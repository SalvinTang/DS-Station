import type { WebContentsView } from 'electron'
import { SELECTOR_KEYS, pagePrelude, type SelectorKey } from './selectors'

/**
 * 驱动主窗口里那个 DeepSeek 网页：写文字、点按钮、读回答。
 *
 * 这里**不碰** DeepSeek 的私有 API，也不自己解 PoW ——
 * 所有真正的网络交互都由网页自己完成，我们只是在旁边操作它的界面（决策 D1）。
 *
 * 读回答也**不用 CDP** 去旁听 SSE：`Runtime.enable` 是 Cloudflare 明确会盯的
 * 机器人特征，我们 P0 好不容易过了人机验证，不值得冒这个险。
 * 改成轮询 DOM 读纯文本，正好也和决策 D2（V0.0.1 先不渲染 Markdown）对得上。
 */

export interface SwitchStates {
  deepThink: boolean | null
  smartSearch: boolean | null
}

/** 轮询间隔：够流畅，也不会给页面太大压力 */
export const POLL_INTERVAL = 150

/** 回答停止变化多久算「说完了」 */
export const ANSWER_SETTLE_MS = 1200

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class DeepSeekPage {
  constructor(private readonly view: WebContentsView) {}

  private get wc() {
    return this.view.webContents
  }

  /** 把一段页面脚本包好丢进去执行；出错只记日志，不往上抛 */
  private async run<T>(body: string): Promise<T | null> {
    const script = `(() => { ${pagePrelude()} ${body} })()`
    try {
      return (await this.wc.executeJavaScript(script, true)) as T
    } catch (err) {
      console.error('[DeepSeek] 页面脚本执行失败:', err)
      return null
    }
  }

  /** 选择器自检：启动时跑，哪一项挂了立刻能看出来 */
  async selfCheck(): Promise<Record<SelectorKey, boolean> | null> {
    return this.run<Record<SelectorKey, boolean>>(`
      const out = {};
      for (const key of ${JSON.stringify(SELECTOR_KEYS)}) out[key] = !!dsFind(key);
      return out;
    `)
  }

  // ── 写 ────────────────────────────────────────────────────────

  /**
   * 把文字写进输入框。
   *
   * ★ 关键：React 受控组件必须走**原型上的原生 setter**。
   *   直接 `el.value = x` 只改了 DOM 属性，React 内部记录的值没变，
   *   一旦失焦 React 就会拿旧值把界面覆盖回去 —— 表现就是「字凭空消失」。
   *   这是社区里反复踩到的坑。
   */
  async setComposerText(text: string): Promise<boolean> {
    const json = JSON.stringify(text)
    return (
      (await this.run<boolean>(`
        const el = dsFind('composer');
        if (!el) return false;

        el.focus();

        if (el.isContentEditable) {
          el.textContent = ${json};
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
          return true;
        }

        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

        if (setter) setter.call(el, ${json});
        else el.value = ${json};

        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      `)) === true
    )
  }

  /** 点发送。优先点那个圆形按钮，找不到就退回在输入框上敲回车 */
  async clickSend(): Promise<boolean> {
    return (
      (await this.run<boolean>(`
        const btn = dsFind('sendButton');
        if (btn && !String(btn.className || '').includes(DS_STATE.buttonDisabled)) {
          btn.click();
          return true;
        }

        const el = dsFind('composer');
        if (!el) return false;
        el.focus();
        for (const type of ['keydown', 'keypress', 'keyup']) {
          el.dispatchEvent(new KeyboardEvent(type, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true,
          }));
        }
        return true;
      `)) === true
    )
  }

  /** 开启新对话 */
  async startNewChat(): Promise<boolean> {
    return (
      (await this.run<boolean>(`
        const btn = dsFind('newChat');
        if (!btn) return false;
        btn.click();
        return true;
      `)) === true
    )
  }

  // ── 开关状态 ──────────────────────────────────────────────────

  async getSwitchStates(): Promise<SwitchStates | null> {
    return this.run<SwitchStates>(`
      return {
        deepThink: dsIsOn(dsFind('deepThinkToggle')),
        smartSearch: dsIsOn(dsFind('smartSearchToggle')),
      };
    `)
  }

  /**
   * 把某个开关设成目标状态。
   * 读不准状态时**不动它** —— 瞎点一下会把用户原来的设置弄反。
   */
  async setSwitch(key: 'deepThinkToggle' | 'smartSearchToggle', on: boolean): Promise<boolean> {
    const states = await this.getSwitchStates()
    if (!states) return false

    const current = key === 'deepThinkToggle' ? states.deepThink : states.smartSearch
    if (current === null) return false
    if (current === on) return true

    const clicked =
      (await this.run<boolean>(`
        const el = dsFind('${key}');
        if (!el) return false;
        el.click();
        return true;
      `)) === true

    if (clicked) await delay(POLL_INTERVAL)
    return clicked
  }

  // ── 读 ────────────────────────────────────────────────────────

  /** 页面上所有 AI 回答的纯文本，按先后顺序 */
  async listAnswers(): Promise<string[]> {
    return (
      (await this.run<string[]>(`
        for (const sel of DS_SELECTORS.assistantMessage) {
          let nodes;
          try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
          if (!nodes.length) continue;
          return nodes.map(dsReadAnswer).filter(Boolean);
        }
        return [];
      `)) ?? []
    )
  }

  /** 等回答数量超过 baseline（说明这一轮已经在生成了） */
  async waitForNewAnswer(baseline: number, timeoutMs = 15000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const answers = await this.listAnswers()
      if (answers.length > baseline) return true
      await delay(POLL_INTERVAL)
    }
    return false
  }

  /**
   * 盯住最后一条回答，每变一次就回调一次，直到它稳定下来。
   * 返回是否成功拿到过内容。
   */
  async streamLastAnswer(onUpdate: (text: string) => void, timeoutMs = 120000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    let last = ''
    let lastChangedAt = Date.now()
    let sawAnything = false

    while (Date.now() < deadline) {
      const answers = await this.listAnswers()
      const current = answers.length ? answers[answers.length - 1] : ''

      if (current !== last) {
        last = current
        lastChangedAt = Date.now()
        if (current) {
          sawAnything = true
          onUpdate(current)
        }
      } else if (sawAnything && Date.now() - lastChangedAt > ANSWER_SETTLE_MS) {
        // 内容超过 1.2 秒没再变，认为这一轮说完了
        return true
      }

      await delay(POLL_INTERVAL)
    }

    return sawAnything
  }
}

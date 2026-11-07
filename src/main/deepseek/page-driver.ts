import type { WebContentsView } from 'electron'
import { DEEPSEEK_ORIGIN } from '../../shared/constants'
import type { HistoryEntry, HistoryMessage } from '../../shared/types'
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

/** logged-out 是确定的；unknown 表示页面还没准备好，不代表没登录 */
export type LoginState = 'logged-in' | 'logged-out' | 'unknown'

/**
 * 取消令牌。
 * 用户点「停止生成」时把它翻成 true，正在跑的两段轮询会尽快退出。
 */
export interface StreamToken {
  cancelled: boolean
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

  /**
   * 登录状态。两个条件缺一不可：
   *   1. 地址不是登录页 —— 未登录时首页会先渲染一下再跳到 /sign_in
   *   2. 页面上能找到对话输入框 —— 登录页的账号输入框也可见，不能只看 DOM
   *
   * 页面还在加载、或者命令执行失败时返回 'unknown'，交给调用方决定要不要等。
   */
  async loginState(): Promise<LoginState> {
    const url = this.wc.getURL()
    if (!url.startsWith(DEEPSEEK_ORIGIN)) return 'unknown'
    if (/\/sign_in(?:$|[/?#])/.test(url)) return 'logged-out'

    const checks = await this.selfCheck()
    if (!checks) return 'unknown'
    return checks.composer ? 'logged-in' : 'unknown'
  }

  async isLoggedIn(): Promise<boolean> {
    return (await this.loginState()) === 'logged-in'
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

  // ── 停止 / 继续生成 ──────────────────────────────────────────

  /**
   * 页面是否正在生成回答。
   *
   * 生成中发送按钮会变成「停止」：没有 disabled 类，图标是圆角方块。
   * 实测方块图标的 SVG path 以 `M2 4.88` 开头，完成后会换回向上的箭头。
   */
  async isGenerating(): Promise<boolean> {
    return (
      (await this.run<boolean>(`
        const btn = dsFind('sendButton');
        if (!btn) return false;
        if (String(btn.className || '').includes(DS_STATE.buttonDisabled)) return false;
        const path = btn.querySelector('svg path');
        return !!path && (path.getAttribute('d') || '').startsWith('M2 4.88');
      `)) === true
    )
  }

  /**
   * 停止生成：点页面上的停止按钮。
   *
   * 刚发出消息的几百毫秒里按钮还没切到停止态，此时点它等于「再次发送」。
   * 所以先确认图标已经是方块，再点。
   */
  async stopGenerating(timeoutMs = 2500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (await this.isGenerating()) {
        return (
          (await this.run<boolean>(`
            const btn = dsFind('sendButton');
            if (!btn) return false;
            dsDeepest(btn).click();
            return true;
          `)) === true
        )
      }
      await delay(150)
    }

    return false
  }

  /** 页面上是否有可点的「继续生成」按钮（只有最新一条被截断的回答才有） */
  async hasContinueButton(): Promise<boolean> {
    return (await this.run<boolean>(`return !!dsFindContinue();`)) === true
  }

  /**
   * 点「继续生成」。
   *
   * 这个按钮对合成 click 不响应（实测 .click() 和 pointer 事件都没用，
   * React 组件大概率检查了 isTrusted），必须用 sendInputEvent 模拟真实鼠标。
   * 坐标取按钮滚动到视口中央后的矩形中心。
   */
  async continueGenerating(): Promise<boolean> {
    /*
     * 主窗口隐藏时，DeepSeek 页面最上层会铺一个全屏透明层
     * （实测 div._4cbcd96，覆盖整个视口，pointer-events: auto），
     * 真实鼠标事件会被它吃掉，点不到下面的按钮。
     *
     * 所以点击前把「挡在按钮和视口之间的元素」临时改成 pointer-events: none，
     * 点完立刻恢复。只动 pointer-events，不动布局和 React 状态。
     */
    const prepared = await this.run<{ x: number; y: number } | null>(`
      const btn = dsFindContinue();
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' });

      const r = btn.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;

      const x = Math.round(Math.min(Math.max(r.x + r.width / 2, 1), window.innerWidth - 1));
      const y = Math.round(Math.min(Math.max(r.y + r.height / 2, 1), window.innerHeight - 1));

      const stack = document.elementsFromPoint(x, y);
      const blockers = stack.filter(
        (el) => el !== btn && !btn.contains(el) && !el.contains(btn),
      );
      window.__dsBlockers = blockers.map((el) => [el, el.style.pointerEvents]);
      for (const el of blockers) el.style.pointerEvents = 'none';

      return { x, y };
    `)

    if (!prepared) return false

    try {
      this.wc.sendInputEvent({ type: 'mouseMove', x: prepared.x, y: prepared.y })
      this.wc.sendInputEvent({
        type: 'mouseDown',
        x: prepared.x,
        y: prepared.y,
        button: 'left',
        clickCount: 1,
      })
      this.wc.sendInputEvent({
        type: 'mouseUp',
        x: prepared.x,
        y: prepared.y,
        button: 'left',
        clickCount: 1,
      })
    } finally {
      await this.run(`
        const saved = window.__dsBlockers || [];
        for (const [el, prev] of saved) {
          try { el.style.pointerEvents = prev; } catch (e) {}
        }
        window.__dsBlockers = null;
        return true;
      `)
    }

    console.log(`[快捷窗口] 继续生成 → 已点击 (${prepared.x}, ${prepared.y})`)
    return true
  }

  /**
   * 开启新对话。
   *
   * 主窗口宽度较窄时 DeepSeek 会把左侧栏收起来，「开启新对话」在屏幕外，
   * `dsFindByText` 只认可见元素，所以直接找是找不到的。
   * 这时先点左上角的侧栏开关，等侧栏展开后再点一次。
   */
  async startNewChat(): Promise<boolean> {
    const clickVisible = (): Promise<boolean | null> =>
      this.run<boolean>(`
        const btn = dsFind('newChat');
        if (!btn) return false;
        // 点击处理挂在内层 span 上，点外层 div 没反应
        dsDeepest(btn).click();
        return true;
      `)

    if ((await clickVisible()) === true) return true

    const opened = await this.run<boolean>(`
      const btn = Array.from(document.querySelectorAll('[role="button"], button')).find((el) => {
        const r = el.getBoundingClientRect();
        return r.width >= 30 && r.height >= 30 && r.x >= 0 && r.x < 70 && r.y < 80;
      });
      if (!btn) return false;
      btn.click();
      return true;
    `)

    if (opened !== true) return false

    // 侧栏展开有过渡动画
    await delay(500)
    return (await clickVisible()) === true
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
   * 等「这一轮的新回答」真正出现。
   *
   * 不能用数量判断：首次启动时主窗口可能停在旧会话或首页，本来就有内容；
   * 而发送后页面跳转到新会话的瞬间又会短暂返回空数组。
   * 比较**最后一条回答的文本**最稳 —— 只要它跟发送前不一样，就是新的。
   */
  async waitForAnswerChange(
    baseline: string[],
    timeoutMs = 45000,
    token?: StreamToken,
  ): Promise<boolean> {
    const baseLast = baseline.length ? baseline[baseline.length - 1] : ''
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (token?.cancelled) return false
      const answers = await this.listAnswers()
      const last = answers.length ? answers[answers.length - 1] : ''
      if (last && last !== baseLast) return true
      await delay(POLL_INTERVAL)
    }
    return false
  }

  /**
   * 盯住最后一条回答，每变一次就回调一次，直到它稳定下来。
   * 返回是否成功拿到过内容。
   */
  async streamLastAnswer(
    onUpdate: (text: string) => void,
    timeoutMs = 120000,
    token?: StreamToken,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    let last = ''
    let lastChangedAt = Date.now()
    let sawAnything = false

    while (Date.now() < deadline) {
      // 用户点了停止：立刻退出，不再推增量
      if (token?.cancelled) return sawAnything
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

  // ── 历史对话 ──────────────────────────────────────────────────

  /**
   * 读左侧边栏的历史对话（由新到旧）。
   *
   * 侧边栏是分页/懒加载的：初始一般渲染 100 条，滚到底会再拉一页。
   * scrollable 表示“还能滚动”，调用方据此决定要不要继续按需加载。
   */
  async readHistory(): Promise<{ items: HistoryEntry[]; scrollable: boolean }> {
    const result = await this.run<{ items: HistoryEntry[]; scrollable: boolean }>(`
      const items = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href^="/a/chat/s/"]')) {
        if (!dsVisible(a)) continue;
        const href = a.getAttribute('href') || '';
        const id = href.split('/').filter(Boolean).pop() || '';
        if (!id || seen.has(id)) continue;
        const title = dsText(a);
        if (!title) continue;
        seen.add(id);
        items.push({ id, title });
      }

      const scroller = Array.from(document.querySelectorAll('.ds-scroll-area')).find((el) => {
        const r = el.getBoundingClientRect();
        return r.x < 380 && el.scrollHeight > el.clientHeight + 40;
      });

      return {
        items,
        scrollable: !!scroller && scroller.scrollHeight > scroller.clientHeight + 40,
      };
    `)
    return result ?? { items: [], scrollable: false }
  }

  /** 把侧边栏滚到底，触发下一页加载 */
  async scrollHistoryToBottom(): Promise<boolean> {
    return (
      (await this.run<boolean>(`
        const scroller = Array.from(document.querySelectorAll('.ds-scroll-area')).find((el) => {
          const r = el.getBoundingClientRect();
          return r.x < 380 && el.scrollHeight > el.clientHeight + 40;
        });
        if (!scroller) return false;
        scroller.scrollTop = scroller.scrollHeight;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        return true;
      `)) === true
    )
  }

  /**
   * 打开一条历史对话，并读回它最下方当前渲染出来的消息。
   *
   * 对话区是虚拟列表：只保留视口附近的消息，所以先滚到最底部，
   * 再读渲染出来的那一批 —— 也正好符合设计稿「显示最下方内容」。
   */
  async openHistory(id: string): Promise<HistoryMessage[] | null> {
    const clicked = await this.run<boolean>(`
      const target = ${JSON.stringify(id)};
      const anchors = Array.from(document.querySelectorAll('a[href^="/a/chat/s/"]'));
      const link = anchors.find((a) => {
        const href = a.getAttribute('href') || '';
        return href.split('/').filter(Boolean).pop() === target;
      });
      if (!link) return false;
      link.scrollIntoView({ block: 'nearest' });
      link.click();
      return true;
    `)
    if (clicked !== true) return null

    const deadline = Date.now() + 15000
    let ready = false
    while (Date.now() < deadline) {
      const state = await this.run<{ path: string; count: number }>(`
        return {
          path: location.pathname,
          count: document.querySelectorAll('.ds-message').length,
        };
      `)
      if (state?.path.includes(id) && state.count > 0) {
        ready = true
        break
      }
      await delay(250)
    }
    if (!ready) return null

    // 滚到底，等虚拟列表把最后几条渲染出来
    await this.scrollConversationToBottom()
    await delay(500)
    await this.scrollConversationToBottom()
    await delay(250)

    const messages =
      (await this.run<HistoryMessage[]>(`
        const out = [];
        const seen = new Set();
        for (const node of document.querySelectorAll('.ds-message')) {
          if (!dsVisible(node)) continue;
          const ai = node.querySelector('.ds-assistant-message-main-content');
          const text = dsReadAnswer(ai || node);
          if (!text) continue;
          const role = ai ? 'ai' : 'user';
          const key = role + '|' + text;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ role, text });
        }
        return out.slice(-40);
      `)) ?? []

    return messages
  }

  private async scrollConversationToBottom(): Promise<boolean> {
    return (
      (await this.run<boolean>(`
        const list = document.querySelector('.ds-virtual-list') ||
          Array.from(document.querySelectorAll('.ds-scroll-area')).find((el) => {
            const r = el.getBoundingClientRect();
            return r.x > 300 && el.scrollHeight > el.clientHeight + 40;
          });
        if (!list) return false;
        list.scrollTop = list.scrollHeight;
        list.dispatchEvent(new Event('scroll', { bubbles: true }));
        return true;
      `)) === true
    )
  }
}

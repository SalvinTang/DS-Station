import type { WebContentsView } from 'electron'
import { DEEPSEEK_ORIGIN } from '../../shared/constants'
import type { HistoryEntry, HistoryMessage, SearchInfo, SearchSummary } from '../../shared/types'
import {
  COMPOSER_TOGGLES,
  SELECTOR_KEYS,
  pagePrelude,
  type ComposerToggleKey,
  type SelectorKey,
} from './selectors'

/**
 * 驱动主窗口里那个 DeepSeek 网页：写文字、点按钮、读回答、读历史。
 *
 * 发消息、生成回答仍然完全由网页自己做，我们不自己解 PoW，也不碰登录态。
 * 历史列表 / 完整历史消息走的是网页自己的接口，请求头直接复用网页已经
 * 发出去的 `authorization`，不额外保存 token。
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
   *
   * ★ 点击之后**会重新读一遍状态**。
   *   旧实现只看「点到了元素」就当成功，页面正在切会话、重渲染，
   *   或者开关禁用时点击其实不生效，用户就会看到「开关是开的，
   *   DeepSeek 却没联网搜索」。现在最多重试 3 次，每次点击后等状态
   *   真正变成目标值；确认不了返回 false，调用方只记录日志，
   *   不因此阻断发送（面板仍然是唯一状态源）。
   */
  async setSwitch(key: 'deepThinkToggle' | 'smartSearchToggle', on: boolean): Promise<boolean> {
    const read = async (): Promise<boolean | null | undefined> => {
      const states = await this.getSwitchStates()
      if (!states) return undefined
      return key === 'deepThinkToggle' ? states.deepThink : states.smartSearch
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await read()
      if (current === on) return true

      // 读不到（页面脚本失败）或元素不存在（页面还没渲染好 /
      // 当前模型不支持）—— 再等一轮，可能只是新对话后的重渲染。
      if (current === undefined || current === null) {
        if (attempt < 2) await delay(350)
        continue
      }

      // 第一次点根节点；没反应时再点图标（结构定位，不依赖文字）。
      // 点击子元素会冒泡到根节点上的处理函数。
      const target =
        attempt === 0 ? 'el' : "(el.querySelector('.ds-toggle-button__icon') || el)"
      const clicked =
        (await this.run<boolean>(`
          const el = dsFind('${key}');
          if (!el) return false;
          if (String(el.className || '').includes(DS_STATE.toggleDisabled)) return false;
          ${target}.click();
          return true;
        `)) === true

      if (!clicked) {
        await delay(300)
        continue
      }

      // 等 React 把 aria-pressed / 选中类名更新过来
      for (let wait = 0; wait < 12; wait += 1) {
        await delay(100)
        if ((await read()) === on) return true
      }
    }

    const final = await read()
    console.warn(
      `[DeepSeek] 开关 ${key} → ${on ? '开' : '关'} 失败，当前状态: ${String(final)}`,
    )
    return false
  }

  /**
   * 发送前把输入区的开关同步成快捷面板的状态。
   *
   * 面板是唯一状态源；网页上用户自己改过的状态在这里被覆盖。
   * 同步失败不阻断发送 —— 只记录日志，消息照常发出。
   * 开关的对应关系由 COMPOSER_TOGGLES 的顺序决定，不按文字匹配。
   */
  async syncComposerSwitches(desired: {
    deepThink: boolean
    smartSearch: boolean
  }): Promise<void> {
    const values: Record<ComposerToggleKey, boolean> = {
      deepThinkToggle: desired.deepThink,
      smartSearchToggle: desired.smartSearch,
    }

    for (const key of COMPOSER_TOGGLES) {
      await this.setSwitch(key, values[key])
    }
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
   * 最后一条回答的纯文本 + 页面里渲染好的 HTML。
   * HTML 直接来自 `.ds-assistant-message-main-content`，
   * 由快捷窗口做白名单清洗后显示。
   */
  async lastAnswerRich(): Promise<{ text: string; html: string } | null> {
    return this.run<{ text: string; html: string }>(`
      for (const sel of DS_SELECTORS.assistantMessage) {
        let nodes;
        try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
        if (!nodes.length) continue;
        const el = nodes[nodes.length - 1];
        return { text: dsReadAnswer(el), html: el.outerHTML };
      }
      return null;
    `)
  }

  /**
   * 盯住最后一条回答，每变一次就回调一次，直到它稳定下来。
   * 返回是否成功拿到过内容。
   *
   * 回调同时带 text 和 html：text 用于兜底和复制，html 用于 Markdown 渲染。
   * HTML 每 300ms 最多推一次，避免每 150ms 重排一次气泡。
   */
  async streamLastAnswer(
    onUpdate: (text: string, html: string) => void,
    timeoutMs = 120000,
    token?: StreamToken,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    let last = ''
    let lastChangedAt = Date.now()
    let lastPushAt = 0
    let sawAnything = false

    while (Date.now() < deadline) {
      // 用户点了停止：立刻退出，不再推增量
      if (token?.cancelled) return sawAnything
      const rich = await this.lastAnswerRich()
      const current = rich?.text ?? ''
      const html = rich?.html ?? ''
      const now = Date.now()
      const changed = current !== last

      if (changed) {
        last = current
        lastChangedAt = now
      }

      // 统一按 300ms 推，保证 text 和 html 永远成对出现
      if (current && now - lastPushAt >= 300) {
        sawAnything = true
        lastPushAt = now
        onUpdate(current, html)
      }

      if (sawAnything && now - lastChangedAt > ANSWER_SETTLE_MS) {
        // 内容超过 1.2 秒没再变，认为这一轮说完了
        return true
      }

      await delay(POLL_INTERVAL)
    }

    return sawAnything
  }

  /**
   * 当前实时回答的搜索入口摘要（数量 + 前 4 个网站图标）。
   * 只读 DOM，回答一开始就能拿到，用来先把顶部搜索气泡显示出来。
   */
  async readCurrentSearchSummary(answerIndex?: number): Promise<SearchSummary | null> {
    return this.run<SearchSummary | null>(`
      const answers = Array.from(document.querySelectorAll('.ds-assistant-message-main-content'));
      const index = ${typeof answerIndex === 'number' ? String(answerIndex) : 'null'};
      const answer = index === null ? answers[answers.length - 1] : answers[index];
      if (!answer) return null;

      // 只看当前这条回答所在的消息容器，避免把上一条回答的搜索入口算进来
      const messageRoot =
        answer.closest('.ds-message') ||
        answer.closest('[data-virtual-list-item-key]') ||
        answer.parentElement;
      if (!messageRoot) return null;

      let hit = null;
      let count = null;
      for (const el of Array.from(messageRoot.querySelectorAll('span, div'))) {
        if (el.children.length > 0) continue;
        const text = (el.textContent || '').trim();
        const match = text.match(/^搜索到\\s*(\\d+)\\s*个网页$/);
        if (match) {
          hit = el;
          count = Number(match[1]);
          break;
        }
      }
      if (!hit || count === null) return null;

      const icons = [];
      let row = hit.parentElement;
      for (let depth = 0; depth < 4 && row; depth += 1) {
        for (const img of Array.from(row.querySelectorAll('img'))) {
          const src = img.getAttribute('src') || '';
          if (/^https:\\/\\/cdn\\.deepseek\\.com\\//i.test(src) && !icons.includes(src)) {
            icons.push(src);
          }
        }
        if (icons.length > 0) break;
        row = row.parentElement;
      }
      return { count: count, icons: icons.slice(0, 4) };
    `)
  }

  /**
   * 当前这条实时回答的智能搜索结果。
   *
   * 页面上的搜索入口在回答正文外层，这里只拿它做“是否搜索过”和数量校验；
   * 网页列表本身从 history_messages 的 SEARCH 片段里取，和网页端一致。
   */
  async readCurrentSearchInfo(answerIndex?: number): Promise<SearchInfo | null> {
    await this.installApiHeaderHook()

    const result = await this.run<{
      search?: SearchInfo | null
      error?: string
      noSearch?: boolean
    }>(`
      return (async () => {
        try {
          const headers = window.__dsApiHeaders || null;
          if (!headers) return { error: 'no headers' };
          const pathMatch = location.pathname.match(/\\/a\\/chat\\/s\\/([^/?#]+)/);
          if (!pathMatch) return { noSearch: true };
          const sessionId = decodeURIComponent(pathMatch[1]);

          const answers = Array.from(document.querySelectorAll('.ds-assistant-message-main-content'));
          const index = ${typeof answerIndex === 'number' ? String(answerIndex) : 'null'};
          const answer = index === null ? answers[answers.length - 1] : answers[index];
          if (!answer) return { noSearch: true };

          // 只看当前这条回答所在的消息容器，避免误用上一条回答的搜索结果
          const messageRoot =
            answer.closest('.ds-message') ||
            answer.closest('[data-virtual-list-item-key]') ||
            answer.parentElement;
          let summaryCount = null;
          if (messageRoot) {
            for (const el of Array.from(messageRoot.querySelectorAll('span, div'))) {
              if (el.children.length > 0) continue;
              const text = (el.textContent || '').trim();
              const hit = text.match(/^搜索到\\s*(\\d+)\\s*个网页$/);
              if (hit) {
                summaryCount = Number(hit[1]);
                break;
              }
            }
          }
          if (summaryCount === null) return { noSearch: true };

          const url = '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sessionId);
          const resp = await fetch(url, { credentials: 'include', headers });
          if (!resp.ok) return { error: 'http ' + resp.status };
          const json = await resp.json();
          if (json && json.code === 40003) return { error: 'invalid token' };
          const biz = json && json.data && json.data.biz_data;
          const messages = (biz && biz.chat_messages) || [];

          // 从最后一条往前找，数量和页面上显示的一致才算当前回答
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            const message = messages[i];
            if (!message || message.role === 'USER') continue;
            const fragment = (message.fragments || []).find((f) => f.type === 'SEARCH');
            if (!fragment || !Array.isArray(fragment.results)) continue;
            const sources = fragment.results
              .filter((item) => item && typeof item.url === 'string' && /^https?:\\/\\//i.test(item.url))
              .map((item) => ({
                url: item.url,
                title: typeof item.title === 'string' ? item.title : '',
                snippet: typeof item.snippet === 'string' ? item.snippet : '',
                citeIndex: Number(item.cite_index) || 0,
                publishedAt: Number(item.published_at) || 0,
                siteIcon: typeof item.site_icon === 'string' ? item.site_icon : '',
                siteName: typeof item.site_name === 'string' ? item.site_name : '',
              }))
              .sort((a, b) => a.citeIndex - b.citeIndex);
            if (!sources.length) continue;
            if (sources.length === summaryCount) {
              return { search: { count: sources.length, sources: sources } };
            }
          }
          return { noSearch: true };
        } catch (error) {
          return { error: String(error && error.message ? error.message : error) };
        }
      })();
    `)

    if (result?.error) console.log('[搜索] 读取当前回答的网页结果失败:', result.error)
    return result?.search ?? null
  }

  // ── 历史对话 ──────────────────────────────────────────────────

  /**
   * 用接口读历史对话列表，不依赖侧边栏 DOM。
   *
   * 网页自己用的就是 `GET /api/v0/chat_session/fetch_page`：
   *   ?lte_cursor.pinned=false
   *   &lte_cursor.updated_at=<上一页最后一条的 updated_at>   ← 翻下一页
   *
   * 所以主窗口被缩得很小、侧边栏被隐藏时，列表依然能拿到。
   * cursor 传上一页最后一条会话的 updated_at；首页传 null。
   */
  async fetchHistoryList(
    cursor: number | null = null,
  ): Promise<{ items: HistoryEntry[]; hasMore: boolean; cursor: number | null } | null> {
    await this.installApiHeaderHook()

    const readHeaders = (): Promise<Record<string, string> | null> =>
      this.run<Record<string, string> | null>(`return window.__dsApiHeaders || null;`)

    let headers = await readHeaders()
    if (!headers) {
      // 页面还没发过带登录态的请求；等一会儿，拿不到就让调用方退回 DOM
      for (let i = 0; i < 15; i += 1) {
        await delay(100)
        headers = await readHeaders()
        if (headers) break
      }
    }
    if (!headers) return null

    const request = (): Promise<{
      items?: HistoryEntry[]
      hasMore?: boolean
      cursor?: number | null
      error?: string
      authError?: boolean
    } | null> =>
      this.run<{
        items?: HistoryEntry[]
        hasMore?: boolean
        cursor?: number | null
        error?: string
        authError?: boolean
      } | null>(`
        return (async () => {
          try {
            const headers = window.__dsApiHeaders || null;
            if (!headers) return { error: 'no headers' };

            let url = '/api/v0/chat_session/fetch_page?lte_cursor.pinned=false';
            const cursor = ${JSON.stringify(cursor)};
            if (cursor !== null && cursor !== undefined && Number.isFinite(Number(cursor))) {
              url += '&lte_cursor.updated_at=' + encodeURIComponent(String(cursor));
            }

            const controller = new AbortController();
            const timer = setTimeout(function () { controller.abort(); }, 6000);
            let resp;
            try {
              resp = await fetch(url, {
                credentials: 'include',
                headers: headers,
                signal: controller.signal,
              });
            } finally {
              clearTimeout(timer);
            }
            if (!resp.ok) return { error: 'http ' + resp.status };

            const json = await resp.json();
            if (json && json.code === 40003) return { authError: true, error: 'invalid token' };

            const data = json && json.data;
            const biz = data && (data.biz_data || (data.data && data.data.biz_data));
            if (!biz || !Array.isArray(biz.chat_sessions)) {
              return { error: 'bad payload code=' + (json && json.code) + ' msg=' + (json && json.msg) };
            }

            const items = [];
            const seen = new Set();
            let nextCursor = null;
            for (const session of biz.chat_sessions) {
              if (!session) continue;
              const id = session.id !== undefined && session.id !== null
                ? String(session.id)
                : (session.session_id !== undefined && session.session_id !== null
                  ? String(session.session_id)
                  : '');
              const updatedAt = Number(session.updated_at);
              if (Number.isFinite(updatedAt)) nextCursor = updatedAt;
              if (!id || seen.has(id)) continue;
              const title = typeof session.title === 'string' ? session.title.trim() : '';
              if (!title) continue;
              seen.add(id);
              items.push({ id: id, title: title });
            }

            return { items: items, hasMore: biz.has_more === true, cursor: nextCursor };
          } catch (error) {
            return { error: String(error && error.message ? error.message : error) };
          }
        })()
      `)

    let result = await request()

    if (result && result.authError) {
      // token 失效：清掉缓存，等页面重新发一个带登录态的请求后重试一次
      await this.run(`window.__dsApiHeaders = null; return true;`)
      let fresh = false
      for (let i = 0; i < 15; i += 1) {
        await delay(100)
        if (await readHeaders()) {
          fresh = true
          break
        }
      }
      if (!fresh) return null
      result = await request()
    }

    if (!result || !Array.isArray(result.items)) {
      if (result && result.error) console.log('[历史] 接口列表读取失败:', result.error)
      return null
    }

    return {
      items: result.items,
      hasMore: result.hasMore === true,
      cursor: typeof result.cursor === 'number' ? result.cursor : null,
    }
  }

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
   * 安装一次性的请求头拦截：
   * 页面里任何带 authorization 的 XHR/fetch 都会把 headers 缓存到 window.__dsApiHeaders。
   * 只装一次，缓存只有一个对象，不会按对话累积。
   */
  async installApiHeaderHook(): Promise<void> {
    await this.run(`
      if (!window.__dsHeaderHook) {
        window.__dsHeaderHook = true;
        window.__dsApiHeaders = window.__dsApiHeaders || null;
        const capture = (headers) => {
          if (!headers) return;
          const list = {};
          try {
            if (Array.isArray(headers)) {
              for (const pair of headers) {
                if (pair && pair.length >= 2) list[String(pair[0])] = String(pair[1]);
              }
            } else if (typeof headers.forEach === 'function') {
              headers.forEach(function (value, key) { list[String(key)] = String(value); });
            } else {
              for (const key of Object.keys(headers)) list[key] = String(headers[key]);
            }
          } catch (e) {
            return;
          }
          let auth = '';
          for (const key of Object.keys(list)) {
            if (key.toLowerCase() === 'authorization') { auth = list[key]; break; }
          }
          if (!auth) return;
          window.__dsApiHeaders = list;
        };

        const origOpen = XMLHttpRequest.prototype.open;
        const origSet = XMLHttpRequest.prototype.setRequestHeader;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__dsUrl = url;
          this.__dsHeaders = {};
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
          if (!this.__dsHeaders) this.__dsHeaders = {};
          this.__dsHeaders[name] = value;
          return origSet.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
          capture(this.__dsHeaders);
          return origSend.apply(this, arguments);
        };

        const origFetch = window.fetch;
        if (origFetch) {
          window.fetch = function (input, init) {
            if (init && init.headers) capture(init.headers);
            return origFetch.apply(this, arguments);
          };
        }
      }
      return true;
    `)
  }

  /** 把主页面切到指定会话（历史预览时不切，真正发消息/扩大时才调） */
  async switchToHistory(id: string): Promise<boolean> {
    return this.openConversation(id)
  }

  /**
   * 直接用页面自己的 history_messages 接口拉整段对话。
   *
   * 优先复用已经缓存的请求头，不再点会话；
   * 只有第一次没有缓存时才点一下会话、短暂等页面自己发请求来拿 headers。
   */
  async openHistoryViaApi(id: string): Promise<HistoryMessage[] | null> {
    await this.installApiHeaderHook()

    const clickTarget = (): Promise<boolean | null> =>
      this.run<boolean>(`
        const target = ${JSON.stringify(id)};
        const link = Array.from(document.querySelectorAll('a[href^="/a/chat/s/"]')).find((a) => {
          const href = a.getAttribute('href') || '';
          return href.split('/').filter(Boolean).pop() === target;
        });
        if (!link) return false;
        link.scrollIntoView({ block: 'nearest' });
        link.click();
        return true;
      `)

    const waitHeaders = async (timeoutMs: number): Promise<boolean> => {
      const attempts = Math.ceil(timeoutMs / 100)
      for (let i = 0; i < attempts; i += 1) {
        const headers = await this.run<Record<string, string> | null>(`
          return window.__dsApiHeaders || null;
        `)
        if (headers) return true
        await delay(100)
      }
      return false
    }

    let headers = await this.run<Record<string, string> | null>(`
      return window.__dsApiHeaders || null;
    `)
    let navigated = false

    if (!headers) {
      if ((await clickTarget()) !== true) return null
      navigated = true
      if (!(await waitHeaders(1500))) return null
    }

    const fetchMessages = async (): Promise<{
      messages?: HistoryMessage[]
      error?: string
      authError?: boolean
    }> => {
      return (
        (await this.run<{
          messages?: HistoryMessage[]
          error?: string
          authError?: boolean
        }>(`
          return (async () => {
            try {
              const headers = window.__dsApiHeaders || null;
              if (!headers) return { error: 'no headers' };
              const url = '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(${JSON.stringify(id)});
              const resp = await fetch(url, { credentials: 'include', headers });
              if (!resp.ok) return { error: 'http ' + resp.status };
              const json = await resp.json();
              if (json && json.code === 40003) return { authError: true, error: 'invalid token' };
              const data = json && json.data && json.data.biz_data;
              if (!data || !Array.isArray(data.chat_messages)) {
                return { error: 'bad payload code=' + (json && json.code) + ' msg=' + (json && json.msg) };
              }
              let source = data.chat_messages;
              const currentId = data.chat_session && data.chat_session.current_message_id;
              if (currentId !== undefined && currentId !== null) {
                const byId = new Map(source.map((message) => [String(message.message_id), message]));
                const chain = [];
                const seen = new Set();
                let cursor = byId.get(String(currentId));
                while (cursor && !seen.has(String(cursor.message_id))) {
                  seen.add(String(cursor.message_id));
                  chain.push(cursor);
                  const parent = cursor.parent_id;
                  cursor = parent !== undefined && parent !== null ? byId.get(String(parent)) : undefined;
                }
                if (chain.length) source = chain.reverse();
              }
              const out = [];
              for (const message of source) {
                const fragments = message.fragments || [];
                if (message.role === 'USER') {
                  const request = fragments
                    .filter((fragment) => fragment.type === 'REQUEST' && typeof fragment.content === 'string')
                    .map((fragment) => fragment.content)
                    .join('')
                    .trim();
                  if (request) out.push({ role: 'user', text: request, key: String(message.message_id) });
                  continue;
                }
                const response = fragments
                  .filter(
                    (fragment) =>
                      fragment.type === 'RESPONSE' &&
                      typeof fragment.content === 'string' &&
                      fragment.content.trim(),
                  )
                  .map((fragment) => fragment.content)
                  .join(String.fromCharCode(10, 10))
                  .trim();
                if (!response) continue;

                // 智能搜索：SEARCH 片段里带完整的网页结果
                const searchFragment = fragments.find((fragment) => fragment.type === 'SEARCH');
                let search = null;
                if (searchFragment && Array.isArray(searchFragment.results)) {
                  const sources = searchFragment.results
                    .filter((item) => item && typeof item.url === 'string' && /^https?:\\/\\//i.test(item.url))
                    .map((item) => ({
                      url: item.url,
                      title: typeof item.title === 'string' ? item.title : '',
                      snippet: typeof item.snippet === 'string' ? item.snippet : '',
                      citeIndex: Number(item.cite_index) || 0,
                      publishedAt: Number(item.published_at) || 0,
                      siteIcon: typeof item.site_icon === 'string' ? item.site_icon : '',
                      siteName: typeof item.site_name === 'string' ? item.site_name : '',
                    }))
                    .sort((a, b) => a.citeIndex - b.citeIndex);
                  if (sources.length) search = { count: sources.length, sources: sources };
                }

                out.push({
                  role: 'ai',
                  text: response,
                  markdown: response,
                  key: String(message.message_id),
                  search: search || undefined,
                });
              }
              return { messages: out };
            } catch (error) {
              return { error: String(error) };
            }
          })();
        `)) ?? { error: 'script failed' }
      )
    }

    let result = await fetchMessages()

    // 缓存的 token 过期：清掉，重新从页面请求里抓一次，再试一次
    if (result.authError) {
      await this.run(`window.__dsApiHeaders = null; return true;`)
      if (!navigated) {
        if ((await clickTarget()) !== true) return null
        navigated = true
      }
      if (!(await waitHeaders(1500))) return null
      result = await fetchMessages()
    }

    return result.messages ?? null
  }

  private async openConversation(id: string): Promise<boolean> {
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
    if (clicked !== true) return false

    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const state = await this.run<{ path: string; count: number }>(`
        return {
          path: location.pathname,
          count: document.querySelectorAll('.ds-message').length,
        };
      `)
      if (state?.path.includes(id) && state.count > 0) return true
      await delay(250)
    }
    return false
  }

  /** 读当前虚拟列表里已经渲染出来的消息（带虚拟项 key） */
  private async readRenderedMessages(): Promise<HistoryMessage[]> {
    return (
      (await this.run<HistoryMessage[]>(`
        const out = [];
        for (const node of document.querySelectorAll('.ds-message')) {
          if (!dsVisible(node)) continue;
          const ai = node.querySelector('.ds-assistant-message-main-content');
          const text = dsReadAnswer(ai || node);
          if (!text) continue;
          const holder = node.closest('[data-virtual-list-item-key]');
          const key = holder ? holder.getAttribute('data-virtual-list-item-key') : '';
          out.push({
            role: ai ? 'ai' : 'user',
            text,
            html: ai ? ai.outerHTML : undefined,
            key: key || undefined,
          });
        }
        return out;
      `)) ?? []
    )
  }

  /**
   * 只加载最后一段完整对话：最后一条用户消息 + 它后面的所有回答。
   * 不加载更早的历史；更早的内容由 loadOlderHistory 按需补。
   */
  async openHistoryLastExchange(
    id: string,
  ): Promise<{ messages: HistoryMessage[]; hasOlder: boolean } | null> {
    if (!(await this.openConversation(id))) return null

    await this.scrollConversationToBottom()
    await delay(500)

    let messages = await this.readRenderedMessages()
    let lastUser = -1
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') {
        lastUser = i
        break
      }
    }

    // 最后一条用户消息可能在长回答上方，先向上补一点直到渲染出来
    for (let attempt = 0; lastUser < 0 && attempt < 8; attempt += 1) {
      await this.run(`
        const list = document.querySelector('.ds-virtual-list');
        if (list) {
          list.scrollTop = Math.max(0, list.scrollTop - list.clientHeight * 0.8);
          list.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
        return true;
      `)
      await delay(450)
      messages = await this.readRenderedMessages()
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'user') {
          lastUser = i
          break
        }
      }
    }

    if (lastUser < 0) {
      return { messages: messages.slice(-6), hasOlder: true }
    }
    return { messages: messages.slice(lastUser), hasOlder: true }
  }

  /**
   * 按需加载更早的消息：从当前最早的消息 key 往上补一段。
   * 返回的 messages 会 prepend 到快捷窗口列表顶部。
   */
  async loadOlderHistory(
    firstKey: string | null,
  ): Promise<{ messages: HistoryMessage[]; hasOlder: boolean } | null> {
    let messages = await this.readRenderedMessages()
    let index = firstKey ? messages.findIndex((m) => m.key === firstKey) : 0
    if (index > 0) {
      return { messages: messages.slice(0, index), hasOlder: true }
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = await this.run<{ top: number; count: number; height: number }>(`
        const list = document.querySelector('.ds-virtual-list');
        return {
          top: list ? Math.round(list.scrollTop) : 0,
          count: document.querySelectorAll('.ds-message').length,
          height: list ? list.scrollHeight : 0,
        };
      `)

      await this.run(`
        const list = document.querySelector('.ds-virtual-list');
        if (list) {
          list.scrollTop = Math.max(0, list.scrollTop - list.clientHeight * 0.8);
          list.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
        return true;
      `)
      await delay(500)

      messages = await this.readRenderedMessages()
      index = firstKey ? messages.findIndex((m) => m.key === firstKey) : 0
      if (index > 0) {
        return { messages: messages.slice(0, index), hasOlder: true }
      }

      const after = await this.run<{ top: number; count: number; height: number }>(`
        const list = document.querySelector('.ds-virtual-list');
        return {
          top: list ? Math.round(list.scrollTop) : 0,
          count: document.querySelectorAll('.ds-message').length,
          height: list ? list.scrollHeight : 0,
        };
      `)
      if (!before || !after) break
      if (after.top <= 0 && after.count <= before.count && after.height <= before.height) {
        return { messages: [], hasOlder: false }
      }
    }

    return { messages: [], hasOlder: false }
  }

  async openHistory(id: string): Promise<HistoryMessage[] | null> {
    if (!(await this.openConversation(id))) return null

    // 反复滚到顶部，触发更早消息的分页加载。
    // 虚拟列表会把已经加载的消息留在 DOM 里，加载完后统一读一遍。
    await this.loadAllConversationMessages()
    await delay(800)

    const messages = await this.readRenderedMessages()

    // 主窗口里的页面恢复到底部，不影响用户之后打开主窗口时的阅读位置
    await this.scrollConversationToBottom()

    return messages
  }

  /**
   * 把整段对话加载出来。
   *
   * 对话区是虚拟列表 + 分页：打开时只渲染最后几条，滚到顶部会继续加载更早的消息。
   * 这里反复滚到顶部，直到消息数量/总高度不再增长，再交给调用方统一读取。
   */
  private async loadAllConversationMessages(): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = await this.run<{ count: number; height: number }>(`
        const list = document.querySelector('.ds-virtual-list');
        return {
          count: document.querySelectorAll('.ds-message').length,
          height: list ? list.scrollHeight : 0,
        };
      `)

      const scrolled = await this.run<boolean>(`
        const list = document.querySelector('.ds-virtual-list');
        if (!list) return false;
        list.scrollTop = 0;
        list.dispatchEvent(new Event('scroll', { bubbles: true }));
        return true;
      `)
      if (scrolled !== true) break

      await delay(800)

      const after = await this.run<{ count: number; height: number }>(`
        const list = document.querySelector('.ds-virtual-list');
        return {
          count: document.querySelectorAll('.ds-message').length,
          height: list ? list.scrollHeight : 0,
        };
      `)
      if (!before || !after) break
      if (after.count <= before.count && after.height <= before.height) break
    }
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

/**
 * DeepSeek 网页版的元素定位注册表。
 *
 * ★ 这是整个项目**唯一**依赖 DeepSeek 前端结构的地方 ★
 * DeepSeek 改版后，通常只需要动这一个文件，再跑一次启动自检。
 *
 * ── 2026-10-14 实测得到的事实（别再照网上搜到的写了）────────────
 *
 *  1. DeepSeek 的「按钮」多数是 `<div role="button" class="ds-button ...">`，
 *     **不是** `<button>`；而且绝大多数**没有 aria-label**，只能靠文字识别。
 *     网上流传的 `button[aria-label="Send message"]` 在中文界面下匹配不到。
 *
 *  2. 好在它用的是**语义化的 ds-* 类名**，比随机哈希类名持久得多：
 *       - 发送按钮：ds-button--primary + ds-button--filled + ds-button--circle
 *         禁用时附加 ds-button--disabled
 *       - 两个开关：ds-toggle-button
 *         开启状态附加 ds-toggle-button--selected
 *       - 回答正文：.ds-assistant-message-main-content（同时也有 .ds-markdown）
 *
 *  3. 输入框**没有** `#chat-input` 这个 id（那是旧版/别处的说法）。
 *     实际是 `textarea.ds-scroll-area`，placeholder 为「给 DeepSeek 发送消息」。
 *
 *  4. 回答正文里会内联引用角标 `<span class="ds-markdown-cite">`，
 *     读纯文本时必须滤掉，否则会读成「……框架。12」。
 */

/** 纯 CSS 候选链：按「稳定 → 脆弱」排序，取第一个命中的**可见**元素 */
export const SELECTORS = {
  composer: [
    'textarea.ds-scroll-area',
    'textarea[placeholder*="发送消息"]',
    'textarea[placeholder*="Send"]',
    'textarea',
  ],

  /** 兜底用。正常路径是 dsFindSend()（见下），它会先看输入框周边 */
  sendButton: [
    'div.ds-button--primary.ds-button--filled.ds-button--circle',
    'div.ds-button--circle.ds-button--primary',
    'button[aria-label="Send message"]',
    'button[type="submit"]',
  ],

  /** 具体是哪一个由文字决定，见 TEXT_MATCHERS */
  deepThinkToggle: ['.ds-toggle-button'],

  /** 同上 */
  smartSearchToggle: ['.ds-toggle-button'],

  /** 兜底。正常路径是文字匹配 */
  newChat: ['[data-testid="new-chat"]'],

  assistantMessage: [
    '.ds-assistant-message-main-content',
    '.ds-markdown.ds-markdown--block',
    '.ds-markdown',
  ],
} as const

export type SelectorKey = keyof typeof SELECTORS
export const SELECTOR_KEYS = Object.keys(SELECTORS) as SelectorKey[]

/**
 * 只能靠文字认的元素。
 * 之所以不写成选择器，是因为 DeepSeek 的按钮基本没有 aria-label，
 * 而「哪些元素算按钮」在它这里也不固定（div / span / a 都有）。
 */
export const TEXT_MATCHERS: Partial<Record<SelectorKey, readonly string[]>> = {
  deepThinkToggle: ['深度思考'],
  // 设计稿叫「智能搜索」，DeepSeek 中文界面用的也是这个词；
  // 英文界面或旧版可能叫「联网搜索」，一并留着
  smartSearchToggle: ['智能搜索', '联网搜索', '联网'],
  newChat: ['新对话', '开启新对话', '新建对话'],
}

/** 表示「开」的状态类名 */
export const STATE_CLASS = {
  toggleSelected: 'ds-toggle-button--selected',
  buttonDisabled: 'ds-button--disabled',
} as const

/** 读纯文本时要滤掉的装饰性节点 */
export const NOISE_SELECTORS = [
  '.ds-markdown-cite',
  '[data-citation-group]',
  'svg',
  'button',
] as const

/**
 * 注入到页面里运行的前置代码。
 *
 * 这段跑在**页面主世界**，拿不到 Node 的任何东西，
 * 所以选择器必须序列化进去、不能靠闭包。
 */
export function pagePrelude(): string {
  return `
    const DS_SELECTORS = ${JSON.stringify(SELECTORS)};
    const DS_TEXT_MATCHERS = ${JSON.stringify(TEXT_MATCHERS)};
    const DS_STATE = ${JSON.stringify(STATE_CLASS)};
    const DS_NOISE = ${JSON.stringify(NOISE_SELECTORS)};

    const dsVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const dsText = (el) =>
      ((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();

    const dsPick = (key, requireVisible = true) => {
      const list = DS_SELECTORS[key] || [];
      for (const sel of list) {
        let nodes;
        try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
        for (const node of nodes) {
          if (!requireVisible || dsVisible(node)) return node;
        }
      }
      return null;
    };

    /** 按文字找元素。先看语义化节点，再退化到 div/span */
    const dsFindByText = (labels, scope) => {
      if (!labels || !labels.length) return null;
      const root = scope || document;

      const scan = (nodes) => {
        for (const el of nodes) {
          const r = el.getBoundingClientRect();
          if (r.width < 16 || r.height < 16 || r.width > 360) continue;
          const t = dsText(el);
          if (!t || t.length > 24) continue;
          if (labels.some((l) => t === l || t.includes(l))) return el;
        }
        return null;
      };

      return (
        scan(root.querySelectorAll('.ds-toggle-button, .ds-button, [role="button"], button, a')) ||
        scan(root.querySelectorAll('div, span'))
      );
    };

    /**
     * 从 el 往下钻到真正承载这段文字的最深层元素。
     *
     * DeepSeek 有些按钮的点击处理挂在内层 span 上，点外层 div 毫无反应
     * （「开启新对话」就是典型）。点击内层元素同样会冒泡到外层的处理函数，
     * 所以钻到最深层最稳。
     */
    const dsDeepest = (el) => {
      const text = dsText(el);
      let node = el;
      for (let depth = 0; depth < 8; depth++) {
        let next = null;
        for (const child of node.children) {
          if (dsText(child) === text) { next = child; break; }
        }
        if (!next) break;
        node = next;
      }
      return node;
    };

    /**
     * 发送按钮：先看输入框周边那个实心圆形按钮，
     * 那儿是唯一会随着输入框状态一起禁用/启用的元素。
     */
    const dsFindSend = () => {
      const composer = dsPick('composer', false);
      if (composer) {
        let zone = composer;
        for (let i = 0; i < 4 && zone.parentElement; i++) zone = zone.parentElement;
        const circles = Array.from(zone.querySelectorAll('div.ds-button--circle, button'))
          .filter((el) => {
            const cls = String(el.className || '');
            return dsVisible(el) && cls.includes('ds-button--circle') && cls.includes('ds-button--primary');
          });
        if (circles.length) return circles[circles.length - 1];
      }
      return dsPick('sendButton');
    };

    /** 统一入口：注册表 + 文字匹配 + 特例 */
    const dsFind = (key, requireVisible = true) => {
      if (DS_TEXT_MATCHERS[key]) return dsFindByText(DS_TEXT_MATCHERS[key]);
      if (key === 'sendButton') return dsFindSend();
      return dsPick(key, requireVisible);
    };

    /** 元素是否处于「开」的状态 */
    const dsIsOn = (el) => {
      if (!el) return null;
      const cls = String(el.className || '');
      if (cls.includes(DS_STATE.toggleSelected)) return true;
      const aria = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
      if (aria !== null) return aria === 'true';
      const state = el.getAttribute('data-state');
      if (state) return state === 'on' || state === 'checked';
      return false;
    };

    /**
     * 读取回答正文的纯文本。
     *
     * 克隆一份再处理，而不是直接动原节点 —— 直接改会触发重排，
     * 而我们是每 150ms 轮询一次，那样主窗口会一直闪。
     * 克隆体是游离节点，textContent 不需要布局，所以能用。
     */
    const dsReadAnswer = (el) => {
      if (!el) return '';
      const clone = el.cloneNode(true);
      for (const sel of DS_NOISE) {
        try { clone.querySelectorAll(sel).forEach((n) => n.remove()); } catch (e) {}
      }
      // 块级元素后补换行，让 textContent 也带段落结构
      clone
        .querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, tr, br')
        .forEach((n) => n.appendChild(document.createTextNode('\\n')));
      return (clone.textContent || '')
        .replace(/[ \\t]+\\n/g, '\\n')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();
    };
  `
}

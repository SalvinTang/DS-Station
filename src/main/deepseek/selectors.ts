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
 *
 *  5. 输入区的两个开关**不按文字认**。DeepSeek 固定先渲染「深度思考」，
 *     再渲染「智能搜索」；按 DOM 顺序取比按文字稳 —— 侧栏历史对话标题、
 *     设置项里都可能出现同样的词，以后输入区还会加更多开关。
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

  /** 具体是哪一个由 DOM 顺序决定，见 COMPOSER_TOGGLES */
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
 * 输入区开关的固定顺序，必须和 DeepSeek 的渲染顺序一致。
 *
 * 这是「输入区第几个开关对应哪个功能」的唯一映射表。
 * 以后快捷面板新增功能时，在这里追加，并保证顺序和网页一致；
 * 不要改成按文字匹配 —— 同名文字可能出现在侧栏、设置、历史对话里。
 */
export const COMPOSER_TOGGLES = ['deepThinkToggle', 'smartSearchToggle'] as const
export type ComposerToggleKey = (typeof COMPOSER_TOGGLES)[number]

/**
 * 只能靠文字认的元素。
 * 之所以不写成选择器，是因为 DeepSeek 的按钮基本没有 aria-label，
 * 而「哪些元素算按钮」在它这里也不固定（div / span / a 都有）。
 *
 * 输入区开关不在此列：它们见 COMPOSER_TOGGLES，按 DOM 顺序取。
 */
export const TEXT_MATCHERS: Partial<Record<SelectorKey, readonly string[]>> = {
  // 不能把单独的「新对话」放进来：侧栏里旧的无标题会话也叫「新对话」，
  // 按文字优先会点到历史会话，而不是顶部的「开启新对话」按钮。
  newChat: ['开启新对话', '新建对话', 'New chat'],
}

/** 表示「开」的状态类名 */
export const STATE_CLASS = {
  toggleSelected: 'ds-toggle-button--selected',
  toggleDisabled: 'ds-toggle-button--disabled',
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
    const DS_COMPOSER_TOGGLES = ${JSON.stringify(COMPOSER_TOGGLES)};
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

      // 开关不参与文字匹配：它们只按 COMPOSER_TOGGLES 的顺序取。
      return (
        scan(root.querySelectorAll('.ds-button, [role="button"], button, a')) ||
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
    /**
     * 当前这一轮回答的 DOM 容器：最后一条用户消息后面的第一条助手消息。
     *
     * 编辑消息会保留旧分支，页面上可能同时出现新旧回答；不能再统按
     * “最后一条回答”或全局下标取，否则深度思考会读到旧内容。
     */
    const dsCurrentTurnRoot = () => {
      const items = Array.from(document.querySelectorAll('[data-virtual-list-item-key]'));
      let userIndex = -1;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i].querySelector('.d29f3d7d.ds-message')) {
          userIndex = i;
          break;
        }
      }
      if (userIndex < 0) return null;
      for (let i = userIndex + 1; i < items.length; i += 1) {
        if (items[i].querySelector('.ds-assistant-message-main-content, .ds-think-content')) {
          return items[i];
        }
      }
      return items[userIndex + 1] || null;
    };

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
     * 找到开关的真正根节点（带 aria-pressed / --selected 的那一层）。
     */
    const dsToggleRoot = (el) => {
      if (!el) return null;
      if (String(el.className || '').includes('ds-toggle-button')) return el;
      let node = el.parentElement;
      for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
        if (String(node.className || '').includes('ds-toggle-button')) return node;
      }
      return el;
    };

    /**
     * 输入区里的开关列表，按 DOM 顺序返回。
     *
     * 从输入框往上找「第一个包含 .ds-toggle-button 的祖先容器」，
     * 这个容器就是输入区的功能行，不会把侧栏历史对话、设置项算进来。
     */
    const dsComposerToggleList = () => {
      const composer = dsPick('composer', false);
      if (!composer) return [];

      let node = composer;
      for (let i = 0; i < 10 && node && node !== document.body; i++) {
        node = node.parentElement;
        if (!node) break;
        const list = Array.from(node.querySelectorAll('.ds-toggle-button')).filter(dsVisible);
        if (list.length) return list;
      }
      return [];
    };

    /**
     * 按 DOM 顺序取开关。
     *
     * ★ 不按文字找。侧栏历史对话标题、设置项里都可能出现「智能搜索」
     *   之类的文字；以前按文字匹配曾点到侧栏对话，表现就是「有时智能
     *   搜索没生效」。现在只认输入区里的开关顺序。
     *
     * 数量对不上时返回 null：当前模型可能不支持其中某个开关，
     * 或者 DeepSeek 调了结构。这时宁可不点，也不能把深度思考当搜索点。
     */
    const dsFindToggle = (key) => {
      const index = DS_COMPOSER_TOGGLES.indexOf(key);
      if (index < 0) return null;

      const list = dsComposerToggleList();
      if (list.length !== DS_COMPOSER_TOGGLES.length) return null;
      return list[index] || null;
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
    /**
     * 新建对话。
     *
     * 侧栏里无标题的历史会话也会显示成「新对话」；如果按文字直接找，
     * 会点到那条历史记录，于是每次“新对话”都重新打开同一个会话。
     * 这里优先找「开启新对话 / 新建对话」，并明确排除历史链接。
     */
    const dsFindNewChat = () => {
      const history = (el) => !!el.closest('a[href^="/a/chat/s/"]');
      const candidates = Array.from(
        document.querySelectorAll('.ds-button, [role="button"], button, a'),
      );
      for (const el of candidates) {
        if (!dsVisible(el) || history(el)) continue;
        const text = dsText(el);
        if (!text || text.length > 24) continue;
        if (/开启新对话|新建对话|New chat/i.test(text)) return el;
      }

      // 顶部按钮的文字节点可能不在 .ds-button / role=button / a 里
      const byText = dsFindByText(['开启新对话', '新建对话', 'New chat']);
      if (byText && !history(byText)) return byText;

      // 结构兜底：顶部左侧的大按钮
      const fallback = Array.from(document.querySelectorAll('[role="button"], button'))
        .find((el) => {
          const r = el.getBoundingClientRect();
          return r.width >= 80 && r.height >= 30 && r.x >= 0 && r.x < 220 && r.y < 120;
        });
      return fallback || null;
    };

    const dsFind = (key, requireVisible = true) => {
      if (key === 'deepThinkToggle' || key === 'smartSearchToggle') return dsFindToggle(key);
      if (key === 'newChat') return dsFindNewChat();
      if (DS_TEXT_MATCHERS[key]) return dsFindByText(DS_TEXT_MATCHERS[key]);
      if (key === 'sendButton') return dsFindSend();
      return dsPick(key, requireVisible);
    };

    /**
     * 「继续生成」按钮。
     *
     * 只有被用户主动停止的最后一条回答下方才会出现。
     * 结构是一个 role=button 的胶囊，文字节点在 .ds-button__content 里，
     * 所以按**外层按钮的合并文本**匹配，返回外层 —— 点击坐标也以外层为准。
     */
    const dsFindContinue = () => {
      const labels = ['继续生成', 'Continue generating', 'Continue'];
      const nodes = Array.from(
        document.querySelectorAll('[role="button"], button, .ds-button'),
      );
      for (const el of nodes) {
        if (!dsVisible(el)) continue;
        const text = dsText(el);
        if (!text || text.length > 24) continue;
        if (labels.some((label) => text === label || text.endsWith(label))) return el;
      }
      return null;
    };

    /** 元素是否处于「开」的状态 */
    const dsIsOn = (el) => {
      const node = dsToggleRoot(el);
      if (!node) return null;
      const cls = String(node.className || '');
      if (cls.includes(DS_STATE.toggleSelected)) return true;
      const aria = node.getAttribute('aria-checked') ?? node.getAttribute('aria-pressed');
      if (aria !== null) return aria === 'true';
      const state = node.getAttribute('data-state');
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

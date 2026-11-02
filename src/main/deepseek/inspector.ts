import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type WebContentsView } from 'electron'
import { SELECTOR_KEYS, pagePrelude } from './selectors'

/**
 * DOM 探针（仅开发用）。
 *
 * 用途：在**真实已登录**的 DeepSeek 页面上，把选择器注册表里每一条的
 * 实际命中情况，以及周边候选元素抓回来。DeepSeek 改版后重跑一次，
 * 就知道该改 selectors.ts 里的哪一行。
 *
 * 已经在未登录页面上证实的事实：DeepSeek 的按钮是
 * `<div role="button" class="ds-button ds-button--primary">`，不是 `<button>`，
 * 而且多数没有 aria-label、只有纯文本。所以探针必须把「某个元素周边
 * 都有哪些按钮、各自什么文字」原样抓回来，光靠猜选择器没用。
 *
 * 触发：DS_INSPECT=1，然后菜单「开发者 → 导出 DOM 报告」(⌘⇧D)
 */

const REPORT_FILE = 'dom-report.json'

export async function writeDomReport(view: WebContentsView): Promise<string | null> {
  const script = `
    (() => {
      ${pagePrelude()}

      const describe = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          className: typeof el.className === 'string' ? el.className.slice(0, 180) : undefined,
          role: el.getAttribute('role') || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          dataTestId: el.getAttribute('data-testid') || undefined,
          placeholder: el.getAttribute('placeholder') || undefined,
          contentEditable: el.getAttribute('contenteditable') || undefined,
          text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 70) || undefined,
          visible: r.width > 0 && r.height > 0,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        };
      };

      const allButtons = () => Array.from(
        document.querySelectorAll('[role="button"], button, .ds-button')
      ).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });

      // 1. 注册表里每一条的实际命中情况
      const registry = {};
      for (const key of ${JSON.stringify(SELECTOR_KEYS)}) {
        const hit = dsFind(key);
        registry[key] = {
          matched: !!hit,
          via: hit ? DS_SELECTORS[key].find((s) => {
            try { return Array.from(document.querySelectorAll(s)).includes(hit); }
            catch (e) { return false; }
          }) : null,
          element: describe(hit),
        };
      }

      // 2. 所有候选输入框
      const inputs = Array.from(
        document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')
      ).slice(0, 12).map(describe);

      // 3. ★ 输入框周边：向上 5 层的祖先链，以及该区域内的全部按钮。
      //    这一块是用来锁定「发送按钮」「深度思考」「智能搜索」的关键。
      let composerZone = null;
      const composer = dsFind('composer', false);
      if (composer) {
        const chain = [];
        let node = composer;
        for (let i = 0; i < 5 && node && node !== document.body; i++) {
          chain.push(describe(node));
          node = node.parentElement;
        }
        let container = composer;
        for (let i = 0; i < 3 && container.parentElement; i++) container = container.parentElement;
        composerZone = {
          chain,
          buttonsInZone: Array.from(
            container.querySelectorAll('[role="button"], button, .ds-button')
          ).slice(0, 25).map(describe),
          containerHtmlSample: container.outerHTML.slice(0, 1500),
        };
      }

      // 4. 页面上全部 ds-button（学习命名约定）
      const dsButtons = allButtons()
        .filter((el) => typeof el.className === 'string' && el.className.includes('ds-button'))
        .slice(0, 30)
        .map(describe);

      // 5. 含关键词的元素
      const KEYWORDS = ['深度思考', '联网', '智能搜索', '新对话', '发送', 'Send', '停止'];
      const byKeyword = {};
      for (const kw of KEYWORDS) {
        byKeyword[kw] = Array.from(document.querySelectorAll('*'))
          .filter((el) => {
            const t = (el.innerText || '').trim();
            return t && t.length < 24 && t.includes(kw) && el.children.length === 0;
          })
          .slice(0, 4)
          .map((el) => ({ ...describe(el), parent: describe(el.parentElement) }));
      }

      // 6. 最后一条 AI 回答的祖先链 + 原始结构片段
      let lastAnswer = null;
      for (const sel of DS_SELECTORS.assistantMessage) {
        let nodes;
        try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
        if (!nodes.length) continue;
        const el = nodes[nodes.length - 1];
        const chain = [];
        let node = el;
        for (let i = 0; i < 4 && node && node !== document.body; i++) {
          chain.push(describe(node));
          node = node.parentElement;
        }
        lastAnswer = {
          matchedSelector: sel,
          totalMatches: nodes.length,
          chain,
          htmlSample: el.outerHTML.slice(0, 1800),
        };
        break;
      }

      return {
        url: location.href,
        title: document.title,
        loggedIn: !!composer,
        hasComposer: !!composer,
        registry,
        inputs,
        composerZone,
        dsButtons,
        byKeyword,
        lastAnswer,
      };
    })()
  `

  try {
    const report = (await view.webContents.executeJavaScript(script, true)) as unknown
    const file = join(app.getPath('userData'), REPORT_FILE)
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

    const r = report as { hasComposer?: boolean; registry?: Record<string, { matched: boolean }> }
    console.log(`\n[DOM 探针] 报告已写入: ${file}`)
    if (r.hasComposer) {
      console.log('[DOM 探针] 选择器命中情况:')
      for (const [key, value] of Object.entries(r.registry ?? {})) {
        console.log(`  ${value.matched ? '✅' : '❌'} ${key}`)
      }
    } else {
      console.log('[DOM 探针] 没找到输入框 —— 还没登录，或者不在对话页。')
    }
    return file
  } catch (err) {
    console.error('[DOM 探针] 执行失败:', err)
    return null
  }
}

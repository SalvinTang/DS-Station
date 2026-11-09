/**
 * 历史对话走接口时，接口返回的是原始 Markdown。
 * 这里用 markdown-it + KaTeX + highlight.js 自己渲染，
 * 支持官方网页端实际支持的 CommonMark / GFM / 数学公式 / 代码高亮。
 */

import MarkdownIt from 'markdown-it'
import texmath from 'markdown-it-texmath'
import taskLists from 'markdown-it-task-lists'
import footnote from 'markdown-it-footnote'
import hljs from 'highlight.js'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { CODE_COPY_ICON, attachCodeCopy, getCopyCodeLabel } from './markdown'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
})

md.use(taskLists, { enabled: true, label: true })
md.use(footnote)
md.use(texmath, {
  engine: katex,
  delimiters: ['dollars', 'brackets'],
  katexOptions: { throwOnError: false, strict: 'ignore' },
})

/** DeepSeek 的引用标记：转成数字角标 */
md.inline.ruler.before('link', 'ds_citation', (state: any, silent: boolean) => {
  const match = /^\[(?:citation|reference):(\d+)\]/.exec(state.src.slice(state.pos))
  if (!match) return false
  if (!silent) {
    const token = state.push('html_inline', '', 0)
    token.content = `<span class="md-cite">${match[1]}</span>`
  }
  state.pos += match[0].length
  return true
})

md.renderer.rules.fence = (tokens: any, idx: number): string => {
  const token = tokens[idx]
  const info = String(token.info || '').trim()
  const language = info.split(/\s+/)[0] || ''

  if (language === 'math') {
    return `<div class="md-math-display">${katex.renderToString(token.content.trim(), {
      displayMode: true,
      throwOnError: false,
    })}</div>\n`
  }

  let highlighted = md.utils.escapeHtml(token.content)
  if (language && hljs.getLanguage(language)) {
    try {
      highlighted = hljs.highlight(token.content, {
        language,
        ignoreIllegals: true,
      }).value
    } catch {
      highlighted = md.utils.escapeHtml(token.content)
    }
  }

  const label = md.utils.escapeHtml(language || 'text')
  const copyLabel = md.utils.escapeHtml(getCopyCodeLabel())
  return (
    `<div class="md-code-block">` +
    `<div class="md-code-head">` +
    `<span class="md-code-lang">${label}</span>` +
    `<button type="button" class="md-code-copy" title="${copyLabel}" aria-label="${copyLabel}">${CODE_COPY_ICON}</button>` +
    `</div>` +
    `<pre><code class="hljs">${highlighted}</code></pre>` +
    `</div>\n`
  )
}

/** 图片不加载远程资源，先只显示 alt 文本 */
md.renderer.rules.image = (tokens: any, idx: number): string => {
  const alt = tokens[idx].content || '图片'
  return `<span class="md-image-alt">${md.utils.escapeHtml(alt)}</span>`
}

/** Markdown HTML 缓存：8MB 内容预算、单条 512KB、LRU、仅内存 */
const MAX_CACHE_CHARS = 8 * 1024 * 1024
const MAX_ENTRY_CHARS = 512 * 1024
const htmlCache = new Map<string, string>()
let cacheChars = 0

function hashText(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= code
    h2 = Math.imul(h2, 0x85ebca6b)
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${text.length.toString(36)}`
}

function cacheGet(key: string): string | null {
  const value = htmlCache.get(key)
  if (value === undefined) return null
  // LRU：命中后移到队尾
  htmlCache.delete(key)
  htmlCache.set(key, value)
  return value
}

function cacheSet(key: string, html: string): void {
  if (!key || html.length > MAX_ENTRY_CHARS) return

  const existing = htmlCache.get(key)
  if (existing !== undefined) {
    cacheChars -= existing.length
    htmlCache.delete(key)
  }

  htmlCache.set(key, html)
  cacheChars += html.length

  while (cacheChars > MAX_CACHE_CHARS && htmlCache.size > 0) {
    const oldest = htmlCache.entries().next().value as [string, string] | undefined
    if (!oldest) break
    htmlCache.delete(oldest[0])
    cacheChars -= oldest[1].length
  }
}

/** 退出登录等场景可以主动清空缓存；正常使用由 LRU 控制上限 */
export function clearMarkdownCache(): void {
  htmlCache.clear()
  cacheChars = 0
}

/** 把一段接口 Markdown 渲染进 AI 气泡；同一个 message key + 内容 hash 会复用 HTML */
export function renderApiMarkdown(body: HTMLElement, markdown: string, messageKey?: string): void {
  const cacheKey = messageKey ? `${messageKey}:${hashText(markdown)}` : ''
  let html = cacheKey ? cacheGet(cacheKey) : null

  if (html === null) {
    html = md.render(markdown)
    if (cacheKey) cacheSet(cacheKey, html)
  }

  body.classList.add('md')
  body.innerHTML = html

  for (const button of Array.from(body.querySelectorAll<HTMLButtonElement>('.md-code-copy'))) {
    if (button.dataset.wired === '1') continue
    const pre = button.closest('.md-code-block')?.querySelector('pre')
    if (!pre) continue
    button.dataset.wired = '1'
    attachCodeCopy(button, pre as HTMLElement)
  }
}

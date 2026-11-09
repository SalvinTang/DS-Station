/**
 * 把 DeepSeek 页面里已经渲染好的 Markdown HTML 清洗成安全节点。
 *
 * 这里不解析 Markdown —— 页面已经解析过了，我们只做白名单过滤：
 *   - 保留标题/段落/列表/引用/表格/代码/链接/KaTeX
 *   - KaTeX 只取 MathML 部分（Chromium 原生支持），丢掉依赖 KaTeX CSS 的排版 DOM
 *   - 代码块只保留 <pre>，丢掉 DeepSeek 的外壳、图标和按钮
 *   - 其他未知标签一律拆掉，只保留里面的文字
 */

const BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'hr',
  'br',
])

const INLINE_TAGS = new Set(['strong', 'b', 'em', 'i', 'del', 's', 'sup', 'sub', 'kbd', 'code'])

const MATH_NS = 'http://www.w3.org/1998/Math/MathML'

/** 代码块右上角的复制按钮 */
let copyCodeLabel = '复制代码'

export function setMarkdownLabels(labels: { copyCode: string }): void {
  if (labels.copyCode) copyCodeLabel = labels.copyCode
}

export const CODE_COPY_ICON = `
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <rect x="5.6" y="5.6" width="8" height="8.6" rx="1.6" stroke="currentColor" stroke-width="1.3" />
    <path d="M10.4 5.6V3.6c0-.9-.7-1.6-1.6-1.6H3.6C2.7 2 2 2.7 2 3.6v5.2c0 .9.7 1.6 1.6 1.6h2"
          stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
  </svg>`

const CODE_DONE_ICON = `
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.6"
          stroke-linecap="round" stroke-linejoin="round" />
  </svg>`

/** 复制代码；成功后按钮短暂变成对勾 */
export function getCopyCodeLabel(): string {
  return copyCodeLabel
}

export function attachCodeCopy(button: HTMLButtonElement, pre: HTMLElement): void {
  button.addEventListener('click', () => copyCode(pre.textContent || '', button))
}

function copyCode(text: string, button: HTMLButtonElement): void {
  const done = (): void => {
    button.classList.add('copied')
    button.innerHTML = CODE_DONE_ICON
    window.setTimeout(() => {
      button.classList.remove('copied')
      button.innerHTML = CODE_COPY_ICON
    }, 1300)
  }

  const fallback = (): void => {
    const scratch = document.createElement('textarea')
    scratch.value = text
    scratch.style.position = 'fixed'
    scratch.style.opacity = '0'
    document.body.appendChild(scratch)
    scratch.select()
    document.execCommand('copy')
    scratch.remove()
    done()
  }

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback)
  } else {
    fallback()
  }
}

const MATH_TAGS = new Set([
  'math',
  'semantics',
  'mrow',
  'mi',
  'mo',
  'mn',
  'ms',
  'mtext',
  'mspace',
  'msup',
  'msub',
  'msubsup',
  'mfrac',
  'msqrt',
  'mroot',
  'mover',
  'munder',
  'munderover',
  'mtable',
  'mtr',
  'mtd',
  'mstyle',
  'mpadded',
  'menclose',
])

/** MathML 上保留的属性（其余 class/style/事件全部丢掉） */
const MATH_ATTRS = new Set([
  'xmlns',
  'display',
  'encoding',
  'mathvariant',
  'displaystyle',
  'scriptlevel',
  'stretchy',
  'fence',
  'separator',
  'largeop',
  'movablelimits',
  'symmetric',
  'maxsize',
  'minsize',
  'lspace',
  'rspace',
  'accent',
  'accentunder',
  'linethickness',
  'columnalign',
  'rowalign',
  'columnspacing',
  'rowspacing',
  'numalign',
  'denomalign',
  'bevelled',
  'width',
  'height',
  'depth',
  'voffset',
])

/** 代码高亮用到的 Prism token class，只允许这种简单的词 */
const TOKEN_WORD = /^[a-z][a-z0-9-]{0,30}$/i

function isKatex(element: HTMLElement): boolean {
  const cls = element.classList
  return (
    cls.contains('katex') ||
    cls.contains('katex-display') ||
    cls.contains('ds-markdown-math') ||
    element.tagName.toLowerCase() === 'math'
  )
}

/** 只保留 MathML 的 math 子树 */
function cleanMath(element: HTMLElement): Node | null {
  const math = element.tagName.toLowerCase() === 'math' ? element : element.querySelector('math')
  if (!math) return null

  const display =
    !!math.closest('.katex-display') ||
    math.getAttribute('display') === 'block' ||
    element.classList.contains('katex-display') ||
    element.classList.contains('ds-markdown-math')

  const clone = sanitizeMath(math)

  const wrapper = document.createElement(display ? 'div' : 'span')
  wrapper.className = display ? 'md-math-display' : 'md-math-inline'
  wrapper.appendChild(clone)
  return wrapper
}

function sanitizeMath(root: Element): Element {
  const out = document.createElementNS(MATH_NS, root.tagName.toLowerCase())

  for (const attr of Array.from(root.attributes)) {
    if (MATH_ATTRS.has(attr.name)) out.setAttribute(attr.name, attr.value)
  }

  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.appendChild(document.createTextNode(child.nodeValue ?? ''))
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const el = child as Element
    const tag = el.tagName.toLowerCase()
    if (!MATH_TAGS.has(tag)) continue
    // annotation 里是 TeX 源码，保留不影响显示
    out.appendChild(sanitizeMath(el))
  }

  return out
}

function tokenClass(className: string): string {
  const words = className.split(/\s+/).filter(Boolean)
  if (!words.includes('token')) return ''
  return words.filter((word) => word === 'token' || TOKEN_WORD.test(word)).join(' ')
}

/**
 * DeepSeek 的引用角标。
 *
 * 页面结构是：
 *   <span class="ds-markdown-cite">
 *     <span style="opacity:0">-</span>          ← 用来撑宽度的隐藏短横线
 *     <span style="position:absolute">2</span>  ← 数字
 *   </span>
 * 来源类角标里是品牌图标 + 名称，例如 [知乎] 知乎。
 * 参考页面的胶囊样式：14 高、9px 字、左下角切平的圆角。
 */
function brandPill(anchor: Element, citation: Element): HTMLElement {
  const pill = document.createElement('span')
  pill.className = 'md-cite md-cite-brand'

  // 图标可能因为重新解析 HTML 被挪出 brand-inner，所以从整条链接里找
  const image = citation.querySelector('img') || anchor.querySelector('img')
  const src = image?.getAttribute('src') || ''
  if (/^https:\/\/cdn\.deepseek\.com\//i.test(src)) {
    const icon = document.createElement('img')
    icon.className = 'md-cite-icon'
    icon.src = src
    icon.alt = ''
    icon.loading = 'lazy'
    icon.referrerPolicy = 'no-referrer'
    pill.appendChild(icon)
  }

  // 来源链接的 aria-label 就是来源名（例如「知乎」），最可靠
  const source =
    anchor.getAttribute('aria-label') ||
    citation.querySelector('.ds-markdown-cite-brand-inner')?.textContent ||
    citation.textContent ||
    ''
  const label = source
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-–—]\s*/, '')
  if (label) pill.appendChild(document.createTextNode(label))
  return pill
}

function cleanCitation(element: HTMLElement): Node {
  const pill = document.createElement('span')
  pill.className = 'md-cite'

  // 来源类角标（[知乎] 知乎）：外层类名是唯一可靠的标志。
  // 图标/文字的 DOM 嵌套在重新解析 HTML 时可能被拆开，所以从整个角标里找。
  if (element.classList.contains('ds-markdown-cite-brand')) {
    pill.classList.add('md-cite-brand')

    const image = element.querySelector('img')
    const src = image?.getAttribute('src') || ''
    // 只允许 DeepSeek 自己的来源图标，不加载任意远程图片
    if (/^https:\/\/cdn\.deepseek\.com\//i.test(src)) {
      const icon = document.createElement('img')
      icon.className = 'md-cite-icon'
      icon.src = src
      icon.alt = ''
      icon.loading = 'lazy'
      icon.referrerPolicy = 'no-referrer'
      pill.appendChild(icon)
    }

    const brandInner = element.querySelector('.ds-markdown-cite-brand-inner')
    const source = brandInner?.textContent?.trim() ? brandInner.textContent : element.textContent
    const label = (source || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[-–—]\s*/, '')
    if (label) pill.appendChild(document.createTextNode(label))
    return pill
  }

  const label = (element.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-–—]\s*/, '')
  pill.textContent = label || '•'
  return pill
}

/** 把未知容器拆开，只保留子节点 */
function unwrap(element: Element): DocumentFragment {
  const fragment = document.createDocumentFragment()
  for (const child of Array.from(element.childNodes)) {
    const clean = cleanNode(child)
    if (clean) fragment.appendChild(clean)
  }
  return fragment
}

function appendCleaned(target: Element, source: Element): void {
  for (const child of Array.from(source.childNodes)) {
    const clean = cleanNode(child)
    if (clean) target.appendChild(clean)
  }
}

function cleanNode(node: Node): Node | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return document.createTextNode(node.nodeValue ?? '')
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null

  const element = node as HTMLElement
  const tag = element.tagName.toLowerCase()

  // 危险元素直接丢弃
  if (
    tag === 'script' ||
    tag === 'style' ||
    tag === 'iframe' ||
    tag === 'object' ||
    tag === 'embed' ||
    tag === 'svg' ||
    tag === 'canvas' ||
    tag === 'img' ||
    tag === 'video' ||
    tag === 'audio' ||
    tag === 'input' ||
    tag === 'button' ||
    tag === 'link' ||
    tag === 'meta'
  ) {
    return null
  }

  if (isKatex(element)) return cleanMath(element)

  if (element.classList.contains('ds-markdown-cite')) return cleanCitation(element)

  // DeepSeek 的代码块：还原顶部语言标签 + 只保留一个图标复制按钮
  if (element.classList.contains('md-code-block')) {
    const pre = element.querySelector('pre')
    if (!pre) return unwrap(element)

    const banner = element.querySelector('.md-code-block-banner')
    let language = (banner?.querySelector('span')?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!language && banner) {
      language = (banner.textContent || '')
        .replace(/\b(复制|下载|Copy|Download)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
    }
    language = language.slice(0, 24)

    const wrap = document.createElement('div')
    wrap.className = 'md-code-block'

    const head = document.createElement('div')
    head.className = 'md-code-head'

    const languageEl = document.createElement('span')
    languageEl.className = 'md-code-lang'
    languageEl.textContent = language
    head.appendChild(languageEl)

    const copyButton = document.createElement('button')
    copyButton.type = 'button'
    copyButton.className = 'md-code-copy'
    copyButton.title = copyCodeLabel
    copyButton.setAttribute('aria-label', copyCodeLabel)
    copyButton.innerHTML = CODE_COPY_ICON
    head.appendChild(copyButton)

    wrap.appendChild(head)

    const cleanPre = cleanNode(pre)
    if (cleanPre) {
      wrap.appendChild(cleanPre)
      attachCodeCopy(copyButton, cleanPre as HTMLElement)
    }
    return wrap
  }

  if (tag === 'a') {
    const href = element.getAttribute('href') || ''
    const safeHref = /^https?:\/\//i.test(href)

    // 来源角标：链接里包着 .ds-markdown-cite-brand
    const brandCitation = element.querySelector('.ds-markdown-cite-brand')
    if (brandCitation) {
      const pill = brandPill(element, brandCitation)
      if (!safeHref) return pill
      const link = document.createElement('a')
      link.setAttribute('href', href)
      link.setAttribute('rel', 'noreferrer noopener')
      link.appendChild(pill)
      return link
    }

    if (!safeHref) {
      // 非 http(s) 链接：去掉链接本身，只保留文字
      return unwrap(element)
    }
    const link = document.createElement('a')
    link.setAttribute('href', href)
    link.setAttribute('rel', 'noreferrer noopener')
    appendCleaned(link, element)
    return link
  }

  if (tag === 'span') {
    const cls = String(element.className || '')
    if (/(^|\s)token(\s|$)/.test(cls)) {
      const span = document.createElement('span')
      span.className = tokenClass(cls)
      appendCleaned(span, element)
      return span
    }
    return unwrap(element)
  }

  if (BLOCK_TAGS.has(tag) || INLINE_TAGS.has(tag)) {
    const clean = document.createElement(tag)
    if (tag === 'ol' && element.getAttribute('start')) {
      clean.setAttribute('start', String(Number(element.getAttribute('start')) || 1))
    }
    if ((tag === 'th' || tag === 'td') && element.getAttribute('colspan')) {
      clean.setAttribute('colspan', String(Number(element.getAttribute('colspan')) || 1))
    }
    if ((tag === 'th' || tag === 'td') && element.getAttribute('rowspan')) {
      clean.setAttribute('rowspan', String(Number(element.getAttribute('rowspan')) || 1))
    }
    if (tag === 'th' || tag === 'td') {
      const align = element.getAttribute('align')
      if (align === 'left' || align === 'center' || align === 'right') {
        clean.setAttribute('align', align)
      }
    }
    appendCleaned(clean, element)
    return clean
  }

  // 其它容器（div 等）：拆开，保留内容
  return unwrap(element)
}

/** 把清洗后的 HTML 渲染到 AI 气泡里 */
export function renderAiContent(body: HTMLElement, text: string, html?: string): void {
  if (!html) {
    body.classList.remove('md')
    body.textContent = text
    return
  }

  /*
   * 来源角标里用 <div> 包图标，而整条角标又被 <a>/<span> 包着；
   * 重新解析 HTML 时浏览器会把 div（连带 img）挪出 citation，
   * 导致图标丢失。先把这个 div 换成 span，结构就不会被拆开。
   */
  const normalized = html.replace(
    /<div([^>]*class="[^"]*\bds-markdown-cite-brand-icon\b[^"]*"[^>]*)>([\s\S]*?)<\/div>/g,
    '<span$1>$2</span>',
  )

  const template = document.createElement('template')
  template.innerHTML = normalized

  const fragment = document.createDocumentFragment()
  for (const child of Array.from(template.content.childNodes)) {
    const clean = cleanNode(child)
    if (clean) fragment.appendChild(clean)
  }

  // 表格统一包一层横向滚动
  const holder = document.createElement('div')
  holder.appendChild(fragment)
  for (const table of Array.from(holder.querySelectorAll('table'))) {
    if (table.parentElement?.classList.contains('md-table-wrap')) continue
    const wrap = document.createElement('div')
    wrap.className = 'md-table-wrap'
    table.replaceWith(wrap)
    wrap.appendChild(table)
  }

  body.replaceChildren(...Array.from(holder.childNodes))
  body.classList.add('md')
}

/**
 * 快捷窗口。
 *
 * 这里只负责界面：输入自适应、消息渲染、顶栏悬停、复制。
 * 真正跟 DeepSeek 通信是主进程的事 —— 我们发 submitQuickMessage，
 * 然后等它把 answer-start / answer-update / answer-done 推回来。
 */

import type { QuickEvent, QuickMode, QuickSubmitPayload } from '../../shared/types'

const MIN_WINDOW_HEIGHT = 100
const MAX_WINDOW_HEIGHT = 200
/** 一行的高度：line-height 22 + 上下 padding 各 3 */
const TEXTAREA_MIN = 28
/** 输入框之外的固定开销：外框描边 2 + 上下 padding 15/9 + 工具栏 36 */
const COMPOSER_CHROME = 62
/** 窗口最高 200，输入框最多占 138，再多就出滚动条 */
const TEXTAREA_MAX = MAX_WINDOW_HEIGHT - COMPOSER_CHROME

/** 设计稿（ui尺寸.html）：鼠标移出窗口 1 秒后顶栏自动消失 */
const TOPBAR_HIDE_DELAY = 1000

const COPY_ICON = `
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path fill="currentColor" d="M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016 8.49597 4.07598C9.12128 4.13269 9.65792 4.25188 10.1415 4.53106C10.7202 4.8653 11.2008 5.3459 11.535 5.92462C11.8142 6.40818 11.9334 6.94481 11.9901 7.57012C12.0459 8.18625 12.0458 8.95419 12.0458 9.9168C12.0458 10.8795 12.0459 11.6473 11.9901 12.2635C11.9334 12.8888 11.8142 13.4254 11.535 13.909C11.2008 14.4877 10.7202 14.9683 10.1415 15.3025C9.65792 15.5817 9.12128 15.7009 8.49597 15.7576C7.87984 15.8134 7.11196 15.8133 6.14929 15.8133C5.18667 15.8133 4.41874 15.8134 3.80261 15.7576C3.1773 15.7009 2.64067 15.5817 2.1571 15.3025C1.5784 14.9683 1.09778 14.4877 0.76355 13.909C0.484366 13.4254 0.365184 12.8888 0.308472 12.2635C0.252649 11.6473 0.252808 10.8795 0.252808 9.9168C0.252808 8.95418 0.252664 8.18625 0.308472 7.57012C0.365184 6.94481 0.484366 6.40818 0.76355 5.92462C1.09777 5.34589 1.57839 4.86529 2.1571 4.53106C2.64067 4.25188 3.1773 4.13269 3.80261 4.07598C4.41874 4.02017 5.18666 4.02032 6.14929 4.02032ZM6.14929 5.37774C5.16181 5.37774 4.46634 5.37761 3.92566 5.42657C3.39434 5.47472 3.07859 5.56574 2.83582 5.70587C2.4632 5.92106 2.15354 6.2307 1.93835 6.60333C1.79823 6.8461 1.70721 7.16185 1.65906 7.69317C1.6101 8.23385 1.61023 8.92933 1.61023 9.9168C1.61023 10.9043 1.61009 11.5998 1.65906 12.1404C1.70721 12.6717 1.79823 12.9875 1.93835 13.2303C2.15356 13.6029 2.46321 13.9126 2.83582 14.1277C3.07859 14.2679 3.39434 14.3589 3.92566 14.407C4.46634 14.456 5.16182 14.4559 6.14929 14.4559C7.13682 14.4559 7.83224 14.456 8.37292 14.407C8.90425 14.3589 9.21999 14.2679 9.46277 14.1277C9.83535 13.9126 10.145 13.6029 10.3602 13.2303C10.5004 12.9875 10.5914 12.6717 10.6395 12.1404C10.6885 11.5998 10.6884 10.9043 10.6884 9.9168C10.6884 8.92934 10.6885 8.23384 10.6395 7.69317C10.5914 7.16185 10.5004 6.8461 10.3602 6.60333C10.1451 6.23071 9.83536 5.92107 9.46277 5.70587C9.21999 5.56574 8.90424 5.47472 8.37292 5.42657C7.83224 5.3776 7.13682 5.37774 6.14929 5.37774ZM9.80164 0.367975C10.7638 0.367975 11.5314 0.36788 12.1473 0.423639C12.7726 0.480307 13.3093 0.598759 13.7928 0.877741C14.3717 1.21192 14.8521 1.69355 15.1864 2.27227C15.4655 2.75574 15.5857 3.29164 15.6425 3.9168C15.6983 4.53301 15.6971 5.3016 15.6971 6.26446V7.82989C15.6971 8.29264 15.6989 8.58993 15.6649 8.84844C15.4668 10.3525 14.401 11.5738 12.9833 11.9988V10.5467C13.6973 10.1903 14.2105 9.49662 14.3192 8.67169C14.3387 8.52347 14.3407 8.3358 14.3407 7.82989V6.26446C14.3407 5.27706 14.3398 4.58149 14.2909 4.04083C14.2428 3.50968 14.1526 3.19372 14.0126 2.95098C13.7974 2.57849 13.4876 2.26869 13.1151 2.05352C12.8724 1.91347 12.5564 1.82237 12.0253 1.77423C11.4847 1.72528 10.7888 1.7254 9.80164 1.7254H7.71472C6.7562 1.72558 5.92665 2.27697 5.52332 3.07891H4.07019C4.54221 1.51132 5.9932 0.368186 7.71472 0.367975H9.80164Z" />
  </svg>`

const DONE_ICON = `
  <svg viewBox="0 0 1024 1024" width="16" height="16" aria-hidden="true">
    <path fill="currentColor" d="M510.999207 64.425312c-245.292636 0-445.986517 200.693882-445.986518 445.986517 0 245.293659 200.693882 445.98754 445.986518 445.98754 245.293659 0 445.98754-200.693882 445.98754-445.98754 0-245.292636-200.693882-445.986517-445.98754-445.986517z m0 802.776549c-196.234313 0-356.789009-160.554696-356.78901-356.790032 0-196.234313 160.554696-356.789009 356.78901-356.789009 196.235336 0 356.790032 160.554696 356.790032 356.789009S707.235566 867.201861 510.999207 867.201861z" />
    <path fill="currentColor" d="M509.09688 641.340787c-7.423063 7.42511-17.148565 11.136641-26.874067 11.136641-9.726525 0-19.453051-3.711532-26.874067-11.136641L328.643995 514.636037c-7.820106-7.818059-11.261485-18.160615-10.839882-28.384468 0.372483-9.205663 3.811816-18.334577 10.839882-25.36162 7.027044-7.03216 16.156982-10.471492 25.363668-10.843976 10.221806-0.417509 20.566408 3.019777 28.384467 10.843976l99.830683 99.825566 175.853124-175.850054c7.818059-7.820106 18.164708-11.261485 28.384467-10.839882 9.206686 0.37453 18.337647 3.811816 25.363667 10.839882 7.02909 7.027044 10.467399 16.161075 10.839883 25.363668 0.420579 10.221806-3.019777 20.566408-10.839883 28.386514l-202.727191 202.725144z" />
  </svg>`

/** 文案表（注意别和下面的 messages 元素重名） */
let texts: Record<string, string> = {}

function t(key: string, vars?: Record<string, string | number>): string {
  let text = texts[key] ?? key
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

/** 把文案贴到各处的 title / placeholder / aria-label 上 */
function applyMessages(): void {
  input.placeholder = t('quick.placeholder')

  const labelled: [Element | null, string][] = [
    [deepThinkButton, 'quick.deepThink'],
    [smartSearchButton, 'quick.smartSearch'],
    [sendButton, 'quick.send'],
    [tbClose, 'quick.close'],
    [tbNewChat, 'quick.newChat'],
    [tbExpand, 'quick.expand'],
  ]
  for (const [element, key] of labelled) {
    if (!element) continue
    element.setAttribute('title', t(key))
    element.setAttribute('aria-label', t(key))
  }
}

async function loadMessages(): Promise<void> {
  texts = (await window.ds?.getMessages()) ?? {}
  applyMessages()
}

const app = document.getElementById('app') as HTMLElement
const topbar = document.getElementById('topbar') as HTMLElement
const messages = document.getElementById('messages') as HTMLElement
const messagesInner = document.getElementById('messagesInner') as HTMLElement

const input = document.getElementById('input') as HTMLTextAreaElement
const deepThinkButton = document.getElementById('deepThink')
const smartSearchButton = document.getElementById('smartSearch')
const sendButton = document.getElementById('send') as HTMLButtonElement

const tbClose = document.getElementById('tbClose')
const tbNewChat = document.getElementById('tbNewChat')
const tbExpand = document.getElementById('tbExpand')

let mode: QuickMode = 'empty'
/** 拖动窗口：按下时的鼠标屏幕坐标 */
let dragOrigin: { x: number; y: number } | null = null
/** 正在等回答：这期间禁止再次发送 */
let busy = false
/** 当前正在流式更新的那条回答 */
let streamingBody: HTMLElement | null = null
/** 等待回答时的呼吸点占位 */
let thinkingEl: HTMLElement | null = null
let topbarTimer: number | undefined

// ── 输入框自适应 ──────────────────────────────────────────────

function autosize(): void {
  input.style.height = 'auto'
  const natural = input.scrollHeight
  const height = Math.min(Math.max(natural, TEXTAREA_MIN), TEXTAREA_MAX)

  input.style.height = `${height}px`
  // 达到上限后不再长高，改为出滚动条（设计稿原文）
  input.style.overflowY = natural > height ? 'auto' : 'hidden'

  if (mode === 'empty') {
    // 空态：窗口跟着一起长高（输入框 + 固定开销），夹在 100–200 之间。
    // 主进程负责保持底边不动、只把顶边上移
    const windowHeight = Math.min(
      MAX_WINDOW_HEIGHT,
      Math.max(MIN_WINDOW_HEIGHT, COMPOSER_CHROME + height),
    )
    window.ds?.resizeQuickWindow(windowHeight)
  }
}

function syncSendState(): void {
  sendButton.disabled = busy || input.value.trim().length === 0
}

/**
 * 把光标放回输入框。
 *
 * 只在窗口本身是前台时生效 —— 面板在后台（比如回答流着的时候用户切走了）
 * 不应该把焦点抢回来。
 */
function focusInput(): void {
  if (!document.hasFocus()) return
  input.focus({ preventScroll: true })
}

function isPressed(element: Element | null): boolean {
  return element?.getAttribute('aria-pressed') === 'true'
}

function togglePressed(element: Element | null): void {
  element?.setAttribute('aria-pressed', String(!isPressed(element)))
}

// ── 消息渲染 ──────────────────────────────────────────────────

function scrollToBottom(): void {
  messages.scrollTop = messages.scrollHeight
}

function makeCopyButton(read: () => string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'copy-btn'
  button.title = t('quick.copy')
  button.setAttribute('aria-label', t('quick.copy'))
  button.innerHTML = COPY_ICON
  button.addEventListener('click', () => void copyText(read(), button))
  return button
}

async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // file:// 下 clipboard API 偶尔不可用，退回老办法
    const scratch = document.createElement('textarea')
    scratch.value = text
    scratch.style.position = 'fixed'
    scratch.style.opacity = '0'
    document.body.appendChild(scratch)
    scratch.select()
    document.execCommand('copy')
    scratch.remove()
  }

  // 设计稿：复制完成后按钮变成「完成」图标，2 秒后复原
  button.classList.add('done')
  button.innerHTML = DONE_ICON
  window.setTimeout(() => {
    button.classList.remove('done')
    button.innerHTML = COPY_ICON
  }, 2000)

  // 复制完把光标还给输入框
  focusInput()
}

function appendMessage(kind: 'user' | 'ai', text: string): HTMLElement {
  const group = document.createElement('div')
  group.className = 'msg-group'

  const template = document.getElementById(kind === 'user' ? 'tplUser' : 'tplAi')
  if (template instanceof HTMLTemplateElement) group.appendChild(template.content.cloneNode(true))

  const body = group.querySelector(kind === 'user' ? '.bubble' : '.body') as HTMLElement
  body.textContent = text

  const actions = group.querySelector('.msg-actions') as HTMLElement
  actions.appendChild(makeCopyButton(() => body.textContent ?? ''))

  messagesInner.appendChild(group)
  scrollToBottom()
  return body
}

function addThinking(): void {
  if (thinkingEl) return
  const group = document.createElement('div')
  group.className = 'msg-group'
  const box = document.createElement('div')
  box.className = 'thinking'
  box.innerHTML = '<i></i><i></i><i></i>'
  group.appendChild(box)
  messagesInner.appendChild(group)
  thinkingEl = group
  scrollToBottom()
}

function removeThinking(): void {
  thinkingEl?.remove()
  thinkingEl = null
}

function clearMessages(): void {
  messagesInner.replaceChildren()
  streamingBody = null
  thinkingEl = null
}

// ── 形态切换 ──────────────────────────────────────────────────

/**
 * 只改界面自身的状态，不通知主进程。
 * 主进程推来 mode-changed 时也走这里，避免来回互相调用。
 */
function applyMode(next: QuickMode): void {
  if (mode === next) return
  mode = next
  app.dataset.mode = next

  if (next === 'empty') {
    busy = false
    clearMessages()
    topbar.classList.remove('show')
    app.classList.remove('content-enter')
    app.classList.remove('content-leave')
    input.value = ''
  }

  autosize()
  syncSendState()
}

function switchToContent(): void {
  applyMode('content')
  window.ds?.setQuickMode('content')
}

function resetToEmpty(): void {
  applyMode('empty')
  window.ds?.setQuickMode('empty')
}

// ── 发送 ──────────────────────────────────────────────────────

function submit(): void {
  const text = input.value.trim()
  if (!text || busy) return

  /*
   * 空态 → 有内容态：主进程会把窗口下移再向上长高。
   * 这期间先把内容藏起来，等主进程发来 transition-done 再淡入 ——
   * 效果就是「外框先撑开，内容再出现」。
   */
  const enteringContent = mode === 'empty'

  const payload: QuickSubmitPayload = {
    text,
    deepThink: isPressed(deepThinkButton),
    smartSearch: isPressed(smartSearchButton),
    // 空态发出的消息 = 新对话的第一条，主进程会先开新会话
    startNewChat: enteringContent,
  }

  if (enteringContent) {
    app.classList.add('content-enter')
    // 兜底：万一没收到 transition-done，也不要把内容永久藏着
    window.setTimeout(() => app.classList.remove('content-enter'), 1500)
  }

  // 先把反馈给到用户：切形态 + 画出自己那条气泡，然后再等回答
  switchToContent()
  appendMessage('user', text)
  addThinking()

  busy = true
  input.value = ''
  autosize()
  syncSendState()
  // 发送后光标留在输入框，方便接着写下一句
  focusInput()

  window.ds?.submitQuickMessage(payload)
}

// ── 主进程推来的事件 ──────────────────────────────────────────

window.ds?.onQuickEvent((event: QuickEvent) => {
  switch (event.type) {
    case 'answer-update': {
      removeThinking()
      if (streamingBody) {
        streamingBody.textContent = event.text
      } else {
        streamingBody = appendMessage('ai', event.text)
      }
      scrollToBottom()
      break
    }

    case 'answer-done': {
      removeThinking()
      streamingBody = null
      busy = false
      syncSendState()
      // 回答结束，光标回到输入框
      focusInput()
      break
    }

    case 'mode-changed': {
      applyMode(event.mode)
      // 收回空态之后，用户多半是要马上打字
      if (event.mode === 'empty') focusInput()
      break
    }

    case 'transition-done': {
      // 展开动画结束，内容淡入
      app.classList.remove('content-enter')
      break
    }

    case 'conversation-cleared': {
      resetToEmpty()
      break
    }

    case 'error': {
      removeThinking()
      streamingBody = null
      busy = false
      appendMessage('ai', `${t('quick.error')}：${event.message}`)
      syncSendState()
      break
    }

    case 'answer-start':
      // 呼吸点已经在提交时就放好了
      break
  }
})

// ── 交互绑定 ──────────────────────────────────────────────────

input.addEventListener('input', () => {
  autosize()
  syncSendState()
})

input.addEventListener('keydown', (event) => {
  // isComposing：中文输入法选词时的回车不能当成发送
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit()
  }
})

deepThinkButton?.addEventListener('click', () => togglePressed(deepThinkButton))
smartSearchButton?.addEventListener('click', () => togglePressed(smartSearchButton))
sendButton.addEventListener('click', submit)

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    window.ds?.hideQuickWindow()
  }
})

// 设计稿：鼠标移入窗口任意位置出现顶栏，移出后 2 秒自动消失
function showTopbar(): void {
  if (mode !== 'content') return
  if (topbarTimer) window.clearTimeout(topbarTimer)
  topbarTimer = undefined
  topbar.classList.add('show')
}

function scheduleTopbarHide(): void {
  if (mode !== 'content') return
  if (topbarTimer) window.clearTimeout(topbarTimer)
  topbarTimer = window.setTimeout(() => {
    topbar.classList.remove('show')
    topbarTimer = undefined
  }, TOPBAR_HIDE_DELAY)
}

app.addEventListener('mouseenter', showTopbar)
// 兜底：面板是「在鼠标下面冒出来」的，那一刻不会有 mouseenter，
// 所以还要听 mousemove
app.addEventListener('mousemove', showTopbar)
app.addEventListener('mouseleave', scheduleTopbarHide)

tbClose?.addEventListener('click', () => window.ds?.hideQuickWindow())
tbNewChat?.addEventListener('click', () => {
  // 收起动画：内容先淡出，等主进程把窗口收回去、发来 mode-changed 再切空态
  app.classList.add('content-leave')
  window.setTimeout(() => app.classList.remove('content-leave'), 1500)
  window.ds?.quickNewChat()
})
tbExpand?.addEventListener('click', () => window.ds?.quickExpand())

// ── 拖动窗口 ──────────────────────────────────────────────────
/*
 * 窗口是透明的，-webkit-app-region: drag 在这种窗口上不可靠，
 * 所以改成手动拖动：按住面板上**没有被控件遮挡**的地方就能移动整个窗口。
 * 消息区排除在外（要能选中文字、滚动），按钮和输入框同理。
 */
app.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  const target = event.target as HTMLElement | null
  if (target?.closest('button, textarea, input, select, a, .messages')) return

  dragOrigin = { x: event.screenX, y: event.screenY }
  try {
    app.setPointerCapture(event.pointerId)
  } catch {
    // 合成事件下没有活跃指针，捕获失败不影响拖动本身
  }
  window.ds?.beginWindowDrag(event.screenX, event.screenY)
  showTopbar()
  event.preventDefault()
})

app.addEventListener('pointermove', (event) => {
  if (!dragOrigin) return
  window.ds?.moveWindowDrag(event.screenX, event.screenY)
})

function endWindowDrag(event: PointerEvent): void {
  if (!dragOrigin) return
  dragOrigin = null
  try {
    if (app.hasPointerCapture(event.pointerId)) app.releasePointerCapture(event.pointerId)
  } catch {
    // 忽略
  }
  window.ds?.endWindowDrag()
}

app.addEventListener('pointerup', endWindowDrag)
app.addEventListener('pointercancel', endWindowDrag)

// 被重新唤出时：焦点回到输入框，并按输入框里**当前**的内容重新量一次高度 ——
// 用户收起面板时可能已经打了一大段字，不能缩回初始尺寸。
window.ds?.onQuickShown(() => {
  // 顺手重拉一次文案 —— 用户可能刚在设置里换了语言
  void loadMessages()
  app.classList.remove('content-enter')
  autosize()
  input.focus()
})

// 焦点一回到窗口，光标就落在输入框里（从别的 App 切回来、重新唤出都算）
window.addEventListener('focus', focusInput)

/*
 * 点工具栏按钮、复制按钮之后，把光标还给输入框。
 * 消息区的点击不拦 —— 那里要能选中文字。
 */
app.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null
  if (!target) return
  if (target.closest('.toolbar .tool-btn, .copy-btn')) {
    focusInput()
    return
  }
  if (target.closest('.composer') && !target.closest('textarea, button')) {
    focusInput()
  }
})

void loadMessages()
autosize()
syncSendState()
input.focus()

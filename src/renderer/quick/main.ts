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
/** 一行的高度：line-height 20 + 上下 padding 各 4 */
const TEXTAREA_MIN = 28
/** 空态下输入框最多长到 28 + 100 = 128，再多就出滚动条 */
const TEXTAREA_MAX = TEXTAREA_MIN + (MAX_WINDOW_HEIGHT - MIN_WINDOW_HEIGHT)

/** 设计稿：鼠标移出窗口 2 秒后顶栏自动消失 */
const TOPBAR_HIDE_DELAY = 2000

const COPY_ICON = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
       stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2.5" />
    <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
  </svg>`

const DONE_ICON = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
       stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M20 6L9 17l-5-5" />
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
    // 空态：窗口跟着一起长高。主进程负责保持底边不动、只把顶边上移
    window.ds?.resizeQuickWindow(MIN_WINDOW_HEIGHT + (height - TEXTAREA_MIN))
  }
}

function syncSendState(): void {
  sendButton.disabled = busy || input.value.trim().length === 0
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

  const payload: QuickSubmitPayload = {
    text,
    deepThink: isPressed(deepThinkButton),
    smartSearch: isPressed(smartSearchButton),
  }

  // 先把反馈给到用户：切形态 + 画出自己那条气泡，然后再等回答
  switchToContent()
  appendMessage('user', text)
  addThinking()

  busy = true
  input.value = ''
  autosize()
  syncSendState()

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
      // 焦点收回输入框，方便接着追问
      input.focus()
      break
    }

    case 'mode-changed': {
      applyMode(event.mode)
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
tbNewChat?.addEventListener('click', () => window.ds?.quickNewChat())
tbExpand?.addEventListener('click', () => window.ds?.quickExpand())

// 被重新唤出时：焦点回到输入框，并按输入框里**当前**的内容重新量一次高度 ——
// 用户收起面板时可能已经打了一大段字，不能缩回初始尺寸。
window.ds?.onQuickShown(() => {
  // 顺手重拉一次文案 —— 用户可能刚在设置里换了语言
  void loadMessages()
  autosize()
  input.focus()
})

void loadMessages()
autosize()
syncSendState()
input.focus()

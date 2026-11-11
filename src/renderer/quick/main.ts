/**
 * 快捷窗口。
 *
 * 这里只负责界面：输入自适应、消息渲染、顶栏悬停、复制。
 * 真正跟 DeepSeek 通信是主进程的事 —— 我们发 submitQuickMessage，
 * 然后等它把 answer-start / answer-update / answer-done 推回来。
 */

import type {
  HistoryEntry,
  HistoryMessage,
  QuickEvent,
  QuickMode,
  QuickSubmitPayload,
  SearchInfo,
  SearchSource,
  SearchSummary,
  ThinkingInfo,
  ThinkingOpenSegment,
  ThinkingSearch,
  ThinkingSearchSegment,
  ThinkingSegment,
  ThinkingTextSegment,
} from '../../shared/types'
import { renderAiContent, setMarkdownLabels } from './markdown'
import { clearMarkdownCache, renderApiMarkdown } from './markdown-render'

const MIN_WINDOW_HEIGHT = 100
const MAX_WINDOW_HEIGHT = 200
/** 一行的高度：line-height 22 + 上下 padding 各 3 */
const TEXTAREA_MIN = 28
/** 输入框之外的固定开销：外框描边 2 + 上下 padding 15/7 + 工具栏 36 */
const COMPOSER_CHROME = 60
/** 窗口最高 200，输入框最多占 138，再多就出滚动条 */
const TEXTAREA_MAX = MAX_WINDOW_HEIGHT - COMPOSER_CHROME

/** 设计稿（ui尺寸.html）：鼠标移出窗口 1 秒后顶栏自动消失 */
const TOPBAR_HIDE_DELAY = 1000

/** 顶栏高 40；新消息的顶端对齐到它下面 10px */
const TOPBAR_HEIGHT = 40
const MESSAGE_TOP_GAP = 10
const MESSAGE_TOP_ANCHOR = TOPBAR_HEIGHT + MESSAGE_TOP_GAP

/** 离顶部多少像素内就提前加载更早的历史 */
const OLDER_TRIGGER = 150
/**
 * 补位空间多留一点富余：等待回答的呼吸点只有几像素高，
 * 回答开始时它会被移除，若可滚动高度刚好卡满，scrollTop 会被浏览器夹一下，
 * 消息就会往下漂几像素。
 */
const TAIL_SLACK = 16

const COPY_ICON = `
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path fill="currentColor" d="M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016 8.49597 4.07598C9.12128 4.13269 9.65792 4.25188 10.1415 4.53106C10.7202 4.8653 11.2008 5.3459 11.535 5.92462C11.8142 6.40818 11.9334 6.94481 11.9901 7.57012C12.0459 8.18625 12.0458 8.95419 12.0458 9.9168C12.0458 10.8795 12.0459 11.6473 11.9901 12.2635C11.9334 12.8888 11.8142 13.4254 11.535 13.909C11.2008 14.4877 10.7202 14.9683 10.1415 15.3025C9.65792 15.5817 9.12128 15.7009 8.49597 15.7576C7.87984 15.8134 7.11196 15.8133 6.14929 15.8133C5.18667 15.8133 4.41874 15.8134 3.80261 15.7576C3.1773 15.7009 2.64067 15.5817 2.1571 15.3025C1.5784 14.9683 1.09778 14.4877 0.76355 13.909C0.484366 13.4254 0.365184 12.8888 0.308472 12.2635C0.252649 11.6473 0.252808 10.8795 0.252808 9.9168C0.252808 8.95418 0.252664 8.18625 0.308472 7.57012C0.365184 6.94481 0.484366 6.40818 0.76355 5.92462C1.09777 5.34589 1.57839 4.86529 2.1571 4.53106C2.64067 4.25188 3.1773 4.13269 3.80261 4.07598C4.41874 4.02017 5.18666 4.02032 6.14929 4.02032ZM6.14929 5.37774C5.16181 5.37774 4.46634 5.37761 3.92566 5.42657C3.39434 5.47472 3.07859 5.56574 2.83582 5.70587C2.4632 5.92106 2.15354 6.2307 1.93835 6.60333C1.79823 6.8461 1.70721 7.16185 1.65906 7.69317C1.6101 8.23385 1.61023 8.92933 1.61023 9.9168C1.61023 10.9043 1.61009 11.5998 1.65906 12.1404C1.70721 12.6717 1.79823 12.9875 1.93835 13.2303C2.15356 13.6029 2.46321 13.9126 2.83582 14.1277C3.07859 14.2679 3.39434 14.3589 3.92566 14.407C4.46634 14.456 5.16182 14.4559 6.14929 14.4559C7.13682 14.4559 7.83224 14.456 8.37292 14.407C8.90425 14.3589 9.21999 14.2679 9.46277 14.1277C9.83535 13.9126 10.145 13.6029 10.3602 13.2303C10.5004 12.9875 10.5914 12.6717 10.6395 12.1404C10.6885 11.5998 10.6884 10.9043 10.6884 9.9168C10.6884 8.92934 10.6885 8.23384 10.6395 7.69317C10.5914 7.16185 10.5004 6.8461 10.3602 6.60333C10.1451 6.23071 9.83536 5.92107 9.46277 5.70587C9.21999 5.56574 8.90424 5.47472 8.37292 5.42657C7.83224 5.3776 7.13682 5.37774 6.14929 5.37774ZM9.80164 0.367975C10.7638 0.367975 11.5314 0.36788 12.1473 0.423639C12.7726 0.480307 13.3093 0.598759 13.7928 0.877741C14.3717 1.21192 14.8521 1.69355 15.1864 2.27227C15.4655 2.75574 15.5857 3.29164 15.6425 3.9168C15.6983 4.53301 15.6971 5.3016 15.6971 6.26446V7.82989C15.6971 8.29264 15.6989 8.58993 15.6649 8.84844C15.4668 10.3525 14.401 11.5738 12.9833 11.9988V10.5467C13.6973 10.1903 14.2105 9.49662 14.3192 8.67169C14.3387 8.52347 14.3407 8.3358 14.3407 7.82989V6.26446C14.3407 5.27706 14.3398 4.58149 14.2909 4.04083C14.2428 3.50968 14.1526 3.19372 14.0126 2.95098C13.7974 2.57849 13.4876 2.26869 13.1151 2.05352C12.8724 1.91347 12.5564 1.82237 12.0253 1.77423C11.4847 1.72528 10.7888 1.7254 9.80164 1.7254H7.71472C6.7562 1.72558 5.92665 2.27697 5.52332 3.07891H4.07019C4.54221 1.51132 5.9932 0.368186 7.71472 0.367975H9.80164Z" />
  </svg>`

const SEARCH_ICON = `
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M11.748 6.7028C11.748 3.90104 9.47653 1.62976 6.6748 1.62956C3.87291 1.62956 1.60156 3.90091 1.60156 6.7028C1.60176 9.50453 3.87304 11.776 6.6748 11.776C9.47641 11.7759 11.7479 9.50441 11.748 6.7028ZM13.0479 6.7028C13.0477 10.2224 10.1944 13.0757 6.6748 13.0759C3.15507 13.0759 0.300977 10.2225 0.300781 6.7028C0.300781 3.18294 3.15494 0.328781 6.6748 0.328781C10.1945 0.328977 13.0479 3.18307 13.0479 6.7028Z" fill="currentColor"/>
    <path d="M15.6991 14.7513L14.7792 15.6712L11.3974 12.2894L12.3173 11.3694L15.6991 14.7513Z" fill="currentColor"/>
  </svg>`

/* 和快捷面板「深度思考」按钮使用同一个图标 */
const THINK_ICON = `
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <path
      fill="currentColor"
      d="M8 6.77c0.679 0 1.23 0.551 1.23 1.23s-0.551 1.23-1.23 1.23S6.77 8.679 6.77 8 7.321 6.77 8 6.77z"
    />
    <path
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      d="M10.731 10.731C7.526 13.936 3.706 15.31 2.198 13.802 0.69 12.294 2.065 8.474 5.27 5.269 8.475 2.064 12.294 0.69 13.802 2.198 15.31 3.706 13.936 7.526 10.731 10.731z"
    />
    <path
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      d="M10.731 5.269C13.936 8.474 15.31 12.294 13.802 13.802 12.294 15.31 8.475 13.936 5.27 10.731 2.065 7.526 0.69 3.706 2.198 2.198 3.706 0.69 7.526 2.064 10.731 5.269z"
    />
  </svg>`

const CHEVRON_ICON = `
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
    <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`

const OPEN_PAGE_ICON = `
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
    <path d="M4.5 2.2h4.2L12 5.5v8.3H4.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M8.6 2.4v3.3h3.3M6.3 8h3.4M6.3 10.5h3.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
  </svg>`

/** 默认发送图标（向上箭头）。HTML 里也有一份，状态切换时用这里覆盖 */
const SEND_ICON = `
  <svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true">
    <path
      fill="currentColor"
      d="M9.551 0.39c0.301-0.046 0.597-0.035 0.898 0 0.511 0.1 0.958 0.306 1.366 0.619 0.323 0.247 0.672 0.582 1.03 0.923l6.796 6.472-2.033 1.936-6.171-5.877v15.177h-2.875V4.463L2.391 10.341 0.359 8.405 7.154 1.932C7.513 1.591 7.862 1.256 8.185 1.009 8.529 0.745 8.971 0.477 9.551 0.39z"
    />
  </svg>`

/** 生成中的停止图标：白色圆角方块（设计稿 30px 圆内 10×10，圆角 2） */
const STOP_ICON = `
  <svg viewBox="0 0 30 30" width="30" height="30" aria-hidden="true">
    <rect x="10" y="10" width="10" height="10" rx="2" fill="currentColor" />
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

  // 胶囊里显示的是短标签，完整名称留在 title / aria-label
  if (deepThinkLabel) deepThinkLabel.textContent = t('quick.deepThinkShort')
  if (smartSearchLabel) smartSearchLabel.textContent = t('quick.smartSearchShort')
  if (historyLabel) historyLabel.textContent = t('quick.history')
  if (historyEmpty) historyEmpty.textContent = t('quick.noHistory')
  if (searchPanelTitle) searchPanelTitle.textContent = t('quick.searchResults')
  if (searchPanelClose) {
    searchPanelClose.title = t('quick.searchCollapse')
    searchPanelClose.setAttribute('aria-label', t('quick.searchCollapse'))
  }
  setMarkdownLabels({ copyCode: t('quick.copyCode') })

  const labelled: [Element | null, string][] = [
    [deepThinkButton, 'quick.deepThink'],
    [smartSearchButton, 'quick.smartSearch'],
    [historyButton, 'quick.history'],
    [sendButton, 'quick.send'],
    [scrollBottomButton, 'quick.scrollBottom'],
    [tbClose, 'quick.close'],
    [tbNewChat, 'quick.newChat'],
    [tbExpand, 'quick.expand'],
  ]
  for (const [element, key] of labelled) {
    if (!element) continue
    element.setAttribute('title', t(key))
    element.setAttribute('aria-label', t(key))
  }

  // 上面把发送按钮的 title 固定成了「发送」，生成中要改回「停止生成」
  syncSendState()
}

async function loadMessages(): Promise<void> {
  texts = (await window.ds?.getMessages()) ?? {}
  applyMessages()
}

const app = document.getElementById('app') as HTMLElement
const topbar = document.getElementById('topbar') as HTMLElement
const messages = document.getElementById('messages') as HTMLElement
const messagesInner = document.getElementById('messagesInner') as HTMLElement
const messagesTail = document.getElementById('messagesTail') as HTMLElement
const messagesFade = document.getElementById('messagesFade') as HTMLElement
const composer = document.querySelector('.composer') as HTMLElement

const input = document.getElementById('input') as HTMLTextAreaElement
const deepThinkButton = document.getElementById('deepThink')
const smartSearchButton = document.getElementById('smartSearch')
const deepThinkLabel = document.getElementById('deepThinkLabel')
const smartSearchLabel = document.getElementById('smartSearchLabel')
const sendButton = document.getElementById('send') as HTMLButtonElement
const scrollBottomButton = document.getElementById('scrollBottom') as HTMLButtonElement

const historyButton = document.getElementById('history') as HTMLButtonElement
const historyLabel = document.getElementById('historyLabel')
const historyPanel = document.getElementById('historyPanel') as HTMLElement
const historyList = document.getElementById('historyList') as HTMLElement
const historyEmpty = document.getElementById('historyEmpty') as HTMLElement
const historyLoader = document.getElementById('historyLoader') as HTMLElement

const tbClose = document.getElementById('tbClose')
const tbNewChat = document.getElementById('tbNewChat')
const tbExpand = document.getElementById('tbExpand')

const shell = document.getElementById('shell') as HTMLElement
const searchPanel = document.getElementById('searchPanel') as HTMLElement
const searchPanelTitle = document.getElementById('searchPanelTitle') as HTMLElement
const searchPanelClose = document.getElementById('searchPanelClose') as HTMLButtonElement
const searchPanelList = document.getElementById('searchPanelList') as HTMLElement

/** 右侧搜索结果栏是否展开 */
let searchPanelOpen = false
/** 当前搜索栏对应的消息组 */
let activeSearchGroup: HTMLElement | null = null
/** 消息组对应的搜索结果，用于回答结束后补上底部胶囊 */
const groupSearchInfo = new WeakMap<HTMLElement, SearchInfo>()
/** 深度思考块里每一次搜索按需拉到的完整结果 */
const groupSearchSegments = new WeakMap<HTMLElement, Map<number, SearchInfo>>()
/** 实时回答在网页里的序号，打开结果栏时按需拉完整列表 */
const groupAnswerIndex = new WeakMap<HTMLElement, number>()
/** 搜索结果栏按需请求令牌：关闭/切换回答时让旧请求失效 */
let searchDetailsToken = 0
/** 当前结果栏对应的是哪一次搜索；undefined 表示底部聚合 */
let activeSearchIndex: number | undefined
/** 搜索结果栏宽度（和主进程 quick-window.ts 保持一致） */
const SEARCH_PANEL_WIDTH = 260

/** 快捷窗口加宽/收窄时，左侧内容区宽度保持固定，避免底部气泡左右移动 */
function syncAppWidth(panelOpen = searchPanelOpen): void {
  const width = panelOpen ? window.innerWidth - SEARCH_PANEL_WIDTH : window.innerWidth
  app.style.width = `${Math.max(0, Math.round(width))}px`
}

let mode: QuickMode = 'empty'
/** 历史弹框是否展开 */
let historyOpen = false
/** 通过快捷键打开历史弹框时，等列表回来后默认选中第一条 */
let historyKeyboardSelect = false
/** 当前键盘选中的历史条目下标，-1 表示没有选中 */
let historySelectedIndex = -1
/** 历史列表还能不能继续加载 */
let historyHasMore = false
/** 已经请求过「加载更多」，等主进程回话 */
let historyLoadPending = false
/** 收起动画结束后再隐藏弹框的定时器 */
let historyHideTimer: number | undefined
/** 正在等主进程把选中的历史对话读回来（这期间不让发送） */
let historyLoading = false
/** 历史对话加载后的落点，等布局稳定（字体/图片/窗口动画）再对齐一次 */
let historyLandingGroup: HTMLElement | null = null
/** 窗口展开动画期间还有历史落点要在动画结束后校正 */
let historyLandingPending = false
/** 接口返回的完整历史（只渲染首屏需要的部分，其余留在内存里） */
let historyAllMessages: HistoryMessage[] | null = null
/** 历史首屏渲染的世代号，切换会话后让旧的延迟渲染失效 */
let historyRenderEpoch = 0
/** 首屏两页缓冲正在后台渲染，避免和用户滚动触发的懒加载并发 */
let historyPrefillRunning = false
/** historyAllMessages 里当前已经渲染到第几条 */
let historyRenderedStart = 0
/** 历史对话是否还有更早的消息可以加载 */
let historyHasOlder = false
/** 正在加载更早的历史消息 */
let historyOlderLoading = false
/** 用户已经主动滚动过，才允许触发按需加载 */
let historyLazyArmed = false
/** 已经渲染过的历史条目，用来去重 */
const historySeen = new Set<string>()
/** 拖动窗口：按下时的鼠标屏幕坐标 */
let dragOrigin: { x: number; y: number } | null = null
/** 正在等回答：这期间发送按钮变成「停止生成」 */
let busy = false
/** 已经点了停止、还没收到主进程的 answer-stopped，避免连点 */
let stopping = false
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

  if (historyOpen) placeHistoryPanel()
  placeMessagesFade()
}

/** 当前发送按钮是不是「停止」形态，避免每次输入都重写 innerHTML */
let sendIconIsStop = false

function syncSendState(): void {
  if (busy !== sendIconIsStop) {
    sendIconIsStop = busy
    sendButton.innerHTML = busy ? STOP_ICON : SEND_ICON
  }

  const key = busy ? 'quick.stop' : 'quick.send'
  sendButton.setAttribute('title', t(key))
  sendButton.setAttribute('aria-label', t(key))

  // 生成中：发送按钮就是停止按钮，始终可点
  // 空闲时：没有内容、或正在加载历史对话就禁用
  sendButton.disabled = historyLoading || (!busy && input.value.trim().length === 0)
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

// ── 历史对话弹框 ─────────────────────────────────────────────

/** 把弹框贴到输入框正上方（输入框高度变化时也要重新算） */
/** 底部渐隐蒙层：底边贴住输入框顶部，输入框长高时跟着上移 */
function placeMessagesFade(): void {
  const appRect = app.getBoundingClientRect()
  const composerRect = composer.getBoundingClientRect()
  const appBottom = appRect.top + app.clientTop + app.clientHeight
  messagesFade.style.bottom = `${Math.round(appBottom - composerRect.top)}px`
}

function placeHistoryPanel(): void {
  const appRect = app.getBoundingClientRect()
  const buttonRect = historyButton.getBoundingClientRect()
  const width = 206
  const center = buttonRect.left + buttonRect.width / 2

  // 设计稿：气泡贴在「历史」按钮正上方，尾巴指向按钮
  const left = Math.min(
    Math.max(center - appRect.left - width / 2, 4),
    appRect.width - width - 4,
  )
  historyPanel.style.left = `${Math.round(left)}px`
  // 尾巴尖离气泡底边约 12px，正好落在胶囊上沿
  historyPanel.style.bottom = `${Math.round(appRect.bottom - buttonRect.top + 12)}px`

  const tail = Math.min(Math.max(center - appRect.left - left - 7, 10), width - 22)
  historyPanel.style.setProperty('--tail-x', `${Math.round(tail)}px`)

  // 有内容态可能被用户缩得很矮：气泡不能顶出窗口
  const available = buttonRect.top - appRect.top - 20
  historyPanel.style.maxHeight = `${Math.round(Math.max(120, Math.min(166, available)))}px`
}

/**
 * 只改界面，不通知主进程。
 * 主进程推来的 history-panel 也走这里，避免两边来回调用。
 */
function applyHistoryPanel(open: boolean): void {
  if (open === historyOpen) {
    if (open) placeHistoryPanel()
    return
  }

  historyOpen = open
  historyButton.setAttribute('aria-pressed', String(open))

  if (open) {
    /*
     * 空态窗口会临时撑高到 230，composer 必须固定 100 高贴在底部。
     * 关闭时不能立刻去掉这个类：窗口还有 260ms 的收起缓冲期，
     * 提前去掉 composer 会先撑满整个窗口，看起来就是「变大再变小」。
     * 类由下面的 window resize 处理：窗口真正缩回 100 后再移除。
     */
    if (mode === 'empty') app.classList.add('history-open')
    if (historyHideTimer !== undefined) {
      window.clearTimeout(historyHideTimer)
      historyHideTimer = undefined
    }

    /*
     * 连续开合时保留上一次的列表，不先清空再等接口。
     * 只有第一次打开（列表为空）才用 loading 占住高度。
     */
    historyLoadPending = false
    historyHasMore = false
    historySeen.clear()
    historyPanel.classList.remove('empty')
    historyPanel.classList.toggle('loading', historyList.children.length === 0)

    historyPanel.hidden = false
    placeHistoryPanel()
    // 列表可能还是上一次的；快捷键打开时先把第一条选中
    if (historyList.children.length > 0) applyPendingHistorySelection()
    requestAnimationFrame(() => {
      // 这一帧之前用户又关掉了，就不要再打开，否则会闪一下
      if (!historyOpen) return
      placeHistoryPanel()
      historyPanel.classList.add('open')
    })
    return
  }

  historyPanel.classList.remove('open')
  historyKeyboardSelect = false
  clearHistorySelection()
  historyLoadPending = false
  historyHasMore = false
  // 保留列表 DOM，下次打开可以立即显示；淡出动画结束后再真正藏起来
  if (historyHideTimer !== undefined) window.clearTimeout(historyHideTimer)
  historyHideTimer = window.setTimeout(() => {
    historyHideTimer = undefined
    if (!historyOpen) historyPanel.hidden = true
  }, 160)
}

function historyItemElements(): HTMLButtonElement[] {
  return Array.from(historyList.querySelectorAll('.history-item')) as HTMLButtonElement[]
}

function clearHistorySelection(): void {
  historySelectedIndex = -1
  for (const item of historyItemElements()) item.classList.remove('selected')
}

function setHistorySelection(index: number, scroll = true): void {
  const items = historyItemElements()
  if (!items.length) {
    historySelectedIndex = -1
    return
  }

  const next = Math.max(0, Math.min(items.length - 1, index))
  items.forEach((item, itemIndex) => item.classList.toggle('selected', itemIndex === next))
  historySelectedIndex = next
  if (scroll) items[next]?.scrollIntoView({ block: 'nearest' })
}

/** 列表刷新后恢复键盘选中状态；快捷键打开时默认第一条 */
function applyPendingHistorySelection(): void {
  if (historyKeyboardSelect && historyList.children.length > 0) {
    historyKeyboardSelect = false
    setHistorySelection(0)
    return
  }

  if (historySelectedIndex >= 0) setHistorySelection(historySelectedIndex, false)
}

function renderHistoryItems(items: HistoryEntry[], append: boolean): void {
  if (!append) {
    /*
     * 连续开合时接口很快会返回同一份列表。
     * 内容和顺序都没变就不要再重建 DOM —— 重建会让列表闪一下。
     */
    const current = Array.from(historyList.children) as HTMLElement[]
    const same =
      current.length === items.length &&
      items.every((item, index) => {
        const button = current[index]
        return button?.dataset.id === item.id && button.textContent === item.title
      })

    if (same) {
      historySeen.clear()
      for (const item of items) historySeen.add(item.id)
      historyPanel.classList.remove('loading')
      historyPanel.classList.toggle('empty', items.length === 0)
      placeHistoryPanel()
      applyPendingHistorySelection()
      return
    }

    historyList.replaceChildren()
    historyList.scrollTop = 0
    historySeen.clear()
  }

  for (const item of items) {
    if (historySeen.has(item.id)) continue
    historySeen.add(item.id)

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'history-item'
    button.dataset.id = item.id
    button.textContent = item.title
    // 条目本身已经被 CSS 截断，悬停时给出完整标题
    button.title = item.title
    button.addEventListener('click', () => {
      applyHistoryPanel(false)
      window.ds?.selectQuickHistory(item.id)
    })
    historyList.appendChild(button)
  }

  historyPanel.classList.remove('loading')
  historyPanel.classList.toggle('empty', historyList.children.length === 0)
  placeHistoryPanel()
  if (!append) applyPendingHistorySelection()
}

/** 点「历史」胶囊：先给反馈，再让主进程去页面里读 */
function requestHistoryToggle(): void {
  if (historyOpen) {
    applyHistoryPanel(false)
    window.ds?.toggleQuickHistory(false)
    return
  }
  if (busy || stopping || historyLoading) return

  applyHistoryPanel(true)
  window.ds?.toggleQuickHistory(true)
}

// ── 消息渲染 ──────────────────────────────────────────────────

/** 距离底部 4px 以内算「已经在底部」 */
const BOTTOM_EPSILON = 4

/**
 * 消息内容的底边（不含 messagesTail 补位）在滚动坐标系里的位置。
 * 用 rect 而不是 scrollHeight —— 内容比视口短时 scrollHeight 会被夹到视口高度。
 */
function contentBottom(): number {
  const containerTop = messages.getBoundingClientRect().top
  return messagesInner.getBoundingClientRect().bottom - containerTop + messages.scrollTop
}

function isAtBottom(): boolean {
  return contentBottom() - (messages.scrollTop + messages.clientHeight) <= BOTTOM_EPSILON
}

/**
 * 程序触发的平滑滚动期间先别让「滚动到底部」按钮冒出来：
 * 用户点按钮时它应该立刻消失，而不是跟着滚到底部才消失；
 * 新消息往上滚的动画过程中也不应该闪一下。
 */
let suppressScrollButton = false
let suppressScrollTimer: number | undefined

function suppressScrollButtonDuringAnimation(): void {
  suppressScrollButton = true
  scrollBottomButton.classList.remove('show')
  if (suppressScrollTimer) window.clearTimeout(suppressScrollTimer)
  // scrollend 没触发时兜底（smooth 滚动一般 300–500ms）
  suppressScrollTimer = window.setTimeout(() => {
    suppressScrollButton = false
    suppressScrollTimer = undefined
    updateScrollButton()
  }, 1200)
}

/** 设计稿（优化内容展示）：不在底部时浮出「滚动到底部」按钮。
 * 生成文字时**不自动跟随**，所以新内容长出来之后这个按钮会重新出现。
 */
function updateScrollButton(): void {
  if (suppressScrollButton) {
    scrollBottomButton.classList.remove('show')
    return
  }
  const scrollable = contentBottom() - messages.clientHeight > 8
  scrollBottomButton.classList.toggle('show', mode === 'content' && scrollable && !isAtBottom())
}

/**
 * 把刚发出的用户消息顶到「顶栏下方 10px」。
 *
 * 内容底部不够长时，光滚动是到不了那个位置的（滚动会夹在底部），
 * 所以先用 messagesTail 在下面补足一段空白，回答结束再收回。
 *
 * animate：第二条及以后的消息，先让气泡出现在可视区底部，再平滑滚上去，
 * 避免内容一下子「跳」到顶部。
 */
function alignMessageToTop(group: HTMLElement, animate: boolean): void {
  messagesTail.style.height = '0px'

  const messageTop =
    group.getBoundingClientRect().top - messages.getBoundingClientRect().top + messages.scrollTop
  const below = messagesInner.getBoundingClientRect().bottom - group.getBoundingClientRect().bottom
  // 视图里消息下方还要放得下「消息自身 + 后面的内容」
  const needed = messages.clientHeight - MESSAGE_TOP_ANCHOR - group.offsetHeight - below
  if (needed > 0) messagesTail.style.height = `${needed + TAIL_SLACK}px`

  const target = Math.max(0, messageTop - MESSAGE_TOP_ANCHOR)

  if (!animate) {
    // 空态发出的第一条：窗口还在展开，直接落位即可
    messages.scrollTop = target
    return
  }

  // 新消息先出现在内容底部（视口最下方），下一帧再平滑滚到顶部
  suppressScrollButtonDuringAnimation()
  messages.scrollTop = Math.max(0, contentBottom() - messages.clientHeight)
  requestAnimationFrame(() => {
    messages.scrollTo({ top: target, behavior: 'smooth' })
  })
}

/**
 * 思考结束、正文开始：把正文第一行顶到「顶栏下方 10px」。
 * 上方已经看完的思考块随之滚出视野，用户直接看正文逐步出现。
 */
function alignAnswerBodyToTop(body: HTMLElement): void {
  messagesTail.style.height = '0px'

  const bodyRect = body.getBoundingClientRect()
  const bodyTop = bodyRect.top - messages.getBoundingClientRect().top + messages.scrollTop
  const below = messagesInner.getBoundingClientRect().bottom - bodyRect.bottom
  const needed = messages.clientHeight - MESSAGE_TOP_ANCHOR - body.offsetHeight - below
  if (needed > 0) messagesTail.style.height = `${needed + TAIL_SLACK}px`

  const target = Math.max(0, bodyTop - MESSAGE_TOP_ANCHOR)
  suppressScrollButtonDuringAnimation()
  messages.scrollTo({ top: target, behavior: 'smooth' })
}


/**
 * 回答结束：尽量收回补位空间。
 *
 * 只收到「不会让当前视图被夹走」的程度 —— 如果回答很短、内容底部撑不满视口，
 * 全部收回会让浏览器把 scrollTop 夹到新的最大值，用户刚顶到上面的消息会往下跳。
 * 留刚好够的那一点点空白，视图就保持不动。
 */
function releaseTail(): void {
  const keep = messages.scrollTop + messages.clientHeight - contentBottom()
  messagesTail.style.height = `${Math.max(0, keep)}px`
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

function searchSiteLogo(source: SearchSource): HTMLElement {
  const logo = document.createElement('span')
  logo.className = 'site-logo'
  logo.textContent = (source.siteName || '?').slice(0, 1)

  if (/^https:\/\/cdn\.deepseek\.com\//i.test(source.siteIcon)) {
    const image = document.createElement('img')
    image.src = source.siteIcon
    image.alt = ''
    image.loading = 'lazy'
    image.referrerPolicy = 'no-referrer'
    image.addEventListener('error', () => image.remove())
    logo.appendChild(image)
  }
  return logo
}

function searchSiteLogos(sources: SearchSource[]): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'site-logos'
  for (const source of sources.slice(0, 4)) wrap.appendChild(searchSiteLogo(source))
  return wrap
}

function formatSearchDate(seconds: number): string {
  if (!seconds) return ''
  const date = new Date(seconds * 1000)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

function cleanSearchSnippet(text: string): string {
  return text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
}

function removeSearchUi(group: HTMLElement): void {
  for (const element of Array.from(group.querySelectorAll('.search-top, .search-pill'))) {
    element.remove()
  }
}

/** 给一条 AI 回答挂上顶部搜索入口和底部搜索胶囊 */
/** 摘要只有数量和图标，先合成一份临时 SearchInfo，详情回来后原地更新 */
function searchInfoFromSummary(summary: SearchSummary): SearchInfo {
  return {
    count: summary.count,
    sources: summary.icons.map((icon, index) => {
      const match = icon.match(/\/site-icons\/([^/?#]+)/i)
      const siteName = match ? match[1].split('.')[0] : ''
      return {
        url: '',
        title: '',
        snippet: '',
        citeIndex: index + 1,
        publishedAt: 0,
        siteIcon: icon,
        siteName,
      }
    }),
  }
}

function thinkingSearchInfo(search: ThinkingSearch): SearchInfo {
  return search.info ?? searchInfoFromSummary({ count: search.count, icons: search.icons })
}

/**
 * 底部聚合搜索的兜底：
 * 实时阶段网页底部的「N 个网页」有时晚于正文出现，先按思考块里的
 * 搜索片段拼一个摘要，保证胶囊不会完全不显示；拿到网页真实数量后再更新。
 */
function aggregateFromThinking(thinking: ThinkingInfo): ThinkingSearch | null {
  const searches = thinking.segments.filter(
    (segment): segment is ThinkingSearchSegment => segment.kind === 'search',
  )
  if (!searches.length) return null

  const allSources: SearchSource[] = []
  for (const search of searches) {
    if (search.info) allSources.push(...search.info.sources)
  }
  if (allSources.length) {
    const seen = new Set<string>()
    const sources: SearchSource[] = []
    for (const source of allSources) {
      if (!source.url || seen.has(source.url)) continue
      seen.add(source.url)
      sources.push(source)
    }
    if (sources.length) {
      return {
        count: sources.length,
        icons: sources.slice(0, 4).map((source) => source.siteIcon).filter(Boolean),
        info: { count: sources.length, sources },
      }
    }
  }

  const count = searches.reduce((sum, search) => sum + search.count, 0)
  const icons: string[] = []
  for (const search of searches) {
    for (const icon of search.icons) {
      if (icons.length >= 4) break
      icons.push(icon)
    }
    if (icons.length >= 4) break
  }
  return { count, icons }
}

function getThinkingSegmentInfo(group: HTMLElement, searchIndex: number): SearchInfo | null {
  return groupSearchSegments.get(group)?.get(searchIndex) ?? null
}

function setThinkingSegmentInfo(group: HTMLElement, searchIndex: number, info: SearchInfo): void {
  let map = groupSearchSegments.get(group)
  if (!map) {
    map = new Map()
    groupSearchSegments.set(group, map)
  }
  map.set(searchIndex, info)
}

function thinkingTitle(thinking: ThinkingInfo): string {
  if (thinking.status === 'thinking') return t('quick.thinkThinking')
  if (thinking.status === 'stopped') return t('quick.thinkStopped')
  const elapsed = thinking.elapsedSecs
  if (typeof elapsed === 'number' && elapsed > 0) {
    const seconds = Math.max(1, Math.round(elapsed))
    return t(seconds > 1 ? 'quick.thinkDone' : 'quick.thinkDoneOne', { n: seconds })
  }
  return t('quick.thinkDoneShort')
}

/** 深度思考块的状态信息，回答结束/停止时用来更新标题 */
const groupThinkingInfo = new WeakMap<HTMLElement, ThinkingInfo>()

function createThinkBlock(group: HTMLElement, collapsed: boolean): HTMLElement {
  const block = document.createElement('div')
  block.className = 'think-block'
  block.innerHTML = `
    <button class="think-head" type="button">
      <span class="think-icon">${THINK_ICON}</span>
      <span class="think-title"></span>
      <span class="think-chevron">${CHEVRON_ICON}</span>
    </button>
    <div class="think-body"></div>
  `

  const anchor = group.querySelector('.search-top') || group.querySelector('.msg-ai')
  if (anchor) group.insertBefore(block, anchor)
  else group.appendChild(block)

  if (!collapsed) block.classList.add('is-open')

  const head = block.querySelector('.think-head') as HTMLButtonElement
  head.setAttribute('aria-expanded', String(block.classList.contains('is-open')))
  head.addEventListener('click', () => {
    if (block.dataset.animating === '1') return
    if (block.classList.contains('is-open')) collapseThinkBlock(block, head)
    else {
      block.classList.add('is-open')
      head.setAttribute('aria-expanded', 'true')
    }
  })

  return block
}

/**
 * 收起思考块：一边把正文高度压到 0，一边把滚动位置调回
 * 「思考标题贴住顶部功能栏」的位置。
 *
 * 只看收起后的布局，标题会停在原位、正文贴到标题下面；
 * 高度和滚动同步动画，避免内容瞬间跳一下再滚很远。
 */
function collapseThinkBlock(block: HTMLElement, head: HTMLElement): void {
  const body = block.querySelector('.think-body') as HTMLElement | null
  const close = (): void => {
    block.classList.remove('is-open')
    head.setAttribute('aria-expanded', 'false')
  }
  if (!body) {
    close()
    return
  }

  const messagesRect = messages.getBoundingClientRect()
  const blockRect = block.getBoundingClientRect()
  const headerTop = head.getBoundingClientRect().top - messagesRect.top
  const startScroll = messages.scrollTop
  const blockDocTop = blockRect.top - messagesRect.top + startScroll
  // 保持标题当前的屏幕位置不变，只把思考块顶端滚到标题所在的位置
  const targetScroll = Math.max(0, blockDocTop - headerTop)

  const height = body.offsetHeight
  const duration = 220
  block.dataset.animating = '1'
  close()
  block.classList.add('is-collapsing')
  body.style.height = `${height}px`
  body.style.opacity = '1'
  body.style.overflow = 'hidden'
  // 先让浏览器记住初始高度，再开始过渡
  void body.offsetHeight
  body.style.transition = `height ${duration}ms ease, opacity ${duration}ms ease`
  body.style.height = '0px'
  body.style.opacity = '0'
  suppressScrollButtonDuringAnimation()

  const started = performance.now()
  const ease = (t: number): number => 1 - (1 - t) ** 3

  const step = (now: number): void => {
    const t = Math.min(1, (now - started) / duration)
    const eased = ease(t)
    messages.scrollTop = startScroll + (targetScroll - startScroll) * eased
    if (t < 1) {
      requestAnimationFrame(step)
      return
    }

    body.style.transition = ''
    body.style.height = ''
    body.style.opacity = ''
    body.style.overflow = ''
    block.classList.remove('is-collapsing')
    delete block.dataset.animating
  }

  requestAnimationFrame(step)
}

function renderThinkingSegments(
  group: HTMLElement,
  container: HTMLElement,
  segments: ThinkingSegment[],
): void {
  const fragment = document.createDocumentFragment()

  for (const segment of segments) {
    if (segment.kind === 'think') {
      const text = segment as ThinkingTextSegment
      const row = document.createElement('div')
      row.className = 'think-text'
      const icon = document.createElement('span')
      icon.className = 'think-text-icon'
      row.appendChild(icon)
      const body = document.createElement('div')
      body.className = 'think-text-body'
      if (text.html) renderAiContent(body, text.text, text.html)
      else renderApiMarkdown(body, text.text)
      row.appendChild(body)
      fragment.appendChild(row)
      continue
    }

    if (segment.kind === 'search') {
      const search = segment as ThinkingSearchSegment
      if (search.info) setThinkingSegmentInfo(group, search.searchIndex, search.info)

      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'think-search'
      const icon = document.createElement('span')
      icon.className = 'search-icon'
      icon.innerHTML = SEARCH_ICON
      const label = document.createElement('span')
      label.className = 'think-search-label'
      label.textContent = t('quick.searchCount', { n: search.count })
      row.append(icon, label, searchSiteLogos(thinkingSearchInfo(search).sources))
      row.addEventListener('click', () => {
        const info = getThinkingSegmentInfo(group, search.searchIndex) ?? thinkingSearchInfo(search)
        toggleSearchPanel(group, info, search.searchIndex)
      })
      fragment.appendChild(row)
      continue
    }

    const open = segment as ThinkingOpenSegment
    const row = document.createElement('div')
    row.className = 'think-open'
    const icon = document.createElement('span')
    icon.className = 'think-open-icon'
    icon.innerHTML = OPEN_PAGE_ICON
    const content = document.createElement('div')
    content.className = 'think-open-content'
    const label = document.createElement('div')
    label.className = 'think-open-label'
    label.textContent = t(
      open.pages.length === 1 ? 'quick.thinkOpenPageOne' : 'quick.thinkOpenPages',
      { n: open.pages.length },
    )
    const pages = document.createElement('div')
    pages.className = 'think-open-pages'
    for (const page of open.pages) {
      if (page.url) {
        const link = document.createElement('a')
        link.className = 'think-open-page is-link'
        link.href = page.url
        link.textContent = page.title
        link.addEventListener('click', (event) => {
          event.preventDefault()
          window.ds?.openExternal(page.url)
        })
        pages.appendChild(link)
      } else {
        const span = document.createElement('span')
        span.className = 'think-open-page'
        span.textContent = page.title
        pages.appendChild(span)
      }
    }
    content.append(label, pages)
    row.append(icon, content)
    fragment.appendChild(row)
  }

  container.replaceChildren(fragment)
}

function attachThinking(
  group: HTMLElement,
  thinking: ThinkingInfo,
  options: { collapsed?: boolean } = {},
): void {
  groupThinkingInfo.set(group, thinking)
  let block = group.querySelector('.think-block') as HTMLElement | null
  if (!block) block = createThinkBlock(group, options.collapsed === true)

  block.dataset.status = thinking.status
  block.classList.toggle('is-thinking', thinking.status === 'thinking')

  const title = block.querySelector('.think-title')
  if (title) title.textContent = thinkingTitle(thinking)

  const body = block.querySelector('.think-body') as HTMLElement | null
  if (body) renderThinkingSegments(group, body, thinking.segments)
}

function markThinkingStopped(group: HTMLElement): void {
  const block = group.querySelector('.think-block') as HTMLElement | null
  if (!block) return
  if (block.dataset.status !== 'thinking') return
  const previous = groupThinkingInfo.get(group)
  const thinking: ThinkingInfo = {
    status: 'stopped',
    segments: previous?.segments ?? [],
    aggregateSearch: previous?.aggregateSearch,
    elapsedSecs: previous?.elapsedSecs,
  }
  groupThinkingInfo.set(group, thinking)
  block.dataset.status = 'stopped'
  block.classList.remove('is-thinking')
  const title = block.querySelector('.think-title')
  if (title) title.textContent = thinkingTitle(thinking)
}

function markThinkingDone(group: HTMLElement): void {
  const block = group.querySelector('.think-block') as HTMLElement | null
  if (!block) return
  if (block.dataset.status !== 'thinking') return
  const previous = groupThinkingInfo.get(group)
  if (!previous) return
  const thinking: ThinkingInfo = { ...previous, status: 'done' }
  groupThinkingInfo.set(group, thinking)
  block.dataset.status = 'done'
  block.classList.remove('is-thinking')
  const title = block.querySelector('.think-title')
  if (title) title.textContent = thinkingTitle(thinking)
}

/** 当前正在输出/刚结束的那条 AI 消息 */
function currentAnswerGroup(): HTMLElement | null {
  const streaming = streamingBody?.closest('.msg-group') as HTMLElement | null
  if (streaming) return streaming

  const groups = Array.from(messagesInner.querySelectorAll('.msg-group-ai')) as HTMLElement[]
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    if (groups[i].querySelector('.search-top, .search-pill')) return groups[i]
  }
  return groups[groups.length - 1] ?? null
}

function addSearchBottom(group: HTMLElement, info: SearchInfo): void {
  const actions = group.querySelector('.msg-actions:not(.right)') as HTMLElement | null
  if (!actions) return

  const sources = info.sources.slice().sort((a, b) => a.citeIndex - b.citeIndex)
  const existing = group.querySelector('.search-pill') as HTMLButtonElement | null
  const pill = existing ?? document.createElement('button')
  if (!existing) {
    pill.type = 'button'
    pill.className = 'search-pill'
    pill.addEventListener('click', () => {
      const current = groupSearchInfo.get(group)
      if (current) toggleSearchPanel(group, current)
    })
  }

  const count = document.createElement('span')
  count.textContent = t('quick.webCount', { n: info.count || sources.length })
  // 数量/图标可能在网页底部胶囊出现后更新，原地刷新即可
  pill.replaceChildren(searchSiteLogos(sources), count)
  if (!existing) actions.appendChild(pill)
}

/** 给一条 AI 回答挂上顶部搜索入口；showBottom=false 时底部胶囊等回答结束再补 */
function attachSearchUi(group: HTMLElement, info: SearchInfo, showBottom = true): void {
  removeSearchUi(group)

  const sources = info.sources.slice().sort((a, b) => a.citeIndex - b.citeIndex)
  if (!sources.length) return
  const normalized: SearchInfo = { count: info.count || sources.length, sources }
  groupSearchInfo.set(group, normalized)

  const top = document.createElement('button')
  top.type = 'button'
  top.className = 'search-top'
  const icon = document.createElement('span')
  icon.className = 'search-icon'
  icon.innerHTML = SEARCH_ICON
  const label = document.createElement('span')
  label.textContent = t('quick.searchCount', { n: normalized.count })
  top.append(icon, label, searchSiteLogos(sources))
  top.addEventListener('click', () => {
    const current = groupSearchInfo.get(group)
    if (current) toggleSearchPanel(group, current)
  })

  const ai = group.querySelector('.msg-ai')
  if (ai) group.insertBefore(top, ai)
  else group.prepend(top)

  if (showBottom) addSearchBottom(group, normalized)
  updateScrollButton()
}

/** 回答结束/停止后，把底部「N 个网页」胶囊补到操作行 */
function completeSearchBottom(group: HTMLElement): void {
  const info = groupSearchInfo.get(group)
  if (!info) return
  addSearchBottom(group, info)
  updateScrollButton()
}

function searchHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** 结果栏占位：加载中 / 加载失败，整体在内容区域垂直居中 */
function showSearchPlaceholder(wrap: HTMLElement): void {
  searchPanelList.classList.add('is-placeholder')
  searchPanelList.replaceChildren(wrap)
  searchPanelList.scrollTop = 0
}

function renderSearchLoading(): void {
  const wrap = document.createElement('div')
  wrap.className = 'search-placeholder'
  const text = document.createElement('div')
  text.className = 'search-placeholder-text'
  text.textContent = t('quick.searchLoading')
  wrap.appendChild(text)
  showSearchPlaceholder(wrap)
}

function renderSearchError(
  group: HTMLElement,
  answerIndex: number,
  searchIndex?: number,
): void {
  const wrap = document.createElement('div')
  wrap.className = 'search-placeholder'

  const failed = document.createElement('div')
  failed.className = 'search-placeholder-text'
  failed.textContent = t('quick.searchLoadFailed')

  const retry = document.createElement('button')
  retry.type = 'button'
  retry.className = 'search-retry'
  retry.textContent = t('quick.searchRetry')
  retry.addEventListener('click', () => {
    if (!searchPanelOpen || activeSearchGroup !== group) return
    void loadSearchDetails(group, answerIndex, searchIndex)
  })

  wrap.append(failed, retry)
  showSearchPlaceholder(wrap)
}

/**
 * 用户打开结果栏后才按需拉完整网页列表。
 * 第一次立即请求，失败后每 500ms 再试，最多 6 次。
 * 关闭结果栏或切换回答时令牌变化，旧循环直接退出。
 *
 * searchIndex 指定第几次搜索；不传表示底部聚合。
 */
async function loadSearchDetails(
  group: HTMLElement,
  answerIndex: number,
  searchIndex?: number,
): Promise<void> {
  const token = ++searchDetailsToken
  renderSearchLoading()

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (token !== searchDetailsToken || !searchPanelOpen || activeSearchGroup !== group) {
      return
    }

    const info = await window.ds?.requestSearchDetails(answerIndex, searchIndex)

    if (token !== searchDetailsToken || !searchPanelOpen || activeSearchGroup !== group) {
      return
    }

    if (info && info.sources.some((source) => source.url)) {
      if (searchIndex === undefined) groupSearchInfo.set(group, info)
      else setThinkingSegmentInfo(group, searchIndex, info)
      renderSearchPanel(info)
      searchPanelList.scrollTop = 0
      return
    }

    if (attempt < 5) await wait(500)
  }

  if (token !== searchDetailsToken || !searchPanelOpen || activeSearchGroup !== group) {
    return
  }
  renderSearchError(group, answerIndex, searchIndex)
}

function renderSearchPanel(info: SearchInfo): void {
  const sources = info.sources.slice().sort((a, b) => a.citeIndex - b.citeIndex)

  // 正常路径下打开结果栏时已经确认有完整数据；这里兜底防御
  if (!sources.some((source) => source.url)) {
    renderSearchLoading()
    return
  }

  searchPanelList.classList.remove('is-placeholder')
  const fragment = document.createDocumentFragment()

  sources.forEach((source, index) => {
    const link = document.createElement('a')
    link.className = 'search-result'
    link.href = source.url
    link.rel = 'noreferrer noopener'
    link.target = '_blank'

    const meta = document.createElement('div')
    meta.className = 'search-result-meta'
    const site = document.createElement('span')
    site.className = 'search-result-site'
    site.textContent = source.siteName || searchHost(source.url)
    const date = document.createElement('span')
    date.className = 'search-result-date'
    date.textContent = formatSearchDate(source.publishedAt)
    const cite = document.createElement('span')
    cite.className = 'search-result-cite'
    // 结果栏使用网页端的顺序编号（1、2、3…），不显示接口的 cite_index
    cite.textContent = String(index + 1)
    meta.append(searchSiteLogo(source), site, date, cite)

    const title = document.createElement('div')
    title.className = 'search-result-title'
    title.textContent = source.title

    const snippet = document.createElement('div')
    snippet.className = 'search-result-snippet'
    snippet.textContent = cleanSearchSnippet(source.snippet)

    link.append(meta, title, snippet)
    fragment.appendChild(link)
  })

  searchPanelList.replaceChildren(fragment)
}

function openSearchPanel(
  group: HTMLElement,
  info: SearchInfo,
  searchIndex?: number,
): void {
  activeSearchGroup = group
  activeSearchIndex = searchIndex
  // 取消上一条回答可能还在进行的按需请求
  searchDetailsToken += 1

  const hasDetails = info.sources.some((source) => source.url)
  if (hasDetails) renderSearchPanel(info)
  else renderSearchLoading()

  if (!searchPanelOpen) {
    // 先固定左侧内容宽度，再显示结果栏；主进程随后加宽窗口时内容不会被拉伸
    app.style.width = `${window.innerWidth}px`
    searchPanelOpen = true
    searchPanel.hidden = false
    shell.classList.add('search-open')
  } else {
    searchPanel.hidden = false
    shell.classList.add('search-open')
  }

  // 每次打开、或切换到另一条回答的搜索结果，都从顶部开始看
  searchPanelList.scrollTop = 0
  window.ds?.setSearchPanel(true)

  if (!hasDetails) {
    const answerIndex = groupAnswerIndex.get(group)
    if (answerIndex !== undefined) {
      void loadSearchDetails(group, answerIndex, searchIndex)
    }
  }
}

function closeSearchPanel(): void {
  if (!searchPanelOpen && searchPanel.hidden) return
  // 关闭后不再继续重试拉取
  searchDetailsToken += 1
  if (searchPanelOpen) {
    // 先把左侧内容宽度收回到 420，再移除结果栏并让主进程缩窗口
    app.style.width = `${Math.max(0, window.innerWidth - SEARCH_PANEL_WIDTH)}px`
  }
  searchPanelOpen = false
  activeSearchGroup = null
  activeSearchIndex = undefined
  shell.classList.remove('search-open')
  searchPanel.hidden = true
  searchPanelList.classList.remove('is-placeholder')
  searchPanelList.replaceChildren()
  window.ds?.setSearchPanel(false)
}

function toggleSearchPanel(
  group: HTMLElement,
  info: SearchInfo,
  searchIndex?: number,
): void {
  if (
    searchPanelOpen &&
    activeSearchGroup === group &&
    activeSearchIndex === searchIndex
  ) {
    closeSearchPanel()
    return
  }
  openSearchPanel(group, info, searchIndex)
}

searchPanelClose.addEventListener('click', closeSearchPanel)

// 搜索结果用系统浏览器打开，不让面板自己导航
searchPanelList.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null
  const link = target?.closest('a')
  if (!link) return
  event.preventDefault()
  const href = link.getAttribute('href') || ''
  if (/^https?:\/\//i.test(href)) window.ds?.openExternal(href)
})

function buildMessageGroup(
  kind: 'user' | 'ai',
  text: string,
  html?: string,
  markdown?: string,
  messageKey?: string,
  search?: SearchInfo,
  thinking?: ThinkingInfo,
): { group: HTMLElement; body: HTMLElement } {
  const group = document.createElement('div')
  // 用户提问 / AI 回答各自是一个独立的组，上下边距不同
  group.className = `msg-group msg-group-${kind}`

  const template = document.getElementById(kind === 'user' ? 'tplUser' : 'tplAi')
  if (template instanceof HTMLTemplateElement) group.appendChild(template.content.cloneNode(true))

  const body = group.querySelector(kind === 'user' ? '.bubble' : '.body') as HTMLElement
  if (kind === 'ai') {
    if (markdown) {
      renderApiMarkdown(body, markdown, messageKey)
    } else {
      renderAiContent(body, text, html)
    }
  } else {
    body.textContent = text
  }

  const actions = group.querySelector('.msg-actions') as HTMLElement
  actions.appendChild(makeCopyButton(() => body.textContent ?? ''))

  if (kind === 'ai' && thinking) {
    // 历史对话里的思考块默认收起；搜索行在思考块内部，不再单独挂顶部气泡
    attachThinking(group, thinking, { collapsed: true })
    const aggregate = thinking.aggregateSearch ?? aggregateFromThinking(thinking)
    if (aggregate) {
      const info = thinkingSearchInfo(aggregate)
      groupSearchInfo.set(group, info)
      addSearchBottom(group, info)
    }
  } else if (kind === 'ai' && search) {
    attachSearchUi(group, search)
  }

  return { group, body }
}

/**
 * 标记一条 AI 回答是否还在生成。
 * 生成期间隐藏下方操作行（复制按钮），结束或手动停止后再放出来。
 */
function setStreamingState(body: HTMLElement | null, streaming: boolean): void {
  body?.closest('.msg-group')?.classList.toggle('is-streaming', streaming)
}

function appendMessage(
  kind: 'user' | 'ai',
  text: string,
  html?: string,
  markdown?: string,
  messageKey?: string,
  search?: SearchInfo,
  thinking?: ThinkingInfo,
): HTMLElement {
  const { group, body } = buildMessageGroup(
    kind,
    text,
    html,
    markdown,
    messageKey,
    search,
    thinking,
  )
  messagesInner.appendChild(group)
  updateScrollButton()
  return body
}

/**
 * 拿到当前正在生成的回答组；还没有就创建一个空组。
 * 深度思考、搜索摘要、正文谁先到都能落在同一个组里。
 */
function ensureStreamingAnswerGroup(): { group: HTMLElement; body: HTMLElement } | null {
  let group = streamingBody?.closest('.msg-group') as HTMLElement | null
  if (!group) {
    removeThinking()
    const body = appendMessage('ai', '')
    streamingBody = body
    setStreamingState(body, true)
    group = body.closest('.msg-group')
  }
  if (!group) return null
  const body =
    (group.querySelector('.body') as HTMLElement | null) || streamingBody || null
  if (!body) return null
  return { group, body }
}

/**
 * 把更早的历史消息插到列表顶部。
 * 插入前后补滚动高度，保证用户当前看到的内容不跳。
 */
function prependMessages(history: HistoryMessage[]): void {
  if (!history.length) return

  const oldHeight = messages.scrollHeight
  const oldTop = messages.scrollTop

  const fragment = document.createDocumentFragment()
  for (const message of history) {
    const { group } = buildMessageGroup(
      message.role === 'user' ? 'user' : 'ai',
      message.text,
      message.html,
      message.markdown,
      undefined,
      message.search,
      message.thinking,
    )
    fragment.appendChild(group)
  }
  messagesInner.insertBefore(fragment, messagesInner.firstChild)

  messages.scrollTop = oldTop + (messages.scrollHeight - oldHeight)
  updateScrollButton()
}

/** 消息区一页的高度（动态，跟随窗口大小） */
function historyPageHeight(): number {
  return Math.max(200, messages.clientHeight || 400)
}

function prependOneHistoryMessage(message: HistoryMessage): void {
  const { group } = buildMessageGroup(
    message.role === 'user' ? 'user' : 'ai',
    message.text,
    message.html,
    message.markdown,
    message.key,
    message.search,
    message.thinking,
  )
  messagesInner.insertBefore(group, messagesInner.firstChild)
}

/**
 * 接口历史首屏渲染：
 * 先完整渲染最后一组问答；如果不足两页，再向上补更早的消息到两页。
 */
function renderApiHistoryInitial(
  all: HistoryMessage[],
): { all: HistoryMessage[]; lastUser: number } {
  historyAllMessages = all

  let lastUser = -1
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i].role === 'user') {
      lastUser = i
      break
    }
  }
  if (lastUser < 0) lastUser = Math.max(0, all.length - 1)

  // 第一阶段：只渲染最后一组；更早的两页缓冲等首屏画完再补
  for (let i = lastUser; i < all.length; i += 1) {
    const message = all[i]
    appendMessage(
      message.role === 'user' ? 'user' : 'ai',
      message.text,
      message.html,
      message.markdown,
      message.key,
      message.search,
      message.thinking,
    )
  }

  historyRenderedStart = lastUser
  historyHasOlder = lastUser > 0
  return { all, lastUser }
}

/**
 * 第二阶段：首屏画完后，在后台把更早的两页缓冲补到顶部。
 * 每次 prepend 都补偿滚动高度，最后一条用户消息保持在原来的位置。
 */
function renderApiHistoryOlderBuffer(epoch: number, all: HistoryMessage[], lastUser: number): void {
  if (epoch !== historyRenderEpoch || historyAllMessages !== all) {
    historyPrefillRunning = false
    return
  }

  const limit = historyPageHeight() * 2
  let renderedStart = lastUser

  while (renderedStart > 0 && messagesInner.offsetHeight < limit) {
    const index = renderedStart - 1
    const oldHeight = messages.scrollHeight
    const oldTop = messages.scrollTop
    prependOneHistoryMessage(all[index])
    messages.scrollTop = oldTop + (messages.scrollHeight - oldHeight)
    renderedStart = index
  }

  historyRenderedStart = renderedStart
  historyHasOlder = renderedStart > 0
  historyPrefillRunning = false
  updateScrollButton()
}

/** 从内存里的完整历史中，向上渲染一批（一页） */
function renderOlderFromMemory(): void {
  const all = historyAllMessages
  if (!all || historyRenderedStart <= 0) {
    historyHasOlder = false
    historyOlderLoading = false
    historyLoader.hidden = true
    return
  }

  const page = historyPageHeight()
  const oldHeight = messages.scrollHeight
  const oldTop = messages.scrollTop
  let start = historyRenderedStart

  while (start > 0) {
    const index = start - 1
    prependOneHistoryMessage(all[index])
    start = index
    if (messages.scrollHeight - oldHeight >= page) break
  }

  historyRenderedStart = start
  messages.scrollTop = oldTop + (messages.scrollHeight - oldHeight)
  historyHasOlder = start > 0
  historyOlderLoading = false
  historyLoader.hidden = true
  updateScrollButton()
}

/** 滚到顶部后按需加载更早的一批消息 */
function requestOlderHistory(): void {
  if (!historyHasOlder || historyOlderLoading || historyPrefillRunning) return
  historyOlderLoading = true
  historyLoader.hidden = false

  if (historyAllMessages) {
    // 接口路径：数据都在内存里，只差渲染
    requestAnimationFrame(() => renderOlderFromMemory())
    return
  }

  window.ds?.loadOlderQuickHistory()
}

function addThinking(): void {
  if (thinkingEl) return
  const group = document.createElement('div')
  // 等待动画占的是「AI 回答组」的位置，上边距和回答保持一致
  group.className = 'msg-group msg-group-thinking'
  const box = document.createElement('div')
  box.className = 'thinking'
  box.innerHTML = '<i></i><i></i><i></i>'
  group.appendChild(box)
  messagesInner.appendChild(group)
  thinkingEl = group
}

function removeThinking(): void {
  thinkingEl?.remove()
  thinkingEl = null
}

function clearMessages(): void {
  historyLandingGroup = null
  historyHasOlder = false
  historyOlderLoading = false
  historyLazyArmed = false
  historyAllMessages = null
  historyRenderedStart = 0
  historyPrefillRunning = false
  historyLandingPending = false
  historyLoader.hidden = true
  messagesInner.replaceChildren()
  messagesTail.style.height = '0px'
  streamingBody = null
  thinkingEl = null
  continueButton = null
}

// ── 「继续生成」按钮 ─────────────────────────────────────────

/** 当前位置上的「继续生成」胶囊（只有最新一条被截断的回答才有） */
let continueButton: HTMLButtonElement | null = null
/** 继续生成时复用的那条 AI 气泡（避免在下面再多出一个重复气泡） */
let continueBody: HTMLElement | null = null

function hideContinueButton(): void {
  if (!continueButton) return
  const actions = continueButton.parentElement
  continueButton.remove()
  actions?.classList.remove('has-continue')
  continueButton = null
  continueBody = null
}

/**
 * 在最后一条 AI 回答下方挂出「继续生成」。
 * 操作行原本只有左侧的复制按钮，这里加一个右侧的胶囊。
 */
function showContinueButton(): void {
  hideContinueButton()

  const groups = messagesInner.querySelectorAll('.msg-group')
  const last = groups[groups.length - 1] as HTMLElement | undefined
  if (!last) return

  const actions = last.querySelector('.msg-actions:not(.right)') as HTMLElement | null
  if (!actions) return

  const body = last.querySelector('.msg-ai .body') as HTMLElement | null
  if (!body) return

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'continue-btn'
  button.textContent = t('quick.continue')
  button.addEventListener('click', () => {
    // 续写的结果是「同一条回答继续变长」，直接复用这条气泡，
    // 不要再多挂一条重复的 AI 消息
    const target = continueBody
    hideContinueButton()
    streamingBody = target
    setStreamingState(target, true)
    busy = true
    stopping = false
    syncSendState()
    window.ds?.continueQuickGeneration()
  })

  actions.classList.add('has-continue')
  actions.appendChild(button)
  continueButton = button
  continueBody = body
  updateScrollButton()
}

// ── 形态切换 ──────────────────────────────────────────────────

/**
 * 只改界面自身的状态，不通知主进程。
 * 主进程推来 mode-changed 时也走这里，避免来回互相调用。
 */
function applyMode(next: QuickMode): void {
  if (mode === next) return
  if (historyOpen) applyHistoryPanel(false)
  mode = next
  app.dataset.mode = next

  if (next === 'empty') {
    busy = false
    historyLoading = false
    closeSearchPanel()
    clearMessages()
    topbar.classList.remove('show')
    app.classList.remove('content-enter')
    app.classList.remove('content-leave')
    input.value = ''
  }

  autosize()
  syncSendState()
  syncAppWidth()
  // 布局要等一帧才稳定（展开动画期间高度在变）
  requestAnimationFrame(() => {
    updateScrollButton()
    placeMessagesFade()
  })
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
  // stopping：已经点了停止，等主进程确认前不要发下一条
  if (!text || busy || stopping || historyLoading) return

  // 发了新消息，上一条被截断的回答就不能再继续了
  hideContinueButton()
  if (historyOpen) {
    applyHistoryPanel(false)
    window.ds?.toggleQuickHistory(false)
  }

  /*
   * 空态 → 有内容态。
   * 动效暂时关闭：主进程直接切到最终窗口，内容也跟着直接出现。
   * 恢复动效时取消下面 content-enter 那段注释即可。
   */
  const enteringContent = mode === 'empty'

  const smartSearch = isPressed(smartSearchButton)
  const payload: QuickSubmitPayload = {
    text,
    deepThink: isPressed(deepThinkButton),
    smartSearch,
    // 空态发出的消息 = 新对话的第一条，主进程会先开新会话
    startNewChat: enteringContent,
  }

  /*
   * 动效暂时关闭，直接展示最终效果：
   *
   * if (enteringContent) {
   *   app.classList.add('content-enter')
   *   // 兜底：万一没收到 transition-done，也不要把内容永久藏着
   *   window.setTimeout(() => app.classList.remove('content-enter'), 1500)
   * }
   */

  // 先把反馈给到用户：切形态 + 画出自己那条气泡，然后再等回答
  switchToContent()
  const bubble = appendMessage('user', text)
  addThinking()

  // 新消息顶到「顶栏下方 10px」，每次发消息都能从最上面开始看
  const group = bubble.closest('.msg-group') as HTMLElement | null
  // 第一条（空态→有内容态）不做滚动动画，直接落位
  if (group) alignMessageToTop(group, !enteringContent)
  updateScrollButton()

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
      if (!streamingBody) {
        const ensured = ensureStreamingAnswerGroup()
        if (!ensured) break
        streamingBody = ensured.body
      }
      removeThinking()

      const group = streamingBody.closest('.msg-group') as HTMLElement | null
      const bodyWasEmpty = !(streamingBody.textContent || '').trim()
      renderAiContent(streamingBody, event.text, event.html)

      if (bodyWasEmpty && group?.querySelector('.think-block')) {
        // 正文开始：思考标题立即切成「已思考…」，并把正文第一行滚到顶部
        markThinkingDone(group)
        const scrollBody = streamingBody
        requestAnimationFrame(() => {
          // answer-done 可能在同一帧到达，消息已经被清掉
          if (scrollBody.isConnected) alignAnswerBodyToTop(scrollBody)
        })
      }

      // 设计稿：生成过程中不自动滚动，只更新「滚动到底部」按钮
      updateScrollButton()
      break
    }

    case 'answer-thinking': {
      let group = streamingBody?.closest('.msg-group') as HTMLElement | null
      if (!group && busy) {
        const ensured = ensureStreamingAnswerGroup()
        group = ensured?.group ?? null
      }
      if (!group) group = currentAnswerGroup()
      if (!group) break

      if (typeof event.answerIndex === 'number') {
        groupAnswerIndex.set(group, event.answerIndex)
      }

      attachThinking(group, event.thinking, { collapsed: false })

      const aggregate =
        event.thinking.aggregateSearch ?? aggregateFromThinking(event.thinking)
      if (aggregate) {
        const existing = groupSearchInfo.get(group)
        const existingHasDetails =
          !!existing && existing.sources.some((source) => source.url)
        // 已经拿到完整详情就不要被摘要覆盖
        if (!existingHasDetails) {
          const info = thinkingSearchInfo(aggregate)
          groupSearchInfo.set(group, info)
          // 已经挂出胶囊时，随着网页真实数量更新摘要
          if (group.querySelector('.search-pill')) addSearchBottom(group, info)
        }
        if (!busy) completeSearchBottom(group)
      }
      updateScrollButton()
      break
    }

    case 'answer-search-summary': {
      let group = streamingBody?.closest('.msg-group') as HTMLElement | null
      if (!group && busy) {
        const ensured = ensureStreamingAnswerGroup()
        group = ensured?.group ?? null
      }
      if (!group) group = currentAnswerGroup()
      if (!group) break

      if (typeof event.answerIndex === 'number') {
        groupAnswerIndex.set(group, event.answerIndex)
      }

      // 开了深度思考时搜索气泡在思考块里，不再挂顶部搜索气泡
      if (group.querySelector('.think-block')) break

      const existing = groupSearchInfo.get(group)
      // 详情已经先到了就不要被摘要覆盖
      if (existing && existing.sources.some((source) => source.url)) break

      const info = searchInfoFromSummary(event.summary)
      groupSearchInfo.set(group, info)
      if (!group.querySelector('.search-top')) attachSearchUi(group, info, false)
      if (!busy) completeSearchBottom(group)
      // 结果栏的完整数据等用户点击入口时再按需拉取，这里不动面板内容
      break
    }

    case 'answer-done': {
      removeThinking()
      const finishedGroup = streamingBody?.closest('.msg-group') as HTMLElement | null
      if (finishedGroup) {
        markThinkingDone(finishedGroup)
        completeSearchBottom(finishedGroup)
        finishedGroup.classList.remove('is-streaming')
      }
      releaseTail()
      streamingBody = null
      busy = false
      stopping = false
      hideContinueButton()
      syncSendState()
      updateScrollButton()
      // 回答结束，光标回到输入框
      focusInput()
      break
    }

    case 'answer-stopped': {
      const wasStopping = stopping
      stopping = false

      if (!event.stopped) {
        /*
         * 停止没生效，页面其实还在生成：
         * 把按钮恢复成停止态，继续等回答更新。
         * 如果这期间回答已经自己结束了（wasStopping 已被清掉），就不用管。
         */
        if (wasStopping) {
          busy = true
          syncSendState()
        }
        break
      }

      removeThinking()
      const stoppedGroup = streamingBody?.closest('.msg-group') as HTMLElement | null
      if (stoppedGroup) {
        markThinkingStopped(stoppedGroup)
        completeSearchBottom(stoppedGroup)
        stoppedGroup.classList.remove('is-streaming')
      }
      releaseTail()
      streamingBody = null
      busy = false
      syncSendState()
      // DeepSeek 只有最新一条被截断的回答会给出「继续生成」
      if (event.canContinue) showContinueButton()
      updateScrollButton()
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
      placeMessagesFade()

      // 历史对话的落点：窗口动画结束后再精确对齐一次最后一条用户消息
      if (historyLandingPending && mode === 'content') {
        const users = messagesInner.querySelectorAll('.msg-user')
        const lastUser = users[users.length - 1] as HTMLElement | undefined
        const group = lastUser?.closest('.msg-group') as HTMLElement | null
        if (group) alignMessageToTop(group, false)
        updateScrollButton()
        historyLandingPending = false
      }
      break
    }

    case 'conversation-cleared': {
      // 退出登录：释放历史对话的 Markdown HTML 缓存
      clearMarkdownCache()
      resetToEmpty()
      break
    }

    case 'error': {
      removeThinking()
      releaseTail()
      setStreamingState(streamingBody, false)
      streamingBody = null
      historyLoading = false
      busy = false
      stopping = false
      appendMessage('ai', `${t('quick.error')}：${event.message}`)
      syncSendState()
      updateScrollButton()
      break
    }

    case 'history-shortcut': {
      if (busy || stopping || historyLoading) break
      if (historyOpen) {
        applyHistoryPanel(false)
        window.ds?.toggleQuickHistory(false)
        break
      }
      historyKeyboardSelect = true
      requestHistoryToggle()
      break
    }

    case 'history-panel': {
      applyHistoryPanel(event.open)
      break
    }

    case 'history-list': {
      if (!historyOpen) break
      renderHistoryItems(event.items, event.append)
      historyHasMore = event.hasMore
      historyLoadPending = false
      break
    }

    case 'history-start': {
      applyHistoryPanel(false)
      closeSearchPanel()
      clearMessages()
      addThinking()
      historyLoading = true
      historyHasOlder = false
      historyOlderLoading = false
      historyLazyArmed = false
      historyAllMessages = null
      historyRenderedStart = 0
      historyLoader.hidden = true
      busy = false
      stopping = false
      syncSendState()
      break
    }

    case 'history-loaded': {
      removeThinking()
      historyLoader.hidden = true
      historyRenderEpoch += 1
      clearMessages()
      historyAllMessages = null
      historyRenderedStart = 0
      historyPrefillRunning = false

      if (event.source === 'api') {
        const plan = renderApiHistoryInitial(event.messages)
        const epoch = historyRenderEpoch
        historyPrefillRunning = true
        // 双 rAF：先让最后一组完成一次绘制，再补两页缓冲
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            renderApiHistoryOlderBuffer(epoch, plan.all, plan.lastUser)
          })
        })
      } else {
        for (const message of event.messages) {
          appendMessage(
            message.role === 'user' ? 'user' : 'ai',
            message.text,
            message.html,
            message.markdown,
            message.key,
            message.search,
            message.thinking,
          )
        }
        historyHasOlder = event.hasOlder
      }

      historyLoading = false
      historyOlderLoading = false
      historyLazyArmed = false
      historyLandingPending = true
      busy = false
      stopping = false
      syncSendState()

      /*
       * 进入历史对话后的落点：最后一条用户消息的气泡顶端对齐到
       * 「顶栏下方 10px」—— 和空态发第一条消息时的位置一致。
       * 这样能先看清自己最后问了什么，再往下看回答。
       */
      requestAnimationFrame(() => {
        const users = messagesInner.querySelectorAll('.msg-user')
        const lastUser = users[users.length - 1] as HTMLElement | undefined
        const group = lastUser?.closest('.msg-group') as HTMLElement | null
        if (mode === 'content' && group) {
          alignMessageToTop(group, false)
          // 等字体/图片/代码块和窗口展开动画都稳定后再对齐一次，
          // 防止后面的内容把气泡顶偏
          const landingGroup = group
          const landingScrollTop = messages.scrollTop
          historyLandingGroup = group
          window.setTimeout(() => {
            if (historyLandingGroup !== landingGroup || !landingGroup.isConnected) return
            if (mode !== 'content') return
            // 用户已经自己滚动过，就不要再抢位置
            if (Math.abs(messages.scrollTop - landingScrollTop) > 2) {
              historyLandingGroup = null
              return
            }
            alignMessageToTop(landingGroup, false)
            updateScrollButton()
            historyLandingGroup = null
            historyLandingPending = false
          }, 450)
        } else {
          messages.scrollTop = messages.scrollHeight
        }
        updateScrollButton()
        focusInput()
      })
      break
    }

    case 'history-prepended': {
      prependMessages(event.messages)
      historyHasOlder = event.hasOlder
      historyOlderLoading = false
      historyLoader.hidden = true
      break
    }

    case 'answer-start': {
      // 提交时已经放过呼吸点；继续生成时这里负责切回「停止」态
      busy = true
      stopping = false
      hideContinueButton()
      syncSendState()
      break
    }
  }
})

// ── 交互绑定 ──────────────────────────────────────────────────

input.addEventListener('input', () => {
  autosize()
  syncSendState()
})

input.addEventListener('keydown', (event) => {
  // 历史弹框展开时，回车留给列表确认，不要发送消息
  if (historyOpen) {
    if (event.key === 'Enter') event.preventDefault()
    return
  }

  // isComposing：中文输入法选词时的回车不能当成发送
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit()
  }
})

// 历史弹框展开时：上下键切换，回车确认
document.addEventListener('keydown', (event) => {
  if (!historyOpen) return

  const items = historyItemElements()
  if (!items.length) return

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (historySelectedIndex < 0) {
      setHistorySelection(0)
    } else {
      setHistorySelection(historySelectedIndex + (event.key === 'ArrowDown' ? 1 : -1))
    }
    return
  }

  if (event.key === 'Enter') {
    event.preventDefault()
    const index = historySelectedIndex >= 0 ? historySelectedIndex : 0
    items[index]?.click()
  }
})

deepThinkButton?.addEventListener('click', () => togglePressed(deepThinkButton))
smartSearchButton?.addEventListener('click', () => togglePressed(smartSearchButton))
historyButton?.addEventListener('click', () => requestHistoryToggle())

// 历史列表滚到接近底部：按需再向页面要一屏（不显示 loading）
historyList.addEventListener('scroll', () => {
  if (!historyOpen || !historyHasMore || historyLoadPending) return
  const remaining = historyList.scrollHeight - historyList.scrollTop - historyList.clientHeight
  if (remaining > 80) return
  historyLoadPending = true
  window.ds?.loadMoreQuickHistory()
})

// 点弹框外面（包括输入框、消息区、其它按钮）就收起
app.addEventListener(
  'pointerdown',
  (event) => {
    if (!historyOpen) return
    const target = event.target as Node | null
    if (target && (historyPanel.contains(target) || historyButton.contains(target))) return
    applyHistoryPanel(false)
    window.ds?.toggleQuickHistory(false)
  },
  true,
)

// Markdown 里的链接：一律用系统浏览器打开，不让面板自己导航
messagesInner.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null
  const link = target?.closest('a')
  if (!link) return
  event.preventDefault()
  const href = link.getAttribute('href') || ''
  if (href.startsWith('#')) {
    // Markdown 脚注等站内锚点：在消息区内滚动过去
    try {
      const dest = messagesInner.querySelector(href)
      dest?.scrollIntoView({ block: 'center' })
    } catch {
      // 非法选择器忽略
    }
    return
  }
  if (href) window.ds?.openExternal(href)
})

// 滚动时更新「滚动到底部」按钮；滚到历史顶部时按需加载更早消息
messages.addEventListener('scroll', () => {
  updateScrollButton()
  if (
    historyLazyArmed &&
    historyHasOlder &&
    !historyOlderLoading &&
    messages.scrollTop <= 24
  ) {
    requestOlderHistory()
  }
}, { passive: true })

// 触控板/鼠标向上滑到顶：加载更早的消息
messages.addEventListener('wheel', (event) => {
  if (event.deltaY >= 0) return
  if (messages.scrollTop > OLDER_TRIGGER) return
  historyLazyArmed = true
  requestOlderHistory()
}, { passive: true })

// 拖滚动条/键盘滚动时，先标记用户主动滚动过
messages.addEventListener('pointerdown', () => {
  historyLazyArmed = true
}, { passive: true })
messages.addEventListener(
  'scrollend',
  () => {
    if (!suppressScrollButton) return
    suppressScrollButton = false
    if (suppressScrollTimer) {
      window.clearTimeout(suppressScrollTimer)
      suppressScrollTimer = undefined
    }
    updateScrollButton()
  },
  { passive: true },
)
const scrollObserver = new ResizeObserver(updateScrollButton)
scrollObserver.observe(messages)
scrollObserver.observe(messagesInner)

scrollBottomButton.addEventListener('click', () => {
  // 点下去立刻收起，不等滚到底部
  suppressScrollButtonDuringAnimation()
  // 只滚到内容底部，不滚进 messagesTail 补出来的空白
  messages.scrollTo({ top: Math.max(0, contentBottom() - messages.clientHeight), behavior: 'smooth' })
  focusInput()
})
sendButton.addEventListener('click', () => {
  if (!busy) {
    submit()
    return
  }

  // 生成中：按钮是「停止生成」
  if (stopping) return

  /*
   * 乐观更新：点下去立刻切回发送态，不等主进程确认。
   * 如果停止失败，answer-stopped(stopped:false) 会把按钮恢复成停止态。
   */
  stopping = true
  busy = false
  syncSendState()
  window.ds?.stopQuickGeneration()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (searchPanelOpen) {
      closeSearchPanel()
      return
    }
    if (historyOpen) {
      applyHistoryPanel(false)
      window.ds?.toggleQuickHistory(false)
      return
    }
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
  /*
   * 动效暂时关闭，直接切回空态。
   * 恢复动效时取消下面两行注释：
   *
   * app.classList.add('content-leave')
   * window.setTimeout(() => app.classList.remove('content-leave'), 1500)
   */
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
  // 历史弹框开着时，点哪都只是「关弹框」，不要顺手把窗口拖走
  if (historyOpen) return
  const target = event.target as HTMLElement | null
  if (target?.closest('button, textarea, input, select, a, .messages, .history-panel')) return
  // 个别情况下 screenX/Y 会是 NaN，不能拿它当拖动起点
  if (!Number.isFinite(event.screenX) || !Number.isFinite(event.screenY)) return

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
  if (!Number.isFinite(event.screenX) || !Number.isFinite(event.screenY)) return
  window.ds?.moveWindowDrag(event.screenX, event.screenY)
})

function endWindowDrag(event: PointerEvent): void {
  if (!dragOrigin) return
  dragOrigin = null
  try {
    if (app.hasPointerCapture(event.pointerId)) app.releasePointerCapture(event.pointerId)
    if (searchPanel.hasPointerCapture(event.pointerId)) {
      searchPanel.releasePointerCapture(event.pointerId)
    }
  } catch {
    // 忽略
  }
  window.ds?.endWindowDrag()
}

app.addEventListener('pointerup', endWindowDrag)
app.addEventListener('pointercancel', endWindowDrag)

// 搜索结果栏也可以拖动整个窗口（按钮、链接除外）
searchPanel.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  const target = event.target as HTMLElement | null
  if (target?.closest('button, a, input, textarea, select')) return
  if (!Number.isFinite(event.screenX) || !Number.isFinite(event.screenY)) return

  dragOrigin = { x: event.screenX, y: event.screenY }
  try {
    searchPanel.setPointerCapture(event.pointerId)
  } catch {
    // 合成事件下没有活跃指针
  }
  window.ds?.beginWindowDrag(event.screenX, event.screenY)
  showTopbar()
  event.preventDefault()
})

searchPanel.addEventListener('pointermove', (event) => {
  if (!dragOrigin) return
  if (!Number.isFinite(event.screenX) || !Number.isFinite(event.screenY)) return
  window.ds?.moveWindowDrag(event.screenX, event.screenY)
})

searchPanel.addEventListener('pointerup', endWindowDrag)
searchPanel.addEventListener('pointercancel', endWindowDrag)

// 被重新唤出时：焦点回到输入框，并按输入框里**当前**的内容重新量一次高度 ——
// 用户收起面板时可能已经打了一大段字，不能缩回初始尺寸。
window.ds?.onQuickShown(() => {
  // 顺手重拉一次文案 —— 用户可能刚在设置里换了语言
  void loadMessages()
  app.classList.remove('content-enter')
  // 设计稿：隐藏后重新唤起，历史弹框默认收起
  applyHistoryPanel(false)
  autosize()
  updateScrollButton()
  input.focus()
})

// 焦点一回到窗口，光标就落在输入框里（从别的 App 切回来、重新唤出都算）
window.addEventListener('focus', focusInput)

// 窗口尺寸变化（空态展开历史、用户缩放有内容态）后重新贴一下弹框
window.addEventListener('resize', () => {
  syncAppWidth()
  if (historyOpen) {
    placeHistoryPanel()
  } else if (app.dataset.mode === 'empty' && window.innerHeight <= 220) {
    // 历史弹框已关闭，且窗口已经从撑高状态缩回：现在才撤掉 composer 的固定高度
    app.classList.remove('history-open')
  }
  placeMessagesFade()
})

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
syncAppWidth()
input.focus()

import type { Language, ResolvedLanguage } from './i18n'

/** 主题：跟随系统 / 浅色 / 深色 */
export type ThemeSetting = 'system' | 'light' | 'dark'

/** 快捷窗口的两种形态（设计稿：快捷窗口-无内容 / 快捷窗口-有内容） */
export type QuickMode = 'empty' | 'content'

/** 历史对话列表里的一条 */
export interface HistoryEntry {
  id: string
  title: string
}

/** 历史对话里的消息。AI 消息额外带渲染好的 HTML（快速窗口负责清洗） */
export interface HistoryMessage {
  role: 'user' | 'ai'
  text: string
  html?: string
  /** 接口返回的原始 Markdown（历史对话走接口时使用） */
  markdown?: string
  /** 页面虚拟列表的消息 key，用于继续加载更早的消息 */
  key?: string
}

/** 主进程推给快捷窗口的事件，走同一条通道 */
export type QuickEvent =
  /** 消息已发出，界面可以进入「等待回答」 */
  | { type: 'answer-start' }
  /** 回答增量更新：text 用于纯文本兜底/复制，html 是页面里渲染好的 Markdown */
  | { type: 'answer-update'; text: string; html?: string }
  /** 回答结束 */
  | { type: 'answer-done' }
  /**
   * 停止操作的结果。
   * stopped=false 表示 DeepSeek 那边没停成功（页面还在生成），界面要恢复成停止态。
   * canContinue 表示 DeepSeek 页面是否给出了「继续生成」按钮。
   */
  | { type: 'answer-stopped'; stopped: boolean; canContinue: boolean }
  /** 主进程改了窗口形态，界面要跟着切（避免两边状态不一致） */
  | { type: 'mode-changed'; mode: QuickMode }
  /** 空态 → 有内容态的窗口展开动画结束，界面可以把内容淡入 */
  | { type: 'transition-done' }
  /** 对话被清空（顶栏「新对话」） */
  | { type: 'conversation-cleared' }
  /** 出错，界面应把消息撤掉并提示 */
  | { type: 'error'; message: string }
  /** 历史弹框的展开/收起（主进程可能同时改了窗口尺寸） */
  | { type: 'history-panel'; open: boolean }
  /** 历史列表（第一次打开 append=false，滚动加载 append=true） */
  | { type: 'history-list'; items: HistoryEntry[]; append: boolean; hasMore: boolean }
  /** 正在从 DeepSeek 页面加载选中的历史对话 */
  | { type: 'history-start' }
  /** 历史对话加载完成：只包含最后一段完整问答 */
  | { type: 'history-loaded'; messages: HistoryMessage[]; hasOlder: boolean; source?: 'api' | 'dom' }
  /** 按需加载的更早历史消息（prepend 到列表顶部） */
  | { type: 'history-prepended'; messages: HistoryMessage[]; hasOlder: boolean }

export interface QuickSubmitPayload {
  text: string
  /** 「深度思考」开关 */
  deepThink: boolean
  /** 「智能搜索」开关 */
  smartSearch: boolean
  /**
   * 面板当时是空态（没有对话内容）。
   * 空态发出第一条消息必须**新开一个 DeepSeek 对话**，
   * 不能接着主窗口里正在看的那个会话往下写。
   */
  startNewChat: boolean
}

export interface HotkeyUpdateResult {
  ok: boolean
  /** 给用户看的一句话（已按当前语言翻译好） */
  message: string
  /** 生效后的展示文本，例如 "⌥ Space" */
  display: string
}

/** 设置窗口一次拿齐所有需要的东西 */
export interface SettingsSnapshot {
  messages: Record<string, string>
  language: ResolvedLanguage
  languageSetting: Language
  /** 主题设置：system / light / dark */
  theme: ThemeSetting
  /** Electron accelerator，例如 'Alt+Space' */
  hotkey: string
  hotkeyDisplay: string
  /** 0 表示「从不」重置 */
  resetAfterMinutes: number
  version: string
}

/** 主进程通过 preload 暴露给渲染层的接口 —— 保持最小，按需增加 */
export interface DsApi {
  // ── 通用 ──────────────────────────────────────────────────

  /** 读取应用版本号 */
  getVersion: () => Promise<string>

  /** 拉取当前语言的文案表 */
  getMessages: () => Promise<Record<string, string>>

  /** 用系统浏览器打开链接（只允许 http/https） */
  openExternal: (url: string) => void

  // ── 设置 ──────────────────────────────────────────────────

  openSettings: () => void
  getSettings: () => Promise<SettingsSnapshot>
  setHotkey: (accelerator: string) => Promise<HotkeyUpdateResult>
  setResetAfter: (minutes: number) => Promise<void>
  setLanguage: (language: Language) => Promise<void>
  setTheme: (theme: ThemeSetting) => Promise<void>
  logout: () => Promise<void>

  // ── 快捷窗口 ──────────────────────────────────────────────

  hideQuickWindow: () => void

  /**
   * 空态下输入折行时请求改高。
   * 主进程会保持底边不动、只把顶边上移，并夹在 100–200 之间。
   */
  resizeQuickWindow: (height: number) => void

  /** 提交一条消息，主进程会驱动主窗口里的 DeepSeek 网页完成这次对话 */
  submitQuickMessage: (payload: QuickSubmitPayload) => void

  /** 停止生成：点掉 DeepSeek 页面上的停止按钮 */
  stopQuickGeneration: () => void

  /** 继续生成：点掉 DeepSeek 页面上的「继续生成」按钮 */
  continueQuickGeneration: () => void

  /** 打开 / 收起历史对话弹框 */
  toggleQuickHistory: (open: boolean) => void

  /** 历史列表滚到底部时，让主进程再去页面里滚一屏 */
  loadMoreQuickHistory: () => void

  /** 选了某条历史对话 */
  selectQuickHistory: (id: string) => void

  /** 滚到历史消息顶部时，请求更早的一批消息 */
  loadOlderQuickHistory: () => void

  /** 切换窗口形态：空态 ↔ 有内容 */
  setQuickMode: (mode: QuickMode) => void

  /** 顶栏「新对话」：清空当前对话 */
  quickNewChat: () => void

  /** 顶栏「扩大」：切到主窗口，关闭快捷窗口 */
  quickExpand: () => void

  // ── 窗口拖动（透明窗口下原生拖拽区不可靠，改为手动移动）──

  /** 按下鼠标，记录起点（屏幕坐标） */
  beginWindowDrag: (screenX: number, screenY: number) => void
  /** 拖动中，更新到当前鼠标位置（屏幕坐标） */
  moveWindowDrag: (screenX: number, screenY: number) => void
  /** 松开鼠标，落位并记住位置 */
  endWindowDrag: () => void

  /** 面板被呼出时触发，界面据此重新量高度、拉文案、把焦点收回输入框 */
  onQuickShown: (callback: () => void) => void

  /** 订阅主进程推来的对话事件 */
  onQuickEvent: (callback: (event: QuickEvent) => void) => void
}

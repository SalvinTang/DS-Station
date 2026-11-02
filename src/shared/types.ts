import type { Language, ResolvedLanguage } from './i18n'

/** 快捷窗口的两种形态（设计稿：快捷窗口-无内容 / 快捷窗口-有内容） */
export type QuickMode = 'empty' | 'content'

/** 主进程推给快捷窗口的事件，走同一条通道 */
export type QuickEvent =
  /** 消息已发出，界面可以进入「等待回答」 */
  | { type: 'answer-start' }
  /** 回答增量更新（纯文本） */
  | { type: 'answer-update'; text: string }
  /** 回答结束 */
  | { type: 'answer-done' }
  /** 主进程改了窗口形态，界面要跟着切（避免两边状态不一致） */
  | { type: 'mode-changed'; mode: QuickMode }
  /** 对话被清空（顶栏「新对话」） */
  | { type: 'conversation-cleared' }
  /** 出错，界面应把消息撤掉并提示 */
  | { type: 'error'; message: string }

export interface QuickSubmitPayload {
  text: string
  /** 「深度思考」开关 */
  deepThink: boolean
  /** 「智能搜索」开关 */
  smartSearch: boolean
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

  // ── 设置 ──────────────────────────────────────────────────

  openSettings: () => void
  getSettings: () => Promise<SettingsSnapshot>
  setHotkey: (accelerator: string) => Promise<HotkeyUpdateResult>
  setResetAfter: (minutes: number) => Promise<void>
  setLanguage: (language: Language) => Promise<void>
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

  /** 切换窗口形态：空态 ↔ 有内容 */
  setQuickMode: (mode: QuickMode) => void

  /** 顶栏「新对话」：清空当前对话 */
  quickNewChat: () => void

  /** 顶栏「扩大」：切到主窗口，关闭快捷窗口 */
  quickExpand: () => void

  /** 面板被呼出时触发，界面据此重新量高度、拉文案、把焦点收回输入框 */
  onQuickShown: (callback: () => void) => void

  /** 订阅主进程推来的对话事件 */
  onQuickEvent: (callback: (event: QuickEvent) => void) => void
}

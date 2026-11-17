import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Language } from '../shared/i18n'
import type {
  DsApi,
  GuideStep,
  QuickEditSubmitPayload,
  QuickEvent,
  QuickMode,
  QuickSubmitPayload,
  ThemeSetting,
  TrayAction,
} from '../shared/types'

/**
 * 只暴露给「我们自己的」界面（快捷窗口、设置页、引导页、状态栏菜单）。
 * DeepSeek 网页视图**不加载这个 preload**，所以远程页面拿不到任何东西。
 *
 * 每个方法都对应主进程里一个明确的 ipcMain 处理器，
 * 不提供通用的 send/channel 透传 —— 那等于把 IPC 通道整个开放出去。
 */
const api: DsApi = {
  getVersion: () => ipcRenderer.invoke('ds:get-version'),
  getMessages: () => ipcRenderer.invoke('ds:get-messages'),
  openExternal: (url: string) => ipcRenderer.send('ds:open-external', url),

  getSettings: () => ipcRenderer.invoke('ds:get-settings'),
  setHotkey: (accelerator: string) => ipcRenderer.invoke('ds:set-hotkey', accelerator),
  setQuickShortcut: (name: 'newChat' | 'history', accelerator: string) =>
    ipcRenderer.invoke('ds:set-quick-shortcut', name, accelerator),
  setResetAfter: (minutes: number) => ipcRenderer.invoke('ds:set-reset-after', minutes),
  setLanguage: (language: Language) => ipcRenderer.invoke('ds:set-language', language),
  setTheme: (theme: ThemeSetting) => ipcRenderer.invoke('ds:set-theme', theme),

  hideQuickWindow: () => ipcRenderer.send('ds:quick-hide'),
  resizeQuickWindow: (height) => ipcRenderer.send('ds:quick-resize', height),
  submitQuickMessage: (payload: QuickSubmitPayload) => ipcRenderer.send('ds:quick-submit', payload),
  regenerateLatestAnswer: () => ipcRenderer.send('ds:quick-regenerate'),
  startEdit: () => ipcRenderer.invoke('ds:start-edit'),
  cancelEdit: () => ipcRenderer.invoke('ds:cancel-edit'),
  submitEdit: (payload: QuickEditSubmitPayload) => ipcRenderer.send('ds:quick-edit-submit', payload),
  getEditAttachmentStatuses: (ids: string[]) =>
    ipcRenderer.invoke('ds:edit-attachment-statuses', ids),
  removeEditAttachment: (id: string, index: number) =>
    ipcRenderer.invoke('ds:remove-edit-attachment', id, index),
  stopQuickGeneration: () => ipcRenderer.send('ds:quick-stop'),
  continueQuickGeneration: () => ipcRenderer.send('ds:quick-continue'),
  toggleQuickHistory: (open: boolean) => ipcRenderer.send('ds:quick-history-toggle', open),
  loadMoreQuickHistory: () => ipcRenderer.send('ds:quick-history-more'),
  selectQuickHistory: (id: string) => ipcRenderer.send('ds:quick-history-select', id),
  loadOlderQuickHistory: () => ipcRenderer.send('ds:quick-history-older'),
  setQuickMode: (mode: QuickMode) => ipcRenderer.send('ds:quick-mode', mode),
  setSearchPanel: (open: boolean) => ipcRenderer.send('ds:quick-search-panel', open),
  pickAttachments: () => ipcRenderer.invoke('ds:pick-attachments'),
  importAttachment: (path: string) => ipcRenderer.invoke('ds:import-attachment', path),
  getPathForFile: (file: unknown) => webUtils.getPathForFile(file as File),
  prepareAttachments: (ids: string[]) => ipcRenderer.send('ds:prepare-attachments', ids),
  setAttachmentPanel: (open: boolean) => ipcRenderer.send('ds:quick-attachment-panel', open),
  requestAttachmentPreview: (id: string) => ipcRenderer.invoke('ds:preview-attachment', id),
  getAttachmentStatuses: (ids: string[]) => ipcRenderer.invoke('ds:attachment-statuses', ids),
  removeAttachment: (id: string) => ipcRenderer.invoke('ds:remove-attachment', id),
  retryAttachment: (id: string) => ipcRenderer.invoke('ds:retry-attachment', id),
  requestSearchDetails: (answerIndex: number, searchIndex?: number) =>
    ipcRenderer.invoke('ds:search-details', answerIndex, searchIndex),
  quickNewChat: () => ipcRenderer.send('ds:quick-new-chat'),
  quickExpand: () => ipcRenderer.send('ds:quick-expand'),

  guideNext: () => ipcRenderer.send('ds:guide-next'),
  guideStart: () => ipcRenderer.send('ds:guide-start'),
  onGuideStep: (callback: (step: GuideStep) => void) => {
    ipcRenderer.on('ds:guide-step', (_sender, step: GuideStep) => callback(step))
  },

  getTrayState: () => ipcRenderer.invoke('ds:tray-state'),
  trayAction: (action: TrayAction) => ipcRenderer.send('ds:tray-action', action),
  hideTrayMenu: () => ipcRenderer.send('ds:tray-hide'),
  onTrayShown: (callback: () => void) => {
    ipcRenderer.on('ds:tray-shown', () => callback())
  },

  beginWindowDrag: (screenX, screenY) =>
    ipcRenderer.send('ds:window-drag-start', screenX, screenY),
  moveWindowDrag: (screenX, screenY) =>
    ipcRenderer.send('ds:window-drag-move', screenX, screenY),
  endWindowDrag: () => ipcRenderer.send('ds:window-drag-end'),

  onQuickShown: (callback: () => void) => {
    ipcRenderer.on('ds:quick-shown', () => callback())
  },

  onQuickEvent: (callback: (event: QuickEvent) => void) => {
    ipcRenderer.on('ds:quick-event', (_sender, event: QuickEvent) => callback(event))
  },
}

contextBridge.exposeInMainWorld('ds', api)

import { contextBridge, ipcRenderer } from 'electron'
import type { Language } from '../shared/i18n'
import type { DsApi, QuickEvent, QuickMode, QuickSubmitPayload } from '../shared/types'

/**
 * 只暴露给「我们自己的」界面（标题栏、快捷窗口、设置页）。
 * DeepSeek 网页视图**不加载这个 preload**，所以远程页面拿不到任何东西。
 *
 * 每个方法都对应主进程里一个明确的 ipcMain 处理器，
 * 不提供通用的 send/channel 透传 —— 那等于把 IPC 通道整个开放出去。
 */
const api: DsApi = {
  getVersion: () => ipcRenderer.invoke('ds:get-version'),
  getMessages: () => ipcRenderer.invoke('ds:get-messages'),

  openSettings: () => ipcRenderer.send('ds:open-settings'),
  getSettings: () => ipcRenderer.invoke('ds:get-settings'),
  setHotkey: (accelerator: string) => ipcRenderer.invoke('ds:set-hotkey', accelerator),
  setResetAfter: (minutes: number) => ipcRenderer.invoke('ds:set-reset-after', minutes),
  setLanguage: (language: Language) => ipcRenderer.invoke('ds:set-language', language),
  logout: () => ipcRenderer.invoke('ds:logout'),

  hideQuickWindow: () => ipcRenderer.send('ds:quick-hide'),
  resizeQuickWindow: (height) => ipcRenderer.send('ds:quick-resize', height),
  submitQuickMessage: (payload: QuickSubmitPayload) => ipcRenderer.send('ds:quick-submit', payload),
  stopQuickGeneration: () => ipcRenderer.send('ds:quick-stop'),
  continueQuickGeneration: () => ipcRenderer.send('ds:quick-continue'),
  setQuickMode: (mode: QuickMode) => ipcRenderer.send('ds:quick-mode', mode),
  quickNewChat: () => ipcRenderer.send('ds:quick-new-chat'),
  quickExpand: () => ipcRenderer.send('ds:quick-expand'),

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

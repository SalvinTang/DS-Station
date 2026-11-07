import { BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'

/**
 * 设置窗口。
 *
 * P1 只搭好窗口骨架并把齿轮按钮接通；四个设置项
 * （快捷键 / 重置为新聊天 / 语言 / 版本号）与「退出登录」在 P4 实现。
 */

// 设计稿画板尺寸（设置页调整.html：360×460）
const WIDTH = 360
const HEIGHT = 460

let instance: BrowserWindow | null = null

export function openSettingsWindow(): void {
  if (instance && !instance.isDestroyed()) {
    instance.show()
    instance.focus()
    return
  }

  instance = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '设置',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1c20' : '#f6f6f6',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  instance.once('ready-to-show', () => instance?.show())
  instance.on('closed', () => {
    instance = null
  })

  void instance.loadFile(join(__dirname, '../renderer/settings/index.html'))
}

export function closeSettingsWindow(): void {
  if (instance && !instance.isDestroyed()) instance.destroy()
  instance = null
}

/** 当前设置窗口实例（开发自检用） */
export function getSettingsWindow(): BrowserWindow | null {
  return instance && !instance.isDestroyed() ? instance : null
}

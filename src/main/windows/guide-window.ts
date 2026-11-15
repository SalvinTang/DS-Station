import { BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'
import { isQuitting } from '../app-state'

/**
 * 功能引导窗口。
 *
 * 两个引导页共用一个 BrowserWindow，顶部是 macOS 标准窗口标题栏：
 * hiddenInset 保留系统红绿灯，背景和页面内容一致，不再自绘深色条。
 * 页面里只负责切换「引导页 1 / 引导页 2」。
 *
 * 实例由 index.ts 按需创建：启动阶段不预建，第一次需要显示引导时才加载。
 */

export const GUIDE_STEP = { intro: 1, connect: 2 } as const
export type GuideStep = (typeof GUIDE_STEP)[keyof typeof GUIDE_STEP]

const WIDTH = 520
const HEIGHT = 456
/** hiddenInset 标题栏高度；页面内容从这里开始 */
export const GUIDE_TITLEBAR_HEIGHT = 38

export class GuideWindow {
  readonly window: BrowserWindow

  private step: GuideStep = GUIDE_STEP.intro
  private loaded = false
  private centered = false

  constructor() {
    const background = nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff'

    this.window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'DS Station',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 12 },
      backgroundColor: background,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    this.window.webContents.on('did-finish-load', () => {
      this.loaded = true
      if (this.window.isVisible()) this.sendStep()
    })

    // 点系统红绿灯的关闭只是收起引导；app 仍留在菜单栏，可再次打开
    this.window.on('close', (event) => {
      if (isQuitting()) return
      event.preventDefault()
      this.window.hide()
    })

    void this.window.loadFile(join(__dirname, '../renderer/guide/index.html'))
  }

  get isVisible(): boolean {
    return this.window.isVisible()
  }

  show(step: GuideStep = this.step): void {
    this.step = step
    if (!this.centered) {
      this.window.center()
      this.centered = true
    }
    this.window.show()
    this.window.focus()
    this.sendStep()
  }

  hide(): void {
    if (!this.window.isDestroyed()) this.window.hide()
  }

  setStep(step: GuideStep): void {
    this.step = step
    this.sendStep()
  }

  /** 主题切换时让窗口底色跟随页面，避免边缘出现另一种颜色 */
  syncTheme(): void {
    if (this.window.isDestroyed()) return
    const background = nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff'
    this.window.setBackgroundColor(background)
  }

  private sendStep(): void {
    if (!this.loaded || this.window.isDestroyed()) return
    this.window.webContents.send('ds:guide-step', this.step)
  }
}

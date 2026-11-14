import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { isQuitting } from '../app-state'
import { getTrayBounds } from '../tray'

/**
 * 状态栏图标的弹出菜单。
 *
 * 原生 NSMenu 只能放纯文字菜单项，放不下账号卡、两个并排按钮和版本号，
 * 所以这里用透明无边框窗口自绘。窗口只负责外观，所有动作回主进程执行。
 */

const MENU_WIDTH = 280
const PADDING_X = 36
const WIDTH = MENU_WIDTH + PADDING_X * 2
const HEIGHT = 330
const EDGE_GAP = 0

export class TrayMenuWindow {
  readonly window: BrowserWindow
  private loaded = false

  constructor() {
    this.window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      roundedCorners: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      acceptFirstMouse: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    this.window.setAlwaysOnTop(true, 'pop-up-menu')
    this.window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })

    this.window.webContents.on('did-finish-load', () => {
      this.loaded = true
      if (this.window.isVisible()) this.sendShown()
    })

    this.window.on('blur', () => {
      // 给点击「设置 / 退出」留出执行时间；真正失焦后才收起
      setTimeout(() => {
        if (!this.window.isDestroyed() && !this.window.isFocused()) this.hide()
      }, 100)
    })

    this.window.on('close', (event) => {
      if (isQuitting()) return
      event.preventDefault()
      this.hide()
    })

    void this.window.loadFile(join(__dirname, '../renderer/tray-menu/index.html'))
  }

  get isVisible(): boolean {
    return this.window.isVisible()
  }

  show(): void {
    this.positionNearTray()
    app.focus({ steal: true })
    this.window.show()
    this.window.focus()
    this.window.moveTop()
    this.sendShown()
  }

  hide(): void {
    if (!this.window.isDestroyed()) this.window.hide()
  }

  toggle(): void {
    if (this.isVisible) this.hide()
    else this.show()
  }

  private sendShown(): void {
    if (!this.loaded || this.window.isDestroyed()) return
    this.window.webContents.send('ds:tray-shown')
  }

  private positionNearTray(): void {
    const tray = getTrayBounds()
    const point = tray
      ? { x: tray.x + tray.width / 2, y: tray.y + tray.height / 2 }
      : screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(point)
    const area = display.workArea

    // 窗口左右各有 36px 透明留白给阴影；菜单本身居中在状态栏图标下方
    let x = tray
      ? Math.round(tray.x + tray.width / 2 - MENU_WIDTH / 2 - PADDING_X)
      : point.x
    let y = tray ? Math.round(tray.y + tray.height + EDGE_GAP) : point.y

    x = Math.max(area.x + 6, Math.min(x, area.x + area.width - WIDTH - 6))
    y = Math.max(area.y, Math.min(y, area.y + area.height - HEIGHT - 6))

    this.window.setPosition(x, y, false)
  }
}

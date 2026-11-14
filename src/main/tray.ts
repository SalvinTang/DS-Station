import { Tray, app, nativeImage, type Rectangle } from 'electron'
import trayTemplateIcon from '../../resources/trayTemplate.png?asset'

/**
 * 菜单栏常驻图标。
 *
 * 明暗自动切换靠的是 **模板图**：图片只提供 alpha 形状，
 * macOS 会按菜单栏当前的外观着色 —— 浅色菜单栏画成黑色，
 * 深色菜单栏画成白色。所以 Design/素材 里的黑白两张稿，
 * 运行时只需要一张（黑色那张），另一张是给设计对稿用的。
 *
 * 点击图标不弹原生 NSMenu，而是由 TrayMenuWindow 自绘账号卡片和按钮。
 * tray 必须保存在模块作用域里，否则会被垃圾回收，图标随之消失。
 */

export interface TrayHandlers {
  onTrayClick: () => void
}

let tray: Tray | null = null
let handlers: TrayHandlers | null = null

export function createTray(next: TrayHandlers): void {
  if (tray) return

  handlers = next
  const icon = nativeImage.createFromPath(trayTemplateIcon)
  icon.setTemplateImage(true)

  tray = new Tray(icon)
  tray.setToolTip(app.name)
  tray.on('click', () => handlers?.onTrayClick())
  tray.on('right-click', () => handlers?.onTrayClick())
}

export function getTrayBounds(): Rectangle | null {
  if (!tray || tray.isDestroyed()) return null
  const bounds = tray.getBounds()
  return bounds.width > 0 && bounds.height > 0 ? bounds : null
}

/** 开发自检（DS_TRAY_TEST=1）用：确认图标进了菜单栏、点击回调已挂上 */
export function trayDebugState(): unknown {
  if (!tray) return { exists: false }
  return {
    exists: true,
    destroyed: tray.isDestroyed(),
    bounds: tray.getBounds(),
    expectedTooltip: app.name,
    customMenu: true,
    hasClickHandler: !!handlers,
  }
}

import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions } from 'electron'
import trayTemplateIcon from '../../resources/trayTemplate.png?asset'
import { translate, type MessageKey } from '../shared/i18n'
import { currentLanguage } from './settings'
import { openSettingsWindow } from './windows/settings-window'

export interface TrayHandlers {
  showMainWindow: () => void
}

let tray: Tray | null = null
let handlers: TrayHandlers | null = null

/**
 * 菜单栏常驻图标。
 *
 * 明暗自动切换靠的是 **模板图**：图片只提供 alpha 形状，
 * macOS 会按菜单栏当前的外观着色 —— 浅色菜单栏画成黑色，
 * 深色菜单栏画成白色。所以 Design/素材 里的黑白两张稿，
 * 运行时只需要一张（黑色那张），另一张是给设计对稿用的。
 *
 * tray 必须保存在模块作用域里，否则会被垃圾回收，图标随之消失。
 */
export function createTray(next: TrayHandlers): void {
  if (tray) return

  handlers = next
  const icon = nativeImage.createFromPath(trayTemplateIcon)
  icon.setTemplateImage(true)

  tray = new Tray(icon)
  tray.setToolTip(app.name)
  refreshTrayMenu()
}

/** 语言切换后重建菜单（由 index.ts 的 rebuildMenu 调用） */
export function refreshTrayMenu(): void {
  if (!tray || !handlers) return
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate()))
}

function buildTrayTemplate(): MenuItemConstructorOptions[] {
  const lang = currentLanguage()
  const t = (key: MessageKey, vars?: Record<string, string | number>): string =>
    translate(lang, key, vars)

  return [
    { label: t('menu.settings'), click: () => openSettingsWindow() },
    { label: t('menu.showMain'), click: () => handlers?.showMainWindow() },
    { type: 'separator' },
    { label: t('menu.quit', { app: app.name }), click: () => app.quit() },
  ]
}

/** 开发自检（DS_TRAY_TEST=1）用：确认图标真的进了菜单栏、菜单项也对 */
export function trayDebugState(): unknown {
  if (!tray) return { exists: false }
  return {
    exists: true,
    destroyed: tray.isDestroyed(),
    bounds: tray.getBounds(),
    expectedTooltip: app.name,
    menu: buildTrayTemplate().map((item) =>
      item.type === 'separator' ? '---' : item.label,
    ),
  }
}

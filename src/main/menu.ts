import { Menu, app, type MenuItemConstructorOptions } from 'electron'
import { translate, type MessageKey } from '../shared/i18n'
import { currentLanguage } from './settings'
import { toDisplayAccelerator } from './shortcut'
import { openSettingsWindow } from './windows/settings-window'

export interface MenuHandlers {
  showMainWindow: () => void
  toggleQuickWindow: () => void
  /** 已注册的呼出快捷键（Electron 格式） */
  quickHotkey: string
  /** 只在开发模式（DS_INSPECT=1）下提供 */
  dev?: {
    exportDom: () => void
  }
}

/**
 * macOS 应用菜单。
 *
 * 两点要留意：
 *
 * 1. 「编辑」菜单不是装饰 —— 没有它，⌘C / ⌘V 在 DeepSeek 网页里会失效，
 *    用户连问题都粘贴不进去。role 会自动代理到当前聚焦的 webContents。
 *
 * 2. 呼出快捷键只在**标签文字**里展示，不设 accelerator 字段。
 *    设了它，菜单会在应用获得焦点时截走按键，和 globalShortcut 打架。
 */
export function buildAppMenu(handlers: MenuHandlers): void {
  const lang = currentLanguage()
  const t = (key: MessageKey, vars?: Record<string, string | number>): string =>
    translate(lang, key, vars)
  const appName = app.name

  const template: MenuItemConstructorOptions[] = [
    {
      label: appName,
      submenu: [
        { role: 'about', label: t('menu.about', { app: appName }) },
        { type: 'separator' },
        { label: t('menu.settings'), accelerator: 'Command+,', click: () => openSettingsWindow() },
        { type: 'separator' },
        { role: 'services', label: t('menu.services') },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hide', { app: appName }) },
        { role: 'hideOthers', label: t('menu.hideOthers') },
        { role: 'unhide', label: t('menu.unhide') },
        { type: 'separator' },
        { role: 'quit', label: t('menu.quit', { app: appName }) },
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') },
      ],
    },
    {
      label: t('menu.window'),
      submenu: [
        { label: t('menu.showMain'), click: handlers.showMainWindow },
        {
          label: `${t('menu.toggleQuick')}（${toDisplayAccelerator(handlers.quickHotkey)}）`,
          click: handlers.toggleQuickWindow,
        },
        { type: 'separator' },
        { role: 'minimize', label: t('menu.minimize') },
        { role: 'zoom', label: t('menu.zoom') },
        { type: 'separator' },
        { role: 'front', label: t('menu.front') },
      ],
    },
    ...(handlers.dev
      ? [
          {
            label: 'Developer',
            submenu: [
              {
                label: 'Export DOM report',
                accelerator: 'Command+Shift+D',
                click: handlers.dev.exportDom,
              },
            ],
          },
        ]
      : []),
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

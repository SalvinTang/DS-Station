import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { allMessages, resolveLanguage, type Language, type ResolvedLanguage } from '../shared/i18n'
import type { ThemeSetting } from '../shared/types'

/**
 * 本地配置。产品说明书 §10：只保存应用自身的配置，
 * 绝不保存任何 DeepSeek 的用户数据（登录态由 Electron Session 负责）。
 */

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
}

export interface QuickWindowSettings {
  /** Electron accelerator，例如 'Alt+Space' */
  hotkey: string
  /** 快捷窗口激活且处于有内容态时，新对话的本地快捷键 */
  newChatShortcut: string
  /** 快捷窗口激活时，打开/关闭历史对话的本地快捷键 */
  historyShortcut: string
  /**
   * 设计稿「重置为新聊天」：距上次关闭超过该分钟数，就以空白会话开场。
   * 0 表示「从不」—— 永远保留上一次的对话内容。
   */
  resetAfterMinutes: number
  /**
   * 上次隐藏时窗口的左边和底边（屏幕坐标）。
   * 空态会向上长高，用底边做锚点最稳；null 表示还没定位过，用屏幕正中。
   */
  x: number | null
  bottom: number | null
  /** 有内容态的尺寸，跨重启保留 */
  contentWidth: number
  contentHeight: number
}

export interface Settings {
  window: WindowState
  quickWindow: QuickWindowSettings
  language: Language
  /** 应用主题：跟随系统 / 浅色 / 深色 */
  theme: ThemeSetting
  /**
   * 上一次确认过的登录状态。
   *
   * 只是启动时的提示，不是凭证 —— 真正的登录态由 Electron Session 管。
   * 用途：已知登录时先把快捷窗口亮出来，再在后台复核，避免每次启动
   * 都盯着空屏幕等页面加载完。
   */
  login: {
    knownLoggedIn: boolean
  }
}
// 注：构建号不属于用户配置 —— 它随产物走，存在 build-number.json 里，
// 构建时由 define 注入。老版本 settings.json 里的 build 字段会被忽略。

const DEFAULTS: Settings = {
  window: { width: 1280, height: 860 },
  quickWindow: {
    hotkey: 'Alt+Space',
    newChatShortcut: 'Command+N',
    historyShortcut: 'Command+Y',
    resetAfterMinutes: 10,
    x: null,
    bottom: null,
    contentWidth: 420,
    contentHeight: 500,
  },
  language: 'system',
  theme: 'system',
  login: { knownLoggedIn: false },
}

/**
 * 深层的「可选」类型。
 * `Partial<Settings>` 只放宽第一层，`{ quickWindow: { hotkey } }` 这种
 * 只改一个字段的调用会被拒。而 merge() 本来就是深合并的，类型应当跟上。
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

let cache: Settings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** 深合并；patch 里为 undefined 的键保持原值 */
function merge<T extends object>(base: T, patch: DeepPartial<T>): T {
  return mergeInto(base as Record<string, unknown>, patch as Record<string, unknown>) as T
}

function mergeInto(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base }

  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue

    const current = out[key]
    const bothPlainObjects =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)

    out[key] = bothPlainObjects
      ? mergeInto(current as Record<string, unknown>, value as Record<string, unknown>)
      : value
  }

  return out
}

export function load(): Settings {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>
    cache = merge(DEFAULTS, raw)
  } catch {
    // 文件不存在或损坏 → 用默认值，不报错
    cache = merge(DEFAULTS, {})
  }

  /*
   * 旧版本的默认历史快捷键是 ⌘H，会和 macOS 的隐藏应用冲突，
   * 导致快速开合时整个面板闪动。这里自动迁移到新的默认值 ⌘Y。
   */
  if (cache.quickWindow.historyShortcut === 'Command+H') {
    cache.quickWindow.historyShortcut = 'Command+Y'
    try {
      const file = settingsPath()
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
    } catch {
      // 写不进去也继续用内存里的 ⌘Y
    }
  }

  return cache
}

/** 把「与系统一致」落实成具体语言 */
export function currentLanguage(): ResolvedLanguage {
  return resolveLanguage(load().language, app.getLocale())
}

/** 打包给渲染层的文案表 */
export function messages(): Record<string, string> {
  return allMessages(currentLanguage())
}

export function save(patch: DeepPartial<Settings>): void {
  const next = merge(load(), patch)
  cache = next
  try {
    const file = settingsPath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch (err) {
    console.error('[settings] 写入失败:', err)
  }
}

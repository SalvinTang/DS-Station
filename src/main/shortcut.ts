import { globalShortcut, type Input } from 'electron'
import { DEFAULT_QUICK_HOTKEY } from '../shared/constants'

/**
 * 全局快捷键。
 *
 * 关键约束（产品说明书 §14）：快捷键被别的程序占用时注册会失败，
 * 但**绝不能因此让应用启动失败** —— 只提示，不抛异常。
 */

export interface HotkeyResult {
  accelerator: string
  ok: boolean
}

export function registerQuickHotkey(accelerator: string, handler: () => void): HotkeyResult {
  const acc = accelerator.trim() || DEFAULT_QUICK_HOTKEY

  try {
    const ok = globalShortcut.register(acc, handler)
    if (ok) {
      console.log(`[快捷键] 已注册「${acc}」呼出快捷窗口`)
    } else {
      console.warn(
        `[快捷键] 「${acc}」注册失败 —— 多半被 Spotlight、Raycast、Alfred 之类占用了。` +
          `应用照常运行，可在设置里换一个组合。`,
      )
    }
    return { accelerator: acc, ok }
  } catch (err) {
    console.warn(`[快捷键] 「${acc}」注册异常:`, err)
    return { accelerator: acc, ok: false }
  }
}

export function unregisterAllHotkeys(): void {
  globalShortcut.unregisterAll()
}

/** accelerator 的规范化签名，用来判断两个组合是否等价 */
export function acceleratorSignature(accelerator: string): string {
  const tokens = accelerator
    .split('+')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
  const key = (tokens.pop() ?? '').replace(/^return$/, 'enter')

  const modifiers = new Set<string>()
  for (const token of tokens) {
    if (['command', 'cmd', 'commandorcontrol', 'cmdorctrl', 'super'].includes(token)) {
      modifiers.add(process.platform === 'darwin' ? 'command' : 'control')
    } else if (token === 'control' || token === 'ctrl') {
      modifiers.add('control')
    } else if (token === 'alt' || token === 'option') {
      modifiers.add('alt')
    } else if (token === 'shift') {
      modifiers.add('shift')
    }
  }

  return `${[...modifiers].sort().join('+')}+${key}`
}

/** 判断一次键盘输入是否命中 accelerator（只用于快捷窗口内的本地快捷键） */
export function matchesAccelerator(input: Input, accelerator: string): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return false

  const tokens = accelerator
    .split('+')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
  const key = tokens.pop() ?? ''
  if (!key) return false

  const has = (...names: string[]): boolean => names.some((name) => tokens.includes(name))
  const wantsCommand = has('command', 'cmd', 'commandorcontrol', 'cmdorctrl', 'super')
  const wantsControl =
    has('control', 'ctrl') ||
    (process.platform !== 'darwin' && has('commandorcontrol', 'cmdorctrl'))

  if (!!input.meta !== wantsCommand) return false
  if (!!input.control !== wantsControl) return false
  if (!!input.alt !== has('alt', 'option')) return false
  if (!!input.shift !== has('shift')) return false

  return matchesKey(input, key)
}

function matchesKey(input: Input, key: string): boolean {
  const normalized = key.toLowerCase()
  const code = input.code || ''

  if (/^[a-z]$/.test(normalized) && code === `Key${normalized.toUpperCase()}`) return true
  if (/^[0-9]$/.test(normalized) && code === `Digit${normalized}`) return true
  if (/^f\d{1,2}$/.test(normalized) && code.toLowerCase() === normalized) return true

  const codeAliases: Record<string, string> = {
    return: 'Enter',
    enter: 'Enter',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    space: 'Space',
    tab: 'Tab',
    escape: 'Escape',
    esc: 'Escape',
    backspace: 'Backspace',
    delete: 'Delete',
    '-': 'Minus',
    '=': 'Equal',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    ';': 'Semicolon',
    "'": 'Quote',
    '`': 'Backquote',
    '\\': 'Backslash',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
  }

  const expectedCode = codeAliases[normalized]
  if (expectedCode && code === expectedCode) return true

  return (input.key || '').toLowerCase() === normalized
}

/**
 * 把 Electron accelerator 转成 macOS 键盘符号。
 *
 * 只用于**显示**。注意不要把结果设成菜单项的 accelerator ——
 * 那会在应用获得焦点时截走按键，和 globalShortcut 打架。
 */
export function toDisplayAccelerator(accelerator: string): string {
  return accelerator
    .replace(/CommandOrControl|CmdOrCtrl|Command|Cmd/gi, '⌘')
    .replace(/Control|Ctrl/gi, '⌃')
    .replace(/Alt|Option/gi, '⌥')
    .replace(/Shift/gi, '⇧')
    .replace(/Return|Enter/gi, '↩')
    .replace(/\+/g, ' ')
    .trim()
}

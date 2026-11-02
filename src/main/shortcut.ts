import { globalShortcut } from 'electron'
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

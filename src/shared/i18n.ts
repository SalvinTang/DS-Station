/**
 * 文案表。
 *
 * 设计稿要求「程序语言」默认跟随系统，只考虑中文和英文。
 * 这里只管**本应用自己的界面文案** —— DeepSeek 网页里的内容由它自己负责。
 */

export type Language = 'system' | 'zh' | 'en'
export type ResolvedLanguage = 'zh' | 'en'

const zh = {
  // ── 设置窗口 ──
  'settings.title': '设置',
  'settings.hotkey': '快捷窗口呼出快捷键',
  'settings.hotkeyHint': '点击右侧按钮，然后按下新的组合键',
  'settings.hotkeyRecording': '请按下新的组合键…',
  'settings.hotkeyNeedModifier': '至少要带一个修饰键（⌘ ⌃ ⌥ ⇧）',
  'settings.hotkeyTaken': '这个组合已被其他程序占用，换一个试试',
  'settings.hotkeyOk': '已更新',
  'settings.resetAfter': '重置为新聊天',
  'settings.resetHint': '呼出快捷窗口时，若距上次关闭已超过这个时间，就以空白对话开始',
  'settings.language': '程序语言',
  'settings.version': '版本号',
  'settings.logout': '退出登录',
  'settings.logoutConfirm': '是否要退出登录？',
  'settings.logoutDetail': '退出后需要重新登录 DeepSeek 账号。聊天记录存在 DeepSeek 那边，不会丢。',
  'settings.cancel': '取消',

  // ── 时间选项 ──
  'time.never': '从不',
  'time.minutes': '{n} 分钟',
  'time.hours': '{n} 小时',

  // ── 语言选项 ──
  'language.system': '与系统一致',
  'language.zh': '中文',
  'language.en': 'English',

  // ── 应用菜单 ──
  'menu.about': '关于 {app}',
  'menu.settings': '设置…',
  'menu.services': '服务',
  'menu.hide': '隐藏 {app}',
  'menu.hideOthers': '隐藏其他',
  'menu.unhide': '全部显示',
  'menu.quit': '退出 {app}',
  'menu.edit': '编辑',
  'menu.undo': '撤销',
  'menu.redo': '重做',
  'menu.cut': '剪切',
  'menu.copy': '拷贝',
  'menu.paste': '粘贴',
  'menu.selectAll': '全选',
  'menu.window': '窗口',
  'menu.showMain': '显示主窗口',
  'menu.toggleQuick': '呼出快捷窗口',
  'menu.minimize': '最小化',
  'menu.zoom': '缩放',
  'menu.front': '前置全部窗口',

  // ── 快捷窗口 ──
  'quick.placeholder': '给Deepseek发送消息',
  'quick.deepThink': '深度思考',
  'quick.smartSearch': '智能搜索',
  'quick.deepThinkShort': '深度',
  'quick.smartSearchShort': '搜索',
  'quick.scrollBottom': '滚动到底部',
  'quick.send': '发送',
  'quick.copy': '复制',
  'quick.close': '关闭',
  'quick.newChat': '新对话',
  'quick.expand': '在主窗口打开',
  'quick.error': '出错了',
  'quick.stop': '停止生成',
  'quick.continue': '继续生成',
} as const

export type MessageKey = keyof typeof zh

const en: Record<MessageKey, string> = {
  'settings.title': 'Settings',
  'settings.hotkey': 'Quick window shortcut',
  'settings.hotkeyHint': 'Click the button, then press a new key combination',
  'settings.hotkeyRecording': 'Press a new combination…',
  'settings.hotkeyNeedModifier': 'Include at least one modifier (⌘ ⌃ ⌥ ⇧)',
  'settings.hotkeyTaken': 'That combination is taken by another app — try another',
  'settings.hotkeyOk': 'Updated',
  'settings.resetAfter': 'Reset to new chat',
  'settings.resetHint':
    'When the quick window is summoned, start a blank conversation if this much time has passed since it was last closed',
  'settings.language': 'Language',
  'settings.version': 'Version',
  'settings.logout': 'Sign out',
  'settings.logoutConfirm': 'Sign out?',
  'settings.logoutDetail':
    'You will need to sign in to DeepSeek again. Your chat history lives on DeepSeek and is not affected.',
  'settings.cancel': 'Cancel',

  'time.never': 'Never',
  'time.minutes': '{n} min',
  'time.hours': '{n} h',

  'language.system': 'Match system',
  'language.zh': '中文',
  'language.en': 'English',

  'menu.about': 'About {app}',
  'menu.settings': 'Settings…',
  'menu.services': 'Services',
  'menu.hide': 'Hide {app}',
  'menu.hideOthers': 'Hide Others',
  'menu.unhide': 'Show All',
  'menu.quit': 'Quit {app}',
  'menu.edit': 'Edit',
  'menu.undo': 'Undo',
  'menu.redo': 'Redo',
  'menu.cut': 'Cut',
  'menu.copy': 'Copy',
  'menu.paste': 'Paste',
  'menu.selectAll': 'Select All',
  'menu.window': 'Window',
  'menu.showMain': 'Show Main Window',
  'menu.toggleQuick': 'Open Quick Window',
  'menu.minimize': 'Minimize',
  'menu.zoom': 'Zoom',
  'menu.front': 'Bring All to Front',

  'quick.placeholder': 'Send a message to DeepSeek',
  'quick.deepThink': 'Deep thinking',
  'quick.smartSearch': 'Smart search',
  'quick.deepThinkShort': 'Deep',
  'quick.smartSearchShort': 'Search',
  'quick.scrollBottom': 'Scroll to bottom',
  'quick.send': 'Send',
  'quick.copy': 'Copy',
  'quick.close': 'Close',
  'quick.newChat': 'New chat',
  'quick.expand': 'Open in main window',
  'quick.error': 'Something went wrong',
  'quick.stop': 'Stop generating',
  'quick.continue': 'Continue generating',
}

const DICTIONARIES: Record<ResolvedLanguage, Record<MessageKey, string>> = { zh, en }

/** 把「与系统一致」解析成具体语言 */
export function resolveLanguage(setting: Language, systemLocale: string): ResolvedLanguage {
  if (setting === 'zh' || setting === 'en') return setting
  return systemLocale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** 取文案，支持 {name} 占位 */
export function translate(
  lang: ResolvedLanguage,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  let text = DICTIONARIES[lang][key] ?? zh[key] ?? key
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

/** 把所有文案打包给渲染层用 */
export function allMessages(lang: ResolvedLanguage): Record<string, string> {
  return { ...DICTIONARIES[lang] }
}

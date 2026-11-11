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
  'settings.groupShortcuts': '快捷窗口',
  'settings.groupAppearance': '外观与语言',
  'settings.groupAccount': '账号',
  'settings.hotkey': '呼出快捷窗口',
  'settings.hotkeyHint': '在其他应用里也可以呼出',
  'settings.hotkeyRecording': '请按下新的组合键…',
  'settings.hotkeyNeedModifier': '至少要带一个修饰键（⌘ ⌃ ⌥ ⇧）',
  'settings.hotkeyTaken': '这个组合已被其他程序占用，换一个试试',
  'settings.hotkeyOk': '已更新',
  'settings.newChatShortcut': '新对话',
  'settings.newChatShortcutHint': '仅在展开状态、且快捷窗口激活时生效',
  'settings.historyShortcut': '历史对话',
  'settings.historyShortcutHint': '打开后用 ↑ ↓ 选择，回车确认',
  'settings.shortcutRecording': '按下快捷键…',
  'settings.shortcutTaken': '这个快捷键已经被占用了，换一个',
  'settings.resetAfter': '重置为新聊天',
  'settings.resetHint': '距上次关闭超过这个时间后，自动以空白对话开始',
  'settings.language': '程序语言',
  'settings.theme': '主题',
  'theme.system': '与系统一致',
  'theme.light': '浅色',
  'theme.dark': '深色',
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
  'quick.history': '历史',
  'quick.noHistory': '无历史对话',
  'quick.scrollBottom': '滚动到底部',
  'quick.send': '发送',
  'quick.copy': '复制',
  'quick.copyCode': '复制代码',
  'quick.searchCount': '搜索到 {n} 个网页',
  'quick.webCount': '{n} 个网页',
  'quick.searchResults': '搜索结果',
  'quick.searchLoading': '加载中',
  'quick.searchLoadFailed': '加载失败',
  'quick.searchRetry': '重试',
  'quick.searchCollapse': '收起',
  'quick.thinkThinking': '正在思考',
  'quick.thinkDone': '已思考（用时 {n} 秒）',
  'quick.thinkDoneOne': '已思考（用时 1 秒）',
  'quick.thinkDoneShort': '已思考',
  'quick.thinkStopped': '已停止',
  'quick.thinkOpenPages': '浏览 {n} 个页面',
  'quick.thinkOpenPageOne': '浏览 1 个页面',
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
  'settings.groupShortcuts': 'Quick window',
  'settings.groupAppearance': 'Appearance & language',
  'settings.groupAccount': 'Account',
  'settings.hotkey': 'Summon quick window',
  'settings.hotkeyHint': 'Works from any app',
  'settings.hotkeyRecording': 'Press a new combination…',
  'settings.hotkeyNeedModifier': 'Include at least one modifier (⌘ ⌃ ⌥ ⇧)',
  'settings.hotkeyTaken': 'That combination is taken by another app — try another',
  'settings.hotkeyOk': 'Updated',
  'settings.newChatShortcut': 'New chat',
  'settings.newChatShortcutHint': 'Only while the quick window is open and focused',
  'settings.historyShortcut': 'History',
  'settings.historyShortcutHint': 'Use ↑ ↓ to choose, Enter to confirm',
  'settings.shortcutRecording': 'Press shortcut…',
  'settings.shortcutTaken': 'That shortcut is already in use — try another',
  'settings.resetAfter': 'Reset to new chat',
  'settings.resetHint':
    'Start a blank conversation automatically if this much time has passed since the quick window was last closed',
  'settings.language': 'Language',
  'settings.theme': 'Theme',
  'theme.system': 'Match system',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
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
  'quick.history': 'History',
  'quick.noHistory': 'No history yet',
  'quick.scrollBottom': 'Scroll to bottom',
  'quick.send': 'Send',
  'quick.copy': 'Copy',
  'quick.copyCode': 'Copy code',
  'quick.searchCount': 'Found {n} web pages',
  'quick.webCount': '{n} pages',
  'quick.searchResults': 'Search results',
  'quick.searchLoading': 'Loading',
  'quick.searchLoadFailed': 'Failed to load',
  'quick.searchRetry': 'Retry',
  'quick.searchCollapse': 'Collapse',
  'quick.thinkThinking': 'Thinking',
  'quick.thinkDone': 'Thought for {n} seconds',
  'quick.thinkDoneOne': 'Thought for 1 second',
  'quick.thinkDoneShort': 'Thought',
  'quick.thinkStopped': 'Stopped',
  'quick.thinkOpenPages': 'Read {n} pages',
  'quick.thinkOpenPageOne': 'Read 1 page',
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

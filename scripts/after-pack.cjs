/**
 * electron-builder 的 afterPack 钩子：精简 Chromium 内置语言包。
 *
 * Electron 默认带上 220 个 <语言>.lproj/locale.pak，占安装体积约 56MB。
 * 本应用的界面只有中文/英文两种（见 src/shared/i18n.ts），
 * Chromium 自己的右键菜单、错误页等也只可能用到这两种；
 * 其他语言删掉后，系统语言是别的语种时会回退到英文。
 *
 * 注意：只删框架里的 .lproj，不动主 bundle 的 InfoPlist.strings。
 * 钩子在签名之前执行，删完再签名，不会破坏签名。
 */
const { readdirSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')

const KEEP = /^(en|en_GB|zh_CN|zh_TW)(_(FEMININE|MASCULINE|NEUTER))?\.lproj$/

function dirSize(path) {
  let total = 0
  const stack = [path]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) stack.push(child)
      else {
        try {
          total += statSync(child).size
        } catch {
          // 忽略读不到的项
        }
      }
    }
  }
  return total
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const resources = join(
    context.appOutDir,
    appName,
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources',
  )

  let removed = 0
  let freed = 0

  for (const name of readdirSync(resources)) {
    if (!name.endsWith('.lproj') || KEEP.test(name)) continue
    const path = join(resources, name)
    freed += dirSize(path)
    rmSync(path, { recursive: true, force: true })
    removed += 1
  }

  console.log(
    `[after-pack] 语言包精简：删除 ${removed} 个，释放 ${(freed / 1024 / 1024).toFixed(1)} MB`,
  )
}

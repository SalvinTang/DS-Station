#!/usr/bin/env node
/**
 * 打包入口。
 *
 *   npm run pack               → 只生成 .app（快，用来验证打包链路）
 *   npm run dist               → 生成 .dmg
 *   npm run dist -- --no-bump  → 不消耗构建号（调试打包配置时用）
 *
 * 顺序有意义：先自增构建号，再编译，最后打包 —— 保证产物里的构建号
 * 就是 build-number.json 里的值，且一次打包只 +1。
 *
 * 打包失败会把构建号回滚，并且会检查产物是否真的落盘 ——
 * electron-builder 在下载依赖超时时会打印错误却仍然以 0 退出。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))

const target = args.has('--dir') ? 'dir' : 'dmg'
const skipBump = args.has('--no-bump')

/**
 * electron-builder 的 dmg 工具链要从 GitHub Releases 下载，
 * 国内经常超时。默认走 npmmirror（文件校验和一致），可用环境变量覆盖。
 */
const binariesMirror =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'

function run(command, argv, env = {}) {
  const result = spawnSync(command, argv, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_BUILDER_BINARIES_MIRROR: binariesMirror, ...env },
  })
  if (result.error) throw new Error(`启动 ${command} 失败：${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} 退出码 ${result.status}`)
}

function readBuildNumber() {
  const raw = JSON.parse(readFileSync(join(ROOT, 'build-number.json'), 'utf8'))
  const value = Number(raw.build)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`build-number.json 里的 build 不是非负整数：${JSON.stringify(raw.build)}`)
  }
  return value
}

function writeBuildNumber(value) {
  writeFileSync(join(ROOT, 'build-number.json'), `${JSON.stringify({ build: value }, null, 2)}\n`, 'utf8')
}

/** 产物是否真的生成了（mtime 必须晚于本次开始时间） */
function findArtifact(build, since) {
  const releaseDir = join(ROOT, 'release')
  let names
  try {
    names = readdirSync(releaseDir)
  } catch {
    return null
  }

  const wanted =
    target === 'dir'
      ? names.filter((name) => name === 'mac-arm64').map((name) => join(releaseDir, name, 'DS Desktop.app'))
      : names
          .filter((name) => name.startsWith('DS-Desktop-') && name.endsWith(`-${build}-arm64.dmg`))
          .map((name) => join(releaseDir, name))

  for (const path of wanted) {
    try {
      if (statSync(path).mtimeMs >= since) return path
    } catch {
      // 不存在就继续找
    }
  }
  return null
}

const previous = readBuildNumber()
const next = skipBump ? previous : previous + 1
const build = String(next).padStart(3, '0')

console.log(`[dist] 版本 1.0.0.${build}，目标 ${target}`)

if (!skipBump) writeBuildNumber(next)

const startedAt = Date.now()

try {
  run(process.execPath, ['node_modules/electron-vite/bin/electron-vite.js', 'build'])
  /*
   * --publish never：仓库配置了 GitHub remote 后，electron-builder 会因为
   * CI 检测默认尝试上传 release，没有 GH_TOKEN 就直接失败。
   * 我们的发包是手动上传，打包脚本只负责出本地文件。
   */
  run(
    process.execPath,
    ['node_modules/electron-builder/cli.js', '--mac', target, '--arm64', '--publish', 'never'],
    { BUILD_NUMBER: build },
  )
} catch (err) {
  if (!skipBump) writeBuildNumber(previous)
  console.error(`\n[dist] ❌ 打包失败，构建号已回滚到 ${String(previous).padStart(3, '0')}`)
  console.error(`[dist] ${err.message}`)
  process.exit(1)
}

const artifact = findArtifact(build, startedAt)
if (!artifact) {
  if (!skipBump) writeBuildNumber(previous)
  console.error(`\n[dist] ❌ 没有找到 ${target} 产物，构建号已回滚到 ${String(previous).padStart(3, '0')}`)
  process.exit(1)
}

console.log(`[dist] ✅ ${artifact}`)

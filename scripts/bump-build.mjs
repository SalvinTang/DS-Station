#!/usr/bin/env node
/**
 * 构建号自增。
 *
 * 版本号分四段：1.2.3.002
 *   - 前三段来自 package.json 的 version，只有用户明确要求时才改
 *   - 第四段是构建号，每次打包自动 +1（本脚本负责）
 *
 * 构建号存在 build-number.json 里并随仓库提交 —— 它必须跨机器连续，
 * 不能像设置项那样放进 userData（那样每个用户看到自己的号）。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(ROOT, 'build-number.json')

function readCurrent() {
  let raw
  try {
    raw = JSON.parse(readFileSync(FILE, 'utf8'))
  } catch (err) {
    console.error(`[build] 读不到 ${FILE}：${err.message}`)
    process.exit(1)
  }

  const value = Number(raw.build)
  if (!Number.isInteger(value) || value < 0) {
    console.error(`[build] ${FILE} 里的 build 不是非负整数：${JSON.stringify(raw.build)}`)
    process.exit(1)
  }
  return value
}

const next = readCurrent() + 1

try {
  writeFileSync(FILE, `${JSON.stringify({ build: next }, null, 2)}\n`, 'utf8')
} catch (err) {
  console.error(`[build] 写不回 ${FILE}：${err.message}`)
  process.exit(1)
}

// 超过 999 不特殊处理，padStart 会自然变成四位
console.log(`[build] 构建号 +1 → ${String(next).padStart(3, '0')}`)

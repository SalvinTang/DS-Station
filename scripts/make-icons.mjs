/**
 * 由 Design/素材 里的原始设计稿生成运行时需要的图标：
 *
 *   build/icon.png / icon.icns       应用图标（Dock、访达、安装包）
 *   resources/trayTemplate.png       菜单栏图标（1x）
 *   resources/trayTemplate@2x.png
 *
 * 用法（Design/ 是本地素材，不进仓库）：
 *
 *   npm run icons
 *
 * 为什么菜单栏只生成黑色图标：
 *   macOS 的模板图（template image）只读取 alpha 通道，系统会按菜单栏当前
 *   的外观自动渲染成黑色或白色。所以那张白色稿在运行时用不上，也不需要
 *   监听外观变化 —— 系统自己会切。
 */
import { app, BrowserWindow, nativeImage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'Design/素材')
const LOGO = join(SRC, 'DS Station logo.png')
const TRAY_BLACK = join(SRC, 'DS Station lMenu bar icon-black.png')

const BUILD_DIR = join(ROOT, 'build')
const ASSET_DIR = join(ROOT, 'resources')

const CANVAS = 1024
const TILE = 824 // macOS 图标规范：1024 画布里居中放 824 的圆角方块
const TILE_RADIUS = 185
const WHALE_WIDTH = 600
/**
 * 素材是 512×512 的透明画布，鲸鱼图形只占中间一块。
 * 必须按这个边界裁出来再缩放 —— 直接缩放整张画布会把图形压扁。
 * 数值是逐像素扫描 alpha 通道得到的。
 */
const LOGO_CROP = { x: 15, y: 90, width: 483, height: 332 }
const TRAY_WIDTH = 20 // 菜单栏图标 20×14 pt

/** 素材里的像素边界（透明边距不算） */
const TRAY_CROP = { x: 14, y: 89, width: 484, height: 334 }

if (!existsSync(LOGO) || !existsSync(TRAY_BLACK)) {
  console.error(`找不到设计素材：${SRC}`)
  console.error('Design/ 目录不进仓库，请先把素材放回原位再运行。')
  process.exit(1)
}

const dataUrl = (path) => `data:image/png;base64,${readFileSync(path).toString('base64')}`

/** 用一个离屏窗口把 canvas 画出来 */
async function renderPage(html, width, height) {
  const page = join(app.getPath('temp'), `ds-icon-${Date.now()}.html`)
  writeFileSync(page, html)

  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, backgroundThrottling: false },
  })
  try {
    await win.loadFile(page)
    // 等图片解码 + drawImage 完成
    await new Promise((r) => setTimeout(r, 600))
    return await win.webContents.capturePage()
  } finally {
    win.destroy()
  }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  mkdirSync(BUILD_DIR, { recursive: true })
  mkdirSync(ASSET_DIR, { recursive: true })

  // ── 应用图标 ────────────────────────────────────────────────
  // 高度按原图比例算，不取整 —— 取整会带来轻微拉伸
  const whaleHeight = (WHALE_WIDTH * LOGO_CROP.height) / LOGO_CROP.width
  const iconHtml = `<!doctype html>
<body style="margin:0;background:transparent">
  <canvas id="c" width="${CANVAS}" height="${CANVAS}" style="display:block"></canvas>
  <script>
    const img = new Image()
    img.onload = () => {
      const ctx = document.getElementById('c').getContext('2d')
      const x = (${CANVAS} - ${TILE}) / 2
      const y = (${CANVAS} - ${TILE}) / 2

      // 投影（macOS 图标自带的落地感）
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.22)'
      ctx.shadowBlur = 24
      ctx.shadowOffsetY = 10
      ctx.beginPath()
      ctx.roundRect(x, y, ${TILE}, ${TILE}, ${TILE_RADIUS})
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.restore()

      // 白色底 + 极淡的竖向渐变，避免大面积死白
      const grad = ctx.createLinearGradient(0, y, 0, y + ${TILE})
      grad.addColorStop(0, '#ffffff')
      grad.addColorStop(1, '#f0f2f7')
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(x, y, ${TILE}, ${TILE}, ${TILE_RADIUS})
      ctx.clip()
      ctx.fillStyle = grad
      ctx.fillRect(x, y, ${TILE}, ${TILE})
      // 9 参数版本：只从原图里取鲸鱼实际占的那块（不含透明边距），
      // 再等比放到目标尺寸，保证和原图完全同比例。
      ctx.drawImage(
        img,
        ${LOGO_CROP.x},
        ${LOGO_CROP.y},
        ${LOGO_CROP.width},
        ${LOGO_CROP.height},
        (${CANVAS} - ${WHALE_WIDTH}) / 2,
        (${CANVAS} - ${whaleHeight}) / 2,
        ${WHALE_WIDTH},
        ${whaleHeight},
      )
      ctx.restore()
      window.__ready = true
    }
    img.src = '${dataUrl(LOGO)}'
  </script>
</body>`

  const icon = await renderPage(iconHtml, CANVAS, CANVAS)
  const iconPng = icon.toPNG()
  writeFileSync(join(BUILD_DIR, 'icon.png'), iconPng)

  // iconutil 需要 .iconset 里 10 张固定尺寸的图
  const iconset = join(BUILD_DIR, 'icon.iconset')
  mkdirSync(iconset, { recursive: true })
  const variants = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ]
  const source = icon.resize({ width: CANVAS, height: CANVAS, quality: 'best' })
  for (const [size, name] of variants) {
    const scaled = size === CANVAS ? source : source.resize({ width: size, height: size, quality: 'best' })
    writeFileSync(join(iconset, name), scaled.toPNG())
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(BUILD_DIR, 'icon.icns')])
  console.log('✓ build/icon.png + build/icon.icns')

  // ── 菜单栏图标 ──────────────────────────────────────────────
  // 只取 alpha，系统会按菜单栏外观自动染成黑或白（模板图）。
  const trayBase = nativeImage.createFromPath(TRAY_BLACK).crop(TRAY_CROP)
  for (const [scale, suffix] of [
    [1, ''],
    [2, '@2x'],
  ]) {
    const width = TRAY_WIDTH * scale
    const height = Math.round((width * TRAY_CROP.height) / TRAY_CROP.width)
    const img = trayBase.resize({ width, height, quality: 'best' })
    writeFileSync(join(ASSET_DIR, `trayTemplate${suffix}.png`), img.toPNG())
  }
  console.log('✓ resources/trayTemplate.png (+@2x)')

  app.quit()
})

setTimeout(() => {
  console.error('生成图标超时')
  app.exit(1)
}, 60_000)

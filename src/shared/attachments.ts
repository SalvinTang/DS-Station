/**
 * 附件类型判断。
 *
 * 预览能力必须和 DeepSeek 网页保持一致，不能按「文件能不能上传」来判断。
 * 网页端的 getPreviewType 规则是：
 *   - 图片 → image
 *   - pdf → pdf
 *   - doc/docx/xls/xlsx/ppt/pptx、epub/mobi/azw3/h5/hdf → 不可预览
 *   - 其它（代码、文本、csv 等）→ text
 * 这里只做同一套分类，保证已发送消息里的预览入口和网页一致。
 */

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'file'

/** 与网页端 dH 保持一致；部分格式网页可能转码后预览 */
const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'heic', 'heif', 'svg', 'svgz', 'bmp', 'gif', 'webp',
  'ico', 'xbm', 'dib', 'pjp', 'tif', 'pjpeg', 'avif', 'apng', 'tiff', 'jfif',
  'jpe', 'jp2', 'jpc', 'jpf', 'jpx', 'mpeg', 'mpg', 'pbm', 'pcx', 'pfm',
  'pgm', 'ppm', 'psd', 'pxr', 'qoi', 'ras', 'rgb', 'rgba', 'sgi', 'tga',
  'vda', 'vst', 'wmf', 'xpm',
])

/** 网页端 dO：Office 文档不提供预览 */
const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'])

/** 网页端 dP：电子书不提供预览 */
const EBOOK_EXTS = new Set(['epub', 'mobi', 'azw3', 'h5', 'hdf'])

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() || ''
  const index = base.lastIndexOf('.')
  if (index <= 0 || index === base.length - 1) return ''
  return base.slice(index + 1).toLowerCase()
}

export function classifyAttachment(name: string): AttachmentKind {
  const ext = extensionOf(name)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (OFFICE_EXTS.has(ext) || EBOOK_EXTS.has(ext)) return 'file'
  return 'text'
}

export function isPreviewableAttachment(name: string): boolean {
  return classifyAttachment(name) !== 'file'
}

/** 文件大小显示：跟网页端一样用 KB/MB，保留两位小数 */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`
}

/** 原生文件选择器的扩展名列表（accept 里的 `.x` → `x`） */
export function acceptExtensions(accept: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of accept.split(',')) {
    let item = raw.trim().toLowerCase()
    if (!item || item === '*/*') continue
    if (item.startsWith('.')) item = item.slice(1)
    if (!item || item.includes('/') || item.includes('*')) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

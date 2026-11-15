import { BrowserWindow, dialog, nativeImage } from 'electron'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { createReadStream, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import type {
  AttachmentInfo,
  AttachmentPickResult,
  AttachmentPreview,
  HistoryMessage,
} from '../shared/types'
import {
  acceptExtensions,
  classifyAttachment,
  extensionOf,
} from '../shared/attachments'
import { getDeepseekSession } from './session'

export const MAX_ATTACHMENTS = 20
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024

export interface PendingAttachment extends AttachmentInfo {
  path: string
  mime: string
  prepared: boolean
  prepareError?: string
  removed?: boolean
  sent?: boolean
}

interface AttachmentSource {
  id: string
  name: string
  kind: AttachmentInfo['kind']
  path?: string
  url?: string
}

const pending = new Map<string, PendingAttachment>()
const historySources = new Map<string, AttachmentSource>()

/** 已成功注入网页输入区的附件，按注入顺序排列（失败的文件没有卡片） */
const injectedOrder: string[] = []
/** 已发送的附件顺序，用于给主进程里的预览记录做上限 */
const sentOrder: string[] = []
const MAX_SENT_PENDING = 300

const execFileAsync = promisify(execFile)
const SIPS = '/usr/bin/sips'
const TEMP_DIR = join(tmpdir(), 'ds-station-attachments')
const MAX_THUMB_BYTES = 48 * 1024
const MAX_THUMB_HARD_BYTES = 96 * 1024
const FALLBACK_DECODE_MAX_BYTES = 8 * 1024 * 1024
const PREVIEW_MAX_EDGE = 1600
let tempDirReady: Promise<void> | null = null
let previewTempPath: string | null = null

async function ensureTempDir(): Promise<void> {
  if (!tempDirReady) {
    tempDirReady = fs.mkdir(TEMP_DIR, { recursive: true, mode: 0o700 }).then(
      () => undefined,
      (error) => {
        tempDirReady = null
        throw error
      },
    )
  }
  await tempDirReady
}

async function removeFile(path: string | null | undefined): Promise<void> {
  if (!path) return
  await fs.unlink(path).catch(() => undefined)
}

interface ImageInfo {
  width: number
  height: number
  hasAlpha: boolean
}

/** 只读图片元数据，不把原图解码进主进程 */
async function readImageInfo(path: string): Promise<ImageInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      SIPS,
      ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', path],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
    )
    const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1] ?? 0)
    const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1] ?? 0)
    if (!width || !height) return null
    return { width, height, hasAlpha: /hasAlpha:\s*yes/i.test(stdout) }
  } catch {
    return null
  }
}

async function runSips(args: string[]): Promise<void> {
  await execFileAsync(SIPS, args, { timeout: 30_000, maxBuffer: 1024 * 1024 })
}

/**
 * 生成附件卡片缩略图。
 *
 * 优先让系统缩略图工具在子进程里缩放到目标尺寸，主进程只读取最终的小图；
 * 这样一张几十 MP 的照片不会先把整张位图解码进 Electron 主进程。
 * 只有 sips 不认识、且文件本身很小的图片，才退回 nativeImage 兜底。
 */
async function makeThumbnail(
  path: string,
  kind: AttachmentInfo['kind'],
  size: number,
): Promise<string | undefined> {
  if (kind !== 'image') return undefined

  const info = await readImageInfo(path)
  if (info) {
    const logicalWidth = Math.min(
      168,
      Math.max(56, Math.round((56 * info.width) / info.height)),
    )
    const width = logicalWidth * 2
    const ext = info.hasAlpha ? 'png' : 'jpg'
    const out = join(TEMP_DIR, `thumb-${randomUUID()}.${ext}`)
    try {
      await ensureTempDir()
      const encode = async (quality?: number): Promise<Buffer> => {
        const args = info.hasAlpha
          ? ['-s', 'format', 'png']
          : ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality ?? 75)]
        args.push('-z', '112', String(width), path, '--out', out)
        await runSips(args)
        return fs.readFile(out)
      }

      let buffer = await encode()
      if (!info.hasAlpha && buffer.byteLength > MAX_THUMB_BYTES) {
        buffer = await encode(50)
      }
      if (buffer.byteLength > MAX_THUMB_HARD_BYTES) return undefined
      return `data:image/${info.hasAlpha ? 'png' : 'jpeg'};base64,${buffer.toString('base64')}`
    } catch {
      return undefined
    } finally {
      await removeFile(out)
    }
  }

  // sips 失败时只对小图兜底；大图宁可显示占位图，也不在主进程全量解码。
  if (size > FALLBACK_DECODE_MAX_BYTES) return undefined
  try {
    const source = nativeImage.createFromPath(path)
    const dims = source.getSize()
    if (source.isEmpty() || !dims.width || !dims.height) return undefined
    const width = Math.min(168, Math.max(56, Math.round((56 * dims.width) / dims.height)))
    return source.resize({ width: width * 2, height: 112, quality: 'good' }).toDataURL()
  } catch {
    return undefined
  }
}

/** 预览图：长边限制在 1600px，返回临时文件路径；不返回原图 */
async function makePreviewImage(path: string): Promise<string | null> {
  const info = await readImageInfo(path)
  if (!info) return null

  const ext = info.hasAlpha ? 'png' : 'jpg'
  const out = join(TEMP_DIR, `preview-${randomUUID()}.${ext}`)
  try {
    await ensureTempDir()
    const args = info.hasAlpha
      ? ['-s', 'format', 'png']
      : ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80']
    // 小图不要被 sips 放大；只有长边超过预览上限时才缩到 1600px。
    if (Math.max(info.width, info.height) > PREVIEW_MAX_EDGE) {
      args.push('-Z', String(PREVIEW_MAX_EDGE))
    }
    args.push(path, '--out', out)
    await runSips(args)
    return out
  } catch {
    await removeFile(out)
    return null
  }
}

function fullSignedUrl(path: string, ty: 'p' | 'r' | 't' = 'r'): string {
  if (/^https?:\/\//i.test(path)) return path
  const normalized = path.startsWith('/') ? path : `/${path}`
  const base = normalized.startsWith('/api/')
    ? `https://files.deepseeksvc.com${normalized}`
    : `https://files.deepseeksvc.com/api${normalized}`
  return `${base}${base.includes('?') ? '&' : '?'}ty=${ty}`
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case 'pdf': return 'application/pdf'
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'svg': return 'image/svg+xml'
    case 'bmp': return 'image/bmp'
    case 'avif': return 'image/avif'
    case 'tif':
    case 'tiff': return 'image/tiff'
    case 'json': return 'application/json'
    case 'html':
    case 'htm': return 'text/html'
    case 'css': return 'text/css'
    case 'js':
    case 'mjs':
    case 'cjs': return 'text/javascript'
    case 'ts':
    case 'tsx': return 'text/typescript'
    case 'md':
    case 'markdown': return 'text/markdown'
    case 'csv': return 'text/csv'
    case 'xml': return 'application/xml'
    case 'yaml':
    case 'yml': return 'text/yaml'
    default: return 'text/plain'
  }
}

function isAllowed(name: string, accept: Set<string>): boolean {
  const ext = extensionOf(name)
  const key = ext || basename(name).replace(/^\./, '').toLowerCase()
  return accept.has(key)
}

async function validatePaths(
  filePaths: string[],
  accept: string,
  labels: { title: string; filter: string; button: string },
): Promise<AttachmentPickResult> {
  const extensions = acceptExtensions(accept)
  if (!extensions.length) {
    return { attachments: [], rejected: [], error: labels.filter }
  }

  const allowed = new Set(extensions)
  const attachments: AttachmentInfo[] = []
  const rejected: AttachmentPickResult['rejected'] = []

  for (const path of filePaths) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      rejected.push({ name: basename(path), reason: 'limit' })
      continue
    }
    const name = basename(path)
    if (!isAllowed(name, allowed)) {
      rejected.push({ name, reason: 'format' })
      continue
    }

    let size = 0
    try {
      size = (await fs.stat(path)).size
    } catch {
      rejected.push({ name, reason: 'unreadable' })
      continue
    }
    if (size > MAX_ATTACHMENT_BYTES) {
      rejected.push({ name, reason: 'size' })
      continue
    }

    const ext = extensionOf(name)
    const kind = classifyAttachment(name)
    const id = `att-${randomUUID()}`
    const attachment: PendingAttachment = {
      id,
      name,
      size,
      ext,
      kind,
      previewable: kind !== 'file',
      status: 'uploading',
      thumbnailUrl: await makeThumbnail(path, kind, size),
      path,
      mime: mimeForExt(ext),
      prepared: false,
    }
    pending.set(id, attachment)
    const { path: _path, mime: _mime, ...safe } = attachment
    attachments.push(safe)
  }

  return { attachments, rejected }
}

export async function pickAttachments(
  parent: BrowserWindow,
  accept: string,
  labels: { title: string; filter: string; button: string },
): Promise<AttachmentPickResult> {
  const extensions = acceptExtensions(accept)
  if (!extensions.length) {
    return { attachments: [], rejected: [], error: labels.filter }
  }

  const result = await dialog.showOpenDialog(parent, {
    title: labels.title,
    buttonLabel: labels.button,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: labels.filter, extensions }],
  })
  if (result.canceled) return { attachments: [], rejected: [] }
  return validatePaths(result.filePaths, accept, labels)
}

/** 开发自检用：绕过原生文件框直接校验路径；正式运行不会调用 */
export function pickAttachmentsForTest(
  filePaths: string[],
  accept: string,
  labels: { title: string; filter: string; button: string },
): Promise<AttachmentPickResult> {
  return validatePaths(filePaths, accept, labels)
}

export function setAttachmentPrepared(id: string): void {
  const attachment = pending.get(id)
  if (!attachment) return
  attachment.prepared = true
  attachment.prepareError = undefined
  attachment.retryable = undefined
  if (!injectedOrder.includes(id)) injectedOrder.push(id)
}

export function setAttachmentPrepareError(id: string, error: string): void {
  const attachment = pending.get(id)
  if (!attachment) return
  attachment.status = 'error'
  attachment.error = error
  attachment.prepareError = error
  attachment.retryable = true
  const index = injectedOrder.indexOf(id)
  if (index >= 0) injectedOrder.splice(index, 1)
}

/** 用户点了失败卡片上的重新上传：先回到上传中，等网页状态轮询确认结果 */
export function setAttachmentRetrying(id: string): void {
  const attachment = pending.get(id)
  if (!attachment) return
  attachment.status = 'uploading'
  attachment.error = undefined
  attachment.retryable = undefined
  attachment.prepareError = undefined
}

export function removePendingAttachment(id: string): number {
  const index = getPendingAttachmentIndex(id)
  pending.delete(id)
  const injectedIndex = injectedOrder.indexOf(id)
  if (injectedIndex >= 0) injectedOrder.splice(injectedIndex, 1)
  const sentIndex = sentOrder.indexOf(id)
  if (sentIndex >= 0) sentOrder.splice(sentIndex, 1)
  return index
}

/**
 * 已发送的附件仍保留在 pending 里供预览，但不再参与下一批上传索引。
 * 缩略图只用于输入区和刚发送的消息 DOM，主进程不再保留一份重复的 data URL。
 */
export function markAttachmentsSent(ids: string[]): void {
  for (const id of ids) {
    const attachment = pending.get(id)
    if (!attachment) continue
    attachment.sent = true
    attachment.thumbnailUrl = undefined
    sentOrder.push(id)
  }
  while (sentOrder.length > MAX_SENT_PENDING) {
    const oldest = sentOrder.shift()
    if (!oldest) break
    const attachment = pending.get(oldest)
    if (attachment?.sent) pending.delete(oldest)
    const injectedIndex = injectedOrder.indexOf(oldest)
    if (injectedIndex >= 0) injectedOrder.splice(injectedIndex, 1)
  }
}

export function getPendingAttachmentIndex(id: string): number {
  return injectedOrder.filter((item) => {
    const attachment = pending.get(item)
    return !!attachment && !attachment.sent
  }).indexOf(id)
}

export function getPendingAttachments(ids: string[]): PendingAttachment[] {
  return ids.map((id) => pending.get(id)).filter((item): item is PendingAttachment => !!item)
}

export function clearPendingAttachments(): void {
  pending.clear()
  injectedOrder.length = 0
  sentOrder.length = 0
}

export function registerHistoryAttachments(messages: HistoryMessage[]): void {
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (!attachment.signedPath) continue
      historySources.set(attachment.id, {
        id: attachment.id,
        name: attachment.name,
        kind: attachment.kind,
        url: fullSignedUrl(attachment.signedPath, attachment.kind === 'image' ? 'p' : 'r'),
      })
    }
  }
}

export function clearHistoryAttachments(): void {
  historySources.clear()
}

export function getAttachmentSource(id: string): AttachmentSource | null {
  const local = pending.get(id)
  if (local) return { id, name: local.name, kind: local.kind, path: local.path }
  return historySources.get(id) ?? null
}

let previewServer: Server | null = null

export async function closeAttachmentPreview(): Promise<void> {
  const server = previewServer
  const temp = previewTempPath
  previewServer = null
  previewTempPath = null
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await removeFile(temp)
}

async function startPreviewServer(
  source: AttachmentSource,
  tempPath: string | null = null,
): Promise<string> {
  await closeAttachmentPreview()
  previewTempPath = tempPath
  const token = randomBytes(18).toString('hex')
  const contentType =
    source.kind === 'pdf'
      ? 'application/pdf'
      : mimeForExt(extensionOf(source.path ?? source.name))
  const server = createServer(async (req, res) => {
    if (!req.url || !req.url.startsWith(`/preview/${token}`)) {
      res.statusCode = 404
      res.end()
      return
    }
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Accept-Ranges', 'bytes')
    try {
      if (source.path) {
        const stat = await fs.stat(source.path)
        let start = 0
        let end = stat.size - 1
        let status = 200
        const range = req.headers.range
        const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
        if (match) {
          start = match[1] ? Number(match[1]) : 0
          end = match[2] ? Number(match[2]) : stat.size - 1
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
            res.statusCode = 416
            res.setHeader('Content-Range', `bytes */${stat.size}`)
            res.end()
            return
          }
          end = Math.min(end, stat.size - 1)
          status = 206
          res.statusCode = 206
          res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
        }
        res.statusCode = status
        res.setHeader('Content-Length', String(end - start + 1))
        createReadStream(source.path, { start, end }).on('error', () => res.destroy()).pipe(res)
        return
      }
      if (!source.url) {
        res.statusCode = 404
        res.end()
        return
      }
      const headers: Record<string, string> = {}
      if (req.headers.range) headers.Range = req.headers.range
      const response = await getDeepseekSession().fetch(source.url, {
        credentials: 'include',
        headers,
      })
      if (!response.ok || !response.body) {
        res.statusCode = response.status || 502
        res.end()
        return
      }
      res.statusCode = response.status === 206 ? 206 : 200
      const length = response.headers.get('content-length')
      const contentRange = response.headers.get('content-range')
      const acceptRanges = response.headers.get('accept-ranges')
      if (length) res.setHeader('Content-Length', length)
      if (contentRange) res.setHeader('Content-Range', contentRange)
      if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges)
      Readable.fromWeb(response.body as unknown as ReadableStream<Uint8Array>).pipe(res)
    } catch {
      if (!res.headersSent) res.statusCode = 502
      res.end()
    }
  })
  previewServer = server
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
  } catch (error) {
    previewServer = null
    await removeFile(previewTempPath)
    previewTempPath = null
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeAttachmentPreview()
    throw new Error('preview server unavailable')
  }
  return `http://127.0.0.1:${address.port}/preview/${token}`
}

export async function openAttachmentPreview(id: string): Promise<AttachmentPreview | null> {
  const source = getAttachmentSource(id)
  if (!source) return null

  if (source.kind === 'text') {
    try {
      let text = ''
      if (source.path) {
        const buffer = await fs.readFile(source.path)
        if (buffer.byteLength > MAX_TEXT_PREVIEW_BYTES) {
          return { kind: 'error', name: source.name, message: '文件内容过长，无法全部展示' }
        }
        text = buffer.toString('utf8')
      } else if (source.url) {
        const response = await getDeepseekSession().fetch(source.url, { credentials: 'include' })
        if (!response.ok) throw new Error(`http ${response.status}`)
        text = await response.text()
        if (text.length > MAX_TEXT_PREVIEW_BYTES) {
          return { kind: 'error', name: source.name, message: '文件内容过长，无法全部展示' }
        }
      }
      return { kind: 'text', name: source.name, text }
    } catch (error) {
      return {
        kind: 'error',
        name: source.name,
        message: error instanceof Error ? error.message : '打开文件失败',
      }
    }
  }

  if (source.kind === 'image' && source.path) {
    /*
     * 本地图片不再把原图交给预览栏：先生成一张长边 1600px 的临时预览图，
     * 快捷窗口的缩略图会先显示，这张图加载好后再替换。
     */
    const temp = await makePreviewImage(source.path)
    if (!temp) return null
    try {
      const url = await startPreviewServer({ ...source, path: temp }, temp)
      return { kind: 'image', name: source.name, url }
    } catch {
      await removeFile(temp)
      return null
    }
  }

  if (source.kind === 'image' || source.kind === 'pdf') {
    try {
      const url = await startPreviewServer(source)
      return { kind: source.kind, name: source.name, url }
    } catch (error) {
      return {
        kind: 'error',
        name: source.name,
        message: error instanceof Error ? error.message : '打开文件失败',
      }
    }
  }

  return {
    kind: 'error',
    name: source.name,
    message: '该文件不支持预览',
  }
}

/** 页面端引用文件时给 File 的 MIME；没有扩展名时退回二进制 */
export function mimeForAttachment(name: string): string {
  return mimeForExt(extensionOf(name)) || 'application/octet-stream'
}

export { fullSignedUrl }

export interface AttachmentBridgeFile {
  path: string
  name: string
  mime: string
}

/** 给网页注入文件用的临时本机 URL；页面 fetch 完成后立即关闭 */
export async function createAttachmentBridge(
  files: AttachmentBridgeFile[],
): Promise<{ urls: Array<{ name: string; type: string; url: string }>; close: () => Promise<void> }> {
  const token = randomBytes(18).toString('hex')
  const server = createServer((req, res) => {
    const match = /^\/attach\/([^/]+)\/(\d+)$/.exec(req.url || '')
    if (!match || match[1] !== token) {
      res.statusCode = 404
      res.end()
      return
    }
    const file = files[Number(match[2])]
    if (!file) {
      res.statusCode = 404
      res.end()
      return
    }
    res.setHeader('Content-Type', file.mime || 'application/octet-stream')
    res.setHeader('Access-Control-Allow-Origin', 'https://chat.deepseek.com')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.setHeader('Cache-Control', 'no-store')
    createReadStream(file.path).on('error', () => res.destroy()).pipe(res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('attachment bridge unavailable')
  }
  return {
    urls: files.map((file, index) => ({
      name: file.name,
      type: file.mime,
      url: `http://127.0.0.1:${address.port}/attach/${token}/${index}`,
    })),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

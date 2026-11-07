import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { writeJson, plainPath } from './config.mjs'
import { GROUP_DECISION_DESCRIPTION, GROUP_DECISION_PARAMETERS } from './group-participation.mjs'

const MAX_INBOUND_IMAGES = 4
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const SPEECH_TIMEOUT_SECONDS = 60

const defaults = {
  enabled: false,
  speechCommand: '',
  batchWindowSeconds: 1,
  maxBatchAgeSeconds: 20,
  maxBatchSize: 8,
}
const numberLimits = {
  batchWindowSeconds: [0, 30],
  maxBatchAgeSeconds: [0, 60],
  maxBatchSize: [1, 50],
}
function normalize(raw = {}) {
  const value = { ...defaults, ...raw }
  for (const [key, fallback] of Object.entries(defaults)) {
    if (typeof fallback === 'boolean' && typeof value[key] !== 'boolean') {
      value[key] = fallback
    }
  }
  for (const [key, [min, max]] of Object.entries(numberLimits)) {
    const n = Number(value[key])
    value[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defaults[key]
  }
  return value
}

async function boundedBytes(response, limit, signal) {
  if (!response.ok || Number(response.headers?.get?.('content-length')) > limit) {
    throw new Error('媒体下载失败或过大')
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > limit) {
      throw new Error('媒体过大')
    }
    return bytes
  }
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      length += value.length
      if (length > limit) {
        throw new Error('媒体过大')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks, length)
  } finally {
    await reader.cancel().catch(() => {
      // Cancellation is best-effort after consumption or a primary read failure.
    })
    reader.releaseLock()
  }
}
async function mediaBytes(data, limit, signal) {
  const source = String(data.url || data.file || '')
  if (/^https?:\/\//i.test(source)) {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(8000)].filter(Boolean))
    return boundedBytes(await fetch(source, { signal: combined }), limit, combined)
  }
  if (source.startsWith('base64://')) {
    if (source.length > Math.ceil((limit * 4) / 3) + 20) {
      throw new Error('媒体过大')
    }
    return Buffer.from(source.slice(9), 'base64')
  }
  const path = source.startsWith('file://') ? new URL(source) : source
  if (!path || !existsSync(path)) {
    return null
  }
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > limit) {
    throw new Error('媒体过大')
  }
  return readFileSync(path)
}
function speech(command, file, timeout, signal) {
  return new Promise((resolveResult) => {
    const quoted = process.platform === 'win32' ? `"${file}"` : `'${file.replace(/'/g, `'\\''`)}'`
    const line = command.replace(/(["'])?\{file\}\1/g, quoted)
    let child
    let output = ''
    let settled = false
    const finish = (value) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolveResult(value)
    }
    const abort = () => {
      if (settled) {
        return
      }
      if (child?.pid) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: 3000,
          })
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch (error) {
            if (error.code !== 'ESRCH') {
              child.kill('SIGKILL')
            }
          }
        }
      }
      finish('[语音转写已取消]')
    }
    const timer = setTimeout(abort, timeout * 1000)
    if (signal.aborted) {
      return abort()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      child = spawn(line, {
        shell: true,
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      })
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        if (settled) {
          return
        }
        output += chunk
        if (output.length > 16000) {
          abort()
        }
      })
      child.stderr?.resume()
      child.on('error', () => finish('[语音转写失败]'))
      child.on('close', (code) =>
        finish(code === 0 && output.trim() ? `（语音）${output.trim()}` : '[语音转写失败]'),
      )
    } catch {
      finish('[语音转写失败]')
    }
  })
}

const imageExtensionForMimeType = (mimeType) =>
  mimeType === 'image/png'
    ? 'png'
    : mimeType === 'image/gif'
      ? 'gif'
      : mimeType === 'image/webp'
        ? 'webp'
        : 'jpg'

function detectImageMimeType(bytes) {
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      return 'image/png'
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49) {
      return 'image/gif'
    }
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) {
      return 'image/webp'
    }
  } catch {
    // Unreadable signatures retain the historical JPEG fallback.
  }
  return 'image/jpeg'
}

/** Join visible assistant text without forwarding reasoning or image blocks. */
function extractAssistantText(message) {
  if (!message || !Array.isArray(message.content)) {
    return ''
  }
  return message.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** Native assistant images are forwarded separately from visible text. */
function extractAssistantImages(message) {
  if (!message || !Array.isArray(message.content)) {
    return []
  }
  return message.content
    .filter((b) => b && b.type === 'image' && typeof b.data === 'string')
    .slice(0, 10)
}

/** 拼一个 OneBot「图片段」（base64 直接塞，不依赖 QQ 那边能不能访问本地文件）。 */
function createImageSegment(base64) {
  return { type: 'image', data: { file: 'base64://' + String(base64) } }
}

/** Remove Markdown image references from text and return deduplicated URL/path descriptors. */
function extractMarkdownImages(inputText) {
  const images = []
  const text = String(inputText || '')
    .replace(/!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g, (_match, imagePath) => {
      const p = String(imagePath || '').trim()
      if (!p) {
        return ''
      }
      if (/^https?:\/\//i.test(p)) {
        if (!images.some((x) => x.value === p)) {
          images.push({ kind: 'url', value: p })
        }
        return ''
      }
      if (!images.some((x) => x.value === p)) {
        images.push({ kind: 'path', value: p })
      }
      return ''
    })
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, images }
}

/** QQ markers are presentation hints, not an additional reply gate. */
function stripQqTags(inputText) {
  return String(inputText || '')
    .replace(/\[\s*\/?\s*QQ\s*\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
const truncateText = (s2, n = 120) => {
  const t = String(s2 == null ? '' : s2)
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
const decodeHtmlEntities = (t) =>
  String(t || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
const extractBilibiliVideoId = (contentText) => {
  const m = /BV[0-9A-Za-z]{10}/.exec(String(contentText || ''))
  return m ? m[0] : ''
}
/** 从分享卡片段（json / xml）里抽标题、描述、链接 —— 抽不到也给一句看得懂的话 */
function extractCardText(segment) {
  const d = (segment && segment.data) || {}
  let raw = d.data != null ? d.data : d.content != null ? d.content : d.xml != null ? d.xml : ''
  if (raw && typeof raw === 'object') {
    raw = JSON.stringify(raw)
  }
  raw = decodeHtmlEntities(String(raw || ''))
  const titles = []
  let url = ''
  try {
    const j = JSON.parse(raw)
    const collectFields = (o, depth = 0) => {
      if (!o || typeof o !== 'object' || depth > 6) {
        return
      }
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string') {
          const value = decodeHtmlEntities(v).trim()
          if (/^(title|desc|summary|prompt)$/i.test(k) && value) {
            titles.push(value)
          }
          if (/^(jumpUrl|qqdocurl|url)$/i.test(k) && /^https?:/i.test(value) && !url) {
            url = value
          }
        } else {
          collectFields(v, depth + 1)
        }
      }
    }
    collectFields(j)
  } catch {
    // Cards may be XML rather than JSON; retain the bounded XML/text fallback below.
  }
  if (!titles.length || !url) {
    const titleMatch = /<title>([\s\S]{0,100}?)<\/title>/i.exec(raw)
    if (titleMatch && decodeHtmlEntities(titleMatch[1]).trim()) {
      titles.push(decodeHtmlEntities(titleMatch[1]).trim())
    }
    const summaryMatch = /<summary>([\s\S]{0,140}?)<\/summary>/i.exec(raw)
    if (summaryMatch && decodeHtmlEntities(summaryMatch[1]).trim()) {
      titles.push(decodeHtmlEntities(summaryMatch[1]).trim())
    }
    const urlMatch = /(https?:\/\/[^\s"'<>&]+)/.exec(raw)
    if (urlMatch && !url) {
      url = urlMatch[1]
    }
  }
  const title = [...new Set(titles)].slice(0, 2).join(' —— ')
  const bv = extractBilibiliVideoId(raw + ' ' + url)
  const trailingText = [url ? '链接 ' + url : '', bv ? 'BV号 ' + bv : ''].filter(Boolean).join('　')
  if (!title && !trailingText) {
    return '[分享卡片（里面没抓到内容）]'
  }
  const prefix = bv ? '[分享视频卡片]' : '[分享卡片]'
  return (
    prefix +
    ' ' +
    (title || '（没标题）') +
    (trailingText ? String.fromCharCode(10) + '  ' + trailingText : '')
  )
}
/** Bound node/line counts and nesting; collect image segments only from the outermost forward. */
async function extractForwardedLines(segment, request, imageSegments, depth, budget) {
  const indent = '  '.repeat(depth + 1)
  const d = (segment && segment.data) || {}
  const id = String(
    d.id != null ? d.id : d.message_id != null ? d.message_id : d.content != null ? d.content : '',
  )
  if (!id) {
    return [indent + '[合并转发的聊天记录（没有 id，读不出来）]']
  }
  let nodes = []
  for (const body of [{ message_id: id }, { id }]) {
    const result = await request('get_forward_msg', body)
    const candidates = (result && (result.messages || result.message)) || null
    if (Array.isArray(candidates) && candidates.length) {
      nodes = candidates
      break
    }
  }
  if (!nodes.length) {
    return [indent + '[合并转发的聊天记录（内容取不到）]']
  }
  const lines = [indent + '[合并转发的聊天记录 · 共 ' + nodes.length + ' 条]']
  for (const node of nodes.slice(0, 12)) {
    if (budget.linesRemaining <= 0) {
      lines.push(indent + '  …（后面的没展开）')
      break
    }
    budget.linesRemaining--
    const senderName = String(
      (node && node.sender && (node.sender.card || node.sender.nickname)) ||
        (node && node.nickname) ||
        '某人',
    )
    const segments = Array.isArray(node && node.content)
      ? node.content
      : Array.isArray(node && node.message)
        ? node.message
        : []
    const textParts = []
    const nestedSegments = []
    for (const x of segments) {
      if (!x) {
        continue
      }
      const type = String(x.type || '')
      if (type === 'text') {
        textParts.push(String((x.data && x.data.text) || ''))
        continue
      }
      if (type === 'image' || type === 'mface') {
        // Some mface segments contain only a description; keep that visible without a URL.
        const dd = x.data || {}
        const imageSource = String(dd.url || dd.file || dd.path || dd.thumb || '')
        if (type === 'mface' && !imageSource) {
          textParts.push(
            '[表情:' + truncateText(String(dd.summary || dd.emoji_id || '大表情'), 20) + ']',
          )
          continue
        }
        if (depth === 0 && Array.isArray(imageSegments)) {
          imageSegments.push(x)
        } // 只收第一层的图
        textParts.push('[图片]')
        continue
      }
      if (type === 'face') {
        textParts.push('[表情]')
        continue
      }
      if (type === 'record') {
        textParts.push('[语音]')
        continue
      }
      if (type === 'video') {
        textParts.push('[视频]')
        continue
      }
      if (type === 'json' || type === 'xml') {
        textParts.push('[卡片]')
        continue
      }
      if (type === 'at') {
        textParts.push('@' + String((x.data && (x.data.name || x.data.qq)) || ''))
        continue
      }
      if (type === 'forward') {
        nestedSegments.push(x)
        continue
      }
    }
    const prefix = indent + '  ' + truncateText(senderName, 20) + '：'
    const text = textParts
      .join('')
      .replace(/[ \t]+/g, ' ')
      .replace(/[\r\n]+/g, ' ')
      .trim()
    if (text) {
      lines.push(prefix + truncateText(text, 240))
    }
    // A forwarded-only message still needs its sender label.
    else if (nestedSegments.length && depth === 0) {
      lines.push(prefix + '（转发的聊天记录）')
    }
    for (const nestedSegment of nestedSegments) {
      if (depth >= 3) {
        // At the depth limit, report the nested count without expanding its content.
        budget.linesRemaining--
        let count = 0
        try {
          const d2 = (nestedSegment && nestedSegment.data) || {}
          const id2 = String(d2.id != null ? d2.id : d2.content != null ? d2.content : '')
          if (id2) {
            const nestedResult = await request('get_forward_msg', { message_id: id2 })
            const nestedCandidates =
              (nestedResult && (nestedResult.messages || nestedResult.message)) || null
            if (Array.isArray(nestedCandidates)) {
              count = nestedCandidates.length
            }
          }
        } catch {
          // The optional count is best-effort; the placeholder below still identifies nested content.
        }
        lines.push(
          prefix +
            (count
              ? `[里面还有 ${count} 条转发，套得太深没展开]`
              : '[里面还套着一层转发（太深，没展开）]'),
        )
        continue
      }
      lines.push(
        ...(await extractForwardedLines(nestedSegment, request, imageSegments, depth + 1, budget)),
      )
    }
    if (!text && !nestedSegments.length) {
      lines.push(prefix + '（这条没内容）')
    }
  }
  return lines
}

/** Limit forwarded context by both line count and final character count. */
async function extractForwardedText(segment, request, imageSegments) {
  const lines = await extractForwardedLines(segment, request, imageSegments, 0, {
    linesRemaining: 40,
  })
  let contentText = lines.join(String.fromCharCode(10))
  if (contentText.length > 2500) {
    contentText = contentText.slice(0, 2500) + String.fromCharCode(10) + '…（太长，剩下的没展开）'
  }
  return contentText
}

function incomingHistory(event, text) {
  const pieces = Array.isArray(event.message) ? event.message : []
  const sender = event.user_id === undefined ? event.sender?.user_id : event.user_id
  return {
    kind: 'incoming',
    messageId: String(event.message_id),
    senderId:
      (typeof sender === 'string' || typeof sender === 'number') &&
      /^[1-9]\d*$/.test(String(sender)) &&
      Number.isSafeInteger(Number(sender))
        ? String(sender)
        : null,
    time: event.time ?? null,
    text: String(text).slice(0, 4000),
    mentions: pieces
      .filter((piece) => piece.type === 'at')
      .map((piece) => String(piece.data?.qq ?? '')),
    replyToMessageId:
      pieces.find((piece) => piece.type === 'reply')?.data?.id != null
        ? String(pieces.find((piece) => piece.type === 'reply').data.id)
        : null,
  }
}

function conversation(row) {
  return row.groupConversation || { history: [], latestAssessment: null, mood: '' }
}

function appendHistory(state, entries) {
  const history = [...(state.history || [])]
  for (const entry of entries) {
    if (!history.some((item) => item.kind === entry.kind && item.messageId === entry.messageId)) {
      history.push(entry)
    }
  }
  let length = 0
  state.history = history
    .slice(-80)
    .reverse()
    .filter((entry) => {
      length += entry.text.length
      return length <= 24000
    })
    .reverse()
  return state
}

function validDecision(args, targets) {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => !Object.hasOwn(GROUP_DECISION_PARAMETERS.properties, key)) ||
    !['reply', 'react', 'silent'].includes(args.action) ||
    typeof args.addressedToBot !== 'boolean' ||
    typeof args.reason !== 'string' ||
    !args.reason.trim() ||
    args.reason.length > 500 ||
    (args.mood !== undefined && (typeof args.mood !== 'string' || args.mood.length > 160)) ||
    (args.quote !== undefined && typeof args.quote !== 'boolean') ||
    (args.targetMessageId !== undefined &&
      (typeof args.targetMessageId !== 'string' ||
        !args.targetMessageId ||
        args.targetMessageId.length > 128 ||
        !targets.has(args.targetMessageId))) ||
    (args.emojiId !== undefined &&
      (typeof args.emojiId !== 'string' || !/^[0-9]{1,20}$/.test(args.emojiId))) ||
    (args.action !== 'silent' && !targets.has(args.targetMessageId)) ||
    (args.action === 'react' && args.emojiId === undefined)
  ) {
    return null
  }
  return { ...args }
}

/** One event-driven host. Inbox records are isolated by account and chat. */
export function createBridge(ctx) {
  const directory = ctx.directory
  plainPath(directory)
  mkdirSync(directory, { recursive: true })
  const life = new AbortController()
  const controllers = new Set()
  const disposers = []
  const tasks = new Set()
  const logs = []
  const batches = new Map()
  const chatMetadata = new Map()
  const locks = new Map()
  const outbound = new Map()
  const turns = new Map()
  const turnOrigins = new Map()
  const activeDeliveries = new Map()
  const pendingPublications = new Set()
  const recovered = new Set()
  let stopped = false
  let processing = false
  let generation = 0
  let timer = null
  const log = (text) => {
    logs.push({ time: Date.now(), text })
    if (logs.length > 100) {
      logs.shift()
    }
    ctx.logger?.info?.(text)
  }
  const config = () => normalize(ctx.readConfig())
  const transport = () => {
    const s = ctx.onebot?.status?.()
    return s?.connected && s.ready && typeof s.selfId === 'string' && /^[1-9]\d*$/.test(s.selfId)
      ? s
      : null
  }
  const identityDir = (self) => join(directory, 'inbox', self)
  const chatFile = (self, chat) =>
    join(identityDir(self), `${Buffer.from(`${chat.type}-${chat.id}`).toString('hex')}.json`)
  function load(self, chat) {
    const file = chatFile(self, chat)
    plainPath(file)
    if (!existsSync(file)) {
      return { version: 1, selfId: self, chat, pending: [], seen: [], outbound: [] }
    }
    const row = JSON.parse(readFileSync(file, 'utf8'))
    if (
      row.version !== 1 ||
      row.selfId !== self ||
      row.chat?.type !== chat.type ||
      row.chat?.id !== chat.id ||
      !Array.isArray(row.pending) ||
      !Array.isArray(row.seen)
    ) {
      throw new Error('QQ 收件箱损坏或身份不匹配')
    }
    return row
  }
  function save(row) {
    writeJson(chatFile(row.selfId, row.chat), row)
  }
  const chatFor = (event) => {
    const type = event.message_type === 'group' ? 'group' : 'private'
    const id = String(
      type === 'group' ? event.group_id : (event.user_id ?? event.sender?.user_id ?? ''),
    )
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
      return null
    }
    const groupId = type === 'private' ? (event.group_id ?? event.temp_source?.group_id) : undefined
    return { type, id, ...(groupId != null ? { groupId: String(groupId) } : {}) }
  }
  async function parseMessage(message, chat, self, signal) {
    const pieces = Array.isArray(message.message)
      ? message.message
      : [{ type: 'text', data: { text: message.raw_message || message.message || '' } }]
    let text = ''
    let readError
    const imageData = []
    const attachments = []
    const call = async (action, body) => {
      try {
        return await ctx.onebot.request(action, body, { signal, timeout: 8000 })
      } catch (error) {
        if (
          signal.aborted ||
          ['ONEBOT_TIMEOUT', 'ONEBOT_DISCONNECTED', 'ONEBOT_CANCELLED'].includes(error?.code)
        ) {
          readError = error
        }
        throw error
      }
    }
    for (const piece of pieces) {
      signal.throwIfAborted()
      const data = piece.data || {}
      switch (piece.type) {
        case 'text':
          text += String(data.text || '')
          break
        case 'at':
          text += ` @${data.name || data.qq}`
          break
        case 'image':
        case 'mface':
          imageData.push(data)
          break
        case 'json':
        case 'xml':
          text += '\n' + extractCardText(piece)
          break
        case 'forward':
          text += '\n' + (await extractForwardedText(piece, call, imageData))
          break
        case 'record': {
          const cfg = config()
          if (!cfg.speechCommand.includes('{file}')) {
            text += '[语音，未配置转写]'
            break
          }
          let source = data
          try {
            const record = await call('get_record', { file: data.file, out_format: 'wav' })
            if (record?.file || record?.url) {
              source = record
            }
          } catch {
            // Backends without WAV conversion may still supply the original audio.
            // Transport failures remain in readError and are rethrown after parsing.
          }
          try {
            const bytes = await mediaBytes(source, 16 * 1024 * 1024, signal)
            if (!bytes) {
              text += '[语音下载失败]'
              break
            }
            const mediaRoot = join(
              identityDir(self),
              `${Buffer.from(`${chat.type}-${chat.id}`).toString('hex')}-media`,
            )
            const audioDir = join(mediaRoot, 'audio')
            plainPath(audioDir)
            mkdirSync(audioDir, { recursive: true })
            const file = join(
              audioDir,
              `voice-${String(message.message_id).replace(/[^\w-]/g, '')}.audio`,
            )
            plainPath(file)
            writeFileSync(file, bytes, { mode: 0o600 })
            text += await speech(cfg.speechCommand, file, SPEECH_TIMEOUT_SECONDS, signal)
          } catch {
            text += '[语音转写失败]'
          }
          break
        }
        case 'video':
          text += '[视频，尚未解析]'
          break
      }
    }
    if (readError) {
      throw readError
    }
    for (const data of imageData.slice(0, MAX_INBOUND_IMAGES)) {
      try {
        const bytes = await mediaBytes(data, MAX_IMAGE_BYTES, signal)
        if (!bytes) {
          continue
        }
        const imageDir = join(
          identityDir(self),
          `${Buffer.from(`${chat.type}-${chat.id}`).toString('hex')}-media`,
          'images',
        )
        plainPath(imageDir)
        mkdirSync(imageDir, { recursive: true })
        const mimeType = detectImageMimeType(bytes)
        const file = join(
          imageDir,
          `${Date.now()}-${String(message.message_id).replace(/[^\w-]/g, '')}-${attachments.length}.${imageExtensionForMimeType(mimeType)}`,
        )
        plainPath(file)
        writeFileSync(file, bytes, { mode: 0o600 })
        attachments.push({
          type: 'image',
          mimeType,
          url: `file://${file.replace(/\\/g, '/')}`,
          path: file,
          data: bytes.toString('base64'),
        })
        text += `\n[图片：${file}]`
      } catch {
        text += '\n[图片获取失败]'
      }
    }
    return { text: text.trim(), attachments }
  }
  async function downloadAndParse(event, chat, self, signal) {
    const parsed = await parseMessage(
      { ...event, user_id: event.user_id ?? event.sender?.user_id },
      chat,
      self,
      signal,
    )
    for (const seg of Array.isArray(event.message) ? event.message : []) {
      if (
        ![
          'text',
          'at',
          'image',
          'mface',
          'json',
          'xml',
          'forward',
          'record',
          'video',
          'reply',
        ].includes(seg.type)
      ) {
        let metadata = ''
        try {
          metadata = JSON.stringify(seg.data || {}).slice(0, 500)
        } catch {
          metadata = '[metadata unavailable]'
        }
        parsed.text = [
          parsed.text,
          `[不支持的消息段：${String(seg.type || 'unknown')} ${metadata}]`,
        ]
          .filter(Boolean)
          .join('\n')
      }
    }
    return parsed
  }
  function enqueue(event) {
    if (stopped || !event || event.post_type !== 'message') {
      return false
    }
    const status = transport()
    if (!status || String(event.self_id ?? '') !== status.selfId) {
      return false
    }
    const self = status.selfId
    if (
      event.message_type === 'message_sent' ||
      event.post_type === 'message_sent' ||
      String(event.user_id ?? event.sender?.user_id ?? '') === self
    ) {
      return false
    }
    const chat = chatFor(event)
    const id = String(event.message_id ?? '')
    if (!chat || !id) {
      return false
    }
    chatMetadata.set(`${chat.type}-${chat.id}`, chat)
    try {
      const row = load(self, chat)
      if (
        row.seen.includes(id) ||
        row.pending.some((item) => String(item.event.message_id) === id)
      ) {
        return false
      }
      row.pending.push({ event, received: Date.now() })
      if (chat.type === 'group') {
        row.groupRevision = (row.groupRevision || 0) + 1
      }
      save(row)
      batches.set(`${self}/${chat.type}-${chat.id}`, {
        self,
        chat,
        first: batches.get(`${self}/${chat.type}-${chat.id}`)?.first ?? Date.now(),
        last: Date.now(),
      })
      schedule(0)
      return true
    } catch (error) {
      log('持久收件箱写入失败；停止接收以避免丢失消息')
      stop()
      void ctx.onebot?.close?.()
      throw error
    }
  }
  function schedule(delay = 0) {
    if (stopped || timer) {
      return
    }
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, delay)
    timer.unref?.()
  }
  function current(self, epoch, capturedGeneration) {
    const status = transport()
    return (
      !stopped &&
      config().enabled &&
      generation === capturedGeneration &&
      status?.selfId === self &&
      status.epoch === epoch
    )
  }
  async function processChat(key, batch, epoch, capturedGeneration) {
    if (!current(batch.self, epoch, capturedGeneration)) {
      return
    }
    if (batch.retryAt && batch.retryAt > Date.now()) {
      return
    }
    const row = load(batch.self, batch.chat)
    if (!row.pending.length) {
      batches.delete(key)
      return
    }
    const now = Date.now()
    const windowMs = Math.max(0, Number(config().batchWindowSeconds) || 0) * 1000
    const maxAge = Math.max(windowMs, Number(config().maxBatchAgeSeconds ?? 2) * 1000)
    if (
      row.pending.length < Math.max(1, Number(config().maxBatchSize) || 1) &&
      now - batch.last < windowMs &&
      now - batch.first < maxAge
    ) {
      schedule(Math.min(windowMs - (now - batch.last), maxAge - (now - batch.first)))
      return
    }
    const chosen = row.pending.slice(0, Math.max(1, Number(config().maxBatchSize) || 1))
    const controller = new AbortController()
    controllers.add(controller)
    const signal = AbortSignal.any([life.signal, controller.signal])
    try {
      const parsed = []
      for (const item of chosen) {
        signal.throwIfAborted()
        const value = await downloadAndParse(item.event, batch.chat, batch.self, signal)
        if (!current(batch.self, epoch, capturedGeneration)) {
          return
        }
        parsed.push({ event: item.event, ...value })
      }
      const body = parsed
        .map(
          (item) =>
            `[QQ ${batch.chat.type === 'group' ? `群 ${batch.chat.id}｜${item.event.sender?.card || item.event.sender?.nickname || item.event.user_id} (${item.event.user_id})` : `私聊 ${item.event.user_id}`}]\n${item.text}`,
        )
        .join('\n')
      const context = {
        channel: 'qq',
        selfId: batch.self,
        chat: { type: batch.chat.type, id: batch.chat.id },
        messages: chosen.map(({ event }) => {
          const sender = event.user_id === undefined ? event.sender?.user_id : event.user_id
          const senderId =
            (typeof sender === 'number' || typeof sender === 'string') &&
            /^[1-9]\d*$/.test(String(sender)) &&
            Number.isSafeInteger(Number(sender))
              ? String(sender)
              : null
          return { messageId: String(event.message_id), senderId }
        }),
      }
      const observed = parsed.map((item) => incomingHistory(item.event, item.text))
      if (batch.chat.type === 'group') {
        context.groupConversation = appendHistory(structuredClone(conversation(row)), observed)
        const included = new Set(
          context.groupConversation.history
            .filter((item) => item.kind === 'incoming')
            .map((item) => item.messageId),
        )
        context.groupConversation.currentMessages = observed.filter(
          (item) => !included.has(item.messageId),
        )
      }
      const origin = {
        selfId: batch.self,
        epoch,
        generation: capturedGeneration,
        active: true,
        chat: batch.chat,
        revision: row.groupRevision || 0,
        decision: null,
        accepted: false,
        targets: new Set(
          [
            ...(context.groupConversation?.history || []).filter(
              (item) => item.kind === 'incoming',
            ),
            ...observed,
          ].map((item) => item.messageId),
        ),
      }
      const agent = ctx.agents.get(`${batch.chat.type}-${batch.chat.id}`, batch.chat, context)
      if (!agent) {
        return
      }
      if (batch.chat.type === 'group') {
        agent.registerTool?.({
          name: 'qq_reply_gate',
          description: GROUP_DECISION_DESCRIPTION,
          parameters: GROUP_DECISION_PARAMETERS,
          execute: async (args) => {
            origin.decision = null
            if (
              !origin.active ||
              origin.ended ||
              !current(origin.selfId, epoch, capturedGeneration)
            ) {
              return { error: 'QQ group turn is no longer current' }
            }
            const decision = validDecision(args, origin.targets)
            if (!decision) {
              return { error: 'Invalid group participation decision or unobserved target' }
            }
            origin.decision = decision
            return decision
          },
        })
      }
      let accepted = false
      const onAccepted = () => {
        if (accepted) {
          return
        }
        accepted = true
        try {
          const latest = load(batch.self, batch.chat)
          const ids = new Set(chosen.map((x) => String(x.event.message_id)))
          latest.pending = latest.pending.filter((x) => !ids.has(String(x.event.message_id)))
          latest.seen = [...new Set([...latest.seen, ...ids])].slice(-10000)
          if (batch.chat.type === 'group') {
            latest.groupConversation = appendHistory(conversation(latest), observed)
          }
          save(latest)
          origin.accepted = true
          if (!latest.pending.length) {
            batches.delete(key)
          } else {
            batches.set(key, {
              ...batch,
              first: latest.pending[0].received || Date.now(),
              last: latest.pending.at(-1).received || Date.now(),
            })
          }
        } catch (error) {
          log('接受确认无法持久化；停止接收以避免重复执行')
          stop()
          void ctx.onebot?.close?.()
          throw error
        }
      }
      const sessionId = `${batch.chat.type}-${batch.chat.id}`
      activeDeliveries.set(sessionId, origin)
      try {
        await agent.followup(body, {
          attachments: parsed.flatMap((item) => item.attachments),
          onAccepted,
          signal,
        })
      } finally {
        if (!origin.ended) {
          assess(origin, 'cancelled')
          origin.active = false
        }
        if (activeDeliveries.get(sessionId) === origin) {
          activeDeliveries.delete(sessionId)
        }
      }
      if (!accepted) {
        throw new Error('会话未确认接收输入')
      }
    } catch (error) {
      if (!signal.aborted) {
        batch.retryAt = Date.now() + 2000
        log(`消息处理失败；该聊天将在稍后重试：${error.message}`)
      }
    } finally {
      controllers.delete(controller)
      await ctx.agents.release?.(`${batch.chat.type}-${batch.chat.id}`)
    }
  }
  async function flush() {
    if (stopped || processing) {
      return
    }
    const status = transport()
    if (!status || !config().enabled) {
      return
    }
    for (const [key, batch] of batches) {
      if (batch.self !== status.selfId) {
        batches.delete(key)
      }
    }
    if (!recovered.has(status.selfId)) {
      try {
        const dir = identityDir(status.selfId)
        plainPath(dir)
        if (existsSync(dir)) {
          for (const name of readdirSync(dir)) {
            if (!name.endsWith('.json')) {
              continue
            }
            const file = join(dir, name)
            plainPath(file)
            const row = JSON.parse(readFileSync(file, 'utf8'))
            if (
              row?.version === 1 &&
              row.selfId === status.selfId &&
              row.chat &&
              Array.isArray(row.pending) &&
              row.pending.length
            ) {
              const key = `${status.selfId}/${row.chat.type}-${row.chat.id}`
              if (!batches.has(key)) {
                batches.set(key, {
                  self: status.selfId,
                  chat: row.chat,
                  first: row.pending[0].received || Date.now(),
                  last: row.pending.at(-1).received || Date.now(),
                })
              }
            }
          }
        }
        recovered.add(status.selfId)
      } catch (error) {
        log(`收件箱恢复失败：${error.message}`)
        return
      }
    }
    if (!batches.size) {
      return
    }
    processing = true
    const capturedGeneration = generation
    const epoch = status.epoch
    try {
      for (const [key, batch] of [...batches]) {
        if (stopped || !current(batch.self, epoch, capturedGeneration)) {
          break
        }
        const prior = locks.get(key) || Promise.resolve()
        const task = prior
          .catch(() => {
            // A failed predecessor must not permanently poison this chat's processing queue.
          })
          .then(() => processChat(key, batch, epoch, capturedGeneration))
        locks.set(key, task)
        tasks.add(task)
        await task
        tasks.delete(task)
      }
    } finally {
      processing = false
      if (batches.size && !stopped) {
        const now = Date.now()
        const delays = [...batches.values()].map((batch) =>
          batch.retryAt && batch.retryAt > now ? batch.retryAt - now : 50,
        )
        schedule(Math.min(...delays))
      }
    }
  }
  function publishable(origin) {
    return (
      current(origin.selfId, origin.epoch, origin.generation) &&
      origin.active &&
      (origin.chat.type !== 'group' ||
        (load(origin.selfId, origin.chat).groupRevision || 0) === origin.revision)
    )
  }
  function assess(origin, outcome, error) {
    if (origin.chat.type !== 'group' || !origin.accepted) {
      return
    }
    try {
      const row = load(origin.selfId, origin.chat)
      const state = conversation(row)
      if ((state.latestAssessment?.revision ?? -1) > origin.revision) {
        return
      }
      state.latestAssessment = {
        ...(origin.decision || { action: null }),
        outcome,
        time: Date.now(),
        revision: origin.revision,
        ...(error ? { error: String(error.message || error).slice(0, 500) } : {}),
      }
      if (origin.modelCompleted && origin.decision?.mood !== undefined) {
        state.mood = origin.decision.mood
      }
      row.groupConversation = state
      save(row)
    } catch (error) {
      log(`群聊状态写入失败；停止接收：${error.message}`)
      stop()
    }
  }
  async function publish(origin, result) {
    if (!publishable(origin)) {
      assess(origin, 'not_published')
      return
    }
    try {
      if (origin.chat.type === 'group' && origin.decision.action === 'react') {
        const messageId = origin.decision.targetMessageId
        if (!/^-?\d+$/.test(messageId) || !Number.isSafeInteger(Number(messageId))) {
          throw new Error('Reaction target is not a real OneBot message ID')
        }
        await ctx.onebot.request(
          'set_msg_emoji_like',
          {
            message_id: Number(messageId),
            emoji_id: origin.decision.emojiId,
            set: true,
          },
          { signal: life.signal, timeout: 10000 },
        )
        assess(origin, publishable(origin) ? 'reacted' : 'superseded_after_reaction')
      } else {
        const outcome = await send(origin.chat, origin, result.text, result.images)
        assess(origin, outcome)
      }
    } catch (error) {
      log(`发送失败或被取消；不自动重发：${error.message}`)
      assess(origin, 'failed', error)
    }
  }
  const turnKey = (id, turn) => `${id}\u0000${turn}`
  function receiveEvent(session, event) {
    const id = typeof session === 'string' ? session : session?.id
    const turnId = String(event?.turn ?? '')
    const key = turnKey(id, turnId)
    if (event?.type === 'turn/start') {
      const origin = activeDeliveries.get(id)
      if (origin?.active) {
        turnOrigins.set(key, origin)
      }
      return
    }
    if (event?.type === 'assistant/message') {
      const origin = turnOrigins.get(key)
      if (!origin?.active) {
        return
      }
      turns.set(key, {
        id,
        turn: turnId,
        text: extractAssistantText(event.message || event),
        images: extractAssistantImages(event.message || event),
      })
      return
    }
    if (event?.type !== 'turn/end') {
      return
    }
    const result = turns.get(key) || { text: '', images: [] }
    const origin = turnOrigins.get(key)
    turns.delete(key)
    turnOrigins.delete(key)
    if (!origin?.active || origin.ended) {
      return
    }
    origin.ended = true
    origin.modelCompleted = event.status === 'completed'
    if (!origin.modelCompleted || !publishable(origin)) {
      assess(origin, origin.modelCompleted ? 'not_published' : 'cancelled')
      return
    }
    const chat = origin.chat
    if (chat.type === 'group' && (!origin.decision || origin.decision.action === 'silent')) {
      assess(origin, origin.decision ? 'silent' : 'no_decision')
      return
    }
    if (
      !result.text &&
      !result.images.length &&
      (chat.type !== 'group' || origin.decision.action !== 'react')
    ) {
      assess(origin, 'no_content')
      return
    }
    assess(origin, 'queued')
    pendingPublications.add(origin)
    const chatKey = `${chat.type}-${chat.id}`
    const previous = outbound.get(chatKey) || Promise.resolve()
    const task = previous
      .catch(() => {
        // Release the queue after failure; only this new result is sent, never the failed result.
      })
      .then(() => publish(origin, result))
    outbound.set(chatKey, task)
    tasks.add(task)
    task.finally(() => {
      pendingPublications.delete(origin)
      tasks.delete(task)
      if (outbound.get(chatKey) === task) {
        outbound.delete(chatKey)
      }
    })
  }
  async function send(chat, origin, text, nativeImages) {
    if (!publishable(origin)) {
      return 'not_published'
    }
    const { text: body, images } = extractMarkdownImages(stripQqTags(text))
    const segments = body
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => [{ type: 'text', data: { text: part } }])
    for (const image of [...nativeImages, ...images]) {
      if (image.data && image.data.length <= Math.ceil((MAX_IMAGE_BYTES * 4) / 3)) {
        segments.push([createImageSegment(image.data)])
      } else if (image.kind === 'url') {
        segments.push([{ type: 'image', data: { file: image.value } }])
      } else if (image.kind === 'path') {
        const root = resolve(ctx.projectRoot || directory)
        const file = resolve(root, image.value)
        const rel = relative(root, file)
        if (!rel.startsWith('..') && !isAbsolute(rel) && existsSync(file)) {
          plainPath(file)
          const st = statSync(file)
          if (st.isFile() && st.size <= MAX_IMAGE_BYTES) {
            segments.push([
              {
                type: 'image',
                data: { file: `base64://${readFileSync(file).toString('base64')}` },
              },
            ])
          }
        }
      }
    }
    if (!segments.length) {
      return 'no_content'
    }
    for (let i = 0; i < segments.length; i++) {
      if (!publishable(origin)) {
        return 'not_published'
      }
      if (chat.type === 'group' && i === 0 && origin.decision.quote === true) {
        segments[i].unshift({ type: 'reply', data: { id: origin.decision.targetMessageId } })
      }
      const result = await ctx.onebot.request(
        chat.type === 'group' ? 'send_group_msg' : 'send_private_msg',
        {
          ...(chat.type === 'group'
            ? { group_id: Number(chat.id) }
            : {
                user_id: Number(chat.id),
                ...(chat.groupId ? { group_id: Number(chat.groupId) } : {}),
              }),
          message: segments[i],
        },
        { signal: life.signal, timeout: 10000 },
      )
      if (!current(origin.selfId, origin.epoch, origin.generation)) {
        return 'not_published'
      }
      if (result?.message_id == null) {
        throw new Error('OneBot did not confirm a sent message ID')
      }
      const row = load(origin.selfId, chat)
      row.outbound = [...new Set([...(row.outbound || []), String(result.message_id)])].slice(-1000)
      if (chat.type === 'group') {
        row.groupConversation = appendHistory(conversation(row), [
          {
            kind: 'bot',
            messageId: String(result.message_id),
            senderId: origin.selfId,
            time: Math.floor(Date.now() / 1000),
            text: segments[i]
              .map((segment) =>
                segment.type === 'text'
                  ? segment.data.text
                  : segment.type === 'image'
                    ? '[图片]'
                    : '',
              )
              .filter(Boolean)
              .join('\n')
              .slice(0, 4000),
            mentions: [],
            replyToMessageId:
              i === 0 && origin.decision.quote === true ? origin.decision.targetMessageId : null,
          },
        ])
      }
      save(row)
    }
    return publishable(origin) ? 'replied' : 'superseded_after_send'
  }
  const offEvent = ctx.onSessionEvent?.(receiveEvent)
  if (typeof offEvent === 'function') {
    disposers.push(offEvent)
  }
  const offOneBotEvent = ctx.onebot?.onEvent?.(enqueue)
  if (typeof offOneBotEvent === 'function') {
    disposers.push(offOneBotEvent)
  }
  const offOneBotState = ctx.onebot?.onState?.((state) => {
    if (!state?.connected || !state?.ready) {
      connectionLost()
    } else {
      schedule(0)
    }
  })
  if (typeof offOneBotState === 'function') {
    disposers.push(offOneBotState)
  }
  function invalidateTurns() {
    for (const origin of new Set([
      ...activeDeliveries.values(),
      ...turnOrigins.values(),
      ...pendingPublications,
    ])) {
      assess(origin, 'not_published')
      origin.active = false
    }
    activeDeliveries.clear()
    turnOrigins.clear()
    turns.clear()
  }
  function connectionLost() {
    generation++
    invalidateTurns()
    recovered.clear()
    for (const c of controllers) {
      c.abort()
    }
    for (const b of batches.values()) {
      b.last = Date.now() - Number(config().batchWindowSeconds || 0) * 1000
    }
    if (!stopped) {
      schedule(0)
    }
  }
  function stop() {
    if (stopped) {
      return
    }
    stopped = true
    generation++
    invalidateTurns()
    recovered.clear()
    clearTimeout(timer)
    life.abort()
    for (const c of controllers) {
      c.abort()
    }
    for (const d of disposers.splice(0).reverse()) {
      d?.()
    }
  }
  async function drain() {
    await Promise.allSettled([...tasks, ...locks.values()])
  }
  ctx.effect?.(() => stop)
  return {
    accept: enqueue,
    connectionLost,
    stop,
    close: async () => {
      stop()
      await drain()
    },
    drain,
    flush,
    status: () => ({
      enabled: !stopped && config().enabled,
      chats: batches.size,
      processing,
      sending: tasks.size,
      logs: logs.slice(-10),
    }),
  }
}

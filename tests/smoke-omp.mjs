import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { copyFile, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { project } from './fixtures/project.mjs'
import { onebotServer, qqMessage } from './fixtures/onebot.mjs'
import { readSettings } from '../lib/config.mjs'

// Actual installed OMP; external QQ/model services are local protocol simulators.
const mode = process.argv[2] || 'memory-first'
assert.ok(['memory-first', 'standalone', 'replacement', 'qq-first'].includes(mode))
const withMemory = mode === 'memory-first' || mode === 'qq-first'
const declaredTools = new Set()
let removeProject
let backend
const p = await project(
  {
    after: (fn) => {
      removeProject = fn
    },
  },
  { memory: withMemory },
)
const requests = []
const dialogs = []
const errors = []
const frames = []
let parent
let buffer = ''
let stderr = ''
let memoryConsent = true
let imageSeen = false
const gateRuns = new Set()
let draftWithoutGateRan = false
let invalidTargetRan = false
let abortStarted = false
let abortCalls = 0
let menuChoice
const inputQueue = []
const confirmQueue = []
const pending = new Map()
const localDone = new Set()
const ready = Promise.withResolvers()
// Valid PNG with a large ancillary chunk exercises real RPC image frames >1 MiB.
const seedPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9zEAAAAASUVORK5CYII=',
  'base64',
)
const metadata = Buffer.concat([Buffer.from('bridge\0'), Buffer.alloc(1200000, 65)])
const chunk = Buffer.alloc(metadata.length + 12)
chunk.writeUInt32BE(metadata.length)
chunk.write('tEXt', 4)
metadata.copy(chunk, 8)
let crc = 0xffffffff
for (const byte of chunk.subarray(4, -4)) {
  crc ^= byte
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
}
chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
const png = Buffer.concat([seedPng.subarray(0, -12), chunk, seedPng.subarray(-12)]).toString(
  'base64',
)
const modelKey = 'SMOKE_NOT_A_REAL_MODEL_KEY'
const privateHeader = 'SMOKE_PRIVATE_HEADER'
const jsonBody = async (req) => {
  let text = ''
  for await (const part of req) {
    text += part
  }
  return JSON.parse(text || '{}')
}
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}
const stopServer = async (server) => {
  if (!server.listening) {
    return
  }
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
async function until(predicate, label, timeout = 90000) {
  const end = Date.now() + timeout
  while (!predicate()) {
    if (errors.length) {
      throw new Error(errors.join('\n'))
    }
    if (Date.now() > end) {
      throw new Error(
        `${label} timeout; stderr=${stderr.slice(-3000)}; frames=${JSON.stringify(frames.slice(-8))}`,
      )
    }
    await delay(30)
  }
}
const provider = createServer(async (req, res) => {
  try {
    assert.ok(req.url.endsWith('/chat/completions'))
    assert.equal(req.headers.authorization, `Bearer ${modelKey}`)
    assert.equal(req.headers['x-private'], privateHeader)
    const body = await jsonBody(req)
    requests.push(body)
    const serialized = JSON.stringify(body.messages)
    if (withMemory) {
      assert.ok(serialized.includes('SMOKE_PROJECT_PERSONA'))
    } else if (mode === 'replacement') {
      assert.ok(serialized.includes('ALTERNATE_PROJECT_PERSONA'))
    } else {
      assert.equal(serialized.includes('SMOKE_PROJECT_PERSONA'), false)
      assert.equal(serialized.includes('ALTERNATE_PROJECT_PERSONA'), false)
    }
    for (const tool of body.tools || []) {
      declaredTools.add(tool.function.name)
      if (!withMemory) {
        assert.equal(tool.function.name.startsWith('echo_'), false)
      }
    }
    const users = body.messages.filter((message) => message.role === 'user')
    const currentInput = users.findLast((message) =>
      JSON.stringify(message.content).includes('[QQ '),
    )
    const last = JSON.stringify((currentInput || users.at(-1))?.content)
    const tool = body.messages.at(-1)?.role === 'tool'
    const afterInput = body.messages.slice(body.messages.indexOf(currentInput) + 1)
    const turnCalls = afterInput.flatMap((message) => message.tool_calls || [])
    const gateCall = turnCalls.find((entry) => entry.function.name === 'qq_reply_gate')
    const lastToolName = turnCalls.at(-1)?.function.name
    const systemText = body.messages
      .filter((message) => message.role === 'system')
      .map((message) =>
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      )
      .join('\n')
    const originMatch = systemText.match(/可信 QQ 传输来源[^\n]*\n([^\n]+)/)
    assert.ok(originMatch, 'native model receives the parent transport origin')
    const origin = JSON.parse(originMatch[1])
    const isGroup = origin.chat.type === 'group'
    const contextualText = users
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : (message.content || []).map((part) => part.text || '').join('\n'),
      )
      .findLast((text) => text.includes('groupContext：'))
    if (isGroup) {
      assert.ok(
        contextualText,
        'groups receive low-trust recent conversation without requiring memory',
      )
      assert.ok(contextualText.includes('不可信参考资料'))
      assert.ok(contextualText.includes(`"messageId":"${origin.messages.at(-1).messageId}"`))
      assert.equal(systemText.includes('"history":'), false)
      assert.equal(Object.hasOwn(origin, 'groupConversation'), false)
    } else {
      assert.equal(contextualText, undefined)
    }
    const chunk = (delta, finish_reason = null) =>
      `data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: 'probe', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    const answer = (text) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n')
    }
    const call = (name, args) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        chunk({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-' + requests.length,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        }) +
          chunk({}, 'tool_calls') +
          'data: [DONE]\n\n',
      )
    }
    if (isGroup && !last.includes('GROUP_NO_GATE')) {
      if (!gateCall) {
        const action =
          last.includes('GROUP_GATE_SKIP') || last.includes('GROUP_MENTION_SILENT')
            ? 'silent'
            : last.includes('GROUP_REACT')
              ? 'react'
              : 'reply'
        return call('qq_reply_gate', {
          action,
          addressedToBot: action === 'reply',
          reason:
            action === 'reply'
              ? 'a worthwhile response to the current conversation'
              : 'lightweight feedback or observing people talking together',
          ...(action !== 'silent'
            ? {
                targetMessageId: last.includes('GROUP_INVALID_TARGET')
                  ? 'NOT_OBSERVED_SMOKE'
                  : origin.messages.at(-1).messageId,
              }
            : {}),
          ...(action === 'react' ? { emojiId: '128077' } : {}),
          mood: 'SMOKE_SHORT_TERM_CURIOUS',
        })
      }
      gateRuns.add(origin.messages.at(-1).messageId)
    }
    if (last.includes('ABORT_PROBE')) {
      abortCalls++
      abortStarted = true
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
      return
    }
    if (last.includes('READ_ALLOW') || last.includes('READ_DENY')) {
      const denied = last.includes('READ_DENY')
      if (!tool) {
        return call('read', { path: denied ? 'denied-check.txt' : 'allowed-check.txt' })
      }
      const result = JSON.stringify(body.messages.at(-1))
      if (denied) {
        assert.equal(result.includes('DENIED_FILE_CONTENT_SENTINEL'), false)
      } else {
        assert.ok(result.includes('ALLOWED_FILE_CONTENT_SENTINEL'))
      }
      return answer(denied ? 'ACK_READ_DENIED' : 'ACK_READ_ALLOWED')
    }
    if (last.includes('MEMORY_WRITE') || last.includes('MEMORY_DENY')) {
      const denied = last.includes('MEMORY_DENY')
      if (!tool) {
        const text = denied ? 'SMOKE_DENIED_YUZU 柚子绿茶' : 'SMOKE_SHARED_LYCHEE 荔枝红茶'
        return withMemory
          ? call('echo_memory', {
              action: 'remember',
              content: text,
              type: 'preference',
              source: 'user',
              evidence: '本次烟测明确要求保存，并由本机确认',
            })
          : call('remember_note', { text })
      }
      return answer(denied ? 'ACK_MEMORY_DENIED' : 'ACK_MEMORY_SAVED')
    }
    if (last.includes('GROUP_GATE_SKIP') || last.includes('GROUP_MENTION_SILENT')) {
      return answer('GATE_MUST_STAY_SILENT')
    }
    if (last.includes('GROUP_REACT')) {
      assert.ok(contextualText.includes('SMOKE_SHORT_TERM_CURIOUS'))
      assert.equal(contextualText.includes('GATE_MUST_STAY_SILENT'), false)
      return answer('REACTION_MUST_NOT_SEND_TEXT')
    }
    if (last.includes('GROUP_NO_GATE')) {
      draftWithoutGateRan = true
      return answer('ABSENT_GATE_MUST_NOT_SEND_TEXT')
    }
    if (last.includes('GROUP_INVALID_TARGET')) {
      invalidTargetRan = true
      return answer('INVALID_TARGET_MUST_NOT_SEND_TEXT')
    }
    if (last.includes('GROUP_SHARED_RECALL')) {
      assert.ok(serialized.includes('SMOKE_SHARED_LYCHEE'))
      assert.equal(JSON.stringify(users).includes('PRIVATE_ONE'), false)
      assert.equal(JSON.stringify(users).includes('MEMORY_WRITE'), false)
      if (mode === 'replacement') {
        if (lastToolName !== 'recall_note') {
          return call('recall_note', {})
        }
        assert.ok(JSON.stringify(body.messages.at(-1)).includes('SMOKE_SHARED_LYCHEE'))
      }
      return answer('ACK_SHARED_MEMORY_WITHOUT_PRIVATE_HISTORY')
    }
    if (last.includes('PRIVATE_TWO')) {
      assert.ok(JSON.stringify(users.slice(0, -1)).includes('PRIVATE_ONE'))
      return answer('ACK_RESUMED_PRIVATE_HISTORY')
    }
    if (last.includes('IMAGE_PROBE')) {
      imageSeen =
        Array.isArray(currentInput?.content) &&
        currentInput.content.some(
          (part) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/'),
        )
      return answer('ACK_IMAGE\n\n![original](omp-qq-bridge/.runtime/inbox/return.png)')
    }
    if (last.includes('GROUP_ONE')) {
      assert.equal(JSON.stringify(users).includes('PRIVATE_ONE'), false)
      return answer('ACK_GROUP_ONE')
    }
    if (last.includes('NEW_PRIVATE')) {
      assert.equal(JSON.stringify(users).includes('PRIVATE_ONE'), false)
      return answer('ACK_NEW_PRIVATE')
    }
    if (last.includes('NEW_GROUP')) {
      assert.equal(JSON.stringify(users).includes('PRIVATE_ONE'), false)
      return answer('ACK_NEW_GROUP')
    }
    if (last.includes('AFTER_RECONNECT')) {
      return answer('ACK_RECONNECTED')
    }
    answer('ACK_PRIVATE_ONE')
  } catch (error) {
    errors.push(error.stack)
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'smoke assertion failed' } }))
  }
})
const send = (frame) => parent.stdin.write(JSON.stringify(frame) + '\n')
function consume(frame) {
  frames.push(frame)
  if (frame.type === 'ready') {
    ready.resolve(frame)
  }
  if (frame.type === 'extension_error') {
    errors.push(frame.error)
  }
  if (frame.type === 'prompt_result' && frame.agentInvoked === false) {
    localDone.add(frame.id)
  }
  if (frame.type === 'response') {
    if (frame.data?.agentInvoked === false) {
      localDone.add(frame.id)
    }
    const wait = pending.get(frame.id)
    if (wait) {
      pending.delete(frame.id)
      frame.success === false ? wait.reject(new Error(frame.error)) : wait.resolve(frame)
    }
  }
  if (frame.type !== 'extension_ui_request') {
    return
  }
  dialogs.push({ method: frame.method, title: frame.title })
  if (frame.method === 'input') {
    if (!inputQueue.length) {
      throw new Error('Unexpected native input: ' + frame.title)
    }
    send({ type: 'extension_ui_response', id: frame.id, value: inputQueue.shift() })
  } else if (frame.method === 'confirm') {
    send({
      type: 'extension_ui_response',
      id: frame.id,
      confirmed: confirmQueue.length ? confirmQueue.shift() : memoryConsent,
    })
  } else if (frame.method === 'select') {
    assert.ok(frame.options.includes(menuChoice), `Native option unavailable: ${menuChoice}`)
    send({ type: 'extension_ui_response', id: frame.id, value: menuChoice })
  }
}
async function request(type, payload = {}) {
  const id = 'request-' + Math.random().toString(36).slice(2)
  const wait = Promise.withResolvers()
  pending.set(id, wait)
  send({ id, type, ...payload })
  const frame = await wait.promise
  if (type === 'prompt') {
    await until(() => localDone.has(id), 'native slash command', 30000)
  }
  return frame
}
const textSent = (text) =>
  backend.sent.filter((packet) => JSON.stringify(packet.params.message).includes(text))
const emit = (id, text, { user = 12345, group, pointed = false, extra = [] } = {}) => {
  const value = qqMessage(id, {
    user,
    group,
    text,
    segments: [
      { type: 'text', data: { text } },
      ...(pointed ? [{ type: 'at', data: { qq: '10001' } }] : []),
      ...extra,
    ],
  })
  backend.event(value)
  return value
}
async function files(root) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = join(root, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await files(file)))
    } else {
      result.push(file)
    }
  }
  return result
}
async function toggle(choice) {
  menuChoice = choice
  await request('prompt', { message: '/omp-qq-bridge /setting' })
}
async function connected(previous) {
  await until(
    () => [...backend.clients].some((client) => client !== previous),
    'websocket connected',
  )
}
try {
  backend = await onebotServer({ token: 'SMOKE_ONEBOT_TOKEN' })
  const providerUrl = await listen(provider)
  if (withMemory) {
    const personaPath = join(p.memory, 'persona.json')
    const persona = JSON.parse(await readFile(personaPath, 'utf8'))
    persona.name = 'SMOKE_PROJECT_PERSONA'
    await writeFile(personaPath, JSON.stringify(persona))
  } else if (mode === 'replacement') {
    await copyFile(
      new URL('./fixtures/alternate-memory.mjs', import.meta.url),
      join(p.root, 'alternate-memory.mjs'),
    )
  }
  const owner = mode === 'memory-first' ? p.memory : p.bridge
  const agentDir = join(owner, '.runtime', 'omp')
  const sessionDir = join(owner, '.runtime', 'sessions')
  await mkdir(agentDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  await writeFile(
    join(agentDir, 'models.yml'),
    JSON.stringify({
      providers: {
        'bridge-smoke': {
          api: 'openai-completions',
          baseUrl: providerUrl + '/v1',
          apiKey: 'SMOKE_MODEL_KEY',
          headers: { 'x-private': 'SMOKE_MODEL_HEADER' },
          models: [
            {
              id: 'probe',
              name: 'Local probe',
              reasoning: false,
              input: ['text', 'image'],
              contextWindow: 32000,
              maxTokens: 512,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  )
  const env = {
    ...process.env,
    SMOKE_MODEL_KEY: modelKey,
    SMOKE_MODEL_HEADER: privateHeader,
    PI_CODING_AGENT_DIR: agentDir,
    PI_NO_TITLE: '1',
  }
  delete env.OMP_PROFILE
  parent = spawn(
    process.execPath,
    [
      join(owner, 'launch.mjs'),
      ...(mode === 'memory-first' ? ['-e', join(p.bridge, 'index.mjs')] : []),
      ...(mode === 'qq-first' ? ['-e', join(p.memory, 'index.mjs')] : []),
      ...(mode === 'replacement' ? ['-e', join(p.root, 'alternate-memory.mjs')] : []),
      '--mode',
      'rpc-ui',
      '--model',
      'bridge-smoke/probe',
    ],
    { cwd: p.root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  )
  parent.on('error', (error) => {
    errors.push(error.message)
    ready.reject(error)
  })
  parent.stdout.setEncoding('utf8')
  parent.stderr.setEncoding('utf8')
  parent.stderr.on('data', (text) => {
    stderr += text
  })
  parent.stdout.on('data', (text) => {
    buffer += text
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (line.trim()) {
        try {
          consume(JSON.parse(line))
        } catch (error) {
          errors.push(error.stack)
        }
      }
    }
  })
  const startup = setTimeout(
    () => ready.reject(new Error('native omp startup timeout: ' + stderr)),
    30000,
  )
  try {
    await ready.promise
  } finally {
    clearTimeout(startup)
  }
  const available = await request('get_available_commands')
  assert.ok(available.data.commands.some((command) => command.name === 'omp-qq-bridge'))
  assert.equal(
    available.data.commands.some((command) => command.name === 'omp-echo-memory'),
    withMemory,
  )
  inputQueue.push(backend.url, 'SMOKE_ONEBOT_TOKEN')
  confirmQueue.push(...(mode === 'standalone' ? [true] : [true, true]))
  await request('prompt', { message: '/omp-qq-bridge /init' })
  const settings = readSettings(p.root)
  assert.equal(settings.enabled, true)
  assert.equal('chats' in settings, false)
  assert.equal(inputQueue.length, 0)
  await connected()
  const original = emit(1, 'PRIVATE_ONE')
  emit(1, 'GROUP_ONE', { group: 54321 })
  await until(
    () => textSent('ACK_PRIVATE_ONE').length === 1 && textSent('ACK_GROUP_ONE').length === 1,
    'automatic unknown chats',
  )
  assert.equal(textSent('ACK_PRIVATE_ONE')[0].params.user_id, 12345)
  assert.equal(textSent('ACK_GROUP_ONE')[0].params.group_id, 54321)
  emit(1, 'NEW_PRIVATE', { user: 23456 })
  emit(1, 'NEW_GROUP', { user: 34567, group: 77777, pointed: true })
  await until(
    () => textSent('ACK_NEW_PRIVATE').length === 1 && textSent('ACK_NEW_GROUP').length === 1,
    'new private/group without configuration',
  )
  if (mode !== 'standalone') {
    emit(2, 'MEMORY_WRITE SMOKE_SHARED_LYCHEE')
    await until(() => textSent('ACK_MEMORY_SAVED').length === 1, 'native memory confirmation')
    emit(2, 'GROUP_SHARED_RECALL SMOKE_SHARED_LYCHEE', { group: 54321, pointed: true })
    await until(
      () => textSent('ACK_SHARED_MEMORY_WITHOUT_PRIVATE_HISTORY').length === 1,
      'shared memory independent context',
    )
    memoryConsent = false
    emit(3, 'MEMORY_DENY')
    await until(() => textSent('ACK_MEMORY_DENIED').length === 1, 'memory denial')
    let stored
    if (withMemory) {
      const { openProjectMemory } = await import('omp-echo-memory/api')
      const memory = await openProjectMemory(p.root, p.memory)
      stored = await memory.execute(
        'echo_memory',
        { action: 'list', includeDormant: true },
        { origin: 'smoke inspection', signal: new AbortController().signal },
      )
    } else {
      stored = JSON.parse(await readFile(join(p.root, '.alternate-memory.json'), 'utf8'))
      assert.ok(declaredTools.has('remember_note'))
      assert.ok(declaredTools.has('recall_note'))
    }
    assert.equal(JSON.stringify(stored).includes('SMOKE_DENIED_YUZU'), false)
    memoryConsent = true
  }
  await writeFile(join(p.root, 'allowed-check.txt'), 'ALLOWED_FILE_CONTENT_SENTINEL')
  await writeFile(join(p.root, 'denied-check.txt'), 'DENIED_FILE_CONTENT_SENTINEL')
  emit(2, 'READ_ALLOW', { user: 23456 })
  await until(() => textSent('ACK_READ_ALLOWED').length === 1, 'native computer read confirmation')
  memoryConsent = false
  emit(3, 'READ_DENY', { user: 23456 })
  await until(
    () => textSent('ACK_READ_DENIED').length === 1,
    'computer read blocked without consent',
  )
  memoryConsent = true
  assert.ok(
    dialogs.filter((dialog) => dialog.method === 'confirm' && dialog.title.includes('读取电脑数据'))
      .length >= 2,
  )
  emit(3, 'GROUP_GATE_SKIP', { user: 45678, group: 54321 })
  await until(() => gateRuns.has('3'), 'unmentioned member reaches real native reply gate')
  await delay(150)
  assert.equal(textSent('GATE_MUST_STAY_SILENT').length, 0)
  emit(4, 'GROUP_MENTION_SILENT', { user: 45678, group: 54321, pointed: true })
  await until(() => gateRuns.has('4'), 'mention remains semantic evidence, not an order to reply')
  await delay(150)
  assert.equal(textSent('GATE_MUST_STAY_SILENT').length, 0)
  emit(-5, 'GROUP_REACT', { user: 45678, group: 54321 })
  await until(
    () => backend.reactions.get('10001:-5')?.get('128077')?.count === 1,
    'native reaction reaches the simulated OneBot API using a real negative message ID',
  )
  const reactionProbe = new WebSocket(backend.url + '?access_token=SMOKE_ONEBOT_TOKEN')
  try {
    await once(reactionProbe, 'open')
    const received = once(reactionProbe, 'message')
    reactionProbe.send(
      JSON.stringify({
        action: 'get_msg_emoji_likes',
        params: { message_id: -5 },
        echo: 'reaction-readback',
      }),
    )
    const [raw] = await received
    const likes = JSON.parse(raw.toString())
    assert.equal(likes.status, 'ok')
    assert.equal(likes.echo, 'reaction-readback')
    assert.deepEqual(likes.data, [
      {
        emoji_id: '128077',
        emoji_type: '1',
        count: 1,
        users: [{ user_id: 10001 }],
      },
    ])
  } finally {
    const closed = once(reactionProbe, 'close')
    reactionProbe.close()
    await closed
  }
  assert.equal(textSent('REACTION_MUST_NOT_SEND_TEXT').length, 0)
  emit(6, 'GROUP_NO_GATE', { user: 45678, group: 54321 })
  await until(
    () => draftWithoutGateRan,
    'model draft without a gate is retained only as a private draft',
  )
  await delay(150)
  assert.equal(textSent('ABSENT_GATE_MUST_NOT_SEND_TEXT').length, 0)
  emit(7, 'GROUP_INVALID_TARGET', { user: 45678, group: 54321 })
  await until(() => invalidTargetRan, 'unobserved target is rejected through the native callback')
  await delay(150)
  assert.equal(textSent('INVALID_TARGET_MUST_NOT_SEND_TEXT').length, 0)
  const old = [...backend.clients][0]
  await toggle('停止桥接')
  assert.equal(readSettings(p.root).enabled, false)
  confirmQueue.push(true)
  await toggle('启用桥接')
  await connected(old)
  backend.event(original)
  emit(4, 'PRIVATE_TWO')
  await until(() => textSent('ACK_RESUMED_PRIVATE_HISTORY').length === 1, 'persisted auto context')
  assert.equal(textSent('ACK_PRIVATE_ONE').length, 1)
  const inbox = join(p.bridge, '.runtime', 'inbox')
  await mkdir(inbox, { recursive: true })
  await writeFile(join(inbox, 'return.png'), Buffer.from(png, 'base64'))
  emit(5, 'IMAGE_PROBE', { extra: [{ type: 'image', data: { file: 'base64://' + png } }] })
  await until(
    () =>
      textSent('ACK_IMAGE').length === 1 &&
      backend.sent.some((packet) =>
        packet.params.message.some(
          (part) => part.type === 'image' && part.data.file === 'base64://' + png,
        ),
      ),
    'large image event and original output',
  )
  assert.equal(imageSeen, true)
  emit(6, 'ABORT_PROBE')
  await until(() => abortStarted, 'turn active during disconnect')
  const disconnected = [...backend.clients][0]
  backend.disconnect()
  await connected(disconnected)
  emit(7, 'AFTER_RECONNECT')
  await until(() => textSent('ACK_RECONNECTED').length === 1, 'automatic reconnect')
  assert.equal(abortCalls, 1, 'accepted interrupted input is not replayed')
  abortStarted = false
  emit(8, 'ABORT_PROBE_SECOND')
  await until(() => abortStarted, 'turn active during stop')
  const before = backend.sent.length
  await toggle('停止桥接')
  await delay(100)
  assert.equal(backend.sent.length, before)
  assert.equal(
    backend.requests.some((packet) => /history|friend_list|group_list/.test(packet.action)),
    false,
  )
  for (const file of await files(join(p.bridge, '.runtime'))) {
    const data = await readFile(file)
    assert.equal(data.includes(Buffer.from(modelKey)), false, `key persisted: ${file}`)
    assert.equal(data.includes(Buffer.from(privateHeader)), false, `header persisted: ${file}`)
  }
  if (!withMemory) {
    await assert.rejects(readFile(join(p.memory, 'project.json')), { code: 'ENOENT' })
  }
  console.log(
    JSON.stringify(
      {
        actualOmp: true,
        composition: mode,
        memoryProviderInstalled: withMemory,
        forwardWebSocket: true,
        noChatConfiguration: true,
        newPrivateAndGroup: true,
        allMembersReceived: true,
        ownEchoIgnored: true,
        semanticReplyReactAndSilence: true,
        mentionCanStaySilent: true,
        shortTermContextWithoutPrivilegedChatText: true,
        sharedMemoryWithNativeConsent: mode !== 'standalone',
        computerReadConsentAndDenial: true,
        separateChatContexts: true,
        restartAndDedup: true,
        reconnectNoReplay: true,
        largeImageRoundtrip: true,
        stopCancelsTurn: true,
        modelCredentialsNotPersisted: true,
        simulatedOneBotAndModel: true,
        modelRequests: requests.length,
      },
      null,
      2,
    ),
  )
} finally {
  if (parent?.pid && parent.exitCode === null && parent.signalCode === null) {
    const exit = new Promise((resolve) => parent.once('close', resolve))
    parent.stdin.end()
    const kill = setTimeout(() => parent.kill('SIGKILL'), 10000)
    await exit
    clearTimeout(kill)
  }
  await backend?.close()
  await stopServer(provider)
  await removeProject()
}

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createBridge } from '../../lib/host.js'

export async function fixture(t, { config: patch = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'omp-qq-host-'))
  const events = new EventEmitter()
  const calls = []
  const contexts = []
  const requests = []
  const sent = []
  const actors = new Map()
  const bridges = []
  const waits = []
  let selfId = '10001'
  let epoch = 1
  let connected = true
  let ready = true
  let sequence = 80000
  let requestHook = null
  const settings = {
    enabled: true,
    speechCommand: '',
    batchWindowSeconds: 0,
    maxBatchAgeSeconds: 2,
    maxBatchSize: 8,
    ...patch,
  }
  const eventSource = new EventEmitter()
  const stateSource = new EventEmitter()
  const onebot = {
    status: () => ({ connected, ready, selfId, epoch }),
    onEvent: (fn) => {
      eventSource.on('event', fn)
      return () => eventSource.off('event', fn)
    },
    onState: (fn) => {
      stateSource.on('state', fn)
      return () => stateSource.off('state', fn)
    },
    request: async (action, params, options = {}) => {
      const req = { action, body: params, options }
      requests.push(req)
      if (options.signal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
      if (requestHook) {
        const result = await requestHook(req)
        if (result !== undefined) {
          return result
        }
      }
      if (action === 'get_forward_msg') {
        return { messages: [] }
      }
      if (action === 'set_msg_emoji_like') {
        return {}
      }
      if (action.startsWith('send_')) {
        sent.push(req)
        return { message_id: ++sequence }
      }
      throw Error('Unexpected OneBot action ' + action)
    },
  }
  const ensure = (id) => {
    if (actors.has(id)) {
      return actors.get(id)
    }
    const actor = {
      busy: false,
      tools: new Map(),
      follow: null,
      flush: null,
      onTurn: null,
      registerTool(tool) {
        this.tools.set(tool.name, tool)
      },
      async followup(prompt, options) {
        calls.push({ id, prompt, attachments: options.attachments })
        await this.follow?.(prompt, options)
        options.onAccepted?.()
        await this.onTurn?.(prompt, options)
        await this.flush?.()
      },
    }
    actors.set(id, actor)
    return actor
  }
  const mount = () => {
    const bridge = createBridge({
      directory: root,
      projectRoot: root,
      readConfig: () => settings,
      onebot,
      agents: {
        get: (id, chat, context) => {
          contexts.push({ id, chat, context })
          return ensure(id)
        },
        release() {},
      },
      logger: { info() {} },
      onSessionEvent: (fn) => {
        events.on('session', fn)
        return () => events.off('session', fn)
      },
      effect: () => {},
    })
    bridges.push(bridge)
    return bridge
  }
  const bridge = mount()
  t.after(async () => {
    waits.forEach((w) => w.resolve())
    bridges.forEach((b) => b.stop())
    await Promise.all(bridges.map((b) => b.drain()))
    rmSync(root, { recursive: true, force: true })
  })
  const message = (
    id,
    {
      type = 'private',
      chat = type === 'group' ? '54321' : '12345',
      user = type === 'private' ? chat : '22222',
      text = `message-${id}`,
      segments,
      time = Math.floor(Date.now() / 1000),
    } = {},
  ) => ({
    post_type: 'message',
    message_type: type,
    self_id: selfId,
    message_id: id,
    time,
    user_id: user,
    ...(type === 'group' ? { group_id: chat } : {}),
    message: segments || [{ type: 'text', data: { text } }],
    sender: { user_id: user, nickname: 'member-' + user },
  })
  return {
    root,
    bridge,
    mount,
    config: settings,
    calls,
    requests,
    sent,
    contexts,
    actor: ensure,
    onebot,
    message,
    deliver: (e) => eventSource.emit('event', e),
    connect: (id = selfId) => {
      selfId = String(id)
      connected = true
      ready = true
      epoch++
      stateSource.emit('state', { connected, ready, selfId, epoch })
    },
    disconnect: () => {
      connected = false
      ready = false
      epoch++
      stateSource.emit('state', { connected, ready, selfId, epoch })
    },
    sessionEvent: (id, event) => events.emit('session', id, event),
    reply: (id, text, turn = 'turn-1', status = 'completed') => {
      events.emit('session', id, { type: 'turn/start', turn })
      if (text !== undefined) {
        events.emit('session', id, {
          type: 'assistant/message',
          turn,
          message: { content: [{ type: 'text', text }] },
        })
      }
      events.emit('session', id, { type: 'turn/end', turn, status })
    },
    defer: () => {
      const w = Promise.withResolvers()
      waits.push(w)
      return w
    },
    requestHook: (fn) => {
      requestHook = fn
    },
  }
}
export async function settle() {
  for (let i = 0; i < 12; i++) {
    await new Promise(setImmediate)
  }
}

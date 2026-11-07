import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  readSettings,
  writeSettings,
  defaultSettings,
  writeJson,
  settingsPaths,
} from '../lib/config.mjs'
import { project } from './fixtures/project.mjs'

async function host(t) {
  const p = await project(t, { memory: false })
  const handlers = new Map()
  const commands = new Map()
  const messages = []
  const extension = (await p.extension()).default
  extension({
    events: new EventEmitter(),
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    sendMessage: (message) => messages.push(message.content),
  })
  const ctx = {
    cwd: p.root,
    agent: { kind: 'main' },
    hasUI: true,
    sessionManager: { getSessionId: () => 'main-session' },
    ui: {},
  }
  await handlers.get('session_start')({}, ctx)
  t.after(() => handlers.get('session_shutdown')({}, ctx))
  return {
    ...p,
    ctx,
    handlers,
    commands,
    messages,
    run: (args) => commands.get('omp-qq-bridge').handler(args, { ...ctx }),
  }
}

test('QQ-only initialization stays disabled when the operator declines all-chat enable', async (t) => {
  const f = await host(t)
  const inputs = ['', '']
  const confirms = [false]
  f.ctx.ui.input = async () => inputs.shift()
  f.ctx.ui.confirm = async () => confirms.shift()
  await f.run('/init')
  const settings = readSettings(f.root)
  assert.equal(settings.enabled, false)
})

test('setting accepts a native selected label and a blank token clears the connection token', async (t) => {
  const f = await host(t)
  writeSettings(f.root, { ...defaultSettings(f.root), token: 'old-private-token' })
  const inputs = ['ws://127.0.0.1:4999', '']
  f.ctx.ui.select = async (_title, options) =>
    options.find((option) => option.label === '修改 QQ 连接').label
  f.ctx.ui.input = async () => inputs.shift()
  await f.run('/setting')
  const settings = readSettings(f.root)
  assert.equal(settings.onebotUrl, 'ws://127.0.0.1:4999')
  assert.equal(settings.token, '')
})
test('cancelled dialog leaves an existing project configuration untouched', async (t) => {
  const f = await host(t)
  const previous = writeSettings(f.root, { ...defaultSettings(f.root) })
  f.ctx.ui.select = async () => undefined
  await f.run('/setting')
  assert.deepEqual(readSettings(f.root), previous)
})
test('same-project v3 settings require explicit reinitialization and outside-project settings reject', async (t) => {
  const f = await host(t)
  const foreign = await project(t)
  const legacy = {
    ...defaultSettings(f.root),
    version: 3,
    onebotUrl: 'http://127.0.0.1:3000',
    chats: [{ type: 'private', id: '12345' }],
    enabled: true,
  }
  writeJson(settingsPaths(f.root).settingsFile, legacy)
  assert.equal(readSettings(f.root), null)
  await f.run('/setting')
  assert.match(f.messages.at(-1), /全聊天接入/)
  writeJson(settingsPaths(f.root).settingsFile, { ...legacy, projectRoot: foreign.root })
  assert.throws(() => readSettings(f.root))
})

test('switching projects while init is waiting cannot save stale answers anywhere', async (t) => {
  const f = await host(t)
  const foreign = await project(t)
  const waiting = Promise.withResolvers()
  let dialogSignal
  f.ctx.ui.input = async (_title, _placeholder, options) => {
    dialogSignal = options.signal
    return waiting.promise
  }
  const pending = f.run('/init')
  await f.handlers.get('session_switch')(
    {},
    { ...f.ctx, cwd: foreign.root, sessionManager: { getSessionId: () => 'foreign' } },
  )
  assert.equal(dialogSignal.aborted, true)
  waiting.resolve('http://127.0.0.1:3000')
  await pending
  assert.equal(readSettings(f.root), null)
  assert.equal(readSettings(foreign.root), null)
})

test('shutdown cancels a blocked dialog without waiting for user input', async (t) => {
  const f = await host(t)
  const waiting = Promise.withResolvers()
  let signal
  f.ctx.ui.input = async (_title, _placeholder, options) => {
    signal = options.signal
    return waiting.promise
  }
  const pending = f.run('/init')
  await f.handlers.get('session_shutdown')({}, f.ctx)
  assert.equal(signal.aborted, true)
  waiting.resolve('')
  await pending
  assert.equal(readSettings(f.root), null)
})

test('an extension loaded outside its owning project never registers commands or initializes data', async (t) => {
  const owner = await project(t)
  const foreign = await project(t)
  const handlers = new Map()
  const commands = []
  ;(await owner.extension()).default({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (...args) => commands.push(args),
    sendMessage: () => {},
  })
  await handlers.get('session_start')(
    {},
    { cwd: foreign.root, agent: { kind: 'main' }, sessionManager: { getSessionId: () => 'other' } },
  )
  assert.equal(commands.length, 0)
  assert.equal(readSettings(owner.root), null)
  assert.equal(readSettings(foreign.root), null)
})

test('configuring an external speech command requires separate consent; clearing it does not', async (t) => {
  const f = await host(t)
  writeSettings(f.root, { ...defaultSettings(f.root) })
  f.ctx.ui.select = async (_title, options) =>
    options.find((option) => option.label === '语音转写（可选）').label
  f.ctx.ui.input = async () => 'node trusted-asr "{file}"'
  f.ctx.ui.confirm = async () => false
  await f.run('/setting')
  assert.equal(readSettings(f.root).speechCommand, '')
  f.ctx.ui.confirm = async () => true
  await f.run('/setting')
  assert.equal(readSettings(f.root).speechCommand, 'node trusted-asr "{file}"')
  f.ctx.ui.input = async () => ''
  f.ctx.ui.confirm = async () => {
    throw new Error('clearing must not ask to execute a command')
  }
  await f.run('/setting')
  assert.equal(readSettings(f.root).speechCommand, '')
})

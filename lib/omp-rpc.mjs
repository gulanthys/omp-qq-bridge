import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { plainPath } from './config.mjs'

const extensionPath = fileURLToPath(new URL('./omp-extension.mjs', import.meta.url))
const MAX_FRAME = 1024 * 1024
const MAX_LOGICAL = 64 * 1024 * 1024

export class OmpAgent {
  constructor({
    id,
    cwd,
    agentDir,
    sessionDir,
    command = 'omp',
    modelSource,
    tools = ['read', 'grep', 'glob'],
    extensions = [],
    env = {},
    callbackUrl,
    callbackToken,
    memoryTools = [],
    timeoutMs = 300000,
    onEvent = () => {},
    onDiagnostic = () => {},
  }) {
    if (!modelSource || typeof modelSource.getAuth !== 'function' || !modelSource.model) {
      throw new Error('OmpAgent requires a modelSource')
    }
    Object.assign(this, {
      id,
      cwd,
      agentDir,
      sessionDir,
      command: modelSource.executable || command,
      modelSource,
      tools,
      extensions,
      env,
      callbackUrl,
      callbackToken,
      memoryTools,
      timeoutMs,
      onEvent,
      onDiagnostic,
    })
    this.session = { id }
    this.toolsByName = new Map()
    this.pending = new Map()
    this.active = false
    this.closed = false
    this.ready = false
    this.proc = null
    this.startPromise = null
    this.turn = null
    this.cancelRequested = false
    this.buffer = ''
    this.chunks = null
    this.maxFrame = MAX_FRAME
    this.modelFingerprint = null
  }

  get busy() {
    return this.active || Boolean(this.startPromise && !this.ready)
  }

  async ensureStarted() {
    if (this.closed) {
      throw new Error('omp 会话已关闭')
    }
    const controller = new AbortController()
    this.authController = controller
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 60000))
    let abort
    let auth
    try {
      auth = await new Promise((resolve, reject) => {
        abort = () => reject(new Error('模型认证已取消或超时'))
        controller.signal.addEventListener('abort', abort, { once: true })
        Promise.resolve()
          .then(() => this.modelSource.getAuth())
          .then(resolve, reject)
      })
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', abort)
      if (this.authController === controller) {
        this.authController = undefined
      }
    }
    if (this.closed || this.cancelRequested) {
      throw new Error('omp 启动已取消')
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ model: this.modelSource.model, auth }))
      .digest('hex')
    if (this.proc && this.ready && this.modelFingerprint !== fingerprint) {
      await this.stopProcess()
    }
    this.startAuth = auth
    this.modelFingerprint = fingerprint
    if (this.ready) {
      return
    }
    if (!this.startPromise) {
      this.startPromise = this.start().catch(async (error) => {
        await this.stopProcess()
        this.startPromise = null
        throw error
      })
    }
    await this.startPromise
  }

  async start() {
    plainPath(this.agentDir)
    plainPath(this.sessionDir)
    await Promise.all([
      mkdir(this.agentDir, { recursive: true }),
      mkdir(this.sessionDir, { recursive: true }),
    ])
    const overlay = join(this.sessionDir, 'bridge-config.yml')
    const modelPath = join(this.agentDir, 'models.yml')
    plainPath(this.agentDir)
    plainPath(this.sessionDir)
    plainPath(overlay)
    plainPath(modelPath)
    const auth = this.startAuth || {}
    const envName = `OMP_QQ_BRIDGE_MODEL_KEY_${createHash('sha256').update(this.id).digest('hex').slice(0, 12).toUpperCase()}`
    const headerEnv = {}
    const headers = {}
    let index = 0
    for (const [name, value] of Object.entries(auth.headers || {})) {
      const reference = `OMP_QQ_BRIDGE_MODEL_HEADER_${createHash('sha256').update(this.id).digest('hex').slice(0, 8).toUpperCase()}_${index++}`
      headers[name] = reference
      headerEnv[reference] = value
    }
    const model = { ...this.modelSource.model }
    if (model.compat) {
      model.compat = { ...model.compat }
      // Registry default; models.yml only permits explicit all_strict/none.
      if (model.compat.toolStrictMode === 'mixed') {
        delete model.compat.toolStrictMode
      }
      delete model.compat.isOpenRouterHost
      delete model.compat.isVercelGatewayHost
    }
    const provider = { api: model.api, baseUrl: model.baseUrl, apiKey: envName, models: [model] }
    delete model.provider
    if (Object.keys(headers).length) {
      provider.headers = headers
    }
    await writeFile(overlay, 'memory:\n  backend: off\nautolearn:\n  enabled: false\n', {
      mode: 0o600,
    })
    await writeFile(
      modelPath,
      JSON.stringify({ providers: { [this.modelSource.model.provider]: provider } }),
      { mode: 0o600 },
    )
    if (this.closed || this.cancelRequested) {
      throw new Error('omp 启动已取消')
    }
    const args = [
      '--mode',
      'rpc',
      '--no-ui',
      '--continue',
      '--cwd',
      this.cwd,
      '--session-dir',
      this.sessionDir,
      '--config',
      overlay,
      '--model',
      `${this.modelSource.model.provider}/${this.modelSource.model.id}`,
      '--approval-mode',
      'write',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--no-context-files',
      '--no-lsp',
      '--no-title',
      '-e',
      extensionPath,
    ]
    if (this.tools.length) {
      args.push('--tools', this.tools.join(','))
    } else {
      args.push('--no-tools')
    }
    for (const extension of this.extensions) {
      args.push('-e', extension)
    }
    const env = {
      ...process.env,
      ...this.env,
      ...(auth.env || {}),
      [envName]: auth.apiKey || '',
      ...headerEnv,
      PI_CODING_AGENT_DIR: this.agentDir,
      PI_NO_TITLE: '1',
      OMP_QQ_BRIDGE_MEMORY_TOOLS: JSON.stringify(this.memoryTools),
    }
    delete env.OMP_PROFILE
    if (this.callbackUrl && this.callbackToken) {
      env.OMP_QQ_BRIDGE_CALLBACK_URL = this.callbackUrl
      env.OMP_QQ_BRIDGE_CALLBACK_TOKEN = this.callbackToken
      env.OMP_QQ_BRIDGE_TURN_FILE = join(this.agentDir, 'callback-turn.json')
    }
    this.buffer = ''
    this.chunks = null
    this.maxFrame = MAX_FRAME
    const ready = Promise.withResolvers()
    this.readyWaiter = ready
    const child = spawn(this.command, args, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
    this.proc = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (bytes) => {
      if (this.proc === child) {
        this.consume(bytes)
      }
    })
    child.stderr.on('data', (bytes) => this.onDiagnostic(String(bytes).slice(-4000)))
    child.stdin.on('error', (error) => {
      if (this.proc === child) {
        this.failAll(error)
      }
    })
    child.on('error', (error) => {
      if (this.proc === child) {
        this.failAll(error)
      }
    })
    child.on('exit', (code, signal) => {
      if (this.proc !== child) {
        return
      }
      this.proc = null
      this.ready = false
      this.startPromise = null
      this.failAll(new Error(`omp 退出（${code ?? signal}）`))
    })
    const timer = setTimeout(
      () => ready.reject(new Error('omp RPC 启动超时')),
      Math.min(this.timeoutMs, 60000),
    )
    let frame
    try {
      frame = await ready.promise
    } finally {
      clearTimeout(timer)
      this.readyWaiter = null
    }
    if (frame.supportedProtocolVersions?.includes(2)) {
      await this.request('negotiate_protocol', { protocolVersion: 2 })
    }
    this.ready = true
  }

  consume(bytes) {
    this.buffer += bytes
    try {
      let index
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 1)
        if (!line.trim()) {
          continue
        }
        if (Buffer.byteLength(line) + 1 > this.maxFrame) {
          throw new Error('omp RPC 物理帧超出上限')
        }
        this.frame(JSON.parse(line))
      }
      if (Buffer.byteLength(this.buffer) > this.maxFrame) {
        throw new Error('omp RPC 未结束的帧超出上限')
      }
    } catch (error) {
      this.onDiagnostic(`omp RPC 协议错误：${error.message}`)
      this.failAll(error)
      void this.stopProcess()
    }
  }

  frame(frame) {
    if (!frame || typeof frame !== 'object') {
      throw new Error('无效 RPC 帧')
    }
    if (frame.type === 'rpc_chunk') {
      if (
        !Number.isSafeInteger(frame.count) ||
        frame.count < 1 ||
        frame.count > MAX_LOGICAL ||
        !Number.isSafeInteger(frame.index) ||
        frame.index < 0 ||
        !Number.isSafeInteger(frame.byteLength) ||
        frame.byteLength < 1 ||
        frame.byteLength > MAX_LOGICAL ||
        typeof frame.chunkId !== 'string'
      ) {
        throw new Error('无效 RPC 分块声明')
      }
      if (!this.chunks) {
        if (frame.index !== 0) {
          throw new Error('RPC 分块不从零开始')
        }
        this.chunks = {
          id: frame.chunkId,
          count: frame.count,
          length: frame.byteLength,
          index: 0,
          size: 0,
          parts: [],
        }
      }
      const sequence = this.chunks
      if (
        frame.chunkId !== sequence.id ||
        frame.index !== sequence.index ||
        frame.count !== sequence.count ||
        frame.byteLength !== sequence.length
      ) {
        throw new Error('RPC 分块乱序')
      }
      if (
        typeof frame.data !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)
      ) {
        throw new Error('无效 RPC 分块编码')
      }
      const part = Buffer.from(frame.data, 'base64')
      sequence.size += part.length
      if (!part.length || sequence.size > sequence.length) {
        throw new Error('RPC 分块超过声明长度')
      }
      sequence.parts.push(part)
      sequence.index++
      if (sequence.index === sequence.count) {
        this.chunks = null
        if (sequence.size !== sequence.length) {
          throw new Error('RPC 分块长度不匹配')
        }
        this.frame(
          JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
              Buffer.concat(sequence.parts, sequence.size),
            ),
          ),
        )
      }
      return
    }
    if (this.chunks) {
      throw new Error('RPC 分块被其他帧打断')
    }
    if (frame.type === 'ready') {
      if (Number.isSafeInteger(frame.maxFrameBytes) && frame.maxFrameBytes > 0) {
        this.maxFrame = Math.min(frame.maxFrameBytes, MAX_FRAME)
      }
      this.readyWaiter?.resolve(frame)
      return
    }
    if (frame.type === 'response') {
      const pending = this.pending.get(frame.id)
      if (!pending) {
        return
      }
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.success === false) {
        pending.reject(new Error(frame.error || 'omp RPC 请求失败'))
      } else {
        pending.resolve(frame)
      }
      return
    }
    if (frame.type === 'extension_ui_request') {
      if (frame.id && ['confirm', 'select', 'input', 'editor', 'custom'].includes(frame.method)) {
        this.send({
          type: 'extension_ui_response',
          id: frame.id,
          cancelled: true,
          confirmed: false,
        })
      }
      return
    }
    if (frame.type === 'extension_error') {
      this.onDiagnostic(`omp 扩展错误：${frame.error}`)
      this.failAll(new Error('omp 安全扩展加载或执行失败，拒绝接收 QQ 输入'))
      void this.stopProcess()
      return
    }
    const turn = this.turn
    if (!turn) {
      return
    }
    if (frame.type === 'message_end') {
      this.rememberAssistant(frame.message)
    } else if (frame.type === 'agent_end') {
      if (!turn.sawAssistant && Array.isArray(frame.messages)) {
        for (const message of frame.messages) {
          this.rememberAssistant(message)
        }
      }
    } else if (frame.type === 'prompt_result' && frame.id === turn.requestId) {
      if (frame.status !== 'completed') {
        const error = new Error(
          typeof frame.error === 'string'
            ? frame.error
            : frame.error?.message || `omp 处理${frame.status === 'aborted' ? '已取消' : '失败'}`,
        )
        this.finish(frame.status === 'aborted' ? 'interrupted' : 'failed', error)
      } else if (turn.cancelled) {
        this.finish('interrupted', new Error('omp 处理已取消'))
      } else if (frame.sessionSettled === false) {
        turn.waitingForSettlement = true
      } else {
        this.finish('completed')
      }
    } else if (frame.type === 'session_settled' && turn.waitingForSettlement) {
      this.finish(turn.cancelled ? 'interrupted' : 'completed')
    }
  }

  rememberAssistant(message) {
    if (!this.turn || message?.role !== 'assistant') {
      return
    }
    this.turn.sawAssistant = true
    this.turn.lastMessage = message
  }

  finish(kind, error) {
    const turn = this.turn
    if (!turn) {
      return
    }
    this.turn = null
    clearTimeout(turn.timer)
    if (kind === 'completed') {
      const message = turn.lastMessage
      if (message && !['toolUse', 'error', 'aborted'].includes(message.stopReason)) {
        const content = (message.content || []).filter(
          (block) => block.type === 'text' || block.type === 'image',
        )
        if (content.length) {
          this.onEvent(this.session, {
            type: 'assistant/message',
            turn: turn.requestId,
            message: { role: 'assistant', content },
          })
        }
      }
    }
    this.onEvent(this.session, { type: 'turn/end', turn: turn.requestId, status: kind })
    if (kind === 'completed') {
      turn.completion.resolve()
    } else {
      const failure = error || new Error('omp 处理已取消')
      failure.accepted = turn.accepted
      turn.completion.reject(failure)
    }
  }

  send(frame) {
    if (!this.proc || this.closed || this.proc.stdin.destroyed) {
      throw new Error('omp RPC 进程不可用')
    }
    this.proc.stdin.write(JSON.stringify(frame) + '\n')
  }

  request(type, payload = {}, { id = randomUUID(), onWrite, timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`omp RPC ${type} 超时`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ id, type, ...payload })
        onWrite?.()
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async followup(prompt, { attachments = [], onAccepted, signal, context } = {}) {
    if (this.active || this.closed) {
      throw new Error('omp 会话正在执行或已关闭')
    }
    if (typeof prompt !== 'string') {
      throw new Error('无效 QQ 消息')
    }
    const text = prompt
    const images = []
    for (const item of attachments) {
      if (
        !item ||
        item.type !== 'image' ||
        typeof item.mimeType !== 'string' ||
        typeof item.data !== 'string'
      ) {
        throw new Error('不支持的 QQ 内容格式')
      }
      images.push({ type: 'image', data: item.data, mimeType: item.mimeType })
    }
    if (/^\s*(?:\/|!)/.test(text)) {
      throw new Error('QQ 输入不能执行 slash 或本机命令')
    }
    if (!text.trim() && !images.length) {
      throw new Error('QQ 输入不能为空')
    }
    if (signal?.aborted) {
      throw new Error('omp 处理已取消')
    }
    this.active = true
    this.cancelRequested = false
    const onAbort = () => {
      void this.cancel().catch(() => this.onDiagnostic('QQ 回合取消失败'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    let accepted = false
    try {
      await this.ensureStarted()
      if (this.cancelRequested || this.closed) {
        throw new Error('omp 处理已取消')
      }
      const requestId = randomUUID()
      if (this.callbackUrl && this.callbackToken) {
        const turnFile = join(this.agentDir, 'callback-turn.json')
        plainPath(turnFile)
        await writeFile(turnFile, JSON.stringify({ turn: requestId }), { mode: 0o600 })
        if (this.cancelRequested || this.closed) {
          throw new Error('omp 处理已取消')
        }
      }
      const completion = Promise.withResolvers()
      const turn = {
        requestId,
        completion,
        accepted: false,
        cancelled: false,
        waitingForSettlement: false,
        lastMessage: null,
        sawAssistant: false,
      }
      this.turn = turn
      turn.timer = setTimeout(() => {
        this.finish('failed', new Error('omp 本轮执行超时；不自动重试'))
        this.failPending(new Error('omp 本轮执行超时'))
        void this.stopProcess()
      }, this.timeoutMs)
      const acknowledgement = this.request(
        'prompt',
        { message: text, ...(images.length ? { images } : {}) },
        {
          id: requestId,
          onWrite: () => {
            accepted = true
            turn.accepted = true
            onAccepted?.()
            this.onEvent(this.session, { type: 'turn/start', turn: requestId, context })
          },
        },
      ).then((response) => {
        if (response.data?.agentInvoked === false && this.turn === turn) {
          this.finish('completed')
        }
      })
      await Promise.all([acknowledgement, completion.promise])
    } catch (error) {
      if (this.turn) {
        this.finish('failed', error)
      }
      if (accepted) {
        error.accepted = true
        await this.stopProcess()
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.active = false
    }
  }

  async cancel() {
    if (!this.active) {
      return
    }
    this.cancelRequested = true
    this.authController?.abort()
    if (this.turn) {
      this.turn.cancelled = true
    }
    const completion = this.turn?.completion.promise.catch(() => {
      // Cancellation may reject completion; this waiter only waits for the turn to settle.
    })
    try {
      if (this.ready) {
        const abort = this.request('abort', {}, { timeoutMs: 3000 })
        await (completion ? Promise.race([abort, completion]) : abort)
      }
    } catch (error) {
      if (!this.closed) {
        throw error
      }
    } finally {
      if (this.turn) {
        this.finish('interrupted', new Error('omp 处理已取消'))
      }
      this.failPending(new Error('omp 处理已取消'))
      this.readyWaiter?.reject(new Error('omp 启动已取消'))
      await this.stopProcess()
    }
  }

  registerTool(definition) {
    this.toolsByName.set(definition.name, definition)
    return () => {
      if (this.toolsByName.get(definition.name) === definition) {
        this.toolsByName.delete(definition.name)
      }
    }
  }
  async executeTool(name, args, { signal } = {}) {
    if (signal?.aborted) {
      throw new Error('工具操作已取消')
    }
    const tool = this.toolsByName.get(name)
    if (!tool) {
      throw new Error('未知桥接工具')
    }
    return tool.execute(args, { signal })
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
  failAll(error) {
    this.readyWaiter?.reject(error)
    this.failPending(error)
    if (this.turn) {
      this.finish('failed', error)
    }
  }

  async stopProcess() {
    if (this.stopPromise) {
      return this.stopPromise
    }
    const child = this.proc
    this.proc = null
    this.ready = false
    this.startPromise = null
    if (!child) {
      return
    }
    this.stopPromise = (async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return
      }
      let timer
      const exited = new Promise((resolve) => child.once('close', resolve))
      try {
        child.stdin.end()
        timer = setTimeout(() => child.kill('SIGKILL'), 3000)
        await exited
      } finally {
        clearTimeout(timer)
      }
    })().finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise
  }

  async close() {
    if (this.closed) {
      return this.stopPromise
    }
    this.closed = true
    this.cancelRequested = true
    this.authController?.abort()
    const error = new Error('omp 会话已关闭')
    this.readyWaiter?.reject(error)
    if (this.turn) {
      this.finish('interrupted', error)
    }
    this.failPending(error)
    await this.stopProcess()
  }
}

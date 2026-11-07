import { randomUUID } from 'node:crypto'

const identity = (value) => {
  const id = String(value ?? '')
  return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? id : null
}
const failure = (code, message) => Object.assign(new Error(message), { code })

/** Forward OneBot WS '/' endpoint: events and echo-correlated API calls. */
export function createOneBot({ url, token = '', onEvent = () => {}, onState = () => {} }) {
  const base = new URL(url)
  if (
    !['ws:', 'wss:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('需要无内嵌凭据的 OneBot 正向 WebSocket 地址')
  }
  if (token) {
    base.searchParams.set('access_token', token)
  }
  const pending = new Map()
  const buffered = []
  const eventListeners = new Set()
  const stateListeners = new Set()
  let socket
  let stopped = true
  let connected = false
  let ready = false
  let selfId = null
  let selfNickname = null
  let epoch = 0
  let retryTimer
  let connectTimer
  let heartbeat
  let retries = 0
  let lastError = null
  const status = () => ({ connected, ready, selfId, selfNickname, epoch, lastError })
  const publish = () => {
    const value = status()
    onState(value)
    for (const listener of stateListeners) {
      listener(value)
    }
  }
  function rejectPending() {
    for (const entry of pending.values()) {
      entry.reject(
        failure('ONEBOT_DISCONNECTED', 'OneBot 连接中断，调用结果可能未知；不会自动重发'),
      )
    }
  }
  function lose(candidate, message) {
    if (!candidate || socket !== candidate) {
      return
    }
    socket = undefined
    connected = false
    ready = false
    selfId = null
    selfNickname = null
    epoch++
    clearTimeout(connectTimer)
    clearInterval(heartbeat)
    rejectPending()
    lastError = message
    publish()
    try {
      candidate.close()
    } catch {
      // State and pending calls are already invalidated; a failed close cannot restore readiness.
    }
    if (!stopped && !retryTimer) {
      retryTimer = setTimeout(
        () => {
          retryTimer = undefined
          open()
        },
        Math.min(30000, 1000 * 2 ** Math.min(retries++, 5)),
      )
      retryTimer.unref?.()
    }
  }
  function requestOn(
    candidate,
    action,
    params = {},
    { signal, timeout = 8000 } = {},
    bootstrap = false,
  ) {
    if (stopped || candidate !== socket || !connected || (!bootstrap && !ready)) {
      return Promise.reject(failure('ONEBOT_DISCONNECTED', 'OneBot 尚未就绪'))
    }
    if (signal?.aborted) {
      return Promise.reject(failure('ONEBOT_CANCELLED', 'OneBot 调用已取消'))
    }
    const echo = randomUUID()
    return new Promise((resolve, reject) => {
      let finished = false
      const finish = (fn, value) => {
        if (finished) {
          return
        }
        finished = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        pending.delete(echo)
        fn(value)
      }
      const abort = () =>
        finish(reject, failure('ONEBOT_CANCELLED', 'OneBot 调用已取消；可能已发送，不自动重发'))
      const timer = setTimeout(
        () =>
          finish(reject, failure('ONEBOT_TIMEOUT', 'OneBot 调用超时；结果可能未知，不自动重发')),
        timeout,
      )
      pending.set(echo, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        candidate.send(JSON.stringify({ action, params, echo }))
      } catch {
        finish(reject, failure('ONEBOT_DISCONNECTED', 'OneBot 调用发送失败；不自动重发'))
      }
    })
  }
  function dispatch(event) {
    if (identity(event.self_id) !== selfId) {
      return
    }
    try {
      onEvent(event)
      for (const listener of eventListeners) {
        listener(event)
      }
    } catch {
      // Do not continue accepting events after the durable sink fails.
      stopped = true
      buffered.length = 0
      lose(socket, '消息持久化失败，连接已停止；请修复项目存储后重新启用')
    }
  }
  async function authorize(candidate) {
    try {
      const login = await requestOn(candidate, 'get_login_info', {}, { timeout: 5000 }, true)
      if (candidate !== socket || stopped) {
        return
      }
      const id = identity(login?.user_id ?? login?.userId)
      if (!id) {
        throw new Error('unknown identity')
      }
      if (ready && id !== selfId) {
        lose(candidate, 'QQ 登录账号发生变化，正在重新确认身份')
        return
      }
      selfId = id
      selfNickname =
        typeof login.nickname === 'string' && login.nickname.trim()
          ? login.nickname.trim().slice(0, 256)
          : null
      ready = true
      lastError = null
      retries = 0
      publish()
      const early = buffered.splice(0)
      for (const event of early) {
        if (!ready || candidate !== socket) {
          break
        }
        dispatch(event)
      }
    } catch {
      if (candidate === socket) {
        lose(candidate, '无法确认 QQ 登录身份，暂停接收并重连')
      }
    }
  }
  function open() {
    if (stopped || socket) {
      return
    }
    epoch++
    lastError = null
    let candidate
    try {
      candidate = new WebSocket(base.href)
    } catch {
      lastError = '无法建立 OneBot WebSocket 连接'
      publish()
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        open()
      }, 3000)
      retryTimer.unref?.()
      return
    }
    socket = candidate
    publish()
    connectTimer = setTimeout(() => lose(candidate, 'OneBot WebSocket 连接超时'), 8000)
    connectTimer.unref?.()
    candidate.addEventListener('open', () => {
      if (socket !== candidate || stopped) {
        return
      }
      clearTimeout(connectTimer)
      connected = true
      publish()
      void authorize(candidate)
      // Detect half-open links even when no QQ messages or heartbeat events arrive.
      heartbeat = setInterval(() => void authorize(candidate), 30000)
      heartbeat.unref?.()
    })
    candidate.addEventListener('message', (event) => {
      if (socket !== candidate || stopped || typeof event.data !== 'string') {
        return
      }
      let value
      try {
        value = JSON.parse(event.data)
      } catch {
        lose(candidate, 'OneBot 返回无效 JSON')
        return
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return
      }
      if (typeof value.echo === 'string' && pending.has(value.echo)) {
        const entry = pending.get(value.echo)
        if (value.status === 'ok' && value.retcode === 0) {
          entry.resolve(value.data)
        } else {
          entry.reject(new Error('OneBot API 返回失败或未确定完成'))
        }
        return
      }
      if (typeof value.post_type !== 'string') {
        return
      }
      if (!identity(value.self_id)) {
        return
      }
      if (!ready) {
        buffered.push(value)
        return
      }
      if (identity(value.self_id) !== selfId) {
        buffered.push(value)
        lose(candidate, '事件账号发生变化，暂停旧回合并重新连接')
        return
      }
      dispatch(value)
    })
    candidate.addEventListener('error', () =>
      lose(candidate, 'OneBot WebSocket 连接失败或认证被拒绝'),
    )
    candidate.addEventListener('close', () => lose(candidate, 'OneBot WebSocket 已断开'))
  }
  return {
    status,
    onEvent(fn) {
      eventListeners.add(fn)
      return () => eventListeners.delete(fn)
    },
    onState(fn) {
      stateListeners.add(fn)
      return () => stateListeners.delete(fn)
    },
    request: (action, params, options) => requestOn(socket, action, params, options),
    connect() {
      if (!stopped) {
        return
      }
      stopped = false
      open()
    },
    close() {
      if (stopped && !socket) {
        return
      }
      stopped = true
      clearTimeout(retryTimer)
      retryTimer = undefined
      buffered.length = 0
      if (socket) {
        lose(socket, null)
      } else {
        clearTimeout(connectTimer)
        clearInterval(heartbeat)
        rejectPending()
      }
    },
  }
}

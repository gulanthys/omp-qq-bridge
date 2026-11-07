import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultSettings, readSettings, validateSettings, writeSettings } from './lib/config.mjs'
import { startRuntime } from './lib/runtime.mjs'
import { resolveHostModel } from './lib/model-source.mjs'
import { resolveMemoryProvider } from './lib/memory-provider.mjs'

const extensionDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = realpathSync.native(resolve(extensionDir, '..'))
const samePath = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

export default function ompQQBridge(pi) {
  let runtime
  let active = false
  let generation = 0
  let dialogController
  let activeSessionId
  let operation = Promise.resolve()
  let stopping = Promise.resolve()
  let registered = false
  const belongs = (ctx) => {
    try {
      return (
        ctx?.agent?.kind === 'main' && samePath(realpathSync.native(resolve(ctx.cwd)), projectRoot)
      )
    } catch {
      return false
    }
  }
  const valid = (ctx, token) =>
    active &&
    belongs(ctx) &&
    ctx?.sessionManager?.getSessionId?.() === activeSessionId &&
    token === generation
  const notice = (ctx, text) => {
    if (valid(ctx, generation)) {
      pi.sendMessage(
        { customType: 'omp-qq-bridge', content: text, display: true },
        { triggerTurn: false },
      )
    }
  }
  const stop = () => {
    const previous = runtime
    runtime = undefined
    if (previous) {
      stopping = Promise.all([stopping, previous.close()]).then(() => {})
    }
    return stopping
  }
  const start = async (ctx, token = generation) => {
    if (!valid(ctx, token)) {
      return
    }
    const current = readSettings(projectRoot)
    if (!current?.enabled) {
      return
    }
    const instance = await startRuntime({
      projectRoot,
      memoryProvider: resolveMemoryProvider(pi, projectRoot),
      resolveModel: () =>
        valid(ctx, token) ? resolveHostModel(ctx) : Promise.reject(new Error('当前会话已离开项目')),
      requestConsent: async (request) => {
        if (!valid(ctx, token) || !ctx.hasUI) {
          return false
        }
        return ctx.ui.confirm(request.title, request.description, { signal: request.signal })
      },
      onNotice: (text) => {
        if (valid(ctx, token)) {
          notice(ctx, text)
        }
      },
    })
    if (!valid(ctx, token)) {
      await instance.close()
    } else {
      runtime = instance
    }
  }
  const serialize = (fn) => {
    const result = operation.then(fn)
    operation = result.catch(() => {
      // Keep later commands runnable; the caller still receives the original rejected result.
    })
    return result
  }
  const prompt = async (ctx, title, placeholder, secret = false, signal) =>
    ctx.ui.input(title, placeholder, {
      ...(secret ? { secret: true } : {}),
      ...(signal ? { signal } : {}),
    })
  const still = (ctx, token, signal) => valid(ctx, token) && !signal.aborted
  const init = async (ctx, token, signal) => {
    if (!ctx.hasUI) {
      return notice(ctx, '需要可交互的本机界面才能配置 QQ 桥接。')
    }
    const previous = readSettings(projectRoot)
    if (
      previous &&
      !(await ctx.ui.confirm(
        '覆盖桥接设置？',
        '将覆盖本项目 QQ 桥接设置；不会清空共享记忆、人格或会话。',
        { signal },
      ))
    ) {
      return
    }
    if (!still(ctx, token, signal)) {
      return
    }
    const defaults = previous ?? defaultSettings(projectRoot)
    let onebotUrl = await prompt(
      ctx,
      'OneBot 正向 WebSocket 地址',
      defaults.onebotUrl,
      false,
      signal,
    )
    if (!still(ctx, token, signal) || onebotUrl === undefined) {
      return
    }
    if (!onebotUrl.trim()) {
      onebotUrl = defaults.onebotUrl
    }
    const tokenValue = await prompt(
      ctx,
      'OneBot AccessToken（可留空）',
      '留空表示不使用 Token',
      true,
      signal,
    )
    if (!still(ctx, token, signal) || tokenValue === undefined) {
      return
    }
    const provider = resolveMemoryProvider(pi, projectRoot)
    if (
      provider &&
      !(await ctx.ui.confirm(
        '共用当前项目记忆？',
        `已发现 ${provider.id}。所有接入聊天可召回本项目经授权保存的人格与长期记忆；原始聊天历史独立。变更仍需本机确认，不要保存敏感信息。`,
        { signal },
      ))
    ) {
      return
    }
    if (!still(ctx, token, signal)) {
      return
    }
    const enabled = await ctx.ui.confirm(
      '立即启用 QQ 桥接？',
      '启用后，OneBot 转发的所有私聊与群聊消息都会交给当前模型处理；群内无关消息也会产生模型费用。',
      { signal },
    )
    if (!still(ctx, token, signal)) {
      return
    }
    let validated
    try {
      validated = validateSettings(projectRoot, {
        ...defaults,
        onebotUrl,
        token: tokenValue,
        enabled,
      })
    } catch (error) {
      return notice(ctx, `配置未保存：${error.message}`)
    }
    return serialize(async () => {
      if (!still(ctx, token, signal)) {
        return
      }
      await stop()
      if (!still(ctx, token, signal)) {
        return
      }
      writeSettings(projectRoot, validated)
      if (validated.enabled) {
        await start(ctx, token)
      }
      notice(
        ctx,
        validated.enabled
          ? 'QQ 桥接设置已保存并启用；所有私聊与群聊均自动接入。'
          : 'QQ 桥接设置已保存，当前未启用。',
      )
    }).catch((error) => notice(ctx, `QQ 桥接未能完成：${error.message}`))
  }
  const settings = async (ctx, token, signal) => {
    if (!ctx.hasUI) {
      return notice(ctx, '需要可交互的本机界面才能修改设置。')
    }
    const current = readSettings(projectRoot)
    if (!current) {
      return notice(ctx, '尚无 v4 配置，请运行 /omp-qq-bridge /init 明确启用全聊天接入。')
    }
    const provider = resolveMemoryProvider(pi, projectRoot)
    const memoryLabel = provider?.id || '未加载记忆插件'
    const options = [
      {
        label: current.enabled ? '停止桥接' : '启用桥接',
        description: '切换所有私聊与群聊消息接入',
      },
      { label: '修改 QQ 连接', description: '正向 WebSocket 地址和 Token' },
      { label: '共享角色与记忆说明', description: memoryLabel },
      { label: '查看状态', description: '运行状态与连接信息' },
      { label: '语音转写（可选）', description: '仅配置可信本机命令；留空关闭' },
    ]
    const choice = await ctx.ui.select('QQ 桥接设置', options, { signal })
    if (!still(ctx, token, signal) || choice === undefined) {
      return
    }
    if (choice === options[3].label) {
      const state = runtime?.status()
      return notice(
        ctx,
        `状态：${current.enabled ? (state?.enabled ? '运行中' : '已启用但未运行或已暂停') : '已停止'}\nOneBot：${current.onebotUrl}\n项目记忆：${memoryLabel}\n所有私聊与群聊自动接入；聊天历史彼此独立，模型沿用启动时选择。\n${state ? JSON.stringify(state, null, 2) : ''}`,
      )
    }
    if (choice === options[2].label) {
      return notice(
        ctx,
        `项目记忆：${memoryLabel}\n${provider ? '所有聊天共享该提供者的授权人格与长期记忆，原始聊天历史独立。记忆变更需本机确认；人格审批由记忆插件自己的管理入口负责。' : '当前 QQ 桥接独立运行，不注入额外人格或长期记忆，也不注册记忆工具。加载兼容的项目记忆插件后重新启用桥接即可自动接入。'}`,
      )
    }
    let draft = { ...current }
    if (choice === options[0].label) {
      draft.enabled = !current.enabled
      if (
        draft.enabled &&
        !(await ctx.ui.confirm(
          '启用 QQ 桥接？',
          '所有私聊与群聊消息会发送给当前模型，群内无关消息也可能产生模型费用。',
          { signal },
        ))
      ) {
        return
      }
      if (!still(ctx, token, signal)) {
        return
      }
    } else if (choice === options[1].label) {
      let url = await prompt(ctx, 'OneBot 正向 WebSocket 地址', current.onebotUrl, false, signal)
      if (!still(ctx, token, signal) || url === undefined) {
        return
      }
      if (!url.trim()) {
        url = current.onebotUrl
      }
      const accessToken = await prompt(
        ctx,
        'OneBot AccessToken（可留空）',
        '留空表示不使用 Token',
        true,
        signal,
      )
      if (!still(ctx, token, signal) || accessToken === undefined) {
        return
      }
      draft.onebotUrl = url
      draft.token = accessToken
    } else if (choice === options[4].label) {
      const command = await prompt(
        ctx,
        '可信本机转写命令（留空关闭）',
        current.speechCommand || '使用 "{file}" 作为音频文件参数；不要在命令中写 Key',
        false,
        signal,
      )
      if (!still(ctx, token, signal) || command === undefined) {
        return
      }
      if (
        command.trim() &&
        !(await ctx.ui.confirm(
          '允许执行本机转写命令？',
          '每段接入的 QQ 语音都会执行此命令，权限等同当前用户。仅使用可信的前台程序，不自动安装模型；凭据请放环境变量。',
          { signal },
        ))
      ) {
        return
      }
      if (!still(ctx, token, signal)) {
        return
      }
      draft.speechCommand = command.trim()
    } else {
      return
    }
    if (!still(ctx, token, signal)) {
      return
    }
    try {
      draft = validateSettings(projectRoot, draft)
    } catch (error) {
      return notice(ctx, `设置无效，未保存：${error.message}`)
    }
    return serialize(async () => {
      if (!still(ctx, token, signal)) {
        return
      }
      await stop()
      if (!still(ctx, token, signal)) {
        return
      }
      writeSettings(projectRoot, draft)
      if (draft.enabled) {
        await start(ctx, token)
      }
      notice(
        ctx,
        draft.enabled ? 'QQ 桥接已启用；所有私聊与群聊均自动接入。' : 'QQ 桥接已停止并保存设置。',
      )
    }).catch((error) => notice(ctx, `QQ 桥接未能完成：${error.message}`))
  }
  const register = () => {
    if (registered) {
      return
    }
    registered = true
    pi.registerCommand('omp-qq-bridge', {
      description: '配置和管理本项目 QQ OneBot 桥接',
      handler: async (args, ctx) => {
        const token = generation
        if (!valid(ctx, token)) {
          return
        }
        dialogController?.abort()
        const controller = new AbortController()
        dialogController = controller
        const command = args.trim()
        try {
          if (command === '/init') {
            return await init(ctx, token, controller.signal)
          }
          if (command === '/setting') {
            return await settings(ctx, token, controller.signal)
          }
          notice(ctx, '用法：/omp-qq-bridge /init 或 /omp-qq-bridge /setting')
        } catch (error) {
          if (still(ctx, token, controller.signal)) {
            notice(ctx, `操作未完成：${error.message}`)
          }
        } finally {
          if (dialogController === controller) {
            dialogController = undefined
          }
        }
      },
    })
  }
  const invalidate = () => {
    generation++
    dialogController?.abort()
    dialogController = undefined
    active = false
  }
  pi.on('session_start', async (_event, ctx) => {
    invalidate()
    activeSessionId = belongs(ctx) ? ctx.sessionManager?.getSessionId?.() : undefined
    active = belongs(ctx)
    if (!active) {
      void stop()
      return
    }
    register()
    const token = generation
    const closing = stop()
    void serialize(async () => {
      await closing
      await start(ctx, token)
    }).catch((error) => notice(ctx, `QQ 桥接启动失败：${error.message}`))
  })
  pi.on('session_switch', async (_event, ctx) => {
    invalidate()
    activeSessionId = belongs(ctx) ? ctx.sessionManager?.getSessionId?.() : undefined
    active = belongs(ctx)
    if (!active) {
      void stop()
      return
    }
    register()
    const token = generation
    const closing = stop()
    void serialize(async () => {
      await closing
      await start(ctx, token)
    }).catch((error) => notice(ctx, `QQ 桥接启动失败：${error.message}`))
  })
  pi.on('session_shutdown', (_event, ctx) => {
    const sessionId = ctx?.sessionManager?.getSessionId?.()
    if (activeSessionId !== undefined && sessionId !== activeSessionId) {
      return
    }
    invalidate()
    activeSessionId = undefined
    return stop()
  })
}

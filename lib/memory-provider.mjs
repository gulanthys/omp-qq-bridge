import { samePath } from './config.mjs'

const reservedNames = new Set(['read', 'grep', 'glob', 'qq_reply_gate'])
const validName = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/

function plainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

export function validateMemoryProvider(provider, projectRoot) {
  if (
    !plainObject(provider) ||
    provider.version !== 1 ||
    typeof provider.id !== 'string' ||
    !provider.id.trim() ||
    typeof provider.projectRoot !== 'string' ||
    !samePath(provider.projectRoot, projectRoot) ||
    !Array.isArray(provider.tools) ||
    typeof provider.prepare !== 'function' ||
    typeof provider.execute !== 'function'
  ) {
    throw new Error('项目记忆提供方响应格式或项目身份无效')
  }
  const names = new Set()
  for (const tool of provider.tools) {
    if (
      !plainObject(tool) ||
      !validName.test(tool.name) ||
      names.has(tool.name) ||
      reservedNames.has(tool.name) ||
      typeof tool.label !== 'string' ||
      typeof tool.description !== 'string' ||
      !plainObject(tool.parameters) ||
      tool.parameters.type !== 'object'
    ) {
      throw new Error('项目记忆提供方工具描述无效')
    }
    names.add(tool.name)
  }
  const tools = JSON.parse(JSON.stringify(provider.tools))
  return {
    version: 1,
    id: provider.id,
    projectRoot,
    tools,
    prepare: (prompt, context) => provider.prepare(prompt, context),
    execute: (name, args, options) => provider.execute(name, args, options),
  }
}

export function resolveMemoryProvider(pi, projectRoot) {
  const responders = []
  pi.events.emit('project-memory:resolve', {
    version: 1,
    projectRoot,
    accept(provider) {
      responders.push(provider)
    },
  })
  if (!responders.length) {
    return null
  }
  if (responders.length !== 1) {
    throw new Error('发现多个项目记忆提供方；请只加载一个')
  }
  return validateMemoryProvider(responders[0], projectRoot)
}

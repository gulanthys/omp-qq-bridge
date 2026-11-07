import { basename } from 'node:path'

const APIS = new Set([
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'azure-openai-responses',
  'anthropic-messages',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-gemini-cli',
  'google-vertex',
])
const MODEL_FIELDS = [
  'id',
  'name',
  'api',
  'baseUrl',
  'reasoning',
  'input',
  'contextWindow',
  'maxTokens',
  'cost',
  'compat',
  'thinking',
  'tokenizer',
  'imageInputDecoder',
  'supportsTools',
  'omitMaxOutputTokens',
  'premiumMultiplier',
  'remoteCompaction',
]

export async function resolveHostModel(ctx) {
  if (ctx?.agent?.kind !== 'main' || !ctx.model || !ctx.modelRegistry) {
    throw new Error('请先在当前项目的 omp 主会话选择可用模型')
  }
  const selected = ctx.model
  if (!APIS.has(selected.api)) {
    throw new Error(
      '当前模型使用进程内自定义 API，无法直接供隔离 QQ 上下文使用；请选择 omp 内置协议的模型',
    )
  }
  if (
    typeof selected.provider !== 'string' ||
    !selected.provider ||
    typeof selected.id !== 'string' ||
    !selected.id ||
    typeof selected.baseUrl !== 'string'
  ) {
    throw new Error('当前模型缺少明确的供应商、模型 ID 或服务地址')
  }
  const endpoint = new URL(selected.baseUrl)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('模型服务地址必须不含内嵌凭据、查询参数或片段；认证应由 omp 单独管理')
  }
  if (
    typeof ctx.modelRegistry.getApiKeyAndHeaders !== 'function' ||
    typeof ctx.modelRegistry.resolveModelHeaders !== 'function'
  ) {
    throw new Error('当前 omp 缺少模型认证解析接口，需要 omp 18.16.0 或兼容版本')
  }
  const model = { provider: selected.provider }
  for (const field of MODEL_FIELDS) {
    if (selected[field] !== undefined) {
      model[field] = selected[field]
    }
  }
  // Functions such as resolveHeaders are deliberately not serialized. They run
  // in the owning OMP process; only their resolved request values cross to the
  // child in its environment, never in the model file or process arguments.
  return {
    model: structuredClone(model),
    executable: /^omp(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : 'omp',
    async getAuth() {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(selected)
      if (!auth?.ok || typeof auth.apiKey !== 'string') {
        throw new Error('无法解析当前 omp 模型的认证；请先在本机确认该模型可用')
      }
      const headers = {
        ...(auth.headers || {}),
        ...((await ctx.modelRegistry.resolveModelHeaders(selected)) || {}),
      }
      if (Object.entries(headers).some(([key, value]) => !key || typeof value !== 'string')) {
        throw new Error('当前模型返回了无效的认证请求头')
      }
      return { apiKey: auth.apiKey, headers, env: auth.env || {} }
    },
  }
}

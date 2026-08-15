// 崩溃隐患回归测试:模拟"新用户安装、未配置任何凭据"的加载场景。
// 模拟 Cordis loader 流程:plugin(plugin, undefined) → schema 填充默认 config → apply。
// 断言:无同步异常、无 unhandledRejection、状态为"未配置"错误而非崩溃。
import plugin from '../lib/index.js'

const failures = []
let unhandled = null

process.on('unhandledRejection', (reason) => {
  unhandled = reason
})

// ---- 模拟 loader 的 config 解析 ----
const schemaResult = plugin.Config['~standard'].validate(undefined)
if (schemaResult.issues && schemaResult.issues.length) {
  failures.push('config schema 校验失败: ' + JSON.stringify(schemaResult.issues))
}
const config = schemaResult.value

// ---- 构造 mock ctx(新用户环境:无凭据) ----
const registeredRoutes = []
const intervals = []
const mockCtx = {
  get(name) {
    switch (name) {
      case 'credentials':
        return {
          resolve: async () => undefined, // 未配置任何凭据
        }
      case 'subprocess':
        return undefined // 未挂载(或不可用)
      case 'sandboxPolicy':
        return undefined
      case 'shell':
        return undefined
      case 'webServer':
        return {
          register(route) {
            registeredRoutes.push(route)
            return () => {}
          },
        }
      default:
        return undefined
    }
  },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposer()
  },
  interval(cb) {
    intervals.push(cb)
    return () => {}
  },
}

// ---- 加载插件 ----
let applyError = null
try {
  plugin.apply(mockCtx, config)
} catch (e) {
  applyError = e
}

// ---- 等待异步 fire-and-forget 完成 ----
await new Promise((r) => setTimeout(r, 800))

// ---- 断言 ----
if (applyError) failures.push('apply 同步异常: ' + applyError.message)
if (unhandled) failures.push('unhandledRejection: ' + (unhandled && unhandled.message ? unhandled.message : String(unhandled)))

console.log('=== 新用户未配置凭据 场景测试 ===')
console.log('config 默认值:', JSON.stringify(config))
console.log('apply 同步异常:', applyError ? applyError.message : '(无)')
console.log('unhandledRejection:', unhandled ? (unhandled.message || String(unhandled)) : '(无)')
console.log('注册的路由:', registeredRoutes.map((r) => r.path).join(', ') || '(无)')
console.log('注册的 interval 数:', intervals.length)

// 通过 handler 读取状态(模拟 client 请求)
if (registeredRoutes.length) {
  let body = ''
  const fakeRes = {
    setHeader() {},
    end(s) { body = s },
  }
  registeredRoutes[0].handler(null, fakeRes)
  const state = JSON.parse(body)
  console.log('--- host 状态(通过路由 handler) ---')
  console.log('official:', JSON.stringify(state.official))
  console.log('officialError:', state.officialError)
  console.log('usage:', JSON.stringify(state.usage))
  console.log('usageError:', state.usageError)
  console.log('myKey:', JSON.stringify(state.myKey))
  console.log('myKeyError:', state.myKeyError)
  if (state.officialError !== '未配置 DEEPSEEK_API_KEY') failures.push('余额错误提示不符: ' + state.officialError)
  if (state.usageError !== '未提供 DEEPSEEK_PLATFORM_TOKEN（平台登录 token）') failures.push('用量错误提示不符: ' + state.usageError)
  if (state.myKeyError !== '未提供 DEEPSEEK_PLATFORM_TOKEN（平台登录 token）') failures.push('我的key错误提示不符: ' + state.myKeyError)
}

console.log('\n=== 结论 ===')
if (failures.length) {
  console.log('✗ 发现 ' + failures.length + ' 个问题:')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
} else {
  console.log('✓ 全部通过:未配置凭据场景无崩溃、无未处理异常,界面显示明确错误提示')
}

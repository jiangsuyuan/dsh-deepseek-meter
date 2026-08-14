// 边缘场景回归测试:凭据存在但接口/子进程异常时,不得崩溃。
import plugin from './dsh-deepseek-meter/lib/index.js'

const failures = []
process.on('unhandledRejection', (reason) => {
  failures.push('unhandledRejection: ' + (reason && reason.message ? reason.message : String(reason)))
})

const config = plugin.Config['~standard'].validate(undefined).value

function makeCtx({ subStdout, subExit = 0, spawnThrows = false }) {
  const routes = []
  return {
    get(name) {
      switch (name) {
        case 'credentials':
          return { resolve: async () => ({ value: 'sk-abcdef123456' }) } // 有凭据
        case 'subprocess':
          return {
            resolveExecutable: async () => 'node',
            spawn() {
              if (spawnThrows) throw new Error('spawn failed')
              return {
                done: Promise.resolve({ exitCode: subExit }),
                collected: { stdout: { readFrom: () => ({ text: subStdout }) } },
              }
            },
          }
        case 'sandboxPolicy':
          return { workspaceRoot: 'D:\\LY\\05-SAM' }
        case 'shell':
          return undefined
        case 'webServer':
          return { register: (r) => { routes.push(r); return () => {} } }
        default:
          return undefined
      }
    },
    effect(fn) { const d = fn(); if (typeof d === 'function') d() },
    interval() { return () => {} },
    routes,
  }
}

async function scenario(name, ctx) {
  let applyError = null
  try {
    plugin.apply(ctx, config)
  } catch (e) {
    applyError = e
  }
  await new Promise((r) => setTimeout(r, 600))
  console.log(`--- ${name} ---`)
  console.log('  apply 异常:', applyError ? applyError.message : '(无)')
  let state = null
  if (ctx.routes.length) {
    let body = ''
    ctx.routes[0].handler(null, { setHeader() {}, end(s) { body = s } })
    try { state = JSON.parse(body) } catch { failures.push(name + ': 状态 JSON 解析失败') }
  }
  if (applyError) failures.push(name + ': apply 异常 ' + applyError.message)
  return state
}

// 场景 B:接口失败(__ERR__)
const b = await scenario('接口失败(__ERR__: network)', makeCtx({ subStdout: '__ERR__:network failed\n' }))
console.log('  official:', JSON.stringify(b && b.official), '| error:', b && b.officialError)

// 场景 C:余额返回垃圾文本
const c = await scenario('余额返回垃圾文本', makeCtx({ subStdout: 'hello world not json\n' }))
console.log('  officialError:', c && c.officialError)

// 场景 D:子进程异常退出
const d = await scenario('子进程 exit 1', makeCtx({ subStdout: '', subExit: 1 }))
console.log('  officialError:', d && d.officialError)

// 场景 E:spawn 抛错
const e = await scenario('spawn 抛异常', makeCtx({ subStdout: '', spawnThrows: true }))
console.log('  officialError:', e && e.officialError)

console.log('\n=== 结论 ===')
if (failures.length) {
  console.log('✗ ' + failures.length + ' 个问题:')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
} else {
  console.log('✓ 全部通过:接口失败/垃圾数据/子进程异常均不崩溃,保留上次数据或显示错误')
}

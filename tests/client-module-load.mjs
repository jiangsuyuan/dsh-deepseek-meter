// 决定性验证:模拟 DSH 浏览器模块表(seed 含 react,复刻 client-modules 的 makeRequire),
// 实际执行 lib/client.js 的工厂,验证 require("react") 能否解析。
// 运行:node tests/client-module-load.mjs(从包根目录,依赖 node_modules 中的 react 等)
// 如果成功 → client 端 require("react") 不是崩溃原因(与内置包 ui-tool 一致)。
import * as React from 'react'
import * as ReactJsx from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as Cordis from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'

// ---- 复刻真实 seed(与 packages/client/web/src/seed.ts 一致) ----
const seed = new Map(Object.entries({
  'react': React,
  'react/jsx-runtime': ReactJsx,
  'react-dom': ReactDom,
  'react-dom/client': ReactDomClient,
  '@deepseek-ai/cordis': Cordis,
}))

// ---- 复刻 ClientModuleSystem 的 __ModuleLoader__ 注册 ----
const factories = new Map()
globalThis.window = globalThis // client.js 顶层用 window.__ModuleLoader__.load
globalThis.__ModuleLoader__ = {
  load: (handoff) => {
    factories.set(handoff.id, handoff.factory)
  },
}

// ---- 执行 lib/client.js(它会调用 __ModuleLoader__.load 注册工厂) ----
const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const wrap = new Function(clientSrc) // 顶层是 window.__ModuleLoader__.load(...) 调用
wrap()

// ---- 复刻 makeRequire(seed → memoized → factory → 抛错)并物化工厂 ----
const materialized = new Map()
function makeRequire(id) {
  return (spec) => {
    if (seed.has(spec)) return seed.get(spec)
    const hit = materialized.get(spec)
    if (hit !== undefined) return hit
    const factory = factories.get(spec)
    if (factory) {
      const exports = factory(makeRequire(spec))
      materialized.set(spec, exports)
      return exports
    }
    throw new Error(`client-modules: require("${spec}") missed the module table`)
  }
}

console.log('已注册的工厂:', [...factories.keys()].join(', '))

try {
  const moduleExports = factories.get('dsh-deepseek-meter')(makeRequire('dsh-deepseek-meter'))
  const plugin = moduleExports.default ?? moduleExports
  console.log('=== client 工厂物化成功 ===')
  console.log('模块导出键:', Object.keys(moduleExports).join(', '))
  console.log('插件 name:', plugin.name)
  console.log('插件 inject:', JSON.stringify(plugin.inject))
  console.log('插件 apply 类型:', typeof plugin.apply)
  if (plugin.apply === undefined) throw new Error('无 apply 方法')
  if (plugin.name !== 'dsh-deepseek-meter/client') throw new Error('name 不符')
  console.log('\n✓ 结论:require("react") 在模拟模块表(seed 含 react)中解析成功')
  console.log('  client.js 与内置包(ui-tool 等)的 react external 方式完全一致')
} catch (e) {
  console.error('\n✗ 物化失败:', e.message)
  process.exit(1)
}

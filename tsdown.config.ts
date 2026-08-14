import { defineConfig } from 'tsdown'

const ID = 'dsh-deepseek-meter'

/**
 * 第三方独立包构建:
 * 1. node 半 -> lib/index.js (esm, host loader 直接 import)
 * 2. client 半 -> lib/client.js (cjs, window.__ModuleLoader__.load 契约,
 *    react / @deepseek-ai/cordis 由浏览器模块表 external 解析)
 */
export default defineConfig([
  {
    name: ID,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'],
    },
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: false,
    deps: {
      neverBundle: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      exports: 'named',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])

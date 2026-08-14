import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-deepseek-meter'

export interface Config {
  balanceUrl: string
  platformBase: string
  balanceIntervalMs: number
  usageIntervalMs: number
  fetchTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  balanceUrl: Schema.string().default('https://api.deepseek.com/user/balance'),
  platformBase: Schema.string().default('https://platform.deepseek.com/api/v0'),
  balanceIntervalMs: Schema.number().default(60000),
  usageIntervalMs: Schema.number().default(120000),
  fetchTimeoutMs: Schema.number().default(20000),
})

/**
 * Host half: 拉取 DeepSeek 官方余额/用量数据,并通过 RPC 暴露给 client 半。
 * 凭据只走显式 env 传入 Node 子进程(本机 Schannel 损坏,必须绕开系统 TLS)。
 */
export default {
  inject: ['timer'],
  apply(ctx: Context, config: Config) {
    const BALANCE_URL = config.balanceUrl
    const PLATFORM_BASE = config.platformBase
    const BALANCE_MS = config.balanceIntervalMs
    const USAGE_MS = config.usageIntervalMs
    const FETCH_MS = config.fetchTimeoutMs

    // ===================== 状态 =====================
    const pad = (n: number) => String(n).padStart(2, '0')
    const dateKey = (d: Date) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    const tzSec = () => -new Date().getTimezoneOffset() * 60
    let official: Record<string, unknown> | null = null
    let officialError: string | null = null
    let usage: Record<string, unknown> | null = null
    let usageError: string | null = null
    let myKey: Record<string, unknown> | null = null
    let myKeyError: string | null = null
    const symbolOf = (cur: string) => (cur === 'CNY' ? '¥' : cur === 'USD' ? '$' : (typeof cur === 'string' && cur !== '' ? cur + ' ' : '¥'))

    // ===================== 通用：Node 子进程执行脚本（凭据只走显式 env） =====================
    const nodeRun = async (env: Record<string, string>, script: string) => {
      const sub = ctx.get('subprocess')
      if (sub === undefined) return { ok: false as const, reason: '子进程服务不可用' }
      let cwd = ''
      const sandboxPolicy = ctx.get('sandboxPolicy')
      if (sandboxPolicy !== undefined && typeof (sandboxPolicy as { workspaceRoot?: unknown }).workspaceRoot === 'string' && (sandboxPolicy as { workspaceRoot: string }).workspaceRoot !== '') {
        cwd = (sandboxPolicy as { workspaceRoot: string }).workspaceRoot
      }
      if (cwd === '') {
        const shell = ctx.get('shell')
        if (shell !== undefined) {
          try {
            const spec = (shell as { resolve: (req: { command: string }) => unknown }).resolve({ command: '' })
            if (spec !== undefined && spec !== null && typeof (spec as { workdir?: unknown }).workdir === 'string' && (spec as { workdir: string }).workdir !== '') cwd = (spec as { workdir: string }).workdir
          } catch { cwd = '' }
        }
      }
      if (cwd === '') return { ok: false as const, reason: '无法确定工作目录' }
      let exe = 'node'
      try {
        const resolved = await (sub as { resolveExecutable: (name: string) => Promise<unknown> }).resolveExecutable('node')
        if (typeof resolved === 'string' && resolved !== '') exe = resolved
      } catch { /* 保持 'node' */ }
      const handle = (sub as {
        spawn: (req: {
          argv: string[]; cwd: string; stdio: unknown; graceMs: number; env: Record<string, string>
        }) => { done: Promise<{ exitCode: number }>; collected: { stdout: { readFrom: (n: number) => { text: string } } } }
      }).spawn({
        argv: [exe, '-e', script],
        cwd: cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 524288 }, stderr: { maxBytes: 8192 } },
        graceMs: 1000,
        env: env,
      })
      const outcome = await handle.done
      const reader = handle.collected.stdout
      const text = reader !== undefined && reader !== null ? reader.readFrom(0).text : ''
      const str = String(text)
      if (outcome.exitCode !== 0) return { ok: false as const, reason: '子进程退出 ' + outcome.exitCode }
      const m = /^__ERR__:([\s\S]*)$/m.exec(str)
      if (m !== null) {
        const reason = m[1].trim()
        return { ok: false as const, reason: reason !== '' ? reason : '请求失败' }
      }
      return { ok: true as const, text: str }
    }

    const resolveCred = async (ref: string) => {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return undefined
      try {
        const resolved = await (credentials as { resolve: (ref: string) => Promise<{ value?: unknown } | undefined> }).resolve(ref)
        if (resolved !== undefined && resolved !== null && typeof resolved.value === 'string' && resolved.value !== '') return resolved.value
      } catch { /* 按未配置处理 */ }
      return undefined
    }

    const platFetch = async (token: string, urls: string[]) => {
      const script = "const hs=" + JSON.stringify(urls) + ";const h={Authorization:'Bearer '+process.env.DSH_PLATFORM_TOKEN,'x-app-version':'1.0.0',Accept:'*/*',Referer:'https://platform.deepseek.com/usage',Origin:'https://platform.deepseek.com'};const f=function(u){const ac=new AbortController();const tm=setTimeout(function(){ac.abort();}," + FETCH_MS + ");return fetch(u,{headers:h,signal:ac.signal}).then(function(r){clearTimeout(tm);return r.text();}).then(function(t){try{return JSON.parse(t);}catch(e){throw new Error('非JSON响应');}});};Promise.all(hs.map(f)).then(function(a){console.log(JSON.stringify(a));}).catch(function(e){console.log('__ERR__:'+(e&&e.message?e.message:String(e)));});"
      return nodeRun({ DSH_PLATFORM_TOKEN: token }, script)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bizOf = (d: any) => {
      if (d === null || d === undefined || d.code !== 0 || d.data === null || d.data === undefined) return undefined
      const raw = d.data.biz_data
      return Array.isArray(raw) ? raw[0] : raw
    }

    // ===================== 官方余额（API key） =====================
    const refreshBalance = async () => {
      const key = await resolveCred('DEEPSEEK_API_KEY')
      if (key === undefined) {
        official = null
        officialError = '未配置 DEEPSEEK_API_KEY'
        return
      }
      try {
        const script = "const u='" + BALANCE_URL + "';const ac=new AbortController();const tm=setTimeout(function(){ac.abort();}," + FETCH_MS + ");fetch(u,{headers:{Authorization:'Bearer '+process.env.DSH_BALANCE_KEY},signal:ac.signal}).then(function(r){clearTimeout(tm);return r.text().then(function(t){return {s:r.status,t:t};});}).then(function(o){console.log('STATUS '+o.s);console.log(o.t);}).catch(function(e){console.log('__ERR__:'+(e&&e.message?e.message:String(e)));});"
        const result = await nodeRun({ DSH_BALANCE_KEY: key }, script)
        if (!result.ok) {
          // 瞬时传输失败：保留上次数据
          return
        }
        const lines = result.text.split(/\r?\n/)
        const status = /^STATUS (\d+)/.exec(lines[0] || '')
        if (status === null || status[1] !== '200') {
          officialError = '官方余额查询失败（HTTP ' + (status !== null ? status[1] : '?') + '）'
          return
        }
        const data = JSON.parse(lines.slice(1).join('\n').trim())
        const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
        const first = infos[0]
        if (first === undefined || first === null || typeof first.total_balance !== 'string') {
          officialError = '官方余额返回异常'
          return
        }
        const currency = typeof first.currency === 'string' && first.currency !== '' ? first.currency : 'CNY'
        const total = parseFloat(first.total_balance)
        if (!Number.isFinite(total)) {
          officialError = '官方余额返回异常'
          return
        }
        official = {
          currency: currency,
          symbol: symbolOf(currency),
          total: total,
          granted: parseFloat(first.granted_balance) || 0,
          toppedUp: parseFloat(first.topped_up_balance) || 0,
          available: data.is_available !== false,
          syncedAt: Date.now(),
        }
        officialError = null
      } catch { /* 保留上次数据 */ }
    }

    // ===================== 账号合计用量（本月 + 今日） =====================
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parseUsageJson = (json: any) => {
      const amountBiz = bizOf(json.amount)
      const costBiz = bizOf(json.cost)
      if (amountBiz === undefined || !Array.isArray(amountBiz.days)) return null
      const todayStr = dateKey(new Date())
      const month = { input: 0, cacheHit: 0, output: 0, cost: 0 }
      let today: Record<string, number | string> | null = null
      const costByDate: Record<string, number> = {}
      if (costBiz !== undefined && Array.isArray(costBiz.days)) {
        for (const day of costBiz.days) {
          let dCost = 0
          for (const mu of (day.data || [])) for (const e of (mu.usage || [])) dCost += parseFloat(e.amount) || 0
          costByDate[day.date] = dCost
        }
      }
      for (const day of amountBiz.days) {
        const date = typeof day.date === 'string' ? day.date : ''
        let dInput = 0, dHit = 0, dOut = 0
        for (const mu of (day.data || [])) {
          for (const e of (mu.usage || [])) {
            const v = parseFloat(e.amount) || 0
            const t = typeof e.type === 'string' ? e.type : ''
            if (t === 'PROMPT_TOKEN' || t === 'PROMPT_CACHE_MISS_TOKEN') dInput += v
            else if (t === 'PROMPT_CACHE_HIT_TOKEN') dHit += v
            else if (t === 'RESPONSE_TOKEN') dOut += v
          }
        }
        month.input += dInput
        month.cacheHit += dHit
        month.output += dOut
        if (date === todayStr) today = { date: date, input: dInput, cacheHit: dHit, output: dOut, cost: costByDate[date] || 0 }
      }
      for (const d of Object.keys(costByDate)) month.cost += costByDate[d]
      return { month: month, today: today }
    }

    const refreshUsage = async () => {
      const token = await resolveCred('DEEPSEEK_PLATFORM_TOKEN')
      if (token === undefined) {
        usage = null
        usageError = '未提供 DEEPSEEK_PLATFORM_TOKEN（平台登录 token）'
        return
      }
      const now = new Date()
      const month = now.getMonth() + 1
      const year = now.getFullYear()
      try {
        const u1 = PLATFORM_BASE + '/usage/amount?month=' + month + '&year=' + year
        const u2 = PLATFORM_BASE + '/usage/cost?month=' + month + '&year=' + year
        const result = await platFetch(token, [u1, u2])
        if (!result.ok) return // 瞬时失败：保留上次数据
        const json = JSON.parse(result.text.trim())
        if (json[0].code === 40003 || json[1].code === 40003) {
          usage = null
          usageError = '平台 Token 无效或已过期，请重新获取'
          return
        }
        const parsed = parseUsageJson({ amount: json[0], cost: json[1] })
        if (parsed === null) {
          usageError = '官方用量返回异常'
          return
        }
        usage = { month: parsed.month, today: parsed.today, syncedAt: Date.now() }
        usageError = null
      } catch { /* 保留上次数据 */ }
    }

    // ===================== 我的 key 用量（by_api_key，自动匹配） =====================
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parseMyKeyJson = (json: any, prefix: string, suffix: string, todayStart: number) => {
      const amountBiz = bizOf(json.amount)
      const costBiz = bizOf(json.cost)
      if (amountBiz === undefined || !Array.isArray(amountBiz.series)) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const match = (k: any) => k !== null && k !== undefined && typeof k.sensitive_id === 'string'
        && k.sensitive_id.startsWith(prefix) && k.sensitive_id.endsWith(suffix)
      const mySeries = amountBiz.series.filter((s: { api_key: unknown }) => match(s.api_key))
      if (mySeries.length === 0) return { empty: true }
      const costSeries = (costBiz !== undefined && Array.isArray(costBiz.data))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? costBiz.data.flatMap((cur: any) => (cur.series || []).filter((s: { api_key: unknown }) => match(s.api_key)))
        : []
      const month = { input: 0, cacheHit: 0, output: 0, cost: 0 }
      const today = { input: 0, cacheHit: 0, output: 0, cost: 0 }
      let hasToday = false
      for (const s of mySeries) {
        for (const b of (s.buckets || [])) {
          const u = b.usage || {}
          const inp = (parseFloat(u.PROMPT_TOKEN) || 0) + (parseFloat(u.PROMPT_CACHE_MISS_TOKEN) || 0)
          const hit = parseFloat(u.PROMPT_CACHE_HIT_TOKEN) || 0
          const out = parseFloat(u.RESPONSE_TOKEN) || 0
          month.input += inp; month.cacheHit += hit; month.output += out
          if (b.time === todayStart) { today.input += inp; today.cacheHit += hit; today.output += out; hasToday = true }
        }
      }
      for (const s of costSeries) {
        for (const b of (s.buckets || [])) {
          const c = parseFloat(b.cost) || 0
          month.cost += c
          if (b.time === todayStart) { today.cost += c; hasToday = true }
        }
      }
      const info = mySeries[0].api_key
      return {
        name: typeof info.name === 'string' ? info.name : '',
        sensitiveId: typeof info.sensitive_id === 'string' ? info.sensitive_id : '',
        trackingId: info.tracking_id === null || info.tracking_id === undefined ? null : String(info.tracking_id),
        month: month,
        today: hasToday ? today : null,
      }
    }

    const refreshMyKey = async () => {
      const token = await resolveCred('DEEPSEEK_PLATFORM_TOKEN')
      if (token === undefined) {
        myKey = null
        myKeyError = '未提供 DEEPSEEK_PLATFORM_TOKEN（平台登录 token）'
        return
      }
      const rawKey = await resolveCred('DEEPSEEK_API_KEY')
      if (rawKey === undefined || rawKey.length < 12) {
        myKey = null
        myKeyError = '未配置 DEEPSEEK_API_KEY'
        return
      }
      const prefix = rawKey.slice(0, 7)
      const suffix = rawKey.slice(-4)
      const now = new Date()
      const tz = tzSec()
      const monthStart = Date.parse(now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-01T00:00:00') / 1000
      const ny = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear()
      const nm = now.getMonth() === 11 ? 1 : now.getMonth() + 2
      const nextMonthStart = Date.parse(ny + '-' + pad(nm) + '-01T00:00:00') / 1000
      const todayStart = Date.parse(dateKey(now) + 'T00:00:00') / 1000
      try {
        const u1 = PLATFORM_BASE + '/usage/by_api_key/amount?start=' + monthStart + '&end=' + nextMonthStart + '&tz=' + tz
        const u2 = PLATFORM_BASE + '/usage/by_api_key/cost?start=' + monthStart + '&end=' + nextMonthStart + '&tz=' + tz
        const result = await platFetch(token, [u1, u2])
        if (!result.ok) return // 瞬时失败：保留上次数据
        const json = JSON.parse(result.text.trim())
        if (json[0].code === 40003 || json[1].code === 40003) {
          myKey = null
          myKeyError = '平台 Token 无效或已过期，请重新获取'
          return
        }
        const parsed = parseMyKeyJson({ amount: json[0], cost: json[1] }, prefix, suffix, todayStart)
        if (parsed === null) {
          myKeyError = '官方按 key 用量返回异常'
          return
        }
        if ((parsed as { empty?: boolean }).empty === true) {
          myKeyError = '未在账户中匹配到该 key（' + prefix + '***' + suffix + '）'
          return
        }
        myKey = { name: parsed.name, sensitiveId: parsed.sensitiveId, trackingId: parsed.trackingId, month: parsed.month, today: parsed.today, syncedAt: Date.now() }
        myKeyError = null
      } catch { /* 保留上次数据 */ }
    }

    // ===================== 启动 + 周期刷新 =====================
    refreshBalance()
    refreshUsage()
    refreshMyKey()
    ctx.interval(() => { refreshBalance() }, BALANCE_MS)
    ctx.interval(() => { refreshUsage(); refreshMyKey() }, USAGE_MS)

    // ===================== 供前端轮询的 RPC =====================
    // 动态插件用闭包注入的 harness.handle;静态双端插件没有该通道,
    // 改为在 host 半注册 HTTP 路由,client 半 fetch 同源相对路径。
    const webServer = ctx.get('webServer')
    if (webServer !== undefined) {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/deepseek-meter/state',
        handler: (_req: unknown, res: { setHeader: (k: string, v: string) => void; end: (s: string) => void }) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({
            official: official,
            officialError: officialError,
            usage: usage,
            usageError: usageError,
            myKey: myKey,
            myKeyError: myKeyError,
          }))
        },
      }))
    }
  },
}

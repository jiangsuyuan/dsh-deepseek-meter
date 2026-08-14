import type { Context } from '@deepseek-ai/cordis'
import * as React from 'react'

export const name = 'dsh-deepseek-meter/client'

/**
 * Client half: 右下角可折叠胶囊 UI。
 * - 数据经 HTTP 路由 `/api/deepseek-meter/state` 从 host 半拉取(每 2s 轮询)。
 * - CSS 通过 <style> 标签注入(静态 client 插件无 styles 闭包符号,但有完整 DOM)。
 * - 注意:client 端没有 timer 服务(host 才有),周期轮询用浏览器原生 setInterval。
 */
export default {
  // slots 服务(浏览器端由 dsh-client-runtime 提供)必须就绪后才能注册 UI。
  inject: ['slots'],
  apply(ctx: Context) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    const CSS = [
      '.um-wrap{position:fixed;right:16px;bottom:16px;z-index:9999;pointer-events:auto;font-family:inherit;user-select:none}',
      '.um-pill{display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;box-shadow:0 2px 10px rgba(0,0,0,.18);cursor:pointer;backdrop-filter:blur(8px);transition:border-color .15s ease,box-shadow .15s ease}',
      '.um-pill:hover{border-color:var(--dsw-alias-border-l2)}',
      '.um-pill .um-strong{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.um-pill .um-sep{opacity:.4}',
      '.um-chevron{opacity:.55;font-size:10px;margin-left:2px;transition:transform .15s ease}',
      '.um-open .um-chevron{transform:rotate(180deg)}',
      '.um-balance-ok{color:var(--dsw-alias-state-success-primary)}',
      '.um-balance-low{color:var(--dsw-alias-state-warn-primary)}',
      '.um-balance-empty{color:var(--dsw-alias-state-error-primary)}',
      '.um-panel{position:absolute;right:0;bottom:calc(100% + 8px);width:310px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 14px;box-shadow:0 4px 18px rgba(0,0,0,.22);backdrop-filter:blur(8px);opacity:0;visibility:hidden;transform:translateY(4px);transition:opacity .15s ease,transform .15s ease,visibility .15s;pointer-events:auto}',
      '.um-open .um-panel{opacity:1;visibility:visible;transform:translateY(0)}',
      '.um-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px}',
      '.um-title{font-size:11px;letter-spacing:.06em;color:var(--dsw-alias-label-secondary);opacity:.75}',
      '.um-balance-big{font-size:15px;font-weight:700;color:var(--dsw-alias-label-primary)}',
      '.um-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);padding:3px 0}',
      '.um-row .um-strong{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.um-row .um-muted{color:var(--dsw-alias-label-secondary);font-weight:400;font-size:11px}',
      '.um-group{font-size:10px;letter-spacing:.08em;color:var(--dsw-alias-label-secondary);opacity:.6;margin:8px 0 2px}',
      '.um-row + .um-row{border-top:1px solid var(--dsw-alias-border-l1);margin-top:2px;padding-top:5px}',
    ].join('\n')

    const styleEl = document.createElement('style')
    styleEl.textContent = CSS
    document.head.appendChild(styleEl)
    ctx.effect(() => () => { styleEl.remove() })

    // ===================== 数据轮询 =====================
    // 静态双端插件没有动态插件的 host.call RPC;改用 host 半注册的 HTTP 路由。
    const fetchState = async (): Promise<Record<string, unknown> | null> => {
      try {
        const res = await fetch('/api/deepseek-meter/state', { headers: { Accept: 'application/json' } })
        if (!res.ok) return null
        return await res.json()
      } catch {
        return null
      }
    }

    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'usage-meter-badge', order: 1000, label: '官方用量' },
      (props: Record<string, unknown>) => {
        const [state, setState] = React.useState<Record<string, unknown> | null>(null)
        const [open, setOpen] = React.useState(false)

        React.useEffect(() => {
          let alive = true
          let busy = false
          const tick = () => {
            if (busy) return
            busy = true
            fetchState().then((res) => {
              if (alive && res !== null) setState(res)
            }).catch(() => {}).then(() => { busy = false })
          }
          tick()
          const timer = setInterval(tick, 2000)
          return () => { alive = false; clearInterval(timer) }
        }, [])

        const fmtTok = (n: number) => {
          const v = typeof n === 'number' && !Number.isNaN(n) ? Math.round(n) : 0
          if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M'
          if (v >= 1000) return (v / 1000).toFixed(1) + 'k'
          return String(v)
        }
        const money = (n: number, sym: string) => {
          const v = typeof n === 'number' && !Number.isNaN(n) ? n : 0
          return (typeof sym === 'string' && sym !== '' ? sym : '¥') + v.toFixed(2)
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = (label: string, value: string, cls: string | undefined, key: string) => React.createElement('div', { className: 'um-row', key },
          React.createElement('span', null, label),
          React.createElement('span', { className: cls || 'um-strong' }, value),
        )
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tokLine = (t: any) => '入 ' + fmtTok(t.input) + ' · 缓存 ' + fmtTok(t.cacheHit) + ' · 出 ' + fmtTok(t.output)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tokRow = (label: string, t: any, key: string) => row(label, tokLine(t), 'um-muted', key)

        const s = state as Record<string, unknown> | null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const official = (s !== null && s.official !== null ? s.official : null) as any
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const officialError = s !== null ? (s.officialError as any) : null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const usageS = (s !== null && s.usage !== null ? s.usage : null) as any
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const usageError = s !== null ? (s.usageError as any) : null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const myKey = (s !== null && s.myKey !== null ? s.myKey : null) as any
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const myKeyError = s !== null ? (s.myKeyError as any) : null

        const officialOk = official !== null && typeof official.total === 'number' && Number.isFinite(official.total)
        const balSym = officialOk && typeof official.symbol === 'string' ? official.symbol : '¥'
        const balCls = officialOk
          ? (Number(official.total) <= 0 ? 'um-balance-empty' : Number(official.total) < 1 ? 'um-balance-low' : 'um-balance-ok')
          : 'um-muted'
        const usageOk = usageS !== null && usageS.today !== null
        const myKeyOk = myKey !== null && myKey.month !== null

        // 胶囊折叠态：我的 key 的今日花费 + 今日 tokens
        const myToday = myKeyOk && myKey.today !== null ? myKey.today : null
        const pillCost = myToday !== null ? money(myToday.cost, balSym) : '--'
        const pillTokens = myToday !== null
          ? fmtTok((Number(myToday.input) || 0) + (Number(myToday.cacheHit) || 0) + (Number(myToday.output) || 0))
          : '--'

        const rows: React.ReactNode[] = []
        if (s !== null) {
          if (officialOk) {
            const when = typeof official.syncedAt === 'number'
              ? new Date(official.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : ''
            rows.push(row('官方余额', money(official.total, official.symbol) + (when !== '' ? ' · ' + when : ''), balCls, 'official-bal'))
            rows.push(row('其中', '充值 ' + money(official.toppedUp, official.symbol) + ' · 赠送 ' + money(official.granted, official.symbol), 'um-muted', 'official-split'))
          } else if (typeof officialError === 'string' && officialError !== '') {
            rows.push(row('官方余额', officialError, 'um-muted', 'official-err'))
          }

          rows.push(React.createElement('div', { className: 'um-group', key: 'g-mine' }, '我的 key（个人消耗）'))
          if (myKeyOk) {
            rows.push(row('key', myKey.name + ' · ' + myKey.sensitiveId, 'um-muted', 'my-key'))
            rows.push(tokRow('本月 tokens', myKey.month, 'my-month-tok'))
            rows.push(row('本月花费', money(myKey.month.cost, balSym), undefined, 'my-month-cost'))
            if (myKey.today !== null) {
              rows.push(tokRow('今日 tokens', myKey.today, 'my-today-tok'))
              rows.push(row('今日花费', money(myKey.today.cost, balSym), undefined, 'my-today-cost'))
            } else {
              rows.push(row('今日', '无数据', 'um-muted', 'my-today-none'))
            }
          } else if (typeof myKeyError === 'string' && myKeyError !== '') {
            rows.push(row('我的 key', myKeyError, 'um-muted', 'my-key-err'))
          }

          rows.push(React.createElement('div', { className: 'um-group', key: 'g-acct' }, '账号合计（所有 key）'))
          if (usageOk) {
            const month = usageS.month !== null ? usageS.month : { input: 0, cacheHit: 0, output: 0, cost: 0 }
            rows.push(tokRow('本月 tokens', month, 'acct-month-tok'))
            rows.push(row('本月花费', money(month.cost, balSym), undefined, 'acct-month-cost'))
            rows.push(tokRow('今日 tokens', usageS.today, 'acct-today-tok'))
            rows.push(row('今日花费', money(usageS.today.cost, balSym), undefined, 'acct-today-cost'))
          } else if (typeof usageError === 'string' && usageError !== '') {
            rows.push(row('账号用量', usageError, 'um-muted', 'acct-usage-err'))
          }

          if (officialOk && usageS !== null) {
            const when = typeof usageS.syncedAt === 'number'
              ? new Date(usageS.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : ''
            rows.push(row('来源', '官方平台 · ' + when, 'um-muted', 'src'))
          }
        }

        const balanceBig = officialOk ? money(official.total, balSym) : '--'
        return React.createElement('div', { className: 'um-wrap' + (open ? ' um-open' : '') },
          React.createElement('div', { className: 'um-panel' },
            React.createElement('div', { className: 'um-head' },
              React.createElement('span', { className: 'um-title' }, 'DeepSeek 用量 · 余额'),
              React.createElement('span', { className: 'um-balance-big ' + balCls }, balanceBig),
            ),
            rows,
          ),
          React.createElement('div', { className: 'um-pill', onClick: () => setOpen(!open), title: open ? '点击收起' : '点击展开' },
            React.createElement('span', { className: 'um-strong' }, '今日 ' + pillCost),
            React.createElement('span', { className: 'um-sep' }, '·'),
            React.createElement('span', null, '⚡ ' + pillTokens),
            React.createElement('span', { className: 'um-chevron' }, '▾'),
          ),
        )
      },
    ))
  },
}

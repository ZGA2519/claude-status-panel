import { atom, read, update } from 'claude-code'
import type { Register, StateDollar } from 'claude-code'

import type { Agent, Item, Status } from '../types'

const items = atom({ plugin: 'progress-band', key: 'items' } as const, [] as Item[])
const agents = atom({ plugin: 'progress-band', key: 'agents' } as const, [] as Agent[])

const isOk = (r: { deny?: unknown; isError?: unknown }) => r.deny === undefined && !r.isError

// A todo list belongs to the main loop, or to the subagent whose loop called the tool.
const editList = async ($: StateDollar, agentId: string | undefined, fn: (list: Item[]) => Item[]) => {
  if (agentId) {
    await update($, agents, all => all.map(a => (a.id === agentId ? { ...a, items: fn(a.items) } : a)))
  } else {
    await update($, items, fn)
  }
}

const setAgent = ($: StateDollar, id: string, fn: (a: Agent) => Agent) =>
  update($, agents, all => all.map(a => (a.id === id ? fn(a) : a)))

// Desktop's plan tool: 1-based `done`/`start`, `advance` moves in_progress to the next pending.
export type PlanInput = {
  items?: { content: string; status: Status }[]
  advance?: boolean
  done?: number[]
  start?: number
}

export const applyPlan = (list: Item[], e: PlanInput): Item[] => {
  const next: Item[] = e.items
    ? e.items.map((it, i) => ({ id: String(i), label: it.content, status: it.status }))
    : list.map(it => ({ ...it }))
  const set = (i: number, status: Status) => {
    const it = next[i]
    if (it) it.status = status
  }

  if (e.advance) {
    set(next.findIndex(it => it.status === 'in_progress'), 'completed')
    set(next.findIndex(it => it.status === 'pending'), 'in_progress')
  }
  for (const n of e.done ?? []) set(n - 1, 'completed')
  if (e.start) set(e.start - 1, 'in_progress')

  return next
}

const CORAL = ['#D97757', '#F2B880'] as const
const MINT = ['#10B981', '#6EE7B7'] as const

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0')
export const mix = (a: string, b: string, t: number) => {
  const ch = (s: string, i: number) => parseInt(s.slice(i, i + 2), 16)
  return '#' + [1, 3, 5].map(i => hex2(ch(a, i) + (ch(b, i) - ch(a, i)) * t)).join('')
}

export const summary = (list: Item[]) => {
  const total = list.length
  const done = list.filter(it => it.status === 'completed').length
  const active = list.findIndex(it => it.status === 'in_progress')
  const isDone = done === total
  const upNext = list.find(it => it.status === 'pending')

  return {
    total,
    done,
    isDone,
    active,
    pct: Math.round((done / total) * 100),
    step: active >= 0 ? active + 1 : Math.min(done + 1, total),
    label: isDone ? 'All done' : (list[active]?.label ?? (upNext ? `Up next: ${upNext.label}` : '')),
    colors: isDone ? MINT : CORAL,
  }
}

// Desktop: one rounded segment per step on a shared gradient; the active one pulses.
// ponytail: past 24 steps segments get too thin, so it falls back to one continuous track.
const svgDoc = (W: number, H: number, colors: readonly [string, string], body: string) =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="0">`,
    `<stop offset="0" stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/>`,
    '</linearGradient></defs>',
    body,
    '</svg>',
  ].join('')

export const segmentsSvg = (list: Item[], isWorking: boolean, W = 1600, H = 14) => {
  const { colors, done, total } = summary(list)
  const isSegmented = total <= 24
  const gap = isSegmented ? 10 : 0
  const w = isSegmented ? (W - gap * (total - 1)) / total : W
  const segs = isSegmented
    ? list.map((it, i) => ({
        x: i * (w + gap),
        fill: it.status === 'completed' ? 1 : 0,
        isActive: it.status === 'in_progress',
      }))
    : [{ x: 0, fill: done / total, isActive: false }]
  const rect = (x: number, width: number, extra: string) =>
    `<rect x="${x.toFixed(1)}" y="0" width="${width.toFixed(1)}" height="${H}" rx="${H / 2}" ${extra}`
  const pulse = isWorking
    ? '><animate attributeName="opacity" values="0.25;0.9;0.25" dur="1.8s" repeatCount="indefinite"/></rect>'
    : '/>'

  return svgDoc(
    W,
    H,
    colors,
    segs
      .map(s =>
        [
          rect(s.x, w, 'fill="#888888" fill-opacity="0.22"/>'),
          s.fill > 0 ? rect(s.x, w * s.fill, 'fill="url(#g)"/>') : '',
          s.isActive ? rect(s.x, w, 'fill="url(#g)" opacity="0.55"') + pulse : '',
        ].join(''),
      )
      .join(''),
  )
}

// A subagent with no todo list: a gradient glint sweeping the track while it runs, full when done.
export const activitySvg = (isDone: boolean, W = 480, H = 16) => {
  const r = H / 2
  const blob = W * 0.35
  const full = `<rect width="${W}" height="${H}" rx="${r}"`

  return svgDoc(
    W,
    H,
    isDone ? MINT : CORAL,
    isDone
      ? `${full} fill="url(#g)"/>`
      : `<clipPath id="c">${full}/></clipPath>${full} fill="#888888" fill-opacity="0.22"/>` +
          `<g clip-path="url(#c)"><rect x="${-blob}" width="${blob}" height="${H}" rx="${r}" fill="url(#g)">` +
          `<animate attributeName="x" values="${-blob};${W}" dur="1.4s" repeatCount="indefinite"/></rect></g>`,
  )
}

export const agentMeta = (a: Agent) => {
  const s = a.items.length > 0 ? summary(a.items) : undefined
  const tools = `${a.tools} tool${a.tools === 1 ? '' : 's'}`

  return {
    summary: s,
    colors: a.isDone || s?.isDone ? MINT : CORAL,
    meta: [s && `${s.done}/${s.total}`, tools, !a.isDone && a.lastTool].filter(Boolean).join(' · '),
  }
}

// Terminal: a thin heavy line, filled cells shaded across the gradient, a half cell at the edge.
export const lineCells = (frac: number, width: number, colors: readonly [string, string]) => {
  const exact = frac * width
  const full = Math.floor(exact)
  const half = exact - full >= 0.5 && full < width
  const cells = Array.from({ length: full + (half ? 1 : 0) }, (_, i) => ({
    char: i === full ? '╸' : '━',
    color: mix(colors[0], colors[1], width > 1 ? i / (width - 1) : 0),
  }))

  return { cells, rest: '━'.repeat(width - cells.length) }
}

export const register: Register = on => {
  // Terminal CLI: TodoWrite sends the whole list.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const r = await next(e)
    if (isOk(r)) {
      await editList($, e.agentId, () =>
        e.todos.map((t, i) => ({ id: String(i), label: t.content, status: t.status })),
      )
    }
    return r
  }).catch(($, e, next) => next(e))

  // Terminal CLI: Task tools build the list one entry at a time.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError) {
      const id = r.result.task.id
      await editList($, e.agentId, list => [...list, { id, label: e.subject, status: 'pending' as const }])
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const r = await next(e)
    if (isOk(r)) {
      const { taskId, subject, status } = e
      await editList($, e.agentId, list =>
        status === 'deleted'
          ? list.filter(it => it.id !== taskId)
          : list.map(it =>
              it.id === taskId
                ? { ...it, label: subject ?? it.label, status: status ?? it.status }
                : it,
            ),
      )
    }
    return r
  }).catch(($, e, next) => next(e))

  // Claude desktop: the pinned plan list, checked off by wrap_up.
  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && isOk(r)) {
      await update($, items, list => applyPlan(list, e as PlanInput))
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && isOk(r)) {
      await update($, items, list => list.map(it => ({ ...it, status: 'completed' as const })))
    }
    return r
  }).catch(($, e, next) => next(e))

  // Subagents: one row each, from spawn to its own turn.complete.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const id = r.agentId
    if (id) {
      const row: Agent = {
        id,
        type: e.subagentType,
        label: e.description || e.name || e.subagentType,
        isDone: false,
        tools: 0,
        items: [],
      }
      await update($, agents, all =>
        all.some(a => a.id === id)
          ? all.map(a => (a.id === id ? { ...a, isDone: false } : a))
          : [...all, row],
      )
    }
    return r
  }).catch(($, e, next) => next(e))

  // Every tool call a subagent makes: count it and remember the latest.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      const tool = e.tool.replace(/^mcp__.*?__/, '')
      await setAgent($, e.agentId, a => ({ ...a, tools: a.tools + 1, lastTool: tool }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A teammate wakes for another turn. A main turn starting drops rows of background
  // subagents that finished while idle.
  on('turn.start', async ($, e, next) => {
    if (e.agentId) {
      await setAgent($, e.agentId, a => ({ ...a, isDone: false }))
    } else {
      await update($, agents, all => all.filter(a => !a.isDone))
    }
    return next(e)
  })

  // A subagent's turn ending finishes its row. The main turn ending drops a finished
  // list and finished subagents, so the next turn starts clean; unfinished ones
  // (CLI tasks spanning turns, background agents) come back with the next turn.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      await setAgent($, e.agentId, a => ({ ...a, isDone: true }))
    } else {
      const list = await read($, items)
      if (list.length > 0 && list.every(it => it.status === 'completed')) {
        await update($, items, () => [])
      }
      await update($, agents, all => all.filter(a => !a.isDone))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, items)
    const subs = await read($, agents)
    // Shown while a turn runs, or while a background subagent is still working.
    const isBusy = e.props.isWorking || subs.some(a => !a.isDone)
    if (e.props.hasSurvey || !isBusy || (list.length === 0 && subs.length === 0)) {
      return next(e)
    }

    const s = list.length > 0 ? summary(list) : undefined

    if (e.surface === 'desktop') {
      const { Box, Text, Svg } = $.ui.resolve(e)

      return (
        <Box flexDirection="column" gap="xs" paddingY="xs">
          {s ? (
            <Box flexDirection="column" gap="xs">
              <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
                <Box flexDirection="row" alignItems="center" gap="xs" flexShrink={1}>
                  <Text size="footnote" weight="semibold" color={s.colors[0]}>
                    {s.isDone ? '✓ Complete' : `Step ${s.step} of ${s.total}`}
                  </Text>
                  {s.isDone ? null : (
                    <Text size="footnote" color="subtle" wrap="truncate-end">
                      {s.label}
                    </Text>
                  )}
                </Box>
                <Text size="footnote" weight="semibold" tabular color={s.colors[0]}>
                  {`${s.pct}%`}
                </Text>
              </Box>
              <Svg
                source={segmentsSvg(list, !s.isDone)}
                alt={`${s.done} of ${s.total} steps done (${s.pct}%)`}
                isInteractive={!s.isDone}
              />
            </Box>
          ) : null}
          {subs.map(a => {
            const m = agentMeta(a)
            const isLive = !a.isDone

            return (
              <Box flexDirection="row" alignItems="center" gap="sm">
                <Box flexDirection="row" alignItems="center" gap="xs" flexGrow={1} flexShrink={1}>
                  <Text size="footnote" color="subtle">↳</Text>
                  <Text size="footnote" weight="medium" color={m.colors[0]}>
                    {a.isDone ? `✓ ${a.type}` : a.type}
                  </Text>
                  <Text size="footnote" color="subtle" wrap="truncate-end">
                    {a.label}
                  </Text>
                </Box>
                <Text size="footnote" color="subtle" tabular>
                  {m.meta}
                </Text>
                <Svg
                  width={120}
                  source={a.items.length > 0 ? segmentsSvg(a.items, isLive, 480, 16) : activitySvg(a.isDone)}
                  alt={`${a.type} subagent: ${a.isDone ? 'done' : 'running'}, ${m.meta}`}
                  isInteractive={isLive}
                />
              </Box>
            )
          })}
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)
    const mainLine = (() => {
      if (!s) return null
      // ponytail: leaves ~22 cells for glyph/percent/count plus up to 30 of label
      const width = Math.max(12, Math.min(36, e.props.bodyColumns - 22 - Math.min(s.label.length, 30)))
      const line = lineCells(s.done / s.total, width, s.colors)

      return (
        <Box flexDirection="row" gap={1}>
          <Text color={s.colors[0]}>{s.isDone ? '✓' : '●'}</Text>
          <Box flexDirection="row">
            {line.cells.map(c => (
              <Text color={c.color}>{c.char}</Text>
            ))}
            <Text color="inactive">{line.rest}</Text>
          </Box>
          <Text bold color={s.colors[0]}>{`${s.pct}%`.padStart(4)}</Text>
          <Text dimColor>{`${s.done}/${s.total}`}</Text>
          <Text wrap="truncate-end">{s.label}</Text>
        </Box>
      )
    })()

    return (
      <Box flexDirection="column">
        {mainLine}
        {subs.map(a => {
          const m = agentMeta(a)
          const mini = m.summary ? lineCells(m.summary.done / m.summary.total, 10, m.colors) : undefined

          return (
            <Box flexDirection="row" gap={1} paddingLeft={2}>
              <Text dimColor>↳</Text>
              <Text color={m.colors[0]}>{a.isDone ? '✓' : '◌'}</Text>
              <Text bold>{a.type}</Text>
              {mini ? (
                <Box flexDirection="row">
                  {mini.cells.map(c => (
                    <Text color={c.color}>{c.char}</Text>
                  ))}
                  <Text color="inactive">{mini.rest}</Text>
                </Box>
              ) : null}
              <Text dimColor>{m.meta}</Text>
              <Text wrap="truncate-end">{a.label}</Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}

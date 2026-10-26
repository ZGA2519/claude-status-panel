import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { Account, Call, FornixMemory, FornixSearch, FornixServer, MascotAssets, Prompt, SessionSummary, Stats, Tab } from '../types'
import { accountLines, accountOf, describe, fmtDur, fmtNum, matches, mcpRows, prettyTool, rel } from './format'
import { emojiOf, iconFor, svgOf } from './icons'
import type { IconKey } from './icons'
import { BUILD_MASCOT_PY } from './build-mascot-script'
import { DEFAULT_MASCOT, mascot, mascotText } from './mascot'

const PANE = 'status-panel'
const KEEP = 50
const NO_STATS: Stats = { calls: 0, failed: 0, ms: 0, adds: 0, dels: 0, subagent: 0, byTool: {}, tokensIn: 0, tokensOut: 0, startedAt: 0 }

const calls = atom({ plugin: 'status-panel', key: 'calls' } as const, [])
const pinned = atom({ plugin: 'status-panel', key: 'pinned' } as const, [])
const working = atom({ plugin: 'status-panel', key: 'isWorking' } as const, false)
const stats = atom({ plugin: 'status-panel', key: 'stats' } as const, NO_STATS)
const query = atom({ plugin: 'status-panel', key: 'query' } as const, '') // the applied filter
const draft = atom({ plugin: 'status-panel', key: 'draft' } as const, '') // what the search box holds
const limit = atom({ plugin: 'status-panel', key: 'limit' } as const, 1) // prompts shown; "Load more" adds one
const prompts = atom({ plugin: 'status-panel', key: 'prompts' } as const, [])
const currentPrompt = atom({ plugin: 'status-panel', key: 'currentPrompt' } as const, '')
const tab = atom({ plugin: 'status-panel', key: 'tab' } as const, 'summary')
const NO_SUMMARY: SessionSummary = { text: '', prompt: 0, updatedAt: 0, isUpdating: false }
const summary = atom({ plugin: 'status-panel', key: 'summary' } as const, NO_SUMMARY)
const mascotRev = atom({ plugin: 'status-panel', key: 'mascotRev' } as const, 0) // bumped when the mascot changes
const beat = atom({ plugin: 'status-panel', key: 'beat' } as const, 0) // the CLI mascot's frame; only the CLI view reads it
const fornix = atom({ plugin: 'status-panel', key: 'fornixServers' } as const, [])
const fornixSearch = atom({ plugin: 'status-panel', key: 'fornixSearch' } as const, {})
const account = atom({ plugin: 'status-panel', key: 'account' } as const, null)

const TINT = { running: 'warning', done: 'success', error: 'error' } as const
const BADGE = { running: '● RUNNING', done: '✓ DONE', error: '✕ FAILED' } as const
// fornix servers: `fornix` for a repo of its own, `fornix-<repo>` per repo in a folder over several
const FORNIX_NAME = /^fornix(?:-[\w.-]+)?$/
const FORNIX_TOOL = /^mcp__(fornix(?:-[\w.-]+)?)__(\w+)$/

// CLI mascot: the render hook says whether the text mascot is on screen and whether to dance; a timer steps the beat.
let isTextMascotShown = false
let isDancing = false
// Summary: turn.complete marks it due; a session.start timer writes it, so no prompt waits on the model.
// A prompt's transcript row and its turn.start can come in either order: whichever is first waits for the other.
let pendingRow = ''
let rowlessPrompt = ''
const setPromptRow = (id: string, rowId: string) => (list: Prompt[]) => list.map(p => (p.id === id ? { ...p, rowId } : p))

let isSummaryDue = false
let isSummarizing = false
let lastAnswer = ''
const SUMMARY_SYSTEM =
  'You keep a brief running summary of a Claude Code session for a side panel. Reply in Markdown: one bold headline line, ' +
  'then 3 to 6 short bullets covering what has been done so far and where things stand now (next step or open question). ' +
  'Under 120 words, plain wording, no preamble, no closing remarks.'

/** Every fornix server of the working directory's .mcp.json, with its store folder (`--directory`). */
async function fornixConfigured($: EngineInterface): Promise<{ name: string; dir?: string }[]> {
  // ponytail: the folder's .mcp.json only; a server added in another scope shows up once its tools are called
  const doc = await $.fs.read('.mcp.json').then(t => JSON.parse(String(t)), () => ({}))
  return Object.entries((doc?.mcpServers ?? {}) as Record<string, { args?: unknown }>)
    .filter(([name]) => FORNIX_NAME.test(name))
    .map(([name, v]) => {
      const args = Array.isArray(v?.args) ? v.args.map(String) : []
      const i = args.indexOf('--directory')
      return { name, dir: i >= 0 ? args[i + 1] : undefined }
    })
}

const errText = (err: unknown) => String(err instanceof Error ? err.message : err).slice(0, 300)
const failed = (r: McpToolResult) => new Error(r.content.map(b => b.text ?? '').join(' ') || 'the server reported an error')
const memoryOf = (r: any): FornixMemory => ({
  id: String(r.id),
  ts: String(r.ts ?? ''),
  text: String(r.text ?? '').slice(0, 400),
  tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
  score: typeof r.score === 'number' ? r.score : undefined,
})
const memoriesOf = (r: McpToolResult) => mcpRows(r).filter(m => m?.id !== undefined).map(memoryOf)

/** Ask one fornix server for its scopes and newest memories, and read the sync flag in its store folder. */
async function probe($: EngineInterface, name: string, dir: string | undefined, at: number): Promise<FornixServer> {
  const sync: FornixServer['sync'] =
    dir === undefined ? undefined : await $.fs.read(`${dir}/.sync-on`).then(t => (String(t).trim() === 'readonly' ? 'readonly' : 'full'), () => 'off')
  const base = { name, dir, sync, checkedAt: at, recalled: 0, written: 0 }
  try {
    const [sc, sel] = await Promise.all([$.mcp.call(name, 'scopes'), $.mcp.call(name, 'select', { query: '', k: 5 })])
    if (sc.isError || sel.isError) throw failed(sc.isError ? sc : sel)
    const scopes = mcpRows(sc)
      .filter(r => typeof r?.scope === 'string')
      .map(r => ({ scope: r.scope, count: Number(r.count) || 0, tags: r.tags ?? {} }))
    return { ...base, state: 'ok', scopes, recent: memoriesOf(sel) }
  } catch (err) {
    return { ...base, state: 'down', error: errText(err), scopes: [], recent: [] }
  }
}

/** Search one server's memories; an empty query clears the search and its card shows the newest again. */
async function searchFornix($: EngineInterface, name: string, query: string): Promise<void> {
  const q = query.trim()
  const put = (found: FornixSearch | undefined) =>
    update($, fornixSearch, ({ [name]: _, ...rest }): Record<string, FornixSearch> => (found ? { ...rest, [name]: found } : rest))
  if (!q) return void (await put(undefined))
  try {
    const r = await $.mcp.call(name, 'select', { query: q, k: 8 })
    if (r.isError) throw failed(r)
    await put({ query: q, hits: memoriesOf(r) })
  } catch (err) {
    await put({ query: q, hits: [], error: errText(err) })
  }
}

/** Flip a server's sync: the `.sync-on` flag fornix's prompt hook reads, written or removed in its store folder. */
async function setSync($: EngineInterface, sv: FornixServer, mode: 'off' | 'readonly' | 'full'): Promise<void> {
  if (sv.dir === undefined) return
  const flag = `${sv.dir.startsWith('/') ? sv.dir : `${await $.session.cwd()}/${sv.dir}`}/.sync-on`
  try {
    if (mode !== 'off') await $.fs.write(flag, `${mode}\n`)
    else {
      // ponytail: $.fs has no delete; rm -f is the flag's whole removal
      const r = await $.process.run(['rm', '-f', flag])
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `rm exited ${r.exitCode}`)
    }
  } catch (err) {
    return void $.ui.toast(`Could not change sync for ${sv.name}: ${errText(err)}`)
  }
  await update($, fornix, list => list.map(s => (s.name === sv.name ? { ...s, sync: mode } : s)))
  void $.ui.toast(
    mode !== 'off'
      ? `${sv.name}: sync ${mode === 'full' ? 'on' : 'on, read-only'} from the next prompt`
      : sv.sync === 'full'
        ? `${sv.name}: sync off. Nothing was flushed: /context-stop-sync stores what is left first`
        : `${sv.name}: sync off`,
  )
}

/** How Claude Code is signed in: `claude auth status`, else the login record in .claude.json and ANTHROPIC_API_KEY. */
async function readAccount($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  // it prints its JSON whether or not it exits 0 (signed out exits 1)
  const ran = await $.process.run(['claude', 'auth', 'status', '--json'], { timeoutMs: 15_000 }).catch(() => undefined)
  let found: Account | undefined = ran ? accountOf(ran.stdout, at) : undefined
  if (!found || (found.method !== 'none' && !found.email)) {
    // ponytail: no `claude` on PATH (some desktop installs), or a token login that prints no email
    const [dir, home, key] = await Promise.all([$.env.get('CLAUDE_CONFIG_DIR'), $.env.get('HOME'), $.env.get('ANTHROPIC_API_KEY')])
    const login = await $.fs
      .read(`${dir ?? home ?? '~'}/.claude.json`)
      .then(t => JSON.parse(String(t))?.oauthAccount, () => undefined)
    const email = typeof login?.emailAddress === 'string' ? login.emailAddress : undefined
    const org = typeof login?.organizationName === 'string' ? login.organizationName : undefined
    found = found
      ? { ...found, email: found.email ?? email, org: found.org ?? org }
      : { method: key ? 'api_key' : login ? 'claude.ai' : 'none', keySource: key ? 'ANTHROPIC_API_KEY' : undefined, email, org, checkedAt: at }
  }
  await update($, account, () => found)
}

/** Re-read every fornix server: the configured ones and any whose tools were called. One check at a time. */
let checking: Promise<void> | undefined
const checkFornix = ($: EngineInterface) => (checking ??= readFornix($).finally(() => (checking = undefined)))

async function readFornix($: EngineInterface): Promise<void> {
  const [found, seen, at] = await Promise.all([fornixConfigured($), read($, fornix), $.clock.now()])
  const list = [...found, ...seen.filter(s => !found.some(f => f.name === s.name))]
  const probed = await Promise.all(list.map(s => probe($, s.name, s.dir, at)))
  // the session's counts are tool.call's, and may have moved while the servers answered
  await update($, fornix, was => probed.map(p => ({ ...p, recalled: was.find(w => w.name === p.name)?.recalled ?? 0, written: was.find(w => w.name === p.name)?.written ?? 0 })))
}

/** One fornix tool call answered: count what it recalled or wrote on its server, listing the server if new. */
const tally = (name: string, recalled: number, written: number) => (list: FornixServer[]) => {
  const bump = (s: FornixServer) => ({ ...s, recalled: s.recalled + recalled, written: s.written + written })
  return list.some(s => s.name === name)
    ? list.map(s => (s.name === name ? bump(s) : s))
    : [...list, bump({ name, state: 'unknown', scopes: [], recent: [], checkedAt: 0, recalled: 0, written: 0 })]
}

async function summarize($: EngineInterface): Promise<void> {
  if (isSummarizing) return
  isSummarizing = true
  isSummaryDue = false
  try {
    await update($, summary, s => ({ ...s, isUpdating: true, error: undefined }))
    const [prev, ps, list] = await Promise.all([read($, summary), read($, prompts), read($, calls)])
    const p = ps[ps.length - 1]
    const tasks = (p ? list.filter(c => c.promptId === p.id) : list).slice(0, 25)
    const steps = tasks.map(c => `${c.status === 'error' ? 'failed' : 'ok'}: ${prettyTool(c.tool)} ${c.summary}`.slice(0, 160)).join('\n')
    const prompt = [
      `Current summary:\n${prev.text || '(none yet: this is the first one)'}`,
      p ? `Latest prompt (#${p.n}): ${p.text}` : '',
      `Tool calls for it:\n${steps || '(none)'}`,
      `Claude's reply (may be cut):\n${lastAnswer.slice(0, 4000) || '(none)'}`,
      'Rewrite the summary so it covers the whole session so far.',
    ]
      .filter(Boolean)
      .join('\n\n')
    const r = await $.model.complete({ model: 'haiku', system: SUMMARY_SYSTEM, prompt, maxTokens: 400 })
    const at = await $.clock.now()
    if (r.isAnswered && r.text.trim()) {
      await update($, summary, () => ({ text: r.text.trim(), prompt: p?.n ?? 0, updatedAt: at, isUpdating: false }))
    } else {
      await update($, summary, s => ({ ...s, isUpdating: false, error: r.isAnswered ? 'empty reply' : r.reason }))
    }
  } catch (err) {
    await update($, summary, s => ({ ...s, isUpdating: false, error: String(err) })).catch(() => {})
  } finally {
    isSummarizing = false
  }
}

// An uploaded mascot (kept in $.store across sessions); the built-in default, if any, when none.
let custom: MascotAssets | undefined
const isMascot = (v: unknown): v is MascotAssets =>
  typeof v === 'object' && v !== null && typeof (v as MascotAssets).gif === 'string' && Array.isArray((v as MascotAssets).raster?.frames)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'status-panel', description: 'Open the status panel (cwd + recent tool calls)' })
    const now = await $.clock.now()
    const saved = await $.store.get('mascot')
    $.clock.every(2000, () => {
      if (isSummaryDue && !isSummarizing) void summarize($)
    })
    custom = isMascot(saved) ? saved : undefined
    await update($, stats, s => (s.startedAt ? s : { ...s, startedAt: now }))
    // ponytail: 4 redraws a second of the CLI pane while working, 2 GIF frames a step; lower if a slow terminal lags
    $.clock.every(250, () => {
      if (!isTextMascotShown || !isDancing) return
      void update($, beat, n => n + 2).catch(() => {})
    })
    void $.ui.open({ id: PANE, title: 'Status' })
    void checkFornix($)
    void readAccount($)

    return next(e)
  })

  on('command.run', { command: 'status-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Status' })

    return {} // a panel needs no transcript line
  })

  on('turn.start', async ($, e, next) => {
    await update($, working, () => true)
    const text = e.text.trim()
    if (text) {
      const rowId = pendingRow || undefined
      rowlessPrompt = rowId ? '' : e.turnId
      pendingRow = ''
      await update($, prompts, list => [...list, { id: e.turnId, n: (list[list.length - 1]?.n ?? 0) + 1, text: text.slice(0, 300), rowId }].slice(-30))
      await update($, currentPrompt, () => e.turnId)
      await update($, limit, () => 1)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // remember the transcript row of each prompt typed in the main chat, so its Activity heading can scroll to it
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      if (rowlessPrompt) {
        await update($, prompts, setPromptRow(rowlessPrompt, e.uuid))
        rowlessPrompt = ''
      } else pendingRow = e.uuid
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, working, () => false)
      lastAnswer = e.answer
      isSummaryDue = true
      void checkFornix($) // the turn may have flipped the sync flag
    }
    const u = e.usage
    if (u) {
      const tokensIn = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, stats, s => ({ ...s, tokensIn: s.tokensIn + tokensIn, tokensOut: s.tokensOut + u.output_tokens }))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id: id, agentId, requestMeta: _meta, ...input } = e
    const [cwd, t0, promptId] = await Promise.all([$.session.cwd(), $.clock.now(), read($, currentPrompt)])
    const name = String(tool)
    const call: Call = { id, tool: name, agentId, status: 'running', promptId: promptId || undefined, ...describe(name, input, undefined, cwd) }
    await update($, calls, list => [call, ...list].slice(0, KEEP))

    const res = await next(e)
    const isError = res.deny !== undefined || res.isError === true
    const ms = (await $.clock.now()) - t0
    const done: Call = { ...call, status: isError ? 'error' : 'done', ms, ...describe(name, input, res, cwd) }
    await update($, calls, list => list.map(c => (c.id === id ? { ...c, ...done } : c)))
    const [, server, op] = FORNIX_TOOL.exec(name) ?? []
    if (server && !isError) {
      const hits = op === 'select' ? (res.text?.match(/"id"\s*:/g) ?? []).length : 0 // one id per memory returned
      await update($, fornix, tally(server, hits, op === 'write' ? 1 : 0))
      void checkFornix($)
    }
    // per file, relative to the working directory: reads, and edits/writes with the lines they changed
    const path = !isError && 'file_path' in input ? rel(String(input.file_path), cwd) : ''
    const isRead = path !== '' && name === 'Read'
    const isWrite = path !== '' && (name === 'Edit' || name === 'Write')
    await update($, stats, s => {
      const reads = s.byRead ?? {} // absent in a session started before 0.18
      const writes = s.byWrite ?? {}
      const was = writes[path] ?? { n: 0, adds: 0, dels: 0 }
      return {
        ...s,
        calls: s.calls + 1,
        failed: s.failed + (isError ? 1 : 0),
        ms: s.ms + ms,
        adds: s.adds + (done.adds ?? 0),
        dels: s.dels + (done.dels ?? 0),
        subagent: s.subagent + (agentId ? 1 : 0),
        byTool: { ...s.byTool, [name]: (s.byTool[name] ?? 0) + 1 },
        byRead: isRead ? { ...reads, [path]: (reads[path] ?? 0) + 1 } : reads,
        byWrite: isWrite ? { ...writes, [path]: { n: was.n + 1, adds: was.adds + (done.adds ?? 0), dels: was.dels + (done.dels ?? 0) } } : writes,
      }
    })

    return res
  }).catch(($, e, next) => next(e)) // ponytail: an observer never blocks a tool; next(e) replays if already run

  // the search box (search-box.tsx) posts { type: 'search', text } or { type: 'clear' }
  on('ui.message', { requestId: PANE }, async ($, e) => {
    const data = (e.data ?? {}) as { type?: string; text?: unknown; channel?: unknown }
    const text = data.type === 'search' && typeof data.text === 'string' ? data.text : ''
    const isSearch = data.type === 'search' || data.type === 'clear'
    // a server card's search box names its server; only ever a fornix one is asked
    if (typeof data.channel === 'string') {
      if (isSearch && FORNIX_NAME.test(data.channel)) await searchFornix($, data.channel, text)
    } else if (isSearch) {
      await update($, draft, () => text)
      await update($, query, () => text)
      await update($, limit, () => 1)
    }

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Code, Markdown } = els
    // by surface, not `'Svg' in els`: the terminal's table carries an Svg that draws nothing
    const Svg = (e.surface === 'desktop' || e.surface === 'mobile') && 'Svg' in els ? els.Svg : undefined
    const isCli = e.surface === 'terminal'
    const Input = 'Input' in els ? els.Input : undefined
    const Client = 'Client' in els ? els.Client : undefined
    const [cwd, model, turns, now, list, pins, isWorking, st, q, typed] = await Promise.all([
      $.session.cwd(),
      $.session.model(),
      $.session.turns(),
      $.clock.now(),
      read($, calls),
      read($, pinned),
      read($, working),
      read($, stats),
      read($, query),
      read($, draft),
    ])
    const stored = (await read($, tab)) as string // 'status' from before the four tabs means Activity; the Agents tab is gone
    const view: Tab = stored === 'status' ? 'activity' : stored === 'agents' ? 'summary' : (stored as Tab)
    const sm = await read($, summary)
    const servers = await read($, fornix)
    const found = await read($, fornixSearch)
    const acct = await read($, account)
    await read($, mascotRev) // redraw when a mascot is uploaded or reset
    const pet = custom ?? DEFAULT_MASCOT // undefined: no mascot until one is picked
    const lim = await read($, limit)
    const promptList = await read($, prompts)
    const home = cwd.replace(/^\/(Users|home)\/[^/]+/, '~')
    const isBusy = isWorking || list.some(c => c.status === 'running')
    const shown = q.trim() ? list.filter(c => matches(c, q)) : list
    const search = async () => {
      const text = await read($, draft) // the box as it is now, not as it was drawn
      await update($, query, () => text)
      await update($, limit, () => 1)
    }
    const clear = async () => {
      await update($, draft, () => '')
      await update($, query, () => '')
      await update($, limit, () => 1)
    }
    isTextMascotShown = isCli && pet !== undefined
    isDancing = isBusy
    const step = isCli && isBusy ? await read($, beat) : 0 // read only here, so the desktop never redraws per beat
    const toggle = (id: string) => update($, pinned, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))
    const byRead = st.byRead ?? {}
    const byWrite = st.byWrite ?? {}
    const toolRows = Object.entries(st.byTool).map(([t, n]) => ({ name: prettyTool(t), n }))

    const icon = (k: IconKey, size = 16) =>
      Svg ? <Svg source={svgOf(k)} alt={k} width={size} height={size} /> : <Text>{emojiOf(k)}</Text>

    /** One row per file or tool, most first, each with a bar scaled to the largest count. */
    const counts = (id: string, rows: { name: string; n: number; extra?: JSX.Element }[], most = Infinity) => {
      const sorted = [...rows].sort((a, b) => b.n - a.n).slice(0, most)
      const max = sorted[0]?.n ?? 1
      if (!sorted.length) return <Text dimColor>nothing yet</Text>
      return sorted.map(x => (
        <Box key={`${id}-${x.name}`} flexDirection="row" justifyContent="space-between" gap={2}>
          <Text wrap="truncate-start">{x.name}</Text>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {x.extra}
            <Text color="suggestion">{'▇'.repeat(Math.max(1, Math.round((x.n / max) * 8)))}</Text>
            <Text bold>×{x.n}</Text>
          </Box>
        </Box>
      ))
    }
    /** A card counting files read, files written or tool calls; its title opens the list of each and how often. */
    const countCard = (id: string, k: IconKey, title: string, n: number, rows: { name: string; n: number; extra?: JSX.Element }[]) => {
      const isOpen = pins.includes(id)
      return (
        <Box key={`${id}-card`} flexDirection="column" borderStyle="round" borderColor={isOpen ? 'suggestion' : undefined} borderDimColor={!isOpen} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Box flexDirection="row" gap={1} alignItems="center">
              {icon(k, 16)}
              <Button key={id} plain dimColor={!isOpen} onPress={() => toggle(id)}>
                {`${title} ${isOpen ? '▾' : '▸'}`}
              </Button>
            </Box>
            <Text bold>{n}</Text>
          </Box>
          {isOpen && (
            <Box flexDirection="column" marginTop={1}>
              {counts(id, rows)}
            </Box>
          )}
        </Box>
      )
    }
    /** A titled card of the Statistics tab. */
    const card = (key: string, k: IconKey, title: string, body: (JSX.Element | false)[]) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Box flexDirection="row" gap={1} alignItems="center" marginBottom={1}>
          {icon(k, 16)}
          <Text dimColor bold>
            {title}
          </Text>
        </Box>
        {body}
      </Box>
    )

    const row = (label: string, value: string | JSX.Element) => (
      <Box key={`row-${label}`} flexDirection="row" justifyContent="space-between" gap={2}>
        <Text dimColor>{label}</Text>
        {typeof value === 'string' ? (
          <Text bold wrap="truncate-start">
            {value}
          </Text>
        ) : (
          value
        )}
      </Box>
    )

    const placeholder = 'Search tasks: tool, file, command, output…'
    // A Client draws its own full-width field (the surface's Input keeps a fixed width); the plain Input is the fallback.
    const searchBar = Client ? (
      <Client key="search" module="./search-box.tsx" props={{ value: q, placeholder, isTerminal: isCli }} width="100%" />
    ) : Input && (
      <Box flexDirection="column" gap={1} width="100%" alignItems="stretch">
        <Box flexDirection="column" width="100%" alignItems="stretch">
          <Input
            key="search"
            placeholder={placeholder}
            value={typed}
            onInput={v => update($, draft, () => v)}
            onSubmit={v => update($, draft, () => v).then(search)}
          />
        </Box>
        <Box flexDirection="row" gap={1} justifyContent="flex-end">
          <Button key="search-go" label="Search" variant="primary" onPress={search} />
          <Button key="search-clear" label="Clear" onPress={clear} />
        </Box>
      </Box>
    )
    const matchLine = q.trim() !== '' && (
      <Text dimColor>
        {shown.length} of {list.length} tasks match “{q.trim()}”
      </Text>
    )
    const emptyNote =
      list.length === 0 ? "Waiting for the agent's first tool call…" : shown.length === 0 ? `No tasks match “${q.trim()}”.` : ''

    const setTab = (t: Tab) => update($, tab, () => t)
    const tabButton = (t: Tab, label: string) => (
      <Button key={`tab-${t}`} label={label} variant={view === t ? 'primary' : 'secondary'} onPress={() => setTab(t)} />
    )

    const tabBar = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {tabButton('summary', 'Summary')}
        {tabButton('stats', 'Statistics')}
        {tabButton('activity', 'Activity')}
        {tabButton('fornix', servers.some(sv => sv.state === 'down') ? 'Fornix ✕' : servers.length > 1 ? `Fornix (${servers.length})` : 'Fornix')}
      </Box>
    )

    // Upload: the macOS file dialog, then the bundled converter (ffmpeg) shrinks the GIF for both surfaces.
    const uploadMascot = async () => {
      const home = (await $.env.get('HOME')) ?? ''
      const env = { HOME: home, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' }
      const pick = await $.process
        .run(['osascript', '-e', 'POSIX path of (choose file with prompt "Choose a GIF for your mascot" of type {"com.compuserve.gif"})'], {
          env,
          timeoutMs: 300_000,
        })
        .catch(() => undefined)
      if (!pick) return void $.ui.toast('Upload needs the macOS file dialog (osascript), which is not available here')
      if (pick.exitCode !== 0) return // cancelled
      void $.ui.toast('Converting your GIF…')
      // the converter rides in the plugin's code (fed to `python3 -`), so no install folder is assumed
      const built = await $.process
        .run(['python3', '-', pick.stdout.trim(), '--json'], { env, stdin: BUILD_MASCOT_PY, timeoutMs: 120_000 })
        .catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
      let assets: unknown
      try {
        assets = built.exitCode === 0 ? JSON.parse(built.stdout) : undefined
      } catch {}
      if (!isMascot(assets)) return void $.ui.toast(`Could not use that GIF: ${built.stderr.trim().split('\n').pop() || 'conversion failed'}`)
      await $.store.set('mascot', assets)
      custom = assets
      await update($, mascotRev, n => n + 1)
      void $.ui.toast('Mascot updated')
    }
    // the working directory opens in Finder (macOS `open`)
    const openCwd = async () => {
      const ran = await $.process.run(['open', cwd]).catch(() => undefined)
      void $.ui.toast(ran?.exitCode === 0 ? `Opened ${home} in Finder` : `Could not open ${home}`)
    }
    const resetMascot = async () => {
      await $.store.delete('mascot')
      custom = undefined
      await update($, mascotRev, n => n + 1)
      void $.ui.toast(DEFAULT_MASCOT ? 'Back to the default mascot' : 'Mascot removed')
    }

    // a prompt heading scrolls the chat to where that prompt was sent
    const jumpTo = async (p: Prompt | undefined) => {
      if (!p?.rowId) return void $.ui.toast('That prompt was sent before the panel could link it')
      const r = await $.ui.scroll({ to: { requestId: p.rowId }, block: 'start' }).catch(err => ({ deny: String(err) }))
      if (r.deny) void $.ui.toast(`Could not scroll to prompt ${p.n}: ${r.deny}`)
    }

    // Activity groups: one per prompt, newest first; tasks from before the first prompt the panel saw go last.
    const current = promptList[promptList.length - 1]?.id
    const groups = [
      ...[...promptList].reverse().map(p => ({ prompt: p as Prompt | undefined, tasks: shown.filter(c => c.promptId === p.id) })),
      { prompt: undefined, tasks: shown.filter(c => !c.promptId || !promptList.some(p => p.id === c.promptId)) },
    ].filter(g => g.tasks.length > 0 || (g.prompt !== undefined && g.prompt.id === current && !q.trim()))
    const visibleGroups = groups.slice(0, lim)
    const taskCard = (c: Call, isOpen: boolean) => (
      <Box
        key={`call-${c.id}`}
        flexDirection="column"
        borderStyle="round"
        borderColor={c.status === 'done' ? undefined : TINT[c.status]}
        borderDimColor={c.status === 'done'}
        hover={{ borderColor: 'suggestion' }}
        paddingX={1}
      >
        <Box flexDirection="row" gap={1} alignItems="center">
          {icon(iconFor(c.tool))}
          <Button key={`toggle-${c.id}`} plain onPress={() => toggle(c.id)}>
            <Text bold>{prettyTool(c.tool)}</Text>
            <Text dimColor> {isOpen ? '▾' : '▸'}</Text>
          </Button>
        </Box>
        {c.summary !== '' && <Text wrap="truncate-middle">{c.summary}</Text>}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text backgroundColor={TINT[c.status]} color="inverseText" bold>
            {` ${BADGE[c.status]} `}
          </Text>
          {c.ms !== undefined && <Text dimColor>⏱ {fmtDur(c.ms)}</Text>}
          {c.adds !== undefined && <Text color="success">+{c.adds}</Text>}
          {c.dels !== undefined && <Text color="error">−{c.dels}</Text>}
          {c.stat && <Text dimColor>{c.stat}</Text>}
          {c.agentId && <Text color="claude">◆ subagent</Text>}
        </Box>
        {isOpen &&
          c.sections.map(s => (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor bold>
                {s.label.toUpperCase()}
              </Text>
              <Code source={s.source} format={s.format} language={s.language} path={s.path} startLine={s.startLine} />
            </Box>
          ))}
      </Box>
    )

    const net = st.adds - st.dels
    const statsView = (
      <Box flexDirection="column" gap={1}>
        {countCard('stats-read', 'read', 'FILES READ', Object.keys(byRead).length, Object.entries(byRead).map(([name, n]) => ({ name, n })))}
        {countCard(
          'stats-written',
          'edit',
          'FILES WRITTEN',
          Object.keys(byWrite).length,
          Object.entries(byWrite).map(([name, v]) => ({
            name,
            n: v.n,
            extra: (
              <Text>
                <Text color="success">+{v.adds}</Text> <Text color="error">−{v.dels}</Text>
              </Text>
            ),
          })),
        )}
        {countCard('stats-tools', 'activity', 'TOOL CALLS', st.calls, toolRows)}
        {card('stats-changes', 'write', 'CHANGES', [
          row('Lines added', <Text bold color="success">+{st.adds}</Text>),
          row('Lines removed', <Text bold color="error">−{st.dels}</Text>),
          row('Net', <Text bold color={net > 0 ? 'success' : net < 0 ? 'error' : undefined}>{net > 0 ? `+${net}` : net < 0 ? `−${-net}` : '0'}</Text>),
        ])}
        {card('stats-calls', 'tool', 'TOOLS', [
          row(
            'Failed',
            st.failed ? (
              <Text bold color="error">
                {st.failed} of {st.calls} ({Math.round((st.failed / st.calls) * 100)}%)
              </Text>
            ) : (
              '0'
            ),
          ),
          row('Total time', st.calls ? fmtDur(st.ms) : '—'),
          row('Average per call', st.calls ? fmtDur(st.ms / st.calls) : '—'),
          row('Run by subagents', String(st.subagent)),
          <Box key="most" flexDirection="column" marginTop={1}>
            <Text dimColor>Most used</Text>
            {counts('most', toolRows, 3)}
          </Box>,
        ])}
        {card('stats-session', 'terminal', 'SESSION', [
          row('Prompts', String(turns)),
          row('Tokens in', fmtNum(st.tokensIn)),
          row('Tokens out', fmtNum(st.tokensOut)),
          row('Session age', st.startedAt ? fmtDur(now - st.startedAt) : '—'),
        ])}
      </Box>
    )

    const activityView = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          {icon('activity')}
          <Text bold>ACTIVITY</Text>
          {isBusy ? <Text color="warning">● working…</Text> : <Text dimColor>○ idle</Text>}
        </Box>

        {searchBar}
        {matchLine}
        {emptyNote !== '' && (
          <Box borderStyle="round" borderDimColor paddingX={1}>
            <Text dimColor italic>
              {emptyNote}
            </Text>
          </Box>
        )}

        {visibleGroups.map((g, gi) => (
          <Box key={`prompt-${g.prompt?.id ?? 'earlier'}`} flexDirection="column" gap={1}>
            {promptList.length > 0 && (
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                {g.prompt ? (
                  <Button key={`prompt-${g.prompt.id}`} plain onPress={() => jumpTo(g.prompt)}>
                    <Text color="claude" bold>
                      💬 Prompt {g.prompt.n}
                    </Text>
                    <Text> “{g.prompt.text.split('\n')[0]}”</Text>
                    <Text dimColor> ↗</Text>
                  </Button>
                ) : (
                  <Text color="claude" bold>
                    💬 Earlier activity
                  </Text>
                )}
                <Text dimColor>
                  · {g.tasks.length} task{g.tasks.length === 1 ? '' : 's'}
                </Text>
              </Box>
            )}
            {g.tasks.length === 0 && (
              <Text dimColor italic>
                No tool calls for this prompt yet.
              </Text>
            )}
            {g.tasks.map((c, i) => {
              const isOpen = (gi === 0 && i === 0) !== pins.includes(c.id) // the newest opens by itself; a click flips any task
              return taskCard(c, isOpen)
            })}
          </Box>
        ))}

        {groups.length > lim && (
          <Button
            key="load-more"
            label={`Load more (previous prompt · ${groups.length - lim} older)`}
            onPress={() => update($, limit, n => n + 1)}
          />
        )}
      </Box>
    )

    const summaryView = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          {icon('summary')}
          <Text bold>SUMMARY</Text>
          <Box flexGrow={1}>
            <Text dimColor wrap="truncate-end">
              {sm.isUpdating ? '↻ updating…' : sm.prompt ? `after prompt ${sm.prompt} · ${fmtDur(Math.max(0, now - sm.updatedAt))} ago` : ''}
            </Text>
          </Box>
          <Button key="summary-refresh" plain onPress={() => summarize($)}>
            <Text color="suggestion">↻ Refresh</Text>
          </Button>
        </Box>
        {sm.text ? (
          <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
            <Markdown text={sm.text} />
          </Box>
        ) : (
          <Box borderStyle="round" borderDimColor paddingX={1}>
            <Text dimColor italic>
              {sm.isUpdating ? 'Writing the first summary…' : 'A short summary of this session appears here after each prompt finishes.'}
            </Text>
          </Box>
        )}
        {sm.error && <Text color="error">Could not update the summary: {sm.error}</Text>}
      </Box>
    )

    const FX = {
      unknown: { tint: 'warning', badge: '… CHECKING' },
      ok: { tint: 'success', badge: '● CONNECTED' },
      down: { tint: 'error', badge: '✕ UNREACHABLE' },
    } as const
    const SYNC = { off: 'Off', readonly: 'Read-only', full: 'Full' } as const
    const checkedAt = Math.max(0, ...servers.map(sv => sv.checkedAt))
    const serverCard = (sv: FornixServer) => {
      const id = `fornix-${sv.name}`
      const isOpen = (servers.length === 1) !== pins.includes(id) // a lone server opens by itself; a click flips any
      const search = found[sv.name]
      const memory = (m: FornixMemory) => (
        <Box key={`${id}-mem-${m.id}`} flexDirection="column">
          <Text>{m.text}</Text>
          <Text dimColor wrap="truncate-end">
            {[m.ts.slice(0, 10), m.score === undefined ? '' : `score ${m.score.toFixed(2)}`, ...m.tags.map(t => `#${t}`)].filter(Boolean).join(' ')}
          </Text>
        </Box>
      )
      const placeholder = `Search ${sv.name} memories…`
      const searchField = Client ? (
        <Client key={`${id}-search`} module="./search-box.tsx" props={{ value: search?.query ?? '', placeholder, isTerminal: isCli, channel: sv.name }} width="100%" />
      ) : (
        Input && <Input key={`${id}-search`} placeholder={placeholder} value={search?.query ?? ''} onSubmit={v => searchFornix($, sv.name, v)} />
      )
      const tagRows = Object.entries(
        sv.scopes.reduce<Record<string, number>>((all, sc) => {
          for (const [t, n] of Object.entries(sc.tags)) all[t] = (all[t] ?? 0) + n
          return all
        }, {}),
      ).map(([name, n]) => ({ name: `#${name}`, n }))
      return (
        <Box key={`${id}-card`} flexDirection="column" borderStyle="round" borderColor={sv.state === 'down' ? 'error' : undefined} borderDimColor={sv.state !== 'down'} paddingX={1}>
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            {icon('plug')}
            <Button key={id} plain onPress={() => toggle(id)}>
              <Text bold>{sv.name}</Text>
              <Text dimColor> {isOpen ? '▾' : '▸'}</Text>
            </Button>
            <Text backgroundColor={FX[sv.state].tint} color="inverseText" bold>
              {` ${FX[sv.state].badge} `}
            </Text>
          </Box>
          {sv.sync && (
            <Box key={`${id}-sync`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={2} flexWrap="wrap">
              <Text dimColor>Sync</Text>
              <Box flexDirection="row" gap={1}>
                {(['off', 'readonly', 'full'] as const).map(m => (
                  <Button key={`${id}-sync-${m}`} label={SYNC[m]} variant={sv.sync === m ? 'primary' : 'secondary'} onPress={() => setSync($, sv, m)} />
                ))}
              </Box>
            </Box>
          )}
          {row('Memories', sv.state === 'ok' ? `${sv.scopes.reduce((n, sc) => n + sc.count, 0)} in ${sv.scopes.length} scope${sv.scopes.length === 1 ? '' : 's'}` : '—')}
          {row('This session', `${sv.recalled} recalled · ${sv.written} written`)}
          {sv.state === 'down' && <Text dimColor>{sv.error ? `${sv.error} · ` : ''}reconnect it in /mcp</Text>}
          {isOpen && sv.state === 'ok' && (
            <Box flexDirection="column" gap={1} marginTop={1}>
              <Box flexDirection="column">
                <Text dimColor bold>SCOPES</Text>
                {counts(`${id}-scopes`, sv.scopes.map(sc => ({ name: sc.scope, n: sc.count })))}
              </Box>
              {tagRows.length > 0 && (
                <Box flexDirection="column">
                  <Text dimColor bold>TOP TAGS</Text>
                  {counts(`${id}-tags`, tagRows, 8)}
                </Box>
              )}
              <Box flexDirection="column" gap={1}>
                {searchField}
                {search ? (
                  <Text dimColor bold>
                    MATCHES FOR “{search.query}” · {search.hits.length}
                  </Text>
                ) : (
                  <Text dimColor bold>NEWEST MEMORIES</Text>
                )}
                {search?.error && <Text color="error">Could not search: {search.error}</Text>}
                {(search ? search.hits : sv.recent).length === 0 && !search?.error && (
                  <Text dimColor italic>{search ? 'Nothing stored matches that.' : 'The store is empty.'}</Text>
                )}
                {(search ? search.hits : sv.recent).map(memory)}
              </Box>
            </Box>
          )}
        </Box>
      )
    }
    const fornixView = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          {icon('plug')}
          <Text bold>FORNIX</Text>
          <Box flexGrow={1}>
            <Text dimColor wrap="truncate-end">
              {servers.length} server{servers.length === 1 ? '' : 's'}
              {checkedAt ? ` · checked ${fmtDur(Math.max(0, now - checkedAt))} ago` : ''}
            </Text>
          </Box>
          <Button key="fornix-refresh" plain onPress={() => checkFornix($)}>
            <Text color="suggestion">↻ Refresh</Text>
          </Button>
        </Box>
        {servers.length === 0 && (
          <Box borderStyle="round" borderDimColor paddingX={1}>
            <Text dimColor italic>
              No fornix server in this folder's .mcp.json. Set one up with uvx fornix setup -y (or .fornix/setup.sh --set-root for a folder over
              several repos), restart and approve it.
            </Text>
          </Box>
        )}
        {servers.map(serverCard)}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box
          key="claude"
          flexDirection="row"
          gap={2}
          alignItems="center"
          {...(isCli ? {} : { borderStyle: 'round', borderColor: 'claude', paddingX: 1 })}
        >
          <Box key="mascot" flexDirection="column" flexShrink={0}>
            {!pet ? null : Svg ? (
              <Svg
                source={mascot(isBusy, pet)}
                alt={isBusy ? 'Your mascot dancing while Claude works' : 'Your mascot, idle'}
                width={pet.width}
                height={pet.height}
              />
            ) : isCli ? (
              <Box flexDirection="column">
                {mascotText(step, pet).map(row => (
                  <Text>{row.map(span => (span.color ? <Text color={span.color} backgroundColor={span.bg}>{span.text}</Text> : span.text))}</Text>
                ))}
              </Box>
            ) : (
              <Text color="claude">✻</Text>
            )}
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Text bold color="claude">
              Claude
            </Text>
            {isBusy ? <Text color="claude">♪ working…</Text> : <Text dimColor>idle · waiting for you</Text>}
            <Text dimColor>{model}</Text>
          </Box>
          {/* the mascot controls sit at the card's right edge */}
          <Box flexDirection="column" alignItems="flex-end" alignSelf="flex-start" flexShrink={0}>
            <Button key="mascot-upload" plain onPress={uploadMascot}>
              <Text color="suggestion">🖼 Change mascot</Text>
            </Button>
            {custom && (
              <Button key="mascot-reset" plain onPress={resetMascot}>
                <Text dimColor>{DEFAULT_MASCOT ? '↺ Default' : '✕ Remove'}</Text>
              </Button>
            )}
          </Box>
        </Box>

        <Box key="cwd" flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            {icon('folder', 18)}
            <Text dimColor bold>
              WORKING DIRECTORY
            </Text>
          </Box>
          <Button key="open-cwd" plain onPress={openCwd}>
            <Text bold color="suggestion" wrap="truncate-start">
              {home}
            </Text>
            <Text dimColor> ↗</Text>
          </Button>
        </Box>

        <Box key="account" flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            {icon('user', 18)}
            <Text dimColor bold>
              SIGNED IN AS
            </Text>
            <Box flexGrow={1} />
            <Button key="account-refresh" plain onPress={() => readAccount($)}>
              <Text color="suggestion">↻</Text>
            </Button>
          </Box>
          {acct ? (
            <Box flexDirection="column">
              <Text bold color="suggestion" wrap="truncate-end">
                {accountLines(acct).login}
              </Text>
              <Text>
                <Text dimColor>Plan </Text>
                {accountLines(acct).plan}
              </Text>
            </Box>
          ) : (
            <Text dimColor italic>
              checking…
            </Text>
          )}
        </Box>

        {tabBar}

        {view === 'fornix' ? fornixView : view === 'stats' ? statsView : view === 'activity' ? activityView : summaryView}
      </Box>
    )
  })
}

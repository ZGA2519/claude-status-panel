import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Call, MascotAssets, Prompt, SessionSummary, Stats, Tab } from '../types'
import { agentRun, clip, describe, fmtDur, fmtNum, matches, prettyTool } from './format'
import { emojiOf, iconFor, svgOf } from './icons'
import type { IconKey } from './icons'
import { BUILD_TOM_PY } from './build-tom-script'
import { DEFAULT_MASCOT, mascot, tomText } from './mascot'

const PANE = 'status-panel'
const KEEP = 50
const NO_STATS: Stats = { calls: 0, failed: 0, ms: 0, adds: 0, dels: 0, subagent: 0, byTool: {}, tokensIn: 0, tokensOut: 0, startedAt: 0 }

const calls = atom({ plugin: 'status-panel', key: 'calls' } as const, [])
const filesRead = atom({ plugin: 'status-panel', key: 'read' } as const, [])
const filesWritten = atom({ plugin: 'status-panel', key: 'written' } as const, [])
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
const beat = atom({ plugin: 'status-panel', key: 'beat' } as const, 0) // CLI Tom's frame; only the CLI view reads it

const TINT = { running: 'warning', done: 'success', error: 'error' } as const
const BADGE = { running: '● RUNNING', done: '✓ DONE', error: '✕ FAILED' } as const
const GLYPH = { running: '●', done: '✓', error: '✕' } as const
const isAgentTool = (name: string) => name === 'Agent' || name === 'Task'

/** The Agent call answered: merge what it said into what agent.spawn / turn.complete already recorded. */
function settleAgent(was: AgentRun, now: AgentRun, isError: boolean): AgentRun {
  const merged = { ...was, ...now, childId: was.childId ?? now.childId }
  if (now.launched) return { ...merged, state: was.state === 'running' || !was.state ? 'running' : was.state, result: was.result } // runs on in the background
  return { ...merged, state: was.state === 'done' ? 'done' : isError ? 'error' : 'done', ms: was.ms }
}
const addOnce = (path: string) => (list: string[]) => (list.includes(path) ? list : [...list, path])

// CLI Tom: the render hook says whether the text Tom is on screen and whether to dance; a timer steps the beat.
let isTextTomShown = false
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

// An uploaded mascot (kept in $.store across sessions); Tom when none.
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
      if (!isTextTomShown || !isDancing) return
      void update($, beat, n => n + 2).catch(() => {})
    })
    void $.ui.open({ id: PANE, title: 'Status' })

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
    } else {
      const child = e.agentId
      const state: AgentRun['state'] = e.reason === 'answer' ? 'done' : 'error'
      await update($, calls, list =>
        list.map(c =>
          c.agent?.childId === child
            ? { ...c, agent: { ...c.agent, state, ms: e.durationMs, result: e.answer.trim() ? clip(e.answer.trim()) : c.agent.result } }
            : c,
        ),
      )
    }
    const u = e.usage
    if (u) {
      const tokensIn = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, stats, s => ({ ...s, tokensIn: s.tokensIn + tokensIn, tokensOut: s.tokensOut + u.output_tokens }))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const res = await next(e)
    const childId = res.agentId
    if (childId) {
      await update($, calls, list =>
        list.map(c =>
          c.id === e.tool_use_id && c.agent ? { ...c, agent: { ...c.agent, childId, state: 'running' as const, type: e.subagentType || c.agent.type } } : c,
        ),
      )
    }

    return res
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id: id, agentId, requestMeta: _meta, ...input } = e
    const [cwd, t0, promptId] = await Promise.all([$.session.cwd(), $.clock.now(), read($, currentPrompt)])
    const name = String(tool)
    const call: Call = { id, tool: name, agentId, status: 'running', promptId: promptId || undefined, ...describe(name, input, undefined, cwd) }
    if (isAgentTool(name)) call.agent = agentRun(input, undefined)
    await update($, calls, list => [call, ...list].slice(0, KEEP))

    const res = await next(e)
    const isError = res.deny !== undefined || res.isError === true
    const ms = (await $.clock.now()) - t0
    const done: Call = { ...call, status: isError ? 'error' : 'done', ms, ...describe(name, input, res, cwd) }
    await update($, calls, list =>
      list.map(c =>
        c.id === id ? { ...c, ...done, agent: c.agent && settleAgent(c.agent, agentRun(input, res), isError) } : c,
      ),
    )
    await update($, stats, s => ({
      ...s,
      calls: s.calls + 1,
      failed: s.failed + (isError ? 1 : 0),
      ms: s.ms + ms,
      adds: s.adds + (done.adds ?? 0),
      dels: s.dels + (done.dels ?? 0),
      subagent: s.subagent + (agentId ? 1 : 0),
      byTool: { ...s.byTool, [name]: (s.byTool[name] ?? 0) + 1 },
    }))

    const path = 'file_path' in input ? String(input.file_path) : ''
    if (!isError && path && name === 'Read') await update($, filesRead, addOnce(path))
    if (!isError && path && (name === 'Edit' || name === 'Write')) await update($, filesWritten, addOnce(path))

    return res
  }).catch(($, e, next) => next(e)) // ponytail: an observer never blocks a tool; next(e) replays if already run

  // the search box (search-box.tsx) posts { type: 'search', text } or { type: 'clear' }
  on('ui.message', { requestId: PANE }, async ($, e) => {
    const data = (e.data ?? {}) as { type?: string; text?: unknown }
    const text = data.type === 'search' && typeof data.text === 'string' ? data.text : ''
    if (data.type === 'search' || data.type === 'clear') {
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
    const [cwd, model, turns, now, list, r, w, pins, isWorking, st, q, typed] = await Promise.all([
      $.session.cwd(),
      $.session.model(),
      $.session.turns(),
      $.clock.now(),
      read($, calls),
      read($, filesRead),
      read($, filesWritten),
      read($, pinned),
      read($, working),
      read($, stats),
      read($, query),
      read($, draft),
    ])
    const stored = (await read($, tab)) as string // 'status' from before the four tabs means Activity
    const view: Tab = stored === 'status' ? 'activity' : (stored as Tab)
    const sm = await read($, summary)
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
    isTextTomShown = isCli && pet !== undefined
    isDancing = isBusy
    const step = isCli && isBusy ? await read($, beat) : 0 // read only here, so the desktop never redraws per beat
    const toggle = (id: string) => update($, pinned, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))
    const topTools = Object.entries(st.byTool)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t, n]) => `${prettyTool(t)} ×${n}`)
      .join(' · ')

    const icon = (k: IconKey, size = 16) =>
      Svg ? <Svg source={svgOf(k)} alt={k} width={size} height={size} /> : <Text>{emojiOf(k)}</Text>

    const tile = (k: IconKey, n: number, label: string) => (
      <Box key={`tile-${label}`} flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          {icon(k, 14)}
          <Text bold>{n}</Text>
        </Box>
        <Text dimColor>{label}</Text>
      </Box>
    )

    const row = (label: string, value: string | JSX.Element) => (
      <Box key={`row-${label}`} flexDirection="row" justifyContent="space-between" gap={2}>
        <Text dimColor>{label}</Text>
        {typeof value === 'string' ? <Text wrap="truncate-start">{value}</Text> : value}
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

    const agents = list.filter(c => c.agent)
    const kidsOf = (childId?: string) => (childId ? list.filter(c => c.agentId === childId) : [])
    const isLive = (c: Call) =>
      c.agent?.state ? c.agent.state === 'running' : c.status === 'running' || kidsOf(c.agent?.childId).some(k => k.status === 'running')
    const running = agents.filter(isLive).length
    const setTab = (t: Tab) => update($, tab, () => t)
    const tabButton = (t: Tab, label: string) => (
      <Button key={`tab-${t}`} label={label} variant={view === t ? 'primary' : 'secondary'} onPress={() => setTab(t)} />
    )

    const tabBar = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {tabButton('summary', 'Summary')}
        {tabButton('stats', 'Statistics')}
        {tabButton('activity', 'Activity')}
        <Button
          key="tab-agents"
          label={running ? `Agents · ${running} running` : `Agents (${agents.length})`}
          variant={view === 'agents' ? 'primary' : 'secondary'}
          onPress={() => setTab('agents')}
        />
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
        .run(['python3', '-', pick.stdout.trim(), '--json'], { env, stdin: BUILD_TOM_PY, timeoutMs: 120_000 })
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

    const statsView = (
      <Box flexDirection="column" gap={1}>
        <Box key="stats" flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            {icon('chart', 18)}
            <Text dimColor bold>
              STATISTICS
            </Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            {tile('read', r.length, 'files read')}
            {tile('edit', w.length, 'files written')}
            {tile('activity', st.calls, 'tool calls')}
          </Box>
          {row(
            'Lines changed',
            <Text>
              <Text color="success">+{st.adds}</Text> <Text color="error">−{st.dels}</Text>
            </Text>,
          )}
          {row('Failed calls', st.failed ? <Text color="error">{st.failed}</Text> : '0')}
          {row('Tool time', st.calls ? `${fmtDur(st.ms)} · avg ${fmtDur(st.ms / st.calls)}` : '—')}
          {row('Subagent calls', String(st.subagent))}
          {row('Top tools', topTools || '—')}
          {row('Prompts', String(turns))}
          {row('Tokens', `${fmtNum(st.tokensIn)} in · ${fmtNum(st.tokensOut)} out`)}
          {row('Session age', st.startedAt ? fmtDur(now - st.startedAt) : '—')}
        </Box>
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

    const agentsView = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          {icon('agent')}
          <Text bold>AGENTS</Text>
          <Text dimColor>{agents.length} launched ·</Text>
          {running ? <Text color="warning">● {running} running</Text> : <Text dimColor>none running</Text>}
        </Box>
        {agents.length === 0 && (
          <Box borderStyle="round" borderDimColor paddingX={1}>
            <Text dimColor italic>
              No subagents yet. When Claude hands work to an agent, it shows up here with its prompt, live tool calls and result.
            </Text>
          </Box>
        )}
        {agents.map((c, i) => {
          const a = c.agent!
          const kids = kidsOf(a.childId)
          const status = isLive(c) ? 'running' : (a.state ?? c.status)
          const took = a.ms ?? (a.launched ? undefined : c.ms)
          const showPrompt = pins.includes(`${c.id}:prompt`) // closed unless toggled
          const showResult = (i === 0) !== pins.includes(`${c.id}:result`) // the newest opens by itself
          const facts = [a.model, `${a.toolCount ?? kids.length} tool calls`, a.tokens ? `${fmtNum(a.tokens)} tokens` : ''].filter(Boolean)
          return (
            <Box
              key={`agent-${c.id}`}
              flexDirection="column"
              borderStyle="round"
              borderColor={status === 'done' ? undefined : TINT[status]}
              borderDimColor={status === 'done'}
              hover={{ borderColor: 'suggestion' }}
              paddingX={1}
            >
              <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                {icon('agent')}
                <Text bold color="claude">
                  {a.type}
                </Text>
                <Text backgroundColor={TINT[status]} color="inverseText" bold>
                  {` ${BADGE[status]} `}
                </Text>
                {a.background && <Text dimColor>⧗ background</Text>}
                {status !== 'running' && took !== undefined && <Text dimColor>⏱ {fmtDur(took)}</Text>}
              </Box>
              <Text bold>{c.summary || 'Untitled task'}</Text>
              <Text dimColor wrap="truncate-end">
                {facts.join(' · ')}
              </Text>

              {kids.length > 0 && (
                <Box flexDirection="column" marginTop={1}>
                  <Text dimColor bold>
                    LATEST STEPS
                  </Text>
                  {kids.slice(0, 5).map(k => (
                    <Text wrap="truncate-end">
                      <Text color={TINT[k.status]}>{GLYPH[k.status]}</Text> <Text bold>{prettyTool(k.tool)}</Text>{' '}
                      <Text dimColor>
                        {k.summary}
                        {k.ms !== undefined ? ` · ${fmtDur(k.ms)}` : ''}
                      </Text>
                    </Text>
                  ))}
                  {kids.length > 5 && <Text dimColor>… {kids.length - 5} earlier steps</Text>}
                </Box>
              )}

              <Box flexDirection="row" gap={2} marginTop={1}>
                <Button key={`agent-prompt-${c.id}`} plain onPress={() => toggle(`${c.id}:prompt`)}>
                  <Text color="suggestion">{showPrompt ? '▾' : '▸'} Prompt</Text>
                </Button>
                <Button key={`agent-result-${c.id}`} plain onPress={() => toggle(`${c.id}:result`)}>
                  <Text color="suggestion">{showResult ? '▾' : '▸'} Result</Text>
                </Button>
              </Box>
              {showPrompt && (
                <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                  <Markdown text={a.prompt || '_(empty prompt)_'} />
                </Box>
              )}
              {showResult && (
                <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                  {a.result ? (
                    <Markdown text={a.result} />
                  ) : (
                    <Text dimColor italic>
                      {status === 'running' ? 'Still working…' : 'No result text.'}
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          )
        })}
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
                {tomText(step, pet).map(row => (
                  <Text>{row.map(span => (span.color ? <Text color={span.color} backgroundColor={span.bg}>{span.text}</Text> : span.text))}</Text>
                ))}
              </Box>
            ) : (
              <Text>🦎</Text>
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

        {tabBar}

        {view === 'agents' ? agentsView : view === 'stats' ? statsView : view === 'activity' ? activityView : summaryView}
      </Box>
    )
  })
}

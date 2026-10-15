import { expect, mock, test } from 'claude-code/testing'

import { describe, human, matches, patchToDiff } from './format'
import { DEFAULT_MASCOT, mascot, mascotText } from './mascot'
import type { MascotAssets } from '../types'

const PANE = {
  component: 'Pane',
  requestId: 'status-panel',
  props: { title: 'Agent', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('human() renders JSON as readable key: value lines', async () => {
  expect(human({ a: 1, b: { c: 'x' }, d: ['p', { q: 1, r: 2 }], e: 'l1\nl2' })).toBe('a: 1\nb:\n  c: x\nd:\n  - p\n  - q: 1\n    r: 2\ne: |\n    l1\n    l2')
})

// a 2×1-cell mascot: ▀ top orange over bottom default, then a blank cell
const cells = (list: number[][]) => btoa(String.fromCharCode(...new Uint8Array(new Uint32Array(list.flat()).buffer)))
const PET: MascotAssets = {
  gif: 'R0lGODlh',
  still: 'iVBORw0K',
  width: 40,
  height: 30,
  raster: { columns: 2, rows: 1, frameMs: 125, frames: [cells([[0x2580, 0xd97757, 0x01000000], [0x2580, 0x01000000, 0x01000000]])] },
}

test('the mascot: the GIF while dancing, its still while idle, block art for the CLI', async () => {
  expect(mascot(true, PET)).toContain('data:image/gif;base64,R0lGODlh')
  expect(mascot(false, PET)).toContain('data:image/png;base64,iVBORw0K')
  expect(mascot(true, PET).length).toBeLessThan(131072) // Svg source limit
  expect(mascotText(0, PET)).toEqual([[{ text: '▀', color: '#d97757' }, { text: ' ' }]])
  if (DEFAULT_MASCOT) for (const f of DEFAULT_MASCOT.raster.frames) expect(atob(f).length).toBe(DEFAULT_MASCOT.raster.columns * DEFAULT_MASCOT.raster.rows * 12)
})

test('search matches every word anywhere in a task', async () => {
  const call = { id: '1', tool: 'mcp__srv__list', status: 'done', summary: 'src/app.ts', sections: [{ label: 'output', source: 'rows: 3' }] } as const
  expect(matches({ ...call, sections: [...call.sections] }, 'srv APP')).toBe(true)
  expect(matches({ ...call, sections: [...call.sections] }, 'rows 3')).toBe(true)
  expect(matches({ ...call, sections: [...call.sections] }, 'app missing')).toBe(false)
})

test('the Agents tab shows each subagent with its type, task, prompt and result', async ($, on) => {
  mock.clock(on)
  on('session.cwd', () => ({ value: '/p' }))
  on('session.model', () => ({ value: 'claude-test' }))
  on('session.turns', () => ({ value: 1 }))
  on('tool.call', () => ({
    result: { agentId: 'sub-1', agentType: 'Explore', content: [{ type: 'text', text: '## Found it\n- `auth.ts`' }], totalToolUseCount: 2, totalTokens: 1234 },
    text: 'ok',
  }))
  const tools = $.tool as unknown as { call: (input: object) => Promise<unknown> }
  await tools.call({ tool: 'Agent', description: 'Find the auth middleware', prompt: 'Look for auth', subagent_type: 'Explore' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'status-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: 'SUMMARY' })).toBeDefined() // Summary is the default tab
    await ui.press({ key: 'tab-agents' })
    expect(await ui.find({ type: 'Text', text: 'SUMMARY' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Explore' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Find the auth middleware' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 tool calls · 1.2k tokens/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Markdown' })).some(m => String(m.props.text).includes('Found it'))).toBe(true) // newest result open
    const promptButton = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('agent-prompt-'))
    await ui.press({ key: promptButton?.key ?? '' })
    expect((await ui.findAll({ type: 'Markdown' })).some(m => m.props.text === 'Look for auth')).toBe(true)
    await ui.press({ key: promptButton?.key ?? '' }) // closed again: open/closed is session state shared by surfaces
    await ui.press({ key: 'tab-summary' })
    await ui.unmount()
  }
})

test('a background agent stays RUNNING after its launch until its own turn completes', async ($, on) => {
  mock.clock(on)
  on('session.cwd', () => ({ value: '/p' }))
  on('session.model', () => ({ value: 'claude-test' }))
  on('session.turns', () => ({ value: 1 }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: { status: 'async_launched', agentId: 'sub-9' }, text: 'Async agent launched' }))
  const tools = $.tool as unknown as { call: (input: object) => Promise<unknown> }
  await tools.call({ tool: 'Agent', description: 'Audit the repo', prompt: 'Audit it', subagent_type: 'Explore' })

  const ui = await $.ui.mount({ plugin: 'status-panel', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-agents' })
  expect(await ui.find({ type: 'Text', text: /RUNNING/ })).toBeDefined() // the Agent call answered, the agent did not
  expect(await ui.find({ type: 'Text', text: /background/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Markdown' })).some(m => String(m.props.text).includes('launched'))).toBe(false)

  const turn = $.turn as unknown as { complete: (input: object) => Promise<unknown> }
  await turn.complete({ answer: '# Audit report', durationMs: 4200, isAborted: false, turnId: 't1', agentId: 'sub-9', reason: 'answer' })
  expect(await ui.find({ type: 'Text', text: /DONE/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /4\.2s/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Markdown' })).some(m => String(m.props.text).includes('Audit report'))).toBe(true)
  await ui.unmount()
})

test('Activity shows the last prompt\'s tasks and loads one earlier prompt per press', async ($, on) => {
  mock.clock(on)
  on('session.cwd', () => ({ value: '/p' }))
  on('session.model', () => ({ value: 'claude-test' }))
  on('session.turns', () => ({ value: 2 }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  const tools = $.tool as unknown as { call: (input: object) => Promise<unknown> }
  const turn = $.turn as unknown as { start: (input: object) => Promise<unknown> }

  await turn.start({ text: 'fix the login bug', turnId: 't1' })
  for (let n = 1; n <= 2; n++) await tools.call({ tool: 'mcp__srv__ping', n: `first ${n}` })
  await turn.start({ text: 'now add tests', turnId: 't2' })
  for (let n = 1; n <= 3; n++) await tools.call({ tool: 'mcp__srv__ping', n: `second ${n}` })
  await turn.start({ text: '', turnId: 't3' }) // a continuation joins the prompt before
  await tools.call({ tool: 'mcp__srv__ping', n: 'second 4' })

  const ui = await $.ui.mount({ plugin: 'status-panel', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-activity' })
  const rows = async () => (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('toggle-')).length
  expect(await rows()).toBe(4)
  expect(await ui.find({ type: 'Text', text: '💬 Prompt 2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '“now add tests”' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '💬 Prompt 1' })).toBeUndefined()
  await ui.press({ key: 'load-more' })
  expect(await rows()).toBe(6)
  expect(await ui.find({ type: 'Text', text: '💬 Prompt 1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'load-more' })).toBeUndefined()
  await ui.unmount()
})

test('the Summary tab shows a short session summary written by a small model', async ($, on) => {
  mock.clock(on)
  on('session.cwd', () => ({ value: '/p' }))
  on('session.model', () => ({ value: 'claude-test' }))
  on('session.turns', () => ({ value: 1 }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  let asked = ''
  on('model.complete', ($, e) => {
    asked = e.prompt
    return { value: { isAnswered: true, text: '**Built a status panel**\n- added tabs', usage: {} } } as never
  })
  const turn = $.turn as unknown as { start: (input: object) => Promise<unknown> }
  await turn.start({ text: 'add tabs', turnId: 't1' })

  const ui = await $.ui.mount({ plugin: 'status-panel', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /appears here after each prompt/ })).toBeDefined()
  await ui.press({ key: 'summary-refresh' })
  expect((await ui.findAll({ type: 'Markdown' })).some(m => String(m.props.text).includes('Built a status panel'))).toBe(true)
  expect(asked).toContain('Latest prompt (#1): add tabs')
  expect(await ui.find({ type: 'Text', text: /after prompt 1/ })).toBeDefined()
  await ui.unmount()
})

test('a prompt heading scrolls the chat to where that prompt was sent', async ($, on) => {
  mock.clock(on)
  on('session.cwd', () => ({ value: '/p' }))
  on('session.model', () => ({ value: 'claude-test' }))
  on('session.turns', () => ({ value: 1 }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined } as never
  })
  const raise = $ as unknown as {
    session: { append: (input: object) => Promise<unknown> }
    turn: { start: (input: object) => Promise<unknown> }
    tool: { call: (input: object) => Promise<unknown> }
  }
  await raise.session.append({ door: 'prompt', uuid: 'row-42', origin: { kind: 'person' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'fix it' }] } })
  await raise.turn.start({ text: 'fix it', turnId: 't1' })
  await raise.tool.call({ tool: 'mcp__srv__ping', n: 'one' })

  const ui = await $.ui.mount({ plugin: 'status-panel', surface: 'desktop', ...PANE })
  await ui.press({ key: 'tab-activity' })
  await ui.press({ key: 'prompt-t1' })
  // the kit draws no chat, so the scroll itself cannot land here; what matters is the prompt knew its row
  expect(toasts.some(t => t.includes('before the panel could link it'))).toBe(false)
  expect(toasts.some(t => t.includes('scroll to prompt 1'))).toBe(true)
  await ui.unmount()
})

test('patchToDiff cuts on whole lines and keeps hunk headers valid', async () => {
  const diff = patchToDiff([{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: ['-a', '+b', '+c', ' d'] }], 3)
  expect(diff).toBe('@@ -3,1 +3,2 @@\n-a\n+b\n+c')
})

test('Edit shows a proposed diff while running and counts adds/dels', async () => {
  const shown = describe('Edit', { file_path: '/p/x.ts', old_string: 'a', new_string: 'b\nc' }, undefined, '/p')
  expect(shown.summary).toBe('x.ts')
  expect([shown.stat, shown.adds, shown.dels]).toEqual(['proposed', 2, 1])
  expect(shown.sections[0]?.format).toBe('diff')
})

test('the pane lists calls newest first with diffs and readable output', async ($, on) => {
  mock.clock(on)
  on('session.cwd', () => ({ value: '/p' }))
  on('session.model', () => ({ value: 'claude-test' }))
  on('session.turns', () => ({ value: 2 }))
  on('tool.call', ($, e) =>
    e.tool === 'Edit'
      ? { result: { filePath: '/p/x.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] }, text: 'ok' }
      : { result: {}, text: '{"rows":[{"id":1}]}' },
  )
  // the connected MCP tools make $.tool.call's input union too deep for tsc here
  const tools = $.tool as unknown as { call: (input: object) => Promise<unknown> }
  await tools.call({ tool: 'Edit', file_path: '/p/x.ts', old_string: 'old', new_string: 'new' })
  await tools.call({ tool: 'mcp__srv__list', q: 'all' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'status-panel', surface, ...PANE })
    await ui.press({ key: 'tab-activity' })
    const rows = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('toggle-'))
    expect(rows[0]?.text).toContain('srv · list')
    expect(rows[1]?.text).toContain('Edit')
    expect(await ui.find({ type: 'Text', text: '+1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '−1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /DONE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'CHANGES' })).toBeUndefined() // statistics have their own tab
    await ui.press({ key: 'tab-stats' })
    expect(await ui.find({ type: 'Button', key: 'stats-written' })).toBeDefined()
    for (const title of ['CHANGES', 'TOOLS', 'SESSION']) expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+1' })).toBeDefined() // lines added
    expect(await ui.find({ type: 'Text', text: 'Most used' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'srv · list' })).toBeDefined() // a most-used tool, one row each
    expect(await ui.find({ type: 'Text', text: 'claude-test' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /idle · waiting/ })).toBeDefined()
    await ui.press({ key: 'tab-activity' })
    const hasMcpRow = async () => (await ui.findAll({ type: 'Button' })).some(b => b.text.includes('srv · list'))
    // the full-width search box is a Client: type into it key by key
    const type = async (text: string) => {
      for (const ch of text) await ui.key({ key: ch, in: 'search' })
    }
    await type('x.ts')
    expect(await hasMcpRow()).toBe(true) // typing alone does not filter
    expect(await ui.find({ type: 'Text', text: /x\.ts/, in: 'search' })).toBeDefined() // what was typed shows in the box
    await ui.press({ key: 'sb-go' })
    expect(await ui.find({ type: 'Text', text: /1 of 2 tasks match/ })).toBeDefined()
    expect(await hasMcpRow()).toBe(false)
    await ui.press({ key: 'sb-clear' })
    expect(await hasMcpRow()).toBe(true)
    await type('srv')
    await ui.key({ key: 'return', in: 'search' }) // Enter searches too
    expect(await ui.find({ type: 'Text', text: /1 of 2 tasks match/ })).toBeDefined()
    await ui.press({ key: 'sb-clear' })
    if (surface === 'terminal') expect(!!(await ui.find({ type: 'Text', text: /▀/ }))).toBe(!!DEFAULT_MASCOT) // the default mascot as text, or none
    expect(await ui.find({ type: 'Button', key: 'open-cwd' })).toBeDefined() // the working directory is clickable
    const top = rows[0]?.key ?? ''
    const sections = async () => (await ui.findAll({ type: 'Code' })).length
    const before = await sections()
    await ui.press({ key: top }) // the newest task closes on a click…
    expect(await sections()).toBeLessThan(before)
    await ui.press({ key: top }) // …and opens again
    expect(await sections()).toBe(before)
    expect(await ui.find({ type: 'Button', key: 'mascot-upload' })).toBeDefined() // always visible under "Claude"
    if (surface === 'desktop') expect((await ui.findAll({ type: 'Svg' })).some(svg => svg.props.alt === 'Your mascot, idle')).toBe(!!DEFAULT_MASCOT)
    expect(await ui.find({ type: 'Code', text: /rows:\n {2}- id: 1/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the statistics tiles open what was read, written and called, and how often', async ($, on) => {
  mock.clock(on)
  on('session.cwd', () => ({ value: '/p' }))
  on('session.model', () => ({ value: 'claude-test' }))
  on('session.turns', () => ({ value: 1 }))
  on('tool.call', ($, e) =>
    e.tool === 'Edit'
      ? { result: { filePath: '/p/x.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old', '+new', '+more'] }] }, text: 'ok' }
      : { result: {}, text: 'ok' },
  )
  const tools = $.tool as unknown as { call: (input: object) => Promise<unknown> }
  await tools.call({ tool: 'Read', file_path: '/p/src/a.ts' })
  await tools.call({ tool: 'Read', file_path: '/p/src/a.ts' })
  await tools.call({ tool: 'Read', file_path: '/p/b.md' })
  await tools.call({ tool: 'Edit', file_path: '/p/x.ts', old_string: 'old', new_string: 'new\nmore' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'status-panel', surface, ...PANE })
    await ui.press({ key: 'tab-stats' })
    expect(await ui.find({ type: 'Text', text: 'src/a.ts' })).toBeUndefined() // closed until pressed
    await ui.press({ key: 'stats-read' })
    const reads = await ui.findAll({ type: 'Text', text: /^(src\/a\.ts|b\.md)$/ })
    expect(reads.map(t => t.text)).toEqual(['src/a.ts', 'b.md']) // relative to the working directory, most read first
    expect(await ui.find({ type: 'Text', text: '×2' })).toBeDefined()
    await ui.press({ key: 'stats-written' })
    expect(await ui.find({ type: 'Text', text: 'x.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
    await ui.press({ key: 'stats-tools' })
    expect((await ui.findAll({ type: 'Text', text: 'Read' })).length).toBe(2) // its own list, beside Most used
    for (const k of ['stats-read', 'stats-written', 'stats-tools']) await ui.press({ key: k }) // closed again: shared by surfaces
    expect(await ui.find({ type: 'Text', text: 'src/a.ts' })).toBeUndefined()
    await ui.unmount()
  }
})

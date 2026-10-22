import { expect, test } from 'claude-code/testing'

import { lineCells, mix, segmentsSvg } from './register'

const BAND = {
  plugin: 'progress-band',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('band shows plan progress and follows advance / wrap_up', async ($, on) => {
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Read code', status: 'in_progress' },
      { content: 'Write fix', status: 'pending' },
      { content: 'Run tests', status: 'pending' },
      { content: 'Ship', status: 'pending' },
    ],
  })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const dt = (re: RegExp) => desk.find({ type: 'Text', text: re }).then(n => n?.text)
  expect(await dt(/^Step/)).toBe('Step 2 of 4')
  expect(await dt(/Write fix/)).toBe('Write fix')
  expect(await dt(/%$/)).toBe('25%')
  await desk.unmount()

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const tt = (re: RegExp) => term.find({ type: 'Text', text: re }).then(n => n?.text)
  expect(await tt(/%$/)).toBe(' 25%')
  expect(await tt(/^\d+\/\d+$/)).toBe('1/4')
  expect(await tt(/Write fix/)).toBe('Write fix')
  await term.unmount()

  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' })
  const done = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const nt = (re: RegExp) => done.find({ type: 'Text', text: re }).then(n => n?.text)
  expect(await nt(/Complete/)).toBe('✓ Complete')
  expect(await nt(/%$/)).toBe('100%')
  await done.unmount()
})

test('band tracks TodoWrite and stays out when empty', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const empty = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await empty.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await empty.unmount()

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'A', status: 'completed', activeForm: 'Doing A' },
      { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
    ],
  })
  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const tt = (re: RegExp) => term.find({ type: 'Text', text: re }).then(n => n?.text)
  expect(await tt(/%$/)).toBe(' 50%')
  expect(await tt(/^\d+\/\d+$/)).toBe('1/2')
  await term.unmount()
})

test('band hides once the turn ends and a finished list is dropped', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [{ content: 'Only step', status: 'in_progress' }],
  })

  const idle = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isWorking: false } })
  expect((await idle.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await idle.unmount()

  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' })
  await $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' })

  const next = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await next.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await next.unmount()
})

test('each subagent gets a sub line until the main turn ends', async ($, on) => {
  let n = 0
  on('agent.spawn', () => ({ model: 'm', agentId: `a${++n}` }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const spawn = (description: string, subagentType: string) =>
    $.agent.spawn({
      tool_use_id: description,
      prompt: 'p',
      description,
      subagentType,
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'm',
      background: false,
      fork: false,
    })
  await spawn('Find auth code', 'Explore')
  await spawn('Review diff', 'general-purpose')
  await $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't', reason: 'answer', agentId: 'a1' })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const t = (re: RegExp) => ui.find({ type: 'Text', text: re }).then(n => n?.text)
    expect(await t(/Find auth code/)).toBe('Find auth code')
    expect(await t(/Review diff/)).toBe('Review diff')
    expect(await t(/^0 tools$/)).toBe('0 tools')
    await ui.unmount()
  }
  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await desk.find({ type: 'Text', text: /Explore/ }))?.text).toBe('✓ Explore')
  await desk.unmount()

  // Main turn ends: the finished Explore row goes, the running one stays.
  await $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 'm', reason: 'answer' })
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: /Find auth code/ })).toBeUndefined()
  expect((await after.find({ type: 'Text', text: /Review diff/ }))?.text).toBe('Review diff')
  await after.unmount()
})

test('band stays up while idle until background subagents finish', async ($, on) => {
  on('agent.spawn', () => ({ model: 'm', agentId: 'bg1' }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const IDLE = { ...BAND, props: { ...BAND.props, isWorking: false } }

  await $.agent.spawn({
    tool_use_id: 'bg',
    prompt: 'p',
    description: 'Background scan',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'm',
    background: true,
    fork: false,
  })
  await $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 'm', reason: 'answer' })

  const running = await $.ui.mount({ ...IDLE, surface: 'desktop' })
  expect((await running.find({ type: 'Text', text: /Background scan/ }))?.text).toBe('Background scan')
  await running.unmount()

  await $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 'b', reason: 'answer', agentId: 'bg1' })
  const finished = await $.ui.mount({ ...IDLE, surface: 'desktop' })
  expect((await finished.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await finished.unmount()
})

test('drawing helpers', () => {
  expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')

  const coral = ['#D97757', '#F2B880'] as const
  expect(lineCells(0.5, 10, coral).cells.length).toBe(5)
  expect(lineCells(0.5, 10, coral).rest.length).toBe(5)
  expect(lineCells(0.55, 10, coral).cells.map(c => c.char).join('')).toBe('━━━━━╸')
  expect(lineCells(1, 10, coral).rest).toBe('')

  const items = [
    { id: '0', label: 'a', status: 'completed' as const },
    { id: '1', label: 'b', status: 'in_progress' as const },
    { id: '2', label: 'c', status: 'pending' as const },
  ]
  const svg = segmentsSvg(items, true)
  expect((svg.match(/<rect /g) ?? []).length).toBe(5) // 3 tracks + 1 fill + 1 pulse
  expect(svg.includes('<animate')).toBe(true)
  expect(segmentsSvg(items, false).includes('<animate')).toBe(false)
})

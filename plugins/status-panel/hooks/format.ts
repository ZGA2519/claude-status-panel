import type { AgentRun, Call, Section } from '../types'

// ponytail: per-section caps keep $.state small; raise if a panel needs more
const MAX_LINES = 150
const MAX_CHARS = 8000

export type Res = { result?: unknown; text?: string; isError?: boolean; deny?: string }
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
type Shown = Pick<Call, 'summary' | 'stat' | 'adds' | 'dels' | 'sections'>

export function clip(text: string): string {
  const lines = text.split('\n')
  let out = lines.slice(0, MAX_LINES).join('\n')
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS)
  const cut = text.length - out.length
  return cut > 0 ? `${out}\n… ${lines.length > MAX_LINES ? `${lines.length - MAX_LINES} more lines` : `${cut} more chars`}` : out
}

/** YAML-ish view of any value: objects as `key: value`, multi-line strings as blocks. */
export function human(v: unknown, pad = ''): string {
  if (typeof v === 'string') return v.includes('\n') ? `|\n${v.replace(/^/gm, `${pad}  `)}` : v
  if (v === null || typeof v !== 'object') return String(v)
  const rows = Array.isArray(v) ? v.map(x => ['-', x] as const) : Object.entries(v).map(([k, x]) => [`${k}:`, x] as const)
  if (rows.length === 0) return Array.isArray(v) ? '[]' : '{}'
  return rows
    .map(([k, x]) => {
      if (x === null || typeof x !== 'object' || Object.keys(x).length === 0) return `${pad}${k} ${human(x, `${pad}  `)}`
      const inner = human(x, `${pad}  `)
      return k === '-' ? `${pad}- ${inner.trimStart()}` : `${pad}${k}\n${inner}`
    })
    .join('\n')
}

/** Unified-diff hunks, cut on whole lines so the result always parses as a diff. */
export function patchToDiff(hunks: readonly Hunk[], maxLines = MAX_LINES): string {
  const out: string[] = []
  let left = maxLines
  for (const h of hunks) {
    if (left <= 0) break
    const lines = h.lines.slice(0, left)
    left -= lines.length
    const body = lines.filter(l => !l.startsWith('\\'))
    const oldN = body.filter(l => !l.startsWith('+')).length
    const newN = body.filter(l => !l.startsWith('-')).length
    out.push(`@@ -${h.oldStart},${oldN} +${h.newStart},${newN} @@`, ...lines)
  }
  return out.join('\n')
}

function output(text: string | undefined): Section {
  const raw = (text ?? '').trim()
  if (raw === '') return { label: 'output', source: '(no output)' }
  if (/^[[{]/.test(raw)) {
    try {
      return { label: 'output', source: clip(human(JSON.parse(raw))), language: 'yaml' }
    } catch {}
  }
  return { label: 'output', source: clip(raw) }
}

const rel = (path: string, cwd: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

function summaryOf(input: Record<string, unknown>, cwd: string): string {
  const first = Object.values(input).find(v => typeof v === 'string' && v !== '') as string | undefined
  return rel(lines(first)[0]?.slice(0, 120) ?? '', cwd)
}

const lines = (s: unknown) => (typeof s === 'string' && s !== '' ? s.replace(/\n$/, '').split('\n') : [])

/** What the model asked for, before the tool ran: the diff it proposes. */
function proposed(tool: string, input: Record<string, unknown>): Hunk[] {
  const oldL = tool === 'Edit' ? lines(input.old_string) : []
  const newL = lines(tool === 'Edit' ? input.new_string : input.content)
  const added = newL.map(l => `+${l}`)
  return [{ oldStart: oldL.length ? 1 : 0, oldLines: oldL.length, newStart: 1, newLines: newL.length, lines: [...oldL.map(l => `-${l}`), ...added] }]
}

export function describe(tool: string, input: Record<string, unknown>, res: Res | undefined, cwd: string): Shown {
  const r = (res?.result ?? {}) as Record<string, any> // ponytail: duck-typed per BuiltinToolResults
  const path = rel(String(input.file_path ?? ''), cwd)

  if (res && (res.deny !== undefined || res.isError)) {
    return { summary: path || summaryOf(input, cwd), stat: res.deny !== undefined ? 'denied' : 'error', sections: [{ label: 'error', source: clip(res.deny ?? res.text ?? '') }] }
  }

  switch (tool) {
    case 'Read': {
      if (!res) {
        const from = Number(input.offset ?? 1)
        return { summary: path, stat: input.limit ? `lines ${from}–${from + Number(input.limit) - 1}` : 'whole file', sections: [] }
      }
      if (r.type !== 'text') return { summary: path, stat: String(r.type ?? ''), sections: [output(res.text)] }
      const f = r.file
      return {
        summary: path,
        stat: `lines ${f.startLine}–${f.startLine + f.numLines - 1} of ${f.totalLines}`,
        sections: [{ label: 'read', source: clip(f.content), path: f.filePath, startLine: f.startLine }],
      }
    }
    case 'Edit':
    case 'Write': {
      const hunks: Hunk[] = r.structuredPatch?.length ? r.structuredPatch : !res || r.type === 'create' ? proposed(tool, input) : []
      const all = hunks.flatMap(h => h.lines)
      const adds = all.filter(l => l.startsWith('+')).length
      const dels = all.filter(l => l.startsWith('-')).length
      return {
        summary: path,
        stat: res ? undefined : 'proposed',
        adds,
        dels,
        sections: hunks.length ? [{ label: res ? 'changes' : 'proposed', source: patchToDiff(hunks), format: 'diff', path }] : [{ label: 'changes', source: 'no diff available' }],
      }
    }
    case 'Bash':
      return {
        summary: String(input.description ?? lines(input.command)[0] ?? ''),
        sections: [{ label: 'command', source: String(input.command ?? ''), language: 'bash' }, ...(res ? [output(res.text)] : [])],
      }
    default:
      return {
        summary: summaryOf(input, cwd),
        sections: [{ label: 'input', source: clip(human(input)), language: 'yaml' }, ...(res ? [output(res.text)] : [])],
      }
  }
}

/** The Agent tool's call as the Agents tab shows it; the result fields arrive once it answers. */
export function agentRun(input: Record<string, unknown>, res: Res | undefined): AgentRun {
  const r = (res?.result ?? {}) as Record<string, any> // ponytail: duck-typed per BuiltinToolResults.Agent
  const text = Array.isArray(r.content) ? r.content.map((b: { text?: string }) => b.text ?? '').join('\n') : res?.deny ?? res?.text
  return {
    type: String(input.subagent_type ?? r.agentType ?? 'general-purpose'),
    prompt: clip(String(input.prompt ?? '')),
    background: input.run_in_background === true || r.status === 'async_launched' || r.status === 'remote_launched' || undefined,
    ...(res && {
      launched: r.status === 'async_launched' || r.status === 'remote_launched' || undefined,
      result: r.status === 'async_launched' || r.status === 'remote_launched' ? undefined : clip(String(text ?? '').trim()),
      childId: typeof r.agentId === 'string' ? r.agentId : undefined,
      toolCount: typeof r.totalToolUseCount === 'number' ? r.totalToolUseCount : undefined,
      tokens: typeof r.totalTokens === 'number' ? r.totalTokens : undefined,
      model: typeof r.resolvedModel === 'string' ? r.resolvedModel : undefined,
    }),
  }
}

/** Every word of `query` appears somewhere in the call: tool, file/command, stats, status or its bodies. */
export function matches(call: Call, query: string): boolean {
  const hay = [call.tool, prettyTool(call.tool), call.summary, call.stat ?? '', call.status, ...call.sections.map(s => s.source)]
    .join('\n')
    .toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => hay.includes(word))
}

/** `mcp__server__tool` → `server · tool`; built-ins unchanged. */
export const prettyTool = (tool: string) => (tool.startsWith('mcp__') ? tool.slice(5).replace('__', ' · ') : tool)

export function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  return m < 60 ? `${m}m ${Math.floor((ms % 60_000) / 1000)}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export const fmtNum = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))

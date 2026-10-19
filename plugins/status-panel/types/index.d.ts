export type CallStatus = 'running' | 'done' | 'error'

/** One block of a call's body, drawn as a Code element. */
export type Section = {
  label: string
  source: string
  format?: 'diff'
  language?: string
  path?: string
  startLine?: number
}

/** A mascot made by scripts/build-mascot.py --json from a GIF the person uploaded. */
export type MascotAssets = {
  gif: string
  still: string
  width: number
  height: number
  raster: { columns: number; rows: number; frameMs: number; frames: string[] }
}

/** The Summary tab: a short running summary, rewritten after each prompt. */
export type SessionSummary = { text: string; prompt: number; updatedAt: number; isUpdating: boolean; error?: string }

/** One prompt the person sent; tasks carry its id. */
export type Prompt = {
  id: string
  n: number
  text: string
  /** The prompt's transcript row (session.append uuid): what the chat scrolls to. */
  rowId?: string
}

export type Call = {
  id: string
  tool: string
  status: CallStatus
  agentId?: string
  summary: string
  stat?: string
  adds?: number
  dels?: number
  ms?: number
  /** The prompt this task ran under (absent: before the panel saw a prompt). */
  promptId?: string
  sections: Section[]
}

/** Session-wide counters; the call list keeps only the newest 50. */
export type Stats = {
  calls: number
  failed: number
  ms: number
  adds: number
  dels: number
  subagent: number
  byTool: Record<string, number>
  tokensIn: number
  tokensOut: number
  startedAt: number
  /** Per file, relative to the working directory: times read. Absent in a session started before 0.18. */
  byRead?: Record<string, number>
  /** Per file: times edited or written, and the lines those changed. */
  byWrite?: Record<string, { n: number; adds: number; dels: number }>
}

/** One memory as fornix's `select` returns it. */
export type FornixMemory = { id: string; ts: string; text: string; tags: string[] }

/** One fornix MCP server: `fornix` for a repo of its own, `fornix-<repo>` per repo in a folder over several. */
export type FornixServer = {
  name: string
  /** Its store folder (`--directory` in .mcp.json), the `.sync-on` flag inside; absent when only its tool calls named it. */
  dir?: string
  /** 'ok': it answered; 'down': the call failed (not connected, not approved or not running). */
  state: 'unknown' | 'ok' | 'down'
  error?: string
  /** The `.sync-on` flag: absent off, "readonly" recall only, anything else full; unknown without `dir`. */
  sync?: 'off' | 'full' | 'readonly'
  scopes: { scope: string; count: number; tags: Record<string, number> }[]
  recent: FornixMemory[]
  checkedAt: number
  /** This session: memories its `select` returned, and its `write` calls. */
  recalled: number
  written: number
}

export type Tab = 'summary' | 'stats' | 'activity' | 'fornix'

declare module 'claude-code' {
  interface PluginState {
    'status-panel': {
      calls: Call[]
      pinned: string[]
      isWorking: boolean
      query: string
      draft: string
      beat: number
      tab: Tab
      summary: SessionSummary
      limit: number
      prompts: Prompt[]
      currentPrompt: string
      mascotRev: number
      stats: Stats
      fornixServers: FornixServer[]
    }
  }
}

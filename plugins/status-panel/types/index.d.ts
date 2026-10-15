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

/** What an Agent (subagent) call carries for the Agents tab. */
export type AgentRun = {
  type: string
  prompt: string
  /** The subagent's own id, from agent.spawn: its tool calls carry it as `agentId`. */
  childId?: string
  background?: boolean
  /** The subagent's own life, apart from the Agent call (a background launch answers at once). */
  state?: 'running' | 'done' | 'error'
  /** How long the subagent ran, from its turn.complete. */
  ms?: number
  /** The Agent call answered only "launched"; the result comes with the subagent's turn.complete. */
  launched?: boolean
  result?: string
  toolCount?: number
  tokens?: number
  model?: string
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
  agent?: AgentRun
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
}

export type Tab = 'summary' | 'stats' | 'activity' | 'agents'

declare module 'claude-code' {
  interface PluginState {
    'status-panel': {
      calls: Call[]
      read: string[]
      written: string[]
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
    }
  }
}

export type Status = 'pending' | 'in_progress' | 'completed'
export type Item = { id: string; label: string; status: Status }
export type Agent = {
  id: string
  type: string
  label: string
  isDone: boolean
  tools: number
  lastTool?: string
  items: Item[]
}
// The main loop's turn while it has no plan: drawn as an activity bar.
export type Activity = { startedAt: number; now: number; tools: number; lastTool?: string }

declare module 'claude-code' {
  interface PluginState {
    'progress-band': { items: Item[]; agents: Agent[]; activity: Activity | null }
  }
}

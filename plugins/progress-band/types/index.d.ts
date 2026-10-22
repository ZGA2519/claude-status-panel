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

declare module 'claude-code' {
  interface PluginState {
    'progress-band': { items: Item[]; agents: Agent[] }
  }
}

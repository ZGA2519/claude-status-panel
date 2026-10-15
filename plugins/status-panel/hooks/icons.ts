// Lucide-style line icons (24×24, stroke 2). Desktop draws the SVG; the terminal draws the emoji.
// Stroke colours are mid-tone so they read on light and dark themes alike.
const ICONS = {
  folder: { color: '#F59E0B', emoji: '📁', d: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>' },
  activity: { color: '#F43F5E', emoji: '⚡', d: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>' },
  read: { color: '#3B82F6', emoji: '📖', d: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>' },
  edit: { color: '#8B5CF6', emoji: '📝', d: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>' },
  write: { color: '#10B981', emoji: '📄', d: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>' },
  terminal: { color: '#94A3B8', emoji: '💻', d: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>' },
  search: { color: '#06B6D4', emoji: '🔎', d: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>' },
  web: { color: '#0EA5E9', emoji: '🌐', d: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>' },
  agent: { color: '#EC4899', emoji: '🤖', d: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>' },
  plug: { color: '#F97316', emoji: '🔌', d: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>' },
  todo: { color: '#14B8A6', emoji: '📋', d: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>' },
  summary: { color: '#A78BFA', emoji: '📜', d: '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>' },
  chart: { color: '#6366F1', emoji: '📊', d: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>' },
  tool: { color: '#94A3B8', emoji: '🔧', d: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>' },
} as const

export type IconKey = keyof typeof ICONS

export const emojiOf = (k: IconKey) => ICONS[k].emoji

export const svgOf = (k: IconKey) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${ICONS[k].color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[k].d}</svg>`

export function iconFor(tool: string): IconKey {
  if (tool === 'Read' || tool === 'NotebookRead') return 'read'
  if (tool === 'Edit' || tool === 'NotebookEdit') return 'edit'
  if (tool === 'Write') return 'write'
  if (tool === 'Bash' || tool === 'BashOutput' || tool === 'KillShell') return 'terminal'
  if (tool === 'Grep' || tool === 'Glob' || tool === 'ToolSearch' || tool === 'WebSearch') return 'search'
  if (tool === 'WebFetch' || /browser|chrome|playwright/i.test(tool)) return 'web'
  if (tool === 'Agent' || tool === 'Task' || tool === 'SendMessage') return 'agent'
  if (tool === 'TodoWrite') return 'todo'
  if (tool.startsWith('mcp__')) return 'plug'
  return 'tool'
}

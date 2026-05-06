import type { FeedEntry } from '../office/types.js'
import { prettyActivity } from '../office/components/ToolOverlay.js'

interface AgentFeedProps {
  agentId: number | null
  folderName?: string
  entries: FeedEntry[]
  isMobile: boolean
  onClose: () => void
}

export function AgentFeed({ agentId, folderName, entries, isMobile, onClose }: AgentFeedProps) {
  if (agentId === null) return null
  const ordered = [...entries].reverse() // latest first
  const baseStyle: React.CSSProperties = isMobile
    ? { position: 'fixed', left: 0, right: 0, bottom: 0, height: '70vh', background: '#0c0d12', borderTop: '2px solid #FF7A1A', zIndex: 800, display: 'flex', flexDirection: 'column' }
    : { position: 'fixed', right: 0, top: 0, bottom: 0, width: 380, background: '#0c0d12', borderLeft: '2px solid #FF7A1A', zIndex: 800, display: 'flex', flexDirection: 'column' }
  return (
    <div style={baseStyle}>
      <div style={{ background: '#FF7A1A', color: '#1a0a00', padding: '8px 12px', display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
        <span>Agent #{agentId}{folderName ? ` · ${folderName}` : ''}</span>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#1a0a00', fontSize: 22, lineHeight: 1, cursor: 'pointer' }}>×</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', color: '#e6e6f0' }}>
        {ordered.map((e, i) => <FeedCard key={i} entry={e} />)}
        {ordered.length === 0 && <div style={{ color: '#7d8694', textAlign: 'center', marginTop: 32 }}>No activity yet.</div>}
      </div>
    </div>
  )
}

function FeedCard({ entry }: { entry: FeedEntry }) {
  const ts = new Date(entry.timestamp).toLocaleTimeString()
  const card = (color: string, label: string, body: React.ReactNode) => (
    <div style={{ background: '#16181f', border: `1px solid ${color}33`, borderLeft: `3px solid ${color}`, padding: '6px 10px', fontSize: 12 }}>
      <div style={{ color: '#7d8694', fontSize: 10, marginBottom: 2 }}>{ts} · {label}</div>
      <div>{body}</div>
    </div>
  )
  switch (entry.kind) {
    case 'text':       return card('#9ad8ff', 'assistant', <span>{entry.text.slice(0, 240)}{entry.text.length > 240 ? '…' : ''}</span>)
    case 'tool_start': return card('#FFB060', 'tool',      <span>{prettyActivity(entry.status)}</span>)
    case 'tool_done':  return card('#7be3a8', 'done',      <span style={{ color: '#7d8694' }}>tool {entry.toolId.slice(-8)} finished</span>)
    case 'tool_perm':  return card('#FF7A1A', 'perm',      <span>Awaiting permission · {entry.label}</span>)
    case 'system':     return card('#7d8694', 'system',    <span style={{ color: '#7d8694' }}>{entry.message}</span>)
  }
}

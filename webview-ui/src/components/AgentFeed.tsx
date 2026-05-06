import type { FeedEntry } from '../office/types.js'
import { prettyActivity } from '../office/components/ToolOverlay.js'

interface AgentFeedProps {
  agentId: number | null
  folderName?: string
  entries: FeedEntry[]
  isMobile: boolean
  onClose: () => void
  onBack?: () => void
  /** When true, skip the fixed-position wrapper — assume parent positions. */
  embedded?: boolean
}

export function AgentFeed({ agentId, folderName, entries, isMobile, onClose, onBack, embedded }: AgentFeedProps) {
  if (agentId === null) return null
  const ordered = [...entries].reverse() // latest first
  const wrapperStyle: React.CSSProperties = embedded
    ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }
    : isMobile
      ? { position: 'fixed', left: 0, right: 0, bottom: 0, height: '70vh', background: '#0c0d12', borderTop: '2px solid #FF7A1A', zIndex: 800, display: 'flex', flexDirection: 'column' }
      : { position: 'fixed', right: 0, top: 0, bottom: 0, width: 380, background: '#0c0d12', borderLeft: '2px solid #FF7A1A', zIndex: 800, display: 'flex', flexDirection: 'column' }
  return (
    <div style={wrapperStyle}>
      <div style={{ background: '#FF7A1A', color: '#1a0a00', padding: '6px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 700, fontSize: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {onBack && (
            <button onClick={onBack} title="Back to all agents" style={{ background: 'transparent', border: 'none', color: '#1a0a00', cursor: 'pointer', fontWeight: 700, padding: '0 4px', fontSize: 14 }}>←</button>
          )}
          <span>Agent #{agentId}{folderName ? ` · ${folderName}` : ''}</span>
        </div>
        {!onBack && (
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#1a0a00', fontSize: 18, lineHeight: 1, cursor: 'pointer' }}>×</button>
        )}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', color: '#e6e6f0' }}>
        {ordered.map((e, i) => <FeedCard key={i} entry={e} />)}
        {ordered.length === 0 && <div style={{ color: '#7d8694', textAlign: 'center', marginTop: 24, fontSize: 11 }}>No activity yet.</div>}
      </div>
    </div>
  )
}

function FeedCard({ entry }: { entry: FeedEntry }) {
  const ts = new Date(entry.timestamp).toLocaleTimeString()
  const card = (color: string, label: string, body: React.ReactNode) => (
    <div style={{ background: '#16181f', border: `1px solid ${color}33`, borderLeft: `4px solid ${color}`, padding: '10px 14px', fontSize: 16 }}>
      <div style={{ color: '#7d8694', fontSize: 12, marginBottom: 4 }}>{ts} · {label}</div>
      <div>{body}</div>
    </div>
  )
  switch (entry.kind) {
    case 'text':       return card('#9ad8ff', 'assistant', <span>{entry.text.slice(0, 250)}{entry.text.length > 250 ? '…' : ''}</span>)
    case 'tool_start': return card('#FFB060', 'tool',      <span>{prettyActivity(entry.status)}</span>)
    case 'tool_done':  return card('#7be3a8', 'done',      <span style={{ color: '#7d8694' }}>tool {entry.toolId.slice(-8)} finished</span>)
    case 'tool_perm':  return card('#FF7A1A', 'perm',      <span>Awaiting permission · {entry.label}</span>)
    case 'system':     return card('#7d8694', 'system',    <span style={{ color: '#7d8694' }}>{entry.message}</span>)
  }
}

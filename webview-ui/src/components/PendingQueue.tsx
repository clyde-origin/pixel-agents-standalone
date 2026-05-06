import { useState } from 'react'

interface PendingItem {
  agentId: number
  folderName?: string
  toolName?: string
  label?: string
  receivedAt: number
}

interface PendingQueueProps {
  pending: PendingItem[]
  onSelect: (agentId: number) => void
}

export function PendingQueue({ pending, onSelect }: PendingQueueProps) {
  const [open, setOpen] = useState(false)
  if (pending.length === 0) return null
  return (
    <div style={{ position: 'fixed', top: 12, right: 12, zIndex: 900 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: '#FF7A1A', color: '#1a0a00', border: '2px solid rgba(0,0,0,0.35)',
          padding: '6px 12px', fontWeight: 700, fontFamily: 'inherit', fontSize: '13px',
          cursor: 'pointer', boxShadow: '0 2px 0 rgba(0,0,0,0.35)',
        }}
      >
        ! {pending.length} pending
      </button>
      {open && (
        <div style={{ marginTop: 6, background: '#0c0d12', border: '2px solid #FF7A1A', minWidth: 280, padding: 6, fontFamily: 'inherit' }}>
          {pending.map((p) => (
            <button
              key={p.agentId}
              onClick={() => { setOpen(false); onSelect(p.agentId) }}
              style={{
                width: '100%', textAlign: 'left', background: 'transparent', color: '#e6e6f0',
                border: 'none', borderBottom: '1px solid #2a2d36', padding: '6px 8px',
                cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px',
              }}
            >
              <div><strong>Agent #{p.agentId}</strong>{p.folderName ? ` · ${p.folderName}` : ''}</div>
              <div style={{ color: '#9aa', fontSize: '11px' }}>{p.toolName} · {p.label ?? ''} · {Math.round((Date.now() - p.receivedAt) / 1000)}s</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

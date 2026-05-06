import type { OfficeState } from '../office/engine/officeState.js'
import type { ToolActivity } from '../office/types.js'
import { prettyActivity } from '../office/components/ToolOverlay.js'

interface AgentListProps {
  officeState: OfficeState
  agents: number[]
  agentTools: Record<number, ToolActivity[]>
  onSelect: (agentId: number) => void
}

export function AgentList({ officeState, agents, agentTools, onSelect }: AgentListProps) {
  const rows = agents.map((id) => {
    const ch = officeState.characters.get(id)
    if (!ch || ch.isSubagent) return null
    const tools = agentTools[id] ?? []
    const pending = tools.some((t) => t.permissionWait && !t.done)
    const lastTool = [...tools].reverse().find((t) => !t.done)
    const activity = lastTool ? prettyActivity(lastTool.status) : (ch.isActive ? 'Thinking…' : 'Idle')
    return { id, project: ch.folderName ?? `Agent ${id}`, activity, pending }
  }).filter(Boolean) as Array<{ id: number; project: string; activity: string; pending: boolean }>

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '8px 6px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ color: '#7d8694', fontSize: 10, padding: '2px 6px 6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {rows.length} agent{rows.length === 1 ? '' : 's'} live
      </div>
      {rows.map((r) => (
        <button
          key={r.id}
          onClick={() => onSelect(r.id)}
          style={{
            background: r.pending ? '#FF7A1A' : '#16181f',
            color: r.pending ? '#1a0a00' : '#e6e6f0',
            border: '1px solid ' + (r.pending ? '#5a1f00' : '#2a2d36'),
            padding: '6px 10px',
            textAlign: 'left',
            cursor: 'pointer',
            fontFamily: 'inherit',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.3px' }}>
            {r.pending ? '! ' : ''}{r.project}
          </span>
          <span style={{ fontSize: 10, color: r.pending ? '#1a0a00' : '#9aa', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
            {r.activity}
          </span>
        </button>
      ))}
      {rows.length === 0 && (
        <div style={{ color: '#7d8694', fontSize: 11, textAlign: 'center', marginTop: 24 }}>
          No agents connected.
        </div>
      )}
    </div>
  )
}

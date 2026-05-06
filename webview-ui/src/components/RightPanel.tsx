import type { FeedEntry, ToolActivity } from '../office/types.js'
import type { OfficeState } from '../office/engine/officeState.js'
import { AgentList } from './AgentList.js'
import { AgentFeed } from './AgentFeed.js'

interface RightPanelProps {
  officeState: OfficeState
  agents: number[]
  agentTools: Record<number, ToolActivity[]>
  selectedAgentId: number | null
  agentFeeds: Record<number, FeedEntry[]>
  onSelect: (agentId: number) => void
  onClearSelection: () => void
}

export function RightPanel({ officeState, agents, agentTools, selectedAgentId, agentFeeds, onSelect, onClearSelection }: RightPanelProps) {
  return (
    <div
      style={{
        position: 'fixed',
        right: 0, top: 0, bottom: 0,
        width: 520,
        background: '#0c0d12',
        borderLeft: '2px solid #FF7A1A',
        zIndex: 800,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      }}
    >
      {selectedAgentId === null ? (
        <>
          <div style={{ background: '#FF7A1A', color: '#1a0a00', padding: '8px 12px', fontWeight: 700 }}>
            Pixel Agents · Live
          </div>
          <AgentList
            officeState={officeState}
            agents={agents}
            agentTools={agentTools}
            onSelect={onSelect}
          />
        </>
      ) : (
        <AgentFeed
          agentId={selectedAgentId}
          folderName={officeState.characters.get(selectedAgentId)?.folderName}
          entries={agentFeeds[selectedAgentId] ?? []}
          isMobile={false}
          onBack={onClearSelection}
          onClose={onClearSelection}
          embedded
        />
      )}
    </div>
  )
}

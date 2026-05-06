import type { ToolActivity } from '../office/types.js'
import type { PermissionContext } from '../hooks/useExtensionMessages.js'

interface PermissionModalProps {
  agentId: number | null
  folderName: string | undefined
  pendingTool: ToolActivity | null
  context: PermissionContext | null
  onClose: () => void
}

/** Standard Claude Code permission options as shown in the terminal. */
const TERMINAL_OPTIONS = [
  { key: '1', label: 'Yes', sub: 'Allow this once' },
  { key: '2', label: 'Yes, and don\'t ask again', sub: 'Allow this tool for the rest of this session' },
  { key: '3', label: 'No, and tell me what to do', sub: 'Send the agent feedback' },
]

/** Best-effort summary of the tool input for the modal body. */
function summarizeInput(name: string | undefined, input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  switch (name) {
    case 'Bash':
      return typeof input.command === 'string' ? (input.command as string) : ''
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return typeof input.file_path === 'string' ? (input.file_path as string) : ''
    case 'Read':
      return typeof input.file_path === 'string' ? (input.file_path as string) : ''
    default: {
      try {
        return JSON.stringify(input, null, 2)
      } catch {
        return ''
      }
    }
  }
}

/** Mini-terminal style modal showing what an agent is waiting on for permission.
 *  Approve / Deny are wired to a placeholder for now — actually forwarding the answer
 *  to the live Claude Code session needs a PreToolUse hook in Claude's settings.json. */
export function PermissionModal({ agentId, folderName, pendingTool, context, onClose }: PermissionModalProps) {
  if (agentId === null || !pendingTool) return null

  const toolName = context?.toolName ?? ''
  const inputSummary = summarizeInput(toolName, context?.toolInput)
  const lastText = context?.lastAssistantText?.trim() ?? ''
  const requestId = context?.requestId
  const canRespond = typeof requestId === 'string'

  const respond = async (decision: 'allow' | 'deny') => {
    if (!requestId) return
    try {
      await fetch('/permission/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, decision }),
      })
    } catch {
      /* server unreachable — ignore, modal will close anyway */
    }
    onClose()
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#0c0d12',
          border: '2px solid #FF7A1A',
          minWidth: 360,
          maxWidth: 520,
          color: '#e6e6f0',
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          boxShadow: '0 8px 0 rgba(0,0,0,0.5)',
        }}
      >
        {/* Header bar */}
        <div
          style={{
            background: '#FF7A1A',
            color: '#1a0a00',
            padding: '6px 12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontWeight: 700,
            letterSpacing: '0.5px',
          }}
        >
          <span>! PERMISSION NEEDED — Agent #{agentId}{folderName ? ` · ${folderName}` : ''}</span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#1a0a00',
              fontSize: '22px',
              lineHeight: 1,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* Body — terminal-ish content */}
        <div style={{ padding: '12px 14px', fontSize: '13px', lineHeight: 1.45, maxHeight: '60vh', overflowY: 'auto' }}>
          {lastText && (
            <>
              <div style={{ color: '#9aa', marginBottom: 6 }}>$ latest message from agent:</div>
              <pre
                style={{
                  background: '#16181f',
                  padding: '10px 12px',
                  border: '1px solid #2a2d36',
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: '12px',
                  color: '#cfd2da',
                  maxHeight: '180px',
                  overflowY: 'auto',
                }}
              >
                {lastText}
              </pre>
            </>
          )}
          <div style={{ color: '#9aa', margin: '12px 0 6px' }}>$ requesting permission for:</div>
          <pre
            style={{
              background: '#16181f',
              padding: '10px 12px',
              border: '1px solid #2a2d36',
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: '13px',
            }}
          >
            {toolName ? <span style={{ color: '#FFB060' }}>{toolName} </span> : null}
            <span style={{ color: '#cfd2da' }}>{pendingTool.status}</span>
            {inputSummary && inputSummary !== pendingTool.status && (
              <>
                {'\n'}
                <span style={{ color: '#7d8694' }}>{inputSummary}</span>
              </>
            )}
          </pre>

          <div style={{ color: '#9aa', margin: '14px 0 6px' }}>$ choose how to respond:</div>
          <div
            style={{
              background: '#16181f',
              border: '1px solid #2a2d36',
              padding: '8px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {TERMINAL_OPTIONS.map((opt) => (
              <div key={opt.key} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                <span
                  style={{
                    color: '#FFB060',
                    fontWeight: 700,
                    minWidth: 18,
                    textAlign: 'right',
                  }}
                >
                  {opt.key}.
                </span>
                <div>
                  <div style={{ color: '#e6e6f0', fontWeight: 600 }}>{opt.label}</div>
                  <div style={{ color: '#7d8694', fontSize: '11px' }}>{opt.sub}</div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ color: '#9aa', marginTop: 14, fontSize: '12px' }}>
            {canRespond
              ? 'Click Allow or Deny below — the answer is forwarded to the agent\'s Claude Code session.'
              : <>Type <strong style={{ color: '#FFB060' }}>1</strong>, <strong style={{ color: '#FFB060' }}>2</strong>, or <strong style={{ color: '#FFB060' }}>3</strong> in the agent's terminal. To click these here instead, install the <code style={{ color: '#9ad8ff' }}>PreToolUse</code> hook in <code style={{ color: '#9ad8ff' }}>~/.claude/settings.json</code>.</>
            }
          </div>
        </div>

        {/* Action bar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '10px 14px',
            borderTop: '1px solid #2a2d36',
            background: '#0a0b10',
          }}
        >
          <button
            onClick={canRespond ? () => respond('deny') : undefined}
            disabled={!canRespond}
            title={canRespond ? 'Tell the agent to stop and try a different approach' : 'Install the PreToolUse hook to enable in-app responses'}
            style={{
              background: canRespond ? '#3a1010' : '#1a1d24',
              color: canRespond ? '#ff9b8b' : '#777',
              border: canRespond ? '1px solid #6b2020' : '1px solid #2a2d36',
              padding: '6px 14px',
              fontSize: '13px',
              cursor: canRespond ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              letterSpacing: '0.3px',
              fontWeight: 600,
            }}
          >
            Deny
          </button>
          <button
            onClick={canRespond ? () => respond('allow') : undefined}
            disabled={!canRespond}
            title={canRespond ? 'Allow this tool call' : 'Install the PreToolUse hook to enable in-app responses'}
            style={{
              background: canRespond ? '#FF7A1A' : '#3a2810',
              color: canRespond ? '#1a0a00' : '#aa9577',
              border: canRespond ? '1px solid #5a1f00' : '1px solid #5a3a18',
              padding: '6px 14px',
              fontSize: '13px',
              cursor: canRespond ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              letterSpacing: '0.3px',
              fontWeight: 700,
            }}
          >
            Allow
          </button>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              color: '#9aa',
              border: '1px solid #2a2d36',
              padding: '6px 14px',
              fontSize: '13px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              letterSpacing: '0.3px',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

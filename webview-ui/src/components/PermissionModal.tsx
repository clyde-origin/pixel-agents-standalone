import { useState } from 'react'
import type { ToolActivity } from '../office/types.js'
import type { PermissionContext, ResponseTemplate } from '../hooks/useExtensionMessages.js'

interface PermissionModalProps {
  agentId: number | null
  folderName: string | undefined
  pendingTool: ToolActivity | null
  context: PermissionContext | null
  responses: Record<string, ResponseTemplate[]>
  onClose: () => void
}

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
 *  Buttons are driven by ~/.pixel-agents/responses.json — the server pushes the
 *  config over WS and the modal renders one button per preset. "Custom feedback…"
 *  reveals a textarea for the user to dictate what the agent should do instead. */
export function PermissionModal({ agentId, folderName, pendingTool, context, responses, onClose }: PermissionModalProps) {
  const [composerText, setComposerText] = useState('')
  const [reasonComposerOpen, setReasonComposerOpen] = useState(false)

  if (agentId === null || !pendingTool) return null

  const toolName = context?.toolName ?? ''
  const inputSummary = summarizeInput(toolName, context?.toolInput)
  const lastText = context?.lastAssistantText?.trim() ?? ''
  const requestId = context?.requestId
  const canRespond = typeof requestId === 'string'
  const presetButtons = responses[toolName] ?? responses.default ?? []

  async function handlePreset(btn: ResponseTemplate) {
    if (btn.askForReason) { setReasonComposerOpen(true); return }
    if (!requestId) return
    await fetch('/permission/respond', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, decision: btn.decision, scope: btn.scope, reason: btn.reason }),
    }).catch(() => {})
    onClose()
  }

  async function sendDeny(reason: string) {
    if (!requestId) return
    await fetch('/permission/respond', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, decision: 'deny', reason }),
    }).catch(() => {})
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

          <div style={{ color: '#9aa', margin: '14px 0 6px' }}>$ choose a response:</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {presetButtons.map((btn, i) => (
              <button
                key={i}
                onClick={() => handlePreset(btn)}
                disabled={!canRespond}
                style={{
                  background: btn.decision === 'allow' ? '#FF7A1A' : '#3a1010',
                  color: btn.decision === 'allow' ? '#1a0a00' : '#ff9b8b',
                  border: btn.decision === 'allow' ? '1px solid #5a1f00' : '1px solid #6b2020',
                  padding: '8px 12px', fontSize: '14px', cursor: canRespond ? 'pointer' : 'not-allowed',
                  textAlign: 'left', fontFamily: 'inherit', fontWeight: 600,
                }}
              >
                {btn.label}
              </button>
            ))}
          </div>

          {reasonComposerOpen && (
            <>
              <textarea
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
                placeholder="Tell the agent what to do instead…"
                style={{ width: '100%', minHeight: 80, marginTop: 10, background: '#16181f', color: '#e6e6f0', border: '1px solid #2a2d36', padding: '8px', fontFamily: 'inherit', fontSize: '13px', boxSizing: 'border-box' }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <button onClick={() => setReasonComposerOpen(false)} style={{ background: 'transparent', color: '#9aa', border: '1px solid #2a2d36', padding: '6px 12px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={() => sendDeny(composerText)} disabled={!composerText.trim()} style={{ background: '#FF7A1A', color: '#1a0a00', border: '1px solid #5a1f00', padding: '6px 12px', fontWeight: 700, cursor: composerText.trim() ? 'pointer' : 'not-allowed' }}>Send</button>
              </div>
            </>
          )}
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

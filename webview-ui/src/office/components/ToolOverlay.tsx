import { useState, useEffect } from 'react'
import type { ToolActivity } from '../types.js'
import type { OfficeState } from '../engine/officeState.js'
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js'
import { TILE_SIZE, CharacterState } from '../types.js'
import { TOOL_OVERLAY_VERTICAL_OFFSET, CHARACTER_SITTING_OFFSET_PX } from '../../constants.js'

interface ToolOverlayProps {
  officeState: OfficeState
  agents: number[]
  agentTools: Record<number, ToolActivity[]>
  subagentCharacters: SubagentCharacter[]
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  onCloseAgent: (id: number) => void
  /** Triggered when the user clicks "Respond?" on an agent that needs permission. */
  onRespondToAgent?: (id: number) => void
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
): string {
  const tools = agentTools[agentId]
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done)
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval'
      return prettyActivity(activeTool.status)
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1]
      if (lastTool) return prettyActivity(lastTool.status)
    }
  }

  return isActive ? 'Thinking…' : 'Idle'
}

/** Translate the server's tool status into plain English. */
function prettyActivity(status: string): string {
  // Bash: parse the command for a friendly verb
  if (status.startsWith('Running: ')) {
    return prettyBash(status.slice('Running: '.length))
  }
  if (status.startsWith('Subtask: ')) return 'Spinning up a helper'
  if (status === 'Running subtask') return 'Spinning up a helper'
  if (status.startsWith('Reading ')) return status   // "Reading foo.ts" — already plain
  if (status.startsWith('Editing ')) return status
  if (status.startsWith('Writing ')) return status
  if (status === 'Searching files' || status === 'Searching code') return 'Searching the project'
  if (status === 'Fetching web content') return 'Reading the web'
  if (status === 'Searching the web') return 'Searching the web'
  if (status === 'Waiting for your answer') return 'Waiting on you'
  if (status === 'Planning') return 'Planning'

  // "Using FooBar" or "Using mcp__claude_ai_Slack__send_message" → "Using Slack"
  if (status.startsWith('Using ')) {
    const name = status.slice('Using '.length)
    if (name.startsWith('mcp__')) {
      const parts = name.split('__')
      const service = parts[1] ? parts[1].replace(/^claude_ai_/, '') : 'a tool'
      return `Using ${service.replace(/_/g, ' ')}`
    }
    if (name === 'Task' || name === 'Agent') return 'Spinning up a helper'
    if (name === 'TaskCreate' || name === 'TaskUpdate' || name === 'TaskList') return 'Updating its task list'
    if (name === 'AskUserQuestion') return 'Waiting on you'
    if (name === 'EnterPlanMode' || name === 'ExitPlanMode') return 'Planning'
    if (name === 'NotebookEdit') return 'Editing a notebook'
    if (name === 'WebFetch') return 'Reading the web'
    if (name === 'WebSearch') return 'Searching the web'
    if (name === 'ToolSearch') return 'Looking up a tool'
    if (name === 'Skill') return 'Loading a skill'
    if (name === 'ScheduleWakeup' || name === 'CronCreate' || name === 'CronList' || name === 'CronDelete') return 'Scheduling work'
    if (name === 'EnterWorktree' || name === 'ExitWorktree') return 'Switching worktrees'
    if (name === 'Monitor') return 'Watching a process'
    if (name === 'PushNotification') return 'Notifying you'
    if (name === 'RemoteTrigger') return 'Triggering a remote'
    return `Using ${name}`
  }
  return status
}

/** Map a bash command to a layman phrase. */
function prettyBash(cmd: string): string {
  const c = cmd.trim().replace(/^["'`]/, '').toLowerCase()
  // Match by leading token chains
  if (/^(npm|pnpm|yarn|bun)\s+install\b/.test(c) || /^(npm|pnpm|yarn|bun)\s+i\b/.test(c) || /^(npm|pnpm|yarn|bun)\s+add\b/.test(c)) return 'Installing packages'
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(build|dev|start)\b/.test(c)) return 'Building / running the app'
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tsc|typecheck|lint)\b/.test(c) || /^pytest\b|^jest\b|^vitest\b|^cargo\s+test\b|^go\s+test\b/.test(c)) return 'Running tests'
  if (/^git\s+status\b/.test(c)) return 'Checking git status'
  if (/^git\s+diff\b/.test(c) || /^git\s+show\b/.test(c)) return 'Reviewing changes'
  if (/^git\s+log\b/.test(c) || /^git\s+blame\b/.test(c)) return 'Reading git history'
  if (/^git\s+add\b/.test(c)) return 'Staging changes'
  if (/^git\s+commit\b/.test(c)) return 'Committing'
  if (/^git\s+push\b/.test(c)) return 'Pushing to git'
  if (/^git\s+pull\b|^git\s+fetch\b/.test(c)) return 'Pulling from git'
  if (/^git\s+(checkout|switch|branch|merge|rebase|stash|restore|reset)\b/.test(c)) return 'Working with git branches'
  if (/^gh\s+pr\s+create\b/.test(c)) return 'Opening a pull request'
  if (/^gh\s+pr\s+(merge|review|comment|edit)\b/.test(c)) return 'Working on a PR'
  if (/^gh\s+issue\b/.test(c)) return 'Working on an issue'
  if (/^gh\s+/.test(c)) return 'Talking to GitHub'
  if (/^docker\b|^kubectl\b|^helm\b/.test(c)) return 'Managing infra'
  if (/^curl\b|^wget\b|^http\b/.test(c)) return 'Calling an API'
  if (/^(ls|find|tree|fd|rg|ripgrep|grep|cat|head|tail|wc|file|stat|du)\b/.test(c)) return 'Exploring files'
  if (/^(mkdir|rm|mv|cp|touch|chmod|chown|ln)\b/.test(c)) return 'Reorganising files'
  if (/^(node|python3?|ruby|go run|cargo run|deno|bun run)\b/.test(c)) return 'Running a script'
  if (/^(psql|sqlite3|mysql|mongosh|redis-cli)\b/.test(c)) return 'Querying a database'
  if (/^(supabase|prisma|drizzle)\b/.test(c)) return 'Working with the database'
  if (/^(vercel|netlify|fly|heroku|railway|aws|gcloud|az)\b/.test(c)) return 'Talking to cloud'
  if (/^(make|cmake|ninja|bazel|gradle|mvn)\b/.test(c)) return 'Building'
  if (/^(echo|printf|true|false|sleep|date|env|export|source|alias|which|where|type)\b/.test(c)) return 'Setting things up'
  return 'Running a command'
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
  onRespondToAgent,
}: ToolOverlayProps) {
  const [, setTick] = useState(0)
  useEffect(() => {
    let rafId = 0
    const tick = () => {
      setTick((n) => n + 1)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const el = containerRef.current
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const canvasW = Math.round(rect.width * dpr)
  const canvasH = Math.round(rect.height * dpr)
  const layout = officeState.getLayout()
  const mapW = layout.cols * TILE_SIZE * zoom
  const mapH = layout.rows * TILE_SIZE * zoom
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x)
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y)

  const selectedId = officeState.selectedAgentId
  const hoveredId = officeState.hoveredAgentId

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)]

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id)
        if (!ch) return null

        const isSelected = selectedId === id
        const isHovered = hoveredId === id
        const isSub = ch.isSubagent

        // Position above character
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr
        const screenY = (deviceOffsetY + (ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET) * zoom) / dpr

        const displayName = ch.folderName || (isSub ? 'Subtask' : `Agent #${id}`)

        // Compute activity + dot for everyone; the activity row only renders when relevant.
        const subHasPermission = isSub && ch.bubbleType === 'permission'
        let activityText = ''
        if (isSub) {
          if (subHasPermission) {
            activityText = 'Needs approval'
          } else {
            const sub = subagentCharacters.find((s) => s.id === id)
            activityText = sub ? sub.label : 'Subtask'
          }
        } else {
          activityText = getActivityText(id, agentTools, ch.isActive)
        }

        const tools = agentTools[id]
        const hasPermission = subHasPermission || (!!tools && tools.some((t) => t.permissionWait && !t.done))
        const hasActiveTools = !!tools && tools.some((t) => !t.done)
        const isActive = ch.isActive

        // Activity is only shown on hover or when selected — keeps the scene calm.
        const showDetails = isSelected || isHovered

        let dotColor: string | null = null
        if (hasPermission) {
          dotColor = 'var(--pixel-status-permission)'
        } else if (isActive && hasActiveTools) {
          dotColor = 'var(--pixel-status-active)'
        }

        return (
          <div
            key={id}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY - 24,
              transform: 'translateX(-50%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              pointerEvents: isSelected ? 'auto' : 'none',
              zIndex: isSelected ? 'var(--pixel-overlay-selected-z)' : 'var(--pixel-overlay-z)',
            }}
          >
            {showDetails ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  background: 'var(--pixel-bg)',
                  border: isSelected
                    ? '2px solid var(--pixel-border-light)'
                    : '2px solid var(--pixel-border)',
                  borderRadius: 0,
                  padding: isSelected ? '3px 6px 3px 8px' : '3px 8px',
                  boxShadow: 'var(--pixel-shadow)',
                  whiteSpace: 'nowrap',
                  maxWidth: 220,
                }}
              >
                {dotColor && (
                  <span
                    className={ch.isActive && dotColor !== 'var(--pixel-status-permission)' ? 'pixel-agents-pulse' : undefined}
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: dotColor,
                      flexShrink: 0,
                    }}
                  />
                )}
                <div style={{ overflow: 'hidden' }}>
                  <span
                    style={{
                      fontSize: isSub ? '20px' : '22px',
                      fontStyle: isSub ? 'italic' : undefined,
                      color: 'var(--vscode-foreground)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: 'block',
                    }}
                  >
                    {displayName}
                  </span>
                  <span
                    style={{
                      fontSize: '16px',
                      color: 'var(--pixel-text-dim)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: 'block',
                    }}
                  >
                    {activityText}
                  </span>
                </div>
                {hasPermission && onRespondToAgent && !isSub && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onRespondToAgent(id)
                    }}
                    title="Show what this agent is waiting on"
                    style={{
                      background: '#FF7A1A',
                      color: '#1a0a00',
                      border: '2px solid rgba(0,0,0,0.35)',
                      padding: '3px 8px',
                      fontSize: '13px',
                      lineHeight: 1,
                      fontWeight: 700,
                      letterSpacing: '0.5px',
                      cursor: 'pointer',
                      pointerEvents: 'auto',
                      marginLeft: 4,
                      flexShrink: 0,
                      boxShadow: '0 1px 0 rgba(0,0,0,0.35)',
                    }}
                  >
                    RESPOND?
                  </button>
                )}
                {isSelected && !isSub && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onCloseAgent(id)
                    }}
                    title="Close agent"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--pixel-close-text)',
                      cursor: 'pointer',
                      padding: '0 2px',
                      fontSize: '26px',
                      lineHeight: 1,
                      marginLeft: 2,
                      flexShrink: 0,
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-hover)'
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-text)'
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ) : (
              <div
                style={{
                  background: 'var(--pixel-bg)',
                  border: '1px solid var(--pixel-border)',
                  padding: '1px 6px',
                  boxShadow: 'var(--pixel-shadow)',
                  whiteSpace: 'nowrap',
                }}
              >
                <span
                  style={{
                    fontSize: '16px',
                    color: 'var(--pixel-text-dim)',
                  }}
                >
                  {displayName}
                </span>
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

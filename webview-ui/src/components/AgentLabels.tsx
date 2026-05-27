import { useState, useEffect } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { SubagentCharacter } from '../hooks/useExtensionMessages.js'
import { TILE_SIZE, CharacterState } from '../office/types.js'
import type { Character } from '../office/types.js'

/** Friendly phrasing for a leisure "field trip" away from the desk. */
function tripPhrase(trip: Character['tripMode']): string | null {
  switch (trip) {
    case 'ping_pong': return 'Playing ping-pong'
    case 'chess': return 'Playing chess'
    case 'pool': return 'At the pool table'
    case 'beanbag': return 'Chilling on the beanbag'
    case 'bookshelf': return 'Browsing the shelf'
    case 'pacing': return 'Pacing, thinking'
    case 'planting': return 'Planting in the meadow'
    default: return null
  }
}

/** Resolve the live "what is it doing right now" line, highest-priority first. */
function resolveLiveLine(ch: Character, isWaiting: boolean): string {
  if (ch.bubbleType === 'permission') return 'Needs permission'
  if (isWaiting || ch.bubbleType === 'waiting') return 'Waiting for you'
  if (ch.liveStatus) return ch.liveStatus
  const trip = tripPhrase(ch.tripMode)
  if (trip) return trip
  if (ch.isActive) return 'Working…'
  return 'idle'
}

interface AgentLabelsProps {
  officeState: OfficeState
  agents: number[]
  agentStatuses: Record<number, string>
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  subagentCharacters: SubagentCharacter[]
}

export function AgentLabels({
  officeState,
  agents,
  agentStatuses,
  containerRef,
  zoom,
  panRef,
  subagentCharacters,
}: AgentLabelsProps) {
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

  // Read the canvas shell's rect (smaller than the App container on desktop) so overlay
  // positioning math matches the actual canvas geometry.
  const shell = document.querySelector('.pixel-canvas-shell') as HTMLElement | null
  const el = shell ?? containerRef.current
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  // Compute device pixel offset (same math as renderFrame, including pan)
  const canvasW = Math.round(rect.width * dpr)
  const canvasH = Math.round(rect.height * dpr)
  const layout = officeState.getLayout()
  const mapW = layout.cols * TILE_SIZE * zoom
  const mapH = layout.rows * TILE_SIZE * zoom
  // On desktop the office is right-anchored within the canvas, so the overlay must apply
  // the same right-align offset (matching OfficeCanvas's renderFrame call).
  const isDesktop = window.matchMedia('(min-width: 769px)').matches
  const panX = isDesktop ? (canvasW - mapW) / 2 : panRef.current.x
  const panY = isDesktop ? 0 : panRef.current.y
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panX)
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panY)

  // Build sub-agent label lookup
  const subLabelMap = new Map<number, string>()
  for (const sub of subagentCharacters) {
    subLabelMap.set(sub.id, sub.label)
  }

  // All character IDs to render labels for (regular agents + sub-agents)
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)]

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id)
        if (!ch) return null

        // Character position: device pixels → CSS pixels (follow sitting offset)
        const sittingOffset = ch.state === CharacterState.TYPE ? 6 : 0
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr
        const screenY = (deviceOffsetY + (ch.y + sittingOffset - 24) * zoom) / dpr

        const status = agentStatuses[id]
        const isWaiting = status === 'waiting'
        const isActive = ch.isActive
        const isSub = ch.isSubagent

        let dotColor = 'transparent'
        if (isWaiting) {
          dotColor = 'var(--vscode-charts-yellow, #cca700)'
        } else if (isActive) {
          dotColor = 'var(--vscode-charts-blue, #3794ff)'
        }

        // Line 1 = identity + intent. Sub-agents use their subtask label (their "goal").
        const subLabel = subLabelMap.get(id)
        const identity = isSub ? (subLabel || `Agent #${id}`) : (ch.folderName || `Agent #${id}`)
        const goal = isSub ? undefined : ch.goal
        // Line 2 = what it's doing right now.
        const liveLine = resolveLiveLine(ch, isWaiting)
        const liveDim = liveLine === 'idle'

        return (
          <div
            key={id}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY,
              // Anchor the label's BOTTOM just above the head so it clears the sprite
              // regardless of how many lines it has.
              transform: 'translate(-50%, -100%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              pointerEvents: 'none',
              zIndex: 40,
            }}
          >
            {dotColor !== 'transparent' && (
              <span
                className={isActive && !isWaiting ? 'pixel-agents-pulse' : undefined}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: dotColor,
                  marginBottom: 2,
                }}
              />
            )}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                background: 'rgba(30,30,46,0.78)',
                padding: '1px 5px 2px',
                borderRadius: 3,
                maxWidth: isSub ? 140 : 240,
              }}
            >
              {/* Line 1: identity · "goal" */}
              <span
                style={{
                  fontSize: isSub ? '15px' : '17px',
                  fontStyle: isSub ? 'italic' : undefined,
                  color: 'var(--vscode-foreground)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: '100%',
                }}
              >
                {identity}
                {goal && <span style={{ opacity: 0.72 }}>{` · “${goal}”`}</span>}
              </span>
              {/* Line 2: live focus */}
              <span
                style={{
                  fontSize: '12px',
                  lineHeight: 1.2,
                  color: 'var(--vscode-descriptionForeground, #aab)',
                  opacity: liveDim ? 0.5 : 0.85,
                  fontStyle: liveDim ? 'italic' : undefined,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: '100%',
                }}
              >
                {liveLine}
              </span>
            </div>
          </div>
        )
      })}
    </>
  )
}

import { useState, useEffect } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import { TILE_SIZE } from '../office/types.js'
import { DeskActivityCard } from './DeskActivityCard.js'
import type { ToolActivity } from '../office/types.js'

interface DeskLabelsProps {
  officeState: OfficeState
  agentTools: Record<number, ToolActivity[]>
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  onSelectAgent?: (id: number) => void
}

/** A workgroup pod — bounding box of tiles and the task-type label that sits on the center desk. */
interface ClusterDef {
  /** tile col range (inclusive) */
  colMin: number
  colMax: number
  /** tile row of the desks (anchor for the label) */
  deskRow: number
  /** Tile row where the label is anchored — should land on the desk surface, just below the monitor. */
  labelRow: number
  title: string
  subtitle?: string
  tone: 'cool' | 'warm' | 'pink' | 'amber' | 'teal' | 'violet' | 'green'
}

// Six 3-desk pods. Top clusters: desks rows 3-4, monitors at row 4 — label sits on row 4 desk surface,
// rendered as a placard centered horizontally and aligned just below the monitor.
// Bottom clusters: desks rows 11-12, monitors at row 12 — label on row 12.
const CLUSTERS: ClusterDef[] = [
  { colMin: 2,  colMax: 7,  deskRow: 3,  labelRow: 4,  title: 'BUILD',     subtitle: 'New features',   tone: 'cool' },
  { colMin: 10, colMax: 15, deskRow: 3,  labelRow: 4,  title: 'REFACTOR',  subtitle: 'Cleanup & rework', tone: 'amber' },
  { colMin: 18, colMax: 23, deskRow: 3,  labelRow: 4,  title: 'SHIP',      subtitle: 'Release & deploy', tone: 'green' },
  { colMin: 2,  colMax: 7,  deskRow: 11, labelRow: 12, title: 'TEST',      subtitle: 'Verify & QA',    tone: 'teal' },
  { colMin: 10, colMax: 15, deskRow: 11, labelRow: 12, title: 'REVIEW',    subtitle: 'Read & critique', tone: 'pink' },
  { colMin: 18, colMax: 23, deskRow: 11, labelRow: 12, title: 'EXPLORE',   subtitle: 'Spikes & research', tone: 'violet' },
]

const TONE_BG: Record<ClusterDef['tone'], string> = {
  cool:   'linear-gradient(180deg, rgba(40, 90, 130, 0.94),  rgba(20, 50, 80, 0.94))',
  warm:   'linear-gradient(180deg, rgba(140, 90, 40, 0.94),  rgba(80, 50, 20, 0.94))',
  pink:   'linear-gradient(180deg, rgba(150, 60, 100, 0.94), rgba(90, 30, 60, 0.94))',
  amber:  'linear-gradient(180deg, rgba(160, 110, 30, 0.94), rgba(100, 70, 15, 0.94))',
  teal:   'linear-gradient(180deg, rgba(40, 130, 110, 0.94), rgba(20, 80, 70, 0.94))',
  violet: 'linear-gradient(180deg, rgba(95, 60, 150, 0.94),  rgba(50, 30, 90, 0.94))',
  green:  'linear-gradient(180deg, rgba(60, 130, 60, 0.94),  rgba(30, 80, 30, 0.94))',
}

export function DeskLabels({ officeState, agentTools, containerRef, zoom, panRef, onSelectAgent }: DeskLabelsProps) {
  // Re-render each animation frame so labels track pan/zoom/camera-follow smoothly.
  const [, setTick] = useState(0)
  useEffect(() => {
    let rafId = 0
    const tick = () => {
      setTick((n) => (n + 1) & 0xfff)
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

  // Count which projects are currently inside each cluster (by character position).
  const projectsByCluster: string[][] = CLUSTERS.map(() => [])
  for (const ch of officeState.characters.values()) {
    if (!ch.folderName) continue
    for (let i = 0; i < CLUSTERS.length; i++) {
      const c = CLUSTERS[i]
      // A character belongs to a cluster if their tile col is within the cluster's span
      // AND their tile row is within ±3 of the cluster's desk row.
      if (
        ch.tileCol >= c.colMin && ch.tileCol <= c.colMax &&
        Math.abs(ch.tileRow - c.deskRow) <= 3
      ) {
        if (!projectsByCluster[i].includes(ch.folderName)) {
          projectsByCluster[i].push(ch.folderName)
        }
        break
      }
    }
  }

  // Render one label per cluster, plus the existing per-station labels.
  return (
    <>
      {CLUSTERS.map((c, i) => {
        // Center the label on the middle desk's center column.
        const centerCol = (c.colMin + c.colMax) / 2 + 0.5
        const wx = centerCol * TILE_SIZE
        // Anchor at the bottom edge of the monitor row so the label sits just below the screen.
        const wy = (c.labelRow + 1) * TILE_SIZE - 2
        const screenX = (deviceOffsetX + wx * zoom) / dpr
        const screenY = (deviceOffsetY + wy * zoom) / dpr
        const projects = projectsByCluster[i]
        return (
          <div
            key={`cluster-${i}`}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY,
              transform: 'translate(-50%, -100%)',
              pointerEvents: 'none',
              zIndex: 30,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1,
            }}
          >
            <span
              style={{
                fontSize: '11px',
                lineHeight: 1,
                padding: '2px 6px',
                background: TONE_BG[c.tone],
                color: '#f4f4ff',
                border: '1px solid rgba(255,255,255,0.20)',
                borderRadius: 0,
                whiteSpace: 'nowrap',
                fontWeight: 700,
                letterSpacing: '0.6px',
                boxShadow: '0 1px 0 rgba(0,0,0,0.35)',
                fontFamily: 'inherit',
              }}
            >
              {c.title}
            </span>
            {projects.length > 0 && (
              <span
                style={{
                  fontSize: '9px',
                  lineHeight: 1,
                  color: 'rgba(255,255,255,0.85)',
                  background: 'rgba(20,20,30,0.7)',
                  padding: '1px 4px',
                  border: '1px solid rgba(255,255,255,0.1)',
                  whiteSpace: 'nowrap',
                  maxWidth: 140,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {projects.join(' · ')}
              </span>
            )}
          </div>
        )
      })}
      {Array.from(officeState.characters.values()).map((ch) => {
        if (ch.isSubagent || !ch.seatId) return null
        const seat = officeState.seats.get(ch.seatId)
        if (!seat) return null
        // Card sits on the desk row just below the monitor — anchor at (seatCol, seatRow+2)
        const wx = (seat.seatCol + 0.5) * TILE_SIZE
        const wy = (seat.seatRow + 3) * TILE_SIZE
        const sx = (deviceOffsetX + wx * zoom) / dpr
        const sy = (deviceOffsetY + wy * zoom) / dpr
        const tools = agentTools[ch.id] ?? []
        const pending = tools.some((t) => t.permissionWait && !t.done)
        const lastTool = [...tools].reverse().find((t) => !t.done)
        const activity = lastTool ? lastTool.status : (ch.isActive ? 'thinking…' : 'idle')
        return (
          <DeskActivityCard
            key={`card-${ch.id}`}
            screenX={sx} screenY={sy}
            project={ch.folderName ?? `Agent ${ch.id}`}
            activity={activity}
            pendingPermission={pending}
            onClick={() => onSelectAgent?.(ch.id)}
          />
        )
      })}
    </>
  )
}

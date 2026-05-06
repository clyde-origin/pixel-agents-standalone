import { useState, useEffect } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import { TILE_SIZE } from '../office/types.js'

interface DeskLabelsProps {
  officeState: OfficeState
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
}

/** A workgroup pod — bounding box of tiles and the task-type label that sits on the center desk. */
interface ClusterDef {
  /** tile col range (inclusive) */
  colMin: number
  colMax: number
  /** tile row of the desks (used for project-occupancy detection) */
  deskRow: number
  /** Tile row where the label is anchored on the desk surface. */
  labelRow: number
  title: string
  tone: 'cool' | 'warm' | 'pink' | 'amber' | 'teal' | 'violet' | 'green'
}

// Six task pods. Top clusters: desks rows 3-4 — label sits on the desk surface.
// Bottom clusters: desks rows 11-12 — label on the desk surface.
const CLUSTERS: ClusterDef[] = [
  { colMin: 2,  colMax: 7,  deskRow: 3,  labelRow: 4,  title: 'BUILD',    tone: 'cool' },
  { colMin: 10, colMax: 15, deskRow: 3,  labelRow: 4,  title: 'REFACTOR', tone: 'amber' },
  { colMin: 18, colMax: 23, deskRow: 3,  labelRow: 4,  title: 'SHIP',     tone: 'green' },
  { colMin: 2,  colMax: 7,  deskRow: 11, labelRow: 12, title: 'TEST',     tone: 'teal' },
  { colMin: 10, colMax: 15, deskRow: 11, labelRow: 12, title: 'REVIEW',   tone: 'pink' },
  { colMin: 18, colMax: 23, deskRow: 11, labelRow: 12, title: 'EXPLORE',  tone: 'violet' },
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

export function DeskLabels({ officeState, containerRef, zoom, panRef }: DeskLabelsProps) {
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

  return (
    <>
      {CLUSTERS.map((c, i) => {
        // Center the label on the middle desk's center column.
        const centerCol = (c.colMin + c.colMax) / 2 + 0.5
        const wx = centerCol * TILE_SIZE
        // Anchor at the TOP of the bottom desk row so the label sits on the desk surface,
        // slightly above the monitor screen so it doesn't cover anything important.
        const wy = c.labelRow * TILE_SIZE
        const screenX = (deviceOffsetX + wx * zoom) / dpr
        const screenY = (deviceOffsetY + wy * zoom) / dpr
        return (
          <div
            key={`cluster-${i}`}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
              zIndex: 30,
            }}
          >
            <span
              style={{
                fontSize: '10px',
                lineHeight: 1,
                padding: '2px 6px',
                background: TONE_BG[c.tone],
                color: '#f4f4ff',
                border: '1px solid rgba(255,255,255,0.25)',
                borderRadius: 0,
                whiteSpace: 'nowrap',
                fontWeight: 700,
                letterSpacing: '0.6px',
                boxShadow: '0 1px 0 rgba(0,0,0,0.4)',
                fontFamily: 'inherit',
              }}
            >
              {c.title}
            </span>
          </div>
        )
      })}
    </>
  )
}

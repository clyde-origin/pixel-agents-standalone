import { useState, useEffect } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import { TILE_SIZE } from '../office/types.js'

interface DeskLabelsProps {
  officeState: OfficeState
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
}

/** A task-type label that sits centered on a paired-desk pod's seam. */
interface ClusterDef {
  /** World col where the label centers (multiplied by TILE_SIZE). For a pod spanning cols
   *  X..X+3 with two 2-wide desks at cols X and X+2, centerCol = X+2 = the seam between them. */
  centerCol: number
  /** Tile row of the bottom desk row in the pod. */
  labelRow: number
  title: string
  tone: 'cool' | 'warm' | 'pink' | 'amber' | 'teal' | 'violet' | 'green'
}

// 1 hero + 3 pods × 2 rows + 2 station rows × 3 = 13 labels. Pods span cols 2-5, 8-11, 14-17 → seams at cols 4, 10, 16.
const CLUSTERS: ClusterDef[] = [
  // Hero desk at top center — col 9 desk → centerCol = col 10
  { centerCol: 10, labelRow: 6,  title: 'MERGE TO MAIN', tone: 'green' },

  // Top home pods (chair row 9, desk rows 10-11) — labelRow = 11.
  { centerCol: 4,  labelRow: 11, title: 'BUILD',    tone: 'cool' },
  { centerCol: 10, labelRow: 11, title: 'REFACTOR', tone: 'amber' },
  { centerCol: 16, labelRow: 11, title: 'SHIP',     tone: 'green' },

  // Station row A (chair row 13, desk rows 14-15) — labelRow = 15.
  { centerCol: 4,  labelRow: 15, title: 'BUILDS & TESTS', tone: 'warm' },
  { centerCol: 10, labelRow: 15, title: 'GIT & PRS',      tone: 'pink' },
  { centerCol: 16, labelRow: 15, title: 'REVIEW & DOCS',  tone: 'amber' },

  // Bottom home pods (chair row 17, desk rows 18-19) — labelRow = 19.
  { centerCol: 4,  labelRow: 19, title: 'TEST',     tone: 'teal' },
  { centerCol: 10, labelRow: 19, title: 'REVIEW',   tone: 'pink' },
  { centerCol: 16, labelRow: 19, title: 'EXPLORE',  tone: 'violet' },

  // Station row B (chair row 21, desk rows 22-23) — labelRow = 23.
  { centerCol: 4,  labelRow: 23, title: 'DEBUG',  tone: 'violet' },
  { centerCol: 10, labelRow: 23, title: 'DOCS',   tone: 'cool' },
  { centerCol: 16, labelRow: 23, title: 'DEPLOY', tone: 'green' },
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
        // Center the label on the paired-desk pod's seam (centerCol = pod.col + 2).
        const wx = c.centerCol * TILE_SIZE
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

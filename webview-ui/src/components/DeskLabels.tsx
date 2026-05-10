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
  /** Override Y translate. Default '-200%' (sits above the desk bottom edge). */
  translateY?: string
  /** Render title on two lines, split by '/'. */
  multiLine?: boolean
  /** Station side and tier — used to gate label visibility on revealedDeskIds.
   *  Omit for the hero label (always visible). */
  side?: 'l' | 'r'
  tier?: number
}

const CLUSTERS: ClusterDef[] = [
  // Hero MERGE TO MAIN — sign sits well south of the chairs (row 7) on the sand path,
  // centered on cols 9-10 (the seam of the shifted layout).
  { centerCol: 10, labelRow: 7, title: 'Merge to/MAIN', tone: 'green', translateY: '0%', multiLine: true },

  // 12 stations: chair row N, desk-top row N+1, desk-bottom/PC row N+2.
  // labelRow = chair_row + 3 = top of the row just below the desk's bottom row,
  // i.e. the world-y of the desk's bottom edge. With translate(-50%, -100%) the
  // label's BOTTOM aligns with that edge, so it never covers the monitor.
  // Left column center = col 4, right column center = col 16.
  { centerCol: 4,  labelRow: 9,  title: 'BUILD',           tone: 'cool',   side: 'l', tier: 0 },
  { centerCol: 16, labelRow: 9,  title: 'REFACTOR',        tone: 'amber',  side: 'r', tier: 0 },
  { centerCol: 4,  labelRow: 12, title: 'BUILDS & TESTS',  tone: 'warm',   side: 'l', tier: 1 },
  { centerCol: 16, labelRow: 12, title: 'GIT & PRS',       tone: 'pink',   side: 'r', tier: 1 },
  { centerCol: 4,  labelRow: 15, title: 'TEST',            tone: 'teal',   side: 'l', tier: 2 },
  { centerCol: 16, labelRow: 15, title: 'SHIP',            tone: 'green',  side: 'r', tier: 2 },
  { centerCol: 4,  labelRow: 18, title: 'REVIEW',          tone: 'pink',   side: 'l', tier: 3 },
  { centerCol: 16, labelRow: 18, title: 'EXPLORE',         tone: 'violet', side: 'r', tier: 3 },
  { centerCol: 4,  labelRow: 21, title: 'DEBUG',           tone: 'violet', side: 'l', tier: 4 },
  { centerCol: 16, labelRow: 21, title: 'DEPLOY',          tone: 'green',  side: 'r', tier: 4 },
  { centerCol: 4,  labelRow: 24, title: 'DOCS',            tone: 'cool',   side: 'l', tier: 5 },
  { centerCol: 16, labelRow: 24, title: 'REVIEW & DOCS',   tone: 'amber',  side: 'r', tier: 5 },
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

  // Hide labels for hidden desks: a station label only appears when at least one of its
  // pod's desks has been revealed. Hero label has no side/tier — always visible.
  const revealed = officeState.revealedDeskIds
  const visibleClusters = CLUSTERS.filter((c) => {
    if (c.side === undefined || c.tier === undefined) return true
    const prefix = `station-${c.side}-${c.tier}-`
    for (const gid of revealed) {
      if (gid.startsWith(prefix)) return true
    }
    return false
  })

  return (
    <>
      {visibleClusters.map((c, i) => {
        // Center the label on the paired-desk pod's seam (centerCol = pod.col + 2).
        const wx = c.centerCol * TILE_SIZE
        // Anchor at the world-y of the desk's bottom edge (labelRow * TILE_SIZE).
        // The transform places the label's BOTTOM at that anchor — label sits
        // as a thin band right above the bottom edge of the desk.
        const wy = c.labelRow * TILE_SIZE
        const screenX = (deviceOffsetX + wx * zoom) / dpr
        const screenY = (deviceOffsetY + wy * zoom) / dpr
        const ty = c.translateY ?? '-200%'
        const lines = c.multiLine ? c.title.split('/') : [c.title]
        return (
          <div
            key={`cluster-${i}`}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY,
              transform: `translate(-50%, ${ty})`,
              pointerEvents: 'none',
              zIndex: 30,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                fontSize: '8px',
                lineHeight: 1.15,
                padding: '1px 5px',
                background: TONE_BG[c.tone],
                color: '#f4f4ff',
                border: 'none',
                borderRadius: 0,
                whiteSpace: 'nowrap',
                fontWeight: 700,
                letterSpacing: '0.6px',
                boxShadow: '0 1px 0 rgba(0,0,0,0.4)',
                fontFamily: 'inherit',
                textAlign: 'center',
              }}
            >
              {lines.map((line, li) => (
                <span key={li} style={{ display: 'block' }}>
                  {line}
                </span>
              ))}
            </span>
          </div>
        )
      })}
    </>
  )
}

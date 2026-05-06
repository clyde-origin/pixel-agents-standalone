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

/** Renders one DeskActivityCard per occupied seat. The static cluster banners
 *  (BUILD/REFACTOR/SHIP/etc.) are no longer rendered — each agent already shows
 *  its project + activity above its desk via DeskActivityCard. */
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

  return (
    <>
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

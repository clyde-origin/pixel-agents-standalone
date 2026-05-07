import { useState, useEffect } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import { TILE_SIZE, CharacterState } from '../office/types.js'

interface HighFiveOverlayProps {
  officeState: OfficeState
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
}

/**
 * Renders a big, bright "HI 5!" banner over any character in the SPAWNING state's
 * high-five phase (spinTimer < 0). Independent of the canvas bubble system so the
 * greeter exchange is unmistakable.
 */
export function HighFiveOverlay({ officeState, containerRef, zoom, panRef }: HighFiveOverlayProps) {
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
  const isDesktop = window.matchMedia('(min-width: 769px)').matches
  const panX = isDesktop ? (canvasW - mapW) / 2 : panRef.current.x
  const panY = isDesktop ? 0 : panRef.current.y
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panX)
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panY)

  const targets: Array<{ x: number; y: number; pulse: number }> = []
  for (const ch of officeState.getCharacters()) {
    // Show banner over: the spawning agent in high-five phase, AND the greeter while a partner exists.
    const isAgentHighfive = ch.state === CharacterState.SPAWNING && ch.spinTimer !== null && ch.spinTimer < 0
    const isGreeterHighfive = ch.isGreeter && ch.bubbleType === 'highfive'
    if (!isAgentHighfive && !isGreeterHighfive) continue
    // Pulse based on character's bubbleTimer (ms remaining), maps to 0..1
    const ms = ch.bubbleTimer
    const pulse = 0.5 + 0.5 * Math.sin((ms / 1000) * Math.PI * 4)
    targets.push({ x: ch.x, y: ch.y, pulse })
  }

  if (targets.length === 0) return null

  return (
    <>
      {targets.map((t, i) => {
        const screenX = (deviceOffsetX + t.x * zoom) / dpr
        const screenY = (deviceOffsetY + (t.y - 28) * zoom) / dpr  // 28px above feet (above head)
        const scale = 1 + 0.15 * t.pulse
        return (
          <div
            key={`hi5-${i}`}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY,
              transform: `translate(-50%, -100%) scale(${scale})`,
              pointerEvents: 'none',
              zIndex: 50,
              fontFamily: 'inherit',
              fontWeight: 900,
              fontSize: 28,
              letterSpacing: '1px',
              color: '#FFE34A',
              textShadow: '0 0 8px rgba(255,180,0,0.9), 0 2px 0 #8a4a00, 0 -1px 0 #fff7c2',
              whiteSpace: 'nowrap',
              filter: `drop-shadow(0 0 6px rgba(255,200,40,${0.5 + 0.5 * t.pulse}))`,
            }}
          >
            ✋ HI 5!
          </div>
        )
      })}
    </>
  )
}

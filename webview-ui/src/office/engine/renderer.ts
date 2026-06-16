import { TileType, TILE_SIZE, CharacterState } from '../types.js'
import type { TileType as TileTypeVal, FurnitureInstance, Character, SpriteData, Seat, FloorColor, ToolEffect, PortalRing } from '../types.js'
import { getCachedSprite, getOutlineSprite } from '../sprites/spriteCache.js'
import { getCharacterSprites, BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE, BUBBLE_HIGHFIVE_SPRITE } from '../sprites/spriteData.js'
import { getCharacterSprite } from './characters.js'
import { renderMatrixEffect } from './matrixEffect.js'
import { getColorizedFloorSprite, hasFloorSprites, WALL_COLOR } from '../floorTiles.js'
import { hasWallSprites, getWallInstances, wallColorToHex } from '../wallTiles.js'
import {
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_Z_SORT_OFFSET,
  OUTLINE_Z_SORT_OFFSET,
  SELECTED_OUTLINE_ALPHA,
  HOVERED_OUTLINE_ALPHA,
  GHOST_PREVIEW_SPRITE_ALPHA,
  GHOST_PREVIEW_TINT_ALPHA,
  SELECTION_DASH_PATTERN,
  BUTTON_MIN_RADIUS,
  BUTTON_RADIUS_ZOOM_FACTOR,
  BUTTON_ICON_SIZE_FACTOR,
  BUTTON_LINE_WIDTH_MIN,
  BUTTON_LINE_WIDTH_ZOOM_FACTOR,
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  FALLBACK_FLOOR_COLOR,
  SEAT_OWN_COLOR,
  SEAT_AVAILABLE_COLOR,
  SEAT_BUSY_COLOR,
  GRID_LINE_COLOR,
  VOID_TILE_OUTLINE_COLOR,
  VOID_TILE_DASH_PATTERN,
  GHOST_BORDER_HOVER_FILL,
  GHOST_BORDER_HOVER_STROKE,
  GHOST_BORDER_STROKE,
  GHOST_VALID_TINT,
  GHOST_INVALID_TINT,
  SELECTION_HIGHLIGHT_COLOR,
  DELETE_BUTTON_BG,
  ROTATE_BUTTON_BG,
  EFFECT_RISE_PX_PER_SEC,
} from '../../constants.js'

// ── Render functions ────────────────────────────────────────────

// Reusable offscreen buffer for the floor/wall layer. Sized to the tile map in
// native tile pixels (TILE_SIZE per tile) and only resized when dimensions
// change, so we don't churn canvases every frame.
let tileBuffer: HTMLCanvasElement | null = null
function getTileBuffer(w: number, h: number): HTMLCanvasElement {
  if (!tileBuffer) tileBuffer = document.createElement('canvas')
  if (tileBuffer.width !== w || tileBuffer.height !== h) {
    tileBuffer.width = w
    tileBuffer.height = h
  }
  return tileBuffer
}

export function renderTileGrid(
  ctx: CanvasRenderingContext2D,
  tileMap: TileTypeVal[][],
  offsetX: number,
  offsetY: number,
  zoom: number,
  tileColors?: Array<FloorColor | null>,
  cols?: number,
): void {
  const useSpriteFloors = hasFloorSprites()
  const tmRows = tileMap.length
  const tmCols = tmRows > 0 ? tileMap[0].length : 0
  if (tmRows === 0 || tmCols === 0) return
  const layoutCols = cols ?? tmCols

  // Render the floor/wall layer to an offscreen buffer at native tile
  // resolution — each tile exactly TILE_SIZE px, on integer boundaries — then
  // blit the whole buffer to the screen with a single scaled drawImage below.
  // Because the buffer is one continuous, gap-free image, scaling it can never
  // open the hairline seams that per-tile drawing leaves at fractional zoom.
  const bufW = tmCols * TILE_SIZE
  const bufH = tmRows * TILE_SIZE
  const buf = getTileBuffer(bufW, bufH)
  const bctx = buf.getContext('2d')!
  bctx.imageSmoothingEnabled = false
  bctx.clearRect(0, 0, bufW, bufH)

  for (let r = 0; r < tmRows; r++) {
    const by = r * TILE_SIZE
    for (let c = 0; c < tmCols; c++) {
      const tile = tileMap[r][c]

      // Skip VOID tiles entirely (transparent)
      if (tile === TileType.VOID) continue

      const bx = c * TILE_SIZE

      if (tile === TileType.WALL || !useSpriteFloors) {
        // Wall tiles or fallback: solid color
        if (tile === TileType.WALL) {
          const colorIdx = r * layoutCols + c
          const wallColor = tileColors?.[colorIdx]
          bctx.fillStyle = wallColor ? wallColorToHex(wallColor) : WALL_COLOR
        } else {
          bctx.fillStyle = FALLBACK_FLOOR_COLOR
        }
        bctx.fillRect(bx, by, TILE_SIZE, TILE_SIZE)
        continue
      }

      // Floor tile: get colorized sprite, rasterized at 1x (exact 16×16).
      const colorIdx = r * layoutCols + c
      const color = tileColors?.[colorIdx] ?? { h: 0, s: 0, b: 0, c: 0 }
      const sprite = getColorizedFloorSprite(tile, color)
      const cached = getCachedSprite(sprite, 1)
      bctx.drawImage(cached, bx, by)
    }
  }

  // Single scaled blit of the gap-free buffer onto the screen. The destination
  // origin is already integer-snapped by the caller; one nearest-neighbor scale
  // fills the whole map area with no internal seams.
  const s = TILE_SIZE * zoom
  ctx.drawImage(buf, 0, 0, bufW, bufH, offsetX, offsetY, tmCols * s, tmRows * s)
}

interface ZDrawable {
  zY: number
  draw: (ctx: CanvasRenderingContext2D) => void
}

/** Permanent "danced" look: bare-skin chest patch + loincloth band, painted over the
 *  lower torso of an already-drawn character sprite. Coordinates are in source-sprite
 *  pixel rows for a 16×32 character cell, derived empirically from char_0.png:
 *    head     rows 3-17
 *    torso    rows 18-24  (typing pose shifts ↓3 → rows 21-26)
 *    belt     row 25                                  → row 27
 *    pants    rows 26-28                              → rows 28-30
 *  `originX/originY` are the sprite's top-left in device px. */
function drawLoinclothOverlay(
  ctx: CanvasRenderingContext2D,
  originX: number, originY: number,
  zoom: number,
  isTyping: boolean,
): void {
  const yShift = isTyping ? 3 : 0
  const cell = zoom
  ctx.save()
  // Bare chest (skin) covers the shirt area (torso rows).
  ctx.fillStyle = '#E9A384'
  ctx.fillRect(originX + 3 * cell, originY + (18 + yShift) * cell, 10 * cell, 6 * cell)
  // Subtle shadow band at chest bottom for a little form.
  ctx.fillStyle = '#C5896E'
  ctx.fillRect(originX + 3 * cell, originY + (23 + yShift) * cell, 10 * cell, cell)
  // Nipple dots — tiny, 1 cell each.
  ctx.fillStyle = '#7A4030'
  ctx.fillRect(originX + 5 * cell, originY + (21 + yShift) * cell, cell, cell)
  ctx.fillRect(originX + 10 * cell, originY + (21 + yShift) * cell, cell, cell)
  // Loincloth — leather band over the pants/hip area.
  ctx.fillStyle = '#6B4A2B'
  ctx.fillRect(originX + 3 * cell, originY + (25 + yShift) * cell, 10 * cell, 3 * cell)
  // Knotted front flap dangling lower.
  ctx.fillStyle = '#8A6238'
  ctx.fillRect(originX + 6 * cell, originY + (28 + yShift) * cell, 4 * cell, 2 * cell)
  // Belt highlight (1px lighter trim along top of band).
  ctx.fillStyle = '#A07A50'
  ctx.fillRect(originX + 3 * cell, originY + (25 + yShift) * cell, 10 * cell, cell)
  ctx.restore()
}

export function renderScene(
  ctx: CanvasRenderingContext2D,
  furniture: FurnitureInstance[],
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  selectedAgentId: number | null,
  hoveredAgentId: number | null,
): void {
  const drawables: ZDrawable[] = []

  // Furniture
  for (const f of furniture) {
    const cached = getCachedSprite(f.sprite, zoom)
    const fx = offsetX + f.x * zoom
    const fy = offsetY + f.y * zoom
    const alpha = f.animAlpha
    const scale = f.animScale
    const animated = (alpha !== undefined && alpha < 1) || (scale !== undefined && scale !== 1)
    drawables.push({
      zY: f.zY,
      draw: (c) => {
        if (!animated) {
          c.drawImage(cached, fx, fy)
          return
        }
        c.save()
        if (alpha !== undefined) c.globalAlpha = alpha
        if (scale !== undefined && scale !== 1) {
          // Scale around the bottom-center of the sprite so the desk pops up from its base.
          const cx = fx + cached.width / 2
          const cy = fy + cached.height
          c.translate(cx, cy)
          c.scale(scale, scale)
          c.translate(-cx, -cy)
        }
        c.drawImage(cached, fx, fy)
        c.restore()
      },
    })
  }

  // Characters
  for (const ch of characters) {
    const sprites = getCharacterSprites(ch.palette, ch.hueShift)
    const spriteData = getCharacterSprite(ch, sprites)
    const cached = getCachedSprite(spriteData, zoom)
    // Sitting offset: shift character down when seated so they visually sit in the chair.
    // Suppress while stretching so the stand-up gesture doesn't draw mid-air.
    const sittingOffset = (ch.state === CharacterState.TYPE && !ch.stretching) ? CHARACTER_SITTING_OFFSET_PX : 0
    // Anchor at bottom-center of character — round to integer device pixels
    const drawX = Math.round(offsetX + ch.x * zoom - cached.width / 2)
    const drawY = Math.round(offsetY + (ch.y + sittingOffset) * zoom - cached.height)

    // Sort characters by bottom of their tile (not center) so they render
    // in front of same-row furniture (e.g. chairs) but behind furniture
    // at lower rows (e.g. desks, bookshelves that occlude from below).
    const charZY = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET

    // Matrix spawn/despawn effect — skip outline, use per-pixel rendering
    if (ch.matrixEffect) {
      const mDrawX = drawX
      const mDrawY = drawY
      const mSpriteData = spriteData
      const mCh = ch
      drawables.push({
        zY: charZY,
        draw: (c) => {
          renderMatrixEffect(c, mCh, mSpriteData, mDrawX, mDrawY, zoom)
        },
      })
      continue
    }

    // White outline: full opacity for selected, 50% for hover
    const isSelected = selectedAgentId !== null && ch.id === selectedAgentId
    const isHovered = hoveredAgentId !== null && ch.id === hoveredAgentId
    if (isSelected || isHovered) {
      const outlineAlpha = isSelected ? SELECTED_OUTLINE_ALPHA : HOVERED_OUTLINE_ALPHA
      const outlineData = getOutlineSprite(spriteData)
      const outlineCached = getCachedSprite(outlineData, zoom)
      const olDrawX = drawX - zoom  // 1 sprite-pixel offset, scaled
      const olDrawY = drawY - zoom  // outline follows sitting offset via drawY
      drawables.push({
        zY: charZY - OUTLINE_Z_SORT_OFFSET, // sort just before character
        draw: (c) => {
          c.save()
          c.globalAlpha = outlineAlpha
          c.drawImage(outlineCached, olDrawX, olDrawY)
          c.restore()
        },
      })
    }

    // Capture danced flag + typing state for the overlay closure.
    const chDanced = ch.danced === true
    const chIsWizard = ch.isWizard === true
    const chIsTyping = ch.state === CharacterState.TYPE && !ch.stretching
    const chDrawX = drawX
    const chDrawY = drawY

    drawables.push({
      zY: charZY,
      draw: (c) => {
        c.drawImage(cached, chDrawX, chDrawY)
        if (chDanced) {
          drawLoinclothOverlay(c, chDrawX, chDrawY, zoom, chIsTyping)
        }
        if (chIsWizard) {
          // Head anchor: top-center of the sprite cell, nudged down onto the head.
          drawWizardOverlay(c, chDrawX + 8 * zoom, chDrawY + 8 * zoom, zoom)
        }
      },
    })
  }

  // Sort by Y (lower = in front = drawn later)
  drawables.sort((a, b) => a.zY - b.zY)

  for (const d of drawables) {
    d.draw(ctx)
  }
}

// ── Seat indicators ─────────────────────────────────────────────

export function renderSeatIndicators(
  ctx: CanvasRenderingContext2D,
  seats: Map<string, Seat>,
  characters: Map<number, Character>,
  selectedAgentId: number | null,
  hoveredTile: { col: number; row: number } | null,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (selectedAgentId === null || !hoveredTile) return
  const selectedChar = characters.get(selectedAgentId)
  if (!selectedChar) return

  // Only show indicator for the hovered seat tile
  for (const [uid, seat] of seats) {
    if (seat.seatCol !== hoveredTile.col || seat.seatRow !== hoveredTile.row) continue

    const s = TILE_SIZE * zoom
    const x = offsetX + seat.seatCol * s
    const y = offsetY + seat.seatRow * s

    if (selectedChar.seatId === uid) {
      // Selected agent's own seat — blue
      ctx.fillStyle = SEAT_OWN_COLOR
    } else if (!seat.assigned) {
      // Available seat — green
      ctx.fillStyle = SEAT_AVAILABLE_COLOR
    } else {
      // Busy (assigned to another agent) — red
      ctx.fillStyle = SEAT_BUSY_COLOR
    }
    ctx.fillRect(x, y, s, s)
    break
  }
}

// ── Edit mode overlays ──────────────────────────────────────────

export function renderGridOverlay(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  cols: number,
  rows: number,
  tileMap?: TileTypeVal[][],
): void {
  const s = TILE_SIZE * zoom
  ctx.strokeStyle = GRID_LINE_COLOR
  ctx.lineWidth = 1
  ctx.beginPath()
  // Vertical lines — offset by 0.5 for crisp 1px lines
  for (let c = 0; c <= cols; c++) {
    const x = offsetX + c * s + 0.5
    ctx.moveTo(x, offsetY)
    ctx.lineTo(x, offsetY + rows * s)
  }
  // Horizontal lines
  for (let r = 0; r <= rows; r++) {
    const y = offsetY + r * s + 0.5
    ctx.moveTo(offsetX, y)
    ctx.lineTo(offsetX + cols * s, y)
  }
  ctx.stroke()

  // Draw faint dashed outlines on VOID tiles
  if (tileMap) {
    ctx.save()
    ctx.strokeStyle = VOID_TILE_OUTLINE_COLOR
    ctx.lineWidth = 1
    ctx.setLineDash(VOID_TILE_DASH_PATTERN)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (tileMap[r]?.[c] === TileType.VOID) {
          ctx.strokeRect(offsetX + c * s + 0.5, offsetY + r * s + 0.5, s - 1, s - 1)
        }
      }
    }
    ctx.restore()
  }
}

/** Draw faint expansion placeholders 1 tile outside grid bounds (ghost border). */
export function renderGhostBorder(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  cols: number,
  rows: number,
  ghostHoverCol: number,
  ghostHoverRow: number,
): void {
  const s = TILE_SIZE * zoom
  ctx.save()

  // Collect ghost border tiles: one ring around the grid
  const ghostTiles: Array<{ c: number; r: number }> = []
  // Top and bottom rows
  for (let c = -1; c <= cols; c++) {
    ghostTiles.push({ c, r: -1 })
    ghostTiles.push({ c, r: rows })
  }
  // Left and right columns (excluding corners already added)
  for (let r = 0; r < rows; r++) {
    ghostTiles.push({ c: -1, r })
    ghostTiles.push({ c: cols, r })
  }

  for (const { c, r } of ghostTiles) {
    const x = offsetX + c * s
    const y = offsetY + r * s
    const isHovered = c === ghostHoverCol && r === ghostHoverRow
    if (isHovered) {
      ctx.fillStyle = GHOST_BORDER_HOVER_FILL
      ctx.fillRect(x, y, s, s)
    }
    ctx.strokeStyle = isHovered ? GHOST_BORDER_HOVER_STROKE : GHOST_BORDER_STROKE
    ctx.lineWidth = 1
    ctx.setLineDash(VOID_TILE_DASH_PATTERN)
    ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1)
  }

  ctx.restore()
}

export function renderGhostPreview(
  ctx: CanvasRenderingContext2D,
  sprite: SpriteData,
  col: number,
  row: number,
  valid: boolean,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const cached = getCachedSprite(sprite, zoom)
  const x = offsetX + col * TILE_SIZE * zoom
  const y = offsetY + row * TILE_SIZE * zoom
  ctx.save()
  ctx.globalAlpha = GHOST_PREVIEW_SPRITE_ALPHA
  ctx.drawImage(cached, x, y)
  // Tint overlay
  ctx.globalAlpha = GHOST_PREVIEW_TINT_ALPHA
  ctx.fillStyle = valid ? GHOST_VALID_TINT : GHOST_INVALID_TINT
  ctx.fillRect(x, y, cached.width, cached.height)
  ctx.restore()
}

export function renderSelectionHighlight(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  w: number,
  h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const s = TILE_SIZE * zoom
  const x = offsetX + col * s
  const y = offsetY + row * s
  ctx.save()
  ctx.strokeStyle = SELECTION_HIGHLIGHT_COLOR
  ctx.lineWidth = 2
  ctx.setLineDash(SELECTION_DASH_PATTERN)
  ctx.strokeRect(x + 1, y + 1, w * s - 2, h * s - 2)
  ctx.restore()
}

export function renderDeleteButton(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  w: number,
  _h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): DeleteButtonBounds {
  const s = TILE_SIZE * zoom
  // Position at top-right corner of selected furniture
  const cx = offsetX + (col + w) * s + 1
  const cy = offsetY + row * s - 1
  const radius = Math.max(BUTTON_MIN_RADIUS, zoom * BUTTON_RADIUS_ZOOM_FACTOR)

  // Circle background
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = DELETE_BUTTON_BG
  ctx.fill()

  // X mark
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = Math.max(BUTTON_LINE_WIDTH_MIN, zoom * BUTTON_LINE_WIDTH_ZOOM_FACTOR)
  ctx.lineCap = 'round'
  const xSize = radius * BUTTON_ICON_SIZE_FACTOR
  ctx.beginPath()
  ctx.moveTo(cx - xSize, cy - xSize)
  ctx.lineTo(cx + xSize, cy + xSize)
  ctx.moveTo(cx + xSize, cy - xSize)
  ctx.lineTo(cx - xSize, cy + xSize)
  ctx.stroke()
  ctx.restore()

  return { cx, cy, radius }
}

export function renderRotateButton(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  _w: number,
  _h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): RotateButtonBounds {
  const s = TILE_SIZE * zoom
  // Position to the left of the delete button (which is at top-right corner)
  const radius = Math.max(BUTTON_MIN_RADIUS, zoom * BUTTON_RADIUS_ZOOM_FACTOR)
  const cx = offsetX + col * s - 1
  const cy = offsetY + row * s - 1

  // Circle background
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = ROTATE_BUTTON_BG
  ctx.fill()

  // Circular arrow icon
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = Math.max(BUTTON_LINE_WIDTH_MIN, zoom * BUTTON_LINE_WIDTH_ZOOM_FACTOR)
  ctx.lineCap = 'round'
  const arcR = radius * BUTTON_ICON_SIZE_FACTOR
  ctx.beginPath()
  // Draw a 270-degree arc
  ctx.arc(cx, cy, arcR, -Math.PI * 0.8, Math.PI * 0.7)
  ctx.stroke()
  // Draw arrowhead at the end of the arc
  const endAngle = Math.PI * 0.7
  const endX = cx + arcR * Math.cos(endAngle)
  const endY = cy + arcR * Math.sin(endAngle)
  const arrowSize = radius * 0.35
  ctx.beginPath()
  ctx.moveTo(endX + arrowSize * 0.6, endY - arrowSize * 0.3)
  ctx.lineTo(endX, endY)
  ctx.lineTo(endX + arrowSize * 0.7, endY + arrowSize * 0.5)
  ctx.stroke()
  ctx.restore()

  return { cx, cy, radius }
}

// ── Speech bubbles ──────────────────────────────────────────────

export function renderBubbles(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const ch of characters) {
    if (!ch.bubbleType) continue

    const sprite = ch.bubbleType === 'permission'
      ? BUBBLE_PERMISSION_SPRITE
      : ch.bubbleType === 'highfive'
        ? BUBBLE_HIGHFIVE_SPRITE
        : BUBBLE_WAITING_SPRITE

    // Compute opacity: permission/highfive = full, waiting = fade in last 0.5s
    let alpha = 1.0
    if (ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC) {
      alpha = ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
    }

    const cached = getCachedSprite(sprite, zoom)
    // Position: centered above the character's head
    // Character is anchored bottom-center at (ch.x, ch.y), sprite is 16x24
    // Place bubble above head with a small gap; follow sitting offset
    const sittingOff = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0
    const bubbleX = Math.round(offsetX + ch.x * zoom - cached.width / 2)
    const bubbleY = Math.round(offsetY + (ch.y + sittingOff - BUBBLE_VERTICAL_OFFSET_PX) * zoom - cached.height - 1 * zoom)

    ctx.save()
    if (alpha < 1.0) ctx.globalAlpha = alpha
    ctx.drawImage(cached, bubbleX, bubbleY)
    ctx.restore()
  }
}

// ── Spawn pad ───────────────────────────────────────────────────

const SPAWN_PAD_TILE_COL = 9.5
const SPAWN_PAD_TILE_ROW = 33
const SPAWN_PAD_RADIUS_TILES = 1.6  // pad covers ~3.2 tiles wide

function renderSpawnPad(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
) {
  const cx = offsetX + SPAWN_PAD_TILE_COL * TILE_SIZE * zoom
  const cy = offsetY + SPAWN_PAD_TILE_ROW * TILE_SIZE * zoom
  const baseR = SPAWN_PAD_RADIUS_TILES * TILE_SIZE * zoom
  // Slow pulse: 0.85 → 1.15 over ~2s
  const pulse = 1 + 0.15 * Math.sin((timeMs / 1000) * Math.PI)
  const r = baseR * pulse

  ctx.save()
  // Outer glow (soft cyan/violet halo)
  const grad = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r)
  grad.addColorStop(0,    'rgba(180, 230, 255, 0.85)')
  grad.addColorStop(0.35, 'rgba(140, 180, 255, 0.45)')
  grad.addColorStop(0.7,  'rgba(120, 110, 220, 0.20)')
  grad.addColorStop(1,    'rgba(100,  80, 200, 0)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()

  // Inner ring — sharp circle marking the pad's edge
  ctx.strokeStyle = 'rgba(200, 235, 255, 0.7)'
  ctx.lineWidth = Math.max(1, zoom * 0.8)
  ctx.beginPath()
  ctx.arc(cx, cy, baseR * 0.55, 0, Math.PI * 2)
  ctx.stroke()

  // Center hot-spot
  const inner = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseR * 0.35)
  inner.addColorStop(0, 'rgba(255, 255, 255, 0.9)')
  inner.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = inner
  ctx.beginPath()
  ctx.arc(cx, cy, baseR * 0.35, 0, Math.PI * 2)
  ctx.fill()

  ctx.restore()
}

// ── Chess thinking indicator ─────────────────────────────────────

/** Floating "thinking dots" + occasional chess-piece silhouette above chess players' heads
 *  to suggest "they're playing/contemplating a move". Each player has an offset phase so
 *  the dots don't sync. Drawn after the scene so they always sit on top. */
export function renderChessActivity(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
): void {
  let drewAny = false
  ctx.save()
  for (const ch of characters) {
    if (ch.tripMode !== 'chess') continue
    if (!ch.tripTile) continue
    if (ch.tileCol !== ch.tripTile.col || ch.tileRow !== ch.tripTile.row) continue
    if (ch.state !== CharacterState.IDLE) continue

    drewAny = true
    // 4-second cycle: 0-1.5s dots fade in (1→2→3 dots); 1.5-2.5s hold; 2.5-3.5s fade out;
    // 3.5-4s pause. id-based phase offset so the two players are out of sync.
    const cycle = ((timeMs * 0.001) + ch.id * 0.83) % 4
    let alpha = 0
    let dotCount = 0
    if (cycle < 1.5) {
      alpha = 1
      dotCount = Math.min(3, Math.floor(cycle / 0.5) + 1)
    } else if (cycle < 2.5) {
      alpha = 1
      dotCount = 3
    } else if (cycle < 3.5) {
      alpha = 1 - (cycle - 2.5)
      dotCount = 3
    }
    if (dotCount === 0 || alpha <= 0) continue

    const headWorldX = ch.x + (ch.dir === 1 ? -2 : ch.dir === 2 ? 2 : 0) // bias to facing side
    const headWorldY = ch.y - 22  // a few pixels above the head
    const px = offsetX + headWorldX * zoom
    const py = offsetY + headWorldY * zoom
    const dotSize = Math.max(1, Math.round(zoom * 1.4))
    const gap = Math.max(2, Math.round(zoom * 1.4))
    const totalW = dotCount * dotSize + (dotCount - 1) * gap
    // Tiny rounded background to make the dots readable on any backdrop.
    ctx.globalAlpha = alpha * 0.6
    ctx.fillStyle = '#0c0d12'
    ctx.fillRect(
      px - totalW / 2 - 2 * zoom,
      py - dotSize - 1,
      totalW + 4 * zoom,
      dotSize + 3,
    )
    ctx.globalAlpha = alpha
    ctx.fillStyle = '#f4f4ff'
    for (let i = 0; i < dotCount; i++) {
      ctx.fillRect(
        px - totalW / 2 + i * (dotSize + gap),
        py - dotSize,
        dotSize,
        dotSize,
      )
    }
  }
  if (drewAny) ctx.restore()
  else ctx.restore()
}

// ── Swimming pool ────────────────────────────────────────────────

/** Pool footprint — must match OfficeState.POOL_RECT. Bottom-right of the lounge. */
const POOL_RECT = { col0: 12, row0: 33, col1: 17, row1: 34 } as const

/** Foreground water strip drawn AFTER characters so swimmers' lower halves disappear behind
 *  the water surface, giving a "submerged" look. Covers only the slot row (the south row of
 *  the pool, where swimmers actually stand). */
export function renderPoolForeground(
  ctx: CanvasRenderingContext2D,
  rect: { col0: number; row0: number; col1: number; row1: number },
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
): void {
  const x = offsetX + rect.col0 * TILE_SIZE * zoom
  // Strip covers the bottom row of the pool (swim-slot row), starting partway down so the
  // swimmer's torso + head stay above water.
  const stripTop = offsetY + (rect.row1 * TILE_SIZE - 5) * zoom
  const w = (rect.col1 - rect.col0 + 1) * TILE_SIZE * zoom
  const h = (TILE_SIZE + 5) * zoom
  ctx.save()
  // Slightly translucent water over the swimmer's lower half.
  const grad = ctx.createLinearGradient(x, stripTop, x, stripTop + h)
  grad.addColorStop(0, 'rgba(74, 163, 221, 0.55)')
  grad.addColorStop(0.4, 'rgba(45, 138, 207, 0.85)')
  grad.addColorStop(1, 'rgba(30, 111, 180, 1)')
  ctx.fillStyle = grad
  ctx.fillRect(x, stripTop, w, h)

  // Bright surface line + tiny ripples at the waterline.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
  ctx.lineWidth = Math.max(1, zoom * 0.6)
  ctx.beginPath()
  const segs = 24
  for (let i = 0; i <= segs; i++) {
    const sx = x + (w * i) / segs
    const sy = stripTop + Math.sin((i / segs) * Math.PI * 4 + timeMs * 0.003) * (zoom * 0.5)
    if (i === 0) ctx.moveTo(sx, sy)
    else ctx.lineTo(sx, sy)
  }
  ctx.stroke()

  // Soft ripple highlights along the strip.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'
  for (let i = 0; i < 5; i++) {
    const px = x + (((i * 137) + Math.floor(timeMs * 0.04)) % 100) / 100 * w
    const py = stripTop + zoom * 1.5
    ctx.fillRect(px, py, zoom * 2, Math.max(1, zoom * 0.4))
  }
  ctx.restore()
}

/** Draw the pool's water as a stable blue rectangle with animated wave highlights and a
 *  bright sparkle on top. Tile coordinates passed in are inclusive (col0..col1, row0..row1). */
export function renderPool(
  ctx: CanvasRenderingContext2D,
  rect: { col0: number; row0: number; col1: number; row1: number },
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
): void {
  const x = offsetX + rect.col0 * TILE_SIZE * zoom
  const y = offsetY + rect.row0 * TILE_SIZE * zoom
  const w = (rect.col1 - rect.col0 + 1) * TILE_SIZE * zoom
  const h = (rect.row1 - rect.row0 + 1) * TILE_SIZE * zoom
  ctx.save()
  // Water gradient — darker at top, lighter at bottom.
  const grad = ctx.createLinearGradient(x, y, x, y + h)
  grad.addColorStop(0, '#1e6fb4')
  grad.addColorStop(0.5, '#2d8acf')
  grad.addColorStop(1, '#4aa3dd')
  ctx.fillStyle = grad
  ctx.fillRect(x, y, w, h)
  // Pool tile edge — thin dark border around the water.
  ctx.strokeStyle = 'rgba(20, 50, 80, 0.85)'
  ctx.lineWidth = Math.max(1, zoom * 0.6)
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)

  // Animated wave highlights — horizontal bands that scroll/fade.
  const waveCount = 6
  for (let i = 0; i < waveCount; i++) {
    const phase = (timeMs * 0.0006 + i * 0.31) % 1
    const wy = y + phase * h
    const alpha = 0.15 + 0.15 * Math.sin(timeMs * 0.002 + i)
    const len = (0.25 + 0.6 * ((i * 73) % 100) / 100) * w
    const sx = x + (((i * 37) % 100) / 100) * (w - len)
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`
    ctx.fillRect(sx, wy, len, Math.max(1, zoom * 0.6))
  }

  // Subtle sparkle dots
  for (let i = 0; i < 8; i++) {
    const sx = x + ((i * 89 + Math.floor(timeMs * 0.05)) % 100) / 100 * w
    const sy = y + ((i * 41 + Math.floor(timeMs * 0.07)) % 100) / 100 * h
    const a = 0.2 + 0.5 * Math.abs(Math.sin(timeMs * 0.004 + i * 1.7))
    ctx.fillStyle = `rgba(255, 255, 255, ${a})`
    ctx.fillRect(sx, sy, Math.max(1, zoom * 0.6), Math.max(1, zoom * 0.6))
  }
  ctx.restore()
}

// ── Portal rings (desk reveal/hide animation) ────────────────────

/** Glowing circles drawn on the floor where a station desk is appearing or disappearing.
 *  Layered above the floor but below furniture so the desk visibly emerges from the ring. */
export function renderPortalRings(
  ctx: CanvasRenderingContext2D,
  rings: PortalRing[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
): void {
  if (rings.length === 0) return
  ctx.save()
  for (const r of rings) {
    if (r.alpha <= 0) continue
    const px = offsetX + r.cx * zoom
    const py = offsetY + r.cy * zoom
    const outer = r.radius * zoom
    const inner = Math.max(1, outer - 3 * zoom)
    // Outer halo — soft cyan/violet gradient.
    const grad = ctx.createRadialGradient(px, py, 0, px, py, outer)
    const hue = (timeMs * 0.2) % 360
    grad.addColorStop(0, `hsla(${hue}, 90%, 70%, ${r.alpha * 0.35})`)
    grad.addColorStop(0.6, `hsla(${(hue + 40) % 360}, 90%, 60%, ${r.alpha * 0.55})`)
    grad.addColorStop(1, `hsla(${(hue + 80) % 360}, 90%, 55%, 0)`)
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(px, py, outer, 0, Math.PI * 2)
    ctx.fill()
    // Bright ring edge.
    ctx.strokeStyle = `hsla(${hue}, 100%, 80%, ${r.alpha})`
    ctx.lineWidth = Math.max(1, zoom * 0.8)
    ctx.beginPath()
    ctx.arc(px, py, inner, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

// ── Merge-to-Main beams ─────────────────────────────────────────

/** Hero MERGE TO MAIN PCs occupy cols 8-11 row 4 (south edge of the desks). */
const HERO_PC_COLS = new Set<number>([8, 9, 10, 11])
const HERO_PC_ROWS = new Set<number>([4])

/** Vertical pillars of light shooting from each active hero PC up out of the office.
 *  Drawn over the top of everything (after the scene + bubbles) so the beam reads as
 *  a celestial uplink. Hue-cycles per agent so the four pillars feel distinct. */
export function renderMergeBeams(
  ctx: CanvasRenderingContext2D,
  activePCTiles: Array<{ col: number; row: number; agentId: number }>,
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
): void {
  const heroPCs = activePCTiles.filter((t) => HERO_PC_COLS.has(t.col) && HERO_PC_ROWS.has(t.row))
  if (heroPCs.length === 0) return
  ctx.save()
  for (const pc of heroPCs) {
    const seed = pc.agentId * 73
    const hue = (seed + timeMs * 0.05) % 360
    const cx = offsetX + (pc.col * TILE_SIZE + TILE_SIZE / 2) * zoom
    // Beam base — the top of the monitor screen (matches the lift used by renderActivePCScreens).
    const baseY = offsetY + (pc.row * TILE_SIZE - 4) * zoom
    // Beam crown — well above the canvas so the pillar visibly leaves the office.
    const topY = -80 * zoom
    const beamW = 4 * zoom
    const haloW = beamW * 4

    // Outer halo — soft falloff sideways, vertical fade upward.
    const halo = ctx.createLinearGradient(cx, baseY, cx, topY)
    halo.addColorStop(0, `hsla(${hue}, 95%, 70%, 0.55)`)
    halo.addColorStop(0.4, `hsla(${(hue + 20) % 360}, 95%, 75%, 0.35)`)
    halo.addColorStop(1, `hsla(${(hue + 60) % 360}, 95%, 80%, 0)`)
    ctx.fillStyle = halo
    ctx.fillRect(cx - haloW / 2, topY, haloW, baseY - topY)

    // Bright core column.
    const core = ctx.createLinearGradient(cx, baseY, cx, topY)
    core.addColorStop(0, `hsla(${hue}, 100%, 95%, 1)`)
    core.addColorStop(0.7, `hsla(${(hue + 30) % 360}, 100%, 90%, 0.8)`)
    core.addColorStop(1, `hsla(${(hue + 60) % 360}, 100%, 90%, 0)`)
    ctx.fillStyle = core
    ctx.fillRect(cx - beamW / 2, topY, beamW, baseY - topY)

    // Swirling pixel-clusters flying up the beam. Each group is a small chunky shape
    // (2-5 hand-placed offsets) that spirals around the beam axis with its own speed,
    // amplitude, hue offset, and shape. Deterministic per (agent, group index).
    const len = baseY - topY
    const SHAPES: Array<Array<[number, number]>> = [
      [[0, 0], [1, 0], [0, 1], [1, 1]],                           // 2×2 block
      [[0, 0], [1, 0], [2, 0], [1, 1]],                           // T
      [[0, 0], [1, 0], [1, 1], [2, 1]],                           // S
      [[0, 0], [0, 1], [0, 2], [1, 1]],                           // ⊢
      [[0, 0], [1, 0], [2, 0]],                                   // ───
      [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],                   // +
      [[0, 0], [1, 0], [1, 1]],                                   // tiny L
    ]
    const NUM_GROUPS = 14
    for (let i = 0; i < NUM_GROUPS; i++) {
      const gs = seed + i * 137                                    // group seed
      const lifeSec = 1.6 + ((gs * 31) % 100) / 100 * 1.8          // 1.6 – 3.4 s rise
      const phaseOffset = ((gs * 17) % 1000) / 1000
      const t = ((timeMs / 1000 / lifeSec) + phaseOffset) % 1      // 0 = base, 1 = top
      // Y rises linearly, accelerating slightly so groups thin out as they ascend.
      const yProgress = t * t * 0.4 + t * 0.6
      const y = baseY - len * yProgress
      // Swirl: sine in x with amplitude growing as the group rises.
      const swirlAmp = (3 + (gs % 7)) * zoom * (0.5 + yProgress * 1.5)
      const swirlFreq = 2 + ((gs >> 3) % 4)
      const swirl = Math.sin(t * Math.PI * swirlFreq + gs * 0.7)
      const x = cx + swirl * swirlAmp
      // Fade-in / fade-out at the ends so groups don't pop.
      const alpha = t < 0.08 ? t / 0.08 : t > 0.85 ? (1 - t) / 0.15 : 1
      if (alpha <= 0) continue
      const shape = SHAPES[(gs >>> 5) % SHAPES.length]
      const hueOff = ((gs * 19) % 80) - 40                         // ±40°
      const px = Math.round(x)
      const py = Math.round(y)
      ctx.fillStyle = `hsla(${(hue + hueOff + 360) % 360}, 100%, 92%, ${alpha})`
      for (const [dx, dy] of shape) {
        ctx.fillRect(px + dx * zoom, py + dy * zoom, zoom, zoom)
      }
    }

    // Pulsating bright burst at the base of the beam.
    const pulse = 0.6 + 0.4 * Math.abs(Math.sin(timeMs * 0.005 + seed))
    const burstR = haloW * 0.6 * pulse
    const burst = ctx.createRadialGradient(cx, baseY, 0, cx, baseY, burstR)
    burst.addColorStop(0, `hsla(${hue}, 100%, 90%, ${0.7 * pulse})`)
    burst.addColorStop(1, `hsla(${hue}, 100%, 90%, 0)`)
    ctx.fillStyle = burst
    ctx.beginPath()
    ctx.arc(cx, baseY, burstR, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

// ── Sleeping dragon ─────────────────────────────────────────────

/** Top-right anchor for the dragon (col, row of the bounding box top-left). */
const DRAGON_ANCHOR = { col: 13, row: 0 }

/** Big sleeping dragon — procedural pixel-art body with animated Z's drifting up and a
 *  snore "puff" emitted from the snout periodically. Drawn over the floor but under the
 *  scene-z so taller foreground items can occlude him correctly. */
export function renderSleepingDragon(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
): void {
  const baseX = DRAGON_ANCHOR.col * TILE_SIZE
  const baseY = DRAGON_ANCHOR.row * TILE_SIZE
  const cx = offsetX + baseX * zoom
  const cy = offsetY + baseY * zoom

  // World-relative coordinates within the 6×5 bounding box (96 wide × 80 tall).
  const block = (wx: number, wy: number, ww: number, wh: number, color: string) => {
    ctx.fillStyle = color
    ctx.fillRect(cx + wx * zoom, cy + wy * zoom, ww * zoom, wh * zoom)
  }

  ctx.save()

  // Palette
  const SCALE = '#5a8a4a'
  const SCALE_DARK = '#3d6e3d'
  const SCALE_LIGHT = '#7eb060'
  const BELLY = '#d4d490'
  const SPINE = '#6a4a3a'
  const HORN = '#3a2818'
  const EYE = '#1a3a1a'
  const NOSTRIL = '#1a1a1a'

  // Breathing — slow chest rise/fall.
  const breath = Math.sin(timeMs * 0.0009) * 0.6
  const by = breath  // tiny y nudge for body

  // Tail — wraps around the right edge then curls back inward.
  block(70, 56 + by, 22, 8, SCALE_DARK)
  block(78, 48 + by, 14, 8, SCALE_DARK)
  block(80, 40 + by, 10, 8, SCALE_DARK)
  block(78, 32 + by, 8, 8, SCALE_DARK)
  block(70, 28 + by, 8, 6, SCALE_DARK)  // curl tip back over body

  // Main body — wide oval-ish shape via stacked rects.
  block(22, 30 + by, 56, 32, SCALE)
  block(18, 34 + by, 64, 24, SCALE)
  block(14, 38 + by, 6, 16, SCALE)        // left bulge
  block(76, 40 + by, 6, 12, SCALE)        // right bulge

  // Belly underside (lighter).
  block(24, 56 + by, 50, 8, BELLY)
  block(28, 60 + by, 42, 4, BELLY)

  // Spine bumps + folded wings.
  block(28, 26 + by, 10, 8, SPINE)
  block(42, 24 + by, 12, 9, SPINE)
  block(58, 26 + by, 10, 8, SPINE)
  // Wing membranes peeking through bumps.
  block(34, 28 + by, 4, 4, '#8a6a4a')
  block(48, 26 + by, 4, 4, '#8a6a4a')
  block(62, 28 + by, 4, 4, '#8a6a4a')

  // Highlight strip — top of body catching the morning sun.
  block(28, 32 + by, 42, 2, SCALE_LIGHT)
  block(36, 30 + by, 28, 2, SCALE_LIGHT)

  // Head — left side.
  block(2, 38 + by, 18, 18, SCALE)
  block(0, 42 + by, 4, 10, SCALE)         // back of jaw
  // Snout extending out left.
  block(-8, 46 + by, 12, 8, SCALE)
  block(-12, 48 + by, 6, 5, SCALE_DARK)   // snout tip
  // Nostril.
  block(-10, 49 + by, 2, 2, NOSTRIL)
  // Closed eye — single slit with a faint highlight.
  block(8, 44 + by, 6, 1, EYE)
  block(8, 45 + by, 6, 1, '#3a5a3a')
  // Horns on top of head.
  block(8, 34 + by, 3, 6, HORN)
  block(15, 34 + by, 3, 7, HORN)
  // Cheek scale.
  block(14, 50 + by, 4, 4, SCALE_DARK)

  // Animated Z's drifting up + slightly right from above the head.
  ctx.save()
  const fontSz = Math.max(8, Math.round(10 * zoom))
  ctx.font = `bold ${fontSz}px FSPixelSans, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < 3; i++) {
    const phase = ((timeMs * 0.0005) + i * 0.33) % 1
    const zx = (10 + i * 6 + phase * 18) * zoom
    const zy = (28 - phase * 32) * zoom
    const alpha = phase < 0.15
      ? phase / 0.15
      : phase > 0.7
        ? (1 - phase) / 0.3
        : 1
    if (alpha <= 0) continue
    ctx.globalAlpha = alpha * 0.85
    // Drop shadow
    ctx.fillStyle = 'rgba(20,40,20,0.6)'
    ctx.fillText('Z', cx + zx + 1, cy + zy + 1)
    ctx.fillStyle = '#ffffff'
    ctx.fillText('Z', cx + zx, cy + zy)
  }
  ctx.restore()

  // Snore puff — periodic small cloud near the snout.
  const snorePhase = (timeMs * 0.0006) % 1
  if (snorePhase < 0.3) {
    const puffT = snorePhase / 0.3
    const drift = -puffT * 14
    const px2 = cx + (-12 + drift) * zoom
    const py2 = cy + (52 - puffT * 6) * zoom
    const r = (2 + puffT * 4) * zoom
    ctx.globalAlpha = (1 - puffT) * 0.6
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(px2, py2, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
  }

  ctx.restore()
}

// ── Forest animals ──────────────────────────────────────────────

export interface ForestAnimal {
  kind: 'rabbit' | 'squirrel' | 'baby-dragon'
  /** Current world-pixel position (tile-center coordinates). */
  x: number
  y: number
  facing: 'left' | 'right'
}

function drawRabbit(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  cell: number,
  facing: 'left' | 'right',
  timeMs: number,
): void {
  const sign = facing === 'right' ? 1 : -1
  const bob = Math.abs(Math.sin(timeMs * 0.003)) * cell
  // Body (rounded rect built from layered rects)
  ctx.fillStyle = '#f5f5f5'
  ctx.fillRect(cx - 3 * cell, cy - bob, 6 * cell, 3 * cell)
  ctx.fillRect(cx - 2 * cell, cy - cell - bob, 4 * cell, cell)
  ctx.fillRect(cx - 2 * cell, cy + 3 * cell - bob, 4 * cell, cell)
  // Ears (rabbit's left/right)
  ctx.fillRect(cx - 2 * cell, cy - 4 * cell - bob, cell, 3 * cell)
  ctx.fillRect(cx + 1 * cell, cy - 4 * cell - bob, cell, 3 * cell)
  // Inner ear pink
  ctx.fillStyle = '#f8b4c4'
  ctx.fillRect(cx - 2 * cell, cy - 3 * cell - bob, cell, cell)
  ctx.fillRect(cx + 1 * cell, cy - 3 * cell - bob, cell, cell)
  // Eyes — facing-direction-sensitive
  ctx.fillStyle = '#222'
  ctx.fillRect(cx + sign * -1 * cell, cy - bob, cell, cell)
  ctx.fillRect(cx + sign * 1 * cell, cy - bob, cell, cell)
  // Tiny pink nose
  ctx.fillStyle = '#f8b4c4'
  ctx.fillRect(cx, cy + cell - bob, cell, cell)
  // Tiny tail — opposite side from facing
  ctx.fillStyle = '#f5f5f5'
  ctx.fillRect(cx + sign * -3 * cell, cy + cell - bob, cell, cell)
}

function drawSquirrel(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  cell: number,
  facing: 'left' | 'right',
  timeMs: number,
): void {
  const sign = facing === 'right' ? 1 : -1
  const bob = Math.sin(timeMs * 0.004 + cx) * cell * 0.5
  // Curling tail behind body (opposite side from facing direction)
  ctx.fillStyle = '#5a3818'
  ctx.fillRect(cx + sign * -4 * cell, cy - 4 * cell - bob, 2 * cell, 4 * cell)
  ctx.fillRect(cx + sign * -3 * cell, cy - 5 * cell - bob, cell, cell)
  ctx.fillRect(cx + sign * -3 * cell, cy + bob, cell, cell)
  // Body
  ctx.fillStyle = '#a06030'
  ctx.fillRect(cx - 2 * cell, cy - bob, 4 * cell, 3 * cell)
  ctx.fillRect(cx - cell, cy - 2 * cell - bob, 3 * cell, cell)
  // Head
  ctx.fillRect(cx + sign * 0 * cell, cy - 3 * cell - bob, 2 * cell, cell)
  ctx.fillRect(cx + sign * cell, cy - 4 * cell - bob, cell, cell)
  // Chest cream
  ctx.fillStyle = '#d4a070'
  ctx.fillRect(cx - cell, cy + cell - bob, 2 * cell, cell)
  // Eyes
  ctx.fillStyle = '#222'
  ctx.fillRect(cx + sign * cell, cy - 2 * cell - bob, cell, cell)
}

/** A speckled dragon egg sitting in the embers; tiny wobble as it nears hatching. */
function drawEgg(ctx: CanvasRenderingContext2D, px: number, py: number, zoom: number, timeMs: number): void {
  const wob = Math.sin(timeMs * 0.006) * 0.5 * zoom
  const w = 7 * zoom, h = 9 * zoom
  const cx = px + wob, cy = py - h / 2
  ctx.save()
  ctx.fillStyle = '#e8e0c8'
  ctx.beginPath(); ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#7bbf5a'
  const cell = Math.max(1, Math.round(zoom))
  ctx.fillRect(cx - 2 * zoom, cy - 1 * zoom, cell, cell)
  ctx.fillRect(cx + 1 * zoom, cy + 2 * zoom, cell, cell)
  ctx.fillRect(cx, cy - 3 * zoom, cell, cell)
  ctx.restore()
}

/** A tiny green baby dragon: round body, stubby flapping wings, a horn, bobbing. */
function drawBabyDragon(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, cell: number,
  facing: 'left' | 'right', timeMs: number,
): void {
  const dir = facing === 'right' ? 1 : -1
  const bob = Math.sin(timeMs * 0.004) * cell
  const flap = Math.sin(timeMs * 0.012) * 1.5 * cell
  ctx.save()
  ctx.translate(cx, cy + bob)
  ctx.fillStyle = '#3fa85a'
  ctx.beginPath(); ctx.ellipse(0, 0, 4 * cell, 3.2 * cell, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#bfe89a'
  ctx.beginPath(); ctx.ellipse(0, 1.2 * cell, 2.4 * cell, 1.8 * cell, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#3fa85a'
  ctx.beginPath(); ctx.ellipse(dir * 3.2 * cell, -2.4 * cell, 2.6 * cell, 2.2 * cell, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#e8e0c8'
  ctx.fillRect(dir * 3.2 * cell - cell / 2, -4.8 * cell, cell, 1.6 * cell)
  ctx.fillStyle = '#111'
  ctx.fillRect(dir * 4 * cell, -3 * cell, cell, cell)
  ctx.fillStyle = '#2e8047'
  ctx.beginPath()
  ctx.moveTo(-dir * cell, -cell)
  ctx.lineTo(-dir * 4 * cell, -2.5 * cell - flap)
  ctx.lineTo(-dir * 3.5 * cell, cell)
  ctx.closePath(); ctx.fill()
  ctx.restore()
}

/** Draw all forest animals at their current positions. */
export function renderAnimals(
  ctx: CanvasRenderingContext2D,
  animals: ForestAnimal[] | undefined,
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
): void {
  if (!animals || animals.length === 0) return
  const cell = Math.max(1, Math.round(zoom))
  ctx.save()
  for (const a of animals) {
    const cx = offsetX + a.x * zoom
    const cy = offsetY + a.y * zoom
    if (a.kind === 'rabbit') drawRabbit(ctx, cx, cy, cell, a.facing, timeMs)
    else if (a.kind === 'baby-dragon') drawBabyDragon(ctx, cx, cy, cell, a.facing, timeMs)
    else drawSquirrel(ctx, cx, cy, cell, a.facing, timeMs)
  }
  ctx.restore()
}

// ── Forest atmospherics ─────────────────────────────────────────

/** Position of the campfire — must match the `lng-campfire` entry in layout.json. */
const CAMPFIRE_TILE = { col: 5, row: 30 }

/** Procedural animated flames + glow + rising sparks above each campfire tile. */
export function renderCampfireFlames(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
  campfire?: CampfireRenderState,
): void {
  const tile = campfire?.fireTile ?? CAMPFIRE_TILE
  const phase = campfire?.phase ?? 'growing'
  const woodMax = campfire?.woodMax ?? 8
  const woodLevel = campfire?.woodLevel ?? woodMax
  const level = woodLevel / Math.max(1, woodMax)
  // Fire scales hard with wood: a single log is a flicker, 8 logs is a bonfire.
  // 'dancing' and 'full' both burn at peak; 'growing' is what scales.
  const intensity = phase === 'egg' ? 0.12
    : phase === 'growing' ? 0.08 + 1.4 * level
    : phase === 'full' || phase === 'dancing' ? 1.6
    : 0.6 // burning_down / hatching
  const { col, row } = tile
  const cx = (col * TILE_SIZE + TILE_SIZE / 2)
  const baseY = (row * TILE_SIZE + 7)
  const cell = Math.max(1, Math.round(zoom))
  ctx.save()

  const halo = 0.85 + 0.15 * Math.sin(timeMs * 0.005)
  const haloR = (6 + 14 * intensity) * zoom * halo
  const px = offsetX + cx * zoom
  const py = offsetY + baseY * zoom
  const haloGrad = ctx.createRadialGradient(px, py, 0, px, py, haloR)
  haloGrad.addColorStop(0, `rgba(255, 200, 80, ${Math.min(0.85, 0.45 * intensity + 0.1)})`)
  haloGrad.addColorStop(0.5, `rgba(255, 140, 40, ${0.22 * intensity})`)
  haloGrad.addColorStop(1, 'rgba(255, 100, 20, 0)')
  ctx.fillStyle = haloGrad
  ctx.beginPath(); ctx.arc(px, py, haloR, 0, Math.PI * 2); ctx.fill()

  // Stacked logs at the base of the pit grow with wood count (visible even when not lit).
  if (phase !== 'egg') {
    drawWoodStack(ctx, px, py + 2 * zoom, zoom, woodLevel)
  }

  if (phase !== 'egg') {
    const flameLayers = [
      { dx: 0, h: 11, w: 4, color1: '#fff09a', color2: '#ffae40', freq: 0.012, phase: 0 },
      { dx: -3, h: 7, w: 3, color1: '#ffae40', color2: '#ff5020', freq: 0.014, phase: 1.3 },
      { dx: 3, h: 7, w: 3, color1: '#ffae40', color2: '#ff5020', freq: 0.014, phase: 2.7 },
    ]
    for (const f of flameLayers) {
      const wobble = Math.sin(timeMs * f.freq + f.phase) * 1.2
      // Height scales nearly linearly with intensity, so 1 log = tiny flicker, 8 logs = tall flames.
      const fheight = ((f.h * (0.15 + 0.85 * Math.min(1.2, intensity))) + Math.sin(timeMs * f.freq * 0.7 + f.phase) * 1.5) * zoom
      const fwidth = f.w * (0.4 + 0.6 * Math.min(1.2, intensity)) * zoom
      const fx = offsetX + (cx + f.dx) * zoom + wobble
      const fy = offsetY + baseY * zoom
      for (let i = 0; i < 8; i++) {
        const t = i / 8
        const w = fwidth * (1 - t * 0.7)
        const y = fy - fheight * t
        ctx.fillStyle = t < 0.5 ? f.color2 : f.color1
        ctx.fillRect(fx - w / 2, y, w, Math.max(1, fheight / 8))
      }
    }
  } else {
    drawEgg(ctx, px, py, zoom, timeMs)
  }

  const sparkCount = Math.round(1 + 8 * intensity)
  for (let i = 0; i < sparkCount; i++) {
    const ph = ((timeMs * 0.0009) + i * 0.13) % 1
    const sy = py - ph * 24 * zoom
    const sx = px + Math.sin(ph * Math.PI * 4 + i) * 4 * zoom
    const a = (1 - ph) * 0.9 * Math.min(1, intensity)
    ctx.fillStyle = `rgba(255, ${180 + Math.floor(60 * (1 - ph))}, 60, ${a})`
    ctx.fillRect(sx, sy, cell, cell)
  }
  ctx.restore()
}

/** Stacked logs at the base of the campfire pit. Visible whether or not the fire
 *  is lit — the pile grows tile-by-tile as agents drop wood. */
function drawWoodStack(
  ctx: CanvasRenderingContext2D,
  px: number, py: number, zoom: number, woodLevel: number,
): void {
  if (woodLevel <= 0) return
  const cell = Math.max(1, Math.round(zoom))
  // Up to 3 rows of logs; each row holds 1-3 logs.
  const rows: Array<{ dy: number; widths: number[] }> = [
    { dy: 0, widths: [6, 5, 4] },
    { dy: -2, widths: [5, 4] },
    { dy: -4, widths: [4] },
  ]
  let drawn = 0
  ctx.save()
  for (const r of rows) {
    if (drawn >= woodLevel) break
    const logCount = Math.min(r.widths.length, woodLevel - drawn)
    const totalWidth = r.widths.slice(0, logCount).reduce((s, w) => s + w, 0) + (logCount - 1)
    let xCursor = px - (totalWidth / 2) * zoom
    for (let i = 0; i < logCount; i++) {
      const w = r.widths[i]
      // Log barrel.
      ctx.fillStyle = '#6E4322'
      ctx.fillRect(xCursor, py + r.dy * zoom, w * zoom, 2 * zoom)
      // End-cap rings (lighter).
      ctx.fillStyle = '#8E5A33'
      ctx.fillRect(xCursor, py + r.dy * zoom, cell, 2 * zoom)
      ctx.fillRect(xCursor + (w - 1) * zoom, py + r.dy * zoom, cell, 2 * zoom)
      // Top highlight strip for roundness.
      ctx.fillStyle = '#9A6A40'
      ctx.fillRect(xCursor + cell, py + r.dy * zoom, (w - 2) * zoom, cell)
      xCursor += (w + 1) * zoom
      drawn++
      if (drawn >= woodLevel) break
    }
  }
  ctx.restore()
}

/** Dim the entire canvas around the campfire while the ritual dance is on, leaving a
 *  bright halo around the fire itself. Fades in over ~1.5s when entering 'dancing' and
 *  out over ~1.5s when entering 'burning_down', so transitions don't pop. No-op for
 *  every other phase. */
export function renderDanceDim(
  ctx: CanvasRenderingContext2D,
  canvasW: number, canvasH: number,
  offsetX: number, offsetY: number,
  zoom: number,
  timeMs: number,
  campfire?: CampfireRenderState,
): void {
  if (!campfire) return
  const FADE_MS = 1500
  const TARGET_ALPHA = 0.62
  const elapsed = timeMs - campfire.phaseStartMs
  let alpha = 0
  if (campfire.phase === 'dancing') {
    alpha = TARGET_ALPHA * Math.min(1, elapsed / FADE_MS)
  } else if (campfire.phase === 'burning_down') {
    alpha = TARGET_ALPHA * Math.max(0, 1 - elapsed / FADE_MS)
  }
  if (alpha <= 0.01) return

  const tile = campfire.fireTile ?? CAMPFIRE_TILE
  const cx = tile.col * TILE_SIZE + TILE_SIZE / 2
  const baseY = tile.row * TILE_SIZE + 7
  const px = offsetX + cx * zoom
  const py = offsetY + baseY * zoom

  // Radial gradient: transparent at the fire (so flames + nearby dancers stay lit),
  // ramping to the target alpha out beyond the ring. Inner clear radius ~3 tiles,
  // outer dim radius ~9 tiles — far enough that distant rings are clearly darkened.
  const inner = TILE_SIZE * 3 * zoom
  const outer = TILE_SIZE * 9 * zoom
  // Slight breathing flicker keyed to the same cadence as the halo, so the dim
  // pulses subtly with the bonfire.
  const flicker = 0.92 + 0.08 * Math.sin(timeMs * 0.005)

  ctx.save()
  // First: a flat darkening layer covering everything outside the bright zone.
  const fade = ctx.createRadialGradient(px, py, inner, px, py, outer)
  fade.addColorStop(0, 'rgba(0, 0, 0, 0)')
  fade.addColorStop(1, `rgba(8, 5, 24, ${alpha})`)
  ctx.fillStyle = fade
  ctx.fillRect(0, 0, canvasW, canvasH)
  // Then: solid dim past the outer radius so distant tiles aren't suddenly bright.
  ctx.fillStyle = `rgba(8, 5, 24, ${alpha})`
  ctx.beginPath()
  ctx.rect(0, 0, canvasW, canvasH)
  ctx.arc(px, py, outer, 0, Math.PI * 2, true)
  ctx.fill('evenodd')
  // Warm firelight wash over the inner zone — boosts the bonfire's reach.
  const warm = ctx.createRadialGradient(px, py, 0, px, py, inner * flicker)
  warm.addColorStop(0, `rgba(255, 160, 60, ${0.32 * alpha / TARGET_ALPHA})`)
  warm.addColorStop(1, 'rgba(255, 100, 20, 0)')
  ctx.fillStyle = warm
  ctx.fillRect(0, 0, canvasW, canvasH)
  ctx.restore()
}

/** Slanted warm sunlight beam streaming from the upper-right of the canvas across the
 *  meadow. Subtle drift over time so it feels alive rather than static. */
export function renderSunBeam(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  timeMs: number,
): void {
  ctx.save()
  // Slowly drift the beam horizontally so it shifts during the day.
  const drift = Math.sin(timeMs * 0.00008) * canvasW * 0.05
  ctx.translate(canvasW * 0.62 + drift, 0)
  ctx.rotate(0.32)  // ~18° clockwise

  // Wide outer halo.
  const outerW = canvasW * 0.5
  const haloLen = canvasH * 1.6
  const halo = ctx.createLinearGradient(-outerW / 2, 0, outerW / 2, 0)
  halo.addColorStop(0, 'rgba(255, 240, 180, 0)')
  halo.addColorStop(0.5, 'rgba(255, 240, 180, 0.10)')
  halo.addColorStop(1, 'rgba(255, 240, 180, 0)')
  ctx.fillStyle = halo
  ctx.fillRect(-outerW / 2, 0, outerW, haloLen)

  // Brighter narrower core.
  const coreW = canvasW * 0.18
  const core = ctx.createLinearGradient(-coreW / 2, 0, coreW / 2, 0)
  core.addColorStop(0, 'rgba(255, 250, 220, 0)')
  core.addColorStop(0.5, 'rgba(255, 250, 220, 0.22)')
  core.addColorStop(1, 'rgba(255, 250, 220, 0)')
  ctx.fillStyle = core
  ctx.fillRect(-coreW / 2, 0, coreW, haloLen)

  // Floating dust motes inside the beam.
  const cell = Math.max(1, Math.round(2))
  for (let i = 0; i < 18; i++) {
    const phase = ((timeMs * 0.00012) + i * 0.071) % 1
    const py = phase * haloLen
    const px = ((i * 137) % 100) / 100 * outerW * 0.7 - outerW * 0.35
    const a = 0.4 + 0.4 * Math.sin(phase * Math.PI * 2 + i)
    ctx.fillStyle = `rgba(255, 250, 230, ${a * 0.7})`
    ctx.fillRect(px, py, cell, cell)
  }
  ctx.restore()
}

/** Tiny pixel flower clusters scattered deterministically across grass tiles.
 *  Static (no animation). Uses tileColor hue to detect grass — only paints on grass tiles. */
export function renderFlowers(
  ctx: CanvasRenderingContext2D,
  tileColors: Array<FloorColor | null> | undefined,
  cols: number,
  rows: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (!tileColors) return
  const FLOWER_COLORS = ['#ff6b8a', '#ffd66b', '#a3d8ff', '#ffffff', '#ff9f43', '#e066ff']
  ctx.save()
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tc = tileColors[r * cols + c]
      if (!tc || tc.h !== 95) continue  // grass hue from layout script
      const seed = r * 1009 + c * 31 + 7
      // ~22% of grass tiles get a flower cluster.
      if ((seed % 100) >= 22) continue
      const colorIdx = (seed >>> 4) % FLOWER_COLORS.length
      const color = FLOWER_COLORS[colorIdx]
      // Sub-tile position (5/16..11/16 horizontally, 5/16..11/16 vertically).
      const subX = ((seed * 7) % 7) + 5
      const subY = ((seed * 13) % 7) + 5
      const px = offsetX + (c * TILE_SIZE + subX) * zoom
      const py = offsetY + (r * TILE_SIZE + subY) * zoom
      const cell = Math.max(1, Math.round(zoom))
      // Tiny + shape: stem (green), 4 petals around center, yellow center pixel.
      ctx.fillStyle = '#3a8030'  // stem
      ctx.fillRect(px, py + cell, cell, cell)
      ctx.fillStyle = color  // petals
      ctx.fillRect(px - cell, py, cell, cell)
      ctx.fillRect(px + cell, py, cell, cell)
      ctx.fillRect(px, py - cell, cell, cell)
      ctx.fillStyle = '#fff8c0'  // center
      ctx.fillRect(px, py, cell, cell)
    }
  }
  ctx.restore()
}

/** Permanent flowers planted by idle agents. Each entry is a tile key "col,row" → color.
 *  Drawn the same way as procedural flowers but with a subtle white outline so they
 *  visually stand out as "freshly planted." */
export function renderPlantedFlowers(
  ctx: CanvasRenderingContext2D,
  planted: Map<string, string> | undefined,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (!planted || planted.size === 0) return
  const cell = Math.max(1, Math.round(zoom))
  ctx.save()
  for (const [key, color] of planted) {
    const [csStr, rsStr] = key.split(',')
    const c = parseInt(csStr, 10)
    const r = parseInt(rsStr, 10)
    if (Number.isNaN(c) || Number.isNaN(r)) continue
    // Place at tile center (8/16 horizontally, 8/16 vertically).
    const px = offsetX + (c * TILE_SIZE + 8) * zoom
    const py = offsetY + (r * TILE_SIZE + 8) * zoom
    // Pale halo so they read against busy procedural flowers.
    ctx.fillStyle = 'rgba(255, 255, 240, 0.28)'
    ctx.fillRect(px - 2 * cell, py - 2 * cell, 5 * cell, 5 * cell)
    // Stem.
    ctx.fillStyle = '#3a8030'
    ctx.fillRect(px, py + cell, cell, cell)
    // Petals (4 arms of the +).
    ctx.fillStyle = color
    ctx.fillRect(px - cell, py, cell, cell)
    ctx.fillRect(px + cell, py, cell, cell)
    ctx.fillRect(px, py - cell, cell, cell)
    // Center.
    ctx.fillStyle = '#fff8c0'
    ctx.fillRect(px, py, cell, cell)
  }
  ctx.restore()
}

/** Animated sprout above a character actively planting — grows from a stem to a full
 *  flower as their plantingTimer counts down. Renders only for characters currently
 *  parked at their planting tile. */
export function renderPlantingProgress(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  totalDurationMs: number,
): void {
  const cell = Math.max(1, Math.round(zoom))
  ctx.save()
  for (const ch of characters) {
    if (ch.tripMode !== 'planting') continue
    if (ch.plantingTimer === undefined) continue
    if (!ch.tripTile) continue
    if (ch.tileCol !== ch.tripTile.col || ch.tileRow !== ch.tripTile.row) continue
    // Progress: 0 = just arrived, 1 = about to finish.
    const t = Math.min(1, Math.max(0, 1 - ch.plantingTimer / totalDurationMs))
    // Sprout sits at the agent's feet, just south of the agent's tile center.
    const wx = ch.tileCol * TILE_SIZE + 8
    const wy = ch.tileRow * TILE_SIZE + 12
    const px = offsetX + wx * zoom
    const py = offsetY + wy * zoom
    // Stem grows tall as t→1.
    const stemH = Math.max(1, Math.round((1 + t * 3) * cell))
    ctx.fillStyle = '#3a8030'
    ctx.fillRect(px, py - stemH, cell, stemH)
    // Bud then bloom.
    if (t > 0.5) {
      const bloom = Math.min(1, (t - 0.5) * 2)
      const r = bloom * cell
      ctx.fillStyle = '#ffae40'
      ctx.fillRect(px - r, py - stemH - cell, cell, cell)
      ctx.fillRect(px + r, py - stemH - cell, cell, cell)
      ctx.fillRect(px, py - stemH - cell - r, cell, cell)
      ctx.fillStyle = '#fff8c0'
      ctx.fillRect(px, py - stemH - cell, cell, cell)
    } else {
      // Bud: tiny green dot at top of stem.
      ctx.fillStyle = '#7ec07e'
      ctx.fillRect(px, py - stemH - cell, cell, cell)
    }
    // Sparkle puff around the planter.
    const t2 = (1 - ch.plantingTimer / totalDurationMs)
    const sparkleAlpha = 0.5 + 0.5 * Math.sin(t2 * 30)
    ctx.fillStyle = `rgba(255, 240, 120, ${sparkleAlpha * 0.7})`
    for (let i = 0; i < 3; i++) {
      const angle = t2 * Math.PI * 6 + i * (Math.PI * 2 / 3)
      const sx = px + Math.cos(angle) * 4 * zoom
      const sy = py - 4 * zoom + Math.sin(angle) * 3 * zoom
      ctx.fillRect(sx, sy, cell, cell)
    }

    // Hearts floating up from above the agent's head — one per cycle slot, each at its
    // own phase. Drift sideways slightly as they rise; fade out near the top.
    const headX = ch.x
    const headY = ch.y - 18  // pixels above the agent's center (above their head)
    const HEART_COUNT = 4
    const HEART_COLORS = ['#ff5a8a', '#ff7aa0', '#ff4070', '#ffa3c4']
    for (let i = 0; i < HEART_COUNT; i++) {
      const phase = ((t2 * 1.6) + i / HEART_COUNT) % 1
      const rise = phase * 18 * zoom
      const drift = Math.sin(phase * Math.PI * 3 + i * 1.7) * 3 * zoom
      const hxw = offsetX + headX * zoom + drift
      const hyw = offsetY + headY * zoom - rise
      // Fade in quickly, fade out at the top.
      const alpha = phase < 0.15
        ? phase / 0.15
        : phase > 0.75
          ? (1 - phase) / 0.25
          : 1
      if (alpha <= 0) continue
      ctx.globalAlpha = alpha * 0.95
      const color = HEART_COLORS[i % HEART_COLORS.length]
      ctx.fillStyle = color
      // 5×4 pixel heart shape:
      //   X . X
      //  X X X X X
      //  . X X X .
      //  . . X . .
      // Row 0: two top humps
      ctx.fillRect(hxw - 2 * cell, hyw, cell, cell)
      ctx.fillRect(hxw, hyw, cell, cell)
      // Row 1: full width
      ctx.fillRect(hxw - 2 * cell, hyw + cell, 5 * cell, cell)
      // Row 2: middle 3
      ctx.fillRect(hxw - cell, hyw + 2 * cell, 3 * cell, cell)
      // Row 3: tip
      ctx.fillRect(hxw, hyw + 3 * cell, cell, cell)
      // Highlight on the upper-left hump.
      ctx.globalAlpha = alpha * 0.7
      ctx.fillStyle = '#ffd0e0'
      ctx.fillRect(hxw - 2 * cell, hyw, cell, cell)
    }
    ctx.globalAlpha = 1
  }
  ctx.restore()
}

/** A small log sprite above any character currently carrying wood to the campfire. */
function renderCarriedLogs(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number, offsetY: number, zoom: number,
): void {
  const spriteH = 24 // character sprite height in world px
  for (const ch of characters) {
    if (!ch.carrying) continue
    const px = offsetX + (ch.x - 5) * zoom
    const py = offsetY + (ch.y - spriteH - 2) * zoom
    const w = 10 * zoom, h = 3 * zoom
    ctx.save()
    ctx.fillStyle = '#6b4a2b'
    ctx.fillRect(px, py, w, h)
    ctx.fillStyle = '#caa06a'
    ctx.fillRect(px, py, 2 * zoom, h)
    ctx.fillRect(px + w - 2 * zoom, py, 2 * zoom, h)
    ctx.restore()
  }
}

/** Small mushroom clusters deterministically scattered along the hedge edges (cols 1-2 and
 *  17-18, on grass tiles only). Cluster of 1-3 caps with a stem each. Static. */
export function renderMushrooms(
  ctx: CanvasRenderingContext2D,
  tileColors: Array<FloorColor | null> | undefined,
  cols: number,
  rows: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (!tileColors) return
  ctx.save()
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Only along the hedge-adjacent columns.
      if (c !== 1 && c !== 2 && c !== 17 && c !== 18) continue
      const tc = tileColors[r * cols + c]
      if (!tc || tc.h !== 95) continue  // grass only
      const seed = r * 757 + c * 113 + 11
      // ~35% of edge grass tiles get mushrooms.
      if ((seed % 100) >= 35) continue
      const cell = Math.max(1, Math.round(zoom))
      const baseX = offsetX + (c * TILE_SIZE + 4 + ((seed * 3) % 5)) * zoom
      const baseY = offsetY + (r * TILE_SIZE + 8 + ((seed * 5) % 4)) * zoom
      const numCaps = 1 + (seed % 3)
      const isRed = (seed >>> 4) % 2 === 0
      for (let i = 0; i < numCaps; i++) {
        const dx = i * cell * 3
        // Stem
        ctx.fillStyle = '#f0e8d0'
        ctx.fillRect(baseX + dx, baseY + cell, cell, cell * 2)
        // Cap
        ctx.fillStyle = isRed ? '#c53030' : '#7c4a32'
        ctx.fillRect(baseX + dx - cell, baseY, cell * 3, cell)
        ctx.fillRect(baseX + dx, baseY - cell, cell, cell)
        // Spots
        ctx.fillStyle = '#fff8e0'
        ctx.fillRect(baseX + dx - cell, baseY, cell, cell)
        ctx.fillRect(baseX + dx + cell, baseY, cell, cell)
      }
    }
  }
  ctx.restore()
}

// ── Knight raised swords (all-4-hero summon companion) ────────

/** Tile positions of the two flanking knights — must match `hero-knight-l/r` in layout.json. */
const KNIGHT_POSITIONS = [
  { col: 7, row: 4 },
  { col: 12, row: 4 },
] as const

/** When all four hero PCs are in use, the two flanking knights raise their swords overhead.
 *  Drawn as a procedural overlay (sword + crossguard + grip + glowing halo) above each
 *  knight sprite — appears/disappears in one frame as the summon condition flips. */
export function renderRaisedSwords(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
): void {
  ctx.save()
  for (const k of KNIGHT_POSITIONS) {
    const cell = Math.max(1, Math.round(zoom))
    const bob = Math.sin(timeMs * 0.004 + k.col) * 0.5
    // Sword centered horizontally over the knight tile.
    const wx = k.col * TILE_SIZE + TILE_SIZE / 2
    // Blade tip a full tile above the knight's head; crossguard at top of head row.
    const wyTip = k.row * TILE_SIZE - TILE_SIZE
    const wyBase = k.row * TILE_SIZE
    const x = offsetX + wx * zoom
    const yTip = offsetY + (wyTip + bob) * zoom
    const yBase = offsetY + (wyBase + bob) * zoom

    // Glow halo behind the blade — wider than the sword, soft falloff sideways.
    const haloW = 10 * zoom
    const haloGrad = ctx.createLinearGradient(x - haloW / 2, 0, x + haloW / 2, 0)
    haloGrad.addColorStop(0, 'rgba(255, 250, 180, 0)')
    haloGrad.addColorStop(0.5, 'rgba(255, 250, 200, 0.55)')
    haloGrad.addColorStop(1, 'rgba(255, 250, 180, 0)')
    ctx.fillStyle = haloGrad
    ctx.fillRect(x - haloW / 2, yTip - 3 * cell, haloW, yBase - yTip + 6 * cell)

    // Blade (silver) — 1 cell wide, edge-of-blade highlight.
    ctx.fillStyle = '#9098a3'
    ctx.fillRect(x - cell, yTip, cell, yBase - yTip)
    ctx.fillStyle = '#e8ecf0'
    ctx.fillRect(x, yTip, cell, yBase - yTip)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x - cell / 2, yTip, cell / 2, Math.max(2 * cell, (yBase - yTip) * 0.3))

    // Crossguard (gold) — horizontal bar at base of blade.
    ctx.fillStyle = '#d4a834'
    ctx.fillRect(x - 3 * cell, yBase, 6 * cell, cell)
    ctx.fillStyle = '#fde88a'
    ctx.fillRect(x - 3 * cell, yBase, 6 * cell, Math.max(1, cell * 0.4))

    // Grip (brown) and pommel (gold) below crossguard, just into the helmet area.
    ctx.fillStyle = '#5a3820'
    ctx.fillRect(x - cell / 2, yBase + cell, cell, 3 * cell)
    ctx.fillStyle = '#d4a834'
    ctx.fillRect(x - cell, yBase + 4 * cell, 2 * cell, cell)

    // Sparkle near the blade tip.
    const sparklePulse = (Math.sin(timeMs * 0.008 + k.col * 1.7) + 1) / 2
    if (sparklePulse > 0.7) {
      ctx.fillStyle = `rgba(255, 255, 230, ${(sparklePulse - 0.7) / 0.3})`
      ctx.fillRect(x - cell, yTip - cell * 2, cell, cell)
      ctx.fillRect(x, yTip - cell * 3, cell, cell)
      ctx.fillRect(x + cell, yTip - cell * 2, cell, cell)
    }
  }
  ctx.restore()
}

// ── Energy spirit (all-4-hero-PCs summon) ──────────────────────

/** Floats a small glowing humanoid spirit between the four merge-to-main beams when ALL
 *  four hero PCs are currently active. He traces a Lissajous figure across the cols 8-11
 *  airspace, drifting up and down, with energy particles flowing upward off his body.
 *  The instant any of the four PCs goes idle, he isn't drawn — gone in one frame. */
export function renderEnergySpirit(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
): void {
  const t = timeMs / 1000
  // Base center: between the four beams (cols 8-11), hovering ~1.5 tiles above the desk surface.
  const cxBase = 9.5 * TILE_SIZE
  const cyBase = 1.2 * TILE_SIZE
  const xR = 1.7 * TILE_SIZE
  const yR = 0.9 * TILE_SIZE
  const cx = cxBase + Math.sin(t * 0.65) * xR
  const cy = cyBase + Math.sin(t * 1.35) * yR
  const px = offsetX + cx * zoom
  const py = offsetY + cy * zoom

  ctx.save()

  // Pulsing radial halo.
  const pulse = 0.85 + 0.15 * Math.sin(t * 5)
  const haloR = 13 * zoom * pulse
  const halo = ctx.createRadialGradient(px, py, 0, px, py, haloR)
  halo.addColorStop(0, 'rgba(255, 255, 255, 0.95)')
  halo.addColorStop(0.3, 'rgba(190, 255, 255, 0.65)')
  halo.addColorStop(0.7, 'rgba(126, 232, 255, 0.35)')
  halo.addColorStop(1, 'rgba(126, 232, 255, 0)')
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(px, py, haloR, 0, Math.PI * 2)
  ctx.fill()

  const cell = Math.max(1, Math.round(zoom))
  // Tiny humanoid silhouette — head + body + simple arm bumps.
  // (px, py) is the visual center of the body.
  // Head (3 wide × 3 tall) at -3..-1 rows above center.
  ctx.fillStyle = '#ffffff'
  for (let dy = -4; dy <= -2; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      ctx.fillRect(px + dx * cell, py + dy * cell, cell, cell)
    }
  }
  // Eyes
  ctx.fillStyle = '#0a1a30'
  ctx.fillRect(px - 1 * cell, py - 3 * cell, cell, cell)
  ctx.fillRect(px + 1 * cell, py - 3 * cell, cell, cell)
  // Body (5 wide × 3 tall) at -1..+1 rows.
  ctx.fillStyle = '#ffffff'
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      ctx.fillRect(px + dx * cell, py + dy * cell, cell, cell)
    }
  }
  // Tail / trailing fade — body narrows toward the bottom into wisps.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
  for (let dx = -1; dx <= 1; dx++) {
    ctx.fillRect(px + dx * cell, py + 2 * cell, cell, cell)
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'
  ctx.fillRect(px, py + 3 * cell, cell, cell)

  // Upward energy particles streaming off the spirit.
  for (let i = 0; i < 14; i++) {
    const phase = ((timeMs * 0.0008) + i * 0.071) % 1
    const py2 = py - phase * 32 * zoom
    const swirl = Math.sin(phase * Math.PI * 5 + i * 0.7) * 4 * zoom
    const px2 = px + swirl
    const alpha = (1 - phase) * 0.9
    ctx.fillStyle = `hsla(${(180 + i * 9) % 360}, 95%, 90%, ${alpha})`
    ctx.fillRect(px2, py2, cell, cell)
  }

  ctx.restore()
}

// ── Hero PC charging (idle anticipation) ───────────────────────

/** Hero PCs that don't have a sitting agent show a "charging up" effect: dim blue screen
 *  with brief flickers + a few subtle pixel sparkles drifting around. As soon as an agent
 *  sits down, the PC leaves the charging set and full-on rendering (screen + beam + bright
 *  sparkles) takes over instead. */
export function renderChargingPCs(
  ctx: CanvasRenderingContext2D,
  activePCTiles: Array<{ col: number; row: number; agentId: number }>,
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
): void {
  const activeKeys = new Set<string>()
  for (const t of activePCTiles) {
    if (HERO_PC_COLS.has(t.col) && HERO_PC_ROWS.has(t.row)) {
      activeKeys.add(`${t.col},${t.row}`)
    }
  }
  // Screen geometry — must match renderActivePCScreens.
  const SCREEN_X = 5, SCREEN_Y = 2, SCREEN_W = 6, SCREEN_H = 6
  const SURFACE_LIFT_PX = 8
  ctx.save()
  for (const col of HERO_PC_COLS) {
    for (const row of HERO_PC_ROWS) {
      if (activeKeys.has(`${col},${row}`)) continue
      const seed = col * 7 + row * 13
      const px = offsetX + (col * TILE_SIZE + SCREEN_X) * zoom
      const py = offsetY + (row * TILE_SIZE + SCREEN_Y - SURFACE_LIFT_PX) * zoom
      const w = SCREEN_W * zoom
      const h = SCREEN_H * zoom

      // Dim "charging" base — slow blue pulse, with rare bright flicker.
      const slow = (Math.sin(timeMs * 0.0018 + seed) + 1) / 2          // 0..1
      const flicker = Math.sin(timeMs * 0.022 + seed * 1.3) > 0.96 ? 1 : 0
      const baseAlpha = 0.18 + slow * 0.22 + flicker * 0.45
      ctx.globalAlpha = baseAlpha
      ctx.fillStyle = '#1a3a5e'
      ctx.fillRect(px, py, w, h)

      // Charging "data trickle" — sparse short stripes that scroll vertically,
      // brighter the further along their phase.
      const cellH = Math.max(1, Math.floor(zoom))
      for (let i = 0; i < SCREEN_H; i++) {
        const phase = ((timeMs * 0.0006) + i * 0.13 + seed * 0.0011) % 1
        if (phase < 0.55) continue
        const ry = py + i * cellH
        const len = (1 + (i % 3)) * zoom
        const sx = px + ((i * 17 + seed) % SCREEN_W) * zoom
        const a = (phase - 0.55) * 2
        ctx.globalAlpha = Math.min(1, a)
        ctx.fillStyle = 'hsl(205, 90%, 75%)'
        ctx.fillRect(sx, ry, len, Math.max(1, zoom * 0.5))
      }

      // Subtle pixel sparkles around the monitor — quieter than active sparkles.
      ctx.globalAlpha = 1
      const mcx = col * TILE_SIZE + TILE_SIZE / 2
      const mcy = row * TILE_SIZE + TILE_SIZE / 2 - SURFACE_LIFT_PX
      const NUM = 4
      for (let i = 0; i < NUM; i++) {
        const gs = seed + i * 113
        const periodSec = 2.4 + ((gs * 7) % 100) / 100 * 1.6
        const phaseOffset = ((gs * 31) % 1000) / 1000
        const t = ((timeMs / 1000 / periodSec) + phaseOffset) % 1
        const angle = t * Math.PI * 2
        const radiusX = (4 + (gs % 4)) * zoom
        const radiusY = (3 + (gs % 3)) * zoom
        const harmonic = 1 + (gs % 2) * 0.5
        const sx = offsetX + mcx * zoom + Math.cos(angle * harmonic + (gs % 5)) * radiusX
        const sy = offsetY + mcy * zoom + Math.sin(angle) * radiusY
        const a = 0.3 + 0.35 * Math.abs(Math.sin(t * Math.PI * 2 + (gs % 4)))
        ctx.fillStyle = `hsla(205, 95%, 80%, ${a})`
        const cell = Math.max(1, Math.round(zoom))
        ctx.fillRect(Math.round(sx), Math.round(sy), cell, cell)
      }
    }
  }
  ctx.restore()
}

// ── Active PC sparkles ──────────────────────────────────────────

/** Pixel-cluster sparkles that float and swirl around any active monitor (every working
 *  agent's PC, not just hero). Smaller and more localized than the merge beams — these
 *  give every working desk a visible "I'm working" energy. */
export function renderActivePCSparkles(
  ctx: CanvasRenderingContext2D,
  activePCTiles: Array<{ col: number; row: number; agentId: number }>,
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
): void {
  if (activePCTiles.length === 0) return
  const SHAPES: Array<Array<[number, number]>> = [
    [[0, 0], [1, 0], [0, 1], [1, 1]],   // 2×2 block
    [[0, 0], [1, 0], [1, 1]],            // tiny L
    [[0, 0], [1, 0], [2, 0]],            // 3 wide
    [[0, 0], [0, 1], [0, 2]],            // 3 tall
    [[0, 0]],                             // single pixel
    [[0, 0], [1, 1]],                     // diagonal pair
  ]
  ctx.save()
  for (const pc of activePCTiles) {
    const seed = pc.agentId * 47
    const hue = (seed + timeMs * 0.04) % 360
    const isHeroPC = HERO_PC_COLS.has(pc.col) && HERO_PC_ROWS.has(pc.row)
    const lift = isHeroPC ? 8 : 20
    // Monitor screen center in world pixels.
    const mcx = pc.col * TILE_SIZE + TILE_SIZE / 2
    const mcy = pc.row * TILE_SIZE + TILE_SIZE / 2 - lift

    const NUM = 7
    for (let i = 0; i < NUM; i++) {
      const gs = seed + i * 113
      // Each cluster has its own orbital period (1-3 seconds), phase offset, radius mix.
      const periodSec = 1.2 + ((gs * 7) % 100) / 100 * 1.8
      const phaseOffset = ((gs * 31) % 1000) / 1000
      const t = ((timeMs / 1000 / periodSec) + phaseOffset) % 1
      // Lissajous-style swirl with horizontal drift wider than vertical so the cluster
      // tends to circle the monitor rather than just bob up and down.
      const angle = t * Math.PI * 2
      const radiusX = (5 + (gs % 7)) * zoom
      const radiusY = (3 + (gs % 5)) * zoom
      const harmonic = 1 + (gs % 3) * 0.5
      const x = mcx * zoom + Math.cos(angle * harmonic + (gs % 7)) * radiusX
      const y = mcy * zoom + Math.sin(angle) * radiusY
      const px = offsetX + x
      const py = offsetY + y
      const shape = SHAPES[(gs >>> 4) % SHAPES.length]
      const hueOff = ((gs * 11) % 60) - 30
      // Pulse alpha so clusters twinkle.
      const alpha = 0.6 + 0.4 * Math.abs(Math.sin(t * Math.PI * 2 + (gs % 5)))
      ctx.fillStyle = `hsla(${(hue + hueOff + 360) % 360}, 100%, 90%, ${alpha})`
      const ix = Math.round(px)
      const iy = Math.round(py)
      const cell = Math.max(1, Math.round(zoom))
      for (const [dx, dy] of shape) {
        ctx.fillRect(ix + dx * cell, iy + dy * cell, cell, cell)
      }
    }
  }
  ctx.restore()
}

// ── Active PC screen glow ───────────────────────────────────────

/** Paint an animated screen on each active PC: hue-cycling background, randomized
 *  scrolling "code rows" (1-2 px-tall colored stripes) that shift each frame, and
 *  occasional fast blink/flicker so the screen reads as "live work happening".
 *  Each agent has a different hue phase + scroll offset so adjacent monitors look
 *  distinct rather than identical. */
export function renderActivePCScreens(
  ctx: CanvasRenderingContext2D,
  tiles: Array<{ col: number; row: number; agentId: number }>,
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
): void {
  if (tiles.length === 0) return
  // The PC sprite's screen area is roughly cols 5-10, rows 2-7 within its 16x16 tile.
  const SCREEN_X = 5
  const SCREEN_Y = 2
  const SCREEN_W = 6
  const SCREEN_H = 6
  ctx.save()
  for (const t of tiles) {
    const seed = t.agentId * 73
    const hue = (seed + timeMs * 0.06) % 360
    // Quick blink: ~3 Hz square-ish wave; alpha drops briefly each cycle.
    const blinkPhase = ((timeMs * 0.003) + (seed * 0.137)) % 1
    const blink = blinkPhase < 0.06 ? 0.15 : 1
    // Lift must match the per-PC lift in layoutToFurnitureInstances. Hero MERGE TO MAIN
    // PCs (cols 8-11, row 3) use 8 px; all others use 20 px.
    const isHeroPC = HERO_PC_COLS.has(t.col) && HERO_PC_ROWS.has(t.row)
    const SURFACE_LIFT_PX = isHeroPC ? 8 : 20
    const px = offsetX + (t.col * TILE_SIZE + SCREEN_X) * zoom
    const py = offsetY + (t.row * TILE_SIZE + SCREEN_Y - SURFACE_LIFT_PX) * zoom
    const w = SCREEN_W * zoom
    const h = SCREEN_H * zoom

    // Background screen color
    ctx.globalAlpha = blink
    ctx.fillStyle = `hsl(${hue}, 80%, 26%)`
    ctx.fillRect(px, py, w, h)

    // Scrolling "code rows" — one px-row per sprite-pixel, shifted by time so they
    // appear to scroll. Use a deterministic pseudo-random per (agent, row).
    const rowH = Math.max(1, Math.floor(zoom))
    for (let i = 0; i < SCREEN_H; i++) {
      const scroll = Math.floor(timeMs * 0.012 + seed) // px per second
      const row = (i + scroll) % SCREEN_H
      const r = (seed * 17 + row * 31) % 100
      if (r > 65) continue // gaps
      const len = 2 + (r % 4) // 2-5 sprite-px wide
      const startX = (r * 7) % (SCREEN_W - len)
      const lightness = 55 + (r % 25) // 55-80%
      ctx.fillStyle = `hsl(${(hue + r) % 360}, 90%, ${lightness}%)`
      ctx.fillRect(px + startX * zoom, py + i * rowH, len * zoom, rowH)
    }

    // Bright top-edge highlight
    ctx.globalAlpha = blink * 0.7
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(px, py, w, Math.max(1, zoom))
  }
  ctx.restore()
}

// ── Ping-pong ball + scoreboard ─────────────────────────────────

/** Tile coords of the two ping-pong player slots (must match OfficeState.PING_PONG_SLOTS). */
const PING_PONG_LEFT_TILE = { col: 12, row: 25 }
const PING_PONG_RIGHT_TILE = { col: 16, row: 25 }

export interface PingPongMatchState {
  leftScore: number
  rightScore: number
  phase: 'rallying' | 'scoring' | 'celebrating'
  phaseStartMs: number
  lastPointWinner: 'left' | 'right' | null
}

/**
 * Draws a small white ball. During 'rallying' phase it bounces back and forth at ~2 Hz.
 * During 'scoring' / 'celebrating' phases the ball rests on the loser's side of the table
 * (since the loser failed to return it), giving the player a moment to celebrate.
 */
export function renderPingPongBall(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
  match?: PingPongMatchState | null,
): void {
  let leftPlayer: Character | null = null
  let rightPlayer: Character | null = null
  for (const ch of characters) {
    if (ch.tripMode !== 'ping_pong') continue
    if (ch.tileCol === PING_PONG_LEFT_TILE.col && ch.tileRow === PING_PONG_LEFT_TILE.row) {
      leftPlayer = ch
    } else if (ch.tileCol === PING_PONG_RIGHT_TILE.col && ch.tileRow === PING_PONG_RIGHT_TILE.row) {
      rightPlayer = ch
    }
  }
  if (!leftPlayer || !rightPlayer) return

  // Table top reference: cols 13-15, row 25. Ball arcs across the table.
  const tableY = 25 * TILE_SIZE + TILE_SIZE * 0.35
  const leftX = 13 * TILE_SIZE + 1
  const rightX = 15 * TILE_SIZE + TILE_SIZE - 2

  let ballWX: number
  let ballWY: number
  const phase = match?.phase ?? 'rallying'
  if (phase === 'rallying' || !match) {
    // 2 Hz back-and-forth: triangle wave for x, sine arc for y.
    const cycleSec = 0.5
    const t = ((timeMs / 1000) % cycleSec) / cycleSec
    const tri = t < 0.5 ? t * 2 : (1 - t) * 2
    const archHeight = TILE_SIZE * 0.6
    const archY = -Math.sin(t * Math.PI * 2) * archHeight * 0.5 - archHeight * 0.4
    ballWX = leftX + (rightX - leftX) * tri
    ballWY = tableY + archY
  } else {
    // Ball rests on the loser's side. Tiny vertical jitter so it doesn't read as frozen.
    const winner = match.lastPointWinner
    const loserX = winner === 'left' ? rightX : leftX
    ballWX = loserX
    ballWY = tableY + Math.sin(timeMs * 0.005) * 0.5 * zoom
  }

  const px = offsetX + ballWX * zoom
  const py = offsetY + ballWY * zoom
  const ballSize = Math.max(2, Math.round(3 * zoom))

  ctx.save()
  ctx.fillStyle = '#1a1a1a'
  ctx.fillRect(px - 1, py - 1, ballSize + 2, ballSize + 2)
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(px, py, ballSize, ballSize)
  ctx.restore()
}

/** Draws a scoreboard panel centered above the ping-pong table while a match is in progress. */
export function renderPingPongScoreboard(
  ctx: CanvasRenderingContext2D,
  match: PingPongMatchState | null,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (!match) return
  const cx = 14 * TILE_SIZE + TILE_SIZE / 2  // centered over the table (cols 13-15)
  const cy = 24 * TILE_SIZE - 4              // just above the table
  const px = offsetX + cx * zoom
  const py = offsetY + cy * zoom
  const text = `${match.leftScore} – ${match.rightScore}`
  const fontPx = Math.max(5, Math.round(7 * zoom))
  ctx.save()
  ctx.font = `bold ${fontPx}px FSPixelSans, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const measure = ctx.measureText(text)
  const padX = 3 * zoom
  const padY = 1.5 * zoom
  const w = measure.width + padX * 2
  const h = fontPx + padY * 2
  // Highlight the side that just scored — brief flash during 'scoring' phase.
  const elapsed = performance.now() - match.phaseStartMs
  const flash = match.phase === 'scoring' ? Math.max(0, 1 - elapsed / 500) : 0
  ctx.fillStyle = `rgba(20, 20, 30, ${0.85 - flash * 0.2})`
  ctx.fillRect(px - w / 2, py - h / 2, w, h)
  ctx.strokeStyle = `rgba(255, 220, 120, ${0.5 + flash * 0.5})`
  ctx.lineWidth = Math.max(1, zoom * 0.5)
  ctx.strokeRect(px - w / 2, py - h / 2, w, h)
  ctx.fillStyle = flash > 0 ? '#ffe88a' : '#f4f4ff'
  ctx.fillText(text, px, py)
  ctx.restore()
}

/** Floating "★" above the winning player's head during the celebration phase. */
export function renderPingPongCelebration(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  match: PingPongMatchState | null,
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
): void {
  if (!match || match.phase !== 'celebrating' || !match.lastPointWinner) return
  for (const ch of characters) {
    if (ch.tripMode !== 'ping_pong') continue
    if (!ch.tripTile) continue
    const isLeft = ch.tripTile.col === PING_PONG_LEFT_TILE.col
    const isWinner = (match.lastPointWinner === 'left') === isLeft
    if (!isWinner) continue

    const elapsed = timeMs - match.phaseStartMs
    const t = Math.min(1, Math.max(0, elapsed / 1200))
    const rise = -10 * t
    const alpha = 1 - t * 0.5
    // Subtle bounce: scale pulses 1 → 1.25 → 1 over the celebration window.
    const scale = 1 + 0.25 * Math.sin(t * Math.PI)
    const wx = ch.x
    const wy = ch.y - 22 + rise
    const px = offsetX + wx * zoom
    const py = offsetY + wy * zoom
    const fontPx = Math.max(10, Math.round(16 * zoom * scale))
    ctx.save()
    ctx.font = `bold ${fontPx}px FSPixelSans, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.globalAlpha = alpha
    // Drop shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
    ctx.fillText('★', px + 1, py + 1)
    ctx.fillStyle = '#ffd66b'
    ctx.fillText('★', px, py)
    ctx.restore()
  }
}

// ── Tool reaction effects ───────────────────────────────────────

const EFFECT_GLYPHS: Record<ToolEffect['kind'], { glyph: string; color: string }> = {
  edit: { glyph: '✎', color: '#ffd66b' },        // ✎ pencil
  bash: { glyph: '»', color: '#7be3a8' },        // » terminal
  read: { glyph: '․', color: '#9ad8ff' },        // small dot column
  search: { glyph: '⌕', color: '#9ad8ff' },      // ⌕ magnifier-ish
  task: { glyph: '❖', color: '#d8a3ff' },        // ❖ subtask
  permission: { glyph: '⚠', color: '#ff9255' },  // ⚠
  spark: { glyph: '∗', color: '#ffffff' },       // ∗
}

export function renderEffects(
  ctx: CanvasRenderingContext2D,
  effects: ToolEffect[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (effects.length === 0) return
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const fx of effects) {
    const t = fx.age / fx.lifetime
    if (t >= 1) continue
    // Float up + slight horizontal drift; ease-out alpha so fade is most visible at end.
    const rise = EFFECT_RISE_PX_PER_SEC * fx.age
    const driftX = fx.drift * t
    // Anchor above the head (head is roughly 24px above bottom-anchor y)
    const wx = fx.x + driftX
    const wy = fx.y - 22 - rise
    const px = offsetX + wx * zoom
    const py = offsetY + wy * zoom
    const meta = EFFECT_GLYPHS[fx.kind]
    const alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85
    const fontPx = Math.max(8, Math.round(8 * zoom * 0.9))
    ctx.font = `bold ${fontPx}px ui-monospace, "SF Mono", Menlo, monospace`
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha))
    // Soft shadow for legibility on busy floors
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillText(meta.glyph, px + 1, py + 1)
    ctx.fillStyle = meta.color
    ctx.fillText(meta.glyph, px, py)
  }
  ctx.restore()
}

export interface ButtonBounds {
  /** Center X in device pixels */
  cx: number
  /** Center Y in device pixels */
  cy: number
  /** Radius in device pixels */
  radius: number
}

export type DeleteButtonBounds = ButtonBounds
export type RotateButtonBounds = ButtonBounds

export interface EditorRenderState {
  showGrid: boolean
  ghostSprite: SpriteData | null
  ghostCol: number
  ghostRow: number
  ghostValid: boolean
  selectedCol: number
  selectedRow: number
  selectedW: number
  selectedH: number
  hasSelection: boolean
  isRotatable: boolean
  /** Updated each frame by renderDeleteButton */
  deleteButtonBounds: DeleteButtonBounds | null
  /** Updated each frame by renderRotateButton */
  rotateButtonBounds: RotateButtonBounds | null
  /** Whether to show ghost border (expansion tiles outside grid) */
  showGhostBorder: boolean
  /** Hovered ghost border tile col (-1 to cols) */
  ghostBorderHoverCol: number
  /** Hovered ghost border tile row (-1 to rows) */
  ghostBorderHoverRow: number
}

export interface SelectionRenderState {
  selectedAgentId: number | null
  hoveredAgentId: number | null
  hoveredTile: { col: number; row: number } | null
  seats: Map<string, Seat>
  characters: Map<number, Character>
}

export interface CampfireRenderState {
  fireTile: { col: number; row: number } | null
  woodLevel: number
  woodMax: number
  phase: 'growing' | 'full' | 'dancing' | 'burning_down' | 'egg' | 'hatching'
  /** performance.now() ms at which the current phase began — used to fade the dim
   *  overlay in/out at the dance boundaries. */
  phaseStartMs: number
}

export interface WizardRenderState {
  /** Desk fixture tiles (2 wide). */
  deskTiles: Array<{ col: number; row: number }>
  /** Wizard NPC standing tile. */
  standTile: { col: number; row: number }
  /** Blessing spot (front of line) — where the rune draws. */
  frontTile: { col: number; row: number }
  /** True while the wizard is actively blessing the head agent. */
  blessing: boolean
  /** performance.now() ms when the current blessing started (0 if idle). */
  blessStartMs: number
  /** When set, draw a summon bolt from the wizard to this seat tile until summonUntilMs. */
  summonTo: { col: number; row: number } | null
  summonUntilMs: number
}

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  tileMap: TileTypeVal[][],
  furniture: FurnitureInstance[],
  characters: Character[],
  zoom: number,
  panX: number,
  panY: number,
  selection?: SelectionRenderState,
  editor?: EditorRenderState,
  tileColors?: Array<FloorColor | null>,
  layoutCols?: number,
  layoutRows?: number,
  effects?: ToolEffect[],
  activePCTiles?: Array<{ col: number; row: number; agentId: number }>,
  timeMs?: number,
  portalRings?: PortalRing[],
  pingPongMatch?: PingPongMatchState | null,
  plantedFlowers?: Map<string, string>,
  plantingDurationMs?: number,
  animals?: ForestAnimal[],
  campfire?: CampfireRenderState,
  wizard?: WizardRenderState,
): { offsetX: number; offsetY: number } {
  // Clear
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)

  // Use layout dimensions (fallback to tileMap size)
  const cols = layoutCols ?? (tileMap.length > 0 ? tileMap[0].length : 0)
  const rows = layoutRows ?? tileMap.length

  // Center map in viewport + pan offset (integer device pixels)
  const mapW = cols * TILE_SIZE * zoom
  const mapH = rows * TILE_SIZE * zoom
  const offsetX = Math.floor((canvasWidth - mapW) / 2) + Math.round(panX)
  const offsetY = Math.floor((canvasHeight - mapH) / 2) + Math.round(panY)

  // Draw tiles (floor + wall base color)
  renderTileGrid(ctx, tileMap, offsetX, offsetY, zoom, tileColors, layoutCols)

  // Forest decor — flowers and mushrooms on the grass, drawn over the floor but under
  // furniture so taller items still occlude them naturally.
  renderFlowers(ctx, tileColors, cols, rows, offsetX, offsetY, zoom)
  renderMushrooms(ctx, tileColors, cols, rows, offsetX, offsetY, zoom)
  // Permanent flowers planted by idle agents.
  renderPlantedFlowers(ctx, plantedFlowers, offsetX, offsetY, zoom)
  // Sleeping dragon — drawn before the scene so agent sprites can render in front of him.
  renderSleepingDragon(ctx, offsetX, offsetY, zoom, timeMs ?? performance.now())

  // Spawn pad — glowing circle on lounge floor where new agents emerge.
  renderSpawnPad(ctx, offsetX, offsetY, zoom, timeMs ?? performance.now())

  // Swimming pool — drawn over floor, under furniture/characters so swimmers stand "in" it.
  renderPool(ctx, POOL_RECT, offsetX, offsetY, zoom, timeMs ?? performance.now())

  // Wizard scene — desk fixture, the pulsing blessing rune under the served agent, and the
  // summon bolt. Drawn under characters so the agent stands on/over the rune.
  if (wizard) {
    renderWizardScene(ctx, wizard, offsetX, offsetY, zoom, timeMs ?? performance.now())
  }

  // Desk-reveal/hide portal rings — drawn on the floor under furniture.
  if (portalRings && portalRings.length > 0) {
    renderPortalRings(ctx, portalRings, offsetX, offsetY, zoom, timeMs ?? performance.now())
  }

  // Seat indicators (below furniture/characters, on top of floor)
  if (selection) {
    renderSeatIndicators(ctx, selection.seats, selection.characters, selection.selectedAgentId, selection.hoveredTile, offsetX, offsetY, zoom)
  }

  // Build wall instances for z-sorting with furniture and characters
  const wallInstances = hasWallSprites()
    ? getWallInstances(tileMap, tileColors, layoutCols)
    : []
  const allFurniture = wallInstances.length > 0
    ? [...wallInstances, ...furniture]
    : furniture

  // Draw walls + furniture + characters (z-sorted)
  const selectedId = selection?.selectedAgentId ?? null
  const hoveredId = selection?.hoveredAgentId ?? null
  renderScene(ctx, allFurniture, characters, offsetX, offsetY, zoom, selectedId, hoveredId)

  // Screen-glow on active PCs (after furniture, under bubbles/effects)
  if (activePCTiles && activePCTiles.length > 0) {
    renderActivePCScreens(ctx, activePCTiles, offsetX, offsetY, zoom, timeMs ?? performance.now())
    renderActivePCSparkles(ctx, activePCTiles, offsetX, offsetY, zoom, timeMs ?? performance.now())
    renderMergeBeams(ctx, activePCTiles, offsetX, offsetY, zoom, timeMs ?? performance.now())
    // When ALL 4 hero PCs are simultaneously in use, summon the energy spirit floating
    // between the beams + raise the flanking knights' swords. Vanishes the frame any one
    // of them stops.
    const heroActiveCount = activePCTiles.filter((t) => HERO_PC_COLS.has(t.col) && HERO_PC_ROWS.has(t.row)).length
    if (heroActiveCount >= 4) {
      renderEnergySpirit(ctx, offsetX, offsetY, zoom, timeMs ?? performance.now())
      renderRaisedSwords(ctx, offsetX, offsetY, zoom, timeMs ?? performance.now())
    }
  }
  // Hero PCs without a seated agent show a "charging up" idle effect — runs every frame
  // regardless of whether anyone is active, so empty hero PCs always look alive.
  renderChargingPCs(ctx, activePCTiles ?? [], offsetX, offsetY, zoom, timeMs ?? performance.now())

  // Planting-in-progress sprout above any character currently planting.
  renderPlantingProgress(ctx, characters, offsetX, offsetY, zoom, plantingDurationMs ?? 2200)

  // Carried logs — drawn above the character sprite for agents fetching wood.
  renderCarriedLogs(ctx, characters, offsetX, offsetY, zoom)

  // Forest animals — drawn over the scene so they're always visible (small sprites).
  renderAnimals(ctx, animals, offsetX, offsetY, zoom, timeMs ?? performance.now())

  // Sun beam — cast over everything with low alpha so the meadow looks lit from above.
  renderSunBeam(ctx, canvasWidth, canvasHeight, timeMs ?? performance.now())

  // Bouncing ball between two ping-pong players (under bubbles, above furniture).
  // Pauses on the loser's side during 'scoring' / 'celebrating' phases.
  renderPingPongBall(ctx, characters, offsetX, offsetY, zoom, timeMs ?? performance.now(), pingPongMatch ?? null)

  // Scoreboard above the ping-pong table (only while a match is live).
  renderPingPongScoreboard(ctx, pingPongMatch ?? null, offsetX, offsetY, zoom)

  // Winner celebration — floating ★ above their head during the celebrating phase.
  renderPingPongCelebration(ctx, characters, pingPongMatch ?? null, offsetX, offsetY, zoom, timeMs ?? performance.now())

  // Chess thinking dots — above chess players' heads while they "play".
  renderChessActivity(ctx, characters, offsetX, offsetY, zoom, timeMs ?? performance.now())

  // Pool foreground water — drawn AFTER characters so swimmers look submerged from the
  // waist down. Drawn before bubbles/effects so those still float above.
  renderPoolForeground(ctx, POOL_RECT, offsetX, offsetY, zoom, timeMs ?? performance.now())

  // Dance dim — vignette around the bonfire while the ritual is dancing. Must come
  // BEFORE the flame pass so the fire renders on top of the darkened scene.
  renderDanceDim(ctx, canvasWidth, canvasHeight, offsetX, offsetY, zoom, timeMs ?? performance.now(), campfire)

  // Campfire flames — drawn over scene (and on top of any dance-dim) so the bonfire
  // dominates the frame during the ritual.
  renderCampfireFlames(ctx, offsetX, offsetY, zoom, timeMs ?? performance.now(), campfire)

  // Speech bubbles (always on top of characters)
  renderBubbles(ctx, characters, offsetX, offsetY, zoom)

  // Tool reaction effects (above everything)
  if (effects && effects.length > 0) {
    renderEffects(ctx, effects, offsetX, offsetY, zoom)
  }

  // Editor overlays
  if (editor) {
    if (editor.showGrid) {
      renderGridOverlay(ctx, offsetX, offsetY, zoom, cols, rows, tileMap)
    }
    if (editor.showGhostBorder) {
      renderGhostBorder(ctx, offsetX, offsetY, zoom, cols, rows, editor.ghostBorderHoverCol, editor.ghostBorderHoverRow)
    }
    if (editor.ghostSprite && editor.ghostCol >= 0) {
      renderGhostPreview(ctx, editor.ghostSprite, editor.ghostCol, editor.ghostRow, editor.ghostValid, offsetX, offsetY, zoom)
    }
    if (editor.hasSelection) {
      renderSelectionHighlight(ctx, editor.selectedCol, editor.selectedRow, editor.selectedW, editor.selectedH, offsetX, offsetY, zoom)
      editor.deleteButtonBounds = renderDeleteButton(ctx, editor.selectedCol, editor.selectedRow, editor.selectedW, editor.selectedH, offsetX, offsetY, zoom)
      if (editor.isRotatable) {
        editor.rotateButtonBounds = renderRotateButton(ctx, editor.selectedCol, editor.selectedRow, editor.selectedW, editor.selectedH, offsetX, offsetY, zoom)
      } else {
        editor.rotateButtonBounds = null
      }
    } else {
      editor.deleteButtonBounds = null
      editor.rotateButtonBounds = null
    }
  }

  return { offsetX, offsetY }
}

function renderWizardScene(
  ctx: CanvasRenderingContext2D,
  w: WizardRenderState,
  offsetX: number,
  offsetY: number,
  zoom: number,
  timeMs: number,
): void {
  const px = (col: number) => offsetX + col * TILE_SIZE * zoom
  const py = (row: number) => offsetY + row * TILE_SIZE * zoom
  const ts = TILE_SIZE * zoom

  // Desk fixture — a dark wood counter across the 2 desk tiles.
  for (const t of w.deskTiles) {
    ctx.fillStyle = '#4a3526'
    ctx.fillRect(px(t.col), py(t.row) + ts * 0.35, ts, ts * 0.5)
    ctx.fillStyle = '#5e4632'
    ctx.fillRect(px(t.col), py(t.row) + ts * 0.3, ts, ts * 0.12)
  }

  // Blessing rune — a pulsing magic circle under the agent at the front tile.
  if (w.blessing) {
    const t = (timeMs - w.blessStartMs) / 1000
    const cx = px(w.frontTile.col) + ts / 2
    const cy = py(w.frontTile.row) + ts / 2
    const r = ts * (0.38 + 0.06 * Math.sin(t * 6))
    ctx.save()
    ctx.globalAlpha = 0.55 + 0.25 * Math.sin(t * 6)
    ctx.strokeStyle = '#9b7bff'
    ctx.lineWidth = 2 * zoom
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2); ctx.stroke()
    // a few orbiting sparkle dots
    for (let i = 0; i < 6; i++) {
      const a = t * 3 + (i * Math.PI) / 3
      ctx.fillStyle = '#d8c8ff'
      ctx.fillRect(cx + Math.cos(a) * r - zoom, cy + Math.sin(a) * r - zoom, 2 * zoom, 2 * zoom)
    }
    ctx.restore()
  }

  // Summon beam — fired from the wizard's glowing staff tip to the agent's seat.
  if (w.summonTo && timeMs < w.summonUntilMs) {
    const SUMMON_VIS_MS = 900 // must match OfficeState's wizardSummonUntilMs window
    // Staff-tip origin: mirrors the purple glow drawn in drawWizardOverlay
    // (head anchor = tile-centre; tip = +7.5px x, headY-11px → +15.5, -19 from tile origin).
    const STAFF_TIP_DX = 15.5
    const STAFF_TIP_DY = -19
    const p = Math.max(0, Math.min(1, (SUMMON_VIS_MS - (w.summonUntilMs - timeMs)) / SUMMON_VIS_MS))

    const sx = px(w.standTile.col) + STAFF_TIP_DX * zoom
    const sy = py(w.standTile.row) + STAFF_TIP_DY * zoom
    const ex = px(w.summonTo.col) + ts / 2
    const ey = py(w.summonTo.row) + ts / 2
    const cxq = (sx + ex) / 2
    const cyq = Math.min(sy, ey) - ts * 1.2 // bow the arc upward
    const bez = (t: number) => ({
      x: (1 - t) * (1 - t) * sx + 2 * (1 - t) * t * cxq + t * t * ex,
      y: (1 - t) * (1 - t) * sy + 2 * (1 - t) * t * cyq + t * t * ey,
    })

    ctx.save()
    ctx.lineCap = 'round'
    const beamAlpha = Math.sin(Math.min(1, p / 0.85) * Math.PI) // grow in, fade out

    // Three stacked strokes: soft outer glow → mid → bright core.
    const stroke = (color: string, width: number, alpha: number) => {
      ctx.globalAlpha = alpha * beamAlpha
      ctx.strokeStyle = color
      ctx.lineWidth = width * zoom
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.quadraticCurveTo(cxq, cyq, ex, ey)
      ctx.stroke()
    }
    stroke('#7b5cff', 7, 0.3)
    stroke('#bda6ff', 3.5, 0.65)
    stroke('#ffffff', 1.3, 1)

    // Muzzle flash at the staff tip — bright burst that blooms then fades.
    const flash = Math.max(0, 1 - p / 0.4)
    if (flash > 0) {
      const fr = (3 + 6 * (1 - flash)) * zoom
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, fr)
      g.addColorStop(0, 'rgba(255,255,255,1)')
      g.addColorStop(0.45, 'rgba(189,166,255,0.9)')
      g.addColorStop(1, 'rgba(123,92,255,0)')
      ctx.globalAlpha = flash
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(sx, sy, fr, 0, Math.PI * 2)
      ctx.fill()
    }

    // Travelling spark riding the beam from tip → seat (arrives by ~60%).
    const tt = Math.min(1, p / 0.6)
    const spk = bez(tt)
    const sg = ctx.createRadialGradient(spk.x, spk.y, 0, spk.x, spk.y, 4.5 * zoom)
    sg.addColorStop(0, 'rgba(255,255,255,1)')
    sg.addColorStop(1, 'rgba(189,166,255,0)')
    ctx.globalAlpha = beamAlpha
    ctx.fillStyle = sg
    ctx.beginPath()
    ctx.arc(spk.x, spk.y, 4.5 * zoom, 0, Math.PI * 2)
    ctx.fill()

    // Landing burst at the seat once the spark arrives — expanding ring + star sparks.
    if (p > 0.5) {
      const bp = Math.min(1, (p - 0.5) / 0.5)
      ctx.globalAlpha = (1 - bp) * 0.9
      ctx.strokeStyle = '#d8c8ff'
      ctx.lineWidth = 2 * zoom
      ctx.beginPath()
      ctx.arc(ex, ey, (2 + 11 * bp) * zoom, 0, Math.PI * 2)
      ctx.stroke()
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3
        const rr = (4 + 10 * bp) * zoom
        ctx.globalAlpha = 1 - bp
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(ex + Math.cos(a) * rr - zoom, ey + Math.sin(a) * rr - zoom, 2 * zoom, 2 * zoom)
      }
    }
    ctx.restore()
  }
}

/** Pointy hat + staff drawn over the base sprite for the wizard NPC.
 *  `headX`/`headY` are the head anchor in screen space (sprite top-center area). */
function drawWizardOverlay(
  ctx: CanvasRenderingContext2D,
  headX: number,
  headY: number,
  zoom: number,
): void {
  const u = zoom // 1px in screen space
  // Pointy purple hat sitting on the head.
  ctx.fillStyle = '#3b2a6b'
  ctx.beginPath()
  ctx.moveTo(headX, headY - 16 * u)
  ctx.lineTo(headX - 6 * u, headY - 4 * u)
  ctx.lineTo(headX + 6 * u, headY - 4 * u)
  ctx.closePath()
  ctx.fill()
  // Hat brim + a star.
  ctx.fillRect(headX - 7 * u, headY - 5 * u, 14 * u, 2 * u)
  ctx.fillStyle = '#ffe27a'
  ctx.fillRect(headX - u, headY - 11 * u, 2 * u, 2 * u)
  // Staff with a glowing tip, held to the right.
  ctx.fillStyle = '#6b4a2a'
  ctx.fillRect(headX + 7 * u, headY - 10 * u, 1.5 * u, 16 * u)
  ctx.fillStyle = '#bda6ff'
  ctx.beginPath()
  ctx.arc(headX + 7.5 * u, headY - 11 * u, 2.5 * u, 0, Math.PI * 2)
  ctx.fill()
}

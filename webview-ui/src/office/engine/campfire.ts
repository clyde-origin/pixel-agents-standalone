// Pure campfire-ritual state machine + geometry. No DOM/canvas — unit-testable.
import type { OfficeLayout } from '../types.js'

export type CampfirePhase =
  | 'growing'      // accepting wood
  | 'full'         // fire maxed; recruiting dancers
  | 'dancing'      // ring dance in progress
  | 'burning_down' // shrinking to embers
  | 'egg'          // egg sitting in the ashes
  | 'hatching'     // transient: spawn the dragon, then reset

export interface Tile { col: number; row: number }

export interface CampfireState {
  phase: CampfirePhase
  woodLevel: number          // 0..WOOD_TO_FULL
  woodReserved: number       // logs claimed/in-flight, not yet dropped
  phaseStartMs: number       // when the current phase began (performance.now ms)
  rotateAtMs: number         // next clockwise dancer rotation
  dancers: number[]          // agent ids on the ring, in slot order
}

// ── Tunable constants (grouped) ──
export const WOOD_TO_FULL = 8
export const MIN_DANCERS = 2
export const FULL_GRACE_MS = 8_000
export const DANCE_DURATION_MS = 120_000 // 2 minutes
export const ROTATE_INTERVAL_MS = 3_000
export const BURNDOWN_DURATION_MS = 4_000
export const HATCH_DELAY_MS = 15_000
export const DROP_DURATION_MS = 1_500
/** Hard cap as a safety net — `computeDanceSlots` expands rings outward until either
 *  enough walkable tiles are found or this many slots are collected. */
export const MAX_DANCERS = 64

// 3×3 core occupied by the fire + stumps (relative to the fire tile).
function inCore(fire: Tile, col: number, row: number): boolean {
  return Math.abs(col - fire.col) <= 1 && Math.abs(row - fire.row) <= 1
}

export function createCampfireState(): CampfireState {
  return {
    phase: 'growing',
    woodLevel: 0,
    woodReserved: 0,
    phaseStartMs: 0,
    rotateAtMs: 0,
    dancers: [],
  }
}

/** Read the campfire furniture tile from a layout, or null if none. */
export function resolveFireTile(layout: Pick<OfficeLayout, 'furniture'>): Tile | null {
  for (const f of layout.furniture) {
    if ((f.type as string) === 'campfire') return { col: f.col, row: f.row }
  }
  return null
}

/** Pick a walkable woodpile tile a few tiles from the fire. Scans an outward ring
 *  starting east of the core; deterministic (returns the first walkable hit). */
export function resolveWoodpileTile(
  fire: Tile,
  isWalkable: (col: number, row: number) => boolean,
): Tile | null {
  const offsets: Tile[] = []
  for (let d = 2; d <= 5; d++) {
    offsets.push({ col: fire.col + d, row: fire.row })
    offsets.push({ col: fire.col + d, row: fire.row + 1 })
    offsets.push({ col: fire.col + d, row: fire.row - 1 })
    offsets.push({ col: fire.col - d, row: fire.row })
    offsets.push({ col: fire.col, row: fire.row + d })
  }
  for (const o of offsets) {
    if (inCore(fire, o.col, o.row)) continue
    if (isWalkable(o.col, o.row)) return o
  }
  return null
}

/** Ordered ring of walkable tiles around the 3×3 core, expanding outward shell-by-shell
 *  until MAX_DANCERS is reached or shells are exhausted. Tiles within a shell are sorted
 *  clockwise; outer shells follow inner ones, so a partially-filled ring stays tight. */
export function computeDanceSlots(
  fire: Tile,
  isWalkable: (col: number, row: number) => boolean,
): Tile[] {
  const slots: Tile[] = []
  // Dancers start on shell 2 (just outside the wood-drop tiles in the 3×3 core) and
  // expand outward. Cap shells at a generous depth so even a packed office finds a seat.
  for (let shell = 2; shell <= 8 && slots.length < MAX_DANCERS; shell++) {
    const ring: Tile[] = []
    for (let dc = -shell; dc <= shell; dc++) {
      for (let dr = -shell; dr <= shell; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== shell) continue
        const col = fire.col + dc
        const row = fire.row + dr
        if (!isWalkable(col, row)) continue
        ring.push({ col, row })
      }
    }
    ring.sort((a, b) => angleCW(fire, a) - angleCW(fire, b))
    for (const t of ring) {
      if (slots.length >= MAX_DANCERS) break
      slots.push(t)
    }
  }
  return slots
}

function angleCW(fire: Tile, t: Tile): number {
  const a = Math.atan2(t.col - fire.col, -(t.row - fire.row))
  return a < 0 ? a + Math.PI * 2 : a
}

export interface CampfireContext {
  nowMs: number
  dancerCount: number // agents currently seated on the ring
}

export type CampfireEvent =
  | 'start_dancing'
  | 'rotate'
  | 'start_burndown'
  | 'lay_egg'
  | 'hatch'

/** Record one dropped log. Increments wood; flips to 'full' at the cap. */
export function addWood(state: CampfireState, nowMs: number): CampfireState {
  if (state.phase !== 'growing') return state
  const woodLevel = Math.min(WOOD_TO_FULL, state.woodLevel + 1)
  if (woodLevel >= WOOD_TO_FULL) {
    return { ...state, woodLevel, phase: 'full', phaseStartMs: nowMs }
  }
  return { ...state, woodLevel }
}

/** Advance time-based phases. Returns the new state + any side-effect events for
 *  OfficeState to act on (recruit/rotate dancers, spawn egg/dragon). */
export function advanceCampfire(
  state: CampfireState,
  _dtMs: number,
  ctx: CampfireContext,
): { state: CampfireState; events: CampfireEvent[] } {
  const events: CampfireEvent[] = []
  const elapsed = ctx.nowMs - state.phaseStartMs
  let s = state

  switch (s.phase) {
    case 'full': {
      const enough = ctx.dancerCount >= MIN_DANCERS
      const graced = elapsed >= FULL_GRACE_MS && ctx.dancerCount >= 1
      if (enough || graced) {
        s = { ...s, phase: 'dancing', phaseStartMs: ctx.nowMs, rotateAtMs: ctx.nowMs + ROTATE_INTERVAL_MS }
        events.push('start_dancing')
      }
      break
    }
    case 'dancing': {
      if (ctx.nowMs >= s.rotateAtMs) {
        s = { ...s, rotateAtMs: ctx.nowMs + ROTATE_INTERVAL_MS }
        events.push('rotate')
      }
      if (elapsed >= DANCE_DURATION_MS) {
        s = { ...s, phase: 'burning_down', phaseStartMs: ctx.nowMs }
        events.push('start_burndown')
      }
      break
    }
    case 'burning_down': {
      if (elapsed >= BURNDOWN_DURATION_MS) {
        s = { ...s, phase: 'egg', phaseStartMs: ctx.nowMs }
        events.push('lay_egg')
      }
      break
    }
    case 'egg': {
      if (elapsed >= HATCH_DELAY_MS) {
        s = { ...s, phase: 'growing', phaseStartMs: ctx.nowMs, woodLevel: 0, dancers: [] }
        events.push('hatch')
      }
      break
    }
    // 'growing' and 'hatching' have no time-based transition here.
  }
  return { state: s, events }
}

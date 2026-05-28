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
export const MAX_DANCERS = 8

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

/** Ordered (clockwise) ring of up to MAX_DANCERS walkable tiles around the 3×3 core. */
export function computeDanceSlots(
  fire: Tile,
  isWalkable: (col: number, row: number) => boolean,
): Tile[] {
  // The four immediate edge tiles are wood-drop tiles inside the 3×3 core; dancers
  // ring the fire on the next shell out (Chebyshev distance 2), so we enumerate only
  // that shell — every tile on it is outside the core by construction.
  const candidates: Tile[] = []
  for (let dc = -2; dc <= 2; dc++) {
    for (let dr = -2; dr <= 2; dr++) {
      if (Math.max(Math.abs(dc), Math.abs(dr)) !== 2) continue
      const col = fire.col + dc
      const row = fire.row + dr
      if (!isWalkable(col, row)) continue
      candidates.push({ col, row })
    }
  }
  candidates.sort((a, b) => angleCW(fire, a) - angleCW(fire, b))
  return candidates.slice(0, MAX_DANCERS)
}

function angleCW(fire: Tile, t: Tile): number {
  const a = Math.atan2(t.col - fire.col, -(t.row - fire.row))
  return a < 0 ? a + Math.PI * 2 : a
}

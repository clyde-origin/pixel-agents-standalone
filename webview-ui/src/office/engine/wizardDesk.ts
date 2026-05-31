// Pure wizard-blessing queue + geometry. No DOM/canvas — unit-testable.

export interface Tile { col: number; row: number }

export type WizardPhase =
  | 'idle'      // no one being served, or head walking to the blessing spot
  | 'blessing'  // head is on the spot; rune pulses, then the summon bolt fires

export interface WizardState {
  queue: number[]          // agent ids; index 0 = head (being served / arriving)
  phase: WizardPhase
  servingId: number | null // the agent currently at the head
  servingSince: number     // performance.now() ms when servingId last changed
  blessTimer: number       // ms remaining in the current blessing
  casted: boolean          // has 'cast_summon' fired for this blessing yet
}

// ── Tunable constants ──
export const BLESS_MS = 1800
/** Fire the summon bolt this many ms before the blessing completes. */
export const CAST_REMAINING_MS = 700
/** A head that never reaches the blessing spot is evicted to its seat after this. */
export const SAFETY_TIMEOUT_MS = 20_000
/** Cap on the rendered/queued line length. */
export const MAX_LINE = 12

export function createWizardState(): WizardState {
  return {
    queue: [],
    phase: 'idle',
    servingId: null,
    servingSince: 0,
    blessTimer: 0,
    casted: false,
  }
}

/** Add an agent to the back of the line (idempotent). */
export function enqueue(state: WizardState, id: number): void {
  if (!state.queue.includes(id)) state.queue.push(id)
}

/** Remove an agent from anywhere in the line. */
export function dequeue(state: WizardState, id: number): void {
  const i = state.queue.indexOf(id)
  if (i !== -1) state.queue.splice(i, 1)
  if (state.servingId === id) {
    state.servingId = null
    state.phase = 'idle'
    state.casted = false
  }
}

/** Ordered single-file line walking SOUTH from the blessing spot (index 0).
 *  Non-walkable rows are skipped so the line stays in one column. */
export function computeLineupTiles(
  frontTile: Tile,
  isWalkable: (col: number, row: number) => boolean,
  maxLen: number = MAX_LINE,
): Tile[] {
  const tiles: Tile[] = []
  let row = frontTile.row
  // Tolerate up to MAX_LINE blocked rows before giving up the scan.
  const limit = frontTile.row + maxLen + MAX_LINE
  while (tiles.length < maxLen && row < limit) {
    if (isWalkable(frontTile.col, row)) tiles.push({ col: frontTile.col, row })
    row++
  }
  return tiles
}

export interface WizardContext {
  nowMs: number
  /** Is the head agent standing on the blessing spot (line index 0)? */
  headArrived: boolean
}

export type WizardEvent = 'start_blessing' | 'cast_summon' | 'release' | 'evict'

/** Advance the queue/blessing state machine. Mutates `state`; returns side-effect
 *  events for OfficeState to act on (summon the desk, send the head to its seat). */
export function advanceWizard(
  state: WizardState,
  dtMs: number,
  ctx: WizardContext,
): WizardEvent[] {
  const events: WizardEvent[] = []

  if (state.queue.length === 0) {
    state.phase = 'idle'
    state.servingId = null
    state.casted = false
    return events
  }

  const head = state.queue[0]
  if (state.servingId !== head) {
    state.servingId = head
    state.servingSince = ctx.nowMs
    state.phase = 'idle'
    state.blessTimer = 0
    state.casted = false
  }

  if (state.phase === 'idle') {
    if (ctx.headArrived) {
      state.phase = 'blessing'
      state.blessTimer = BLESS_MS
      state.casted = false
      events.push('start_blessing')
    } else if (ctx.nowMs - state.servingSince > SAFETY_TIMEOUT_MS) {
      events.push('evict')
      state.queue.shift()
      state.servingId = null
    }
  } else {
    // blessing
    state.blessTimer -= dtMs
    if (!state.casted && state.blessTimer <= CAST_REMAINING_MS) {
      state.casted = true
      events.push('cast_summon')
    }
    if (state.blessTimer <= 0) {
      events.push('release')
      state.queue.shift()
      state.servingId = null
      state.phase = 'idle'
      state.casted = false
    }
  }

  return events
}

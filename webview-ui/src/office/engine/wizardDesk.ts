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
  state.queue = state.queue.filter((q) => q !== id)
  if (state.servingId === id) {
    state.servingId = null
    state.phase = 'idle'
    state.casted = false
  }
}

# Wizard Blessing Ceremony Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a wizard NPC behind a desk at the lounge↔workstation boundary; every agent (main + subagent) must line up single-file after appearing, receive a pulsing-rune blessing, and have its computer summoned (wand-bolt → desk reveal) before walking to its station — on first appearance and on every reactivation.

**Architecture:** Mirror the campfire ritual exactly. A new pure, DOM-free, unit-tested state machine `wizardDesk.ts` owns the queue + blessing phases and the lineup geometry. `officeState.ts` injects a persistent wizard NPC (like the greeters), resolves the desk/line geometry from constants, drives the queue from a `tickWizard()` (like `tickCampfire()`), and adds a `wizard_blessing` trip mode. `renderer.ts` draws the desk, the wizard adornments, the rune, and the summon bolt.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Vitest (`node_modules/.bin/vitest run`), procedural canvas rendering. Webview typecheck: `cd webview-ui && npx tsc --noEmit`.

---

## Key facts grounded from the codebase (read before starting)

- **Spawn flow today** (`officeState.ts`): `materializeAgent` (≈605) places a new agent at the pad `(PAD_COL=9, PAD_ROW=33)`, sets `CharacterState.SPAWNING`, `matrixEffect='spawn'`. The update loop (≈2516) runs the matrix effect → on completion kicks off the spin (≈2527) → greeter high-five (≈2543/2590) → on SPAWNING-complete snaps back to the pad (≈2610). After that, the generic trip reconciliation (≈2620) and `desiredTripFor` (≈2241) route the agent.
- **Greeters are code-injected** in `ensureGreeter()` (≈159) — NOT layout furniture. Sentinels `GREETER_ID=-1000000`, `GREETER2_ID=-1000001`. They are skipped everywhere via `if (ch.isGreeter) continue`.
- **Trip system**: `startTrip(ch, type)` (≈2126) picks a target tile, pathfinds, reserves `occupiedTripTiles`, sets `tripMode`/`tripTile`, backs up `originalSeatId`. `endTrip(ch)` (≈2203) frees the tile and walks the agent back to `originalSeatId`. `desiredTripFor(ch)` (≈2241) returns the wanted mode; the update loop reconciles `desired !== ch.tripMode`.
- **Campfire pattern** (the model): pure `campfire.ts` + `tickCampfire`/`recruitDancers`/`rotateDancers`/`releaseDancers` (≈1808–1920). Two-phase release/reassign in `rotateDancers` avoids slot-swap deadlock. Geometry resolved in `resolveCampfireGeometry()` (≈431), reset in `rebuildFromLayout()` (≈349).
- **Desk reveal** ("magical computer summon"): `revealNextDesk()` (≈1099) adds a `gid` to `revealedDeskIds` and sets a `'reveal'` entry in `deskAnimations` (alpha ramp 0→1). Today it is triggered during seat assignment, only when no free revealed seat exists (`if (!free && this.revealNextDesk())` at ≈544 and ≈601). We relocate that trigger to the wizard's cast moment.
- **`rebuildVisibleState()`** (≈1053) recomputes `this.blockedTiles = getBlockedTiles(visible)` then `this.walkableTiles = getWalkableTiles(...)`.
- **`renderFrame(...)`** (renderer.ts ≈2304) is a long positional-arg function ending in `campfire?: CampfireRenderState`. The single call site is `OfficeCanvas.tsx` ≈233 (ends `campfireRender,`).
- **Value-import trap**: `TileType`, `Direction`, `CharacterState` are already imported as values in `officeState.ts` (used as `.WALL`, `.DOWN`, etc.). Keep it that way in any file that uses their members.
- **Layout landmarks**: lounge rows 24–34 (tile 2), workstations rows 1–23 (tile 1, stations cols 1–6 & 13–18, central corridor cols 7–12 open). Coffee table at `(9,26)`. Chosen wizard column **10** keeps the southward line clear.

---

## File structure

- **Create** `webview-ui/src/office/engine/wizardDesk.ts` — pure queue/blessing state machine + `computeLineupTiles` geometry. DOM-free, unit-tested.
- **Create** `webview-ui/src/office/engine/__tests__/wizardDesk.test.ts` — unit tests for the module.
- **Modify** `webview-ui/src/office/types.ts` — add `'wizard_blessing'` to the `tripMode` union; add `isWizard?` and `needsBlessing?` Character fields.
- **Modify** `webview-ui/src/office/engine/officeState.ts` — wizard NPC injection, geometry resolution + desk blocking, queue integration (`tickWizard`, `startTrip` case, `desiredTripFor` priority, blessing tick, teardown), reactivation/spawn/subagent seams, `rebuildFromLayout` reset, summon trigger, render-state getter.
- **Modify** `webview-ui/src/office/engine/renderer.ts` — `WizardRenderState` interface, append `wizard?` param to `renderFrame`, `renderWizardScene` (desk + rune + bolt), `drawWizardOverlay` (hat/staff on the wizard NPC sprite).
- **Modify** `webview-ui/src/office/components/OfficeCanvas.tsx` — build `wizardRender` and pass it as the new last arg to `renderFrame`.

---

## Task 1: Pure `wizardDesk.ts` — types, state, enqueue/dequeue

**Files:**
- Create: `webview-ui/src/office/engine/wizardDesk.ts`
- Test: `webview-ui/src/office/engine/__tests__/wizardDesk.test.ts`

- [ ] **Step 1: Write the failing test**

Create `webview-ui/src/office/engine/__tests__/wizardDesk.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  createWizardState,
  enqueue,
  dequeue,
} from '../wizardDesk.js'

describe('createWizardState', () => {
  it('starts idle with an empty queue', () => {
    const s = createWizardState()
    expect(s.phase).toBe('idle')
    expect(s.queue).toEqual([])
    expect(s.servingId).toBeNull()
    expect(s.casted).toBe(false)
  })
})

describe('enqueue', () => {
  it('appends ids in order and is idempotent', () => {
    const s = createWizardState()
    enqueue(s, 7)
    enqueue(s, 9)
    enqueue(s, 7) // duplicate ignored
    expect(s.queue).toEqual([7, 9])
  })
})

describe('dequeue', () => {
  it('removes an id from anywhere in the line', () => {
    const s = createWizardState()
    enqueue(s, 1); enqueue(s, 2); enqueue(s, 3)
    dequeue(s, 2)
    expect(s.queue).toEqual([1, 3])
  })
  it('clears servingId when the served head leaves', () => {
    const s = createWizardState()
    enqueue(s, 1)
    s.servingId = 1
    dequeue(s, 1)
    expect(s.queue).toEqual([])
    expect(s.servingId).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run webview-ui/src/office/engine/__tests__/wizardDesk.test.ts`
Expected: FAIL — `Failed to resolve import "../wizardDesk.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `webview-ui/src/office/engine/wizardDesk.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run webview-ui/src/office/engine/__tests__/wizardDesk.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/office/engine/wizardDesk.ts webview-ui/src/office/engine/__tests__/wizardDesk.test.ts
git commit -m "feat(wizard): pure WizardState + enqueue/dequeue"
```

---

## Task 2: `wizardDesk.ts` — `computeLineupTiles` geometry

**Files:**
- Modify: `webview-ui/src/office/engine/wizardDesk.ts`
- Test: `webview-ui/src/office/engine/__tests__/wizardDesk.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `wizardDesk.test.ts`:

```ts
import { computeLineupTiles } from '../wizardDesk.js'

describe('computeLineupTiles', () => {
  const front = { col: 10, row: 25 }
  it('walks south from the blessing spot, all walkable', () => {
    const tiles = computeLineupTiles(front, () => true, 4)
    expect(tiles).toEqual([
      { col: 10, row: 25 },
      { col: 10, row: 26 },
      { col: 10, row: 27 },
      { col: 10, row: 28 },
    ])
  })
  it('skips blocked tiles but stays in the same column', () => {
    const blocked = new Set(['10,26'])
    const tiles = computeLineupTiles(front, (c, r) => !blocked.has(`${c},${r}`), 3)
    expect(tiles).toEqual([
      { col: 10, row: 25 },
      { col: 10, row: 27 },
      { col: 10, row: 28 },
    ])
  })
  it('caps at maxLen', () => {
    expect(computeLineupTiles(front, () => true, 2)).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run webview-ui/src/office/engine/__tests__/wizardDesk.test.ts`
Expected: FAIL — `computeLineupTiles is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `wizardDesk.ts`:

```ts
/** Ordered single-file line walking SOUTH from the blessing spot (index 0).
 *  Non-walkable rows are skipped so the line stays in one column. */
export function computeLineupTiles(
  frontTile: Tile,
  isWalkable: (col: number, row: number) => boolean,
  maxLen: number = MAX_LINE,
): Tile[] {
  const tiles: Tile[] = []
  let row = frontTile.row
  const limit = frontTile.row + maxLen + 12 // scan a bit past in case of gaps
  while (tiles.length < maxLen && row < limit) {
    if (isWalkable(frontTile.col, row)) tiles.push({ col: frontTile.col, row })
    row++
  }
  return tiles
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run webview-ui/src/office/engine/__tests__/wizardDesk.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/office/engine/wizardDesk.ts webview-ui/src/office/engine/__tests__/wizardDesk.test.ts
git commit -m "feat(wizard): computeLineupTiles geometry"
```

---

## Task 3: `wizardDesk.ts` — `advanceWizard` reducer

**Files:**
- Modify: `webview-ui/src/office/engine/wizardDesk.ts`
- Test: `webview-ui/src/office/engine/__tests__/wizardDesk.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `wizardDesk.test.ts`:

```ts
import {
  advanceWizard,
  BLESS_MS,
  CAST_REMAINING_MS,
  SAFETY_TIMEOUT_MS,
} from '../wizardDesk.js'

describe('advanceWizard', () => {
  it('does nothing on an empty queue', () => {
    const s = createWizardState()
    expect(advanceWizard(s, 16, { nowMs: 1000, headArrived: false })).toEqual([])
    expect(s.phase).toBe('idle')
  })

  it('starts blessing when the head arrives', () => {
    const s = createWizardState()
    enqueue(s, 5)
    const ev = advanceWizard(s, 16, { nowMs: 1000, headArrived: true })
    expect(ev).toContain('start_blessing')
    expect(s.phase).toBe('blessing')
    expect(s.blessTimer).toBe(BLESS_MS)
  })

  it('waits (no blessing) while the head has not arrived', () => {
    const s = createWizardState()
    enqueue(s, 5)
    const ev = advanceWizard(s, 16, { nowMs: 1000, headArrived: false })
    expect(ev).toEqual([])
    expect(s.phase).toBe('idle')
    expect(s.servingId).toBe(5)
  })

  it('fires cast_summon once, then release, popping the head', () => {
    const s = createWizardState()
    enqueue(s, 5); enqueue(s, 6)
    advanceWizard(s, 16, { nowMs: 0, headArrived: true }) // start_blessing
    // advance to just past the cast threshold
    const toCast = BLESS_MS - CAST_REMAINING_MS + 1
    const e1 = advanceWizard(s, toCast, { nowMs: toCast, headArrived: true })
    expect(e1).toContain('cast_summon')
    expect(s.casted).toBe(true)
    // a second tick before completion does NOT re-cast
    const e2 = advanceWizard(s, 10, { nowMs: toCast + 10, headArrived: true })
    expect(e2).not.toContain('cast_summon')
    // finish the blessing
    const e3 = advanceWizard(s, CAST_REMAINING_MS, { nowMs: BLESS_MS + 100, headArrived: true })
    expect(e3).toContain('release')
    expect(s.queue).toEqual([6])
    expect(s.servingId).toBeNull()
    expect(s.phase).toBe('idle')
  })

  it('evicts a head that never arrives after the safety timeout', () => {
    const s = createWizardState()
    enqueue(s, 5)
    advanceWizard(s, 16, { nowMs: 0, headArrived: false }) // servingSince = 0
    const ev = advanceWizard(s, 16, { nowMs: SAFETY_TIMEOUT_MS + 1, headArrived: false })
    expect(ev).toContain('evict')
    expect(s.queue).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run webview-ui/src/office/engine/__tests__/wizardDesk.test.ts`
Expected: FAIL — `advanceWizard is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `wizardDesk.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run webview-ui/src/office/engine/__tests__/wizardDesk.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/office/engine/wizardDesk.ts webview-ui/src/office/engine/__tests__/wizardDesk.test.ts
git commit -m "feat(wizard): advanceWizard reducer (blessing + summon + evict)"
```

---

## Task 4: Types — trip mode + Character flags

**Files:**
- Modify: `webview-ui/src/office/types.ts:245` (tripMode union), and the Character flags block (≈260)

- [ ] **Step 1: Add the trip mode and flags**

In `webview-ui/src/office/types.ts`, change the `tripMode` line (245):

```ts
  tripMode: 'beanbag' | 'bookshelf' | 'pacing' | 'ping_pong' | 'chess' | 'pool' | 'planting' | 'campfire_wood' | 'campfire_dance' | 'wizard_blessing' | null
```

And in the optional-flags block near `isGreeter?` / `greeterVariant?` (≈260), add:

```ts
  /** True for the persistent wizard NPC behind the blessing desk. */
  isWizard?: boolean
  /** Set when an agent must visit the wizard before working (first appearance + every reactivation). */
  needsBlessing?: boolean
```

- [ ] **Step 2: Typecheck**

Run: `cd webview-ui && npx tsc --noEmit`
Expected: FAIL with errors in `officeState.ts` `startTrip`/`desiredTripFor` signatures (their inline unions don't yet include `'wizard_blessing'`) — this is expected; Task 5 fixes them. If the ONLY errors are those two signatures, proceed.

- [ ] **Step 3: Commit**

```bash
git add webview-ui/src/office/types.ts
git commit -m "feat(wizard): add wizard_blessing trip mode + isWizard/needsBlessing flags"
```

---

## Task 5: OfficeState — wizard NPC injection + geometry + desk blocking

**Files:**
- Modify: `webview-ui/src/office/engine/officeState.ts`

- [ ] **Step 1: Add imports and constants**

At the top of `officeState.ts`, add a new import line from `wizardDesk.js`. **Import only what Task 5 uses** — the webview has `noUnusedLocals: true`, so importing `advanceWizard`/`enqueue`/`dequeue` here (first used in Task 7) would fail the typecheck. Task 7 extends this import.

```ts
import {
  createWizardState, computeLineupTiles, MAX_LINE,
  type WizardState, type Tile as WizardTile,
} from './wizardDesk.js'
```

Inside the `OfficeState` class, near the greeter/pad constants (≈149–156), add:

```ts
  private static readonly WIZARD_ID = -1000002
  /** Wizard desk fixture (2 tiles wide) at the lounge↔workstation boundary, central. */
  private static readonly WIZARD_DESK_TILES: WizardTile[] = [
    { col: 9, row: 24 },
    { col: 10, row: 24 },
  ]
  /** Wizard stands behind the desk (north), facing south. */
  private static readonly WIZARD_STAND_COL = 10
  private static readonly WIZARD_STAND_ROW = 23
  /** Front of the line (where the served agent is blessed) — one tile south of the desk. */
  private static readonly WIZARD_FRONT_COL = 10
  private static readonly WIZARD_FRONT_ROW = 25
```

Add instance fields near the campfire geometry fields (≈303–307):

```ts
  private wizard: WizardState = createWizardState()
  private wizardLineTiles: WizardTile[] = []
  private wizardInitialized = false
```

- [ ] **Step 2: Add `ensureWizard()` and call it**

Add a method next to `ensureGreeter()` (≈159):

```ts
  /** Spawn the persistent wizard NPC behind the blessing desk, if not yet placed. */
  private ensureWizard(): void {
    if (this.wizardInitialized) return
    this.wizardInitialized = true
    if (this.characters.has(OfficeState.WIZARD_ID)) return
    const ch = createCharacter(OfficeState.WIZARD_ID, 5, null, null, 200)
    ch.tileCol = OfficeState.WIZARD_STAND_COL
    ch.tileRow = OfficeState.WIZARD_STAND_ROW
    ch.x = OfficeState.WIZARD_STAND_COL * TILE_SIZE + TILE_SIZE / 2
    ch.y = OfficeState.WIZARD_STAND_ROW * TILE_SIZE + TILE_SIZE / 2
    ch.dir = Direction.DOWN // face the line
    ch.state = CharacterState.IDLE
    ch.isWizard = true
    ch.isActive = false
    ch.seatId = null
    this.characters.set(OfficeState.WIZARD_ID, ch)
  }
```

In the constructor, right after `this.ensureGreeter()` (≈122), add:

```ts
    this.ensureWizard()
```

- [ ] **Step 3: Block the desk tiles in `rebuildVisibleState`**

In `rebuildVisibleState()` (≈1053), between the `getBlockedTiles` line and the `getWalkableTiles` line, insert the desk-blocking so walkability accounts for it:

```ts
    this.blockedTiles = getBlockedTiles(visible)
    for (const t of OfficeState.WIZARD_DESK_TILES) {
      this.blockedTiles.add(`${t.col},${t.row}`)
    }
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles)
```

- [ ] **Step 4: Add `resolveWizardGeometry()` and call it**

Add a method next to `resolveCampfireGeometry()` (≈431):

```ts
  /** Resolve the wizard's single-file line tiles from the front-of-line anchor. */
  private resolveWizardGeometry(): void {
    const walkable = (c: number, r: number): boolean => {
      if (this.blockedTiles.has(`${c},${r}`)) return false
      const t = this.tileMap[r]?.[c]
      return t !== undefined && t !== TileType.WALL && t !== TileType.VOID
    }
    this.wizardLineTiles = computeLineupTiles(
      { col: OfficeState.WIZARD_FRONT_COL, row: OfficeState.WIZARD_FRONT_ROW },
      walkable,
      MAX_LINE,
    )
  }
```

Call it in the constructor right after `this.resolveCampfireGeometry()` (≈123) AND in `rebuildFromLayout()` right after `this.resolveCampfireGeometry()` (≈350). In `rebuildFromLayout`, also reset the queue there:

```ts
    this.resolveCampfireGeometry()
    this.wizard = createWizardState()
    this.resolveWizardGeometry()
    this.ensureWizard()
```

(The `wizard_blessing` tripMode is already cleared by the existing trip-reset loop at ≈340, which sets `ch.tripMode = null` for non-greeters. The wizard NPC has `isGreeter` falsy, so guard it in Step 5.)

- [ ] **Step 5: Exclude the wizard NPC from agent loops**

The wizard must never be treated as an agent. Update these `if (ch.isGreeter ...)` guards to also skip the wizard:

- `rebuildFromLayout` trip-reset loop (≈339): `if (ch.isGreeter || ch.isWizard) continue`
- `rebuildFromLayout` seat pass 1 (≈372): `if (ch.isGreeter || ch.isWizard) continue`
- `rebuildFromLayout` seat pass 2 (≈393): `if (ch.isGreeter || ch.isWizard) continue`
- `rebuildFromLayout` relocate pass (≈410): `if (ch.isGreeter || ch.isWizard) continue`
- palette-count loop (≈497): `if (ch.isGreeter || ch.isWizard) continue`

In the `update()` loop, add a wizard skip block right after the knight block (≈2587, before the SPAWNING handler):

```ts
      // Wizard NPC: just stands behind the desk. Pose/cast visuals are render-only.
      if (ch.isWizard) {
        ch.dir = Direction.DOWN
        updateCharacter(ch, dt, this.walkableTiles, this.seats, this.tileMap, this.blockedTiles)
        continue
      }
```

- [ ] **Step 6: Fix the trip signatures to include `'wizard_blessing'`**

Update the union in `startTrip` (≈2126) and `desiredTripFor` return type (≈2241) to add `| 'wizard_blessing'` (matching the Character.tripMode union from Task 4). For example `startTrip`:

```ts
  private startTrip(ch: Character, type: 'beanbag' | 'bookshelf' | 'pacing' | 'ping_pong' | 'chess' | 'pool' | 'planting' | 'campfire_wood' | 'campfire_dance' | 'wizard_blessing'): boolean {
```

and the `desiredTripFor` return type the same way.

- [ ] **Step 7: Typecheck**

Run: `cd webview-ui && npx tsc --noEmit`
Expected: PASS (no errors). The wizard NPC now exists, is blocked, and is excluded from agent logic. The line geometry resolves but nothing drives the queue yet.

- [ ] **Step 8: Commit**

```bash
git add webview-ui/src/office/engine/officeState.ts
git commit -m "feat(wizard): inject wizard NPC + resolve line geometry + block desk"
```

---

## Task 6: OfficeState — `startTrip` case + `desiredTripFor` priority + needsBlessing seams

**Files:**
- Modify: `webview-ui/src/office/engine/officeState.ts`

- [ ] **Step 1: Add the `wizard_blessing` target in `startTrip`**

In `startTrip` (≈2126), add a branch in the target-selection if/else chain (e.g. after the `campfire_dance` branch at ≈2143):

```ts
    } else if (type === 'wizard_blessing') {
      target = this.wizardSlotFor(ch)
```

Then add the helper method (place it just below `startTrip`):

```ts
  /** The line tile this agent should occupy, based on its index in the wizard queue.
   *  Falls back to the back of the line if it is not yet enqueued. */
  private wizardSlotFor(ch: Character): WizardTile | null {
    if (this.wizardLineTiles.length === 0) return null
    let idx = this.wizard.queue.indexOf(ch.id)
    if (idx < 0) idx = this.wizard.queue.length // about to be appended
    const clamped = Math.min(idx, this.wizardLineTiles.length - 1)
    return this.wizardLineTiles[clamped]
  }
```

- [ ] **Step 2: Give `wizard_blessing` top priority in `desiredTripFor`**

At the very top of `desiredTripFor` (≈2242, before the `if (!ch.isActive)` branch), add:

```ts
    // The blessing gates everything else, for active and idle agents alike.
    if (ch.needsBlessing) return 'wizard_blessing'
```

- [ ] **Step 3: Set `needsBlessing` on first appearance (materialize)**

In `materializeAgent`, in the `if (seatId)` block that sets `ch.state = CharacterState.SPAWNING` (≈639), add right before it:

```ts
      ch.needsBlessing = true
```

(So the flag is set from spawn. During SPAWNING the trip reconciliation is skipped, so it only takes effect once the spin/high-five completes.)

- [ ] **Step 4: Set `needsBlessing` on subagent creation**

In `addSubagent` (≈816), after the character is created and added (locate the `this.characters.set(...)` for the new subagent), set:

```ts
      ch.needsBlessing = true
```

Place it alongside the subagent's other initialization so both the seated and seatless subagent branches get it. (Subagents queue too — spec: everyone.)

- [ ] **Step 5: Set `needsBlessing` on reactivation**

In `setAgentActive` (≈973), inside the `else` branch (active === true, ≈986), after the existing `this.cancelCampfireTrip(ch)` (≈998), add:

```ts
        if (!ch.isGreeter && !ch.isWizard && !ch.isKnight) {
          ch.needsBlessing = true
        }
```

- [ ] **Step 6: Typecheck**

Run: `cd webview-ui && npx tsc --noEmit`
Expected: PASS. Agents now flag themselves for blessing and `startTrip('wizard_blessing')` targets a line slot, but the queue is not yet enqueued/advanced/released — Task 7 wires `tickWizard`.

- [ ] **Step 7: Commit**

```bash
git add webview-ui/src/office/engine/officeState.ts
git commit -m "feat(wizard): route blessing-bound agents into the wizard line"
```

---

## Task 7: OfficeState — `tickWizard` (enqueue, advance, summon, release) + teardown

**Files:**
- Modify: `webview-ui/src/office/engine/officeState.ts`

- [ ] **Step 0: Extend the wizardDesk import**

Add the now-used symbols to the `wizardDesk.js` import from Task 5:

```ts
import {
  createWizardState, computeLineupTiles, MAX_LINE,
  advanceWizard, enqueue, dequeue,
  type WizardState, type Tile as WizardTile,
} from './wizardDesk.js'
```

- [ ] **Step 1: Add `cancelWizardTrip` and wire it into teardown**

Add a helper next to `cancelCampfireTrip` (≈959):

```ts
  /** Remove an agent from the wizard line and free its reserved slot. Call wherever a
   *  character is torn down or pulled out of the ceremony. */
  private cancelWizardTrip(ch: Character): void {
    dequeue(this.wizard, ch.id)
    ch.needsBlessing = false
    if (ch.tripMode === 'wizard_blessing' && ch.tripTile) {
      this.occupiedTripTiles.delete(`${ch.tripTile.col},${ch.tripTile.row}`)
    }
  }
```

Call `this.cancelWizardTrip(ch)` immediately after every existing `this.cancelCampfireTrip(ch)` call:
- agent despawn path (≈696)
- `removeSubagent` (≈896)
- `removeAllSubagents` (≈929)

Do NOT add it to `setAgentActive(_, false)` — an agent that goes idle mid-line keeps its place and still gets blessed (Task 6 sets `needsBlessing` on reactivation, not deactivation; leaving an in-progress blessing alone is correct).

- [ ] **Step 2: Add `tickWizard()`**

Add the method next to `tickCampfire` (≈1808):

```ts
  private tickWizard(dt: number, nowMs: number): void {
    if (this.wizardLineTiles.length === 0) return

    // 1. Enqueue any agent flagged for blessing that is not already in line, and not still
    //    materializing/spinning (let the spawn ceremony finish first).
    for (const ch of this.characters.values()) {
      if (!ch.needsBlessing) continue
      if (ch.isWizard || ch.isGreeter || ch.isKnight) continue
      if (ch.matrixEffect || ch.state === CharacterState.SPAWNING) continue
      enqueue(this.wizard, ch.id)
    }

    // 2. Reflow: each queued agent should be walking to / standing on its line slot.
    //    Re-path only when its target slot changed (covers line-advance + mid-line removal).
    this.wizard.queue.forEach((id, idx) => {
      const ch = this.characters.get(id)
      if (!ch) return
      const slot = this.wizardLineTiles[Math.min(idx, this.wizardLineTiles.length - 1)]
      if (ch.tripMode !== 'wizard_blessing') {
        // Not started yet — the generic reconciliation will call startTrip; ensure the slot is free.
        return
      }
      if (ch.tripTile && (ch.tripTile.col !== slot.col || ch.tripTile.row !== slot.row)) {
        this.occupiedTripTiles.delete(`${ch.tripTile.col},${ch.tripTile.row}`)
        this.occupiedTripTiles.add(`${slot.col},${slot.row}`)
        ch.tripTile = { col: slot.col, row: slot.row }
        const path = findPath(ch.tileCol, ch.tileRow, slot.col, slot.row, this.tileMap, this.blockedTiles)
        if (path.length > 0) {
          ch.path = path
          ch.moveProgress = 0
          ch.state = CharacterState.WALK
          ch.frame = 0
          ch.frameTimer = 0
        }
      }
    })

    // 3. Advance the state machine. headArrived = the front agent is on the blessing spot.
    const front = this.wizardLineTiles[0]
    const head = this.wizard.queue[0]
    const headCh = head !== undefined ? this.characters.get(head) : undefined
    const headArrived =
      !!headCh && !!front && headCh.tileCol === front.col && headCh.tileRow === front.row
    const events = advanceWizard(this.wizard, dt * 1000, { nowMs, headArrived })

    for (const ev of events) {
      if (ev === 'start_blessing') {
        if (headCh) headCh.dir = Direction.UP // face the wizard
      } else if (ev === 'cast_summon') {
        if (headCh) this.summonDeskFor(headCh)
      } else if (ev === 'release' || ev === 'evict') {
        if (headCh) {
          headCh.needsBlessing = false
          this.endTrip(headCh) // frees the slot + walks them to their seat
        }
      }
    }
  }
```

- [ ] **Step 3: Add `summonDeskFor` (the "magical computer summon, if needed")**

Add below `tickWizard`:

```ts
  /** Reveal the agent's desk PC if it is not already shown. The wand-bolt visual is
   *  rendered separately; this performs the actual materialize "if needed". */
  private summonDeskFor(ch: Character): void {
    if (!ch.seatId) {
      // No reserved seat yet — fall back to revealing the next pooled desk if we're out.
      this.revealNextDesk()
      return
    }
    const chairUid = ch.seatId.split(':')[0]
    const gid = this.deskGroupId(chairUid)
    if (gid && !this.revealedDeskIds.has(gid)) {
      this.revealedDeskIds.add(gid)
      this.deskLastEmptyAt.delete(gid)
      this.deskAnimations.set(gid, { type: 'reveal', startMs: performance.now() })
      this.rebuildVisibleState()
    }
  }
```

(`deskGroupId`, `deskLastEmptyAt`, `deskAnimations`, `revealedDeskIds`, `revealNextDesk` all already exist — see `revealNextDesk` at ≈1099 and the rebuild in `rebuildFromLayout` at ≈329.)

- [ ] **Step 4: Call `tickWizard` from `update()`**

In `update()`, next to the existing `this.tickCampfire(dt, nowMs)` call (≈2512), add:

```ts
    this.tickWizard(dt, nowMs)
```

- [ ] **Step 5: Typecheck + run tests**

Run: `cd webview-ui && npx tsc --noEmit`
Expected: PASS.
Run: `node_modules/.bin/vitest run`
Expected: PASS (all existing + 12 wizard tests).

- [ ] **Step 6: Commit**

```bash
git add webview-ui/src/office/engine/officeState.ts
git commit -m "feat(wizard): tickWizard queue drive + desk summon + teardown"
```

---

## Task 8: Renderer — WizardRenderState, getter, plumb through renderFrame

**Files:**
- Modify: `webview-ui/src/office/engine/renderer.ts`
- Modify: `webview-ui/src/office/engine/officeState.ts`
- Modify: `webview-ui/src/office/components/OfficeCanvas.tsx`

- [ ] **Step 1: Add `WizardRenderState` and append the `renderFrame` param**

In `renderer.ts`, next to `CampfireRenderState` (≈2294), add:

```ts
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
```

Append to the `renderFrame(...)` parameter list (≈2304), as the new LAST parameter after `campfire?: CampfireRenderState,`:

```ts
  wizard?: WizardRenderState,
```

- [ ] **Step 2: Add a render call inside `renderFrame`**

Inside `renderFrame`, after the campfire is rendered (find where `campfire` is consumed — search for `renderCampfireFlames` or the `campfire?.` usage), add a call to draw the wizard scene in world space, using the same `offsetX/offsetY/zoom` the other furniture passes use:

```ts
  if (wizard) {
    renderWizardScene(ctx, wizard, offsetX, offsetY, zoom, timeMs ?? performance.now())
  }
```

Place this so it draws over the floor but is consistent with other ground fixtures (near the campfire/pool draws). The rune draws under characters (so the agent stands on it); the desk + bolt may draw before characters too — acceptable for a first pass.

- [ ] **Step 3: Implement `renderWizardScene` (desk + rune + bolt)**

Add at the end of `renderer.ts`:

```ts
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

  // Summon bolt — an arc of light from the wizard to the agent's seat while active.
  if (w.summonTo && timeMs < w.summonUntilMs) {
    const sx = px(w.standTile.col) + ts / 2
    const sy = py(w.standTile.row) + ts / 2
    const ex = px(w.summonTo.col) + ts / 2
    const ey = py(w.summonTo.row) + ts / 2
    ctx.save()
    ctx.globalAlpha = 0.8
    ctx.strokeStyle = '#bda6ff'
    ctx.lineWidth = 2.5 * zoom
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.quadraticCurveTo((sx + ex) / 2, Math.min(sy, ey) - ts, ex, ey)
    ctx.stroke()
    // sparkle landing at the seat
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(ex - 2 * zoom, ey - 2 * zoom, 4 * zoom, 4 * zoom)
    ctx.restore()
  }
}
```

- [ ] **Step 4: Add render-state getter on OfficeState**

In `officeState.ts`, add a method (near `getCampfireFireTile`, ≈310). It exposes the render state and tracks the active summon bolt:

```ts
  // Set on a cast_summon event; consumed by the renderer for the bolt animation.
  private wizardSummonTo: { col: number; row: number } | null = null
  private wizardSummonUntilMs = 0
  private wizardBlessStartMs = 0

  getWizardRenderState(): WizardRenderState {
    return {
      deskTiles: OfficeState.WIZARD_DESK_TILES.map((t) => ({ col: t.col, row: t.row })),
      standTile: { col: OfficeState.WIZARD_STAND_COL, row: OfficeState.WIZARD_STAND_ROW },
      frontTile: { col: OfficeState.WIZARD_FRONT_COL, row: OfficeState.WIZARD_FRONT_ROW },
      blessing: this.wizard.phase === 'blessing',
      blessStartMs: this.wizardBlessStartMs,
      summonTo: this.wizardSummonTo,
      summonUntilMs: this.wizardSummonUntilMs,
    }
  }
```

Import the type at the top of `officeState.ts` (add to the renderer import or a new `import type`):

```ts
import type { WizardRenderState } from './renderer.js'
```

In `tickWizard` (Task 7 Step 2), record the timestamps in the event loop:
- on `'start_blessing'`: `this.wizardBlessStartMs = nowMs`
- on `'cast_summon'`: set the bolt target:

```ts
      } else if (ev === 'cast_summon') {
        if (headCh) {
          this.summonDeskFor(headCh)
          if (headCh.seatId) {
            const seat = this.seats.get(headCh.seatId)
            if (seat) {
              this.wizardSummonTo = { col: seat.seatCol, row: seat.seatRow }
              this.wizardSummonUntilMs = nowMs + 900
            }
          }
        }
      }
```

(Update the `start_blessing` branch from Task 7 to also set `this.wizardBlessStartMs = nowMs`.)

- [ ] **Step 5: Plumb through `OfficeCanvas.tsx`**

In `OfficeCanvas.tsx`, just before the `renderFrame(` call (≈225, next to `const campfireRender = {...}`), add:

```ts
        const wizardRender = officeState.getWizardRenderState()
```

Then add `wizardRender,` as the new LAST argument to the `renderFrame(` call (after `campfireRender,` at ≈256):

```ts
          campfireRender,
          wizardRender,
        )
```

If `WizardRenderState` needs importing in the canvas file for types, it is inferred from the getter return — no import required.

- [ ] **Step 6: Typecheck both projects**

Run: `cd webview-ui && npx tsc --noEmit`
Expected: PASS.
Run (from repo root): `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add webview-ui/src/office/engine/renderer.ts webview-ui/src/office/engine/officeState.ts webview-ui/src/office/components/OfficeCanvas.tsx
git commit -m "feat(wizard): render desk, blessing rune, and summon bolt"
```

---

## Task 9: Renderer — wizard NPC adornments (hat + staff)

**Files:**
- Modify: `webview-ui/src/office/engine/renderer.ts`

- [ ] **Step 1: Find the per-character draw path**

Search `renderer.ts` for where each `Character` is drawn (the loop over `characters` that draws the sprite; the greeter palette/loincloth overlays are applied here — search for `drawLoinclothOverlay` or `isGreeter`). Identify the function that draws one character (e.g. `drawCharacter(...)`).

- [ ] **Step 2: Add a wizard overlay**

Add a helper near `drawLoinclothOverlay`:

```ts
/** Pointy hat + staff drawn over the base sprite for the wizard NPC. */
function drawWizardOverlay(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  zoom: number,
): void {
  const u = zoom // 1px in screen space
  // Pointy purple hat sitting on the head.
  ctx.fillStyle = '#3b2a6b'
  ctx.beginPath()
  ctx.moveTo(screenX, screenY - 16 * u)
  ctx.lineTo(screenX - 6 * u, screenY - 4 * u)
  ctx.lineTo(screenX + 6 * u, screenY - 4 * u)
  ctx.closePath()
  ctx.fill()
  // Hat brim + a star.
  ctx.fillRect(screenX - 7 * u, screenY - 5 * u, 14 * u, 2 * u)
  ctx.fillStyle = '#ffe27a'
  ctx.fillRect(screenX - u, screenY - 11 * u, 2 * u, 2 * u)
  // Staff with a glowing tip, held to the right.
  ctx.fillStyle = '#6b4a2a'
  ctx.fillRect(screenX + 7 * u, screenY - 10 * u, 1.5 * u, 16 * u)
  ctx.fillStyle = '#bda6ff'
  ctx.beginPath()
  ctx.arc(screenX + 7.5 * u, screenY - 11 * u, 2.5 * u, 0, Math.PI * 2)
  ctx.fill()
}
```

- [ ] **Step 3: Call it for the wizard NPC**

In the per-character draw function, after the base sprite is drawn, add (mirroring how `drawLoinclothOverlay` is conditionally called):

```ts
  if (ch.isWizard) {
    drawWizardOverlay(ctx, /* the same screenX */ , /* screenY used for the sprite */ , zoom)
  }
```

Use the exact `screenX`/`screenY` (sprite anchor) variables already in scope in that function — match the call convention of the existing overlay call so the hat lands on the head.

- [ ] **Step 4: Typecheck**

Run: `cd webview-ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/office/engine/renderer.ts
git commit -m "feat(wizard): draw wizard hat + staff overlay on the NPC"
```

---

## Task 10: Full verification (typecheck, tests, manual run)

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `node_modules/.bin/vitest run`
Expected: PASS — all existing suites plus `wizardDesk.test.ts` (12 tests).

- [ ] **Step 2: Typecheck both projects**

Run: `cd webview-ui && npx tsc --noEmit` → PASS
Run (repo root): `npx tsc --noEmit -p tsconfig.json` → PASS

- [ ] **Step 3: Manual run**

Run: `npm run dev`, open http://localhost:5173.
Verify against a live Claude Code session (or trigger spawns):
- A newly-appeared agent does its matrix-spawn + greeter high-five, then **walks north to the wizard desk and stands in line** facing the wizard.
- The front agent shows a **pulsing rune circle**; after ~1.8s a **bolt arcs from the wizard to its seat** and (if its desk was hidden) the desk **materializes**; then it walks to its seat and starts typing.
- With several agents at once, they form a **single-file line** south of the desk that advances one at a time.
- An agent that goes idle and then resumes work (reactivates) **returns to the line** for a fresh blessing.
- No agent gets permanently stuck at the desk (safety timeout releases a stuck head after ~20s).
- The wizard NPC has a hat + staff and never leaves its post.

- [ ] **Step 4: Final commit (if any tuning tweaks were made)**

```bash
git add -A
git commit -m "feat(wizard): tuning after manual verification"
```

(Only commit wizard-feature files — leave the unrelated summarizer WIP untouched: `server/summarizer.ts`, `server/index.ts`, `server/types.ts`, `webview-ui/src/App.tsx`, `AgentFeed.tsx`, `AgentList.tsx`, `RightPanel.tsx`, `useExtensionMessages.ts`, `AgentAvatar.tsx`.)

---

## Self-review notes (coverage vs. spec)

- Wizard NPC + desk at lounge/workstation boundary, central → Task 5 (constants col 10, rows 23–25; desk tiles (9,24)/(10,24)).
- Everyone queues (main + subagents) → Task 6 (materialize, addSubagent, setAgentActive).
- Full ceremony on every reactivation → Task 6 Step 5 (`needsBlessing=true` on activate).
- Single-file line, one at a time, with safety timeout → Tasks 3 + 7 (`advanceWizard` + `tickWizard` reflow + evict).
- Blessing = pulsing rune, then wand-bolt summon "if needed" → Tasks 7 (`summonDeskFor` reveals only if hidden) + 8 (rune + bolt render).
- Lifecycle correctness: `rebuildFromLayout` reset (Task 5 Step 4), teardown via `cancelWizardTrip` at despawn/removeSubagent/removeAllSubagents (Task 7 Step 1), value-imports preserved (Task 5 uses existing value imports).
- `renderFrame` new arg appended + single call site updated together → Task 8.
```

# Campfire Ritual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Idle agents gather wood to feed the lounge campfire until it fills a 3×3; they dance around it for 2 minutes (going permanently shirtless/loincloth); the fire burns down to an egg that hatches a baby dragon by the fire; the cycle repeats forever, accumulating dragons.

**Architecture:** A pure state-machine module (`campfire.ts`) owns phase/timer logic and ring/woodpile geometry (unit-tested). `OfficeState` holds one `CampfireState`, drives it from the existing per-frame `update()` loop, and reuses the existing trip system (`startTrip`/`endTrip`/`findPath`/`occupiedTripTiles`) for wood-gathering and dancing, and the existing `animals` array for the baby dragon. The renderer parameterizes the existing `renderCampfireFlames` by wood level and draws the egg, dragon, carried log, and the loincloth recolor.

**Tech Stack:** TypeScript, Vite/React (webview-ui), Vitest (node env), HTML canvas 2D procedural rendering. No new dependencies.

---

## Spec

See `docs/superpowers/specs/2026-05-27-campfire-ritual-design.md`.

## Grounding facts (verified against current code)

- Campfire furniture `lng-campfire` at tile **(5,30)**; stumps at the four corners (4,29)(6,29)(4,31)(6,31); 3×3 = cols 4–6 × rows 29–31. The four edge-center tiles (5,29)(4,30)(6,30)(5,31) are free → used as wood-drop tiles.
- Trip API (`webview-ui/src/office/engine/officeState.ts`): `startTrip(ch, type)` (line ~1620), `endTrip(ch)` (~1688), `desiredTripFor(ch, now)` (~1719), update-loop trip block (~2091), planting timer pattern (~2106), `findPath(...)` from `tileMap.ts`, reservation set `occupiedTripTiles`, `blockedTiles`, `tileMap`.
- Recruitment pattern: `canStartPingPong` (~1397) + `PING_PONG_SLOTS` (~1328) + `findFreePingPongSlot` (~1357).
- `rebuildFromLayout` trip reset (~285); `setAgentActive` planting-cancel (~872).
- Animals: `animals: Array<{kind:'rabbit'|'squirrel'; homeX,homeY,watchX,watchY,x,y,facing,targetX,targetY,nextHopAt}>` (~236), init in `ensureGreeter` (~194), `tickAnimals` (~1522), `ANIMAL_HOP_RADIUS_PX=32`.
- Renderer: `renderCampfireFlames(ctx,offsetX,offsetY,zoom,timeMs)` (renderer.ts ~1107, `CAMPFIRE_TILE` const ~1104); `ForestAnimal` interface (~1008); `renderAnimals` (~1081), `drawRabbit`/`drawSquirrel` (~1016/~1050); `renderScene` char loop calls `getCharacterSprites(ch.palette, ch.hueShift)` (renderer.ts ~143); `renderFrame` signature (~2062) already threads `animals?`, `pingPongMatch?`, `plantedFlowers?`; called once from `OfficeCanvas.tsx:224`.
- Sprites: real app uses **pre-colored** sprites (`getCharacterSprites` `loadedCharacters` branch, spriteData.ts ~1744) — so loincloth is a **pixel recolor** (shirt-hex→skin). Palettes: `CHARACTER_PALETTES` (spriteData.ts ~871), each `{skin,shirt,pants,hair,shoes}`.
- Tests: root `vitest.config.ts` includes only `server/**/*.test.ts`, env node. We extend it to include webview pure-logic tests. Run local binary: `node_modules/.bin/vitest run <file>` (npx pulls a wrong version).

---

## File structure

- **Create** `webview-ui/src/office/engine/campfire.ts` — pure: types, constants, `createCampfireState`, `resolveFireTile`, `resolveWoodpileTile`, `computeDanceSlots`, `addWood`, `advanceCampfire` reducer. No DOM/canvas imports.
- **Create** `webview-ui/src/office/engine/__tests__/campfire.test.ts` — unit tests.
- **Modify** `vitest.config.ts` — include webview pure-logic tests.
- **Modify** `webview-ui/src/office/types.ts` — `Character.tripMode` union (+`campfire_wood`,`campfire_dance`), add `danced?: boolean`, `carrying?: boolean`.
- **Modify** `webview-ui/src/office/engine/officeState.ts` — campfire state + integration, dragon spawn, animal `kind` union.
- **Modify** `webview-ui/src/office/engine/characters.ts` — dance facing/bob + carried-log gating (minimal).
- **Modify** `webview-ui/src/office/engine/renderer.ts` — parameterize flames; `drawEgg`, `drawBabyDragon`, `drawCarriedLog`; `ForestAnimal` union; loincloth branch in `renderScene`; thread campfire state through `renderFrame`.
- **Modify** `webview-ui/src/office/components/OfficeCanvas.tsx` — pass campfire render state into `renderFrame`.
- **Create** `webview-ui/src/office/sprites/dancedSprites.ts` — cached shirt→skin / pants→loincloth recolor of `getCharacterSprites` output.

---

## Task 1: Test infra + campfire types, constants, state factory, fire/woodpile geometry

**Files:**
- Modify: `vitest.config.ts`
- Create: `webview-ui/src/office/engine/campfire.ts`
- Create: `webview-ui/src/office/engine/__tests__/campfire.test.ts`

- [ ] **Step 1: Extend vitest include to webview pure-logic tests**

In `vitest.config.ts` change the `include` array:

```ts
    include: ['server/**/*.test.ts', 'webview-ui/src/**/*.test.ts'],
```

- [ ] **Step 2: Write failing tests for state factory + geometry**

Create `webview-ui/src/office/engine/__tests__/campfire.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  createCampfireState,
  resolveFireTile,
  resolveWoodpileTile,
  computeDanceSlots,
  WOOD_TO_FULL,
} from '../campfire.js'

describe('createCampfireState', () => {
  it('starts in growing phase with no wood', () => {
    const s = createCampfireState()
    expect(s.phase).toBe('growing')
    expect(s.woodLevel).toBe(0)
    expect(s.dancers).toEqual([])
  })
})

describe('resolveFireTile', () => {
  it('finds the campfire furniture tile', () => {
    const layout = { furniture: [{ uid: 'lng-campfire', type: 'campfire', col: 5, row: 30 }] }
    expect(resolveFireTile(layout as any)).toEqual({ col: 5, row: 30 })
  })
  it('returns null when there is no campfire', () => {
    expect(resolveFireTile({ furniture: [] } as any)).toBeNull()
  })
})

describe('resolveWoodpileTile', () => {
  it('returns a walkable tile a few tiles from the fire', () => {
    const fire = { col: 5, row: 30 }
    const walkable = () => true
    const wp = resolveWoodpileTile(fire, walkable)!
    expect(wp).not.toBeNull()
    const dist = Math.abs(wp.col - fire.col) + Math.abs(wp.row - fire.row)
    expect(dist).toBeGreaterThanOrEqual(2)
  })
  it('skips unwalkable tiles', () => {
    const fire = { col: 5, row: 30 }
    // Only (9,30) walkable.
    const walkable = (c: number, r: number) => c === 9 && r === 30
    expect(resolveWoodpileTile(fire, walkable)).toEqual({ col: 9, row: 30 })
  })
})

describe('computeDanceSlots', () => {
  it('returns up to 8 walkable ring tiles, excluding the 3x3 core', () => {
    const fire = { col: 5, row: 30 }
    const walkable = () => true
    const slots = computeDanceSlots(fire, walkable)
    expect(slots.length).toBeGreaterThanOrEqual(4)
    expect(slots.length).toBeLessThanOrEqual(8)
    // None inside the 3x3 core (cols 4-6, rows 29-31)
    for (const s of slots) {
      const inCore = s.col >= 4 && s.col <= 6 && s.row >= 29 && s.row <= 31
      expect(inCore).toBe(false)
    }
  })
  it('drops slots that are not walkable', () => {
    const fire = { col: 5, row: 30 }
    const walkable = (c: number, r: number) => r === 28 // only the north outer row
    const slots = computeDanceSlots(fire, walkable)
    expect(slots.every((s) => s.row === 28)).toBe(true)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node_modules/.bin/vitest run webview-ui/src/office/engine/__tests__/campfire.test.ts`
Expected: FAIL — `Cannot find module '../campfire.js'`.

- [ ] **Step 4: Create `campfire.ts` with types/constants/geometry (no reducer yet)**

Create `webview-ui/src/office/engine/campfire.ts`:

```ts
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
export const FULL_GRACE_MS = 8_000      // start dancing with <MIN after this if ≥1 present
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
  for (const f of layout.furniture as Array<{ type?: string; col: number; row: number }>) {
    if (f.type === 'campfire') return { col: f.col, row: f.row }
  }
  return null
}

/** Pick a walkable woodpile tile a few tiles from the fire. Scans an outward ring
 *  starting east of the core; deterministic (returns the first walkable hit). */
export function resolveWoodpileTile(
  fire: Tile,
  isWalkable: (col: number, row: number) => boolean,
): Tile | null {
  // Candidate offsets in priority order: east of the core, then sweep outward.
  const offsets: Tile[] = []
  for (let d = 2; d <= 5; d++) {
    offsets.push({ col: fire.col + d, row: fire.row })      // east
    offsets.push({ col: fire.col + d, row: fire.row + 1 })
    offsets.push({ col: fire.col + d, row: fire.row - 1 })
    offsets.push({ col: fire.col - d, row: fire.row })      // west
    offsets.push({ col: fire.col, row: fire.row + d })      // south
  }
  for (const o of offsets) {
    if (inCore(fire, o.col, o.row)) continue
    if (isWalkable(o.col, o.row)) return o
  }
  return null
}

/** Ordered (clockwise) ring of up to MAX_DANCERS walkable tiles around the 3×3 core.
 *  Prefers the four free edge tiles of the immediate ring, then the nearest walkable
 *  tiles of the next ring out, sorted clockwise by angle from the fire. */
export function computeDanceSlots(
  fire: Tile,
  isWalkable: (col: number, row: number) => boolean,
): Tile[] {
  const candidates: Tile[] = []
  // Immediate-ring edge tiles (corners are stumps → skip) + the radius-2 ring.
  const rings: Array<[number, number]> = []
  // radius 1 edges (N,E,S,W)
  rings.push([0, -1], [1, 0], [0, 1], [-1, 0])
  // radius 2 full ring
  for (let dc = -2; dc <= 2; dc++) {
    for (let dr = -2; dr <= 2; dr++) {
      if (Math.max(Math.abs(dc), Math.abs(dr)) === 2) rings.push([dc, dr])
    }
  }
  const seen = new Set<string>()
  for (const [dc, dr] of rings) {
    const col = fire.col + dc
    const row = fire.row + dr
    const key = `${col},${row}`
    if (seen.has(key)) continue
    if (inCore(fire, col, row)) continue
    if (!isWalkable(col, row)) continue
    seen.add(key)
    candidates.push({ col, row })
  }
  // Sort clockwise by angle from the fire (atan2), starting at North.
  candidates.sort((a, b) => angleCW(fire, a) - angleCW(fire, b))
  return candidates.slice(0, MAX_DANCERS)
}

function angleCW(fire: Tile, t: Tile): number {
  // Clockwise from North: North=0, East=π/2, ... using screen coords (row down).
  const a = Math.atan2(t.col - fire.col, -(t.row - fire.row)) // 0 at North, CW positive
  return a < 0 ? a + Math.PI * 2 : a
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node_modules/.bin/vitest run webview-ui/src/office/engine/__tests__/campfire.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts webview-ui/src/office/engine/campfire.ts webview-ui/src/office/engine/__tests__/campfire.test.ts
git commit -m "feat(campfire): pure state types + fire/woodpile/ring geometry with tests"
```

---

## Task 2: `addWood` + `advanceCampfire` reducer (the timed state machine)

**Files:**
- Modify: `webview-ui/src/office/engine/campfire.ts`
- Modify: `webview-ui/src/office/engine/__tests__/campfire.test.ts`

- [ ] **Step 1: Write failing tests for the reducer**

Append to `campfire.test.ts`:

```ts
import { addWood, advanceCampfire, DANCE_DURATION_MS, BURNDOWN_DURATION_MS, HATCH_DELAY_MS, ROTATE_INTERVAL_MS } from '../campfire.js'

describe('addWood', () => {
  it('increments wood and enters full at WOOD_TO_FULL', () => {
    let s = createCampfireState()
    for (let i = 0; i < WOOD_TO_FULL - 1; i++) s = addWood(s, 1000)
    expect(s.phase).toBe('growing')
    s = addWood(s, 2000)
    expect(s.woodLevel).toBe(WOOD_TO_FULL)
    expect(s.phase).toBe('full')
    expect(s.phaseStartMs).toBe(2000)
  })
  it('does not exceed full or add wood outside growing', () => {
    let s = { ...createCampfireState(), phase: 'dancing' as const, woodLevel: 3 }
    s = addWood(s, 1000)
    expect(s.woodLevel).toBe(3) // ignored outside growing
  })
})

describe('advanceCampfire', () => {
  it('full → dancing once min dancers present', () => {
    const base = { ...createCampfireState(), phase: 'full' as const, phaseStartMs: 0 }
    const { state, events } = advanceCampfire(base, 100, { nowMs: 100, dancerCount: 2 })
    expect(state.phase).toBe('dancing')
    expect(events).toContain('start_dancing')
  })
  it('full → waits when nobody is around (under grace)', () => {
    const base = { ...createCampfireState(), phase: 'full' as const, phaseStartMs: 0 }
    const { state } = advanceCampfire(base, 100, { nowMs: 1000, dancerCount: 0 })
    expect(state.phase).toBe('full')
  })
  it('dancing emits rotate on the interval', () => {
    const base = { ...createCampfireState(), phase: 'dancing' as const, phaseStartMs: 0, rotateAtMs: ROTATE_INTERVAL_MS }
    const { state, events } = advanceCampfire(base, 0, { nowMs: ROTATE_INTERVAL_MS + 1, dancerCount: 3 })
    expect(events).toContain('rotate')
    expect(state.rotateAtMs).toBeGreaterThan(ROTATE_INTERVAL_MS + 1)
  })
  it('dancing → burning_down after DANCE_DURATION', () => {
    const base = { ...createCampfireState(), phase: 'dancing' as const, phaseStartMs: 0 }
    const { state, events } = advanceCampfire(base, 0, { nowMs: DANCE_DURATION_MS + 1, dancerCount: 3 })
    expect(state.phase).toBe('burning_down')
    expect(events).toContain('start_burndown')
  })
  it('burning_down → egg, egg → hatch → growing', () => {
    let s = { ...createCampfireState(), phase: 'burning_down' as const, phaseStartMs: 0, woodLevel: WOOD_TO_FULL }
    let r = advanceCampfire(s, 0, { nowMs: BURNDOWN_DURATION_MS + 1, dancerCount: 0 })
    expect(r.state.phase).toBe('egg')
    s = r.state
    r = advanceCampfire(s, 0, { nowMs: r.state.phaseStartMs + HATCH_DELAY_MS + 1, dancerCount: 0 })
    expect(r.events).toContain('hatch')
    expect(r.state.phase).toBe('growing')
    expect(r.state.woodLevel).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node_modules/.bin/vitest run webview-ui/src/office/engine/__tests__/campfire.test.ts`
Expected: FAIL — `addWood`/`advanceCampfire` not exported.

- [ ] **Step 3: Implement `addWood` + `advanceCampfire` in `campfire.ts`**

Append to `campfire.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `node_modules/.bin/vitest run webview-ui/src/office/engine/__tests__/campfire.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/office/engine/campfire.ts webview-ui/src/office/engine/__tests__/campfire.test.ts
git commit -m "feat(campfire): addWood + advanceCampfire reducer with full state-machine tests"
```

---

## Task 3: Character type changes

**Files:**
- Modify: `webview-ui/src/office/types.ts`

- [ ] **Step 1: Extend the tripMode union and add flags**

In `webview-ui/src/office/types.ts`, find the `tripMode` field on `Character` (currently ends `| 'pool' | 'planting' | null`) and replace its type, and add two fields after `plantingTimer`:

```ts
  tripMode: 'beanbag' | 'bookshelf' | 'pacing' | 'ping_pong' | 'chess' | 'pool' | 'planting' | 'campfire_wood' | 'campfire_dance' | null
```

Add (near `plantingTimer?`):

```ts
  /** True once this agent has joined a campfire dance — permanent; renders shirtless+loincloth. */
  danced?: boolean
  /** True while carrying a log to the fire (campfire_wood trip, post-pickup). */
  carrying?: boolean
  /** Milliseconds remaining while dropping a log at the fire. */
  woodDropTimer?: number
```

- [ ] **Step 2: Typecheck**

Run: `cd webview-ui && npx tsc --noEmit`
Expected: PASS (these are additive; the new tripMode values are not yet referenced).

- [ ] **Step 3: Commit**

```bash
git add webview-ui/src/office/types.ts
git commit -m "feat(campfire): Character tripMode + danced/carrying/woodDropTimer fields"
```

---

## Task 4: Wire CampfireState into OfficeState (state, reset, getters) — no behavior yet

**Files:**
- Modify: `webview-ui/src/office/engine/officeState.ts`

- [ ] **Step 1: Import campfire module**

At the top of `officeState.ts`, with the other engine imports, add:

```ts
import {
  createCampfireState, resolveFireTile, resolveWoodpileTile, computeDanceSlots,
  addWood, advanceCampfire, WOOD_TO_FULL, DROP_DURATION_MS,
  type CampfireState, type Tile,
} from './campfire.js'
```

- [ ] **Step 2: Add fields (near the `animals` / `plantedFlowers` declarations, ~line 220-261)**

```ts
  // ── Campfire ritual ──
  campfire: CampfireState = createCampfireState()
  /** Fire tile resolved from the layout (null if no campfire furniture present). */
  private fireTile: Tile | null = null
  /** Woodpile tile agents fetch logs from. */
  private woodpileTile: Tile | null = null
  /** Ordered clockwise dance-ring slots around the fire. */
  private danceSlots: Tile[] = []
```

- [ ] **Step 3: Resolve geometry — add a private helper and call it from `rebuildFromLayout`**

Add this method to the class:

```ts
  /** Resolve fire/woodpile/dance-ring tiles from the current layout + walkability. */
  private resolveCampfireGeometry(): void {
    this.fireTile = resolveFireTile(this.layout)
    if (!this.fireTile) {
      this.woodpileTile = null
      this.danceSlots = []
      return
    }
    const walkable = (c: number, r: number): boolean => {
      if (this.blockedTiles.has(`${c},${r}`)) return false
      const t = this.tileMap[r]?.[c]
      return t !== undefined && t !== TileType.WALL && t !== TileType.VOID
    }
    this.woodpileTile = resolveWoodpileTile(this.fireTile, walkable)
    this.danceSlots = computeDanceSlots(this.fireTile, walkable)
  }
```

In `rebuildFromLayout`, immediately after the trip-state clear block (after the `for (const ch ...) { ... ch.moveProgress = 0 }` at ~line 295), add:

```ts
    // Re-resolve campfire geometry and reset the ritual (slot coords may have moved).
    this.campfire = createCampfireState()
    this.resolveCampfireGeometry()
```

- [ ] **Step 4: Call `advanceCampfire` from the update loop (timed phases only, no recruiting yet)**

In `update()`, right after `this.updatePingPongMatch(nowMs)` (~line just before the character loop, near `this.tickAnimals(...)`), add:

```ts
    this.tickCampfire(dt, nowMs)
```

Add the method (recruiting/spawning filled in later tasks — for now just advance the reducer and count dancers):

```ts
  private tickCampfire(_dt: number, nowMs: number): void {
    if (!this.fireTile) return
    const dancerCount = this.countSeatedDancers()
    const { state, events } = advanceCampfire(this.campfire, _dt * 1000, { nowMs, dancerCount })
    this.campfire = state
    for (const ev of events) {
      if (ev === 'hatch') this.hatchDragon()
      // 'start_dancing' / 'rotate' / 'start_burndown' / 'lay_egg' handled in later tasks.
    }
  }

  /** Count agents currently standing on a dance slot. */
  private countSeatedDancers(): number {
    let n = 0
    for (const id of this.campfire.dancers) {
      const ch = this.characters.get(id)
      if (ch && ch.tripTile && ch.tileCol === ch.tripTile.col && ch.tileRow === ch.tripTile.row) n++
    }
    return n
  }

  /** Spawn one baby dragon near the fire (filled in Task 8). */
  private hatchDragon(): void { /* implemented in Task 8 */ }
```

- [ ] **Step 5: Resolve geometry on construction**

Find where the constructor finishes initial layout setup (after the first `rebuildVisibleState()` / wherever `this.layout` is first valid). The simplest safe hook: call `this.resolveCampfireGeometry()` at the end of the constructor (after `ensureGreeter()` or equivalent). If geometry depends on `tileMap`/`blockedTiles` being built, place the call after those are initialized. (`rebuildFromLayout` already re-resolves, so this only matters for the initial default layout.)

- [ ] **Step 6: Typecheck + tests**

Run: `cd webview-ui && npx tsc --noEmit` → PASS
Run: `cd .. && node_modules/.bin/vitest run` → PASS (server + campfire)

- [ ] **Step 7: Commit**

```bash
git add webview-ui/src/office/engine/officeState.ts
git commit -m "feat(campfire): wire CampfireState + geometry resolution + reducer tick into OfficeState"
```

---

## Task 5: Wood-gathering trip (`campfire_wood`)

**Files:**
- Modify: `webview-ui/src/office/engine/officeState.ts`

- [ ] **Step 1: Recruitment gate**

Add near `canStartPingPong` (~line 1397):

```ts
  /** True when this idle agent should go fetch wood: fire is growing, has capacity,
   *  and a woodpile + a free drop tile exist. */
  private canStartCampfireWood(ch: Character): boolean {
    if (!this.fireTile || !this.woodpileTile) return false
    if (this.campfire.phase !== 'growing') return false
    if (this.campfire.woodLevel + this.campfire.woodReserved >= WOOD_TO_FULL) return false
    return this.findFreeWoodDropTile(ch) !== null
  }

  /** The four free edge-center tiles of the 3×3 used to stand and toss wood in. */
  private findFreeWoodDropTile(ch: Character): Tile | null {
    if (!this.fireTile) return null
    const f = this.fireTile
    const edges: Tile[] = [
      { col: f.col, row: f.row - 1 },
      { col: f.col + 1, row: f.row },
      { col: f.col, row: f.row + 1 },
      { col: f.col - 1, row: f.row },
    ]
    let best: Tile | null = null
    let bestDist = Infinity
    for (const s of edges) {
      const key = `${s.col},${s.row}`
      const mine = ch.tripTile && ch.tripTile.col === s.col && ch.tripTile.row === s.row
      if (this.occupiedTripTiles.has(key) && !mine) continue
      if (this.blockedTiles.has(key) && !mine) continue
      const t = this.tileMap[s.row]?.[s.col]
      if (t === undefined) continue
      const dist = Math.abs(s.col - ch.tileCol) + Math.abs(s.row - ch.tileRow)
      if (dist < bestDist) { best = s; bestDist = dist }
    }
    return best
  }
```

- [ ] **Step 2: Hook into `desiredTripFor`**

In `desiredTripFor` (~line 1719), inside the `if (!ch.isActive)` block, BEFORE the planting checks (so building the fire takes priority over lounging but planting-after-work still wins — place it right after the in-flight `chess/ping_pong/pool` commitment checks and before `canStartPingPong`):

```ts
      // Stay committed to an in-flight wood run.
      if (ch.tripMode === 'campfire_wood') return 'campfire_wood'
      // Start a wood run if the fire wants feeding.
      if (this.canStartCampfireWood(ch)) return 'campfire_wood'
```

Note: the in-flight `campfire_dance` commitment is handled in Task 6; add `if (ch.tripMode === 'campfire_dance') return 'campfire_dance'` there.

- [ ] **Step 3: `startTrip` case + reservation**

In `startTrip` (~line 1620), add a branch in the target-selection if/else chain (before the final `else`):

```ts
    } else if (type === 'campfire_wood') {
      target = this.woodpileTile
      if (target) this.campfire = { ...this.campfire, woodReserved: this.campfire.woodReserved + 1 }
```

(The agent first walks to the woodpile; the second leg to the drop tile is issued on arrival in the update loop, Step 4.)

- [ ] **Step 4: Update-loop handling — pickup → carry → drop → grow**

In `update()`, right after the planting timer block (~line 2129), add:

```ts
      // Campfire wood run: woodpile → carry → drop tile → grow the fire.
      if (ch.tripMode === 'campfire_wood' && ch.tripTile && ch.state !== CharacterState.WALK && ch.path.length === 0) {
        const atWoodpile = this.woodpileTile && ch.tileCol === this.woodpileTile.col && ch.tileRow === this.woodpileTile.row
        if (atWoodpile && !ch.carrying) {
          // Picked up a log — now head to a free drop tile by the fire.
          const drop = this.findFreeWoodDropTile(ch)
          if (drop) {
            const path = findPath(ch.tileCol, ch.tileRow, drop.col, drop.row, this.tileMap, this.blockedTiles)
            if (path.length > 0) {
              ch.carrying = true
              this.occupiedTripTiles.add(`${drop.col},${drop.row}`)
              ch.tripTile = drop
              ch.path = path
              ch.moveProgress = 0
              ch.state = CharacterState.WALK
              ch.frame = 0
              ch.frameTimer = 0
            }
          }
        } else if (ch.carrying && this.fireTile &&
                   ch.tripTile.col !== this.woodpileTile?.col) {
          // Arrived at the drop tile — face the fire and run the drop timer.
          ch.dir = directionBetween(ch.tileCol, ch.tileRow, this.fireTile.col, this.fireTile.row)
          if (ch.woodDropTimer === undefined) ch.woodDropTimer = DROP_DURATION_MS
          ch.woodDropTimer -= dt * 1000
          if (ch.woodDropTimer <= 0) {
            this.campfire = addWood({ ...this.campfire, woodReserved: Math.max(0, this.campfire.woodReserved - 1) }, nowMs)
            ch.woodDropTimer = undefined
            ch.carrying = false
            this.endTrip(ch)
          }
        }
      }
```

Add the import for `directionBetween` if not already imported (check the top of `officeState.ts`; `characters.ts` uses it — it's exported from there or `tileMap.ts`). If unavailable, compute facing inline:
```ts
// fallback facing toward the fire:
ch.dir = Math.abs(this.fireTile.col - ch.tileCol) > Math.abs(this.fireTile.row - ch.tileRow)
  ? (this.fireTile.col > ch.tileCol ? Direction.RIGHT : Direction.LEFT)
  : (this.fireTile.row > ch.tileRow ? Direction.DOWN : Direction.UP)
```

- [ ] **Step 5: Reset carrying/timer on layout rebuild**

In the `rebuildFromLayout` per-character clear loop (the `for (const ch ...)` at ~289), add inside the loop:

```ts
      ch.carrying = false
      ch.woodDropTimer = undefined
```

- [ ] **Step 6: Typecheck + run app**

Run: `cd webview-ui && npx tsc --noEmit` → PASS
Then run the app (Task 12 instructions). Expected: idle agents walk to the woodpile, then to a fire edge, pause, and `campfire.woodLevel` climbs. (Carried-log/flame visuals come later; verify via behavior + temporary `console.log(this.campfire.woodLevel)` if needed, removed before commit.)

- [ ] **Step 7: Commit**

```bash
git add webview-ui/src/office/engine/officeState.ts
git commit -m "feat(campfire): wood-gathering trip — fetch from woodpile, carry, drop, grow fire"
```

---

## Task 6: Dance recruitment, ring assignment, rotation, release

**Files:**
- Modify: `webview-ui/src/office/engine/officeState.ts`

- [ ] **Step 1: `desiredTripFor` — keep dancers committed**

In `desiredTripFor` `!ch.isActive` block, add (near the other in-flight commitments):

```ts
      if (ch.tripMode === 'campfire_dance') return 'campfire_dance'
```

Dancers are assigned imperatively (below), not via `canStart…`, so no `canStartCampfireDance` in the priority chain — recruitment happens in `tickCampfire`.

- [ ] **Step 2: `startTrip` case for dancing**

In `startTrip` target selection, add:

```ts
    } else if (type === 'campfire_dance') {
      target = this.findFreeDanceSlot(ch)
```

Add the helper near `findFreeWoodDropTile`:

```ts
  /** Closest free dance-ring slot, or null. */
  private findFreeDanceSlot(ch: Character): Tile | null {
    let best: Tile | null = null
    let bestDist = Infinity
    for (const s of this.danceSlots) {
      const key = `${s.col},${s.row}`
      const mine = ch.tripTile && ch.tripTile.col === s.col && ch.tripTile.row === s.row
      if (this.occupiedTripTiles.has(key) && !mine) continue
      if (this.blockedTiles.has(key) && !mine) continue
      const dist = Math.abs(s.col - ch.tileCol) + Math.abs(s.row - ch.tileRow)
      if (dist < bestDist) { best = s; bestDist = dist }
    }
    return best
  }
```

- [ ] **Step 3: Recruit + rotate in `tickCampfire`**

Replace the `tickCampfire` body's event loop and add recruiting:

```ts
  private tickCampfire(dt: number, nowMs: number): void {
    if (!this.fireTile) return

    // Recruit dancers whenever the fire is full or dancing and slots remain.
    if (this.campfire.phase === 'full' || this.campfire.phase === 'dancing') {
      this.recruitDancers()
    }

    const dancerCount = this.countSeatedDancers()
    const { state, events } = advanceCampfire(this.campfire, dt * 1000, { nowMs, dancerCount })
    this.campfire = state

    for (const ev of events) {
      if (ev === 'rotate') this.rotateDancers()
      else if (ev === 'start_burndown') this.releaseDancers()
      else if (ev === 'lay_egg') { /* egg renders from phase; nothing to do */ }
      else if (ev === 'hatch') this.hatchDragon()
    }

    // Face every seated dancer toward the fire + flag them as transformed.
    for (const id of this.campfire.dancers) {
      const ch = this.characters.get(id)
      if (!ch || !ch.tripTile) continue
      if (ch.tileCol === ch.tripTile.col && ch.tileRow === ch.tripTile.row) {
        ch.dir = this.facingToward(ch, this.fireTile)
        ch.danced = true
      }
    }
  }

  private facingToward(ch: Character, t: Tile): Direction {
    return Math.abs(t.col - ch.tileCol) > Math.abs(t.row - ch.tileRow)
      ? (t.col > ch.tileCol ? Direction.RIGHT : Direction.LEFT)
      : (t.row > ch.tileRow ? Direction.DOWN : Direction.UP)
  }

  /** Pull idle agents onto free dance slots, up to the ring capacity. */
  private recruitDancers(): void {
    const live = this.campfire.dancers.filter((id) => {
      const ch = this.characters.get(id)
      return ch && ch.tripMode === 'campfire_dance'
    })
    let changed = live.length !== this.campfire.dancers.length
    let dancers = live
    for (const ch of this.characters.values()) {
      if (dancers.length >= this.danceSlots.length) break
      if (ch.isGreeter || ch.isKnight || ch.isActive || ch.matrixEffect) continue
      if (ch.tripMode === 'campfire_dance') continue
      // Don't yank an agent mid wood-drop; let them finish.
      if (ch.tripMode === 'campfire_wood' && ch.carrying) continue
      if (this.findFreeDanceSlot(ch) === null) continue
      // Free any current trip tile before reassigning.
      if (ch.tripTile) { this.occupiedTripTiles.delete(`${ch.tripTile.col},${ch.tripTile.row}`); ch.tripTile = null; ch.tripMode = null }
      if (this.startTrip(ch, 'campfire_dance')) { dancers.push(ch.id); changed = true }
    }
    if (changed) this.campfire = { ...this.campfire, dancers }
  }

  /** Advance every seated dancer one slot clockwise. */
  private rotateDancers(): void {
    const seated = this.campfire.dancers
      .map((id) => this.characters.get(id))
      .filter((ch): ch is Character => !!ch && !!ch.tripTile)
    if (seated.length < 2) return
    // Current slot index for each dancer, in ring order.
    const slotIndex = (ch: Character) =>
      this.danceSlots.findIndex((s) => s.col === ch.tripTile!.col && s.row === ch.tripTile!.row)
    for (const ch of seated) {
      const idx = slotIndex(ch)
      if (idx < 0) continue
      const next = this.danceSlots[(idx + 1) % this.danceSlots.length]
      const nextKey = `${next.col},${next.row}`
      if (this.occupiedTripTiles.has(nextKey)) continue // someone hasn't moved yet; skip this tick
      const path = findPath(ch.tileCol, ch.tileRow, next.col, next.row, this.tileMap, this.blockedTiles)
      if (path.length === 0) continue
      this.occupiedTripTiles.delete(`${ch.tripTile!.col},${ch.tripTile!.row}`)
      this.occupiedTripTiles.add(nextKey)
      ch.tripTile = next
      ch.path = path
      ch.moveProgress = 0
      ch.state = CharacterState.WALK
      ch.frame = 0
      ch.frameTimer = 0
    }
  }

  /** End the dance: send all dancers home. */
  private releaseDancers(): void {
    for (const id of this.campfire.dancers) {
      const ch = this.characters.get(id)
      if (ch) this.endTrip(ch)
    }
    this.campfire = { ...this.campfire, dancers: [] }
  }
```

Note: a slot may be briefly double-reserved during rotation; the `occupiedTripTiles.has(nextKey)` guard skips a dancer whose next slot isn't vacated yet, and they catch up next rotation. Acceptable for ambient motion.

- [ ] **Step 4: Typecheck + run app**

Run: `cd webview-ui && npx tsc --noEmit` → PASS
Run the app. Expected: once `woodLevel` hits 8, idle agents converge on the ring, face the fire, and every ~3s shuffle one position around the circle; after 2 minutes they walk back to their desks.

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/office/engine/officeState.ts
git commit -m "feat(campfire): dance recruitment, clockwise rotation, and release after 2m"
```

---

## Task 7: Cancel campfire trips when an agent goes active

**Files:**
- Modify: `webview-ui/src/office/engine/officeState.ts`

- [ ] **Step 1: Extend `setAgentActive` cancellation**

In `setAgentActive` (~line 872), in the `else` branch (agent re-activated), after the existing planting cancellation, add:

```ts
        // Re-activated mid-ritual — bail out of any campfire trip cleanly.
        if (ch.tripMode === 'campfire_wood') {
          if (ch.carrying) this.campfire = { ...this.campfire, woodReserved: Math.max(0, this.campfire.woodReserved - 1) }
          ch.carrying = false
          ch.woodDropTimer = undefined
        }
        if (ch.tripMode === 'campfire_dance') {
          this.campfire = { ...this.campfire, dancers: this.campfire.dancers.filter((d) => d !== id) }
        }
```

(`danced` is intentionally NOT cleared — the transformation is permanent.)

- [ ] **Step 2: Typecheck + tests**

Run: `cd webview-ui && npx tsc --noEmit` → PASS
Run: `cd .. && node_modules/.bin/vitest run` → PASS

- [ ] **Step 3: Commit**

```bash
git add webview-ui/src/office/engine/officeState.ts
git commit -m "feat(campfire): cancel wood/dance trips when an agent resumes real work"
```

---

## Task 8: Burn-down → egg → baby dragon (animals system)

**Files:**
- Modify: `webview-ui/src/office/engine/officeState.ts`

- [ ] **Step 1: Extend the animals union to include the dragon**

In the `animals: Array<{ kind: 'rabbit' | 'squirrel'; ... }>` declaration (~line 236), change:

```ts
    kind: 'rabbit' | 'squirrel' | 'baby-dragon'
```

- [ ] **Step 2: Implement `hatchDragon` (replace the Task-4 stub)**

```ts
  /** Hatch one baby dragon, fanned out around the fire so a brood clusters. */
  private hatchDragon(): void {
    if (!this.fireTile) return
    const broodCount = this.animals.filter((a) => a.kind === 'baby-dragon').length
    // Golden-angle fan so each new dragon sits at a fresh spot around the fire.
    const angle = broodCount * 2.39996
    const radiusPx = TILE_SIZE * 1.6
    const fx = this.fireTile.col * TILE_SIZE + TILE_SIZE / 2
    const fy = this.fireTile.row * TILE_SIZE + TILE_SIZE / 2
    const homeX = fx + Math.cos(angle) * radiusPx
    const homeY = fy + Math.sin(angle) * radiusPx
    this.animals.push({
      kind: 'baby-dragon',
      homeX, homeY,
      watchX: homeX, watchY: homeY,   // dragons ignore the "watch" gather; keep == home
      x: fx, y: fy,                   // born at the egg, then settles to home
      facing: Math.cos(angle) >= 0 ? 'right' : 'left',
      targetX: homeX, targetY: homeY,
      nextHopAt: performance.now() + Math.random() * 2000,
    })
  }
```

- [ ] **Step 3: Keep dragons near the fire (small hop radius)**

`tickAnimals` (~line 1522) uses a single `ANIMAL_HOP_RADIUS_PX`. To make dragons stay put and curl up, give them a tiny radius. In `tickAnimals`, inside the per-animal loop where the new target is chosen, replace the hop-radius usage:

```ts
        const r = a.kind === 'baby-dragon' ? 6 : OfficeState.ANIMAL_HOP_RADIUS_PX
```

Also, dragons should not run to the "watch" tile when hero PCs are active — they belong to the fire. In `tickAnimals`, where `watching` forces `tx/ty = a.watchX/watchY`, guard it:

```ts
    const watching = this.isAllHeroOccupied()
    // ...
      if (watching && a.kind !== 'baby-dragon') {
        tx = a.watchX; ty = a.watchY; a.nextHopAt = nowMs + 600
      } else {
        // existing random-hop logic
      }
```

- [ ] **Step 4: Typecheck + run app**

Run: `cd webview-ui && npx tsc --noEmit` → PASS
Run the app. Expected: after a dance + ~4s burndown + ~15s egg wait, a dragon appears at the fire (it will render as a fallback until Task 9 adds `drawBabyDragon`, so verify via `this.animals` length growing, or proceed to Task 9 then re-verify).

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/office/engine/officeState.ts
git commit -m "feat(campfire): hatch baby dragons into the animals system, clustered by the fire"
```

---

## Task 9: Rendering — flames by wood level, egg, dragon, carried log

**Files:**
- Modify: `webview-ui/src/office/engine/renderer.ts`
- Modify: `webview-ui/src/office/components/OfficeCanvas.tsx`

- [ ] **Step 1: Add a render-state type and thread it through `renderFrame`**

In `renderer.ts`, near the other render-state interfaces, add:

```ts
export interface CampfireRenderState {
  fireTile: { col: number; row: number } | null
  woodLevel: number          // 0..max
  woodMax: number
  phase: 'growing' | 'full' | 'dancing' | 'burning_down' | 'egg' | 'hatching'
}
```

Add a parameter to `renderFrame` (after `animals?`):

```ts
  campfire?: CampfireRenderState,
```

- [ ] **Step 2: Parameterize `renderCampfireFlames`**

Replace the `renderCampfireFlames` signature + first lines (~1107) to accept the campfire render state, scaling flame height + halo by `woodLevel`, and handling burndown/egg phases. Replace the function with:

```ts
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
  const level = campfire ? campfire.woodLevel / Math.max(1, campfire.woodMax) : 1
  // 'egg' shows only faint embers; 'burning_down' fades from full → embers over its window.
  const intensity = phase === 'egg' ? 0.15 : phase === 'growing' || phase === 'full' || phase === 'dancing'
    ? 0.35 + 0.65 * level
    : 0.5 // burning_down: mid (the phase is brief)
  const { col, row } = tile
  const cx = (col * TILE_SIZE + TILE_SIZE / 2)
  const baseY = (row * TILE_SIZE + 7)
  const cell = Math.max(1, Math.round(zoom))
  ctx.save()

  const halo = 0.85 + 0.15 * Math.sin(timeMs * 0.005)
  const haloR = (8 + 10 * intensity) * zoom * halo
  const px = offsetX + cx * zoom
  const py = offsetY + baseY * zoom
  const haloGrad = ctx.createRadialGradient(px, py, 0, px, py, haloR)
  haloGrad.addColorStop(0, `rgba(255, 200, 80, ${0.55 * intensity + 0.15})`)
  haloGrad.addColorStop(0.5, `rgba(255, 140, 40, ${0.25 * intensity})`)
  haloGrad.addColorStop(1, 'rgba(255, 100, 20, 0)')
  ctx.fillStyle = haloGrad
  ctx.beginPath(); ctx.arc(px, py, haloR, 0, Math.PI * 2); ctx.fill()

  if (phase !== 'egg') {
    const flameLayers = [
      { dx: 0, h: 9, w: 4, color1: '#fff09a', color2: '#ffae40', freq: 0.012, phase: 0 },
      { dx: -3, h: 6, w: 3, color1: '#ffae40', color2: '#ff5020', freq: 0.014, phase: 1.3 },
      { dx: 3, h: 6, w: 3, color1: '#ffae40', color2: '#ff5020', freq: 0.014, phase: 2.7 },
    ]
    for (const f of flameLayers) {
      const wobble = Math.sin(timeMs * f.freq + f.phase) * 1.2
      const fheight = ((f.h * (0.4 + 0.6 * intensity)) + Math.sin(timeMs * f.freq * 0.7 + f.phase) * 1.5) * zoom
      const fwidth = f.w * (0.6 + 0.4 * intensity) * zoom
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
    // Egg in the ashes.
    drawEgg(ctx, px, py, zoom, timeMs)
  }

  // Sparks (fewer when low / embers).
  const sparkCount = Math.round(2 + 6 * intensity)
  for (let i = 0; i < sparkCount; i++) {
    const ph = ((timeMs * 0.0009) + i * 0.13) % 1
    const sy = py - ph * 22 * zoom
    const sx = px + Math.sin(ph * Math.PI * 4 + i) * 4 * zoom
    const a = (1 - ph) * 0.9 * intensity
    ctx.fillStyle = `rgba(255, ${180 + Math.floor(60 * (1 - ph))}, 60, ${a})`
    ctx.fillRect(sx, sy, cell, cell)
  }
  ctx.restore()
}
```

- [ ] **Step 3: `drawEgg`**

Add near `drawRabbit` (~1016):

```ts
/** A speckled dragon egg sitting in the embers; tiny wobble as it nears hatching. */
function drawEgg(ctx: CanvasRenderingContext2D, px: number, py: number, zoom: number, timeMs: number): void {
  const wob = Math.sin(timeMs * 0.006) * 0.5 * zoom
  const w = 7 * zoom, h = 9 * zoom
  const cx = px + wob, cy = py - h / 2
  ctx.save()
  ctx.fillStyle = '#e8e0c8'
  ctx.beginPath(); ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#7bbf5a' // green speckles
  const cell = Math.max(1, Math.round(zoom))
  ctx.fillRect(cx - 2 * zoom, cy - 1 * zoom, cell, cell)
  ctx.fillRect(cx + 1 * zoom, cy + 2 * zoom, cell, cell)
  ctx.fillRect(cx, cy - 3 * zoom, cell, cell)
  ctx.restore()
}
```

- [ ] **Step 4: `drawBabyDragon` + render it**

In `renderAnimals` (~1095) add the branch:

```ts
    if (a.kind === 'rabbit') drawRabbit(ctx, cx, cy, cell, a.facing, timeMs)
    else if (a.kind === 'baby-dragon') drawBabyDragon(ctx, cx, cy, cell, a.facing, timeMs)
    else drawSquirrel(ctx, cx, cy, cell, a.facing, timeMs)
```

Change `ForestAnimal` (~1008) kind union to include `'baby-dragon'`:

```ts
  kind: 'rabbit' | 'squirrel' | 'baby-dragon'
```

Add the draw fn near `drawSquirrel`:

```ts
/** A tiny green baby dragon: round body, stubby wings that flap, a horn, and a curl of breath. */
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
  // Body
  ctx.fillStyle = '#3fa85a'
  ctx.beginPath(); ctx.ellipse(0, 0, 4 * cell, 3.2 * cell, 0, 0, Math.PI * 2); ctx.fill()
  // Belly
  ctx.fillStyle = '#bfe89a'
  ctx.beginPath(); ctx.ellipse(0, 1.2 * cell, 2.4 * cell, 1.8 * cell, 0, 0, Math.PI * 2); ctx.fill()
  // Head
  ctx.fillStyle = '#3fa85a'
  ctx.beginPath(); ctx.ellipse(dir * 3.2 * cell, -2.4 * cell, 2.6 * cell, 2.2 * cell, 0, 0, Math.PI * 2); ctx.fill()
  // Horn
  ctx.fillStyle = '#e8e0c8'
  ctx.fillRect(dir * 3.2 * cell - cell / 2, -4.8 * cell, cell, 1.6 * cell)
  // Eye
  ctx.fillStyle = '#111'
  ctx.fillRect(dir * 4 * cell, -3 * cell, cell, cell)
  // Wing (flaps)
  ctx.fillStyle = '#2e8047'
  ctx.beginPath()
  ctx.moveTo(-dir * cell, -cell)
  ctx.lineTo(-dir * 4 * cell, -2.5 * cell - flap)
  ctx.lineTo(-dir * 3.5 * cell, cell)
  ctx.closePath(); ctx.fill()
  ctx.restore()
}
```

- [ ] **Step 5: `drawCarriedLog` over carrying agents**

Add a small renderer that draws a log above any `ch.carrying` character. Add this function near `renderPlantingProgress` and call it in `renderFrame` right after `renderPlantingProgress` (~2162):

```ts
function renderCarriedLogs(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number, offsetY: number, zoom: number,
): void {
  for (const ch of characters) {
    if (!ch.carrying) continue
    const px = offsetX + (ch.x - 5) * zoom
    const py = offsetY + (ch.y - CHARACTER_HIT_HEIGHT - 2) * zoom
    const w = 10 * zoom, h = 3 * zoom
    ctx.save()
    ctx.fillStyle = '#6b4a2b'
    ctx.fillRect(px, py, w, h)
    ctx.fillStyle = '#caa06a' // log end-grain
    ctx.fillRect(px, py, 2 * zoom, h)
    ctx.fillRect(px + w - 2 * zoom, py, 2 * zoom, h)
    ctx.restore()
  }
}
```

Call site in `renderFrame`:

```ts
  renderCarriedLogs(ctx, characters, offsetX, offsetY, zoom)
```

(Use the existing `CHARACTER_HIT_HEIGHT` constant if exported in `renderer.ts`; if it lives elsewhere, use a literal `24`.)

- [ ] **Step 6: Pass campfire state into `renderCampfireFlames` and `renderFrame`**

In `renderFrame`, update the `renderCampfireFlames(...)` call (~2159):

```ts
  renderCampfireFlames(ctx, offsetX, offsetY, zoom, timeMs ?? performance.now(), campfire)
```

In `OfficeCanvas.tsx` (the `renderFrame(...)` call at ~224), pass a campfire render-state argument in the matching position (after the `animals` arg). Build it from the office state:

```ts
        campfire: undefined, // replaced below
```

Concretely, before the `renderFrame` call, compute:

```ts
    const os = officeStateRef.current // however OfficeCanvas accesses OfficeState
    const campfireRender = {
      fireTile: os.getCampfireFireTile(),
      woodLevel: os.campfire.woodLevel,
      woodMax: WOOD_TO_FULL,
      phase: os.campfire.phase,
    }
```

and pass `campfireRender` as the new last argument to `renderFrame(...)`. Add a getter to `OfficeState`:

```ts
  getCampfireFireTile(): { col: number; row: number } | null { return this.fireTile }
```

Import `WOOD_TO_FULL` in `OfficeCanvas.tsx` from `../engine/campfire.js`. Match the existing `renderFrame` argument order exactly — `campfire` is the final positional parameter added in Step 1.

- [ ] **Step 7: Typecheck + run app**

Run: `cd webview-ui && npx tsc --noEmit` → PASS
Run the app. Expected full visual loop: flames grow with each log (carried log visible in-hand), dancers ring the fire, fire shrinks to an egg, egg hatches a green baby dragon that settles by the fire; dragons accumulate over cycles.

- [ ] **Step 8: Commit**

```bash
git add webview-ui/src/office/engine/renderer.ts webview-ui/src/office/components/OfficeCanvas.tsx webview-ui/src/office/engine/officeState.ts
git commit -m "feat(campfire): render flames by wood level, egg, baby dragon, carried log"
```

---

## Task 10: Loincloth transformation (danced agents)

**Files:**
- Create: `webview-ui/src/office/sprites/dancedSprites.ts`
- Modify: `webview-ui/src/office/engine/renderer.ts`

- [ ] **Step 1: Inspect the pre-colored sprite's shirt pixels**

Before coding, confirm how shirt pixels appear in the real (pre-colored) sprites. Add a temporary log in `renderScene` (renderer.ts ~143) for one frame:

```ts
// TEMP: inspect — remove before commit
if ((window as any).__dumpSprite && ch.palette === 0) {
  console.log(JSON.stringify(getCharacterSprites(0, 0).walk))
  ;(window as any).__dumpSprite = false
}
```

Run the app, set `window.__dumpSprite = true` in the console, and inspect: confirm whether shirt pixels equal `CHARACTER_PALETTES[0].shirt` (`#4488CC`). **Decision:**
- If pixels match the palette `shirt` hex → use the hex-swap recolor below.
- If they don't (antialiasing / different hues) → use the overlay fallback (Step 4).
Remove the temp log afterward.

- [ ] **Step 2: Implement the recolor module (hex-swap path)**

Create `webview-ui/src/office/sprites/dancedSprites.ts`:

```ts
import { getCharacterSprites, CHARACTER_PALETTES } from './spriteData.js'
import type { CharacterSprites } from './spriteData.js' // export this type if not already

const cache = new Map<string, CharacterSprites>()
const LOINCLOTH = '#7a5230' // earthy brown

/** Danced agents: shirt pixels → bare skin, pants → loincloth brown. Cached per palette. */
export function getDancedCharacterSprites(paletteIndex: number, hueShift = 0): CharacterSprites {
  const key = `${paletteIndex}:${hueShift}`
  const hit = cache.get(key)
  if (hit) return hit
  const base = getCharacterSprites(paletteIndex, hueShift)
  const pal = CHARACTER_PALETTES[paletteIndex % CHARACTER_PALETTES.length]
  const swap = (hex: string): string => {
    const h = hex.toUpperCase()
    if (h === pal.shirt.toUpperCase()) return pal.skin // bare torso
    if (h === pal.pants.toUpperCase()) return LOINCLOTH
    return hex
  }
  const mapGrid = (g: string[][]): string[][] => g.map((row) => row.map((c) => (c ? swap(c) : c)))
  const mapDir = (frames: string[][][]) => frames.map(mapGrid)
  const mapSet = (set: Record<number, string[][][]>) => {
    const out: Record<number, string[][][]> = {}
    for (const k of Object.keys(set)) out[Number(k)] = mapDir(set[Number(k)])
    return out
  }
  const danced: CharacterSprites = {
    walk: mapSet(base.walk) as CharacterSprites['walk'],
    typing: mapSet(base.typing) as CharacterSprites['typing'],
    reading: mapSet(base.reading) as CharacterSprites['reading'],
  }
  cache.set(key, danced)
  return danced
}
```

If `CharacterSprites` isn't exported from `spriteData.ts`, add `export` to its `interface CharacterSprites`. Verify the sprite frame type is `string[][]` (pixel grid of hex/empty strings) — adjust `mapGrid` if frames are stored differently.

- [ ] **Step 3: Branch the character render on `danced`**

In `renderScene` (renderer.ts ~143), replace:

```ts
    const sprites = getCharacterSprites(ch.palette, ch.hueShift)
```

with:

```ts
    const sprites = ch.danced
      ? getDancedCharacterSprites(ch.palette, ch.hueShift)
      : getCharacterSprites(ch.palette, ch.hueShift)
```

Add the import at the top of `renderer.ts`:

```ts
import { getDancedCharacterSprites } from '../sprites/dancedSprites.js'
```

- [ ] **Step 4: Fallback (only if Step 1 showed shirt pixels don't match)**

Instead of Step 2/3, draw an overlay after the sprite in `renderScene`: a skin-tone rectangle over the torso rows and a loincloth strip. Implement `drawLoinclothOverlay(ctx, screenX, screenY, zoom, palette)` painting `pal.skin` over the upper-body band (rows ~ sprite height * 0.35–0.6) and `LOINCLOTH` over a 2px hip band, gated by `ch.danced`. Use this only as the fallback; prefer the recolor for crisp results.

- [ ] **Step 5: Typecheck + run app**

Run: `cd webview-ui && npx tsc --noEmit` → PASS
Run the app. Watch a full dance: participating agents become shirtless + loincloth and **stay that way** after returning to their desks (and across subsequent activity).

- [ ] **Step 6: Commit**

```bash
git add webview-ui/src/office/sprites/dancedSprites.ts webview-ui/src/office/sprites/spriteData.ts webview-ui/src/office/engine/renderer.ts
git commit -m "feat(campfire): permanent shirtless/loincloth transformation for danced agents"
```

---

## Task 11: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck both projects**

Run: `cd webview-ui && npx tsc --noEmit` → PASS
Run: `cd .. && node_modules/.bin/vitest run` → all PASS (server + campfire)

- [ ] **Step 2: Run the app and watch one full cycle**

Free port 3456 if a stale server holds it (`lsof -nP -iTCP:3456 -sTCP:LISTEN`), then `npm run dev` and open `http://localhost:5173`. With idle agents present, confirm in order:
1. Agents carry logs from the woodpile; flames + halo grow with each drop.
2. At 8 logs the fire is full; idle agents ring it, face inward, rotate clockwise ~every 3s.
3. Dancers become shirtless/loincloth permanently.
4. After ~2 min the fire shrinks to embers and an egg appears.
5. ~15s later a baby dragon hatches and settles by the fire.
6. The cycle repeats; dragons accumulate around the campfire.

- [ ] **Step 3: Confirm reset behavior**

In the layout editor (or by triggering a `layoutLoaded`), confirm `rebuildFromLayout` resets the ritual to `growing`/`woodLevel 0` and re-resolves geometry without errors, and that existing dragons remain.

- [ ] **Step 4: Remove any temp logging** left from Task 10 Step 1; re-run typecheck; commit if anything changed.

```bash
git add -A
git commit -m "chore(campfire): remove temp sprite-inspection logging" # only if needed
```

---

## Self-review (completed during planning)

- **Spec coverage:** wood gathering (Task 5), 3×3 fill / flame scaling (Tasks 4,9), 2-min dance + ring + rotation (Task 6), permanent loincloth (Task 10), burn-down→egg→dragon (Tasks 8,9), endless brood (Task 8), reset/persistence (Tasks 4,7,8,11), testable pure logic (Tasks 1–2). All covered.
- **Placeholders:** none — every code step contains concrete code; the only deliberately deferred decision (loincloth recolor vs overlay) has an explicit inspection step and concrete code for both paths.
- **Type consistency:** `CampfireState`, `CampfirePhase`, `Tile`, `CampfireContext`, `CampfireEvent`, `CampfireRenderState`, `getDancedCharacterSprites`, `getCampfireFireTile`, the `tripMode` values `'campfire_wood'`/`'campfire_dance'`, and `Character.danced`/`carrying`/`woodDropTimer` are used consistently across tasks.

## Risks / things to watch during implementation

- **`renderFrame` is a long positional-argument function.** Add `campfire` strictly as the final positional parameter and update the single call site in `OfficeCanvas.tsx:224` in the same task to avoid argument-order drift.
- **Pre-colored sprites:** Task 10 Step 1 must run before choosing the recolor vs overlay path.
- **Woodpile/ring tiles are layout-derived**, not hard-coded — if `resolveWoodpileTile`/`computeDanceSlots` return too few tiles in the real layout, widen their scan radius (constants in `campfire.ts`).
- **`directionBetween`/`Direction` imports** in `officeState.ts`: verify they're imported; a coordinate-compare fallback is provided.

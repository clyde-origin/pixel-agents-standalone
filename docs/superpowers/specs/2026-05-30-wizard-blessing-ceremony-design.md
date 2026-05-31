# Wizard Blessing Ceremony — Design

**Date:** 2026-05-30
**Status:** Approved (design)

## Summary

Add a wizard NPC seated behind a desk at the lounge↔workstation boundary. Every
agent — main sessions **and** subagents — must line up single-file at the desk
after appearing, receive a magical blessing, and have its computer summoned
before it walks to its station to work. The blessing happens on **first
appearance and on every reactivation** (full ceremony each time).

This extends the existing spawn ritual (matrix-spawn at the pad → spin →
high-five with the two greeter NPCs → walk to seat). The wizard step is inserted
**after** the greeter high-five and **before** the agent reaches its seat.

## Goals

- A persistent wizard NPC + desk at the central lounge/workstation boundary.
- Newly-appeared and reactivated agents queue single-file, get blessed one at a
  time, then proceed to work.
- A "spell" visual: a glowing rune circle pulses under the agent during the
  blessing; the wizard then casts a wand-bolt that arcs to the agent's empty
  desk, where the PC materializes (reusing the existing desk-reveal portal).
- The PC summon gesture always plays, but the desk only visibly materializes if
  it was not already revealed ("if needed").
- No soft-locks: a stalled queue head is auto-released after a safety timeout.

## Non-Goals

- No new persisted layout furniture. The wizard is code-injected (like the
  greeters), not added to `~/.pixel-agents/layout.json`.
- No change to how seats are assigned, how work/typing is rendered, or to the
  campfire/trip subsystems beyond adding one trip mode.
- No "skip the line" fast-path for reactivation — full ceremony every time, by
  explicit product choice.

## World Layout (resolved from the real `layout.json`)

The office splits into:
- **Workstation zone** — rows 1–23, tile type 1. Stations in cols 1–6 (left) and
  13–18 (right); central corridor cols 7–12 open. Agents walk north up this
  corridor to reach their station.
- **Lounge / hangout** — rows 24–34, tile type 2. Campfire (5,30), ping-pong
  (13,25), chess (3,25), pool (cols 12–17, rows 33–34), beanbags (7/11, 25/27),
  coffee tables (9,26) and (14,30). Spawn pad at **(9,33)**.

**Wizard placement** (central boundary, anchored in code, validated against
walkable tiles at build time):
- Wizard NPC stands behind the desk at ~**(10, 23)**, facing south.
- Desk fixture spans ~**(9–10, 24)** — the top edge of the lounge.
- Blessing spot (front of line) at ~**(10, 25)**, agent faces north.
- Line extends single-file **south**: (10,26), (10,27)… toward the pad, dodging
  the coffee table at (9,26).

Exact tiles are computed by `computeLineupTiles(deskTile, isWalkable)` so the
geometry survives layout edits, mirroring campfire's `computeDanceSlots`.

## Architecture

Three layers, mirroring the campfire ritual:

### 1. `webview-ui/src/office/engine/wizardDesk.ts` — pure state machine (DOM-free, unit-tested)

```ts
type WizardPhase = 'idle' | 'blessing'

interface WizardState {
  queue: number[]                 // agent ids; front (index 0) = being served / next up
  phase: WizardPhase
  blessTimer: number              // ms remaining in the current blessing (~1800)
  servingId: number | null        // the agent currently at the blessing spot
  enqueuedAt: Map<number, number> // id → ms enqueued, for the safety timeout
}

createWizardState(): WizardState
enqueue(state, id, nowMs): void          // no-op if already queued
dequeue(state, id): void                 // remove from anywhere in the line; clears serving if it was head
advanceWizard(state, dtMs, ctx): WizardEvent[]
computeLineupTiles(deskTile, isWalkable): Tile[]   // [blessingSpot, q1, q2, ...] ordered front→back
```

`advanceWizard` events:
- `'start_blessing'` — head agent has arrived at the blessing spot; begin rune pulse.
- `'cast_summon'` — blessing timer elapsed; fire the wand-bolt + desk reveal.
- `'release'` — front agent is done; send it to its seat and pop the queue.
- `'advance_line'` — everyone shifts forward one slot.
- `'evict'` — safety timeout fired for the served agent; release it anyway.

Tuning constants (exported): `BLESS_MS ≈ 1800`, `SAFETY_TIMEOUT_MS ≈ 20000`,
`MAX_LINE` (cap on rendered/queued line length; overflow waits off-slot).

### 2. `officeState.ts` — integration

- **New trip mode** `'wizard_blessing'` added to the `TripMode` union.
- **New per-character flag** `needsBlessing: boolean`.
- **Wizard NPC injection**: `ensureWizard()` (parallels `ensureGreeter()`),
  called from the constructor. Character with `isWizard = true`, sentinel id far
  below subagent ids. Desk tiles added to `blockedTiles`.
- **Seam 1 — first appearance**: when an agent finishes the SPAWNING
  spin + greeter high-five (the point where it would currently go IDLE → walk to
  seat), set `needsBlessing = true` and `enqueue`. It then walks to the back of
  the line instead of to its seat.
- **Seam 2 — reactivation**: `setAgentActive(id, true)` sets
  `needsBlessing = true` and enqueues (full ceremony). Must compose with
  existing reactivation teardown (`cancelCampfireTrip`, planting clears, etc.).
- **Trip wiring**: `startTrip(ch, 'wizard_blessing')` targets the agent's current
  line slot and reserves it in `occupiedTripTiles`. `desiredTripFor` returns
  `'wizard_blessing'` whenever `needsBlessing` is set, taking priority over all
  other trips.
- **Line advancement**: on `'advance_line'`, use the campfire `rotateDancers`
  two-phase technique — release all current line-tile reservations, then
  reassign each queued agent to the next slot and re-path. Avoids
  release/reserve races.
- **Summon**: on `'cast_summon'`, trigger the agent's existing `revealDesk(gid)`
  portal. The wand-bolt is the visual; the materialize only changes anything if
  the desk was not already revealed.
- **Release**: on `'release'` / `'evict'`, clear `needsBlessing`, free the line
  reservation, restore `seatId`, and path the agent to its seat to start work.

### 3. `renderer.ts` — visuals

- `renderWizard(...)` — desk fixture + wizard sprite (hat/robe/staff), cast pose
  while `phase === 'blessing'`.
- `renderBlessingRune(...)` — pulsing glowing rune circle under the agent at the
  blessing spot.
- `renderSummonBolt(...)` — light bolt arcing wizard → seat on `'cast_summon'`,
  landing where the desk-reveal portal fires.
- New render-state inputs are **appended to the end** of the positional
  `renderFrame(...)` signature; the single `OfficeCanvas.tsx` call site is
  updated in the same change (arg count verified).

## Data Flow (one agent)

```
appear (or reactivate)
  → [first appearance only] matrix-spawn → spin → greeter high-five
  → needsBlessing = true; enqueue
  → walk to back of line (wizard_blessing trip; slot reserved)
  → line advances forward as heads finish (advance_line)
  → reach blessing spot → start_blessing → rune pulses ~1.8s
  → cast_summon → wand-bolt arcs to seat → revealDesk (materialize if hidden)
  → release → needsBlessing = false → walk to seat → TYPE (work)
```

## Lifecycle Correctness (known traps)

- **`rebuildFromLayout`**: reset `WizardState` (clear queue/timers/serving),
  recompute `computeLineupTiles` from the (possibly moved) desk anchor, re-block
  desk tiles, clear any in-flight `wizard_blessing` trips, re-inject the wizard
  NPC. Stale line tiles otherwise soft-lock.
- **`removeSubagent` / `removeAllSubagents`**: `dequeue` the agent and free its
  line-tile reservation — subagents queue too and can be torn down mid-line.
- **`setAgentActive(_, false)`** while queued: `dequeue` and free the slot.
- **Safety timeout**: a served agent that can't reach the blessing spot within
  `SAFETY_TIMEOUT_MS` is evicted to its seat (mirrors the knighting-queue safety
  net), so one stuck head can't freeze the whole line.
- **Type-only import trap**: import `TileType` / `Direction` / `CharacterState`
  as **values** (esbuild strips type-only imports; vite build does not
  typecheck).

## Testing

- **`wizardDesk.test.ts`** (pure, ≈campfire depth): enqueue/dequeue idempotence,
  single-file ordering, blessing timer → `cast_summon` → `release` sequence,
  `advance_line` after a release, safety-timeout `evict`, dequeue of a non-head
  mid-line, `computeLineupTiles` ordering + walkability + `MAX_LINE` cap.
- **Manual** (`npm run dev`): watch a fresh spawn and a reactivation both route
  through the line; confirm the rune + summon-bolt + desk materialize; confirm
  the line advances and no agent soft-locks.
- **Gates before "done"**: `npx tsc --noEmit -p tsconfig.json` (server) +
  `cd webview-ui && npx tsc --noEmit` + `node_modules/.bin/vitest run` all green.

## Open Questions

None blocking. Exact pixel art for the wizard sprite and rune will be tuned
during implementation against the running app.

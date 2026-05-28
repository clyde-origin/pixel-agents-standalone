# Campfire Ritual — Design Spec

**Date:** 2026-05-27
**Status:** Approved for planning

## Summary

An ambient, perpetual ritual built around the existing campfire in the lounge.
Idle agents gather wood and feed a fire until it fills a 3×3 area; they then dance
around it for two minutes (losing their shirts to loincloths, permanently); the
fire burns down to an egg; the egg hatches into a baby dragon that lives by the
fire. The cycle repeats forever, accumulating an endless brood of dragons around
the campfire.

The feature rides almost entirely on systems that already exist: the leisure-trip
system (`tripMode`), the per-frame `update()` loop, tile pathfinding, the procedural
`renderCampfireFlames` glow, and the `animals` creature system.

## The ritual loop (arc)

```
embers
  → idle agent carries a log from the woodpile, tosses it in → fire grows a stage
  → (repeat until woodLevel == WOOD_TO_FULL)
  → FULL (glow covers the 3×3)
  → idle agents gather on a ring and DANCE for 2 minutes
      · stand in a ring facing the fire, bob in place
      · every ROTATE_INTERVAL, everyone advances one slot clockwise
      · joining the dance flips an agent to shirtless+loincloth — PERMANENT
  → fire BURNS DOWN to embers over a few seconds, leaving an EGG in the ashes
  → after HATCH_DELAY the egg HATCHES → a baby dragon
      · dragon curls up and lives by the fire (small hop radius)
  → phase resets to growing; cycle repeats forever
      · each cycle leaves a new egg → new dragon (endless brood, homes fanned
        out around the fire so they cluster rather than overlap)
```

## Spatial facts (from the persisted layout `~/.pixel-agents/layout.json`, 20×36)

- Campfire furniture: `lng-campfire` at **(5, 30)**. Read the position from the
  layout's `campfire` furniture entry at runtime — do **not** hard-code it, so it
  follows the furniture if moved.
- Four stumps at the corners of the 3×3: (4,29), (6,29), (4,31), (6,31). These are
  the "seats" and they block their tiles.
- The 3×3 the fire fills: cols 4–6 × rows 29–31, centered on the campfire.
- The four edge-center tiles — (5,29), (4,30), (6,30), (5,31) — are free.
- **Woodpile tile:** a new decor spot to the side of the lounge. Exact tile chosen
  during implementation: must be on a walkable floor/grass tile, reachable, and not
  overlapping existing furniture (candidate region: lounge interior east of the
  fire). Rendered as a small log-stack.
- **Dance ring:** an ordered list of ~8 slots circling the 3×3. Because the four
  stump corners are blocked, the ring sits just outside the 3×3 (radius ~2). Slots
  must be walkable and reachable; the concrete tile list is finalized during
  implementation against the actual layout.

## Architecture

### CampfireState (new, on `OfficeState`)

A single object owning the whole ritual:

```ts
type CampfirePhase = 'growing' | 'full' | 'dancing' | 'burning_down' | 'egg' | 'hatching'

interface CampfireState {
  phase: CampfirePhase
  woodLevel: number              // 0 .. WOOD_TO_FULL
  fireTile: { col: number; row: number } | null  // resolved from layout
  dancers: number[]              // agent ids on the ring, in slot order
  phaseStartMs: number           // when the current phase began
  rotateAtMs: number             // next clockwise rotation during 'dancing'
  woodReserved: number           // logs in-flight (claimed but not yet dropped)
}
```

Advanced each frame from `update()`. Reset in `rebuildFromLayout()` (re-resolve
`fireTile`, clear `dancers`, set `phase = 'growing'`, `woodLevel = 0`).

### Phase transitions (in `update()`)

- `growing`: while `woodLevel + woodReserved < WOOD_TO_FULL`, allow `campfire_wood`
  trips (see below). Each completed drop: `woodLevel++`. When `woodLevel` reaches
  `WOOD_TO_FULL` → `phase = 'full'`.
- `full`: immediately begin recruiting dancers; once ≥ `MIN_DANCERS` are on the
  ring (or a short grace timeout elapses) → `phase = 'dancing'`, `phaseStartMs = now`.
- `dancing`: agents bob; rotate clockwise every `ROTATE_INTERVAL`. After
  `DANCE_DURATION` → release dancers (`endTrip`) and `phase = 'burning_down'`.
- `burning_down`: flame shrinks to embers over `BURNDOWN_DURATION`; then spawn the
  egg and `phase = 'egg'`.
- `egg`: after `HATCH_DELAY` → `phase = 'hatching'`.
- `hatching`: push a `baby-dragon` into `animals` near the fire, remove the egg,
  reset `woodLevel = 0`, `phase = 'growing'`.

## Components

### 2. Wood gathering — new trip `campfire_wood` (mirrors `planting`)

- Add `'campfire_wood'` to `Character.tripMode`.
- Recruitment: a `canStartCampfireWood(ch)` gate (analogous to `canStartPingPong`)
  — true only when `phase === 'growing'`, the agent is idle, and
  `woodLevel + woodReserved < WOOD_TO_FULL`. Wire it into `desiredTripFor()` in the
  idle branch (priority relative to other trips: place it ahead of `beanbag` so
  building the fire takes precedence over lounging, but behind in-flight commitments).
- `startTrip(ch, 'campfire_wood')`: claim the woodpile (`woodReserved++`), pathfind
  to the woodpile tile. On arrival, attach a carried log (visual) and pathfind to a
  free drop tile adjacent to the fire (the edge-center tiles, claimed via a set like
  `occupiedTripTiles`). On arrival at the drop tile, run a `dropTimer` (reuse the
  `plantingTimer` countdown pattern). On completion: `woodLevel++`, `woodReserved--`,
  remove carried log, `endTrip(ch)` back to `originalSeatId`.
- Carried log is rendered while `tripMode === 'campfire_wood'` and the agent is past
  the pickup step (a per-character `carrying: boolean`).

### 3. The dance (ring + periodic rotation)

- Add `'campfire_dance'` to `Character.tripMode`.
- `DANCE_SLOTS`: ordered ring tiles around the 3×3 (like `PING_PONG_SLOTS`).
- When `phase` is `full`/`dancing`, recruit idle agents onto free ring slots
  (closest-free assignment, reserved in `occupiedTripTiles`). Agents face the fire
  (`dir` toward (5,30)) and play a bob animation in place.
- Rotation: every `ROTATE_INTERVAL`, advance each dancer to the next slot clockwise
  (reassign `tripTile`/path one step around the ring). "Mostly in place, periodically
  move around the circle."
- On `dancing` end: `endTrip()` all dancers; clear `CampfireState.dancers`.

### 4. The transformation (loincloth)

- New per-character flag `danced: boolean`, set true the instant an agent joins a
  dance. **Permanent for that character's lifetime** (runtime-only; not persisted).
- Rendering: danced agents are drawn shirtless + loincloth.
  - **Primary approach:** recolor the shirt pixels of the character sprite to the
    skin tone and paint a 1–2px loincloth band at the waist. Requires confirming the
    exact shirt color value in the sprite templates (`spriteData.ts` character
    templates / palette definitions) — **verify before implementing.**
  - **Fallback:** a render-time overlay — draw the normal sprite, then a skin-tone
    patch over the torso rows + a loincloth strip. Crude but deterministic.
  - Decision made during implementation based on whether the shirt region is cleanly
    identifiable.

### 5. Burn-down → egg → baby dragon (mirrors `animals`)

- Egg: a procedural `drawEgg` at the fire center during `phase === 'egg'`.
- Baby dragon: extend the `animals` union `kind` with `'baby-dragon'`; add
  `drawBabyDragon` (procedural, green, tiny wings — baby version of the decorative
  sleeping dragon at renderer.ts:881). Spawn by pushing to `this.animals` with a
  home tile near the fire and a small `ANIMAL_HOP_RADIUS` so it stays put / curls up.
- Endless brood: each cycle adds one dragon; assign each new dragon a home offset on
  a fanned ring around the campfire so they cluster without overlapping. No cap.

### 6. Rendering additions

- Parameterize `renderCampfireFlames(...)` by `woodLevel` (and phase): flame height
  + glow radius scale with `woodLevel`; at full the glow covers the 3×3; during
  `burning_down` it shrinks to embers; during `egg` only embers + egg show.
- New procedural draws: `drawBabyDragon`, `drawEgg`, `drawCarriedLog`, and the
  danced-agent loincloth pass.

## Constants (tunable, grouped together)

| Constant | Value | Meaning |
|---|---|---|
| `WOOD_TO_FULL` | 8 | logs from embers to full |
| `MIN_DANCERS` | 2 | dancers needed to start (grace timeout otherwise) |
| `DANCE_DURATION` | 120_000 ms | **2 minutes** of dancing |
| `ROTATE_INTERVAL` | ~3_000 ms | clockwise rotation cadence while dancing |
| `BURNDOWN_DURATION` | ~4_000 ms | full → embers shrink |
| `HATCH_DELAY` | ~15_000 ms | egg appears → dragon hatches |
| `DROP_DURATION` | ~1_500 ms | time spent dropping a log at the fire |
| `DANCE_SLOTS` | ~8 | ring positions around the 3×3 |
| dragon cap | ∞ | endless brood |

## Edge cases & resets

- **Agent reactivated mid-ritual:** if an agent's session goes active (real work)
  while gathering/dancing, cancel the trip immediately (mirror the planting
  cancellation in `setAgentActive`): free claimed tiles, decrement `woodReserved` if
  it was carrying, remove from `dancers`. `danced` stays set if they had already
  joined a dance.
- **Not enough idle agents:** `growing` simply progresses slower; `full` waits for
  `MIN_DANCERS` with a grace timeout — if the office is empty it can sit at `full`
  until someone is idle (acceptable; it's ambient).
- **Layout rebuild:** `rebuildFromLayout()` resets `CampfireState` and re-resolves
  `fireTile`. Dragons already in `animals` persist (consistent with existing animals
  not being reset); their home tiles are re-derived from the fire position only on
  spawn, so existing dragons keep their current homes.
- **Persistence:** `CampfireState`, `danced`, and spawned dragons are runtime-only
  (lost on page reload / server restart). Matches the existing ephemeral animals.
  Acceptable for ambient flavor.

## Testing

Pure / near-pure pieces worth unit tests (server-style vitest):

- Dance-ring geometry: given the fire tile + layout, the ring-slot generator returns
  the expected ordered, walkable, reachable tiles; clockwise rotation maps slot i →
  i+1 (mod n).
- Phase-transition logic extracted into a pure reducer
  `advanceCampfire(state, dt, context) → state` so transitions (growing→full→dancing→
  burning_down→egg→hatching→growing) and `woodLevel`/timer math can be tested without
  the renderer or DOM.
- Recruitment gate `canStartCampfireWood` / dancer assignment given a set of agents.

Visual pieces (flames scaling, dragon/egg/loincloth draws, carried log) verified by
running the app.

## Files touched (anticipated)

- `webview-ui/src/office/types.ts` — `Character.tripMode` union (+`campfire_wood`,
  `campfire_dance`), `Character.danced`, `Character.carrying`.
- `webview-ui/src/office/engine/officeState.ts` — `CampfireState`, recruitment gates,
  trip start/advance, phase reducer hook in `update()`, reset in `rebuildFromLayout`,
  `setAgentActive` cancellation, dragon spawn, animal `kind` union.
- `webview-ui/src/office/engine/characters.ts` — facing + bob during dance, carried-
  log attach.
- `webview-ui/src/office/engine/renderer.ts` — `renderCampfireFlames` parameterized,
  `drawBabyDragon`, `drawEgg`, `drawCarriedLog`, danced loincloth pass.
- A new pure module for the campfire reducer + ring geometry (testable), e.g.
  `webview-ui/src/office/engine/campfire.ts`, with tests.

## Non-goals

- No persistence of dragons / danced state across reloads.
- No effect on agents' real Claude Code work — purely visual when idle.
- No sound.

import { TILE_SIZE, MATRIX_EFFECT_DURATION, CharacterState, Direction, TileType } from '../types.js'
import { isReadingTool } from './characters.js'
import {
  PALETTE_COUNT,
  HUE_SHIFT_MIN_DEG,
  HUE_SHIFT_RANGE_DEG,
  WAITING_BUBBLE_DURATION_SEC,
  DISMISS_BUBBLE_FAST_FADE_SEC,
  INACTIVE_SEAT_TIMER_MIN_SEC,
  INACTIVE_SEAT_TIMER_RANGE_SEC,
  AUTO_ON_FACING_DEPTH,
  AUTO_ON_SIDE_DEPTH,
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_HIT_HEIGHT,
  INTENSITY_BOOST_PER_TOOL,
  INTENSITY_MAX,
  EFFECT_LIFETIME_SEC,
  EFFECT_HORIZ_DRIFT_PX,
  THINKING_THRESHOLD_SEC,
  PACING_ROWS,
} from '../../constants.js'
import type { Character, Seat, FurnitureInstance, TileType as TileTypeVal, OfficeLayout, PlacedFurniture, ToolEffect } from '../types.js'
import { createCharacter, updateCharacter } from './characters.js'
import { matrixEffectSeeds } from './matrixEffect.js'
import { isWalkable, getWalkableTiles, findPath } from '../layout/tileMap.js'
import {
  createDefaultLayout,
  layoutToTileMap,
  layoutToFurnitureInstances,
  layoutToSeats,
  getBlockedTiles,
} from '../layout/layoutSerializer.js'
import { getCatalogEntry, getOnStateType } from '../layout/furnitureCatalog.js'
import {
  createCampfireState, resolveFireTile, resolveWoodpileTile, computeDanceSlots,
  addWood, advanceCampfire, WOOD_TO_FULL, DROP_DURATION_MS,
  type CampfireState, type Tile,
} from './campfire.js'
import {
  createWizardState, computeLineupTiles, MAX_LINE,
  advanceWizard, enqueue, dequeue,
  type WizardState, type Tile as WizardTile,
} from './wizardDesk.js'
import type { WizardRenderState } from './renderer.js'

export class OfficeState {
  layout: OfficeLayout
  tileMap: TileTypeVal[][]
  seats: Map<string, Seat>
  blockedTiles: Set<string>
  furniture: FurnitureInstance[]
  walkableTiles: Array<{ col: number; row: number }>
  characters: Map<number, Character> = new Map()
  selectedAgentId: number | null = null
  cameraFollowId: number | null = null
  hoveredAgentId: number | null = null
  hoveredTile: { col: number; row: number } | null = null
  /** Maps "parentId:toolId" → sub-agent character ID (negative) */
  subagentIdMap: Map<string, number> = new Map()
  /** Reverse lookup: sub-agent character ID → parent info */
  subagentMeta: Map<number, { parentAgentId: number; parentToolId: string }> = new Map()
  private nextSubagentId = -1
  /** Floating tool-reaction effects above characters' heads */
  effects: ToolEffect[] = []
  private nextEffectId = 1
  /** Tile keys ("col,row") currently occupied by a character on a field trip (beanbag/bookshelf). */
  private occupiedTripTiles = new Set<string>()
  /** Pending agents waiting for the pad to clear — drained one at a time in update(). */
  private spawnQueue: Array<{
    id: number
    palette?: number
    hueShift?: number
    seatId?: string
    folderName?: string
  }> = []
  /** Pending sessionId assignments for agents not yet materialized. */
  private pendingSessionIds = new Map<number, string>()
  /** Timestamp (ms, performance.now()) until which the pad is busy with a current spawn animation. */
  private spawnInProgressUntil = 0
  /** Whether the greeter NPC has been initialized. */
  private greeterInitialized = false

  // ── Ping-pong match ──────────────────────────────────────────────
  /** Live match state. Created when both PP slots are occupied; cleared when a slot
   *  empties or a game ends. */
  pingPongMatch: {
    leftScore: number
    rightScore: number
    phase: 'rallying' | 'scoring' | 'celebrating'
    phaseStartMs: number
    pointDurationMs: number
    /** Side that won the last point — drives ball-resting position + winner bounce. */
    lastPointWinner: 'left' | 'right' | null
  } | null = null
  private static readonly PP_SCORE_TO_WIN = 7
  private static readonly PP_POINT_MIN_MS = 2000
  private static readonly PP_POINT_MAX_MS = 4000
  private static readonly PP_SCORING_MS = 500
  private static readonly PP_CELEBRATING_MS = 1200

  // ── Dynamic desk reveal/hide ─────────────────────────────────────
  /** Station-desk groupIds currently visible (e.g. "station-l-0-build-d0"). Empty initially —
   *  only the hero MERGE TO MAIN desk + lounge show. Desks get added when no PCs are free
   *  and removed after DESK_DESPAWN_MS of being fully empty. */
  revealedDeskIds: Set<string> = new Set()
  /** Pre-computed reveal order: outermost-first, top-down, alternating L/R. */
  private revealQueue: string[] = []
  /** When each revealed desk last had zero seated agents. Cleared once it's reoccupied. */
  private deskLastEmptyAt: Map<string, number> = new Map()
  /** Active portal animations by groupId. Reveal: desk is in revealedDeskIds while alpha
   *  ramps 0→1. Hide: stays in revealedDeskIds during the fade-out, then removed. */
  private deskAnimations: Map<string, { type: 'reveal' | 'hide'; startMs: number }> = new Map()
  /** A desk is hidden after being empty this long. */
  private static readonly DESK_DESPAWN_MS = 5 * 60 * 1000
  private static readonly REVEAL_ANIM_MS = 700
  private static readonly HIDE_ANIM_MS = 600
  /** Despawn check throttling. */
  private lastDespawnCheckMs = 0
  private static readonly DESPAWN_CHECK_INTERVAL_MS = 5000

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout()
    this.tileMap = layoutToTileMap(this.layout)
    this.seats = layoutToSeats(this.layout.furniture)
    this.buildRevealQueue()
    this.rebuildVisibleState()
    this.ensureGreeter()
    this.ensureWizard()
    this.resolveCampfireGeometry()
    this.resolveWizardGeometry()
  }

  /** Sentinel ids for the two persistent greeter NPCs. Far below subagent IDs (which start at -1 and decrement). */
  private static readonly GREETER_ID = -1000000     // gold/right
  private static readonly GREETER2_ID = -1000001    // green/left
  /** Sentinel id for the knight NPC. */
  private static readonly KNIGHT_ID = -1000002
  /** Knight default home tile (in front of the Merge to / MAIN sign). */
  private static readonly KNIGHT_HOME_COL = 10
  private static readonly KNIGHT_HOME_ROW = 7
  /** Violet carpet wander zone (cols 9..12, rows 6..15). */
  private static readonly KNIGHT_WANDER_MIN_COL = 9
  private static readonly KNIGHT_WANDER_MAX_COL = 12
  private static readonly KNIGHT_WANDER_MIN_ROW = 6
  private static readonly KNIGHT_WANDER_MAX_ROW = 15
  /** Ceremony duration. */
  private static readonly KNIGHT_CEREMONY_MS = 1500
  /** Wander dwell after reaching a target tile. */
  private static readonly KNIGHT_HOME_DWELL_MS = 1500
  private static readonly KNIGHT_WANDER_DWELL_MS = 1500
  /** Safety net — auto-free an agent if the knight hasn't reached them in this long. */
  private static readonly KNIGHT_QUEUE_TIMEOUT_MS = 5000
  /** Total ms from matrix-spawn start through both hugs (300 + 600 + 1200 + 1200 + buffer). */
  private static readonly SPAWN_INTERVAL_MS = 3500
  /** Pad tile location (must match SPAWN_PAD_TILE_COL/ROW in renderer.ts). */
  private static readonly PAD_COL = 9
  private static readonly PAD_ROW = 33
  /** Gold goddess stands two tiles to the right of the pad center (col 11). */
  private static readonly GREETER_COL = 11
  private static readonly GREETER_ROW = 33
  /** Green goddess stands two tiles to the left of the pad center (col 7), symmetric. */
  private static readonly GREETER2_COL = 7
  private static readonly GREETER2_ROW = 33

  /** Sentinel id for the wizard NPC. (KNIGHT_ID is -1000002, so this is -1000003.) */
  private static readonly WIZARD_ID = -1000003
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

  /** Spawn the persistent greeter NPCs (one on each side of the pad) if not yet placed. */
  private ensureGreeter(): void {
    if (this.greeterInitialized) return
    this.greeterInitialized = true

    // Gold goddess (right of pad).
    if (!this.characters.has(OfficeState.GREETER_ID)) {
      const ch = createCharacter(OfficeState.GREETER_ID, 4, null, null, 30)
      ch.tileCol = OfficeState.GREETER_COL
      ch.tileRow = OfficeState.GREETER_ROW
      ch.x = OfficeState.GREETER_COL * TILE_SIZE + TILE_SIZE / 2
      ch.y = OfficeState.GREETER_ROW * TILE_SIZE + TILE_SIZE / 2
      ch.dir = Direction.LEFT // face the pad
      ch.state = CharacterState.IDLE
      ch.isGreeter = true
      ch.greeterVariant = 'gold'
      ch.isActive = false
      ch.seatId = null
      this.characters.set(OfficeState.GREETER_ID, ch)
    }

    // Green goddess (left of pad).
    if (!this.characters.has(OfficeState.GREETER2_ID)) {
      const ch = createCharacter(OfficeState.GREETER2_ID, 2, null, null, 0)
      ch.tileCol = OfficeState.GREETER2_COL
      ch.tileRow = OfficeState.GREETER2_ROW
      ch.x = OfficeState.GREETER2_COL * TILE_SIZE + TILE_SIZE / 2
      ch.y = OfficeState.GREETER2_ROW * TILE_SIZE + TILE_SIZE / 2
      ch.dir = Direction.RIGHT // face the pad
      ch.state = CharacterState.IDLE
      ch.isGreeter = true
      ch.greeterVariant = 'green'
      ch.isActive = false
      ch.seatId = null
      this.characters.set(OfficeState.GREETER2_ID, ch)
    }

    // Knight is currently disabled as a moving NPC — see hero-knight furniture entry
    // in the layout for the static guard. Re-enable once we have a stable wander loop
    // that doesn't interfere with agent spawn flow.

    // Animals — initialize on first call only.
    if (this.animals.length === 0) {
      for (const def of OfficeState.ANIMAL_DEFS) {
        const homeX = def.homeCol * TILE_SIZE + TILE_SIZE / 2
        const homeY = def.homeRow * TILE_SIZE + TILE_SIZE / 2
        const watchX = def.watchCol * TILE_SIZE + TILE_SIZE / 2
        const watchY = def.watchRow * TILE_SIZE + TILE_SIZE / 2
        this.animals.push({
          kind: def.kind,
          homeX, homeY, watchX, watchY,
          x: homeX, y: homeY,
          facing: 'right',
          targetX: homeX, targetY: homeY,
          nextHopAt: performance.now() + Math.random() * 2000,
        })
      }
    }
  }

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

  /** FIFO of agent IDs awaiting a knighting ceremony. setAgentActive(_, false) enqueues. */
  private knightingQueue: number[] = []
  /** When each queued agent was added — used to time out stale entries. */
  private knightingQueueTimes: Map<number, number> = new Map()

  // ── Planting (idle agents plant a flower before going to leisure) ──
  /** Permanent flowers planted by idle agents, keyed by "col,row". Value is the flower
   *  color hex string. Added to during gameplay; rendered alongside the procedural flowers. */
  plantedFlowers: Map<string, string> = new Map()
  /** Agent IDs that should plant something on their next trip selection. Populated when
   *  setAgentActive(_, false) fires; cleared when the agent finishes planting. */
  private pendingPlant: Set<number> = new Set()
  /** Tiles already chosen as planting targets but not yet completed — keep them off the
   *  candidate pool so two agents don't pick the same tile. */
  private claimedPlantTiles: Set<string> = new Set()
  private static readonly PLANTING_DURATION_MS = 2200
  private static readonly PLANTABLE_FLOWER_COLORS = [
    '#ff6b8a', '#ffd66b', '#a3d8ff', '#ffffff', '#ff9f43', '#e066ff', '#7be891', '#ff8060',
  ]

  // ── Forest animals ──
  /** Decorative critters living on the meadow. They idle near a home tile and gather
   *  around the merge desk when all 4 hero PCs are active. Pure visual (no pathfinding,
   *  no collision). World pixel coordinates. */
  animals: Array<{
    kind: 'rabbit' | 'squirrel' | 'baby-dragon'
    homeX: number
    homeY: number
    watchX: number
    watchY: number
    x: number
    y: number
    facing: 'left' | 'right'
    /** Current random hop target while idling (within HOP_RADIUS_PX of home). */
    targetX: number
    targetY: number
    /** Timestamp (performance.now ms) at which to pick a new random hop target. */
    nextHopAt: number
    /** Baby-dragon free-roam behavior. Undefined for rabbits/squirrels.
     *  - 'momma_pet': cluster near the sleeping mother dragon.
     *  - 'bookshelf': perch on a specific bookshelf, occasional small hops.
     *  - 'roamer':    drift across the whole map in long lazy arcs.
     *  - 'hunter':    stalk and eat rabbits; idles otherwise. */
    role?: 'momma_pet' | 'bookshelf' | 'roamer' | 'hunter'
    /** For 'hunter' dragons: the next time (performance.now ms) they may pick a new
     *  rabbit to eat. Throttles predation so the meadow doesn't go silent in a minute. */
    nextHuntAt?: number
    /** Hunter is mid-pounce on a rabbit; once `eatingUntilMs` passes the rabbit is
     *  removed and the dragon rolls back to idle roaming. */
    eatingUntilMs?: number
  }> = []
  private static readonly ANIMAL_HOP_RADIUS_PX = 32   // ~2 tiles around home
  private static readonly ANIMAL_HOP_MIN_MS = 1500
  private static readonly ANIMAL_HOP_MAX_MS = 3500
  /** How close (world px) a hunter must get before it "eats" its rabbit target. */
  private static readonly DRAGON_EAT_RANGE_PX = 6
  /** Cooldown between hunter kills so the rabbit population isn't wiped instantly. */
  private static readonly DRAGON_HUNT_COOLDOWN_MS = 25_000
  /** How long the "eating" pause lasts before the hunter re-engages. */
  private static readonly DRAGON_EAT_DURATION_MS = 1800
  /** How long after being eaten until a rabbit respawns at its original home. Keeps the
   *  meadow populated even with multiple hunters in the brood. */
  private static readonly RABBIT_RESPAWN_MS = 35_000
  /** Pending rabbit respawns: each entry resurrects one rabbit at the given home after
   *  `at` ms (performance.now timeframe). */
  private rabbitRespawnQueue: Array<{
    homeX: number; homeY: number; watchX: number; watchY: number; at: number;
  }> = []
  /** Bookshelf furniture tiles in the layout — dragons perch here. Resolved per-layout. */
  private bookshelfTiles: Array<{ col: number; row: number }> = []
  /** Center (world px) of the sleeping mother dragon — momma_pets cluster here. */
  private static readonly MOMMA_DRAGON_CENTER_X = (13 + 3) * 16    // baseX=col 13, body span ~6 tiles
  private static readonly MOMMA_DRAGON_CENTER_Y = (0 + 3) * 16     // baseY=row 0, body span ~5 tiles
  private static readonly ANIMAL_DEFS = [
    // Rabbit in upper-left meadow → watches from west of the chairs.
    { kind: 'rabbit' as const,   homeCol: 3,  homeRow: 9,  watchCol: 6,  watchRow: 6 },
    // Squirrel in upper-right meadow → watches from east.
    { kind: 'squirrel' as const, homeCol: 16, homeRow: 13, watchCol: 13, watchRow: 6 },
    // Rabbit in mid-right meadow → watches behind center.
    { kind: 'rabbit' as const,   homeCol: 15, homeRow: 19, watchCol: 10, watchRow: 6 },
  ]

  // ── Campfire ritual ──
  campfire: CampfireState = createCampfireState()
  /** Fire tile resolved from the layout (null if no campfire furniture present). */
  private fireTile: Tile | null = null
  /** Woodpile tile agents fetch logs from. */
  private woodpileTile: Tile | null = null
  /** Ordered clockwise dance-ring slots around the fire. */
  private danceSlots: Tile[] = []

  // ── Wizard blessing ceremony ──
  private wizard: WizardState = createWizardState()
  private wizardLineTiles: WizardTile[] = []
  private wizardInitialized = false
  // Set on a cast_summon event; consumed by the renderer for the bolt animation.
  private wizardSummonTo: { col: number; row: number } | null = null
  private wizardSummonUntilMs = 0
  private wizardBlessStartMs = 0

  /** Returns the fire tile position for the campfire render state (null if no campfire in layout). */
  getCampfireFireTile(): { col: number; row: number } | null { return this.fireTile }

  /** Render state for the wizard scene (desk, blessing rune, summon bolt). */
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

  /** Rebuild all derived state from a new layout. Reassigns existing characters.
   *  @param shift Optional pixel shift to apply when grid expands left/up */
  rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }): void {
    this.layout = layout
    this.tileMap = layoutToTileMap(layout)
    this.seats = layoutToSeats(layout.furniture)
    this.buildRevealQueue()
    // Drop any revealed desk groupIds that no longer exist in the new layout.
    for (const gid of Array.from(this.revealedDeskIds)) {
      if (!this.revealQueue.includes(gid)) this.revealedDeskIds.delete(gid)
    }
    // Make sure any desk currently occupied by a character (e.g. across a layout reload) is
    // visible — agents keep their seats in the reassignment passes below, so their desks
    // must be revealed.
    for (const ch of this.characters.values()) {
      if (!ch.seatId) continue
      const chairUid = ch.seatId.split(':')[0]
      const gid = this.deskGroupId(chairUid)
      if (gid) this.revealedDeskIds.add(gid)
    }
    this.rebuildVisibleState()

    // Clear all trip state — trip slot coords (ping-pong, beanbag, bookshelf positions) may
    // have moved with the new layout, so existing trips are stale. Next tick's desiredTripFor
    // will reassign cleanly.
    this.occupiedTripTiles.clear()
    for (const ch of this.characters.values()) {
      if (ch.isGreeter || ch.isWizard) continue
      ch.tripMode = null
      ch.tripTile = null
      ch.path = []
      ch.moveProgress = 0
      ch.carrying = false
      ch.woodDropTimer = undefined
    }

    // Re-resolve campfire geometry and reset the ritual (slot coords may have moved).
    this.campfire = createCampfireState()
    this.resolveCampfireGeometry()
    // Re-resolve the wizard line and reset the blessing queue (slot coords may have moved).
    // Agents keep their needsBlessing flag, so any still awaiting a blessing harmlessly
    // re-enqueue on the next tick.
    this.wizard = createWizardState()
    this.resolveWizardGeometry()
    this.ensureWizard()

    // Shift character positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const ch of this.characters.values()) {
        ch.tileCol += shift.col
        ch.tileRow += shift.row
        ch.x += shift.col * TILE_SIZE
        ch.y += shift.row * TILE_SIZE
        // Clear path since tile coords changed
        ch.path = []
        ch.moveProgress = 0
      }
    }

    // Reassign characters to new seats, preserving existing assignments when possible
    for (const seat of this.seats.values()) {
      seat.assigned = false
    }

    // First pass: try to keep characters at their existing seats
    for (const ch of this.characters.values()) {
      if (ch.isGreeter || ch.isWizard) continue // greeter/wizard never sit
      if (ch.seatId && this.seats.has(ch.seatId)) {
        const seat = this.seats.get(ch.seatId)!
        if (!seat.assigned) {
          seat.assigned = true
          // Snap character to seat position
          ch.tileCol = seat.seatCol
          ch.tileRow = seat.seatRow
          const cx = seat.seatCol * TILE_SIZE + TILE_SIZE / 2
          const cy = seat.seatRow * TILE_SIZE + TILE_SIZE / 2
          ch.x = cx
          ch.y = cy
          ch.dir = seat.facingDir
          continue
        }
      }
      ch.seatId = null // will be reassigned below
    }

    // Second pass: assign remaining characters to free seats
    for (const ch of this.characters.values()) {
      if (ch.isGreeter || ch.isWizard) continue
      if (ch.seatId) continue
      const seatId = this.findFreeSeat()
      if (seatId) {
        this.seats.get(seatId)!.assigned = true
        ch.seatId = seatId
        const seat = this.seats.get(seatId)!
        ch.tileCol = seat.seatCol
        ch.tileRow = seat.seatRow
        ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2
        ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2
        ch.dir = seat.facingDir
      }
    }

    // Relocate any characters that ended up outside bounds or on non-walkable tiles
    for (const ch of this.characters.values()) {
      if (ch.isGreeter || ch.isWizard) continue // greeter/wizard have fixed positions
      if (ch.seatId) continue // seated characters are fine
      if (ch.tileCol < 0 || ch.tileCol >= layout.cols || ch.tileRow < 0 || ch.tileRow >= layout.rows) {
        this.relocateCharacterToWalkable(ch)
      }
    }
  }

  /** Move a character to a random walkable tile */
  private relocateCharacterToWalkable(ch: Character): void {
    if (this.walkableTiles.length === 0) return
    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
    ch.tileCol = spawn.col
    ch.tileRow = spawn.row
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2
    ch.path = []
    ch.moveProgress = 0
  }

  /** Resolve fire/woodpile/dance-ring tiles from the current layout + walkability. */
  private resolveCampfireGeometry(): void {
    // Bookshelves are layout furniture — refresh the perch list whenever the layout
    // changes so newly-added shelves are immediately available to baby dragons.
    this.bookshelfTiles = this.layout.furniture
      .filter((f) => (f.type as string) === 'bookshelf')
      .map((f) => ({ col: f.col, row: f.row }))

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

  getLayout(): OfficeLayout {
    return this.layout
  }

  /** Get the blocked-tile key for a character's own seat, or null */
  private ownSeatKey(ch: Character): string | null {
    if (!ch.seatId) return null
    const seat = this.seats.get(ch.seatId)
    if (!seat) return null
    return `${seat.seatCol},${seat.seatRow}`
  }

  /** Temporarily unblock a character's own seat, run fn, then re-block */
  private withOwnSeatUnblocked<T>(ch: Character, fn: () => T): T {
    const key = this.ownSeatKey(ch)
    if (key) this.blockedTiles.delete(key)
    const result = fn()
    if (key) this.blockedTiles.add(key)
    return result
  }

  private findFreeSeat(): string | null {
    for (const [uid, seat] of this.seats) {
      if (seat.assigned) continue
      // Skip seats whose desk hasn't been revealed yet (station desks gate by revealedDeskIds;
      // hero/lounge chairs return null groupId and are always available).
      const chairUid = uid.split(':')[0]
      const gid = this.deskGroupId(chairUid)
      if (gid && !this.revealedDeskIds.has(gid)) continue
      return uid
    }
    return null
  }

  /**
   * Pick a diverse palette for a new agent based on currently active agents.
   * First 6 agents each get a unique skin (random order). Beyond 6, skins
   * repeat in balanced rounds with a random hue shift (≥45°).
   */
  private pickDiversePalette(): { palette: number; hueShift: number } {
    // Count how many non-sub-agents (excluding the greeter NPC) use each base palette (0-5)
    const counts = new Array(PALETTE_COUNT).fill(0) as number[]
    for (const ch of this.characters.values()) {
      if (ch.isSubagent) continue
      if (ch.isGreeter || ch.isWizard) continue
      counts[ch.palette]++
    }
    const minCount = Math.min(...counts)
    // Available = palettes at the minimum count (least used)
    const available: number[] = []
    for (let i = 0; i < PALETTE_COUNT; i++) {
      if (counts[i] === minCount) available.push(i)
    }
    const palette = available[Math.floor(Math.random() * available.length)]
    // First round (minCount === 0): no hue shift. Subsequent rounds: random ≥45°.
    let hueShift = 0
    if (minCount > 0) {
      hueShift = HUE_SHIFT_MIN_DEG + Math.floor(Math.random() * HUE_SHIFT_RANGE_DEG)
    }
    return { palette, hueShift }
  }

  addAgent(id: number, preferredPalette?: number, preferredHueShift?: number, preferredSeatId?: string, skipSpawnEffect?: boolean, folderName?: string): void {
    if (this.characters.has(id)) return

    // Fast-path: bootstrap restoration with skipSpawnEffect=true previously bypassed the matrix
    // effect entirely. To keep the new "queued sequential spawn" UX, we treat skipSpawnEffect
    // simply as a hint that's ignored here — every agent now goes through the pad with full
    // matrix-spawn → spin → high-five, queued one at a time.
    void skipSpawnEffect

    // Reserve a seat NOW so concurrent addAgent / pickHomeSeatId calls don't double-assign.
    let reservedSeatId: string | null = null
    if (preferredSeatId && this.seats.has(preferredSeatId)) {
      // If the agent is restoring to a seat at a hidden station desk, reveal that desk first.
      const preferredChairUid = preferredSeatId.split(':')[0]
      const preferredGid = this.deskGroupId(preferredChairUid)
      if (preferredGid && !this.revealedDeskIds.has(preferredGid)) {
        this.revealedDeskIds.add(preferredGid)
        this.deskLastEmptyAt.delete(preferredGid)
        this.rebuildVisibleState()
      }
      const seat = this.seats.get(preferredSeatId)!
      if (!seat.assigned) {
        seat.assigned = true
        reservedSeatId = preferredSeatId
      }
    }
    if (!reservedSeatId) {
      let free = this.findFreeSeat()
      // No free seat among visible desks → reveal the next desk and try again.
      if (!free && this.revealNextDesk()) {
        free = this.findFreeSeat()
      }
      if (free) {
        this.seats.get(free)!.assigned = true
        reservedSeatId = free
      }
    }

    const args = {
      id,
      palette: preferredPalette,
      hueShift: preferredHueShift,
      seatId: reservedSeatId ?? undefined,
      folderName,
    }

    const now = performance.now()
    if (now < this.spawnInProgressUntil || this.spawnQueue.length > 0) {
      // Pad is busy or queue has pending entries — defer.
      this.spawnQueue.push(args)
      return
    }

    this.materializeAgent(args)
    this.spawnInProgressUntil = now + OfficeState.SPAWN_INTERVAL_MS
  }

  /** Real spawn body: resolves palette, picks seat, places at pad, kicks matrix-spawn effect. */
  private materializeAgent(args: {
    id: number
    palette?: number
    hueShift?: number
    seatId?: string
    folderName?: string
  }): void {
    const { id, folderName } = args
    if (this.characters.has(id)) return

    let palette: number
    let hueShift: number
    if (args.palette !== undefined) {
      palette = args.palette
      hueShift = args.hueShift ?? 0
    } else {
      const pick = this.pickDiversePalette()
      palette = pick.palette
      hueShift = pick.hueShift
    }

    // Seat is pre-reserved by addAgent (so concurrent calls don't fight). It's already
    // assigned=true. Use it directly. If somehow no seat was reserved, try a free one.
    let seatId: string | null = null
    if (args.seatId && this.seats.has(args.seatId)) {
      seatId = args.seatId
    } else {
      let free = this.findFreeSeat()
      if (!free && this.revealNextDesk()) {
        free = this.findFreeSeat()
      }
      if (free) {
        this.seats.get(free)!.assigned = true
        seatId = free
      }
    }

    let ch: Character
    if (seatId) {
      const seat = this.seats.get(seatId)!
      ch = createCharacter(id, palette, seatId, seat, hueShift)
    } else {
      // No seats — spawn at random walkable tile
      const spawn = this.walkableTiles.length > 0
        ? this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
        : { col: 1, row: 1 }
      ch = createCharacter(id, palette, null, null, hueShift)
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2
      ch.tileCol = spawn.col
      ch.tileRow = spawn.row
    }

    if (folderName) {
      ch.folderName = folderName
    }

    // Spawn from the pad: place the new character at the pad's tile, matrix-effect them in,
    // then SPAWNING-state spin + high-five with the greeter, then IDLE pathfind to seat.
    if (seatId) {
      ch.tileCol = OfficeState.PAD_COL
      ch.tileRow = OfficeState.PAD_ROW
      ch.x = OfficeState.PAD_COL * TILE_SIZE + TILE_SIZE / 2
      ch.y = OfficeState.PAD_ROW * TILE_SIZE + TILE_SIZE / 2
      ch.path = []
      ch.moveProgress = 0
      ch.needsBlessing = true
      // Hold in SPAWNING until matrix completes; then spin handler will run.
      ch.state = CharacterState.SPAWNING
    }

    ch.matrixEffect = 'spawn'
    ch.matrixEffectTimer = 0
    ch.matrixEffectSeeds = matrixEffectSeeds()
    this.characters.set(id, ch)

    // Apply any sessionId queued before materialization.
    const pendingSession = this.pendingSessionIds.get(id)
    if (pendingSession !== undefined) {
      ch.sessionId = pendingSession
      this.pendingSessionIds.delete(id)
    }
  }

  /** Assign a Claude Code sessionId to an agent. Works whether the agent is materialized
   *  or still queued; the value will be applied when the queued agent appears. */
  setAgentSessionId(id: number, sessionId: string): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.sessionId = sessionId
      return
    }
    this.pendingSessionIds.set(id, sessionId)
  }

  /** Set the agent's "what they're working on" goal label (derived from their prompt). */
  setAgentGoal(id: number, goal: string): void {
    const ch = this.characters.get(id)
    if (ch) ch.goal = goal
  }

  /** Set/clear the agent's live tool status line (e.g. "Editing foo.ts"). */
  setAgentLiveStatus(id: number, status: string | null): void {
    const ch = this.characters.get(id)
    if (ch) ch.liveStatus = status ?? undefined
  }

  removeAgent(id: number): void {
    // Remove from spawn queue if still queued (not yet materialized) and free its reserved seat.
    const queueIdx = this.spawnQueue.findIndex((e) => e.id === id)
    if (queueIdx >= 0) {
      const entry = this.spawnQueue[queueIdx]
      this.spawnQueue.splice(queueIdx, 1)
      if (entry.seatId) {
        const seat = this.seats.get(entry.seatId)
        if (seat) seat.assigned = false
      }
      this.pendingSessionIds.delete(id)
      return
    }
    const ch = this.characters.get(id)
    if (!ch) return
    if (ch.matrixEffect === 'despawn') return // already despawning
    // Release campfire-specific bookkeeping (woodReserved, dancers) before tearing down.
    this.cancelCampfireTrip(ch)
    this.cancelWizardTrip(ch)
    // Release any field-trip tile they were holding
    if (ch.tripTile) {
      this.occupiedTripTiles.delete(`${ch.tripTile.col},${ch.tripTile.row}`)
      ch.tripTile = null
      ch.tripMode = null
    }
    // If they had been on a trip, free their original seat too — not the trip-cleared `seatId`
    if (ch.originalSeatId) {
      const seat = this.seats.get(ch.originalSeatId)
      if (seat) seat.assigned = false
      ch.originalSeatId = null
    }
    // Free seat and clear selection immediately
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId)
      if (seat) seat.assigned = false
    }
    if (this.selectedAgentId === id) this.selectedAgentId = null
    if (this.cameraFollowId === id) this.cameraFollowId = null
    // Start despawn animation instead of immediate delete
    ch.matrixEffect = 'despawn'
    ch.matrixEffectTimer = 0
    ch.matrixEffectSeeds = matrixEffectSeeds()
    ch.bubbleType = null
  }

  /** Find seat uid at a given tile position, or null */
  getSeatAtTile(col: number, row: number): string | null {
    for (const [uid, seat] of this.seats) {
      if (seat.seatCol === col && seat.seatRow === row) return uid
    }
    return null
  }

  /** Reassign an agent from their current seat to a new seat */
  reassignSeat(agentId: number, seatId: string): void {
    const ch = this.characters.get(agentId)
    if (!ch) return
    // Unassign old seat
    if (ch.seatId) {
      const old = this.seats.get(ch.seatId)
      if (old) old.assigned = false
    }
    // Assign new seat
    const seat = this.seats.get(seatId)
    if (!seat || seat.assigned) return
    seat.assigned = true
    ch.seatId = seatId
    // Pathfind to new seat (unblock own seat tile for this query)
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles)
    )
    if (path.length > 0) {
      ch.path = path
      ch.moveProgress = 0
      ch.state = CharacterState.WALK
      ch.frame = 0
      ch.frameTimer = 0
    } else {
      // Already at seat or no path — sit down
      ch.state = CharacterState.TYPE
      ch.dir = seat.facingDir
      ch.frame = 0
      ch.frameTimer = 0
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC
      }
    }
  }

  /** Send an agent back to their currently assigned seat */
  sendToSeat(agentId: number): void {
    const ch = this.characters.get(agentId)
    if (!ch || !ch.seatId) return
    const seat = this.seats.get(ch.seatId)
    if (!seat) return
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles)
    )
    if (path.length > 0) {
      ch.path = path
      ch.moveProgress = 0
      ch.state = CharacterState.WALK
      ch.frame = 0
      ch.frameTimer = 0
    } else {
      // Already at seat — sit down
      ch.state = CharacterState.TYPE
      ch.dir = seat.facingDir
      ch.frame = 0
      ch.frameTimer = 0
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC
      }
    }
  }

  /** Walk an agent to an arbitrary walkable tile (right-click command) */
  walkToTile(agentId: number, col: number, row: number): boolean {
    const ch = this.characters.get(agentId)
    if (!ch || ch.isSubagent) return false
    if (!isWalkable(col, row, this.tileMap, this.blockedTiles)) {
      // Also allow walking to own seat tile (blocked for others but not self)
      const key = this.ownSeatKey(ch)
      if (!key || key !== `${col},${row}`) return false
    }
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles)
    )
    if (path.length === 0) return false
    ch.path = path
    ch.moveProgress = 0
    ch.state = CharacterState.WALK
    ch.frame = 0
    ch.frameTimer = 0
    return true
  }

  /** Create a sub-agent character with the parent's palette. Returns the sub-agent ID. */
  addSubagent(parentAgentId: number, parentToolId: string): number {
    const key = `${parentAgentId}:${parentToolId}`
    if (this.subagentIdMap.has(key)) return this.subagentIdMap.get(key)!

    const id = this.nextSubagentId--
    const parentCh = this.characters.get(parentAgentId)
    const palette = parentCh ? parentCh.palette : 0
    const hueShift = parentCh ? parentCh.hueShift : 0

    // Find the free seat closest to the parent agent
    const parentCol = parentCh ? parentCh.tileCol : 0
    const parentRow = parentCh ? parentCh.tileRow : 0
    const dist = (c: number, r: number) =>
      Math.abs(c - parentCol) + Math.abs(r - parentRow)

    let bestSeatId: string | null = null
    let bestDist = Infinity
    for (const [uid, seat] of this.seats) {
      if (!seat.assigned) {
        const d = dist(seat.seatCol, seat.seatRow)
        if (d < bestDist) {
          bestDist = d
          bestSeatId = uid
        }
      }
    }

    let ch: Character
    if (bestSeatId) {
      const seat = this.seats.get(bestSeatId)!
      seat.assigned = true
      ch = createCharacter(id, palette, bestSeatId, seat, hueShift)
    } else {
      // No seats — spawn at closest walkable tile to parent
      let spawn = { col: 1, row: 1 }
      if (this.walkableTiles.length > 0) {
        let closest = this.walkableTiles[0]
        let closestDist = dist(closest.col, closest.row)
        for (let i = 1; i < this.walkableTiles.length; i++) {
          const d = dist(this.walkableTiles[i].col, this.walkableTiles[i].row)
          if (d < closestDist) {
            closest = this.walkableTiles[i]
            closestDist = d
          }
        }
        spawn = closest
      }
      ch = createCharacter(id, palette, null, null, hueShift)
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2
      ch.tileCol = spawn.col
      ch.tileRow = spawn.row
    }
    ch.isSubagent = true
    ch.parentAgentId = parentAgentId
    ch.needsBlessing = true // subagents queue for the blessing too
    ch.matrixEffect = 'spawn'
    ch.matrixEffectTimer = 0
    ch.matrixEffectSeeds = matrixEffectSeeds()
    this.characters.set(id, ch)

    this.subagentIdMap.set(key, id)
    this.subagentMeta.set(id, { parentAgentId, parentToolId })
    return id
  }

  /** Remove a specific sub-agent character and free its seat */
  removeSubagent(parentAgentId: number, parentToolId: string): void {
    const key = `${parentAgentId}:${parentToolId}`
    const id = this.subagentIdMap.get(key)
    if (id === undefined) return

    const ch = this.characters.get(id)
    if (ch) {
      if (ch.matrixEffect === 'despawn') {
        // Already despawning — just clean up maps
        this.subagentIdMap.delete(key)
        this.subagentMeta.delete(id)
        return
      }
      // Release campfire-specific bookkeeping before despawn.
      this.cancelCampfireTrip(ch)
      this.cancelWizardTrip(ch)
      if (ch.seatId) {
        const seat = this.seats.get(ch.seatId)
        if (seat) seat.assigned = false
      }
      // Start despawn animation — keep character in map for rendering
      ch.matrixEffect = 'despawn'
      ch.matrixEffectTimer = 0
      ch.matrixEffectSeeds = matrixEffectSeeds()
      ch.bubbleType = null
    }
    // Clean up tracking maps immediately so keys don't collide
    this.subagentIdMap.delete(key)
    this.subagentMeta.delete(id)
    if (this.selectedAgentId === id) this.selectedAgentId = null
    if (this.cameraFollowId === id) this.cameraFollowId = null
  }

  /** Remove all sub-agents belonging to a parent agent */
  removeAllSubagents(parentAgentId: number): void {
    const toRemove: string[] = []
    for (const [key, id] of this.subagentIdMap) {
      const meta = this.subagentMeta.get(id)
      if (meta && meta.parentAgentId === parentAgentId) {
        const ch = this.characters.get(id)
        if (ch) {
          if (ch.matrixEffect === 'despawn') {
            // Already despawning — just clean up maps
            this.subagentMeta.delete(id)
            toRemove.push(key)
            continue
          }
          // Release campfire-specific bookkeeping before despawn.
          this.cancelCampfireTrip(ch)
          this.cancelWizardTrip(ch)
          if (ch.seatId) {
            const seat = this.seats.get(ch.seatId)
            if (seat) seat.assigned = false
          }
          // Start despawn animation
          ch.matrixEffect = 'despawn'
          ch.matrixEffectTimer = 0
          ch.matrixEffectSeeds = matrixEffectSeeds()
          ch.bubbleType = null
        }
        this.subagentMeta.delete(id)
        if (this.selectedAgentId === id) this.selectedAgentId = null
        if (this.cameraFollowId === id) this.cameraFollowId = null
        toRemove.push(key)
      }
    }
    for (const key of toRemove) {
      this.subagentIdMap.delete(key)
    }
  }

  /** Look up the sub-agent character ID for a given parent+toolId, or null */
  getSubagentId(parentAgentId: number, parentToolId: string): number | null {
    return this.subagentIdMap.get(`${parentAgentId}:${parentToolId}`) ?? null
  }

  /** Release all campfire bookkeeping an agent holds — called when it resumes real work
   *  or despawns. Frees the wood reservation / dance-slot membership / trip-tile reservation.
   *  Does NOT clear ch.danced (the transformation is permanent). */
  private cancelCampfireTrip(ch: Character): void {
    if (ch.tripMode === 'campfire_wood') {
      this.campfire = { ...this.campfire, woodReserved: Math.max(0, this.campfire.woodReserved - 1) }
      ch.carrying = false
      ch.woodDropTimer = undefined
    }
    if (ch.tripMode === 'campfire_dance') {
      this.campfire = { ...this.campfire, dancers: this.campfire.dancers.filter((d) => d !== ch.id) }
    }
    if ((ch.tripMode === 'campfire_wood' || ch.tripMode === 'campfire_dance') && ch.tripTile) {
      this.occupiedTripTiles.delete(`${ch.tripTile.col},${ch.tripTile.row}`)
    }
  }

  /** Remove an agent from the wizard line and free its reserved slot. Call wherever a
   *  character is torn down or pulled out of the ceremony. */
  private cancelWizardTrip(ch: Character): void {
    dequeue(this.wizard, ch.id)
    ch.needsBlessing = false
    if (ch.tripMode === 'wizard_blessing' && ch.tripTile) {
      this.occupiedTripTiles.delete(`${ch.tripTile.col},${ch.tripTile.row}`)
    }
  }

  setAgentActive(id: number, active: boolean): void {
    const ch = this.characters.get(id)
    if (ch) {
      const wasActive = ch.isActive
      ch.isActive = active
      if (!active) {
        ch.seatTimer = -1
        ch.path = []
        ch.moveProgress = 0
        // Just finished work → plant something on the meadow before idle leisure.
        if (wasActive && !ch.isGreeter && !ch.isKnight) {
          this.pendingPlant.add(id)
        }
      } else {
        // Re-activated mid-plant — drop the planting intent so they head back to work.
        this.pendingPlant.delete(id)
        if (ch.tripMode === 'planting') {
          // Free the claimed tile.
          if (ch.tripTile) {
            this.claimedPlantTiles.delete(`${ch.tripTile.col},${ch.tripTile.row}`)
          }
          ch.plantingTimer = undefined
        }
        // Re-activated mid-ritual — release campfire bookkeeping (the trip tile itself is
        // freed by endTrip on the next update tick once desiredTripFor returns null).
        this.cancelCampfireTrip(ch)
        // Re-blessing: every reactivation re-runs the ceremony before working.
        if (!ch.isGreeter && !ch.isWizard && !ch.isKnight) {
          ch.needsBlessing = true
        }
      }
      this.rebuildFurnitureInstances()
    }
  }

  /** Tiles holding a PC whose seated agent should be rendered as "fully on".
   *  - Non-hero seats: must be actively working (isActive=true).
   *  - Hero merge-to-main seats: must be PHYSICALLY at the chair (not still walking to it).
   *    This drives the screen glow + beams + sparkles. While walking, the PC just charges up. */
  getActivePCTiles(): Array<{ col: number; row: number; agentId: number }> {
    const result: Array<{ col: number; row: number; agentId: number }> = []
    for (const ch of this.characters.values()) {
      if (!ch.seatId) continue
      if (ch.isGreeter || ch.isKnight) continue
      const seat = this.seats.get(ch.seatId)
      if (!seat) continue
      const isHeroSeat = ch.seatId.startsWith('hero-merge-chair-')
      if (isHeroSeat) {
        // Hero: agent must be at the chair tile to count as "in use".
        if (ch.tileCol !== seat.seatCol || ch.tileRow !== seat.seatRow) continue
      } else {
        if (!ch.isActive) continue
      }
      const dCol = seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0
      const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0
      // Walk the facing direction looking for a PC tile in front of the agent.
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
        const tc = seat.seatCol + dCol * d
        const tr = seat.seatRow + dRow * d
        const pc = this.layout.furniture.find(
          (f) => f.type === 'pc' && f.col === tc && f.row === tr,
        )
        if (pc) {
          result.push({ col: tc, row: tr, agentId: ch.id })
          break
        }
      }
    }
    return result
  }

  /** Visibility filter: keeps everything except hidden station desks. Hero desks, lounge,
   *  decorations, etc. always pass through; station desks pass only if their groupId is
   *  in revealedDeskIds. */
  private getVisibleFurniture(): PlacedFurniture[] {
    return this.layout.furniture.filter((f) => {
      const gid = this.deskGroupId(f.uid)
      if (!gid) return true
      return this.revealedDeskIds.has(gid)
    })
  }

  /** Recompute blocked/walkable/furniture from the currently-visible subset. Call after
   *  any change to revealedDeskIds. */
  private rebuildVisibleState(): void {
    const visible = this.getVisibleFurniture()
    this.blockedTiles = getBlockedTiles(visible)
    for (const t of OfficeState.WIZARD_DESK_TILES) {
      this.blockedTiles.add(`${t.col},${t.row}`)
    }
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles)
    this.rebuildFurnitureInstances()
  }

  /** Extract the station-desk groupId from a furniture uid (e.g.
   *  "station-l-0-build-d0-chair-l" → "station-l-0-build-d0"). Returns null for
   *  hero/lounge/decoration uids. */
  private deskGroupId(uid: string | undefined): string | null {
    if (!uid || !uid.startsWith('station-')) return null
    const m = uid.match(/^(station-[lr]-\d+-.+?-d\d+)(?=-)/)
    return m ? m[1] : null
  }

  /** Build the ordered reveal queue from the layout's station desks. Order:
   *  outermost-first (lowest col on left, highest col on right), then top-down by tier,
   *  alternating L/R within the same outer-rank+tier. */
  private buildRevealQueue(): void {
    const desks = new Set<string>()
    for (const f of this.layout.furniture) {
      const gid = this.deskGroupId(f.uid)
      if (gid) desks.add(gid)
    }
    type Parsed = { gid: string; side: 'l' | 'r'; tier: number; dOff: number }
    const parsed: Parsed[] = []
    for (const gid of desks) {
      const m = gid.match(/^station-([lr])-(\d+)-.+-d(\d+)$/)
      if (!m) continue
      parsed.push({ gid, side: m[1] as 'l' | 'r', tier: parseInt(m[2], 10), dOff: parseInt(m[3], 10) })
    }
    parsed.sort((a, b) => {
      // Within a tier, fully fill one pod (outer-first) before moving to the other side.
      // Top-down across tiers; left pod fills before right pod within the same tier.
      // Outer rank 0 = outermost: left pod = lowest dOff, right pod = highest dOff.
      const aRank = a.side === 'l' ? a.dOff : 4 - a.dOff
      const bRank = b.side === 'l' ? b.dOff : 4 - b.dOff
      if (a.tier !== b.tier) return a.tier - b.tier
      if (a.side !== b.side) return a.side === 'l' ? -1 : 1
      return aRank - bRank
    })
    this.revealQueue = parsed.map((p) => p.gid)
  }

  /** Reveal the next hidden desk in the queue. Returns its groupId or null if all are revealed. */
  private revealNextDesk(): string | null {
    for (const gid of this.revealQueue) {
      if (!this.revealedDeskIds.has(gid)) {
        this.revealedDeskIds.add(gid)
        this.deskLastEmptyAt.delete(gid)
        this.deskAnimations.set(gid, { type: 'reveal', startMs: performance.now() })
        this.rebuildVisibleState()
        return gid
      }
    }
    return null
  }

  /** Begin hide animation for a revealed desk; the desk is removed from revealedDeskIds
   *  once the animation completes (in tickDeskAnimations). Idempotent. */
  private hideDesk(gid: string): void {
    if (!this.revealedDeskIds.has(gid)) return
    if (this.deskAnimations.get(gid)?.type === 'hide') return
    this.deskAnimations.set(gid, { type: 'hide', startMs: performance.now() })
    this.deskLastEmptyAt.delete(gid)
  }

  /** Compute the desk's center tile (col, row) by finding its 'desk'-type furniture. */
  private getDeskCenter(gid: string): { col: number; row: number } | null {
    for (const f of this.layout.furniture) {
      if (this.deskGroupId(f.uid) !== gid) continue
      if (f.type !== 'desk') continue
      // Desk is a 2-wide footprint; center it.
      return { col: f.col + 1, row: f.row + 1 }
    }
    return null
  }

  /** Snapshot of active portal rings for the renderer to draw on the floor. */
  getPortalRings(nowMs: number): import('../types.js').PortalRing[] {
    if (this.deskAnimations.size === 0) return []
    const out: import('../types.js').PortalRing[] = []
    for (const [gid, anim] of this.deskAnimations) {
      const center = this.getDeskCenter(gid)
      if (!center) continue
      const dur = anim.type === 'reveal' ? OfficeState.REVEAL_ANIM_MS : OfficeState.HIDE_ANIM_MS
      const t = Math.min(1, Math.max(0, (nowMs - anim.startMs) / dur))
      // For reveal: ring expands and fades out (alpha 1→0, radius 4→24 px).
      // For hide:   ring contracts (alpha 0.9→0, radius 24→4 px).
      const radius = anim.type === 'reveal' ? 4 + 20 * t : 24 - 20 * t
      const alpha = anim.type === 'reveal' ? 1 - t : 0.9 * (1 - t)
      out.push({
        cx: center.col * TILE_SIZE,
        cy: (center.row + 0.4) * TILE_SIZE,
        radius,
        alpha,
      })
    }
    return out
  }

  /** Per-frame: update animAlpha/animScale on furniture instances; finalize completed
   *  hide animations by actually removing the desk from revealedDeskIds. */
  private tickDeskAnimations(nowMs: number): void {
    if (this.deskAnimations.size === 0) {
      // Reset any animation overrides on furniture (cheap — only run while furniture has them).
      for (const f of this.furniture) {
        if (f.animAlpha !== undefined || f.animScale !== undefined) {
          f.animAlpha = undefined
          f.animScale = undefined
        }
      }
      return
    }
    const completed: string[] = []
    for (const [gid, anim] of this.deskAnimations) {
      const dur = anim.type === 'reveal' ? OfficeState.REVEAL_ANIM_MS : OfficeState.HIDE_ANIM_MS
      const elapsed = nowMs - anim.startMs
      if (elapsed >= dur) {
        completed.push(gid)
      }
    }
    for (const gid of completed) {
      const anim = this.deskAnimations.get(gid)!
      this.deskAnimations.delete(gid)
      if (anim.type === 'hide') {
        this.revealedDeskIds.delete(gid)
        this.deskLastEmptyAt.delete(gid)
        this.rebuildVisibleState()
      }
    }
    // Update per-instance anim props for any remaining animations.
    for (const f of this.furniture) {
      if (!f.groupId) {
        f.animAlpha = undefined
        f.animScale = undefined
        continue
      }
      const anim = this.deskAnimations.get(f.groupId)
      if (!anim) {
        f.animAlpha = undefined
        f.animScale = undefined
        continue
      }
      const dur = anim.type === 'reveal' ? OfficeState.REVEAL_ANIM_MS : OfficeState.HIDE_ANIM_MS
      const tRaw = Math.min(1, Math.max(0, (nowMs - anim.startMs) / dur))
      // Ease-out for reveal so the desk pops in then settles. Linear ease for hide.
      const t = anim.type === 'reveal' ? 1 - Math.pow(1 - tRaw, 2) : tRaw
      f.animAlpha = anim.type === 'reveal' ? t : 1 - t
      // Subtle scale: 0.6 → 1.0 on reveal, 1.0 → 0.6 on hide.
      f.animScale = anim.type === 'reveal' ? 0.6 + 0.4 * t : 1 - 0.4 * t
    }
  }

  /** Whether any seat belonging to this desk's chairs is currently assigned. */
  private isDeskOccupied(gid: string): boolean {
    for (const [seatUid, seat] of this.seats) {
      if (!seat.assigned) continue
      const chairUid = seatUid.split(':')[0]
      if (this.deskGroupId(chairUid) === gid) return true
    }
    return false
  }

  /** Periodic check (throttled): hide any revealed desk that's been empty too long. */
  private checkDespawnTimers(nowMs: number): void {
    if (nowMs - this.lastDespawnCheckMs < OfficeState.DESPAWN_CHECK_INTERVAL_MS) return
    this.lastDespawnCheckMs = nowMs
    for (const gid of Array.from(this.revealedDeskIds)) {
      if (this.isDeskOccupied(gid)) {
        this.deskLastEmptyAt.delete(gid)
        continue
      }
      const lastEmpty = this.deskLastEmptyAt.get(gid)
      if (lastEmpty === undefined) {
        this.deskLastEmptyAt.set(gid, nowMs)
        continue
      }
      if (nowMs - lastEmpty >= OfficeState.DESK_DESPAWN_MS) {
        this.hideDesk(gid)
      }
    }
  }

  /** Rebuild furniture instances with auto-state applied (active agents turn electronics ON) */
  private rebuildFurnitureInstances(): void {
    // Collect tiles where active agents face desks
    const autoOnTiles = new Set<string>()
    for (const ch of this.characters.values()) {
      if (!ch.isActive || !ch.seatId) continue
      const seat = this.seats.get(ch.seatId)
      if (!seat) continue
      // Find the desk tile(s) the agent faces from their seat
      const dCol = seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0
      const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0
      // Check tiles in the facing direction (desk could be 1-3 tiles deep)
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
        const tileCol = seat.seatCol + dCol * d
        const tileRow = seat.seatRow + dRow * d
        autoOnTiles.add(`${tileCol},${tileRow}`)
      }
      // Also check tiles to the sides of the facing direction (desks can be wide)
      for (let d = 1; d <= AUTO_ON_SIDE_DEPTH; d++) {
        const baseCol = seat.seatCol + dCol * d
        const baseRow = seat.seatRow + dRow * d
        if (dCol !== 0) {
          // Facing left/right: check tiles above and below
          autoOnTiles.add(`${baseCol},${baseRow - 1}`)
          autoOnTiles.add(`${baseCol},${baseRow + 1}`)
        } else {
          // Facing up/down: check tiles left and right
          autoOnTiles.add(`${baseCol - 1},${baseRow}`)
          autoOnTiles.add(`${baseCol + 1},${baseRow}`)
        }
      }
    }

    const visible = this.getVisibleFurniture()
    const tagInstances = (instances: FurnitureInstance[]): FurnitureInstance[] => {
      // Tag each instance with its desk groupId for animation lookup. Order is preserved
      // by layoutToFurnitureInstances (it skips items without catalog entries — those map
      // to no instance, so we walk both arrays in lockstep using a source index).
      let srcIdx = 0
      for (const inst of instances) {
        // Advance srcIdx to the next item with a catalog entry (matches layoutToFurnitureInstances).
        while (srcIdx < visible.length && !getCatalogEntry(visible[srcIdx].type)) srcIdx++
        if (srcIdx >= visible.length) break
        const gid = this.deskGroupId(visible[srcIdx].uid)
        if (gid) inst.groupId = gid
        srcIdx++
      }
      return instances
    }
    if (autoOnTiles.size === 0) {
      this.furniture = tagInstances(layoutToFurnitureInstances(visible))
      return
    }

    // Build modified furniture list with auto-state applied
    const modifiedFurniture: PlacedFurniture[] = visible.map((item) => {
      const entry = getCatalogEntry(item.type)
      if (!entry) return item
      // Check if any tile of this furniture overlaps an auto-on tile
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          if (autoOnTiles.has(`${item.col + dc},${item.row + dr}`)) {
            const onType = getOnStateType(item.type)
            if (onType !== item.type) {
              return { ...item, type: onType }
            }
            return item
          }
        }
      }
      return item
    })

    this.furniture = tagInstances(layoutToFurnitureInstances(modifiedFurniture))
  }

  setAgentTool(id: number, tool: string | null): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.currentTool = tool
      if (tool) {
        // Tool start: pump intensity, spawn a reaction effect, and shorten time-to-stretch
        // so a long tool burst is more likely to interrupt with a stand-up.
        ch.intensity = Math.min(INTENSITY_MAX, ch.intensity + INTENSITY_BOOST_PER_TOOL)
        this.spawnToolEffect(id, tool)
      }
    }
  }

  /** Pop a small floating symbol above the agent's head for a tool start */
  spawnToolEffect(agentId: number, toolName: string): void {
    const ch = this.characters.get(agentId)
    if (!ch) return
    const kind = toolKindForEffect(toolName)
    if (!kind) return
    this.effects.push({
      id: this.nextEffectId++,
      x: ch.x,
      y: ch.y,
      kind,
      age: 0,
      lifetime: EFFECT_LIFETIME_SEC,
      drift: (Math.random() * 2 - 1) * EFFECT_HORIZ_DRIFT_PX,
    })
  }

  showPermissionBubble(id: number): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.bubbleType = 'permission'
      ch.bubbleTimer = 0
    }
  }

  clearPermissionBubble(id: number): void {
    const ch = this.characters.get(id)
    if (ch && ch.bubbleType === 'permission') {
      ch.bubbleType = null
      ch.bubbleTimer = 0
    }
  }

  showWaitingBubble(id: number): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.bubbleType = 'waiting'
      ch.bubbleTimer = WAITING_BUBBLE_DURATION_SEC
    }
  }

  /** Dismiss bubble on click — permission: instant, waiting: quick fade */
  dismissBubble(id: number): void {
    const ch = this.characters.get(id)
    if (!ch || !ch.bubbleType) return
    if (ch.bubbleType === 'permission') {
      ch.bubbleType = null
      ch.bubbleTimer = 0
    } else if (ch.bubbleType === 'waiting') {
      // Trigger immediate fade (0.3s remaining)
      ch.bubbleTimer = Math.min(ch.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC)
    }
  }

  /** Called by the message hook on tool start (false) / last tool done (true). */
  setAgentBetweenTools(id: number, between: boolean): void {
    const ch = this.characters.get(id)
    if (!ch) return
    if (between) {
      // Stamp the moment they entered the no-tool gap (used to detect long thinks).
      ch.lastNoToolTime = performance.now() / 1000
    } else {
      ch.lastNoToolTime = null
    }
  }

  /** Find the closest free trip tile for the given trip type (Manhattan distance). */
  private pickFreeTripTile(
    type: 'beanbag' | 'bookshelf',
    fromCol: number,
    fromRow: number,
  ): { col: number; row: number } | null {
    let best: { col: number; row: number } | null = null
    let bestDist = Infinity
    for (const f of this.layout.furniture) {
      let candidate: { col: number; row: number } | null = null
      if (type === 'beanbag' && (f.type === 'beanbag' || f.type === 'pool_chair' || f.type === 'stump')) {
        // Beanbag, pool chair, and stump are all 1×1 sittable surfaces.
        candidate = { col: f.col, row: f.row }
      } else if (type === 'bookshelf' && f.type === 'bookshelf') {
        // Bookshelf is 1×2 and blocked — stand on the floor tile directly in front of it.
        // Bookshelves on the left wall (col 1): stand at col 2.
        // Bookshelves on the right wall (col cols-2): stand at col cols-3.
        const cols = this.layout.cols
        if (f.col <= 2) candidate = { col: f.col + 1, row: f.row + 1 }
        else if (f.col >= cols - 3) candidate = { col: f.col - 1, row: f.row + 1 }
        else candidate = { col: f.col, row: f.row + 2 }
      }
      if (!candidate) continue
      const key = `${candidate.col},${candidate.row}`
      if (this.occupiedTripTiles.has(key)) continue
      // Skip if not walkable (some bookshelf placements may face walls)
      const tile = this.tileMap[candidate.row]?.[candidate.col]
      if (tile === undefined) continue
      if (this.blockedTiles.has(key)) continue
      const dist = Math.abs(candidate.col - fromCol) + Math.abs(candidate.row - fromRow)
      if (dist < bestDist) {
        best = candidate
        bestDist = dist
      }
    }
    return best
  }

  /** The two ping-pong player tiles, flanking the lounge ping-pong table at cols 13-15, row 25. */
  private static readonly PING_PONG_SLOTS: Array<{ col: number; row: number }> = [
    { col: 12, row: 25 },  // LEFT player (faces RIGHT toward the table)
    { col: 16, row: 25 },  // RIGHT player (faces LEFT toward the table)
  ]

  /** Chess player tiles — directly under the chess sprite's two chair seats so agents
   *  visually sit IN the chairs. Chess set is at (3, 25) with sprite cols 4-13 (left chair)
   *  and 34-43 (right chair); world tiles 3 and 5. Slot row is 26 (just below the
   *  footprint), since the chair seats render in the lower half of the sprite. */
  private static readonly CHESS_SLOTS: Array<{ col: number; row: number }> = [
    { col: 3, row: 26 },  // LEFT player — faces RIGHT toward the chess board
    { col: 5, row: 26 },  // RIGHT player — faces LEFT toward the chess board
  ]

  /** Swimming pool — bottom-right of the lounge. Water rectangle spans cols 12-17 ×
   *  rows 33-34. Agents stand at row 34 (the south edge) facing up, looking like they
   *  swim within the pool. */
  static readonly POOL_RECT = { col0: 12, row0: 33, col1: 17, row1: 34 } as const
  /** Six swim slots along the pool's bottom row. */
  private static readonly POOL_SLOTS: Array<{ col: number; row: number }> = [
    { col: 12, row: 34 },
    { col: 13, row: 34 },
    { col: 14, row: 34 },
    { col: 15, row: 34 },
    { col: 16, row: 34 },
    { col: 17, row: 34 },
  ]

  /** Pick the closest free ping-pong slot for the given character, or null if both are taken. */
  private findFreePingPongSlot(ch: Character): { col: number; row: number } | null {
    let best: { col: number; row: number } | null = null
    let bestDist = Infinity
    for (const s of OfficeState.PING_PONG_SLOTS) {
      const key = `${s.col},${s.row}`
      const isMyOwnSlot = ch.tripTile && ch.tripTile.col === s.col && ch.tripTile.row === s.row
      if (this.occupiedTripTiles.has(key) && !isMyOwnSlot) continue
      const tile = this.tileMap[s.row]?.[s.col]
      if (tile === undefined) continue
      if (this.blockedTiles.has(key) && !isMyOwnSlot) continue
      const dist = Math.abs(s.col - ch.tileCol) + Math.abs(s.row - ch.tileRow)
      if (dist < bestDist) {
        best = s
        bestDist = dist
      }
    }
    return best
  }

  /** Pick the closest free chess slot for the given character, or null if both are taken. */
  private findFreeChessSlot(ch: Character): { col: number; row: number } | null {
    let best: { col: number; row: number } | null = null
    let bestDist = Infinity
    for (const s of OfficeState.CHESS_SLOTS) {
      const key = `${s.col},${s.row}`
      const isMyOwnSlot = ch.tripTile && ch.tripTile.col === s.col && ch.tripTile.row === s.row
      if (this.occupiedTripTiles.has(key) && !isMyOwnSlot) continue
      const tile = this.tileMap[s.row]?.[s.col]
      if (tile === undefined) continue
      if (this.blockedTiles.has(key) && !isMyOwnSlot) continue
      const dist = Math.abs(s.col - ch.tileCol) + Math.abs(s.row - ch.tileRow)
      if (dist < bestDist) {
        best = s
        bestDist = dist
      }
    }
    return best
  }

  /** True when this idle agent has a partner available and at least one slot is free for them. */
  private canStartPingPong(ch: Character): boolean {
    // Need at least one free slot (counting our own current slot as still ours).
    const slot = this.findFreePingPongSlot(ch)
    if (!slot) return false
    // Need a partner: another inactive non-greeter character. The "first idle agent alone"
    // scenario is excluded — they go to a beanbag instead and only switch when a partner shows up.
    for (const other of this.characters.values()) {
      if (other.id === ch.id) continue
      if (other.isGreeter) continue
      if (!other.isActive) return true
    }
    return false
  }

  /** Find the ping-pong player whose slot matches the given side, or null. */
  private getPingPongPlayer(side: 'left' | 'right'): Character | null {
    const slot = side === 'left' ? OfficeState.PING_PONG_SLOTS[0] : OfficeState.PING_PONG_SLOTS[1]
    for (const ch of this.characters.values()) {
      if (ch.tripMode !== 'ping_pong') continue
      if (!ch.tripTile) continue
      if (ch.tripTile.col === slot.col && ch.tripTile.row === slot.row) return ch
    }
    return null
  }

  /** Whether a player has arrived at their ping-pong slot (vs still walking there). */
  private isPlayerSeatedAtPingPong(ch: Character | null): boolean {
    if (!ch || !ch.tripTile) return false
    return ch.tileCol === ch.tripTile.col && ch.tileRow === ch.tripTile.row
  }

  /** Pick a non-greeter, non-trip, inactive character to swap into the loser's slot at game end. */
  private findPingPongWaiter(excludeId: number): Character | null {
    for (const ch of this.characters.values()) {
      if (ch.id === excludeId) continue
      if (ch.isGreeter || ch.isActive) continue
      if (ch.tripMode === 'ping_pong' || ch.tripMode === 'chess') continue
      if (ch.matrixEffect) continue
      return ch
    }
    return null
  }

  /** Advance ping-pong match phases: idle → rallying → scoring → celebrating → repeat,
   *  ending the match (and swapping the loser with a waiting agent) when a player hits
   *  PP_SCORE_TO_WIN. Driven by performance.now() ms timestamps. */
  private updatePingPongMatch(nowMs: number): void {
    const left = this.getPingPongPlayer('left')
    const right = this.getPingPongPlayer('right')
    const bothSeated = this.isPlayerSeatedAtPingPong(left) && this.isPlayerSeatedAtPingPong(right)
    if (!bothSeated) {
      // No active match yet (or one player walking in). Don't start until both seated.
      this.pingPongMatch = null
      return
    }
    if (!this.pingPongMatch) {
      this.pingPongMatch = {
        leftScore: 0,
        rightScore: 0,
        phase: 'rallying',
        phaseStartMs: nowMs,
        pointDurationMs: OfficeState.PP_POINT_MIN_MS + Math.random() * (OfficeState.PP_POINT_MAX_MS - OfficeState.PP_POINT_MIN_MS),
        lastPointWinner: null,
      }
      return
    }
    const m = this.pingPongMatch
    const elapsed = nowMs - m.phaseStartMs
    if (m.phase === 'rallying' && elapsed >= m.pointDurationMs) {
      // Point ended — random winner.
      const winner: 'left' | 'right' = Math.random() < 0.5 ? 'left' : 'right'
      m.lastPointWinner = winner
      if (winner === 'left') m.leftScore++
      else m.rightScore++
      m.phase = 'scoring'
      m.phaseStartMs = nowMs
      return
    }
    if (m.phase === 'scoring' && elapsed >= OfficeState.PP_SCORING_MS) {
      m.phase = 'celebrating'
      m.phaseStartMs = nowMs
      return
    }
    if (m.phase === 'celebrating' && elapsed >= OfficeState.PP_CELEBRATING_MS) {
      const gameOver =
        m.leftScore >= OfficeState.PP_SCORE_TO_WIN || m.rightScore >= OfficeState.PP_SCORE_TO_WIN
      if (!gameOver) {
        m.phase = 'rallying'
        m.phaseStartMs = nowMs
        m.pointDurationMs = OfficeState.PP_POINT_MIN_MS + Math.random() * (OfficeState.PP_POINT_MAX_MS - OfficeState.PP_POINT_MIN_MS)
        m.lastPointWinner = null
        return
      }
      // Game over — swap loser with a waiting agent if one exists.
      const winnerSide: 'left' | 'right' = m.leftScore > m.rightScore ? 'left' : 'right'
      const loserSide: 'left' | 'right' = winnerSide === 'left' ? 'right' : 'left'
      const loser = this.getPingPongPlayer(loserSide)
      const waiter = loser ? this.findPingPongWaiter(loser.id) : null
      if (loser) {
        // Free their slot + send them home so the seat opens for the waiter.
        this.endTrip(loser)
      }
      if (waiter) {
        this.startTrip(waiter, 'ping_pong')
      }
      // Match cleared — next tick will rebuild when both slots are filled again (or wait).
      this.pingPongMatch = null
    }
  }

  /** Whether all four hero merge-to-main PCs have a sprite physically seated at them. */
  private isAllHeroOccupied(): boolean {
    let count = 0
    for (const ch of this.characters.values()) {
      if (!ch.seatId) continue
      if (!ch.seatId.startsWith('hero-merge-chair-')) continue
      const seat = this.seats.get(ch.seatId)
      if (!seat) continue
      if (ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) count++
    }
    return count >= 4
  }

  /** Lerp animals toward their current target. Rabbits/squirrels hop near home (or to
   *  the merge-watch spot when all 4 hero PCs are firing). Baby dragons get role-driven
   *  behavior: cling to momma, perch on bookshelves, drift across the meadow as
   *  roamers, or stalk and eat rabbits as hunters. */
  private tickAnimals(dt: number, nowMs: number): void {
    if (this.animals.length === 0) return
    const watching = this.isAllHeroOccupied()
    // Hunters eat in-place removals — collect indices first, splice after the loop so
    // we don't shift the array while iterating.
    const toRemove: number[] = []
    for (let i = 0; i < this.animals.length; i++) {
      const a = this.animals[i]
      const lerpRate = Math.min(1, dt * (a.kind === 'baby-dragon' && a.role === 'roamer' ? 1.6 : 2.4))
      let tx: number
      let ty: number

      if (a.kind === 'baby-dragon') {
        // Pause for the eating animation — dragon stays put on its rabbit.
        if (a.eatingUntilMs !== undefined && nowMs < a.eatingUntilMs) {
          tx = a.x
          ty = a.y
        } else {
          if (a.eatingUntilMs !== undefined && nowMs >= a.eatingUntilMs) {
            a.eatingUntilMs = undefined
            a.nextHopAt = nowMs + 500
          }
          ;({ tx, ty } = this.dragonTarget(a, nowMs, toRemove, i))
        }
      } else if (watching) {
        tx = a.watchX
        ty = a.watchY
        // Push next random hop slightly into the future so they don't bolt away the
        // instant the merge ends.
        a.nextHopAt = nowMs + 600
      } else {
        // Pick a new random target every so often (or when we've reached the current one).
        const reached = Math.abs(a.targetX - a.x) < 1 && Math.abs(a.targetY - a.y) < 1
        if (nowMs >= a.nextHopAt || reached) {
          const r = OfficeState.ANIMAL_HOP_RADIUS_PX
          a.targetX = a.homeX + (Math.random() - 0.5) * r * 2
          a.targetY = a.homeY + (Math.random() - 0.5) * r * 2
          const span = OfficeState.ANIMAL_HOP_MAX_MS - OfficeState.ANIMAL_HOP_MIN_MS
          a.nextHopAt = nowMs + OfficeState.ANIMAL_HOP_MIN_MS + Math.random() * span
        }
        tx = a.targetX
        ty = a.targetY
      }

      const dx = tx - a.x
      const dy = ty - a.y
      a.x += dx * lerpRate
      a.y += dy * lerpRate
      if (Math.abs(dx) > 0.4) a.facing = dx > 0 ? 'right' : 'left'
    }
    if (toRemove.length > 0) {
      // Remove in descending order so indices stay valid as we splice.
      toRemove.sort((p, q) => q - p)
      for (const idx of toRemove) this.animals.splice(idx, 1)
    }
    // Respawn any rabbits whose timer has elapsed.
    if (this.rabbitRespawnQueue.length > 0) {
      const ready: typeof this.rabbitRespawnQueue = []
      const pending: typeof this.rabbitRespawnQueue = []
      for (const entry of this.rabbitRespawnQueue) {
        if (nowMs >= entry.at) ready.push(entry)
        else pending.push(entry)
      }
      this.rabbitRespawnQueue = pending
      for (const r of ready) {
        this.animals.push({
          kind: 'rabbit',
          homeX: r.homeX, homeY: r.homeY,
          watchX: r.watchX, watchY: r.watchY,
          x: r.homeX, y: r.homeY,
          facing: 'right',
          targetX: r.homeX, targetY: r.homeY,
          nextHopAt: nowMs + Math.random() * 2000,
        })
      }
    }
  }

  /** Compute this baby dragon's current target tile based on its role. May mutate
   *  per-dragon state (re-pick a roam target, latch onto a rabbit, eat one), and may
   *  append an index to `toRemove` when a rabbit gets eaten. */
  private dragonTarget(
    a: NonNullable<OfficeState['animals'][number]>,
    nowMs: number,
    toRemove: number[],
    _selfIndex: number,
  ): { tx: number; ty: number } {
    const reached = Math.abs(a.targetX - a.x) < 1 && Math.abs(a.targetY - a.y) < 1

    switch (a.role) {
      case 'momma_pet': {
        if (nowMs >= a.nextHopAt || reached) {
          // Tight hops around the assigned snuggle spot on momma.
          a.targetX = a.homeX + (Math.random() - 0.5) * 12
          a.targetY = a.homeY + (Math.random() - 0.5) * 8
          a.nextHopAt = nowMs + 2500 + Math.random() * 2500
        }
        break
      }

      case 'bookshelf': {
        if (nowMs >= a.nextHopAt || reached) {
          // Mostly perched still; occasional 1-2 px shuffle along the shelf top.
          a.targetX = a.homeX + (Math.random() - 0.5) * 6
          a.targetY = a.homeY + (Math.random() - 0.5) * 3
          a.nextHopAt = nowMs + 3500 + Math.random() * 3500
        }
        break
      }

      case 'roamer': {
        if (nowMs >= a.nextHopAt || reached) {
          // Pick a fresh meadow point and drift there over several seconds.
          const t = OfficeState.pickMeadowPoint(this.layout)
          a.targetX = t.x
          a.targetY = t.y
          a.nextHopAt = nowMs + 4000 + Math.random() * 4000
        }
        break
      }

      case 'hunter': {
        // If on cooldown, just orbit home like a roamer at a smaller radius.
        const onCooldown = (a.nextHuntAt ?? 0) > nowMs
        if (!onCooldown) {
          // Find nearest rabbit and dive at it.
          let bestIdx = -1
          let bestDistSq = Infinity
          for (let i = 0; i < this.animals.length; i++) {
            const other = this.animals[i]
            if (other.kind !== 'rabbit') continue
            const dx = other.x - a.x
            const dy = other.y - a.y
            const d2 = dx * dx + dy * dy
            if (d2 < bestDistSq) { bestDistSq = d2; bestIdx = i }
          }
          if (bestIdx >= 0) {
            const rabbit = this.animals[bestIdx]
            a.targetX = rabbit.x
            a.targetY = rabbit.y
            // Close enough? Eat it.
            const dist = Math.sqrt(bestDistSq)
            if (dist <= OfficeState.DRAGON_EAT_RANGE_PX) {
              toRemove.push(bestIdx)
              // Queue the rabbit to respawn at its original home so the meadow refills.
              this.rabbitRespawnQueue.push({
                homeX: rabbit.homeX, homeY: rabbit.homeY,
                watchX: rabbit.watchX, watchY: rabbit.watchY,
                at: nowMs + OfficeState.RABBIT_RESPAWN_MS,
              })
              a.eatingUntilMs = nowMs + OfficeState.DRAGON_EAT_DURATION_MS
              a.nextHuntAt = nowMs + OfficeState.DRAGON_HUNT_COOLDOWN_MS
              a.nextHopAt = nowMs + OfficeState.DRAGON_EAT_DURATION_MS + 800
            }
            break
          }
        }
        // No rabbit available or cooling down — drift around home.
        if (nowMs >= a.nextHopAt || reached) {
          a.targetX = a.homeX + (Math.random() - 0.5) * 32
          a.targetY = a.homeY + (Math.random() - 0.5) * 24
          a.nextHopAt = nowMs + 2000 + Math.random() * 2500
        }
        break
      }

      default: {
        // No role assigned (shouldn't happen for hatched dragons, but defensive) — tight
        // hops around home like the original behavior.
        if (nowMs >= a.nextHopAt || reached) {
          a.targetX = a.homeX + (Math.random() - 0.5) * 12
          a.targetY = a.homeY + (Math.random() - 0.5) * 12
          a.nextHopAt = nowMs + 1500 + Math.random() * 2000
        }
        break
      }
    }
    return { tx: a.targetX, ty: a.targetY }
  }

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
      else if (ev === 'hatch') this.hatchDragon()
      // 'start_dancing' / 'lay_egg' need no imperative action here.
    }

    // Face every seated dancer toward the fire + flag them as transformed.
    for (const id of this.campfire.dancers) {
      const ch = this.characters.get(id)
      if (!ch || !ch.tripTile) continue
      if (ch.tileCol === ch.tripTile.col && ch.tileRow === ch.tripTile.row) {
        ch.dir = this.facingTowardTile(ch, this.fireTile)
        ch.danced = true
      }
    }
  }

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
      // Queue beyond MAX_LINE shares the last tile (benign visual stacking; line drains
      // FIFO so no soft-lock).
      const slot = this.wizardLineTiles[Math.min(idx, this.wizardLineTiles.length - 1)]
      if (ch.tripMode !== 'wizard_blessing') {
        // Not started yet — the generic reconciliation will call startTrip; ensure the slot is free.
        return
      }
      if (ch.tripTile && (ch.tripTile.col !== slot.col || ch.tripTile.row !== slot.row)) {
        // Swap the trip-tile reservation only once a path is confirmed, so a failed
        // findPath never leaves an unbacked reservation (matches startTrip).
        const path = findPath(ch.tileCol, ch.tileRow, slot.col, slot.row, this.tileMap, this.blockedTiles)
        if (path.length > 0) {
          this.occupiedTripTiles.delete(`${ch.tripTile.col},${ch.tripTile.row}`)
          this.occupiedTripTiles.add(`${slot.col},${slot.row}`)
          ch.tripTile = { col: slot.col, row: slot.row }
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
        this.wizardBlessStartMs = nowMs
        if (headCh) headCh.dir = Direction.UP // face the wizard
      } else if (ev === 'cast_summon') {
        if (headCh) {
          this.summonDeskFor(headCh)
          // During the trip ch.seatId is null — the real seat is in originalSeatId.
          const seatId = headCh.originalSeatId ?? headCh.seatId
          const seat = seatId ? this.seats.get(seatId) : undefined
          if (seat) {
            this.wizardSummonTo = { col: seat.seatCol, row: seat.seatRow }
            this.wizardSummonUntilMs = nowMs + 900
          }
        }
      } else if (ev === 'release' || ev === 'evict') {
        if (headCh) {
          headCh.needsBlessing = false
          this.endTrip(headCh) // frees the slot + walks them to their seat
        }
      }
    }
  }

  /** Reveal the agent's desk PC if it is not already shown. The wand-bolt visual is
   *  rendered separately; this performs the actual materialize "if needed". */
  private summonDeskFor(ch: Character): void {
    // Mid-blessing, startTrip has nulled ch.seatId and stashed the real seat in
    // originalSeatId; resolve that first so we reveal the agent's own desk.
    const seatId = ch.originalSeatId ?? ch.seatId
    if (!seatId) {
      // No reserved seat — fall back to revealing the next pooled desk if we're out.
      this.revealNextDesk()
      return
    }
    const chairUid = seatId.split(':')[0]
    const gid = this.deskGroupId(chairUid)
    if (gid && !this.revealedDeskIds.has(gid)) {
      this.revealedDeskIds.add(gid)
      this.deskLastEmptyAt.delete(gid)
      this.deskAnimations.set(gid, { type: 'reveal', startMs: performance.now() })
      this.rebuildVisibleState()
    }
  }

  /** Pull idle agents onto free dance slots, up to the ring capacity. */
  private recruitDancers(): void {
    const live = this.campfire.dancers.filter((id) => {
      const ch = this.characters.get(id)
      return ch && ch.tripMode === 'campfire_dance'
    })
    let changed = live.length !== this.campfire.dancers.length
    const dancers = live
    for (const ch of this.characters.values()) {
      if (dancers.length >= this.danceSlots.length) break
      if (ch.isGreeter || ch.isKnight || ch.isActive || ch.matrixEffect) continue
      if (ch.tripMode === 'campfire_dance') continue
      // Let wood-fetchers finish their run (they hold a woodReserved slot); they'll
      // become idle and join the dance on a later pass.
      if (ch.tripMode === 'campfire_wood') continue
      // Don't poach agents committed to multi-player activities — let matches finish naturally.
      if (ch.tripMode === 'ping_pong' || ch.tripMode === 'chess' || ch.tripMode === 'pool') continue
      if (this.findFreeDanceSlot(ch) === null) continue
      // Free any current trip tile before reassigning.
      if (ch.tripTile) {
        if (ch.tripMode === 'planting') this.claimedPlantTiles.delete(`${ch.tripTile.col},${ch.tripTile.row}`)
        this.occupiedTripTiles.delete(`${ch.tripTile.col},${ch.tripTile.row}`)
        ch.tripTile = null
        ch.tripMode = null
      }
      if (this.startTrip(ch, 'campfire_dance')) { dancers.push(ch.id); changed = true }
    }
    if (changed) this.campfire = { ...this.campfire, dancers }
  }

  /** Advance every seated dancer one slot clockwise. A cyclic shift among the dancers'
   *  own slots, applied as a simultaneous two-phase permutation so a FULL ring doesn't
   *  deadlock (every target is another dancer's just-vacated slot). */
  private rotateDancers(): void {
    const moves: Array<{ ch: Character; from: Tile; to: Tile }> = []
    for (const id of this.campfire.dancers) {
      const ch = this.characters.get(id)
      if (!ch || !ch.tripTile) continue
      const idx = this.danceSlots.findIndex((s) => s.col === ch.tripTile!.col && s.row === ch.tripTile!.row)
      if (idx < 0) continue
      const to = this.danceSlots[(idx + 1) % this.danceSlots.length]
      moves.push({ ch, from: ch.tripTile, to })
    }
    if (moves.length < 2) return
    // Phase 1: release every dancer's current slot (no transient conflict).
    for (const m of moves) this.occupiedTripTiles.delete(`${m.from.col},${m.from.row}`)
    // Phase 2: claim the next slot. Distinct dancers map to distinct next slots, so the
    // only blocker is a wall — fall back to staying put in that (unexpected) case.
    for (const m of moves) {
      const target = this.blockedTiles.has(`${m.to.col},${m.to.row}`) ? m.from : m.to
      this.occupiedTripTiles.add(`${target.col},${target.row}`)
      m.ch.tripTile = target
      if (target !== m.from) {
        const path = findPath(m.ch.tileCol, m.ch.tileRow, target.col, target.row, this.tileMap, this.blockedTiles)
        if (path.length > 0) {
          m.ch.path = path
          m.ch.moveProgress = 0
          m.ch.state = CharacterState.WALK
          m.ch.frame = 0
          m.ch.frameTimer = 0
        }
      }
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

  /** Count agents currently standing on a dance slot. */
  private countSeatedDancers(): number {
    let n = 0
    for (const id of this.campfire.dancers) {
      const ch = this.characters.get(id)
      if (ch && ch.tripTile && ch.tileCol === ch.tripTile.col && ch.tileRow === ch.tripTile.row) n++
    }
    return n
  }

  /** Hatch one baby dragon. The first hatchlings stick close to the fire; later ones
   *  branch out — perching on bookshelves, snuggling up to the sleeping mother dragon,
   *  free-roaming the meadow, or stalking rabbits. */
  private hatchDragon(): void {
    if (!this.fireTile) return
    const broodCount = this.animals.filter((a) => a.kind === 'baby-dragon').length
    const fx = this.fireTile.col * TILE_SIZE + TILE_SIZE / 2
    const fy = this.fireTile.row * TILE_SIZE + TILE_SIZE / 2

    // Role rotation, weighted so most stay near the fire/momma but every brood adds
    // some perchers, roamers, and the occasional hunter.
    const role = OfficeState.pickDragonRole(broodCount)
    let homeX = fx
    let homeY = fy
    if (role === 'momma_pet') {
      // Snuggled up against the mother. Small jitter so multiple pets fan out a bit.
      const jitterAngle = broodCount * 2.39996
      homeX = OfficeState.MOMMA_DRAGON_CENTER_X + Math.cos(jitterAngle) * TILE_SIZE * 0.6
      homeY = OfficeState.MOMMA_DRAGON_CENTER_Y + Math.sin(jitterAngle) * TILE_SIZE * 0.4
    } else if (role === 'bookshelf' && this.bookshelfTiles.length > 0) {
      // Each bookshelf perch is unique — cycle through the available shelves first.
      const shelfCount = this.bookshelfTiles.length
      const usedShelves = new Set(
        this.animals
          .filter((a) => a.kind === 'baby-dragon' && a.role === 'bookshelf')
          .map((a) => `${Math.round(a.homeX)},${Math.round(a.homeY)}`),
      )
      let chosen = this.bookshelfTiles[broodCount % shelfCount]
      for (const t of this.bookshelfTiles) {
        const key = `${t.col * TILE_SIZE + TILE_SIZE / 2},${t.row * TILE_SIZE + TILE_SIZE / 2}`
        if (!usedShelves.has(key)) { chosen = t; break }
      }
      homeX = chosen.col * TILE_SIZE + TILE_SIZE / 2
      // Perched on TOP of the shelf — pull up a few pixels so they sit on the edge.
      homeY = chosen.row * TILE_SIZE + TILE_SIZE / 2 - 4
    } else if (role === 'roamer') {
      // Initial roam target: a random meadow tile, drift refreshes on every hop.
      const t = OfficeState.pickMeadowPoint(this.layout)
      homeX = t.x
      homeY = t.y
    } else if (role === 'hunter') {
      // Hunters orbit the fire by default and pick rabbits to chase opportunistically.
      const angle = broodCount * 2.39996
      const radius = TILE_SIZE * 3
      homeX = fx + Math.cos(angle) * radius
      homeY = fy + Math.sin(angle) * radius
    } else {
      // 'momma_pet' fallback (no bookshelves available, etc.) — circle the fire close.
      const angle = broodCount * 2.39996
      const radius = TILE_SIZE * 1.6
      homeX = fx + Math.cos(angle) * radius
      homeY = fy + Math.sin(angle) * radius
    }

    this.animals.push({
      kind: 'baby-dragon',
      homeX, homeY,
      watchX: homeX, watchY: homeY,  // dragons ignore the merge-watch gather
      x: fx, y: fy,                  // born at the egg, then drifts to home
      facing: homeX >= fx ? 'right' : 'left',
      targetX: homeX, targetY: homeY,
      nextHopAt: performance.now() + Math.random() * 2000,
      role,
      nextHuntAt: role === 'hunter' ? performance.now() + 6000 + Math.random() * 8000 : undefined,
    })
  }

  /** Deterministic-ish role weights per brood ordinal. Early dragons hug the fire, the
   *  rest spread out so the meadow stays interesting as the brood grows. */
  private static pickDragonRole(broodCount: number): 'momma_pet' | 'bookshelf' | 'roamer' | 'hunter' {
    // Fixed first few so the first hatchlings look distinct.
    if (broodCount === 0) return 'momma_pet'
    if (broodCount === 1) return 'bookshelf'
    if (broodCount === 2) return 'roamer'
    if (broodCount === 3) return 'hunter'
    // Beyond that: weighted random — 35% momma_pet, 25% bookshelf, 25% roamer, 15% hunter.
    const r = Math.random()
    if (r < 0.35) return 'momma_pet'
    if (r < 0.60) return 'bookshelf'
    if (r < 0.85) return 'roamer'
    return 'hunter'
  }

  /** Random meadow-ish point inside the layout — used to seed roamers and pick new
   *  drift targets. Not walkability-checked because dragons fly. */
  private static pickMeadowPoint(layout: OfficeLayout): { x: number; y: number } {
    const c = 2 + Math.floor(Math.random() * Math.max(1, layout.cols - 4))
    const r = 2 + Math.floor(Math.random() * Math.max(1, layout.rows - 4))
    return { x: c * TILE_SIZE + TILE_SIZE / 2, y: r * TILE_SIZE + TILE_SIZE / 2 }
  }

  /** True when this idle agent has a partner available and at least one chess slot is free. */
  private canStartChess(ch: Character): boolean {
    const slot = this.findFreeChessSlot(ch)
    if (!slot) return false
    for (const other of this.characters.values()) {
      if (other.id === ch.id) continue
      if (other.isGreeter) continue
      if (!other.isActive) return true
    }
    return false
  }

  /** Pick the closest free pool slot for the given character, or null if all are taken. */
  private findFreePoolSlot(ch: Character): { col: number; row: number } | null {
    let best: { col: number; row: number } | null = null
    let bestDist = Infinity
    for (const s of OfficeState.POOL_SLOTS) {
      const key = `${s.col},${s.row}`
      const isMyOwnSlot = ch.tripTile && ch.tripTile.col === s.col && ch.tripTile.row === s.row
      if (this.occupiedTripTiles.has(key) && !isMyOwnSlot) continue
      const tile = this.tileMap[s.row]?.[s.col]
      if (tile === undefined) continue
      if (this.blockedTiles.has(key) && !isMyOwnSlot) continue
      const dist = Math.abs(s.col - ch.tileCol) + Math.abs(s.row - ch.tileRow)
      if (dist < bestDist) {
        best = s
        bestDist = dist
      }
    }
    return best
  }

  /** Pool needs no partner — solo swimming is fine. */
  private canStartPool(ch: Character): boolean {
    return this.findFreePoolSlot(ch) !== null
  }

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

  /** Pick a random grass tile (h===95 in tileColors) that is walkable, not blocked,
   *  not already planted, and not claimed by another planter. Returns null on no
   *  candidates. */
  private findFreePlantingTile(ch: Character): { col: number; row: number } | null {
    const cols = this.layout.cols
    const rows = this.layout.rows
    const tileColors = this.layout.tileColors
    if (!tileColors) return null
    // Sample up to 24 random tiles. Cheap and tends to find one quickly.
    for (let attempt = 0; attempt < 24; attempt++) {
      const c = Math.floor(Math.random() * cols)
      const r = Math.floor(Math.random() * rows)
      const tc = tileColors[r * cols + c]
      if (!tc || tc.h !== 95) continue  // grass only
      const key = `${c},${r}`
      if (this.blockedTiles.has(key)) continue
      if (this.claimedPlantTiles.has(key)) continue
      if (this.plantedFlowers.has(key)) continue
      // Reachable check: pathfind from agent's position.
      const path = findPath(ch.tileCol, ch.tileRow, c, r, this.tileMap, this.blockedTiles)
      if (path.length === 0 && !(ch.tileCol === c && ch.tileRow === r)) continue
      return { col: c, row: r }
    }
    return null
  }

  /** Begin walking the agent toward a trip target. Returns true if a path was found. */
  private startTrip(ch: Character, type: 'beanbag' | 'bookshelf' | 'pacing' | 'ping_pong' | 'chess' | 'pool' | 'planting' | 'campfire_wood' | 'campfire_dance' | 'wizard_blessing'): boolean {
    let target: { col: number; row: number } | null
    if (type === 'pacing') {
      target = this.pickPacingTile(ch.tileCol, ch.tileRow)
    } else if (type === 'ping_pong') {
      target = this.findFreePingPongSlot(ch)
    } else if (type === 'chess') {
      target = this.findFreeChessSlot(ch)
    } else if (type === 'pool') {
      target = this.findFreePoolSlot(ch)
    } else if (type === 'planting') {
      target = this.findFreePlantingTile(ch)
      if (target) {
        this.claimedPlantTiles.add(`${target.col},${target.row}`)
      }
    } else if (type === 'campfire_wood') {
      target = this.woodpileTile
    } else if (type === 'campfire_dance') {
      target = this.findFreeDanceSlot(ch)
    } else if (type === 'wizard_blessing') {
      target = this.wizardSlotFor(ch)
    } else {
      target = this.pickFreeTripTile(type, ch.tileCol, ch.tileRow)
    }
    if (!target) return false
    const path = findPath(
      ch.tileCol,
      ch.tileRow,
      target.col,
      target.row,
      this.tileMap,
      this.blockedTiles,
    )
    if (path.length === 0) return false
    if (type === 'campfire_wood') {
      // Reserve a wood slot now that the run is confirmed (decremented when the log is dropped).
      this.campfire = { ...this.campfire, woodReserved: this.campfire.woodReserved + 1 }
    }
    if (ch.originalSeatId === null) {
      ch.originalSeatId = ch.seatId
    }
    ch.seatId = null  // tells WALK→arrive logic to "sit in place"
    ch.tripMode = type
    ch.tripTile = target
    // Pacing aisles and the shared woodpile aren't reserved (many agents use them);
    // the wood-drop tile is reserved explicitly when the agent picks up a log.
    if (type !== 'pacing' && type !== 'campfire_wood') {
      this.occupiedTripTiles.add(`${target.col},${target.row}`)
    }
    ch.path = path
    ch.moveProgress = 0
    ch.state = CharacterState.WALK
    ch.frame = 0
    ch.frameTimer = 0
    return true
  }

  /** The line tile this agent should occupy, based on its index in the wizard queue.
   *  Falls back to the back of the line if it is not yet enqueued. */
  private wizardSlotFor(ch: Character): WizardTile | null {
    if (this.wizardLineTiles.length === 0) return null
    let idx = this.wizard.queue.indexOf(ch.id)
    if (idx < 0) idx = this.wizard.queue.length // about to be appended
    // Queue beyond MAX_LINE shares the last tile (benign visual stacking; line drains
    // FIFO so no soft-lock).
    const clamped = Math.min(idx, this.wizardLineTiles.length - 1)
    return this.wizardLineTiles[clamped]
  }

  /** Pick a random walkable tile in one of the horizontal aisles, biased away from
   *  the agent's current position so they visibly traverse the aisle. */
  private pickPacingTile(fromCol: number, fromRow: number): { col: number; row: number } | null {
    const candidates: Array<{ col: number; row: number; dist: number }> = []
    const cols = this.layout.cols
    for (const row of PACING_ROWS) {
      for (let col = 1; col < cols - 1; col++) {
        if (this.blockedTiles.has(`${col},${row}`)) continue
        const tile = this.tileMap[row]?.[col]
        if (tile === undefined) continue
        const dist = Math.abs(col - fromCol) + Math.abs(row - fromRow)
        if (dist < 5) continue
        candidates.push({ col, row, dist })
      }
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.dist - a.dist)
    const top = candidates.slice(0, Math.max(4, Math.floor(candidates.length / 3)))
    return top[Math.floor(Math.random() * top.length)]
  }

  /** End the current trip and walk the agent back toward their home seat. */
  private endTrip(ch: Character): void {
    if (ch.tripTile) {
      this.occupiedTripTiles.delete(`${ch.tripTile.col},${ch.tripTile.row}`)
      ch.tripTile = null
    }
    ch.tripMode = null
    if (ch.originalSeatId) {
      ch.seatId = ch.originalSeatId
      ch.originalSeatId = null
      const seat = this.seats.get(ch.seatId)
      if (seat && (ch.tileCol !== seat.seatCol || ch.tileRow !== seat.seatRow)) {
        const path = findPath(
          ch.tileCol,
          ch.tileRow,
          seat.seatCol,
          seat.seatRow,
          this.tileMap,
          this.blockedTiles,
        )
        if (path.length > 0) {
          ch.path = path
          ch.moveProgress = 0
          ch.state = CharacterState.WALK
          ch.frame = 0
          ch.frameTimer = 0
        }
      }
    }
  }

  /** Cardinal facing from an agent toward a target tile. */
  private facingTowardTile(ch: Character, t: Tile): Direction {
    return Math.abs(t.col - ch.tileCol) > Math.abs(t.row - ch.tileRow)
      ? (t.col > ch.tileCol ? Direction.RIGHT : Direction.LEFT)
      : (t.row > ch.tileRow ? Direction.DOWN : Direction.UP)
  }

  /** Determine what trip (if any) the agent should currently be on. */
  private desiredTripFor(ch: Character, _now: number): 'beanbag' | 'bookshelf' | 'pacing' | 'ping_pong' | 'chess' | 'pool' | 'planting' | 'campfire_wood' | 'campfire_dance' | 'wizard_blessing' | null {
    // The blessing gates everything else, for active and idle agents alike.
    if (ch.needsBlessing) return 'wizard_blessing'
    if (!ch.isActive) {
      // Stay committed to in-flight planting until the timer runs out below.
      if (ch.tripMode === 'planting') return 'planting'
      // Just finished work? Detour through the meadow to plant a flower first.
      if (this.pendingPlant.has(ch.id)) return 'planting'
      // Already committed to a chess/ping-pong/pool slot? Stay — don't flap if a partner's
      // isActive bit briefly toggles during a tool call. The slot is reserved either way.
      if (ch.tripMode === 'chess' && ch.tripTile) return 'chess'
      if (ch.tripMode === 'ping_pong' && ch.tripTile) return 'ping_pong'
      if (ch.tripMode === 'pool') return 'pool'
      // Stay committed to an in-flight wood run.
      if (ch.tripMode === 'campfire_wood') return 'campfire_wood'
      // Stay committed to an in-flight dance.
      if (ch.tripMode === 'campfire_dance') return 'campfire_dance'
      // Start a wood run if the fire wants feeding (takes priority over lounging).
      if (this.canStartCampfireWood(ch)) return 'campfire_wood'
      // Not yet at a slot — fall through to fresh selection.
      // Prefer 2-player activities first, then pool (6 slots), then beanbag.
      if (this.canStartPingPong(ch)) return 'ping_pong'
      if (this.canStartChess(ch)) return 'chess'
      if (this.canStartPool(ch)) return 'pool'
      return 'beanbag'
    }
    if (ch.lastNoToolTime === null && isReadingTool(ch.currentTool)) return 'bookshelf'
    return null  // No pacing — compact layout has no inter-pod aisles
  }

  /** Pick a random walkable tile inside the knight's wander box for him to roam to. */
  private pickKnightWanderTile(): { col: number; row: number } | null {
    const tries = 8
    for (let i = 0; i < tries; i++) {
      const c = OfficeState.KNIGHT_WANDER_MIN_COL +
        Math.floor(Math.random() * (OfficeState.KNIGHT_WANDER_MAX_COL - OfficeState.KNIGHT_WANDER_MIN_COL + 1))
      const r = OfficeState.KNIGHT_WANDER_MIN_ROW +
        Math.floor(Math.random() * (OfficeState.KNIGHT_WANDER_MAX_ROW - OfficeState.KNIGHT_WANDER_MIN_ROW + 1))
      const key = `${c},${r}`
      if (this.blockedTiles.has(key)) continue
      const tile = this.tileMap[r]?.[c]
      if (tile === undefined || tile === TileType.WALL || tile === TileType.VOID) continue
      return { col: c, row: r }
    }
    return null
  }

  /** Pathfind the knight from his current tile to a target, returning true if a path was found. */
  private knightWalkTo(ch: Character, target: { col: number; row: number }): boolean {
    if (ch.tileCol === target.col && ch.tileRow === target.row) {
      ch.path = []
      ch.state = CharacterState.IDLE
      return true
    }
    const path = findPath(ch.tileCol, ch.tileRow, target.col, target.row, this.tileMap, this.blockedTiles)
    if (path.length === 0) return false
    ch.path = path
    ch.moveProgress = 0
    ch.state = CharacterState.WALK
    ch.frame = 0
    ch.frameTimer = 0
    return true
  }

  /** Find a walkable tile adjacent to the given character (4-neighbours), preferring the
   *  tile to their immediate south/north. Used when the knight needs to stand next to an
   *  agent to perform the ceremony. */
  private findTileAdjacentTo(target: Character): { col: number; row: number } | null {
    const candidates: Array<{ col: number; row: number }> = [
      { col: target.tileCol, row: target.tileRow + 1 },
      { col: target.tileCol, row: target.tileRow - 1 },
      { col: target.tileCol - 1, row: target.tileRow },
      { col: target.tileCol + 1, row: target.tileRow },
    ]
    for (const c of candidates) {
      const key = `${c.col},${c.row}`
      if (this.blockedTiles.has(key)) continue
      const tile = this.tileMap[c.row]?.[c.col]
      if (tile === undefined || tile === TileType.WALL || tile === TileType.VOID) continue
      return c
    }
    return null
  }

  /** Knight finite-state machine. Called once per frame from update() while ch.isKnight. */
  private tickKnight(ch: Character, dt: number, nowMs: number): void {
    // Always run base movement so walk paths progress.
    updateCharacter(ch, dt, this.walkableTiles, this.seats, this.tileMap, this.blockedTiles)

    // Sweep stale queue entries — free any agent who's been waiting too long.
    if (this.knightingQueue.length > 0) {
      this.knightingQueue = this.knightingQueue.filter((id) => {
        const queuedAt = this.knightingQueueTimes.get(id) ?? nowMs
        if (nowMs - queuedAt > OfficeState.KNIGHT_QUEUE_TIMEOUT_MS) {
          this.knightingQueueTimes.delete(id)
          const stale = this.characters.get(id)
          if (stale) stale.isAwaitingKnight = false
          return false
        }
        return true
      })
    }

    const elapsed = nowMs - (ch.knightStateStartMs ?? nowMs)
    const phase = ch.knightState ?? 'home'

    // Transition once an agent is queued for knighting (interrupts wander/home dwelling).
    if ((phase === 'home' || phase === 'wander' || phase === 'returning') && this.knightingQueue.length > 0) {
      const targetId = this.knightingQueue[0]
      const target = this.characters.get(targetId)
      if (!target || target.matrixEffect === 'despawn' || !target.isAwaitingKnight) {
        // Stale entry — drop it.
        this.knightingQueue.shift()
        if (target) target.isAwaitingKnight = false
        return
      }
      const adj = this.findTileAdjacentTo(target)
      if (adj && this.knightWalkTo(ch, adj)) {
        ch.knightState = 'going'
        ch.knightStateStartMs = nowMs
        ch.knightAgentId = targetId
        return
      }
      // Couldn't reach — drop and free the agent.
      this.knightingQueue.shift()
      this.knightingQueueTimes.delete(targetId)
      target.isAwaitingKnight = false
      return
    }

    if (phase === 'home') {
      // Stand at the post for KNIGHT_HOME_DWELL_MS, then maybe wander.
      if (elapsed >= OfficeState.KNIGHT_HOME_DWELL_MS) {
        const wander = this.pickKnightWanderTile()
        if (wander && this.knightWalkTo(ch, wander)) {
          ch.knightState = 'wander'
          ch.knightStateStartMs = nowMs
        } else {
          ch.knightStateStartMs = nowMs // try again later
        }
      }
      return
    }

    if (phase === 'wander') {
      // While walking, just wait. After arrival (state IDLE) dwell briefly, then return home.
      if (ch.state === CharacterState.IDLE) {
        if (elapsed >= OfficeState.KNIGHT_WANDER_DWELL_MS + 300) {
          const home = { col: OfficeState.KNIGHT_HOME_COL, row: OfficeState.KNIGHT_HOME_ROW }
          if (this.knightWalkTo(ch, home)) {
            ch.knightState = 'returning'
            ch.knightStateStartMs = nowMs
          }
        }
      }
      return
    }

    if (phase === 'returning') {
      if (ch.state === CharacterState.IDLE && ch.tileCol === OfficeState.KNIGHT_HOME_COL && ch.tileRow === OfficeState.KNIGHT_HOME_ROW) {
        ch.dir = Direction.DOWN
        ch.knightState = 'home'
        ch.knightStateStartMs = nowMs
      }
      return
    }

    if (phase === 'going') {
      const target = ch.knightAgentId !== null && ch.knightAgentId !== undefined
        ? this.characters.get(ch.knightAgentId) ?? null
        : null
      if (!target || target.matrixEffect === 'despawn') {
        if (target) target.isAwaitingKnight = false
        if (ch.knightAgentId !== null && ch.knightAgentId !== undefined) {
          const idx = this.knightingQueue.indexOf(ch.knightAgentId)
          if (idx >= 0) this.knightingQueue.splice(idx, 1)
          this.knightingQueueTimes.delete(ch.knightAgentId)
        }
        ch.knightAgentId = null
        ch.knightState = 'returning'
        ch.knightStateStartMs = nowMs
        const home = { col: OfficeState.KNIGHT_HOME_COL, row: OfficeState.KNIGHT_HOME_ROW }
        this.knightWalkTo(ch, home)
        return
      }
      // If the knight is right next to the agent, start ceremony immediately even if mid-walk.
      const adjacent =
        Math.abs(target.tileCol - ch.tileCol) + Math.abs(target.tileRow - ch.tileRow) === 1
      if (adjacent) {
        if (target.tileCol > ch.tileCol) ch.dir = Direction.RIGHT
        else if (target.tileCol < ch.tileCol) ch.dir = Direction.LEFT
        else if (target.tileRow > ch.tileRow) ch.dir = Direction.DOWN
        else ch.dir = Direction.UP
        ch.path = []
        ch.knightState = 'ceremony'
        ch.knightStateStartMs = nowMs
        target.isAwaitingKnight = false
        const idx = this.knightingQueue.indexOf(target.id)
        if (idx >= 0) this.knightingQueue.splice(idx, 1)
        this.knightingQueueTimes.delete(target.id)
        return
      }
      // Re-path if the agent has moved away from the destination we were heading toward
      // (or if our path has finished without reaching them).
      const arrived = ch.state === CharacterState.IDLE
      const lastTile = ch.path.length > 0 ? ch.path[ch.path.length - 1] : null
      const targetAdjMoved = lastTile
        ? Math.abs(target.tileCol - lastTile.col) + Math.abs(target.tileRow - lastTile.row) > 1
        : true
      if (arrived || targetAdjMoved) {
        const adj = this.findTileAdjacentTo(target)
        if (!adj || !this.knightWalkTo(ch, adj)) {
          // Can't reach — give up on this agent.
          target.isAwaitingKnight = false
          ch.knightAgentId = null
          ch.knightState = 'returning'
          ch.knightStateStartMs = nowMs
          const home = { col: OfficeState.KNIGHT_HOME_COL, row: OfficeState.KNIGHT_HOME_ROW }
          this.knightWalkTo(ch, home)
        }
      }
      return
    }

    if (phase === 'ceremony') {
      const target = ch.knightAgentId !== null && ch.knightAgentId !== undefined
        ? this.characters.get(ch.knightAgentId) ?? null
        : null
      if (!target) {
        ch.knightState = 'returning'
        ch.knightStateStartMs = nowMs
        ch.knightAgentId = null
        return
      }
      if (elapsed >= OfficeState.KNIGHT_CEREMONY_MS) {
        target.isBeingKnighted = false
        ch.knightAgentId = null
        const home = { col: OfficeState.KNIGHT_HOME_COL, row: OfficeState.KNIGHT_HOME_ROW }
        if (this.knightWalkTo(ch, home)) {
          ch.knightState = 'returning'
        } else {
          ch.knightState = 'home'
        }
        ch.knightStateStartMs = nowMs
      }
      return
    }
  }

  /** True if there is at least one OTHER inactive non-greeter agent. Used to decide whether to keep playing. */
  private hasIdlePartner(ch: Character): boolean {
    for (const other of this.characters.values()) {
      if (other.id === ch.id) continue
      if (other.isGreeter) continue
      if (!other.isActive) return true
    }
    return false
  }

  update(dt: number): void {
    const now = performance.now() / 1000
    const nowMs = performance.now()

    // Drain spawn queue: when the pad is free and entries are pending, materialize the next.
    while (this.spawnQueue.length > 0 && nowMs >= this.spawnInProgressUntil) {
      const next = this.spawnQueue.shift()!
      this.materializeAgent(next)
      this.spawnInProgressUntil = nowMs + OfficeState.SPAWN_INTERVAL_MS
    }

    this.checkDespawnTimers(nowMs)
    this.tickDeskAnimations(nowMs)
    this.updatePingPongMatch(nowMs)
    this.tickAnimals(dt, nowMs)
    this.tickCampfire(dt, nowMs)
    this.tickWizard(dt, nowMs)

    const toDelete: number[] = []
    for (const ch of this.characters.values()) {
      // Handle matrix effect animation
      if (ch.matrixEffect) {
        ch.matrixEffectTimer += dt
        if (ch.matrixEffectTimer >= MATRIX_EFFECT_DURATION) {
          if (ch.matrixEffect === 'spawn') {
            // Spawn complete — clear matrix overlay.
            ch.matrixEffect = null
            ch.matrixEffectTimer = 0
            ch.matrixEffectSeeds = []
            // If this was an agent spawn (SPAWNING state), kick off the spin animation.
            if (ch.state === CharacterState.SPAWNING && !ch.isGreeter) {
              ch.spinTimer = 0
              ch.dir = Direction.DOWN
              ch.frame = 0
              ch.frameTimer = 0
            }
          } else {
            // Despawn complete — mark for deletion
            toDelete.push(ch.id)
          }
        }
        continue // skip normal FSM while effect is active
      }

      // Greeter NPCs (gold right, green left): skip all wandering/trip/seat logic.
      // Lean toward a hugging partner if one is in the matching hug stage; otherwise return home.
      if (ch.isGreeter) {
        const isGold = ch.greeterVariant !== 'green'
        const homeCol = isGold ? OfficeState.GREETER_COL : OfficeState.GREETER2_COL
        const homeX = homeCol * TILE_SIZE + TILE_SIZE / 2

        // Match a SPAWNING agent to this greeter only when the agent is in this greeter's hug stage:
        //   stage 1 = gold (right), stage 2 = green (left).
        const myStage = isGold ? 1 : 2
        let hugPartner: Character | null = null
        for (const other of this.characters.values()) {
          if (other.id === ch.id) continue
          if (
            other.state === CharacterState.SPAWNING &&
            other.spinTimer !== null &&
            other.spinTimer < 0 &&
            other.hugStage === myStage
          ) {
            hugPartner = other
            break
          }
        }

        if (hugPartner) {
          // Face the pad and lean 6px toward the partner so sprites contact.
          if (isGold) {
            ch.dir = Direction.LEFT
            ch.x = homeX - 6
          } else {
            ch.dir = Direction.RIGHT
            ch.x = homeX + 6
          }
        } else {
          ch.x = homeX
          ch.dir = isGold ? Direction.LEFT : Direction.RIGHT
        }
        updateCharacter(ch, dt, this.walkableTiles, this.seats, this.tileMap, this.blockedTiles)
        continue
      }

      // Knight NPC: own FSM (home / wander / going / ceremony / returning). Uses the same
      // pathfinding + walk machinery as agents but with its own driving logic.
      if (ch.isKnight) {
        this.tickKnight(ch, dt, nowMs)
        continue
      }

      // Wizard NPC: just stands behind the desk. Pose/cast visuals are render-only.
      if (ch.isWizard) {
        ch.dir = Direction.DOWN
        updateCharacter(ch, dt, this.walkableTiles, this.seats, this.tileMap, this.blockedTiles)
        continue
      }

      // SPAWNING agents: pin position based on hug stage, then tick state machine.
      if (ch.state === CharacterState.SPAWNING) {
        const padX = OfficeState.PAD_COL * TILE_SIZE + TILE_SIZE / 2
        const padY = OfficeState.PAD_ROW * TILE_SIZE + TILE_SIZE / 2
        if (ch.spinTimer !== null && ch.spinTimer < 0) {
          // Hug phase: lunge against the matching greeter (sprites overlap by 10px).
          if (ch.hugStage === 2) {
            const greenX = OfficeState.GREETER2_COL * TILE_SIZE + TILE_SIZE / 2
            ch.x = greenX + 10
          } else {
            const goldX = OfficeState.GREETER_COL * TILE_SIZE + TILE_SIZE / 2
            ch.x = goldX - 10
          }
          ch.y = padY
        } else if (ch.spinTimer !== null && ch.spinTimer >= 0) {
          // Spin phase: hold on the pad.
          ch.x = padX
          ch.y = padY
        }
        updateCharacter(ch, dt, this.walkableTiles, this.seats, this.tileMap, this.blockedTiles)
        // When SPAWNING completes, snap back to pad tile so pathfinding starts cleanly.
        if (ch.state !== CharacterState.SPAWNING) {
          ch.x = padX
          ch.y = padY
          ch.tileCol = OfficeState.PAD_COL
          ch.tileRow = OfficeState.PAD_ROW
        }
        continue
      }

      // Field-trip transitions: idle → beanbag, reading → bookshelf, thinking → pacing, else → home
      const desired = this.desiredTripFor(ch, now)
      if (desired !== ch.tripMode) {
        if (desired === null) {
          this.endTrip(ch)
        } else {
          if (ch.tripTile) {
            this.occupiedTripTiles.delete(`${ch.tripTile.col},${ch.tripTile.row}`)
            ch.tripTile = null
            ch.tripMode = null
          }
          this.startTrip(ch, desired)
        }
      }

      // Planting: tick down once arrived at the planting tile. When the timer reaches 0,
      // commit a flower at that tile, free the claim, and end the trip so desiredTripFor
      // routes the agent on to their normal idle activity.
      if (
        ch.tripMode === 'planting' &&
        ch.tripTile &&
        ch.tileCol === ch.tripTile.col &&
        ch.tileRow === ch.tripTile.row
      ) {
        if (ch.plantingTimer === undefined) {
          ch.plantingTimer = OfficeState.PLANTING_DURATION_MS
        }
        ch.plantingTimer -= dt * 1000
        if (ch.plantingTimer <= 0) {
          const key = `${ch.tripTile.col},${ch.tripTile.row}`
          const colors = OfficeState.PLANTABLE_FLOWER_COLORS
          const color = colors[Math.floor(Math.random() * colors.length)]
          this.plantedFlowers.set(key, color)
          this.claimedPlantTiles.delete(key)
          this.pendingPlant.delete(ch.id)
          ch.plantingTimer = undefined
          this.endTrip(ch)
        }
      }

      // Campfire wood run: woodpile → carry → drop tile → grow the fire.
      if (ch.tripMode === 'campfire_wood' && ch.tripTile && ch.state !== CharacterState.WALK && ch.path.length === 0) {
        const atWoodpile = !!this.woodpileTile && ch.tileCol === this.woodpileTile.col && ch.tileRow === this.woodpileTile.row
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
        } else if (ch.carrying && this.fireTile) {
          // Arrived at the drop tile — face the fire and run the drop timer.
          ch.dir = this.facingTowardTile(ch, this.fireTile)
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

      // Pacing: when the path completes, immediately pick a new far-away library tile so
      // the agent visibly walks back and forth instead of standing in place.
      if (
        ch.tripMode === 'pacing' &&
        ch.state !== CharacterState.WALK &&
        ch.path.length === 0
      ) {
        const next = this.pickPacingTile(ch.tileCol, ch.tileRow)
        if (next) {
          const path = findPath(ch.tileCol, ch.tileRow, next.col, next.row, this.tileMap, this.blockedTiles)
          if (path.length > 0) {
            ch.path = path
            ch.moveProgress = 0
            ch.state = CharacterState.WALK
            ch.frame = 0
            ch.frameTimer = 0
            ch.tripTile = next
          }
        }
      }

      // Temporarily unblock own seat so character can pathfind to it
      this.withOwnSeatUnblocked(ch, () =>
        updateCharacter(ch, dt, this.walkableTiles, this.seats, this.tileMap, this.blockedTiles)
      )

      // Tick bubble timer for waiting bubbles
      if (ch.bubbleType === 'waiting') {
        ch.bubbleTimer -= dt
        if (ch.bubbleTimer <= 0) {
          ch.bubbleType = null
          ch.bubbleTimer = 0
        }
      }
    }
    // Remove characters that finished despawn
    for (const id of toDelete) {
      this.characters.delete(id)
    }

    // Tick floating effects; drop any that have aged out
    if (this.effects.length > 0) {
      const live: ToolEffect[] = []
      for (const fx of this.effects) {
        fx.age += dt
        if (fx.age < fx.lifetime) live.push(fx)
      }
      this.effects = live
    }
  }

  getCharacters(): Character[] {
    return Array.from(this.characters.values())
  }

  /** Get character at pixel position (for hit testing). Returns id or null. */
  getCharacterAt(worldX: number, worldY: number): number | null {
    const chars = this.getCharacters().sort((a, b) => b.y - a.y)
    for (const ch of chars) {
      // Skip characters that are despawning
      if (ch.matrixEffect === 'despawn') continue
      // Greeter NPC isn't a real agent — never selectable.
      if (ch.isGreeter) continue
      // Character sprite is 16x24, anchored bottom-center
      // Apply sitting offset to match visual position
      const sittingOffset = (ch.state === CharacterState.TYPE && !ch.stretching) ? CHARACTER_SITTING_OFFSET_PX : 0
      const anchorY = ch.y + sittingOffset
      const left = ch.x - CHARACTER_HIT_HALF_WIDTH
      const right = ch.x + CHARACTER_HIT_HALF_WIDTH
      const top = anchorY - CHARACTER_HIT_HEIGHT
      const bottom = anchorY
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return ch.id
      }
    }
    return null
  }
}

/** Map a tool name to a small floating symbol kind, or null to skip the effect. */
function toolKindForEffect(toolName: string): ToolEffect['kind'] | null {
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit'
    case 'Bash':
      return 'bash'
    case 'Read':
      return 'read'
    case 'Grep':
    case 'Glob':
    case 'WebFetch':
    case 'WebSearch':
      return 'search'
    case 'Task':
      return 'task'
    case 'Agent':
      return 'task'
    default:
      return 'spark'
  }
}

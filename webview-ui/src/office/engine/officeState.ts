import { TILE_SIZE, MATRIX_EFFECT_DURATION, CharacterState, Direction } from '../types.js'
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

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout()
    this.tileMap = layoutToTileMap(this.layout)
    this.seats = layoutToSeats(this.layout.furniture)
    this.blockedTiles = getBlockedTiles(this.layout.furniture)
    this.furniture = layoutToFurnitureInstances(this.layout.furniture)
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles)
    this.ensureGreeter()
  }

  /** Sentinel ids for the two persistent greeter NPCs. Far below subagent IDs (which start at -1 and decrement). */
  private static readonly GREETER_ID = -1000000     // gold/right
  private static readonly GREETER2_ID = -1000001    // green/left
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
  }

  /** Rebuild all derived state from a new layout. Reassigns existing characters.
   *  @param shift Optional pixel shift to apply when grid expands left/up */
  rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }): void {
    this.layout = layout
    this.tileMap = layoutToTileMap(layout)
    this.seats = layoutToSeats(layout.furniture)
    this.blockedTiles = getBlockedTiles(layout.furniture)
    this.rebuildFurnitureInstances()
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles)

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
      if (ch.isGreeter) continue // greeter never sits
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
      if (ch.isGreeter) continue
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
      if (ch.isGreeter) continue // greeter has fixed position
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
      if (!seat.assigned) return uid
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
      if (ch.isGreeter) continue
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
      const seat = this.seats.get(preferredSeatId)!
      if (!seat.assigned) {
        seat.assigned = true
        reservedSeatId = preferredSeatId
      }
    }
    if (!reservedSeatId) {
      const free = this.findFreeSeat()
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
      const free = this.findFreeSeat()
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

  setAgentActive(id: number, active: boolean): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.isActive = active
      if (!active) {
        // Sentinel -1: signals turn just ended, skip next seat rest timer.
        // Prevents the WALK handler from setting a 2-4 min rest on arrival.
        ch.seatTimer = -1
        ch.path = []
        ch.moveProgress = 0
      }
      this.rebuildFurnitureInstances()
    }
  }

  /** Tiles holding a PC whose seated agent is actively working — used by the
   *  renderer to paint an animated screen-glow over the monitor. */
  getActivePCTiles(): Array<{ col: number; row: number; agentId: number }> {
    const result: Array<{ col: number; row: number; agentId: number }> = []
    for (const ch of this.characters.values()) {
      if (!ch.isActive || !ch.seatId) continue
      const seat = this.seats.get(ch.seatId)
      if (!seat) continue
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

    if (autoOnTiles.size === 0) {
      this.furniture = layoutToFurnitureInstances(this.layout.furniture)
      return
    }

    // Build modified furniture list with auto-state applied
    const modifiedFurniture: PlacedFurniture[] = this.layout.furniture.map((item) => {
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

    this.furniture = layoutToFurnitureInstances(modifiedFurniture)
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
      if (type === 'beanbag' && f.type === 'beanbag') {
        // Beanbag is 1×1, character sits on it directly.
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

  /** The two ping-pong player tiles, flanking the lounge ping-pong table at cols 9-11, row 28. */
  private static readonly PING_PONG_SLOTS: Array<{ col: number; row: number }> = [
    { col: 8, row: 28 },   // LEFT player (faces RIGHT toward the table)
    { col: 12, row: 28 },  // RIGHT player (faces LEFT toward the table)
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

  /** Begin walking the agent toward a trip target. Returns true if a path was found. */
  private startTrip(ch: Character, type: 'beanbag' | 'bookshelf' | 'pacing' | 'ping_pong'): boolean {
    let target: { col: number; row: number } | null
    if (type === 'pacing') {
      target = this.pickPacingTile(ch.tileCol, ch.tileRow)
    } else if (type === 'ping_pong') {
      target = this.findFreePingPongSlot(ch)
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
    if (ch.originalSeatId === null) {
      ch.originalSeatId = ch.seatId
    }
    ch.seatId = null  // tells WALK→arrive logic to "sit in place"
    ch.tripMode = type
    ch.tripTile = target
    // Pacing tiles aren't reserved — multiple pacers share the library aisle freely.
    if (type !== 'pacing') {
      this.occupiedTripTiles.add(`${target.col},${target.row}`)
    }
    ch.path = path
    ch.moveProgress = 0
    ch.state = CharacterState.WALK
    ch.frame = 0
    ch.frameTimer = 0
    return true
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

  /** Determine what trip (if any) the agent should currently be on. */
  private desiredTripFor(ch: Character, _now: number): 'beanbag' | 'bookshelf' | 'pacing' | 'ping_pong' | null {
    if (!ch.isActive) {
      // Already at a ping-pong slot? Stay there as long as a partner exists, otherwise drift away.
      if (ch.tripMode === 'ping_pong') {
        return this.hasIdlePartner(ch) ? 'ping_pong' : 'beanbag'
      }
      // Prefer ping-pong if a partner is already idle (or playing); otherwise beanbag.
      if (this.canStartPingPong(ch)) return 'ping_pong'
      return 'beanbag'
    }
    if (ch.lastNoToolTime === null && isReadingTool(ch.currentTool)) return 'bookshelf'
    return null  // No pacing — compact layout has no inter-pod aisles
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

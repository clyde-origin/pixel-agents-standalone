import { CharacterState, Direction, TILE_SIZE, TileType } from '../types.js'
import type { Character, Seat, SpriteData, TileType as TileTypeVal } from '../types.js'

/** Probability that an idle wander step will target a lounge tile (FLOOR_2) when any exist. */
const LOUNGE_BIAS_PROBABILITY = 0.75
import type { CharacterSprites } from '../sprites/spriteData.js'
import {
  getGreeterSprite,
  GREETER_PALETTE,
  GREETER2_PALETTE,
  KNIGHT_DOWN_SPRITE,
  KNIGHT_UP_SPRITE,
  KNIGHT_LEFT_SPRITE,
  KNIGHT_RIGHT_SPRITE,
  KNIGHT_CEREMONY_SPRITE,
} from '../sprites/spriteData.js'
import { findPath } from '../layout/tileMap.js'
import {
  WALK_SPEED_PX_PER_SEC,
  WALK_FRAME_DURATION_SEC,
  TYPE_FRAME_DURATION_SEC,
  TYPE_FRAME_DURATION_MIN_SEC,
  WANDER_PAUSE_MIN_SEC,
  WANDER_PAUSE_MAX_SEC,
  WANDER_MOVES_BEFORE_REST_MIN,
  WANDER_MOVES_BEFORE_REST_MAX,
  SEAT_REST_MIN_SEC,
  SEAT_REST_MAX_SEC,
  INTENSITY_DECAY_PER_SEC,
  STRETCH_INTERVAL_MIN_SEC,
  STRETCH_INTERVAL_MAX_SEC,
  STRETCH_DURATION_SEC,
} from '../../constants.js'

/** Tools that show reading animation instead of typing */
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])

export function isReadingTool(tool: string | null): boolean {
  if (!tool) return false
  return READING_TOOLS.has(tool)
}

/** Pixel center of a tile */
function tileCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
  }
}

/** Direction from one tile to an adjacent tile */
function directionBetween(fromCol: number, fromRow: number, toCol: number, toRow: number): Direction {
  const dc = toCol - fromCol
  const dr = toRow - fromRow
  if (dc > 0) return Direction.RIGHT
  if (dc < 0) return Direction.LEFT
  if (dr > 0) return Direction.DOWN
  return Direction.UP
}

export function createCharacter(
  id: number,
  palette: number,
  seatId: string | null,
  seat: Seat | null,
  hueShift = 0,
): Character {
  const col = seat ? seat.seatCol : 1
  const row = seat ? seat.seatRow : 1
  const center = tileCenter(col, row)
  return {
    id,
    state: CharacterState.TYPE,
    dir: seat ? seat.facingDir : Direction.DOWN,
    x: center.x,
    y: center.y,
    tileCol: col,
    tileRow: row,
    path: [],
    moveProgress: 0,
    currentTool: null,
    palette,
    hueShift,
    frame: 0,
    frameTimer: 0,
    wanderTimer: 0,
    wanderCount: 0,
    wanderLimit: randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX),
    isActive: true,
    seatId,
    bubbleType: null,
    bubbleTimer: 0,
    seatTimer: 0,
    isSubagent: false,
    parentAgentId: null,
    matrixEffect: null,
    matrixEffectTimer: 0,
    matrixEffectSeeds: [],
    intensity: 0,
    stretchTimer: randomRange(STRETCH_INTERVAL_MIN_SEC, STRETCH_INTERVAL_MAX_SEC),
    stretching: false,
    stretchRemaining: 0,
    tripMode: null,
    tripTile: null,
    originalSeatId: null,
    lastNoToolTime: null,
    spinTimer: null,
  }
}

export function updateCharacter(
  ch: Character,
  dt: number,
  walkableTiles: Array<{ col: number; row: number }>,
  seats: Map<string, Seat>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): void {
  ch.frameTimer += dt

  // Greeter NPC: never wanders, never sits, never walks. Static idle pose.
  // High-five bubble is driven externally by OfficeState.update() (mirrors the partner's timer).
  if (ch.isGreeter) {
    ch.frame = 0
    if (ch.bubbleType === 'highfive' && ch.bubbleTimer <= 0) {
      ch.bubbleType = null
      ch.bubbleTimer = 0
      ch.dir = Direction.LEFT
    }
    return
  }

  // Wizard NPC: static behind the desk, always facing the line. Never wanders/sits/walks.
  if (ch.isWizard) {
    ch.dir = Direction.DOWN
    ch.frame = 0
    return
  }

  // Decay intensity globally — applies in all states so it leaks back to 0.
  if (ch.intensity > 0) {
    ch.intensity = Math.max(0, ch.intensity - INTENSITY_DECAY_PER_SEC * dt)
  }

  switch (ch.state) {
    case CharacterState.TYPE: {
      // Tick stretch gesture: brief stand-up while active to sell "still working"
      if (ch.isActive) {
        if (ch.stretching) {
          ch.stretchRemaining -= dt
          if (ch.stretchRemaining <= 0) {
            ch.stretching = false
            ch.stretchTimer = randomRange(STRETCH_INTERVAL_MIN_SEC, STRETCH_INTERVAL_MAX_SEC)
            ch.frame = 0
            ch.frameTimer = 0
          }
          break
        }
        ch.stretchTimer -= dt
        if (ch.stretchTimer <= 0) {
          ch.stretching = true
          ch.stretchRemaining = STRETCH_DURATION_SEC
          ch.frame = 0
          ch.frameTimer = 0
          break
        }
      }
      // Frame swap, sped up by intensity
      const frameDur = TYPE_FRAME_DURATION_SEC -
        ch.intensity * (TYPE_FRAME_DURATION_SEC - TYPE_FRAME_DURATION_MIN_SEC)
      if (ch.frameTimer >= frameDur) {
        ch.frameTimer -= frameDur
        ch.frame = (ch.frame + 1) % 2
      }
      // If no longer active, stand up and start wandering (after seatTimer expires).
      // Exception: if we're parked on a beanbag (idle trip), stay seated — the trip
      // system in OfficeState is in charge of when to get up.
      if (!ch.isActive) {
        if (ch.tripMode === 'beanbag') {
          break
        }
        if (ch.seatTimer > 0) {
          ch.seatTimer -= dt
          break
        }
        ch.seatTimer = 0 // clear sentinel
        ch.state = CharacterState.IDLE
        ch.frame = 0
        ch.frameTimer = 0
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC)
        ch.wanderCount = 0
        ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX)
      }
      break
    }

    case CharacterState.IDLE: {
      // No idle animation — static pose
      ch.frame = 0
      if (ch.seatTimer < 0) ch.seatTimer = 0 // clear turn-end sentinel
      // If became active, pathfind to seat
      if (ch.isActive) {
        if (!ch.seatId) {
          // No seat assigned — type in place
          ch.state = CharacterState.TYPE
          ch.frame = 0
          ch.frameTimer = 0
          break
        }
        const seat = seats.get(ch.seatId)
        if (seat) {
          const path = findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blockedTiles)
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
          }
        } else {
          // Seat was removed — type in place rather than staying IDLE forever
          ch.state = CharacterState.TYPE
          ch.frame = 0
          ch.frameTimer = 0
        }
        break
      }
      // Ping-pong / chess: stay parked at the slot, facing the table — the trip system
      // is in charge of when to leave (e.g., partner left, agent became active).
      if (
        (ch.tripMode === 'ping_pong' || ch.tripMode === 'chess') &&
        ch.tripTile &&
        ch.tileCol === ch.tripTile.col &&
        ch.tileRow === ch.tripTile.row
      ) {
        // Ping-pong: tileCol 12 = LEFT player → RIGHT facing; 16 = RIGHT player → LEFT facing
        // Chess:     tileCol 3  = LEFT chair → RIGHT facing; 5  = RIGHT chair → LEFT facing
        if (ch.tripMode === 'ping_pong') {
          ch.dir = ch.tileCol === 12 ? Direction.RIGHT : Direction.LEFT
        } else {
          ch.dir = ch.tileCol === 3 ? Direction.RIGHT : Direction.LEFT
        }
        break
      }
      // Countdown wander timer
      ch.wanderTimer -= dt
      if (ch.wanderTimer <= 0) {
        // Check if we've wandered enough — return to seat for a rest
        if (ch.wanderCount >= ch.wanderLimit && ch.seatId) {
          const seat = seats.get(ch.seatId)
          if (seat) {
            const path = findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blockedTiles)
            if (path.length > 0) {
              ch.path = path
              ch.moveProgress = 0
              ch.state = CharacterState.WALK
              ch.frame = 0
              ch.frameTimer = 0
              break
            }
          }
        }
        if (walkableTiles.length > 0) {
          // Prefer lounge tiles (FLOOR_2) so idle agents congregate in the chillout room.
          // Fall back to any walkable tile if no lounge tiles exist or the dice rolls otherwise.
          let candidates = walkableTiles
          if (Math.random() < LOUNGE_BIAS_PROBABILITY) {
            const lounge = walkableTiles.filter(
              (t) => tileMap[t.row]?.[t.col] === TileType.FLOOR_2,
            )
            if (lounge.length > 0) candidates = lounge
          }
          const target = candidates[Math.floor(Math.random() * candidates.length)]
          const path = findPath(ch.tileCol, ch.tileRow, target.col, target.row, tileMap, blockedTiles)
          if (path.length > 0) {
            ch.path = path
            ch.moveProgress = 0
            ch.state = CharacterState.WALK
            ch.frame = 0
            ch.frameTimer = 0
            ch.wanderCount++
          }
        }
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC)
      }
      break
    }

    case CharacterState.WALK: {
      // Walk animation
      if (ch.frameTimer >= WALK_FRAME_DURATION_SEC) {
        ch.frameTimer -= WALK_FRAME_DURATION_SEC
        ch.frame = (ch.frame + 1) % 4
      }

      if (ch.path.length === 0) {
        // Path complete — snap to tile center and transition
        const center = tileCenter(ch.tileCol, ch.tileRow)
        ch.x = center.x
        ch.y = center.y

        if (ch.isActive) {
          if (!ch.seatId) {
            // No seat — type in place
            ch.state = CharacterState.TYPE
          } else {
            const seat = seats.get(ch.seatId)
            if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
              ch.state = CharacterState.TYPE
              ch.dir = seat.facingDir
            } else {
              ch.state = CharacterState.IDLE
            }
          }
        } else {
          // Check if arrived at assigned seat — sit down for a rest before wandering again
          if (ch.seatId) {
            const seat = seats.get(ch.seatId)
            if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
              ch.state = CharacterState.TYPE
              ch.dir = seat.facingDir
              // seatTimer < 0 is a sentinel from setAgentActive(false) meaning
              // "turn just ended" — skip the long rest so idle transition is immediate
              if (ch.seatTimer < 0) {
                ch.seatTimer = 0
              } else {
                ch.seatTimer = randomRange(SEAT_REST_MIN_SEC, SEAT_REST_MAX_SEC)
              }
              ch.wanderCount = 0
              ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX)
              ch.frame = 0
              ch.frameTimer = 0
              break
            }
          }
          // Ping-pong / chess arrival: face toward the table center across from us.
          if (
            (ch.tripMode === 'ping_pong' || ch.tripMode === 'chess') &&
            ch.tripTile &&
            ch.tileCol === ch.tripTile.col &&
            ch.tileRow === ch.tripTile.row
          ) {
            if (ch.tripMode === 'ping_pong') {
              ch.dir = ch.tileCol === 12 ? Direction.RIGHT : Direction.LEFT
            } else {
              ch.dir = ch.tileCol === 2 ? Direction.RIGHT : Direction.LEFT
            }
          }
          ch.state = CharacterState.IDLE
          ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC)
        }
        ch.frame = 0
        ch.frameTimer = 0
        break
      }

      // Move toward next tile in path
      const nextTile = ch.path[0]
      ch.dir = directionBetween(ch.tileCol, ch.tileRow, nextTile.col, nextTile.row)

      ch.moveProgress += (WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt

      const fromCenter = tileCenter(ch.tileCol, ch.tileRow)
      const toCenter = tileCenter(nextTile.col, nextTile.row)
      const t = Math.min(ch.moveProgress, 1)
      ch.x = fromCenter.x + (toCenter.x - fromCenter.x) * t
      ch.y = fromCenter.y + (toCenter.y - fromCenter.y) * t

      if (ch.moveProgress >= 1) {
        // Arrived at next tile
        ch.tileCol = nextTile.col
        ch.tileRow = nextTile.row
        ch.x = toCenter.x
        ch.y = toCenter.y
        ch.path.shift()
        ch.moveProgress = 0
      }

      // If became active while wandering, repath to seat
      if (ch.isActive && ch.seatId) {
        const seat = seats.get(ch.seatId)
        if (seat) {
          const lastStep = ch.path[ch.path.length - 1]
          if (!lastStep || lastStep.col !== seat.seatCol || lastStep.row !== seat.seatRow) {
            const newPath = findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blockedTiles)
            if (newPath.length > 0) {
              ch.path = newPath
              ch.moveProgress = 0
            }
          }
        }
      }
      break
    }

    case CharacterState.SPAWNING: {
      // Spawn arrival sequence: spin (0..600ms positive) → highfive (0..-500ms negative) → IDLE.
      if (ch.spinTimer === null) {
        // Defensive: should not happen; transition out.
        ch.state = CharacterState.IDLE
        ch.frame = 0
        ch.frameTimer = 0
        break
      }
      const HUG_DURATION_MS = 1200
      if (ch.spinTimer >= 0) {
        // Spin phase: cycle DOWN → RIGHT → UP → LEFT every 150ms over 600ms total.
        const SPIN_DURATION_MS = 600
        const SPIN_FRAME_MS = 150
        const phase = Math.floor(ch.spinTimer / SPIN_FRAME_MS) % 4
        const dirs = [Direction.DOWN, Direction.RIGHT, Direction.UP, Direction.LEFT]
        ch.dir = dirs[phase]
        ch.spinTimer += dt * 1000
        if (ch.spinTimer >= SPIN_DURATION_MS) {
          // Begin first hug: gold goddess on the right (col 11). Face RIGHT.
          ch.spinTimer = -HUG_DURATION_MS
          ch.dir = Direction.RIGHT
          ch.hugStage = 1
        }
      } else {
        // Hug phase. Position is set externally (in OfficeState.update). Stage determines facing
        // and which greeter we're lunging into.
        ch.spinTimer += dt * 1000
        ch.dir = ch.hugStage === 2 ? Direction.LEFT : Direction.RIGHT
        if (ch.spinTimer >= 0) {
          if (ch.hugStage === 1) {
            // First hug done — start second hug (green goddess on the left, col 7).
            ch.spinTimer = -HUG_DURATION_MS
            ch.hugStage = 2
            ch.dir = Direction.LEFT
          } else {
            // Both hugs done — clear spawn phase, transition to IDLE so pathfind kicks in.
            ch.spinTimer = null
            ch.hugStage = 0
            ch.dir = Direction.DOWN
            ch.state = CharacterState.IDLE
            ch.frame = 0
            ch.frameTimer = 0
          }
        }
      }
      break
    }
  }
}

/** Get the correct sprite frame for a character's current state and direction */
export function getCharacterSprite(ch: Character, sprites: CharacterSprites): SpriteData {
  if (ch.isKnight) {
    if (ch.knightState === 'ceremony') return KNIGHT_CEREMONY_SPRITE
    switch (ch.dir) {
      case Direction.UP: return KNIGHT_UP_SPRITE
      case Direction.LEFT: return KNIGHT_LEFT_SPRITE
      case Direction.RIGHT: return KNIGHT_RIGHT_SPRITE
      case Direction.DOWN:
      default: return KNIGHT_DOWN_SPRITE
    }
  }
  // Goddess greeter renders with a dedicated sprite set (long hair + flowing dress).
  if (ch.isGreeter) {
    const palette = ch.greeterVariant === 'green' ? GREETER2_PALETTE : GREETER_PALETTE
    return getGreeterSprite(ch.dir, palette)
  }
  switch (ch.state) {
    case CharacterState.TYPE:
      // Stretch: brief stand-up gesture while still in TYPE state
      if (ch.stretching) {
        return sprites.walk[ch.dir][1]
      }
      if (isReadingTool(ch.currentTool)) {
        return sprites.reading[ch.dir][ch.frame % 2]
      }
      return sprites.typing[ch.dir][ch.frame % 2]
    case CharacterState.WALK:
      return sprites.walk[ch.dir][ch.frame % 4]
    case CharacterState.IDLE:
      return sprites.walk[ch.dir][1]
    case CharacterState.SPAWNING:
      // Standing pose facing current direction.
      return sprites.walk[ch.dir][1]
    default:
      return sprites.walk[ch.dir][1]
  }
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}

export {
  TILE_SIZE,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_COLS,
  MAX_ROWS,
  MATRIX_EFFECT_DURATION_SEC as MATRIX_EFFECT_DURATION,
} from '../constants.js'

export const TileType = {
  WALL: 0,
  FLOOR_1: 1,
  FLOOR_2: 2,
  FLOOR_3: 3,
  FLOOR_4: 4,
  FLOOR_5: 5,
  FLOOR_6: 6,
  FLOOR_7: 7,
  VOID: 8,
} as const
export type TileType = (typeof TileType)[keyof typeof TileType]

/** Per-tile color settings for floor pattern colorization */
export interface FloorColor {
  /** Hue: 0-360 in colorize mode, -180 to +180 in adjust mode */
  h: number
  /** Saturation: 0-100 in colorize mode, -100 to +100 in adjust mode */
  s: number
  /** Brightness -100 to 100 */
  b: number
  /** Contrast -100 to 100 */
  c: number
  /** When true, use Photoshop-style Colorize (grayscale → fixed HSL). Default: adjust mode. */
  colorize?: boolean
}

export const CharacterState = {
  IDLE: 'idle',
  WALK: 'walk',
  TYPE: 'type',
  /** Newly-spawned agent doing spin / high-five at the pad before pathfinding to seat. */
  SPAWNING: 'spawning',
} as const
export type CharacterState = (typeof CharacterState)[keyof typeof CharacterState]

export const Direction = {
  DOWN: 0,
  LEFT: 1,
  RIGHT: 2,
  UP: 3,
} as const
export type Direction = (typeof Direction)[keyof typeof Direction]

/** 2D array of hex color strings (or '' for transparent). [row][col] */
export type SpriteData = string[][]

export interface Seat {
  /** Chair furniture uid */
  uid: string
  /** Tile col where agent sits */
  seatCol: number
  /** Tile row where agent sits */
  seatRow: number
  /** Direction character faces when sitting (toward adjacent desk) */
  facingDir: Direction
  assigned: boolean
}

export interface FurnitureInstance {
  sprite: SpriteData
  /** Pixel x (top-left) */
  x: number
  /** Pixel y (top-left) */
  y: number
  /** Y value used for depth sorting (typically bottom edge) */
  zY: number
  /** Station-desk groupId, if this instance belongs to a dynamically-revealed desk. */
  groupId?: string
  /** Render alpha 0..1 (default 1). Used during reveal/hide portal animation. */
  animAlpha?: number
  /** Render scale 0..1 (default 1), applied around the bottom-center of the sprite. */
  animScale?: number
}

/** A portal effect ring rendered on the floor during desk reveal/hide. */
export interface PortalRing {
  /** Center in pixel coordinates (pre-zoom, pre-pan). */
  cx: number
  cy: number
  /** Outer radius in pixels (pre-zoom). */
  radius: number
  /** 0..1 ring opacity. */
  alpha: number
}

export interface ToolActivity {
  toolId: string
  status: string
  done: boolean
  permissionWait?: boolean
}

export const FurnitureType = {
  // Original hand-drawn sprites (kept for backward compat)
  DESK: 'desk',
  BOOKSHELF: 'bookshelf',
  PLANT: 'plant',
  COOLER: 'cooler',
  WHITEBOARD: 'whiteboard',
  CHAIR: 'chair',
  PC: 'pc',
  LAMP: 'lamp',
  BEANBAG: 'beanbag',
  COFFEE_TABLE: 'coffee_table',
  PING_PONG_TABLE: 'ping_pong_table',
  CHESS_SET: 'chess_set',
  POOL_CHAIR: 'pool_chair',
  KNIGHT: 'knight',
  STUMP: 'stump',
  CAMPFIRE: 'campfire',
} as const
export type FurnitureType = (typeof FurnitureType)[keyof typeof FurnitureType]

export const EditTool = {
  TILE_PAINT: 'tile_paint',
  WALL_PAINT: 'wall_paint',
  FURNITURE_PLACE: 'furniture_place',
  FURNITURE_PICK: 'furniture_pick',
  SELECT: 'select',
  EYEDROPPER: 'eyedropper',
  ERASE: 'erase',
} as const
export type EditTool = (typeof EditTool)[keyof typeof EditTool]

export interface FurnitureCatalogEntry {
  type: string // FurnitureType enum or asset ID
  label: string
  footprintW: number
  footprintH: number
  sprite: SpriteData
  isDesk: boolean
  category?: string
  /** Orientation from rotation group: 'front' | 'back' | 'left' | 'right' */
  orientation?: string
  /** Whether this item can be placed on top of desk/table surfaces */
  canPlaceOnSurfaces?: boolean
  /** Number of tile rows from the top of the footprint that are "background" (allow placement, still block walking). Default 0. */
  backgroundTiles?: number
  /** Whether this item can be placed on wall tiles */
  canPlaceOnWalls?: boolean
}

export interface PlacedFurniture {
  uid: string
  type: string // FurnitureType enum or asset ID
  col: number
  row: number
  /** Optional color override for furniture */
  color?: FloorColor
}

export interface OfficeLayout {
  version: 1
  cols: number
  rows: number
  tiles: TileType[]
  furniture: PlacedFurniture[]
  /** Per-tile color settings, parallel to tiles array. null = wall/no color */
  tileColors?: Array<FloorColor | null>
}

export interface Character {
  id: number
  state: CharacterState
  dir: Direction
  /** Pixel position */
  x: number
  y: number
  /** Current tile column */
  tileCol: number
  /** Current tile row */
  tileRow: number
  /** Remaining path steps (tile coords) */
  path: Array<{ col: number; row: number }>
  /** 0-1 lerp between current tile and next tile */
  moveProgress: number
  /** Current tool name for typing vs reading animation, or null */
  currentTool: string | null
  /** Palette index (0-5) */
  palette: number
  /** Hue shift in degrees (0 = no shift, ≥45 for repeated palettes) */
  hueShift: number
  /** Animation frame index */
  frame: number
  /** Time accumulator for animation */
  frameTimer: number
  /** Timer for idle wander decisions */
  wanderTimer: number
  /** Number of wander moves completed in current roaming cycle */
  wanderCount: number
  /** Max wander moves before returning to seat for rest */
  wanderLimit: number
  /** Whether the agent is actively working */
  isActive: boolean
  /** Assigned seat uid, or null if no seat */
  seatId: string | null
  /** Active speech bubble type, or null if none showing */
  bubbleType: 'permission' | 'waiting' | 'highfive' | null
  /** Countdown timer for bubble (waiting: 2→0, permission: unused, highfive: ms remaining) */
  bubbleTimer: number
  /** Timer to stay seated while inactive after seat reassignment (counts down to 0) */
  seatTimer: number
  /** Whether this character represents a sub-agent (spawned by Task tool) */
  isSubagent: boolean
  /** Parent agent ID if this is a sub-agent, null otherwise */
  parentAgentId: number | null
  /** Active matrix spawn/despawn effect, or null */
  matrixEffect: 'spawn' | 'despawn' | null
  /** Timer counting up from 0 to MATRIX_EFFECT_DURATION */
  matrixEffectTimer: number
  /** Per-column random seeds (16 values) for staggered rain timing */
  matrixEffectSeeds: number[]
  /** Workspace folder name (only set for multi-root workspaces) */
  folderName?: string
  /** Cleaned label for the newest user prompt — "what this agent is working on". */
  goal?: string
  /** Live status of the current tool (e.g. "Editing officeState.ts"); cleared between tools. */
  liveStatus?: string
  /** Claude Code session id (set when the agent's transcript file is detected). */
  sessionId?: string
  /** Activity intensity 0-1 — bumped on each tool start, decays over time. Drives typing speed. */
  intensity: number
  /** Seconds until next stretch gesture while active */
  stretchTimer: number
  /** True while playing a brief stand-up gesture */
  stretching: boolean
  /** Remaining stretch duration */
  stretchRemaining: number
  /** Current "field trip" away from the home desk, or null when at desk / wandering.
   *  - 'beanbag'   — sitting on a beanbag while idle (turn ended)
   *  - 'bookshelf' — standing at a bookshelf while a Read/Grep/etc tool is running
   *  - 'pacing'    — walking back and forth in the library area while thinking
   *  - 'ping_pong' — standing at one end of the lounge ping-pong table
   *  - 'chess'     — standing at one end of the lounge chess set */
  tripMode: 'beanbag' | 'bookshelf' | 'pacing' | 'ping_pong' | 'chess' | 'pool' | 'planting' | 'campfire_wood' | 'campfire_dance' | null
  /** Tile the agent is occupying (or walking toward) for the current trip. */
  tripTile: { col: number; row: number } | null
  /** Home seat to return to when the trip ends. Saved when the trip begins. */
  originalSeatId: string | null
  /** Time (in seconds, performance.now()/1000) since the agent last had any active tool.
   *  Null while a tool is running. Used to detect long "thinking" gaps. */
  lastNoToolTime: number | null
  /** Spawn-arrival animation timer.
   *  - null              → not in spawn arrival phase
   *  - 0..600 (ms)       → spinning through 4 facing directions
   *  - -1..-500 (negative ms remaining) → high-fiving the greeter
   *  When it reaches 0 from negative, transition to IDLE so pathfind kicks in. */
  spinTimer: number | null
  /** True for the persistent greeter NPC at the pad — excluded from agent counts and most update logic. */
  isGreeter?: boolean
  /** Which greeter sprite palette ('gold' = right white-robe goddess, 'green' = left green-robe goddess). */
  greeterVariant?: 'gold' | 'green'
  /** SPAWNING agents: which hug stage. 0 = not started; 1 = hugging right (gold); 2 = hugging left (green); 3 = done. */
  hugStage?: number
  /** True for the medieval knight NPC. He wanders the violet carpet and intercepts agents
   *  who just finished working to perform a brief knighting ceremony. */
  isKnight?: boolean
  /** Knight FSM phase. */
  knightState?: 'home' | 'wander' | 'going' | 'ceremony' | 'returning'
  /** Timestamp (performance.now() ms) when the current knightState was entered. */
  knightStateStartMs?: number
  /** ID of the agent currently being walked-to / knighted (in 'going' or 'ceremony' state). */
  knightAgentId?: number | null
  /** True while an agent is queued/being targeted by the knight; pauses their trip logic. */
  isAwaitingKnight?: boolean
  /** True while an agent is actively in the knighting ceremony (knight has reached them). */
  isBeingKnighted?: boolean
  /** Milliseconds remaining in the current planting ceremony (counts down from
   *  PLANTING_DURATION_MS). Undefined when not actively planting. */
  plantingTimer?: number
  /** True once this agent has joined a campfire dance — permanent; renders shirtless+loincloth. */
  danced?: boolean
  /** True while carrying a log to the fire (campfire_wood trip, post-pickup). */
  carrying?: boolean
  /** Milliseconds remaining while dropping a log at the fire. */
  woodDropTimer?: number
}

export interface ToolEffect {
  /** Unique id for keying */
  id: number
  /** World x (px) */
  x: number
  /** World y (px) */
  y: number
  /** Symbol kind */
  kind: 'edit' | 'bash' | 'read' | 'search' | 'task' | 'permission' | 'spark'
  /** Seconds since spawn */
  age: number
  /** Total lifetime in seconds */
  lifetime: number
  /** Horizontal drift offset for variety */
  drift: number
}

export type FeedEntry =
  | { kind: 'text'; text: string; timestamp: number }
  | { kind: 'tool_start'; toolId: string; status: string; timestamp: number }
  | { kind: 'tool_done'; toolId: string; timestamp: number }
  | { kind: 'tool_perm'; toolId: string; label: string; timestamp: number }
  | { kind: 'system'; message: string; timestamp: number }

#!/usr/bin/env node
import { writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const COLS = 40
const ROWS = 44
const WALL = 0, F1 = 1, F2 = 2

const tiles = new Array(COLS * ROWS).fill(F1)
for (let c = 0; c < COLS; c++) { tiles[c] = WALL; tiles[(ROWS - 1) * COLS + c] = WALL }
for (let r = 0; r < ROWS; r++) { tiles[r * COLS] = WALL; tiles[r * COLS + (COLS - 1)] = WALL }

// Lounge floor: rows 18-end
const LOUNGE_TOP = 18
for (let r = LOUNGE_TOP; r < ROWS - 1; r++)
  for (let c = 1; c < COLS - 1; c++) tiles[r * COLS + c] = F2

const color = (h, s, b, c = 0) => ({ h, s, b, c, colorize: true })
const WORK_COLOR = color(215, 12, 4)
const LOUNGE_COLOR = color(28, 24, 0)
const WALL_COLOR = color(220, 8, -8)

const tileColors = tiles.map((t) =>
  t === WALL ? WALL_COLOR : t === F1 ? WORK_COLOR : t === F2 ? LOUNGE_COLOR : null
)

const furniture = []
const add = (uid, type, col, row) => furniture.push({ uid, type, col, row })

// 24 home desks: 3 rows of 8 (cols 2, 7, 12, 17, 22, 27, 32, 37)
const DESK_COLS = [2, 7, 12, 17, 22, 27, 32, 37]
const DESK_ROWS = [
  { chair: 2,  desk: 3,  pc: 4 },
  { chair: 6,  desk: 7,  pc: 8 },
  { chair: 10, desk: 11, pc: 12 },
]
let homeIdx = 0
for (const dr of DESK_ROWS) for (const c of DESK_COLS) {
  add(`home-${homeIdx}-chair`, 'chair', c, dr.chair)
  add(`home-${homeIdx}-desk`,  'desk',  c, dr.desk)
  add(`home-${homeIdx}-pc`,    'pc',    c, dr.pc)
  homeIdx++
}

// 6 stations at row 14
const STATIONS = [
  ['build',    4],
  ['git',      11],
  ['review',   18],
  ['research', 25],
  ['deploy',   32],
  ['docs',     36],
]
for (const [sid, c] of STATIONS) {
  add(`station-${sid}-chair`, 'chair', c, 14)
  add(`station-${sid}-desk`,  'desk',  c, 15)
  add(`station-${sid}-pc`,    'pc',    c, 16)
}

// Decor — workspace
add('dec-plant-1', 'plant', 1, 1)
add('dec-plant-2', 'plant', 38, 1)
add('dec-plant-3', 'plant', 1, 13)
add('dec-plant-4', 'plant', 38, 13)
// Whiteboards on the back wall — distribute 7 across
add('dec-wb-1', 'whiteboard', 4, 17)
add('dec-wb-2', 'whiteboard', 9, 17)
add('dec-wb-3', 'whiteboard', 14, 17)
add('dec-wb-4', 'whiteboard', 19, 17)
add('dec-wb-5', 'whiteboard', 24, 17)
add('dec-wb-6', 'whiteboard', 29, 17)
add('dec-wb-7', 'whiteboard', 34, 17)

// Lounge — bookshelves on side walls (cols 1 and 38)
for (const r of [19, 22, 25, 28, 31, 34, 37, 40]) {
  add(`lng-shelf-l-${r}`, 'bookshelf', 1, r)
  add(`lng-shelf-r-${r}`, 'bookshelf', 38, r)
}

// 8 coffee table + beanbag clusters distributed across the wider lounge
const CLUSTERS = [
  { tx: 6,  ty: 21 },
  { tx: 14, ty: 21 },
  { tx: 22, ty: 21 },
  { tx: 30, ty: 21 },
  { tx: 6,  ty: 28 },
  { tx: 14, ty: 28 },
  { tx: 22, ty: 28 },
  { tx: 30, ty: 28 },
]
for (let i = 0; i < CLUSTERS.length; i++) {
  const { tx, ty } = CLUSTERS[i]
  add(`lng-table-${i}`, 'coffee_table', tx, ty)
  add(`lng-bag-${i}-tl`, 'beanbag', tx - 1, ty - 1)
  add(`lng-bag-${i}-tr`, 'beanbag', tx + 1, ty - 1)
  add(`lng-bag-${i}-bl`, 'beanbag', tx - 1, ty + 1)
  add(`lng-bag-${i}-br`, 'beanbag', tx + 1, ty + 1)
}

// Lamps
for (const [c, r] of [
  [3, 23], [12, 23], [21, 23], [30, 23], [36, 23],
  [3, 30], [12, 30], [21, 30], [30, 30], [36, 30],
  [3, 38], [36, 38],
]) add(`lng-lamp-${c}-${r}`, 'lamp', c, r)

// Plants
add('lng-plant-edge-1', 'plant', 1, 35)
add('lng-plant-edge-2', 'plant', 38, 35)
add('lng-plant-edge-3', 'plant', 1, 41)
add('lng-plant-edge-4', 'plant', 38, 41)
add('lng-plant-mid-1', 'plant', 18, 35)
add('lng-plant-mid-2', 'plant', 22, 35)

const layout = { version: 1, cols: COLS, rows: ROWS, tiles, tileColors, furniture }

const dst = join(homedir(), '.pixel-agents', 'layout.json')
const backup = join(homedir(), '.pixel-agents', 'layout.before-portrait.json')
mkdirSync(join(homedir(), '.pixel-agents'), { recursive: true })
if (existsSync(dst) && !existsSync(backup)) copyFileSync(dst, backup)
writeFileSync(dst, JSON.stringify(layout, null, 2))
console.log(`wrote ${dst}: ${COLS}x${ROWS}, ${furniture.length} furniture pieces`)
console.log(`backup at ${backup}`)

#!/usr/bin/env node
import { writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const COLS = 20
const ROWS = 44
const WALL = 0, F1 = 1, F2 = 2

const tiles = new Array(COLS * ROWS).fill(F1)
for (let c = 0; c < COLS; c++) { tiles[c] = WALL; tiles[(ROWS - 1) * COLS + c] = WALL }
for (let r = 0; r < ROWS; r++) { tiles[r * COLS] = WALL; tiles[r * COLS + (COLS - 1)] = WALL }

// Lounge floor: rows 18-34
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

// 12 home desks: 3 rows of 4 (cols 2, 7, 12, 17)
const DESK_COLS = [2, 7, 12, 17]
const DESK_ROWS = [
  { chair: 2,  desk: 3,  pc: 4 },
  { chair: 6,  desk: 7,  pc: 8 },
  { chair: 10, desk: 11, pc: 12 },
]
let homeIdx = 0
for (const dr of DESK_ROWS) for (const c of DESK_COLS) {
  add(`home-${homeIdx}-chair-l`, 'chair', c,     dr.chair)
  add(`home-${homeIdx}-chair-r`, 'chair', c + 1, dr.chair)
  add(`home-${homeIdx}-desk`,    'desk',  c,     dr.desk)
  add(`home-${homeIdx}-pc-l`,    'pc',    c,     dr.pc)
  add(`home-${homeIdx}-pc-r`,    'pc',    c + 1, dr.pc)
  homeIdx++
}

// 3 stations at row 14
const STATIONS = [
  ['build',  4],
  ['git',    10],
  ['review', 16],
]
for (const [sid, c] of STATIONS) {
  add(`station-${sid}-chair`, 'chair', c, 14)
  add(`station-${sid}-desk`,  'desk',  c, 15)
  add(`station-${sid}-pc`,    'pc',    c, 16)
}

// Decor — workspace
add('dec-plant-1', 'plant', 1, 1)
add('dec-plant-2', 'plant', 18, 1)
add('dec-plant-3', 'plant', 1, 13)
add('dec-plant-4', 'plant', 18, 13)
add('dec-wb-1', 'whiteboard', 4, 17)
add('dec-wb-2', 'whiteboard', 9, 17)
add('dec-wb-3', 'whiteboard', 14, 17)

// Lounge — bookshelves on side walls
for (const r of [19, 22, 25, 28, 31]) {
  add(`lng-shelf-l-${r}`, 'bookshelf', 1, r)
  add(`lng-shelf-r-${r}`, 'bookshelf', 18, r)
}
// Beanbag clusters around coffee tables
add('lng-table-1', 'coffee_table', 9, 21)
for (const [c, r] of [[7, 20], [11, 20], [7, 22], [11, 22]]) add(`lng-bag-1-${c}-${r}`, 'beanbag', c, r)
add('lng-table-2', 'coffee_table', 5, 28)
for (const [c, r] of [[4, 27], [6, 27], [4, 29], [6, 29]]) add(`lng-bag-2-${c}-${r}`, 'beanbag', c, r)
add('lng-table-3', 'coffee_table', 14, 28)
for (const [c, r] of [[13, 27], [15, 27], [13, 29], [15, 29]]) add(`lng-bag-3-${c}-${r}`, 'beanbag', c, r)
add('lng-table-4', 'coffee_table', 9, 33)
for (const [c, r] of [[8, 32], [10, 32], [8, 34], [10, 34]]) add(`lng-bag-4-${c}-${r}`, 'beanbag', c, r)
// Lamps
for (const [c, r] of [[3, 23], [16, 23], [3, 30], [16, 30]]) add(`lng-lamp-${c}-${r}`, 'lamp', c, r)

// Extra lounge content for the extended portrait (rows 35-42)
add('lng-table-5', 'coffee_table', 5, 36)
for (const [c, r] of [[4, 35], [6, 35], [4, 37], [6, 37]]) add(`lng-bag-5-${c}-${r}`, 'beanbag', c, r)
add('lng-table-6', 'coffee_table', 14, 36)
for (const [c, r] of [[13, 35], [15, 35], [13, 37], [15, 37]]) add(`lng-bag-6-${c}-${r}`, 'beanbag', c, r)
add('lng-shelf-l-39', 'bookshelf', 1, 39)
add('lng-shelf-r-39', 'bookshelf', 18, 39)
add('lng-table-7', 'coffee_table', 9, 40)
for (const [c, r] of [[7, 39], [11, 39], [7, 41], [11, 41]]) add(`lng-bag-7-${c}-${r}`, 'beanbag', c, r)
for (const [c, r] of [[3, 38], [16, 38], [3, 41], [16, 41]]) add(`lng-lamp-x-${c}-${r}`, 'lamp', c, r)
add('lng-plant-1', 'plant', 1, 35)
add('lng-plant-2', 'plant', 18, 35)
add('lng-plant-3', 'plant', 1, 41)
add('lng-plant-4', 'plant', 18, 41)

const layout = { version: 1, cols: COLS, rows: ROWS, tiles, tileColors, furniture }

const dst = join(homedir(), '.pixel-agents', 'layout.json')
const backup = join(homedir(), '.pixel-agents', 'layout.before-portrait.json')
mkdirSync(join(homedir(), '.pixel-agents'), { recursive: true })
if (existsSync(dst) && !existsSync(backup)) copyFileSync(dst, backup)
writeFileSync(dst, JSON.stringify(layout, null, 2))
console.log(`wrote ${dst}: ${COLS}x${ROWS}, ${furniture.length} furniture pieces`)
console.log(`backup at ${backup}`)

#!/usr/bin/env node
import { writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const COLS = 20
const ROWS = 56  // hero (1-7) + 6 station rows × 4 (8-31) + lounge (32-55)
const WALL = 0, F1 = 1, F2 = 2

const tiles = new Array(COLS * ROWS).fill(F1)
for (let c = 0; c < COLS; c++) { tiles[c] = WALL; tiles[(ROWS - 1) * COLS + c] = WALL }
for (let r = 0; r < ROWS; r++) { tiles[r * COLS] = WALL; tiles[r * COLS + (COLS - 1)] = WALL }

// Lounge floor
const LOUNGE_TOP = 32
for (let r = LOUNGE_TOP; r < ROWS - 1; r++)
  for (let c = 1; c < COLS - 1; c++) tiles[r * COLS + c] = F2

const color = (h, s, b, c = 0) => ({ h, s, b, c, colorize: true })
const WORK_COLOR = color(215, 12, 4)
const LOUNGE_COLOR = color(28, 24, 0)
const WALL_COLOR = color(220, 8, -8)

const tileColors = tiles.map((t) =>
  t === WALL ? WALL_COLOR : t === F1 ? WORK_COLOR : t === F2 ? LOUNGE_COLOR : null
)

// Red carpet down the center aisle (cols 7-12) from below the hero desk to just above the lounge.
const RED_CARPET = color(0, 65, -8)
for (let r = 7; r < LOUNGE_TOP; r++) {
  for (let c = 7; c < 13; c++) {
    const idx = r * COLS + c
    if (tiles[idx] === F1) tileColors[idx] = RED_CARPET
  }
}

const furniture = []
const add = (uid, type, col, row) => furniture.push({ uid, type, col, row })

// Hero desk at top center: 1 chair + 1 desk (2-wide) + 1 PC.
// Anyone can use this for merging to main. Centered horizontally at cols 9-10.
const HERO_COL = 9  // desk occupies cols 9-10
add('hero-merge-chair', 'chair', HERO_COL, 4)
add('hero-merge-desk',  'desk',  HERO_COL, 5)
add('hero-merge-pc',    'pc',    HERO_COL, 6)

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }

// 12 stations arranged 2 columns × 6 rows. Each station = 3 horizontal desks
// + 6 chairs + 6 PCs. Pod row uses 3 grid rows (chair / desk top / desk bottom + PC).
// Each pod row separated by 1-row walking aisle.
const STATION_LABELS_LEFT = [
  'BUILD', 'BUILDS & TESTS', 'TEST', 'REVIEW', 'DEBUG', 'DOCS',
]
const STATION_LABELS_RIGHT = [
  'REFACTOR', 'GIT & PRS', 'SHIP', 'EXPLORE', 'DEPLOY', 'REVIEW & DOCS',
]
// Each pod row's grid rows: chair, desk-top, desk-bottom (PC sits on bottom).
// Pod 0 starts at row 8; each pod occupies 3 grid rows, +1 aisle between pods.
const POD_ROW_HEIGHT = 4 // 3 furniture rows + 1 aisle
const POD_ROWS_START = 8

function addStationPod(uidPrefix, leftCol, chairRow, deskRow, pcRow) {
  // 3 desks side-by-side starting at leftCol — desks at (leftCol, deskRow), (leftCol+2, deskRow), (leftCol+4, deskRow).
  for (const offset of [0, 2, 4]) {
    const c = leftCol + offset
    add(`${uidPrefix}-d${offset}-chair-l`, 'chair', c,     chairRow)
    add(`${uidPrefix}-d${offset}-chair-r`, 'chair', c + 1, chairRow)
    add(`${uidPrefix}-d${offset}-desk`,    'desk',  c,     deskRow)
    add(`${uidPrefix}-d${offset}-pc-l`,    'pc',    c,     pcRow)
    add(`${uidPrefix}-d${offset}-pc-r`,    'pc',    c + 1, pcRow)
  }
}

for (let podRow = 0; podRow < 6; podRow++) {
  const chairRow = POD_ROWS_START + podRow * POD_ROW_HEIGHT
  const deskRow  = chairRow + 1
  const pcRow    = chairRow + 2
  // Left column at cols 1-6, right column at cols 13-18.
  const leftLabel = STATION_LABELS_LEFT[podRow]
  const rightLabel = STATION_LABELS_RIGHT[podRow]
  addStationPod(`station-l-${podRow}-${slugify(leftLabel)}`, 1, chairRow, deskRow, pcRow)
  addStationPod(`station-r-${podRow}-${slugify(rightLabel)}`, 13, chairRow, deskRow, pcRow)
}

// Decor — workspace
// Top-corner plants (row 4) frame the hero MERGE TO MAIN desk.
add('dec-plant-1', 'plant', 1, 4)
add('dec-plant-2', 'plant', 18, 4)

// Lounge — bookshelves on side walls
for (const r of [33, 36, 39, 42, 45, 48, 51]) {
  add(`lng-shelf-l-${r}`, 'bookshelf', 1, r)
  add(`lng-shelf-r-${r}`, 'bookshelf', 18, r)
}
// Beanbag clusters around coffee tables
add('lng-table-1', 'coffee_table', 9, 34)
for (const [c, r] of [[7, 33], [11, 33], [7, 35], [11, 35]]) add(`lng-bag-1-${c}-${r}`, 'beanbag', c, r)
add('lng-table-2', 'coffee_table', 5, 38)
for (const [c, r] of [[4, 37], [6, 37], [4, 39], [6, 39]]) add(`lng-bag-2-${c}-${r}`, 'beanbag', c, r)
add('lng-table-3', 'coffee_table', 14, 38)
for (const [c, r] of [[13, 37], [15, 37], [13, 39], [15, 39]]) add(`lng-bag-3-${c}-${r}`, 'beanbag', c, r)
add('lng-table-4', 'coffee_table', 9, 42)
for (const [c, r] of [[8, 41], [10, 41], [8, 43], [10, 43]]) add(`lng-bag-4-${c}-${r}`, 'beanbag', c, r)
// Lamps
for (const [c, r] of [[3, 36], [16, 36], [3, 43], [16, 43]]) add(`lng-lamp-${c}-${r}`, 'lamp', c, r)

// Extra lounge content
add('lng-table-5', 'coffee_table', 5, 46)
for (const [c, r] of [[4, 45], [6, 45], [4, 47], [6, 47]]) add(`lng-bag-5-${c}-${r}`, 'beanbag', c, r)
add('lng-table-6', 'coffee_table', 14, 46)
for (const [c, r] of [[13, 45], [15, 45], [13, 47], [15, 47]]) add(`lng-bag-6-${c}-${r}`, 'beanbag', c, r)
add('lng-table-7', 'coffee_table', 9, 50)
for (const [c, r] of [[7, 49], [11, 49], [7, 51], [11, 51]]) add(`lng-bag-7-${c}-${r}`, 'beanbag', c, r)
for (const [c, r] of [[3, 50], [16, 50], [3, 53], [16, 53]]) add(`lng-lamp-x-${c}-${r}`, 'lamp', c, r)
add('lng-plant-1', 'plant', 1, 32)
add('lng-plant-2', 'plant', 18, 32)
add('lng-plant-3', 'plant', 1, 54)
add('lng-plant-4', 'plant', 18, 54)

const layout = { version: 1, cols: COLS, rows: ROWS, tiles, tileColors, furniture }

const dst = join(homedir(), '.pixel-agents', 'layout.json')
const backup = join(homedir(), '.pixel-agents', 'layout.before-portrait.json')
mkdirSync(join(homedir(), '.pixel-agents'), { recursive: true })
if (existsSync(dst) && !existsSync(backup)) copyFileSync(dst, backup)
writeFileSync(dst, JSON.stringify(layout, null, 2))
console.log(`wrote ${dst}: ${COLS}x${ROWS}, ${furniture.length} furniture pieces`)
console.log(`backup at ${backup}`)

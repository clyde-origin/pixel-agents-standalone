#!/usr/bin/env node
import { writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const COLS = 20
const ROWS = 36
const LOUNGE_TOP = 24
const WALL = 0, F1 = 1, F2 = 2

const tiles = new Array(COLS * ROWS).fill(F1)
for (let c = 0; c < COLS; c++) { tiles[c] = WALL; tiles[(ROWS - 1) * COLS + c] = WALL }
for (let r = 0; r < ROWS; r++) { tiles[r * COLS] = WALL; tiles[r * COLS + (COLS - 1)] = WALL }

// Lounge floor
for (let r = LOUNGE_TOP; r < ROWS - 1; r++)
  for (let c = 1; c < COLS - 1; c++) tiles[r * COLS + c] = F2

const color = (h, s, b, c = 0) => ({ h, s, b, c, colorize: true })
const WORK_COLOR = color(215, 12, 4)
const LOUNGE_COLOR = color(28, 24, 0)
const WALL_COLOR = color(220, 8, -8)

const tileColors = tiles.map((t) =>
  t === WALL ? WALL_COLOR : t === F1 ? WORK_COLOR : t === F2 ? LOUNGE_COLOR : null
)

// Deep violet center carpet (cols 8-11, 4 wide) from below the hero desk to just above the lounge.
const VIOLET_CARPET = color(270, 70, -20)
for (let r = 4; r < LOUNGE_TOP; r++) {
  for (let c = 8; c < 12; c++) {
    const idx = r * COLS + c
    if (tiles[idx] === F1) tileColors[idx] = VIOLET_CARPET
  }
}

const furniture = []
const add = (uid, type, col, row) => furniture.push({ uid, type, col, row })

// Hero MERGE TO MAIN — wide horizontal desk with 2 chairs on each side facing inward.
// Desk occupies cols 9-10, rows 3-4 (2×2). 4 chairs flanking it. 4 PCs on desk surface.
const HERO_COL = 9
add('hero-merge-desk',     'desk',  HERO_COL,     3)            // 2x2 desk at (9,3)-(10,4)
add('hero-merge-chair-l1', 'chair', HERO_COL - 1, 3)            // left side, top  → faces RIGHT (adj. desk at (9,3))
add('hero-merge-chair-l2', 'chair', HERO_COL - 1, 4)            // left side, btm  → faces RIGHT (adj. desk at (9,4))
add('hero-merge-chair-r1', 'chair', HERO_COL + 2, 3)            // right side, top → faces LEFT  (adj. desk at (10,3))
add('hero-merge-chair-r2', 'chair', HERO_COL + 2, 4)            // right side, btm → faces LEFT  (adj. desk at (10,4))
add('hero-merge-pc-tl',    'pc',    HERO_COL,     3)            // PC top-left
add('hero-merge-pc-tr',    'pc',    HERO_COL + 1, 3)            // PC top-right
add('hero-merge-pc-bl',    'pc',    HERO_COL,     4)            // PC btm-left
add('hero-merge-pc-br',    'pc',    HERO_COL + 1, 4)            // PC btm-right

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }

// 12 stations arranged 2 columns × 6 rows. Each station = 3 horizontal desks
// + 6 chairs + 6 PCs. Pod row uses 3 grid rows (chair / desk top / desk bottom + PC).
// Compact: pods stack directly with NO inter-pod aisle (9:16 fit).
const STATION_LABELS_LEFT = [
  'BUILD', 'BUILDS & TESTS', 'TEST', 'REVIEW', 'DEBUG', 'DOCS',
]
const STATION_LABELS_RIGHT = [
  'REFACTOR', 'GIT & PRS', 'SHIP', 'EXPLORE', 'DEPLOY', 'REVIEW & DOCS',
]
// Each pod row's grid rows: chair, desk-top, desk-bottom (PC sits on bottom).
// Pod 0 starts at row 6; each pod occupies 3 grid rows, no aisle between pods.
const POD_ROW_HEIGHT = 3   // 3 furniture rows, NO aisle (compact 9:16 fit)
const POD_ROWS_START = 6   // first pod row's chair (was 8)

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
// Top-corner plants frame the hero MERGE TO MAIN desk.
add('dec-plant-1', 'plant', 1, 4)
add('dec-plant-2', 'plant', 18, 4)

// Lounge — bookshelves on side walls (rows 25, 28, 31, 34 within lounge 24-35)
for (const r of [25, 28, 31, 34]) {
  add(`lng-shelf-l-${r}`, 'bookshelf', 1, r)
  add(`lng-shelf-r-${r}`, 'bookshelf', 18, r)
}
// Beanbag clusters around coffee tables (compact lounge in rows 24-35)
add('lng-table-1', 'coffee_table', 9, 26)
for (const [c, r] of [[7, 25], [11, 25], [7, 27], [11, 27]]) add(`lng-bag-1-${c}-${r}`, 'beanbag', c, r)
add('lng-table-2', 'coffee_table', 5, 30)
for (const [c, r] of [[4, 29], [6, 29], [4, 31], [6, 31]]) add(`lng-bag-2-${c}-${r}`, 'beanbag', c, r)
add('lng-table-3', 'coffee_table', 14, 30)
for (const [c, r] of [[13, 29], [15, 29], [13, 31], [15, 31]]) add(`lng-bag-3-${c}-${r}`, 'beanbag', c, r)
// Lamps
for (const [c, r] of [[3, 28], [16, 28], [3, 33], [16, 33]]) add(`lng-lamp-${c}-${r}`, 'lamp', c, r)
// Ping pong table — upper-right corner of the lounge with breathing room around it.
// Table spans cols 13-15 row 25; players stand at (12, 25) and (16, 25).
add('lng-ping-pong', 'ping_pong_table', 13, 25)
// Lounge plants at corners
add('lng-plant-1', 'plant', 1, 24)
add('lng-plant-2', 'plant', 18, 24)

const layout = { version: 1, cols: COLS, rows: ROWS, tiles, tileColors, furniture }

const dst = join(homedir(), '.pixel-agents', 'layout.json')
const backup = join(homedir(), '.pixel-agents', 'layout.before-portrait.json')
mkdirSync(join(homedir(), '.pixel-agents'), { recursive: true })
if (existsSync(dst) && !existsSync(backup)) copyFileSync(dst, backup)
writeFileSync(dst, JSON.stringify(layout, null, 2))
console.log(`wrote ${dst}: ${COLS}x${ROWS}, ${furniture.length} furniture pieces`)
console.log(`backup at ${backup}`)

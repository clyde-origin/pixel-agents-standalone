import { describe, it, expect } from 'vitest'
import {
  createWizardState,
  enqueue,
  dequeue,
} from '../wizardDesk.js'

describe('createWizardState', () => {
  it('starts idle with an empty queue', () => {
    const s = createWizardState()
    expect(s.phase).toBe('idle')
    expect(s.queue).toEqual([])
    expect(s.servingId).toBeNull()
    expect(s.casted).toBe(false)
  })
})

describe('enqueue', () => {
  it('appends ids in order and is idempotent', () => {
    const s = createWizardState()
    enqueue(s, 7)
    enqueue(s, 9)
    enqueue(s, 7) // duplicate ignored
    expect(s.queue).toEqual([7, 9])
  })
})

describe('dequeue', () => {
  it('removes an id from anywhere in the line', () => {
    const s = createWizardState()
    enqueue(s, 1); enqueue(s, 2); enqueue(s, 3)
    dequeue(s, 2)
    expect(s.queue).toEqual([1, 3])
  })
  it('clears servingId when the served head leaves', () => {
    const s = createWizardState()
    enqueue(s, 1)
    s.servingId = 1
    dequeue(s, 1)
    expect(s.queue).toEqual([])
    expect(s.servingId).toBeNull()
  })
})

import { computeLineupTiles } from '../wizardDesk.js'

describe('computeLineupTiles', () => {
  const front = { col: 10, row: 25 }
  it('walks south from the blessing spot, all walkable', () => {
    const tiles = computeLineupTiles(front, () => true, 4)
    expect(tiles).toEqual([
      { col: 10, row: 25 },
      { col: 10, row: 26 },
      { col: 10, row: 27 },
      { col: 10, row: 28 },
    ])
  })
  it('skips blocked tiles but stays in the same column', () => {
    const blocked = new Set(['10,26'])
    const tiles = computeLineupTiles(front, (c, r) => !blocked.has(`${c},${r}`), 3)
    expect(tiles).toEqual([
      { col: 10, row: 25 },
      { col: 10, row: 27 },
      { col: 10, row: 28 },
    ])
  })
  it('caps at maxLen', () => {
    expect(computeLineupTiles(front, () => true, 2)).toHaveLength(2)
  })
})

import {
  advanceWizard,
  BLESS_MS,
  CAST_REMAINING_MS,
  SAFETY_TIMEOUT_MS,
} from '../wizardDesk.js'

describe('advanceWizard', () => {
  it('does nothing on an empty queue', () => {
    const s = createWizardState()
    expect(advanceWizard(s, 16, { nowMs: 1000, headArrived: false })).toEqual([])
    expect(s.phase).toBe('idle')
  })

  it('starts blessing when the head arrives', () => {
    const s = createWizardState()
    enqueue(s, 5)
    const ev = advanceWizard(s, 16, { nowMs: 1000, headArrived: true })
    expect(ev).toContain('start_blessing')
    expect(s.phase).toBe('blessing')
    expect(s.blessTimer).toBe(BLESS_MS)
  })

  it('waits (no blessing) while the head has not arrived', () => {
    const s = createWizardState()
    enqueue(s, 5)
    const ev = advanceWizard(s, 16, { nowMs: 1000, headArrived: false })
    expect(ev).toEqual([])
    expect(s.phase).toBe('idle')
    expect(s.servingId).toBe(5)
  })

  it('fires cast_summon once, then release, popping the head', () => {
    const s = createWizardState()
    enqueue(s, 5); enqueue(s, 6)
    advanceWizard(s, 16, { nowMs: 0, headArrived: true }) // start_blessing
    // advance to just past the cast threshold
    const toCast = BLESS_MS - CAST_REMAINING_MS + 1
    const e1 = advanceWizard(s, toCast, { nowMs: toCast, headArrived: true })
    expect(e1).toContain('cast_summon')
    expect(s.casted).toBe(true)
    // a second tick before completion does NOT re-cast
    const e2 = advanceWizard(s, 10, { nowMs: toCast + 10, headArrived: true })
    expect(e2).not.toContain('cast_summon')
    // finish the blessing
    const e3 = advanceWizard(s, CAST_REMAINING_MS, { nowMs: BLESS_MS + 100, headArrived: true })
    expect(e3).toContain('release')
    expect(s.queue).toEqual([6])
    expect(s.servingId).toBeNull()
    expect(s.phase).toBe('idle')
  })

  it('evicts a head that never arrives after the safety timeout', () => {
    const s = createWizardState()
    enqueue(s, 5)
    advanceWizard(s, 16, { nowMs: 0, headArrived: false }) // servingSince = 0
    const ev = advanceWizard(s, 16, { nowMs: SAFETY_TIMEOUT_MS + 1, headArrived: false })
    expect(ev).toContain('evict')
    expect(s.queue).toEqual([])
  })
})

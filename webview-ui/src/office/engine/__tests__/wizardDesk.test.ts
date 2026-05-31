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

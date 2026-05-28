import { describe, it, expect } from 'vitest'
import {
  createCampfireState,
  resolveFireTile,
  resolveWoodpileTile,
  computeDanceSlots,
  WOOD_TO_FULL,
} from '../campfire.js'

describe('createCampfireState', () => {
  it('starts in growing phase with no wood', () => {
    const s = createCampfireState()
    expect(s.phase).toBe('growing')
    expect(s.woodLevel).toBe(0)
    expect(s.dancers).toEqual([])
  })
})

describe('resolveFireTile', () => {
  it('finds the campfire furniture tile', () => {
    const layout = { furniture: [{ uid: 'lng-campfire', type: 'campfire', col: 5, row: 30 }] }
    expect(resolveFireTile(layout as any)).toEqual({ col: 5, row: 30 })
  })
  it('returns null when there is no campfire', () => {
    expect(resolveFireTile({ furniture: [] } as any)).toBeNull()
  })
})

describe('resolveWoodpileTile', () => {
  it('returns a walkable tile a few tiles from the fire', () => {
    const fire = { col: 5, row: 30 }
    const walkable = () => true
    const wp = resolveWoodpileTile(fire, walkable)!
    expect(wp).not.toBeNull()
    const dist = Math.abs(wp.col - fire.col) + Math.abs(wp.row - fire.row)
    expect(dist).toBeGreaterThanOrEqual(2)
  })
  it('skips unwalkable tiles', () => {
    const fire = { col: 5, row: 30 }
    const walkable = (c: number, r: number) => c === 9 && r === 30
    expect(resolveWoodpileTile(fire, walkable)).toEqual({ col: 9, row: 30 })
  })
  it('returns null when nothing is walkable', () => {
    expect(resolveWoodpileTile({ col: 5, row: 30 }, () => false)).toBeNull()
  })
})

describe('computeDanceSlots', () => {
  it('returns up to 8 walkable ring tiles, excluding the 3x3 core', () => {
    const fire = { col: 5, row: 30 }
    const walkable = () => true
    const slots = computeDanceSlots(fire, walkable)
    expect(slots.length).toBeGreaterThanOrEqual(4)
    expect(slots.length).toBeLessThanOrEqual(8)
    for (const s of slots) {
      const inCore = s.col >= 4 && s.col <= 6 && s.row >= 29 && s.row <= 31
      expect(inCore).toBe(false)
    }
  })
  it('drops slots that are not walkable', () => {
    const fire = { col: 5, row: 30 }
    const walkable = (c: number, r: number) => r === 28
    const slots = computeDanceSlots(fire, walkable)
    expect(slots.length).toBe(5) // the 5 shell tiles at row 28 (cols 3..7)
    expect(slots.every((s) => s.row === 28)).toBe(true)
  })
})

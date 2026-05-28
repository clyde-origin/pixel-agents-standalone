import { describe, it, expect } from 'vitest'
import {
  createCampfireState,
  resolveFireTile,
  resolveWoodpileTile,
  computeDanceSlots,
  WOOD_TO_FULL,
  addWood,
  advanceCampfire,
  DANCE_DURATION_MS,
  BURNDOWN_DURATION_MS,
  HATCH_DELAY_MS,
  ROTATE_INTERVAL_MS,
  FULL_GRACE_MS,
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

describe('addWood', () => {
  it('increments wood and enters full at WOOD_TO_FULL', () => {
    let s = createCampfireState()
    for (let i = 0; i < WOOD_TO_FULL - 1; i++) s = addWood(s, 1000)
    expect(s.phase).toBe('growing')
    s = addWood(s, 2000)
    expect(s.woodLevel).toBe(WOOD_TO_FULL)
    expect(s.phase).toBe('full')
    expect(s.phaseStartMs).toBe(2000)
  })
  it('does not exceed full or add wood outside growing', () => {
    let s = { ...createCampfireState(), phase: 'dancing' as const, woodLevel: 3 }
    s = addWood(s, 1000)
    expect(s.woodLevel).toBe(3)
  })
})

describe('advanceCampfire', () => {
  it('full → dancing once min dancers present', () => {
    const base = { ...createCampfireState(), phase: 'full' as const, phaseStartMs: 0 }
    const { state, events } = advanceCampfire(base, 100, { nowMs: 100, dancerCount: 2 })
    expect(state.phase).toBe('dancing')
    expect(events).toContain('start_dancing')
  })
  it('full → waits when nobody is around (under grace)', () => {
    const base = { ...createCampfireState(), phase: 'full' as const, phaseStartMs: 0 }
    const { state } = advanceCampfire(base, 100, { nowMs: 1000, dancerCount: 0 })
    expect(state.phase).toBe('full')
  })
  it('full → waits with a single dancer before the grace period', () => {
    const base = { ...createCampfireState(), phase: 'full' as const, phaseStartMs: 0 }
    const { state } = advanceCampfire(base, 0, { nowMs: FULL_GRACE_MS - 1, dancerCount: 1 })
    expect(state.phase).toBe('full')
  })
  it('full → dancing with a single dancer after the grace period', () => {
    const base = { ...createCampfireState(), phase: 'full' as const, phaseStartMs: 0 }
    const { state, events } = advanceCampfire(base, 0, { nowMs: FULL_GRACE_MS + 1, dancerCount: 1 })
    expect(state.phase).toBe('dancing')
    expect(events).toContain('start_dancing')
  })
  it('dancing emits rotate on the interval', () => {
    const base = { ...createCampfireState(), phase: 'dancing' as const, phaseStartMs: 0, rotateAtMs: ROTATE_INTERVAL_MS }
    const { state, events } = advanceCampfire(base, 0, { nowMs: ROTATE_INTERVAL_MS + 1, dancerCount: 3 })
    expect(events).toContain('rotate')
    expect(state.rotateAtMs).toBeGreaterThan(ROTATE_INTERVAL_MS + 1)
  })
  it('does not rotate before the interval', () => {
    const base = { ...createCampfireState(), phase: 'dancing' as const, phaseStartMs: 0, rotateAtMs: ROTATE_INTERVAL_MS }
    const { events } = advanceCampfire(base, 0, { nowMs: ROTATE_INTERVAL_MS - 1, dancerCount: 3 })
    expect(events).not.toContain('rotate')
  })
  it('dancing → burning_down after DANCE_DURATION', () => {
    const base = { ...createCampfireState(), phase: 'dancing' as const, phaseStartMs: 0 }
    const { state, events } = advanceCampfire(base, 0, { nowMs: DANCE_DURATION_MS + 1, dancerCount: 3 })
    expect(state.phase).toBe('burning_down')
    expect(events).toContain('start_burndown')
  })
  it('burning_down → egg, egg → hatch → growing', () => {
    let s = { ...createCampfireState(), phase: 'burning_down' as const, phaseStartMs: 0, woodLevel: WOOD_TO_FULL }
    let r = advanceCampfire(s, 0, { nowMs: BURNDOWN_DURATION_MS + 1, dancerCount: 0 })
    expect(r.state.phase).toBe('egg')
    expect(r.events).toContain('lay_egg')
    s = r.state
    r = advanceCampfire(s, 0, { nowMs: r.state.phaseStartMs + HATCH_DELAY_MS + 1, dancerCount: 0 })
    expect(r.events).toContain('hatch')
    expect(r.state.phase).toBe('growing')
    expect(r.state.woodLevel).toBe(0)
  })
})

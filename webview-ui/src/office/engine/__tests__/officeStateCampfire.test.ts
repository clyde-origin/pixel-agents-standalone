import { describe, it, expect } from 'vitest'
import { OfficeState } from '../officeState.js'
import { createDefaultLayout } from '../../layout/layoutSerializer.js'

// Regression: resolveCampfireGeometry references TileType.WALL/VOID as runtime values.
// If TileType is imported type-only (erased at runtime), this throws
// "ReferenceError: TileType is not defined" the moment a layout WITH a campfire is loaded.
describe('OfficeState campfire geometry runtime safety', () => {
  it('builds a layout that contains a campfire without throwing', () => {
    const layout = createDefaultLayout()
    layout.furniture.push({ uid: 'test-campfire', type: 'campfire', col: 5, row: 5 })
    expect(() => new OfficeState(layout)).not.toThrow()
  })
})

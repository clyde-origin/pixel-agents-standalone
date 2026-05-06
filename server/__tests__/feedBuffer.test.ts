import { describe, it, expect } from 'vitest'
import { FeedBuffer } from '../feedBuffer.js'

describe('FeedBuffer', () => {
  it('keeps the last N entries', () => {
    const fb = new FeedBuffer(3)
    fb.append({ kind: 'text', text: 'a', timestamp: 1 })
    fb.append({ kind: 'text', text: 'b', timestamp: 2 })
    fb.append({ kind: 'text', text: 'c', timestamp: 3 })
    fb.append({ kind: 'text', text: 'd', timestamp: 4 })
    expect(fb.snapshot().map(e => (e as any).text)).toEqual(['b', 'c', 'd'])
  })
  it('returns latest-first via snapshot', () => {
    const fb = new FeedBuffer(5)
    fb.append({ kind: 'text', text: 'a', timestamp: 1 })
    fb.append({ kind: 'tool_start', toolId: 't1', status: 'Running: ls', timestamp: 2 })
    expect(fb.snapshot()[0].kind).toBe('text')
    expect(fb.snapshot()[1].kind).toBe('tool_start')
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { watchConfigFile } from '../configWatcher.js'

describe('watchConfigFile', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pa-watch-')) })

  it('fires onChange when the file is rewritten', async () => {
    const file = join(dir, 'cfg.json')
    writeFileSync(file, JSON.stringify({ v: 1 }))
    let latest: any = null
    const stop = watchConfigFile<{ v: number }>(file, { v: 0 }, (cfg) => { latest = cfg })
    await new Promise((r) => setTimeout(r, 100))
    writeFileSync(file, JSON.stringify({ v: 2 }))
    await new Promise((r) => setTimeout(r, 600))
    expect(latest?.v).toBe(2)
    stop()
  })
})

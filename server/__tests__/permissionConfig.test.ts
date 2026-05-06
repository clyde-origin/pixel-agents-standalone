import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadOrInitConfig } from '../permissionConfig.js'

describe('loadOrInitConfig', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-cfg-'))
  })

  it('copies the default file into the user dir if missing', () => {
    const target = join(dir, 'policy.json')
    expect(existsSync(target)).toBe(false)
    const cfg = loadOrInitConfig(target, { timeoutSec: 30, defaultOnTimeout: 'allow', listenAddress: '127.0.0.1' })
    expect(cfg.timeoutSec).toBe(30)
    expect(existsSync(target)).toBe(true)
  })

  it('reads an existing user file and ignores the default', () => {
    const target = join(dir, 'policy.json')
    writeFileSync(target, JSON.stringify({ timeoutSec: 99, defaultOnTimeout: 'deny', listenAddress: '0.0.0.0' }))
    const cfg = loadOrInitConfig(target, { timeoutSec: 30, defaultOnTimeout: 'allow', listenAddress: '127.0.0.1' })
    expect(cfg.timeoutSec).toBe(99)
    expect(cfg.defaultOnTimeout).toBe('deny')
  })

  it('falls back to the default if the user file is invalid JSON', () => {
    const target = join(dir, 'policy.json')
    writeFileSync(target, '{ not json')
    const cfg = loadOrInitConfig(target, { timeoutSec: 30, defaultOnTimeout: 'allow', listenAddress: '127.0.0.1' })
    expect(cfg.timeoutSec).toBe(30)
  })
})

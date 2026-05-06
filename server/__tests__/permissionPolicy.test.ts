import { describe, it, expect, beforeEach } from 'vitest'
import { PermissionPolicy } from '../permissionPolicy.js'
import type { RiskyPatterns } from '../permissionConfig.js'

const RISKY: RiskyPatterns = {
  Bash: [{ match: '\\bgit\\s+push\\s+(-f|--force)', label: 'Force push' }],
  filePathPatterns: [{ match: '/\\.env(\\.|$)', label: '.env' }],
  toolNamePatterns: [{ match: '^mcp__', label: 'MCP' }],
}

describe('PermissionPolicy.evaluate', () => {
  let p: PermissionPolicy
  beforeEach(() => { p = new PermissionPolicy(RISKY, new Set()) })

  it('rung 1 — readonly tools always allow', () => {
    expect(p.evaluate('s1', 'Read', { file_path: '/tmp/x' })).toEqual({ allow: true, reason: 'readonly-tool' })
    expect(p.evaluate('s1', 'Grep', {})).toEqual({ allow: true, reason: 'readonly-tool' })
    expect(p.evaluate('s1', 'WebSearch', {})).toEqual({ allow: true, reason: 'readonly-tool' })
  })

  it('rung 2 — session in watch list always fires', () => {
    p = new PermissionPolicy(RISKY, new Set(['s1']))
    expect(p.evaluate('s1', 'Bash', { command: 'ls' })).toEqual({ allow: false, label: 'Watching this session' })
    expect(p.evaluate('s2', 'Bash', { command: 'ls' })).toEqual({ allow: true, reason: 'auto-mode-default' })
  })

  it('rung 3 — session allowlist short-circuits to allow', () => {
    const richRisky: RiskyPatterns = {
      Bash: [
        { match: '\\bgit\\s+push\\s+(-f|--force)', label: 'Force push' },
        { match: '\\brm\\s+-[a-z]*r', label: 'Recursive delete' },
      ],
      filePathPatterns: [],
      toolNamePatterns: [],
    }
    p = new PermissionPolicy(richRisky, new Set())
    p.allowSession('s1', 'Bash')
    expect(p.evaluate('s1', 'Bash', { command: 'rm -rf /tmp/x' })).toEqual({ allow: true, reason: 'session-allowlist' })
    expect(p.evaluate('s2', 'Bash', { command: 'rm -rf /tmp/x' })).toEqual({ allow: false, label: 'Recursive delete' })
  })

  it('rung 4 — risky bash pattern fires modal', () => {
    expect(p.evaluate('s1', 'Bash', { command: 'git push --force' })).toEqual({ allow: false, label: 'Force push' })
    expect(p.evaluate('s1', 'Bash', { command: 'git push origin main' })).toEqual({ allow: true, reason: 'auto-mode-default' })
  })

  it('rung 4 — risky path fires modal for Edit/Write/NotebookEdit', () => {
    expect(p.evaluate('s1', 'Edit', { file_path: '/Users/x/.env' })).toEqual({ allow: false, label: '.env' })
    expect(p.evaluate('s1', 'Write', { file_path: '/Users/x/.env.local' })).toEqual({ allow: false, label: '.env' })
    expect(p.evaluate('s1', 'Edit', { file_path: '/Users/x/foo.ts' })).toEqual({ allow: true, reason: 'auto-mode-default' })
  })

  it('rung 4 — MCP tool name pattern fires modal', () => {
    expect(p.evaluate('s1', 'mcp__slack__send', {})).toEqual({ allow: false, label: 'MCP' })
  })

  it('rung 5 — non-readonly non-risky default-allows', () => {
    expect(p.evaluate('s1', 'Bash', { command: 'echo hi' })).toEqual({ allow: true, reason: 'auto-mode-default' })
  })

  it('updateConfig replaces the patterns', () => {
    p.updateConfig({ Bash: [{ match: '\\becho\\b', label: 'echo' }], filePathPatterns: [], toolNamePatterns: [] })
    expect(p.evaluate('s1', 'Bash', { command: 'echo hi' })).toEqual({ allow: false, label: 'echo' })
  })

  it('updateWatchList replaces the watch list', () => {
    p.updateWatchList(new Set(['s1']))
    expect(p.evaluate('s1', 'Bash', { command: 'ls' })).toEqual({ allow: false, label: 'Watching this session' })
  })
})

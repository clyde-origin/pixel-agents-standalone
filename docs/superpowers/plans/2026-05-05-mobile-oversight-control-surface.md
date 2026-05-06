# Pixel-Agents Mobile Oversight & Control Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn pixel-agents-standalone into a phone-first oversight surface for many concurrent Claude Code sessions: portrait office, PWA install, per-desk activity cards, per-agent live feed, gatekeeper-with-modal that only fires for risky tools, per-session "watch closely" toggle, Tailscale-friendly remote access.

**Architecture:** Smart server, dumb hook. A `PreToolUse` hook posts to `localhost:3456/permission/request`; the server runs a five-rung trigger ladder (readonly → watch list → session allowlist → risky-pattern match → fall-through allow), holds risky requests in memory, and broadcasts `agentPermissionRequest` to all browser clients. A modal driven by `~/.pixel-agents/responses.json` renders one button per response template (Allow / Allow this session / per-tool presets / Custom feedback). Server keeps a 40-entry per-agent ring buffer and broadcasts feed entries; the UI shows them as a tap-to-open bottom sheet on mobile or side panel on desktop. Each desk gets a small live activity card under its monitor. Office layout regenerates to a 20×36 portrait grid; PWA assets ship for home-screen install.

**Tech Stack:** Node 22 / Express 5 / chokidar / ws / TypeScript on the server. React 19 / Vite 7 / canvas + HTML overlays on the client. Vitest for unit tests on pure-logic modules (trigger ladder, regex matching, ring buffer). Manual smoke tests for UI.

**Pre-flight (do once before Task 1):**
- Make sure you have a clean working tree on `main` of `~/pixel-agents-standalone`. Either commit / stash any in-flight changes or work in a fresh git worktree (`git worktree add -b feat/mobile-oversight ../pixel-agents-mobile main`).
- The hook script `~/.pixel-agents/hooks/permission-hook.js` already exists from the prior session — verify with `ls -la ~/.pixel-agents/hooks/permission-hook.js`. The plan rewrites it to the spec's contract.
- The `~/.pixel-agents/layout.json` may have been hand-edited; the layout regen task auto-backs it up to `layout.before-portrait.json` before overwriting.
- Confirm the spec is at `docs/superpowers/specs/2026-05-05-pixel-agents-permission-control-surface-design.md` and read it once.

---

## Phase A — Permission Foundation (Tasks 1–8)

This phase delivers the gatekeeper end-to-end: hook fires on risky tools only, modal shows preset buttons + custom feedback, decisions route back. It produces working software on its own — phases B and C add visibility and mobile polish on top.

### Task 1: Add vitest test harness

**Files:**
- Create: `pixel-agents-standalone/vitest.config.ts`
- Modify: `pixel-agents-standalone/package.json`
- Create: `pixel-agents-standalone/server/__tests__/sanity.test.ts`

- [ ] **Step 1: Install vitest as a dev dependency**

```bash
cd /Users/pawn/pixel-agents-standalone
npm install --save-dev vitest @vitest/expect
```

Expected: `vitest` and `@vitest/expect` added under `devDependencies` in `package.json`.

- [ ] **Step 2: Write the vitest config**

`pixel-agents-standalone/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
})
```

- [ ] **Step 3: Add a `test` script**

In `pixel-agents-standalone/package.json` `scripts` block:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Write a sanity test that fails first**

`pixel-agents-standalone/server/__tests__/sanity.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('vitest harness', () => {
  it('runs', () => {
    expect(2 + 2).toBe(5)  // intentionally wrong to verify the harness
  })
})
```

Run: `npm test`
Expected: FAIL — `expected 4 to be 5`.

- [ ] **Step 5: Fix the assertion**

Change `5` to `4`.

Run: `npm test`
Expected: PASS — 1 test passing.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts server/__tests__/sanity.test.ts
git commit -m "chore: add vitest harness for server unit tests"
```

---

### Task 2: Default config files + first-run loader

**Files:**
- Create: `pixel-agents-standalone/config-defaults/risky-patterns.json`
- Create: `pixel-agents-standalone/config-defaults/responses.json`
- Create: `pixel-agents-standalone/config-defaults/policy.json`
- Create: `pixel-agents-standalone/config-defaults/watch-list.json`
- Create: `pixel-agents-standalone/server/permissionConfig.ts`
- Create: `pixel-agents-standalone/server/__tests__/permissionConfig.test.ts`

- [ ] **Step 1: Write the four shipped defaults**

`pixel-agents-standalone/config-defaults/risky-patterns.json`:

```json
{
  "Bash": [
    { "match": "\\brm\\s+-[a-z]*r", "label": "Recursive delete" },
    { "match": "\\bsudo\\b", "label": "sudo" },
    { "match": "\\bchmod\\s+[0-7]*7", "label": "World-writable chmod" },
    { "match": "\\bchown\\b", "label": "chown" },
    { "match": "\\bgit\\s+push\\s+(-f|--force)", "label": "Force push" },
    { "match": "\\bgit\\s+reset\\s+--hard", "label": "git reset --hard" },
    { "match": "\\bgit\\s+clean\\s+-[a-z]*f", "label": "git clean -f" },
    { "match": "\\bgit\\s+branch\\s+-D\\b", "label": "Force-delete branch" },
    { "match": "\\b(npm|pnpm|yarn|bun)\\s+publish\\b", "label": "Package publish" },
    { "match": "\\bcurl\\b[^|]*\\|\\s*(sh|bash|zsh)", "label": "Pipe-to-shell" },
    { "match": "\\bwget\\b[^|]*\\|\\s*(sh|bash|zsh)", "label": "Pipe-to-shell" },
    { "match": "DROP\\s+(TABLE|DATABASE|SCHEMA|EXTENSION)", "label": "DROP" },
    { "match": "TRUNCATE\\s+TABLE", "label": "TRUNCATE" },
    { "match": "\\bdd\\s+if=", "label": "dd" },
    { "match": "\\bmkfs\\b", "label": "mkfs" },
    { "match": "\\bshutdown\\b", "label": "shutdown" },
    { "match": "\\breboot\\b", "label": "reboot" }
  ],
  "filePathPatterns": [
    { "match": "/\\.env(\\.|$)", "label": ".env file" },
    { "match": "/\\.ssh/", "label": "SSH keys" },
    { "match": "id_rsa\\b|id_ed25519\\b", "label": "Private key" },
    { "match": "/\\.aws/credentials", "label": "AWS credentials" },
    { "match": "^/etc/", "label": "/etc" },
    { "match": "^/System/", "label": "/System" },
    { "match": "^/Library/(?!Application Support)", "label": "/Library" }
  ],
  "toolNamePatterns": [
    { "match": "^mcp__", "label": "MCP tool (external system)" }
  ]
}
```

`pixel-agents-standalone/config-defaults/responses.json`:

```json
{
  "default": [
    { "label": "Allow",                  "decision": "allow" },
    { "label": "Allow this session",     "decision": "allow", "scope": "session" },
    { "label": "Custom feedback…",       "decision": "deny",  "askForReason": true }
  ],
  "Bash": [
    { "label": "Allow",                  "decision": "allow" },
    { "label": "Allow this session",     "decision": "allow", "scope": "session" },
    { "label": "Add --dry-run instead",  "decision": "deny",  "reason": "Re-run with --dry-run to preview only — do not actually execute." },
    { "label": "Skip this step",         "decision": "deny",  "reason": "Skip this command and continue with the next task in the plan." },
    { "label": "Custom feedback…",       "decision": "deny",  "askForReason": true }
  ],
  "Edit": [
    { "label": "Allow",                  "decision": "allow" },
    { "label": "Allow this session",     "decision": "allow", "scope": "session" },
    { "label": "Show me the diff first", "decision": "deny",  "reason": "Print the proposed diff for this edit first — do not write yet." },
    { "label": "Custom feedback…",       "decision": "deny",  "askForReason": true }
  ],
  "Write": [
    { "label": "Allow",                  "decision": "allow" },
    { "label": "Allow this session",     "decision": "allow", "scope": "session" },
    { "label": "Custom feedback…",       "decision": "deny",  "askForReason": true }
  ]
}
```

`pixel-agents-standalone/config-defaults/policy.json`:

```json
{ "timeoutSec": 30, "defaultOnTimeout": "allow", "listenAddress": "127.0.0.1" }
```

`pixel-agents-standalone/config-defaults/watch-list.json`:

```json
{ "watch": [] }
```

- [ ] **Step 2: Write the failing test**

`pixel-agents-standalone/server/__tests__/permissionConfig.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
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
```

Run: `npm test`
Expected: FAIL — `Cannot find module '../permissionConfig.js'`.

- [ ] **Step 3: Write the minimal implementation**

`pixel-agents-standalone/server/permissionConfig.ts`:

```ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Read a JSON config from `userPath`. If absent, write the `defaults` value
 *  there and return it. If the file is invalid JSON, log a warning, leave the
 *  bad file in place (so the user can inspect), and return the defaults. */
export function loadOrInitConfig<T>(userPath: string, defaults: T): T {
  if (!existsSync(userPath)) {
    mkdirSync(dirname(userPath), { recursive: true })
    writeFileSync(userPath, JSON.stringify(defaults, null, 2))
    return defaults
  }
  try {
    return JSON.parse(readFileSync(userPath, 'utf-8')) as T
  } catch (err) {
    console.warn(`[pa] invalid JSON in ${userPath}; using defaults. ${err instanceof Error ? err.message : err}`)
    return defaults
  }
}
```

Run: `npm test`
Expected: PASS — 3 tests in permissionConfig.test.ts plus the sanity test.

- [ ] **Step 4: Add the four config keys to `permissionConfig.ts`**

Append to `pixel-agents-standalone/server/permissionConfig.ts`:

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface RiskyPatterns {
  Bash: Array<{ match: string; label: string }>
  filePathPatterns: Array<{ match: string; label: string }>
  toolNamePatterns: Array<{ match: string; label: string }>
}
export interface ResponseTemplate {
  label: string
  decision: 'allow' | 'deny'
  scope?: 'once' | 'session'
  reason?: string
  askForReason?: boolean
}
export interface PolicyConfig {
  timeoutSec: number
  defaultOnTimeout: 'allow' | 'deny'
  listenAddress: string
}
export interface WatchList { watch: string[] }

const PA_DIR = join(homedir(), '.pixel-agents')

export const RISKY_PATH = join(PA_DIR, 'risky-patterns.json')
export const RESPONSES_PATH = join(PA_DIR, 'responses.json')
export const POLICY_PATH = join(PA_DIR, 'policy.json')
export const WATCH_LIST_PATH = join(PA_DIR, 'watch-list.json')

export const DEFAULT_RISKY: RiskyPatterns = JSON.parse(
  readFileSync(new URL('../config-defaults/risky-patterns.json', import.meta.url), 'utf-8')
)
export const DEFAULT_RESPONSES: Record<string, ResponseTemplate[]> = JSON.parse(
  readFileSync(new URL('../config-defaults/responses.json', import.meta.url), 'utf-8')
)
export const DEFAULT_POLICY: PolicyConfig = JSON.parse(
  readFileSync(new URL('../config-defaults/policy.json', import.meta.url), 'utf-8')
)
export const DEFAULT_WATCH_LIST: WatchList = { watch: [] }
```

- [ ] **Step 5: Run all tests; expect green**

Run: `npm test`
Expected: 4 tests passing.

- [ ] **Step 6: Commit**

```bash
git add config-defaults server/permissionConfig.ts server/__tests__/permissionConfig.test.ts
git commit -m "feat: ship config defaults + first-run loader for permission system"
```

---

### Task 3: configWatcher — chokidar-based hot reload

**Files:**
- Create: `pixel-agents-standalone/server/configWatcher.ts`
- Create: `pixel-agents-standalone/server/__tests__/configWatcher.test.ts`

- [ ] **Step 1: Write the failing test**

`pixel-agents-standalone/server/__tests__/configWatcher.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
```

Run: `npm test`
Expected: FAIL — `Cannot find module '../configWatcher.js'`.

- [ ] **Step 2: Write the implementation**

`pixel-agents-standalone/server/configWatcher.ts`:

```ts
import { watch } from 'chokidar'
import { readFileSync, existsSync } from 'node:fs'

/** Watch `path` for changes; whenever the file is rewritten (and parses as
 *  valid JSON), invoke `onChange` with the new config. Returns a stop fn. */
export function watchConfigFile<T>(
  path: string,
  fallback: T,
  onChange: (cfg: T) => void,
): () => void {
  // Initial read
  if (existsSync(path)) {
    try { onChange(JSON.parse(readFileSync(path, 'utf-8')) as T) }
    catch { onChange(fallback) }
  } else {
    onChange(fallback)
  }
  const watcher = watch(path, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 } })
  watcher.on('change', () => {
    try { onChange(JSON.parse(readFileSync(path, 'utf-8')) as T) }
    catch (err) {
      console.warn(`[pa] hot-reload: invalid JSON in ${path}, keeping previous config. ${err instanceof Error ? err.message : err}`)
    }
  })
  return () => { void watcher.close() }
}
```

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 3: Commit**

```bash
git add server/configWatcher.ts server/__tests__/configWatcher.test.ts
git commit -m "feat: configWatcher hot-reloads JSON configs with safe fallback"
```

---

### Task 4: permissionPolicy — trigger ladder + session allowlist

**Files:**
- Create: `pixel-agents-standalone/server/permissionPolicy.ts`
- Create: `pixel-agents-standalone/server/__tests__/permissionPolicy.test.ts`

- [ ] **Step 1: Write the failing tests for the trigger ladder**

`pixel-agents-standalone/server/__tests__/permissionPolicy.test.ts`:

```ts
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
```

Run: `npm test`
Expected: FAIL — `Cannot find module '../permissionPolicy.js'`.

- [ ] **Step 2: Write the implementation**

`pixel-agents-standalone/server/permissionPolicy.ts`:

```ts
import type { RiskyPatterns } from './permissionConfig.js'

export interface EvaluateAllow {
  allow: true
  reason: 'readonly-tool' | 'session-allowlist' | 'auto-mode-default'
}
export interface EvaluateAsk {
  allow: false
  /** Short label of why the modal is firing (e.g. "Force push", ".env"). */
  label: string
}
export type EvaluateResult = EvaluateAllow | EvaluateAsk

const READONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
  'Task', 'AskUserQuestion',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop',
])

export class PermissionPolicy {
  private risky: RiskyPatterns
  private watchList: Set<string>
  private bashRegexes: Array<{ re: RegExp; label: string }> = []
  private pathRegexes: Array<{ re: RegExp; label: string }> = []
  private toolRegexes: Array<{ re: RegExp; label: string }> = []
  /** Map of sessionId → set of tool names allowed for the rest of the session. */
  private allowlist = new Map<string, Set<string>>()

  constructor(risky: RiskyPatterns, watchList: Set<string>) {
    this.risky = risky
    this.watchList = watchList
    this.compile()
  }

  evaluate(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): EvaluateResult {
    // Rung 1
    if (READONLY_TOOLS.has(toolName)) return { allow: true, reason: 'readonly-tool' }
    // Rung 2
    if (this.watchList.has(sessionId)) return { allow: false, label: 'Watching this session' }
    // Rung 3
    if (this.allowlist.get(sessionId)?.has(toolName)) return { allow: true, reason: 'session-allowlist' }
    // Rung 4
    const matched = this.matchRisky(toolName, toolInput)
    if (matched) return { allow: false, label: matched }
    // Rung 5
    return { allow: true, reason: 'auto-mode-default' }
  }

  allowSession(sessionId: string, toolName: string): void {
    let s = this.allowlist.get(sessionId)
    if (!s) { s = new Set(); this.allowlist.set(sessionId, s) }
    s.add(toolName)
  }

  forgetSession(sessionId: string): void {
    this.allowlist.delete(sessionId)
  }

  updateConfig(risky: RiskyPatterns): void {
    this.risky = risky
    this.compile()
  }

  updateWatchList(watch: Set<string>): void {
    this.watchList = watch
  }

  private compile(): void {
    this.bashRegexes = this.risky.Bash.map((p) => ({ re: new RegExp(p.match, 'i'), label: p.label }))
    this.pathRegexes = this.risky.filePathPatterns.map((p) => ({ re: new RegExp(p.match), label: p.label }))
    this.toolRegexes = this.risky.toolNamePatterns.map((p) => ({ re: new RegExp(p.match), label: p.label }))
  }

  private matchRisky(toolName: string, input: Record<string, unknown>): string | null {
    for (const { re, label } of this.toolRegexes) {
      if (re.test(toolName)) return label
    }
    if (toolName === 'Bash') {
      const cmd = typeof input.command === 'string' ? input.command : ''
      for (const { re, label } of this.bashRegexes) if (re.test(cmd)) return label
    }
    if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
      const fp = typeof input.file_path === 'string' ? input.file_path : ''
      for (const { re, label } of this.pathRegexes) if (re.test(fp)) return label
    }
    return null
  }
}
```

Run: `npm test`
Expected: PASS — all 9 tests in permissionPolicy.test.ts plus prior tests.

- [ ] **Step 3: Commit**

```bash
git add server/permissionPolicy.ts server/__tests__/permissionPolicy.test.ts
git commit -m "feat: PermissionPolicy with five-rung trigger ladder + session allowlist"
```

---

### Task 5: Refactor server endpoints to use the policy module

**Files:**
- Modify: `pixel-agents-standalone/server/index.ts`
- Modify: `pixel-agents-standalone/server/types.ts`

- [ ] **Step 1: Add new ServerMessage types**

In `pixel-agents-standalone/server/types.ts`, replace the existing `agentToolPermission` / `agentPermissionRequest` / `agentPermissionResolved` definitions with the canonical set:

```ts
  | { type: "agentToolPermission"; id: number; toolName?: string; toolInput?: Record<string, unknown>; lastAssistantText?: string }
  | { type: "agentToolPermissionClear"; id: number }
  | {
      type: "agentPermissionRequest";
      id: number;
      requestId: string;
      toolName: string;
      toolInput?: Record<string, unknown>;
      lastAssistantText?: string;
      label: string;     // "Force push" / ".env" / etc.
    }
  | { type: "agentPermissionResolved"; requestId: string; decision: "allow" | "deny" }
```

(The rest of the file is unchanged.)

- [ ] **Step 2: Replace the inline permission code in `server/index.ts` with policy-driven logic**

Open `pixel-agents-standalone/server/index.ts`. Delete the block currently defining `READONLY_TOOLS`, `RISKY_BASH_PATTERNS`, `looksRisky`, the inline `pendingPermissions` Map, and the existing `app.post("/permission/request", ...)` and `app.post("/permission/respond", ...)` handlers.

In their place, insert (after the `app.use(express.static(...))` line):

```ts
import { loadOrInitConfig, RISKY_PATH, RESPONSES_PATH, POLICY_PATH, WATCH_LIST_PATH,
  DEFAULT_RISKY, DEFAULT_RESPONSES, DEFAULT_POLICY, DEFAULT_WATCH_LIST,
  type RiskyPatterns, type PolicyConfig, type WatchList } from "./permissionConfig.js"
import { watchConfigFile } from "./configWatcher.js"
import { PermissionPolicy } from "./permissionPolicy.js"

app.use(express.json({ limit: "256kb" }))

// ── Config bootstrap (creates ~/.pixel-agents/* on first run) ────────
let policyCfg: PolicyConfig = loadOrInitConfig(POLICY_PATH, DEFAULT_POLICY)
let riskyCfg: RiskyPatterns = loadOrInitConfig(RISKY_PATH, DEFAULT_RISKY)
let watchListCfg: WatchList = loadOrInitConfig(WATCH_LIST_PATH, DEFAULT_WATCH_LIST)
loadOrInitConfig(RESPONSES_PATH, DEFAULT_RESPONSES) // copy on first run; UI reads it

const policy = new PermissionPolicy(riskyCfg, new Set(watchListCfg.watch))

watchConfigFile(POLICY_PATH, DEFAULT_POLICY, (c) => { policyCfg = c })
watchConfigFile(RISKY_PATH, DEFAULT_RISKY, (c) => { riskyCfg = c; policy.updateConfig(c) })
watchConfigFile(WATCH_LIST_PATH, DEFAULT_WATCH_LIST, (c) => { watchListCfg = c; policy.updateWatchList(new Set(c.watch)) })

// ── Pending permission requests ──────────────────────────────────────
interface PendingPermission {
  requestId: string
  agentId: number
  sessionId: string
  toolName: string
  resolve: (verdict: { decision: "allow" | "deny"; reason?: string; scope?: "once" | "session" }) => void
  timeoutHandle: ReturnType<typeof setTimeout>
}
const pendingPermissions = new Map<string, PendingPermission>()
let permissionRequestSeq = 1

app.post("/permission/request", (req, res) => {
  const body = req.body as { sessionId?: string; toolName?: string; toolInput?: Record<string, unknown> }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
  const toolName = typeof body.toolName === "string" ? body.toolName : ""
  const toolInput = body.toolInput && typeof body.toolInput === "object" ? body.toolInput : {}

  const verdict = policy.evaluate(sessionId, toolName, toolInput)
  if (verdict.allow) { res.json({ decision: "allow", reason: verdict.reason }); return }

  // Need to ask the human. If no UI is connected, fall through to allow.
  if (clients.size === 0) { res.json({ decision: "allow", reason: "no-ui" }); return }

  const agent = sessionId ? agents.get(sessionId) : null
  if (!agent) { res.json({ decision: "allow", reason: "unknown-session" }); return }

  const requestId = `perm-${permissionRequestSeq++}-${Date.now()}`
  const timeoutMs = Math.max(5_000, policyCfg.timeoutSec * 1000)
  const defaultDecision = policyCfg.defaultOnTimeout

  const timeoutHandle = setTimeout(() => {
    if (pendingPermissions.has(requestId)) {
      pendingPermissions.delete(requestId)
      res.json({ decision: defaultDecision, reason: "timeout" })
      broadcast({ type: "agentPermissionResolved", requestId, decision: defaultDecision })
    }
  }, timeoutMs)

  pendingPermissions.set(requestId, {
    requestId, agentId: agent.id, sessionId, toolName, timeoutHandle,
    resolve: ({ decision, reason, scope }) => {
      clearTimeout(timeoutHandle)
      pendingPermissions.delete(requestId)
      if (decision === "allow" && scope === "session") policy.allowSession(sessionId, toolName)
      res.json({ decision, reason })
    },
  })

  broadcast({
    type: "agentPermissionRequest",
    id: agent.id,
    requestId,
    toolName,
    toolInput,
    lastAssistantText: agent.lastAssistantText || undefined,
    label: verdict.label,
  })
})

app.post("/permission/respond", (req, res) => {
  const body = req.body as { requestId?: string; decision?: string; reason?: string; scope?: string }
  const requestId = typeof body.requestId === "string" ? body.requestId : ""
  const decisionRaw = typeof body.decision === "string" ? body.decision : ""
  const reason = typeof body.reason === "string" ? body.reason : undefined
  const scope: "once" | "session" = body.scope === "session" ? "session" : "once"
  if (decisionRaw !== "allow" && decisionRaw !== "deny") {
    res.status(400).json({ ok: false, error: "decision must be allow|deny" }); return
  }
  const pending = pendingPermissions.get(requestId)
  if (!pending) { res.status(404).json({ ok: false, error: "no pending request" }); return }
  pending.resolve({ decision: decisionRaw as "allow" | "deny", reason, scope })
  broadcast({ type: "agentPermissionResolved", requestId, decision: decisionRaw as "allow" | "deny" })
  res.json({ ok: true })
})

// ── Watch-list mutation endpoint (used by the UI's "Watch closely" toggle) ─
app.post("/watch-list", (req, res) => {
  const body = req.body as { sessionId?: string; watch?: boolean }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
  const watch = !!body.watch
  if (!sessionId) { res.status(400).json({ ok: false, error: "sessionId required" }); return }
  const set = new Set(watchListCfg.watch)
  if (watch) set.add(sessionId); else set.delete(sessionId)
  watchListCfg = { watch: [...set] }
  policy.updateWatchList(set)
  // Persist (the file watcher will pick up the disk change but we want the in-memory change immediate).
  writeFileSync(WATCH_LIST_PATH, JSON.stringify(watchListCfg, null, 2))
  res.json({ ok: true, watch: [...set] })
})
```

Add the missing imports at the top of `server/index.ts`:

```ts
import { writeFileSync } from "node:fs"
```

- [ ] **Step 3: Bind to `policyCfg.listenAddress`**

Find `server.listen(PORT, () => {` near the bottom and change it to:

```ts
server.listen(PORT, policyCfg.listenAddress, () => {
  console.log(`Pixel Agents server running at http://${policyCfg.listenAddress === "0.0.0.0" ? "<your-ip>" : policyCfg.listenAddress}:${PORT}`)
  console.log(`Watching ~/.claude/projects/ for active sessions...`)
})
```

- [ ] **Step 4: Build the server and verify it starts**

```bash
npm run build:server
pkill -f "node dist/server.js" 2>/dev/null; sleep 1
npm start &
sleep 2
curl -sS -X POST http://127.0.0.1:3456/permission/request \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"none","toolName":"Read","toolInput":{}}'
pkill -f "node dist/server.js"
```

Expected: `{"decision":"allow","reason":"readonly-tool"}`.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts server/types.ts
git commit -m "refactor: route permission requests through PermissionPolicy + hot-reload configs"
```

---

### Task 6: Hook script verified end-to-end

**Files:**
- Modify: `~/.pixel-agents/hooks/permission-hook.js`

The hook already exists from the prior session; this task confirms it matches the spec contract.

- [ ] **Step 1: Replace the hook with the canonical version**

Write `~/.pixel-agents/hooks/permission-hook.js`:

```js
#!/usr/bin/env node
/**
 * pixel-agents PreToolUse hook.
 * Reads the Claude Code PreToolUse JSON from stdin, posts it to the local
 * pixel-agents server, exits 0 (allow) or 2 (deny). Defensive: any error,
 * timeout, or unreachable server falls through to "allow" so an offline
 * pixel-agents UI never blocks the agent's work.
 */
const http = require("node:http")

const HOST = process.env.PIXEL_AGENTS_HOST || "127.0.0.1"
const PORT = parseInt(process.env.PIXEL_AGENTS_PORT || "3456", 10)
const TIMEOUT_MS = 6 * 60_000 // server ceiling is 5 min, give ourselves 6

let buf = ""
process.stdin.setEncoding("utf-8")
process.stdin.on("data", (c) => { buf += c })
process.stdin.on("end", () => {
  let parsed
  try { parsed = JSON.parse(buf) } catch { exit("allow"); return }
  const sessionId = parsed.session_id || parsed.sessionId || ""
  const toolName = parsed.tool_name || parsed.toolName || ""
  const toolInput = parsed.tool_input || parsed.toolInput || {}
  if (!toolName) { exit("allow"); return }

  const body = JSON.stringify({ sessionId, toolName, toolInput })
  const req = http.request(
    {
      hostname: HOST, port: PORT, path: "/permission/request", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
    },
    (res) => {
      let chunk = ""
      res.on("data", (c) => { chunk += c })
      res.on("end", () => {
        let decision = "allow"; let reason
        try { const obj = JSON.parse(chunk); decision = obj.decision || "allow"; reason = obj.reason } catch {}
        if (decision === "deny") {
          if (reason) process.stderr.write(`[pixel-agents] ${reason}\n`)
          process.exit(2)
        }
        process.exit(0)
      })
    },
  )
  req.on("timeout", () => { req.destroy(); exit("allow") })
  req.on("error", () => exit("allow"))
  req.write(body)
  req.end()
})

function exit(decision) {
  if (decision === "deny") process.exit(2)
  process.exit(0)
}
```

- [ ] **Step 2: Make executable & verify**

```bash
chmod +x ~/.pixel-agents/hooks/permission-hook.js
echo '{"session_id":"test","tool_name":"Read","tool_input":{}}' | ~/.pixel-agents/hooks/permission-hook.js; echo "exit=$?"
```

Expected: prints nothing, `exit=0`.

```bash
# With no server running, expect immediate fail-open:
pkill -f "node dist/server.js" 2>/dev/null
echo '{"session_id":"test","tool_name":"Bash","tool_input":{"command":"git push --force"}}' | ~/.pixel-agents/hooks/permission-hook.js; echo "exit=$?"
```

Expected: `exit=0` within ~1 second (no server → fail-open).

- [ ] **Step 3: Commit**

The hook lives at `~/.pixel-agents/hooks/`, not in the repo, so no git commit. Note in your terminal that the hook is up-to-date — Task 14 will install it in `~/.claude/settings.json`.

---

### Task 7: PermissionModal — render preset buttons from responses.json

**Files:**
- Modify: `pixel-agents-standalone/webview-ui/src/components/PermissionModal.tsx`
- Modify: `pixel-agents-standalone/webview-ui/src/hooks/useExtensionMessages.ts`
- Modify: `pixel-agents-standalone/webview-ui/src/App.tsx`

- [ ] **Step 1: Have the server publish responses.json over WS on connect**

In `pixel-agents-standalone/server/index.ts`, find `function sendInitialData(ws: WebSocket): void {` and append, just before the existing layout broadcast:

```ts
  ws.send(JSON.stringify({
    type: "responsesLoaded",
    responses: loadOrInitConfig(RESPONSES_PATH, DEFAULT_RESPONSES),
  }))
```

Hot-reload responses too (after the existing `watchConfigFile` calls):

```ts
watchConfigFile(RESPONSES_PATH, DEFAULT_RESPONSES, (c) => {
  broadcast({ type: "responsesLoaded", responses: c } as any)
})
```

Add the new ServerMessage variant in `server/types.ts`:

```ts
  | { type: "responsesLoaded"; responses: Record<string, Array<{ label: string; decision: "allow" | "deny"; scope?: "once" | "session"; reason?: string; askForReason?: boolean }>> }
```

- [ ] **Step 2: Capture responses in the client hook**

In `pixel-agents-standalone/webview-ui/src/hooks/useExtensionMessages.ts`, add to the state:

```ts
const [responses, setResponses] = useState<Record<string, Array<{ label: string; decision: 'allow' | 'deny'; scope?: 'once' | 'session'; reason?: string; askForReason?: boolean }>>>({ default: [] })
```

In the message handler, alongside the other `else if` branches:

```ts
} else if (msg.type === 'responsesLoaded') {
  setResponses(msg.responses as typeof responses)
}
```

Append `responses` to the hook's return object and to `ExtensionMessageState`.

- [ ] **Step 3: Replace PermissionModal's footer with preset rendering**

Open `pixel-agents-standalone/webview-ui/src/components/PermissionModal.tsx` and replace the existing modal body's "$ choose how to respond" block + footer button row with a unified preset-driven body:

```tsx
{lastText && (
  <>
    <div style={{ color: '#9aa', marginBottom: 6 }}>$ latest message:</div>
    <pre style={{ background: '#16181f', padding: '10px 12px', border: '1px solid #2a2d36', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', color: '#cfd2da', maxHeight: 180, overflowY: 'auto' }}>
      {lastText}
    </pre>
  </>
)}
<div style={{ color: '#9aa', margin: '12px 0 6px' }}>$ requesting permission for:</div>
<pre style={{ background: '#16181f', padding: '10px 12px', border: '1px solid #2a2d36', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '13px' }}>
  {toolName ? <span style={{ color: '#FFB060' }}>{toolName} </span> : null}
  <span style={{ color: '#cfd2da' }}>{pendingTool.status}</span>
  {inputSummary && inputSummary !== pendingTool.status && (<>{'\n'}<span style={{ color: '#7d8694' }}>{inputSummary}</span></>)}
</pre>

<div style={{ color: '#9aa', margin: '14px 0 6px' }}>$ choose a response:</div>
<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
  {presetButtons.map((btn, i) => (
    <button
      key={i}
      onClick={() => handlePreset(btn)}
      disabled={!canRespond}
      style={{
        background: btn.decision === 'allow' ? '#FF7A1A' : '#3a1010',
        color: btn.decision === 'allow' ? '#1a0a00' : '#ff9b8b',
        border: btn.decision === 'allow' ? '1px solid #5a1f00' : '1px solid #6b2020',
        padding: '8px 12px', fontSize: '14px', cursor: canRespond ? 'pointer' : 'not-allowed',
        textAlign: 'left', fontFamily: 'inherit', fontWeight: 600,
      }}
    >
      {btn.label}
    </button>
  ))}
</div>

{reasonComposerOpen && (
  <>
    <textarea
      value={composerText}
      onChange={(e) => setComposerText(e.target.value)}
      placeholder="Tell the agent what to do instead…"
      style={{ width: '100%', minHeight: 80, marginTop: 10, background: '#16181f', color: '#e6e6f0', border: '1px solid #2a2d36', padding: '8px', fontFamily: 'inherit', fontSize: '13px', boxSizing: 'border-box' }}
    />
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
      <button onClick={() => setReasonComposerOpen(false)} style={{ background: 'transparent', color: '#9aa', border: '1px solid #2a2d36', padding: '6px 12px', cursor: 'pointer' }}>Cancel</button>
      <button onClick={() => sendDeny(composerText)} disabled={!composerText.trim()} style={{ background: '#FF7A1A', color: '#1a0a00', border: '1px solid #5a1f00', padding: '6px 12px', fontWeight: 700, cursor: composerText.trim() ? 'pointer' : 'not-allowed' }}>Send</button>
    </div>
  </>
)}
```

Add the supporting hooks/state at the top of the component:

```tsx
const [composerText, setComposerText] = useState('')
const [reasonComposerOpen, setReasonComposerOpen] = useState(false)
const presetButtons = (responses[toolName] ?? responses.default ?? [])

async function handlePreset(btn: typeof presetButtons[number]) {
  if (btn.askForReason) { setReasonComposerOpen(true); return }
  if (!requestId) return
  await fetch('/permission/respond', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, decision: btn.decision, scope: btn.scope, reason: btn.reason }),
  }).catch(() => {})
  onClose()
}

async function sendDeny(reason: string) {
  if (!requestId) return
  await fetch('/permission/respond', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, decision: 'deny', reason }),
  }).catch(() => {})
  onClose()
}
```

Update the `PermissionModalProps` interface:

```tsx
interface PermissionModalProps {
  agentId: number | null
  folderName: string | undefined
  pendingTool: ToolActivity | null
  context: PermissionContext | null
  responses: Record<string, Array<{ label: string; decision: 'allow' | 'deny'; scope?: 'once' | 'session'; reason?: string; askForReason?: boolean }>>
  onClose: () => void
}
```

- [ ] **Step 4: Pass `responses` from App.tsx into PermissionModal**

In `pixel-agents-standalone/webview-ui/src/App.tsx`, destructure `responses` from `useExtensionMessages` and pass into `<PermissionModal responses={responses} ... />`.

- [ ] **Step 5: Type-check + build**

```bash
cd webview-ui && npx tsc --noEmit && cd ..
npm run build:ui
```

Expected: no type errors; build succeeds.

- [ ] **Step 6: Manual smoke test**

```bash
npm start &
# In a real browser: open http://localhost:3456
# Force a permission state by curl-ing the request endpoint AFTER joining a real session.
# For now: confirm the modal renders preset buttons (you'll see the bare modal close button at minimum).
pkill -f "node dist/server.js"
```

- [ ] **Step 7: Commit**

```bash
git add server/index.ts server/types.ts webview-ui/src/components/PermissionModal.tsx webview-ui/src/hooks/useExtensionMessages.ts webview-ui/src/App.tsx
git commit -m "feat: PermissionModal renders preset buttons + custom-feedback composer"
```

---

### Task 8: PendingQueue badge + listenAddress

**Files:**
- Create: `pixel-agents-standalone/webview-ui/src/components/PendingQueue.tsx`
- Modify: `pixel-agents-standalone/webview-ui/src/App.tsx`

- [ ] **Step 1: Write the queue component**

`pixel-agents-standalone/webview-ui/src/components/PendingQueue.tsx`:

```tsx
import { useState } from 'react'

interface PendingItem {
  agentId: number
  folderName?: string
  toolName?: string
  label?: string
  receivedAt: number
}

interface PendingQueueProps {
  pending: PendingItem[]
  onSelect: (agentId: number) => void
}

export function PendingQueue({ pending, onSelect }: PendingQueueProps) {
  const [open, setOpen] = useState(false)
  if (pending.length === 0) return null
  return (
    <div style={{ position: 'fixed', top: 12, right: 12, zIndex: 900 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: '#FF7A1A', color: '#1a0a00', border: '2px solid rgba(0,0,0,0.35)',
          padding: '6px 12px', fontWeight: 700, fontFamily: 'inherit', fontSize: '13px',
          cursor: 'pointer', boxShadow: '0 2px 0 rgba(0,0,0,0.35)',
        }}
      >
        ! {pending.length} pending
      </button>
      {open && (
        <div style={{ marginTop: 6, background: '#0c0d12', border: '2px solid #FF7A1A', minWidth: 280, padding: 6, fontFamily: 'inherit' }}>
          {pending.map((p) => (
            <button
              key={p.agentId}
              onClick={() => { setOpen(false); onSelect(p.agentId) }}
              style={{
                width: '100%', textAlign: 'left', background: 'transparent', color: '#e6e6f0',
                border: 'none', borderBottom: '1px solid #2a2d36', padding: '6px 8px',
                cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px',
              }}
            >
              <div><strong>Agent #{p.agentId}</strong>{p.folderName ? ` · ${p.folderName}` : ''}</div>
              <div style={{ color: '#9aa', fontSize: '11px' }}>{p.toolName} · {p.label ?? ''} · {Math.round((Date.now() - p.receivedAt) / 1000)}s</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Track pending in useExtensionMessages**

In `pixel-agents-standalone/webview-ui/src/hooks/useExtensionMessages.ts`, add state:

```ts
const [pending, setPending] = useState<Array<{ agentId: number; folderName?: string; toolName?: string; label?: string; receivedAt: number; requestId: string }>>([])
```

In the `agentPermissionRequest` handler, append:

```ts
setPending((prev) => {
  if (prev.some((p) => p.requestId === ctx.requestId)) return prev
  return [...prev, {
    agentId: id,
    folderName: os.characters.get(id)?.folderName,
    toolName: ctx.toolName, label: (msg as any).label,
    receivedAt: Date.now(), requestId: ctx.requestId!,
  }]
})
```

In the `agentPermissionResolved` handler, append:

```ts
setPending((prev) => prev.filter((p) => p.requestId !== requestId))
```

Return `pending` from the hook.

- [ ] **Step 3: Render in App.tsx**

In `pixel-agents-standalone/webview-ui/src/App.tsx`:

```tsx
import { PendingQueue } from './components/PendingQueue.js'

// inside App, near where other overlays render:
<PendingQueue
  pending={pending}
  onSelect={(id) => setPermissionAgentId(id)}
/>
```

- [ ] **Step 4: Build + manual sanity**

```bash
npm run build:ui
```

Open the tab, verify the badge stays hidden when there are no pending requests.

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/components/PendingQueue.tsx webview-ui/src/hooks/useExtensionMessages.ts webview-ui/src/App.tsx
git commit -m "feat: pending-permission queue badge + drawer"
```

---

## Phase B — Visibility Layer (Tasks 9–14)

Per-agent live feed, per-desk activity cards, watch-list UI.

### Task 9: feedBuffer ring buffer + parser hooks

**Files:**
- Create: `pixel-agents-standalone/server/feedBuffer.ts`
- Create: `pixel-agents-standalone/server/__tests__/feedBuffer.test.ts`
- Modify: `pixel-agents-standalone/server/parser.ts`
- Modify: `pixel-agents-standalone/server/types.ts`

- [ ] **Step 1: Write the failing test**

`pixel-agents-standalone/server/__tests__/feedBuffer.test.ts`:

```ts
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
```

Run: `npm test`
Expected: FAIL — `Cannot find module '../feedBuffer.js'`.

- [ ] **Step 2: Implement FeedBuffer**

`pixel-agents-standalone/server/feedBuffer.ts`:

```ts
export type FeedEntry =
  | { kind: 'text';        text: string;                              timestamp: number }
  | { kind: 'tool_start';  toolId: string; status: string;            timestamp: number }
  | { kind: 'tool_done';   toolId: string;                            timestamp: number }
  | { kind: 'tool_perm';   toolId: string; label: string;             timestamp: number }
  | { kind: 'system';      message: string;                           timestamp: number }

export class FeedBuffer {
  private entries: FeedEntry[] = []
  constructor(private capacity: number) {}
  append(e: FeedEntry): void {
    this.entries.push(e)
    if (this.entries.length > this.capacity) this.entries.shift()
  }
  snapshot(): FeedEntry[] { return this.entries.slice() }
  reset(): void { this.entries = [] }
}
```

Run: `npm test` — green.

- [ ] **Step 3: Add `feedBuffer` to TrackedAgent**

In `pixel-agents-standalone/server/types.ts`:

```ts
import type { FeedBuffer, FeedEntry } from './feedBuffer.js'

// in TrackedAgent:
feedBuffer: FeedBuffer
```

- [ ] **Step 4: Initialize in `server/index.ts`**

In the `agent: TrackedAgent` literal where new agents are created (in `watcher.on("fileAdded", ...)`), import `FeedBuffer` and add:

```ts
feedBuffer: new FeedBuffer(40),
```

- [ ] **Step 5: Append from parser.ts**

In `pixel-agents-standalone/server/parser.ts`:
- In `handleAssistantMessage`, after `agent.lastAssistantText = textBlocks.join("\n\n")`:
  ```ts
  agent.feedBuffer.append({ kind: 'text', text: agent.lastAssistantText, timestamp: Date.now() })
  ```
- Where `agent.activeTools.set(toolId, ...)` runs, also append:
  ```ts
  agent.feedBuffer.append({ kind: 'tool_start', toolId, status, timestamp: Date.now() })
  ```
- In `handleUserMessage`, in the tool_result branch, append:
  ```ts
  agent.feedBuffer.append({ kind: 'tool_done', toolId: completedToolId, timestamp: Date.now() })
  ```

Add the new ServerMessage in `types.ts`:

```ts
  | { type: 'agentFeedAppend';   id: number; entry: FeedEntry }
  | { type: 'agentFeedSnapshot'; id: number; entries: FeedEntry[] }
```

In `parser.ts`, after each `agent.feedBuffer.append(...)`, also `emit({ type: 'agentFeedAppend', id: agent.id, entry })` — but reuse the freshly appended value (extract it as `const entry = { ... }; agent.feedBuffer.append(entry); emit({ type: 'agentFeedAppend', id: agent.id, entry })`).

- [ ] **Step 6: Snapshot on connect**

In `sendInitialData(ws)` in `server/index.ts`, before the existing `existingAgents` send:

```ts
for (const a of agents.values()) {
  ws.send(JSON.stringify({ type: 'agentFeedSnapshot', id: a.id, entries: a.feedBuffer.snapshot() }))
}
```

- [ ] **Step 7: Build + run tests**

```bash
npm run build:server && npm test
```

Expected: build succeeds, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add server/feedBuffer.ts server/__tests__/feedBuffer.test.ts server/parser.ts server/types.ts server/index.ts
git commit -m "feat: per-agent FeedBuffer + WS append/snapshot for live feed"
```

---

### Task 10: useAgentFeeds hook + AgentFeed component

**Files:**
- Create: `pixel-agents-standalone/webview-ui/src/hooks/useAgentFeeds.ts`
- Create: `pixel-agents-standalone/webview-ui/src/components/AgentFeed.tsx`
- Modify: `pixel-agents-standalone/webview-ui/src/hooks/useExtensionMessages.ts`
- Modify: `pixel-agents-standalone/webview-ui/src/App.tsx`

- [ ] **Step 1: Capture feed messages in useExtensionMessages**

In `useExtensionMessages.ts`, add `agentFeeds` state and message handlers:

```ts
import type { FeedEntry } from '../office/types.js' // re-exported
const [agentFeeds, setAgentFeeds] = useState<Record<number, FeedEntry[]>>({})

// in handler:
} else if (msg.type === 'agentFeedSnapshot') {
  const id = msg.id as number
  setAgentFeeds((prev) => ({ ...prev, [id]: (msg.entries || []) as FeedEntry[] }))
} else if (msg.type === 'agentFeedAppend') {
  const id = msg.id as number
  setAgentFeeds((prev) => {
    const list = prev[id] ?? []
    const next = [...list, msg.entry as FeedEntry]
    if (next.length > 40) next.shift()
    return { ...prev, [id]: next }
  })
}
```

Re-export `FeedEntry` type in `webview-ui/src/office/types.ts`:

```ts
export type FeedEntry =
  | { kind: 'text'; text: string; timestamp: number }
  | { kind: 'tool_start'; toolId: string; status: string; timestamp: number }
  | { kind: 'tool_done'; toolId: string; timestamp: number }
  | { kind: 'tool_perm'; toolId: string; label: string; timestamp: number }
  | { kind: 'system'; message: string; timestamp: number }
```

Return `agentFeeds` from the hook.

- [ ] **Step 2: Write AgentFeed**

`pixel-agents-standalone/webview-ui/src/components/AgentFeed.tsx`:

```tsx
import type { FeedEntry } from '../office/types.js'
import { prettyActivity } from '../office/components/ToolOverlay.js' // promote prettyActivity to a named export if not already

interface AgentFeedProps {
  agentId: number | null
  folderName?: string
  entries: FeedEntry[]
  isMobile: boolean
  onClose: () => void
}

export function AgentFeed({ agentId, folderName, entries, isMobile, onClose }: AgentFeedProps) {
  if (agentId === null) return null
  const ordered = [...entries].reverse() // latest first
  const baseStyle: React.CSSProperties = isMobile
    ? { position: 'fixed', left: 0, right: 0, bottom: 0, height: '70vh', background: '#0c0d12', borderTop: '2px solid #FF7A1A', zIndex: 800, display: 'flex', flexDirection: 'column' }
    : { position: 'fixed', right: 0, top: 0, bottom: 0, width: 380, background: '#0c0d12', borderLeft: '2px solid #FF7A1A', zIndex: 800, display: 'flex', flexDirection: 'column' }
  return (
    <div style={baseStyle}>
      <div style={{ background: '#FF7A1A', color: '#1a0a00', padding: '8px 12px', display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
        <span>Agent #{agentId}{folderName ? ` · ${folderName}` : ''}</span>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#1a0a00', fontSize: 22, lineHeight: 1, cursor: 'pointer' }}>×</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', color: '#e6e6f0' }}>
        {ordered.map((e, i) => <FeedCard key={i} entry={e} />)}
        {ordered.length === 0 && <div style={{ color: '#7d8694', textAlign: 'center', marginTop: 32 }}>No activity yet.</div>}
      </div>
    </div>
  )
}

function FeedCard({ entry }: { entry: FeedEntry }) {
  const ts = new Date(entry.timestamp).toLocaleTimeString()
  const card = (color: string, label: string, body: React.ReactNode) => (
    <div style={{ background: '#16181f', border: `1px solid ${color}33`, borderLeft: `3px solid ${color}`, padding: '6px 10px', fontSize: 12 }}>
      <div style={{ color: '#7d8694', fontSize: 10, marginBottom: 2 }}>{ts} · {label}</div>
      <div>{body}</div>
    </div>
  )
  switch (entry.kind) {
    case 'text':       return card('#9ad8ff', 'assistant', <span>{entry.text.slice(0, 240)}{entry.text.length > 240 ? '…' : ''}</span>)
    case 'tool_start': return card('#FFB060', 'tool',      <span>{prettyActivity(entry.status)}</span>)
    case 'tool_done':  return card('#7be3a8', 'done',      <span style={{ color: '#7d8694' }}>tool {entry.toolId.slice(-8)} finished</span>)
    case 'tool_perm':  return card('#FF7A1A', 'perm',      <span>Awaiting permission · {entry.label}</span>)
    case 'system':     return card('#7d8694', 'system',    <span style={{ color: '#7d8694' }}>{entry.message}</span>)
  }
}
```

NOTE: Open `webview-ui/src/office/components/ToolOverlay.tsx` and add `export` to the `prettyActivity` and `prettyBash` function declarations so AgentFeed can import them.

- [ ] **Step 3: Hook into App.tsx**

In `pixel-agents-standalone/webview-ui/src/App.tsx`:

```tsx
import { AgentFeed } from './components/AgentFeed.js'

const [feedAgentId, setFeedAgentId] = useState<number | null>(null)
const isMobile = typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false
// re-evaluate isMobile on resize: use a small useEffect with matchMedia listener (~6 lines)

// On sprite click (in handleClick), additionally:
setFeedAgentId(focusId)

// Render:
<AgentFeed
  agentId={feedAgentId}
  folderName={feedAgentId !== null ? officeState.characters.get(feedAgentId)?.folderName : undefined}
  entries={feedAgentId !== null ? (agentFeeds[feedAgentId] ?? []) : []}
  isMobile={isMobile}
  onClose={() => setFeedAgentId(null)}
/>
```

(Add `agentFeeds` to the `useExtensionMessages` destructure.)

- [ ] **Step 4: Type-check + build**

```bash
cd webview-ui && npx tsc --noEmit && cd ..
npm run build:ui
```

- [ ] **Step 5: Manual smoke test**

```bash
npm start &
# Browser: refresh, click an agent's sprite — the feed panel should slide in from the right with whatever activity is buffered.
pkill -f "node dist/server.js"
```

- [ ] **Step 6: Commit**

```bash
git add webview-ui/src/hooks/useAgentFeeds.ts webview-ui/src/hooks/useExtensionMessages.ts webview-ui/src/components/AgentFeed.tsx webview-ui/src/App.tsx webview-ui/src/office/types.ts webview-ui/src/office/components/ToolOverlay.tsx
git commit -m "feat: per-agent live feed bottom-sheet/side-panel + WS state"
```

---

### Task 11: DeskActivityCard per occupied seat

**Files:**
- Create: `pixel-agents-standalone/webview-ui/src/components/DeskActivityCard.tsx`
- Modify: `pixel-agents-standalone/webview-ui/src/components/DeskLabels.tsx`
- Modify: `pixel-agents-standalone/webview-ui/src/App.tsx`

- [ ] **Step 1: Write the card component**

`pixel-agents-standalone/webview-ui/src/components/DeskActivityCard.tsx`:

```tsx
interface DeskActivityCardProps {
  /** Pixel-space x at the center of the desk (computed by the caller). */
  screenX: number
  /** Pixel-space y at the bottom edge of the monitor (caller computes). */
  screenY: number
  project: string
  activity: string
  pendingPermission: boolean
  onClick: () => void
}

export function DeskActivityCard({ screenX, screenY, project, activity, pendingPermission, onClick }: DeskActivityCardProps) {
  return (
    <div
      onClick={onClick}
      style={{
        position: 'absolute',
        left: screenX, top: screenY, transform: 'translate(-50%, 0)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
        padding: '2px 5px',
        background: pendingPermission ? '#FF7A1A' : 'rgba(20,20,30,0.85)',
        color: pendingPermission ? '#1a0a00' : '#e6e6f0',
        border: pendingPermission ? '1px solid #5a1f00' : '1px solid rgba(255,255,255,0.10)',
        fontSize: 10, fontFamily: 'inherit', lineHeight: 1.05, cursor: 'pointer',
        whiteSpace: 'nowrap', maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis',
        zIndex: 35, pointerEvents: 'auto',
      }}
    >
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.4px' }}>{project || '—'}</span>
      <span style={{ fontSize: 9, color: pendingPermission ? '#1a0a00' : '#9aa', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
        {pendingPermission ? '!  needs you' : activity || 'idle'}
      </span>
    </div>
  )
}
```

- [ ] **Step 2: Render cards from DeskLabels**

In `pixel-agents-standalone/webview-ui/src/components/DeskLabels.tsx`, add a second mapping after the cluster banners:

```tsx
// at top:
import { DeskActivityCard } from './DeskActivityCard.js'

// at the bottom of the JSX, before </>:
{Array.from(officeState.characters.values()).map((ch) => {
  if (ch.isSubagent || !ch.seatId) return null
  const seat = officeState.seats.get(ch.seatId)
  if (!seat) return null
  // Card sits on the desk row just below the monitor — anchor at (seatCol, seatRow+2)
  const wx = (seat.seatCol + 0.5) * TILE_SIZE
  const wy = (seat.seatRow + 3) * TILE_SIZE
  const sx = (deviceOffsetX + wx * zoom) / dpr
  const sy = (deviceOffsetY + wy * zoom) / dpr
  const tools = agentTools[ch.id] ?? []
  const pending = tools.some((t) => t.permissionWait && !t.done)
  const lastTool = [...tools].reverse().find((t) => !t.done)
  const activity = lastTool ? lastTool.status : (ch.isActive ? 'thinking…' : 'idle')
  return (
    <DeskActivityCard
      key={`card-${ch.id}`}
      screenX={sx} screenY={sy}
      project={ch.folderName ?? `Agent ${ch.id}`}
      activity={activity}
      pendingPermission={pending}
      onClick={() => onSelectAgent?.(ch.id)}
    />
  )
})}
```

Update `DeskLabelsProps` to receive `agentTools` and `onSelectAgent`:

```tsx
interface DeskLabelsProps {
  officeState: OfficeState
  agentTools: Record<number, ToolActivity[]>
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  onSelectAgent?: (id: number) => void
}
```

- [ ] **Step 3: Wire from App.tsx**

```tsx
<DeskLabels
  officeState={officeState}
  agentTools={agentTools}
  containerRef={containerRef}
  zoom={editor.zoom}
  panRef={editor.panRef}
  onSelectAgent={(id) => setFeedAgentId(id)}
/>
```

- [ ] **Step 4: Build + smoke test**

```bash
cd webview-ui && npx tsc --noEmit && cd ..
npm run build:ui
```

Verify in the browser: each occupied desk has a small card under its monitor showing project + current activity. Card glows orange when permission is pending.

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/components/DeskActivityCard.tsx webview-ui/src/components/DeskLabels.tsx webview-ui/src/App.tsx
git commit -m "feat: per-desk activity card under each monitor — live project + activity"
```

---

### Task 12: Watch-list UI — right-click toggle + persistence

**Files:**
- Modify: `pixel-agents-standalone/webview-ui/src/hooks/useExtensionMessages.ts`
- Modify: `pixel-agents-standalone/webview-ui/src/office/components/OfficeCanvas.tsx`
- Modify: `pixel-agents-standalone/webview-ui/src/office/types.ts`
- Modify: `pixel-agents-standalone/server/types.ts`
- Modify: `pixel-agents-standalone/server/index.ts`
- Modify: `pixel-agents-standalone/webview-ui/src/App.tsx`

- [ ] **Step 1: Plumb `sessionId` onto Character**

In `pixel-agents-standalone/webview-ui/src/office/types.ts`, add to the `Character` interface:

```ts
sessionId?: string
```

In `pixel-agents-standalone/server/types.ts`, extend the `agentCreated` and `existingAgents` payloads:

```ts
| { type: "agentCreated"; id: number; folderName: string; sessionId: string }
| { type: "existingAgents"; agents: number[]; folderNames: Record<number, string>; sessionIds: Record<number, string>; agentMeta?: Record<number, { palette?: number; hueShift?: number; seatId?: string }> }
```

In `pixel-agents-standalone/server/index.ts`:
- In the `broadcast({ type: "agentCreated", ... })` call, add `sessionId: file.sessionId`.
- In `sendInitialData(ws)`'s `existingAgents` block, build a `sessionIds` map alongside `folderNames` and include it in the message.

In `pixel-agents-standalone/webview-ui/src/hooks/useExtensionMessages.ts`, capture `sessionId` from `agentCreated` and from `existingAgents.sessionIds`, and after `os.addAgent(...)` call, set:

```ts
const ch = os.characters.get(id)
if (ch) ch.sessionId = sessionId
```

- [ ] **Step 2: Add the watch-list hook state to useExtensionMessages**

In `pixel-agents-standalone/webview-ui/src/hooks/useExtensionMessages.ts`, alongside the other state hooks:

```ts
const [watching, setWatching] = useState<Set<string>>(new Set())
```

Add a message handler for the WS update:

```ts
} else if (msg.type === 'watchListUpdated') {
  const arr = Array.isArray(msg.watch) ? msg.watch as string[] : []
  setWatching(new Set(arr))
}
```

Add a `toggleWatch` callback the UI can call:

```ts
const toggleWatch = useCallback(async (sessionId: string) => {
  const willWatch = !watching.has(sessionId)
  await fetch('/watch-list', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, watch: willWatch }),
  }).catch(() => {})
  // Server replies and broadcasts watchListUpdated; we update state from there.
}, [watching])
```

Append `watching` and `toggleWatch` to the hook's return value and to `ExtensionMessageState`.

- [ ] **Step 3: Server broadcasts watchListUpdated on every change**

In `pixel-agents-standalone/server/types.ts`, add the message type:

```ts
| { type: 'watchListUpdated'; watch: string[] }
```

In `pixel-agents-standalone/server/index.ts`:

- After every successful write in the `app.post("/watch-list", ...)` handler, broadcast:
  ```ts
  broadcast({ type: 'watchListUpdated', watch: [...set] })
  ```
- In the `watchConfigFile(WATCH_LIST_PATH, ...)` callback, also broadcast:
  ```ts
  watchConfigFile(WATCH_LIST_PATH, DEFAULT_WATCH_LIST, (c) => {
    watchListCfg = c
    policy.updateWatchList(new Set(c.watch))
    broadcast({ type: 'watchListUpdated', watch: c.watch })
  })
  ```
- In `sendInitialData(ws)`, send the current state once on connect:
  ```ts
  ws.send(JSON.stringify({ type: 'watchListUpdated', watch: watchListCfg.watch }))
  ```

- [ ] **Step 4: Add right-click handler to the canvas**

In `pixel-agents-standalone/webview-ui/src/office/components/OfficeCanvas.tsx`, on the `<canvas>` element:

```tsx
onContextMenu={(e) => {
  e.preventDefault()
  const pos = screenToWorld(e.clientX, e.clientY)
  if (!pos) return
  const hitId = officeState.getCharacterAt(pos.worldX, pos.worldY)
  if (hitId !== null) onContextMenu?.(hitId, e.clientX, e.clientY)
}}
```

Add `onContextMenu?: (agentId: number, x: number, y: number) => void` to the props interface.

- [ ] **Step 5: Render the context menu in App.tsx**

Destructure `watching` and `toggleWatch` from `useExtensionMessages`. Add menu state and render:

```tsx
const [ctxMenu, setCtxMenu] = useState<{ agentId: number; x: number; y: number } | null>(null)

// Pass to canvas:
<OfficeCanvas
  // ...existing props
  onContextMenu={(id, x, y) => setCtxMenu({ agentId: id, x, y })}
/>

// Render the menu:
{ctxMenu && (() => {
  const ch = officeState.characters.get(ctxMenu.agentId)
  if (!ch || !ch.sessionId) return null
  const sessionId = ch.sessionId
  const isWatched = watching.has(sessionId)
  return (
    <div onClick={() => setCtxMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 999 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'absolute', left: ctxMenu.x, top: ctxMenu.y, background: '#0c0d12', border: '2px solid #FF7A1A', minWidth: 200 }}
      >
        <button
          onClick={async () => { await toggleWatch(sessionId); setCtxMenu(null) }}
          style={{ width: '100%', textAlign: 'left', padding: '8px 12px', background: 'transparent', color: '#e6e6f0', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          {isWatched ? '✓ Watching closely' : 'Watch closely'}
        </button>
      </div>
    </div>
  )
})()}
```

- [ ] **Step 6: Build + smoke**

```bash
cd webview-ui && npx tsc --noEmit && cd ..
npm run build && pkill -f "node dist/server.js"; sleep 1; npm start &
# Right-click an agent in the browser → "Watch closely" toggles. Verify ~/.pixel-agents/watch-list.json updates.
cat ~/.pixel-agents/watch-list.json
pkill -f "node dist/server.js"
```

Expected: `watch-list.json` reflects the toggle.

- [ ] **Step 7: Commit**

```bash
git add server/index.ts server/types.ts webview-ui/src/office/components/OfficeCanvas.tsx webview-ui/src/App.tsx webview-ui/src/hooks/useExtensionMessages.ts webview-ui/src/office/types.ts
git commit -m "feat: right-click 'Watch closely' toggle persists to ~/.pixel-agents/watch-list.json"
```

---

### Task 13: Snapshot tests for the trigger ladder + risky regexes

**Files:**
- Modify: `pixel-agents-standalone/server/__tests__/permissionPolicy.test.ts`

- [ ] **Step 1: Add edge-case tests**

Append to `pixel-agents-standalone/server/__tests__/permissionPolicy.test.ts`:

```ts
describe('PermissionPolicy — risky-pattern edge cases', () => {
  const FULL: RiskyPatterns = JSON.parse(
    require('node:fs').readFileSync(new URL('../../config-defaults/risky-patterns.json', import.meta.url), 'utf-8')
  )
  const policy = new PermissionPolicy(FULL, new Set())

  const cases: Array<[string, string, Record<string, unknown>, 'allow' | 'ask']> = [
    ['regular bash echo', 'Bash', { command: 'echo hi' }, 'allow'],
    ['rm regular file',   'Bash', { command: 'rm file.txt' }, 'allow'],
    ['rm -r dir',         'Bash', { command: 'rm -r dist' }, 'ask'],
    ['rm -rf dir',        'Bash', { command: 'rm -rf node_modules' }, 'ask'],
    ['git push regular',  'Bash', { command: 'git push origin main' }, 'allow'],
    ['git push --force',  'Bash', { command: 'git push --force origin main' }, 'ask'],
    ['curl alone',        'Bash', { command: 'curl https://api.example.com' }, 'allow'],
    ['curl pipe to sh',   'Bash', { command: 'curl https://x.sh | sh' }, 'ask'],
    ['edit safe file',    'Edit', { file_path: '/Users/a/proj/foo.ts' }, 'allow'],
    ['edit .env',         'Edit', { file_path: '/Users/a/proj/.env' }, 'ask'],
    ['edit .env.local',   'Edit', { file_path: '/Users/a/.env.local' }, 'ask'],
    ['edit ssh key',      'Edit', { file_path: '/Users/a/.ssh/id_rsa' }, 'ask'],
    ['mcp tool name',     'mcp__supabase__sql', {}, 'ask'],
  ]
  for (const [name, tool, input, expected] of cases) {
    it(name, () => {
      const r = policy.evaluate('s', tool, input)
      expect(r.allow ? 'allow' : 'ask').toBe(expected)
    })
  }
})
```

Run: `npm test`
Expected: PASS — all cases pass against the default risky-patterns.json shipped in Task 2.

- [ ] **Step 2: Commit**

```bash
git add server/__tests__/permissionPolicy.test.ts
git commit -m "test: shipped risky-patterns.json table-driven snapshot cases"
```

---

### Task 14: Install hook in `~/.claude/settings.json`

**Files:**
- Modify: `~/.claude/settings.json`

This is a one-time manual step. Write down the exact diff so you don't accidentally remove existing keys.

- [ ] **Step 1: Read the current settings.json**

```bash
cat ~/.claude/settings.json
```

Note all the existing top-level keys.

- [ ] **Step 2: Use the update-config skill (recommended) or Edit by hand**

If using update-config: invoke it and ask it to add a `PreToolUse` hook entry pointing to `~/.pixel-agents/hooks/permission-hook.js`.

If editing by hand, append a `hooks` block alongside the existing keys (keeping `permissions`, `theme`, `enabledPlugins`, etc. intact):

```json
{
  // ...existing keys unchanged...
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "~/.pixel-agents/hooks/permission-hook.js" }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Validate JSON**

```bash
node -e 'JSON.parse(require("fs").readFileSync(require("os").homedir() + "/.claude/settings.json", "utf-8")); console.log("valid")'
```

Expected: `valid`.

- [ ] **Step 4: Smoke test in a fresh Claude Code session**

Open a new terminal, run `claude`. Have it run `git status` (readonly → instant allow). Then have it run `git push --force origin some-test-branch` (risky → modal pops in your browser tab).

Expected: read-only commands proceed normally; force-push waits for your click.

- [ ] **Step 5: No commit** — `~/.claude/settings.json` is not in the repo. Note in your task tracker that the hook is installed.

---

## Phase C — Mobile Shell (Tasks 15–19)

Portrait office, mobile UI tweaks, PWA install, Tailscale-friendly remote access.

### Task 15: Generate the portrait 20×36 layout

**Files:**
- Create: `pixel-agents-standalone/scripts/generate-portrait-layout.mjs`
- Auto-create: `~/.pixel-agents/layout.before-portrait.json` (backup)
- Auto-rewrite: `~/.pixel-agents/layout.json`

- [ ] **Step 1: Write the layout generator**

`pixel-agents-standalone/scripts/generate-portrait-layout.mjs`:

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const COLS = 20
const ROWS = 36
const WALL = 0, F1 = 1, F2 = 2

const tiles = new Array(COLS * ROWS).fill(F1)
for (let c = 0; c < COLS; c++) { tiles[c] = WALL; tiles[(ROWS - 1) * COLS + c] = WALL }
for (let r = 0; r < ROWS; r++) { tiles[r * COLS] = WALL; tiles[r * COLS + (COLS - 1)] = WALL }

// Lounge floor: rows 18-34
const LOUNGE_TOP = 18
for (let r = LOUNGE_TOP; r < ROWS - 1; r++)
  for (let c = 1; c < COLS - 1; c++) tiles[r * COLS + c] = F2

const color = (h, s, b, c = 0) => ({ h, s, b, c, colorize: true })
const WORK_COLOR = color(215, 12, 4)
const LOUNGE_COLOR = color(28, 24, 0)
const WALL_COLOR = color(220, 8, -8)

const tileColors = tiles.map((t) =>
  t === WALL ? WALL_COLOR : t === F1 ? WORK_COLOR : t === F2 ? LOUNGE_COLOR : null
)

const furniture = []
const add = (uid, type, col, row) => furniture.push({ uid, type, col, row })

// 12 home desks: 3 rows of 4 (cols 2, 7, 12, 17)
const DESK_COLS = [2, 7, 12, 17]
const DESK_ROWS = [
  { chair: 2,  desk: 3,  pc: 4 },
  { chair: 6,  desk: 7,  pc: 8 },
  { chair: 10, desk: 11, pc: 12 },
]
let homeIdx = 0
for (const dr of DESK_ROWS) for (const c of DESK_COLS) {
  add(`home-${homeIdx}-chair`, 'chair', c, dr.chair)
  add(`home-${homeIdx}-desk`,  'desk',  c, dr.desk)
  add(`home-${homeIdx}-pc`,    'pc',    c, dr.pc)
  homeIdx++
}

// 3 stations at row 14
const STATIONS = [
  ['build',  4,  'Builds & Tests'],
  ['git',    10, 'Git & PRs'],
  ['review', 16, 'Review & Docs'],
]
for (const [sid, c] of STATIONS) {
  add(`station-${sid}-chair`, 'chair', c, 14)
  add(`station-${sid}-desk`,  'desk',  c, 15)
  add(`station-${sid}-pc`,    'pc',    c, 16)
}

// Decor — workspace
add('dec-plant-1', 'plant', 1, 1)
add('dec-plant-2', 'plant', 18, 1)
add('dec-plant-3', 'plant', 1, 13)
add('dec-plant-4', 'plant', 18, 13)
add('dec-wb-1', 'whiteboard', 4, 17)
add('dec-wb-2', 'whiteboard', 9, 17)
add('dec-wb-3', 'whiteboard', 14, 17)

// Lounge — bookshelves on side walls
for (const r of [19, 22, 25, 28, 31]) {
  add(`lng-shelf-l-${r}`, 'bookshelf', 1, r)
  add(`lng-shelf-r-${r}`, 'bookshelf', 18, r)
}
// Beanbag clusters around coffee tables
add('lng-table-1', 'coffee_table', 9, 21)
for (const [c, r] of [[7, 20], [11, 20], [7, 22], [11, 22]]) add(`lng-bag-1-${c}-${r}`, 'beanbag', c, r)
add('lng-table-2', 'coffee_table', 5, 28)
for (const [c, r] of [[4, 27], [6, 27], [4, 29], [6, 29]]) add(`lng-bag-2-${c}-${r}`, 'beanbag', c, r)
add('lng-table-3', 'coffee_table', 14, 28)
for (const [c, r] of [[13, 27], [15, 27], [13, 29], [15, 29]]) add(`lng-bag-3-${c}-${r}`, 'beanbag', c, r)
add('lng-table-4', 'coffee_table', 9, 33)
for (const [c, r] of [[8, 32], [10, 32], [8, 34], [10, 34]]) add(`lng-bag-4-${c}-${r}`, 'beanbag', c, r)
// Lamps
for (const [c, r] of [[3, 23], [16, 23], [3, 30], [16, 30]]) add(`lng-lamp-${c}-${r}`, 'lamp', c, r)

const layout = { version: 1, cols: COLS, rows: ROWS, tiles, tileColors, furniture }

const dst = join(homedir(), '.pixel-agents', 'layout.json')
const backup = join(homedir(), '.pixel-agents', 'layout.before-portrait.json')
if (existsSync(dst) && !existsSync(backup)) copyFileSync(dst, backup)
writeFileSync(dst, JSON.stringify(layout, null, 2))
console.log(`wrote ${dst}: ${COLS}x${ROWS}, ${furniture.length} furniture pieces`)
console.log(`backup at ${backup}`)
```

- [ ] **Step 2: Run it**

```bash
node scripts/generate-portrait-layout.mjs
```

Expected: prints `wrote ... 20x36, 71 furniture pieces` (or similar count).

- [ ] **Step 3: Restart server, verify in browser**

```bash
pkill -f "node dist/server.js"; sleep 1; npm start &
# Open http://localhost:3456 — should render a tall portrait office.
```

If chairs end up un-paired with desks (no facing direction), confirm chair positions are directly above their desks (rows 2/6/10 for home, row 14 for stations). The server's `layoutToSeats` derives seat facing from adjacency.

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-portrait-layout.mjs
git commit -m "feat: portrait 20x36 office layout generator"
```

---

### Task 16: Mobile breakpoint CSS + tap-instead-of-hover

**Files:**
- Modify: `pixel-agents-standalone/webview-ui/src/index.css`
- Modify: `pixel-agents-standalone/webview-ui/src/office/components/OfficeCanvas.tsx`
- Modify: `pixel-agents-standalone/webview-ui/src/office/components/ToolOverlay.tsx`

- [ ] **Step 1: Add mobile-friendly CSS**

Append to `pixel-agents-standalone/webview-ui/src/index.css`:

```css
/* ── Mobile breakpoint (≤ 768px) ─────────────────────────── */
@media (max-width: 768px) {
  .pixel-permission-modal {
    /* Switch to bottom sheet */
    inset: auto 0 0 0;
    transform: none;
    width: 100vw;
    max-width: 100vw;
    border-radius: 16px 16px 0 0;
    max-height: 85vh;
  }
  button {
    min-height: 44px;
    min-width: 44px;
  }
  .pixel-context-menu button {
    padding: 12px 14px;
    font-size: 15px;
  }
}

/* iOS / Android safe area */
.pixel-safe-area-bottom {
  padding-bottom: env(safe-area-inset-bottom);
}
```

- [ ] **Step 2: Add `className="pixel-permission-modal"` to PermissionModal's outer div**

Open `webview-ui/src/components/PermissionModal.tsx` and add the class to the modal's container div.

- [ ] **Step 3: Add tap-to-show-overlay logic**

In `pixel-agents-standalone/webview-ui/src/office/components/OfficeCanvas.tsx`, on mobile, the existing `mousemove` hover doesn't fire. Add a tap-to-set-hover behavior:

Find the click handler. Modify so the first tap on a sprite SETS hovered (showing the overlay) AND selects, the second tap (within 500ms) opens the feed/modal. Simplest: just `setHoveredAgentId(hitId)` along with selection on every tap.

Actually the simpler change: on mobile (`window.matchMedia('(max-width: 768px)')`), make tap set both `hoveredAgentId` AND open the feed in one go (since hover doesn't really exist on touch). Skip the "first-tap shows panel" double-tap idea — too fiddly.

Adjust handler:

```tsx
// In handleClick, after hitId resolved:
officeState.hoveredAgentId = hitId  // force overlay
```

- [ ] **Step 4: Build + manual test on a desktop browser at narrow viewport**

```bash
npm run build:ui
# Open browser, resize to ~390px wide. Verify:
# - Modal pops as a bottom sheet (full width)
# - Buttons are big enough to tap
# - Right-click context menu still appears
```

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/index.css webview-ui/src/components/PermissionModal.tsx webview-ui/src/office/components/OfficeCanvas.tsx
git commit -m "feat: mobile breakpoint CSS + tap-shows-overlay on touch"
```

---

### Task 17: PWA manifest + service worker

**Files:**
- Create: `pixel-agents-standalone/webview-ui/public/manifest.json`
- Create: `pixel-agents-standalone/webview-ui/public/sw.js`
- Modify: `pixel-agents-standalone/webview-ui/index.html`

- [ ] **Step 1: Write the manifest**

`pixel-agents-standalone/webview-ui/public/manifest.json`:

```json
{
  "name": "Pixel Agents",
  "short_name": "Pixel Agents",
  "description": "Oversee many concurrent Claude Code sessions from one place.",
  "start_url": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#0c0d12",
  "theme_color": "#0c0d12",
  "icons": [
    { "src": "/icons/192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

- [ ] **Step 2: Write the service worker (cache-first for static assets)**

`pixel-agents-standalone/webview-ui/public/sw.js`:

```js
const CACHE = 'pixel-agents-v1'
const ASSETS = ['/', '/index.html']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)))
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // Never cache websockets or API
  if (url.pathname.startsWith('/permission/') || url.pathname.startsWith('/watch-list')) return
  if (event.request.method !== 'GET') return
  event.respondWith(
    caches.match(event.request).then(
      (hit) => hit || fetch(event.request).then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(event.request, copy))
        return res
      }).catch(() => caches.match('/')),
    ),
  )
})
```

- [ ] **Step 3: Reference manifest + register SW in index.html**

In `pixel-agents-standalone/webview-ui/index.html`, inside `<head>`:

```html
<link rel="manifest" href="/manifest.json" />
<meta name="theme-color" content="#0c0d12" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<link rel="apple-touch-icon" href="/icons/192.png" />
```

In `webview-ui/src/main.tsx`, after the existing imports, add:

```ts
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
```

- [ ] **Step 4: Generate placeholder icons**

For now, create plain colored PNG icons using a one-shot Node script. Real pixel-art icons can replace these later.

`pixel-agents-standalone/scripts/generate-placeholder-icons.mjs`:

```js
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Solid orange PNG, 192/512/1024 — uses a tiny PNG encoder via canvas-less raw bytes.
// For simplicity we ship a single-color square; users can replace later.

function makeSquare(size, color) {
  // Minimal raw RGBA → PNG. Use a tiny library? Simplest: ship a stub fallback PNG
  // generated externally and base64-decoded here.
  const rgba = Buffer.alloc(size * size * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = color.r; rgba[i+1] = color.g; rgba[i+2] = color.b; rgba[i+3] = 255
  }
  // Use pngjs (already a server dep)
  const { PNG } = await import('pngjs')
  const png = new PNG({ width: size, height: size })
  rgba.copy(png.data)
  return PNG.sync.write(png)
}

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'webview-ui', 'public', 'icons')
import { mkdirSync } from 'node:fs'
mkdirSync(out, { recursive: true })
const orange = { r: 255, g: 122, b: 26 }
for (const size of [192, 512, 1024]) {
  writeFileSync(join(out, `${size}.png`), await makeSquare(size, orange))
  console.log(`wrote ${size}.png`)
}
```

Run:

```bash
node scripts/generate-placeholder-icons.mjs
```

Expected: three orange-square PNGs written to `webview-ui/public/icons/`.

- [ ] **Step 5: Build + verify**

```bash
npm run build
# Open the built UI, in Chrome devtools → Application → Manifest. Verify it parses, icons resolve.
```

- [ ] **Step 6: Commit**

```bash
git add webview-ui/public/manifest.json webview-ui/public/sw.js webview-ui/public/icons webview-ui/index.html webview-ui/src/main.tsx scripts/generate-placeholder-icons.mjs
git commit -m "feat: PWA shell — manifest, service worker, placeholder icons"
```

---

### Task 18: Install hint + README

**Files:**
- Create: `pixel-agents-standalone/webview-ui/src/components/InstallHint.tsx`
- Modify: `pixel-agents-standalone/webview-ui/src/App.tsx`
- Modify: `pixel-agents-standalone/README.md`

- [ ] **Step 1: Write the install-hint component**

`pixel-agents-standalone/webview-ui/src/components/InstallHint.tsx`:

```tsx
import { useEffect, useState } from 'react'

const KEY = 'pixel-agents:install-hint-shown'

export function InstallHint() {
  const [show, setShow] = useState(false)
  const [event, setEvent] = useState<any>(null)

  useEffect(() => {
    if (localStorage.getItem(KEY)) return
    const handler = (e: Event) => {
      e.preventDefault()
      setEvent(e)
      setShow(true)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  if (!show) return null
  return (
    <div style={{ position: 'fixed', bottom: 12, left: 12, right: 12, background: '#0c0d12', border: '2px solid #FF7A1A', padding: 12, color: '#e6e6f0', zIndex: 950, fontFamily: 'inherit' }}>
      <div style={{ marginBottom: 8 }}>Install Pixel Agents to your home screen for quick access from any agent's notification.</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={async () => { event?.prompt(); localStorage.setItem(KEY, '1'); setShow(false) }} style={{ background: '#FF7A1A', color: '#1a0a00', border: '1px solid #5a1f00', padding: '8px 12px', fontWeight: 700, cursor: 'pointer' }}>Install</button>
        <button onClick={() => { localStorage.setItem(KEY, '1'); setShow(false) }} style={{ background: 'transparent', color: '#9aa', border: '1px solid #2a2d36', padding: '8px 12px', cursor: 'pointer' }}>Not now</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Render in App.tsx**

```tsx
import { InstallHint } from './components/InstallHint.js'
// somewhere in JSX:
<InstallHint />
```

- [ ] **Step 3: Update README**

Append to `pixel-agents-standalone/README.md`:

````markdown
## Mobile / remote access

The app runs as a PWA — installable on iOS / Android home screens.

### Local network (LAN only)

Edit `~/.pixel-agents/policy.json` and set `"listenAddress": "0.0.0.0"`. Restart the server. Visit `http://<your-mac-ip>:3456` from any device on the same WiFi.

### Anywhere via Tailscale (recommended)

1. Install Tailscale on your Mac and your phone, sign into the same tailnet.
2. Edit `~/.pixel-agents/policy.json` to set `"listenAddress": "0.0.0.0"`.
3. From your phone visit `http://<mac-tailnet-name>:3456`.

### Configuration cookbook

`~/.pixel-agents/risky-patterns.json` — list of patterns that trigger the modal. Edit live; server hot-reloads within ~1s.

`~/.pixel-agents/responses.json` — preset response buttons per tool (Bash, Edit, Write…). Edit live.

`~/.pixel-agents/policy.json` — `timeoutSec`, `defaultOnTimeout` (`allow` or `deny`), `listenAddress`.

`~/.pixel-agents/watch-list.json` — session IDs to watch closely. Toggle via right-click on a sprite (or long-press on mobile).

### Installing the PreToolUse hook

Add to `~/.claude/settings.json` (merge with existing keys, don't replace):

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "*",
      "hooks": [
        { "type": "command", "command": "~/.pixel-agents/hooks/permission-hook.js" }
      ]
    }
  ]
}
```

To disable, delete that block. The hook script and pixel-agents server stay on disk but become inert.
````

- [ ] **Step 4: Commit**

```bash
git add webview-ui/src/components/InstallHint.tsx webview-ui/src/App.tsx README.md
git commit -m "docs: README install/Tailscale/config cookbook + PWA install hint"
```

---

### Task 19: Final smoke test matrix

**Files:** none changed. Manual.

- [ ] **Step 1: Multi-session matrix**

In three terminals, start three Claude Code sessions in different cwds. Open the pixel-agents tab in your browser.

- [ ] **Step 2: Watch list**

Right-click one of the agents → "Watch closely." Have that session run any non-readonly command (e.g., `Edit some-file.txt`) — modal should pop.

- [ ] **Step 3: Risky pattern**

In another (un-watched) session, have it run `git push --force` — modal should pop with label "Force push."

- [ ] **Step 4: Auto-allow path**

In the third session, run regular reads / `git status` — no modal.

- [ ] **Step 5: Allow this session**

In the modal for `git push --force`, click **Allow this session**. Have the same session run another `git push --force` — should auto-allow without modal (session-allowlist hit).

- [ ] **Step 6: Custom feedback**

In another agent that hits a risky pattern, click **Custom feedback…** → type "use --no-verify instead." Verify the agent receives the feedback in its stderr.

- [ ] **Step 7: Timeout fallback**

Edit `~/.pixel-agents/policy.json` to `"timeoutSec": 5`. Trigger a risky tool. Walk away for 6+ seconds. Verify the tool runs (default-allow on timeout).

- [ ] **Step 8: Mobile**

On your phone (Tailscale connected), visit `http://<mac>:3456`. Tap a sprite — feed sheet slides up. Long-press a sprite — context menu appears with "Watch closely." Trigger a risky tool — bottom-sheet modal appears.

- [ ] **Step 9: PWA install**

On your phone, "Add to Home Screen." Open the icon — confirms standalone mode (no browser chrome).

- [ ] **Step 10: Server stop / fail-open**

`pkill -f "node dist/server.js"` while a Claude Code session is running. Have it run a risky tool. Verify it proceeds (hook fail-open). Restart server: `npm start`.

- [ ] **Step 11: Commit a check-in note**

```bash
git commit --allow-empty -m "chore: phase 1 manual smoke matrix passed"
```

---

## Out of scope for this plan

- **Phase 2 of the spec — full chat injection** (`claude -r <session> "msg"` spike) — gets its own implementation plan after this lands.
- **Push notifications** when the tab is backgrounded — see spec.
- **Audit log** of permission decisions — see spec.
- **Per-project (vs per-tool) config** — current scope is global + per-tool only.

When you're ready to ship Phase 2, run `superpowers:writing-plans` against the relevant spec section.

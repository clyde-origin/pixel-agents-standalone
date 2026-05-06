import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

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
export const DEFAULT_WATCH_LIST: WatchList = JSON.parse(
  readFileSync(new URL('../config-defaults/watch-list.json', import.meta.url), 'utf-8')
)

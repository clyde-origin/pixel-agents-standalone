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

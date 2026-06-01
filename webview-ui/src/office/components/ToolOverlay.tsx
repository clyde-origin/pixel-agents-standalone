import type { ToolActivity } from '../types.js'
import type { OfficeState } from '../engine/officeState.js'
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js'

interface ToolOverlayProps {
  officeState: OfficeState
  agents: number[]
  agentTools: Record<number, ToolActivity[]>
  subagentCharacters: SubagentCharacter[]
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  onCloseAgent: (id: number) => void
  /** Triggered when the user clicks "Respond?" on an agent that needs permission. */
  onRespondToAgent?: (id: number) => void
}

/** Translate the server's tool status into plain English. */
export function prettyActivity(status: string): string {
  // Bash: parse the command for a friendly verb
  if (status.startsWith('Running: ')) {
    return prettyBash(status.slice('Running: '.length))
  }
  if (status.startsWith('Subtask: ')) return 'Spinning up a helper'
  if (status === 'Running subtask') return 'Spinning up a helper'
  if (status.startsWith('Reading ')) return status   // "Reading foo.ts" — already plain
  if (status.startsWith('Editing ')) return status
  if (status.startsWith('Writing ')) return status
  if (status === 'Searching files' || status === 'Searching code') return 'Searching the project'
  if (status === 'Fetching web content') return 'Reading the web'
  if (status === 'Searching the web') return 'Searching the web'
  if (status === 'Waiting for your answer') return 'Waiting on you'
  if (status === 'Planning') return 'Planning'

  // "Using FooBar" or "Using mcp__claude_ai_Slack__send_message" → "Using Slack"
  if (status.startsWith('Using ')) {
    const name = status.slice('Using '.length)
    if (name.startsWith('mcp__')) {
      const parts = name.split('__')
      const service = parts[1] ? parts[1].replace(/^claude_ai_/, '') : 'a tool'
      return `Using ${service.replace(/_/g, ' ')}`
    }
    if (name === 'Task' || name === 'Agent') return 'Spinning up a helper'
    if (name === 'TaskCreate' || name === 'TaskUpdate' || name === 'TaskList') return 'Updating its task list'
    if (name === 'AskUserQuestion') return 'Waiting on you'
    if (name === 'EnterPlanMode' || name === 'ExitPlanMode') return 'Planning'
    if (name === 'NotebookEdit') return 'Editing a notebook'
    if (name === 'WebFetch') return 'Reading the web'
    if (name === 'WebSearch') return 'Searching the web'
    if (name === 'ToolSearch') return 'Looking up a tool'
    if (name === 'Skill') return 'Loading a skill'
    if (name === 'ScheduleWakeup' || name === 'CronCreate' || name === 'CronList' || name === 'CronDelete') return 'Scheduling work'
    if (name === 'EnterWorktree' || name === 'ExitWorktree') return 'Switching worktrees'
    if (name === 'Monitor') return 'Watching a process'
    if (name === 'PushNotification') return 'Notifying you'
    if (name === 'RemoteTrigger') return 'Triggering a remote'
    return `Using ${name}`
  }
  return status
}

/** Map a bash command to a layman phrase. */
export function prettyBash(cmd: string): string {
  const c = cmd.trim().replace(/^["'`]/, '').toLowerCase()
  // Match by leading token chains
  if (/^(npm|pnpm|yarn|bun)\s+install\b/.test(c) || /^(npm|pnpm|yarn|bun)\s+i\b/.test(c) || /^(npm|pnpm|yarn|bun)\s+add\b/.test(c)) return 'Installing packages'
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(build|dev|start)\b/.test(c)) return 'Building / running the app'
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tsc|typecheck|lint)\b/.test(c) || /^pytest\b|^jest\b|^vitest\b|^cargo\s+test\b|^go\s+test\b/.test(c)) return 'Running tests'
  if (/^git\s+status\b/.test(c)) return 'Checking git status'
  if (/^git\s+diff\b/.test(c) || /^git\s+show\b/.test(c)) return 'Reviewing changes'
  if (/^git\s+log\b/.test(c) || /^git\s+blame\b/.test(c)) return 'Reading git history'
  if (/^git\s+add\b/.test(c)) return 'Staging changes'
  if (/^git\s+commit\b/.test(c)) return 'Committing'
  if (/^git\s+push\b/.test(c)) return 'Pushing to git'
  if (/^git\s+pull\b|^git\s+fetch\b/.test(c)) return 'Pulling from git'
  if (/^git\s+(checkout|switch|branch|merge|rebase|stash|restore|reset)\b/.test(c)) return 'Working with git branches'
  if (/^gh\s+pr\s+create\b/.test(c)) return 'Opening a pull request'
  if (/^gh\s+pr\s+(merge|review|comment|edit)\b/.test(c)) return 'Working on a PR'
  if (/^gh\s+issue\b/.test(c)) return 'Working on an issue'
  if (/^gh\s+/.test(c)) return 'Talking to GitHub'
  if (/^docker\b|^kubectl\b|^helm\b/.test(c)) return 'Managing infra'
  if (/^curl\b|^wget\b|^http\b/.test(c)) return 'Calling an API'
  if (/^(ls|find|tree|fd|rg|ripgrep|grep|cat|head|tail|wc|file|stat|du)\b/.test(c)) return 'Exploring files'
  if (/^(mkdir|rm|mv|cp|touch|chmod|chown|ln)\b/.test(c)) return 'Reorganising files'
  if (/^(node|python3?|ruby|go run|cargo run|deno|bun run)\b/.test(c)) return 'Running a script'
  if (/^(psql|sqlite3|mysql|mongosh|redis-cli)\b/.test(c)) return 'Querying a database'
  if (/^(supabase|prisma|drizzle)\b/.test(c)) return 'Working with the database'
  if (/^(vercel|netlify|fly|heroku|railway|aws|gcloud|az)\b/.test(c)) return 'Talking to cloud'
  if (/^(make|cmake|ninja|bazel|gradle|mvn)\b/.test(c)) return 'Building'
  if (/^(echo|printf|true|false|sleep|date|env|export|source|alias|which|where|type)\b/.test(c)) return 'Setting things up'
  return 'Running a command'
}

/** Floating name/activity labels above agents were removed in favour of click-to-highlight
 *  (selecting an agent — in the scene or via the right-hand panel — outlines it instead).
 *  This render is now a no-op; the exported prettyActivity/prettyBash helpers above are
 *  still used by the right-panel agent list and feed. */
export function ToolOverlay(_props: ToolOverlayProps): null {
  return null
}

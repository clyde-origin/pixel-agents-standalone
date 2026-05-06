# Pixel-Agents Permission & Control Surface — Design

**Status:** Draft. Approved through brainstorming on 2026-05-05.
**Author:** Clyde + Claude pairing session
**Scope:** Phase 1 = decision-point chat (gatekeeper + modal + presets). Phase 2 = full chat injection (spike-then-decide). Mobile access included in Phase 1.

## Summary

Today the user runs many concurrent Claude Code sessions across many terminals. The pixel-agents standalone web app already visualises every session as an agent on an office floor plan. This spec adds an oversight + control layer on top: a per-session "doorman" hook that lets the user approve, deny, or steer any agent that's about to do something risky — from any browser tab including mobile — without slowing down the agent's auto-mode flow on tools that don't need a human.

The previous attempt at this feature broke `git` in unrelated terminals because every non-readonly tool blocked on a modal click. This design corrects that by: (1) only firing the modal for explicit risky patterns or sessions the user opted in to watch, (2) returning `allow` immediately whenever no UI is connected, and (3) capping every blocked tool to a 30-second wait with a configurable default verdict.

## Goals

1. **Centralised oversight** of N concurrent Claude Code terminals from one browser tab (desktop or mobile).
2. **Gatekeeper for risky tools** with a user-editable list — preserves the user's `defaultMode: "auto"` flow for everything else.
3. **Multi-choice responses** per tool (e.g. for Bash: "Allow", "Add `--dry-run`", "Skip step", "Custom feedback").
4. **Per-session "watch closely" mode** that surfaces *every* non-readonly tool from a chosen agent.
5. **Mobile access** so monitoring works from outside the dev machine.
6. **Non-disruption guarantee:** when the system fails or the user is AFK, tools run normally — never block indefinitely, never break workflows in other terminals.

## Non-Goals

- Replacing Claude Code's built-in permission rules. The user keeps `permissions.defaultMode: "auto"` and `skipAutoPermissionPrompt: true`; this layer is additive.
- Inspecting or rewriting the agent's plan / tool arguments before they run. We only allow / deny / give text feedback.
- Phase 2 full chat injection beyond a 5-minute feasibility spike.

## Architecture

Five components:

1. **Hook script** at `~/.pixel-agents/hooks/permission-hook.js`. Runs as Claude Code's `PreToolUse` hook. Reads the tool intent from stdin, POSTs to `localhost:3456/permission/request`, exits 0 on `allow` or 2 on `deny` (with the deny reason printed to stderr so Claude treats it as feedback).
2. **Express server** in `pixel-agents-standalone/server/`. Owns the trigger ladder, holds pending requests in memory, broadcasts to browsers over WebSocket, accepts verdicts on `POST /permission/respond`.
3. **Three config files** under `~/.pixel-agents/`:
   - `risky-patterns.json` — gatekeeper rules (Bash regexes, Edit/Write path patterns, list of `mcp__*` to gate, etc.).
   - `watch-list.json` — set of `sessionId`s flagged "watch closely" (every non-readonly tool gates).
   - `policy.json` — `{ timeoutSec, defaultOnTimeout, listenAddress }`.
   - All three are file-watched and hot-reload within ~1s.
4. **Browser UI** in `webview-ui/`. Adds: orange `!` badge above sprites with pending requests, modal with per-tool response presets and a "Custom feedback…" composer, a top-right `! N pending` queue badge, a per-agent right-click menu with a "Watch closely" toggle, mobile-friendly fallbacks.
5. **Mobile access** via Tailscale (recommended). Server listens on `0.0.0.0` when `policy.json.listenAddress = "0.0.0.0"`. UI applies touch-friendly fallbacks below a 768px viewport.

```
┌──────────────────────────────────────────────────────────────┐
│  Claude Code session (per terminal)                           │
│   └─ PreToolUse hook → POST /permission/request               │
└──────────────────────┬───────────────────────────────────────┘
                       │ HTTP (long-poll, ≤ 30s)
┌──────────────────────▼───────────────────────────────────────┐
│  pixel-agents server (Node/Express)                           │
│   ├─ Trigger ladder    ← risky-patterns.json (hot-reload)    │
│   ├─ Per-session state ← watch-list.json    (hot-reload)     │
│   ├─ Timeout policy    ← policy.json        (hot-reload)     │
│   ├─ Pending requests Map (in-memory)                         │
│   └─ WS broadcast → all connected browsers                    │
└──────────────────────┬───────────────────────────────────────┘
                       │ WebSocket
┌──────────────────────▼───────────────────────────────────────┐
│  Browser (desktop or Tailscale-reachable mobile)              │
│   ├─ Permission modal (per-tool presets + custom feedback)   │
│   ├─ Pending queue badge                                      │
│   ├─ Per-agent "Watch closely" right-click toggle             │
│   └─ Mobile sheet variant + tap-instead-of-hover              │
└───────────────────────────────────────────────────────────────┘
```

## Trigger Ladder

The server runs each `/permission/request` through this ladder, top to bottom, stops at the first match.

| Rung | Condition | Verdict |
|------|-----------|---------|
| 1 | `toolName ∈ READONLY_TOOLS` (Read, Grep, Glob, WebFetch, WebSearch, Task, AskUserQuestion, Task* helpers) | `allow` immediately |
| 2 | `sessionId ∈ watchList` | fire modal |
| 3 | `sessionAllowlist[sessionId]` contains `toolName` (user previously picked "Allow this session") | `allow` immediately |
| 4 | Tool input matches any rule in `risky-patterns.json` | fire modal |
| 5 | (default) | `allow` immediately |

Plus two short-circuit rungs that take precedence over the modal-firing rungs:

- If `clients.size === 0` (no UI connected) → `allow` immediately, reason `no-ui`.
- If hook can't reach the server at all → exits 0 (allow) without any server involvement.

### Risky-pattern format

`~/.pixel-agents/risky-patterns.json` (ships with sane defaults; user edits live):

```json
{
  "Bash": [
    { "match": "\\brm\\s+-[a-z]*r", "label": "Recursive delete" },
    { "match": "\\bsudo\\b", "label": "sudo" },
    { "match": "\\bgit\\s+push\\s+(-f|--force)", "label": "Force push" },
    { "match": "\\bgit\\s+reset\\s+--hard", "label": "git reset --hard" },
    { "match": "\\bgit\\s+clean\\s+-[a-z]*f", "label": "git clean -f" },
    { "match": "\\b(npm|pnpm|yarn|bun)\\s+publish", "label": "Package publish" },
    { "match": "\\bcurl\\b[^|]*\\|\\s*(sh|bash|zsh)", "label": "Pipe-to-shell" },
    { "match": "DROP\\s+(TABLE|DATABASE|SCHEMA)", "label": "DROP" },
    { "match": "TRUNCATE\\s+TABLE", "label": "TRUNCATE" },
    { "match": "\\bdd\\s+if=", "label": "dd" }
  ],
  "filePathPatterns": [
    { "match": "/\\.env(\\.|$)", "label": ".env file" },
    { "match": "/\\.ssh/", "label": "SSH keys" },
    { "match": "id_rsa|id_ed25519", "label": "Private key" },
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

`Edit`, `Write`, `NotebookEdit` test their `file_path` against `filePathPatterns`. Any tool whose name matches `toolNamePatterns` gates regardless of input. Bash tests `command` against the `Bash` regex list.

The matched rule's `label` is shown in the modal so the user knows *why* this fired.

### Per-session watch list

`~/.pixel-agents/watch-list.json`:

```json
{ "watch": ["d7995736-...", "4de0fae0-..."] }
```

UI maintains this via right-click → "Watch closely" toggle on each sprite.

### Session allowlist (in-memory only)

Built up during the session as the user picks "Allow this session" from the modal. Cleared when the session disappears from `~/.claude/projects/` (matches existing watcher behaviour). Not persisted to disk by design — "this session" should reset between Claude Code restarts.

## Modal Layout & Response Presets

```
┌─ ! PERMISSION NEEDED — Agent #N · <project> ─────[ × ]─┐
│                                                          │
│  $ latest message:                                       │
│   ┌────────────────────────────────────────────────────┐ │
│   │ Let me check the current branch first before…     │ │
│   │ [last assistant text, scrollable, ~6 lines max]   │ │
│   └────────────────────────────────────────────────────┘ │
│                                                          │
│  $ requesting permission for:                            │
│   ┌────────────────────────────────────────────────────┐ │
│   │ Bash · "Force push"                                │ │
│   │ git push --force origin reskin/timeline-day        │ │
│   └────────────────────────────────────────────────────┘ │
│                                                          │
│  $ choose a response:                                    │
│   [ Allow ]                                              │
│   [ Allow this session ]                                 │
│   [ Deny — push without --force instead ]                │
│   [ Deny — abort, ask me what to do ]                    │
│   [ Custom feedback… ]                                   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

`Custom feedback…` expands an inline textarea + Send button. Closes the modal on send.

### Response template config

`~/.pixel-agents/responses.json`:

```json
{
  "default": [
    { "label": "Allow",                "decision": "allow" },
    { "label": "Allow this session",   "decision": "allow", "scope": "session" },
    { "label": "Custom feedback…",     "decision": "deny",  "askForReason": true }
  ],
  "Bash": [
    { "label": "Allow",                "decision": "allow" },
    { "label": "Allow this session",   "decision": "allow", "scope": "session" },
    { "label": "Add --dry-run instead", "decision": "deny", "reason": "Re-run with --dry-run to preview only — do not actually execute." },
    { "label": "Skip this step",       "decision": "deny", "reason": "Skip this command and continue with the next task in the plan." },
    { "label": "Custom feedback…",     "decision": "deny", "askForReason": true }
  ],
  "Edit": [
    { "label": "Allow",                "decision": "allow" },
    { "label": "Allow this session",   "decision": "allow", "scope": "session" },
    { "label": "Show me the diff first","decision": "deny", "reason": "Print the proposed diff for this edit first — do not write yet." },
    { "label": "Custom feedback…",     "decision": "deny", "askForReason": true }
  ]
}
```

Rules:
- A button with `decision: "allow"` and no `scope` = "Allow once" — same as the terminal's option 1.
- A button with `decision: "allow"` and `scope: "session"` = adds the tool to the session allowlist.
- A button with `decision: "deny"` and `reason: "..."` = sends that text back to the agent as the deny reason.
- A button with `decision: "deny"` and `askForReason: true` = expands the inline textarea before sending.

## Multi-Agent UX

- Each agent with a pending request shows the orange `!` badge above their sprite.
- A floating badge in the canvas top-right reads `! N pending` when N ≥ 1. It pulses gently to draw attention.
- Click the floating badge → drawer opens listing every pending request: `Agent #N · project · tool · X seconds waiting`. Click any row to open that agent's modal.
- Only one modal renders at a time. Closing it (without responding) returns to the canvas; the badge stays.
- Each `requestId` is unique; verdicts are routed by `requestId` so two agents asking simultaneously don't get crossed wires.

## Failure Modes (Explicit)

| Scenario | Behaviour |
|----------|-----------|
| Server not running | Hook fails fast, exits 0 (allow). Indistinguishable from no install. |
| Server running, no browser tab | Server returns `allow` immediately on `no-ui` rung. |
| Browser tab open, no answer for 30s | Server resolves with `policy.json.defaultOnTimeout` (default `allow`). |
| Browser tab closed mid-wait (last tab) | WS disconnect → server resolves all pending with `defaultOnTimeout`. |
| Server crashes mid-wait | Hook's HTTP socket gets ECONNRESET → exits 0 (allow). |
| Two simultaneous risky calls from same session | Both held; user sees one modal, the other is in the queue badge. |
| Config file invalid JSON | Server keeps last good version, prints a warning, leaves trigger logic running. |
| Hook script absent / not executable | Hook event silently no-ops; Claude Code falls back to its normal permission flow. |

## Mobile Access

- Server reads `policy.json.listenAddress` (default `127.0.0.1`). Setting `0.0.0.0` makes it reachable from the LAN.
- Recommended deployment: install Tailscale on the Mac and on the phone. Phone visits `http://<mac-tailnet-name>:3456`. Document this in the README.
- UI tweaks at viewport ≤ 768px:
  - Modal becomes a full-height bottom sheet.
  - Per-agent activity panel triggers on tap (first tap shows panel, second tap on the sprite opens modal).
  - Pending queue is a swipe-up drawer instead of a top-right dropdown.
  - Buttons sized for touch (≥ 44px tap targets).
  - Pinch-to-zoom + one-finger pan on the canvas.

## Phase 2: Full Chat Injection (Spike)

A separate effort scheduled after Phase 1 ships. Goal: let the user type a fresh prompt to any agent from the web app.

Investigation steps in order:

1. **`claude -r <sessionId> "msg"` in a sub-process** while session is live in another terminal.
   - Best: message lands in session A's queue, ship as the chat mechanism.
   - Lock conflict: try `--print -r`. If still failing, abort.
   - Spawns a duplicate Claude: abort.
2. **AppleScript / `/dev/pts` keystroke injection** as a macOS-only fallback. Requires window-tracking heuristic.
3. **Switch to Agent SDK** — only if both above fail and the user explicitly opts in. Out of scope for Phase 1.

UI: a "Send message" button on each agent's hover overlay → inline composer → send. Same component on mobile.

## Testing

- **Unit:** trigger-ladder table tests, regex matchers (each shipped pattern + tricky negatives), config-file validators.
- **Integration:** simulated WS client, POST request → broadcast → POST respond, timeout flow with fake clock, hot-reload of all three config files.
- **Hook script:** subprocess invocation with mocked stdin JSON + a fixture HTTP server; assert exit codes and stderr.
- **Modal:** render with mock context, assert per-tool button rendering, click → fetch fired, "Custom feedback" expands textarea.
- **Manual smoke matrix:** three live Claude Code sessions, one watched + two not; verify gatekeeper fires only on watched + risky-pattern paths; verify "Allow this session" actually allowlists subsequent calls; verify timeout default-allow behaviour.

## File Layout (new + changed)

New:
- `~/.pixel-agents/hooks/permission-hook.js` *(already exists; will be replaced/updated)*
- `~/.pixel-agents/risky-patterns.json` *(default ships with the project, copied on first run)*
- `~/.pixel-agents/watch-list.json` *(empty default)*
- `~/.pixel-agents/policy.json` *(default `{ timeoutSec: 30, defaultOnTimeout: "allow", listenAddress: "127.0.0.1" }`)*
- `~/.pixel-agents/responses.json` *(default ships with the project, copied on first run)*
- `pixel-agents-standalone/server/permissionPolicy.ts` — trigger ladder + config loader.
- `pixel-agents-standalone/server/configWatcher.ts` — chokidar-based hot reload of all four config files.
- `pixel-agents-standalone/webview-ui/src/components/PendingQueue.tsx` — top-right badge + drawer.
- `pixel-agents-standalone/webview-ui/src/components/PermissionModal.tsx` — *(already exists; gets the per-tool preset rendering and inline reason composer)*.
- `pixel-agents-standalone/webview-ui/src/hooks/useWatchList.ts` — read/write watch list via server endpoints.

Changed:
- `pixel-agents-standalone/server/index.ts` — replace existing inline `/permission/request` + `/permission/respond` with calls into `permissionPolicy.ts`; bind to `policy.listenAddress`.
- `pixel-agents-standalone/server/types.ts` — add `agentPermissionRequest` payload fields (already partially done) plus `setWatchClosely` client → server message.
- `pixel-agents-standalone/webview-ui/src/hooks/useExtensionMessages.ts` — handle WS messages for queue updates and watch-list changes.
- `pixel-agents-standalone/webview-ui/src/App.tsx` — render PendingQueue and the new PermissionModal preset wiring.
- `pixel-agents-standalone/webview-ui/src/index.css` — mobile breakpoint styles.
- `README.md` — Tailscale setup instructions.

## Out of Scope for This Spec

- Logging / audit trail of permission decisions — could be added later as `~/.pixel-agents/audit.log`.
- Per-project config (only per-tool today). The user can always layer their own logic in `risky-patterns.json` since regex matches are the primitive.
- Authentication on the web app. LAN/Tailscale binding is sufficient for the user's threat model.
- Replacement of the existing hover-only ToolOverlay; that stays as is.

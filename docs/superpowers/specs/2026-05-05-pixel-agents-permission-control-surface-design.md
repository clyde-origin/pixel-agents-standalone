# Pixel-Agents Mobile Oversight & Control Surface — Design

**Status:** Draft. Approved through brainstorming on 2026-05-05.
**Author:** Clyde + Claude pairing session
**Scope:**
- **Phase 1** — Mobile-first oversight: portrait office reshape, PWA shell, per-desk activity cards, per-agent live feed, gatekeeper hook + modal with response presets, per-session watch toggle, Tailscale-friendly remote access.
- **Phase 2** — Full chat injection (proactively message a running session) — spike on `claude -r <session>` first, then decide.

## Summary

Today the user runs many concurrent Claude Code sessions across many terminals. The pixel-agents standalone web app already visualises every session as an agent on an office floor plan. This spec adds an oversight + control layer on top: a per-session "doorman" hook that lets the user approve, deny, or steer any agent that's about to do something risky — from any browser tab including mobile — without slowing down the agent's auto-mode flow on tools that don't need a human.

The previous attempt at this feature broke `git` in unrelated terminals because every non-readonly tool blocked on a modal click. This design corrects that by: (1) only firing the modal for explicit risky patterns or sessions the user opted in to watch, (2) returning `allow` immediately whenever no UI is connected, and (3) capping every blocked tool to a 30-second wait with a configurable default verdict.

## Goals

1. **Phone-first oversight surface.** Hold the phone in portrait, see every running agent at a glance, tap any sprite to see what they're doing, get pushed when they need input. Installable as a PWA so it lives on the home screen.
2. **Centralised control of N concurrent Claude Code terminals** from any browser tab (desktop or mobile). One source of truth for "what's happening + what needs me."
3. **Gatekeeper for risky tools** with a user-editable list — preserves the user's `defaultMode: "auto"` flow for everything else.
4. **Multi-choice responses** per tool (e.g. for Bash: "Allow", "Add `--dry-run`", "Skip step", "Custom feedback").
5. **Per-session "watch closely" mode** that surfaces *every* non-readonly tool from a chosen agent.
6. **Per-desk activity cards** so each running agent's project + plain-English current activity is visible without hovering.
7. **Per-agent live feed** so tapping a sprite gives a chat-like recent history of that session.
8. **Remote access** via Tailscale so monitoring works from outside the dev machine.
9. **Non-disruption guarantee:** when the system fails or the user is AFK, tools run normally — never block indefinitely, never break workflows in other terminals.

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
| 1 | `toolName ∈ READONLY_TOOLS` (Read, Grep, Glob, WebFetch, WebSearch, Task, AskUserQuestion, Task* helpers — hardcoded in `permissionPolicy.ts`, not user-editable) | `allow` immediately |
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

The buttons rendered in `$ choose a response:` come entirely from `responses.json` — the modal renders one button per entry in the matching tool's list (or `default` if no tool-specific list exists). The shipped defaults include "Custom feedback…" so users always have a freeform escape hatch unless they explicitly delete it. Buttons with `askForReason: true` expand an inline textarea + Send button before submitting; everything else is a one-click action that closes the modal immediately.

The "Watch closely" toggle is reachable via right-click (desktop) or long-press (mobile) on a sprite. Single-click on a sprite continues to behave as before — focuses that agent, and opens the modal if a request is pending.

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

## Portrait Office Reshape (9:16)

Current office is 30 cols × 24 rows (landscape). Phone-first means portrait — target ~9:16 aspect.

**New canvas: 20 cols × 36 rows** (≈ 9:16.2, close enough).

Vertical layout, top to bottom:

| Row range | Zone | Content |
|-----------|------|---------|
| 0 | Wall | Top boundary |
| 1 | — | Padding / decoration row |
| 2 | Chairs row A1 | 4 chairs at cols 2, 7, 12, 17 (face down toward desks below) |
| 3–4 | Desks row A1 | 4 desks (2-tile-wide), PCs at row 4 |
| 5 | Aisle | Walking row + per-desk activity card layer |
| 6 | Chairs row A2 | 4 chairs |
| 7–8 | Desks row A2 | 4 desks + PCs |
| 9 | Aisle | |
| 10 | Chairs row A3 | 4 chairs |
| 11–12 | Desks row A3 | 4 desks + PCs |
| 13 | Aisle | |
| 14 | Station chairs | 3 stations (cols 4, 10, 16) — Builds, Git, Review |
| 15–16 | Station desks | + PCs at row 16 |
| 17 | Transition | Whiteboards, decor — visual divider into lounge |
| 18–20 | Library aisle | Pacing zone for "thinking" agents |
| 21–34 | Lounge | Bookshelves on side walls (cols 1, 18), beanbag clusters around coffee tables, lamps, plants |
| 35 | Wall | Bottom boundary |

12 home desks (3 rows of 4) + 3 stations = 15 seats. Plenty of room for the typical 6–10 concurrent agents with overflow space.

The existing `~/.pixel-agents/layout.json` is regenerated; the previous landscape layout is backed up to `layout.before-portrait.json`.

## Per-Desk Activity Cards

Each desk's center monitor gets a small always-visible card directly below the screen:

```
 ┌──────┬──────┬──────┬──────┐
 │origin│ msf- │pixel-│ pawn │   ← project name (12px, accented)
 │ -one │ -lab │agents│      │
 │ Edit │ Push │Think │ Idle │   ← current activity (10px, dim)
 └──────┴──────┴──────┴──────┘
```

- **Project name** — derived from the agent assigned to that seat (same source as the existing `folderName` from the cwd parser). Empty if the desk is unoccupied.
- **Activity** — same plain-English string as the existing `prettyActivity` translator (e.g. "Editing page.tsx", "Pushing to git", "Thinking…", "Idle"). Updates live via WebSocket.
- **Permission state** — when the agent has a pending request, the card glows orange and a small `!` chevron replaces the activity line. Tapping the card opens the modal.

The cluster banner labels (BUILD / REFACTOR / SHIP / etc.) stay in their existing position above the cluster as a *category header* — the per-desk cards are the *live state*. Both layers visible simultaneously.

Card rendering reuses the existing HTML overlay positioning (similar to `DeskLabels.tsx`); animation cost is negligible.

## Per-Agent Live Feed (Tap a Sprite)

When the user taps a sprite (or hovers on desktop), a bottom sheet (mobile) / side panel (desktop ≥ 768px) slides in titled `Agent #N · <project>`. Contents:

- A scrollable list of cards, latest at the top, oldest at the bottom (most recent first).
- Each card represents one entry in a per-agent ring buffer maintained by the server:
  - **Assistant text turns** — show first ~120 chars + a "tap to expand" affordance.
  - **Tool call** — show "Editing page.tsx" / "Running: pnpm install" / etc. (same `prettyActivity` translator as the desk card). Status pill: green = done, amber = running, orange = pending permission.
  - **Tool result** — collapsed by default; tap expands to show stdout/stderr summary (first ~10 lines).
  - **System events** — turn ended, permission resolved, etc., as small dim entries.
- Auto-tails: as new entries arrive over WS, they fade in at the top.
- Header has: agent metadata (project, sessionId short hash, model), a "Watch closely" toggle, and a "Send message" button (Phase 2; disabled with tooltip in Phase 1).

The server keeps a per-agent ring buffer of the last **40 entries** in memory. Stored as `Array<FeedEntry>` on the `TrackedAgent`. Broadcast as `agentFeedAppend` and `agentFeedReset` WS messages so any number of clients stay in sync.

Storage cost: ~40 entries × ~500 bytes avg × 20 agents = ~400 KB peak. Negligible.

Past-history backfill on first connection: when a client connects (`webviewReady`), the server sends `agentFeedSnapshot` for every active agent (last 20 entries each). After that the client subscribes to the live append stream.

## Progressive Web App (PWA)

The web app becomes installable on iOS / Android home screens.

**Required:**
- `webview-ui/public/manifest.json` with `name`, `short_name: "Pixel Agents"`, `display: "standalone"`, theme/background colors matched to the office floor palette, `start_url: "/"`, `orientation: "portrait"`.
- App icons in `webview-ui/public/icons/` (192, 512, 1024 px — derived from a pixel-style sprite of the office).
- A minimal **service worker** (`webview-ui/public/sw.js`) with a network-first strategy for the WS endpoint and cache-first for static assets — gives instant load even on flaky cellular.
- `index.html` updated with `<link rel="manifest">`, `<meta name="theme-color">`, `<meta name="apple-mobile-web-app-capable" content="yes">`.
- An "Add to Home Screen" hint surfaced once per device on mobile after the first successful permission interaction (so the user understands the value before being prompted).

**Touch UX (already covered in §Mobile Access):**
- Modal becomes full-height bottom sheet on viewports ≤ 768px.
- Per-agent feed = bottom sheet (instead of side panel).
- Pinch-to-zoom + one-finger pan on canvas.
- Hover-only tooltips also fire on tap.
- Long-press on a sprite opens the right-click context menu (the "Watch closely" toggle).
- Tap targets ≥ 44px.

**Push notifications (out of scope for this spec but worth noting):** to wake the user when the app is backgrounded and a permission is pending, we'd need a push service (Web Push, requires VAPID keys, server-side push subscription). Defer; for now the user has to keep the tab open — Tailscale + iOS background tab limits make this acceptable for v1.

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

New (config & hooks):
- `~/.pixel-agents/hooks/permission-hook.js` *(already exists; will be replaced/updated)*
- `~/.pixel-agents/risky-patterns.json` *(default ships with the project, copied on first run)*
- `~/.pixel-agents/watch-list.json` *(empty default)*
- `~/.pixel-agents/policy.json` *(default `{ timeoutSec: 30, defaultOnTimeout: "allow", listenAddress: "127.0.0.1" }`)*
- `~/.pixel-agents/responses.json` *(default ships with the project, copied on first run)*

New (server):
- `pixel-agents-standalone/server/permissionPolicy.ts` — trigger ladder + config loader.
- `pixel-agents-standalone/server/configWatcher.ts` — chokidar-based hot reload of all four config files.
- `pixel-agents-standalone/server/feedBuffer.ts` — per-agent ring buffer + WS event emitters for the live feed.

New (frontend):
- `pixel-agents-standalone/webview-ui/src/components/PendingQueue.tsx` — top-right badge + drawer (or top-of-screen on mobile).
- `pixel-agents-standalone/webview-ui/src/components/AgentFeed.tsx` — bottom sheet / side panel showing the per-agent live feed.
- `pixel-agents-standalone/webview-ui/src/components/DeskActivityCard.tsx` — the per-desk project + activity card under each monitor.
- `pixel-agents-standalone/webview-ui/src/hooks/useWatchList.ts` — read/write watch list via server endpoints.
- `pixel-agents-standalone/webview-ui/src/hooks/useAgentFeeds.ts` — keep per-agent feed buffers in client state.

New (PWA + assets):
- `pixel-agents-standalone/webview-ui/public/manifest.json`
- `pixel-agents-standalone/webview-ui/public/sw.js` (service worker)
- `pixel-agents-standalone/webview-ui/public/icons/{192,512,1024}.png` (pixel-art office icon)

New (layout regeneration):
- `~/.pixel-agents/layout.before-portrait.json` (auto-backup of current landscape layout)
- `~/.pixel-agents/layout.json` regenerated to 20×36 portrait via the build script (`scripts/generate-portrait-layout.py` or similar; can also be a one-shot `node` script).

Changed (server):
- `pixel-agents-standalone/server/index.ts` — replace inline `/permission/request` + `/permission/respond` with calls into `permissionPolicy.ts`; bind to `policy.listenAddress`; integrate `feedBuffer.ts` so each parsed line that's user-visible (assistant text, tool start/done, system) appends to the agent's feed.
- `pixel-agents-standalone/server/types.ts` — add `agentPermissionRequest` payload fields (partially done), `setWatchClosely` client→server message, `agentFeedAppend` / `agentFeedSnapshot` / `agentFeedReset` server→client messages.
- `pixel-agents-standalone/server/parser.ts` — emit feed entries alongside existing WS events.

Changed (frontend):
- `pixel-agents-standalone/webview-ui/src/hooks/useExtensionMessages.ts` — handle queue/feed/watchlist messages.
- `pixel-agents-standalone/webview-ui/src/App.tsx` — render PendingQueue, AgentFeed sheet, hooked PermissionModal.
- `pixel-agents-standalone/webview-ui/src/components/DeskLabels.tsx` — keep cluster banner; add per-desk DeskActivityCard rendering for each occupied seat.
- `pixel-agents-standalone/webview-ui/src/index.css` — mobile breakpoint, sheet transitions, PWA-installed safe-area.
- `pixel-agents-standalone/webview-ui/index.html` — manifest link, theme-color, mobile-web-app-capable meta.
- `README.md` — PWA install instructions, Tailscale setup, configuration cookbook for the four `~/.pixel-agents/*.json` files.

## Out of Scope for This Spec

- Logging / audit trail of permission decisions — could be added later as `~/.pixel-agents/audit.log`.
- Per-project config (only per-tool today). The user can always layer their own logic in `risky-patterns.json` since regex matches are the primitive.
- Authentication on the web app. LAN/Tailscale binding is sufficient for the user's threat model.
- Replacement of the existing hover-only ToolOverlay; that stays as is.

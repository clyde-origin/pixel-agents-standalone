import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { JsonlWatcher, type WatchedFile } from "./watcher.js";
import { processTranscriptLine } from "./parser.js";
import {
  loadCharacterSprites,
  loadWallTiles,
  loadFloorTiles,
  loadFurnitureAssets,
  loadDefaultLayout,
} from "./assetLoader.js";
import type { TrackedAgent, ServerMessage } from "./types.js";
import {
  loadOrInitConfig,
  RISKY_PATH,
  RESPONSES_PATH,
  POLICY_PATH,
  WATCH_LIST_PATH,
  DEFAULT_RISKY,
  DEFAULT_RESPONSES,
  DEFAULT_POLICY,
  DEFAULT_WATCH_LIST,
  type RiskyPatterns,
  type PolicyConfig,
  type WatchList,
} from "./permissionConfig.js";
import { watchConfigFile } from "./configWatcher.js";
import { PermissionPolicy } from "./permissionPolicy.js";
import { FeedBuffer } from "./feedBuffer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3456", 10);
const IDLE_SHUTDOWN_MS = 600_000; // 10 minutes

// State
const agents = new Map<string, TrackedAgent>(); // sessionId -> agent
let nextAgentId = 1;
const clients = new Set<WebSocket>();
let lastActivityTime = Date.now();

// Load assets at startup
// In dev mode (tsx), __dirname is server/ so assets are at ../webview-ui/public/assets/
// In production (esbuild), __dirname is dist/ so assets are at ./public/assets/
const devAssetsRoot = join(__dirname, "..", "webview-ui", "public", "assets");
const prodAssetsRoot = join(__dirname, "public", "assets");
const assetsRoot = existsSync(devAssetsRoot) ? devAssetsRoot : prodAssetsRoot;

console.log(`[Server] Loading assets from: ${assetsRoot}`);

const characterSprites = loadCharacterSprites(assetsRoot);
const wallTiles = loadWallTiles(assetsRoot);
const floorTiles = loadFloorTiles(assetsRoot);
const furnitureAssets = loadFurnitureAssets(assetsRoot);

// Persistence directory
const persistDir = join(homedir(), ".pixel-agents");
const persistedLayoutPath = join(persistDir, "layout.json");
const persistedSeatsPath = join(persistDir, "agent-seats.json");

// Load layout: persisted first, then default
function loadLayout(): Record<string, unknown> | null {
  if (existsSync(persistedLayoutPath)) {
    try {
      const content = readFileSync(persistedLayoutPath, "utf-8");
      const layout = JSON.parse(content) as Record<string, unknown>;
      console.log(`[Server] Loaded persisted layout from ${persistedLayoutPath}`);
      return layout;
    } catch (err) {
      console.warn(`[Server] Failed to load persisted layout: ${err instanceof Error ? err.message : err}`);
    }
  }
  return loadDefaultLayout(assetsRoot);
}

function loadPersistedSeats(): Record<number, { palette: number; hueShift: number; seatId: string | null }> | null {
  if (existsSync(persistedSeatsPath)) {
    try {
      const content = readFileSync(persistedSeatsPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  return null;
}

let currentLayout = loadLayout();
const persistedSeats = loadPersistedSeats();

// Express app
const app = express();
app.use(express.json({ limit: "256kb" }));
// Serve production build
app.use(express.static(join(__dirname, "public")));

// ── Config bootstrap (creates ~/.pixel-agents/* on first run) ────────
let policyCfg: PolicyConfig = loadOrInitConfig(POLICY_PATH, DEFAULT_POLICY);
let riskyCfg: RiskyPatterns = loadOrInitConfig(RISKY_PATH, DEFAULT_RISKY);
let watchListCfg: WatchList = loadOrInitConfig(WATCH_LIST_PATH, DEFAULT_WATCH_LIST);
loadOrInitConfig(RESPONSES_PATH, DEFAULT_RESPONSES); // copy on first run; UI reads it

const policy = new PermissionPolicy(riskyCfg, new Set(watchListCfg.watch));

watchConfigFile(POLICY_PATH, DEFAULT_POLICY, (c) => { policyCfg = c });
watchConfigFile(RISKY_PATH, DEFAULT_RISKY, (c) => { riskyCfg = c; policy.updateConfig(c) });
watchConfigFile(WATCH_LIST_PATH, DEFAULT_WATCH_LIST, (c) => {
  watchListCfg = c
  policy.updateWatchList(new Set(c.watch))
  broadcast({ type: 'watchListUpdated', watch: c.watch })
});
watchConfigFile(RESPONSES_PATH, DEFAULT_RESPONSES, (c) => {
  broadcast({ type: "responsesLoaded", responses: c })
})

// ── Pending permission requests ──────────────────────────────────────
interface PendingPermission {
  requestId: string;
  agentId: number;
  sessionId: string;
  toolName: string;
  resolve: (verdict: { decision: "allow" | "deny"; reason?: string; scope?: "once" | "session" }) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}
const pendingPermissions = new Map<string, PendingPermission>();
let permissionRequestSeq = 1;

app.post("/permission/request", (req, res) => {
  const body = req.body as { sessionId?: string; toolName?: string; toolInput?: Record<string, unknown> };
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const toolName = typeof body.toolName === "string" ? body.toolName : "";
  const toolInput = body.toolInput && typeof body.toolInput === "object" ? body.toolInput : {};

  const verdict = policy.evaluate(sessionId, toolName, toolInput);
  if (verdict.allow) { res.json({ decision: "allow", reason: verdict.reason }); return }

  if (clients.size === 0) { res.json({ decision: "allow", reason: "no-ui" }); return }

  const agent = sessionId ? agents.get(sessionId) : null;
  if (!agent) { res.json({ decision: "allow", reason: "unknown-session" }); return }

  const requestId = `perm-${permissionRequestSeq++}-${Date.now()}`;
  const timeoutMs = Math.max(5_000, policyCfg.timeoutSec * 1000);
  const defaultDecision = policyCfg.defaultOnTimeout;

  const timeoutHandle = setTimeout(() => {
    if (pendingPermissions.has(requestId)) {
      pendingPermissions.delete(requestId);
      res.json({ decision: defaultDecision, reason: "timeout" });
      broadcast({ type: "agentPermissionResolved", requestId, decision: defaultDecision });
    }
  }, timeoutMs);

  pendingPermissions.set(requestId, {
    requestId, agentId: agent.id, sessionId, toolName, timeoutHandle,
    resolve: ({ decision, reason, scope }) => {
      clearTimeout(timeoutHandle);
      pendingPermissions.delete(requestId);
      if (decision === "allow" && scope === "session") policy.allowSession(sessionId, toolName);
      res.json({ decision, reason });
    },
  });

  broadcast({
    type: "agentPermissionRequest",
    id: agent.id,
    requestId,
    toolName,
    toolInput,
    lastAssistantText: agent.lastAssistantText || undefined,
    label: verdict.label,
  });
});

app.post("/permission/respond", (req, res) => {
  const body = req.body as { requestId?: string; decision?: string; reason?: string; scope?: string };
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const decisionRaw = typeof body.decision === "string" ? body.decision : "";
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  const scope: "once" | "session" = body.scope === "session" ? "session" : "once";
  if (decisionRaw !== "allow" && decisionRaw !== "deny") {
    res.status(400).json({ ok: false, error: "decision must be allow|deny" }); return;
  }
  const pending = pendingPermissions.get(requestId);
  if (!pending) { res.status(404).json({ ok: false, error: "no pending request" }); return }
  pending.resolve({ decision: decisionRaw as "allow" | "deny", reason, scope });
  broadcast({ type: "agentPermissionResolved", requestId, decision: decisionRaw as "allow" | "deny" });
  res.json({ ok: true });
});

app.post("/watch-list", (req, res) => {
  const body = req.body as { sessionId?: string; watch?: boolean };
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const watch = !!body.watch;
  if (!sessionId) { res.status(400).json({ ok: false, error: "sessionId required" }); return }
  const set = new Set(watchListCfg.watch);
  if (watch) set.add(sessionId); else set.delete(sessionId);
  watchListCfg = { watch: [...set] };
  policy.updateWatchList(set);
  writeFileSync(WATCH_LIST_PATH, JSON.stringify(watchListCfg, null, 2));
  broadcast({ type: 'watchListUpdated', watch: [...set] });
  res.json({ ok: true, watch: [...set] });
});

const server = createServer(app);

// WebSocket
const wss = new WebSocketServer({ server });

// Ping/pong heartbeat — keeps clients Set accurate for shutdown guard
const HEARTBEAT_INTERVAL_MS = 30_000;
setInterval(() => {
  for (const ws of clients) {
    if ((ws as unknown as Record<string, boolean>).__isAlive === false) {
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    (ws as unknown as Record<string, boolean>).__isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function sendInitialData(ws: WebSocket): void {
  // Send settings
  ws.send(JSON.stringify({ type: "settingsLoaded", soundEnabled: false }));

  // Send character sprites
  if (characterSprites) {
    ws.send(JSON.stringify({ type: "characterSpritesLoaded", characters: characterSprites.characters }));
  }

  // Send wall tiles
  if (wallTiles) {
    ws.send(JSON.stringify({ type: "wallTilesLoaded", sprites: wallTiles.sprites }));
  }

  // Send floor tiles (optional)
  if (floorTiles) {
    ws.send(JSON.stringify({ type: "floorTilesLoaded", sprites: floorTiles.sprites }));
  }

  // Send furniture assets (optional)
  if (furnitureAssets) {
    ws.send(
      JSON.stringify({
        type: "furnitureAssetsLoaded",
        catalog: furnitureAssets.catalog,
        sprites: furnitureAssets.sprites,
      }),
    );
  }

  // Send current watch-list once on connect (before existingAgents so the UI has it ready)
  ws.send(JSON.stringify({ type: 'watchListUpdated', watch: watchListCfg.watch }));

  // Send existing agents with persisted seat metadata
  const agentList = Array.from(agents.values());
  const agentIds = agentList.map((a) => a.id);
  const folderNames: Record<number, string> = {};
  const sessionIds: Record<number, string> = {};
  const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};
  for (const a of agentList) {
    folderNames[a.id] = a.projectName;
    sessionIds[a.id] = a.sessionId;
    if (persistedSeats?.[a.id]) {
      const s = persistedSeats[a.id];
      agentMeta[a.id] = { palette: s.palette, hueShift: s.hueShift, seatId: s.seatId ?? undefined };
    }
  }
  for (const a of agents.values()) {
    ws.send(JSON.stringify({ type: 'agentFeedSnapshot', id: a.id, entries: a.feedBuffer.snapshot() }))
  }
  ws.send(JSON.stringify({ type: "existingAgents", agents: agentIds, folderNames, sessionIds, agentMeta }));

  ws.send(JSON.stringify({
    type: "responsesLoaded",
    responses: loadOrInitConfig(RESPONSES_PATH, DEFAULT_RESPONSES),
  }))

  // Send layout (must come after existingAgents — the hook buffers agents until layout arrives)
  if (currentLayout) {
    ws.send(JSON.stringify({ type: "layoutLoaded", layout: currentLayout, version: 1 }));
  } else {
    // Send null layout to trigger default layout creation in the UI
    ws.send(JSON.stringify({ type: "layoutLoaded", layout: null, version: 0 }));
  }
}

wss.on("connection", (ws) => {
  (ws as unknown as Record<string, boolean>).__isAlive = true;
  ws.on("pong", () => { (ws as unknown as Record<string, boolean>).__isAlive = true; });
  clients.add(ws);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "webviewReady" || msg.type === "ready") {
        sendInitialData(ws);
      } else if (msg.type === "saveLayout") {
        try {
          mkdirSync(persistDir, { recursive: true });
          writeFileSync(persistedLayoutPath, JSON.stringify(msg.layout, null, 2));
          currentLayout = msg.layout as Record<string, unknown>;
          // Broadcast to other clients for multi-tab sync
          const data = JSON.stringify({ type: "layoutLoaded", layout: msg.layout, version: 1 });
          for (const client of clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(data);
            }
          }
        } catch (err) {
          console.error(`[Server] Failed to save layout: ${err instanceof Error ? err.message : err}`);
        }
      } else if (msg.type === "saveAgentSeats") {
        try {
          mkdirSync(persistDir, { recursive: true });
          writeFileSync(persistedSeatsPath, JSON.stringify(msg.seats, null, 2));
        } catch (err) {
          console.error(`[Server] Failed to save agent seats: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch {
      /* ignore invalid messages */
    }
  });

  ws.on("close", () => clients.delete(ws));
});

// Watcher
const watcher = new JsonlWatcher();

watcher.on("fileAdded", (file: WatchedFile) => {
  if (agents.has(file.sessionId)) return;
  lastActivityTime = Date.now();

  const agent: TrackedAgent = {
    id: nextAgentId++,
    sessionId: file.sessionId,
    projectDir: dirname(file.path),
    projectName: file.projectName,
    jsonlFile: file.path,
    fileOffset: 0,
    lineBuffer: "",
    activity: "idle",
    activeTools: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastActivityTime: Date.now(),
    lastAssistantText: "",
    feedBuffer: new FeedBuffer(40),
  };

  agents.set(file.sessionId, agent);
  broadcast({ type: "agentCreated", id: agent.id, folderName: agent.projectName, sessionId: file.sessionId });
  console.log(`Agent ${agent.id} joined: ${agent.projectName} (${file.sessionId.slice(0, 8)})`);
});

watcher.on("fileRemoved", (file: WatchedFile) => {
  const agent = agents.get(file.sessionId);
  if (!agent) return;

  agents.delete(file.sessionId);
  broadcast({ type: "agentClosed", id: agent.id });
  console.log(`Agent ${agent.id} left: ${agent.projectName}`);
});

watcher.on("line", (file: WatchedFile, line: string) => {
  const agent = agents.get(file.sessionId);
  if (!agent) return;
  lastActivityTime = Date.now();

  processTranscriptLine(line, agent, broadcast);
});

// Start
watcher.start();
server.listen(PORT, policyCfg.listenAddress, () => {
  console.log(`Pixel Agents server running at http://${policyCfg.listenAddress === "0.0.0.0" ? "<your-ip>" : policyCfg.listenAddress}:${PORT}`)
  console.log(`Watching ~/.claude/projects/ for active sessions...`)
});

// Idle shutdown — opt-in only. Standalone mode keeps the server alive so the
// browser tab can keep monitoring; set IDLE_SHUTDOWN=1 to restore the 10-min auto-exit.
if (process.env.IDLE_SHUTDOWN === "1") {
  setInterval(() => {
    if (agents.size === 0 && clients.size === 0 && Date.now() - lastActivityTime > IDLE_SHUTDOWN_MS) {
      console.log("No active sessions or clients for 10 minutes, shutting down...");
      watcher.stop();
      server.close();
      process.exit(0);
    }
  }, 30_000);
}

// Graceful shutdown
process.on("SIGINT", () => {
  watcher.stop();
  server.close();
  process.exit(0);
});

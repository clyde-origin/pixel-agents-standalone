import { useState, useEffect, useRef } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { OfficeLayout, ToolActivity, FeedEntry } from '../office/types.js'
import { extractToolName } from '../office/toolUtils.js'
import { migrateLayoutColors } from '../office/layout/layoutSerializer.js'
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js'
import { setFloorSprites } from '../office/floorTiles.js'
import { setWallSprites } from '../office/wallTiles.js'
import { setCharacterTemplates } from '../office/sprites/spriteData.js'
import { vscode } from '../vscodeApi.js'
import { playDoneSound, setSoundEnabled } from '../notificationSound.js'

export interface SubagentCharacter {
  id: number
  parentAgentId: number
  parentToolId: string
  label: string
}

export interface FurnitureAsset {
  id: string
  name: string
  label: string
  category: string
  file: string
  width: number
  height: number
  footprintW: number
  footprintH: number
  isDesk: boolean
  canPlaceOnWalls: boolean
  partOfGroup?: boolean
  groupId?: string
  canPlaceOnSurfaces?: boolean
  backgroundTiles?: number
}

export interface WorkspaceFolder {
  name: string
  path: string
}

export interface PermissionContext {
  toolName?: string
  toolInput?: Record<string, unknown>
  lastAssistantText?: string
  /** Set when a hook-driven permission request is pending — enables Allow/Deny in the modal. */
  requestId?: string
}

export interface ResponseTemplate {
  label: string
  decision: 'allow' | 'deny'
  scope?: 'once' | 'session'
  reason?: string
  askForReason?: boolean
}

export interface ExtensionMessageState {
  agents: number[]
  selectedAgent: number | null
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  subagentTools: Record<number, Record<string, ToolActivity[]>>
  subagentCharacters: SubagentCharacter[]
  layoutReady: boolean
  loadedAssets?: { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> }
  workspaceFolders: WorkspaceFolder[]
  /** Map of home-desk uid prefix (e.g. "home-0") → project name claimed at that desk. */
  homeDeskAssignments: Record<string, string>
  /** Per-agent rich context for the most recent pending permission. */
  permissionContexts: Record<number, PermissionContext>
  /** Preset response buttons keyed by tool name (with `default` fallback). */
  responses: Record<string, ResponseTemplate[]>
  /** Active pending permission requests across all agents (top-right queue badge). */
  pending: Array<{ agentId: number; folderName?: string; toolName?: string; label?: string; receivedAt: number; requestId: string }>
  /** Per-agent live feed entries (text turns, tool starts/dones, permission asks, system events). */
  agentFeeds: Record<number, FeedEntry[]>
}

const DESK_ASSIGNMENT_STORAGE_KEY = 'pixel-agents:home-desk-assignments'

/** Read claimed home desks from localStorage. Returns deskKey ("home-0") → projectName. */
function loadHomeDeskAssignments(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DESK_ASSIGNMENT_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>
  } catch { /* ignore */ }
  return {}
}

function saveHomeDeskAssignments(map: Record<string, string>): void {
  try {
    localStorage.setItem(DESK_ASSIGNMENT_STORAGE_KEY, JSON.stringify(map))
  } catch { /* storage full or disabled — ignore */ }
}

/** Number of home desks defined in the layout (uid prefix `home-N-…`). */
function listHomeDeskKeys(os: OfficeState): string[] {
  const keys = new Set<string>()
  for (const f of os.getLayout().furniture) {
    const m = /^(home-\d+)-/.exec(f.uid)
    if (m) keys.add(m[1])
  }
  return Array.from(keys).sort()
}

/** Look up (and claim if needed) the seat for an agent's home desk based on project name. */
function pickHomeSeatId(
  os: OfficeState,
  folderName: string | undefined,
  assignments: Record<string, string>,
): { seatId: string | null; updated: Record<string, string> } {
  if (!folderName) return { seatId: null, updated: assignments }
  const homeKeys = listHomeDeskKeys(os)
  if (homeKeys.length === 0) return { seatId: null, updated: assignments }

  // Already claimed for this project? Reuse the same desk (if its seat exists & is free).
  for (const key of homeKeys) {
    if (assignments[key] === folderName) {
      const seatId = `${key}-chair`
      const seat = os.seats.get(seatId)
      if (seat && !seat.assigned) return { seatId, updated: assignments }
      // Seat already taken (concurrent claim) — keep the assignment but spawn elsewhere.
      return { seatId: null, updated: assignments }
    }
  }

  // Claim the first unassigned home desk for this project.
  for (const key of homeKeys) {
    if (!assignments[key]) {
      const seatId = `${key}-chair`
      const seat = os.seats.get(seatId)
      if (seat && !seat.assigned) {
        const updated = { ...assignments, [key]: folderName }
        return { seatId, updated }
      }
    }
  }

  // All home desks claimed by other projects — fall back to the open seat pool.
  return { seatId: null, updated: assignments }
}

function saveAgentSeats(os: OfficeState): void {
  const seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {}
  for (const ch of os.characters.values()) {
    if (ch.isSubagent) continue
    seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId }
  }
  vscode.postMessage({ type: 'saveAgentSeats', seats })
}

export function useExtensionMessages(
  getOfficeState: () => OfficeState,
  onLayoutLoaded?: (layout: OfficeLayout) => void,
  isEditDirty?: () => boolean,
): ExtensionMessageState {
  const [agents, setAgents] = useState<number[]>([])
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null)
  const [agentTools, setAgentTools] = useState<Record<number, ToolActivity[]>>({})
  const [agentStatuses, setAgentStatuses] = useState<Record<number, string>>({})
  const [subagentTools, setSubagentTools] = useState<Record<number, Record<string, ToolActivity[]>>>({})
  const [subagentCharacters, setSubagentCharacters] = useState<SubagentCharacter[]>([])
  const [layoutReady, setLayoutReady] = useState(false)
  const [loadedAssets, setLoadedAssets] = useState<{ catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } | undefined>()
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([])
  const [homeDeskAssignments, setHomeDeskAssignments] = useState<Record<string, string>>(() => loadHomeDeskAssignments())
  const [permissionContexts, setPermissionContexts] = useState<Record<number, PermissionContext>>({})
  const [responses, setResponses] = useState<Record<string, ResponseTemplate[]>>({ default: [] })
  const [pending, setPending] = useState<Array<{ agentId: number; folderName?: string; toolName?: string; label?: string; receivedAt: number; requestId: string }>>([])
  const [agentFeeds, setAgentFeeds] = useState<Record<number, FeedEntry[]>>({})
  const homeDeskAssignmentsRef = useRef<Record<string, string>>(homeDeskAssignments)
  const updateHomeDeskAssignments = (next: Record<string, string>) => {
    homeDeskAssignmentsRef.current = next
    setHomeDeskAssignments(next)
    saveHomeDeskAssignments(next)
  }

  // Track whether initial layout has been loaded (ref to avoid re-render)
  const layoutReadyRef = useRef(false)

  useEffect(() => {
    // Buffer agents from existingAgents until layout is loaded
    let pendingAgents: Array<{ id: number; palette?: number; hueShift?: number; seatId?: string; folderName?: string }> = []

    const handler = (e: MessageEvent) => {
      const msg = e.data
      const os = getOfficeState()

      if (msg.type === 'layoutLoaded') {
        // Skip external layout updates while editor has unsaved changes
        if (layoutReadyRef.current && isEditDirty?.()) {
          console.log('[Webview] Skipping external layout update — editor has unsaved changes')
          return
        }
        const rawLayout = msg.layout as OfficeLayout | null
        const layout = rawLayout && rawLayout.version === 1 ? migrateLayoutColors(rawLayout) : null
        if (layout) {
          os.rebuildFromLayout(layout)
          onLayoutLoaded?.(layout)
        } else {
          // Default layout — snapshot whatever OfficeState built
          onLayoutLoaded?.(os.getLayout())
        }
        // Add buffered agents now that layout (and seats) are correct.
        // For each agent, prefer their project's home desk (claim one if needed).
        let assignments = homeDeskAssignmentsRef.current
        for (const p of pendingAgents) {
          let seatId = p.seatId
          if (!seatId) {
            const r = pickHomeSeatId(os, p.folderName, assignments)
            if (r.seatId) seatId = r.seatId
            assignments = r.updated
          }
          os.addAgent(p.id, p.palette, p.hueShift, seatId, true, p.folderName)
        }
        if (assignments !== homeDeskAssignmentsRef.current) {
          updateHomeDeskAssignments(assignments)
        }
        pendingAgents = []
        layoutReadyRef.current = true
        setLayoutReady(true)
        if (os.characters.size > 0) {
          saveAgentSeats(os)
        }
      } else if (msg.type === 'agentCreated') {
        const id = msg.id as number
        const folderName = msg.folderName as string | undefined
        setAgents((prev) => (prev.includes(id) ? prev : [...prev, id]))
        setSelectedAgent(id)
        // Try to land them at their project's home desk.
        const { seatId, updated } = pickHomeSeatId(os, folderName, homeDeskAssignmentsRef.current)
        if (updated !== homeDeskAssignmentsRef.current) {
          updateHomeDeskAssignments(updated)
        }
        os.addAgent(id, undefined, undefined, seatId ?? undefined, undefined, folderName)
        saveAgentSeats(os)
      } else if (msg.type === 'agentClosed') {
        const id = msg.id as number
        setAgents((prev) => prev.filter((a) => a !== id))
        setSelectedAgent((prev) => (prev === id ? null : prev))
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentStatuses((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))

        // Release the agent's home-desk claim if no other agent of the same project is around.
        const departing = os.characters.get(id)
        const departingProject = departing?.folderName
        os.removeAgent(id)
        if (departingProject) {
          let stillThere = false
          for (const ch of os.characters.values()) {
            if (ch.id !== id && ch.folderName === departingProject) {
              stillThere = true
              break
            }
          }
          if (!stillThere) {
            const next = { ...homeDeskAssignmentsRef.current }
            let changed = false
            for (const [key, proj] of Object.entries(next)) {
              if (proj === departingProject) {
                delete next[key]
                changed = true
              }
            }
            if (changed) updateHomeDeskAssignments(next)
          }
        }
      } else if (msg.type === 'existingAgents') {
        const incoming = msg.agents as number[]
        const meta = (msg.agentMeta || {}) as Record<number, { palette?: number; hueShift?: number; seatId?: string }>
        const folderNames = (msg.folderNames || {}) as Record<number, string>
        // Buffer agents — they'll be added in layoutLoaded after seats are built
        for (const id of incoming) {
          const m = meta[id]
          pendingAgents.push({ id, palette: m?.palette, hueShift: m?.hueShift, seatId: m?.seatId, folderName: folderNames[id] })
        }
        setAgents((prev) => {
          const ids = new Set(prev)
          const merged = [...prev]
          for (const id of incoming) {
            if (!ids.has(id)) {
              merged.push(id)
            }
          }
          return merged.sort((a, b) => a - b)
        })
      } else if (msg.type === 'agentToolStart') {
        const id = msg.id as number
        const toolId = msg.toolId as string
        const status = msg.status as string
        setAgentTools((prev) => {
          const list = prev[id] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: [...list, { toolId, status, done: false }] }
        })
        const toolName = extractToolName(status)
        os.setAgentTool(id, toolName)
        os.setAgentActive(id, true)
        os.setAgentBetweenTools(id, false)  // a tool is now running
        os.clearPermissionBubble(id)
        // Create sub-agent character for Task tool subtasks
        if (status.startsWith('Subtask:')) {
          const label = status.slice('Subtask:'.length).trim()
          const subId = os.addSubagent(id, toolId)
          setSubagentCharacters((prev) => {
            if (prev.some((s) => s.id === subId)) return prev
            return [...prev, { id: subId, parentAgentId: id, parentToolId: toolId, label }]
          })
        }
      } else if (msg.type === 'agentToolDone') {
        const id = msg.id as number
        const toolId = msg.toolId as string
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          const newList = list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t))
          // If this was the last active tool, mark the agent as "between tools" so the
          // trip system can start its think-time countdown.
          const stillActive = newList.some((t) => !t.done)
          if (!stillActive) {
            os.setAgentBetweenTools(id, true)
          }
          return { ...prev, [id]: newList }
        })
      } else if (msg.type === 'agentToolsClear') {
        const id = msg.id as number
        // Turn ended — clear think-timer so they don't immediately stand up next turn.
        os.setAgentBetweenTools(id, false)
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.setAgentTool(id, null)
        os.clearPermissionBubble(id)
      } else if (msg.type === 'agentSelected') {
        const id = msg.id as number
        setSelectedAgent(id)
      } else if (msg.type === 'agentStatus') {
        const id = msg.id as number
        const status = msg.status as string
        setAgentStatuses((prev) => {
          if (status === 'active') {
            if (!(id in prev)) return prev
            const next = { ...prev }
            delete next[id]
            return next
          }
          return { ...prev, [id]: status }
        })
        os.setAgentActive(id, status === 'active')
        if (status === 'waiting') {
          os.showWaitingBubble(id)
          playDoneSound()
        }
      } else if (msg.type === 'agentToolPermission') {
        const id = msg.id as number
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.done ? t : { ...t, permissionWait: true })),
          }
        })
        // Capture rich context (tool name, raw input, last assistant text) for the modal.
        const ctx: PermissionContext = {
          toolName: typeof msg.toolName === 'string' ? msg.toolName : undefined,
          toolInput: (msg.toolInput && typeof msg.toolInput === 'object')
            ? (msg.toolInput as Record<string, unknown>)
            : undefined,
          lastAssistantText: typeof msg.lastAssistantText === 'string' ? msg.lastAssistantText : undefined,
        }
        setPermissionContexts((prev) => ({ ...prev, [id]: ctx }))
        os.showPermissionBubble(id)
      } else if (msg.type === 'agentPermissionRequest') {
        // Hook-driven request — buttons in the modal can now actually answer.
        const id = msg.id as number
        const ctx: PermissionContext = {
          requestId: typeof msg.requestId === 'string' ? msg.requestId : undefined,
          toolName: typeof msg.toolName === 'string' ? msg.toolName : undefined,
          toolInput: (msg.toolInput && typeof msg.toolInput === 'object')
            ? (msg.toolInput as Record<string, unknown>)
            : undefined,
          lastAssistantText: typeof msg.lastAssistantText === 'string' ? msg.lastAssistantText : undefined,
        }
        setPermissionContexts((prev) => ({ ...prev, [id]: ctx }))
        // Also surface the bubble + permissionWait flag so the sprite shows "!" and the
        // RESPOND? button appears even before the heuristic timer would have fired.
        setAgentTools((prev) => {
          const list = prev[id] || []
          // Add a synthetic "tool" entry tied to this requestId so existing logic shows the !
          const synth = { toolId: ctx.requestId ?? `req-${Date.now()}`, status: ctx.toolName ?? 'pending', done: false, permissionWait: true }
          if (list.some((t) => t.toolId === synth.toolId)) return prev
          return { ...prev, [id]: [...list, synth] }
        })
        os.showPermissionBubble(id)
        setPending((prev) => {
          if (ctx.requestId === undefined) return prev
          if (prev.some((p) => p.requestId === ctx.requestId)) return prev
          return [...prev, {
            agentId: id,
            folderName: os.characters.get(id)?.folderName,
            toolName: ctx.toolName,
            label: typeof (msg as any).label === 'string' ? (msg as any).label : undefined,
            receivedAt: Date.now(),
            requestId: ctx.requestId,
          }]
        })
      } else if (msg.type === 'agentPermissionResolved') {
        const requestId = msg.requestId as string
        // Clear any modal context that still references this requestId
        setPermissionContexts((prev) => {
          let changed = false
          const next: typeof prev = {}
          for (const [k, v] of Object.entries(prev)) {
            if (v.requestId === requestId) {
              changed = true
              continue
            }
            next[Number(k)] = v
          }
          return changed ? next : prev
        })
        // Clear the synthetic tool entry from agentTools and the permission bubble
        setAgentTools((prev) => {
          let changed = false
          const next: typeof prev = {}
          for (const [k, list] of Object.entries(prev)) {
            const filtered = list.filter((t) => t.toolId !== requestId)
            if (filtered.length !== list.length) {
              changed = true
              if (filtered.length === 0) continue
            }
            next[Number(k)] = filtered
          }
          return changed ? next : prev
        })
        setPending((prev) => prev.filter((p) => p.requestId !== requestId))
      } else if (msg.type === 'subagentToolPermission') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        // Show permission bubble on the sub-agent character
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          os.showPermissionBubble(subId)
        }
      } else if (msg.type === 'agentToolPermissionClear') {
        const id = msg.id as number
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          const hasPermission = list.some((t) => t.permissionWait)
          if (!hasPermission) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.permissionWait ? { ...t, permissionWait: false } : t)),
          }
        })
        setPermissionContexts((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        os.clearPermissionBubble(id)
        // Also clear permission bubbles on all sub-agent characters of this parent
        for (const [subId, meta] of os.subagentMeta) {
          if (meta.parentAgentId === id) {
            os.clearPermissionBubble(subId)
          }
        }
      } else if (msg.type === 'subagentToolStart') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        const status = msg.status as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id] || {}
          const list = agentSubs[parentToolId] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: { ...agentSubs, [parentToolId]: [...list, { toolId, status, done: false }] } }
        })
        // Update sub-agent character's tool and active state
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          const subToolName = extractToolName(status)
          os.setAgentTool(subId, subToolName)
          os.setAgentActive(subId, true)
        }
      } else if (msg.type === 'subagentToolDone') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs) return prev
          const list = agentSubs[parentToolId]
          if (!list) return prev
          return {
            ...prev,
            [id]: { ...agentSubs, [parentToolId]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)) },
          }
        })
      } else if (msg.type === 'subagentClear') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs || !(parentToolId in agentSubs)) return prev
          const next = { ...agentSubs }
          delete next[parentToolId]
          if (Object.keys(next).length === 0) {
            const outer = { ...prev }
            delete outer[id]
            return outer
          }
          return { ...prev, [id]: next }
        })
        // Remove sub-agent character
        os.removeSubagent(id, parentToolId)
        setSubagentCharacters((prev) => prev.filter((s) => !(s.parentAgentId === id && s.parentToolId === parentToolId)))
      } else if (msg.type === 'characterSpritesLoaded') {
        const characters = msg.characters as Array<{ down: string[][][]; up: string[][][]; right: string[][][] }>
        console.log(`[Webview] Received ${characters.length} pre-colored character sprites`)
        setCharacterTemplates(characters)
      } else if (msg.type === 'floorTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} floor tile patterns`)
        setFloorSprites(sprites)
      } else if (msg.type === 'wallTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} wall tile sprites`)
        setWallSprites(sprites)
      } else if (msg.type === 'workspaceFolders') {
        const folders = msg.folders as WorkspaceFolder[]
        setWorkspaceFolders(folders)
      } else if (msg.type === 'settingsLoaded') {
        const soundOn = msg.soundEnabled as boolean
        setSoundEnabled(soundOn)
      } else if (msg.type === 'responsesLoaded') {
        setResponses(msg.responses as Record<string, ResponseTemplate[]>)
      } else if (msg.type === 'furnitureAssetsLoaded') {
        try {
          const catalog = msg.catalog as FurnitureAsset[]
          const sprites = msg.sprites as Record<string, string[][]>
          console.log(`📦 Webview: Loaded ${catalog.length} furniture assets`)
          // Build dynamic catalog immediately so getCatalogEntry() works when layoutLoaded arrives next
          buildDynamicCatalog({ catalog, sprites })
          setLoadedAssets({ catalog, sprites })
        } catch (err) {
          console.error(`❌ Webview: Error processing furnitureAssetsLoaded:`, err)
        }
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
    }
    window.addEventListener('message', handler)
    vscode.postMessage({ type: 'webviewReady' })
    return () => window.removeEventListener('message', handler)
  }, [getOfficeState])

  return { agents, selectedAgent, agentTools, agentStatuses, subagentTools, subagentCharacters, layoutReady, loadedAssets, workspaceFolders, homeDeskAssignments, permissionContexts, responses, pending, agentFeeds }
}

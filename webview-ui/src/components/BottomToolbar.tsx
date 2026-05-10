import { useState, useEffect, useRef } from 'react'
import { SettingsModal } from './SettingsModal.js'
import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js'
import { vscode } from '../vscodeApi.js'

interface BottomToolbarProps {
  isEditMode: boolean
  onOpenClaude: () => void
  onToggleEditMode: () => void
  isDebugMode: boolean
  onToggleDebugMode: () => void
  workspaceFolders: WorkspaceFolder[]
}

// Top-left column. Sits below ZoomControls (zoom +/- end ~88px from top).
const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 100,
  left: 8,
  zIndex: 'var(--pixel-controls-z)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 4,
}

// Toggle (chevron) — matches ZoomControls button shape: 40x40 square.
const toggleBtnBase: React.CSSProperties = {
  width: 40,
  height: 40,
  padding: 0,
  background: 'var(--pixel-bg)',
  color: 'var(--pixel-text)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: 'var(--pixel-shadow)',
}

// Expanded action buttons — 40 tall, auto width to fit labels.
const actionBtnBase: React.CSSProperties = {
  height: 40,
  padding: '0 12px',
  fontSize: '22px',
  color: 'var(--pixel-text)',
  background: 'var(--pixel-btn-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
  boxShadow: 'var(--pixel-shadow)',
  whiteSpace: 'nowrap',
}

const actionBtnActive: React.CSSProperties = {
  ...actionBtnBase,
  background: 'var(--pixel-active-bg)',
  border: '2px solid var(--pixel-accent)',
}

export function BottomToolbar({
  isEditMode,
  onOpenClaude,
  onToggleEditMode,
  isDebugMode,
  onToggleDebugMode,
  workspaceFolders,
}: BottomToolbarProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false)
  const [hoveredFolder, setHoveredFolder] = useState<number | null>(null)
  const folderPickerRef = useRef<HTMLDivElement>(null)

  // Close folder picker on outside click
  useEffect(() => {
    if (!isFolderPickerOpen) return
    const handleClick = (e: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node)) {
        setIsFolderPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isFolderPickerOpen])

  const hasMultipleFolders = workspaceFolders.length > 1

  const handleAgentClick = () => {
    if (hasMultipleFolders) {
      setIsFolderPickerOpen((v) => !v)
    } else {
      onOpenClaude()
    }
  }

  const handleFolderSelect = (folder: WorkspaceFolder) => {
    setIsFolderPickerOpen(false)
    vscode.postMessage({ type: 'openClaude', folderPath: folder.path })
  }

  return (
    <div style={panelStyle}>
      {/* Toggle chevron — always visible, square to match zoom buttons */}
      <button
        onClick={() => {
          setIsExpanded((v) => !v)
          if (isExpanded) setIsFolderPickerOpen(false)
        }}
        onMouseEnter={() => setHovered('toggle')}
        onMouseLeave={() => setHovered(null)}
        style={{
          ...toggleBtnBase,
          background: hovered === 'toggle' ? 'var(--pixel-btn-hover-bg)' : toggleBtnBase.background,
        }}
        title={isExpanded ? 'Hide menu' : 'Show menu'}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          style={{
            transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 120ms ease-out',
          }}
        >
          <polyline
            points="4,7 9,12 14,7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </button>

      {/* Expanded action buttons */}
      {isExpanded && (
        <>
          <div ref={folderPickerRef} style={{ position: 'relative' }}>
            <button
              onClick={handleAgentClick}
              onMouseEnter={() => setHovered('agent')}
              onMouseLeave={() => setHovered(null)}
              style={{
                ...actionBtnBase,
                background:
                  hovered === 'agent' || isFolderPickerOpen
                    ? 'var(--pixel-agent-hover-bg)'
                    : 'var(--pixel-agent-bg)',
                border: '2px solid var(--pixel-agent-border)',
                color: 'var(--pixel-agent-text)',
              }}
            >
              + Agent
            </button>
            {isFolderPickerOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: '100%',
                  marginLeft: 4,
                  background: 'var(--pixel-bg)',
                  border: '2px solid var(--pixel-border)',
                  borderRadius: 0,
                  boxShadow: 'var(--pixel-shadow)',
                  minWidth: 160,
                  zIndex: 'var(--pixel-controls-z)',
                }}
              >
                {workspaceFolders.map((folder, i) => (
                  <button
                    key={folder.path}
                    onClick={() => handleFolderSelect(folder)}
                    onMouseEnter={() => setHoveredFolder(i)}
                    onMouseLeave={() => setHoveredFolder(null)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 10px',
                      fontSize: '22px',
                      color: 'var(--pixel-text)',
                      background: hoveredFolder === i ? 'var(--pixel-btn-hover-bg)' : 'transparent',
                      border: 'none',
                      borderRadius: 0,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {folder.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={onToggleEditMode}
            onMouseEnter={() => setHovered('edit')}
            onMouseLeave={() => setHovered(null)}
            style={
              isEditMode
                ? actionBtnActive
                : {
                    ...actionBtnBase,
                    background: hovered === 'edit' ? 'var(--pixel-btn-hover-bg)' : actionBtnBase.background,
                  }
            }
            title="Edit office layout"
          >
            Layout
          </button>
          <button
            onClick={() => setIsSettingsOpen((v) => !v)}
            onMouseEnter={() => setHovered('settings')}
            onMouseLeave={() => setHovered(null)}
            style={
              isSettingsOpen
                ? actionBtnActive
                : {
                    ...actionBtnBase,
                    background: hovered === 'settings' ? 'var(--pixel-btn-hover-bg)' : actionBtnBase.background,
                  }
            }
            title="Settings"
          >
            Settings
          </button>
        </>
      )}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        isDebugMode={isDebugMode}
        onToggleDebugMode={onToggleDebugMode}
      />
    </div>
  )
}

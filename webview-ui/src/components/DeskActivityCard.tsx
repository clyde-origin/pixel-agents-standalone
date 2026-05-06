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

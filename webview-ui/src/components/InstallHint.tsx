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

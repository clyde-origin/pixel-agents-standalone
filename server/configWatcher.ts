import { watch } from 'chokidar'
import { readFileSync, existsSync } from 'node:fs'

/** Watch `path` for changes; whenever the file is rewritten (and parses as
 *  valid JSON), invoke `onChange` with the new config. Returns a stop fn. */
export function watchConfigFile<T>(
  path: string,
  fallback: T,
  onChange: (cfg: T) => void,
): () => void {
  // Initial read
  if (existsSync(path)) {
    try { onChange(JSON.parse(readFileSync(path, 'utf-8')) as T) }
    catch { onChange(fallback) }
  } else {
    onChange(fallback)
  }
  const watcher = watch(path, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 } })
  watcher.on('change', () => {
    try { onChange(JSON.parse(readFileSync(path, 'utf-8')) as T) }
    catch (err) {
      console.warn(`[pa] hot-reload: invalid JSON in ${path}, keeping previous config. ${err instanceof Error ? err.message : err}`)
    }
  })
  return () => { void watcher.close() }
}

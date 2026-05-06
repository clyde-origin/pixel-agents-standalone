#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

async function makeSquare(size, color) {
  const { PNG } = await import('pngjs')
  const png = new PNG({ width: size, height: size })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = color.r
    png.data[i + 1] = color.g
    png.data[i + 2] = color.b
    png.data[i + 3] = 255
  }
  return PNG.sync.write(png)
}

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'webview-ui', 'public', 'icons')
mkdirSync(out, { recursive: true })
const orange = { r: 255, g: 122, b: 26 }
for (const size of [192, 512, 1024]) {
  writeFileSync(join(out, `${size}.png`), await makeSquare(size, orange))
  console.log(`wrote ${size}.png`)
}

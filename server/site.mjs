// Where the questions come from: Prep Room's public export, static files on its CDN
// (preproom.ai/export/v1), kept in a cache on this machine. Reading them costs Prep Room
// nothing, and once a question is cached it works offline.
//
// PREPROOM_URL points the plugin at another copy of the site (a local dev server).
// PREPROOM_CACHE moves the cache.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const SITE = (process.env.PREPROOM_URL || 'https://preproom.ai').replace(/\/+$/, '')
const ROOT = process.env.PREPROOM_CACHE || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'preproom')
/** One cache per site, so a dev server's data never mixes with the real site's. */
export const CACHE = join(ROOT, new URL(SITE).host.replace(/[^\w.-]/g, '_'))

const HOUR = 3600e3
const DAY = 24 * HOUR

export class Offline extends Error {}

async function fetchCached(name, url, maxAgeMs, parse) {
  const file = join(CACHE, name)
  let old = null
  let fresh = false
  try {
    const s = await stat(file)
    old = await readFile(file, 'utf8')
    fresh = Date.now() - s.mtimeMs < maxAgeMs
  } catch {}
  if (old !== null && fresh) return parse(old)
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'prep-room-claude-plugin/1.0' }, signal: AbortSignal.timeout(20_000) })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const text = await r.text()
    const value = parse(text)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text)
    return value
  } catch (e) {
    if (old !== null) return parse(old)
    throw new Offline(`Prep Room could not be reached (${e?.message || e}). Check the connection and try again.`)
  }
}

const json = (t) => JSON.parse(t)
const text = (t) => t

/** Every question as one compact row (lib/export.ts ExportIndex on the site). */
export const loadIndex = () => fetchCached('index.json', `${SITE}/export/v1/index.json`, 12 * HOUR, json)

/** One question as its page shows it: never the hidden checks, never reference code. */
export const loadQuestion = (id) =>
  /^[\w-]{1,64}$/.test(id || '') ? fetchCached(`q/${id}.json`, `${SITE}/export/v1/q/${id}.json`, 7 * DAY, json) : Promise.resolve(null)

/** The cached copy of a question, where the pane reads hints from. */
export const questionCachePath = (id) => join(CACHE, 'q', `${id}.json`)

export const loadGuides = () => fetchCached('guides.json', `${SITE}/export/v1/guides.json`, DAY, json)

export const loadGuideHtml = (slug) =>
  /^[a-z0-9][a-z0-9-]{1,80}$/.test(slug || '') ? fetchCached(`guides/${slug}.html`, `${SITE}/guides-html/${slug}.html`, 7 * DAY, text) : Promise.resolve(null)

export const questionUrl = (id) => `${SITE}/q/${id}`
export const guideUrl = (slug) => `${SITE}/guides/${slug}`

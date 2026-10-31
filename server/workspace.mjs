// A question set up as files in the person's project: prep/<id>/ holds the task
// (README.md), the file they answer in, and .preproom.json, which says what the question
// is, how they are working on it and when they started. The Prep Room pane reads the same
// file, so Claude, the pane and the person all see one state.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LANG_FILE } from './engine.mjs'
import { questionUrl } from './site.mjs'
import { howItWorks, pickLanguage, questionMarkdown, starterOf } from './text.mjs'

export const PREP = 'prep'
export const STATE = '.preproom.json'

const exists = async (p) => { try { await readFile(p); return true } catch { return false } }

/** What the person answers in, and what it starts as. */
function answerFile(q, lang) {
  if (q.kind === 'fn') return { file: LANG_FILE[lang], start: starterOf(q, lang) }
  if (q.kind === 'sql') return { file: 'query.sql', start: '-- Write your query here.\n' }
  if (q.kind === 'files') {
    const edit = q.files.files.filter((f) => f.editable)
    const main = edit.find((f) => f.name === q.files.main) ?? edit[0]
    return { file: main?.name ?? q.files.main, start: main?.content ?? '' }
  }
  return { file: 'answer.md', start: `# ${q.title}\n\n` }
}

/**
 * Writes prep/<id>/. Work already there is kept: setting up the same question again
 * picks up where the person left off, in the language they used.
 */
export async function setUp(q, { language, mode = 'solo', cwd = process.cwd() } = {}) {
  const dir = join(cwd, PREP, q.id)
  await mkdir(dir, { recursive: true })
  const before = await readState(dir)
  const lang = q.kind === 'fn' ? pickLanguage(q, language ?? before?.language) : null
  const { file, start } = answerFile(q, lang)

  const answerPath = join(dir, file)
  const resumed = await exists(answerPath)
  if (!resumed) await writeFile(answerPath, start)
  if (q.kind === 'sql') await writeFile(join(dir, 'tables.sql'), q.sql.setup.trim() + '\n')
  if (q.kind === 'files') {
    for (const f of q.files.files) {
      if (f.name === file) continue
      const p = join(dir, f.name)
      if (!f.editable || !(await exists(p))) await writeFile(p, f.content)
    }
  }
  const how = howItWorks(q, file).map((l) => (l.startsWith('http') ? l : `- ${l}`)).join('\n')
  await writeFile(join(dir, 'README.md'), `${questionMarkdown(q)}\n\n## How this works\n\n${how}\n`)

  const state = {
    id: q.id,
    title: q.title,
    format: q.format,
    difficulty: q.difficulty,
    minutes: q.minutes,
    kind: q.kind,
    language: lang,
    file,
    dir: `${PREP}/${q.id}`,
    mode,
    startedAt: resumed && before?.startedAt && before.mode === mode ? before.startedAt : Date.now(),
    url: questionUrl(q.id),
  }
  await writeState(dir, state)
  return { state, resumed }
}

export async function readState(dir) {
  try { return JSON.parse(await readFile(join(dir, STATE), 'utf8')) } catch { return null }
}

export async function writeState(dir, state) {
  await writeFile(join(dir, STATE), JSON.stringify(state, null, 2) + '\n')
}

/** The question asked for, or the one the person touched last. */
export async function current(cwd = process.cwd(), id) {
  if (id) {
    const s = await readState(join(cwd, PREP, id))
    return s ? { state: s, dir: join(cwd, PREP, id) } : null
  }
  let names = []
  try { names = await readdir(join(cwd, PREP)) } catch { return null }
  let best = null
  for (const n of names) {
    const s = await readState(join(cwd, PREP, n))
    if (s && (!best || (s.touchedAt ?? s.startedAt) > (best.state.touchedAt ?? best.state.startedAt))) best = { state: s, dir: join(cwd, PREP, n) }
  }
  return best
}

export async function readAnswer(dir, state) {
  try { return await readFile(join(dir, state.file), 'utf8') } catch { return null }
}

export async function touch(dir, state, patch = {}) {
  const next = { ...state, ...patch, touchedAt: Date.now() }
  await writeState(dir, next)
  return next
}

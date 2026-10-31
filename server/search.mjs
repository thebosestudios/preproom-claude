// Picking questions from the index on this machine: the same token matching as the site's
// list (lib/data.ts filterIndex), with phrases relaxed the way assistants send them, and a
// different handful each time when nothing narrows it down. It never reports how many
// questions match: the picks are what matter.

const TRACKS = { ai: 'ai', 'ai-assisted engineering': 'ai', 'ai assisted': 'ai', agents: 'ai', sd: 'sd', 'system design': 'sd', design: 'sd', code: 'code', coding: 'code', algorithms: 'code' }
export const TRACK_NAME = { ai: 'AI-assisted engineering', sd: 'System design', code: 'Coding' }
const DIFF = new Set(['easy', 'medium', 'hard'])

const tokens = (s) => (s || '').toLowerCase().split(/[^a-z0-9#+]+/).filter((t) => t.length > 1)
const norm = (s) => s.trim().toLowerCase().replace(/['’]s\b/g, '').replace(/\s+/g, ' ')

const FILLER = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'in', 'on', 'and', 'or', 'how', 'what', 'why', 'when', 'is', 'are', 'do', 'does', 'i', 'me', 'my', 'about', 'with', 'question', 'questions', 'interview', 'explain', 'some', 'give', 'practice', 'problem', 'problems', 'one'])
function relaxed(q) {
  const words = tokens(q).filter((w) => !FILLER.has(w)).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
  const longest = [...words].sort((a, b) => b.length - a.length)[0]
  return [words.join(' '), longest].filter((t, i, all) => t && t !== q.toLowerCase() && all.indexOf(t) === i)
}

export function formatsOf(index) {
  return [...new Set(index.questions.map((q) => q.f))].sort()
}

/** A format as the site names it, from the words a person uses ("review the ai code"). Null when none matches. */
export function formatName(index, want) {
  const all = formatsOf(index)
  const w = norm(want)
  return all.find((f) => norm(f) === w) ?? all.find((f) => norm(f).includes(w)) ?? all.find((f) => w.includes(norm(f))) ?? null
}

function score(q, want) {
  if (!want.length) return 0
  const title = q.t.toLowerCase()
  const hay = `${title} ${q.f.toLowerCase()} ${q.c.toLowerCase()} ${q.s.join(' ')} ${q.co.join(' ').toLowerCase()}`
  let s = 0
  for (const w of want) {
    if (title.includes(w)) s += 3
    else if (hay.includes(w)) s += 1
    else return -1
  }
  const t = tokens(q.t).join(' ')
  const p = want.join(' ')
  return s + (t === p ? 300 : t.startsWith(p + ' ') ? 200 : ` ${t} `.includes(` ${p} `) ? 100 : 0)
}

function sample(list, n) {
  const idx = list.map((_, i) => i)
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[idx[i], idx[j]] = [idx[j], idx[i]]
  }
  return idx.slice(0, n).sort((a, b) => a - b).map((i) => list[i])
}

/**
 * Picks for a request. Returns { picks } or { problem } when a filter names nothing
 * (an unknown format or track), so the answer can say what does exist.
 */
export function findQuestions(index, f) {
  const n = Math.min(5, Math.max(1, Math.round(f.count ?? 3)))
  const track = f.track ? TRACKS[f.track.trim().toLowerCase()] : undefined
  if (f.track && !track) return { problem: `"${f.track}" is not a track. The tracks are AI-assisted engineering (ai), System design (sd) and Coding (code).` }
  const format = f.format ? formatName(index, f.format) : undefined
  if (format === null) return { problem: `There is no "${f.format}" format. The formats are: ${formatsOf(index).join(', ')}.` }
  const difficulty = f.difficulty && DIFF.has(f.difficulty.toLowerCase()) ? f.difficulty.toLowerCase() : undefined
  const company = f.company?.trim().toLowerCase().replace(/\s+style$/, '')
  const topic = f.topic?.trim().toLowerCase()
  const lang = f.language

  const base = index.questions.filter((q) =>
    (!track || q.r === track) &&
    (!difficulty || q.d === difficulty) &&
    (!format || q.f === format) &&
    (!company || q.co.some((c) => c.toLowerCase() === company)) &&
    (!topic || q.c.toLowerCase().includes(topic) || q.s.some((s) => s.replace(/-/g, ' ').includes(topic))) &&
    (!lang || (q.ls !== undefined && index.langSets[q.ls].includes(lang))))

  const ranked = (query) => {
    const want = tokens(query)
    return base.map((q) => ({ q, s: score(q, want) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.q)
  }
  let matches = f.query ? ranked(f.query) : base
  if (f.query) for (const r of relaxed(f.query)) { if (matches.length) break; matches = ranked(r) }
  if (!matches.length) return { picks: [] }
  const pool = f.query ? matches.slice(0, Math.max(n * 4, 12)) : matches
  return { picks: sample(pool, n) }
}

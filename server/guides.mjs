// Concept guides as text: the site's static guide pages, cut into their sections. The
// pictures and the controls stay on the site; the words come here.
import { guideUrl, loadGuideHtml, loadGuides } from './site.mjs'

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', le: '≤', ge: '≥', ne: '≠', times: 'x', middot: '·', hellip: '...', mdash: ', ', ndash: '-', rarr: 'to', larr: 'from' }
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') {
    const hex = e[1] === 'x' || e[1] === 'X'
    const n = parseInt(hex ? e.slice(2) : e.slice(1), hex ? 16 : 10)
    return Number.isFinite(n) ? String.fromCodePoint(n) : m
  }
  return ENTITIES[e.toLowerCase()] ?? m
})

/** A guide page's words: the title, its one-line idea, then each section's heading and text. */
export function guideText(html) {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|select|button|textarea|canvas)\b[\s\S]*?<\/\1>/gi, '')
  const inline = (s) => decode(s
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
  const title = inline(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1] || '')
  const intro = inline(/<p class="intuition"[^>]*>([\s\S]*?)<\/p>/i.exec(body)?.[1] || '')
  const sections = []
  for (const m of body.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/gi)) {
    const s = m[1]
    const heading = inline(/<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(s)?.[1] || '')
    const blocks = []
    for (const b of s.matchAll(/<(p|li|pre|h3)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const tag = b[1].toLowerCase()
      if (tag === 'pre') blocks.push('```\n' + decode(b[2].replace(/<[^>]+>/g, '')).trim() + '\n```')
      else if (tag === 'li') blocks.push('- ' + inline(b[2]))
      else if (tag === 'h3') blocks.push('### ' + inline(b[2]))
      else blocks.push(inline(b[2]))
    }
    const text = blocks.filter((x) => x && x !== '- ').join('\n\n')
    if (heading || text) sections.push({ heading, text })
  }
  return { title, intro, sections }
}

const words = (s) => (s || '').toLowerCase().split(/[^a-z0-9#+]+/).filter((w) => w.length > 1)

/** Guides for some words, best first; at most five. */
export async function findGuides(query) {
  const { guides } = await loadGuides()
  const want = words(query).filter((w) => !['guide', 'guides', 'explain', 'what', 'how', 'the'].includes(w))
  if (!want.length) return []
  return guides
    .map((g) => {
      const title = g.title.toLowerCase()
      const hay = `${title} ${g.excerpt.toLowerCase()} ${g.subjects.join(' ')} ${g.slug} ${g.topic.toLowerCase()}`
      let s = 0
      for (const w of want) s += title.includes(w) ? 3 : hay.includes(w) ? 1 : 0
      return { g, s }
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map((x) => x.g)
}

export async function guideBySlug(slug) {
  const { guides } = await loadGuides()
  return guides.find((g) => g.slug === slug) ?? null
}

/** One section of a guide (the first when none is asked for), with what comes next. */
export async function readGuide(slug, section) {
  const g = await guideBySlug(slug)
  if (!g) return null
  const html = await loadGuideHtml(slug)
  const { title, intro, sections } = guideText(html || '')
  const url = guideUrl(slug)
  if (!sections.length) return { title: title || g.title, text: intro || g.excerpt, next: null, total: 0, url, questions: g.questions }
  const i = Math.min(Math.max(1, Math.round(section || 1)), sections.length)
  const s = sections[i - 1]
  const lead = i === 1 && intro ? `${intro}\n\n` : ''
  return {
    title: title || g.title,
    text: `${lead}${s.heading ? `## ${s.heading}\n\n` : ''}${s.text}`,
    next: i < sections.length ? { number: i + 1, heading: sections[i].heading } : null,
    url,
    questions: g.questions,
  }
}

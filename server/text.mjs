// How a question reads, in the README the plugin writes and in what Claude is told.
// Plain words, the site's voice: no scores, no counts of what is left, no exclamation marks.
import { LANG_NAME, starterFor } from './engine.mjs'
import { questionUrl } from './site.mjs'

export const DIFF = { easy: 'Easy', medium: 'Medium', hard: 'Hard' }

export const MODES = {
  solo: 'Solo',
  mock: 'Mock interview',
  round: 'Assisted round',
  open: 'Open',
}

/** "Write code · Medium · 20 min · Amazon style". */
export function metaLine(q) {
  const format = q.format ?? q.f
  const diff = DIFF[q.difficulty ?? q.d]
  const minutes = q.minutes ?? q.m
  const style = (q.companies ?? q.co ?? [])[0]
  return [format, diff, `${minutes} min`, style ? `${style} style` : ''].filter(Boolean).join(' · ')
}

const value = (v) => JSON.stringify(v).replace(/,(?=\S)/g, ', ')

export function examplesBlock(q) {
  const name = q.fn?.signature.name ?? q.files?.fnName
  const cases = q.fn?.examples ?? q.files?.examples ?? []
  if (!name || !cases.length) return ''
  return cases.map((c) => `${name}(${c.args.map(value).join(', ')}) returns ${value(c.expect)}`).join('\n')
}

/** The language a question opens in: the one asked for when it runs in it, else Python, else its first. */
export function pickLanguage(q, wanted) {
  const offered = q.fn?.languages ?? []
  if (wanted && offered.includes(wanted)) return wanted
  return offered.includes('python') ? 'python' : offered[0]
}

export function starterOf(q, lang) {
  return starterFor({ signature: q.fn.signature, starter: q.fn.starter }, lang)
}

export const languageList = (q) => (q.fn?.languages ?? []).map((l) => LANG_NAME[l] || l).join(', ')

/** What the person writes in, for each kind of question. */
export function howItWorks(q, file) {
  const url = questionUrl(q.id)
  if (q.kind === 'written') {
    return [
      `Write your answer in ${file}, or just talk it through with Claude.`,
      'When you are done, ask Claude to compare it with the model answer and the checklist it is reviewed against.',
      `The question on preproom.ai: ${url}`,
    ]
  }
  if (q.kind === 'files' && q.format === "Review the AI's PR") {
    return [
      `Read pr.diff, then file your findings in ${file}.`,
      'On preproom.ai, Submit matches your findings to the planted defects by file and line. Ask Claude for the link, or press Submit in the Prep Room pane. Your findings go with you.',
      url,
    ]
  }
  const where = q.kind === 'sql' ? `Write your query in ${file}. The tables are in tables.sql.` : `Write your answer in ${file}.`
  return [
    where,
    'Ask Claude to run the examples, or press Run in the Prep Room pane. They run on this computer.',
    `When you trust it, submit it on preproom.ai, where the hidden checks are. Ask Claude for the link, or press Submit in the pane. Your code goes with you.`,
    url,
  ]
}

/** The question as markdown: title, details, the task and the examples. */
export function questionMarkdown(q) {
  const topic = q.topic && q.topic !== q.format ? ` · ${q.topic}` : ''
  const parts = [`# ${q.title}`, metaLine(q) + topic, q.text.trim()]
  const ex = examplesBlock(q)
  if (ex) parts.push(`## Examples\n\n${ex}`)
  return parts.join('\n\n')
}

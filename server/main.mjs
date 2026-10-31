#!/usr/bin/env node
// Prep Room's tools for Claude Code: an MCP server over stdio, with no dependencies.
// It finds questions in Prep Room's public export, sets one up as files in this project,
// runs the examples on this computer and makes the link that takes the work to
// preproom.ai, where the hidden checks are. It needs no account and costs Prep Room
// nothing: no code runs on its servers and no model is called on its side.
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LANG_NAME } from './engine.mjs'
import { findGuides, guideBySlug, readGuide } from './guides.mjs'
import { localLanguages, runExamples } from './runner.mjs'
import { findQuestions } from './search.mjs'
import { Offline, loadIndex, loadQuestion, questionUrl } from './site.mjs'
import { MODES, languageList, metaLine, pickLanguage, questionMarkdown, starterOf } from './text.mjs'
import { current, readAnswer, setUp, touch } from './workspace.mjs'

const VERSION = '1.0.0'

/** The project's folder: the client's first root when it names one (MCP roots), else where Claude Code started us. */
let rootDir = null
const cwd = () => rootDir || process.env.CLAUDE_PROJECT_DIR || process.cwd()

const INSTRUCTIONS = `Prep Room is interview practice for AI-assisted engineering, system design and coding. These tools find a question, set it up as files under prep/<id>/ in this project, run its examples on this computer, and make the link that takes the work to preproom.ai, where the hidden checks, saved progress and reference solutions are. Nothing here needs an account.

Each question has a mode, in prep/<id>/.preproom.json. Solo and mock: the answer file is the person's, so do not edit it; offer the next hint or a question instead. Assisted round: you are their assistant, so write what they ask for and let them direct and check it. Open: help however they like.

Let people try before you show an answer. Give hints one at a time. No scores. Company styles are estimates: say "Stripe style", never "asked at Stripe".`

// ---------------------------------------------------------------- helpers

const ALIASES = { 'c++': 'cpp', 'c#': 'csharp', js: 'javascript', node: 'javascript', ts: 'typescript', golang: 'go', py: 'python', python3: 'python', rs: 'rust', rb: 'ruby', kt: 'kotlin', 'f#': 'fsharp', lisp: 'commonlisp' }
function languageOf(s) {
  if (!s) return null
  const k = String(s).trim().toLowerCase()
  if (LANG_NAME[k]) return k
  if (ALIASES[k]) return ALIASES[k]
  return Object.entries(LANG_NAME).find(([, n]) => n.toLowerCase() === k)?.[0] ?? null
}

const b64url = (text) => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** The question's page with the person's work in the link (the site's handoff format, lib/handoff.ts). */
function siteLink(q, state, code) {
  const p = new URLSearchParams()
  p.set('code', b64url(code))
  if (q.kind === 'fn' && state.language) p.set('lang', state.language)
  if (q.kind === 'files') p.set('file', state.file)
  p.set('from', 'claude-code')
  return `${questionUrl(q.id)}#${p.toString()}`
}

class Note extends Error {}
const note = (text) => { throw new Note(text) }

async function question(id) {
  // The index knows every id, so a wrong one is answered without a download.
  const known = (await loadIndex()).questions.some((x) => x.id === id)
  const q = known ? await loadQuestion(id) : null
  if (!q) note(`No question has the id "${id}". Ids look like cod-g100 or sd-g001; find_questions lists some.`)
  return q
}

/** The question a tool means: the one named, or the one worked on last in this project. */
async function working(id) {
  const c = await current(cwd(), id)
  if (!c) note(id ? `${id} is not set up in this project yet. Start it first.` : 'No question is set up in this project yet. Start one first.')
  return { ...c, q: await question(c.state.id) }
}

const fmtCases = (cases) => cases.map((c) => {
  if (c.pass) return `${c.label}  pass`
  const lines = [`${c.label}  ${c.error ? 'raises' : 'does not match'}`, `  ${c.call}`, `  expected ${c.expected}`]
  lines.push(c.error ? `  ${c.error}` : `  got      ${c.got}`)
  return lines.join('\n')
}).join('\n')

// ---------------------------------------------------------------- the tools

const str = (description) => ({ type: 'string', description })
const ID = str('A question id, such as cod-g100.')
const OPT_ID = str('A question id. Leave it out for the question worked on last in this project.')

const TOOLS = [
  {
    name: 'find_questions',
    title: 'Find practice questions',
    description: 'Finds interview practice questions in AI-assisted engineering, system design and coding. Returns a few picks with their ids. Every filter is optional; with none, the picks vary.',
    readOnly: true,
    schema: {
      query: str('Words to look for, such as "rate limiter" or "binary search".'),
      track: { type: 'string', enum: ['ai', 'sd', 'code'], description: 'ai: AI-assisted engineering. sd: system design. code: coding, code review, on-call and SQL.' },
      format: str("A question format: Write code, Review the AI's code, Review the AI's PR, Vibe coding, Judgment call, Agent build, Design, On-call incident, Code review, SQL or Data frames."),
      difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
      company: str('A company style, such as Stripe or Google.'),
      topic: str('A topic, such as caching or dynamic programming.'),
      language: str('Only coding questions that run in this language, such as Python or Go.'),
      count: { type: 'integer', minimum: 1, maximum: 5, description: 'How many picks. Three by default.' },
    },
    async run(a) {
      const index = await loadIndex()
      const lang = a.language ? languageOf(a.language) : undefined
      if (a.language && !lang) return `"${a.language}" is not a language the coding questions run in.`
      const { picks, problem } = findQuestions(index, { ...a, language: lang })
      if (problem) return problem
      if (!picks.length) return `Nothing matches all of that. Try again with ${a.company ? 'no company' : a.query ? 'fewer words' : 'fewer filters'}.`
      const lines = picks.map((q, i) => `${i + 1}. ${q.t} (id: ${q.id})\n   ${metaLine(q)}${q.c && q.c !== q.f ? ` · ${q.c}` : ''}`)
      const style = a.company ? `\n\nCompany styles are estimated from the kind of question, not taken from real interviews: say "${a.company} style", never "asked at ${a.company}".` : ''
      return lines.join('\n') + style
    },
  },
  {
    name: 'get_question',
    title: 'Read a practice question',
    description: 'The full task for one question, its examples, and its starter code in a language when it is answered in code. Reading does not set it up in the project.',
    readOnly: true,
    schema: { id: ID, language: str('For coding questions: the language for the starter.') },
    required: ['id'],
    async run(a) {
      const q = await question(a.id)
      const parts = [questionMarkdown(q)]
      if (q.kind === 'fn') {
        const lang = pickLanguage(q, languageOf(a.language))
        const head = q.format === "Review the AI's code" && q.fn.starter?.[lang] ? "The assistant's version" : 'Starter'
        parts.push(`## ${head} (${LANG_NAME[lang]})\n\n\`\`\`${lang}\n${starterOf(q, lang).trimEnd()}\n\`\`\``)
        const here = localLanguages(q.fn.languages).map((l) => LANG_NAME[l])
        parts.push(`It runs in ${languageList(q)}. On this computer the examples can run in ${here.join(', ') || 'none of them, so they run on preproom.ai'}.`)
      } else if (q.kind === 'sql') {
        parts.push(`## Tables\n\n\`\`\`sql\n${q.sql.setup.trim()}\n\`\`\``)
      } else if (q.kind === 'files') {
        for (const f of q.files.files) parts.push(`## ${f.name}${f.editable ? ' (you edit this one)' : ''}\n\n\`\`\`\n${f.content.trimEnd()}\n\`\`\``)
      }
      parts.push(questionUrl(q.id))
      return parts.join('\n\n')
    },
  },
  {
    name: 'start_question',
    title: 'Set up a question in this project',
    description: 'Writes prep/<id>/ in this project: README.md with the task, the file the person answers in, and the question\'s state. Work already there is kept. The mode says how Claude helps: solo (the person works alone and gets hints), mock (a timed mock interview), round (an assisted round, where Claude is the assistant and the person leads) or open (Claude helps freely).',
    schema: { id: ID, language: str('For coding questions: the language to answer in.'), mode: { type: 'string', enum: ['solo', 'mock', 'round', 'open'], description: 'How Claude helps. Solo by default.' } },
    required: ['id'],
    async run(a) {
      const q = await question(a.id)
      const lang = languageOf(a.language)
      if (a.language && q.kind === 'fn' && (!lang || !q.fn.languages.includes(lang))) return `This question runs in ${languageList(q)}, not ${a.language}.`
      const { state, resumed } = await setUp(q, { language: lang, mode: a.mode || 'solo', cwd: cwd() })
      const lines = [`${state.dir}/ is ready. README.md has the task; the answer goes in ${state.dir}/${state.file}${state.language ? ` (${LANG_NAME[state.language]})` : ''}.`]
      if (resumed) lines.push(`Their earlier work in ${state.file} is still there.`)
      lines.push(`Mode: ${MODES[state.mode]}. ${state.minutes} minutes is the usual time for it.`)
      if (q.kind === 'fn') {
        const here = localLanguages([state.language]).length > 0
        lines.push(here ? 'The examples run on this computer.' : `This computer cannot run ${LANG_NAME[state.language]}, so the examples run on preproom.ai.`)
      }
      if (state.mode === 'solo' || state.mode === 'mock') lines.push(`Do not edit ${state.file} unless they hand it back.`)
      if (state.mode === 'round') lines.push('In this round you are their assistant: write what they ask for, and let them decide and check.')
      return { text: lines.join('\n'), data: { state } }
    },
  },
  {
    name: 'run_examples',
    title: 'Run the examples on this computer',
    description: "Runs the person's answer against the question's examples with this computer's own toolchain. The hidden checks are not here; they run on preproom.ai.",
    readOnly: true,
    schema: { id: OPT_ID },
    async run(a) {
      const { q, state, dir } = await working(a.id)
      const code = await readAnswer(dir, state)
      if (code === null) note(`${state.dir}/${state.file} is missing. Start the question again to write it.`)
      // An untouched starter has nothing to run, except in Review the AI's code, where the
      // starter is the assistant's version and running it is the first step.
      if (q.kind === 'fn' && q.format !== "Review the AI's code" && code.trim() === starterOf(q, state.language).trim()) {
        return { text: `${state.file} still holds the starter. Write an answer first, then run it.`, data: { id: q.id, status: 'starter' } }
      }
      const r = await runExamples(q, state, code)
      const link = siteLink(q, state, code)
      let text, data
      if (r.cannot) {
        text = `${r.cannot} It runs on preproom.ai with this code already in the editor:\n${link}`
        data = { id: q.id, status: 'elsewhere', url: link }
      } else if (r.problem) {
        text = `Ran with ${r.where} on this computer.\n\n${r.problem}`
        data = { id: q.id, status: 'problem', problem: r.problem, where: r.where }
      } else if (r.sql) {
        text = r.sql.pass
          ? `Ran with ${r.where}. Your rows match the expected result.\n\nThe hidden checks are on preproom.ai. This link opens it with the query in the editor:\n${link}`
          : `Ran with ${r.where}. ${r.sql.note}`
        data = { id: q.id, status: r.sql.pass ? 'pass' : 'fail', where: r.where }
      } else {
        const allPass = r.cases.every((c) => c.pass)
        text = `Ran with ${r.where} on this computer.\n\n${fmtCases(r.cases)}`
        if (r.printed) text += `\n\nWhat it printed:\n${r.printed.slice(0, 1500)}`
        text += allPass
          ? `\n\nThe examples pass. The hidden checks are on preproom.ai, and this link opens the question there with the code in the editor:\n${link}`
          : ''
        data = { id: q.id, status: allPass ? 'pass' : 'fail', where: r.where, cases: r.cases.map((c) => ({ label: c.label, pass: c.pass })) }
      }
      await touch(dir, state, { lastRun: { at: Date.now(), status: data.status } })
      return { text, data }
    },
  },
  {
    name: 'get_hint',
    title: 'Get the next hint',
    description: "One hint from the question's written hint ladder. Without a number, the next one after the last hint given here.",
    readOnly: true,
    schema: { id: OPT_ID, number: { type: 'integer', minimum: 1, maximum: 10, description: 'Which hint, starting at 1.' } },
    async run(a) {
      const c = await current(cwd(), a.id).catch(() => null)
      const q = c ? await question(c.state.id) : await question(a.id)
      const hints = q.hints || []
      if (!hints.length) return 'This question has no written hints. Ask what they have tried, and point at the part of the task they have not used yet.'
      const shown = c?.state.hintsShown ?? 0
      const n = Math.min(Math.max(1, a.number ?? shown + 1), hints.length)
      if (c) await touch(c.dir, c.state, { hintsShown: Math.max(shown, n) })
      const last = n === hints.length
      return { text: `Hint ${n}: ${hints[n - 1]}\n\n${last ? 'That was the last hint.' : 'There is another hint after this one.'}`, data: { id: q.id, number: n, hint: hints[n - 1], last } }
    },
  },
  {
    name: 'get_follow_ups',
    title: 'Get the follow-up questions',
    description: 'The questions an interviewer asks after a solve, each with a short good answer.',
    readOnly: true,
    schema: { id: OPT_ID },
    async run(a) {
      const { q } = a.id ? { q: await question(a.id) } : await working()
      if (!q.followups?.length) return 'This question has no written follow-ups. Ask how the answer changes if the input grows a hundred times, or what they would test first.'
      return `Ask these one at a time and keep the answers to yourself until they have tried.\n\n${q.followups.map((f, i) => `${i + 1}. ${f.q}\n   A good answer: ${f.a}`).join('\n\n')}`
    },
  },
  {
    name: 'get_model_answer',
    title: 'Read the model answer',
    description: 'The model answer in words, with the approaches, the common mistakes and what a strong answer covers. Coding questions come without their code.',
    readOnly: true,
    schema: { id: OPT_ID },
    async run(a) {
      const { q } = a.id ? { q: await question(a.id) } : await working()
      const parts = [`# Model answer: ${q.title}`, q.answer.trim() || 'There is no written answer for this one. The checklist below is what a strong answer covers.']
      if (q.algorithm?.length) parts.push(`## Steps\n\n${q.algorithm.map((s, i) => `${i + 1}. ${s}`).join('\n')}`)
      if (q.approaches?.length) parts.push(`## Approaches, weakest first\n\n${q.approaches.map((x) => `- ${x.name}${x.time ? ` (${x.time}${x.space ? ` time, ${x.space} space` : ''})` : ''}: ${x.idea}${x.limit ? ` ${x.limit}` : ''}`).join('\n')}`)
      if (q.pitfalls?.length) parts.push(`## Common mistakes\n\n${q.pitfalls.map((p) => `- ${p}`).join('\n')}`)
      const covers = q.checklist?.length ? q.checklist : q.requirements
      if (covers?.length) parts.push(`## What a strong answer covers\n\n${covers.map((c) => `- ${c}`).join('\n')}`)
      if (q.levels?.length) parts.push(`## What each level shows\n\n${q.levels.map((l) => `- ${l.level}: ${l.shows}`).join('\n')}`)
      if (q.kind === 'fn' || q.kind === 'sql') parts.push(`The reference solution in code comes with the Prep Room plan, on the question's page: ${questionUrl(q.id)}`)
      return parts.join('\n\n')
    },
  },
  {
    name: 'find_guides',
    title: 'Find concept guides',
    description: 'Short guides to the ideas behind the questions, such as union-find or rate limiting. Search by words, or give a question id for the guides that teach it.',
    readOnly: true,
    schema: { query: str('What the guide is about.'), question: str('A question id, for the guides that teach it.') },
    async run(a) {
      let guides
      if (a.question) {
        const q = await question(a.question)
        guides = (await Promise.all((q.guides || []).map((g) => guideBySlug(g.slug)))).filter(Boolean)
        if (!guides.length) return 'That question has no concept guide.'
      } else {
        guides = await findGuides(a.query || '')
        if (!guides.length) return a.query ? `No guide matches "${a.query}". Try a shorter phrase.` : 'Say what the guide should be about, such as "union find".'
      }
      return guides.map((g, i) => `${i + 1}. ${g.title} (slug: ${g.slug}) · ${g.minutes} min\n   ${g.excerpt}`).join('\n')
    },
  },
  {
    name: 'read_guide',
    title: 'Read a concept guide',
    description: 'A concept guide as text, one section at a time.',
    readOnly: true,
    schema: { slug: str("The guide's slug, such as union-find."), section: { type: 'integer', minimum: 1, maximum: 50, description: 'Which section, starting at 1.' } },
    required: ['slug'],
    async run(a) {
      const g = await readGuide(a.slug, a.section)
      if (!g) return `No guide has the slug "${a.slug}".`
      const next = g.next ? `Next: section ${g.next.number}${g.next.heading ? `, ${g.next.heading}` : ''}.` : 'That is the end of the guide.'
      return `# ${g.title}\n\n${g.text}\n\n${next} With its pictures: ${g.url}`
    },
  },
  {
    name: 'submit_on_site',
    title: 'Take the work to preproom.ai',
    description: "Makes a link that opens the question on preproom.ai with the person's answer file already in the editor, where the hidden checks run and progress is kept. The code travels inside the link; nothing is stored.",
    readOnly: true,
    schema: { id: OPT_ID },
    async run(a) {
      const { q, state, dir } = await working(a.id)
      const code = await readAnswer(dir, state)
      if (!code?.trim()) note(`${state.file} is empty, so there is nothing to take over yet.`)
      if (code.length > 30_000) return `${state.file} is too long to carry in a link. Open ${questionUrl(q.id)} and paste it in.`
      const url = siteLink(q, state, code)
      const doing = q.kind === 'written' ? 'compare it with the checklist and the model answer' : q.format === "Review the AI's PR" ? 'match the findings to the planted defects' : 'run the hidden checks'
      await touch(dir, state, { sentAt: Date.now() })
      return { text: `This link opens the question on preproom.ai with ${state.file} in the editor, ready to ${doing}. A free account keeps the progress.\n\n${url}`, data: { id: q.id, url } }
    },
  },
  {
    name: 'set_mode',
    title: 'Change how Claude helps',
    description: 'Switches the question between solo, mock, round and open. "Hand it back" from solo means open.',
    schema: { id: OPT_ID, mode: { type: 'string', enum: ['solo', 'mock', 'round', 'open'] } },
    required: ['mode'],
    async run(a) {
      const { state, dir } = await working(a.id)
      const next = await touch(dir, state, { mode: a.mode, ...(a.mode === 'round' && state.mode !== 'round' ? { startedAt: Date.now() } : {}) })
      const what = { solo: `${state.file} is theirs again, so stay out of it.`, mock: `Stay out of ${state.file} and play the interviewer.`, round: 'You are their assistant now.', open: 'Help however they ask.' }[a.mode]
      return { text: `Mode: ${MODES[a.mode]}. ${what}`, data: { state: next } }
    },
  },
  {
    name: 'end_round',
    title: 'End the round and read it back',
    description: "Ends a mock interview or an assisted round, and returns its log: the person's prompts, Claude's edits and the runs, with times. Use it to read the round back.",
    schema: { id: OPT_ID },
    async run(a) {
      const { q, state, dir } = await working(a.id)
      let log = []
      try {
        log = (await readFile(join(dir, '.round', 'log.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.at >= state.startedAt)
      } catch {}
      const next = await touch(dir, state, { mode: 'open', endedAt: Date.now() })
      const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
      const used = mmss(Date.now() - state.startedAt)
      const lines = log.map((e) => `${mmss(e.at - state.startedAt)}  ${e.what}`)
      const how = state.mode === 'round'
        ? 'Read the round back in three short notes, each tied to a moment above: Direction (how they framed and ordered the work), Verification (how they proved it: tests, edge cases, runs) and Judgment (what they accepted or turned down from you, and why). Use the model answer and its common mistakes as the reference. Plain and specific, no score.'
        : 'Ask the follow-ups one at a time, then say what they covered, the most important thing they missed, and what an interviewer would ask next. No score.'
      return { text: `${MODES[state.mode]} on ${q.title} ended after ${used} (the usual time is ${q.minutes} min).\n\n${lines.length ? lines.join('\n') : 'No log was kept here, so read it back from the conversation.'}\n\n${how}`, data: { state: next } }
    },
  },
]

// ---------------------------------------------------------------- the protocol

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')

function toolList() {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: { type: 'object', properties: t.schema, ...(t.required ? { required: t.required } : {}), additionalProperties: false },
    annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: false, idempotentHint: !!t.readOnly, openWorldHint: false },
  }))
}

async function callTool(name, args) {
  const t = TOOLS.find((x) => x.name === name)
  if (!t) return { content: [{ type: 'text', text: `There is no tool called ${name}.` }], isError: true }
  try {
    const out = await t.run(args || {})
    const { text, data } = typeof out === 'string' ? { text: out } : out
    return { content: [{ type: 'text', text }], ...(data ? { structuredContent: data } : {}) }
  } catch (e) {
    if (e instanceof Note || e instanceof Offline) return { content: [{ type: 'text', text: e.message }], isError: e instanceof Offline }
    process.stderr.write(`prep-room: ${name} failed: ${e?.stack || e}\n`)
    return { content: [{ type: 'text', text: `That did not work (${e?.message || e}).` }], isError: true }
  }
}

let clientHasRoots = false
const askRoots = () => { if (clientHasRoots) send({ jsonrpc: '2.0', id: 'roots', method: 'roots/list' }) }

async function handle(m) {
  if (!m || typeof m !== 'object') return
  // The client's answer to our roots/list: its first file root is the project.
  if (m.id === 'roots' && !m.method) {
    const uri = m.result?.roots?.find((r) => typeof r?.uri === 'string' && r.uri.startsWith('file://'))?.uri
    if (uri) { try { rootDir = fileURLToPath(uri) } catch {} }
    return
  }
  if (m.method === 'notifications/initialized' || m.method === 'notifications/roots/list_changed') return askRoots()
  if (m.id === undefined || m.id === null) return
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result })
  switch (m.method) {
    case 'initialize': {
      clientHasRoots = !!m.params?.capabilities?.roots
      const asked = m.params?.protocolVersion
      return reply({
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[1],
        capabilities: { tools: {} },
        serverInfo: { name: 'prep-room', title: 'Prep Room', version: VERSION },
        instructions: INSTRUCTIONS,
      })
    }
    case 'ping': return reply({})
    case 'tools/list': return reply({ tools: toolList() })
    case 'tools/call': return reply(await callTool(m.params?.name, m.params?.arguments))
    default: return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } })
  }
}

export { TOOLS, callTool, toolList }

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('main.mjs')) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let m
    try { m = JSON.parse(line) } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
    void handle(m)
  })
}

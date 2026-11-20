// The Prep Room mod for Claude Code: the question pane beside the transcript, the band
// above the prompt (the mode, the time left, Run and Submit), the solo guard on Claude's
// edits, and the log of a mock interview or assisted round. The pane draws in the terminal,
// the Desktop app's Code tab and VS Code; the band only where Claude Code raises one (the
// terminal and the Desktop app, not the VS Code panel), so the pane carries Run and Submit too. Everything it knows
// comes from the plugin's own tools and prep/<id>/.preproom.json: it stores nothing
// anywhere else and sends nothing anywhere.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { PreproomCurrent, PreproomHint, PreproomLogEntry, PreproomMode, PreproomRun } from '../types'

type Engine = EngineInterface

const PANE = 'prep-room'
const TOOL = 'mcp__plugin_preproom_prep-room__'
/** How /mcp may name the plugin's server; $.mcp.call takes either spelling. */
const SERVERS = ['plugin:preproom:prep-room', 'plugin_preproom_prep-room', 'prep-room']
const MODE: Record<PreproomMode, string> = { solo: 'Solo', mock: 'Mock interview', round: 'Assisted round', open: 'Open' }
const DIFF: Record<string, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' }

const current = atom({ plugin: 'preproom', key: 'current' } as const, null, { shape: 'current-1' })
const tab = atom({ plugin: 'preproom', key: 'tab' } as const, 'task')
const hints = atom({ plugin: 'preproom', key: 'hints' } as const, [] as PreproomHint[], { shape: 'hints-1' })
const run = atom({ plugin: 'preproom', key: 'run' } as const, null, { shape: 'run-1' })
const link = atom({ plugin: 'preproom', key: 'link' } as const, null)
const busy = atom({ plugin: 'preproom', key: 'busy' } as const, null)
const tick = atom({ plugin: 'preproom', key: 'tick' } as const, 0)
const log = atom({ plugin: 'preproom', key: 'log' } as const, [] as PreproomLogEntry[], { shape: 'log-1' })

// ---------------------------------------------------------------- reading what the tools wrote

type Saved = { id: string; title: string; format: string; difficulty: string; minutes: number; file: string; dir: string; mode: PreproomMode; startedAt: number; touchedAt?: number; url: string }

async function readSaved($: Engine, cwd: string, dir: string): Promise<Saved | null> {
  try { return JSON.parse(await $.fs.read(`${cwd}/${dir}/.preproom.json`)) as Saved } catch { return null }
}

/** The task as README.md has it, without the "How this works" notes at the end. */
async function readTask($: Engine, cwd: string, dir: string): Promise<string> {
  try {
    const md = await $.fs.read(`${cwd}/${dir}/README.md`)
    return md.split('\n## How this works')[0]!.replace(/^# .*\n+.*\n+/, '').trim()
  } catch { return '' }
}

/** The question asked for, or the one touched last in this project. */
async function loadCurrent($: Engine, id?: string): Promise<PreproomCurrent | null> {
  const cwd = await $.session.cwd()
  let saved: Saved | null = null
  if (id) saved = await readSaved($, cwd, `prep/${id}`)
  else {
    const entries = await $.fs.list(`${cwd}/prep`).catch(() => [])
    for (const en of entries) {
      if (en.kind !== 'dir') continue
      const s = await readSaved($, cwd, `prep/${en.name}`)
      if (s && (!saved || (s.touchedAt ?? s.startedAt) > (saved.touchedAt ?? saved.startedAt))) saved = s
    }
  }
  if (!saved) return null
  return {
    id: saved.id,
    title: saved.title,
    meta: [saved.format, DIFF[saved.difficulty] ?? saved.difficulty, `${saved.minutes} min`].join(' · '),
    mode: saved.mode,
    startedAt: saved.startedAt,
    minutes: saved.minutes,
    file: saved.file,
    dir: saved.dir,
    url: saved.url,
    task: await readTask($, cwd, saved.dir),
  }
}

// ---------------------------------------------------------------- small helpers

function textOf(r: unknown): string {
  if (!r) return ''
  if (typeof r === 'string') return r
  const o = r as { text?: unknown; content?: unknown; result?: unknown }
  if (typeof o.text === 'string') return o.text
  if (Array.isArray(o.content)) return o.content.map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('\n')
  if (o.result !== undefined) return textOf(o.result)
  return ''
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** "14 min left", "under a minute left", "3 min over"; nothing in open mode. */
function timeLeft(q: PreproomCurrent, now: number): string {
  if (q.mode === 'open') return ''
  const left = q.startedAt + q.minutes * 60_000 - now
  if (left >= 60_000) return `${Math.floor(left / 60_000)} min left`
  if (left > 0) return 'under a minute left'
  return `${Math.max(1, Math.round(-left / 60_000))} min over`
}

async function note($: Engine, at: number, what: string) {
  const q = await read($, current)
  if (!q || (q.mode !== 'round' && q.mode !== 'mock')) return
  const next = await update($, log, (l) => [...(l ?? []), { at, what }].slice(-400))
  // The round's log lives beside the question, on this computer only. end_round reads it.
  const cwd = await $.session.cwd()
  await $.fs.write(`${cwd}/${q.dir}/.round/log.jsonl`, (next ?? []).map((x) => JSON.stringify(x)).join('\n') + '\n').catch(() => {})
}

/** Tells Claude what the person did in the pane, so the conversation stays in step. */
async function tellClaude($: Engine, text: string) {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `(From the Prep Room pane) ${text}` }] } }).catch(() => {})
}

// ---------------------------------------------------------------- what a tool's answer changes

async function afterTool($: Engine, name: string, text: string) {
  const now = await $.clock.now()
  if (name === 'start_question' || name === 'set_mode' || name === 'end_round') {
    const before = await read($, current)
    const q = await loadCurrent($)
    await update($, current, () => q)
    if (name === 'start_question' && q && q.id !== before?.id) {
      await update($, hints, () => [])
      await update($, run, () => null)
      await update($, link, () => null)
      await update($, tab, () => 'task')
    }
    if (q && (name === 'start_question' || (name === 'set_mode' && before?.mode !== q.mode)) && (q.mode === 'round' || q.mode === 'mock')) {
      await update($, log, () => [])
      await note($, now, `${MODE[q.mode]} started`)
    }
    if (name === 'start_question') void $.ui.open({ id: PANE, title: 'Prep Room' })
  } else if (name === 'run_examples') {
    const lines = text.split('\n').filter((l) => l.trim() && !/^https?:\/\//.test(l.trim())).slice(0, 16)
    const pass = /The examples pass|rows match/.test(text) ? true : /does not match|raises|differs|not in your result|did not finish|without finishing/.test(text) ? false : null
    await update($, run, () => ({ at: now, pass, lines }))
    await update($, tab, () => 'run')
    const url = /https?:\/\/\S+#code=\S+/.exec(text)?.[0]
    if (url) await update($, link, () => url)
    const failed = lines.find((l) => /does not match|raises/.test(l))
    await note($, now, pass === true ? 'Run: the examples pass' : failed ? `Run: ${failed.trim()}` : `Run: ${clip(lines[1] ?? lines[0] ?? 'no result', 80)}`)
  } else if (name === 'get_hint') {
    const m = /^Hint (\d+): ([\s\S]*?)(\n\n|$)/.exec(text)
    if (m) {
      const n = Number(m[1])
      await update($, hints, (h) => ((h ?? []).some((x) => x.number === n) ? h ?? [] : [...(h ?? []), { number: n, text: m[2]!.trim() }].sort((a, b) => a.number - b.number)))
      await update($, tab, () => 'hints')
      await note($, now, `Hint ${n} opened`)
    }
  } else if (name === 'submit_on_site') {
    const url = /https?:\/\/\S+#code=\S+/.exec(text)?.[0]
    if (url) await update($, link, () => url)
    await note($, now, 'Took the answer to preproom.ai')
  }
}

/** Calls one of the plugin's own tools from the pane or the band. */
async function callTool($: Engine, name: string, args: Record<string, unknown> = {}): Promise<string> {
  let last: unknown
  for (const server of SERVERS) {
    try {
      const r = await $.mcp.call(server, name, args)
      const text = textOf(r)
      if (!r.isError) await afterTool($, name, text)
      return text
    } catch (e) { last = e }
  }
  throw last
}

async function act($: Engine, label: string, fn: () => Promise<void>) {
  if (await read($, busy)) return
  await update($, busy, () => label)
  try { await fn() } catch { $.ui.toast('Prep Room could not do that just now. Ask Claude instead.') } finally { await update($, busy, () => null) }
}

const pressRun = ($: Engine) => act($, 'Running the examples…', async () => {
  const text = await callTool($, 'run_examples')
  const first = text.split('\n').find((l) => /does not match|raises|The examples pass|rows match|cannot|no .* toolchain|still holds the starter/i.test(l))
  await tellClaude($, `The person ran the examples. ${first ? first.trim() : 'See the pane.'}`)
})

const pressSubmit = ($: Engine) => act($, 'Making the link…', async () => {
  const text = await callTool($, 'submit_on_site')
  const url = /https?:\/\/\S+#code=\S+/.exec(text)?.[0]
  if (url) {
    $.ui.toast('The preproom.ai link is ready in the pane.')
    await tellClaude($, 'The person made the link to submit on preproom.ai.')
  }
})

const pressHint = ($: Engine) => act($, 'Opening the next hint…', async () => {
  const text = await callTool($, 'get_hint')
  const m = /^Hint (\d+)/.exec(text)
  await tellClaude($, m ? `The person opened hint ${m[1]} in the pane.` : 'The person asked for a hint; this question has none written.')
})

const pressMode = ($: Engine, mode: PreproomMode, say: string) => act($, 'One moment…', async () => {
  await callTool($, 'set_mode', { mode })
  await tellClaude($, say)
})

// ---------------------------------------------------------------- the hooks

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'prep', description: 'Show the Prep Room pane' }).catch(() => {})
    const q = await loadCurrent($).catch(() => null)
    await update($, current, () => q)
    $.clock.every(30_000, () => { void update($, tick, (n) => (n ?? 0) + 1) })
    return next(e)
  })

  on('command.run', { command: 'prep' }, async ($) => {
    const q = await loadCurrent($).catch(() => null)
    if (q) await update($, current, () => q)
    const opened = await $.ui.open({ id: PANE, title: 'Prep Room' })
    if (!opened.isPlaced) return { text: q ? `Prep Room: ${q.title}. The pane cannot show here (${opened.reason}); the band above the prompt keeps the time.` : 'No question is set up yet. Ask Claude for one, or run /preproom:practice.' }
    return { text: q ? 'The Prep Room pane is open.' : 'The Prep Room pane is open. Ask Claude for a question, or run /preproom:practice.' }
  })

  // The person's own words go in the round's log; nothing leaves this computer.
  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta && !e.command && e.text.trim()) await note($, await $.clock.now(), `You: "${clip(e.text.trim().replace(/\s+/g, ' '), 140)}"`)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    // The solo guard: in solo and mock mode the answer file is the person's.
    if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
      const q = await read($, current)
      const path = String((e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path ?? '')
      const mine = !!q && (path === `${q.dir}/${q.file}` || path.endsWith(`/${q.dir}/${q.file}`))
      if (q && mine && (q.mode === 'solo' || q.mode === 'mock')) {
        return { deny: `${MODE[q.mode]} mode: ${q.file} is the person's until they hand it back. Offer the next hint, or ask what their code does on a small input.` }
      }
      const ran = await next(e)
      if (q && mine && !ran.deny && !ran.isError) await note($, await $.clock.now(), `Claude edited ${q.file}`)
      return ran
    }
    if (typeof e.tool === 'string' && e.tool.startsWith(TOOL)) {
      const ran = await next(e)
      if (!ran.deny && !ran.isError) await afterTool($, e.tool.slice(TOOL.length), textOf(ran)).catch(() => {})
      return ran
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // A broken guard must never lock a person out of their own files.

  // The band above the prompt: the mode, the time, and the two things people press most.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const q = await read($, current)
    if (!q || e.props.hasSurvey) return next(e)
    await read($, tick)
    const { Box, Text, Button } = $.ui.resolve(e)
    const left = timeLeft(q, await $.clock.now())
    const working = await read($, busy)
    return (
      <Box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
        <Text color="success" bold>{MODE[q.mode]}</Text>
        <Text dimColor wrap="truncate-end">{clip(q.title, 48)}</Text>
        {left ? <Text dimColor>{left}</Text> : null}
        {working ? <Text dimColor>{working}</Text> : null}
        <Button key="run" label="Run" onPress={() => void pressRun($)} />
        <Button key="submit" label="Submit" onPress={() => void pressSubmit($)} />
        {q.mode === 'solo' ? <Button key="back" label="Hand it back" onPress={() => void pressMode($, 'open', 'The person handed the answer file back: help however they ask.')} /> : null}
        {q.mode === 'round' || q.mode === 'mock' ? <Button key="end" label="End round" onPress={() => void $.prompt.submit({ text: 'End the round and read it back.' })} /> : null}
      </Box>
    )
  })

  // The pane: the task, the hints opened so far, the last run, and the link to the site.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown, Link } = $.ui.resolve(e)
    const q = await read($, current)
    if (!q) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>No question yet</Text>
          <Text dimColor>Ask Claude for one, such as "a medium coding question in Python", or run /preproom:practice.</Text>
        </Box>
      )
    }
    const view = await read($, tab)
    const shown = (await read($, hints)) ?? []
    const last: PreproomRun | null = await read($, run)
    const url = await read($, link)
    const working = await read($, busy)
    await read($, tick)
    const left = timeLeft(q, await $.clock.now())
    const tabButton = (key: 'task' | 'hints' | 'run', label: string) => (
      <Button key={`tab-${key}`} label={label} plain dimColor={view !== key} onPress={() => void update($, tab, () => key)} />
    )
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold wrap="wrap">{q.title}</Text>
          <Text dimColor wrap="wrap">{q.meta}</Text>
          <Text dimColor>{MODE[q.mode]}{left ? ` · ${left}` : ''}</Text>
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="pane-run" label="Run" variant="primary" onPress={() => void pressRun($)} />
          <Button key="pane-submit" label="Submit on preproom.ai" onPress={() => void pressSubmit($)} />
          {q.mode === 'solo' ? <Button key="pane-back" label="Hand it back" onPress={() => void pressMode($, 'open', 'The person handed the answer file back: help however they ask.')} /> : null}
        </Box>
        {working ? <Text dimColor>{working}</Text> : null}
        {url ? <Link href={url} label="Open it on preproom.ai, with your code" /> : null}
        <Box flexDirection="row" gap={2}>
          {tabButton('task', 'Task')}
          {tabButton('hints', 'Hints')}
          {tabButton('run', 'Run')}
        </Box>
        {view === 'task' ? <Markdown key="task" text={q.task || `The task is in ${q.dir}/README.md.`} /> : null}
        {view === 'hints' ? (
          <Box flexDirection="column" gap={1}>
            {shown.length ? shown.map((hint) => <Text key={`hint-${hint.number}`} wrap="wrap"><Text color="success" bold>Hint {String(hint.number)} </Text>{hint.text}</Text>) : <Text dimColor>No hints yet. Each one gives away a little more.</Text>}
            <Box><Button key="next-hint" label={shown.length ? 'Next hint' : 'First hint'} onPress={() => void pressHint($)} /></Box>
          </Box>
        ) : null}
        {view === 'run' ? (
          <Box flexDirection="column">
            {last ? last.lines.map((l, i) => <Text key={`run-${i}`} wrap="wrap" color={/\bpass\b|The examples pass|rows match/.test(l) ? 'success' : /does not match|raises|differs/.test(l) ? 'warning' : undefined} dimColor={/^\s/.test(l)}>{l}</Text>) : <Text dimColor>Run tries the examples on this computer. The hidden checks are on preproom.ai.</Text>}
          </Box>
        ) : null}
      </Box>
    )
  })
}

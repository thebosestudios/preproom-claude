import { expect, test, type TestBody } from 'claude-code/testing'

// One question set up in /proj, as the plugin's start_question leaves it.
const saved = (mode: string) => JSON.stringify({
  id: 'cod-g100', title: 'Count the days until a warmer day', format: 'Write code', difficulty: 'medium', minutes: 20,
  kind: 'fn', language: 'python', file: 'solution.py', dir: 'prep/cod-g100', mode, startedAt: Date.now() - 6 * 60_000, url: 'https://preproom.ai/q/cod-g100',
})
const README = '# Count the days until a warmer day\n\nWrite code · Medium · 20 min\n\nA weather app shows how long you wait for warmer weather.\n\n## How this works\n\n- Write your answer in solution.py.\n'

function project(on: Parameters<TestBody>[1], mode: string, writes: Record<string, string> = {}, toolText = '') {
  on('command.register', () => ({ value: { command: 'prep' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.list', () => ({ value: [{ name: 'cod-g100', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', (_, e) => {
    const path = String((e as { path?: unknown }).path)
    if (path.endsWith('.preproom.json')) return { value: saved(mode) }
    if (path.endsWith('README.md')) return { value: README }
    throw new Error('missing')
  })
  on('fs.write', (_, e) => { const w = e as { path?: unknown; text?: unknown }; writes[String(w.path)] = String(w.text); return { value: undefined } })
  on('tool.call', () => ({ result: {}, text: toolText }))
  on('prompt.submit', (_, e) => ({ text: (e as { text: string }).text }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.every', () => ({ value: undefined }))
}

const BAND = { plugin: 'preproom', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} } } as const
const PANE = { plugin: 'preproom', component: 'Pane', requestId: 'prep-room', props: { title: 'Prep Room', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

test('in solo mode Claude cannot edit the answer file, and can edit anything else', async ($, on) => {
  project(on, 'solo')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const denied = await $.tool.call({ tool: 'Edit', file_path: '/proj/prep/cod-g100/solution.py', old_string: 'pass', new_string: 'return []' })
  expect(denied.deny).toMatch(/Solo mode: solution\.py is the person's/)

  const other = await $.tool.call({ tool: 'Edit', file_path: '/proj/prep/cod-g100/notes.md', old_string: 'a', new_string: 'b' })
  expect(other.deny).toBeUndefined()
})

test('in an assisted round Claude may edit the answer file, and the round log keeps it', async ($, on) => {
  const writes: Record<string, string> = {}
  project(on, 'round', writes)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({ tool: 'Edit', file_path: '/proj/prep/cod-g100/solution.py', old_string: 'pass', new_string: 'return []' })
  expect(ran.deny).toBeUndefined()
  await $.prompt.submit({ text: 'Walk back from the newest send', wait: false, origin: { kind: 'composer' } })

  const logged = writes['/proj/prep/cod-g100/.round/log.jsonl'] ?? ''
  expect(logged).toMatch(/Claude edited solution\.py/)
  expect(logged).toMatch(/You: \\"Walk back from the newest send\\"/)
})

test('the band shows the mode, the time left, Run and Submit on every surface', async ($, on) => {
  project(on, 'solo')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^Solo$/ }))?.text).toBe('Solo')
    expect((await ui.find({ type: 'Text', text: /min left/ }))?.text).toMatch(/1[34] min left/)
    expect(await ui.find({ key: 'run' })).toBeDefined()
    expect(await ui.find({ key: 'submit' })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane shows the question and its task', async ($, on) => {
  project(on, 'solo')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Count the days/ }))?.text).toBe('Count the days until a warmer day')
    expect(await ui.find({ key: 'task' })).toBeDefined()
    expect(await ui.find({ key: 'pane-run' })).toBeDefined()
    await ui.unmount()
  }
})

test('with no question, the pane says how to get one', async ($, on) => {
  on('session.cwd', () => ({ value: '/empty' }))
  on('fs.list', () => { throw new Error('missing') })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No question yet/ }))?.text).toBe('No question yet')
  await ui.unmount()
})

test('a hint Claude opens reaches the pane and the round log', async ($, on) => {
  const writes: Record<string, string> = {}
  project(on, 'round', writes, 'Hint 1: Walk the list from the right.\n\nThere is another hint after this one.')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'mcp__plugin_preproom_prep-room__get_hint' })
  expect(writes['/proj/prep/cod-g100/.round/log.jsonl'] ?? '').toMatch(/Hint 1 opened/)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Walk the list from the right/ }))?.text).toMatch(/Walk the list/)
  await ui.unmount()
})

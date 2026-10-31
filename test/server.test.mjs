// The plugin's server, offline: a cache seeded from test/fixtures stands in for
// preproom.ai, so nothing here reaches the network. Run with `npm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const cache = mkdtempSync(join(tmpdir(), 'preproom-cache-'))
cpSync(join(here, 'fixtures'), join(cache, 'fixture.invalid'), { recursive: true })
process.env.PREPROOM_URL = 'https://fixture.invalid'
process.env.PREPROOM_CACHE = cache

const { findQuestions, formatName } = await import('../server/search.mjs')
const { loadIndex, loadQuestion } = await import('../server/site.mjs')
const { setUp, current } = await import('../server/workspace.mjs')
const { runExamples, which } = await import('../server/runner.mjs')

const STACK_PY = 'def daily_temperatures(temps):\n    ans = [0] * len(temps)\n    st = []\n    for i, t in enumerate(temps):\n        while st and temps[st[-1]] < t:\n            j = st.pop()\n            ans[j] = i - j\n        st.append(i)\n    return ans\n'

test('search finds by format words, track and language, and says what does not exist', async () => {
  const index = await loadIndex()
  assert.equal(formatName(index, "review the ai's pr"), "Review the AI's PR")
  assert.equal(formatName(index, 'review the ai pr'), "Review the AI's PR")
  const pr = findQuestions(index, { format: 'review the ai pr', count: 5 })
  assert.ok(pr.picks.length >= 1 && pr.picks.every((q) => q.f === "Review the AI's PR"))
  const go = findQuestions(index, { track: 'code', language: 'go', count: 5 })
  assert.ok(go.picks.every((q) => q.r === 'code' && index.langSets[q.ls].includes('go')))
  assert.match(findQuestions(index, { format: 'interpretive dance' }).problem, /no "interpretive dance" format/)
  assert.ok(findQuestions(index, { query: 'how to design a rate limiter' }).picks.length >= 1)
})

test('a question is set up as files, and work already there is kept', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'preproom-proj-'))
  const q = await loadQuestion('cod-g100')
  const { state, resumed } = await setUp(q, { language: 'python', mode: 'solo', cwd })
  assert.equal(resumed, false)
  assert.equal(state.file, 'solution.py')
  const readme = readFileSync(join(cwd, 'prep/cod-g100/README.md'), 'utf8')
  assert.match(readme, /daily_temperatures\(\[73, 74, 75/)
  assert.ok(!/hidden/i.test(JSON.stringify(q)), 'the export never holds hidden checks')
  writeFileSync(join(cwd, 'prep/cod-g100/solution.py'), STACK_PY)
  const again = await setUp(q, { language: 'python', mode: 'solo', cwd })
  assert.equal(again.resumed, true)
  assert.equal(readFileSync(join(cwd, 'prep/cod-g100/solution.py'), 'utf8'), STACK_PY)
  assert.equal((await current(cwd)).state.id, 'cod-g100')
})

test('the examples run on this computer and a wrong answer says which case', { skip: !which('python3') && 'no python3' }, async () => {
  const q = await loadQuestion('cod-g100')
  const ok = await runExamples(q, { language: 'python', file: 'solution.py' }, STACK_PY)
  assert.ok(ok.cases.every((c) => c.pass))
  const bad = await runExamples(q, { language: 'python', file: 'solution.py' }, STACK_PY.replace('< t', '<= t'))
  const failing = bad.cases.filter((c) => !c.pass)
  assert.equal(failing.length, 1)
  assert.equal(failing[0].got, '[3, 1, 1, 0]')
  const raised = await runExamples(q, { language: 'python', file: 'solution.py' }, 'def daily_temperatures(temps):\n    return temps[99]\n')
  assert.match(raised.cases[0].error, /IndexError.*\(line 2\)/)
})

test('JavaScript runs under the name the site uses', async () => {
  const q = await loadQuestion('cod-g100')
  const js = 'function daily_temperatures(t){const a=t.map(()=>0),s=[];t.forEach((x,i)=>{while(s.length&&t[s[s.length-1]]<x){const j=s.pop();a[j]=i-j}s.push(i)});return a}'
  const r = await runExamples(q, { language: 'javascript', file: 'solution.js' }, js)
  assert.ok(r.cases.every((c) => c.pass), JSON.stringify(r))
})

test('SQL compares rows with the expected result', { skip: !which('python3') && 'no python3' }, async () => {
  const q = await loadQuestion('sql-001')
  const right = await runExamples(q, { file: 'query.sql' }, 'SELECT e.name, d.name AS department FROM employee e JOIN department d ON d.id = e.department_id;')
  assert.equal(right.sql.pass, true, right.sql.note)
  const wrong = await runExamples(q, { file: 'query.sql' }, 'SELECT name FROM employee;')
  assert.equal(wrong.sql.pass, false)
})

function server(cwd) {
  const p = spawn(process.execPath, [join(here, '..', 'server', 'main.mjs')], { cwd, env: { ...process.env } })
  let buf = ''
  let id = 0
  const waits = new Map()
  p.stdout.on('data', (d) => {
    buf += d
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const m = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      waits.get(m.id)?.(m)
    }
  })
  const rpc = (method, params) => new Promise((r) => { const n = ++id; waits.set(n, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n') })
  return { rpc, call: async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result, close: () => p.kill() }
}

test('the MCP server speaks the protocol and every tool is marked', async () => {
  const s = server(mkdtempSync(join(tmpdir(), 'preproom-proj-')))
  try {
    const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.match(init.result.instructions, /hidden checks/)
    const { tools } = (await s.rpc('tools/list', {})).result
    assert.ok(tools.length >= 12)
    for (const t of tools) {
      assert.ok(t.title && t.description, t.name)
      assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name)
      assert.equal(t.annotations.destructiveHint, false, t.name)
    }
  } finally { s.close() }
})

test('the project folder comes from the client\'s roots when it has them', async () => {
  const project = mkdtempSync(join(tmpdir(), 'preproom-root-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'preproom-cwd-'))
  const p = spawn(process.execPath, [join(here, '..', 'server', 'main.mjs')], { cwd: elsewhere, env: { ...process.env } })
  let buf = ''
  const seen = []
  const done = new Promise((resolve) => {
    p.stdout.on('data', (d) => {
      buf += d
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const m = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        seen.push(m)
        if (m.method === 'roots/list') p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { roots: [{ uri: `file://${project}`, name: 'project' }] } }) + '\n')
        if (m.id === 2) p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'start_question', arguments: { id: 'cod-g100' } } }) + '\n')
        if (m.id === 3) resolve()
      }
    })
  })
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { roots: {} }, clientInfo: { name: 't', version: '1' } } }) + '\n')
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  setTimeout(() => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n'), 100)
  await done
  p.kill()
  assert.ok(seen.some((m) => m.method === 'roots/list'))
  assert.ok(existsSync(join(project, 'prep/cod-g100/README.md')))
  assert.ok(!existsSync(join(elsewhere, 'prep')))
})

test('a whole practice: start, run, hint, and the link that carries the code', { skip: !which('python3') && 'no python3' }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'preproom-proj-'))
  const s = server(cwd)
  try {
    const started = await s.call('start_question', { id: 'cod-g100', language: 'Python' })
    assert.match(started.content[0].text, /prep\/cod-g100\/ is ready/)
    assert.match(started.content[0].text, /Mode: Solo/)
    assert.match((await s.call('run_examples')).content[0].text, /still holds the starter/)
    writeFileSync(join(cwd, 'prep/cod-g100/solution.py'), STACK_PY)
    const ran = await s.call('run_examples')
    assert.match(ran.content[0].text, /The examples pass/)
    const h1 = await s.call('get_hint')
    const h2 = await s.call('get_hint')
    assert.match(h1.content[0].text, /^Hint 1:/)
    assert.match(h2.content[0].text, /^Hint 2:/)
    const link = (await s.call('submit_on_site')).content[0].text.match(/https:\S+#code=\S+/)[0]
    const frag = new URLSearchParams(link.split('#')[1])
    assert.equal(Buffer.from(frag.get('code'), 'base64url').toString('utf8'), STACK_PY)
    assert.equal(frag.get('lang'), 'python')
    assert.equal(frag.get('from'), 'claude-code')
    const missing = await s.call('get_question', { id: 'nope-1' })
    assert.match(missing.content[0].text, /No question has the id "nope-1"/)
    assert.ok(existsSync(join(cwd, 'prep/cod-g100/.preproom.json')))
  } finally { s.close() }
})

// A client may hand the model structuredContent in place of the text (Claude Code does),
// so the text has to be the whole answer and nothing else may be sent beside it.
test('every answer is plain text, and the text holds all of it', { skip: !which('python3') && 'no python3' }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'preproom-proj-'))
  const s = server(cwd)
  const call = async (name, args) => {
    const r = await s.call(name, args)
    assert.deepEqual(Object.keys(r).filter((k) => k !== 'isError'), ['content'], name)
    assert.equal(r.content[0].type, 'text', name)
    return r.content[0].text
  }
  try {
    assert.match(await call('start_question', { id: 'cod-g100', language: 'Python', mode: 'round' }), /you are their assistant/)
    writeFileSync(join(cwd, 'prep/cod-g100/solution.py'), STACK_PY.replace('< t', '<= t').replace('    ans = [0]', '    print("looking")\n    ans = [0]'))
    const failed = await call('run_examples')
    assert.match(failed, /does not match/)
    assert.match(failed, /expected \[1, 1, 0\]|expected /)
    assert.match(failed, /got {6}\[/)
    assert.match(failed, /What it printed:\n[\s\S]*looking/)
    assert.match(await call('get_hint'), /^Hint 1: /)
    assert.match(await call('set_mode', { mode: 'round' }), /You are their assistant/)
    mkdirSync(join(cwd, 'prep/cod-g100/.round'), { recursive: true })
    writeFileSync(join(cwd, 'prep/cod-g100/.round/log.jsonl'), JSON.stringify({ at: Date.now() + 1000, what: 'You: "start with a stack"' }) + '\n')
    const ended = await call('end_round')
    assert.match(ended, /You: "start with a stack"/)
    assert.match(ended, /Direction[\s\S]*Verification[\s\S]*Judgment/)
  } finally { s.close() }
})

test('the package is what the directory asks for', () => {
  const root = join(here, '..')
  const LIMIT = 256 * 1024
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (['.git', 'types', 'node_modules'].includes(e.name) && dir !== join(root, 'types')) return []
    return e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
  })
  for (const f of walk(root)) {
    if (/\.(png|jpe?g|gif|webp|woff2?|ttf|otf)$/i.test(f)) continue
    assert.ok(statSync(f).size < LIMIT, `${f} is over 256 KiB, so the directory would hold it for a reviewer`)
  }
  for (const skill of readdirSync(join(root, 'skills'))) {
    const text = readFileSync(join(root, 'skills', skill, 'SKILL.md'), 'utf8')
    const allowed = /^allowed-tools: (.*)$/m.exec(text)[1]
    for (const tool of ['Bash', 'Edit', 'Write', 'Task', 'Agent']) assert.ok(!allowed.includes(`"${tool}"`), `${skill} pre-approves ${tool}`)
    assert.match(text, /Claude chat/, `${skill} does not say what to do in chat`)
  }
  assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /support@preproom\.ai/)
})

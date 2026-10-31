// Runs a person's answer against a question's examples on this computer, with the
// toolchain already installed here. Python, JavaScript and TypeScript use small harnesses
// of our own; the compiled languages use Prep Room's own drivers (engine.mjs), so a
// result here matches what the site's Run shows. The hidden checks are not here: they
// stay on preproom.ai.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { LANG_NAME, approxEqual, buildDriver, fnNameIn, parseRunStdout, readCompileError } from './engine.mjs'

const RUN_MS = 10_000
const COMPILE_MS = 60_000
const OUTPUT_MAX = 2 * 1024 * 1024

export function which(cmd) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir && existsSync(join(dir, cmd))) return join(dir, cmd)
  }
  return null
}

function exec(argv, { cwd, input, timeoutMs = RUN_MS } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e?.message || e), timedOut: false })
      return
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', (d) => { if (out.length < OUTPUT_MAX) out += d })
    child.stderr.on('data', (d) => { if (err.length < OUTPUT_MAX) err += d })
    child.on('error', (e) => { err += String(e?.message || e) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err, timedOut }) })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

const version = async (argv) => {
  const r = await exec(argv, { timeoutMs: 8000 })
  const line = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.trim()).find(Boolean) || ''
  return (line.match(/\d+\.\d+(\.\d+)?/) || [''])[0]
}

const nonce = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16)

// ---------------------------------------------------------------- harnesses

const PY_HARNESS = String.raw`
import importlib.util, json, math, sys, traceback
SOL, FN, N = sys.argv[1], sys.argv[2], sys.argv[3]
R = "__CR%s__" % N

def plain(v, d=0):
    if d > 60: return repr(v)
    if v is None or isinstance(v, (bool, str)): return v
    if isinstance(v, int): return int(v)
    if isinstance(v, float): return None if v != v or v in (float("inf"), float("-inf")) else v
    t = type(v); mod = (getattr(t, "__module__", "") or "").split(".")[0]
    if mod == "pandas":
        if t.__name__ == "DataFrame": return [{str(k): plain(x, d + 1) for k, x in r.items()} for r in v.to_dict("records")]
        if t.__name__ == "Series" or t.__name__.endswith("Index"): return [plain(x, d + 1) for x in list(v)]
        if t.__name__ in ("NaTType", "NAType"): return None
        if t.__name__ == "Timestamp": return v.isoformat()
    if mod == "numpy" and hasattr(v, "tolist"): return plain(v.tolist(), d + 1)
    if isinstance(v, dict): return {str(k): plain(x, d + 1) for k, x in v.items()}
    if isinstance(v, (set, frozenset)):
        items = [plain(x, d + 1) for x in v]
        try: return sorted(items)
        except Exception: return sorted(items, key=lambda x: json.dumps(x, sort_keys=True))
    if hasattr(v, "__iter__") and not isinstance(v, (bytes, bytearray)): return [plain(x, d + 1) for x in v]
    if hasattr(v, "isoformat"): return v.isoformat()
    try: return float(v)
    except Exception: return repr(v)

def arg(a):
    if isinstance(a, dict) and len(a) == 1 and "__df__" in a:
        import pandas
        return pandas.DataFrame(a["__df__"])
    return a

def describe(e):
    msg = "%s: %s" % (type(e).__name__, e) if str(e) else type(e).__name__
    line = None
    for fr in traceback.extract_tb(e.__traceback__):
        if fr.filename == SOL: line = fr.lineno
    if isinstance(e, SyntaxError) and e.filename == SOL: line = e.lineno
    return (msg + (" (line %d)" % line if line else "")).replace("\t", " ").replace("\n", " ")

tests = json.load(sys.stdin)
print("__CR%sSTART__" % N, flush=True)
spec = importlib.util.spec_from_file_location("solution", SOL)
mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)
except BaseException as e:
    for i in range(len(tests)): print("\n%s\t%d\tERR\t%s" % (R, i, describe(e)), flush=True)
    sys.exit(0)
fn = getattr(mod, FN, None)
if fn is None and hasattr(mod, "Solution") and hasattr(mod.Solution, FN): fn = getattr(mod.Solution(), FN)
if not callable(fn):
    print("__CR%sMISSING__" % N, flush=True); sys.exit(0)
for i, t in enumerate(tests):
    try:
        got = plain(fn(*[arg(a) for a in t.get("args", [])]))
        print("\n%s\t%d\tOK\t%s" % (R, i, json.dumps(got, ensure_ascii=False)), flush=True)
    except BaseException as e:
        print("\n%s\t%d\tERR\t%s" % (R, i, describe(e)), flush=True)
print("__CR%sDONE__" % N, flush=True)
`

// Appended after the person's code in one file, so their functions are in scope as written
// and their line numbers stay their own.
const JS_HARNESS = (fn, n, userLines) => `
;(async () => {
  const __n = ${JSON.stringify(n)}, __R = '__CR' + __n + '__'
  const __plain = (v, d = 0) => {
    if (d > 60) return String(v)
    if (v === undefined || v === null) return null
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (typeof v === 'bigint') return Number(v)
    if (typeof v === 'string' || typeof v === 'boolean') return v
    if (Array.isArray(v)) return v.map((x) => __plain(x, d + 1))
    if (v instanceof Set) return [...v].map((x) => __plain(x, d + 1)).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
    if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), __plain(x, d + 1)]))
    if (ArrayBuffer.isView(v)) return Array.from(v)
    if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, __plain(x, d + 1)]))
    return String(v)
  }
  const __line = (e) => {
    const m = String(e && e.stack || '').match(/_run\\.[cm]?[jt]s:(\\d+)/)
    return m && Number(m[1]) <= ${userLines} ? ' (line ' + m[1] + ')' : ''
  }
  const __msg = (e) => ((e && e.name ? e.name + ': ' : '') + (e && e.message !== undefined ? e.message : String(e)) + __line(e)).replace(/[\\t\\n]/g, ' ')
  const __tests = JSON.parse(require('fs').readFileSync(0, 'utf8'))
  process.stdout.write('__CR' + __n + 'START__\\n')
  let __f
  try { __f = eval(${JSON.stringify(fn)}) } catch {}
  if (typeof __f !== 'function' && typeof Solution === 'function' && typeof Solution.prototype[${JSON.stringify(fn)}] === 'function') { const __s = new Solution(); __f = __s[${JSON.stringify(fn)}].bind(__s) }
  if (typeof __f !== 'function') { process.stdout.write('__CR' + __n + 'MISSING__\\n'); return }
  for (let i = 0; i < __tests.length; i++) {
    try {
      const got = __plain(await __f(...__tests[i].args))
      process.stdout.write('\\n' + __R + '\\t' + i + '\\tOK\\t' + JSON.stringify(got) + '\\n')
    } catch (e) {
      process.stdout.write('\\n' + __R + '\\t' + i + '\\tERR\\t' + __msg(e) + '\\n')
    }
  }
  process.stdout.write('__CR' + __n + 'DONE__\\n')
})()
`

const SQL_HARNESS = String.raw`
import json, sqlite3, sys
req = json.load(sys.stdin)
con = sqlite3.connect(":memory:")
con.executescript(req["setup"])
last = None
try:
    stmts, buf = [], ""
    for line in req["query"].splitlines(True):
        buf += line
        if sqlite3.complete_statement(buf):
            stmts.append(buf); buf = ""
    if buf.strip(): stmts.append(buf)
    for s in stmts:
        cur = con.execute(s)
        if cur.description:
            last = {"columns": [d[0] for d in cur.description], "values": [list(r) for r in cur.fetchall()]}
    print(json.dumps({"ok": True, "result": last}))
except Exception as e:
    print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}))
`

// ---------------------------------------------------------------- the toolchains

/** How each language builds and runs here. `needs` is what must be on the PATH. */
const LOCAL = {
  c: { needs: 'cc', name: 'C', ver: ['cc', '--version'], compile: ['cc', '-std=c11', '-O2', '-o', 'main', 'main.c', '-lm'], run: ['./main'] },
  cpp: { needs: 'c++', name: 'C++', ver: ['c++', '--version'], compile: ['c++', '-std=c++17', '-O2', '-o', 'main', 'main.cpp'], run: ['./main'] },
  go: { needs: 'go', name: 'Go', ver: ['go', 'version'], run: ['go', 'run', 'main.go'] },
  rust: { needs: 'rustc', name: 'Rust', ver: ['rustc', '--version'], compile: ['rustc', '-O', '--edition', '2021', '-o', 'main', 'main.rs'], run: ['./main'] },
  // Swift's driver catches crashes with Linux's signal structures, so it builds on Linux only.
  swift: { needs: 'swiftc', os: 'linux', name: 'Swift', ver: ['swiftc', '--version'], compile: ['swiftc', '-O', '-o', 'main', 'main.swift'], run: ['./main'] },
  ruby: { needs: 'ruby', name: 'Ruby', ver: ['ruby', '--version'], run: ['ruby', 'main.rb'] },
  perl: { needs: 'perl', name: 'Perl', ver: ['perl', '--version'], run: ['perl', 'main.pl'] },
  bash: { needs: 'bash', name: 'Bash', ver: ['bash', '--version'], run: ['bash', 'main.sh'] },
}

const nodeStrips = () => {
  const [maj, min] = process.versions.node.split('.').map(Number)
  return maj > 22 || (maj === 22 && min >= 6)
}

/** The languages this computer can run, for a question that offers `offered`. */
export function localLanguages(offered) {
  return offered.filter((l) =>
    l === 'python' ? !!(which('python3') || which('python')) :
      l === 'javascript' ? true :
        l === 'typescript' ? nodeStrips() :
          usable(l))
}

const usable = (l) => !!(LOCAL[l] && (!LOCAL[l].os || LOCAL[l].os === process.platform) && which(LOCAL[l].needs))

// ---------------------------------------------------------------- running

/**
 * One run. Returns { where, cases: [{ label, call, expected, got?, error?, pass }] }, or
 * { cannot: reason } when this computer cannot run it, or { problem } for a compile error,
 * a missing function or a run that never finished.
 */
export async function runExamples(q, state, code) {
  if (q.kind === 'written') return { cannot: 'This question is answered in words, so there is nothing to run.' }
  if (q.kind === 'sql') return runSql(q, code)
  const tests = q.fn?.examples ?? q.files?.examples ?? []
  if (!tests.length) return { cannot: 'This question has no examples to run here.' }
  if (q.kind === 'files') {
    const py = which('python3') || which('python')
    if (!py || !state.file.endsWith('.py')) return { cannot: 'This one runs on preproom.ai.' }
    return runPython(q, tests, code, q.files.fnName, py, state)
  }
  const lang = state.language
  // Each language spells the function its own way: daily_temperatures, dailyTemperatures.
  const name = fnNameIn(q.fn.signature, lang)
  if (lang === 'python') {
    if (q.fn.pandas && !(await hasPandas())) return { cannot: 'This one works on pandas DataFrames, and pandas is not installed here.' }
    const py = which('python3') || which('python')
    if (!py) return { cannot: 'There is no Python on this computer that the plugin can find.' }
    return runPython(q, tests, code, name, py, state)
  }
  if (lang === 'javascript' || lang === 'typescript') return runJs(tests, code, name, lang)
  const tool = LOCAL[lang]
  if (!usable(lang)) {
    const name = LANG_NAME[lang] || lang
    return { cannot: tool?.os && which(tool.needs) ? `On this computer, ${name} answers run on preproom.ai.` : `This computer has no ${name} toolchain the plugin can use.` }
  }
  return runCompiled(q, tests, code, lang, tool)
}

let pandasKnown = null
async function hasPandas() {
  if (pandasKnown !== null) return pandasKnown
  const py = which('python3') || which('python')
  pandasKnown = !!py && (await exec([py, '-c', 'import pandas'], { timeoutMs: 20_000 })).code === 0
  return pandasKnown
}

async function inTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'preproom-run-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

function label(t, i) { return t.label || `Example ${i + 1}` }

/** A value as the README writes it: JSON with a space after each comma, cut short when long. */
export function show(v) {
  let s
  try { s = JSON.stringify(v) } catch { s = String(v) }
  if (s === undefined) s = 'nothing'
  s = s.replace(/,(?=\S)/g, ', ')
  return s.length > 300 ? `${s.slice(0, 299)}…` : s
}

/** Matches the harness's lines to the tests: pass, a wrong value, an error, or no answer at all. */
function grade(tests, stdout, n, fnName) {
  const parsed = parseRunStdout(stdout, n)
  if (parsed.fnMissing) return { problem: `There is no function called ${fnName}. Keep the name from the starter.` }
  const cases = tests.map((t, i) => {
    const line = parsed.lines.find((l) => l.index === i)
    const call = `${fnName}(${t.args.map(show).join(', ')})`
    const expected = show(t.expect)
    if (!line) return { label: label(t, i), call, expected, pass: false, error: 'It did not finish.' }
    if (line.status === 'ERR') return { label: label(t, i), call, expected, pass: false, error: line.payload }
    let got
    try { got = JSON.parse(line.payload) } catch { got = line.payload }
    return { label: label(t, i), call, expected, got: show(got), pass: approxEqual(got, t.expect) }
  })
  return { cases, printed: parsed.userOut.trim() }
}

async function runPython(q, tests, code, fnName, py, state) {
  return inTemp(async (dir) => {
    // A question in files runs next to its other files, so an import of one works.
    if (q.files) for (const f of q.files.files) if (f.name !== state.file) await writeFile(join(dir, f.name), f.content)
    const sol = join(dir, state.file?.endsWith('.py') ? state.file : 'solution.py')
    await writeFile(sol, code)
    await writeFile(join(dir, '_harness.py'), PY_HARNESS)
    const n = nonce()
    const r = await exec([py, '-I', join(dir, '_harness.py'), sol, fnName, n], { cwd: dir, input: JSON.stringify(tests) })
    const v = await version([py, '--version'])
    if (r.timedOut) return { problem: `It ran for ${RUN_MS / 1000} seconds without finishing. There may be an infinite loop.`, where: `Python ${v}` }
    const g = grade(tests, r.stdout, n, fnName)
    if (!g.cases && !g.problem && r.stderr) return { problem: r.stderr.trim().split('\n').slice(-3).join('\n') }
    return { ...g, where: `Python ${v}` }
  })
}

async function runJs(tests, code, fnName, lang) {
  return inTemp(async (dir) => {
    const ts = lang === 'typescript'
    const file = join(dir, ts ? '_run.cts' : '_run.cjs')
    const userLines = code.split('\n').length
    const n = nonce()
    await writeFile(file, code + '\n' + JS_HARNESS(fnName, n, userLines))
    const argv = [process.execPath, ...(ts ? ['--experimental-strip-types', '--no-warnings'] : []), file]
    const r = await exec(argv, { cwd: dir, input: JSON.stringify(tests) })
    const where = `Node ${process.versions.node}`
    if (r.timedOut) return { problem: `It ran for ${RUN_MS / 1000} seconds without finishing. There may be an infinite loop.`, where }
    if (!r.stdout.includes(`__CR${n}START__`)) {
      const first = r.stderr.split('\n').find((l) => /Error|error/.test(l)) || r.stderr.trim().split('\n')[0] || 'It did not start.'
      const line = (r.stderr.match(/_run\.c[jt]s:(\d+)/) || [])[1]
      return { problem: `${first.trim()}${line && Number(line) <= userLines ? ` (line ${line})` : ''}`, where }
    }
    return { ...grade(tests, r.stdout, n, fnName), where }
  })
}

async function runCompiled(q, tests, code, lang, tool) {
  const build = buildDriver(lang, q.fn.signature, tests, code)
  if (!build.ok) return { cannot: build.reason }
  return inTemp(async (dir) => {
    await writeFile(join(dir, build.fileName), build.source)
    const v = await version(tool.ver)
    const where = `${tool.name}${v ? ` ${v}` : ''}`
    if (tool.compile) {
      const c = await exec(tool.compile, { cwd: dir, timeoutMs: COMPILE_MS })
      if (c.timedOut) return { problem: 'It took too long to compile.', where }
      if (c.code !== 0) return { problem: readCompileError(lang, c.stderr || c.stdout, build), where }
    }
    const r = await exec(tool.run, { cwd: dir, input: '', timeoutMs: tool.compile ? RUN_MS : COMPILE_MS })
    if (r.timedOut) return { problem: `It ran for ${RUN_MS / 1000} seconds without finishing. There may be an infinite loop.`, where }
    if (!r.stdout.includes(`__CR${build.nonce}START__`) && r.stderr.trim()) return { problem: readCompileError(lang, r.stderr, build), where }
    return { ...grade(tests, r.stdout, build.nonce, build.fn), where }
  })
}

// ---------------------------------------------------------------- SQL

const rowKey = (r) => JSON.stringify(r)
async function runSql(q, query) {
  const py = which('python3') || which('python')
  if (!py) return { cannot: 'SQL runs with Python\'s built-in SQLite, and there is no Python on this computer that the plugin can find.' }
  const exp = q.sql.expected
  if (!exp) return { cannot: 'This one compares its rows on preproom.ai.' }
  return inTemp(async (dir) => {
    await writeFile(join(dir, '_sql.py'), SQL_HARNESS)
    const r = await exec([py, '-I', join(dir, '_sql.py')], { cwd: dir, input: JSON.stringify({ setup: q.sql.setup, query }) })
    const where = `SQLite in Python ${await version([py, '--version'])}`
    if (r.timedOut) return { problem: 'The query ran for 10 seconds without finishing.', where }
    let out
    try { out = JSON.parse(r.stdout.trim().split('\n').pop()) } catch { return { problem: r.stderr.trim() || 'The query did not run.', where } }
    if (!out.ok) return { problem: out.error, where }
    if (!out.result) return { problem: 'End with a SELECT so there are rows to compare.', where }
    const got = out.result
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
    const sameRow = (a, b) => a.length === b.length && a.every((x, i) => approxEqual(x, b[i]))
    let pass = got.columns.length === exp.columns.length && got.values.length === exp.values.length
    let note = ''
    if (!pass) note = `Your query returns ${plural(got.values.length, 'row')} and ${plural(got.columns.length, 'column')}; the expected result has ${plural(exp.values.length, 'row')} and ${plural(exp.columns.length, 'column')}.`
    else if (q.sql.ordered) {
      const bad = exp.values.findIndex((row, i) => !sameRow(got.values[i], row))
      if (bad >= 0) { pass = false; note = `Row ${bad + 1} differs. Yours: ${show(got.values[bad])}. Expected: ${show(exp.values[bad])}. The order matters here.` }
    } else {
      const left = [...got.values]
      for (const row of exp.values) {
        const i = left.findIndex((g) => sameRow(g, row))
        if (i < 0) { pass = false; note = `The expected row ${show(row)} is not in your result.`; break }
        left.splice(i, 1)
      }
    }
    return { sql: { pass, note, columns: got.columns, rows: got.values.slice(0, 5).map(rowKey) }, where }
  })
}

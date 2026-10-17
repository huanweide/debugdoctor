#!/usr/bin/env node
'use strict'
// debugdoctor 单元测试 — 零依赖（仅用 Node 内置 assert/fs/os/path），确定性可复现。
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

// 本文件位于 test/ 下，必须用 .. 回到仓库根加载被测模块
const m = require('../index.js')
const {
  stripNoise, langOf, isTestFile, isLoggerModule,
  scanFile, walk, computeScore, computeGate, parseArgs, exitCodeFor,
} = m

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  process.stdout.write('  ok - ' + name + '\n')
}

// ---- langOf ----
ok('langOf 语言分类', () => {
  for (const e of ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte']) {
    assert.strictEqual(langOf('a' + e), 'js')
  }
  assert.strictEqual(langOf('a.py'), 'py')
  assert.strictEqual(langOf('a.go'), 'go')
  assert.strictEqual(langOf('a.md'), null)
  assert.strictEqual(langOf('a.rs'), null)
})

// ---- isTestFile ----
ok('isTestFile 测试文件识别', () => {
  assert.ok(isTestFile('foo.test.js', 'foo.test.js'))
  assert.ok(isTestFile('bar.spec.ts', 'bar.spec.ts'))
  assert.ok(isTestFile('x/y/__tests__/a.js', 'a.js'))
  assert.ok(isTestFile('x/tests/a.js', 'a.js'))
  assert.ok(isTestFile('test.js', 'test.js')) // 独立测试文件（family 惯例）
  assert.ok(isTestFile('test_foo.py', 'test_foo.py'))
  assert.ok(isTestFile('foo.test.py', 'foo.test.py'))
  assert.ok(isTestFile('foo_test.go', 'foo_test.go'))
  assert.ok(!isTestFile('src/app.js', 'app.js'))
  assert.ok(!isTestFile('src/mytest.js', 'mytest.js')) // 不应误判
})

// ---- isLoggerModule ----
ok('isLoggerModule 日志模块识别(边界不误判)', () => {
  assert.ok(isLoggerModule('src/logger/index.js'))
  assert.ok(isLoggerModule('lib/log.ts'))
  assert.ok(!isLoggerModule('src/catalog/foo.js')) // log 后跟 a 不匹配
  assert.ok(!isLoggerModule('src/mylog.ts'))        // log 后跟 t 不匹配
})

// ---- stripNoise ----
ok('stripNoise 注释内 debugger 被剥离', () => {
  const clean = stripNoise('// debugger;\nconst a = 1\n')
  assert.ok(!/debugger/.test(clean))
  assert.ok(clean.includes('const a = 1'))
})
ok('stripNoise 字符串内 console 被剥离', () => {
  const clean = stripNoise('const s = "console.log(x)";\nconst b = 2\n')
  assert.ok(!/console/.test(clean))
})
ok('stripNoise 正则字面量内部被空格化(防伪信号)', () => {
  const clean = stripNoise('const re = /debugger/mi;\nfoo()\n')
  assert.ok(!/debugger/.test(clean))
})
ok('stripNoise 保留换行(行号一致)', () => {
  const clean = stripNoise('a\nb\nc')
  assert.strictEqual(clean.split('\n').length, 3)
})

// ---- scanFile: JS ----
ok('scanFile js debugger 高危', () => {
  const r = scanFile('x.js', 'function f(){ debugger; return 1 }\n')
  assert.strictEqual(r.issues.length, 1)
  assert.strictEqual(r.issues[0].severity, 'high')
  assert.strictEqual(r.issues[0].ruleId, 'debugger-stmt')
})
ok('scanFile js console 中危', () => {
  const r = scanFile('x.js', 'console.log("hi")\n')
  assert.strictEqual(r.issues.length, 1)
  assert.strictEqual(r.issues[0].severity, 'medium')
})
ok('scanFile js 字符串/注释内不误报', () => {
  const r = scanFile('x.js', 'const s = "debugger; console.log(x)";\n// debugger;\n')
  assert.strictEqual(r.issues.length, 0)
})
ok('scanFile js 行号正确', () => {
  const r = scanFile('x.js', 'a\nb\ndebugger;\n')
  assert.strictEqual(r.issues[0].line, 3)
})

// ---- scanFile: Python / Go ----
ok('scanFile py print 中危', () => {
  const r = scanFile('x.py', 'print("hi")\n')
  assert.strictEqual(r.issues.length, 1)
  assert.strictEqual(r.issues[0].ruleId, 'py-print')
})
ok('scanFile go fmt/log 中危', () => {
  const r = scanFile('x.go', 'fmt.Println("hi")\nlog.Print("x")\n')
  assert.strictEqual(r.issues.length, 2)
})
ok('scanFile 非支持语言返回 null', () => {
  assert.strictEqual(scanFile('x.md', '# h'), null)
})

// ---- scanFile: 豁免 ----
ok('scanFile 测试文件跳过', () => {
  const r = scanFile('foo.test.js', 'debugger;\n')
  assert.strictEqual(r.skipped, 'test')
})
ok('scanFile 超大文件跳过', () => {
  const big = 'a\n'.repeat(3000000) // > 5MB (≈6MB)
  const r = scanFile('big.js', big)
  assert.strictEqual(r.skipped, 'too-large')
})
ok('scanFile 日志模块 console 豁免', () => {
  const r = scanFile('lib/log/logger.js', 'console.log("x")\n')
  assert.strictEqual(r.issues.length, 0)
})
ok('scanFile 普通模块 console 正常报', () => {
  const r = scanFile('lib/app.js', 'console.log("x")\n')
  assert.strictEqual(r.issues.length, 1)
})

// ---- computeScore ----
ok('computeScore 0 问题 = 100', () => {
  assert.strictEqual(computeScore([], 1000), 100)
})
ok('computeScore 容忍基线内不扣分', () => {
  const issues = [{ weight: 2 }]
  assert.strictEqual(computeScore(issues, 10000), 100) // allowed=40
})
ok('computeScore 超额扣分到底', () => {
  const issues = Array.from({ length: 10 }, () => ({ weight: 3 })) // 30 当量
  assert.strictEqual(computeScore(issues, 1000), 0) // allowed=4, excess=26
})

// ---- computeGate ----
// 注意：opts 里必须给 _scanned / _totalLines，否则会命中「输入为空 → inconclusive」，
// 这正是本轮修复的核心语义。
const gateOpts = (o) => Object.assign({ _scanned: 1, _totalLines: 10 }, o)

ok('computeGate failOnHigh', () => {
  const g = computeGate([{ severity: 'high' }], gateOpts({ failOnHigh: true, _score: 100 }))
  assert.strictEqual(g.state, 'fail')
  assert.strictEqual(g.configured, true)
})
ok('computeGate maxHigh 边界', () => {
  const issues = [{ severity: 'high' }, { severity: 'high' }]
  assert.strictEqual(computeGate(issues, gateOpts({ maxHigh: 1, _score: 100 })).state, 'fail')
  assert.strictEqual(computeGate(issues, gateOpts({ maxHigh: 2, _score: 100 })).state, 'pass')
})
ok('computeGate minScore 边界', () => {
  assert.strictEqual(computeGate([], gateOpts({ minScore: 90, _score: 80 })).state, 'fail')
  assert.strictEqual(computeGate([], gateOpts({ minScore: 80, _score: 80 })).state, 'pass')
})
ok('computeGate 未配任何阈值 → inconclusive（不是 pass）', () => {
  const g = computeGate([], gateOpts({ _score: 100 }))
  assert.strictEqual(g.state, 'inconclusive')
  assert.strictEqual(g.configured, false)
})
ok('computeGate 扫到 0 个文件 → inconclusive（假绿灯防线）', () => {
  const g = computeGate([], gateOpts({ failOnHigh: true, _scanned: 0, _totalLines: 0, _score: 100 }))
  assert.strictEqual(g.state, 'inconclusive')
  assert.strictEqual(g.configured, true)
})
ok('computeGate 全部文件无内容 → inconclusive', () => {
  const g = computeGate([], gateOpts({ failOnHigh: true, _scanned: 3, _totalLines: 0, _score: 100 }))
  assert.strictEqual(g.state, 'inconclusive')
})
ok('exitCodeFor 三态映射', () => {
  assert.strictEqual(exitCodeFor({ state: 'pass' }), 0)
  assert.strictEqual(exitCodeFor({ state: 'fail' }), 2)
  assert.strictEqual(exitCodeFor({ state: 'inconclusive' }), 3)
})

// ---- parseArgs ----
ok('parseArgs --root', () => {
  assert.strictEqual(parseArgs(['--root', '/tmp/x']).root, '/tmp/x')
})
ok('parseArgs 未知标志报错(exit2)', () => {
  let code = null
  try { parseArgs(['--bogus']) } catch (e) { code = e.code; /* expected */ }
  assert.strictEqual(code, 2)
})
ok('parseArgs 短标志 -x 也必须退 2（历史缺陷：漏到位置参数）', () => {
  let code = null
  try { parseArgs(['-x']) } catch (e) { code = e.code; /* expected */ }
  assert.strictEqual(code, 2)
})
ok('parseArgs 数值标志拒绝空串 / 小数 / 负数', () => {
  for (const bad of ['', '  ', '1.5', '-1', 'abc']) {
    let code = null
    try { parseArgs(['--max-high', bad]) } catch (e) { code = e.code; /* expected */ }
    assert.strictEqual(code, 2, `'${bad}' 应退 2`)
  }
})
ok('parseArgs --root 不吞后续标志', () => {
  let code = null
  try { parseArgs(['--root', '--json']) } catch (e) { code = e.code; /* expected */ }
  assert.strictEqual(code, 2)
})
ok('parseArgs --max-high 非整数报错(exit2)', () => {
  // 现在 errorExit 抛 UsageExit 而非 process.exit —— 直接断言异常上的 code，
  // 不要再去 monkey-patch process.exit（它已不再被调用，patch 会永远拿到 null）。
  let code = null
  try { parseArgs(['--max-high', 'abc']) } catch (e) { code = e.code; /* expected */ }
  assert.strictEqual(code, 2)
})

// ---- 集成: 临时脏仓库 ----
ok('integration 脏仓库精准报出(零误报)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddoc-'))
  fs.writeFileSync(path.join(dir, 'a.js'), 'function f(){ debugger; console.log("x"); }\n')
  fs.writeFileSync(path.join(dir, 'b.py'), 'print("y")\n')
  fs.writeFileSync(path.join(dir, 'c.go'), 'func m(){ fmt.Println("z") }\n')
  fs.writeFileSync(path.join(dir, 'd.md'), 'debugger; console.log("no")') // 非源码不扫
  const files = []
  walk(dir, new Set(), files)
  let all = []
  for (const f of files) {
    const r = scanFile(f, fs.readFileSync(f, 'utf8'))
    if (r && r.issues) all = all.concat(r.issues)
  }
  assert.strictEqual(all.length, 4) // a.js:1high+1med, b.py:1med, c.go:1med
  assert.strictEqual(all.filter((i) => i.severity === 'high').length, 1)
  assert.strictEqual(all.filter((i) => i.severity === 'medium').length, 3)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---- dogfood 自身归零 ----
ok('dogfood 扫自身 index.js 0 问题', () => {
  // 本文件位于 test/ 下，必须用 .. 回到仓库根，否则扫的是测试文件
  const fp = path.join(__dirname, '..', 'index.js')
  const r = scanFile(fp, fs.readFileSync(fp, 'utf8'))
  assert.strictEqual(r.issues.length, 0)
})

process.stdout.write('All ' + passed + ' tests passed\n')

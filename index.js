#!/usr/bin/env node
'use strict'

// debugdoctor — 零依赖单文件「调试/日志残留卫生体检」CLI
// family 第十五轴 · 源码层第十轴：扫 debugger / console.* / print / fmt.Print* 等开发残留。
// 跨 JS/TS/Python/Go 多语言，输出严重度加权健康分 + CI 门禁。纯 fs 只读，零依赖、零网络。

const fs = require('fs')
const path = require('path')

const VERSION = '1.1.0'

// ---- 规则集（按语言）----
// severity: high(生产致命) / medium(卫生)
// 每条规则存正则 source 字符串 + flags，运行时 new RegExp 实例化，避免共享 lastIndex 串状态。
const RULES = {
  js: [
    { id: 'debugger-stmt', severity: 'high', weight: 3, re: String.raw`\bdebugger\s*;`, flags: 'g', msg: '遗留 debugger 语句（生产环境会中断执行）' },
    { id: 'console-call', severity: 'medium', weight: 2, re: String.raw`\bconsole\s*\.\s*(?:log|info|warn|error|debug|trace|table|dir|dirxml)\s*\(`, flags: 'g', msg: '遗留 console.* 调试输出', loggerExempt: true },
  ],
  py: [
    { id: 'py-print', severity: 'medium', weight: 2, re: String.raw`\b(?:print|pprint)\s*\(`, flags: 'g', msg: '遗留 print/pprint 调试输出' },
  ],
  go: [
    { id: 'go-print', severity: 'medium', weight: 2, re: String.raw`\b(?:fmt|log)\s*\.\s*(?:Print|Printf|Println|Sprint|Sprintf|Sprintln)\s*\(`, flags: 'g', msg: '遗留 fmt/log.Print* 调试输出' },
  ],
}

const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5MB 跳过防 OOM

// ---- 逐字符 tokenizer：剥离注释/字符串（保留换行，正则上下文感知）----
// 来自 secscan/awaitscan 方法沉淀：正则 replace 会塌缩换行致行号错位，必须逐字符扫描。
function isRegexContext(code, i) {
  let j = i - 1
  while (j >= 0 && /\s/.test(code[j])) j--
  if (j < 0) return false
  return /[=([,:!&|?{;]/.test(code[j])
}

function stripNoise(code) {
  let out = ''
  const n = code.length
  let i = 0
  while (i < n) {
    const c = code[i]
    const c2 = code[i + 1]
    if (c === '/' && c2 === '/') {
      while (i < n && code[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        out += (code[i] === '\n') ? '\n' : ' '
        i++
      }
      if (i < n) { out += '  '; i += 2 }
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += ' '; i++
      while (i < n) {
        if (code[i] === '\\') { out += ' '; i += 2; continue }
        if (code[i] === quote) { out += ' '; i++; break }
        out += (code[i] === '\n') ? '\n' : ' '
        i++
      }
      continue
    }
    if (c === '/' && isRegexContext(code, i)) {
      out += ' '; i++ // 跳过开头 /
      while (i < n) {
        if (code[i] === '\\') { out += ' '; i += 2; continue }
        if (code[i] === '/') { out += ' '; i++; break }
        out += (code[i] === '\n') ? '\n' : ' '
        i++
      }
      while (i < n && /[a-z]/i.test(code[i])) { out += ' '; i++ } // 跳过正则标志 gim
      continue
    }
    out += c
    i++
  }
  return out
}

// ---- 文件分类 ----
function langOf(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) return 'js'
  if (ext === '.py') return 'py'
  if (ext === '.go') return 'go'
  if (ext === '.vue' || ext === '.svelte') return 'js' // 仅 script 块含 console，整文件扫可接受
  return null
}

function isTestFile(filePath, base) {
  if (/\.(?:test|spec)\.[jt]sx?$/.test(filePath)) return true
  if (/^test\.[jt]sx?$/.test(base)) return true // 独立 test.js / test.ts 等（family 惯例）
  if (/[\\/]__tests__[\\/]/.test(filePath)) return true
  if (/[\\/](?:tests?)[\\/]/.test(filePath)) return true
  if (/^test_.*\.py$/.test(base)) return true
  if (/\.test\.py$/.test(base)) return true
  if (/_test\.go$/.test(base)) return true
  return false
}

function isLoggerModule(filePath) {
  return /(?:^|[\\/])(?:logger|log|logs|logging)(?:[\\/._-]|$)/i.test(filePath)
}

function countLines(text, idx) {
  let line = 1
  for (let k = 0; k < idx && k < text.length; k++) {
    if (text[k] === '\n') line++
  }
  return line
}

function safeSnippet(lines, lineNo) {
  const s = lines[lineNo - 1]
  if (!s) return ''
  return s.replace(/\t/g, ' ').slice(0, 200)
}

// ---- 单文件扫描 ----
function scanFile(filePath, content) {
  const lang = langOf(filePath)
  if (!lang) return null
  if (isTestFile(filePath, path.basename(filePath))) return { skipped: 'test' }
  if (content.length > MAX_FILE_BYTES) return { skipped: 'too-large' }

  const clean = stripNoise(content)
  const lines = content.split('\n')
  const logger = isLoggerModule(filePath)
  const issues = []
  for (const rule of RULES[lang]) {
    if (rule.loggerExempt && logger) continue // 日志模块的 console 不算残留
    const re = new RegExp(rule.re, rule.flags)
    let m
    while ((m = re.exec(clean)) !== null) {
      if (m.index === re.lastIndex) re.lastIndex++ // 防零宽死循环
      const lineNo = countLines(clean, m.index)
      issues.push({
        file: filePath,
        line: lineNo,
        ruleId: rule.id,
        severity: rule.severity,
        weight: rule.weight,
        message: rule.msg,
        snippet: safeSnippet(lines, lineNo),
      })
    }
  }
  return { issues }
}

// ---- 目录遍历 ----
const DEFAULT_EXCLUDES = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out',
  '.nuxt', 'vendor', '.cache', 'tmp', '.idea', '.vscode',
])

function shouldScan(filePath) {
  return langOf(filePath) !== null
}

function walk(root, extraExcludes, out) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (e) {
    return
  }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      if (DEFAULT_EXCLUDES.has(e.name) || extraExcludes.has(e.name)) continue
      walk(full, extraExcludes, out)
    } else if (e.isFile()) {
      if (shouldScan(full)) out.push(full)
    }
  }
}

// ---- 健康分 ----
function computeScore(issues, totalLines) {
  const weighted = issues.reduce((s, i) => s + i.weight, 0)
  const allowed = 4 * (totalLines / 1000) // 每千行容忍 4 当量
  const excess = Math.max(0, weighted - allowed)
  const penalty = excess * 4
  return Math.max(0, Math.round(100 - penalty))
}

// ---- 门禁三态 ----
// 历史缺陷（家族共性最恶劣失败模式，且本仓有三个变体，全部实测确认）：
//   a) 空目录 + --max-high 0 --max-issues 0 --min-score 100 → 输出「CI 门禁: 通过」，rc=0
//   b) 未配任何阈值时，扫到真 debugger 也输出「CI 门禁: 通过」，rc=0
//   c) --json 的 gate 只有布尔 passed，调用方无法区分「达标」与「根本没判定」
// 三者在 CI 上都是同一盏永不熄灭的绿灯。现在统一为三态：
//   pass(0) / fail(2) / inconclusive(3)
const GATE_STATE = {
  PASS: 'pass',
  FAIL: 'fail',
  INCONCLUSIVE: 'inconclusive',
}

function computeGate(issues, opts) {
  const highs = issues.filter((i) => i.severity === 'high').length
  const mediums = issues.filter((i) => i.severity === 'medium').length
  const reasons = []
  const configured = opts.failOnHigh || opts.maxHigh != null ||
    opts.maxMedium != null || opts.maxIssues != null || opts.minScore != null
  if (!configured) {
    return {
      state: GATE_STATE.INCONCLUSIVE,
      configured: false,
      reasons: [],
      reason: '未配置任何门禁阈值，本次仅体检不判定（请显式传入 --max-high / --max-medium / --max-issues / --min-score / --fail-on-high）',
    }
  }
  // 输入不可信：扫到 0 个文件 → 无法得出任何结论，绝不能报 pass
  if (opts._scanned === 0) {
    return {
      state: GATE_STATE.INCONCLUSIVE,
      configured: true,
      reasons: [],
      reason: '扫描输入为空（0 个可分析文件），无法判定；请确认 --root 指向源码目录且不是全部命中排除规则',
    }
  }
  if (opts._totalLines === 0) {
    return {
      state: GATE_STATE.INCONCLUSIVE,
      configured: true,
      reasons: [],
      reason: '扫描到的文件全部无可解析内容，无法判定',
    }
  }
  if (opts.failOnHigh && highs > 0) reasons.push(`存在 ${highs} 个高危残留(debugger)`)
  if (opts.maxHigh != null && highs > opts.maxHigh) reasons.push(`高危数 ${highs} > --max-high ${opts.maxHigh}`)
  if (opts.maxMedium != null && mediums > opts.maxMedium) reasons.push(`中危数 ${mediums} > --max-medium ${opts.maxMedium}`)
  if (opts.maxIssues != null && issues.length > opts.maxIssues) reasons.push(`问题数 ${issues.length} > --max-issues ${opts.maxIssues}`)
  if (opts.minScore != null && opts._score < opts.minScore) reasons.push(`健康分 ${opts._score} < --min-score ${opts.minScore}`)
  return {
    state: reasons.length === 0 ? GATE_STATE.PASS : GATE_STATE.FAIL,
    configured: true,
    reasons,
    reason: reasons.length === 0 ? '全部指标达标' : '存在不达标项',
  }
}

function exitCodeFor(gate) {
  if (gate.state === GATE_STATE.FAIL) return 2
  if (gate.state === GATE_STATE.INCONCLUSIVE) return 3
  return 0
}

// ---- 参数解析（三类分离，来自 cycscan 方法沉淀）----
const NUM_FLAGS = new Set(['--max-high', '--max-medium', '--max-issues', '--min-score'])
const STR_FLAGS = new Set(['--root', '--exclude'])
const BOOL_FLAGS = new Set(['--json', '--fail-on-high', '--no-logger-exempt', '--help', '-h', '--version', '-V'])

function parseArgs(argv) {
  const opts = {
    json: false, failOnHigh: false, loggerExempt: true,
    maxHigh: null, maxMedium: null, maxIssues: null, minScore: null,
    root: null, excludes: new Set(),
  }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (NUM_FLAGS.has(a)) {
      const raw = argv[++i]
      // 历史缺陷：
      //   Number('') === 0     → 空串静默变成阈值 0
      //   Number('1.5') === 1.5 → 小数被接受，「高危数 1 > --max-high 1.5」永远为假，门禁失效
      // 门禁参数写错 = 门禁不存在，一律退 2。
      const v = Number(raw)
      if (raw === undefined || String(raw).trim() === '' || !Number.isFinite(v)) {
        errorExit(`标志 ${a} 需要整数参数（收到: ${raw === undefined ? '<缺失>' : raw}）`, 2)
      }
      if (!Number.isInteger(v)) errorExit(`标志 ${a} 需要整数（收到: ${raw}）`, 2)
      if (v < 0) errorExit(`标志 ${a} 需要非负整数（收到: ${raw}）`, 2)
      if (a === '--max-high') opts.maxHigh = v
      else if (a === '--max-medium') opts.maxMedium = v
      else if (a === '--max-issues') opts.maxIssues = v
      else if (a === '--min-score') opts.minScore = v
    } else if (STR_FLAGS.has(a)) {
      const v = argv[++i]
      // 历史缺陷：`--root --json` 会把 --json 静默当成目录名吞掉，
      // 报错变成「根目录不存在或无法访问: --json」，用户完全看不懂。
      if (v === undefined || v.startsWith('-')) {
        errorExit(`标志 ${a} 需要参数（收到: ${v === undefined ? '<缺失>' : v}）`, 2)
      }
      if (a === '--root') opts.root = v
      else if (a === '--exclude') opts.excludes.add(v)
    } else if (BOOL_FLAGS.has(a)) {
      if (a === '--json') opts.json = true
      else if (a === '--fail-on-high') opts.failOnHigh = true
      else if (a === '--no-logger-exempt') opts.loggerExempt = false
      else if (a === '--help' || a === '-h') { printHelp(); process.exitCode = 0; throw new HelpExit() }
      else if (a === '--version' || a === '-V') { out(VERSION + '\n'); process.exitCode = 0; throw new HelpExit() }
    } else if (a.startsWith('-')) {
      // 历史缺陷：只拦 `--` 开头的标志，`-x` 这种短标志漏过去，
      // 最终变成位置参数被当 root，报「根目录不存在或无法访问: -x」。
      errorExit(`未知标志: ${a}`, 2)
    } else {
      positional.push(a)
    }
  }
  if (!opts.root) opts.root = positional[0] || process.cwd()
  return opts
}

// parseArgs 在 --help / --version 时不能直接 process.exit()：
// 那会截断尚未冲刷的 stdout。改为抛哨兵，由 run() 收尾设置 exitCode。
class HelpExit extends Error {
  constructor() { super('help'); this.name = 'HelpExit' }
}

function errorExit(msg, code) {
  err('debugdoctor: ' + msg + '\n')
  throw new UsageExit(code)
}

class UsageExit extends Error {
  constructor(code) { super('usage'); this.code = code; this.name = 'UsageExit' }
}

function printHelp() {
  out(
    'debugdoctor — 零依赖调试/日志残留卫生体检 CLI\n\n' +
    '用法: debugdoctor [--root <dir>] [选项]\n\n' +
    '选项:\n' +
    '  --root <dir>           扫描根目录（默认当前目录或首个位置参数）\n' +
    '  --exclude <name>       额外排除的目录名（可多次）\n' +
    '  --json                 仅输出纯 JSON 报告（门禁用退出码）\n' +
    '  --fail-on-high         存在任何 debugger(high) 则门禁失败(退出码2)\n' +
    '  --max-high <n>         高危数上限\n' +
    '  --max-medium <n>       中危数上限\n' +
    '  --max-issues <n>       问题总数上限\n' +
    '  --min-score <n>        健康分下限\n' +
    '  --no-logger-exempt     关闭日志模块(logger/log)的 console 豁免\n' +
    '  -V, --version          版本号\n' +
    '  -h, --help             帮助\n\n' +
    '门禁三态（--json 里见 gate.state / basisComplete）:\n' +
    '  pass           配了门禁阈值且输入可信、指标达标\n' +
    '  fail           配了门禁阈值且存在不达标项\n' +
    '  inconclusive   未配门禁阈值，或扫描输入为空 → 无法下结论，**不算通过**\n\n' +
    '退出码: 0=通过 / 2=门禁失败 / 3=无法判定 / 其他=运行错误\n'
  )
}

function out(s) { process.stdout.write(s) }
function err(s) { process.stderr.write(s) }

// ---- 主流程 ----
// 注意：errorExit 抛 UsageExit 而非 process.exit（process.exit 会截断 stdout）。
// 因此整个 run() 主体都必须包在 try/catch 里收口——
// 参数校验阶段的错误在 parseArgs 里抛，扫描阶段（statSync 失败、root 是文件）
// 在下面抛。任何一处漏收口都会让 UsageExit 逃逸成未捕获异常，
// 结果是「满屏 stack trace + rc=1」而不是干净的 rc=2。
function run(argv) {
  try {
    return runInner(argv)
  } catch (e) {
    if (e instanceof HelpExit) return
    if (e instanceof UsageExit) { process.exitCode = e.code; return }
    throw e
  }
}

function runInner(argv) {
  const opts = parseArgs(argv)
  const root = opts.root
  let stat
  try {
    stat = fs.statSync(root)
  } catch (e) {
    errorExit(`根目录不存在或无法访问: ${root}`, 2)
  }
  if (!stat.isDirectory()) errorExit(`--root 必须是目录: ${root}`, 2)

  const files = []
  walk(root, opts.excludes, files)

  let allIssues = []
  let totalLines = 0
  let skipped = { test: 0, 'too-large': 0, other: 0 }
  for (const f of files) {
    let content
    try {
      content = fs.readFileSync(f, 'utf8')
    } catch (e) {
      continue
    }
    totalLines += content.split('\n').length
    const res = scanFile(f, content)
    if (res === null) { skipped.other++; continue }
    if (res.skipped) { skipped[res.skipped] = (skipped[res.skipped] || 0) + 1; continue }
    allIssues = allIssues.concat(res.issues)
  }

  const score = computeScore(allIssues, totalLines)
  opts._score = score
  opts._scanned = files.length
  opts._totalLines = totalLines
  const gate = computeGate(allIssues, opts)
  const rc = exitCodeFor(gate)

  if (opts.json) {
    const report = {
      tool: 'debugdoctor',
      version: VERSION,
      root,
      scannedFiles: files.length,
      totalLines,
      score,
      gate: { state: gate.state, configured: gate.configured, reasons: gate.reasons, reason: gate.reason },
      basisComplete: gate.state !== GATE_STATE.INCONCLUSIVE,
      issues: allIssues,
      skipped,
    }
    out(JSON.stringify(report, null, 2) + '\n') // 纯 JSON，不追加任何文本
    // 注意：必须用 process.exitCode 而不是 process.exit()。
    // process.exit() 会截断尚未冲刷的 stdout，令 --json 输出残缺、
    // 下游 JSON.parse 直接抛错。
    process.exitCode = rc
    return
  }

  // 人类可读报告
  out('debugdoctor v' + VERSION + ' — 调试/日志残留体检\n')
  out('扫描根: ' + root + '\n')
  out('扫描文件: ' + files.length + '  总行数: ' + totalLines + '\n')
  out('健康分: ' + score + '/100\n')
  if (allIssues.length === 0) {
    out('未发现调试/日志残留（通过）。\n')
  } else {
    const highs = allIssues.filter((i) => i.severity === 'high')
    const mediums = allIssues.filter((i) => i.severity === 'medium')
    out('发现问题: ' + allIssues.length + '（高危 ' + highs.length + ' / 中危 ' + mediums.length + '）\n')
    // 按严重度排序：high 在前
    const sorted = allIssues.slice().sort((a, b) => (a.severity === b.severity ? a.line - b.line : a.severity === 'high' ? -1 : 1))
    for (const i of sorted) {
      const tag = i.severity === 'high' ? '[高危]' : '[中危]'
      out(tag + ' ' + i.file + ':' + i.line + '  (' + i.ruleId + ') ' + i.message + '\n')
      if (i.snippet) out('      ' + i.snippet.trim() + '\n')
    }
  }
  // 门禁状态始终显式打印：用户必须一眼看出「这次到底判没判定」。
  // 只在失败时打印 = 让人误以为「没消息就是通过」。
  out('\n门禁状态: ' + gate.state + ' — ' + gate.reason + '\n')
  if (gate.reasons.length) {
    err('CI 门禁未通过:\n')
    for (const r of gate.reasons) err('  - ' + r + '\n')
  }
  process.exitCode = rc
}

module.exports = {
  RULES, stripNoise, isRegexContext, langOf, isTestFile, isLoggerModule,
  scanFile, walk, computeScore, computeGate, parseArgs, countLines, MAX_FILE_BYTES,
  exitCodeFor, GATE_STATE, VERSION,
}

if (require.main === module) {
  run(process.argv.slice(2))
}

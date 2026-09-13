#!/usr/bin/env node
'use strict'

// debugdoctor — 零依赖单文件「调试/日志残留卫生体检」CLI
// family 第十五轴 · 源码层第十轴：扫 debugger / console.* / print / fmt.Print* 等开发残留。
// 跨 JS/TS/Python/Go 多语言，输出严重度加权健康分 + CI 门禁。纯 fs 只读，零依赖、零网络。

const fs = require('fs')
const path = require('path')

const VERSION = '1.0.0'

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

// ---- CI 门禁 ----
function computeGate(issues, opts) {
  const highs = issues.filter((i) => i.severity === 'high').length
  const mediums = issues.filter((i) => i.severity === 'medium').length
  const reasons = []
  if (opts.failOnHigh && highs > 0) reasons.push(`存在 ${highs} 个高危残留(debugger)`)
  if (opts.maxHigh != null && highs > opts.maxHigh) reasons.push(`高危数 ${highs} > --max-high ${opts.maxHigh}`)
  if (opts.maxMedium != null && mediums > opts.maxMedium) reasons.push(`中危数 ${mediums} > --max-medium ${opts.maxMedium}`)
  if (opts.maxIssues != null && issues.length > opts.maxIssues) reasons.push(`问题数 ${issues.length} > --max-issues ${opts.maxIssues}`)
  if (opts.minScore != null && opts._score < opts.minScore) reasons.push(`健康分 ${opts._score} < --min-score ${opts.minScore}`)
  return { passed: reasons.length === 0, reasons }
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
      const v = Number(argv[++i])
      if (!Number.isFinite(v)) { errorExit(`标志 ${a} 需要整数参数`, 2) }
      if (a === '--max-high') opts.maxHigh = v
      else if (a === '--max-medium') opts.maxMedium = v
      else if (a === '--max-issues') opts.maxIssues = v
      else if (a === '--min-score') opts.minScore = v
    } else if (STR_FLAGS.has(a)) {
      const v = argv[++i]
      if (v === undefined) { errorExit(`标志 ${a} 需要参数`, 2) }
      if (a === '--root') opts.root = v
      else if (a === '--exclude') opts.excludes.add(v)
    } else if (BOOL_FLAGS.has(a)) {
      if (a === '--json') opts.json = true
      else if (a === '--fail-on-high') opts.failOnHigh = true
      else if (a === '--no-logger-exempt') opts.loggerExempt = false
      else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
      else if (a === '--version' || a === '-V') { out(VERSION + '\n'); process.exit(0) }
    } else if (a.startsWith('--')) {
      errorExit(`未知标志: ${a}`, 2)
    } else {
      positional.push(a)
    }
  }
  if (!opts.root) opts.root = positional[0] || process.cwd()
  return opts
}

function errorExit(msg, code) {
  process.stderr.write('debugdoctor: ' + msg + '\n')
  process.exit(code)
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
    '  -h, --help             帮助\n'
  )
}

function out(s) { process.stdout.write(s) }
function err(s) { process.stderr.write(s) }

// ---- 主流程 ----
function run(argv) {
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
  const gate = computeGate(allIssues, opts)

  if (opts.json) {
    const report = {
      tool: 'debugdoctor',
      version: VERSION,
      root,
      scannedFiles: files.length,
      totalLines,
      score,
      gate: { passed: gate.passed, reasons: gate.reasons },
      issues: allIssues,
      skipped,
    }
    out(JSON.stringify(report, null, 2) + '\n') // 纯 JSON，不追加任何文本
    process.exit(gate.passed ? 0 : 2)
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
  if (gate.reasons.length) {
    err('\nCI 门禁未通过:\n')
    for (const r of gate.reasons) err('  - ' + r + '\n')
    process.exit(2)
  } else {
    out('CI 门禁: 通过\n')
    process.exit(0)
  }
}

module.exports = {
  RULES, stripNoise, isRegexContext, langOf, isTestFile, isLoggerModule,
  scanFile, walk, computeScore, computeGate, parseArgs, countLines, MAX_FILE_BYTES,
}

if (require.main === module) {
  run(process.argv.slice(2))
}

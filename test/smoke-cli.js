'use strict';
// debugdoctor spawn 级冒烟测试：真实起进程，验证**退出码契约**。
// 为什么必须有这一层：本仓单测用手写 ok() + assert，历史上靠 monkey-patch
// process.exit 来验退出码——而那正是最脆弱的做法（源码一改 process.exit
// 就不被调用，patch 永远拿到 null，测试静默失效）。
// 现在一律真实起进程验退出码。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INDEX = path.join(path.resolve(__dirname, '..'), 'index.js');

function run(args) {
  const r = spawnSync('node', [INDEX, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---- 三态门禁：三个历史假绿灯变体，全部实测确认过 ----

test('smoke: empty dir + gate configured -> rc 3, never rc 0', () => {
  const d = tmpdir('dd-smoke-empty-');
  const r = run(['--root', d, '--max-high', '0', '--max-issues', '0', '--min-score', '100']);
  assert.strictEqual(r.code, 3, `空输入必须 inconclusive(rc=3)，实际 ${r.code}：${r.stdout}`);
  assert.ok(!r.stdout.includes('CI 门禁: 通过'), '不得再输出「通过」字样');
  assert.ok(r.stdout.includes('inconclusive'), '应说明无法判定');
});

test('smoke: real debugger but NO gate configured -> rc 3 (最恶劣变体)', () => {
  // 历史缺陷：扫到真 debugger 且用户根本没配门禁，工具却打印「CI 门禁: 通过」rc=0
  const d = tmpdir('dd-smoke-nogate-');
  fs.writeFileSync(path.join(d, 'a.js'), 'function f() {\n  debugger;\n}\n');
  const r = run(['--root', d]);
  assert.strictEqual(r.code, 3, '未配门禁时不得返回 0：' + r.stdout);
  assert.ok(!r.stdout.includes('CI 门禁: 通过'));
  assert.ok(r.stdout.includes('未配置'), '应说明未配门禁');
});

test('smoke: gate configured + high issue -> rc 2', () => {
  const d = tmpdir('dd-smoke-bad-');
  fs.writeFileSync(path.join(d, 'a.js'), 'function f() {\n  debugger;\n}\n');
  const r = run(['--root', d, '--fail-on-high']);
  assert.strictEqual(r.code, 2);
});

test('smoke: gate configured + clean input -> rc 0', () => {
  const d = tmpdir('dd-smoke-good-');
  fs.writeFileSync(path.join(d, 'a.js'), 'function f() {\n  return 1;\n}\n');
  const r = run(['--root', d, '--fail-on-high', '--max-issues', '0']);
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('pass'));
});

test('smoke: --json exposes gate.state and basisComplete', () => {
  const d = tmpdir('dd-smoke-json-');
  fs.writeFileSync(path.join(d, 'a.js'), 'function f() {\n  debugger;\n}\n');
  const r = run(['--root', d, '--json', '--fail-on-high']);
  assert.strictEqual(r.code, 2);
  const j = JSON.parse(r.stdout); // stdout 必须完整未被截断
  assert.strictEqual(j.gate.state, 'fail');
  assert.strictEqual(j.basisComplete, true);
});

test('smoke: empty input --json -> basisComplete false', () => {
  const d = tmpdir('dd-smoke-jsonempty-');
  const r = run(['--root', d, '--json', '--fail-on-high']);
  assert.strictEqual(r.code, 3);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.gate.state, 'inconclusive');
  assert.strictEqual(j.basisComplete, false);
});

test('smoke: gate reasons are surfaced in JSON', () => {
  const d = tmpdir('dd-smoke-reason-');
  fs.writeFileSync(path.join(d, 'a.js'), 'function f() {\n  debugger;\n}\n');
  const j = JSON.parse(run(['--root', d, '--json', '--max-high', '0']).stdout);
  assert.strictEqual(j.gate.state, 'fail');
  assert.ok(j.gate.reasons.length > 0, '失败必须给出原因');
  assert.ok(/max-high/.test(j.gate.reasons[0]), j.gate.reasons[0]);
});

test('smoke: every inconclusive path must return exactly 3', () => {
  // 变异测试逃逸记录：把 `if (gate.state === INCONCLUSIVE) return 3` 改成 return 0
  // 时全绿——因为只有「rc 为 3」这一个观测点不够，必须逐条路径钉死具体数字。
  const emptyDir = tmpdir('dd-smoke-rc-empty-');
  assert.strictEqual(run(['--root', emptyDir, '--fail-on-high']).code, 3, '空输入');

  const dirty = tmpdir('dd-smoke-rc-dirty-');
  fs.writeFileSync(path.join(dirty, 'a.js'), 'function f() {\n  debugger;\n}\n');
  assert.strictEqual(run(['--root', dirty]).code, 3, '未配门禁');

  const allBlank = tmpdir('dd-smoke-rc-blank-');
  // 只有 .txt 文件 → 语言不支持，文件被 langOf 过滤掉 → scanned=0 → 输入为空
  fs.writeFileSync(path.join(allBlank, 'a.txt'), 'debugger;\n');
  const j = JSON.parse(run(['--root', allBlank, '--json', '--fail-on-high']).stdout);
  assert.strictEqual(j.scannedFiles, 0, '前置条件：不支持的文件名应被过滤');
  assert.strictEqual(j.gate.state, 'inconclusive');
});

test('smoke: exit codes are 0/2/3 only, never 1', () => {
  // 历史实现门禁失败退 1，与「运行错误」混淆；家族契约统一为 2
  const dirty = tmpdir('dd-smoke-codes-');
  fs.writeFileSync(path.join(dirty, 'a.js'), 'function f() {\n  debugger;\n}\n');
  const clean = tmpdir('dd-smoke-codes2-');
  fs.writeFileSync(path.join(clean, 'a.js'), 'function f() {\n  return 1;\n}\n');
  assert.strictEqual(run(['--root', dirty, '--fail-on-high']).code, 2, '门禁失败必须退 2');
  assert.strictEqual(run(['--root', clean, '--fail-on-high', '--max-issues', '0']).code, 0, '通过退 0');
  assert.strictEqual(run(['--root', dirty]).code, 3, '未配门禁退 3');
  assert.strictEqual(run(['--bogus']).code, 2, '用法错误退 2');
});

// ---- 参数容错：门禁参数写错 = 门禁不存在 ----

test('smoke: unknown long option -> rc 2', () => {
  assert.strictEqual(run(['--bogus']).code, 2);
});

test('smoke: unknown short option -> rc 2 (历史缺陷：漏到位置参数)', () => {
  const r = run(['-x']);
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('未知标志'), r.stderr);
});

test('smoke: --root missing value -> rc 2', () => {
  const r = run(['--root']);
  assert.strictEqual(r.code, 2);
  assert.ok(!r.stderr.includes('undefined'), r.stderr);
});

test('smoke: --root must not swallow the following flag -> rc 2', () => {
  const r = run(['--root', '--json']);
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('--root'), r.stderr);
});

test('smoke: empty string numeric value -> rc 2 (Number("")===0 trap)', () => {
  const d = tmpdir('dd-smoke-emptystr-');
  fs.writeFileSync(path.join(d, 'a.js'), 'function f() {\n  return 1;\n}\n');
  const r = run(['--root', d, '--max-high', '']);
  assert.strictEqual(r.code, 2);
});

test('smoke: non-integer numeric flag -> rc 2', () => {
  const d = tmpdir('dd-smoke-frac-');
  fs.writeFileSync(path.join(d, 'a.js'), 'function f() {\n  return 1;\n}\n');
  assert.strictEqual(run(['--root', d, '--max-high', '1.5']).code, 2);
});

test('smoke: negative numeric flag -> rc 2', () => {
  const d = tmpdir('dd-smoke-neg-');
  fs.writeFileSync(path.join(d, 'a.js'), 'function f() {\n  return 1;\n}\n');
  assert.strictEqual(run(['--root', d, '--max-issues', '-1']).code, 2);
});

test('smoke: nonexistent root -> rc 2', () => {
  assert.strictEqual(run(['--root', path.join(os.tmpdir(), 'definitely-missing-xyz')]).code, 2);
});

test('smoke: --root pointing at a file -> rc 2', () => {
  const d = tmpdir('dd-smoke-file-');
  const f = path.join(d, 'a.js');
  fs.writeFileSync(f, 'const a = 1;\n');
  assert.strictEqual(run(['--root', f]).code, 2);
});

// ---- stdout 完整性：--help / --version 不得被 process.exit 截断 ----

test('smoke: --help exits 0 and prints the full help', () => {
  const r = run(['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('inconclusive'), '帮助应说明三态');
  assert.ok(r.stdout.includes('退出码'), r.stdout.slice(-200));
});

test('smoke: -h short form exits 0', () => {
  assert.strictEqual(run(['-h']).code, 0);
});

test('smoke: --version exits 0 and matches package.json', () => {
  const r = run(['--version']);
  assert.strictEqual(r.code, 0);
  const pkgPath = path.join(path.resolve(__dirname, '..'), 'package.json');
  if (!fs.existsSync(pkgPath)) return; // 未发布 package.json 时跳过
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.ok(r.stdout.includes(pkg.version), `版本漂移：CLI=${r.stdout.trim()} pkg=${pkg.version}`);
});

test('smoke: large report --json stays complete and parseable', () => {
  const d = tmpdir('dd-smoke-big-');
  for (let i = 0; i < 60; i++) {
    const lines = ['function f' + i + '() {'];
    for (let j = 0; j < 10; j++) lines.push('  debugger;');
    lines.push('}');
    fs.writeFileSync(path.join(d, `f${i}.js`), lines.join('\n') + '\n');
  }
  const r = run(['--root', d, '--json', '--fail-on-high']);
  assert.strictEqual(r.code, 2);
  const j = JSON.parse(r.stdout); // 截断会直接抛错
  assert.strictEqual(j.issues.length, 600);
});

// ---- 排除规则 ----

test('smoke: default-excluded dirs are skipped', () => {
  const d = tmpdir('dd-smoke-excl-');
  fs.mkdirSync(path.join(d, 'node_modules'));
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'node_modules', 'a.js'), 'debugger;\n');
  fs.writeFileSync(path.join(d, 'src', 'b.js'), 'const a = 1;\n');
  const j = JSON.parse(run(['--root', d, '--json', '--fail-on-high']).stdout);
  assert.strictEqual(j.scannedFiles, 1, 'node_modules 应排除，src/ 应保留');
});

test('smoke: --exclude adds extra exclusions', () => {
  const d = tmpdir('dd-smoke-excl2-');
  fs.mkdirSync(path.join(d, 'legacy'));
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'legacy', 'a.js'), 'debugger;\n');
  fs.writeFileSync(path.join(d, 'src', 'b.js'), 'const a = 1;\n');
  const j = JSON.parse(run(['--root', d, '--exclude', 'legacy', '--json', '--fail-on-high']).stdout);
  assert.strictEqual(j.scannedFiles, 1);
});

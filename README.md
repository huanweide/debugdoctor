<!-- badges -->
[![License](https://img.shields.io/github/license/huanweide/debugdoctor)](LICENSE)
[![Stars](https://img.shields.io/github/stars/huanweide/debugdoctor)](https://github.com/huanweide/debugdoctor/stargazers)
[![Engineering Health Family](https://img.shields.io/badge/Engineering%20Health%20Family-18%20axes-22c55e)](https://github.com/huanweide/family-showcase)
<!-- /badges -->

**🔧 Part of the [Engineering Health Family](https://github.com/huanweide/family-showcase)** (18 zero-dependency checkup axes). Standalone tool — see [doctors](https://github.com/huanweide/doctors) (monorepo) and [enghealth](https://github.com/huanweide/enghealth) (unified runner).

# debugdoctor

零依赖单文件「调试 / 日志残留卫生体检」CLI。

扫 JS/TS/Python/Go 源码里遗留的 `debugger` 语句、`console.*` 调试输出、`print/pprint` 调试输出、`fmt/log.Print*` 调试输出，给出严重度加权的健康分，并提供 CI 门禁，让「忘了删的调试代码」在合并前被拦下来。

## 为什么需要

每个代码库都逃不掉 `console.log` / `debugger` 残留。市面方案要么只删不报（`strip-debug-cli`、`console-sanitizer`，且需 `npm install`）、要么只限 JS（`eslint no-console`，需配置）、要么只报不体检。`debugdoctor` 零依赖单文件、开箱即扫、跨四种语言、体检报告 + 健康分 + CI 门禁，市场上没有同款。

## 安装 / 运行

零依赖，只需 Node >= 14。无需 `npm install`。

```bash
node index.js --root ./src
# 或（等价）
node index.js
```

## 规则

| 语言 | 规则 ID | 严重度 | 说明 |
|------|---------|--------|------|
| JS/TS | `debugger-stmt` | 高危 | 遗留 `debugger;` 语句，生产环境会中断执行 |
| JS/TS | `console-call` | 中危 | `console.log/info/warn/error/debug/trace/table/dir/dirxml` 调试输出 |
| Python | `py-print` | 中危 | `print/pprint(...)` 调试输出 |
| Go | `go-print` | 中危 | `fmt.Print*/log.Print*` 调试输出 |

## 豁免机制

- **测试文件** 自动跳过：`*.test.js`、`*.spec.ts`、`__tests__/`、`tests/`、`test_*.py`、`*_test.go`。
- **日志模块** 默认豁免 `console` 残留：路径含 `logger/`、`log/`、`logging/` 的文件（`--no-logger-exempt` 可关闭）。
- **超大文件** 大于 5MB 跳过（防 OOM）。
- **默认排除目录**：`node_modules/`、`.git/`、`dist/`、`build/`、`coverage/`、`.next/`、`out/`、`vendor/` 等。

## 健康分

每千行容忍 4 个当量（`debugger`=3，`console/print`=2）；超出部分每个当量扣 4 分，最低 0 分。容忍基线内的少量残留不扣分，避免误伤生产允许的日志。

## CI 门禁

```bash
# 任一 debugger(高危) 即失败
node index.js --root . --fail-on-high

# 更细的阈值组合
node index.js --root . --max-high 0 --max-medium 5 --max-issues 20 --min-score 90

# JSON 模式：纯 JSON 输出，门禁用退出码表达，不污染 stdout
node index.js --root . --json --fail-on-high
```

### 门禁三态（重要）

扫描型门禁工具最恶劣的失败模式是「**扫了 0 个对象却报通过**」——CI 上就是一盏永不熄灭的绿灯。
debugdoctor 历史上同时有三个变体（均已实测确认）：

1. 空目录 + `--max-high 0 --max-issues 0 --min-score 100` → 照样输出「CI 门禁: 通过」，rc=0
2. 扫到真的 `debugger`、但用户**根本没配门禁** → 也输出「CI 门禁: 通过」，rc=0
3. `--json` 的 `gate` 只有布尔 `passed`，调用方无法区分「达标」与「根本没判定」

所以 debugdoctor 输出三态（`--json` 里见 `gate.state` 与 `basisComplete`）：

| `gate.state` | 退出码 | 含义 |
| --- | --- | --- |
| `pass` | 0 | 配了门禁阈值、输入可信、指标达标 |
| `fail` | 2 | 配了门禁阈值，且存在不达标项 |
| `inconclusive` | 3 | **无法下结论**：未配任何门禁阈值，或扫描输入为空 / 全部文件无可解析内容 |

```jsonc
{
  "scannedFiles": 128,
  "score": 96,
  "gate": {
    "state": "pass",
    "configured": true,
    "reasons": [],
    "reason": "全部指标达标"
  },
  "basisComplete": true   // false 表示本次结论不可信，别拿它当合规证据
}
```

> 未配门禁阈值时返回 `3` 而不是 `0`，是刻意的：这样「我只是跑着看看」不会在 CI 里被误读成「检查通过」。
> 想让它放行，显式写 `--max-high 9999` 即可。

退出码：`0` 通过；`2` 门禁未通过或参数错误；`3` 无法下结论（便于 CI `if` 判断）。

所有数值参数必须是**非负整数**：缺值、空串（`Number('') === 0`）、小数（`--max-high 1.5` 会让
「高危数 1 > 1.5」永远为假，门禁形同失效）、负数、`abc` 一律退 `2`。
未知选项（含 `-x` 这类短标志）同样退 `2`——历史上短标志会漏过校验，
最终变成位置参数被当 `--root`，报出「根目录不存在或无法访问: -x」这种看不懂的错误。

## 选项

```
--root <dir>           扫描根目录（默认当前目录或首个位置参数）
--exclude <name>       额外排除的目录名（可多次指定）
--json                 仅输出纯 JSON 报告（门禁用退出码）
--fail-on-high         存在任何 debugger(高危) 则门禁失败
--max-high <n>         高危数上限
--max-medium <n>       中危数上限
--max-issues <n>       问题总数上限
--min-score <n>        健康分下限
--no-logger-exempt     关闭日志模块的 console 豁免
-V, --version          版本号
-h, --help             帮助
```

## 质量

- 零依赖、纯 `fs` 只读，不联网、不执行用户代码、无命令注入面。
- 逐字符 tokenizer 剥离注释 / 字符串（保留换行，正则上下文感知），杜绝把字符串 / 注释里的 `console` 误报。
- 跨语言、跨平台（Windows / POSIX 路径均验证）。
- 自带单元测试：`node test.js`。

## 家族

`debugdoctor` 是「工程健康 family」第十五轴（源码层第十轴），与 `devdoctor`（明文密钥）/ `secscan`（安全 API 用法）/ `typedoctor`（类型纪律）等同源互补，拼成「源码层静态坏味道」完整体检矩阵。

---

## 作者

由 **ReTr · 樊斯瑞** 维护 · [GitHub 主页](https://github.com/huanweide)

## CI 门禁用法

开箱即可接入 CI：在流水线中运行本工具，它会输出健康分与严重度，并显式打印门禁状态；
若存在不达标项会以退出码 `2` 结束，若无法下结论则以 `3` 结束——**只有真正判定通过才是 `0`**（具体参数见上方「CI 门禁」）。

## 测试

```bash
node --test          # 25 组 spawn 级冒烟 + 36 组单测（Node >= 18）
```

`test/smoke-cli.js` 真实起进程验证**退出码契约**，这一层不可省略：
历史单测靠 monkey-patch `process.exit` 来验退出码，而源码一旦改成 `process.exitCode`，
patch 就永远拿到 `null`，测试静默失效却不报红——只有真起进程才拦得住。

## 赞助支持

如果这个项目帮到了你，欢迎 [点 Star](https://github.com/huanweide/debugdoctor) 支持；也可微信扫码自愿赞助（收款码见 `sponsor/wechat-qr.png`，作者本人带 Tri 水印的码，纯静态图片、不含任何密钥）。

## 许可证

[MIT](LICENSE)
---

## 便携性 · 零依赖承诺

- 零运行时依赖：只用一个 Node 内置模块，无需 `npm install`。
- 单文件：整个工具就是一个 `index.js`，复制进任何仓库即可用。
- 离线 / 跨平台：Node 18+ 即可，不联网、不挑系统。
- 一键跑：`node index.js --root ./src`（详见上方用法）。

← [回到代码健康家族总览](https://github.com/huanweide/family-showcase)

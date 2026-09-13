# debugdoctor

零依赖单文件「调试 / 日志残留卫生体检」CLI。

扫 JS/TS/Python/Go 源码里遗留的 `debugger` 语句、`console.*` 调试输出、`print/pprint` 调试输出、`fmt/log.Print*` 调试输出，给出严重度加权的健康分，并提供 CI 门禁，让「忘了删的调试代码」在合并前被拦下来。

## 为什么需要

每个代码库都逃不掉 `console.log` / `debugger` 残留。市面方案要么只删不报（`strip-debug-cli`、`console-sanitizer`，且需 `npm install`）、要么只限 JS（`eslint no-console`，需配置）、要么只报不体检。`debugdoctor` 零依赖单文件、开箱即扫、跨四种语言、体检报告 + 健康分 + CI 门禁，市场上没有同款。

## 安装 / 运行

零依赖，只需 Node >= 14。无需 `npm install`。

```bash
node debugdoctor.js --root ./src
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
node debugdoctor.js --root . --fail-on-high

# 更细的阈值组合
node debugdoctor.js --root . --max-high 0 --max-medium 5 --max-issues 20 --min-score 90

# JSON 模式：纯 JSON 输出，门禁用退出码 0/2 表达，不污染 stdout
node debugdoctor.js --root . --json
```

退出码：`0` 通过；`2` 门禁未通过或参数错误（便于 CI `if` 判断）。

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

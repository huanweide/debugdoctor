**中文** · [README.md](./README.md)

> [!WARNING]
> **⚠️ This tool has been merged into the [doctors](https://github.com/huanweide/doctors) monorepo and is no longer maintained here.**
>
> The source now lives at [`doctors/packages/debugdoctor/`](https://github.com/huanweide/doctors/tree/main/packages/debugdoctor). Inside doctors it runs as the `doctors debug` subcommand (or `node packages/debugdoctor/index.js`). This repository no longer accepts changes — please use <https://github.com/huanweide/doctors>.

<!-- badges -->
[![License](https://img.shields.io/github/license/huanweide/debugdoctor)](LICENSE)
[![Stars](https://img.shields.io/github/stars/huanweide/debugdoctor)](https://github.com/huanweide/debugdoctor/stargazers)
[![zero-dep checkup CLI](https://img.shields.io/badge/zero--dep%20checkup%20CLI-18%20tools-22c55e)](https://github.com/huanweide/family-showcase)
<!-- /badges -->

**🔧 Part of the [huanweide zero-dependency CLI family](https://github.com/huanweide/family-showcase) (18 single-file tools). Use it standalone, as a subcommand inside the [doctors](https://github.com/huanweide/doctors) monorepo, or run everything together via [enghealth](https://github.com/huanweide/enghealth).**

# debugdoctor

Zero-dependency, single-file "debug / logging residue hygiene" CLI.

Scans JS/TS/Python/Go source for leftover `debugger` statements, `console.*` debug output, `print/pprint` debug output, and `fmt/log.Print*` debug output, gives a severity-weighted health score, and provides a CI gate so "debug code you forgot to delete" gets caught before merge.

## Who should use this

- Multi-language repos (JS/TS/Python/Go) that want one tool to catch leftover debug output.
- Teams that want debug-residue caught in CI, not in a post-mortem.
- Anyone who wants a dependency-free, cross-language hygiene check.

## Who should not use this

- If you only need to *strip* debug code (not report it) — use a strip tool instead.
- If you only use JS and already enforce `eslint no-console` to your taste.
- Note: this repo is deprecated — prefer `doctors debug` for new setups.

## Why you need it

Every codebase ends up with leftover `console.log` / `debugger`. Market options either only delete without reporting (`strip-debug-cli`, `console-sanitizer`, and they need `npm install`), only cover JS (`eslint no-console`, needs config), or only report without a health check. `debugdoctor` is zero-dependency, single-file, runs out of the box, across four languages, with a report + health score + CI gate — there's no equivalent on the market.

## Install and run

Zero dependencies, only Node >= 14 needed. No `npm install`.

```bash
node index.js --root ./src
# or (equivalent)
node index.js
```

> The bundled tests use `node --test` and need Node >= 18.

## Rules

| Language | Rule ID | Severity | What it catches |
|------|---------|--------|------|
| JS/TS | `debugger-stmt` | high | leftover `debugger;` statement, which interrupts execution in production |
| JS/TS | `console-call` | medium | `console.log/info/warn/error/debug/trace/table/dir/dirxml` debug output |
| Python | `py-print` | medium | `print/pprint(...)` debug output |
| Go | `go-print` | medium | `fmt.Print*/log.Print*` debug output |

## Exemption mechanism

- **Test files** auto-skipped: `*.test.js`, `*.spec.ts`, `__tests__/`, `tests/`, `test_*.py`, `*_test.go`.
- **Log modules** exempt from `console` residue by default: files whose path contains `logger/`, `log/`, `logging/` (`--no-logger-exempt` turns this off).
- **Oversized files** larger than 5MB are skipped (OOM guard).
- **Default-excluded dirs**: `node_modules/`, `.git/`, `dist/`, `build/`, `coverage/`, `.next/`, `out/`, `vendor/`, etc.

## Health score

Tolerates 4 "equivalents" per 1k lines (`debugger`=3, `console/print`=2); each equivalent beyond that deducts 4 points, minimum 0. A small amount of residue within the tolerance baseline isn't penalized, so production-allowed logging isn't falsely flagged.

## CI gate

```bash
# Fail on any debugger (high)
node index.js --root . --fail-on-high

# Finer threshold combinations
node index.js --root . --max-high 0 --max-medium 5 --max-issues 20 --min-score 90

# JSON mode: pure JSON output, gate expressed via exit code, no stdout pollution
node index.js --root . --json --fail-on-high
```

### Three-state gate (important)

The worst failure mode for a scanning gate is "**scanned 0 objects but reported pass**" — a green light on CI that never goes out. debugdoctor historically had three variants (all confirmed by testing):

1. Empty dir + `--max-high 0 --max-issues 0 --min-score 100` → still printed "CI gate: pass", rc=0
2. Found a real `debugger`, but the user **configured no gate at all** → also printed "CI gate: pass", rc=0
3. `--json`'s `gate` was only a boolean `passed`, so the caller couldn't distinguish "met" from "never judged"

So debugdoctor outputs three states (see `gate.state` and `basisComplete` in `--json`):

| `gate.state` | Exit code | Meaning |
| --- | --- | --- |
| `pass` | 0 | gate threshold configured, input trustworthy, metrics met |
| `fail` | 2 | gate threshold configured, and at least one item is unmet |
| `inconclusive` | 3 | **cannot conclude**: no gate threshold configured, or scan input empty / all files unparseable |

```jsonc
{
  "scannedFiles": 128,
  "score": 96,
  "gate": {
    "state": "pass",
    "configured": true,
    "reasons": [],
    "reason": "all metrics met"
  },
  "basisComplete": true   // false means this conclusion is untrustworthy; don't use it as compliance evidence
}
```

> Returning `3` instead of `0` when no gate is configured is deliberate: that way "I just ran it to look" won't be misread in CI as "check passed". To let it pass, explicitly write `--max-high 9999`.

Exit codes: `0` pass; `2` gate failed or parameter error; `3` cannot conclude (handy for CI `if`).

All numeric parameters must be **non-negative integers**: missing value, empty string (`Number('') === 0`), decimal (`--max-high 1.5` makes "high count 1 > 1.5" always false, so the gate silently dies), negative, `abc` all exit `2`. Unknown options (including short flags like `-x`) also exit `2` — historically a short flag slipped past validation and ended up as a positional `--root`, producing the cryptic "root does not exist or cannot be accessed: -x".

## Options

```
--root <dir>           scan root (default current dir or first positional)
--exclude <name>       extra directory name to exclude (repeatable)
--json                 output pure JSON report only (gate via exit code)
--fail-on-high         gate fails if any debugger (high) present
--max-high <n>         max high count
--max-medium <n>       max medium count
--max-issues <n>       max total issues
--min-score <n>        min health score
--no-logger-exempt     disable the console exemption for log modules
-V, --version          version
-h, --help             help
```

## Quality

- Zero dependencies, pure `fs` read-only, no network, no execution of user code, no command-injection surface.
- Character-by-character tokenizer strips comments / strings (newlines preserved, regex context-aware), eliminating false `console` reports from strings / comments.
- Cross-language, cross-platform (Windows / POSIX paths both verified).
- Ships unit tests: `node test.js`.

## Family

`debugdoctor` belongs to the huanweide zero-dependency CLI family alongside `devdoctor` (plaintext secrets) / `secscan` (unsafe API usage) / `typedoctor` (type discipline), forming a complete static "source-layer smell" checkup matrix.

---

## Author

Maintained by **huanweide** · [GitHub](https://github.com/huanweide)

## CI gate usage

Runs out of the box in CI: run it in your pipeline, it prints the health score and severity and explicitly prints the gate state; if an item is unmet it ends with exit code `2`, and if it cannot conclude it ends with `3` — **only a genuinely judged pass is `0`** (see "CI gate" above).

## Test

```bash
node --test          # 25 spawn-level smoke tests + 36 unit tests (Node >= 18)
```

`test/smoke-cli.js` really spawns a process to verify the **exit-code contract** — this layer is not skippable: historically the unit tests monkey-patched `process.exit` to verify exit codes, but once the source switched to `process.exitCode`, the patch forever got `null` and the tests silently failed to catch regressions — only a real process spawn catches it.

## License

[MIT](LICENSE)

---

## Portability · zero-dependency promise

- Zero runtime dependencies: uses only one Node built-in module, no `npm install`.
- Single file: the whole tool is one `index.js`, copy it into any repo and it works.
- Offline / cross-platform: Node 18+ is enough, no network, no OS preference.
- One command: `node index.js --root ./src` (see Usage above).

← [Back to the zero-dependency CLI family overview](https://github.com/huanweide/family-showcase)

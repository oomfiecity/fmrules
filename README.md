# fmrules

Declarative YAML → `mailrules.json` compiler for [Fastmail](https://fastmail.com), plus a composite GitHub Action that runs the compile in CI.

Author rules as a plain directory of YAML files; `fmrules` resolves archetypes, applies modules, validates the rendered Fastmail search, and emits a ready-to-import `mailrules.json`.

## Quickstart

```
npm install -g fmrules            # or: bun add -g fmrules
fmrules check --cwd ./rules-repo
fmrules compile --cwd ./rules-repo --out mailrules.json
```

A rules directory looks like:

```
rules-repo/
├── meta/
│   ├── config.yaml          # folder allowlist, file ordering
│   ├── archetypes.yaml      # shared rule skeletons (optional)
│   └── modules/             # declarative YAML + TS modules
└── rules/
    └── github.yaml          # one file per logical group
```

Every top-level field is driven by a single registry ([`src/schema/fields.ts`](src/schema/fields.ts)). The authoring surface is [documented in full here](https://github.com/oomfiecity/fmrules/blob/main/tests/fixtures/basic/rules/anthropic.yaml) alongside the compile pipeline's fixtures in [`tests/fixtures/`](tests/fixtures).

## GitHub Action

```yaml
# .github/workflows/compile.yml
on:
  push: { branches: [main] }

jobs:
  compile:
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
      - id: fmrules
        uses: oomfiecity/fmrules/action@v1
      - if: steps.fmrules.outputs.changed == 'true'
        run: |
          git config user.name  'github-actions[bot]'
          git config user.email 'github-actions[bot]@users.noreply.github.com'
          git add mailrules.json meta/lockfile.json
          git commit -m 'compile: regenerate mailrules.json'
          git push
```

The action downloads the published binary for the runner (Linux x64/arm64, macOS x64/arm64) with SHA-256 checksum verification, runs `fmrules compile`, and reports whether the output changed.

By default it also publishes the compiled `mailrules.json` + `meta/lockfile.json` as a GitHub Release on the consumer repo whenever the compile output changed, tagged `compile-YYYY-MM-DD-<shortsha>`. Pass `release: 'false'` to disable.

### Inputs

| Input | Default | Purpose |
|---|---|---|
| `version` | action ref or `latest` | fmrules release tag to install (e.g. `v1`, `v1.2.3`, `latest`). |
| `rules-dir` | `.` | Working directory that contains `rules/` and `meta/`. |
| `out` | `mailrules.json` | Output path, relative to `rules-dir`. |
| `extra-args` | `''` | Additional flags forwarded verbatim to `fmrules compile`. |
| `token` | `${{ github.token }}` | Token used to download binaries and (optionally) publish releases. |
| `release` | `'true'` | Publish a Release on the consumer repo when output changed. `'false'` disables. |
| `release-tag` | `compile-YYYY-MM-DD-<shortsha>` | Override the release tag. Re-runs with the same tag are idempotent (reuse existing release). |
| `release-name` | tag | Override the release title. |
| `release-notes` | auto | Override the release body (markdown). |

### Outputs

| Output | Meaning |
|---|---|
| `version` | Resolved fmrules version that executed. |
| `changed` | `true` when the rendered output differs from HEAD. |
| `output-path` | Absolute path of the generated `mailrules.json`. |
| `release-tag` | Tag of the published (or pre-existing) release. Empty when the release step was skipped. |
| `release-url` | URL of the published (or pre-existing) release. Empty when skipped. |

Releases never fire on `pull_request` events — PR compiles wouldn't have write access to the base repo and shouldn't publish pre-merge rule state.

## Compiler invariants

- Deterministic output: same YAML inputs compile to byte-identical `mailrules.json`, for any hash-stable operating system / Node runtime.
- Stable timestamps: a lockfile (`meta/lockfile.json`) preserves `created` / `updated` across recompiles, so re-compilation doesn't churn every rule's timestamps.
- Round-trip-safe search: every rendered search string is re-parsed through the same parser Fastmail's server uses and must reach a fixed point under `render`. Forbidden fields (`in:`, `attached:`, `inMailbox:`) are rejected before emit.
- One grammar: rule `match:` trees and declarative-module `transform:` trees share `SearchExprSchema` and `compileSearchExpr`.

## Development

```
bun install
bun run typecheck       # tsc --noEmit
bun test                # 95 tests across 10 files
bun run src/cli.ts check --cwd tests/fixtures/basic
```

Fixtures in `tests/fixtures/` cover the canonical shapes: `basic` (defaults + archetype + module), `fan-out` (TS module producing multiple rules per source), `multi-value`, `nested-matchers`, `spam-kill`.

## License

MIT.

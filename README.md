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

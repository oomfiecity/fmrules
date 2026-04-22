# fmrules

YAML-authoring tool that compiles Fastmail mail rules into `mailrules.json`. Bun/TypeScript CLI plus a composite GitHub Action for downstream rule repos.

## Commands

| Command | What it does |
|---|---|
| `fmrules check` | Validate YAML sources without emitting. |
| `fmrules compile` | Emit `mailrules.json` + `meta/lockfile.json`. |
| `fmrules migrate` | Codemod legacy YAML shapes (plural / `_all` matchers → nested). |
| `fmrules match` | Report which rules in this repo would match an email. |
| `fmrules revert` | Reverse-engineer Fastmail JSON rules back to YAML. |
| `fmrules login` | Open a browser to sign in to Fastmail; save session to `auth.json`. |
| `fmrules sync` | Delete all Fastmail filters and import a `mailrules.json` (local file or GitHub release). |
| `fmrules install-browsers` | Pre-download Chromium via playwright-core (sync auto-installs on first use if skipped). |

Global flags (all commands): `--rules`, `--meta`, `--cwd`, `--verbose`/`-v`, `--quiet`/`-q`, `--color`.

## `fmrules match`

Given an email, evaluate every rule in the current repo's source YAML against it using the `SearchNode` IR built by the compile pipeline. Returns a tri-state per rule: matched, no-match, or undetermined (when the rule contains state-dependent operators like `is:read` that aren't knowable from the email alone).

### Usage

```
fmrules match <path>             # auto-detect .eml vs .json by extension/sniff
fmrules match --stdin            # read from stdin
fmrules match --json <path>      # force JSON parsing
fmrules match --eml <path>       # force .eml parsing
fmrules match --output json      # JSON output (default: human)
fmrules match --trace            # per-leaf evaluation trace
fmrules match --rule <name>      # restrict to a single rule
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | At least one rule matched. |
| `1` | No rule matched (some may be undetermined — read JSON for nuance). |
| `2` | Error (file not found, invalid input, pipeline failure). |

### Canonical JSON input

```json
{
  "headers": { "From": "a@b.com", "Subject": "...", "List-Id": "<x.example.com>" },
  "body": "plain text body"
}
```

Header values may be `string` or `string[]`. Header names are case-insensitive on read. `body` is optional (defaults to `""`).

### JSON output schema

```json
{
  "email": { "from": "...", "subject": "...", "listId": null },
  "totalRules": 5,
  "evaluatedRules": 5,
  "matched": [
    { "name": "Anthropic receipts", "file": "anthropic.yaml", "result": "true",
      "trace": [ { "op": "from:anthropic.com", "outcome": "true", "reason": "..." } ] }
  ],
  "undetermined": [
    { "name": "...", "file": "...", "result": "unknown", "reason": "raw: opaque expression: is:read" }
  ],
  "noMatch": 2
}
```

`trace` is only emitted when `--trace` is passed.

### Match semantics (assumptions)

| Operator | Matches when |
|---|---|
| `from:X` | `From` header contains `X` (substring, case-insensitive). |
| `to:X` | `To` ∪ `Cc` ∪ `Bcc` contains `X`. |
| `cc:X` / `bcc:X` | The respective header contains `X`. |
| `subject:X` | `Subject` contains `X`. |
| `body:X` | Body text contains `X`. |
| `with:X` | Any header value or body contains `X`. |
| `list:<X>` | `List-Id` header contains `<X>` (angle-bracketed canonical form). |
| `header:"Name:value"` | `headers[Name]` (case-insensitive) contains `value`. |
| Bare phrase | `Subject` ∪ body contains the phrase. |
| `raw` (e.g. `is:read`, `has:attachment`) | **Always undetermined** — these depend on mailbox state, not email content. |

Substring matching is **case-insensitive** throughout. This matches the Fastmail convention but is unverified against the live engine; if the agent reports false negatives, revisit.

## `fmrules sync`

Pushes a compiled `mailrules.json` into a Fastmail account: wipes all existing filters, imports the new set, and verifies the count against server response. Uses a headless Chromium session (via playwright-core) since Fastmail doesn't expose a public API for filter management.

### One-time setup

```
fmrules login --auth ./auth.json   # headed browser opens; complete login; session is saved
```

Chromium is auto-downloaded the first time a sync runs. To pre-provision (e.g. on CI or a new dev machine):

```
fmrules install-browsers
```

### Usage

```
fmrules sync --file ./mailrules.json                     # sync from a local compile output
fmrules sync --repo owner/rules-repo                     # fetch the latest mailrules.json from that repo's latest release
fmrules sync --file ./mailrules.json --headed            # watch the browser as it runs
fmrules sync --file ./mailrules.json --auth /tmp/a.json  # custom auth path
```

Exactly one of `--file` or `--repo` must be provided.

### Flags

| Flag | Default | Description |
|---|---|---|
| `--file <path>` | — | Local `mailrules.json` to sync. Mutually exclusive with `--repo`. |
| `--repo <owner/name>` | `$GITHUB_REPO` | Fetch latest `mailrules.json` release from this GitHub repo. |
| `--auth <path>` | `$FASTMAIL_AUTH_PATH` or `./auth.json` | Playwright storage state file written by `fmrules login`. |
| `--chromium <path>` | auto-detect | Override the Chromium executable. |
| `--headed` | `false` | Show the browser window during sync. |

### Environment variables

| Variable | Used by |
|---|---|
| `GITHUB_TOKEN` | `sync --repo` — required to fetch release assets. |
| `GITHUB_REPO` | `sync` — default for `--repo`. |
| `FASTMAIL_AUTH_PATH` | `sync` / `login` — default for `--auth`. |
| `PLAYWRIGHT_BROWSERS_PATH` | Chromium detection / install location. |

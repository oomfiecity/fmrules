# fmrules

YAML-authoring tool that compiles Fastmail mail rules into `mailrules.json`. Bun/TypeScript CLI plus a composite GitHub Action for downstream rule repos.

Format reference: [SPEC(10).md](SPEC(10).md).

## Commands

| Command | What it does |
|---|---|
| `fmrules check` | Validate YAML sources without emitting. Runs phases 1–4 of the pipeline (§11.2). |
| `fmrules compile` | Emit `mailrules.json` (+ `meta/lockfile.json` by default). |
| `fmrules login` | Open a browser to sign in to Fastmail; save session to `auth.json`. |
| `fmrules sync` | Delete all Fastmail filters and import a `mailrules.json` (local file or GitHub release). |
| `fmrules verify` | Check rules against live mailbox content, server-side and read-only. |
| `fmrules apply` | Retroactively apply rules to an existing mailbox via JMAP (SPEC(10).md §11.3). |
| `fmrules install-browsers` | Pre-download Chromium via playwright-core (sync auto-installs on first use if skipped). |

Global flags (all commands): `--cwd`, `--verbose`/`-v`, `--quiet`/`-q`, `--color`.

Compile flags: `--out <path>` (default `mailrules.json`), `--no-lockfile`, `--dry-run`.

## Project layout

Per SPEC(10).md §4:

```
your-rules-project/
  manifest.yml            # required — declares rule file order
  rules/                  # .yml files under here; manifest pins order
    00-spam-and-blocks.yml
    10-work-routing.yml
  snippets/               # reusable condition fragments, referenced by `extends:`
    domains/
      work.yml
  meta/
    lockfile.json         # generated — preserves `created` timestamps
```

Every `.yml` file under `rules/` must be listed in `manifest.yml`'s `order` (and vice versa). Paths are case-sensitive (§4).

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

## Drift warning

The compiler is one-way — YAML is the source of truth. Any change made through Fastmail's web interface will be overwritten by the next `fmrules sync`. Treat the Fastmail web UI as read-only for rules once an `fmrules` project is in use. See SPEC(10).md §11.3.

## `fmrules verify`

Evaluates every rule (or `--rule <substring>`) against real mailbox content
using Fastmail's own search engine, without changing anything. For each rule
it reports how many messages in the scope mailbox the rule's condition would
claim, a sample of matches, and the actions that would fire. Rules that match
nothing are flagged — usually the fastest signal that a newly written or
edited rule doesn't mean what you intended.

```
fmrules verify                                  # all rules vs the whole Inbox
fmrules verify --rule "Tumblr" --limit 3        # one rule, 3 samples
fmrules verify --mailbox Archive --after 2026-01-01
```

Matching is delegated to the server via structured JMAP `Email/query`
filters, so semantics (stemming, header substring matching, address handling)
are Fastmail's own rather than a reimplementation. Two caveats:

- Delivery-time predicates (`conv_followed`, `msg_pinned`, …) match against
  *current* message state, which is not necessarily the state at delivery.
- VIP and contact-group membership have no server-side filter equivalent;
  rules using them are reported as not server-evaluable.

## `fmrules apply`

Fastmail's rule engine only fires at delivery. `apply` is the external tool
SPEC(10).md §11.3 anticipated: it evaluates the rule chain (manifest order,
stop semantics) through the same server-side matching as `verify`, then
performs each rule's actions directly with `Email/set` — labels, read state,
archive, spam, trash.

```
fmrules apply --dry-run                # plan only: per-rule match and change counts
fmrules apply --yes                    # actually mutate (required, no prompt)
fmrules apply --rule "Zeus" --yes      # scope to one rule
fmrules apply --after 2026-04-22 --yes # scope by date
```

Mutation notes: current `mailboxIds`/`keywords` are fetched per message and
complete desired maps are written back (Fastmail's `Email/set` replaces whole
maps). Delivery-only actions (`notify`, `send_copy_to`, `snooze_until`) are
reported and skipped.

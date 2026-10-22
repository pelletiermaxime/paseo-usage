# Paseo Usage

A standalone Usage plugin for **Paseo 0.12.0**, porting and adapting [T3 Code](https://github.com/pingdotgg/t3code)'s usage interface and history/pricing readers. Track Codex, Claude Code, Grok Build, OpenCode, Antigravity, Pi, and Cursor usage with costs, tokens, smooth charts, model breakdowns, and subscription limits.

Historical usage comes directly from each provider: local session logs or conversation databases on the selected Paseo host, and Cursor’s account usage API.

## Features

- **Cost / Tokens / Limits** views and **Past 24h / 7 days / 30 days / 90 days** periods.
- History from sessions outside Paseo, including Codex archives, Claude subagent logs, Pi forks and tool/summary costs, OpenCode legacy JSON and SQLite, and Antigravity generation/step metadata.
- Cursor account-wide usage via its saved CLI login, with pagination, account deduplication, a five-minute in-memory cache, and explicit refresh. No transcript-based token guesses.
- Smooth hourly and daily area charts, provider filtering, model rankings, and detailed token breakdowns.
- Cached, uncached, cache-write, output, and reasoning counts, cache savings, and recorded speed.
- Downloaded model prices cached on disk for 12 hours, editable USD prices per million tokens, and model mapping. Unknown models remain **Unpriced**.
- Subscription limits, plans, balances, and reset countdowns exposed by Paseo's public provider API.
- Host-scoped preferences; `C`, `T`, and `L` view shortcuts; Ctrl/Cmd+Shift+1–4 period shortcuts outside fields and dialogs.

API cost estimates represent equivalent token costs, rather than subscription charges. Reasoning tokens are already included in output. Codex logs without a recorded service tier use standard pricing.

## Install from source

Use Node from `.node-version` and [VitePlus](https://viteplus.dev). This project pins pnpm through its `packageManager` field and has its own dependency lockfile.

With `vp` available in the daemon's PATH, install directly from GitHub:

```sh
paseo plugin install https://github.com/pelletiermaxime/paseo-usage --id usage
```

The plugin's build step runs `vp install --prod --frozen-lockfile --ignore-scripts` before Paseo compiles it, including on a fresh checkout. This installs runtime dependencies without running dependency lifecycle scripts.

From this project's directory:

```sh
vp install --frozen-lockfile
vp check
vp run test
paseo plugin install "$PWD" --id usage
paseo plugin ls usage --json
```

Select the existing desktop daemon with Paseo's `--home` or `--host` options if your CLI uses a different target. Open **Usage** from the sidebar or run **Open Usage** from the command menu. No Task Workspaces plugin or other project checkout is required.

In Usage's environment menu (click the host name in the top bar), choose **History sources** to add provider directories or Cursor CLI login files, or **Model prices** to customize estimates. Logs are read on the daemon host. Refresh checks active and archived logs, reuses unchanged files, reads appended JSONL data, and invalidates SQLite snapshots when the database or WAL changes. Cursor refresh re-fetches account usage from cursor.com; removing the saved login drops cached totals from the next scan. Model prices are cached on disk for 12 hours and reused across plugin reloads and daemon restarts. A missing or expired cache triggers an HTTPS download with an eight-second timeout. Failed downloads retain the last good cached table and retry after an hour; refreshing usage does not bypass the price TTL. The cache stores the actual download timestamp, and no update timestamp is claimed until prices have been downloaded. Without cached prices and a successful download, costs remain unpriced unless custom prices or provider-reported costs are available. On Linux the cache is `$XDG_CACHE_HOME/paseo-usage/model-prices.json` or `~/.cache/paseo-usage/model-prices.json`; macOS uses `~/Library/Caches/paseo-usage`, and Windows uses `%LOCALAPPDATA%/paseo-usage`.

After changing installed source:

```sh
vp check
vp run test
paseo plugin reload usage
```

## Development

Use VitePlus for formatting, linting, type checks, tests, and the optional browser preview:

```sh
vp fmt
vp check
vp run test
vp run preview:usage
```

The preview binds `http://127.0.0.1:5178`, renders the same page through React Native Web, and uses the same provider readers as the plugin. Cursor can contact cursor.com when a CLI login is available. Preview settings stay in memory and subscription limits are empty without a connected daemon. The preview is a development aid; desktop interaction must be checked separately in Paseo.

Paseo builds the plugin from `index.client.tsx` and `index.server.ts`. Client code lives in `client/`, history readers and pricing in `server/`, and shared RPC contracts in `shared/`. Tests use synthetic records and cover counters, copied rollouts, fork suppression, archives, Claude duplicates, cache invalidation, calendar windows, DST, pricing, chart rendering, and UI controls.

## Data and coverage

History readers use these provider-owned sources:

| Provider    | Default source and environment overrides                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex       | `CODEX_HOME` or `~/.codex`; `sessions` and `archived_sessions` JSONL                                                                                                                 |
| Claude Code | `CLAUDE_CONFIG_DIR` or `~/.claude`; `projects` JSONL, including subagents                                                                                                            |
| Grok Build  | `GROK_HOME` or `~/.grok`; only `sessions/**/updates.jsonl` completed turns                                                                                                           |
| Pi          | `PI_CODING_AGENT_SESSION_DIR`, or `sessions` under `PI_CODING_AGENT_DIR` or `~/.pi/agent`                                                                                            |
| OpenCode    | Comma-separated `OPENCODE_DATA_DIR`, otherwise `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`; `opencode*.db` and legacy `storage/message` JSON                              |
| Antigravity | Comma-separated `ANTIGRAVITY_DATA_DIR`, otherwise `~/.gemini/{antigravity,antigravity-cli,antigravity-ide,antigravity-backup}` and `~/.config/antigravity`; conversation `.db` files |
| Cursor      | Dashboard account API using CLI `auth.json`: `~/.config/cursor` on Linux (respects `XDG_CONFIG_HOME`), `%APPDATA%/Cursor` on Windows, or `~/.cursor` on macOS with file storage      |

Add more directories or Cursor CLI login files in **History sources**, one absolute or `~/` path per line. Pi custom session directories are supported. Antigravity directories can point to a `conversations` directory or its parent.

Cursor history includes usage across machines for that account. Duplicate logins count once. API-key or in-memory Cursor authentication cannot supply dashboard history; a saved CLI login is needed. On macOS, **Allow Cursor Keychain access** is off by default. Enabling it reads the `cursor-access-token` / `cursor-user` Keychain entry and may prompt on the host Mac. Access is bounded by a timeout. Credentials remain on the host and are sent only to the fixed `https://cursor.com` endpoint, with redirects rejected. They are never returned over the plugin RPC or saved in plugin preferences.

SQLite readers require the host's built-in `node:sqlite`; unavailable SQLite support, unreadable databases, and failed API requests are shown as partial sources. Databases are opened read-only with a short busy timeout. Tests use temporary synthetic logs/databases and mocked HTTP, never personal history or live credentials.

Missing or deleted history cannot be reconstructed. The file cache stays in memory, and history removed from disk stops contributing to totals. The page shows the exact date range and time zone; incomplete or invalid records are handled silently. These boundaries can produce different totals from another application's retained history.

Usage covers one selected Paseo host. Add custom provider locations explicitly when needed. Subscription limits are restricted to information exposed by Paseo 0.12.0's public API. Empty history, unknown model prices, and unavailable limits remain explicit states.

**Check limits** rereads the daemon's available values. Paseo may cache provider readings for up to five minutes; its public plugin API cannot force a provider update. The limits view shows the last successful host check separately from provider update timestamps, when available.

## License and attribution

[MIT](LICENSE). Downloaded model prices come from LiteLLM. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for upstream revisions and license notices.

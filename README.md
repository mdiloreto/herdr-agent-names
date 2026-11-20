# herdr-agent-names

Automatic tab titles, pane headers, and optional stale-shell cleanup for [Herdr App](https://herdr.dev) — works seamlessly across both local and remote `herdr-core` machines.

## Features

- **Automatic tab naming (local & remote):** infers concise tab titles from active agent sessions, terminal OSC titles, current step reports, git branches, and folders.
- **Safe remote machine support:** filters out `herdr-app`'s terminal-address fallback (`<host>/tXX` and bare `tXX` IDs) so agents without an OSC title never turn tabs or pane headers into raw IP/terminal addresses, and resolves each remote machine's `$HOME` to shorten `/home/<user>` to `~`.
- **Configurable namer chain with zero-LLM fallback:** tries any configured tool-less CLI namer (`claude`, `opencode`, `agy`), cools down unavailable CLIs for 1 hour, and falls back to deterministic rule-based naming (`session` / `program` / `folder`) when no LLM CLI is installed or `"namers": []` is set.
- **Respects manual tab names:** typing a custom tab name keeps it for at least `rename_window` (and keeps it permanently on idle shell tabs); clearing a tab name to `""` hands control back.
- **Pane headers (`shared("pane-heads")`):** publishes session title, optional context percentage (`claude.ctx`), and shortened folder path for pane header mods such as `better-changes`.
- **Optional empty-shell cleanup (`cleanup.enabled`):** opt-in (`false` by default) local-only watcher that marks untouched prompt-only shell tabs with ` · stale` and closes them after `stale_after` (never closing focused tabs, a space's last tab, or remote tabs).

## Installation

Clone into your Herdr App mods directory:

```bash
git clone https://github.com/mdiloreto/herdr-agent-names.git ~/.config/herdr-app/mods/herdr-agent-names
```

Verify the mod loads cleanly:

```bash
herdr-app check ~/.config/herdr-app/mods/herdr-agent-names
```

Add it as a zero-size block inside your personal Herdr App layout JSON (e.g. `~/.config/herdr-app/layouts/<your-layout>.json`):

```json
{
  "id": "agent-names-daemon",
  "type": "block",
  "size": { "px": 0 },
  "content": {
    "mod": "herdr-agent-names"
  }
}
```

## Configuration (`mod.json`)

Edit the `settings` block inside `~/.config/herdr-app/mods/herdr-agent-names/mod.json` (Herdr reloads the mod on save):

```json
{
  "place": "none",
  "title": "Agent names",
  "settings": {
    "pane_heads": {
      "enabled": true
    },
    "tabs": {
      "enabled": true,
      "remote": true,
      "rename_window": "10m",
      "namers": ["claude", "opencode", "agy"],
      "claude_model": "haiku",
      "agy_model": "gemini-3.8-flash-low",
      "opencode_models": [],
      "opencode_free_models_file": ""
    },
    "cleanup": {
      "enabled": false,
      "stale_after": "24h",
      "check_every": "5m",
      "log_path": ".local/state/herdr-tab-cleanup.log"
    }
  }
}
```

| Setting | Default | Description |
|---|---|---|
| `pane_heads.enabled` | `true` | Publish session titles and folder details to `shared("pane-heads")`. |
| `tabs.enabled` | `true` | Enable automatic tab renaming. |
| `tabs.remote` | `true` | Also name tabs on remote `herdr-core` machines. |
| `tabs.rename_window` | `"10m"` | Minimum time between re-namings of the same tab (`ms`, `s`, `m`, `h`). |
| `tabs.namers` | `["claude", "opencode", "agy"]` | Ordered provider chain. Set to `[]` for pure zero-LLM rule-based naming. |
| `tabs.claude_model` | `"haiku"` | Model passed to `claude -p --model ...`. |
| `tabs.agy_model` | `"gemini-3.8-flash-low"` | Model passed to `agy --agent tab-namer --model ...`. |
| `tabs.opencode_models` | `[]` | Explicit OpenCode model IDs (e.g. `["opencode/gpt-5-nano"]`). |
| `tabs.opencode_free_models_file` | `""` | Optional JSON file (`{ "models": { "<id>": { "last_ok": ..., "cooldown_until": ... } } }`) used when `opencode_models` is empty. |
| `cleanup.enabled` | `false` | Mark empty local shell tabs ` · stale` and close after `stale_after`. |
| `cleanup.stale_after` | `"24h"` | How long an untouched shell tab stays empty before closing. |
| `cleanup.check_every` | `"5m"` | Poll interval for empty-shell checks. |
| `cleanup.log_path` | `".local/state/herdr-tab-cleanup.log"` | Relative (to `$HOME`) or absolute audit log written before closing any tab. |

## Optional: Claude Code `herdr-core` labels

For Claude Code sessions that don't emit an OSC terminal title, add this snippet to your Claude `statusLine` script so `herdr-agent-names` can read `claude.title` and `claude.ctx` directly from `herdr-core` (including over remote machines):

```sh
if [ -n "${HC_TERMINAL_ID:-}" ] && command -v hc >/dev/null 2>&1; then
  hc_ctx=""
  [ -n "$used_pct" ] && hc_ctx="$(printf '%.0f' "$used_pct")%"
  hc label "$HC_TERMINAL_ID" \
    "claude.session=${session_id}" \
    "claude.title=${session_name}" \
    "claude.ctx=${hc_ctx}" \
    "claude.dir=${project_dir}" \
    "claude.cwd=${cwd}" >/dev/null 2>&1 || true
fi
```

And clear those labels in a Claude `SessionEnd` hook when a session ends intentionally (`reason != "other"`).

## Development & Tests

Requires Node.js 20+:

```bash
node --test tests/*.test.mjs
```

## License

MIT

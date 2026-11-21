# herdr-agent-names

Automatic tab titles, pane headers, and optional stale-shell cleanup for [Herdr App](https://herdr.dev) — works seamlessly across both local and remote `herdr-core` machines.

## Features

- **Universal coding agent support (local & remote):** generates real task-based tab titles for all coding agents (Antigravity, oh-my-pi, Codex, Pi, Gemini, Copilot, Crush, Amp, Kimi, Kiro, Claude Code, OpenCode, etc.) using `herdr-core` session labels (`agent.title`, `session.title`, `agy.title`, `claude.title`, `pi.session`), terminal OSC titles, step reports, git branches, folders, and optional sanitized screen excerpts (`tabs.read_screen`).
- **Native Antigravity CLI (`agy`) plugin bundled (`plugins/herdr-agy-titles`):** reads AGY's native `annotations/<conversationId>.pbtxt` titles with zero extra LLM calls and publishes them to both **Herdr App** (`agy.title`, `agy.session`, `agy.dir`, `agy.cwd` via `hc label`) and **Herdr TUI** (`herdr pane report-metadata`).
- **Smart title filtering & screen fallback:** filters out `herdr-app`'s terminal-address fallback (`<host>/tXX` and bare `tXX` IDs) and raw zsh CLI invocations (e.g. `agy --dangerously-skip-permissions`, `claude --resume ...`, `codex --no-daemon`). When a non-shell agent exposes no label, title, or step report and `tabs.read_screen` is enabled, reads the recent terminal lines via `hc read`, strips ANSI/box-drawing/nerd-font/timestamp noise, and upgrades generic program-name tabs promptly.
- **Safe remote machine support:** resolves each remote machine's `$HOME` to shorten `/home/<user>` to `~` and keeps remote terminals from turning tabs or pane headers into raw IP/terminal addresses.
- **Configurable namer chain with remote `claude` & zero-LLM fallback:** tries any configured local tool-less CLI namer (`claude`, `opencode`, `agy`), cools down unavailable CLIs for 1 hour, falls back to running `claude` on the tab's remote machine (with isolated per-host cooldown tracking) when all local providers are unavailable, and falls back to deterministic rule-based naming (`session` / `program` / `folder`) when no LLM CLI answers or `"namers": []` is set.
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
      "read_screen": true,
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
| `tabs.read_screen` | `true` | Read a sanitized excerpt of the last 40 terminal lines (`hc read`) for non-shell agents that expose no session label, title, or step report. |
| `tabs.rename_window` | `"10m"` | Minimum time between re-namings of the same tab (`ms`, `s`, `m`, `h`). |
| `tabs.namers` | `["claude", "opencode", "agy"]` | Ordered local provider chain (with automatic remote-machine `claude` fallback for remote tabs when all local providers fail). Set to `[]` for pure zero-LLM rule-based naming. |
| `tabs.claude_model` | `"haiku"` | Model passed to `claude -p --model ...`. |
| `tabs.agy_model` | `"gemini-3.8-flash-low"` | Model passed to `agy --agent tab-namer --model ...`. |
| `tabs.opencode_models` | `[]` | Explicit OpenCode model IDs (e.g. `["opencode/gpt-5-nano"]`). |
| `tabs.opencode_free_models_file` | `""` | Optional JSON file (`{ "models": { "<id>": { "last_ok": ..., "cooldown_until": ... } } }`) used when `opencode_models` is empty. |
| `cleanup.enabled` | `false` | Mark empty local shell tabs ` · stale` and close after `stale_after`. |
| `cleanup.stale_after` | `"24h"` | How long an untouched shell tab stays empty before closing. |
| `cleanup.check_every` | `"5m"` | Poll interval for empty-shell checks. |
| `cleanup.log_path` | `".local/state/herdr-tab-cleanup.log"` | Relative (to `$HOME`) or absolute audit log written before closing any tab. |

## Optional: Antigravity CLI (`agy`) Session Titles Plugin

This repository bundles a native Antigravity CLI plugin at `plugins/herdr-agy-titles` that publishes AGY's own generated session titles with **zero extra LLM calls**:

- **How it works:** hooks `SessionStart`, `PreInvocation`, `PostInvocation`, and `Stop`, reads AGY's native conversation annotation (`<app_data_dir>/annotations/<conversationId>.pbtxt`), and publishes the title to:
  - **Herdr App** (`herdr-core`): sets `agy.title`, `agy.session`, `agy.dir`, and `agy.cwd` via `hc label` after verifying the terminal foreground belongs to Antigravity (cached per terminal to avoid redundant calls).
  - **Herdr TUI** (`HERDR_ENV=1`): publishes `herdr pane report-metadata` (`--source user:pane-title --agent agy`) with `task` / `was` tokens and respects the pane's `agent_session` guard.
- **Turn-1 async polling:** when `.pbtxt` has not been written yet on the first turn, the hook returns its JSON response immediately and detaches a background poller that publishes as soon as the title appears.
- **Nested/headless safety:** automatically skips headless `agy -p`, `--print`, and `--agent tab-namer` invocations so internal helper runs never clobber an active pane's labels. Set `HERDR_AGY_TITLE_DISABLE=1` to temporarily disable.

### Installing the AGY Plugin

Install with the Antigravity CLI from a clone of this repo:

```bash
agy plugin install ./plugins/herdr-agy-titles
```

Or symlink/copy it directly into `~/.gemini/config/plugins/herdr-agy-titles`:

```bash
ln -s "$PWD/plugins/herdr-agy-titles" ~/.gemini/config/plugins/herdr-agy-titles
```

## Optional: `herdr-core` session labels

Any agent or hook can publish a session title directly to `herdr-core`; `herdr-agent-names` reads labels only when the pane is running an agent (so exiting an agent back to a shell never shows stale session titles) and checks them in priority order:

1. `agent.title` (generic agent label — works for any coding agent)
2. `session.title` (generic session label)
3. `agy.title` (Antigravity CLI sessions — paired with `agy.cwd` for folder display)
4. `claude.title` (Claude Code label — paired with `claude.cwd` for folder display)
5. `pi.session` (Pi / oh-my-pi sessions)

For any coding agent or wrapper script:

```sh
if [ -n "${HC_TERMINAL_ID:-}" ] && command -v hc >/dev/null 2>&1; then
  hc label "$HC_TERMINAL_ID" "agent.title=${session_title}" >/dev/null 2>&1 || true
fi
```

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

Requires Node.js 20+ and Python 3.9+:

```bash
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p '*_test.py' -v
agy plugin validate plugins/herdr-agy-titles --strict
```

## License

MIT

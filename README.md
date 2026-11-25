# local-claude-agent

Installs and registers the [Claude Agent SDK ACP agent](https://github.com/agentclientprotocol/claude-agent-acp) as a custom agent in JetBrains IDEs (2025.3+) — IntelliJ IDEA, PyCharm, WebStorm, PhpStorm, RubyMine, CLion, GoLand, Rider, DataGrip, RustRover, and Android Studio — via the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/). Once installed, Claude shows up as a selectable agent in the JetBrains AI Chat tool window. The project also registers local [Codex and OpenCode](#codex-and-opencode) installations alongside Claude.

**Why use this instead of JetBrains AI Assistant's built-in Claude support?** This wires the IDE up to your **local Claude Code CLI** installation. Auth is handled by logging in to the CLI (`claude`) with your own Anthropic account, so it runs on **your existing Claude plan** (Pro/Max/Team subscription) — not JetBrains AI credits, and not a separate `ANTHROPIC_API_KEY`/pay-per-token API bill (that's only used as a fallback if you don't want to log in via the CLI).

In 2026.3 IDEs this holds only while the agent's AI source (the selector in the chat input) is **Agent login**. With **JetBrains AI** selected, the IDE routes the agent through its own LLM proxy (`[providers/set]` in the agent's log) and bills JetBrains AI credits. Check the selector after installing.

Two equivalent installers are provided:

- `install-claude-acp-jetbrains.sh` — macOS / Linux
- `install-claude-acp-jetbrains.ps1` — Windows (PowerShell)

## What the scripts do

1. **Node.js** — check for Node.js >= 22; install it if missing or too old (via Homebrew/apt/nvm on macOS/Linux, or winget/choco on Windows).
2. **Install the ACP agent** — install the pinned version of `@agentclientprotocol/claude-agent-acp` globally via npm, apply the local patches for it (see [Local patches](#local-patches)), and resolve the path to its executable/entry point.
3. **Claude Code CLI (auth)** — check for the local `claude` CLI, offering to install it if missing, and point the agent at it (`CLAUDE_CODE_EXECUTABLE`, see [Which Claude Code runs](#which-claude-code-runs)). Authentication is done by logging in to this CLI (`claude`), reusing your existing Claude subscription/plan rather than requiring JetBrains AI credits or a paid API key. As a fallback, if no CLI login is found but `ANTHROPIC_API_KEY` is set in the environment, the script asks before embedding it in plaintext in the config file — this is not the default or recommended path.
4. **Register the agent** — write/merge an entry into the JetBrains ACP config (`~/.jetbrains/acp.json` on macOS/Linux, `%USERPROFILE%\.jetbrains\acp.json` on Windows), pointing it at the installed agent binary. Existing config is backed up first (`acp.json.bak.*`) and merged rather than overwritten, so other configured agents are preserved.
5. **Detect installed JetBrains IDEs** — best-effort, informational scan of common install locations (Toolbox, `/Applications`, `Program Files`, etc.) to confirm a compatible IDE is present. This step never fails the script.

## Usage

**macOS / Linux:**
```bash
./install-claude-acp-jetbrains.sh
```

**Windows:**
```powershell
powershell -ExecutionPolicy Bypass -File .\install-claude-acp-jetbrains.ps1
```

## Codex and OpenCode

`register-acp-agent.mjs` adds either agent to the same JetBrains ACP config as the
Claude installers. It requires Node.js 22 or later and a local ACP executable or Node.js adapter
entry point. Run the commands for the agents you want, then restart the IDE and select
**Codex (ACP)** or **OpenCode (ACP)** in AI Chat.

### Codex

Install the [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp) and pass its
entry point to the registration command. For example, on macOS and Linux:

```bash
npm install --prefix "$HOME/.local/share/codex-acp" @agentclientprotocol/codex-acp
node register-acp-agent.mjs codex \
  "$HOME/.local/share/codex-acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js"
```

On Windows, pass the adapter's `dist\index.js` or a standalone `codex-acp.exe`.
The adapter includes a compatible Codex CLI and supports ChatGPT sign-in. To use a specific
local Codex executable, pass its path as the last argument to the registration command.

### OpenCode

Install [OpenCode](https://opencode.ai/docs/), configure a model provider in the CLI,
then register the path to its executable:

```bash
node register-acp-agent.mjs opencode "$(command -v opencode)"
```

On Windows, use `node register-acp-agent.mjs opencode (Get-Command opencode.exe).Source`
in PowerShell. JetBrains starts the executable with [`acp`](https://opencode.ai/docs/cli/acp/).

## Which Claude Code runs

The agent's SDK bundles its own Claude Code CLI, a second binary at another path that lags the
one you run in a terminal. Anything that treats binaries one by one sees two CLIs, with
different versions and rules: an application firewall that allows programs by path let one
through and blocked the other, which shows up as hung turns. One CLI is simpler to run and to
allow. So when the installers find `claude`, they set `CLAUDE_CODE_EXECUTABLE`
in the agent's `acp.json` entry to the path `command -v claude` gives (a symlink stays a
symlink, so the CLI's own updates apply). The native installer's `claude` links to the file
`~/.local/share/claude/versions/<version>`, and such a firewall sees that real path, which
changes at every CLI update: a rule for one version does not cover the next. The agent now
runs the same file as the terminal, so after an update its first turn hangs like the terminal
until that version is allowed. Without a CLI found, the key is left out and the bundled CLI
runs. Each run rewrites the entry's `env`: a key added there by hand is lost, so
re-run the installer after moving the CLI instead of editing it. On Windows the key is set
only for a native `claude.exe`, since the SDK cannot start an npm `.cmd` shim (untested).
Whether a CLI newer than the SDK's always speaks its protocol is not checked: a failure to
start sessions after a CLI update points here.

## Agent log

The installers set `CLAUDE_AGENT_LOGS` in the agent's `acp.json` entry, so the agent writes
its own log to `~/.local/state/claude-agent-acp/agent.log` (Windows:
`%USERPROFILE%\.local\state\claude-agent-acp\agent.log`), next to the API key fallback's log.
It holds the agent's errors, which still also reach the IDE log, and its other lines, which then
no longer do. It can contain conversation text; on macOS/Linux the folder is created mode 700. A
running agent keeps the environment it started with: the log starts with the next new chat or
IDE restart. The agent appends to it without rotation.

`node extract-acp-errors.mjs`, run from this folder, copies the errors of these sessions into
`errors.jsonl` next to `agent.log`, one JSON line each: the client's (`Error during prompt
turn` in the IDE log) by chat id, and the agent's, joined to their chat and session through the
agent's pid. It copies fields, never whole lines, but an error message can quote conversation
text, so the file is created mode 600; a second run adds nothing. It also trims
`agent.log` to its newest half once it passes 20 MB (`--max-agent-log <bytes>`). It looks for the
IDE logs under `~/.cache/JetBrains` (Linux); elsewhere pass each with `--ide-log <file>`. Agents
started before `CLAUDE_AGENT_LOGS` was set relay every line, so until they exit a line of theirs
can be recorded as an error. `node extract-acp-errors.check.mjs` checks it against fixture logs.

## Local patches

Fixes for upstream bugs that are not released yet live in `patches/claude-agent-acp/<version>/`, one unified diff per fix, made against that exact published version. The installers install the pinned version (`PINNED_VERSION` in the `.sh`, `$PinnedVersion` in the `.ps1`) and apply its patches; re-running them is safe, as an already-applied patch is skipped.

To install another version, set `CLAUDE_AGENT_ACP_VERSION` (e.g. `CLAUDE_AGENT_ACP_VERSION=latest ./install-claude-acp-jetbrains.sh`). If that version has no folder of its own, the pinned version's patches are tried: applying them is reported as a warning (unexpected success, check the fix is still needed), failing to apply them stops the installer, since the bug may still be there. Once upstream ships a fix, create the new version's folder with a README and no `.patch` file.

The macOS/Linux installer applies patches with `patch` (no fuzz, offsets allowed); the Windows one uses `git apply` and so needs git. The Windows path is untested.

After patching, the installers check that `dist/acp-agent.js` still parses and run each `*.check.mjs` in the version's folder against the installed package; a check proves its patch's fix actually behaves, since a hunk can apply in the wrong place and still report success. A failing check stops the installer. They also check that every patch is still detected as applied once all are in: a re-run relies on that, so patches that change each other's lines must be merged into one, and the installer stops if they are not.

`CLAUDE_AGENT_ACP_VERSION` is handed to npm as the version spec, so it can also name a tag, a directory or a git URL: only point it at code you trust, as the install may run under `sudo`.

`npm update -g` or a manual reinstall replaces the patched files: re-run the installer afterwards.

| Patch | Fixes | Upstream |
| --- | --- | --- |
| `0.101.0/0002-close-unanswered-server-tool-calls.patch` (check: `server-tools-close.check.mjs`) | the same error for an advisor call whose result never arrives (a message sent while it runs, or a client tool call earlier in the same response) | not submitted, analysis in `docs/upstream-pr-abandoned-server-tool.md` |
| `0.101.0/advisor-settles.check.mjs` (no patch) | checks that turns calling the advisor tool still end normally, fixed upstream in 0.97.0 | [PR #1247](https://github.com/agentclientprotocol/claude-agent-acp/pull/1247), merged |
| `0.101.0/0003-api-key-fallback.patch` (checks: `credential-rotation.check.mjs`, `model-deny.check.mjs`, `credential-return.check.mjs`) | not a bug fix, a local feature: when the subscription or an API key runs out of quota, sessions move to the next key of a list, refuse a deny list of models there, and return to the subscription once its limit has reset (see [API key fallback](#api-key-fallback)) | local only |
| `0.90.0/0001-settle-advisor-tool-results.patch` (check: `advisor-settles.check.mjs`) | previous pin: turns that call the advisor tool fail with "Claude ended the turn without returning results for tool calls: srvtoolu_…", and JetBrains then kills the agent | [PR #1247](https://github.com/agentclientprotocol/claude-agent-acp/pull/1247), draft comment in `docs/upstream-pr-1247-comment.md` |
| `0.90.0/0002-close-unanswered-server-tool-calls.patch` (check: `server-tools-close.check.mjs`) | previous pin: 0002 above, for 0.90.0 | as above |
| `0.90.0/0003-api-key-fallback.patch` (same checks) | previous pin: 0003 for 0.90.0, without the hold while work runs | local only |
| `0.86.0/0001-settle-advisor-tool-results.patch` (check: `advisor-settles.check.mjs`) | previous pin: the advisor fix for 0.86.0, without 0002 | as above |

## API key fallback

With patch 0003, a turn that fails because the current credential is out of quota (a
claude.ai usage limit, or "Credit balance is too low" on an API key) moves the agent to the
next key of `~/.config/claude-agent-acp/api-keys`, and the chat says your next message
switches. One key per line, `#` starts a comment; keep it `chmod 600` (on
Windows, where mode bits differ, `keys_file_readable_by_others` is logged regardless). The
file is read at each switch, so keys can be added without restarting.

- A switch, and the return below, happen at your next message once no work runs, since
  they recreate the sessions and that kills whatever their Claude Code runs. While a turn,
  a model cycle Claude Code started on its own, or a background task (subagent, background
  command, monitor) still runs, your message is answered with that list and not run
  (`change_held`, which logs the list, command text included); send it again once that work
  has ended. In PyCharm 2026.3 the chats share one agent, so work in any chat holds the
  change for all of them. Not covered: a cycle in the moment between the message that starts
  it and its first output, and work Claude Code does not report as a task.
- Order: the native credential (CLI login, or an `ANTHROPIC_API_KEY` the IDE passes to the
  agent), then the keys top to bottom. A drained key is skipped until the agent restarts.
  Closing a chat does not restart its agent in PyCharm; quitting the IDE does.
- The reset time of the limit that drained the native credential is kept
  with the switch (`returnsAt` in the `switched` line); the first message at or after it moves
  every session back to the native credential before it runs (`returned`), once no work runs;
  when the switch was held, no session left the native credential and nothing is held. No polling: the
  time is checked when a message arrives, so an idle chat returns at its next message. A
  switch whose limit reported no reset time (`returnsAt: null`) is never returned from. A
  return that is too early costs one round trip: the message hits the limit and switches again.
- Only sessions of a patched agent switch; an agent started before the install keeps the old
  code until the IDE restarts it. Sessions routed by the IDE (`providers/set`, gateway login)
  are left alone: in PyCharm 2026.3 that is every session of an agent whose AI source (the
  selector in the chat input) is JetBrains AI, which also bills JetBrains AI credits. Set it to
  "Agent login" for the fallback to apply.
- Every step is a JSON line in `~/.local/state/claude-agent-acp/credential-rotation.log`, keys
  shown by their last four characters: `switched`, `session_created`, `no_credential_left`,
  `keys_file_missing`, `keys_file_unreadable`, `keys_file_readable_by_others`,
  `recreate_failed`, `change_held`, `quota_exhausted_already_rotated`, `limit_rejected` (a limit and its reset
  time, as Claude Code reported them), `returned`, `model_denied`,
  `denied_models_file_unreadable`, and two that mean the patch is broken:
  `credential_not_in_effect` (a session on a key reports another key source, so it bills
  something else) and `rotation_failed` (a defect in the switch; the quota failure is shown
  as unpatched). A real limit cannot be forced, so this log is how the first live switch is
  confirmed.
- A session on a key refuses the models listed in
  `~/.config/claude-agent-acp/denied-models` (one per line, `#` comments, the CLI's
  `deniedModels` syntax: `fable` blocks the family). The turn ends with a chat line asking to
  pick another model, before any request is sent, and `model_denied` is logged. The file is
  read at each prompt; without it nothing is refused. Not covered: the advisor tool's own
  model, a subagent's own model, and a model switch inside a running turn.
- `CLAUDE_ACP_API_KEYS_FILE`, `CLAUDE_ACP_ROTATION_LOG` and `CLAUDE_ACP_DENIED_MODELS_FILE`
  override the paths.

## After installing

1. Make sure your JetBrains IDE (IntelliJ IDEA, PyCharm, WebStorm, PhpStorm, RubyMine, CLion, GoLand, Rider, DataGrip, RustRover, or Android Studio) is on version 2025.3+ with the AI Assistant plugin updated.
2. If you haven't already, run `claude` once in a terminal to log in (or set `ANTHROPIC_API_KEY`).
3. Restart the IDE, open the AI Chat tool window, and select **Claude Agent (ACP)** from the agent picker. In 2026.3, set its AI source to **Agent login** (see the top of this file).

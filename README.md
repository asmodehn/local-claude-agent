# local-claude-agent

Installs and registers the [Claude Agent SDK ACP agent](https://github.com/agentclientprotocol/claude-agent-acp) as a custom agent in JetBrains IDEs (2025.3+) — IntelliJ IDEA, PyCharm, WebStorm, PhpStorm, RubyMine, CLion, GoLand, Rider, DataGrip, RustRover, and Android Studio — via the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/). Once installed, Claude shows up as a selectable agent in the JetBrains AI Chat tool window.

**Why use this instead of JetBrains AI Assistant's built-in Claude support?** This wires the IDE up to your **local Claude Code CLI** installation. Auth is handled by logging in to the CLI (`claude`) with your own Anthropic account, so it runs on **your existing Claude plan** (Pro/Max/Team subscription) — not JetBrains AI credits, and not a separate `ANTHROPIC_API_KEY`/pay-per-token API bill (that's only used as a fallback if you don't want to log in via the CLI).

Two equivalent installers are provided:

- `install-claude-acp-jetbrains.sh` — macOS / Linux
- `install-claude-acp-jetbrains.ps1` — Windows (PowerShell)

## What the scripts do

1. **Node.js** — check for Node.js >= 22; install it if missing or too old (via Homebrew/apt/nvm on macOS/Linux, or winget/choco on Windows).
2. **Install the ACP agent** — install the pinned version of `@agentclientprotocol/claude-agent-acp` globally via npm, apply the local patches for it (see [Local patches](#local-patches)), and resolve the path to its executable/entry point.
3. **Claude Code CLI (auth)** — check for the local `claude` CLI, offering to install it if missing. Authentication is done by logging in to this CLI (`claude`), reusing your existing Claude subscription/plan rather than requiring JetBrains AI credits or a paid API key. As a fallback, if no CLI login is found but `ANTHROPIC_API_KEY` is set in the environment, the script asks before embedding it in plaintext in the config file — this is not the default or recommended path.
4. **Register the agent** — write/merge an entry into the JetBrains ACP config (`~/.jetbrains/acp.json` on macOS/Linux, `%USERPROFILE%\.jetbrains\acp.json` on Windows), pointing it at the installed agent binary. Existing config is backed up first (`acp.json.bak.<timestamp>`) and merged rather than overwritten, so other configured agents are preserved.
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

## Local patches

Fixes for upstream bugs that are not released yet live in `patches/claude-agent-acp/<version>/`, one unified diff per fix, made against that exact published version. The installers install the pinned version (`PINNED_VERSION` in the `.sh`, `$PinnedVersion` in the `.ps1`) and apply its patches; re-running them is safe, as an already-applied patch is skipped.

To install another version, set `CLAUDE_AGENT_ACP_VERSION` (e.g. `CLAUDE_AGENT_ACP_VERSION=latest ./install-claude-acp-jetbrains.sh`). If that version has no folder of its own, the pinned version's patches are tried: applying them is reported as a warning (unexpected success, check the fix is still needed), failing to apply them stops the installer, since the bug may still be there. Once upstream ships a fix, create the new version's folder with a README and no `.patch` file.

The macOS/Linux installer applies patches with `patch` (no fuzz, offsets allowed); the Windows one uses `git apply` and so needs git. The Windows path is untested.

After patching, the installers check that `dist/acp-agent.js` still parses and run each `*.check.mjs` in the version's folder against the installed package; a check proves its patch's fix actually behaves, since a hunk can apply in the wrong place and still report success. A failing check stops the installer.

`CLAUDE_AGENT_ACP_VERSION` is handed to npm as the version spec, so it can also name a tag, a directory or a git URL: only point it at code you trust, as the install may run under `sudo`.

`npm update -g` or a manual reinstall replaces the patched files: re-run the installer afterwards.

| Patch | Fixes | Upstream |
| --- | --- | --- |
| `0.90.0/0001-settle-advisor-tool-results.patch` (check: `advisor-settles.check.mjs`) | turns that call the advisor tool fail with "Claude ended the turn without returning results for tool calls: srvtoolu_…", and JetBrains then kills the agent | [PR #1247](https://github.com/agentclientprotocol/claude-agent-acp/pull/1247), draft comment in `docs/upstream-pr-1247-comment.md` |
| `0.90.0/0002-close-unanswered-server-tool-calls.patch` (check: `server-tools-close.check.mjs`) | the same error for an advisor call whose result never arrives (a message sent while it runs, or a client tool call earlier in the same response) | not submitted, analysis in `docs/upstream-pr-abandoned-server-tool.md` |
| `0.90.0/0003-rotate-credentials-on-quota.patch` (check: `credential-rotation.check.mjs`) | not a bug fix, a local feature: when the subscription or an API key runs out of quota, sessions move to the next key of a list (see [API key fallback](#api-key-fallback)) | local only |
| `0.86.0/0001-settle-advisor-tool-results.patch` (check: `advisor-settles.check.mjs`) | previous pin: the advisor fix for 0.86.0, without 0002 | as above |

## API key fallback

With patch 0003, a turn that fails because the current credential is out of quota (a
claude.ai usage limit, or "Credit balance is too low" on an API key) switches every session
of the agent to the next key of `~/.config/claude-agent-acp/api-keys`, and the chat asks you
to send the message again. One key per line, `#` starts a comment; keep it `chmod 600` (on
Windows, where mode bits differ, `keys_file_readable_by_others` is logged regardless). The
file is read at each switch, so keys can be added without restarting.

- Order: the native credential (CLI login, or an `ANTHROPIC_API_KEY` the IDE passes to the
  agent), then the keys top to bottom. A drained credential is skipped until the agent
  restarts; the subscription is not returned to when its limit resets.
- Only sessions of a patched agent switch; an agent started before the install keeps the old
  code until the IDE restarts it. Sessions routed by the IDE (`providers/set`, gateway login)
  are left alone.
- Every step is a JSON line in `~/.local/state/claude-agent-acp/credential-rotation.log`, keys
  shown by their last four characters: `switched`, `session_created`, `no_credential_left`,
  `keys_file_missing`, `keys_file_unreadable`, `keys_file_readable_by_others`,
  `recreate_failed`, `quota_exhausted_already_rotated`, and two that mean the patch is broken:
  `credential_not_in_effect` (a session on a key reports another key source, so it bills
  something else) and `rotation_failed` (a defect in the switch; the quota failure is shown
  as unpatched). A real limit cannot be forced, so this log is how the first live switch is
  confirmed.
- `CLAUDE_ACP_API_KEYS_FILE` and `CLAUDE_ACP_ROTATION_LOG` override both paths.

## After installing

1. Make sure your JetBrains IDE (IntelliJ IDEA, PyCharm, WebStorm, PhpStorm, RubyMine, CLion, GoLand, Rider, DataGrip, RustRover, or Android Studio) is on version 2025.3+ with the AI Assistant plugin updated.
2. If you haven't already, run `claude` once in a terminal to log in (or set `ANTHROPIC_API_KEY`).
3. Restart the IDE, open the AI Chat tool window, and select **Claude Agent (ACP)** from the agent picker.

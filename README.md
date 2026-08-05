# local-claude-agent

Installs and registers the [Claude Agent SDK ACP agent](https://github.com/agentclientprotocol/claude-agent-acp) as a custom agent in JetBrains IDEs (2025.3+) via the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/). Once installed, Claude shows up as a selectable agent in the JetBrains AI Chat tool window.

**Why use this instead of JetBrains AI Assistant's built-in Claude support?** This wires the IDE up to your **local Claude Code CLI** installation. Auth is handled by logging in to the CLI (`claude`) with your own Anthropic account, so it runs on **your existing Claude plan** (Pro/Max/Team subscription) — not JetBrains AI credits, and not a separate `ANTHROPIC_API_KEY`/pay-per-token API bill (that's only used as a fallback if you don't want to log in via the CLI).

Two equivalent installers are provided:

- `install-claude-acp-jetbrains.sh` — macOS / Linux
- `install-claude-acp-jetbrains.ps1` — Windows (PowerShell)

## What the scripts do

1. **Node.js** — check for Node.js >= 22; install it if missing or too old (via Homebrew/apt/nvm on macOS/Linux, or winget/choco on Windows).
2. **Install the ACP agent** — install/update `@agentclientprotocol/claude-agent-acp` globally via npm, and resolve the path to its executable/entry point.
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

## After installing

1. Make sure your JetBrains IDE is on version 2025.3+ with the AI Assistant plugin updated.
2. If you haven't already, run `claude` once in a terminal to log in (or set `ANTHROPIC_API_KEY`).
3. Restart the IDE, open the AI Chat tool window, and select **Claude Agent (ACP)** from the agent picker.

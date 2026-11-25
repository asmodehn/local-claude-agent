# Roadmap

## Agent-agnostic bridge

Make the JetBrains ACP setup work with other coding agents than Claude Code: at least Codex and
OpenCode. Today every part is Claude-specific: the installers install and patch
`@agentclientprotocol/claude-agent-acp`, and the patches (the API key fallback and the
`/credential` command among them) change that package's code.

## Checks in the bridge

Two checks are being tried out today as hooks in Codex and Claude Code. Once those trials
settle, they move into the bridge, so they apply whichever agent runs behind it:

- a stop hook that blocks slop grenades;
- a claim checker, backed by an MCP server that runs a constraint solver.

## No JavaScript at the system level

Install the bridge per user instead of into the system's global npm folder. Today the Linux
installer runs `npm install -g`, retrying with `sudo` when that fails, so the bridge lands in
`/usr/lib/node_modules`; when Node is missing or too old, it installs Node from NodeSource with
`apt`. Both should move under the user's home: Node from a per-user version manager, and the
bridge in a per-user npm prefix. The same goes for the installer's fallback that installs the
Claude Code CLI with `npm install -g` when no `claude` is found.

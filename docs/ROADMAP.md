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

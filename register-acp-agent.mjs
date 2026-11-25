import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

const agentNames = {
  claude: "Claude Agent (ACP)",
  codex: "Codex (ACP)",
  opencode: "OpenCode (ACP)",
};

function launchPath(file, isNodeScript = false) {
  const path = resolve(file);
  if (!fs.statSync(path).isFile()) throw new Error(`Not a file: ${path}`);
  if (process.platform === "win32" && [".bat", ".cmd"].includes(extname(path).toLowerCase())) {
    throw new Error(`Use the executable or the adapter's Node.js entry point instead of ${path}`);
  }
  fs.accessSync(path, isNodeScript ? fs.constants.R_OK : fs.constants.X_OK);
  return path;
}

function agentEntry(agent, file, extra) {
  // Launch npm adapters directly through Node, including on Windows where
  // their npm command shims cannot be used as JetBrains executables.
  const isNodeScript = agent !== "opencode" && /\.[cm]?js$/i.test(file);
  const path = launchPath(file, isNodeScript);
  const command = isNodeScript ? process.execPath : path;
  const args = isNodeScript ? [path] : [];

  const env = {};
  if (agent === "claude") {
    Object.assign(env, JSON.parse(process.env.CLAUDE_ACP_REGISTRATION_ENV || "{}"));
    env.CLAUDE_AGENT_LOGS = resolve(extra);
  } else if (agent === "codex" && extra) {
    env.CODEX_PATH = launchPath(extra);
  } else if (agent === "opencode") {
    args.push("acp");
  }

  return { command, args, use_idea_mcp: true, use_custom_mcp: true, env };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function register(configFile, name, entry) {
  fs.mkdirSync(dirname(configFile), { recursive: true });
  const lock = `${configFile}.lock`;
  fs.mkdirSync(lock);
  try {
    const target = fs.lstatSync(configFile, { throwIfNoEntry: false })
      ? fs.realpathSync(configFile)
      : configFile;
    const id = randomUUID();
    let config = { default_mcp_settings: { use_custom_mcp: true, use_idea_mcp: false } };
    if (fs.existsSync(target)) {
      const previous = fs.readFileSync(target);
      const backup = `${configFile}.bak.${Date.now()}-${id}`;
      fs.writeFileSync(backup, previous, { mode: 0o600, flag: "wx" });
      try {
        config = JSON.parse(previous.toString("utf8").replace(/^\uFEFF/, ""));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        console.error(`Existing ${configFile} is not valid JSON. Backed up to ${backup}; starting from a fresh config.`);
      }
    }

    if (!isObject(config) || (config.agent_servers != null && !isObject(config.agent_servers))) {
      throw new Error(`Expected a JSON object with an optional agent_servers object in ${configFile}`);
    }
    (config.agent_servers ??= {})[name] = entry;

    const temporary = `${target}.tmp.${id}`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  } finally {
    fs.rmdirSync(lock);
  }
}

try {
  const [agent, file, extra, ...rest] = process.argv.slice(2);
  if (!Object.hasOwn(agentNames, agent) || !file || rest.length ||
      (agent === "opencode" && extra !== undefined) || (agent === "claude" && !extra)) {
    throw new Error("Usage: node register-acp-agent.mjs codex <codex-acp> [codex] | opencode <opencode>");
  }
  const configFile = join(homedir(), ".jetbrains", "acp.json");
  register(configFile, agentNames[agent], agentEntry(agent, file, extra));
  console.log(`Registered '${agentNames[agent]}' in ${configFile}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

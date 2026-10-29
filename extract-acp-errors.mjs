// Copies the errors of JetBrains ACP sessions running claude-agent-acp into one JSON line
// each, in <state dir>/errors.jsonl.
//
// Client errors come from the IDE log, by a whitelist of messages. Agent errors need the
// agent's own log (CLAUDE_AGENT_LOGS, set by the installers): agent.log lines carry no level,
// so an entry is an error when its text also reached the IDE's stderr relay, where only
// logger.error goes once CLAUDE_AGENT_LOGS is set. The entry's pid joins it to its chat (IDE
// log: "Process started with PID" then "Creating new session for chat") and to its session
// ("[session/query] sessionId=").
// Not recorded: a direct console.error (unhandled rejection, cleanup) bypasses the logger and
// has no pid; a logger.error with a non-Error object argument renders differently in agent.log
// ("[object Object]") and on stderr (util.inspect), so it fails the text match.
// Records copy fields, never whole lines; a second run adds nothing.
//
// The IDE logs are looked up under ~/.cache/JetBrains (Linux); elsewhere pass --ide-log.
// Lines are matched by the agent's display name the installers write, "Claude Agent (ACP)".
//
// Usage: node extract-acp-errors.mjs [--state <dir>] [--ide-log <file>]... [--max-agent-log <bytes>]
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const stateDir = opt("--state")[0] ?? process.env.CLAUDE_AGENT_LOGS ?? path.join(os.homedir(), ".local", "state", "claude-agent-acp");
const maxAgentLog = Number(opt("--max-agent-log")[0] ?? 20 * 1024 * 1024);
const agentLogFile = path.join(stateDir, "agent.log");
const errorsFile = path.join(stateDir, "errors.jsonl");
const MAX_MESSAGE = 500;

/** The IDE logs, oldest first: idea.12.log ... idea.1.log, idea.log, per IDE. */
function ideLogs() {
  const given = opt("--ide-log");
  if (given.length) return given;
  const root = path.join(os.homedir(), ".cache", "JetBrains");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((ide) => {
    const dir = path.join(root, ide, "log");
    if (!existsSync(dir)) return [];
    const rank = (f) => (f === "idea.log" ? 0 : Number(f.match(/^idea\.(\d+)\.log$/)?.[1] ?? -1));
    return readdirSync(dir).filter((f) => rank(f) >= 0).sort((a, b) => rank(b) - rank(a)).map((f) => path.join(dir, f));
  });
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const IDE_LINE = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d),(\d{3}) \[\s*\d+\]\s+(\w+) - #(\S+) - (.*)$/;
const AGENT = "[Claude Agent (ACP)]";
// "Error during prompt turn" only, logged at INFO or SEVERE: the FINE
// handleSessionConnectionFailed line that can follow it exists only while debug logging is
// on, and would record a failure twice.
const CLIENT_ERRORS = [new RegExp(`^Error during prompt turn for chat (${UUID}), error: (.*)$`)];
const OUR_AGENT = "acp.claude-agent-acp";
const toolId = (text) => text.match(/\b(?:srv)?toolu_[A-Za-z0-9]+/)?.[0];
const clip = (text) => (text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}...` : text);

const records = [];
const relay = []; // { time, text }: stderr lines the IDE relayed
const pidStarts = []; // { pid, time, chat }
const chatAgent = new Map(); // chat id -> agent id, from any "agent=<id>, chatId=<chat>" line
let recognised = 0;
const pendingStarts = []; // several agents can start before their sessions are created: FIFO

for (const file of ideLogs()) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(IDE_LINE);
    if (!m || !m[5].startsWith("c.i.m.l.a.a.")) continue; // continuation lines, other plugins
    const [, day, clock, ms, level, logger, message] = m;
    const time = new Date(`${day}T${clock}.${ms}`).toISOString(); // the IDE logs local time
    const owner = message.match(new RegExp(`agent=([\\w.-]+), chatId=(${UUID})`));
    if (owner) chatAgent.set(owner[2], owner[1]);
    if (message.startsWith(`${AGENT} stderr: `)) {
      recognised++;
      relay.push({ time, text: message.slice(`${AGENT} stderr: `.length) });
      continue;
    }
    const started = message.match(/^\[Claude Agent \(ACP\)\] Process started with PID: LocalPid\(value=(\d+)\)/);
    if (started) {
      recognised++;
      pendingStarts.push({ pid: Number(started[1]), time });
      continue;
    }
    const created = message.match(new RegExp(`^\\[Claude Agent \\(ACP\\)\\] Creating new session for chat (${UUID})`));
    if (created && pendingStarts.length) {
      pidStarts.push({ ...pendingStarts.shift(), chat: created[1] });
      continue;
    }
    for (const pattern of CLIENT_ERRORS) {
      const e = message.match(pattern);
      if (!e) continue;
      recognised++;
      records.push({ time, side: "client", chat: e[1], level, logger: logger.split(".").pop(), tool: toolId(e[2]), message: clip(e[2]) });
    }
  }
}

/** agent.log entries: a timestamped first line, then any continuation lines (a stack). */
function agentEntries() {
  const entries = [];
  for (const line of readFileSync(agentLogFile, "utf8").split("\n")) {
    const m = line.match(/^(\d{4}-\d\d-\d\dT\S+Z) pid=(\d+) (.*)$/);
    if (m) entries.push({ time: m[1], pid: Number(m[2]), first: m[3], text: m[3] });
    else if (entries.length && line) entries.at(-1).text += `\n${line}`;
  }
  return entries;
}

pidStarts.sort((a, b) => (a.time < b.time ? -1 : 1));
// "Error during prompt turn" names no agent: drop chats known to belong to another one.
for (let i = records.length - 1; i >= 0; i--) {
  const agent = chatAgent.get(records[i].chat);
  if (agent && agent !== OUR_AGENT) records.splice(i, 1);
}

const notes = [];
if (!recognised) notes.push("no recognised ACP lines in the IDE logs: the log format may have changed");
if (existsSync(agentLogFile)) {
  const entries = agentEntries();
  // Without CLAUDE_AGENT_LOGS the relay carries every line, not only errors: only relay
  // lines from the time agent.log starts can tell an error apart.
  const since = entries[0]?.time ?? "";
  const relayTexts = new Set(relay.filter((r) => r.time >= since).map((r) => r.text));
  const sessions = entries.flatMap((e) => {
    const s = e.first.match(new RegExp(`^\\[session/query\\] sessionId=(${UUID})`));
    return s ? [{ pid: e.pid, time: e.time, session: s[1] }] : [];
  });
  const latest = (list, pid, time) => list.filter((x) => x.pid === pid && x.time <= time).at(-1);
  for (const e of entries) {
    if (!relayTexts.has(e.first)) continue;
    records.push({
      time: e.time, side: "agent", chat: latest(pidStarts, e.pid, e.time)?.chat,
      session: latest(sessions, e.pid, e.time)?.session, pid: e.pid, tool: toolId(e.text), message: clip(e.text),
    });
  }
} else {
  notes.push(`no ${agentLogFile}: agent errors need CLAUDE_AGENT_LOGS set for the agent (run the installer, then start a new chat)`);
}

const key = (r) => JSON.stringify([r.side, r.time, r.pid ?? null, r.chat ?? null, r.message]);
const seen = new Set(
  existsSync(errorsFile) ? readFileSync(errorsFile, "utf8").split("\n").filter(Boolean).map((l) => key(JSON.parse(l))) : [],
);
const fresh = records.filter((r) => !seen.has(key(r)) && seen.add(key(r)));
mkdirSync(stateDir, { recursive: true });
if (fresh.length) appendFileSync(errorsFile, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });

// The agent appends without rotation: keep the newest half once past the cap. A line an
// agent appends between the read and the write is lost.
if (existsSync(agentLogFile) && statSync(agentLogFile).size > maxAgentLog) {
  const text = readFileSync(agentLogFile, "utf8");
  const tail = text.slice(text.length - Math.floor(maxAgentLog / 2));
  writeFileSync(agentLogFile, tail.slice(tail.search(/\n\d{4}-\d\d-\d\dT/) + 1));
}

const count = (side) => fresh.filter((r) => r.side === side).length;
console.log(`${fresh.length} new record(s) in ${errorsFile}: ${count("client")} client, ${count("agent")} agent`);
for (const note of notes) console.log(`note: ${note}`);

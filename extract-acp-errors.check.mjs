// Check for extract-acp-errors.mjs: runs it against fixture IDE and agent logs in a temporary
// state folder, and fails unless it records the client error of our agent's chat and each agent
// error with its chat, session and pid; drops another agent's chat and the debug-only FINE
// line; copies no prompt text; adds nothing on a second run; says so when it recognises no
// line; and trims agent.log past the cap at an entry boundary. The child runs in UTC, the
// zone the fixture IDE lines are written in.
//
// Usage: node extract-acp-errors.check.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extractor = path.join(path.dirname(fileURLToPath(import.meta.url)), "extract-acp-errors.mjs");
const tmp = mkdtempSync(path.join(os.tmpdir(), "extract-acp-errors-check-"));
const chat = "11111111-1111-4111-8111-111111111111";
const otherChat = "22222222-2222-4222-8222-222222222222";
const session = "33333333-3333-4333-8333-333333333333";
const prompt = "SENTINEL-PROMPT-7f3a";
const ide = (time, level, logger, message) => `2026-01-02 ${time},000 [1] ${level.padStart(6)} - #c.i.m.l.a.a.${logger} - ${message}`;
const ideLog = [
  // An agent started without CLAUDE_AGENT_LOGS relays every line, errors or not.
  ide("09:59:00", "WARN", "r.p.AcpServerProcessHandlerImpl", "[Claude Agent (ACP)] stderr: Claude ACP started"),
  ide("10:00:00", "INFO", "r.p.AcpServerProcessHandlerImpl", "[Claude Agent (ACP)] Process started with PID: LocalPid(value=4242)"),
  ide("10:00:00", "INFO", "c.AcpSessionLifecycleManager", `[Claude Agent (ACP)] Creating new session for chat ${chat}`),
  ide("10:00:05", "FINE", "s.AcpAgentSession", `Resubmit attempt 0 for request: ${prompt}`),
  ide("10:00:06", "WARN", "r.p.AcpServerProcessHandlerImpl", "[Claude Agent (ACP)] stderr: [claude-agent-acp] Got a tool result for tool use that wasn't tracked: srvtoolu_01Fixture"),
  ide("10:00:07", "SEVERE", "c.AcpSessionLifecycleManager", `Error during prompt turn for chat ${chat}, error: java.lang.IllegalStateException: There is active prompt execution`),
  `java.lang.Throwable: Error during prompt turn for chat ${chat}, error: java.lang.IllegalStateException: There is active prompt execution`,
  ide("10:00:07", "FINE", "c.AcpSessionLifecycleManager", `handleSessionConnectionFailed for agent=acp.claude-agent-acp, chatId=${chat}, error: There is active prompt execution`),
  ide("10:00:08", "WARN", "r.p.AcpServerProcessHandlerImpl", "[Claude Agent (ACP)] stderr: Error: fixture failure"),
  ide("10:00:09", "FINE", "c.AcpSessionLifecycleManager", `warmUpRemoteSessionIfNeeded for agent=acp.opencode, chatId=${otherChat}`),
  ide("10:00:10", "INFO", "c.AcpSessionLifecycleManager", `Error during prompt turn for chat ${otherChat}, error: Internal error`),
].join("\n");
const agentLog = [
  "2026-01-02T10:00:00.500Z pid=4242 Claude ACP started",
  `2026-01-02T10:00:01.000Z pid=4242 [session/query] sessionId=${session} resume=none apiType=native`,
  `2026-01-02T10:00:04.000Z pid=4242 ${prompt}`,
  "2026-01-02T10:00:06.000Z pid=4242 [claude-agent-acp] Got a tool result for tool use that wasn't tracked: srvtoolu_01Fixture",
  "2026-01-02T10:00:08.000Z pid=4242 Error: fixture failure",
  "    at fixture (file:///fixture.js:1:1)",
  "",
].join("\n");

const run = (state, logFile, ...extra) =>
  execFileSync(process.execPath, [extractor, "--state", state, "--ide-log", logFile, ...extra], { env: { ...process.env, TZ: "UTC" }, encoding: "utf8" });
const problems = [];
const expect = (name, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${name}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
};

try {
  const state = path.join(tmp, "state");
  mkdirSync(state);
  const logFile = path.join(tmp, "idea.log");
  writeFileSync(logFile, ideLog);
  writeFileSync(path.join(state, "agent.log"), agentLog);
  const errorsFile = path.join(state, "errors.jsonl");

  run(state, logFile);
  const text = readFileSync(errorsFile, "utf8");
  const records = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const pick = (r) => ({ side: r.side, chat: r.chat, session: r.session, pid: r.pid, tool: r.tool, message: r.message });
  expect("records", records.map(pick), [
    { side: "client", chat, message: "java.lang.IllegalStateException: There is active prompt execution" },
    { side: "agent", chat, session, pid: 4242, tool: "srvtoolu_01Fixture", message: "[claude-agent-acp] Got a tool result for tool use that wasn't tracked: srvtoolu_01Fixture" },
    { side: "agent", chat, session, pid: 4242, message: "Error: fixture failure\n    at fixture (file:///fixture.js:1:1)" },
  ].map(pick));
  expect("client record time", records[0]?.time, "2026-01-02T10:00:07.000Z");
  expect("prompt text in errors.jsonl", text.includes(prompt), false);
  expect("errors.jsonl mode", (statSync(errorsFile).mode & 0o777).toString(8), "600");

  expect("second run", run(state, logFile).split("\n")[0].startsWith("0 new record(s)"), true);
  expect("records after the second run", readFileSync(errorsFile, "utf8"), text);

  const unrecognised = path.join(tmp, "unrecognised.log");
  writeFileSync(unrecognised, "2026-01-02 10:00:00,000 [1]   INFO - #c.i.Other - something else\n");
  expect("note on unrecognised lines", run(path.join(tmp, "empty"), unrecognised).includes("no recognised ACP lines"), true);

  run(state, logFile, "--max-agent-log", "300");
  const trimmed = readFileSync(path.join(state, "agent.log"), "utf8");
  expect("agent.log trimmed under the cap", trimmed.length <= 150, true);
  expect("agent.log trimmed at an entry", /^\d{4}-\d\d-\d\dT\S+Z pid=\d+ /.test(trimmed), true);
} catch (error) {
  problems.push(`run failed: ${error?.message ?? error}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (problems.length) {
  console.error(`extract-acp-errors.mjs does not behave as intended:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("extract-acp-errors.mjs records the fixture errors as intended");

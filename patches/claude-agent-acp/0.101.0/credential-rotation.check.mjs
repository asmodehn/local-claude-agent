// Post-install check for the rotation of 0003-api-key-fallback.patch, run by the
// installers against the patched package directory (argv[2]). It drives prompts through the agent
// with a scripted Claude Code stream that ends in a usage limit or a key without
// credit, against a temporary key list, and fails unless each failure moves the
// rotation to the next key exactly once: default credential -> key 1 -> key 2, none
// past the last key, none when the list is missing or the client routes the session.
// A turn that moved it ends normally (JetBrains stops the agent on a failed turn) and
// recreates nothing; one that did not still fails. The next message recreates the
// sessions on the new key, unless work still runs: it is then answered with that work,
// without running; a model cycle counts as work from Claude Code's first output. An
// idle compaction, which the agent sends itself, changes nothing. A session on a key
// whose CLI reports another key source is logged.
// It imports package internals, so it belongs to this exact version's folder.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pkg = path.resolve(process.argv[2] ?? "");
const tmp = mkdtempSync(path.join(os.tmpdir(), "credential-rotation-check-"));
const keysFile = path.join(tmp, "api-keys");
const logFile = path.join(tmp, "rotation.log");
process.env.CLAUDE_ACP_API_KEYS_FILE = keysFile;
process.env.CLAUDE_ACP_ROTATION_LOG = logFile;
process.env.CLAUDE_ACP_DENIED_MODELS_FILE = path.join(tmp, "denied-models");

const load = (rel) => import(pathToFileURL(path.join(pkg, "dist", rel)).href);
const { ClaudeAcpAgent } = await load("acp-agent.js");
const { credentialRotation } = await load("credential-rotation.js");
const { Pushable } = await load("utils.js");
const { SessionTitles } = await load("session-titles.js");

const sessionId = "check-session";
const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
// The two ways a credential runs out, as the CLI reports them: a claude.ai usage limit
// (a usage-limit text) and an API key without credit (`billing_error`, no such text).
const usageLimit = { error: "rate_limit", text: "You've hit your session limit · resets 3:45pm" };
const noCredit = { error: "billing_error", text: "Credit balance is too low" };

let queryRan = false;
// Whether the session counted a model cycle as running once Claude Code's output started.
let cycleSeen = false;

/** One turn ending in `failure`, or a plain successful turn when it is undefined. */
async function* claudeCode(input, failure, apiKeySource) {
  const { value } = await input[Symbol.asyncIterator]().next();
  queryRan = true;
  yield { type: "system", subtype: "init", apiKeySource, session_id: sessionId, uuid: randomUUID() };
  yield { type: "user", message: value.message, parent_tool_use_id: null, uuid: value.uuid, session_id: sessionId, isReplay: true };
  if (failure) {
    yield {
      type: "assistant", session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), error: failure.error,
      message: { role: "assistant", model: "<synthetic>", usage, content: [{ type: "text", text: failure.text }] },
    };
    cycleSeen = agent.sessions[sessionId]?.claudeCycleRunning === true;
  }
  yield {
    type: "result", subtype: "success", stop_reason: failure ? "stop_sequence" : "end_turn", is_error: !!failure, result: failure?.text ?? "", errors: [],
    duration_ms: 0, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0, usage, modelUsage: {},
    permission_denials: [], uuid: randomUUID(), session_id: sessionId,
  };
}

const updates = [];
const recreations = [];
const agent = new ClaudeAcpAgent(
  {
    sessionUpdate: async (n) => updates.push(n.update),
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } }),
    extNotification: async () => {},
  },
  { log() {}, error() {} },
);
agent.enqueueProviderUpdate = async (config) => recreations.push(config);

const logLines = (event) => existsSync(logFile)
  ? readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes(`"event":"${event}"`)).length
  : 0;

/** One prompt on a fresh session holding `credential`, whose CLI reports
 *  `apiKeySource` and runs the background command `task` when given, sent by `origin`
 *  (the user when undefined); returns what it changed. */
async function limitHit(credential, failure, apiKeySource = credential ? "ANTHROPIC_API_KEY" : "none", task, origin) {
  const input = new Pushable();
  const query = Object.assign(claudeCode(input, failure, apiKeySource), {
    interrupt: async () => {}, stopTask: async () => {}, close() {}, setModel: async () => {},
  });
  const inertAgent = { client: { sessionUpdate: async () => {} }, logger: { error() {} }, sessions: {} };
  agent.sessions[sessionId] = {
    input, query, cancelled: false, cwd: pkg, credential,
    sessionFingerprint: JSON.stringify({ cwd: pkg, mcpServers: [] }),
    titles: new SessionTitles(inertAgent, sessionId),
    modes: { currentModeId: "default", availableModes: [] },
    models: { currentModelId: "default", availableModels: [] },
    modelInfos: [],
    settingsManager: { dispose() {}, getSettings: () => ({}), getApiKeyHelper: () => undefined, getCwd: () => pkg },
    accumulatedUsage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
    accumulatedModelUsage: {}, lastModelUsageReading: {}, configOptions: [], agents: [], currentAgent: "default",
    abortController: new AbortController(), emitRawSDKMessages: false, forwardSubagentText: false,
    contextWindowSize: 200000, contextWindowAuthoritative: false, providerCacheKey: "default",
    taskState: new Map(), emittedToolCalls: new Set(),
    toolUseCache: task ? { toolu_task: { id: "toolu_task", name: "Bash", input: { description: task } } } : {},
    liveBackgroundTasks: new Map(task ? [["task-1", { parentToolUseId: "toolu_task", isSubagent: false }]] : []),
    emittedAssistantText: false, owedTrailingIdles: 0, messageIdToUuid: new Map(),
    sessionFailureState: { epoch: randomUUID(), revisions: new Map(), active: new Map() },
  };
  queryRan = false;
  cycleSeen = false;
  const before = { recreations: recreations.length, updates: updates.length, misbilled: logLines("credential_not_in_effect") };
  let failed = false;
  try {
    const response = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "check" }] }, origin);
    failed = response?.stopReason !== "end_turn";
  } catch {
    failed = true;
  }
  const said = (text) => updates.slice(before.updates)
    .filter((u) => u.sessionUpdate === "agent_message_chunk" && u.content?.text?.includes(text)).length;
  return {
    failed, recreated: recreations.length - before.recreations, notices: said("your next message switches to"),
    held: said("waits until this work ends: Bash runtests"), queryRan, cycleSeen, current: credentialRotation.current,
    misbilled: logLines("credential_not_in_effect") - before.misbilled,
  };
}

const k1 = "sk-ant-check-key-one-0001";
const k2 = "sk-ant-check-key-two-0002";
const expect = (name, got, want) => {
  for (const [field, value] of Object.entries(want)) {
    if (got[field] !== value) problems.push(`${name}: ${field} ${JSON.stringify(got[field])}, expected ${JSON.stringify(value)}`);
  }
};
const problems = [];
try {
  expect("no key list", await limitHit(null, usageLimit), { failed: true, recreated: 0, notices: 0, current: null, misbilled: 0 });
  writeFileSync(keysFile, `# check\n${k1}\n\n${k2}  # second\n`, { mode: 0o600 });
  expect("default credential at its limit, a command running", await limitHit(null, usageLimit, undefined, "runtests"), { failed: false, recreated: 0, notices: 1, cycleSeen: true, current: k1, misbilled: 0 });
  expect("idle compaction, the command still running", await limitHit(null, undefined, undefined, "runtests", "idleCompaction"), { failed: false, recreated: 0, held: 0, queryRan: true, current: k1 });
  expect("next message, the command still running", await limitHit(null, undefined, undefined, "runtests"), { failed: false, recreated: 0, held: 1, queryRan: false, current: k1 });
  expect("next message, nothing running", await limitHit(null), { failed: false, recreated: 1, held: 0, queryRan: true, current: k1 });
  if (credentialRotation.advance(null, sessionId) !== undefined) problems.push("a second failure on the default credential moved the rotation again");
  expect("key 1 without credit", await limitHit(k1, noCredit), { failed: false, recreated: 0, notices: 1, current: k2, misbilled: 0 });
  expect("last key without credit", await limitHit(k2, noCredit), { failed: true, recreated: 0, notices: 0, current: k2 });
  expect("key session billing the login", await limitHit(k2, noCredit, "none"), { misbilled: 1 });
  expect("client-routed session", await limitHit(undefined, usageLimit), { failed: true, recreated: 0, notices: 0, current: k2, misbilled: 0 });
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  for (const event of ["keys_file_missing", "switched", "quota_exhausted_already_rotated", "no_credential_left"]) {
    if (!log.includes(`"event":"${event}"`)) problems.push(`log has no ${event} line`);
  }
  if (log.includes(k1) || log.includes(k2)) problems.push("log contains a full key");
  credentialRotation.current = null;
  if (JSON.stringify(credentialRotation.env()) !== "{}") problems.push("default credential sets an env");
  credentialRotation.current = k1;
  if (credentialRotation.env().ANTHROPIC_API_KEY !== k1) problems.push("key credential does not set ANTHROPIC_API_KEY");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (problems.length) {
  console.error(`Credential rotation on quota does not behave in ${pkg}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Credential rotation on quota moves to the next key exactly once in ${pkg}`);
process.exit(0);

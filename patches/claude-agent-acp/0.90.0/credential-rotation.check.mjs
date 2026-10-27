// Post-install check for the rotation of 0003-api-key-fallback.patch, run by the
// installers against the patched package directory (argv[2]). It drives prompts through the agent
// with a scripted Claude Code stream that ends in a usage limit or a key without
// credit, against a temporary key list, and fails unless each failure moves the
// sessions to the next key exactly once: default credential -> key 1 -> key 2, none
// past the last key, none when the list is missing or the client routes the session.
// A turn that switched ends normally (JetBrains stops the agent on a failed turn); one
// that did not still fails. A session on a key whose CLI reports another key source is
// logged. It imports package internals, so it belongs to this exact version's folder.
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

async function* claudeCode(input, failure, apiKeySource) {
  const { value } = await input[Symbol.asyncIterator]().next();
  yield { type: "system", subtype: "init", apiKeySource, session_id: sessionId, uuid: randomUUID() };
  yield { type: "user", message: value.message, parent_tool_use_id: null, uuid: value.uuid, session_id: sessionId, isReplay: true };
  yield {
    type: "assistant", session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), error: failure.error,
    message: { role: "assistant", model: "<synthetic>", usage, content: [{ type: "text", text: failure.text }] },
  };
  yield {
    type: "result", subtype: "success", stop_reason: "stop_sequence", is_error: true, result: failure.text, errors: [],
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
 *  `apiKeySource`; returns what it changed. */
async function limitHit(credential, failure, apiKeySource = credential ? "ANTHROPIC_API_KEY" : "none") {
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
    taskState: new Map(), toolUseCache: {}, emittedToolCalls: new Set(), liveBackgroundTasks: new Map(),
    emittedAssistantText: false, owedTrailingIdles: 0, messageIdToUuid: new Map(),
    sessionFailureState: { epoch: randomUUID(), revisions: new Map(), active: new Map() },
  };
  const before = { recreations: recreations.length, updates: updates.length, misbilled: logLines("credential_not_in_effect") };
  let failed = false;
  try {
    const response = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "check" }] });
    failed = response?.stopReason !== "end_turn";
  } catch {
    failed = true;
  }
  const notices = updates.slice(before.updates)
    .filter((u) => u.sessionUpdate === "agent_message_chunk" && u.content?.text?.includes("switched to"));
  return {
    failed, recreated: recreations.length - before.recreations, notices: notices.length, current: credentialRotation.current,
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
  expect("default credential at its limit", await limitHit(null, usageLimit), { failed: false, recreated: 1, notices: 1, current: k1, misbilled: 0 });
  expect("default credential again, already rotated", await limitHit(null, usageLimit), { failed: true, recreated: 0, notices: 0, current: k1 });
  expect("key 1 without credit", await limitHit(k1, noCredit), { failed: false, recreated: 1, notices: 1, current: k2, misbilled: 0 });
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

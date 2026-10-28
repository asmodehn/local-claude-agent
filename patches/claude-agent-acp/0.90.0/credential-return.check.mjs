// Post-install check for the return of 0003-api-key-fallback.patch, run by the
// installers against the patched package directory (argv[2]). With a scripted Claude
// Code stream and a fake clock, it fails unless the reset time of the limit that drained
// the native credential (from its rejected rate_limit_event) is recorded at the switch,
// and the first prompt at or after that time moves every session back to the native
// credential before it runs; and unless a prompt before that time, a switch whose limit
// reported no reset time, and a key without credit stay where they are. It imports
// package internals, so it belongs to this exact version's folder.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pkg = path.resolve(process.argv[2] ?? "");
const tmp = mkdtempSync(path.join(os.tmpdir(), "credential-return-check-"));
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
const T = 1_800_000_000; // the limit's reset time, in seconds
const usageLimit = { error: "rate_limit", text: "You've hit your session limit · resets 3:45pm" };
const noCredit = { error: "billing_error", text: "Credit balance is too low" };

/** One turn: a rejected rate_limit_event when `resetsAt` is given, then `failure`, or a
 *  plain successful turn when `failure` is undefined. With `eventFirst` the event comes
 *  before the prompt's echo, which activates the turn. */
async function* claudeCode(input, failure, resetsAt, eventFirst) {
  const { value } = await input[Symbol.asyncIterator]().next();
  const rejected = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" }, uuid: randomUUID(), session_id: sessionId };
  if (resetsAt !== undefined && eventFirst) yield rejected;
  yield { type: "user", message: value.message, parent_tool_use_id: null, uuid: value.uuid, session_id: sessionId, isReplay: true };
  if (resetsAt !== undefined && !eventFirst) yield rejected;
  if (failure) {
    yield {
      type: "assistant", session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), error: failure.error,
      message: { role: "assistant", model: "<synthetic>", usage, content: [{ type: "text", text: failure.text }] },
    };
  }
  yield {
    type: "result", subtype: "success", stop_reason: failure ? "stop_sequence" : "end_turn", is_error: !!failure,
    result: failure?.text ?? "", errors: [], duration_ms: 0, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0, usage,
    modelUsage: {}, permission_denials: [], uuid: randomUUID(), session_id: sessionId,
  };
}

const recreations = [];
const agent = new ClaudeAcpAgent(
  {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } }),
    extNotification: async () => {},
  },
  { log() {}, error() {} },
);
agent.enqueueProviderUpdate = async (config) => recreations.push(config);

/** One prompt at `nowSeconds` on a fresh session holding `credential`. */
async function send(credential, nowSeconds, failure, resetsAt, eventFirst = false) {
  credentialRotation.now = () => nowSeconds * 1000;
  const input = new Pushable();
  const query = Object.assign(claudeCode(input, failure, resetsAt, eventFirst), {
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
  const before = recreations.length;
  let failed = false;
  try {
    failed = (await agent.prompt({ sessionId, prompt: [{ type: "text", text: "check" }] }))?.stopReason !== "end_turn";
  } catch {
    failed = true;
  }
  return {
    failed, recreated: recreations.length - before,
    current: credentialRotation.current === null ? "native" : credentialRotation.current,
    resetsAt: credentialRotation.nativeResetsAt,
  };
}

const k1 = "sk-ant-check-key-one-0001";
const k2 = "sk-ant-check-key-two-0002";
const problems = [];
const expect = (name, got, want) => {
  for (const [field, value] of Object.entries(want)) {
    if (got[field] !== value) problems.push(`${name}: ${field} ${JSON.stringify(got[field])}, expected ${JSON.stringify(value)}`);
  }
};
try {
  writeFileSync(keysFile, `${k1}\n${k2}\n`, { mode: 0o600 });
  expect("native limit with a reset time", await send(null, T - 3600, usageLimit, T), { failed: false, recreated: 1, current: k1, resetsAt: T * 1000 });
  expect("prompt before the reset", await send(k1, T - 1), { failed: false, recreated: 0, current: k1, resetsAt: T * 1000 });
  expect("first prompt at the reset", await send(k1, T), { failed: false, recreated: 1, current: "native", resetsAt: undefined });
  expect("next prompt", await send(null, T + 60), { failed: false, recreated: 0, current: "native" });
  expect("native limit with no reset time", await send(null, T + 120, usageLimit), { failed: false, recreated: 1, current: k1, resetsAt: undefined });
  expect("a day later, no reset time known", await send(k1, T + 86400), { failed: false, recreated: 0, current: k1 });
  expect("key without credit", await send(k1, T + 86500, noCredit, T + 90000), { failed: false, recreated: 1, current: k2, resetsAt: undefined });
  expect("after that key's reported time", await send(k2, T + 90001), { failed: false, recreated: 0, current: k2 });
  credentialRotation.current = null;
  expect("native limit reported before the prompt's echo", await send(null, T + 90100, usageLimit, T + 99000, true), { failed: false, recreated: 1, current: k2, resetsAt: (T + 99000) * 1000 });
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  const returned = log.split("\n").filter((l) => l.includes('"event":"returned"')).length;
  if (returned !== 1) problems.push(`log has ${returned} returned lines, expected 1`);
  if (!log.includes(`"returnsAt":"${new Date(T * 1000).toISOString()}"`)) problems.push("switch line has no returnsAt");
  if (!log.includes('"returnsAt":null')) problems.push("switch with no reset time is not logged as such");
  if (log.includes(k1) || log.includes(k2)) problems.push("log contains a full key");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (problems.length) {
  console.error(`The native credential does not come back at its reset in ${pkg}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`The native credential comes back at its reset in ${pkg}`);
process.exit(0);

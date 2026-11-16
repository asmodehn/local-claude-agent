// Post-install check for the deny list of 0003-api-key-fallback.patch, run by the
// installers against the patched package directory (argv[2]). It sends one prompt per case, against a
// temporary denied-models file, and fails unless a session on a key of the list whose
// model is denied (by id, or through the alias it resolves to) ends the turn normally
// with a chat line, without running the query; and unless the native credential, an
// allowed model and a missing file still run it. It imports package internals, so it
// belongs to this exact version's folder.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pkg = path.resolve(process.argv[2] ?? "");
const tmp = mkdtempSync(path.join(os.tmpdir(), "model-deny-check-"));
const deniedFile = path.join(tmp, "denied-models");
const logFile = path.join(tmp, "rotation.log");
process.env.CLAUDE_ACP_DENIED_MODELS_FILE = deniedFile;
process.env.CLAUDE_ACP_ROTATION_LOG = logFile;

const load = (rel) => import(pathToFileURL(path.join(pkg, "dist", rel)).href);
const { ClaudeAcpAgent } = await load("acp-agent.js");
const { Pushable } = await load("utils.js");
const { SessionTitles } = await load("session-titles.js");

const sessionId = "check-session";
const key = "sk-ant-check-key-one-0001";
const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
let queryRan = false;

async function* claudeCode(input) {
  const { value } = await input[Symbol.asyncIterator]().next();
  queryRan = true;
  yield { type: "user", message: value.message, parent_tool_use_id: null, uuid: value.uuid, session_id: sessionId, isReplay: true };
  yield {
    type: "result", subtype: "success", stop_reason: "end_turn", is_error: false, result: "", errors: [],
    duration_ms: 0, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0, usage, modelUsage: {},
    permission_denials: [], uuid: randomUUID(), session_id: sessionId,
  };
}

const updates = [];
const agent = new ClaudeAcpAgent(
  {
    sessionUpdate: async (n) => updates.push(n.update),
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } }),
    extNotification: async () => {},
  },
  { log() {}, error() {} },
);

/** One prompt on a fresh session holding `credential` and running `modelId`, with model
 *  rows shaped like the SDK's, the `default` one resolving to Fable; returns what happened. */
async function send(credential, modelId) {
  const input = new Pushable();
  const query = Object.assign(claudeCode(input), {
    interrupt: async () => {}, stopTask: async () => {}, close() {}, setModel: async () => {},
  });
  const inertAgent = { client: { sessionUpdate: async () => {} }, logger: { error() {} }, sessions: {} };
  agent.sessions[sessionId] = {
    input, query, cancelled: false, cwd: pkg, credential,
    sessionFingerprint: JSON.stringify({ cwd: pkg, mcpServers: [] }),
    titles: new SessionTitles(inertAgent, sessionId),
    modes: { currentModeId: "default", availableModes: [] },
    models: { currentModelId: modelId, availableModels: [] },
    modelInfos: [
      { value: "default", resolvedModel: "claude-fable-5-1", displayName: "Default", description: "" },
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "" },
      { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "" },
    ],
    settingsManager: { dispose() {}, getSettings: () => ({}), getApiKeyHelper: () => undefined, getCwd: () => pkg },
    accumulatedUsage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
    accumulatedModelUsage: {}, lastModelUsageReading: {}, configOptions: [], agents: [], currentAgent: "default",
    abortController: new AbortController(), emitRawSDKMessages: false, forwardSubagentText: false,
    contextWindowSize: 200000, contextWindowAuthoritative: false, providerCacheKey: "default",
    taskState: new Map(), toolUseCache: {}, emittedToolCalls: new Set(), liveBackgroundTasks: new Map(),
    emittedAssistantText: false, owedTrailingIdles: 0, messageIdToUuid: new Map(),
    sessionFailureState: { epoch: randomUUID(), revisions: new Map(), active: new Map() },
  };
  queryRan = false;
  const before = updates.length;
  let stopReason;
  try {
    stopReason = (await agent.prompt({ sessionId, prompt: [{ type: "text", text: "check" }] }))?.stopReason;
  } catch (error) {
    stopReason = `failed: ${error?.message ?? error}`;
  }
  const refusals = updates.slice(before)
    .filter((u) => u.sessionUpdate === "agent_message_chunk" && u.content?.text?.includes("is not allowed on")).length;
  return { stopReason, queryRan, refusals };
}

const problems = [];
const expect = (name, got, want) => {
  for (const [field, value] of Object.entries(want)) {
    if (got[field] !== value) problems.push(`${name}: ${field} ${JSON.stringify(got[field])}, expected ${JSON.stringify(value)}`);
  }
};
const refused = { stopReason: "end_turn", queryRan: false, refusals: 1 };
const ran = { stopReason: "end_turn", queryRan: true, refusals: 0 };
try {
  expect("no denied-models file", await send(key, "default"), ran);
  writeFileSync(deniedFile, "# check\nfable  # for now\n");
  expect("key, default resolving to a denied model", await send(key, "default"), refused);
  expect("key, denied model by id", await send(key, "claude-fable-5-1[1m]"), refused);
  expect("key, allowed model", await send(key, "opus"), ran);
  expect("default credential, denied model", await send(null, "default"), ran);
  expect("client-routed session, denied model", await send(undefined, "default"), ran);
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  const denials = log.split("\n").filter((l) => l.includes('"event":"model_denied"')).length;
  if (denials !== 2) problems.push(`log has ${denials} model_denied lines, expected 2`);
  if (log.includes(key)) problems.push("log contains a full key");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (problems.length) {
  console.error(`Denied models are not refused on API keys in ${pkg}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Denied models are refused on API keys in ${pkg}`);
process.exit(0);

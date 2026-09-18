/**
 * Measures what this extension actually saves, on one real pi session.
 *
 * It rebuilds the session's compaction-aware context (exactly what pi sends to the model),
 * replays it chunk by chunk as a live session grows — same pruner instance, so cached decisions
 * accumulate — and reports the context size before and after.
 *
 * For a faithful simulation of the gates (size trigger, cache-cost gap, urgent bypass) and of the
 * cache penalty, use `tools/simulate-session.ts` instead: this one is the quick before/after view.
 *
 * Prints aggregate numbers only: message counts, byte sizes, token estimates and Jev usage.
 * Never message content.
 *
 *   node --import jiti/register tools/measure-gain.ts <session.jsonl> [chunkSize]
 *
 * Needs a Jev key (see README) and dev dependencies installed (`npm install`).
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { buildSessionContext, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { HttpJevAsker, JevPruner, loadConfig, resolveApiKey, type PiMessage } from "../index.ts";
import { measurePayload } from "./token-model.ts";

/** Real prompt tokens of the LLM call that produced this assistant message, when pi recorded it. */
function realPromptTokens(message: PiMessage): number | undefined {
	const usage = (message as { usage?: { input?: number; cacheRead?: number; cacheWrite?: number } }).usage;
	if (!usage) return undefined;
	const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	return prompt > 0 ? prompt : undefined;
}

const file = process.argv[2];
if (!file) {
	console.error("usage: node --import jiti/register tools/measure-gain.ts <session.jsonl> [chunkSize]");
	process.exit(1);
}
const chunkSize = Number(process.argv[3] ?? 80);

const entries = parseSessionEntries(readFileSync(file, "utf8"));
const context = buildSessionContext(entries as never[]) as unknown as { messages: PiMessage[] };
const full = context.messages ?? [];
if (full.length === 0) {
	console.error("this session has no messages on its active branch");
	process.exit(1);
}

const before = measurePayload(full);
const lastAssistant = [...full].reverse().find((message) => message.role === "assistant");
const real = lastAssistant ? realPromptTokens(lastAssistant) : undefined;
const kb = (chars: number) => `${(chars / 1024).toFixed(0)} KB`;

console.log(`${basename(file)} — ${full.length} messages`);
console.log(
	`  payload      : ${kb(before.payloadChars)} (text ${kb(before.textChars)}, thinking ${kb(before.thinkingChars)}, ` +
		`call args ${kb(before.argumentChars)}, details ${kb(before.detailsChars)}) + ${before.images} image(s) ` +
		`${kb(before.imageChars)} = ${before.imageTokens} tok${before.imagesUnknown > 0 ? ` (${before.imagesUnknown} unreadable)` : ""}`,
);
console.log(
	`  before       : ~${(before.tokens / 1000).toFixed(0)}k tokens` +
		(real ? `  (pi reported ${(real / 1000).toFixed(0)}k for the last call)` : ""),
);

const config = loadConfig();
const key = resolveApiKey(config);
if (!key) {
	console.error("  no Jev API key configured (see README); aborting before any network call");
	process.exit(1);
}

const pruner = new JevPruner(
	new HttpJevAsker({ apiKey: key, model: config.model, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs }),
	{
		preserveRecentMessages: config.preserveRecentMessages ?? 6,
		minNewCalls: 1,
		minIntervalMs: 0,
		minPendingChars: 0,
		maxStateTokens: config.maxStateTokens ?? 25_000,
		maxRequestTokens: config.maxRequestTokens ?? 30_000,
		fallbackWindowMessages: config.fallbackWindowMessages ?? 120,
		requestConcurrency: config.requestConcurrency ?? 4,
		stateResultHeadChars: config.stateResultHeadChars ?? 300,
		abridgeArgumentChars: config.abridgeArgumentChars ?? 500,
	},
);

let requests = 0;
let outgoing: readonly PiMessage[] = full;
let lastStats: { callsDropped: number; resultsDropped: number; downgraded: number; abridgedArgs: number; kept: number } | undefined;
const steps = Math.ceil(full.length / chunkSize);
for (let step = 0; step < steps; step += 1) {
	const slice = full.slice(-Math.min((step + 1) * chunkSize, full.length));
	const outcome = await pruner.prune(slice, { allowNetwork: true });
	requests += outcome?.stats.requests ?? 0;
	if (outcome) lastStats = outcome.stats;
	outgoing = outcome ? outcome.messages : slice;
}
const after = measurePayload(outgoing);
const net = before.tokens - after.tokens;

console.log(`  after        : ~${(after.tokens / 1000).toFixed(0)}k tokens, ${outgoing.length} messages`);
console.log(
	`  saved        : ${((net / before.tokens) * 100).toFixed(1)}% of the payload (` +
		`text ${kb(before.textChars)} -> ${kb(after.textChars)}, args ${kb(before.argumentChars)} -> ${kb(after.argumentChars)}, ` +
		`details ${kb(before.detailsChars)} -> ${kb(after.detailsChars)}, images ${before.images} -> ${after.images})`,
);
console.log(
	`  decisions    : ${lastStats?.callsDropped ?? 0} calls dropped, ${lastStats?.resultsDropped ?? 0} results truncated, ` +
		`${lastStats?.downgraded ?? 0} kept for safety, ${lastStats?.abridgedArgs ?? 0} arguments abridged`,
);
console.log(`  cost         : ${requests} Jev request(s), ${pruner.cacheSize} calls scored, ${pruner.failures} failure(s)`);
console.log("  note         : permissive gates (minNewCalls 1, minPendingChars 0) — an upper bound on pruning,");
console.log("                 and no cache-invalidation penalty; use tools/simulate-session.ts for the net.");

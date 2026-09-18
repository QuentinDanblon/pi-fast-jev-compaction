/**
 * Faithful session simulator — how this extension would have behaved on a real session.
 *
 * It replays a session the way pi actually drives it: one simulated LLM call per assistant
 * message, the full history as the pruner input, the pruned view as what is sent, and the same
 * gates the `context` hook applies (size trigger, cache-cost gap, urgent bypass, free moments).
 * It then prices the two effects that decide whether the extension is worth running:
 *
 *   saving   = sum over calls of (real prompt tokens x the share the prune removed)
 *   penalty  = one full prompt rewrite per prune that actually changed the prompt prefix
 *              (a cache write costs `ratio` x a cache read, so `ratio - 1` extra reads per token)
 *
 * Usage:
 *   node --import jiti/register tools/simulate-session.ts <session.jsonl> [options]
 *
 *   --window=<tokens>     model context window (default 1000000)
 *   --trigger=<0..1>      share of the window above which Jev may be asked (default 0.5)
 *   --urgent=<0..1>       always-prune threshold (default 0.85; 0 disables)
 *   --gap=auto|<n>        calls between prunes; auto = the pruner's own cache gate (default auto)
 *   --state=<tokens>      maxStateTokens (default 25000)
 *   --head=<chars>        stateResultHeadChars (default 300)
 *   --abridge=<chars>     abridgeArgumentChars (default 500, 0 off)
 *   --ratio=<n>           cache write/read price ratio for the penalty (default 10)
 *   --no-free-moment      ignore already-cold-cache moments
 *   --cache=<file>        reuse decisions across runs with the same state options
 *   --quiet               only the summary line
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { buildSessionContext, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { HttpJevAsker, JevPruner, cacheAlreadyCold, loadConfig, resolveApiKey, type PiMessage } from "../index.ts";
import { measurePayload } from "./token-model.ts";

/* ------------------------------------------------------------------ options */

const args = process.argv.slice(2);
const config = loadConfig();
const file = args.find((arg) => !arg.startsWith("--"));
if (!file) {
	console.error("usage: node --import jiti/register tools/simulate-session.ts <session.jsonl> [options]");
	process.exit(1);
}
const option = (name: string, fallback: number): number => {
	const raw = args.find((arg) => arg.startsWith(`--${name}=`));
	if (!raw) return fallback;
	const value = Number(raw.slice(name.length + 3));
	return Number.isFinite(value) ? value : fallback;
};
const flag = (name: string): boolean => args.includes(`--${name}`);

const window = option("window", 1_000_000);
const trigger = option("trigger", 0.5);
const urgentAt = option("urgent", 0.85);
const gapArg = args.find((arg) => arg.startsWith("--gap="))?.slice(6) ?? "auto";
const stateTokens = option("state", 25_000);
const headChars = option("head", 300);
const abridgeChars = option("abridge", 500);
const ratio = option("ratio", 10);
const freeMoment = !flag("no-free-moment");
/** Ask Jev in the background instead of blocking the simulated LLM call. */
const background = flag("background");
const minPendingChars = option("min-pending", config.minPendingChars ?? 2_000);
const minNewCalls = option("min-new", config.minNewCalls ?? 2);
const cachePath = args.find((arg) => arg.startsWith("--cache="))?.slice(8);
const quiet = flag("quiet");
const maxCalls = option("max-calls", Number.POSITIVE_INFINITY);

/* ------------------------------------------------------------------ session */

const entries = parseSessionEntries(readFileSync(file, "utf8"));
const context = buildSessionContext(entries as never[]) as unknown as { messages: Record<string, unknown>[] };
const messages = (context.messages ?? []) as unknown as PiMessage[];
if (messages.length === 0) {
	console.error("this session has no messages on its active branch");
	process.exit(1);
}

/** Real prompt size (provider-reported) of the LLM call that produced each assistant message. */
function realPromptTokens(message: PiMessage): number | undefined {
	const usage = (message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } })
		.usage;
	if (!usage) return undefined;
	const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	return prompt > 0 ? prompt : undefined;
}

/**
 * Index of the first tool call the applied decisions changed, so a prompt rewrite can be priced
 * from that position: everything after it loses its cache entry and is written again.
 */
function earliestChangedIndex(full: readonly PiMessage[], changed: readonly string[]): number {
	for (let index = 0; index < full.length; index += 1) {
		const message = full[index] as { content?: unknown };
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content as { type?: string; id?: string }[]) {
			if (part.type === "toolCall" && part.id !== undefined && changed.includes(part.id)) return index;
		}
	}
	return full.length;
}

const apiKey = resolveApiKey(config);
if (!apiKey) {
	console.error("no Jev API key configured (see README)");
	process.exit(1);
}

/* ------------------------------------------------------------- decision reuse */

interface SimCache {
	options: { stateTokens: number; headChars: number; model: string | undefined; abridgeChars: number };
	decisions: Record<string, { keepCall: number; keepResult: number; head: string }>;
}

function loadCache(): Map<string, { keepCall: number; keepResult: number }> {
	const map = new Map<string, { keepCall: number; keepResult: number }>();
	if (!cachePath || !existsSync(cachePath)) return map;
	const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as SimCache;
	// Only valid for the same state options: a different state changes what Jev sees.
	if (
		parsed.options?.stateTokens !== stateTokens ||
		parsed.options?.headChars !== headChars ||
		parsed.options?.abridgeChars !== abridgeChars
	) {
		return map;
	}
	for (const [key, value] of Object.entries(parsed.decisions ?? {})) {
		map.set(key, { keepCall: value.keepCall, keepResult: value.keepResult });
	}
	return map;
}

/** Wraps the asker so identical questions are answered from disk instead of the network. */
class CachingAsker {
	#inner: HttpJevAsker;
	#cache: Map<string, { keepCall: number; keepResult: number }>;
	#fresh: Record<string, { keepCall: number; keepResult: number; head: string }> = {};
	hits = 0;

	constructor(inner: HttpJevAsker, cache: Map<string, { keepCall: number; keepResult: number }>) {
		this.#inner = inner;
		this.#cache = cache;
	}

	get freshCount(): number {
		return Object.keys(this.#fresh).length;
	}

	async ask(state: unknown, questions: Record<string, { instructions: string }>) {
		// The result question carries the head of the result under judgement; key by call + head.
		const keys = Object.keys(questions).filter((name) => name.startsWith("call_"));
		const answers: Record<string, unknown> = {};
		const missing: string[] = [];
		for (const name of keys) {
			const id = name.slice(5);
			const resultQuestion = questions[`result_${id}`]?.instructions ?? "";
			const head = resultQuestion.includes("Its output begins: ")
				? resultQuestion.slice(resultQuestion.indexOf("Its output begins: ") + 19, resultQuestion.indexOf("Its output begins: ") + 19 + headChars)
				: "";
			const key = `${id}|${head}`;
			const cached = this.#cache.get(key);
			if (cached) {
				answers[name] = { type: "noul", noul: cached.keepCall };
				answers[`result_${id}`] = { type: "noul", noul: cached.keepResult };
				this.hits += 1;
			} else {
				missing.push(id);
			}
		}
		if (missing.length > 0) {
			const subset: Record<string, { instructions: string }> = {};
			for (const id of missing) {
				subset[`call_${id}`] = questions[`call_${id}`];
				subset[`result_${id}`] = questions[`result_${id}`];
			}
			const response = (await this.#inner.ask(state as never, subset as never)) as {
				answers: Record<string, { noul: number }>;
			};
			for (const id of missing) {
				const keepCall = response.answers[`call_${id}`]?.noul;
				const keepResult = response.answers[`result_${id}`]?.noul;
				if (typeof keepCall !== "number" || typeof keepResult !== "number") throw new Error("bad answer");
				const resultQuestion = questions[`result_${id}`]?.instructions ?? "";
				const start = resultQuestion.indexOf("Its output begins: ");
				const head = start === -1 ? "" : resultQuestion.slice(start + 19, start + 19 + headChars);
				this.#cache.set(`${id}|${head}`, { keepCall, keepResult });
				this.#fresh[`${id}|${head}`] = { keepCall, keepResult, head };
				answers[`call_${id}`] = { type: "noul", noul: keepCall };
				answers[`result_${id}`] = { type: "noul", noul: keepResult };
			}
		}
		return { answers };
	}

	save(): void {
		if (!cachePath || this.freshCount === 0) return;
		const existing = existsSync(cachePath)
			? (JSON.parse(readFileSync(cachePath, "utf8")) as SimCache)
			: { options: { stateTokens, headChars, abridgeChars, model: config.model }, decisions: {} };
		Object.assign(existing.decisions, this.#fresh);
		existing.options = { stateTokens, headChars, abridgeChars, model: config.model };
		writeFileSync(cachePath, JSON.stringify(existing));
	}
}

const asker = new CachingAsker(
	new HttpJevAsker({ apiKey, model: config.model, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs }),
	loadCache(),
);

const pruner = new JevPruner(asker as never, {
	preserveRecentMessages: config.preserveRecentMessages ?? 6,
	minNewCalls,
	minIntervalMs: 0,
	minPendingChars,
	maxStateTokens: stateTokens,
	maxRequestTokens: config.maxRequestTokens ?? 30_000,
	fallbackWindowMessages: config.fallbackWindowMessages ?? 120,
	requestConcurrency: config.requestConcurrency ?? 4,
	stateResultHeadChars: headChars,
	abridgeArgumentChars: abridgeChars,
	minCallsBetweenPrunes: gapArg === "auto" ? 20 : Number(gapArg),
});

/* -------------------------------------------------------------------- replay */

const kb = (tokens: number) => `${(tokens / 1000).toFixed(0)}k`;
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

let calls = 0;
let prunes = 0;
let requests = 0;
let judged = 0;
let savedTokens = 0;
let savedConservative = 0;
let promptSumConservative = 0;
let penaltyTokens = 0;
let penaltyConservative = 0;
let invalidations = 0;
let promptSum = 0;
let blockedMs = 0;
let callsSincePrune = Number.POSITIVE_INFINITY;
let required = gapArg === "auto" ? 20 : Number(gapArg);
const floorGap = gapArg === "auto" ? 20 : Number(gapArg);
const applied = new Map<string, string>();
let realPromptSum = 0;
const usageRatios: number[] = [];
let maxPrompt = 0;
const trajectory: number[] = [];

for (let index = 0; index < messages.length; index += 1) {
	const message = messages[index];
	if (message.role !== "assistant") continue;

	// An LLM call happens right before every assistant message, with everything before it.
	const full = messages.slice(0, index);
	const previousAssistant = [...full].reverse().find((candidate) => candidate.role === "assistant");
	const realPrompt = previousAssistant ? realPromptTokens(previousAssistant) : undefined;

	calls += 1;
	callsSincePrune += 1;
	const requiredNow = gapArg === "auto" ? pruner.requiredCallsBetweenPrunes : Number(gapArg);
	required = requiredNow;
	// Base the measurement on the reconstructed context, never on the historical usage: in a
	// session that went through a compaction, those usages describe a pre-compaction context
	// that no longer exists. The usage is kept only as a cross-check below.
	const trustablePrompt = measurePayload(full).tokens;
	promptSum += trustablePrompt;
	if (realPrompt && realPrompt > 0) {
		realPromptSum += realPrompt;
		maxPrompt = Math.max(maxPrompt, realPrompt);
		usageRatios.push(realPrompt / Math.max(1, trustablePrompt));
	}
	const urgent = urgentAt > 0 && trustablePrompt >= window * urgentAt;
	// The provider cache was already cold when the previous response was billed mostly as
	// uncached input: this call rewrites its prefix anyway, so a prune here costs nothing extra.
	const coldNow = cacheAlreadyCold(full);
	// Urgency drops to the configured floor, never below it (see the extension's hook).
	const gap = urgent ? floorGap : requiredNow;
	const allowNetwork =
		trustablePrompt >= window * trigger && (callsSincePrune >= gap || (freeMoment && coldNow));

	const pruneStarted = Date.now();
	const outcome = await pruner.prune(full, { allowNetwork, urgent, deferNetwork: background });
	if (outcome && outcome.stats.requests > 0) blockedMs += Date.now() - pruneStarted;
	if (flag("debug") && outcome && outcome.stats.requests > 0 && (prunes < 6 || calls > Number(process.env.DEBUG_FROM ?? 395))) {
		const before = measurePayload(full);
		const after = measurePayload(outcome.messages);
		console.log(
			`  [prune ${prunes}] call#${calls} sinceLast=${callsSincePrune} required=${requiredNow} urgent=${urgent} cold=${coldNow} windowed=${outcome.stats.windowed} ` +
				`requests=${outcome.stats.requests} calls=${outcome.stats.calls} dropped=${outcome.stats.callsDropped} ` +
				`truncated=${outcome.stats.resultsDropped} downgraded=${outcome.stats.downgraded} abridged=${outcome.stats.abridgedArgs}`,
		);
		console.log(
			`           payload text ${kb(before.textChars)}->${kb(after.textChars)} args ${kb(before.argumentChars)}->${kb(after.argumentChars)} ` +
				`details ${kb(before.detailsChars)}->${kb(after.detailsChars)} images ${before.images}->${after.images}`,
		);
	}
	const sent = outcome ? outcome.messages : full;
	if (outcome && outcome.stats.requests > 0) {
		prunes += 1;
		callsSincePrune = 0;
	}
	requests += outcome?.stats.requests ?? 0;
	judged = pruner.cacheSize;

	const sentPayload = measurePayload(sent);
	const sentTokens = sentPayload.tokens;
	const sentConservative = measurePayload(sent, false).tokens;
	const promptWithoutDetails = measurePayload(full, false).tokens;
	// Saving is a token difference on one basis: the prompt as it would have been sent, minus what
	// is actually sent. The second accounting charges nothing for `details`, because the
	// calibration against real provider usage is ambiguous about whether they are sent.
	savedTokens += Math.max(0, trustablePrompt - sentTokens);
	savedConservative += Math.max(0, promptWithoutDetails - sentConservative);
	promptSumConservative += promptWithoutDetails;
	trajectory.push(sentTokens);

	// What the applied decisions say about each call this time.
	// Only a prune that actually rewrote the view can invalidate anything, and only decisions
	// that alter the sent bytes count: a call kept verbatim (pinned, or judged useful) leaves the
	// prompt byte-identical.
	if (outcome) {
		const now = new Map<string, string>();
		for (const decision of outcome.decisions) {
			if (decision.action === "keep") continue;
			now.set(decision.toolUseId, `${decision.action}|${decision.downgraded ?? ""}`);
		}
		const changed = [...now.entries()]
			.filter(([id, value]) => applied.get(id) !== value)
			.map(([id]) => id);
		for (const [id, value] of now) applied.set(id, value);
		if (changed.length > 0 && !coldNow) {
			// A rewrite from the earliest changed call onwards loses its cache entry.
			const from = earliestChangedIndex(full, changed);
			if (from < full.length) {
				const slice = full.slice(from);
				const cost = measurePayload(slice).tokens * (ratio - 1);
				penaltyTokens += cost;
				penaltyConservative += measurePayload(slice, false).tokens * (ratio - 1);
				invalidations += 1;
				if (flag("debug") && invalidations <= 8) {
					console.log(
						`  [invalidation ${invalidations}] call#${calls} firstChangedAt=${from}/${full.length} changed=${changed.length} cost=${kb(cost)}`,
					);
				}
			}
		}
	}

	if (calls >= maxCalls) break;
}

asker.save();

/* ------------------------------------------------------------------- report */

const penalty = penaltyTokens;
const net = savedTokens - penalty;
const netConservative = savedConservative - penaltyConservative;

if (!quiet) {
	console.log(`${basename(file)} — ${messages.length} messages, ${calls} simulated LLM calls`);
	console.log(
		`  options      : window=${kb(window)} trigger=${trigger} gap=${gapArg === "auto" ? `auto(${required})` : gapArg} state=${kb(stateTokens)} head=${headChars} abridge=${abridgeChars} ratio=${ratio} freeMoment=${freeMoment}`,
	);
	console.log(
		`  activity     : ${prunes} prune(s), ${invalidations} prompt invalidation(s), ${requests} Jev request(s), ${judged}/${calls} calls judged, ${asker.hits} cached answers, ${pruner.failures} failure(s)`,
	);
	console.log(`  context      : prompt bill ${kb(promptSum)}, max ${kb(maxPrompt)}, final sent ${kb(trajectory.at(-1) ?? 0)}`);
	console.log(
		`  latency      : ${blockedMs} ms spent inside the hook across the session` +
			(background ? " (background mode: nothing blocks)" : " (blocking mode)"),
	);
	if (usageRatios.length > 0) {
		const sorted = [...usageRatios].sort((a, b) => a - b);
		const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
		console.log(
			`  cross-check  : provider usage / estimated context = ${median.toFixed(2)} (median over ${usageRatios.length} calls;` +
				` a session that was compacted shows a large ratio, which is why the estimate is the base)`,
		);
	}
}
console.log(
	`  result       : saved ${kb(savedTokens)} tokens (${pct(savedTokens / Math.max(1, promptSum))} of the prompt bill), ` +
		`penalty ${kb(penalty)}, NET ${net >= 0 ? "+" : ""}${kb(net)} (${pct(net / Math.max(1, promptSum))})` +
		`${flag("quiet") ? "" : `, freed=${pct(pruner.freedFraction)}`}`,
);
console.log(
	`  conservative : saved ${kb(savedConservative)} (details not credited), penalty ${kb(penaltyConservative)}, ` +
		`NET ${netConservative >= 0 ? "+" : ""}${kb(netConservative)} (${pct(netConservative / Math.max(1, promptSumConservative))}) — quote this one`,
);

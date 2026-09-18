/**
 * Measures what this extension actually saves, on one real pi session.
 *
 * It rebuilds the session's compaction-aware context (exactly what pi sends to the model),
 * replays it chunk by chunk the way a live session grows — same pruner instance, so cached
 * decisions accumulate — and reports the context size before and after.
 *
 * Prints aggregate numbers only: message counts, byte sizes, token estimates and Jev usage.
 * Never message content.
 *
 *   node --import jiti/register tools/measure-gain.ts ~/.pi/agent/sessions/<dir>/<file>.jsonl [chunk]
 *
 * Needs a Jev key (see README) and dev dependencies installed (`npm install`).
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { buildSessionContext, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { HttpJevAsker, JevPruner, loadConfig, resolveApiKey, type PiMessage } from "../index.ts";

/** Rough cost of one image content block, whatever its base64 length. */
const IMAGE_TOKENS = 1200;
/** Serialised text-ish payload per token; validated to ~10% against pi's own usage numbers. */
const CHARS_PER_TOKEN = 3.5;

interface Measure {
	textChars: number;
	thinkingChars: number;
	argumentChars: number;
	detailsChars: number;
	images: number;
	imageChars: number;
	tokens: number;
}

function measure(messages: readonly PiMessage[]): Measure {
	let textChars = 0;
	let thinkingChars = 0;
	let argumentChars = 0;
	let detailsChars = 0;
	let images = 0;
	let imageChars = 0;
	for (const message of messages) {
		const record = message as { content?: unknown; details?: unknown; output?: string; command?: string };
		const content = record.content;
		if (typeof content === "string") textChars += content.length;
		else if (Array.isArray(content)) {
			for (const part of content as { type?: string; text?: string; thinking?: string; data?: string; arguments?: unknown }[]) {
				if (part.type === "text") textChars += part.text?.length ?? 0;
				else if (part.type === "thinking") thinkingChars += part.thinking?.length ?? 0;
				else if (part.type === "image") {
					images += 1;
					imageChars += part.data?.length ?? 0;
				} else if (part.type === "toolCall") argumentChars += JSON.stringify(part.arguments ?? {}).length;
			}
		}
		if (record.details !== undefined) detailsChars += JSON.stringify(record.details).length;
		if (typeof record.output === "string") textChars += record.output.length;
		if (typeof record.command === "string") textChars += record.command.length;
	}
	const payload = textChars + thinkingChars + argumentChars + detailsChars;
	return {
		textChars,
		thinkingChars,
		argumentChars,
		detailsChars,
		images,
		imageChars,
		tokens: payload / CHARS_PER_TOKEN + images * IMAGE_TOKENS,
	};
}

function realContextTokens(messages: readonly PiMessage[]): number | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as {
			role?: string;
			usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
		};
		if (message.role !== "assistant" || !message.usage) continue;
		return (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0);
	}
	return undefined;
}

const file = process.argv[2];
if (!file) {
	console.error("usage: node --import jiti/register tools/measure-gain.ts <session.jsonl> [chunkSize]");
	process.exit(1);
}
const chunkSize = Number(process.argv[3] ?? 80);

const entries = parseSessionEntries(readFileSync(file, "utf8"));
const context = buildSessionContext(entries as never[]) as unknown as { messages: Record<string, unknown>[] };
const full = (context.messages ?? []) as unknown as PiMessage[];
if (full.length === 0) {
	console.error("this session has no messages on its active branch");
	process.exit(1);
}

const before = measure(full);
const real = realContextTokens(full);
const kb = (chars: number) => `${(chars / 1024).toFixed(0)} KB`;

console.log(`${basename(file)} — ${full.length} messages`);
console.log(
	`  payload      : ${kb(before.textChars + before.thinkingChars + before.argumentChars + before.detailsChars)}` +
		` (text ${kb(before.textChars)}, thinking ${kb(before.thinkingChars)}, call args ${kb(before.argumentChars)}, details ${kb(before.detailsChars)})` +
		` + ${before.images} image(s) ${kb(before.imageChars)}`,
);
console.log(
	`  before       : ~${(before.tokens / 1000).toFixed(0)}k tokens` +
		(real ? `  (pi reported ${(real / 1000).toFixed(0)}k for this context)` : ""),
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
	},
);

let requests = 0;
let outgoing: readonly PiMessage[] = full;
const steps = Math.ceil(full.length / chunkSize);
for (let step = 0; step < steps; step += 1) {
	const slice = full.slice(-Math.min((step + 1) * chunkSize, full.length));
	const outcome = await pruner.prune(slice, { allowNetwork: true });
	requests += outcome?.stats.requests ?? 0;
	outgoing = outcome ? outcome.messages : slice;
}
const after = measure(outgoing);
const payloadBefore = before.textChars + before.thinkingChars + before.argumentChars + before.detailsChars;
const payloadAfter = after.textChars + after.thinkingChars + after.argumentChars + after.detailsChars;

console.log(`  after        : ~${(after.tokens / 1000).toFixed(0)}k tokens, ${outgoing.length} messages`);
console.log(
	`  saved        : ${(((before.tokens - after.tokens) / before.tokens) * 100).toFixed(1)}% tokens, ` +
		`${(((payloadBefore - payloadAfter) / payloadBefore) * 100).toFixed(1)}% payload` +
		` (text ${kb(before.textChars)} -> ${kb(after.textChars)}, args ${kb(before.argumentChars)} -> ${kb(after.argumentChars)}, ` +
		`details ${kb(before.detailsChars)} -> ${kb(after.detailsChars)}, images ${before.images} -> ${after.images})`,
);
console.log(`  cost         : ${requests} Jev request(s), ${pruner.cacheSize} calls scored, ${pruner.failures} failure(s)`);
console.log(
	"  note         : permissive gates (minNewCalls 1, minPendingChars 0) — this is the upper bound;",
);
console.log("                 token counts are estimates, the ratios compare the same basis.");

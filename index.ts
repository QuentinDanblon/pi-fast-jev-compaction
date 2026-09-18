/**
 * fast-jev-compaction for pi — verbatim context pruning scored by Jev.
 *
 * Port of https://github.com/tamaratran/fast-jev-compaction (MIT), vendored and
 * built at ./vendor/fast-jev-compaction.
 *
 * Upstream is a Claude Code *function hook* that replaces the compaction
 * summary: it never rewrites anything, it only deletes or truncates tool calls
 * and results that Jev says are no longer needed, and keeps every other message
 * verbatim. Pi's `session_before_compact` cannot express that (pi only persists
 * a summary string plus a contiguous `firstKeptEntryId` tail), but pi's
 * `pi.on("context")` hook runs before every LLM call and may return a modified
 * message list. That is the faithful port target:
 *
 *   - nothing is ever persisted or rewritten: the session JSONL keeps the full
 *     verbatim history, the pruning is a per-request view;
 *   - tool calls and results Jev scores as stale are dropped or truncated;
 *   - every other message is passed through untouched;
 *   - decisions are cached per (tool call, input, result) so each call is
 *     scored once instead of once per turn;
 *   - any error, malformed answer or broken tool-call/tool-result pairing
 *     aborts the rewrite and the unmodified messages are sent.
 *
 * Config: ~/.pi/agent/fast-jev-compaction.json (all keys optional) and/or
 * FAST_JEV_* environment variables. The API key is read from
 * FAST_JEV_API_KEY, JEV_API_KEY, TYPESAFE_API_KEY, config.apiKey, or the file
 * ~/.pi/agent/fast-jev-key. Without a key the extension is a silent no-op.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildJevRequest,
	collectToolCalls,
	decideCall,
	estimateTokens,
	fitState,
	noulAnswer,
	parseJevResponse,
	resolveOptions,
	questionsFor,
	type CallDecision,
	type JevAsker,
	type JevQuestions,
	type JevState,
	type Message as JevMessage,
	type ResolvedCompactOptions,
	type ToolCall,
} from "./vendor/fast-jev-compaction/dist/index.js";

/* ------------------------------------------------------------------ config */

/** Config and key locations, overridable so they can be redirected and tested. */
export function configPath(): string {
	return process.env.FAST_JEV_CONFIG ?? join(homedir(), ".pi", "agent", "fast-jev-compaction.json");
}

export function keyPath(): string {
	return process.env.FAST_JEV_KEY_FILE ?? join(homedir(), ".pi", "agent", "fast-jev-key");
}

export interface FastJevConfig {
	enabled: boolean;
	/** Share of the context window above which Jev is actually asked. */
	triggerFraction: number;
	/** Minimum new (uncached) candidates before a network round-trip. */
	minNewCalls: number;
	/** Total result chars a network round-trip must be able to free to be worth it. */
	minPendingChars: number;
	/** Minimum time between network round-trips. */
	minIntervalMs: number;
	/** Window (in messages) used when the full-conversation state cannot be fitted. */
	fallbackWindowMessages: number;
	/** Jev requests in flight per prune. */
	requestConcurrency: number;
	notify: boolean;
	apiKey?: string;
	model?: string;
	baseUrl?: string;
	timeoutMs: number;
	/** Passed straight to the upstream library's `compact` options. */
	keepThreshold?: number;
	preserveRecentMessages?: number;
	maxStateTokens?: number;
	maxRequestTokens?: number;
	truncateHeadChars?: number;
	/** Characters of each pending tool result shown to Jev (0 = upstream behaviour). */
	stateResultHeadChars?: number;
	/** Fewest LLM calls between two pruning events. */
	minCallsBetweenPrunes?: number;
	/** Tools whose calls may be deleted outright (default: read, grep, find, ls, glob). */
	readOnlyTools?: string[];
	/** Treat `bash` calls with a provably read-only command as removable (default true). */
	detectReadOnlyCommands?: boolean;
	/** Abridge kept-call string arguments longer than this (default 500; 0 = off). */
	abridgeArgumentChars?: number;
}

type PruneConfig = ResolvedCompactOptions & {
	triggerFraction: number;
	minNewCalls: number;
	minPendingChars: number;
	minIntervalMs: number;
	/** Fewest LLM calls between two pruning events (cache invalidation amortisation). */
	minCallsBetweenPrunes: number;
	timeoutMs: number;
	fallbackWindowMessages: number;
	requestConcurrency: number;
	/** Characters of each pending result shown to Jev inside the question. */
	stateResultHeadChars: number;
	/** Tools whose calls may be removed entirely; any other tool keeps its call. */
	readOnlyTools: string[];
	/** Treat `bash` calls with a provably read-only command as removable. */
	detectReadOnlyCommands: boolean;
	/** Abridge string arguments longer than this on kept calls (0 = off). */
	abridgeArgumentChars: number;
};

export type PruneOptions = Parameters<typeof resolveOptions>[0] &
	Partial<
		Pick<
			PruneConfig,
			| "triggerFraction"
			| "minNewCalls"
			| "minPendingChars"
			| "minIntervalMs"
			| "minCallsBetweenPrunes"
			| "timeoutMs"
			| "fallbackWindowMessages"
			| "requestConcurrency"
			| "stateResultHeadChars"
			| "readOnlyTools"
			| "detectReadOnlyCommands"
			| "abridgeArgumentChars"
		>
	>;

/** One decision, tied back to the tool call it scores. */
export interface PruneDecision extends CallDecision {
	toolUseId: string;
	/** Set when a `drop_call` was downgraded to `drop_result` for safety. */
	downgraded?: "mutating-tool" | "signed-thinking";
}

/**
 * Tools whose calls may be deleted outright. Everything else (bash, write, edit,
 * MCP tools…) keeps its call so the model does not lose the record of what it
 * already tried, which is how "stupid loops" start.
 */
export const DEFAULT_READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "glob"];

/**
 * Asked above this share of the window. The size gate only decides whether pruning
 * helps per turn; whether it *pays* is decided by `minCallsBetweenPrunes`, see below.
 */
const DEFAULT_TRIGGER_FRACTION = 0.5;

/**
 * Fewest LLM calls between two pruning events — the floor of the cache-cost gate.
 *
 * Removing an old call rewrites the prompt prefix, so the whole cached suffix becomes a
 * cache **write** instead of a cheap **read**. The break-even is
 *
 *     (write/read - 1) / f   further LLM calls
 *
 * where `f` is the share of the prompt the prune frees. This constant is only the floor
 * against chatter: the real gap is computed per prune from the measured `f`
 * (`JevPruner.requiredCallsBetweenPrunes`), so a read-heavy session that frees 40 % is
 * allowed to prune every ~23 calls while a result-only session waits ~80.
 */
const DEFAULT_MIN_CALLS_BETWEEN_PRUNES = 20;

/** Extra read-equivalents a rewritten prompt token costs at a write/read price ratio of ~10. */
const CACHE_REWRITE_PENALTY = 9;

/** Assumed freed share before the first prune, when there is nothing to measure yet. */
const ASSUMED_FREED_FRACTION = 0.15;

/** Characters of each pending result handed to Jev inside the question (300 ≈ a stack trace head). */
const DEFAULT_STATE_RESULT_HEAD_CHARS = 300;

const DEFAULT_CONFIG: Omit<FastJevConfig, "apiKey"> = {
	enabled: true,
	triggerFraction: DEFAULT_TRIGGER_FRACTION,
	minNewCalls: 2,
	minPendingChars: 2_000,
	minIntervalMs: 5_000,
	minCallsBetweenPrunes: DEFAULT_MIN_CALLS_BETWEEN_PRUNES,
	fallbackWindowMessages: 120,
	requestConcurrency: 4,
	stateResultHeadChars: DEFAULT_STATE_RESULT_HEAD_CHARS,
	readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
	detectReadOnlyCommands: true,
	abridgeArgumentChars: 500,
	notify: true,
	model: "jev-latest",
	baseUrl: "https://api.typesafe.ai/v1/systemone",
	timeoutMs: 10_000,
};

function envNumber(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

function envBool(name: string): boolean | undefined {
	const raw = process.env[name]?.trim().toLowerCase();
	if (raw === undefined || raw === "") return undefined;
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function readJson<T>(path: string): Partial<T> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Partial<T>;
	} catch {
		return undefined;
	}
}

export function loadConfig(path: string = configPath()): FastJevConfig {
	const file = readJson<FastJevConfig>(path) ?? {};
	const merged: FastJevConfig = { ...DEFAULT_CONFIG, ...file };
	const overrides: Partial<FastJevConfig> = {
		enabled: envBool("FAST_JEV_ENABLED"),
		triggerFraction: envNumber("FAST_JEV_TRIGGER_FRACTION"),
		minNewCalls: envNumber("FAST_JEV_MIN_NEW_CALLS"),
		minIntervalMs: envNumber("FAST_JEV_MIN_INTERVAL_MS"),
		notify: envBool("FAST_JEV_NOTIFY"),
		model: process.env.FAST_JEV_MODEL,
		baseUrl: process.env.FAST_JEV_BASE_URL,
		timeoutMs: envNumber("FAST_JEV_TIMEOUT_MS"),
	};
	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
	}
	return merged;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

/**
 * The key, in precedence order: FAST_JEV_API_KEY, JEV_API_KEY, TYPESAFE_API_KEY,
 * `apiKey` in the config file, then the key file. Everything is trimmed; an empty
 * value never wins.
 */
export function resolveApiKey(config: FastJevConfig, path: string = keyPath()): string | undefined {
	let fromFile: string | undefined;
	try {
		fromFile = readFileSync(path, "utf8").trim();
	} catch {
		fromFile = undefined;
	}
	return firstNonEmpty(
		process.env.FAST_JEV_API_KEY,
		process.env.JEV_API_KEY,
		process.env.TYPESAFE_API_KEY,
		config.apiKey,
		fromFile,
	);
}

/**
 * True when the key file is readable by group or others. Windows mode bits carry
 * no such meaning, so the check is skipped there. Used for a one-time warning;
 * the file is still read, because refusing the key would be a worse surprise.
 */
export function keyFileIsLoose(path: string = keyPath()): boolean {
	if (process.platform === "win32") return false;
	try {
		return (statSync(path).mode & 0o077) !== 0;
	} catch {
		return false;
	}
}

/* ------------------------------------------------------------------ asker */

/** Jev over HTTP with an abortable timeout; no retries on the request path. */
export class HttpJevAsker implements JevAsker {
	#apiKey: string;
	#model: string | undefined;
	#baseUrl: string | undefined;
	#timeoutMs: number;
	#fetcher: typeof fetch;

	constructor(options: { apiKey: string; model?: string; baseUrl?: string; timeoutMs?: number }) {
		this.#apiKey = options.apiKey;
		this.#model = options.model;
		this.#baseUrl = options.baseUrl;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_CONFIG.timeoutMs;
		this.#fetcher = fetch;
	}

	async ask(state: JevState, questions: JevQuestions) {
		const request = buildJevRequest(
			{ apiKey: this.#apiKey, model: this.#model, baseUrl: this.#baseUrl },
			state,
			questions,
		);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
		try {
			const response = await this.#fetcher(request.url, {
				method: request.method,
				headers: request.headers,
				body: request.body,
				signal: controller.signal,
			});
			return parseJevResponse(response.status, response.ok, await response.text());
		} finally {
			clearTimeout(timer);
		}
	}
}

/* ------------------------------------------------- pi message conversion */

type Part = { type: string; [key: string]: unknown };

export interface PiMessage {
	role: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	[custom: string]: unknown;
}

function asParts(content: unknown): Part[] {
	if (Array.isArray(content)) return content as Part[];
	if (typeof content === "string") return [{ type: "text", text: content }];
	return [];
}

function partText(part: Part): string {
	if (part.type === "text" && typeof part.text === "string") return part.text;
	if (part.type === "thinking" && typeof part.thinking === "string") return part.thinking;
	if (part.type === "image") return `[image: ${String(part.mimeType ?? "unknown")}]`;
	return "";
}

function messageText(message: PiMessage): string {
	if (typeof message.content === "string") return message.content;
	return asParts(message.content)
		.map(partText)
		.filter((text) => text.length > 0)
		.join("\n");
}

function messageReason(msg: unknown): string {
	return msg instanceof Error ? msg.message : String(msg);
}

function toolCallParts(message: PiMessage): Part[] {
	return asParts(message.content).filter((part) => part.type === "toolCall");
}

function resultText(message: PiMessage): string {
	if (typeof message.content === "string") return message.content;
	return asParts(message.content)
		.map(partText)
		.filter((text) => text.length > 0)
		.join("\n");
}

/** pi `AgentMessage[]` -> the upstream library's Claude-shaped `Message[]`, 1:1. */
export function toJevMessages(messages: readonly PiMessage[]): JevMessage[] {
	return messages.map((message) => {
		switch (message.role) {
			case "toolResult": {
				const id = String(message.toolCallId ?? "");
				return {
					role: "user" as const,
					text: "",
					toolUses: [],
					toolResults: [
						{ tool_use_id: id, text: resultText(message), isError: message.isError === true },
					],
				};
			}
			case "assistant": {
				return {
					role: "assistant" as const,
					text: messageText(message),
					toolUses: toolCallParts(message).map((part) => ({
						tool_use_id: String(part.id ?? ""),
						tool: String(part.name ?? "?"),
						input: (part.arguments as Record<string, unknown> | undefined) ?? {},
					})),
				};
			}
			case "bashExecution": {
				return {
					role: "user" as const,
					text: `$ ${String(message.command ?? "")}\n${String(message.output ?? "")}`,
					toolUses: [],
				};
			}
			case "compactionSummary":
			case "branchSummary": {
				return {
					role: "user" as const,
					text: String(message.summary ?? ""),
					toolUses: [],
				};
			}
			case "custom": {
				return { role: "user" as const, text: messageText(message), toolUses: [] };
			}
			default: {
				return {
					role: (message.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
					text: messageText(message),
					toolUses: [],
				};
			}
		}
	});
}

/**
 * True when the last request already rewrote its own prompt prefix — a cache miss that was
 * going to happen anyway — so a prune now costs no extra cache write. Evidence: a large
 * share of the last prompt was billed as uncached input.
 */
export function cacheAlreadyCold(messages: readonly PiMessage[]): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as {
			role?: string;
			usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
		};
		if (message.role !== "assistant" || !message.usage) continue;
		const prompt = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0);
		if (prompt <= 0) return false;
		return (message.usage.input ?? 0) / prompt > 0.25;
	}
	return false;
}

function assistantHasThinking(message: PiMessage | undefined): boolean {
	return message !== undefined && asParts(message.content).some((part) => part.type === "thinking");
}

/* ------------------------------------------------------------- the pruner */

export interface PruneOutcome {
	messages: PiMessage[];
	decisions: PruneDecision[];
	stats: {
		calls: number;
		kept: number;
		resultsDropped: number;
		callsDropped: number;
		/** `drop_call` downgraded to `drop_result` by the safety rules. */
		downgraded: number;
		/** Long arguments of kept calls that were abridged. */
		abridgedArgs: number;
		pinned: number;
		charsBefore: number;
		charsAfter: number;
		requests: number;
		stateTokens: number;
		/** True when the state only covered the fallback window. */
		windowed: boolean;
		ms: number;
	};
}

export interface PruneControls {
	/** When false, only cached decisions are applied (no network). */
	allowNetwork: boolean;
	/** Ignore the minNewCalls/minIntervalMs gates (context nearly full). */
	urgent?: boolean;
}

interface CachedDecision {
	keepCall: number;
	keepResult: number;
}

function hash(text: string): string {
	let value = 0x81_1c_9d_c5;
	for (let index = 0; index < text.length; index += 1) {
		value ^= text.charCodeAt(index);
		value = Math.imul(value, 0x01_00_01_93) >>> 0;
	}
	return value.toString(36);
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			results[index] = await fn(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
	return results;
}

/** A safe head of each result, so Jev judges content it can actually read. */
function resultHeads(
	messages: readonly JevMessage[],
	calls: readonly ToolCall[],
	headChars: number,
): Map<string, string> {
	const heads = new Map<string, string>();
	if (headChars <= 0) return heads;
	for (const call of calls) {
		const text =
			messages[call.resultIndex]?.toolResults?.find((result) => result.tool_use_id === call.tool_use_id)?.text ?? "";
		heads.set(call.tool_use_id, text.slice(0, headChars));
	}
	return heads;
}

/**
 * The two questions asked about one call. The result question carries the head of
 * the result, because upstream's state replaces every result with `n chars
 * (omitted)` — which asks Jev to judge usefulness from the length alone.
 */
export function buildQuestions(call: ToolCall, resultHead: string): JevQuestions {
	const questions = questionsFor(call);
	const key = `result_${call.id}`;
	const question = questions[key];
	if (!question || resultHead.length === 0) return questions;
	const truncated = resultHead.length < call.resultChars;
	return {
		...questions,
		[key]: {
			...question,
			instructions: `${question.instructions}\nIts output begins: ${resultHead}${
				truncated ? ` … (${call.resultChars} characters in total)` : ""
			}`,
		},
	};
}

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

/**
 * Splits candidate calls into batches whose questions fit one request together with
 * the (always complete) state. Upstream's `batchCalls` cannot be used here: it prices
 * questions built without the result heads, which would overflow Jev's 32k ceiling.
 */
export function batchCallsWith(
	calls: readonly ToolCall[],
	stateTokens: number,
	maxRequestTokens: number,
	questionsOf: (call: ToolCall) => JevQuestions,
): ToolCall[][] {
	const budget = maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
	const batches: ToolCall[][] = [];
	let current: ToolCall[] = [];
	let currentTokens = 0;
	for (const call of calls) {
		const tokens = estimateTokens(JSON.stringify(questionsOf(call)));
		if (current.length > 0 && currentTokens + tokens > budget) {
			batches.push(current);
			current = [];
			currentTokens = 0;
		}
		if (current.length === 0 && tokens > budget) {
			throw new Error(
				`state leaves no room for questions (~${stateTokens} of ${maxRequestTokens} tokens)`,
			);
		}
		current.push(call);
		currentTokens += tokens;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

/**
 * Shell commands that cannot change anything: safe to drop the whole call, because
 * re-running them is free. Anything else (installs, migrations, writes, deploys) keeps
 * its call so the model does not lose the record of what it already tried.
 */
const READ_ONLY_COMMANDS = new Set([
	"basename", "cat", "cd", "cut", "date", "df", "diff", "dirname", "du", "echo", "env", "file",
	"find", "grep", "head", "ls", "printenv", "pwd", "readlink", "realpath", "rg", "sort", "stat",
	"tail", "tree", "tr", "uniq", "wc", "which", "whoami",
]);

// `branch`, `tag` and `remote` are deliberately absent: they mutate when given arguments.
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"blame", "describe", "diff", "log", "ls-files", "rev-parse", "shortlog", "show", "status",
]);

const READ_ONLY_PACKAGE_SUBCOMMANDS = new Set(["ls", "list", "outdated", "view", "why"]);

function isReadOnlySegment(segment: string): boolean {
	const tokens = segment.trim().split(/\s+/).filter((token) => token.length > 0);
	if (tokens.length === 0) return false;
	// Leading VAR=value assignments are fine.
	let index = 0;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
	const command = tokens[index]?.replace(/^.*[\\/]/, "");
	if (command === undefined) return false;
	const sub = tokens[index + 1];
	if (command === "git") return sub !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(sub);
	if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
		return sub !== undefined && READ_ONLY_PACKAGE_SUBCOMMANDS.has(sub);
	}
	if (["npx", "tsx", "tsc"].includes(command)) return false;
	return READ_ONLY_COMMANDS.has(command);
}

/**
 * True when a shell command provably only reads: every `|`/`&&`/`;`/`||` segment starts
 * with a read-only command, with no redirect, command substitution or background job.
 */
export function isReadOnlyCommand(command: string): boolean {
	if (command.trim().length === 0) return false;
	if (/[<>`]|\$\(|\$\{/.test(command)) return false; // redirect or substitution
	if (/(^|[^|&])&($|[^&])/.test(command)) return false; // background job
	if (/(^|\s)-i(\s|$|=)/.test(command)) return false; // in-place edit (sed -i, perl -i)
	const segments = command.split(/\|\||&&|\||;/);
	return segments.every((segment) => isReadOnlySegment(segment));
}

function cacheKeyFor(call: ToolCall, messages: readonly JevMessage[]): string {
	const callMessage = messages[call.callIndex];
	const resultMessage = messages[call.resultIndex];
	const input = callMessage?.toolUses.find((use) => use.tool_use_id === call.tool_use_id)?.input;
	const result = resultMessage?.toolResults?.find((res) => res.tool_use_id === call.tool_use_id);
	return `${call.tool_use_id}|${hash(JSON.stringify(input ?? {}))}|${hash(result?.text ?? "")}`;
}

/** Jev-backed, cache-backed pruner over pi messages. Pure except for the asker. */
export class JevPruner {
	#asker: JevAsker;
	#options: PruneConfig;
	#cache = new Map<string, CachedDecision>();
	#requests = 0;
	#failures = 0;
	#windowedRuns = 0;
	#lastFreedFraction = 0;
	#maxFreedFraction = 0;
	#lastError: string | undefined;
	#lastAttemptAt = 0;

	constructor(asker: JevAsker, options: PruneOptions = {}) {
		this.#asker = asker;
		const defined = Object.fromEntries(
			Object.entries(options).filter(([, value]) => value !== undefined),
		) as PruneOptions;
		this.#options = {
			...resolveOptions(defined),
			triggerFraction: defined.triggerFraction ?? DEFAULT_CONFIG.triggerFraction,
			minNewCalls: defined.minNewCalls ?? DEFAULT_CONFIG.minNewCalls,
			minPendingChars: defined.minPendingChars ?? DEFAULT_CONFIG.minPendingChars,
			minIntervalMs: defined.minIntervalMs ?? DEFAULT_CONFIG.minIntervalMs,
			minCallsBetweenPrunes:
				defined.minCallsBetweenPrunes ?? DEFAULT_MIN_CALLS_BETWEEN_PRUNES,
			timeoutMs: defined.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
			fallbackWindowMessages: defined.fallbackWindowMessages ?? DEFAULT_CONFIG.fallbackWindowMessages,
			requestConcurrency: defined.requestConcurrency ?? DEFAULT_CONFIG.requestConcurrency,
			stateResultHeadChars: defined.stateResultHeadChars ?? DEFAULT_STATE_RESULT_HEAD_CHARS,
			readOnlyTools: defined.readOnlyTools ?? DEFAULT_READ_ONLY_TOOLS,
			detectReadOnlyCommands: defined.detectReadOnlyCommands ?? true,
			abridgeArgumentChars: defined.abridgeArgumentChars ?? 500,
		};
	}

	get cacheSize(): number {
		return this.#cache.size;
	}

	get requests(): number {
		return this.#requests;
	}

	/** Failed Jev requests (timeout, HTTP error, malformed answer). */
	get failures(): number {
		return this.#failures;
	}

	/** Prunes whose state only covered the fallback window. */
	get windowedRuns(): number {
		return this.#windowedRuns;
	}

	/** Share of the prompt the last prune freed, for diagnostics. */
	get freedFraction(): number {
		return this.#lastFreedFraction;
	}

	/**
	 * How many further LLM calls must pass before a prune can pay for the cache write it
	 * causes. Derived from the best share any prune has freed so far — a single thin sample
	 * (early in a session, when little movable mass exists yet) must not lock the gate shut —
	 * and bounded, so the gate is always re-evaluated.
	 */
	get requiredCallsBetweenPrunes(): number {
		const freed = this.#maxFreedFraction > 0 ? this.#maxFreedFraction : ASSUMED_FREED_FRACTION;
		const auto = Math.ceil(CACHE_REWRITE_PENALTY / Math.max(freed, 0.05));
		return Math.min(200, Math.max(this.#options.minCallsBetweenPrunes, auto));
	}

	/** Message of the most recent failure, for diagnostics. */
	get lastError(): string | undefined {
		return this.#lastError;
	}

	clearCache(): void {
		this.#cache.clear();
	}

	async prune(
		messages: readonly PiMessage[],
		controls: PruneControls = { allowNetwork: true },
	): Promise<PruneOutcome | null> {
		const started = Date.now();
		const charsBefore = JSON.stringify(messages).length;
		const jevMessages = toJevMessages(messages);
		const calls = collectToolCalls(jevMessages, this.#options.preserveRecentMessages);
		if (calls.length === 0) return null;

		const keys = new Map<string, string>();
		const pending: ToolCall[] = [];
		const resolved = new Map<string, CachedDecision>();
		for (const call of calls) {
			const key = cacheKeyFor(call, jevMessages);
			keys.set(call.id, key);
			const cached = this.#cache.get(key);
			if (call.pinned) {
				resolved.set(call.id, { keepCall: 1, keepResult: 1 });
			} else if (cached) {
				resolved.set(call.id, cached);
			} else {
				pending.push(call);
			}
		}

		const pendingChars = pending.reduce((sum, call) => sum + call.resultChars, 0);
		const intervalElapsed = Date.now() - this.#lastAttemptAt >= this.#options.minIntervalMs;
		const enough =
			pending.length >= Math.max(1, this.#options.minNewCalls) &&
			pendingChars >= this.#options.minPendingChars &&
			intervalElapsed;
		const wantNetwork = controls.allowNetwork && pending.length > 0 && (enough || controls.urgent === true);

		let scored = { requests: 0, stateTokens: 0, windowed: false };
		if (wantNetwork) {
			// Recorded before the call so a hanging or failing Jev is retried at most
			// once per interval instead of on every LLM request.
			this.#lastAttemptAt = Date.now();
			scored = await this.#scorePending(jevMessages, calls, pending, resolved);
			if (scored.windowed) this.#windowedRuns += 1;
		}

		const decisions: PruneDecision[] = calls.map((call) => {
			const key = keys.get(call.id) ?? call.tool_use_id;
			const answer = resolved.get(call.id);
			if (!answer) {
				// Never scored (network skipped or failed): keep, and leave uncached
				// so the next eligible turn can still ask about this call.
				return {
					...decideCall(call, { keepCall: 1, keepResult: 1 }, this.#options),
					toolUseId: call.tool_use_id,
				};
			}
			if (!call.pinned) this.#cache.set(key, answer);
			const decision: PruneDecision = {
				...decideCall(call, { keepCall: answer.keepCall, keepResult: answer.keepResult }, this.#options),
				toolUseId: call.tool_use_id,
			};
			return this.#applySafetyRules(call, messages, decision);
		});

		const applied = applyDecisions(
			messages,
			decisions,
			this.#options.truncateHeadChars,
			pairedIds(calls),
			this.#options.abridgeArgumentChars,
		);
		if (!applied) return null;
		const charsAfter = JSON.stringify(applied.messages).length;
		if (charsAfter < charsBefore) {
			const freed = (charsBefore - charsAfter) / charsBefore;
			this.#lastFreedFraction = freed;
			if (freed > this.#maxFreedFraction) this.#maxFreedFraction = freed;
		}
		return {
			messages: applied.messages,
			decisions,
			stats: {
				calls: calls.length,
				kept: decisions.filter((decision) => decision.action === "keep").length,
				resultsDropped: decisions.filter((decision) => decision.action === "drop_result").length,
				callsDropped: decisions.filter((decision) => decision.action === "drop_call").length,
				downgraded: decisions.filter((decision) => decision.downgraded !== undefined).length,
				abridgedArgs: applied.abridgedArgs,
				pinned: calls.filter((call) => call.pinned).length,
				charsBefore,
				charsAfter,
				requests: scored.requests,
				stateTokens: scored.stateTokens,
				windowed: scored.windowed,
				ms: Date.now() - started,
			},
		};
	}

	/**
	 * A call may only be removed outright when removing it is safe:
	 *
	 * - re-running the tool must be harmless, so mutating tools (bash, write, edit,
	 *   MCP…) keep their call and are only truncated — that also preserves the record
	 *   of what was already tried, which is how the model avoids repeating itself;
	 * - the assistant message must not carry a thinking block, because rewriting a
	 *   message that holds a provider-signed reasoning payload invalidates it.
	 *
	 * Both cases fall back to `drop_result`: the bulky output goes, the call stays.
	 */
	#applySafetyRules(call: ToolCall, messages: readonly PiMessage[], decision: PruneDecision): PruneDecision {
		if (decision.action !== "drop_call") return decision;
		const tool = call.tool.toLowerCase();
		const readOnlyTool = this.#options.readOnlyTools.some((allowed) => allowed.toLowerCase() === tool);
		if (!readOnlyTool && !this.#isProvablyReadOnlyShellCall(call, messages)) {
			return { ...decision, action: "drop_result", reason: "result_dropped", downgraded: "mutating-tool" };
		}
		if (assistantHasThinking(messages[call.callIndex])) {
			return { ...decision, action: "drop_result", reason: "result_dropped", downgraded: "signed-thinking" };
		}
		return decision;
	}

	/** `bash` is droppable only when its command is provably read-only. */
	#isProvablyReadOnlyShellCall(call: ToolCall, messages: readonly PiMessage[]): boolean {
		if (!this.#options.detectReadOnlyCommands) return false;
		const tool = call.tool.toLowerCase();
		if (tool !== "bash" && tool !== "shell" && tool !== "sh") return false;
		const input = messages[call.callIndex]
			? toJevMessages([messages[call.callIndex]])[0]?.toolUses.find(
					(use) => use.tool_use_id === call.tool_use_id,
				)?.input
			: undefined;
		const command = input?.command ?? input?.cmd ?? input?.script;
		return typeof command === "string" && isReadOnlyCommand(command);
	}

	/**
	 * Asks Jev about the pending calls and fills `resolved`; returns the number of
	 * HTTP requests, the fitted state size and whether the state had to be windowed.
	 *
	 * The state is the whole conversation. When even the fully truncated history is
	 * too big for `maxStateTokens` — a long session with hundreds of tool calls hits
	 * this floor — the state is rebuilt from the newest `fallbackWindowMessages`
	 * messages instead, so pruning keeps working (at reduced context) rather than
	 * switching itself off in exactly the sessions that need it.
	 */
	async #scorePending(
		jevMessages: readonly JevMessage[],
		calls: readonly ToolCall[],
		pending: readonly ToolCall[],
		resolved: Map<string, CachedDecision>,
	): Promise<{ requests: number; stateTokens: number; windowed: boolean }> {
		const pendingByToolUseId = new Map(pending.map((call) => [call.tool_use_id, call]));
		const headChars = this.#options.stateResultHeadChars;
		let state: JevState;
		let stateTokens: number;
		let batches: ToolCall[][];
		let questionsOf: (call: ToolCall) => JevQuestions;
		let windowed = false;
		try {
			const fittedState = fitState(jevMessages, calls, this.#options);
			state = fittedState.state;
			stateTokens = fittedState.tokens;
			const heads = resultHeads(jevMessages, pending, headChars);
			questionsOf = (call) => buildQuestions(call, heads.get(call.tool_use_id) ?? "");
			batches = batchCallsWith(pending, fittedState.tokens, this.#options.maxRequestTokens, questionsOf);
		} catch (fitError) {
			const window = this.#options.fallbackWindowMessages;
			const windowedMessages = window > 0 ? jevMessages.slice(-window) : [];
			const windowedCalls = collectToolCalls(windowedMessages, 0).filter((call) => !call.pinned);
			if (windowedCalls.length === 0) {
				this.#recordFailure(fitError); // cannot be fitted at all: keep all, retry later
				return { requests: 0, stateTokens: 0, windowed: false };
			}
			try {
				const fittedState = fitState(windowedMessages, windowedCalls, this.#options);
				state = fittedState.state;
				stateTokens = fittedState.tokens;
				// Heads must come from the same slice: the two call lists number their
				// calls independently, so they are matched by tool-call id, never by id.
				const heads = resultHeads(windowedMessages, windowedCalls, headChars);
				const windowedQuestionsOf = (call: ToolCall) =>
					buildQuestions(call, heads.get(call.tool_use_id) ?? "");
				questionsOf = windowedQuestionsOf;
				batches = batchCallsWith(windowedCalls, fittedState.tokens, this.#options.maxRequestTokens, windowedQuestionsOf);
				windowed = true;
			} catch (windowError) {
				this.#recordFailure(windowError);
				return { requests: 0, stateTokens: 0, windowed: false };
			}
		}

		let requests = 0;
		await mapWithConcurrency(batches, this.#options.requestConcurrency, async (batch) => {
			const questions = Object.assign({}, ...batch.map(questionsOf));
			try {
				const response = await this.#asker.ask(state, questions);
				this.#requests += 1;
				requests += 1;
				for (const asked of batch) {
					// In the windowed case the asked call carries a different positional id;
					// decisions are keyed by the pending call, i.e. by tool-call id.
					const target = pendingByToolUseId.get(asked.tool_use_id);
					if (!target) continue;
					resolved.set(target.id, {
						keepCall: noulAnswer(response.answers, `call_${asked.id}`),
						keepResult: noulAnswer(response.answers, `result_${asked.id}`),
					});
				}
			} catch (error) {
				// Leave this batch unscored: those calls stay verbatim, uncached.
				this.#recordFailure(error);
			}
		});
		return { requests, stateTokens, windowed };
	}

	#recordFailure(error: unknown): void {
		this.#failures += 1;
		this.#lastError = messageReason(error);
	}
}

/* -------------------------------------------------- applying the decisions */

function truncatedResultContent(text: string, isError: boolean, headChars: number): string {
	if (text.length === 0) return "[fast-jev-compaction removed an empty tool result]";
	if (text.length <= headChars + 120) return text;
	const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : "";
	return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
		isError ? " (error)" : ""
	}; re-run the tool if needed]`;
}

/** The tool-use ids that had a matching result in the input messages. */
function pairedIds(calls: readonly ToolCall[]): Set<string> {
	return new Set(calls.map((call) => call.tool_use_id));
}

/**
 * Rewrites pi messages from Jev decisions. Returns null when the result would
 * break the tool-call/tool-result pairing providers require, in which case the
 * caller keeps the original messages.
 */
/**
 * Abridges the long string arguments of a call whose result is being truncated. The
 * call and its shape stay (the model keeps the record of what it ran), but a 40 KB file
 * body or prompt does not have to be re-sent on every later turn: the tool has already
 * run and its effect is on disk. Returns the part unchanged when nothing is long enough.
 */
function abridgeArguments(part: Part, limit: number): [Part, boolean] {
	const args = part.arguments;
	if (args === null || typeof args !== "object" || Array.isArray(args)) return [part, false];
	const next: Record<string, unknown> = {};
	let changed = false;
	for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
		if (typeof value === "string" && value.length > limit) {
			next[key] =
				`${value.slice(0, limit)}\n[fast-jev-compaction abridged ${value.length - limit} characters ` +
				"of this argument; the call already ran]";
			changed = true;
		} else {
			next[key] = value;
		}
	}
	return changed ? [{ ...part, arguments: next }, true] : [part, false];
}

export function applyDecisions(
	messages: readonly PiMessage[],
	decisions: readonly PruneDecision[],
	truncateHeadChars: number,
	paired: ReadonlySet<string>,
	abridgeArgumentChars: number,
): { messages: PiMessage[]; abridgedArgs: number } | null {
	const actionOf = new Map<string, CallDecision["action"]>();
	for (const decision of decisions) {
		if (decision.action === "keep") continue;
		actionOf.set(decision.toolUseId, decision.action);
	}
	if (actionOf.size === 0) return null;

	let abridgedArgs = 0;
	const output: PiMessage[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") {
			const id = String(message.toolCallId ?? "");
			const action = actionOf.get(id);
			if (action === "drop_call") continue;
			if (action === "drop_result") {
				const text = truncatedResultContent(resultText(message), message.isError === true, truncateHeadChars);
				const rewritten: PiMessage = {
					...message,
					content: text.length > 0 ? [{ type: "text", text }] : [],
				};
				delete rewritten.details;
				output.push(rewritten);
				continue;
			}
			output.push(message);
			continue;
		}

		const parts = asParts(message.content);
		if (message.role !== "assistant" || parts.length === 0) {
			output.push(message);
			continue;
		}
		// A message carrying a provider-signed thinking block is never modified.
		const locked = parts.some((part) => part.type === "thinking");
		const kept = parts.flatMap((part) => {
			if (part.type !== "toolCall") return [part];
			const action = actionOf.get(String(part.id ?? ""));
			if (action === "drop_call") return [];
			if (action !== "drop_result" || locked || abridgeArgumentChars <= 0) return [part];
			const [abridged, changed] = abridgeArguments(part, abridgeArgumentChars);
			if (!changed) return [part];
			abridgedArgs += 1;
			return [abridged];
		});
		if (kept.length === parts.length && kept.every((part, index) => part === parts[index])) {
			output.push(message);
			continue;
		}
		const rewritten: PiMessage = { ...message, content: kept };
		if (kept.length === 0) {
			rewritten.content = [{ type: "text", text: "[fast-jev-compaction removed stale tool call(s)]" }];
		}
		if (rewritten.stopReason === "toolUse" && kept.every((part) => part.type !== "toolCall")) {
			rewritten.stopReason = "stop";
		}
		output.push(rewritten);
	}

	if (!pairingIntact(output, paired)) return null;
	return { messages: output, abridgedArgs };
}

/**
 * No new orphan may be introduced: every paired call that survives still has
 * its result, and every surviving result still has its call. Tool calls that
 * were already unpaired in the input are left alone.
 */
function pairingIntact(messages: readonly PiMessage[], paired: ReadonlySet<string>): boolean {
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const part of toolCallParts(message)) calls.add(String(part.id ?? ""));
		} else if (message.role === "toolResult") {
			results.add(String(message.toolCallId ?? ""));
		}
	}
	for (const id of paired) {
		if (calls.has(id) !== results.has(id)) return false;
	}
	return true;
}

/* ------------------------------------------------------------- extension */

interface PrunerState {
	config: FastJevConfig;
	pruner: JevPruner | undefined;
	apiKey: string | undefined;
	lastStatus: string | undefined;
	warnedMissingKey: boolean;
	notifiedFailures: number;
	notifiedWindowed: boolean;
	/** LLM calls seen since the last prune that asked Jev something. */
	callsSincePrune: number;
}

function buildPruner(config: FastJevConfig, apiKey: string): JevPruner {
	const asker = new HttpJevAsker({
		apiKey,
		model: config.model,
		baseUrl: config.baseUrl,
		timeoutMs: config.timeoutMs,
	});
	return new JevPruner(asker, {
		keepThreshold: config.keepThreshold,
		preserveRecentMessages: config.preserveRecentMessages,
		maxStateTokens: config.maxStateTokens,
		maxRequestTokens: config.maxRequestTokens,
		truncateHeadChars: config.truncateHeadChars,
		triggerFraction: config.triggerFraction,
		minNewCalls: config.minNewCalls,
		minIntervalMs: config.minIntervalMs,
		timeoutMs: config.timeoutMs,
	});
}

function formatStats(outcome: PruneOutcome): string {
	const { stats } = outcome;
	const saved = stats.charsBefore - stats.charsAfter;
	return `jev: ${stats.callsDropped} call(s) + ${stats.resultsDropped} result(s) dropped${
		stats.downgraded > 0 ? ` (${stats.downgraded} kept for safety)` : ""
	}, ${stats.kept} kept, ~${saved} chars saved (${stats.requests} request(s), ${stats.ms}ms)`;
}

/** Short one-liner for the footer status. */
function formatStatus(outcome: PruneOutcome): string {
	const { stats } = outcome;
	const saved = Math.round((stats.charsBefore - stats.charsAfter) / 100) / 10;
	return `jev: -${saved}k ch, ${stats.callsDropped}+${stats.resultsDropped} dropped, ${stats.requests} req${stats.windowed ? " [window]" : ""}`;
}

export default function fastJevCompaction(pi: ExtensionAPI): void {
	const state: PrunerState = {
		config: loadConfig(),
		pruner: undefined,
		apiKey: undefined,
		lastStatus: undefined,
		warnedMissingKey: false,
		notifiedFailures: 0,
		notifiedWindowed: false,
		callsSincePrune: Number.POSITIVE_INFINITY,
	};

	const ensurePruner = (ctx: ExtensionContext): JevPruner | undefined => {
		if (!state.config.enabled) return undefined;
		if (!state.pruner || !state.apiKey) {
			state.apiKey = resolveApiKey(state.config);
			if (!state.apiKey) {
				if (!state.warnedMissingKey && state.config.notify) {
					state.warnedMissingKey = true;
					ctx.ui.notify(
						"fast-jev-compaction: no API key (set FAST_JEV_API_KEY or JEV_API_KEY); context left untouched",
						"warning",
					);
				}
				return undefined;
			}
			state.pruner = buildPruner(state.config, state.apiKey);
			if (state.config.notify) {
				if (keyFileIsLoose()) {
					ctx.ui.notify(
						`fast-jev-compaction: ${keyPath()} is readable by other users (chmod 600 it)`,
						"warning",
					);
				}
				ctx.ui.setStatus("fast-jev", "jev: armed");
			}
		}
		return state.pruner;
	};

	pi.on("context", async (event, ctx) => {
		const pruner = ensurePruner(ctx);
		if (!pruner) return;

		const usage = ctx.getContextUsage();
		const window = usage?.contextWindow ?? 0;
		const used = usage?.tokens ?? estimateTokens(JSON.stringify(event.messages));
		const trigger = window > 0 ? window * state.config.triggerFraction : Number.POSITIVE_INFINITY;
		// A prune rewrites the prompt prefix, so the cached suffix becomes a cache write
		// (roughly 10x the price of a read). One prune therefore has to be amortised over
		// enough further calls: see DEFAULT_MIN_CALLS_BETWEEN_PRUNES.
		const urgent = window > 0 && used >= window * 0.85;
		state.callsSincePrune += 1;
		const minCallsBetweenPrunes = pruner.requiredCallsBetweenPrunes;
		// A cache miss that was going to happen anyway makes a prune free of extra cost.
		const freeMoment = cacheAlreadyCold(event.messages as unknown as PiMessage[]);
		const allowNetwork =
			used >= trigger && (state.callsSincePrune >= minCallsBetweenPrunes || urgent || freeMoment);

		let outcome: PruneOutcome | null;
		try {
			outcome = await pruner.prune(event.messages as unknown as PiMessage[], { allowNetwork, urgent });
		} catch (error) {
			ctx.ui.notify(`fast-jev-compaction: ${messageReason(error)}`, "error");
			return;
		}
		if (outcome && outcome.stats.requests > 0) state.callsSincePrune = 0;
		if (!outcome) return;

		if (state.config.notify && pruner.failures > state.notifiedFailures) {
			state.notifiedFailures = pruner.failures;
			ctx.ui.notify(
				`fast-jev-compaction: Jev request failed (${pruner.lastError ?? "unknown"}); context kept verbatim`,
				"warning",
			);
		}

		if (state.config.notify && pruner.windowedRuns > 0 && !state.notifiedWindowed) {
			state.notifiedWindowed = true;
			ctx.ui.notify(
				`fast-jev-compaction: history too large for the full state, scoring against the last ${state.config.fallbackWindowMessages} messages`,
				"warning",
			);
		}

		if (state.config.notify && outcome.stats.requests > 0) {
			const line = formatStats(outcome);
			state.lastStatus = line;
			ctx.ui.setStatus("fast-jev", formatStatus(outcome));
		}
		return { messages: outcome.messages as unknown as typeof event.messages };
	});

	pi.registerCommand("jev-compaction", {
		description: "fast-jev-compaction: status, on/off, clear cache, live probe",
		handler: async (args, ctx) => {
			const command = (args ?? "").trim().toLowerCase();
			if (command === "on" || command === "off") {
				state.config.enabled = command === "on";
				if (state.config.enabled) state.pruner = undefined;
				ctx.ui.notify(`fast-jev-compaction ${command}`, "info");
				return;
			}
			if (command === "clear") {
				state.pruner?.clearCache();
				ctx.ui.notify("fast-jev-compaction: decision cache cleared", "info");
				return;
			}
			if (command === "probe") {
				const apiKey = resolveApiKey(state.config);
				if (!apiKey) {
					ctx.ui.notify("fast-jev-compaction: no API key configured", "warning");
					return;
				}
				const asker = new HttpJevAsker({
					apiKey,
					model: state.config.model,
					baseUrl: state.config.baseUrl,
					timeoutMs: state.config.timeoutMs,
				});
				try {
					const response = await asker.ask({ probe: "pi fast-jev-compaction" }, {
						probe: {
							type: "noul",
							instructions: "Does this request come from a pi coding-agent session?",
						},
					});
					const answer = noulAnswer(response.answers, "probe");
					ctx.ui.notify(`fast-jev-compaction: probe ok (p=${answer.toFixed(2)}, model ${response.model ?? "?"})`, "info");
				} catch (error) {
					ctx.ui.notify(`fast-jev-compaction: probe failed — ${messageReason(error)}`, "error");
				}
				return;
			}
			const minCallsBetweenPrunes =
				state.config.minCallsBetweenPrunes ?? DEFAULT_MIN_CALLS_BETWEEN_PRUNES;
			const pruner = state.pruner;
			ctx.ui.notify(
				[
					`fast-jev-compaction: ${state.config.enabled ? "enabled" : "disabled"}`,
					`key: ${resolveApiKey(state.config) ? "configured" : "missing"}`,
					`trigger: ${(state.config.triggerFraction * 100).toFixed(0)}% of window`,
					`may be dropped outright: ${(state.config.readOnlyTools ?? DEFAULT_READ_ONLY_TOOLS).join(", ") || "(nothing)"}; other tools keep their call`,
					`result head shown to Jev: ${state.config.stateResultHeadChars} chars`,
					`min new calls/requests: ${state.config.minNewCalls}/${state.config.minIntervalMs}ms`,
					`calls between prunes: ${minCallsBetweenPrunes} required (${Number.isFinite(state.callsSincePrune) ? state.callsSincePrune : "-"} since the last one; last prune freed ${((pruner?.freedFraction ?? 0) * 100).toFixed(1)}%)`,
					`cached decisions: ${pruner?.cacheSize ?? 0}, requests this session: ${pruner?.requests ?? 0}${pruner?.failures ? `, ${pruner.failures} failed` : ""}${pruner?.windowedRuns ? `, ${pruner.windowedRuns} windowed` : ""}`,
					...(pruner?.lastError ? [`last error: ${pruner.lastError}`] : []),
					state.lastStatus ?? "last prune: none",
					`config: ${configPath()}`,
					`key file: ${keyPath()}${keyFileIsLoose() ? " (readable by other users)" : ""}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.on("session_shutdown", () => {
		state.pruner?.clearCache();
		state.pruner = undefined;
		state.apiKey = undefined;
	});
}

/** Config, key resolution and failure-observability tests (no network). */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JevAnswer, JevAsker, JevQuestions, JevResponse, JevState } from "../vendor/fast-jev-compaction/dist/index.js";
import {
	JevPruner,
	configPath,
	keyFileIsLoose,
	keyPath,
	loadConfig,
	prunerOptions,
	resolveApiKey,
	type PiMessage,
	type PruneOptions,
} from "../index.ts";

const dir = mkdtempSync(join(tmpdir(), "fast-jev-test-"));
const ENV_KEYS = ["FAST_JEV_API_KEY", "JEV_API_KEY", "TYPESAFE_API_KEY", "FAST_JEV_CONFIG", "FAST_JEV_KEY_FILE", "FAST_JEV_MIN_NEW_CALLS", "FAST_JEV_ENABLED", "FAST_JEV_TRIGGER_FRACTION"];

function withEnv(values: Record<string, string | undefined>, body: () => void): void {
	const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
	try {
		for (const key of ENV_KEYS) delete process.env[key];
		for (const [key, value] of Object.entries(values)) {
			if (value !== undefined) process.env[key] = value;
		}
		body();
	} finally {
		for (const key of ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

class FailingAsker implements JevAsker {
	async ask(_state: JevState, _questions: JevQuestions): Promise<JevResponse> {
		throw new Error("HTTP 401: invalid key");
	}
}

/** Answers every question from a plan (`"*"` is the fallback), without touching the network. */
class PlanAsker implements JevAsker {
	#plan: Record<string, number>;

	constructor(plan: Record<string, number> = {}) {
		this.#plan = plan;
	}

	async ask(_state: JevState, questions: JevQuestions): Promise<JevResponse> {
		const answers: Record<string, JevAnswer> = {};
		for (const name of Object.keys(questions)) {
			answers[name] = { type: "noul", noul: this.#plan[name] ?? this.#plan["*"] ?? 1 };
		}
		return { answers };
	}
}

test("loadConfig merges the file over the defaults", () => {
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify({ minNewCalls: 9, triggerFraction: 0.25, keepThreshold: 0.7 }));
	withEnv({}, () => {
		const config = loadConfig(path);
		assert.equal(config.minNewCalls, 9);
		assert.equal(config.triggerFraction, 0.25);
		assert.equal(config.keepThreshold, 0.7);
		assert.equal(config.minIntervalMs, 5_000, "untouched keys keep their default");
		assert.equal(config.enabled, true);
	});
});

test("environment variables beat the config file", () => {
	const path = join(dir, "config-env.json");
	writeFileSync(path, JSON.stringify({ minNewCalls: 9, enabled: false }));
	withEnv({ FAST_JEV_MIN_NEW_CALLS: "3", FAST_JEV_ENABLED: "0" }, () => {
		const config = loadConfig(path);
		assert.equal(config.minNewCalls, 3);
		assert.equal(config.enabled, false);
	});
});

test("a missing or invalid config file falls back to defaults", () => {
	withEnv({}, () => {
		assert.equal(loadConfig(join(dir, "nope.json")).minNewCalls, 2);
		const broken = join(dir, "broken.json");
		writeFileSync(broken, "{ not json");
		assert.equal(loadConfig(broken).minNewCalls, 2);
	});
});

test("config and key paths are overridable through the environment", () => {
	withEnv({ FAST_JEV_CONFIG: "/x/c.json", FAST_JEV_KEY_FILE: "/x/k" }, () => {
		assert.equal(configPath(), "/x/c.json");
		assert.equal(keyPath(), "/x/k");
	});
});

test("resolveApiKey follows its documented precedence", () => {
	const path = join(dir, "key");
	writeFileSync(path, "  from-file\n");
	withEnv({}, () => {
		assert.equal(resolveApiKey({ apiKey: "from-config" } as never, path), "from-config");
		assert.equal(resolveApiKey({} as never, path), "from-file", "file value is trimmed");
		assert.equal(resolveApiKey({} as never, join(dir, "missing")), undefined);
	});
	withEnv({ TYPESAFE_API_KEY: "typesafe" }, () => {
		assert.equal(resolveApiKey({ apiKey: "from-config" } as never, path), "typesafe");
	});
	withEnv({ TYPESAFE_API_KEY: "typesafe", JEV_API_KEY: "jev" }, () => {
		assert.equal(resolveApiKey({} as never, path), "jev");
	});
	withEnv({ JEV_API_KEY: "jev", FAST_JEV_API_KEY: "fast" }, () => {
		assert.equal(resolveApiKey({} as never, path), "fast");
	});
	withEnv({ FAST_JEV_API_KEY: "   " }, () => {
		assert.equal(resolveApiKey({ apiKey: "from-config" } as never, path), "from-config", "blank wins nothing");
	});
});

test("loose key-file permissions are detected where the platform has them", () => {
	const path = join(dir, "loose-key");
	writeFileSync(path, "k");
	chmodSync(path, 0o644);
	if (process.platform === "win32") {
		assert.equal(keyFileIsLoose(path), false);
		return;
	}
	assert.equal(keyFileIsLoose(path), true);
	chmodSync(path, 0o600);
	assert.equal(keyFileIsLoose(path), false);
	assert.equal(keyFileIsLoose(join(dir, "missing-key")), false);
});

/**
 * The config file is read by `loadConfig`, but the pruner only sees what `prunerOptions` hands
 * over. A key dropped on that short path used to be invisible: the values silently fell back to
 * the pruner defaults while `/jev-compaction` printed the configured ones.
 */
test("every config key the pruner reads reaches it", () => {
	const path = join(dir, "pruner-options.json");
	writeFileSync(
		path,
		JSON.stringify({
			minPendingChars: 1234,
			minCallsBetweenPrunes: 7,
			fallbackWindowMessages: 33,
			requestConcurrency: 2,
			stateResultHeadChars: 111,
			readOnlyTools: ["ffgrep"],
			detectReadOnlyCommands: false,
			abridgeArgumentChars: 222,
		}),
	);
	withEnv({}, () => {
		const options = prunerOptions(loadConfig(path));
		assert.equal(options.minPendingChars, 1234);
		assert.equal(options.minCallsBetweenPrunes, 7);
		assert.equal(options.fallbackWindowMessages, 33);
		assert.equal(options.requestConcurrency, 2);
		assert.equal(options.stateResultHeadChars, 111);
		assert.deepEqual(options.readOnlyTools, ["ffgrep"]);
		assert.equal(options.detectReadOnlyCommands, false);
		assert.equal(options.abridgeArgumentChars, 222);
	});
});

test("a tool the config lists as read-only is dropped whole, not downgraded", async () => {
	const path = join(dir, "read-only-tools.json");
	writeFileSync(
		path,
		JSON.stringify({
			readOnlyTools: ["ffgrep"],
			preserveRecentMessages: 0,
			minNewCalls: 1,
			minIntervalMs: 0,
			minPendingChars: 0,
		}),
	);
	const messages: PiMessage[] = [
		{ role: "user", content: "find the callers" },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "ffgrep", arguments: { pattern: "prunerOptions" } }],
		},
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "ffgrep",
			content: [{ type: "text", text: "index.ts:1259: prunerOptions".repeat(200) }],
			isError: false,
		},
		{ role: "user", content: "go on" },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	];
	let options: PruneOptions = {};
	withEnv({}, () => {
		options = prunerOptions(loadConfig(path));
	});
	const pruner = new JevPruner(new PlanAsker({ "*": 0.1 }), options);
	const outcome = await pruner.prune(messages, { allowNetwork: true });
	assert.ok(outcome);
	assert.equal(outcome.decisions.length, 1);
	assert.equal(outcome.decisions[0].action, "drop_call", "a configured read-only tool may be removed");
	assert.equal(outcome.decisions[0].downgraded, undefined, "not downgraded to drop_result");
	assert.equal(outcome.stats.callsDropped, 1);
});

test("failures are counted and reported instead of being swallowed", async () => {
	const messages: PiMessage[] = [
		{ role: "user", content: "fix it" },
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] },
		{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "x" }], isError: false },
		{ role: "user", content: "go" },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	];
	const pruner = new JevPruner(new FailingAsker(), {
		preserveRecentMessages: 1,
		minNewCalls: 1,
		minIntervalMs: 0,
		minPendingChars: 0,
	});
	const outcome = await pruner.prune(messages, { allowNetwork: true });
	assert.equal(outcome, null, "history stays verbatim");
	assert.equal(pruner.failures, 1);
	assert.match(pruner.lastError ?? "", /401/);
	await pruner.prune(messages, { allowNetwork: true });
	assert.equal(pruner.failures, 2, "every attempt is counted");
});

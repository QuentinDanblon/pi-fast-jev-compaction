/** Config, key resolution and failure-observability tests (no network). */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JevAsker, JevQuestions, JevResponse, JevState } from "../vendor/fast-jev-compaction/dist/index.js";
import { JevPruner, configPath, keyFileIsLoose, keyPath, loadConfig, resolveApiKey, type PiMessage } from "../index.ts";

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

/**
 * Behaviour tests for the pi port of fast-jev-compaction.
 * Run: node --import <jiti>/lib/jiti-register.mjs --test test/pruner.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	JevAnswer,
	JevAsker,
	JevQuestions,
	JevResponse,
	JevState,
} from "../vendor/fast-jev-compaction/dist/index.js";
import { JevPruner, toJevMessages, type PiMessage, type PruneOptions, type PruneOutcome } from "../index.ts";

type AnyMessage = PiMessage;

class FakeAsker implements JevAsker {
	calls = 0;
	states: unknown[] = [];
	#plan: Record<string, number>;
	#fail: boolean;

	constructor(plan: Record<string, number> = {}, fail = false) {
		this.#plan = plan;
		this.#fail = fail;
	}

	async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
		this.calls += 1;
		this.states.push(state);
		if (this.#fail) throw new Error("jev unavailable");
		const answers: Record<string, JevAnswer> = {};
		for (const name of Object.keys(questions)) {
			answers[name] = { type: "noul", noul: this.#plan[name] ?? this.#plan["*"] ?? 1 };
		}
		return { answers };
	}
}

const BIG_RESULT = "x".repeat(4000);

function transcript(): AnyMessage[] {
	return [
		{ role: "user", content: "Fix the failing test. Never edit src/generated." },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "src/a.ts" } }],
		},
		{ role: "toolResult", toolCallId: "call_a", toolName: "read", content: [{ type: "text", text: BIG_RESULT }], isError: false },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call_b", name: "bash", arguments: { command: "npm test" } }],
		},
		{ role: "toolResult", toolCallId: "call_b", toolName: "bash", content: [{ type: "text", text: "3 tests failed" }], isError: true },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "checking the generated file" },
				{ type: "toolCall", id: "call_c", name: "read", arguments: { path: "src/generated.ts" } },
			],
		},
		{ role: "toolResult", toolCallId: "call_c", toolName: "read", content: [{ type: "text", text: "generated" }], isError: false },
		{ role: "user", content: "keep going" },
		{ role: "assistant", content: [{ type: "text", text: "done" }] },
	];
}

function pruner(asker: JevAsker, overrides: PruneOptions = {}): JevPruner {
	return new JevPruner(asker, {
		preserveRecentMessages: 2,
		minNewCalls: 1,
		minIntervalMs: 0,
		minPendingChars: 0,
		...overrides,
	});
}

test("pi messages map 1:1 onto the library transcript shape", () => {
	const mapped = toJevMessages(transcript());
	assert.equal(mapped.length, 9);
	assert.deepEqual(mapped[1].toolUses, [
		{ tool_use_id: "call_a", tool: "read", input: { path: "src/a.ts" } },
	]);
	assert.equal(mapped[2].role, "user");
	assert.equal(mapped[2].toolResults?.[0].tool_use_id, "call_a");
	assert.equal(mapped[2].toolResults?.[0].text.length, 4000);
	assert.equal(mapped[2].toolResults?.[0].isError, false);
	assert.equal(mapped[4].toolResults?.[0].isError, true);
	assert.equal(mapped[5].text, "checking the generated file");
	assert.equal(mapped[5].toolUses[0].tool_use_id, "call_c");
	assert.equal(mapped[0].text, "Fix the failing test. Never edit src/generated.");
});

test("drop_result truncates, drop_call removes the pair, keep is untouched", async () => {
	const asker = new FakeAsker({
		call_t1: 1,
		result_t1: 0,
		call_t2: 0,
		result_t2: 0,
		call_t3: 1,
		result_t3: 1,
	});
	const outcome = await pruner(asker).prune(transcript());
	assert.ok(outcome, "expected a rewrite");
	const messages = (outcome as PruneOutcome).messages;

	assert.equal(asker.calls, 1, "one batched request");
	assert.equal(messages.length, 8, "call_b's result message is gone");
	assert.equal(outcome.stats.callsDropped, 1);
	assert.equal(outcome.stats.resultsDropped, 1);
	assert.equal(outcome.stats.kept, 1);

	// call_a kept, result truncated with a note.
	assert.deepEqual(messages[1], transcript()[1]);
	const truncated = (messages[2].content as { text: string }[])[0].text;
	assert.ok(truncated.startsWith(BIG_RESULT.slice(0, 300)), "keeps the head verbatim");
	assert.match(truncated, /fast-jev-compaction truncated 3700 chars/);

	// call_b dropped: call block removed, empties out to a placeholder.
	assert.deepEqual(messages[3].content, [{ type: "text", text: "[fast-jev-compaction removed stale tool call(s)]" }]);
	assert.equal(messages[3].stopReason, undefined);

	// call_c kept whole, including its text part.
	assert.deepEqual(messages[4], transcript()[5]);
	assert.deepEqual(messages[5], transcript()[6]);

	// User and assistant text are always verbatim.
	assert.deepEqual(messages[0], transcript()[0]);
	assert.deepEqual(messages[6], transcript()[7]);
	assert.deepEqual(messages[7], transcript()[8]);
});

test("decisions are cached: a second request asks Jev nothing", async () => {
	const asker = new FakeAsker({ call_t1: 1, result_t1: 0, call_t2: 0, result_t2: 0, call_t3: 1, result_t3: 1 });
	const instance = pruner(asker, { minIntervalMs: 0 });
	const first = await instance.prune(transcript());
	const second = await instance.prune(transcript());
	assert.equal(asker.calls, 1);
	assert.equal(instance.requests, 1);
	assert.equal(instance.cacheSize, 3);
	assert.ok(first && second);
	assert.deepEqual(second.messages, first.messages);
});

test("network failures leave the history verbatim", async () => {
	const asker = new FakeAsker({}, true);
	const outcome = await pruner(asker).prune(transcript());
	assert.equal(asker.calls, 1);
	assert.equal(outcome, null, "no rewrite when nothing was scored");
});

test("the interval gate keeps cached pruning but defers new scoring", async () => {
	const asker = new FakeAsker({ call_t1: 1, result_t1: 0, call_t2: 0, result_t2: 0, call_t3: 1, result_t3: 1 });
	const instance = pruner(asker, { minIntervalMs: 60_000 });
	const first = await instance.prune(transcript());
	assert.ok(first);
	assert.equal(asker.calls, 1);

	// A new candidate tool call appears while the interval has not elapsed.
	const extended = [
		...transcript(),
		{ role: "assistant", content: [{ type: "toolCall", id: "call_d", name: "read", arguments: { path: "src/d.ts" } }] },
		{ role: "toolResult", toolCallId: "call_d", toolName: "read", content: [{ type: "text", text: "d" }], isError: false },
		{ role: "user", content: "more" },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	];
	const second = await instance.prune(extended);
	assert.equal(asker.calls, 1, "no new request inside the interval");
	assert.ok(second, "cached decisions still applied");
	assert.equal(second.stats.callsDropped, 1);

	// urgent: bypasses both gates.
	const third = await instance.prune(extended, { allowNetwork: true, urgent: true });
	assert.equal(asker.calls, 2);
	assert.ok(third);
});

test("already-unpaired tool calls do not block pruning", async () => {
	const asker = new FakeAsker({ call_t1: 1, result_t1: 0, call_t2: 0, result_t2: 0, call_t3: 1, result_t3: 1 });
	const withPending: AnyMessage[] = [
		...transcript(),
		{ role: "assistant", content: [{ type: "toolCall", id: "call_pending", name: "bash", arguments: {} }] },
	];
	const outcome = await pruner(asker).prune(withPending);
	assert.ok(outcome, "a pending call without a result is not a candidate");
	assert.equal(outcome.messages.length, withPending.length - 1);
});

test("oldest message and newest messages are pinned", async () => {
	const asker = new FakeAsker({ call_t2: 0, result_t2: 0 });
	const messages: AnyMessage[] = [
		{ role: "assistant", content: [{ type: "toolCall", id: "call_old", name: "read", arguments: {} }] },
		{ role: "toolResult", toolCallId: "call_old", toolName: "read", content: [{ type: "text", text: "old" }], isError: false },
		{ role: "assistant", content: [{ type: "toolCall", id: "call_mid", name: "bash", arguments: { command: "ls" } }] },
		{ role: "toolResult", toolCallId: "call_mid", toolName: "bash", content: [{ type: "text", text: "mid" }], isError: false },
		{ role: "user", content: "recent" },
		{ role: "assistant", content: [{ type: "text", text: "recent reply" }] },
	];
	const outcome = await pruner(asker).prune(messages);
	assert.ok(outcome);
	assert.equal(outcome.stats.pinned, 1, "only the oldest call is pinned");
	assert.equal(asker.calls, 1);
	assert.deepEqual(outcome.messages[0], messages[0], "pinned call kept verbatim");
	assert.deepEqual(outcome.messages[1], messages[1], "pinned result kept verbatim");
	assert.deepEqual(outcome.messages[2].content, [
		{ type: "text", text: "[fast-jev-compaction removed stale tool call(s)]" },
	]);
	assert.equal(outcome.messages.length, 5, "the dropped pair's result is gone");
});

test("a request is only spent when the pending results are worth it", async () => {
	const asker = new FakeAsker({ call_t1: 0, result_t1: 0, call_t2: 0, result_t2: 0, call_t3: 0, result_t3: 0 });
	const instance = pruner(asker, { minPendingChars: 10_000 }); // results are tiny here
	const outcome = await instance.prune(transcript(), { allowNetwork: true });
	assert.equal(asker.calls, 0, "a few hundred chars are not worth a full-state request");
	assert.equal(outcome, null);

	const urgentAsker = new FakeAsker({ call_t1: 1, result_t1: 0 });
	const urgent = await pruner(urgentAsker, { minPendingChars: 10_000 }).prune(transcript(), {
		allowNetwork: true,
		urgent: true,
	});
	assert.equal(urgentAsker.calls, 1, "urgency bypasses the worth-it gate");
	assert.ok(urgent);
});

test("a history too large for the full state falls back to a window", async () => {
	const pairs = 300;
	const messages: AnyMessage[] = [{ role: "user", content: "refactor the parser" }];
	for (let index = 0; index < pairs; index += 1) {
		messages.push(
			{
				role: "assistant",
				content: [
					{ type: "text", text: `step ${index}: inspecting the parser` },
					{ type: "toolCall", id: `call_${index}`, name: "read", arguments: { path: `src/module_${index}.ts` } },
				],
			},
			{
				role: "toolResult",
				toolCallId: `call_${index}`,
				toolName: "read",
				content: [{ type: "text", text: `result ${index} `.repeat(40) }],
				isError: false,
			},
		);
	}
	messages.push({ role: "user", content: "status?" }, { role: "assistant", content: [{ type: "text", text: "done" }] });

	// Deliberately below the fitting floor (~17k tokens for 300 calls).
	// "*" drops everything, so the assertion does not depend on positional ids
	// (the windowed run numbers its calls differently from the full history).
	const asker = new FakeAsker({ "*": 0 });
	const instance = new JevPruner(asker, {
		preserveRecentMessages: 2,
		minNewCalls: 1,
		minIntervalMs: 0,
		minPendingChars: 0,
		maxStateTokens: 5_000,
		maxRequestTokens: 8_000,
		fallbackWindowMessages: 120,
	});
	const outcome = await instance.prune(messages, { allowNetwork: true, urgent: true });
	assert.ok(outcome, "pruning must survive an unfittable full history");
	assert.equal(outcome.stats.windowed, true);
	assert.ok(asker.calls >= 1);
	assert.equal(outcome.decisions.length, pairs, "every call still gets a decision");
	assert.ok(outcome.messages.length < messages.length, "the windowed run still pruned");
	assert.equal(instance.failures, 0, "the window fallback is not a failure");
	assert.equal(instance.windowedRuns, 1, "the windowed run is counted and reported");
});

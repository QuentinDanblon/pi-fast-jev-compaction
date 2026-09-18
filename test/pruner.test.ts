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
import { JevPruner, cacheAlreadyCold, isReadOnlyCommand, toJevMessages, type PiMessage, type PruneOptions, type PruneOutcome } from "../index.ts";

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
			content: [{ type: "toolCall", id: "call_b", name: "grep", arguments: { pattern: "test" } }],
		},
		{ role: "toolResult", toolCallId: "call_b", toolName: "grep", content: [{ type: "text", text: "3 tests failed" }], isError: true },
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
		{ role: "assistant", content: [{ type: "toolCall", id: "call_mid", name: "grep", arguments: { pattern: "x" } }] },
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

test("read-only shell detection is conservative", () => {
	for (const command of [
		"ls -la",
		"cat src/a.ts",
		"git status",
		"git diff --stat",
		"git log -1 --oneline",
		"git rev-parse HEAD",
		"rg -n foo src",
		"npm ls",
		"pnpm view react version",
		"FOO=1 ls -l",
		"cat src/a.ts | head -20",
		"cd /tmp && git status",
		"wc -l src/*.ts",
	]) {
		assert.equal(isReadOnlyCommand(command), true, `expected read-only: ${command}`);
	}
	for (const command of [
		"npm test",
		"npm install left-pad",
		"pnpm db:migrate",
		"git push",
		"git commit -m wip",
		"git branch feature",
		"git tag v1",
		"git remote add origin x",
		"rm -rf dist",
		"cat a > b",
		"echo hi >> log",
		"sed -i s/a/b/ src/a.ts",
		"echo $(date)",
		"ls `pwd`",
		"node script.js",
		"python -c print(1)",
		"npx prisma migrate deploy",
		"tsc --noEmit",
		"cat a | tee b",
		"ls &",
		"cat a; rm -rf b",
	]) {
		assert.equal(isReadOnlyCommand(command), false, `expected NOT read-only: ${command}`);
	}
});

test("long arguments of a kept call are abridged, not dropped", async () => {
	const content = "export const generated = [\n" + "  'line',\n".repeat(400) + "];\n";
	const messages: AnyMessage[] = [
		{ role: "user", content: "write the file" },
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "w1", name: "write", arguments: { path: "src/gen.ts", content } },
			],
		},
		{ role: "toolResult", toolCallId: "w1", toolName: "write", content: [{ type: "text", text: "wrote 400 lines\n" + "x".repeat(3000) }], isError: false },
		{ role: "user", content: "next" },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	];
	const outcome = await pruner(new FakeAsker({ call_t1: 0, result_t1: 0 })).prune(messages);
	assert.ok(outcome);
	assert.equal(outcome.decisions[0].action, "drop_result");
	assert.equal(outcome.stats.abridgedArgs, 1);
	const parts = outcome.messages[1].content as { type: string; arguments: { path: string; content: string } }[];
	assert.equal(parts.length, 1, "the call survives");
	assert.equal(parts[0].arguments.path, "src/gen.ts", "short arguments are untouched");
	assert.ok(parts[0].arguments.content.length < 700, "the 8 KB body is abridged");
	assert.match(parts[0].arguments.content, /abridged \d+ characters of this argument; the call already ran/);
	assert.ok(parts[0].arguments.content.startsWith("export const generated = ["), "the head stays verbatim");

	// Argument abridging is off by default when the limit is 0, and never touches a
	// message that carries a signed thinking block.
	const off = await pruner(new FakeAsker({ call_t1: 0, result_t1: 0 }), { abridgeArgumentChars: 0 }).prune(messages);
	assert.ok(off);
	assert.equal(off.stats.abridgedArgs, 0);

	const withThinking: AnyMessage[] = JSON.parse(JSON.stringify(messages)) as AnyMessage[];
	(withThinking[1].content as unknown as { type: string; thinking?: string; signature?: string }[]).unshift({
		type: "thinking",
		thinking: "writing the file",
		signature: "sig",
	});
	const locked = await pruner(new FakeAsker({ call_t1: 0, result_t1: 0 })).prune(withThinking);
	assert.ok(locked);
	assert.equal(locked.stats.abridgedArgs, 0, "a thinking-bearing message is left alone");
	assert.deepEqual(locked.messages[1], withThinking[1]);
});

test("a read-only shell command is dropped whole, a mutating one is not", async () => {
	const shell = (command: string): AnyMessage[] => [
		{ role: "user", content: "go" },
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command } }] },
		{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "x".repeat(4000) }], isError: false },
		{ role: "user", content: "next" },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	];
	const plan = { call_t1: 0, result_t1: 0 };

	const readOnly = await pruner(new FakeAsker(plan)).prune(shell("git diff --stat"));
	assert.ok(readOnly);
	assert.equal(readOnly.decisions[0].action, "drop_call");
	assert.equal(readOnly.stats.callsDropped, 1);
	assert.equal(readOnly.messages.length, 4, "call and result both go");

	const mutating = await pruner(new FakeAsker(plan)).prune(shell("pnpm db:migrate && pnpm seed"));
	assert.ok(mutating);
	assert.equal(mutating.decisions[0].action, "drop_result");
	assert.equal(mutating.decisions[0].downgraded, "mutating-tool");
	assert.equal(mutating.messages.length, 5, "the call and its input stay");

	const disabled = await pruner(new FakeAsker(plan), { detectReadOnlyCommands: false }).prune(shell("git diff --stat"));
	assert.ok(disabled);
	assert.equal(disabled.decisions[0].action, "drop_result", "the heuristic can be turned off");
});

test("a mutating tool keeps its call: only the result is truncated", async () => {
	const asker = new FakeAsker({ call_t1: 0, result_t1: 0 });
	const messages: AnyMessage[] = [
		{ role: "user", content: "run the migration" },
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "pnpm db:migrate" } }] },
		{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "applied 12 migrations".repeat(40) }], isError: false },
		{ role: "user", content: "next" },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	];
	const outcome = await pruner(asker).prune(messages);
	assert.ok(outcome);
	assert.equal(outcome.decisions[0].action, "drop_result", "bash is never removed outright");
	assert.equal(outcome.decisions[0].downgraded, "mutating-tool");
	assert.equal(outcome.stats.callsDropped, 0);
	assert.equal(outcome.stats.downgraded, 1);
	assert.deepEqual(outcome.messages[1], messages[1], "the call and its arguments stay");
	assert.match((outcome.messages[2].content as { text: string }[])[0].text, /fast-jev-compaction truncated/);
	assert.equal(outcome.messages.length, messages.length, "nothing is dropped");
});

test("a signed thinking block keeps its tool call intact", async () => {
	const asker = new FakeAsker({ call_t1: 0, result_t1: 0 });
	const messages: AnyMessage[] = [
		{ role: "user", content: "read the file" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "I should read src/a.ts before editing.", signature: "sig-abc" },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } },
			],
		},
		{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "export const a = 1;".repeat(60) }], isError: false },
		{ role: "user", content: "next" },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	];
	const outcome = await pruner(asker).prune(messages);
	assert.ok(outcome);
	assert.equal(outcome.decisions[0].action, "drop_result");
	assert.equal(outcome.decisions[0].downgraded, "signed-thinking");
	const parts = outcome.messages[1].content as { type: string; signature?: string }[];
	assert.equal(parts.length, 2, "thinking and its tool call both survive");
	assert.equal(parts[0].signature, "sig-abc", "the thinking block is untouched");
});

test("Jev is shown the head of each result it is judging", async () => {
	const asker = new FakeAsker({ call_t1: 1, result_t1: 1 });
	const seen: string[] = [];
	const recording: JevAsker = {
		ask: async (state, questions) => {
			seen.push(JSON.stringify(questions));
			return asker.ask(state, questions);
		},
	};
	const messages: AnyMessage[] = [
		{ role: "user", content: "debug it" },
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "node --test" } }] },
		{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: `TYPEERROR at line 42: cannot read property 'x' of undefined\n${"k".repeat(4000)}` }], isError: true },
		{ role: "user", content: "next" },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	];
	await new JevPruner(recording, { preserveRecentMessages: 2, minNewCalls: 1, minIntervalMs: 0, minPendingChars: 0 }).prune(messages);
	assert.equal(seen.length, 1);
	assert.match(seen[0], /Its output begins: TYPEERROR at line 42/, "the error text reaches the question");
	assert.match(seen[0], /… \(4060 characters in total\)/, "the head says how much was left out");
	assert.doesNotMatch(seen[0], /k{301,}/, "only a bounded head is sent");

	// stateResultHeadChars: 0 restores upstream behaviour (length only).
	const off: string[] = [];
	const recordingOff: JevAsker = { ask: async (state, questions) => { off.push(JSON.stringify(questions)); return asker.ask(state, questions); } };
	await new JevPruner(recordingOff, { preserveRecentMessages: 2, minNewCalls: 1, minIntervalMs: 0, minPendingChars: 0, stateResultHeadChars: 0 }).prune(messages);
	assert.doesNotMatch(off[0], /Its output begins/);
});

test("the cache gate tunes itself from the share a prune actually frees", async () => {
	const fresh = pruner(new FakeAsker({}));
	assert.equal(fresh.requiredCallsBetweenPrunes, 60, "nothing measured yet: assume 15% freed");

	// A prune that frees almost nothing must buy a long gap before the next one.
	// Here the prompt is dominated by unmovable text: the only movable mass is one result.
	const thin = pruner(new FakeAsker({ result_t1: 0 }));
	const small = await thin.prune([
		{ role: "user", content: "x".repeat(20_000) },
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] },
		{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "y".repeat(1000) }], isError: false },
		{ role: "user", content: "next" },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	]);
	assert.ok(small, "the small result is still truncated");
	assert.ok(thin.freedFraction < 0.05, `freed ${thin.freedFraction}`);
	assert.ok(
		thin.requiredCallsBetweenPrunes >= 180,
		`expected a long gap, got ${thin.requiredCallsBetweenPrunes}`,
	);

	// A prune that frees half the prompt may repeat as soon as the floor allows.
	const fat = pruner(new FakeAsker({ "*": 0 }));
	const big = await fat.prune(transcript());
	assert.ok(big);
	assert.ok(fat.freedFraction > 0.4, `freed ${fat.freedFraction}`);
	assert.ok(fat.requiredCallsBetweenPrunes <= 25, `expected a short gap, got ${fat.requiredCallsBetweenPrunes}`);
});

test("decisions survive a reload: they can be drained and restored", async () => {
	const messages = transcript();
	const asker = new FakeAsker({ call_t1: 0, result_t1: 0, call_t2: 0, result_t2: 0, call_t3: 1, result_t3: 1 });
	const first = pruner(asker);
	const outcome = await first.prune(messages, { allowNetwork: true });
	assert.ok(outcome);
	const persisted = first.takeNewDecisions();
	assert.equal(Object.keys(persisted).length, 3, "one entry per scored call");
	assert.deepEqual(first.takeNewDecisions(), {}, "draining is a one-shot");

	// A fresh pruner (what a /reload builds) with the same session must not ask again.
	const reloaded = pruner(new FakeAsker({}));
	assert.equal(reloaded.restoreDecisions([persisted]), 3);
	const again = await reloaded.prune(messages, { allowNetwork: true });
	assert.ok(again, "the restored decisions are applied straight away");
	assert.equal(reloaded.requests, 0, "nothing is asked again after a reload");
	assert.deepEqual(again.messages, outcome.messages, "and the view is identical");

	// A reset marker (what /jev-compaction clear appends) discards everything restored.
	const cleared = pruner(new FakeAsker({}));
	cleared.restoreDecisions([persisted, { reset: true } as never]);
	assert.equal(cleared.cacheSize, 0);
});

test("background scoring never blocks the caller", async () => {
	const asker = new FakeAsker({ call_t1: 1, result_t1: 0 });
	const instance = pruner(asker);
	const messages = transcript();

	// First call: Jev is asked in the background, so this call cannot apply the answer yet.
	const immediate = await instance.prune(messages, { allowNetwork: true, deferNetwork: true });
	assert.equal(immediate, null, "no decision is applied on the call that asks");

	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(instance.isScoring, false, "the background round is done");
	assert.equal(Object.keys(instance.takeNewDecisions()).length, 3, "it committed every answer");

	// Next call: the cached decisions apply, and the background request is reported once.
	const later = await instance.prune(messages, { allowNetwork: false });
	assert.ok(later);
	assert.equal(later.stats.requests, 1, "the background request is reported on the next call");
	assert.equal(later.stats.resultsDropped, 1);
});

test("a request whose prompt was already uncached is a free moment to prune", () => {
	const withUsage = (usage: Record<string, number>): PiMessage[] => [
		{ role: "assistant", content: [{ type: "text", text: "hi" }], usage } as unknown as PiMessage,
	];
	assert.equal(cacheAlreadyCold(withUsage({ input: 500, cacheRead: 100, cacheWrite: 0 })), true);
	assert.equal(cacheAlreadyCold(withUsage({ input: 10, cacheRead: 990, cacheWrite: 0 })), false);
	assert.equal(cacheAlreadyCold(withUsage({ input: 0, cacheRead: 0, cacheWrite: 0 })), false);
	assert.equal(cacheAlreadyCold([{ role: "assistant", content: [{ type: "text", text: "no usage" }] }]), false);
	assert.equal(cacheAlreadyCold([]), false);
});

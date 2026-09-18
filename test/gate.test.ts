/**
 * Tests for the gate that decides whether a Jev request is worth spending.
 * These are the rules the whole cost model rests on, so they are pinned down.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldAskJev, type AskGate } from "../index.ts";

function gate(overrides: Partial<AskGate> = {}): AskGate {
	return {
		usedTokens: 600_000,
		contextWindow: 1_000_000,
		triggerFraction: 0.5,
		urgentFraction: 0.85,
		callsSincePrune: 999,
		economicGap: 80,
		floorGap: 20,
		cacheCold: false,
		...overrides,
	};
}

test("nothing is spent below the size trigger", () => {
	const decision = shouldAskJev(gate({ usedTokens: 499_999 }));
	assert.equal(decision.ask, false);
	assert.equal(decision.reason, "below-trigger");
});

test("the economic gap is what stops chatter above the trigger", () => {
	assert.equal(shouldAskJev(gate({ callsSincePrune: 79 })).ask, false);
	assert.equal(shouldAskJev(gate({ callsSincePrune: 79 })).reason, "too-early");
	assert.equal(shouldAskJev(gate({ callsSincePrune: 80 })).ask, true);
});

test("urgency bypasses the economic gap but never the floor", () => {
	const urgent = { usedTokens: 900_000 };
	assert.equal(shouldAskJev(gate({ ...urgent, callsSincePrune: 19 })).ask, false, "floor respected");
	assert.equal(shouldAskJev(gate({ ...urgent, callsSincePrune: 20 })).ask, true);
	assert.equal(shouldAskJev(gate({ ...urgent, callsSincePrune: 20 })).reason, "urgent");
	// A long session with a small floor must not turn urgency into one request per call.
	assert.equal(
		shouldAskJev(gate({ ...urgent, callsSincePrune: 1, floorGap: 20 })).ask,
		false,
		"no per-call amplification",
	);
});

test("an already-cold cache makes a prune free, whatever the gap", () => {
	const decision = shouldAskJev(gate({ callsSincePrune: 1, cacheCold: true }));
	assert.equal(decision.ask, true);
	assert.equal(decision.reason, "cache-cold");
	assert.equal(shouldAskJev(gate({ callsSincePrune: 1, cacheCold: true, usedTokens: 10 })).ask, false, "still size-gated");
});

test("an unknown context window disables everything", () => {
	const decision = shouldAskJev(gate({ contextWindow: 0, callsSincePrune: 10_000 }));
	assert.equal(decision.ask, false);
	assert.equal(decision.reason, "no-window");
});

test("urgency can be turned off", () => {
	const decision = shouldAskJev(gate({ usedTokens: 990_000, callsSincePrune: 25, urgentFraction: 0 }));
	assert.equal(decision.urgent, false);
	assert.equal(decision.ask, false, "only the economic gap applies then");
});

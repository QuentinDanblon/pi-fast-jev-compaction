# pi-fast-jev-compaction

Verbatim context pruning for the [pi coding agent](https://github.com/earendil-works/pi-mono),
scored by [TypeSafe Jev](https://api.typesafe.ai) (System One).
Port of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction), MIT.

Most context compaction asks a model to **summarize** old turns, and a summary is lossy: a
file path, an exact error or a constraint can disappear. This extension never rewrites
anything. It asks Jev, over the whole conversation, whether each old **tool call** and each
old **tool result** is still needed, then drops or truncates only those. Text, thinking,
images and custom messages are passed through verbatim and in order, and the session file
on disk is never touched — the pruning is a per-request view.

| Jev decision | Effect on the outgoing request |
| --- | --- |
| `keepResult ≥ keepThreshold` | call and result stay verbatim |
| `keepCall ≥ keepThreshold` | call stays, result is truncated to `truncateHeadChars` + a one-line note |
| otherwise | call and result are removed together |

If anything is uncertain — a Jev error, a malformed answer, a state that cannot be fitted,
a tool-call/result pairing that would break the provider — the unmodified messages are sent.

## Measured gain

`tools/simulate-session.ts` replays a session the way pi drives it — one LLM call per assistant
message, the same gate as the `context` hook, real Jev answers — and prices both effects: the
tokens a prune removes from every later call, and one prompt rewrite per prune that changes the
prefix (a cache write costs `ratio` × a cache read, `ratio` = 10 by default). Runs use frozen
snapshots of the session files so they are comparable, and an optional decision cache so an
experiment can be re-run almost for free.

Two real sessions, default configuration:

| | screenshots 1704×1307 | screenshots 1440×900 |
| --- | --- | --- |
| messages / LLM calls / tool calls | 1187 / 537 / 536 | 1401 / 673 / 672 |
| prompt bill (message payload) | 299 M tok | 350 M tok |
| prunes / prompt invalidations / Jev requests | 20 / 20 / 50 | 13 / 15 / 27 |
| saved | 100.6 M tok | 140.2 M tok |
| cache penalty | 8.5 M tok | 8.0 M tok |
| **net with the default (scoring in the background)** | **+31.8 %** | **+37.7 %** |
| net if scoring blocks the request path | +33.6 % | +40.9 % |
| failures | 0 | 0 |

Both sessions are tool-output-heavy: ~90 % of the payload is tool results, most of it base64
screenshots at ~2500 tokens each — exactly the mass this extension truncates.
`tools/token-model.ts` reads the dimensions out of the PNG/JPEG headers and prices images the way
providers do (longest side capped at 1568 px, ~750 px per token) instead of guessing a flat cost.

What the matrix settled, each row measured on the same snapshot:

| Change | Effect |
| --- | --- |
| `--gap=1` (no cache gate) | net 33.6 % → 31.6 %, Jev requests ×11 (557 vs 50) |
| `--state=8000` (Jev sees less history) | net 33.6 % → **14.0 %** |
| `--trigger=0.85` (valve only, near-full window) | net **+0.5 %** — the penalty eats the saving |
| `--abridge=0` | net 33.6 % → 33.5 % |
| `--head=0` (Jev sees only lengths, as upstream) | identical decisions, 34 vs 50 requests |
| `--background` (score off the request path) | net 33.6 % → 31.8 % |
| `ratio=1` (flat-rate billing) | net 33.6 % → 36.7 % (what the cache penalty costs) |

The latency `--background` removes: 2984 ms inside the hook over the session in blocking mode
(with the experiment cache answering locally) versus 322 ms in background mode. With real network
round-trips — 20 prunes × ~1 s — that is roughly 20 s of added wall-clock per session, which is why
background scoring is the default and the 1.8 point cost is accepted.

Three caveats, stated plainly:

- **`details` are not credited, and that is verified rather than assumed:** pi's Anthropic and
  OpenAI-compatible serializers build tool results from `content`, `isError` and `toolCallId` only,
  so tool-specific metadata never reaches a model or its cache. Dropping it changes no prompt token.
- **Absolute tokens carry large uncertainty.** pi's own reported usage is ~0.65–0.67× this model on
  these image-heavy sessions, and image pricing is a formula, not a measurement. The *ratios* compare
  one basis throughout, so the percentages are the defensible claim, and they say nothing about
  text-heavy sessions — none was available to measure.
- **What cannot be touched at all:** thinking blocks, user text and assistant text. On the measured
  sessions the movable mass is tool results and the abridged arguments of kept calls.

Deleting whole tool calls (upstream's behaviour) would add roughly 10 points more, by removing the
record of `write`, `edit` and shell commands that launch harnesses. This port refuses that by
default: a call is only removed when it is provably re-runnable.

## Install

As a pi package (installs to `~/.pi/agent/git/github.com/QuentinDanblon/pi-fast-jev-compaction`):

```sh
pi install git:github.com/QuentinDanblon/pi-fast-jev-compaction
```

Or clone it straight into the extension directory, which is also nicer if you want to hack on it:

```sh
git clone https://github.com/QuentinDanblon/pi-fast-jev-compaction \
  ~/.pi/agent/extensions/fast-jev-compaction
```

Then restart pi, or run `/reload` in a session.

## API key

The key is read from `FAST_JEV_API_KEY`, `JEV_API_KEY`, `TYPESAFE_API_KEY`, `apiKey` in the
config file, or `~/.pi/agent/fast-jev-key` (override the path with `FAST_JEV_KEY_FILE`). An
empty value never wins. Without a key the extension is a silent no-op.

```sh
( umask 077; printf '%s' 'YOUR_KEY' > ~/.pi/agent/fast-jev-key )
```

If the key file is readable by group or others, the extension says so once at startup
(POSIX only).

## Command

`/jev-compaction` shows whether it is enabled, whether a key was found, the trigger, the
cached decision count, requests, failures and the last error, and whether a windowed state
was needed. `/jev-compaction on|off|clear` toggles it, and `/jev-compaction probe` makes one
live call to verify the key.

The footer shows a one-line summary when a prune happens:
`jev: -7.2k ch, 2+0 dropped, 1 req` (plus `[window]` when the fallback window was used).

## Configuration — `~/.pi/agent/fast-jev-compaction.json`

```json
{
  "enabled": true,
  "triggerFraction": 0.5,
  "minNewCalls": 2,
  "minPendingChars": 2000,
  "minIntervalMs": 5000,
  "minCallsBetweenPrunes": 20,
  "pruneInBackground": true,
  "fallbackWindowMessages": 120,
  "requestConcurrency": 4,
  "stateResultHeadChars": 300,
  "readOnlyTools": ["read", "grep", "find", "ls", "glob"],
  "detectReadOnlyCommands": true,
  "abridgeArgumentChars": 500,
  "keepThreshold": 0.5,
  "preserveRecentMessages": 6,
  "maxStateTokens": 25000,
  "maxRequestTokens": 30000,
  "truncateHeadChars": 300,
  "timeoutMs": 10000,
  "notify": true,
  "model": "jev-latest",
  "baseUrl": "https://api.typesafe.ai/v1/systemone"
}
```

Environment overrides: `FAST_JEV_ENABLED`, `FAST_JEV_TRIGGER_FRACTION`,
`FAST_JEV_MIN_NEW_CALLS`, `FAST_JEV_MIN_INTERVAL_MS`, `FAST_JEV_TIMEOUT_MS`,
`FAST_JEV_MODEL`, `FAST_JEV_BASE_URL`, `FAST_JEV_NOTIFY`, `FAST_JEV_CONFIG` (config path),
`FAST_JEV_KEY_FILE` (key path). Environment variables win over the config file.

## How it works

1. Tool calls are paired with their results by tool-call id. Calls in the first message or in
   the newest `preserveRecentMessages` messages are pinned and never touched.
2. The state sent to Jev is the whole conversation, oldest first, with tool results replaced
   by a short note and the head of the result under judgement appended to its question. It is fitted
   under `maxStateTokens` by progressively truncating inputs, abridging old texts, collapsing old
   messages and reducing old calls to one line each.
3. Each non-pinned call gets two `noul` questions: should the call stay, and should its result
   stay verbatim.
4. Questions are batched so state plus questions stay under `maxRequestTokens`, and batches run
   `requestConcurrency` at a time (the full state is re-sent with each request, as upstream does).
5. With `pruneInBackground` (default) the requests are fired off and the call returns immediately
   with the decisions already known; the new ones land on the next call. The session is never blocked
   on Jev, at the cost of those decisions applying one call later.

Decisions are persisted as they are taken (`pi.appendEntry`) and restored on `session_start`, so a
reload or a resumed session does not re-pay for scores already bought. `/jev-compaction clear`
forgets them, in memory and across reloads.

Cost control — the state is re-sent every request, so a round-trip must be worth it:

- decisions are cached per `(tool call id, input hash, result hash)`: each call is scored once
  per session, not once per turn;
- Jev is only asked above `triggerFraction` of the context window, when at least `minNewCalls`
  new candidates exist, when the pending results are worth at least `minPendingChars`
  characters, and when `minIntervalMs` has passed since the last attempt — an attempt is
  recorded even when it fails, so a broken key costs one timeout per interval instead of one
  per request;
- `minCallsBetweenPrunes` (default 20) is only the **floor** of the cache-cost gate; the real
  gap is computed per prune. Removing an old call rewrites the prompt prefix, so the cached
  suffix becomes a cache **write** instead of a cheap **read** (~10x the price on
  Anthropic/DeepSeek pricing, i.e. 9 extra read-equivalents per rewritten token). A prune that
  frees a share `f` of the prompt only pays for itself after `(write/read − 1) / f` further LLM
  calls, and the pruner measures its own `f` (`freedFraction`) after each prune, keeping the
  best share it has seen (a thin early sample must not lock the gate shut) and bounding the gap
  to 20–200 calls so it is always re-evaluated. Before the first prune it assumes 15 % (60 calls).
  This gate is the single most valuable one: without it, the same net gain costs 11× the requests
  (measured);
- a request whose prompt was **already uncached** (`cacheAlreadyCold`: the last response was
  billed mostly as uncached input, i.e. the provider's cache had already expired or been
  invalidated) is a free moment: the prune then costs no extra cache write and is allowed
  immediately. On a flat-rate or subscription provider that does not bill cache writes
  separately, `minCallsBetweenPrunes` only costs context relief and can be set to 0;
- above 85 % of the window all of that is bypassed (`urgent`), because a full window is worse
  than an invalidation;

### Why `pi.on("context")` and not `session_before_compact`

Pi persists compaction as a summary string plus a contiguous kept tail (`firstKeptEntryId`).
That model can only keep a *suffix* verbatim; it cannot delete individual tool calls or
results inside the summarized range. `pi.on("context")` runs before every LLM call and may
return a modified message list, which is the faithful equivalent of the upstream Claude Code
function hook — and it keeps the persisted history byte-for-byte intact.

## Design notes (the non-obvious contracts)

- **A call is only removed when removing it is provably safe.** Whole calls disappear for
  read-only tools (`readOnlyTools`) and for shell commands that only read (`isReadOnlyCommand`:
  every `|`/`&&`/`;` segment starts with a read-only command, with no redirect, no command
  substitution, no background job, no `-i`). Everything else — `write`, `edit`, a `bash` that
  runs a build, a migration or a WSL/PowerShell harness, any MCP tool — keeps its call: the bulky
  output is truncated and long arguments are abridged, but the record of *what was run* stays.
  This is deliberate: a model that cannot see that it already ran the migration will run it again.
- **Jev sees a head of every result it judges.** Upstream's state replaces each result with
  `n chars (omitted)`, which asks Jev to judge usefulness from a length. The questions this port
  builds (`buildQuestions`) append the first `stateResultHeadChars` characters (300) of the result
  under judgement — never of the whole history, so the state stays small — and batches are priced
  with those heads included (`batchCallsWith`) to stay under Jev's 32k request limit.
- **A message carrying a thinking block is never modified.** Some providers sign reasoning
  payloads; rewriting the message that holds one invalidates it. Such a call is downgraded to a
  result truncation and its arguments are left alone.
- **Pairing is the hard invariant.** Providers reject a tool call without its result (and vice
  versa), so `drop_call` always removes the call *and* the result message, and the result is
  re-checked against the set of ids that were paired in the input. If the check fails the
  original messages are sent unchanged. A call that was already unanswered in the input is left
  alone rather than treated as an error.
- **Decision ids are positional.** The vendored library assigns `t1..tn` in conversation order,
  so decisions are mapped back to tool-call ids before any pi message is touched; the cache,
  the config and the logs are all keyed by the real id.
- **Empty assistant content is never emitted.** Dropping the only tool call of a message inserts
  a one-line placeholder and downgrades `stopReason: "toolUse"` to `"stop"`.
- **The state has a fitting floor.** The upstream fitter can compress a history to one line per
  old call, and that floor is ~17k tokens for 300 calls: past roughly 430 calls in one session
  it can no longer fit `maxStateTokens` and would give up entirely. The pruner then rebuilds the
  state from the newest `fallbackWindowMessages` messages and keeps scoring, matching answers
  back by tool-call id. Calls outside the window stay verbatim. `stats.windowed`, the
  `[window]` status marker and a one-time warning make this visible; `windowedRuns` counts it.
- **A request must be worth its cost.** A round-trip that frees 200 characters costs more than
  it saves, hence `minPendingChars`.
- **Single file on purpose.** pi loads one extension entry point; the heavy lifting lives in the
  vendored library, and `index.ts` is organised in banner-separated sections in dependency order
  (config → asker → adapter → pruner → apply → wiring).

## Vendored library

The upstream README says `npm install fast-jev-compaction`, but **that package is not published**
(404 on the registry), so the library is vendored: `vendor/fast-jev-compaction/` contains the
build output of an unmodified upstream checkout pinned to a commit, with its MIT LICENSE and a
`PROVENANCE.md`. `npm run vendor` refreshes it (`git clone` → `npm install` → `npm run build`,
then reduced to `dist/` + LICENSE + README + package.json, so no toolchain is committed).

## Development

```sh
npm install
npm run typecheck   # strict TypeScript
npm test            # 35 behaviour tests, no network
npm run check       # both
npm run vendor      # re-vendor the upstream library
```

The tests use a fake Jev: no API key, no network traffic, no session files.

`tools/simulate-session.ts` is the measurement harness behind every number in this README. It
replays a real session the way pi drives it (one LLM call per assistant message, the same gates,
real Jev answers) and reports the tokens saved, the prompt rewrites that cost cache writes, and
the net:

```sh
node --import jiti/register tools/simulate-session.ts ~/.pi/agent/sessions/<dir>/<session>.jsonl \
  --cache=/tmp/sim.json --window=1000000 --state=25000 --abridge=500 --gap=auto
```

Options worth knowing: `--gap=1` removes the cache-cost gate (the aggressive bound), `--trigger`
and `--urgent` move the size gates, `--state` / `--head` / `--abridge` change what Jev sees,
`--ratio` sets the cache write/read price ratio, `--debug` prints what each prune did, and
`--cache` reuses decisions across runs with the same state options. It prints aggregate numbers
only — message counts, bytes, tokens and request counts, never message content.

Only sessions whose context contains no `compaction` entry can be replayed faithfully: in a
compacted session the historical prompt usages describe a context that no longer exists, so the
simulator bases everything on the reconstructed context instead. `tools/measure-gain.ts` gives a
rougher per-session figure.

| Path | What it is |
| --- | --- |
| `index.ts` | the extension: gates, safety rules, `context` hook, `/jev-compaction` |
| `image.ts` | image dimensions and cost, shared by the extension and the tools |
| `test/*.test.ts` | 35 behaviour tests, fake Jev, no network |
| `tools/simulate-session.ts` | the measurement harness behind every number here |
| `tools/token-model.ts` | shared token accounting (payload, images) |
| `tools/measure-gain.ts` | quick per-session gain figure |
| `vendor/fast-jev-compaction/` | upstream library build (see below) |

## Known headroom

What measurement settled, and what is still open:

**Settled, do not re-litigate:**

- a smaller state is a false economy: `--state=8000` cut Jev requests 2.6× and the net gain 2.4×
  (33.6 % → 14.0 %), because Jev without history keeps everything;
- argument abridging is worth ~0.1 point on these sessions (arguments are ~29 % of the payload but
  rarely exceed the threshold) — kept because it preserves the record of a call whose result was
  dropped, not because it pays;
- the result head changes no decision on image-heavy sessions (the head of a screenshot is a
  placeholder) while costing 45 % more Jev requests; it is kept for text results, where it is the
  only signal that separates a re-readable file dump from a unique error trace;
- "valve only" (prune just before the window fills, `--trigger=0.85`) nets +0.5 %: too few prunes
  to cover the session, and the one penalty is paid in full;
- the cache-cost gate is worth its keep: without it the net is *lower* (31.6 % vs 33.6 %) for 11×
  the Jev requests;
- scoring in the background costs 1.8 points and removes ~20 s of added wall-clock per session;
- the decision cache survives a reload or a resume (`pi.appendEntry`), so nothing is re-paid;
- `details` never reach the model (verified in pi's Anthropic and OpenAI-compatible serializers),
  so no saving can come from them.

**Still open:**

| Lever | Expected effect | Risk |
| --- | --- | --- |
| Make `cacheAlreadyCold` also cover `/compact` and session start (a prefix that is being rewritten anyway) | invalidation at no extra cost, so the gate can be ignored there | none identified |
| Strip thinking blocks from all but the newest turns | thinking is the largest unreachable block | providers sign reasoning payloads; only safe where previous-turn thinking is ignored |
| Measure a text-heavy session | every measurable session here is screenshot-heavy; the text regime is unverified | none |
| Group decisions (`choice` question per batch) | fewer questions per request, so fewer 25k states re-sent (currently 27–50 Jev requests per session) | coarser signal, must be measured against per-call `noul` |

## Limits

- Only tool results, their `details`, the abridged arguments of kept calls, and provably
  re-runnable calls are candidates. Thinking blocks, user text and assistant text are never
  touched — in a measured session that leaves ~50 % of the payload unreachable.
- Pruning is therefore **not** a compaction strategy on its own: it keeps a session small, it does
  not refocus it. pi's own compaction still runs at its threshold, and if you want a model-grown
  summary of the work, that is still the tool for it.
- Token sizes are estimated from character counts, not tokenized (images especially: a fixed
  per-image cost). Treat absolute numbers as estimates.
- A probability is not proof. Jev can be wrong about a result that was still needed; a read-only
  tool can be re-run, and `/jev-compaction clear` puts the whole history back in front of the
  model in one command.
- Requires a Jev API key; without one it does nothing.

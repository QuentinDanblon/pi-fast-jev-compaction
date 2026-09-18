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

Replayed on two real pi sessions, using the default safe rules (results only, calls kept):

| | text/code session | screenshot-heavy session |
| --- | --- | --- |
| messages / tool calls | 956 / 480 | 982 / 512 |
| tool mix | 71 % bash, 21 % write, 6 % edit | 71 % bash, 21 % write, 6 % edit |
| context before | 578k tok | 916k tok |
| context after | **514k tok** | **801k tok** |
| **tokens saved** | **−11 %** | **−12.5 %** |
| bytes saved | −24 % | −19 % |
| Jev requests (whole session) | 27 | 34 |
| failures | 0 | 0 |

For reference, the same replay with whole *calls* also removable (upstream's behaviour) reached
**−36 %** and **−28 %** of tokens. That extra gain came from deleting 328 and 324 calls, which in
these sessions included `write`, `edit` and shell commands that launch WSL/PowerShell/Python
harnesses. Deleting the record of a side effect is how a model ends up repeating work or
re-running a migration, so this port does not do it by default: a call is only removed when it
is provably re-runnable (a read-only tool, or a shell command that only reads).

`tools/measure-gain.ts` reproduces this on your own sessions.

Three caveats, stated plainly:

- **Bytes overstate the win when images are involved.** In the screenshot-heavy session 88 % of the
  bytes were base64 images but only 6 % of the tokens.
- Token counts are estimates (a character model validated to within ~10 % of the usage pi reports),
  and the replay used permissive gates, so these numbers are an upper bound: the default
  configuration prunes at most once every `minCallsBetweenPrunes` LLM calls.
- What cannot be touched at all: thinking blocks (32 % of the text in the first session), user and
  assistant text. Results, their `details`, the abridged arguments of kept calls, and provably
  read-only calls are the only movable mass — roughly half the payload.

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
   by a short note. It is fitted under `maxStateTokens` by progressively truncating inputs,
   abridging old texts, collapsing old messages and reducing old calls to one line each.
3. Each non-pinned call gets two `noul` questions: should the call stay, and should its result
   stay verbatim.
4. Questions are batched so state plus questions stay under `maxRequestTokens`, and batches run
   `requestConcurrency` at a time (the full state is re-sent with each request, as upstream does).

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
  to 20–200 calls so it is always re-evaluated: a read-heavy session that frees 40 % may prune
  every ~23 calls, a result-only session that frees 8 % waits ~113. Before the first prune it
  assumes 15 % (60 calls). Fewer, larger prunes beat continuous trimming;
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
npm test            # 22 behaviour tests, no network
npm run check       # both
npm run vendor      # re-vendor the upstream library
```

The tests use a fake Jev: no API key and no network traffic. `tools/measure-gain.ts` does talk
to Jev (it is the only way to measure real decisions) and prints aggregate numbers only, never
message content:

```sh
node --import jiti/register tools/measure-gain.ts ~/.pi/agent/sessions/<dir>/<session>.jsonl
```

## Known headroom

What is measured, and what could still move the needle:

| Lever | Expected effect | Risk |
| --- | --- | --- |
| Abridge long arguments of *all* old kept calls, not only those whose result is dropped (`abridgeArgumentChars` is currently ignored for `keep` decisions) | arguments are ~30 % of the payload (590 KB in the measured session) for ~1.2 KB per call, so a lower threshold would move `f` well past 11 % | the model loses exact old commands/paths; heads must be kept |
| Strip thinking blocks from all but the newest turns | thinking was 32 % of the text in the measured session — the single biggest block | providers sign reasoning payloads; only safe where the provider ignores previous-turn thinking |
| Persist the decision cache (`pi.appendEntry`) | a resumed or reloaded session currently re-pays every Jev request | entries grow with the session |
| Group decisions (`choice` question per batch of calls) | fewer questions per request, so fewer of the 25k-token states are re-sent | coarser signal, needs measuring against per-call `noul` |
| Smaller state (`maxStateTokens`) | 3-5x more questions per request, so a 3-5x cheaper session for Jev | Jev sees less context, so decisions get worse |
| Cache-write-aware free moments: `/compact`, session start, provider cache TTL expiry | invalidation for free, so the `minCallsBetweenPrunes` gate can be ignored | none identified; only detects the *following* request |

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

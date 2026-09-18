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

Replayed on two real pi sessions (all messages of the session's compaction-aware context,
pruned incrementally turn by turn, so decisions accumulate exactly like in a live session):

| | text/code session | screenshot-heavy session |
| --- | --- | --- |
| messages / tool calls | 956 / 480 | 982 / 512 |
| context before | 578k tok | 879k tok |
| context after | **369k tok** | **631k tok** |
| **tokens saved** | **−36 %** | **−28 %** |
| bytes saved | −39 % | −55 % |
| Jev requests | 17 | 21 |
| failures | 0 | 0 |

`tools/measure-gain.ts` reproduces this on your own sessions.

Two caveats worth stating plainly:

- **Bytes overstate the win when images are involved.** In the screenshot-heavy session 89 %
  of the bytes were base64 images but only 6 % of the tokens; the byte figure was −55 % while
  the token figure was −28 %. Tokens are what you pay for.
- Absolute token counts are estimates (a character model validated to within ~10 % of the
  usage pi reports). The *ratios* compare the same basis, so they hold; the replay used
  permissive gates (`minNewCalls: 1`, `minPendingChars: 0`), making these numbers the upper
  bound — the default configuration prunes slightly less and costs fewer requests.

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
  "fallbackWindowMessages": 120,
  "requestConcurrency": 4,
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
- above 85 % of the window all of that is bypassed (`urgent`).

### Why `pi.on("context")` and not `session_before_compact`

Pi persists compaction as a summary string plus a contiguous kept tail (`firstKeptEntryId`).
That model can only keep a *suffix* verbatim; it cannot delete individual tool calls or
results inside the summarized range. `pi.on("context")` runs before every LLM call and may
return a modified message list, which is the faithful equivalent of the upstream Claude Code
function hook — and it keeps the persisted history byte-for-byte intact.

## Design notes (the non-obvious contracts)

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
npm test            # 16 behaviour tests, no network
npm run check       # both
npm run vendor      # re-vendor the upstream library
```

The tests use a fake Jev: no API key and no network traffic. `tools/measure-gain.ts` does talk
to Jev (it is the only way to measure real decisions) and prints aggregate numbers only, never
message content:

```sh
node --import jiti/register tools/measure-gain.ts ~/.pi/agent/sessions/<dir>/<session>.jsonl
```

## Limits

- Only tool calls and results are candidates. Thinking blocks are the largest single
  non-prunable block of a context (32 % of the text in one of the measured sessions); text,
  thinking and images are never removed.
- Token sizes are estimated from character counts, not tokenized (images especially: a fixed
  per-image cost). Treat absolute numbers as estimates.
- A probability is not proof. Jev can be wrong about a result that was still needed; the
  assistant can always re-run the tool, and `/jev-compaction off` disables everything instantly.
- Requires a Jev API key; without one it does nothing.

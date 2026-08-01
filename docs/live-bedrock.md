# Live Bedrock check — manual, opt-in, once

**Bedrock inference is billable in the caller's own AWS account.** Nothing in
this repository calls it during tests, nothing calls it implicitly, and CI never
calls it at all. That is a deliberate default, matching spawn-ts's gated
`live-smoke` pattern (`spawn-ts/docs/live-smoke.md`) and MockProvider's
cost-safe-unless-asked rule.

The whole reason `ask()` takes an injected `ConverseFn` rather than a Bedrock
client is that the interesting behaviour — the multi-turn loop, tool dispatch,
failure handling, gap reporting, the streaming reducer — is exercised against
canned responses. `npm test` covers it with **no network, no credentials and no
inference**. There is nothing in `src/bedrock/` that a unit test could
meaningfully check; it is wire translation, and the only thing worth verifying
about it is that a real model on the other end behaves.

So the live check exists to answer exactly one question:

> Does a real Bedrock model, given this system prompt and this toolset, actually
> honour the grounding contract — call `recommend_shape` first, call
> `find_instances` before naming a type, and *say* when it is inferring?

That is not a regression test. It is a **prompt-quality check**, run by a human
who reads the answer.

## Prerequisites

1. An AWS account with **Bedrock model access granted** for the model you intend
   to use. Note that `listModels()` reports which models *exist* in the region —
   it is **not** a statement about what your account has been granted. A model
   that appears there can still return `AccessDeniedException`.
2. Credentials in the environment (or a browser session via spawn-ts's
   `credsFromIdToken`).
3. `@aws-sdk/client-bedrock-runtime` installed — it is an `optionalDependency`,
   present in this repo's devDependencies.

## Running it

There is no committed script and no npm task, on purpose: a one-command path to
billable inference is a path someone runs by accident. Write the few lines
inline, in a scratch file outside the repo, and delete it afterwards.

```ts
// scratch/ask.mts — NOT committed.
import { ask, truffleInstanceSource, truffleAppSource } from "@spore-host/advisor-ts";
import { bedrockConverse } from "@spore-host/advisor-ts/bedrock";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { find, CATALOG_AS_OF, lookupApp, AppCatalog } from "@spore-host/truffle-ts";

if (!process.env.ADVISOR_LIVE_BEDROCK) {
  throw new Error("refusing to spend money: set ADVISOR_LIVE_BEDROCK=1");
}

const answer = await ask(process.argv[2], {
  converse: bedrockConverse({
    client: new BedrockRuntimeClient({ region: "us-east-1" }),
    modelId: process.env.ADVISOR_MODEL_ID!, // required; never defaulted
  }),
  backends: {
    instances: truffleInstanceSource({ find, catalogAsOf: CATALOG_AS_OF }),
    apps: truffleAppSource({ lookupApp, appCatalog: AppCatalog }),
  },
  prompt: { region: "us-east-1" },
});

console.log(answer.text, "\n---");
for (const c of answer.calls) console.log("tool:", c.tool, c.error ?? "ok");
for (const g of answer.gaps) console.log("gap:", g);
```

```bash
ADVISOR_LIVE_BEDROCK=1 ADVISOR_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0 \
  npx tsx scratch/ask.mts "what should I run LAMMPS on for a 6-hour run?"
```

Start **without** `live` and `capacity` backends. The gaps list should then
already contain "no AWS credentials, so spot prices and service-quota headroom
were not checked" — and the point of the check is whether the model's prose
*mentions* that, not merely whether the array is populated.

## What to look for in the answer

Ranked by what actually goes wrong:

1. **An uncatalogued workload is the headline case.** Ask about something *not* in
   the six-entry KB — LAMMPS, NAMD, CP2K, a lab's own code. The answer must state
   the premise ("I don't have a verified profile for this, so I'm treating it
   as…") **before** the recommendation, and invite correction. A fluent answer
   with no stated premise is a failure even if the hardware advice is good.
2. **Every instance name and price appears in `answer.calls`.** Grep the prose
   against the tool outputs. A type or a figure that is in the text but not in a
   tool result means the model answered from memory — the exact failure this
   library exists to prevent, and the one that looks most convincing.
3. **`recommend_shape` was called first.** If the model reached for
   `find_instances` before deciding how the job runs, the workflow section of the
   prompt needs strengthening — shape changes which instance advice is even
   correct.
4. **Gaps are voiced, not just recorded.** With `live` absent, the answer should
   say quota and spot were not checked. Silence there is the #63 defect in its
   most natural habitat: an unmentioned missing check reads exactly like a check
   that passed.
5. **No implication that it can launch.** The prompt says it cannot. Verify the
   model doesn't offer to.

## If the model misbehaves

Fix `src/core/prompt.ts` and add the assertion to `prompt.test.ts` in the same
change. That file's tests look like testing prose, and that is the point: the
failure mode is silent — someone tidies the prompt, drops the "label your
inference" paragraph, and every answer afterwards still *looks* fine, just with
the premise no longer stated. That is not detectable from an output sample. It is
detectable there.

Do **not** respond to a misbehaving model by loosening the tools (e.g. letting
`estimate_cost` accept a price the model supplied from memory, or coercing a
stringified number). The tools are the grounding; a tool that tolerates a
made-up input teaches the model that made-up inputs work.

## Cost

One question with a handful of tool round-trips is fractions of a cent on a
mid-tier model. The reason this is gated is not the amount — it is that an
unguarded path to *any* billable call ends up in a loop, in CI, or in someone's
watch script.

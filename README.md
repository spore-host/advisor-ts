# advisor-ts

A browser-native **research-computing advisor** for AWS. It answers the questions
a researcher actually asks —

> *"What should I run GROMACS on?"*
> *"How much might 500 docking runs cost me?"*
> *"Can I even launch 8 of those right now?"*

— by calling the spore.host tools for every hardware fact and using Amazon
Bedrock only for the part a model is genuinely good at: knowing what a given
research code needs.

Part of the spore.host suite alongside
[`spawn-ts`](https://github.com/spore-host/spawn-ts) (launch + self-terminate),
[`truffle-ts`](https://github.com/spore-host/truffle-ts) (instance discovery) and
[`lagotto-ts`](https://github.com/spore-host/lagotto-ts) (capacity watching).

## The point: a division of labour, stated out loud

A researcher will name a workload no catalog has ever heard of nearly every time.
That is the **normal path**, not an exception — chasing coverage by enumerating
scientific software is an unwinnable treadmill, and it would make answer quality a
function of how recently someone edited a YAML file.

So the work is split where each side is actually reliable:

| | owns | never supplies |
|---|---|---|
| **the tools** | instance types, prices, per-AZ spot prices, quota headroom, live capacity | workload characterisation |
| **the model** | "this code is GPU-resident", "this scales over EFA", "this is memory-bound" | any number, any instance name |

And the contract between them is **visible in the answer**. An uncatalogued
workload degrades to:

> I don't have a verified profile for LAMMPS, so I'm treating it as a
> GPU-accelerated MD code that can scale across nodes — **correct me if that's
> wrong**. For that shape: `p5.48xlarge`, 8 × H100 with 80 GiB each, $55.04/hr
> on-demand *(truffle-ts catalog, 2026-07)*.

The premise comes **before** the recommendation, because a premise stated
afterwards is one the reader has already acted on.

Three invariants hold everywhere:

1. **Every hardware fact traces to a tool call.** `ask()` returns the full
   `calls` record, so a UI can show what was checked — not just what was
   concluded.
2. **A failed or impossible check is stated, never omitted.** An answer that
   drops a failed capacity check reads exactly like one where capacity was fine.
3. **Read-only by construction.** There is no `launch` tool, and a test asserts
   there is no tool matching `launch|create|run_instance|terminate|delete`. An
   LLM must not be one hallucinated tool call away from a billable
   `RunInstances`. The output is a *proposal* a human submits.

## Install

```bash
npm install @spore-host/advisor-ts

# the tools it calls (peer, optional — install the ones you want to give it):
npm install @spore-host/truffle-ts @spore-host/lagotto-ts

# to talk to Bedrock:
npm install @aws-sdk/client-bedrock-runtime
```

## Two entry points

- **`@spore-host/advisor-ts`** — the pure core: the tool registry, the tool-use
  loop, the shape recommender, cost arithmetic, the seed workload KB, the system
  prompt, the transcript reducer. No AWS SDK, no truffle-ts, no lagotto-ts
  imports at all. Safe in any bundle.
- **`@spore-host/advisor-ts/bedrock`** — the Bedrock binding
  (`bedrockConverse`, `bedrockConverseStream`, `listModels`). The only place
  `@aws-sdk/client-bedrock-runtime` is imported, guarded by
  `src/core/isolation.test.ts`, which walks the source import graph and fails if
  the default entry can reach an `@aws-sdk/*` import.

Bedrock's runtime endpoints are CORS-enabled — `converse`, `converse-stream`,
`invoke` and `invoke-with-response-stream` all return
`access-control-allow-origin: *` — so this runs **in a browser tab against the
user's own account with no proxy and no backend**, the same property that makes
`sts.amazonaws.com` usable in spawn-ts's `credsFromIdToken`.

## Quick start

```ts
import { ask, truffleInstanceSource, truffleAppSource } from "@spore-host/advisor-ts";
import { bedrockConverse } from "@spore-host/advisor-ts/bedrock";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { find, CATALOG_AS_OF, lookupApp, AppCatalog } from "@spore-host/truffle-ts";

const converse = bedrockConverse({
  client: new BedrockRuntimeClient({ region: "us-east-1", credentials }),
  // Required and never defaulted: a defaulted model id bills for a model the
  // caller did not choose, and availability differs per account and region.
  modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
});

const answer = await ask("what should I run GROMACS on for a 4-hour run?", {
  converse,
  backends: {
    instances: truffleInstanceSource({ find, catalogAsOf: CATALOG_AS_OF }),
    apps: truffleAppSource({ lookupApp, appCatalog: AppCatalog }),
  },
  prompt: { region: "us-east-1" },
});

console.log(answer.text);
for (const c of answer.calls) console.log(c.tool, c.error ?? "ok"); // what was checked
for (const g of answer.gaps) console.log("gap:", g);                // what wasn't
```

`answer.gaps` here would include *"no AWS credentials, so spot prices and
service-quota headroom were not checked"* and *"capacity was not checked"* —
before the model even ran. **Show the gaps next to the answer.** A gap list
filed away separately is a gap list nobody reads.

### Adding live grounding

```ts
import { truffleLiveSource, lagottoCapacitySource } from "@spore-host/advisor-ts";
import { AwsLiveFinder } from "@spore-host/truffle-ts/live";
import { CapacityWatcher, truffleFinderAdapter } from "@spore-host/lagotto-ts/live";

const finder = new AwsLiveFinder({ regions: ["us-east-1"], pricing: "lazy" });

const backends = {
  instances: truffleInstanceSource({ find, catalogAsOf: CATALOG_AS_OF }),
  apps: truffleAppSource({ lookupApp, appCatalog: AppCatalog }),
  live: truffleLiveSource({ finder, region: "us-east-1" }),
  capacity: lagottoCapacitySource({
    watcher: new CapacityWatcher({ finder: truffleFinderAdapter(finder, "us-east-1") }),
    region: "us-east-1",
  }),
};
```

Note the adapters take the sibling libraries' **functions as arguments**. Nothing
in advisor-ts imports truffle-ts or lagotto-ts, so both stay peer/optional
dependencies and every backend is testable with an object literal.

### Streaming

```ts
const converse = bedrockConverseStream({ client, modelId, onText: (d) => process.stdout.write(d) });
```

Both paths reduce to the same `ConverseResponse`, so there is exactly **one**
tool-use loop — the streaming and non-streaming paths cannot drift, because only
one of them has any logic.

## The tools the model may call

`buildToolset(backends)` returns **only the tools whose backend is present**. A
model that watches a tool fail repeatedly stops calling it and answers from
memory instead — precisely the failure this library exists to prevent. Fewer
tools plus a stated gap beats more tools that lie.

| tool | needs | backed by |
|---|---|---|
| `recommend_shape` | — (pure) | `single-node` / `job-array` / `mpi` + EFA, with the reason |
| `estimate_cost` | — (pure) | price × hours × count, with caveats attached |
| `lookup_workload` | — (pure) | the seed KB; a **miss is the normal case** |
| `find_instances` | `instances` | truffle-ts `find` |
| `get_pricing` | `instances` | catalog `onDemandPrice` |
| `lookup_app` | `apps` | truffle-ts `lookupApp` (interactive viz only) |
| `get_spot_prices` | `live` | truffle-ts `LiveFinder.getSpotPricing` (per-AZ) |
| `check_quota` | `live` | `getQuotas` + `canLaunch`, scaled by count |
| `check_capacity` | `capacity` | lagotto-ts `CapacityWatcher.check` |

### `recommend_shape` is what makes this a *job* advisor

A researcher's real question is rarely "which instance type" — it's "how do I run
this". Shape precedence is `mpi` → `job-array` → `single-node`, and the order is
deliberate: **running an MPI job as an array silently produces garbage** (ranks
that can't reach each other), whereas running an array as MPI merely wastes
money. Every MPI shape sets `efa: true`. With no signal at all it returns
`confident: false` and says so — that's a guess, not a finding.

Spot advice follows the shape, not the price: a `job-array` is a yes (a reclaimed
task is re-run), an `mpi` job is a no (losing one instance kills the whole job).

### The seed KB is deliberately tiny

`workloads.ts` holds six entries, each with a required `provenance` citation — an
uncited entry is indistinguishable from a guess. It exists to **override** the
model where we hold a verified, citable opinion. It is not the mechanism, and
growing it is not the roadmap.

## What it will not do

- **Launch anything.** No `launch` tool in v0.1.0, asserted by a test.
- **Handle a long-lived AWS key.** Credentials come from the caller; reuse
  spawn-ts's `credsFromIdToken` for a browser BYOA path.
- **Call Bedrock implicitly.** Every call is billable in the caller's own
  account, so a caller must construct a client and pass it in. No test in this
  repo spends a cent — see [docs/live-bedrock.md](docs/live-bedrock.md).

## Testing without a bill

The model arrives as an injected function:

```ts
type ConverseFn = (req: ConverseRequest) => Promise<ConverseResponse>;
```

That one choice is why the multi-turn loop, tool dispatch, failure handling and
gap reporting all run in tests against canned responses — no network, no
credentials, no billable inference. `src/bedrock/` contains no logic worth
testing, which is the point.

```bash
npm run typecheck && npm test && npm run build
npx vitest run src/core/isolation.test.ts   # the default entry pulls in no @aws-sdk/*
```

## Scope of this release (v0.1.0)

- ✅ The grounding contract: tool-sourced facts, labelled inference, stated gaps.
- ✅ Nine read-only tools, gated on backend presence.
- ✅ Converse + ConverseStream, reducing to one loop.
- ✅ Adapters for truffle-ts and lagotto-ts through structural seams.
- ⏳ Not yet: a launchable **template** as the output (the `Proposal` type is
  already structured data rather than a string precisely so it can grow into
  one), data-movement bindings, and multi-region comparison.

advisor-ts stays on `0.x.y` **indefinitely**; there is no planned 1.0.0, so a MINOR
bump is the breaking-change signal for the life of the project. Unlike its
spawn-ts / truffle-ts / lagotto-ts siblings it has no Go original, so it makes no
parity claim.

## License

Apache-2.0 © Scott Friedman. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

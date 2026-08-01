# The grounding contract

This is the design document. Everything else in advisor-ts is an implementation
detail of what follows.

## The problem

Ask a capable language model "what should I run GROMACS on?" and you get a fluent,
plausible, well-organised answer containing an instance type that may not exist, a
price that was true eighteen months ago, and a quota assumption it never checked.
The answer is *indistinguishable in form* from a correct one. That is the failure
mode — not that the model is wrong, but that being wrong looks exactly like being
right.

The obvious fix — build a catalog of workloads and refuse anything not in it —
fails differently. There is no structured data for computational workloads
anywhere in the spore.host repos: `libs/catalog` holds six *interactive
visualization* apps (paraview, chimerax, igv, qgis, fiji, ds9) and nothing else,
and its schema (`dcv:`, `idle_timeout_default:`, `launch_command:`) doesn't
describe batch or MPI codes at all. A researcher will name a code no catalog has
heard of nearly every time. Enumerating scientific software is an unwinnable
treadmill, and it makes answer quality a function of how recently someone edited a
YAML file.

**So the uncatalogued workload is the normal path, and the design has to be good
at it rather than apologise for it.**

## The division of labour

Split the work where each side is actually reliable.

| | owns | must never supply |
|---|---|---|
| **the tools** | instance type names, on-demand prices, per-AZ spot prices, savings percentages, quota headroom, live capacity | any claim about what a workload needs |
| **the model** | "this code is GPU-resident", "this scales across nodes and wants a low-latency fabric", "this is bound by memory bandwidth" | any number, any instance name |

A model genuinely does know the second column for thousands of research codes —
far more than anyone would hand-curate. That knowledge is the most valuable thing
it contributes, and suppressing it would throw away the answer to the common case.

## What makes it honest: the contract is visible

Labelling is the load-bearing part. The answer must separate *inferred workload
characteristics* from *retrieved hardware facts*, and say which is which:

> I don't have a verified profile for LAMMPS, so I'm treating it as a
> GPU-accelerated MD code that can scale across nodes — **correct me if that's
> wrong.** For that shape: `p5.48xlarge`, 8 × H100 with 80 GiB each, $55.04/hr
> *(truffle-ts catalog, 2026-07)*.

Two details in there are deliberate:

- **The premise comes before the recommendation.** A premise stated afterwards is
  one the reader has already acted on.
- **"Correct me if that's wrong"** is an invitation, and it is the highest-value
  output for an uncatalogued workload. A researcher knows their own code better
  than the model does; a *stated* premise is one they can fix, a hidden premise is
  one they inherit.

## Where each rule lives

The contract is not a convention anyone has to remember. It is enforced in code
and asserted in tests.

| rule | enforced by | tested by |
|---|---|---|
| hardware facts come only from tools | `prompt.ts`, per fact class | `prompt.test.ts` |
| there is no way to launch anything | `tools.ts` — no such tool exists | `tools.test.ts` rejects `launch\|create\|run_instance\|terminate\|delete` |
| a tool that can't work isn't offered | `buildToolset(backends)` | `tools.test.ts` |
| a missing capability is stated up front | `missingCapabilities()`, seeded into `gaps` | `advisor.test.ts` |
| a failed call becomes a gap AND reaches the model | `runTool` never throws; `toolResultMessage(status: "error")` | `advisor.test.ts` |
| an uncatalogued workload still gets cited hardware | `lookup_workload`'s miss branch returns `guidance` | **the headline test**, `advisor.test.ts` |
| a truncated list can't read as exhaustive | `totalMatches` next to `returned` | `tools.test.ts` |
| a price with no source is reported as absent | `noPriceAvailable`, `noSpotDataFor` | `tools.test.ts` |
| a cost figure carries its caveats | `cost.ts` always attaches them | `cost.test.ts` |

## The #63 invariant, generalised

Go spawn #63 and spawn #469 both turned on one rule: **an error must never be
indistinguishable from an absence of data.** advisor-ts extends it in four
directions, because each one is a distinct way for silence to lie:

1. A **missing capability** never mentioned reads exactly like one that ran and
   found nothing wrong. Hence gaps are seeded from `missingCapabilities()` before
   the model is ever called — true regardless of what the model does.
2. An **omitted failed capacity check** reads exactly like a passed one. Hence
   `runTool` returns `{ ok: false, error }` rather than throwing, the error goes
   into the transcript *as an error-status tool result*, and it goes into
   `answer.gaps`.
3. A **truncated result set** must not read as exhaustive. Hence `totalMatches`
   travels with `returned`, and `noPriceAvailable` / `noSpotDataFor` name what was
   asked for and not found.
4. **`available: false`** (an observation: nothing matching is on offer right now)
   must be distinguishable from a **throw** (the check itself broke). The lagotto
   adapter keeps those two paths separate for exactly that reason.

A corollary that shapes the streaming reducer: a malformed streamed tool input
becomes `{ __malformed: raw }`, never `{}`. Schema validation then rejects it, so a
truncated stream surfaces as a *failed tool call* instead of one that quietly ran
on default arguments and produced a confident answer from the wrong numbers.

## Why a tool that cannot work is not offered

`buildToolset(backends)` returns only tools whose backend is present. It would be
simpler to register all nine and let the missing ones error.

That's worse, and the reason is behavioural rather than aesthetic: a model that
watches a tool fail repeatedly stops calling it and answers from memory instead —
precisely the failure this library exists to prevent. **Fewer tools plus a stated
gap beats more tools that lie.**

## Why read-only

There is no `launch` tool in v0.1.0, and a test asserts there is no tool matching
`launch|create|run_instance|terminate|delete`. Adding one is a decision, not a
convenience: an LLM must not be one hallucinated tool call away from a billable
`RunInstances`.

The output is a **proposal** a human reviews and submits through spawn-ts's
existing form. Advice, then a human hand on the trigger. The `Proposal` type is
structured data rather than a string precisely so it can grow into a launchable
template later without the output type changing shape.

## Why shape comes first

A researcher's real question is rarely "which instance type" — it's "how do I run
this". `recommend_shape` answers `single-node` / `job-array` / `mpi`, and it must
precede `find_instances` because **shape changes which instance advice is even
correct**: an array of 500 independent tasks wants a cheap type × 500 on spot; an
MPI job wants one placement group and an EFA fabric.

Precedence is MPI → job-array → single-node, and the asymmetry is the
justification: running an MPI job as an array **silently produces garbage** (ranks
that cannot reach each other), whereas running an array as MPI merely wastes
money. When the description carries no signal at all, the recommendation returns
`confident: false` and says so — that's a guess, not a finding.

Spot advice follows from the shape rather than the price: a `job-array` is a yes (a
reclaimed task is simply re-run), an `mpi` job is a no (losing one instance kills
the whole job), and a long single-node run is a no.

## Why the KB stays small

`workloads.ts` has six entries. Each carries a **required** `provenance` citation,
because an uncited entry is indistinguishable from a guess — and a guess dressed
as a catalog hit is worse than an honest inference, which at least labels itself.

The KB is an accuracy **override** for the handful of workloads where we hold a
verified, citable opinion. It is not the mechanism. Growing it is not the roadmap,
and a PR that adds twenty uncited entries is a regression.

## Why the model is an injected function

```ts
type ConverseFn = (req: ConverseRequest) => Promise<ConverseResponse>;
```

Because the model arrives as a function rather than a Bedrock client, the
multi-turn loop, tool dispatch, failure handling, gap reporting and the streaming
reducer all run in tests against canned responses — no network, no credentials, no
billable inference. `src/bedrock/` is wire translation and contains no logic worth
testing, which is the point: any logic that migrates there becomes untestable
without paying for it.

The live check that remains is a **prompt-quality** check run by a human who reads
the answer, not a regression test. See [live-bedrock.md](live-bedrock.md).

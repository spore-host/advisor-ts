# CLAUDE.md — advisor-ts

`advisor-ts` is the browser-native research-computing advisor for the spore.host
suite: it answers "what should I run this on?" and "what will it cost?" by
calling [`truffle-ts`](https://github.com/spore-host/truffle-ts) and
[`lagotto-ts`](https://github.com/spore-host/lagotto-ts) as tools, with Amazon
Bedrock supplying only the workload reasoning. Fourth `-ts` sibling alongside
[`spawn-ts`](https://github.com/spore-host/spawn-ts).

## The design in one paragraph — read this before changing anything

The tools own every hardware fact (instance types, prices, quota, capacity). The
model owns the workload → hardware-characteristics mapping. **The contract
between them is explicit, labelled, and visible in the answer.** An uncatalogued
workload is the *normal path*, not an exception: chasing coverage by enumerating
scientific software is an unwinnable treadmill and would make answer quality a
function of how recently someone edited a YAML file. So the seed KB stays tiny and
the model's inference is invited — and labelled.

## Three invariants that must survive every edit

1. **Facts trace to tool calls.** No instance name, price, savings percentage or
   quota number may originate in the model. `prompt.ts` says so per fact class,
   and `prompt.test.ts` asserts each line. Those assertions look like testing
   prose; they exist because the failure mode is silent — drop the "label your
   inference" paragraph and every answer still *looks* fine.
2. **An error must never be indistinguishable from an absence of data** (Go #63,
   spawn #469). Extended here: a missing capability never mentioned reads like one
   that ran and found nothing wrong; an omitted failed capacity check reads
   exactly like a passed one; a truncated result set must not read as exhaustive;
   `available: false` (an observation) must be distinguishable from a throw (a
   broken check). Hence `runTool` never throws, `find_instances` reports
   `totalMatches` next to `returned`, `get_pricing` reports `noPriceAvailable`,
   and `missingCapabilities` seeds gaps *before* the model runs.
3. **Read-only by construction.** No `launch` tool, asserted by a test that also
   rejects `create|run_instance|terminate|delete`. Adding one is a decision, not a
   convenience: an LLM must not be one hallucinated tool call away from a billable
   `RunInstances`. The output is a proposal a human submits through spawn-ts.

## Architecture

- **`src/core/`** — pure, SDK-free, DOM-free. This is the `.` export.
  - `types.ts` — the domain model. `Provenance` (`tool` | `catalog` | `inferred`)
    is the single most important field in the library. `Proposal` is deliberately
    **not** a string, so it can grow into a launchable template.
  - `shapes.ts` — pure `recommendShape`. Precedence MPI → job-array →
    single-node, because running an MPI job as an array silently produces garbage
    (ranks that can't reach each other) whereas running an array as MPI merely
    wastes money. Every MPI shape sets `efa: true`.
  - `workloads.ts` — the seed KB. **Deliberately tiny, and that is the design,
    not a TODO.** Every entry carries a required `provenance` citation; an uncited
    entry is indistinguishable from a guess. Don't grow this to chase coverage.
  - `schema.ts` — a JSON Schema subset. Returns *all* problems (a round-trip per
    typo is slow and billable) and **does not coerce** `"8"` → `8`: a tool that
    accepts a stringified number teaches the model that loose types work, and the
    one place it matters is a price or an hour count.
  - `backends.ts` — the structural seams. `InstanceSource.asOf` is **required**:
    an undated snapshot reads as current data.
  - `cost.ts` — mirrors spawn-ts's `accumulatedCost`. Throws on `price <= 0` (a
    zero total reads as "free"). Caveats are always attached, because a cost
    figure travels — into a grant budget, into an email — and it takes its
    qualifications with it or it stops having any.
  - `tools.ts` — the registry. `buildToolset` returns only tools whose backend is
    present: a model that watches a tool fail repeatedly stops calling it and
    answers from memory instead. Tool descriptions are **prompt text** — they say
    *when* to call, not just what it does.
  - `prompt.ts` — the grounding contract, in the one place the model reads it.
    Deterministic, so it's testable.
  - `transcript.ts` — Converse wire shapes as plain data, plus the streaming
    reducer. A malformed streamed tool input becomes `{ __malformed: raw }`, never
    `{}` — schema validation then rejects it, so a truncated stream surfaces as a
    failed tool call rather than one that ran on defaults.
  - `advisor.ts` — `ask()`, the multi-turn loop.
- **`src/adapters/`** — bind truffle-ts / lagotto-ts to the seams. They take the
  libraries' **functions as arguments**; nothing here imports them, so both stay
  peer/optional and every adapter is testable with a two-line stub.
- **`src/bedrock/`** — the only place `@aws-sdk/client-bedrock*` is imported, the
  `./bedrock` export. Deliberately thin and deliberately not unit-tested: logic
  here would be logic testable only by paying for inference.

## Why `ConverseFn` is injected

`type ConverseFn = (req: ConverseRequest) => Promise<ConverseResponse>`. Because
the model arrives as a *function* rather than a Bedrock client, the multi-turn
loop, tool dispatch, failure handling and gap reporting all run in tests against
canned responses — no network, no credentials, no billable inference. Keep it that
way: any logic that migrates into `src/bedrock/` becomes untestable.

## Testing

- `npm run typecheck` — `tsc --noEmit`
- `npm test` / `npm run test:cov` — vitest
- `npx vitest run src/core/isolation.test.ts` — the import-graph guard: the
  default entry must not reach an `@aws-sdk/*` import. Its walker **strips
  comments before regexing**, because the adapter doc-comments contain real
  `import … from "@spore-host/truffle-ts"` usage examples; a fourth test pins the
  guard against becoming vacuous in either direction.
- **The headline test** is in `advisor.test.ts`: an *uncatalogued* workload still
  gets cited hardware with its premise labelled. That's the common case. If it
  ever degrades to a refusal, or to a fluent answer with invented numbers, the
  library has failed at the thing it exists for.
- `src/core/fixtures.test-util.ts` holds the stub backends (named `.test-util.ts`
  so vitest doesn't run it as a suite).

**No test may call Bedrock.** Live inference is manual, opt-in and once —
see `docs/live-bedrock.md`.

## Build & publish

- `npm run build:lib` — emit `dist/` (the published artifact; `.` and
  `./bedrock` declarations must both exist)
- `npm run build` — library + TypeDoc

Package `@spore-host/advisor-ts`. First publish must be manual (Trusted
Publishing can't bootstrap a never-published package); after the trusted
publisher is registered on npmjs.com (org spore-host, repo advisor-ts, workflow
publish.yml), tag `v*` → token-free OIDC publish with provenance.

## Versioning & changelog (required)

Semantic Versioning + Keep a Changelog. Every user-facing change updates
`CHANGELOG.md` under `## [Unreleased]` in the same PR. Release: rename
`[Unreleased]` → `[X.Y.Z] - DATE`, tag `vX.Y.Z`.

**`0.x.y` indefinitely — there is no planned 1.0.0.** Breaking changes bump MINOR
permanently, not as a pre-release convention. This holds across every spore.host
`-ts` library. advisor-ts has no Go original, so unlike its siblings it makes no
parity claim at all.

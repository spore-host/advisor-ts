# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0,
breaking changes bump the MINOR version.

## [Unreleased]

## [0.1.0] - 2026-07-30

### Added

- Initial release — a browser-native research-computing advisor, packaged as
  `@spore-host/advisor-ts`. It answers "what should I run this on?" and "what
  will it cost?" by calling the spore.host libraries for every hardware fact and
  using Amazon Bedrock only for workload reasoning, which it labels as reasoning.

- **The grounding contract** (`src/core/prompt.ts`, asserted in
  `prompt.test.ts`): hardware facts come only from tools; workload
  characterisation comes from the model and is stated as a premise *before* the
  recommendation; a failed or unavailable check is reported, never omitted.

- **Pure core** (default `.` entry — no AWS SDK, no truffle-ts, no lagotto-ts):
  - `ask()` — the multi-turn tool-use loop. The model arrives as an injected
    `ConverseFn`, so the loop, tool dispatch, failure handling and gap reporting
    are all tested against canned responses with no network, no credentials and
    no billable inference.
  - `buildToolset(backends)` — nine read-only tools, each offered **only** when
    its backend is present: `recommend_shape`, `estimate_cost`,
    `lookup_workload` (always, pure), `find_instances` + `get_pricing`,
    `lookup_app`, `get_spot_prices` + `check_quota`, `check_capacity`.
    **There is no `launch` tool**, and a test asserts no tool matches
    `launch|create|run_instance|terminate|delete`.
  - `missingCapabilities(backends)` — the deployment's blind spots as
    user-facing gaps, seeded into every answer before the model runs.
  - `runTool()` — never throws: a bad tool name, invalid input and a failing
    handler all return `{ ok: false, error }`, so a failure reaches both the
    model and the user's gap list.
  - `recommendShape()` — pure `single-node` / `job-array` / `mpi` (+ EFA) with
    the reason. Precedence is MPI → array → single-node, because running an MPI
    job as an array silently produces garbage while the converse merely wastes
    money. With no signal it returns `confident: false`.
  - `estimateCost()` / `spotComparison()` / `spotAdvice()` — cost arithmetic
    mirroring spawn-ts's lifecycle formula, with the compute-only and
    full-duration caveats always attached, and spot suitability driven by the
    execution shape rather than the price.
  - `WorkloadCatalog` / `lookupWorkload()` — a deliberately tiny seed KB (six
    entries) where each entry carries a required `provenance` citation. An
    accuracy override, not the mechanism: a KB **miss is the normal path** and
    returns explicit guidance to characterise the workload and label it as
    inference.
  - `validate()` — a small JSON Schema subset that reports **all** problems at
    once (a round-trip per typo is slow and billable) and deliberately does not
    coerce `"8"` → `8`.
  - Transcript reduction — `messageText`, `toolUses`, `toolResultMessage`,
    `gapsFromCalls`, plus the streaming reducer (`newStreamState`,
    `reduceStreamEvent`, `finishStream`). Streaming reduces to the same
    `ConverseResponse` as the non-streaming path, so there is exactly one
    tool-use loop.
  - Structural backend seams (`InstanceSource`, `AppSource`, `LiveSource`,
    `CapacitySource`) — advisor-ts core never imports the sibling libraries, so
    they stay peer/optional and every tool is testable with an object literal.
  - `truffleInstanceSource` / `truffleAppSource` / `truffleLiveSource` /
    `lagottoCapacitySource` — adapters that take the libraries' *functions* as
    arguments. `checkQuota` fetches a fresh quota snapshot per call, scales the
    request by instance count, and returns `canLaunch: false` when headroom is
    unknown rather than turning a missing measurement into a green light.

- **Bedrock binding** (`./bedrock` subpath, the only place the AWS SDK is
  imported): `bedrockConverse`, `bedrockConverseStream` (with an `onText` delta
  callback), and `listModels`. `modelId` is required and never defaulted.
  `temperature` defaults to 0. `listModels` reports what **exists**, documented
  as not being a statement about what access has been *granted*.

- Packaging mirrors the sibling `-ts` libraries: subpath `exports` (`.` +
  `./bedrock`), `build:lib`, `prepare`, Trusted-Publishing `publish.yml`, CI,
  TypeDoc, and an import-graph isolation test proving the default entry cannot
  reach an `@aws-sdk/*` import.

### Notes

- Bedrock inference is **billable in the caller's own account**. Nothing in this
  repository calls it during tests, and nothing calls it implicitly. The live
  check is manual and opt-in — see `docs/live-bedrock.md`.

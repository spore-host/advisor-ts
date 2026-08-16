# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**advisor-ts stays on `0.x.y` indefinitely.** There is no planned 1.0.0, so
breaking changes bump the MINOR version — permanently, not as a pre-release
convention. Read a MINOR bump as "may break you" for the life of the project.

Its version line is **its own**, as with every spore.host `-ts` library. Unlike
spawn-ts / truffle-ts / lagotto-ts, advisor-ts has **no Go original**, so it makes
no parity claim at all — there is nothing to be at parity with.

## [Unreleased]

### Fixed
- **A pin's version comment can no longer silently misstate what CI runs.**
  `src/ci-hygiene.test.ts` required only that *some* `# vN` comment be present,
  never that it was true. A wrong label is worse than a missing one: it makes a
  major-version jump read as a routine same-line bump. Not hypothetical —
  Dependabot bumped nf-spawn's `checkout` pin to a **v7.0.1** SHA while leaving the
  comment reading `# v6`, and the identical pattern passed it. Two complementary
  halves now, because neither alone suffices: the test requires an exact `vX.Y.Z`
  (offline, hermetic — catches vague labels), and a new `scripts/verify-pins.sh`
  resolves each SHA against the tag its comment claims and fails if they disagree
  (needs the network, so it runs as its own CI step — catches exact-but-false
  labels the offline half cannot see). This repo's pins were already exact and
  true, so nothing needed relabelling; the gate is what changed.

### Security
- **Every GitHub Actions ref is now pinned to a commit SHA, with Dependabot to
  bump the pins** ([#6](https://github.com/spore-host/advisor-ts/issues/6)). All 5 `uses:` refs were floating tags
  (`@v4`), and a tag is mutable — `@v4` means "whatever `v4` points at when the
  job runs." `actions/checkout@v6` genuinely moved (`df4cb1c` → `d23441a`) with no
  signal to consumers, so this is not hypothetical.
  - It matters most in `publish.yml`, which uses **npm Trusted Publishing**:
    `id-token: write` + OIDC authorizes publishing `@spore-host/advisor-ts`, so whatever runs in
    that job can publish as us — and unlike a leaked `NPM_TOKEN` there is nothing
    to rotate afterward. Nothing in this repo sat between an upstream tag being
    repointed and code executing with that authority.
  - A SHA alone would trade a mutable-tag hole for a staleness one — pins never
    move, including past a security fix — so a new `.github/dependabot.yml` bumps
    them weekly with a 7-day cooldown (a freshly published tag is exactly when a
    compromised one is still unnoticed) and covers `npm` dependencies too. Its
    group pattern is `*`, not `actions/*`, so the first action from outside
    `actions/` can't silently fall outside the group.
  - `src/ci-hygiene.test.ts` makes both halves regressions rather than
    conventions — reverting a pin or dropping the Dependabot entry now fails
    `npm test`. `yaml` becomes a dev dependency for it; `"files": ["dist"]` and the
    `tsconfig.build.json` test exclusion keep it out of the published package.
  No runtime change — CI wiring and tests only.

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

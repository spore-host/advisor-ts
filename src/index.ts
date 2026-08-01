// Public API for advisor-ts — the SDK-FREE entry.
//
// advisor-ts answers a researcher's real questions ("what should I run this on?",
// "what will it cost?") by calling the spore.host browser-native libraries as
// tools. The division of labour is the design:
//
//   - tools own every hardware fact — instance types, prices, quota, capacity
//   - the model owns workload → hardware characteristics, and says it's inferring
//   - a check that failed or could not run is stated as a gap, never omitted
//
// Nothing reachable from this entry imports the AWS SDK (asserted by
// src/core/isolation.test.ts), so a browser bundle that only needs the pure core
// pays nothing for Bedrock. The Bedrock binding lives behind "./bedrock":
//
//   import { ask, buildToolset } from "@spore-host/advisor-ts";
//   import { bedrockConverse } from "@spore-host/advisor-ts/bedrock";
//
// Bedrock inference is billable in the caller's own account. This library never
// calls it implicitly — a caller must construct a client and pass it in.

/** Library version, matching package.json. */
export const VERSION = "0.1.0";

// The domain model — the grounding contract as data.
export type {
  ExecutionShape,
  Provenance,
  WorkloadShape,
  ToolCallRecord,
  CitedFact,
  Proposal,
} from "./core/types.js";

// The tool-use loop. `converse` is injected, so the whole loop runs in tests
// against canned responses with no network and no credentials.
export { ask, toolSpecs } from "./core/advisor.js";
export type {
  AdvisorAnswer,
  AdvisorOptions,
  ConverseFn,
  ConverseRequest,
} from "./core/advisor.js";

// The tool registry. Read-only by design: there is no `launch` tool.
export { buildToolset, missingCapabilities, runTool } from "./core/tools.js";
export type { Tool, ToolOutcome } from "./core/tools.js";

// The backend seams. advisor-ts core never imports truffle-ts or lagotto-ts;
// backends arrive through these structural interfaces.
export type {
  AdvisorBackends,
  AdvisorAppEntry,
  AdvisorCapacityResult,
  AdvisorFindResult,
  AdvisorInstanceType,
  AdvisorQuotaVerdict,
  AdvisorSpotPrice,
  AppSource,
  CapacitySource,
  InstanceSource,
  LiveSource,
} from "./core/backends.js";

// Adapters binding the seams to the sibling libraries (they take the libraries'
// functions as arguments, so both stay peer/optional dependencies).
export {
  truffleInstanceSource,
  truffleAppSource,
  truffleLiveSource,
} from "./adapters/truffle.js";
export type {
  TruffleFind,
  TruffleInstanceOptions,
  TruffleAppOptions,
  TruffleLiveOptions,
  TruffleLiveFinderLike,
} from "./adapters/truffle.js";
export { lagottoCapacitySource } from "./adapters/lagotto.js";
export type { LagottoCapacityOptions, LagottoWatcherLike } from "./adapters/lagotto.js";

// Execution shape — pure, and the first question to answer.
export { recommendShape, looksGpuAccelerated } from "./core/shapes.js";
export type { ShapeInput, ShapeRecommendation } from "./core/shapes.js";

// Cost arithmetic over a tool-sourced price.
export { estimateCost, spotComparison, spotAdvice } from "./core/cost.js";
export type { CostInput, CostEstimate } from "./core/cost.js";

// The seed workload KB — an accuracy override, not the mechanism.
export {
  WorkloadCatalog,
  lookupWorkload,
  shapeFromEntry,
  knownWorkloads,
} from "./core/workloads.js";
export type { WorkloadEntry } from "./core/workloads.js";

// The system prompt — the grounding contract, in the one place the model reads.
export { systemPrompt } from "./core/prompt.js";
export type { PromptOptions } from "./core/prompt.js";

// Transcript types + pure reductions (including the streaming reducer).
export {
  messageText,
  toolUses,
  toolResultMessage,
  appendMessage,
  userMessage,
  gapsFromCalls,
  newStreamState,
  reduceStreamEvent,
  finishStream,
} from "./core/transcript.js";
export type {
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  Message,
  StopReason,
  ConverseResponse,
  StreamEvent,
  StreamState,
} from "./core/transcript.js";

// Tool-input validation (the JSON Schema subset).
export { validate } from "./core/schema.js";
export type { JsonSchema } from "./core/schema.js";

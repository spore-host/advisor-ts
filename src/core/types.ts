// Core domain types for advisor-ts. Nothing here imports the AWS SDK or Bedrock
// — the whole grounding contract is expressible in plain data, which is what
// makes it testable without credentials.

/**
 * How a workload runs across machines. This is the first question a researcher
 * actually has ("how do I run this?"), and it must be answered *before* instance
 * advice, because the shape changes which instance advice is even correct: an
 * array of 500 independent tasks wants a cheap type × 500 on spot, while an MPI
 * job wants one AZ, a placement group, and EFA.
 */
export type ExecutionShape = "single-node" | "job-array" | "mpi";

/**
 * Where a claim came from. The single most important field in this library: an
 * instance type, price, or quota number is only trustworthy if a tool produced
 * it, and a workload characterisation is only honest if it's marked as a guess.
 *
 * - `tool` — returned by a tool call. Cite it.
 * - `catalog` — a verified seed-KB entry, citable via its `provenance`.
 * - `inferred` — the model's own knowledge. Legitimate for workload shape,
 *   never acceptable for a number.
 */
export type Provenance = "tool" | "catalog" | "inferred";

/**
 * The hardware character of a workload — what it *needs*, independent of which
 * instance types happen to exist. The model may supply this; the tools then turn
 * it into real types. Keeping the two apart is the whole design.
 */
export interface WorkloadShape {
  /** Free-text workload name as the user said it, e.g. "gromacs". */
  workload: string;
  shape: ExecutionShape;
  /** Why this shape — stated so a user who knows better can correct the premise. */
  rationale: string;
  gpuAccelerated: boolean;
  /** True when the code scales across nodes over a low-latency fabric. */
  multiNode: boolean;
  /** Whether EFA is warranted. Only meaningful when `multiNode`. */
  efa: boolean;
  /** True when performance is bound by memory bandwidth/capacity, not FLOPs. */
  memoryBound: boolean;
  /** Where this characterisation came from — the field a UI must surface. */
  provenance: Provenance;
  /** For a `catalog` shape: the citation for the entry. */
  citation?: string;
}

/**
 * One tool invocation and its outcome. A *failed* call is recorded, not dropped:
 * the invariant this library inherits from Go #63 is that an error must never be
 * indistinguishable from an absence of data.
 */
export interface ToolCallRecord {
  tool: string;
  input: unknown;
  /** Present on success. */
  output?: unknown;
  /** Present on failure — surfaced to the user as a stated gap. */
  error?: string;
}

/** A hardware fact with its source attached, so an answer can cite it. */
export interface CitedFact {
  /** What the fact is about, e.g. "p5.48xlarge" or "us-east-1 P quota". */
  subject: string;
  /** The fact itself, already formatted, e.g. "$55.04/hr on-demand". */
  statement: string;
  /** Which tool produced it. Absent only when `provenance` is `inferred`. */
  tool?: string;
  provenance: Provenance;
}

/**
 * A serializable proposal — the advisor's real output type. Deliberately NOT a
 * string: the direction this aims at is a launchable template (execution shape +
 * sizing + TTL + data bindings), and a string can't grow into one. v0.1.0 renders
 * it as advice; a later version hands it to spawn-ts as a LaunchSpec.
 */
export interface Proposal {
  /** The inferred-or-cited workload characterisation this rests on. */
  workload: WorkloadShape;
  /** Recommended instance types, best first. Always tool-sourced. */
  instanceTypes: string[];
  /** How many instances the shape implies (1 for single-node). */
  count: number;
  /** On-demand $/hr for one instance, when a pricing tool returned it. */
  pricePerHour?: number;
  /** Estimated total cost for the stated duration, when both are known. */
  estimatedCost?: number;
  /** Hours the estimate assumes. Absent when the user gave no duration. */
  durationHours?: number;
  /** Whether spot is recommended, and why. */
  spot?: { recommended: boolean; reason: string };
  /** Every hardware claim, with its source. */
  facts: CitedFact[];
  /**
   * Things the advisor could not establish — a failed tool call, a missing quota,
   * an unverified workload. Never empty just because nothing went well: silence
   * here means "everything was checked", so it must be earned.
   */
  gaps: string[];
}

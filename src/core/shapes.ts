// Execution-shape recommendation — the pure heuristic behind the
// `recommend_shape` tool. Answers "how do I run this?" (single node, job array,
// or MPI) from a description, before any instance advice, because the shape
// changes which instance advice is correct.
//
// This is deliberately a small keyword classifier, not a model call. Two reasons:
// it's testable without credentials, and the model already gets to *describe* the
// workload — letting it also decide the shape would remove the one place a
// deterministic rule can disagree with it. When the description is genuinely
// uninformative, the honest answer is the conservative one plus a stated reason,
// not a confident guess.

import type { ExecutionShape } from "./types.js";

/** Inputs a caller (or the model, via the tool) supplies. */
export interface ShapeInput {
  /** How the work was described, e.g. "500 independent docking runs". */
  description: string;
  /** Number of independent tasks, when the user said. */
  taskCount?: number;
  /** True when the caller already knows the code uses MPI. */
  mpi?: boolean;
  /** True when the caller already knows it's GPU-accelerated. */
  gpu?: boolean;
}

/** The recommendation: a shape, its reason, and the fabric consequence. */
export interface ShapeRecommendation {
  shape: ExecutionShape;
  /** Why — always populated, so the premise is correctable. */
  rationale: string;
  /** Whether EFA is warranted. Only ever true for `mpi`. */
  efa: boolean;
  /** Instances the shape implies; 1 unless a task count says otherwise. */
  count: number;
  /**
   * True when the shape came from an explicit signal rather than a guess. A
   * low-confidence recommendation must not read like a high-confidence one.
   */
  confident: boolean;
}

// Tightly-coupled parallelism: ranks exchange data every step, so latency
// between them is the bottleneck — this is what EFA exists for.
const mpiWords = [
  "mpi", "mpirun", "srun", "openmpi", "mpich", "intel mpi", "impi",
  "tightly coupled", "tightly-coupled", "domain decomposition", "halo exchange",
  "collective", "allreduce", "multi-node", "multinode", "across nodes",
  "distributed training", "cfd", "weather", "climate model", "lattice",
];

// Independent work: no inter-task communication, so it's a fan-out and spot is
// nearly free money (a lost task is re-run, not a lost job).
const arrayWords = [
  "job array", "array job", "embarrassingly parallel", "embarassingly parallel",
  "independent", "independently", "parameter sweep", "sweep", "each sample",
  "per sample", "per file", "batch of", "many runs", "replicate", "replicates",
  "monte carlo", "ensemble", "screening", "docking", "one per", "fan out",
  "fan-out", "scatter",
];

const gpuWords = [
  "gpu", "cuda", "gpus", "accelerated", "accelerator", "tensor", "nvidia",
  "training", "fine-tune", "fine tune", "finetune", "inference", "deep learning",
  "neural", "pytorch", "tensorflow", "jax",
];

const singleWords = [
  "single node", "single-node", "one machine", "one node", "interactive",
  "notebook", "jupyter", "desktop", "visuali", "shared memory", "shared-memory",
  "openmp", "threaded", "one big",
];

/** How many words from `list` appear in `text`. */
function hits(text: string, list: string[]): string[] {
  return list.filter((w) => text.includes(w));
}

/**
 * Recommend an execution shape. Pure — no I/O, no model, no SDK.
 *
 * Precedence is deliberate and reflects cost of being wrong. MPI first: running
 * an MPI job as an array silently produces garbage (ranks that can't reach each
 * other), whereas running an array as MPI merely wastes money. An explicit task
 * count > 1 then implies an array. Everything else is single-node, which is the
 * safe default because it's the only shape that can't fail structurally.
 */
export function recommendShape(input: ShapeInput): ShapeRecommendation {
  const text = input.description.toLowerCase();
  const mpiHits = hits(text, mpiWords);
  const arrayHits = hits(text, arrayWords);
  const gpuHits = hits(text, gpuWords);
  const singleHits = hits(text, singleWords);
  const count = input.taskCount ?? 0;

  // Explicit MPI beats everything, including a task count — "500 MPI ranks" is
  // one job of 500 ranks, not 500 jobs.
  if (input.mpi === true || mpiHits.length > 0) {
    const why = input.mpi === true
      ? "the caller stated the code uses MPI"
      : `the description mentions ${quote(mpiHits)}`;
    return {
      shape: "mpi",
      // EFA is asserted for every MPI job: the whole point of the shape is
      // inter-rank latency, and the downside of EFA on a job that didn't need it
      // is a narrower instance choice, not a wrong result.
      efa: true,
      count: count > 1 ? count : 2,
      confident: true,
      rationale:
        `Tightly-coupled parallel work — ${why}. Ranks exchange data as they run, ` +
        `so they need one placement group in a single AZ and an EFA fabric; ` +
        `splitting them into independent tasks would break the job, not just slow it.`,
    };
  }

  if (count > 1 || arrayHits.length > 0) {
    const why = count > 1
      ? `${count} independent tasks were requested`
      : `the description mentions ${quote(arrayHits)}`;
    return {
      shape: "job-array",
      efa: false,
      count: count > 1 ? count : 0,
      confident: true,
      rationale:
        `Independent tasks with no communication between them — ${why}. ` +
        `Run as an indexed job array: each task gets its own instance, they can ` +
        `land in any AZ, and spot is a good fit because a reclaimed task is re-run ` +
        `rather than losing the whole job.`,
    };
  }

  if (singleHits.length > 0 || gpuHits.length > 0) {
    const why = singleHits.length > 0
      ? `the description mentions ${quote(singleHits)}`
      : `the work is GPU-accelerated (${quote(gpuHits)}) with no sign of scaling across nodes`;
    return {
      shape: "single-node",
      efa: false,
      count: 1,
      confident: true,
      rationale: `One machine — ${why}. Size the node to the job rather than adding nodes.`,
    };
  }

  // Nothing in the description settled it. Say so: a guess presented as a finding
  // is the failure mode this library exists to avoid.
  return {
    shape: "single-node",
    efa: false,
    count: 1,
    confident: false,
    rationale:
      "Defaulting to a single node: the description didn't say whether the work " +
      "splits into independent tasks or runs as one tightly-coupled job. " +
      "That's a guess, not a finding — say how many tasks there are, or whether " +
      "the code uses MPI, and this changes.",
  };
}

/** True when GPU words appear — used to seed a WorkloadShape's gpuAccelerated. */
export function looksGpuAccelerated(description: string): boolean {
  return hits(description.toLowerCase(), gpuWords).length > 0;
}

function quote(words: string[]): string {
  return words.slice(0, 3).map((w) => `"${w}"`).join(", ");
}

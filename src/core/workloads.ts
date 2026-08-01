// A small seed KB of VERIFIED workload shapes.
//
// This file is deliberately tiny, and that is the design, not a TODO. There is no
// structured data for computational workloads anywhere in the spore.host repos —
// libs/catalog holds six *interactive visualization* apps and nothing else — so a
// researcher will name a code this KB has never heard of nearly every time. The
// uncatalogued case is the NORMAL path.
//
// Chasing coverage by enumerating scientific software is an unwinnable treadmill,
// and it would make answer quality a function of how recently someone edited a
// list. So the division of labour is:
//
//   - the TOOLS own every fact about hardware (types, prices, quota) — never the model
//   - the MODEL owns workload → hardware characteristics, which it genuinely knows
//     for thousands of codes
//   - this KB is an accuracy OVERRIDE for the handful where we hold a verified,
//     citable opinion — not the mechanism by which the advisor works
//
// Every entry therefore carries a `provenance` string naming its source. An entry
// with no citable source does not belong here; it belongs to model inference,
// which at least labels itself as inference.

import type { WorkloadShape } from "./types.js";

/** A KB entry: a workload shape plus the citation that justifies it. */
export interface WorkloadEntry extends Omit<WorkloadShape, "workload" | "provenance"> {
  /** Canonical lowercase name. */
  name: string;
  /** Other names users type for the same code. */
  aliases?: string[];
  /**
   * Where this opinion comes from — a doc, benchmark, or vendor guide. Required:
   * an uncited entry is indistinguishable from a guess, and a guess dressed as a
   * catalog hit is worse than an honest inference.
   */
  provenance: string;
  /** Instance families worth recommending, best first, WITH a reason. */
  families?: { families: string[]; reason: string };
}

/**
 * The seed KB. Six entries covering distinct scaling characters, chosen so the
 * override mechanism is exercised across all of them rather than clustering on
 * one shape.
 */
export const WorkloadCatalog: WorkloadEntry[] = [
  {
    name: "gromacs",
    aliases: ["gmx"],
    shape: "single-node",
    rationale:
      "GPU-resident MD: since 2020 GROMACS offloads the full force calculation, " +
      "PME included, so one fat GPU node usually beats several thinner ones. " +
      "Multi-node scaling exists but needs a large system to pay for the halo exchange.",
    gpuAccelerated: true,
    multiNode: false,
    efa: false,
    memoryBound: false,
    provenance: "GROMACS 2024 user guide, 'Getting good performance from mdrun' (GPU offload of PME)",
    families: {
      families: ["p5", "p4d", "g6e"],
      reason: "one node with a high-VRAM NVIDIA card; GROMACS wants GPU throughput, not node count",
    },
  },
  {
    name: "openfoam",
    shape: "mpi",
    rationale:
      "Finite-volume CFD by domain decomposition — subdomains exchange halo cells " +
      "every timestep, so inter-rank latency sets the wall clock.",
    gpuAccelerated: false,
    multiNode: true,
    efa: true,
    memoryBound: true,
    provenance: "OpenFOAM v12 User Guide §3.4 (decomposePar / parallel running)",
    families: {
      families: ["hpc7a", "hpc6a", "c7i"],
      reason: "EFA-capable HPC families; memory bandwidth per core matters more than clock",
    },
  },
  {
    name: "wrf",
    aliases: ["weather research and forecasting"],
    shape: "mpi",
    rationale:
      "Grid-based atmospheric model with per-timestep halo exchange across a " +
      "decomposed domain. Scales to many nodes and is bandwidth-hungry.",
    gpuAccelerated: false,
    multiNode: true,
    efa: true,
    memoryBound: true,
    provenance: "WRF ARW Technical Note (NCAR/TN-556+STR), parallel decomposition",
    families: {
      families: ["hpc7a", "hpc6a"],
      reason: "EFA plus high memory bandwidth per core; WRF is bandwidth-bound before it is FLOP-bound",
    },
  },
  {
    name: "blast",
    aliases: ["blastn", "blastp", "blastx", "ncbi-blast"],
    shape: "job-array",
    rationale:
      "Sequence search over independent queries — split the query set and run the " +
      "pieces separately. No communication between tasks at all.",
    gpuAccelerated: false,
    multiNode: false,
    efa: false,
    memoryBound: true,
    provenance: "NCBI BLAST+ user manual, query splitting / -num_threads guidance",
    families: {
      families: ["r7i", "r7a", "m7i"],
      reason: "memory-resident databases: fit the DB in RAM and the search becomes CPU-bound",
    },
  },
  {
    name: "alphafold",
    aliases: ["alphafold2", "alphafold3", "af2"],
    shape: "single-node",
    rationale:
      "Two very different phases on one node: a CPU/IO-heavy MSA search, then a " +
      "GPU inference pass whose VRAM need grows with sequence length.",
    gpuAccelerated: true,
    multiNode: false,
    efa: false,
    memoryBound: true,
    provenance: "DeepMind AlphaFold README (hardware requirements: 1 GPU, ~3 TB DB, high-RAM MSA stage)",
    families: {
      families: ["p4d", "g6e", "p5"],
      reason: "a large-VRAM card for long sequences, plus enough system RAM and fast local disk for the MSA stage",
    },
  },
  {
    name: "llm-finetune",
    aliases: ["fine-tune", "finetune", "lora", "qlora", "llm training"],
    shape: "single-node",
    rationale:
      "Fine-tuning fits on one multi-GPU node until the model no longer does. " +
      "Below that point, NVLink inside a node beats a network between nodes; " +
      "above it the shape becomes multi-node with EFA.",
    gpuAccelerated: true,
    multiNode: false,
    efa: false,
    memoryBound: false,
    provenance: "NVIDIA multi-GPU training guidance (intra-node NVLink vs inter-node fabric)",
    families: {
      families: ["p5", "p5e", "p4de"],
      reason: "8 NVLink-connected high-VRAM cards in one node; go multi-node + EFA only when the model won't fit",
    },
  },
];

const byName = new Map<string, WorkloadEntry>();
for (const e of WorkloadCatalog) {
  byName.set(e.name, e);
  for (const a of e.aliases ?? []) byName.set(a, e);
}

/**
 * Look up a verified workload shape. Returns `undefined` for a miss — which is
 * the common case and NOT an error. A miss means the caller should fall back to
 * model inference and label it as such; it must never be smoothed into a
 * confident-looking catalog answer.
 */
export function lookupWorkload(name: string): WorkloadEntry | undefined {
  return byName.get(name.trim().toLowerCase());
}

/** Turn a KB entry into a `WorkloadShape` carrying `catalog` provenance + citation. */
export function shapeFromEntry(entry: WorkloadEntry, asked: string): WorkloadShape {
  return {
    workload: asked,
    shape: entry.shape,
    rationale: entry.rationale,
    gpuAccelerated: entry.gpuAccelerated,
    multiNode: entry.multiNode,
    efa: entry.efa,
    memoryBound: entry.memoryBound,
    provenance: "catalog",
    citation: entry.provenance,
  };
}

/** Every canonical name in the KB (for diagnostics + docs). */
export function knownWorkloads(): string[] {
  return WorkloadCatalog.map((e) => e.name);
}

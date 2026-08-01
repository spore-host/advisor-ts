import { describe, it, expect } from "vitest";
import { WorkloadCatalog, knownWorkloads, lookupWorkload, shapeFromEntry } from "./workloads.js";

describe("lookupWorkload", () => {
  it("finds a seeded workload", () => {
    const e = lookupWorkload("gromacs")!;
    expect(e.shape).toBe("single-node");
    expect(e.gpuAccelerated).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(lookupWorkload("  GROMACS ")!.name).toBe("gromacs");
  });

  it("resolves aliases to the canonical entry", () => {
    expect(lookupWorkload("gmx")!.name).toBe("gromacs");
    expect(lookupWorkload("blastp")!.name).toBe("blast");
    expect(lookupWorkload("qlora")!.name).toBe("llm-finetune");
  });

  it("returns undefined for a miss — the common case, not an error", () => {
    // The whole design rests on this: the KB is deliberately small, so a miss is
    // the normal path and must be representable without throwing.
    expect(lookupWorkload("lammps")).toBeUndefined();
    expect(lookupWorkload("some-in-house-fortran-code")).toBeUndefined();
  });
});

describe("the seed KB's invariants", () => {
  it("every entry cites a source", () => {
    // An uncited entry is indistinguishable from a guess, and a guess dressed as a
    // catalog hit is worse than an honest inference.
    for (const e of WorkloadCatalog) {
      expect(e.provenance.length, e.name).toBeGreaterThan(10);
    }
  });

  it("every entry explains its shape", () => {
    for (const e of WorkloadCatalog) {
      expect(e.rationale.length, e.name).toBeGreaterThan(40);
    }
  });

  it("EFA is only claimed for multi-node entries", () => {
    for (const e of WorkloadCatalog) {
      if (e.efa) expect(e.multiNode, e.name).toBe(true);
    }
  });

  it("every multi-node entry uses the mpi shape", () => {
    for (const e of WorkloadCatalog) {
      if (e.multiNode) expect(e.shape, e.name).toBe("mpi");
    }
  });

  it("every family recommendation carries a reason", () => {
    for (const e of WorkloadCatalog) {
      if (e.families) expect(e.families.reason.length, e.name).toBeGreaterThan(20);
    }
  });

  it("stays small — coverage is not the mechanism", () => {
    // A guard against the treadmill this design exists to avoid. If this fails,
    // someone is enumerating scientific software; the answer is better inference
    // labelling, not more entries.
    expect(WorkloadCatalog.length).toBeLessThan(25);
  });

  it("has no duplicate names or aliases", () => {
    const seen = new Set<string>();
    for (const e of WorkloadCatalog) {
      for (const n of [e.name, ...(e.aliases ?? [])]) {
        expect(seen.has(n), `duplicate: ${n}`).toBe(false);
        seen.add(n);
      }
    }
  });

  it("covers more than one execution shape", () => {
    expect(new Set(WorkloadCatalog.map((e) => e.shape)).size).toBeGreaterThan(1);
  });
});

describe("shapeFromEntry", () => {
  it("marks provenance as catalog and carries the citation", () => {
    const shape = shapeFromEntry(lookupWorkload("openfoam")!, "OpenFOAM");
    expect(shape.provenance).toBe("catalog");
    expect(shape.citation).toMatch(/OpenFOAM/);
    // The user's own wording is preserved, so the answer echoes what they asked.
    expect(shape.workload).toBe("OpenFOAM");
    expect(shape.efa).toBe(true);
  });
});

describe("knownWorkloads", () => {
  it("lists canonical names only", () => {
    const names = knownWorkloads();
    expect(names).toContain("gromacs");
    expect(names).not.toContain("gmx");
  });
});

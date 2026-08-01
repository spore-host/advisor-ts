import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION } from "./index.js";

describe("library scaffold", () => {
  // VERSION is a hand-maintained constant, so every release has to remember to
  // update it in two places. truffle-ts had the identical constant and its 0.5.0
  // bump missed it — caught only because that repo has this assertion. lagotto-ts
  // then got the same guard, and it duly failed on its 0.2.0 bump. This is the
  // third copy, added before advisor-ts's first version bump rather than after it.
  //
  // A stale VERSION fails quietly rather than loudly: a consumer logging it for a
  // bug report names the wrong release, and the wrong changelog gets read.
  it("exports a VERSION matching package.json", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

import { describe, it, expect } from "vitest";
import { validate, type JsonSchema } from "./schema.js";

const schema: JsonSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    hours: { type: "number", minimum: 0 },
    count: { type: "integer", minimum: 1, maximum: 25 },
    spot: { type: "boolean" },
    sort: { type: "string", enum: ["cheapest", "newest"] },
    types: { type: "array", items: { type: "string" } },
  },
  required: ["query"],
};

describe("validate", () => {
  it("accepts valid input", () => {
    expect(validate({ query: "h100", hours: 4, count: 2, spot: true, sort: "cheapest" }, schema)).toEqual([]);
  });

  it("accepts input with only the required fields", () => {
    expect(validate({ query: "h100" }, schema)).toEqual([]);
  });

  it("reports a missing required field", () => {
    expect(validate({ hours: 3 }, schema)).toContain("input.query: required");
  });

  it("rejects a stringified number rather than coercing it", () => {
    // Deliberate: coercing "4" → 4 teaches the model that loose types work, and a
    // silent coercion of a PRICE is where that habit does damage.
    const errs = validate({ query: "x", hours: "4" }, schema);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/expected a number, got a string \("4"\)/);
  });

  it("rejects an unknown property and lists the valid ones", () => {
    // A model that invents a key has misunderstood the tool. Dropping the key
    // silently would run the handler on defaults and return a plausible answer.
    const errs = validate({ query: "x", instanceTye: "p5.48xlarge" }, schema);
    expect(errs[0]).toMatch(/unknown property/);
    expect(errs[0]).toMatch(/query/);
  });

  it("reports every problem at once, not just the first", () => {
    // One round-trip per typo is slow AND billable.
    const errs = validate({ hours: "x", count: 99, bogus: 1 }, schema);
    expect(errs.length).toBeGreaterThanOrEqual(4);
  });

  it("enforces enum membership", () => {
    expect(validate({ query: "x", sort: "fastest" }, schema)[0]).toMatch(/is not one of: cheapest, newest/);
  });

  it("enforces minimum and maximum", () => {
    expect(validate({ query: "x", count: 0 }, schema)[0]).toMatch(/below the minimum 1/);
    expect(validate({ query: "x", count: 99 }, schema)[0]).toMatch(/above the maximum 25/);
  });

  it("enforces integrality", () => {
    expect(validate({ query: "x", count: 2.5 }, schema)[0]).toMatch(/expected a whole number/);
  });

  it("rejects an explicit null for a required field", () => {
    // An explicit null reaches the handler as a value, unlike an omitted optional.
    expect(validate({ query: null }, schema)).toContain("input.query: required");
  });

  it("rejects NaN as a number", () => {
    expect(validate({ query: "x", hours: NaN }, schema)[0]).toMatch(/expected a number/);
  });

  it("validates array items and reports the index", () => {
    const errs = validate({ query: "x", types: ["p5.48xlarge", 7] }, schema);
    expect(errs[0]).toMatch(/input\.types\[1\]/);
  });

  it("rejects a non-object at the top level", () => {
    expect(validate("just a string", schema)[0]).toMatch(/expected an object/);
    expect(validate(null, schema)[0]).toMatch(/expected an object/);
    expect(validate([1, 2], schema)[0]).toMatch(/expected an object/);
  });

  it("rejects a non-boolean for a boolean field", () => {
    expect(validate({ query: "x", spot: "yes" }, schema)[0]).toMatch(/expected true or false/);
  });
});

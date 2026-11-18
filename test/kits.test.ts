import { describe, expect, it } from "vitest";

import {
  FeatureKitSchema,
  InvestigationKitSchema,
  KIT_FIELDS,
  KIT_SCHEMAS,
  KIT_SHAPES,
  QuestionKitSchema,
  TICKET_KINDS,
  evaluateKit,
  meaningful,
  usefulEvidence,
} from "../src/core/kits.js";
import { completeBugKit } from "./helpers.js";

describe("meaningful", () => {
  it("treats values that only describe an absence as empty", () => {
    for (const value of ["unknown", " N/A ", "-", "?", "Not provided", "don't know"]) {
      expect(meaningful(value)).toBe("");
    }
  });

  it("matches the whole value, not a substring", () => {
    expect(meaningful("the cause is unknown to the user")).toBe("the cause is unknown to the user");
  });
});

describe("usefulEvidence", () => {
  it("drops an item whose value is the absence marker", () => {
    expect(usefulEvidence([{ kind: "screenshot", value: "unknown" }])).toEqual([]);
  });
});

describe("evaluateKit: BUG", () => {
  it("accepts a complete kit", () => {
    expect(evaluateKit("BUG", completeBugKit())).toEqual({ complete: true, missing: [], warnings: [] });
  });

  it("reports an empty kit as missing every blocking field, in canonical order", () => {
    const result = evaluateKit("BUG", completeBugKit({
      location: "", steps: [], expected: "", actual: "", scope: { breadth: "unknown" }, evidence: [],
    }));
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["location", "steps", "expected", "actual", "scope", "evidence"]);
  });

  it("needs at least two real steps", () => {
    expect(evaluateKit("BUG", completeBugKit({ steps: ["open the reports page"] })).missing).toEqual(["steps"]);
    expect(evaluateKit("BUG", completeBugKit({ steps: ["open the page", "click"] })).missing).toEqual(["steps"]);
  });

  it("does not let a field filled with an absence marker pass the length check", () => {
    const result = evaluateKit("BUG", completeBugKit({ location: "unknown", expected: "not provided" }));
    expect(result.missing).toEqual(["location", "expected"]);
  });

  it("blocks on 'one customer' when nobody said which", () => {
    expect(evaluateKit("BUG", completeBugKit({ scope: { breadth: "one_customer" } })).missing).toEqual(["scope"]);
    expect(
      evaluateKit("BUG", completeBugKit({ scope: { breadth: "one_customer", customerRef: "Birchwood Clinic" } })).complete,
    ).toBe(true);
  });

  it("does not accept the absence marker as evidence", () => {
    const result = evaluateKit("BUG", completeBugKit({ evidence: [{ kind: "screenshot", value: "unknown" }] }));
    expect(result.missing).toEqual(["evidence"]);
  });

  it("accepts a real reason in place of evidence", () => {
    const kit = completeBugKit({ evidence: [], noEvidenceReason: "the error no longer shows up" });
    expect(evaluateKit("BUG", kit).complete).toBe(true);
  });

  it("turns prioritisation fields into warnings, never into questions", () => {
    const result = evaluateKit("BUG", completeBugKit({
      role: "unknown", occurredAt: "unknown", frequency: "unknown", impact: "",
    }));
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.warnings).toHaveLength(4);
  });

  it("warns on a date that cannot be parsed", () => {
    const result = evaluateKit("BUG", completeBugKit({ occurredAt: "sometime last week" }));
    expect(result.complete).toBe(true);
    expect(result.warnings.join(" ")).toContain("occurredAt");
  });
});

describe("evaluateKit: INVESTIGATION", () => {
  const complete = InvestigationKitSchema.parse({
    subject: "why did the nightly imports fail",
    target: { kind: "integration", ref: "calendar connector" },
    period: "between Jan 10 and Jan 12",
    deliverable: "root_cause",
  });

  it("does not block on evidence: people asking for a summary rarely have a screenshot", () => {
    const result = evaluateKit("INVESTIGATION", complete);
    expect(result.complete).toBe(true);
    expect(result.warnings.join(" ")).toContain("no evidence");
  });

  it("does not block on a target with no identifier: finding it is often the request", () => {
    const kit = InvestigationKitSchema.parse({ ...complete, target: { kind: "customer" } });
    const result = evaluateKit("INVESTIGATION", kit);
    expect(result.complete).toBe(true);
    expect(result.warnings.join(" ")).toContain("no identifier");
  });

  it("blocks on subject, target kind, period and deliverable", () => {
    expect(evaluateKit("INVESTIGATION", InvestigationKitSchema.parse({})).missing).toEqual([
      "subject", "target", "period", "deliverable",
    ]);
  });
});

describe("evaluateKit: QUESTION and FEATURE", () => {
  it("a question needs the question and where it applies", () => {
    expect(evaluateKit("QUESTION", QuestionKitSchema.parse({})).missing).toEqual(["question", "location"]);
    const kit = QuestionKitSchema.parse({ question: "How do I archive a project?", location: "/projects" });
    expect(evaluateKit("QUESTION", kit).complete).toBe(true);
  });

  it("a feature request is workable without an impact statement", () => {
    const kit = FeatureKitSchema.parse({
      problem: "we re-type the same task list every month",
      desiredOutcome: "save a task list as a template",
    });
    const result = evaluateKit("FEATURE", kit);
    expect(result.complete).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("kit specs stay in step with the schemas", () => {
  it.each(TICKET_KINDS)("%s: every askable field exists in the schema", (kind) => {
    const schemaKeys = Object.keys(KIT_SCHEMAS[kind].shape);
    for (const { name } of KIT_FIELDS[kind]) expect(schemaKeys).toContain(name);
  });

  it.each(TICKET_KINDS)("%s: the shape shown to the model has exactly the schema's keys", (kind) => {
    expect(Object.keys(KIT_SHAPES[kind]).sort()).toEqual(Object.keys(KIT_SCHEMAS[kind].shape).sort());
  });
});

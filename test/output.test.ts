import { describe, expect, it } from "vitest";

import { evaluateOutput, gateStatus, parseTriageOutput } from "../src/core/output.js";
import { coerceTriageShape } from "../src/core/shape.js";
import { bugOutput, completeBugKit } from "./helpers.js";

function mustParse(raw: unknown, options = {}) {
  const parsed = parseTriageOutput(raw, options);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("the model cannot approve its own ticket", () => {
  it("refuses status READY with a message that explains the rule", () => {
    const parsed = parseTriageOutput(bugOutput({ status: "READY" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('cannot emit status "READY"');
  });

  it("refuses it in any casing", () => {
    expect(parseTriageOutput(bugOutput({ status: " ready " })).ok).toBe(false);
  });

  it("only code turns a ticket READY, and only from a complete kit", () => {
    const complete = mustParse(bugOutput());
    expect(gateStatus(complete, evaluateOutput(complete))).toBe("READY");

    const incomplete = mustParse(bugOutput({ kit: completeBugKit({ steps: [] }) }));
    expect(gateStatus(incomplete, evaluateOutput(incomplete))).toBe("NEEDS_INFO");
  });

  it("a model insisting the kit is complete changes nothing", () => {
    // Extra keys claiming completeness are rejected by the strict schema, not honoured.
    expect(parseTriageOutput(bugOutput({ complete: true })).ok).toBe(false);
  });
});

describe("parseTriageOutput", () => {
  it("requires a reason for a rejection", () => {
    const parsed = parseTriageOutput(bugOutput({ status: "REJECTED" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("triageNote");
  });

  it("accepts a rejection with a reason and maps it to REJECTED", () => {
    const output = mustParse(
      bugOutput({ status: "REJECTED", rejectionKind: "DUPLICATE", triageNote: "same report as ticket 12" }),
    );
    expect(gateStatus(output, evaluateOutput(output))).toBe("REJECTED");
  });

  it("rejects a kit of the wrong kind instead of half-accepting it", () => {
    const parsed = parseTriageOutput(bugOutput({ kind: "INVESTIGATION" }));
    expect(parsed.ok).toBe(false);
  });

  it("an empty kit still parses, so the gate can say what is missing", () => {
    const output = mustParse(bugOutput({ kit: {} }));
    expect(evaluateOutput(output).missing).toEqual(["location", "steps", "expected", "actual", "scope", "evidence"]);
  });

  it("maps an area outside the configured list to unknown", () => {
    expect(mustParse(bugOutput({ area: "Billing" }), { areas: ["web", "billing"] }).area).toBe("billing");
    expect(mustParse(bugOutput({ area: "kitchen" }), { areas: ["web", "billing"] }).area).toBe("unknown");
  });

  it("rejects non-objects without throwing", () => {
    expect(parseTriageOutput(null).ok).toBe(false);
    expect(parseTriageOutput("READY").ok).toBe(false);
    expect(parseTriageOutput([]).ok).toBe(false);
  });
});

describe("coerceTriageShape: fixes the container, never the content", () => {
  it("moves kit fields left at the root into the kit", () => {
    const { kit, ...envelope } = bugOutput();
    const output = mustParse({ ...envelope, ...(kit as object) });
    expect(output.kind).toBe("BUG");
    expect(evaluateOutput(output).complete).toBe(true);
  });

  it("turns a scope sentence into the scope object", () => {
    const scope = (value: string) =>
      (mustParse(bugOutput({ kit: { ...completeBugKit(), scope: value } })).kit as { scope: unknown }).scope;

    expect(scope("all customers")).toEqual({ breadth: "all" });
    expect(scope("several workspaces")).toEqual({ breadth: "several" });
    expect(scope("only one customer, Birchwood Clinic")).toEqual({
      breadth: "one_customer",
      customerRef: "only one customer, Birchwood Clinic",
    });
  });

  it("turns an unrecognisable scope into unknown, which becomes a question", () => {
    const output = mustParse(bugOutput({ kit: { ...completeBugKit(), scope: "hard to say" } }));
    expect(evaluateOutput(output).missing).toEqual(["scope"]);
  });

  it("turns bare evidence strings into typed items", () => {
    const output = mustParse(
      bugOutput({
        kit: {
          ...completeBugKit(),
          evidence: ["https://app.example.test/reports/7", "screenshot of the page", "TypeError: rows is undefined", "20250115-rem-88412"],
        },
      }),
    );
    expect((output.kit as { evidence: { kind: string }[] }).evidence.map((e) => e.kind)).toEqual([
      "url", "screenshot", "error", "record_id",
    ]);
  });

  it("splits steps written as one numbered string", () => {
    const output = mustParse(
      bugOutput({ kit: { ...completeBugKit(), steps: "1. open the reports page\n2. click the export button" } }),
    );
    expect((output.kit as { steps: string[] }).steps).toEqual(["open the reports page", "click the export button"]);
  });

  it("maps an unknown enum value to unknown instead of failing", () => {
    const output = mustParse(bugOutput({ kit: { ...completeBugKit(), frequency: "every other Tuesday" } }));
    expect((output.kit as { frequency: string }).frequency).toBe("unknown");
  });

  it("drops nulls so schema defaults apply", () => {
    expect(mustParse(bugOutput({ triageNote: null, kit: { ...completeBugKit(), impact: null } })).kit).toMatchObject({
      impact: "",
    });
  });

  it("is idempotent and leaves unrecognisable input alone", () => {
    const once = coerceTriageShape(bugOutput());
    expect(coerceTriageShape(once)).toEqual(once);
    expect(coerceTriageShape({ kind: "PIZZA", topping: "x" })).toEqual({ kind: "PIZZA", topping: "x" });
    expect(coerceTriageShape("nope")).toBe("nope");
  });

  it("never fills an empty field", () => {
    const output = mustParse(bugOutput({ kit: { ...completeBugKit(), expected: "" } }));
    expect((output.kit as { expected: string }).expected).toBe("");
  });
});

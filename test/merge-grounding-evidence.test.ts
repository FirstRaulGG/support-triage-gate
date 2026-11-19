import { describe, expect, it } from "vitest";

import { anchorKit } from "../src/core/anchor.js";
import { attachmentEvidence, reconcileEvidence, threadHasAttachment } from "../src/core/evidence.js";
import { distinctiveTokens, isGrounded, isNameGrounded } from "../src/core/grounding.js";
import { ATTACHMENT_MARKER, FeatureKitSchema, InvestigationKitSchema, evaluateKit } from "../src/core/kits.js";
import type { BugKit } from "../src/core/kits.js";
import { mergeKit } from "../src/core/merge.js";
import { completeBugKit } from "./helpers.js";

describe("mergeKit", () => {
  it("restores a known field the new extraction failed to re-confirm", () => {
    const oldKit = completeBugKit({ location: "/team/billing" });
    const newKit = completeBugKit({ location: "unknown" });
    const merged = mergeKit({ oldKind: "BUG", oldKit, newKind: "BUG", newKit }) as BugKit;

    expect(merged.location).toBe("/team/billing");
    expect(evaluateKit("BUG", merged).complete).toBe(true);
  });

  it("lets a present new value win, even when it is 'emptier'", () => {
    const oldKit = completeBugKit({ scope: { breadth: "one_customer", customerRef: "Birchwood Clinic" } });
    const newKit = completeBugKit({ scope: { breadth: "all" } });
    const merged = mergeKit({ oldKind: "BUG", oldKit, newKind: "BUG", newKit }) as BugKit;

    expect(merged.scope).toEqual({ breadth: "all" });
  });

  it("does not restore the old scope over a correction that is still missing the name", () => {
    // "it is several" -> later "actually just one customer", name not extracted. Restoring the old
    // scope would store a FALSE one that also looks complete; keeping the new one asks for the name.
    const oldKit = completeBugKit({ scope: { breadth: "several" } });
    const newKit = completeBugKit({ scope: { breadth: "one_customer" } });
    const merged = mergeKit({ oldKind: "BUG", oldKit, newKind: "BUG", newKit }) as BugKit;

    expect(merged.scope).toEqual({ breadth: "one_customer" });
    expect(evaluateKit("BUG", merged).missing).toEqual(["scope"]);
  });

  it("moves evidence and its reason together", () => {
    const oldKit = completeBugKit({ evidence: [], noEvidenceReason: "the error no longer shows up" });
    const newKit = completeBugKit({ evidence: [] });
    const merged = mergeKit({ oldKind: "BUG", oldKit, newKind: "BUG", newKit }) as BugKit;

    expect(merged.noEvidenceReason).toBe("the error no longer shows up");
    expect(evaluateKit("BUG", merged).complete).toBe(true);
  });

  it("restores advisory fields too, which the evaluator's missing list would never show", () => {
    const evidence = [{ kind: "record_id" as const, value: "run-20250115-88412" }];
    const base = { subject: "why did the nightly imports fail", target: { kind: "system" }, period: "last night", deliverable: "timeline" };
    const oldKit = InvestigationKitSchema.parse({ ...base, evidence });
    const newKit = InvestigationKitSchema.parse({ ...base, evidence: [] });

    const merged = mergeKit({ oldKind: "INVESTIGATION", oldKit, newKind: "INVESTIGATION", newKit });
    expect((merged as { evidence: unknown[] }).evidence).toEqual(evidence);
  });

  it("does not merge on the first triage, across kinds, or over a stale kit", () => {
    const newKit = completeBugKit({ location: "unknown" });
    expect(mergeKit({ oldKind: "BUG", oldKit: null, newKind: "BUG", newKit })).toBe(newKit);

    const feature = FeatureKitSchema.parse({ problem: "p".repeat(20), desiredOutcome: "d".repeat(20), impact: "an impact statement" });
    expect(mergeKit({ oldKind: "FEATURE", oldKit: feature, newKind: "BUG", newKit })).toBe(newKit);

    expect(mergeKit({ oldKind: "BUG", oldKit: { renamedField: 1 }, newKind: "BUG", newKit })).toBe(newKit);
  });
});

describe("isGrounded", () => {
  const thread = "Team billing page shows the wrong seat count after I remove a member.";

  it("accepts a paraphrase whose distinctive words are in the thread", () => {
    expect(isGrounded("the Team Billing page", thread)).toBe(true);
    expect(isGrounded("seat count is wrong after removing a member", thread)).toBe(true);
  });

  it("refuses a value that was never said", () => {
    expect(isGrounded("Birchwood Clinic", thread)).toBe(false);
    expect(isGrounded("/settings/integrations", thread)).toBe(false);
  });

  it("refuses when there is nothing distinctive to check", () => {
    expect(isGrounded("it is so", thread)).toBe(false);
    expect(isGrounded("", thread)).toBe(false);
  });

  it("ignores accents, case and punctuation, and keeps route segments", () => {
    expect(isGrounded("Résumé Façade", "the resume facade page shows an error")).toBe(true);
    expect(distinctiveTokens("/settings/billing?tab=2")).toEqual(["settings", "billing"]);
  });
});

describe("evidence comes from the thread, not from the model", () => {
  const withImage = `the chart is blank\n${ATTACHMENT_MARKER}`;

  it("adds the attachment when the model reported nothing usable", () => {
    expect(reconcileEvidence([], withImage)).toEqual([attachmentEvidence()]);
    expect(reconcileEvidence([{ kind: "screenshot", value: "unknown" }], withImage)).toEqual([attachmentEvidence()]);
  });

  it("removes evidence the model made up for a thread with no attachment", () => {
    expect(reconcileEvidence([{ kind: "screenshot", value: "unknown" }], "the chart is blank")).toEqual([]);
  });

  it("does not keep the model's description of a screenshot nobody attached", () => {
    const invented = [{ kind: "screenshot" as const, value: "screenshot of the blank chart" }];
    expect(reconcileEvidence(invented, "the chart is blank")).toEqual([]);
    expect(reconcileEvidence(invented, withImage)).toEqual([attachmentEvidence()]);
  });

  it("keeps a URL or a record id only when the reporter wrote it", () => {
    const url = { kind: "url" as const, value: "https://app.example.test/charts/7" };
    const id = { kind: "record_id" as const, value: "order #4821" };
    const thread = "the chart at https://app.example.test/charts/7 is blank for order 4821";

    expect(reconcileEvidence([url, id], thread)).toEqual([url, id]);
    expect(reconcileEvidence([url, id], "the chart is blank")).toEqual([]);
    expect(reconcileEvidence([{ ...url, value: "https://app.example.test/charts/8" }], thread)).toEqual([]);
  });

  it("keeps an error message that is quoted from the thread, even shortened", () => {
    const thread = "it says: Export failed, upstream timeout while reading workspace 12";
    expect(reconcileEvidence([{ kind: "error", value: "Export failed: upstream timeout" }], thread)).toHaveLength(1);
    expect(reconcileEvidence([{ kind: "error", value: "NullPointerException in ReportWriter" }], thread)).toEqual([]);
  });

  it("puts the attachment next to what the reporter quoted", () => {
    const url = { kind: "url" as const, value: "https://app.example.test/charts/7" };
    expect(reconcileEvidence([url], `${withImage}
https://app.example.test/charts/7`)).toEqual([attachmentEvidence(), url]);
  });

  it("detects the attachment marker", () => {
    expect(threadHasAttachment(withImage)).toBe(true);
    expect(threadHasAttachment("no image here")).toBe(false);
  });
});

describe("anchorKit: what the model may not make up", () => {
  const thread = "The export on the reports page is empty for Birchwood Clinic. It stopped showing after a reload.";

  it("drops a customer name the reporter never wrote, which reopens the scope question", () => {
    const kit = completeBugKit({ scope: { breadth: "one_customer", customerRef: "Northgate Dental" }, evidence: [] });
    const anchored = anchorKit("BUG", kit, thread) as BugKit;
    expect(anchored.scope).toEqual({ breadth: "one_customer" });
    expect(evaluateKit("BUG", anchored).missing).toContain("scope");
  });

  it("keeps a customer name the reporter wrote", () => {
    const kit = completeBugKit({ scope: { breadth: "one_customer", customerRef: "Birchwood Clinic" } });
    expect((anchorKit("BUG", kit, thread) as BugKit).scope.customerRef).toBe("Birchwood Clinic");
  });

  it("accepts a reason for having no evidence only in the reporter's words", () => {
    const real = completeBugKit({ evidence: [], noEvidenceReason: "it stopped showing after a reload" });
    expect(evaluateKit("BUG", anchorKit("BUG", real, thread)).complete).toBe(true);

    const invented = completeBugKit({ evidence: [], noEvidenceReason: "the customer deleted the screenshot" });
    expect(evaluateKit("BUG", anchorKit("BUG", invented, thread)).missing).toEqual(["evidence"]);
  });

  it("drops an investigation target nobody named", () => {
    const kit = InvestigationKitSchema.parse({
      subject: "why the nightly imports failed",
      target: { kind: "customer", ref: "Northgate Dental" },
      period: "last week",
      deliverable: "root_cause",
    });
    expect((anchorKit("INVESTIGATION", kit, thread) as { target: unknown }).target).toEqual({ kind: "customer" });
  });

  it("leaves kinds without evidence or names alone", () => {
    const kit = FeatureKitSchema.parse({ problem: "we retype the list", desiredOutcome: "templates" });
    expect(anchorKit("FEATURE", kit, thread)).toEqual(kit);
  });
});

describe("isNameGrounded", () => {
  it("accepts a short name written as whole words, which has no distinctive token", () => {
    expect(isGrounded("ACE", "only ACE sees it")).toBe(false);
    expect(isNameGrounded("ACE", "only ACE sees it")).toBe(true);
    expect(isNameGrounded("ACE", "the interface is broken")).toBe(false);
  });
});

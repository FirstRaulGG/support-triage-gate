import { describe, expect, it } from "vitest";

import { announcementVerdict, decideAnnouncementReply, looksLikeAnnouncement } from "../src/core/announcement.js";
import { ATTACHMENT_MARKER } from "../src/core/kits.js";
import { decideAutoReply, needsRetriage, replyOpening, shouldReply } from "../src/core/policy.js";
import type { PolicyMessage } from "../src/core/policy.js";
import { at } from "./helpers.js";

const inbound = (minute: number): PolicyMessage => ({ direction: "INBOUND", createdAt: at(minute) });
const outbound = (minute: number): PolicyMessage => ({ direction: "OUTBOUND", createdAt: at(minute) });

describe("shouldReply", () => {
  it("answers a first inbound message", () => {
    expect(shouldReply({ messages: [inbound(0)] })).toBe(true);
  });

  it("stays quiet with no messages", () => {
    expect(shouldReply({ messages: [] })).toBe(false);
  });

  it("does not ask again while the reporter is silent", () => {
    expect(shouldReply({ messages: [inbound(0), outbound(1)], lastOutboundAt: at(1) })).toBe(false);
  });

  it("does not answer its own answer", () => {
    expect(shouldReply({ messages: [inbound(0), outbound(5)], lastOutboundAt: at(5) })).toBe(false);
  });

  it("treats a tie as 'not answered'", () => {
    expect(shouldReply({ messages: [outbound(5), inbound(5)], lastOutboundAt: at(5) })).toBe(false);
  });

  it("answers when the reporter writes after our last reply", () => {
    expect(shouldReply({ messages: [inbound(0), outbound(1), inbound(2)], lastOutboundAt: at(1) })).toBe(true);
  });

  it("speaks after a re-triage only if there is something new to say", () => {
    const base = { messages: [inbound(0), outbound(1)], lastOutboundAt: at(1), triagedAt: at(3) };
    expect(shouldReply({ ...base, nextReply: "ask: location", lastReply: "ask: steps" })).toBe(true);
    expect(shouldReply({ ...base, nextReply: "ask:  steps ", lastReply: "ask: steps" })).toBe(false);
    expect(shouldReply({ ...base })).toBe(false);
  });

  it("ignores a re-triage that happened before we last spoke", () => {
    expect(
      shouldReply({
        messages: [inbound(0), outbound(4)],
        lastOutboundAt: at(4),
        triagedAt: at(3),
        nextReply: "new",
        lastReply: "old",
      }),
    ).toBe(false);
  });
});

describe("replyOpening", () => {
  it("distinguishes first contact, an answer, and our own change of mind", () => {
    expect(replyOpening({ messages: [inbound(0)] })).toBe("first");
    expect(replyOpening({ messages: [inbound(0), outbound(1), inbound(2)], lastOutboundAt: at(1) })).toBe("answered");
    expect(replyOpening({ messages: [inbound(0), outbound(1)], lastOutboundAt: at(1) })).toBe("revised");
  });
});

describe("needsRetriage", () => {
  const answered = { triagedAt: at(1), lastInboundAt: at(2) };

  it("re-triages when the reporter wrote after the last judgement", () => {
    expect(needsRetriage({ status: "NEEDS_INFO", ...answered })).toBe(true);
    expect(needsRetriage({ status: "READY", ...answered })).toBe(true);
  });

  it("does not when nothing arrived since", () => {
    expect(needsRetriage({ status: "NEEDS_INFO", triagedAt: at(2), lastInboundAt: at(1) })).toBe(false);
  });

  it("never touches closed or untriaged tickets", () => {
    for (const status of ["NEW", "REJECTED", "RESOLVED", "IN_REVIEW", "NEEDS_HUMAN"]) {
      expect(needsRetriage({ status, ...answered })).toBe(false);
    }
  });

  it("holds a ticket with a live issue, and releases one whose issue was abandoned", () => {
    expect(needsRetriage({ status: "READY", ...answered, issueNumber: 7 })).toBe(false);
    expect(needsRetriage({ status: "READY", ...answered, issueNumber: 7, issueAbandoned: false })).toBe(false);
    expect(needsRetriage({ status: "READY", ...answered, issueNumber: 7, issueAbandoned: true })).toBe(true);
  });
});

describe("decideAutoReply", () => {
  const ticket = { status: "NEEDS_INFO", severity: "P3", source: "CHAT", messages: [inbound(0)] };

  it("is off unless enabled", () => {
    expect(decideAutoReply(ticket, false)).toEqual({ send: false, reason: "AUTO_REPLY_DISABLED" });
    expect(decideAutoReply(ticket, true)).toEqual({ send: true });
  });

  it("never auto-answers a P1", () => {
    expect(decideAutoReply({ ...ticket, severity: "P1" }, true)).toEqual({ send: false, reason: "P1_NEEDS_HUMAN" });
  });

  it("never posts for a ticket with no thread", () => {
    expect(decideAutoReply({ ...ticket, source: "MANUAL" }, true)).toEqual({ send: false, reason: "NO_THREAD" });
  });

  it("only answers NEEDS_INFO and READY", () => {
    for (const status of ["NEW", "REJECTED", "RESOLVED", "NEEDS_HUMAN"]) {
      expect(decideAutoReply({ ...ticket, status }, true)).toEqual({ send: false, reason: "STATUS_NOT_ANSWERABLE" });
    }
  });
});

describe("looksLikeAnnouncement", () => {
  it("matches a known tag at the start, ignoring case and spacing", () => {
    expect(looksLikeAnnouncement("[SHIPPED] bulk archive")).toBe(true);
    expect(looksLikeAnnouncement("  [ shipped ] bulk archive")).toBe(true);
  });

  it("skips attachment markers before the tag", () => {
    expect(looksLikeAnnouncement(`${ATTACHMENT_MARKER}\n${ATTACHMENT_MARKER}\n[FIXED] export`)).toBe(true);
  });

  it("is not fooled by other brackets", () => {
    expect(looksLikeAnnouncement("[URGENT] the PDF does not generate")).toBe(false);
    expect(looksLikeAnnouncement("the export fails [SHIPPED]")).toBe(false);
    expect(looksLikeAnnouncement("[SHIPPED no closing bracket")).toBe(false);
    expect(looksLikeAnnouncement("")).toBe(false);
    expect(looksLikeAnnouncement(null)).toBe(false);
  });

  it("uses the configured tags", () => {
    expect(looksLikeAnnouncement("[LAUNCH] new board", ["LAUNCH"])).toBe(true);
    expect(looksLikeAnnouncement("[SHIPPED] new board", ["LAUNCH"])).toBe(false);
  });
});

describe("two keys to dismiss a message", () => {
  const regression = "[FIXED] calendar sync\nit is happening again, new events are not showing up";

  it("the tag alone never silences a report", () => {
    expect(announcementVerdict({ modelSaysAnnouncement: false, firstMessageText: regression })).toBe("NOT_ANNOUNCEMENT");
  });

  it("the model alone never silences an untagged message", () => {
    expect(
      announcementVerdict({ modelSaysAnnouncement: true, firstMessageText: "the new export is great, by the way" }),
    ).toBe("DISPUTED");
  });

  it("both keys together dismiss it", () => {
    expect(
      announcementVerdict({ modelSaysAnnouncement: true, firstMessageText: "[SHIPPED] bulk archive is live" }),
    ).toBe("ANNOUNCEMENT");
  });
});

describe("decideAnnouncementReply", () => {
  const ticket = { status: "REJECTED", rejectionKind: "ANNOUNCEMENT", source: "CHAT", messages: [inbound(0)] };

  it("answers a confirmed announcement once", () => {
    expect(decideAnnouncementReply(ticket, true)).toEqual({ send: true });
    expect(
      decideAnnouncementReply({ ...ticket, messages: [inbound(0), outbound(1)], lastOutboundAt: at(1) }, true),
    ).toEqual({ send: false, reason: "SHOULD_NOT_REPLY" });
  });

  it("stays quiet for any other rejection", () => {
    expect(decideAnnouncementReply({ ...ticket, rejectionKind: "DUPLICATE" }, true)).toEqual({
      send: false,
      reason: "NOT_AN_ANNOUNCEMENT",
    });
    expect(decideAnnouncementReply({ ...ticket, status: "READY" }, true).send).toBe(false);
    expect(decideAnnouncementReply(ticket, false).send).toBe(false);
  });
});

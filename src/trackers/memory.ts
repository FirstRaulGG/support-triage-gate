// An in-memory issue tracker. For tests and the offline demo.

import type { IssueOutcome, PrSnapshot } from "../core/followup.js";
import type { IssueTracker } from "./types.js";

export interface MemoryIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  labels: string[];
  outcome: IssueOutcome;
}

export class MemoryTracker implements IssueTracker {
  readonly issues: MemoryIssue[] = [];
  private readonly pullRequests = new Map<number, PrSnapshot & { branch: string }>();
  private sequence = 100;

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }> {
    const number = ++this.sequence;
    const url = `https://tracker.example.test/issues/${number}`;
    this.issues.push({ number, url, outcome: "OPEN", ...input });
    return { number, url };
  }

  async getIssueOutcome(issueNumber: number): Promise<IssueOutcome> {
    return this.issues.find((issue) => issue.number === issueNumber)?.outcome ?? "OPEN";
  }

  async findPullRequestForBranch(branchName: string): Promise<number | null> {
    for (const [number, pr] of this.pullRequests) {
      if (pr.branch === branchName) return number;
    }
    return null;
  }

  async getPullRequest(prNumber: number): Promise<PrSnapshot> {
    const pr = this.pullRequests.get(prNumber);
    if (!pr) throw new Error(`pull request #${prNumber} not found`);
    return { number: pr.number, state: pr.state, previewUrl: pr.previewUrl };
  }

  // --- test/demo controls ---------------------------------------------------

  closeIssue(issueNumber: number, outcome: Exclude<IssueOutcome, "OPEN">): void {
    const issue = this.issues.find((i) => i.number === issueNumber);
    if (issue) issue.outcome = outcome;
  }

  openPullRequest(branch: string, previewUrl: string | null = null): number {
    const number = ++this.sequence;
    this.pullRequests.set(number, { number, branch, state: "OPEN", previewUrl });
    return number;
  }

  setPullRequest(prNumber: number, patch: Partial<Pick<PrSnapshot, "state" | "previewUrl">>): void {
    const pr = this.pullRequests.get(prNumber);
    if (pr) Object.assign(pr, patch);
  }
}

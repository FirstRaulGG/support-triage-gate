// Issue tracker port: where READY tickets become work, and where the gate learns how it ended.

import type { IssueOutcome, PrSnapshot } from "../core/followup.js";

export interface IssueTracker {
  createIssue(input: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }>;
  /**
   * Must fail closed: when the tracker cannot be reached, answer "OPEN". An outage must never be
   * read as permission to rewrite a ticket or to close it.
   */
  getIssueOutcome(issueNumber: number): Promise<IssueOutcome>;
  /** The pull request opened from this branch, if any. */
  findPullRequestForBranch(branchName: string): Promise<number | null>;
  getPullRequest(prNumber: number): Promise<PrSnapshot>;
}

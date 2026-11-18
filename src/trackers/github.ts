// GitHub as an `IssueTracker`, over the REST API.

import { issueOutcome } from "../core/followup.js";
import type { IssueOutcome, PrSnapshot, PrState } from "../core/followup.js";
import { isSupportBranchName } from "../core/work.js";
import type { IssueTracker } from "./types.js";

const API = "https://api.github.com";

export interface GitHubTrackerOptions {
  token: string;
  owner: string;
  repo: string;
  /** Deployment environment whose URL is offered to reporters as the preview. */
  previewEnvironment?: string;
  fetchImpl?: typeof fetch;
}

/** `owner/repo` -> parts, or `null` when the value is not in that form. */
export function parseRepoSlug(slug: string): { owner: string; repo: string } | null {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(slug.trim());
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

export class GitHubTracker implements IssueTracker {
  private readonly fetchImpl: typeof fetch;
  private readonly repoPath: string;

  constructor(private readonly options: GitHubTrackerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.repoPath = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.options.token}`,
        "x-github-api-version": "2022-11-28",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GitHub returned ${response.status} for ${path}: ${body.slice(0, 200)}`);
    }
    return (await response.json()) as T;
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }> {
    const created = await this.request<{ number: number; html_url: string }>(`${this.repoPath}/issues`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return { number: created.number, url: created.html_url };
  }

  async getIssueOutcome(issueNumber: number): Promise<IssueOutcome> {
    try {
      const issue = await this.request<{ state: string; state_reason?: string | null }>(
        `${this.repoPath}/issues/${issueNumber}`,
      );
      return issueOutcome({ state: issue.state, stateReason: issue.state_reason });
    } catch {
      return "OPEN"; // fail closed: "the issue still stands"
    }
  }

  async findPullRequestForBranch(branchName: string): Promise<number | null> {
    // The name goes into a query string and comes from storage; only our own format is accepted.
    if (!isSupportBranchName(branchName)) return null;
    const head = encodeURIComponent(`${this.options.owner}:${branchName}`);
    const pulls = await this.request<{ number: number }[]>(
      `${this.repoPath}/pulls?state=all&head=${head}&per_page=1`,
    );
    return pulls[0]?.number ?? null;
  }

  async getPullRequest(prNumber: number): Promise<PrSnapshot> {
    const pr = await this.request<{ number: number; state: string; merged: boolean; head: { sha: string } }>(
      `${this.repoPath}/pulls/${prNumber}`,
    );
    // REST reports a merged pull request as `state: "closed"`; the `merged` flag tells them apart.
    // Without this check every accepted pull request would look "closed without merge".
    const state: PrState = pr.merged ? "MERGED" : pr.state === "open" ? "OPEN" : "CLOSED";
    const previewUrl = state === "OPEN" ? await this.latestPreviewUrl(pr.head.sha) : null;
    return { number: pr.number, state, previewUrl };
  }

  /**
   * Preview URL of the COMMIT. The ref is the SHA, not the branch name: hosting providers register
   * the deployment against the commit, and filtering by branch tends to return an empty list.
   */
  private async latestPreviewUrl(sha: string): Promise<string | null> {
    const environment = encodeURIComponent(this.options.previewEnvironment ?? "Preview");
    try {
      const deployments = await this.request<{ id: number }[]>(
        `${this.repoPath}/deployments?environment=${environment}&ref=${encodeURIComponent(sha)}&per_page=5`,
      );
      for (const deployment of deployments) {
        const statuses = await this.request<{ state: string; environment_url?: string }[]>(
          `${this.repoPath}/deployments/${deployment.id}/statuses?per_page=10`,
        );
        const success = statuses.find((status) => status.state === "success" && status.environment_url);
        if (success?.environment_url) return success.environment_url;
      }
      return null;
    } catch {
      return null; // no preview is not a failure: the build may not have finished
    }
  }
}

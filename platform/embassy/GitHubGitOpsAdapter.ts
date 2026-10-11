/**
 * GITHUB GITOPS ACTUATOR
 *
 * Converts an approved NeuroFabric remediation proposal into a real
 * GitHub Pull Request via the GitHub REST API.
 *
 * Configuration:
 *   • GITHUB_TOKEN  — Personal access token (repo scope).
 *   • GITHUB_REPO   — Target repository in "owner/repo" form.
 *   • GITHUB_API_BASE — Optional self-hosted GHES / mirror endpoint
 *                         (default https://api.github.com).
 *
 * Actuation flow (when an Incident Commander approves a proposal):
 *   1. Create branch  neurofabric/remediation-<taskToken>
 *   2. Commit the synthesized unified patch to that branch.
 *   3. Open a Pull Request carrying the structured RCA report,
 *      confidence score, blast radius, and a Merkle audit link.
 *
 * If GITHUB_TOKEN / GITHUB_REPO are omitted the adapter falls back
 * to a deterministic local simulation so the pipeline never blocks
 * and downstream tests can still assert on the PR dispatch shape.
 */

export interface RcaSummary {
  rootCause: string;
  explanation: string;
  blastRadius: string;
  confidence: number;
  diff: string;
}

export interface GitOpsDispatchParams {
  taskToken: string;
  patch: string;
  rca: RcaSummary;
  merkleLink?: string;
  approver?: string;
  target?: string;
}

export interface GitOpsDispatchResult {
  mode: "github" | "simulation";
  taskToken: string;
  branch: string;
  prUrl: string | null;
  prNumber: number | null;
  title: string;
  body: string;
  committed: boolean;
  files: string[];
  baseBranch: string;
  dispatchedAt: string;
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_API_BASE = (process.env.GITHUB_API_BASE || "https://api.github.com").replace(/\/$/, "");
const GITHUB_REQUEST_TIMEOUT_MS = 10000;

export class GitHubGitOpsAdapter {
  private readonly token: string | undefined;
  private readonly repo: string | undefined;
  private readonly apiBase: string;

  constructor(
    opts: { token?: string; repo?: string; apiBase?: string } = {}
  ) {
    this.token = opts.token ?? GITHUB_TOKEN;
    this.repo = opts.repo ?? GITHUB_REPO;
    this.apiBase = (opts.apiBase ?? GITHUB_API_BASE).replace(/\/$/, "");
  }

  /** True when real GitHub actuation is possible. */
  get isConfigured(): boolean {
    return Boolean(this.token && this.repo);
  }

  /**
   * Dispatch an approved remediation as a Git branch + commit + PR.
   *
   * Falls back to simulation mode when GITHUB_TOKEN is omitted or
   * when any GitHub API call fails.
   */
  async dispatchRemediation(params: GitOpsDispatchParams): Promise<GitOpsDispatchResult> {
    const { taskToken, patch, rca, merkleLink, approver, target } = params;
    const branch = `neurofabric/remediation-${taskToken}`;
    const title = `[NeuroFabric] RCA remediation: ${target || taskToken}`;
    const body = this.buildPrBody(rca, merkleLink, approver, branch, target);

    if (!this.isConfigured) {
      return this.simulate(taskToken, branch, title, body);
    }

    try {
      return await this.dispatchToGitHub(taskToken, branch, title, body, patch, rca, target);
    } catch (err) {
      console.warn(
        "[GitHubGitOpsAdapter] GitHub dispatch failed, falling back to simulation:",
        err instanceof Error ? err.message : err
      );
      return this.simulate(taskToken, branch, title, body);
    }
  }

  // -------------------------------------------------------------------------
  // PR body construction
  // -------------------------------------------------------------------------

  private buildPrBody(
    rca: RcaSummary,
    merkleLink: string | undefined,
    approver: string | undefined,
    branch: string,
    target: string | undefined
  ): string {
    return [
      "## 🤖 NeuroFabric Agentic RCA Report",
      "",
      "### 🔎 Root Cause",
      rca.rootCause,
      "",
      "### 🧠 Explanation & Recommended Remediation",
      rca.explanation,
      "",
      "### 💥 Blast Radius",
      rca.blastRadius,
      "",
      "### 🎯 Confidence Score",
      `${rca.confidence}%`,
      "",
      "### 🎯 Affected Target",
      target || "unspecified",
      "",
      "### 🔗 Merkle Audit Link",
      merkleLink || "N/A",
      "",
      "### 👤 Approved By",
      approver || "Incident Commander",
      "",
      "### 🩹 Remediation Patch",
      "```diff",
      rca.diff,
      "```",
      "",
      "---",
      `Branch: \`${branch}\``,
      "_Dispatched by the NeuroFabric GitOps Actuator._",
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // GitHub REST actuation
  // -------------------------------------------------------------------------

  private async dispatchToGitHub(
    taskToken: string,
    branch: string,
    title: string,
    body: string,
    patch: string,
    rca: RcaSummary,
    target: string | undefined
  ): Promise<GitOpsDispatchResult> {
    const headers = this.githubHeaders();

    // 1. Resolve the default branch + its HEAD SHA.
    const repoData = await this.apiGet<any>(`/repos/${this.repo}`);
    const defaultBranch = String(repoData.default_branch || "main");

    const refData = await this.apiGet<any>(
      `/repos/${this.repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`
    );
    const baseSha = refData?.object?.sha;
    if (!baseSha) throw new Error("Could not resolve default branch HEAD SHA");

    // 2. Create the remediation branch.
    await this.apiPost(`/repos/${this.repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    });

    // 3. Commit the synthesized patch to the branch.
    const filePath = `remediations/${(target || taskToken).replace(/[^a-zA-Z0-9-_]/g, "-")}.patch`;
    const contentB64 = Buffer.from(patch || rca.diff || "", "utf8").toString("base64");
    await this.apiPut(`/repos/${this.repo}/contents/${encodeURIComponent(filePath)}`, {
      message: `[NeuroFabric] RCA remediation for ${taskToken}`,
      content: contentB64,
      branch,
    });

    // 4. Open the Pull Request carrying the RCA report.
    const prData = await this.apiPost<any>(`/repos/${this.repo}/pulls`, {
      title,
      body,
      head: branch,
      base: defaultBranch,
    });

    return {
      mode: "github",
      taskToken,
      branch,
      prUrl: prData?.html_url ?? null,
      prNumber: prData?.number ?? null,
      title,
      body,
      committed: true,
      files: [filePath],
      baseBranch: defaultBranch,
      dispatchedAt: new Date().toISOString(),
    };
  }

  private githubHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "neurofabric-gitops-actuator",
    };
  }

  private async apiGet<T>(path: string): Promise<T> {
    return this.apiRequest<T>("GET", path, undefined);
  }

  private async apiPost<T>(path: string, body: unknown): Promise<T> {
    return this.apiRequest<T>("POST", path, body);
  }

  private async apiPut<T>(path: string, body: unknown): Promise<T> {
    return this.apiRequest<T>("PUT", path, body);
  }

  private async apiRequest<T>(method: string, path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.apiBase}${path}`, {
        method,
        headers: this.githubHeaders(),
        signal: controller.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`GitHub API ${method} ${path} -> HTTP ${res.status} ${detail.slice(0, 120)}`);
      }
      // 204 No Content (e.g. ref creation) has no JSON body.
      if (res.status === 204) return {} as T;
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Simulation fallback
  // -------------------------------------------------------------------------

  private simulate(
    taskToken: string,
    branch: string,
    title: string,
    body: string
  ): GitOpsDispatchResult {
    return {
      mode: "simulation",
      taskToken,
      branch,
      prUrl: null,
      prNumber: null,
      title,
      body,
      committed: false,
      files: [],
      baseBranch: "main",
      dispatchedAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience singleton
// ---------------------------------------------------------------------------

export const gitHubGitOpsAdapter = new GitHubGitOpsAdapter();

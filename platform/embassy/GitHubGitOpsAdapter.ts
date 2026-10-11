export interface GitOpsRemediationRequest {
  taskId: string;
  taskToken?: string;
  target: string;
  diff: string;
  rca: {
    rootCause?: string;
    explanation?: string;
    blastRadius?: string;
    confidence?: number;
    diff?: string;
  };
}

export interface GitOpsRemediationResult {
  mode: "github" | "simulation";
  taskToken: string;
  branch: string;
  prUrl: string;
  prNumber: string | number;
  title: string;
  body: string;
  committed: boolean;
  files: Array<{ path: string; action: string }>;
  baseBranch: string;
  dispatchedAt: string;
}

export class GitHubGitOpsAdapter {
  private token = process.env.GITHUB_TOKEN || "";
  private repo = process.env.GITHUB_REPO || "NeuroFabric/neurofabric";

  async dispatchRemediation(req: GitOpsRemediationRequest): Promise<GitOpsRemediationResult> {
    const taskToken = req.taskToken || req.taskId;
    const branch = `neurofabric/remediation-${taskToken}`;
    const title = `[NeuroFabric] RCA remediation: ${req.target}`;
    const targetPath = `deploy/${req.target}.yaml`;

    const body = [
      `## 🤖 NeuroFabric Agentic RCA Report`,
      ``,
      `### 🔎 Root Cause`,
      req.rca.rootCause || `Anomaly detected in ${req.target}`,
      ``,
      `### 🧠 Explanation & Recommended Remediation`,
      req.rca.explanation || `Automated remediation patch approved by Incident Commander.`,
      ``,
      `### 💥 Blast Radius`,
      req.rca.blastRadius || "medium",
      ``,
      `### 🎯 Confidence Score`,
      `${req.rca.confidence ?? 85}%`,
      ``,
      `### 🎯 Target Service`,
      req.target,
      ``,
      `### 🩹 Remediation Patch`,
      "```diff",
      req.diff || req.rca.diff || "# No diff content",
      "```",
      ``,
      `---`,
      `Branch: \`${branch}\``,
      `_Dispatched automatically by NeuroFabric GitOps Actuator._`,
    ].join("\n");

    if (this.token && this.repo) {
      try {
        const headers = {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "NeuroFabric-Orchestrator",
          "X-GitHub-Api-Version": "2022-11-28",
        };

        // 1. Get SHA of base branch (main)
        const refRes = await fetch(`https://api.github.com/repos/${this.repo}/git/ref/heads/main`, { headers });
        if (!refRes.ok) {
          const errText = await refRes.text();
          console.warn(`[GitHubGitOpsAdapter] Failed to get main branch SHA: ${refRes.status} ${errText}`);
          throw new Error(`Failed to fetch main branch: ${refRes.statusText}`);
        }
        const refData = await refRes.json() as any;
        const mainSha = refData.object.sha;

        // 2. Create branch
        await fetch(`https://api.github.com/repos/${this.repo}/git/refs`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: mainSha }),
        });

        // 3. Commit remediation file so branch differs from main
        const fileContent = Buffer.from(req.diff || req.rca.diff || "# Patch applied\n").toString("base64");
        await fetch(`https://api.github.com/repos/${this.repo}/contents/${targetPath}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            message: `chore(remediation): apply automated patch for ${req.target}`,
            content: fileContent,
            branch,
          }),
        });

        // 4. Create Pull Request
        const prRes = await fetch(`https://api.github.com/repos/${this.repo}/pulls`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title,
            head: branch,
            base: "main",
            body,
          }),
        });

        if (prRes.ok) {
          const prData = await prRes.json() as any;
          return {
            mode: "github",
            taskToken,
            branch,
            prUrl: prData.html_url || "",
            prNumber: prData.number || "",
            title,
            body,
            committed: true,
            files: [{ path: targetPath, action: "update" }],
            baseBranch: "main",
            dispatchedAt: new Date().toISOString(),
          };
        } else {
          const prErr = await prRes.text();
          console.warn(`[GitHubGitOpsAdapter] PR creation error: ${prRes.status} ${prErr}`);
        }
      } catch (err: any) {
        console.warn(`[GitHubGitOpsAdapter] Live dispatch error: ${err?.message || err}`);
      }
    } else {
      console.warn("[GitHubGitOpsAdapter] Missing GITHUB_TOKEN or GITHUB_REPO. Running simulation mode.");
    }

    return {
      mode: "simulation",
      taskToken,
      branch,
      prUrl: "",
      prNumber: "",
      title,
      body,
      committed: false,
      files: [],
      baseBranch: "main",
      dispatchedAt: new Date().toISOString(),
    };
  }
}

export const gitHubGitOpsAdapter = new GitHubGitOpsAdapter();

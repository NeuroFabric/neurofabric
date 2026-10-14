import { useState, type FormEvent } from 'react';
import { useTelemetry } from '../context/TelemetryContext';
import { analyzeDiffAST } from '../utils/security';
import {
  ShieldCheck,
  ShieldAlert,
  GitPullRequest,
  Check,
  X,
  AlertTriangle,
  RotateCcw,
  FileCode,
  Plus,
  Edit3,
  Undo2,
  RefreshCw,
  CheckCheck,
  GitBranch,
  Layers,
  ExternalLink,
  Key,
  Activity,
  Zap,
  Send,
  FolderGit2,
} from 'lucide-react';
import { toast } from 'sonner';
import { InfoTooltip } from '../components/common/Tooltip';

function GitHubIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
      />
    </svg>
  );
}

export function EmbassyPage() {
  const {
    proposals,
    authorizePR,
    declinePR,
    bulkApproveVerified,
    bulkDeclineBlocked,
    reopenPR,
    rollbackPR,
    setCanaryStage,
    updateProposalDiff,
    createGitOpsPR,
    resetProposals,
    githubConfig,
    saveGitHubConfig,
    switchGitHubRepo,
    syncGitHubPRs,
    disconnectGitHub,
  } = useTelemetry();

  const [queueFilter, setQueueFilter] = useState<'ALL' | 'PENDING' | 'BLOCKED' | 'ACTIONED'>('ALL');
  const [selectedId, setSelectedId] = useState<string>(proposals[0]?.taskId || '');
  const [rcaTab, setRcaTab] = useState<'TELEMETRY' | 'CAUSAL_TREE' | 'CANARY_SPLIT'>('TELEMETRY');
  const [taskToken, setTaskToken] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [showDeclineReasons, setShowDeclineReasons] = useState(false);
  const [isEditingDiff, setIsEditingDiff] = useState(false);
  const [draftDiff, setDraftDiff] = useState('');

  // GitHub Connection Modal State
  const [showGitModal, setShowGitModal] = useState(false);
  const [patInput, setPatInput] = useState('');
  const [repoInput, setRepoInput] = useState('');
  const [branchInput, setBranchInput] = useState('main');

  // Interactive GitOps PR Composer Modal State
  const [showComposer, setShowComposer] = useState(false);
  const [compService, setCompService] = useState('auth-gateway');
  const [compTitle, setCompTitle] = useState('Raise Connection Pool Ceiling & Enforce Fail-Fast Timeout');
  const [compFile, setCompFile] = useState('deployments/auth-gateway.yaml');
  const [compSummary, setCompSummary] = useState(
    'Increases MAX_IDLE_CONNS from 10 to 50 and bounds connection acquisition timeout at 2500ms to prevent socket starvation.'
  );
  const [compDiff, setCompDiff] = useState(
    [
      '--- a/deployments/auth-gateway.yaml',
      '+++ b/deployments/auth-gateway.yaml',
      '@@ -12,4 +12,6 @@ spec:',
      '-  maxIdleConns: 10',
      '+  maxIdleConns: 50',
      '+  poolAcquireTimeoutMs: 2500',
    ].join('\n')
  );
  const [isCreatingPr, setIsCreatingPr] = useState(false);

  const liveComposerAst = analyzeDiffAST(compDiff.split('\n'));

  const filteredQueue = proposals.filter((p) => {
    if (queueFilter === 'PENDING') return p.status === 'PENDING';
    if (queueFilter === 'BLOCKED') return p.astStatus === 'REJECT';
    if (queueFilter === 'ACTIONED') return p.status !== 'PENDING';
    return true;
  });

  const current = proposals.find((p) => p.taskId === selectedId) || filteredQueue[0] || proposals[0];

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setShowConfirm(false);
    setShowDeclineReasons(false);
    setIsEditingDiff(false);
    setTaskToken('');
  };

  const handleStartEdit = () => {
    if (!current) return;
    setDraftDiff(current.diff.join('\n'));
    setIsEditingDiff(true);
  };

  const handleSaveDiff = () => {
    if (!current) return;
    updateProposalDiff(current.taskId, draftDiff.split('\n'));
    setIsEditingDiff(false);
  };

  const handleApprove = async () => {
    if (!current) return;
    if (current.astStatus === 'REJECT') {
      toast.error('AST Security Gate Lock (HTTP 422)', {
        description: 'Cannot merge a pull request with active AST security violations.',
      });
      return;
    }
    if (!showConfirm) {
      setShowConfirm(true);
      setShowDeclineReasons(false);
      return;
    }
    if (taskToken.trim() !== current.taskId) {
      toast.error('Confirmation Token Mismatch', {
        description: `Click "Auto-fill token" or enter "${current.taskId}" to confirm.`,
      });
      return;
    }
    await authorizePR(current.taskId, current.target, current.diff.join('\n'));
    setShowConfirm(false);
    setTaskToken('');
  };

  const handleDeclineWithReason = async (reason: string) => {
    if (!current) return;
    await declinePR(current.taskId, current.target, reason);
    setShowDeclineReasons(false);
    setShowConfirm(false);
  };

  const handleConnectGitHub = async (e: FormEvent) => {
    e.preventDefault();
    if (!patInput.trim()) {
      toast.error('Personal Access Token Required', { description: 'Enter a GitHub PAT with repo scope.' });
      return;
    }
    await saveGitHubConfig(patInput, repoInput, branchInput);
    setShowGitModal(false);
  };

  const handleCreatePrSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!compTitle.trim() || !compFile.trim()) return;
    setIsCreatingPr(true);
    const createdId = await createGitOpsPR({
      service: compService,
      title: compTitle,
      targetFile: compFile,
      rcaSummary: compSummary,
      diffLines: compDiff.split('\n'),
    });
    setIsCreatingPr(false);
    if (createdId) {
      setSelectedId(createdId);
      setShowComposer(false);
    }
  };

  const declineReasons = [
    'False Positive RCA',
    'Blast Radius Too Wide',
    'AST Security Policy Violation',
    'Defer to Maintenance Window',
  ];

  const pendingCount = proposals.filter((p) => p.status === 'PENDING').length;

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-7xl font-sans tabular-nums">
      {/* Header & Live Repository Selector */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-2xl font-bold text-white tracking-tight">
              GitOps Patch Review &amp; AST Security Gate
            </h1>
            <InfoTooltip content="Screen pull requests against 6 deterministic AST static analysis rules, inspect per-PR failure telemetry and 5-Whys causal chains, shift canary traffic weights, and merge directly on GitHub." />
          </div>

          <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs">
            {githubConfig.isConnected ? (
              <div className="flex flex-wrap items-center gap-2 font-mono">
                <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-bold">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  <span>GITHUB CONNECTED:</span>
                </span>

                {githubConfig.availableRepos.length > 0 ? (
                  <select
                    aria-label="Select connected GitHub repository"
                    value={githubConfig.repo}
                    onChange={(e) => switchGitHubRepo(e.target.value)}
                    className="bg-[#0B0E17] border border-emerald-500/40 rounded-lg px-2.5 py-1 text-white font-mono text-xs focus:outline-none focus:border-emerald-400"
                  >
                    {githubConfig.availableRepos.map((r) => (
                      <option key={r.fullName} value={r.fullName}>
                        {r.fullName} ({r.defaultBranch})
                      </option>
                    ))}
                  </select>
                ) : (
                  <a
                    href={`https://github.com/${githubConfig.repo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-300 underline hover:text-white flex items-center space-x-1 font-bold"
                  >
                    <span>{githubConfig.repo}</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}

                <span className="text-slate-400">Branch: <strong className="text-slate-200">{githubConfig.branch}</strong></span>
              </div>
            ) : (
              <div className="text-slate-300 font-mono flex flex-wrap items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                <span>Mode: Local Sandbox Queue (4 distinct service scenarios)</span>
                <button
                  onClick={() => setShowGitModal(true)}
                  className="text-emerald-400 underline hover:text-emerald-300 font-bold"
                >
                  Connect GitHub PAT to sync &amp; merge real PRs →
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {githubConfig.isConnected ? (
            <>
              <button
                onClick={() => syncGitHubPRs()}
                disabled={githubConfig.isSyncing}
                className="px-3 py-1.5 rounded-xl bg-[#121622] hover:bg-slate-800 border border-white/10 text-emerald-300 text-xs font-mono font-bold flex items-center space-x-1.5 transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${githubConfig.isSyncing ? 'animate-spin' : ''}`} />
                <span>{githubConfig.isSyncing ? 'Syncing...' : 'Refresh GitHub PRs'}</span>
              </button>
              <button
                onClick={disconnectGitHub}
                className="px-2.5 py-1.5 rounded-xl bg-white/5 hover:bg-rose-500/20 text-slate-300 hover:text-rose-300 text-xs font-mono transition"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={() => setShowGitModal(true)}
              className="px-3.5 py-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/50 text-emerald-300 text-xs font-mono font-bold flex items-center space-x-1.5 transition"
            >
              <GitHubIcon className="w-3.5 h-3.5" />
              <span>Connect GitHub Repo</span>
            </button>
          )}

          <button
            onClick={() => setShowComposer(!showComposer)}
            className="px-3.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-mono font-bold flex items-center space-x-1.5 transition shadow-lg shadow-emerald-500/20"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{githubConfig.isConnected ? '+ Open Real GitHub PR' : '+ Create Remediation PR'}</span>
          </button>

          <button
            onClick={bulkApproveVerified}
            className="px-3 py-1.5 rounded-xl bg-[#121622] hover:bg-emerald-500/20 border border-white/10 hover:border-emerald-400/40 text-slate-200 hover:text-emerald-300 text-xs font-mono font-bold flex items-center space-x-1.5 transition"
          >
            <CheckCheck className="w-3.5 h-3.5" />
            <span>Approve Verified</span>
          </button>

          <button
            onClick={bulkDeclineBlocked}
            className="px-3 py-1.5 rounded-xl bg-[#121622] hover:bg-rose-500/20 border border-white/10 hover:border-rose-500/40 text-slate-200 hover:text-rose-300 text-xs font-mono font-bold flex items-center space-x-1.5 transition"
          >
            <X className="w-3.5 h-3.5" />
            <span>Refuse Blocked</span>
          </button>

          <button
            onClick={resetProposals}
            className="px-2.5 py-1.5 rounded-xl bg-[#121622] hover:bg-slate-800 border border-white/10 text-xs font-mono text-slate-300 flex items-center space-x-1 transition"
          >
            <RotateCcw className="w-3.5 h-3.5 text-emerald-400" />
            <span>Reset</span>
          </button>
        </div>
      </div>

      {/* GitHub PAT & Dynamic Repository Discovery Modal */}
      {showGitModal && (
        <form
          onSubmit={handleConnectGitHub}
          className="p-6 rounded-2xl nf-card border border-emerald-400/50 space-y-4"
        >
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <div className="flex items-center space-x-2 font-mono text-xs font-bold text-white uppercase">
              <GitHubIcon className="w-4 h-4 text-emerald-400" />
              <span>Connect GitHub Personal Access Token (Auto-Discovers Your Repositories)</span>
            </div>
            <button
              type="button"
              onClick={() => setShowGitModal(false)}
              className="text-xs font-mono text-slate-400 hover:text-white"
            >
              Close
            </button>
          </div>

          <p className="text-xs text-slate-300 leading-relaxed">
            Provide a GitHub Personal Access Token with <code className="text-emerald-400">repo</code> scope. NeuroFabric will automatically discover your accessible repositories, load your real open/closed pull requests, screen their diffs, and execute real merges via <code className="text-cyan-300">api.github.com</code>.Leave Target Repo blank to auto-select your most recently updated repository.
          </p>

          <div className="grid md:grid-cols-3 gap-4 font-mono text-xs">
            <div>
              <label htmlFor="gh-pat-input" className="text-[10px] text-slate-300 font-bold block mb-1">
                GITHUB PERSONAL ACCESS TOKEN (PAT) *
              </label>
              <div className="relative">
                <Key className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                <input
                  id="gh-pat-input"
                  type="password"
                  required
                  value={patInput}
                  onChange={(e) => setPatInput(e.target.value)}
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  className="w-full bg-[#05070B] border border-white/15 rounded-xl pl-9 pr-3 py-2 text-white focus:outline-none focus:border-emerald-400"
                />
              </div>
            </div>

            <div>
              <label htmlFor="gh-repo-input" className="text-[10px] text-slate-300 font-bold block mb-1">
                TARGET REPOSITORY (OPTIONAL — AUTO-DETECTED)
              </label>
              <div className="relative">
                <FolderGit2 className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                <input
                  id="gh-repo-input"
                  type="text"
                  value={repoInput}
                  onChange={(e) => setRepoInput(e.target.value)}
                  placeholder="owner/repository (or leave blank)"
                  className="w-full bg-[#05070B] border border-white/15 rounded-xl pl-9 pr-3 py-2 text-white focus:outline-none focus:border-emerald-400"
                />
              </div>
            </div>

            <div>
              <label htmlFor="gh-branch-input" className="text-[10px] text-slate-300 font-bold block mb-1">
                BASE BRANCH
              </label>
              <input
                id="gh-branch-input"
                type="text"
                value={branchInput}
                onChange={(e) => setBranchInput(e.target.value)}
                placeholder="main"
                className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-emerald-400"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <span className="text-[10px] font-mono text-slate-400">
              Token is held strictly in volatile memory (never written to localStorage).
            </span>
            <button
              type="submit"
              className="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold font-mono text-xs rounded-xl transition"
            >
              Connect &amp; Load Live Pull Requests
            </button>
          </div>
        </form>
      )}

      {/* Interactive GitOps PR Composer Modal */}
      {showComposer && (
        <form
          onSubmit={handleCreatePrSubmit}
          className="p-6 rounded-2xl nf-card border border-cyan-500/40 space-y-4"
        >
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <div className="flex items-center space-x-2 font-mono text-xs font-bold text-cyan-300 uppercase">
              <GitPullRequest className="w-4 h-4" />
              <span>
                {githubConfig.isConnected
                  ? `Create & Push Real Pull Request to github.com/${githubConfig.repo}`
                  : 'Author New Remediation Pull Request (With Live AST Screening)'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowComposer(false)}
              className="text-xs font-mono text-slate-400 hover:text-white"
            >
              Close
            </button>
          </div>

          <div className="grid md:grid-cols-3 gap-4 font-mono text-xs">
            <div>
              <label htmlFor="comp-service" className="text-[10px] text-slate-300 font-bold block mb-1">
                TARGET MICROSERVICE
              </label>
              <select
                id="comp-service"
                value={compService}
                onChange={(e) => setCompService(e.target.value)}
                className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-white"
              >
                <option value="auth-gateway">auth-gateway</option>
                <option value="flapping-payment-worker">flapping-payment-worker</option>
                <option value="billing-core">billing-core</option>
                <option value="order-service">order-service</option>
                <option value="ingress-gateway">ingress-gateway</option>
              </select>
            </div>

            <div>
              <label htmlFor="comp-file" className="text-[10px] text-slate-300 font-bold block mb-1">
                TARGET MANIFEST / FILE PATH
              </label>
              <input
                id="comp-file"
                type="text"
                required
                value={compFile}
                onChange={(e) => setCompFile(e.target.value)}
                className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-emerald-300"
              />
            </div>

            <div>
              <label htmlFor="comp-title" className="text-[10px] text-slate-300 font-bold block mb-1">
                PULL REQUEST TITLE
              </label>
              <input
                id="comp-title"
                type="text"
                required
                value={compTitle}
                onChange={(e) => setCompTitle(e.target.value)}
                className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-white font-sans"
              />
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4 font-mono text-xs">
            <div className="space-y-2">
              <label htmlFor="comp-diff" className="text-[10px] text-slate-300 font-bold block">
                UNIFIED GIT DIFF (TEST TYPING &quot;curl | bash&quot; OR &quot;privileged: true&quot; TO SEE AST BLOCK)
              </label>
              <textarea
                id="comp-diff"
                rows={6}
                value={compDiff}
                onChange={(e) => setCompDiff(e.target.value)}
                className="w-full bg-[#05070B] border border-white/15 rounded-xl p-3 text-emerald-200 text-xs font-mono focus:outline-none focus:border-emerald-400"
              />
            </div>

            <div className="space-y-3 flex flex-col justify-between">
              <div>
                <label htmlFor="comp-summary" className="text-[10px] text-slate-300 font-bold block mb-1">
                  INCIDENT ROOT CAUSE &amp; REMEDIATION RATIONALE
                </label>
                <textarea
                  id="comp-summary"
                  rows={3}
                  value={compSummary}
                  onChange={(e) => setCompSummary(e.target.value)}
                  className="w-full bg-[#05070B] border border-white/15 rounded-xl p-3 text-slate-200 text-xs font-sans focus:outline-none focus:border-emerald-400"
                />
              </div>

              <div
                className={`p-3.5 rounded-xl border ${
                  liveComposerAst.status === 'PASS'
                    ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                    : 'bg-rose-950/50 border-rose-500/50 text-rose-300'
                }`}
              >
                <div className="font-bold text-[11px]">
                  LIVE AST PRE-SCREEN: {liveComposerAst.status} ({liveComposerAst.nodesScanned} tokens, +{liveComposerAst.addedLines}/-{liveComposerAst.removedLines} lines)
                </div>
                <div className="text-[10px] mt-0.5 font-sans">{liveComposerAst.summaryMessage}</div>
              </div>

              <button
                type="submit"
                disabled={isCreatingPr}
                className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center space-x-2 transition"
              >
                <Send className="w-3.5 h-3.5" />
                <span>
                  {isCreatingPr
                    ? 'Pushing Branch & Opening PR...'
                    : githubConfig.isConnected
                    ? `Push Branch & Open Real PR on ${githubConfig.repo}`
                    : 'Add Remediation PR to Queue'}
                </span>
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Empty State when Connected GitHub Repo has 0 Pull Requests */}
      {proposals.length === 0 ? (
        <div className="p-12 rounded-3xl nf-card text-center space-y-4 max-w-2xl mx-auto">
          <GitPullRequest className="w-10 h-10 text-emerald-400 mx-auto" />
          <h2 className="text-xl font-bold text-white">
            0 Pull Requests Found in {githubConfig.repo || 'Repository'}
          </h2>
          <p className="text-xs text-slate-300 leading-relaxed max-w-lg mx-auto">
            Your connected GitHub repository (<code className="text-emerald-300">{githubConfig.repo}</code>) currently has no pull requests. Click below to push a real remediation branch and open Pull Request #1 directly on GitHub.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={() => setShowComposer(true)}
              className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono font-bold text-xs flex items-center space-x-2"
            >
              <Plus className="w-4 h-4" />
              <span>Open Real Pull Request on {githubConfig.repo}</span>
            </button>
            <button
              onClick={disconnectGitHub}
              className="px-4 py-2.5 rounded-xl bg-[#121622] border border-white/10 text-slate-300 font-mono text-xs"
            >
              Switch to Local Sandbox
            </button>
          </div>
        </div>
      ) : (
        current && (
          <div className="grid lg:grid-cols-12 gap-6">
            {/* Left Pane (3 Cols): Filterable PR Queue */}
            <div className="lg:col-span-3 space-y-3">
              <div className="flex items-center justify-between px-1">
                <span className="text-[11px] font-mono font-bold uppercase tracking-wider text-slate-300">
                  PR Queue ({filteredQueue.length} / {proposals.length})
                </span>
                <span className="text-[10px] font-mono text-amber-400 font-bold">{pendingCount} Open</span>
              </div>

              <div className="grid grid-cols-4 gap-1 bg-[#090C14] p-1 rounded-xl border border-white/10 font-mono text-[10px]">
                {(['ALL', 'PENDING', 'BLOCKED', 'ACTIONED'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setQueueFilter(f)}
                    className={`py-1.5 rounded-lg font-bold transition ${
                      queueFilter === f ? 'bg-emerald-500 text-slate-950' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>

              <div className="space-y-2.5 max-h-[600px] overflow-y-auto pr-1">
                {filteredQueue.map((prop) => {
                  const isSelected = prop.taskId === current.taskId;
                  return (
                    <div
                      key={prop.taskId}
                      onClick={() => handleSelect(prop.taskId)}
                      className={`p-3.5 rounded-2xl border cursor-pointer transition space-y-1.5 ${
                        isSelected
                          ? 'bg-gradient-to-br from-emerald-500/20 to-cyan-500/10 border-emerald-400 shadow-lg'
                          : 'nf-card hover:border-white/25'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-mono text-slate-300 font-bold flex items-center space-x-1.5">
                          {prop.isRealGitHubPr && <GitHubIcon className="w-3 h-3 text-emerald-400" />}
                          <span>PR #{prop.prNumber}</span>
                          <span className="text-slate-500">• {prop.service}</span>
                        </span>
                        <span
                          className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded-full ${
                            prop.status === 'APPROVED'
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                              : prop.status === 'DECLINED'
                              ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                              : prop.astStatus === 'REJECT'
                              ? 'bg-rose-950 text-rose-300 border border-rose-700'
                              : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                          }`}
                        >
                          {prop.status === 'PENDING' && prop.astStatus === 'REJECT'
                            ? 'AST BLOCKED'
                            : prop.status === 'APPROVED'
                            ? 'MERGED'
                            : prop.status}
                        </span>
                      </div>
                      <div className="text-xs font-bold text-white leading-snug">{prop.title}</div>
                      <div className="flex items-center justify-between text-[10px] font-mono pt-0.5">
                        <span className="text-emerald-400 truncate flex items-center space-x-1 max-w-[150px]">
                          <FileCode className="w-3 h-3 shrink-0" />
                          <span className="truncate">{prop.target}</span>
                        </span>
                        <span className="text-slate-400">
                          +{prop.astAddedLines}/-{prop.astRemovedLines}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Center Pane (5 Cols): PR Metadata + Multi-Rule AST Gate + Unified Diff Editor */}
            <div className="lg:col-span-5 space-y-4">
              <div className="p-4 rounded-2xl nf-card space-y-2.5 font-mono text-xs">
                <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
                  <div className="flex items-center space-x-2">
                    <GitPullRequest className="w-4 h-4 text-emerald-400" />
                    <span className="text-white font-bold text-sm">Pull Request #{current.prNumber}</span>
                    {current.isRealGitHubPr && current.githubUrl ? (
                      <a
                        href={current.githubUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-cyan-300 hover:text-white underline flex items-center space-x-1 ml-2"
                      >
                        <span>Open on GitHub</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : (
                      <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                        Sandbox PR
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-white/5 border border-white/10 text-slate-300">
                    SHA: {current.commitSha}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3 text-[11px] pt-0.5">
                  <div>
                    <span className="text-slate-500 block text-[9px] uppercase">REPOSITORY</span>
                    <span className="text-white font-bold truncate block">{current.repository}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[9px] uppercase">BRANCH MERGE TARGET</span>
                    <span className="text-emerald-300 flex items-center space-x-1 truncate">
                      <GitBranch className="w-3 h-3 shrink-0" />
                      <span className="truncate">
                        {current.headBranch || 'patch'} → {current.targetBranch}
                      </span>
                    </span>
                  </div>
                </div>
              </div>

              {/* Multi-Rule AST Security Gate Banner */}
              <div
                className={`p-4 rounded-2xl border space-y-2 ${
                  current.astStatus === 'PASS'
                    ? 'bg-emerald-950/40 border-emerald-500/50'
                    : 'bg-rose-950/60 border-rose-500/60'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2.5">
                    {current.astStatus === 'PASS' ? (
                      <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
                    ) : (
                      <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0" />
                    )}
                    <span
                      className={`text-xs font-bold font-mono ${
                        current.astStatus === 'PASS' ? 'text-emerald-300' : 'text-rose-300'
                      }`}
                    >
                      AST STATIC ANALYSIS: {current.astStatus === 'PASS' ? 'VERIFIED (PASS)' : 'BLOCKED (HTTP 422)'}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-300 bg-black/30 px-2 py-0.5 rounded">
                    {current.astNodesScanned} tokens • +{current.astAddedLines}/-{current.astRemovedLines} lines
                  </span>
                </div>

                <div className="text-[11px] text-slate-200 leading-relaxed">{current.astMessage}</div>

                {current.astFindings.length > 0 && (
                  <div className="space-y-1 pt-1">
                    {current.astFindings.map((f, i) => (
                      <div
                        key={i}
                        className="p-2 rounded-lg bg-black/40 border border-rose-500/40 font-mono text-[10px] text-rose-200"
                      >
                        <strong>[{f.ruleId} • Line {f.lineNumber}]</strong> {f.explanation}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Diff Viewer & Live AST Editor */}
              <div className="rounded-2xl nf-card overflow-hidden">
                <div className="p-3.5 border-b border-white/10 flex items-center justify-between bg-[#101420] font-mono text-xs">
                  <div className="flex items-center space-x-2 truncate">
                    <FileCode className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span className="text-white font-bold truncate">{current.target}</span>
                  </div>
                  {!isEditingDiff ? (
                    <button
                      onClick={handleStartEdit}
                      className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] text-emerald-300 flex items-center space-x-1 transition shrink-0"
                    >
                      <Edit3 className="w-3 h-3" />
                      <span>Edit Diff &amp; Re-Scan AST</span>
                    </button>
                  ) : (
                    <button
                      onClick={handleSaveDiff}
                      className="px-2.5 py-1 rounded-lg bg-emerald-500 text-slate-950 font-bold text-[11px] flex items-center space-x-1 shrink-0"
                    >
                      <Check className="w-3 h-3" />
                      <span>Re-Scan AST &amp; Save</span>
                    </button>
                  )}
                </div>

                {isEditingDiff ? (
                  <div className="p-4 bg-[#05070B] space-y-2">
                    <div className="text-[11px] font-mono text-slate-300">
                      Modify the diff below. Adding <code className="text-rose-400">+ curl ... | bash</code>, <code className="text-rose-400">+ privileged: true</code>, or <code className="text-rose-400">+ 0.0.0.0/0</code> will trigger a deterministic AST block:
                    </div>
                    <textarea
                      value={draftDiff}
                      onChange={(e) => setDraftDiff(e.target.value)}
                      rows={13}
                      className="w-full bg-[#090C14] border border-emerald-500/40 rounded-xl p-3 font-mono text-xs text-emerald-200 focus:outline-none"
                    />
                  </div>
                ) : (
                  <div className="p-4 bg-[#05070B] font-mono text-xs overflow-x-auto leading-relaxed space-y-0.5 max-h-[380px]">
                    {current.diff.map((line, idx) => {
                      const isAdd = line.startsWith('+') && !line.startsWith('+++');
                      const isDel = line.startsWith('-') && !line.startsWith('---');
                      const hasViolation = current.astFindings.some((f) => f.lineNumber === idx + 1);
                      return (
                        <div
                          key={idx}
                          className={`py-0.5 px-2 rounded flex items-center space-x-3 ${
                            hasViolation
                              ? 'bg-rose-600/30 text-rose-200 font-bold border border-rose-500'
                              : isAdd
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : isDel
                              ? 'bg-rose-500/15 text-rose-300'
                              : 'text-slate-400'
                          }`}
                        >
                          <span className="text-slate-600 select-none w-5 text-right text-[10px]">{idx + 1}</span>
                          <span className="flex-1 break-all">{line}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Right Pane (4 Cols): Per-PR Telemetry, 5-Whys Causal Chain & Canary Controller */}
            <div className="lg:col-span-4 space-y-4">
              <div className="p-6 rounded-2xl nf-card space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono font-bold text-emerald-400 uppercase tracking-wider">
                    Incident Context • {current.service}
                  </span>
                  <span
                    className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${
                      current.status === 'APPROVED'
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : current.status === 'DECLINED'
                        ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                        : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                    }`}
                  >
                    {current.status === 'APPROVED' ? 'MERGED' : current.status}
                  </span>
                </div>

                <div className="text-base font-bold text-white leading-snug">{current.title}</div>

                {/* Per-PR Sub-Navigation Tabs */}
                <div className="grid grid-cols-3 gap-1 bg-[#090C14] p-1 rounded-xl border border-white/10 font-mono text-[10px]">
                  <button
                    onClick={() => setRcaTab('TELEMETRY')}
                    className={`py-1.5 rounded-lg font-bold transition flex items-center justify-center space-x-1 ${
                      rcaTab === 'TELEMETRY' ? 'bg-emerald-500 text-slate-950 shadow' : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    <Activity className="w-3 h-3" />
                    <span>Telemetry</span>
                  </button>
                  <button
                    onClick={() => setRcaTab('CAUSAL_TREE')}
                    className={`py-1.5 rounded-lg font-bold transition flex items-center justify-center space-x-1 ${
                      rcaTab === 'CAUSAL_TREE' ? 'bg-emerald-500 text-slate-950 shadow' : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    <Zap className="w-3 h-3" />
                    <span>5-Whys RCA</span>
                  </button>
                  <button
                    onClick={() => setRcaTab('CANARY_SPLIT')}
                    className={`py-1.5 rounded-lg font-bold transition flex items-center justify-center space-x-1 ${
                      rcaTab === 'CANARY_SPLIT' ? 'bg-emerald-500 text-slate-950 shadow' : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    <Layers className="w-3 h-3" />
                    <span>Canary ({current.canaryPercentage}%)</span>
                  </button>
                </div>

                {/* TAB 1: DYNAMIC PER-PR TELEMETRY SIGNATURE */}
                {rcaTab === 'TELEMETRY' && (
                  <div className="space-y-3 font-mono text-xs">
                    <p className="text-xs text-slate-300 leading-relaxed font-sans">{current.rcaSummary}</p>

                    <div className="p-3.5 rounded-xl bg-[#07090F] border border-white/10 space-y-2 text-[11px]">
                      <div className="text-[10px] text-emerald-400 font-bold uppercase">
                        Service Telemetry Signature ({current.service})
                      </div>
                      <div className="flex justify-between text-slate-300 gap-2">
                        <span className="text-slate-400">Impacted Route:</span>
                        <span className="text-rose-300 font-bold truncate">{current.telemetryProfile.failingEndpoint}</span>
                      </div>
                      <div className="flex justify-between text-slate-300 gap-2">
                        <span className="text-slate-400">Downstream Dependency:</span>
                        <span className="text-white font-bold truncate">{current.telemetryProfile.downstreamTarget}</span>
                      </div>
                      <div className="flex justify-between text-slate-300 gap-2">
                        <span className="text-slate-400">{current.telemetryProfile.saturationMetricLabel}:</span>
                        <span className="text-amber-300 font-bold">{current.telemetryProfile.saturationMetricValue}</span>
                      </div>
                      <div className="flex justify-between text-slate-300 gap-2">
                        <span className="text-slate-400">{current.telemetryProfile.secondaryMetricLabel}:</span>
                        <span className="text-cyan-300 font-bold">{current.telemetryProfile.secondaryMetricValue}</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[10px]">
                      <div className="p-2.5 rounded-xl bg-[#090C14] border border-white/10">
                        <span className="text-slate-400 block">PRE-PATCH P99 LATENCY</span>
                        <span className="text-rose-400 font-bold text-sm">
                          {current.telemetryProfile.baselineP99Ms} ms ({current.telemetryProfile.baselineErrorPct}% err)
                        </span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-[#090C14] border border-white/10">
                        <span className="text-slate-400 block">POST-PATCH CANARY P99</span>
                        <span className="text-emerald-400 font-bold text-sm">
                          {current.telemetryProfile.canaryP99Ms} ms ({current.telemetryProfile.canaryErrorPct}% err)
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* TAB 2: DYNAMIC PER-PR 5-WHYS CAUSAL CHAIN */}
                {rcaTab === 'CAUSAL_TREE' && (
                  <div className="p-3.5 rounded-xl bg-[#07090F] border border-white/10 space-y-2.5 font-mono text-[11px]">
                    <div className="text-[10px] text-emerald-400 font-bold uppercase">
                      5-Whys Root Cause Chain (PR #{current.prNumber})
                    </div>
                    <div className="space-y-2 text-slate-200 leading-relaxed font-sans">
                      {current.causalChain.map((step, idx) => (
                        <div
                          key={idx}
                          className={`p-2 rounded-lg border ${
                            idx === current.causalChain.length - 1
                              ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-200 font-semibold'
                              : 'bg-[#0B0E17] border-white/5'
                          }`}
                        >
                          {step}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* TAB 3: DYNAMIC PER-PR CANARY TRAFFIC CONTROLLER */}
                {rcaTab === 'CANARY_SPLIT' && (
                  <div className="space-y-3 font-mono text-xs">
                    <div className="p-3.5 rounded-xl bg-[#07090F] border border-white/10 space-y-2.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-slate-300 font-bold uppercase">Traffic Split Weight</span>
                        <span className="text-emerald-400 font-bold">{current.canaryPercentage}% Canary</span>
                      </div>

                      <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden flex">
                        <div
                          style={{ width: `${100 - current.canaryPercentage}%` }}
                          className="bg-slate-600 transition-all duration-300"
                        />
                        <div
                          style={{ width: `${current.canaryPercentage}%` }}
                          className="bg-gradient-to-r from-emerald-400 to-teal-400 transition-all duration-300"
                        />
                      </div>

                      <div className="flex justify-between text-[10px] text-slate-400">
                        <span>Baseline Pods ({100 - current.canaryPercentage}%)</span>
                        <span className="text-emerald-300 font-bold">Patched Canary ({current.canaryPercentage}%)</span>
                      </div>

                      <div className="grid grid-cols-5 gap-1.5 pt-1">
                        {[0, 10, 25, 50, 100].map((pct) => (
                          <button
                            key={pct}
                            onClick={() => setCanaryStage(current.taskId, pct)}
                            className={`py-1.5 rounded-lg text-[10px] font-bold border transition ${
                              current.canaryPercentage === pct
                                ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow'
                                : 'bg-[#090C14] text-slate-300 border-white/10 hover:text-white'
                            }`}
                          >
                            {pct}%
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="p-3 rounded-xl bg-[#07090F] border border-white/10 space-y-2 text-[11px]">
                      <div className="text-[10px] text-slate-400 font-bold uppercase">
                        Live Canary Verification ({current.service})
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-center">
                        <div className="p-2 rounded bg-[#0D111C] border border-white/5">
                          <div className="text-[9px] text-slate-400">BASELINE P99</div>
                          <div className="text-rose-400 font-bold text-sm mt-0.5">
                            {current.telemetryProfile.baselineP99Ms} ms
                          </div>
                        </div>
                        <div className="p-2 rounded bg-[#0D111C] border border-white/5">
                          <div className="text-[9px] text-slate-400">CANARY P99</div>
                          <div className="text-emerald-400 font-bold text-sm mt-0.5">
                            {current.telemetryProfile.canaryP99Ms} ms
                          </div>
                        </div>
                      </div>
                      <div className="flex justify-between text-[10px] text-slate-300 pt-1">
                        <span>
                          Canary Error Rate: <strong className="text-emerald-400">{current.telemetryProfile.canaryErrorPct}%</strong>
                        </span>
                        <span>
                          Auto-Rollback Gate: <strong className="text-emerald-300">ARMED (&lt;0.5% threshold)</strong>
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Merge, Decline & Rollback Action Controls */}
                {current.status === 'APPROVED' && (
                  <div className="p-4 rounded-xl bg-emerald-950/50 border border-emerald-500/50 text-xs font-mono text-emerald-200 space-y-3">
                    <div className="font-bold text-emerald-400 flex items-center space-x-1.5">
                      <Check className="w-4 h-4" />
                      <span>
                        PR #{current.prNumber} MERGED ({current.canaryPercentage}% TRAFFIC)
                      </span>
                    </div>
                    <div className="flex items-center space-x-2 pt-1">
                      <button
                        onClick={() => rollbackPR(current.taskId)}
                        className="flex-1 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-amber-300 font-bold flex items-center justify-center space-x-1.5 transition"
                      >
                        <Undo2 className="w-3.5 h-3.5" />
                        <span>Revert Canary &amp; Rollback</span>
                      </button>
                      <button
                        onClick={() => reopenPR(current.taskId)}
                        className="px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 transition"
                      >
                        Re-Open
                      </button>
                    </div>
                  </div>
                )}

                {current.status === 'DECLINED' && (
                  <div className="p-4 rounded-xl bg-rose-950/50 border border-rose-500/50 text-xs font-mono text-rose-200 space-y-3">
                    <div className="font-bold text-rose-400 flex items-center space-x-1.5">
                      <X className="w-4 h-4" />
                      <span>PULL REQUEST CLOSED / DECLINED</span>
                    </div>
                    <div>Reason: {current.declineReason || 'Operator Refused'}</div>
                    <div className="flex items-center space-x-2 pt-1">
                      <button
                        onClick={() => reopenPR(current.taskId)}
                        className="flex-1 py-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/50 text-emerald-300 font-bold flex items-center justify-center space-x-1.5 transition"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Re-Open Proposal</span>
                      </button>
                    </div>
                  </div>
                )}

                {current.status === 'PENDING' && showConfirm && (
                  <div className="p-4 rounded-xl bg-[#101420] border border-amber-400/50 space-y-3">
                    <div className="flex items-center justify-between text-amber-300 text-xs font-mono font-bold">
                      <span className="flex items-center space-x-1.5">
                        <AlertTriangle className="w-4 h-4" />
                        <span>Confirm Merge Authorization</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setTaskToken(current.taskId)}
                        className="text-[10px] text-emerald-400 underline hover:text-emerald-300"
                      >
                        Auto-fill token
                      </button>
                    </div>
                    <input
                      type="text"
                      value={taskToken}
                      onChange={(e) => setTaskToken(e.target.value)}
                      placeholder={current.taskId}
                      className="w-full bg-[#05070B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-emerald-400"
                    />
                    <div className="flex items-center space-x-2 pt-1">
                      <button
                        onClick={handleApprove}
                        className="flex-1 py-2 bg-emerald-400 hover:bg-emerald-300 text-slate-950 font-bold rounded-lg text-xs font-mono transition"
                      >
                        {current.isRealGitHubPr
                          ? `Execute PUT /pulls/${current.prNumber}/merge`
                          : 'Confirm Sandbox Merge'}
                      </button>
                      <button
                        onClick={() => setShowConfirm(false)}
                        className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-mono"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {current.status === 'PENDING' && showDeclineReasons && (
                  <div className="p-4 rounded-xl bg-[#101420] border border-rose-500/50 space-y-2.5">
                    <div className="text-xs font-mono font-bold text-rose-300">
                      Select Refusal Reason (Sealed to Merkle Ledger):
                    </div>
                    <div className="grid grid-cols-1 gap-1.5">
                      {declineReasons.map((r) => (
                        <button
                          key={r}
                          onClick={() => handleDeclineWithReason(r)}
                          className="w-full text-left px-3 py-2 rounded-lg bg-[#05070B] hover:bg-rose-500/20 border border-white/10 hover:border-rose-500/40 text-xs font-mono text-slate-200 hover:text-rose-200 transition"
                        >
                          • {r}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => setShowDeclineReasons(false)}
                      className="text-[11px] font-mono text-slate-400 hover:text-white pt-1"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {current.status === 'PENDING' && !showConfirm && !showDeclineReasons && (
                  <div className="space-y-2.5 pt-2">
                    {current.astStatus === 'REJECT' && (
                      <button
                        onClick={() => {
                          const sanitized = current.diff.filter(
                            (l) =>
                              !/(curl|wget)\s+.*\|\s*(bash|sh|zsh)|\brm\s+-rf\b|privileged:\s*true|0\.0\.0\.0\/0/i.test(l)
                          );
                          updateProposalDiff(current.taskId, [
                            ...sanitized,
                            '+  # Sanitized by Operator: Removed policy-violating line',
                          ]);
                        }}
                        className="w-full py-2.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-amber-300 text-xs font-mono font-bold transition flex items-center justify-center space-x-2"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>Sanitize Violating Line &amp; Re-Scan AST</span>
                      </button>
                    )}

                    <div className="flex items-center space-x-3">
                      <button
                        onClick={handleApprove}
                        disabled={current.astStatus === 'REJECT'}
                        className={`flex-1 py-3 rounded-xl text-xs font-mono font-bold transition flex items-center justify-center space-x-2 ${
                          current.astStatus === 'REJECT'
                            ? 'bg-slate-800/80 text-slate-500 cursor-not-allowed border border-white/5'
                            : 'bg-gradient-to-r from-emerald-400 to-teal-500 hover:from-emerald-300 hover:to-teal-400 text-slate-950 shadow-lg shadow-emerald-500/20'
                        }`}
                      >
                        <Check className="w-4 h-4" />
                        <span>
                          {current.isRealGitHubPr
                            ? `Merge PR #${current.prNumber} on GitHub`
                            : 'Authorize & Merge PR'}
                        </span>
                      </button>
                      <button
                        onClick={() => setShowDeclineReasons(true)}
                        className="px-4 py-3 bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-300 rounded-xl text-xs font-mono font-bold transition flex items-center justify-center space-x-1.5"
                      >
                        <X className="w-4 h-4" />
                        <span>Decline</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      )}
    </div>
  );
}

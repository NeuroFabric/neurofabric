import { useState } from 'react';
import { useTelemetry } from '../context/TelemetryContext';
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
} from 'lucide-react';
import { toast } from 'sonner';
import { InfoTooltip } from '../components/common/Tooltip';

function GitHubIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
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
    synthesizeProposal,
    resetProposals,
    githubConfig,
    saveGitHubConfig,
    syncGitHubPRs,
    disconnectGitHub,
  } = useTelemetry();

  const [queueFilter, setQueueFilter] = useState<'ALL' | 'PENDING' | 'BLOCKED' | 'ACTIONED'>('ALL');
  const [selectedId, setSelectedId] = useState<string>(proposals[0]?.taskId || 'task-auth-gw-892');
  const [rcaTab, setRcaTab] = useState<'TELEMETRY' | 'CAUSAL_TREE' | 'CANARY_SPLIT'>('TELEMETRY');
  const [taskToken, setTaskToken] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [showDeclineReasons, setShowDeclineReasons] = useState(false);
  const [isEditingDiff, setIsEditingDiff] = useState(false);
  const [draftDiff, setDraftDiff] = useState('');

  const [showGitModal, setShowGitModal] = useState(false);
  const [patInput, setPatInput] = useState(githubConfig.token || '');
  const [repoInput, setRepoInput] = useState(githubConfig.repo || 'NeuroFabric/neurofabric');
  const [branchInput, setBranchInput] = useState(githubConfig.branch || 'main');

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
    setDraftDiff(current.diff.join('\n'));
    setIsEditingDiff(true);
  };

  const handleSaveDiff = () => {
    updateProposalDiff(current.taskId, draftDiff.split('\n'));
    setIsEditingDiff(false);
  };

  const handleApprove = async () => {
    if (current.astStatus === 'REJECT') {
      toast.error('AST Gate Policy Lock (HTTP 422)', {
        description: 'Cannot dispatch a proposal containing prohibited shell primitives.',
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
        description: `Click "Auto-fill token" or type "${current.taskId}" to authorize.`,
      });
      return;
    }
    await authorizePR(current.taskId, current.target, current.diff.join('\n'));
    setShowConfirm(false);
    setTaskToken('');
  };

  const handleDeclineWithReason = async (reason: string) => {
    await declinePR(current.taskId, current.target, reason);
    setShowDeclineReasons(false);
    setShowConfirm(false);
  };

  const handleConnectGitHub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!patInput.trim()) {
      toast.error('Personal Access Token Required', { description: 'Create a GitHub PAT with "repo" scope.' });
      return;
    }
    await saveGitHubConfig(patInput, repoInput, branchInput);
    setShowGitModal(false);
  };

  const declineReasons = [
    'False Positive RCA',
    'Blast Radius Too Wide',
    'Malicious AST Primitive',
    'Defer to Maintenance Window',
  ];

  const pendingCount = proposals.filter((p) => p.status === 'PENDING').length;
  const canaryPct = current.canaryPercentage || 10;
  const baselinePct = 100 - canaryPct;

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-2xl font-bold text-white tracking-tight">
              Autonomous Embassy — GitOps Patch Review (HITL)
            </h1>
            <InfoTooltip content="Human-in-the-Loop GitOps review. Connect your GitHub repository to screen, deploy canary traffic, and merge real pull requests on github.com." />
          </div>

          <div className="flex items-center space-x-3 mt-1 text-xs">
            {githubConfig.isConnected ? (
              <span className="flex items-center space-x-1.5 font-mono text-emerald-400 font-bold">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                <span>Live GitHub Sync:</span>
                <a
                  href={`https://github.com/${githubConfig.repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-white flex items-center space-x-1"
                >
                  <span>{githubConfig.repo}</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
                <span className="text-slate-400">({githubConfig.branch})</span>
              </span>
            ) : (
              <span className="text-slate-400 font-mono flex items-center space-x-2">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                <span>Target: github.com/{githubConfig.repo} • Mode: Local Simulation</span>
                <button
                  onClick={() => setShowGitModal(true)}
                  className="text-emerald-400 underline hover:text-emerald-300 font-bold ml-1"
                >
                  Connect GitHub Token
                </button>
              </span>
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
                <span>{githubConfig.isSyncing ? 'Syncing...' : 'Fetch Live GitHub PRs'}</span>
              </button>
              <button
                onClick={disconnectGitHub}
                className="px-2.5 py-1.5 rounded-xl bg-white/5 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 text-xs font-mono transition"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={() => setShowGitModal(true)}
              className="px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-emerald-500/20 to-teal-500/20 hover:from-emerald-500/30 hover:to-teal-500/30 border border-emerald-400/50 text-emerald-300 text-xs font-mono font-bold flex items-center space-x-1.5 transition shadow"
            >
              <GitHubIcon className="w-3.5 h-3.5" />
              <span>Connect Live GitHub Repo</span>
            </button>
          )}

          <button
            onClick={bulkApproveVerified}
            className="px-3 py-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/40 text-emerald-300 text-xs font-mono font-bold flex items-center space-x-1.5 transition"
          >
            <CheckCheck className="w-3.5 h-3.5" />
            <span>Bulk Approve</span>
          </button>
          <button
            onClick={bulkDeclineBlocked}
            className="px-3 py-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-300 text-xs font-mono font-bold flex items-center space-x-1.5 transition"
          >
            <X className="w-3.5 h-3.5" />
            <span>Refuse Blocked</span>
          </button>
          <button
            onClick={async () => {
              const newId = await synthesizeProposal('order-service');
              setSelectedId(newId);
            }}
            className="px-3.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-mono font-bold flex items-center space-x-1.5 transition shadow-lg shadow-emerald-500/20"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Synthesize Patch</span>
          </button>
          <button
            onClick={resetProposals}
            className="px-3 py-1.5 rounded-xl bg-[#121622] hover:bg-slate-800 border border-white/10 text-xs font-mono text-slate-300 flex items-center space-x-1.5 transition"
          >
            <RotateCcw className="w-3.5 h-3.5 text-emerald-400" />
            <span>Reset</span>
          </button>
        </div>
      </div>

      {/* GitHub PAT Connection Modal */}
      {showGitModal && (
        <form
          onSubmit={handleConnectGitHub}
          className="p-6 rounded-2xl nf-card border border-emerald-400/50 space-y-4 animate-in fade-in duration-150"
        >
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <div className="flex items-center space-x-2 font-mono text-xs font-bold text-white uppercase">
              <GitHubIcon className="w-4 h-4 text-emerald-400" />
              <span>Connect Live GitHub Repository for Actual PR Creation & Merges</span>
            </div>
            <button
              type="button"
              onClick={() => setShowGitModal(false)}
              className="text-xs font-mono text-slate-400 hover:text-white"
            >
              Cancel
            </button>
          </div>

          <p className="text-xs text-slate-300 leading-relaxed font-sans">
            Paste a GitHub Personal Access Token (PAT) with <code className="text-emerald-400">repo</code> permissions.
            The Embassy agent will fetch your real open pull requests from <code className="text-white">github.com/{repoInput}</code>,
            screen their live diffs, and perform merges on GitHub.
          </p>

          <div className="grid md:grid-cols-3 gap-4 font-mono text-xs">
            <div>
              <label className="text-[10px] text-slate-400 block mb-1">
                GITHUB PERSONAL ACCESS TOKEN (PAT)
              </label>
              <div className="relative">
                <Key className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                <input
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
              <label className="text-[10px] text-slate-400 block mb-1">TARGET REPO (OWNER/REPO)</label>
              <input
                type="text"
                required
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                placeholder="NeuroFabric/neurofabric"
                className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-emerald-400"
              />
            </div>

            <div>
              <label className="text-[10px] text-slate-400 block mb-1">TARGET BRANCH</label>
              <input
                type="text"
                required
                value={branchInput}
                onChange={(e) => setBranchInput(e.target.value)}
                placeholder="main"
                className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-emerald-400"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <span className="text-[10px] font-mono text-slate-500">
              Tokens remain local to your browser session and are never logged to disk.
            </span>
            <button
              type="submit"
              className="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold font-mono text-xs rounded-xl transition shadow-lg shadow-emerald-500/20"
            >
              Authenticate & Sync Real PRs
            </button>
          </div>
        </form>
      )}

      {/* 3-Pane Console */}
      <div className="grid lg:grid-cols-12 gap-6">
        {/* Left Pane (3 Cols): Proposal Queue */}
        <div className="lg:col-span-3 space-y-3">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] font-mono font-bold uppercase tracking-wider text-slate-400">
              PR Queue ({filteredQueue.length} / {proposals.length})
            </span>
            <span className="text-[10px] font-mono text-amber-400 font-bold">{pendingCount} Pending</span>
          </div>

          <div className="grid grid-cols-4 gap-1 bg-[#090C14] p-1 rounded-xl border border-white/10 font-mono text-[10px]">
            {(['ALL', 'PENDING', 'BLOCKED', 'ACTIONED'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setQueueFilter(f)}
                className={`py-1 rounded-lg font-bold transition ${
                  queueFilter === f ? 'bg-emerald-500 text-slate-950' : 'text-slate-400 hover:text-white'
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          <div className="space-y-2.5 max-h-[580px] overflow-y-auto pr-1">
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
                    <span className="text-[10px] font-mono text-slate-400 font-bold flex items-center space-x-1">
                      {prop.isRealGitHubPr && <GitHubIcon className="w-3 h-3 text-emerald-400" />}
                      <span>PR #{prop.prNumber}</span>
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
                      {prop.status === 'PENDING' && prop.astStatus === 'REJECT' ? 'AST BLOCKED' : prop.status}
                    </span>
                  </div>
                  <div className="text-xs font-bold text-white leading-snug">{prop.title}</div>
                  <div className="text-[10px] font-mono text-emerald-400 truncate flex items-center space-x-1">
                    <FileCode className="w-3 h-3 shrink-0" />
                    <span className="truncate">{prop.target}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Center Pane (5 Cols): Diff Viewer + AST Banner */}
        <div className="lg:col-span-5 space-y-4">
          <div className="p-4 rounded-2xl nf-card space-y-2 font-mono text-xs">
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <div className="flex items-center space-x-2">
                <GitPullRequest className="w-4 h-4 text-emerald-400" />
                <span className="text-white font-bold text-sm">Pull Request #{current.prNumber}</span>
                <a
                  href={`https://github.com/${current.repository}/pull/${current.prNumber}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-cyan-300 hover:text-white underline flex items-center space-x-1 ml-2"
                >
                  <span>github.com PR</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded bg-white/5 border border-white/10 text-slate-300">
                Commit: {current.commitSha}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400 pt-1">
              <div>
                <span className="text-slate-500 block text-[9px]">TARGET FLEET</span>
                <span className="text-white truncate block">{current.repository}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[9px]">TARGET BRANCH</span>
                <span className="text-emerald-300 flex items-center space-x-1">
                  <GitBranch className="w-3 h-3" />
                  <span>{current.targetBranch}</span>
                </span>
              </div>
            </div>
          </div>

          {current.astStatus === 'PASS' ? (
            <div className="p-4 rounded-2xl bg-emerald-950/50 border border-emerald-500/50 flex items-center space-x-3">
              <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
              <div>
                <div className="text-xs font-bold text-emerald-300 font-mono">AST SECURITY GATE: VERIFIED (PASS)</div>
                <div className="text-[11px] text-emerald-200/80 mt-0.5">{current.astMessage}</div>
              </div>
            </div>
          ) : (
            <div className="p-4 rounded-2xl bg-rose-950/60 border border-rose-500/60 flex items-center space-x-3">
              <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0" />
              <div>
                <div className="text-xs font-bold text-rose-300 font-mono">AST SECURITY GATE: BLOCKED (HTTP 422)</div>
                <div className="text-[11px] text-rose-200/90 mt-0.5">{current.astMessage}</div>
              </div>
            </div>
          )}

          <div className="rounded-2xl nf-card overflow-hidden">
            <div className="p-3.5 border-b border-white/10 flex items-center justify-between bg-[#101420] font-mono text-xs">
              <div className="flex items-center space-x-2">
                <FileCode className="w-4 h-4 text-emerald-400" />
                <span className="text-white font-bold">{current.target}</span>
              </div>
              {!isEditingDiff ? (
                <button
                  onClick={handleStartEdit}
                  className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] text-emerald-300 flex items-center space-x-1 transition"
                >
                  <Edit3 className="w-3 h-3" />
                  <span>Edit Diff & Re-Screen AST</span>
                </button>
              ) : (
                <button
                  onClick={handleSaveDiff}
                  className="px-2.5 py-1 rounded-lg bg-emerald-500 text-slate-950 font-bold text-[11px] flex items-center space-x-1"
                >
                  <Check className="w-3 h-3" />
                  <span>Run AST Gate & Save</span>
                </button>
              )}
            </div>

            {isEditingDiff ? (
              <div className="p-4 bg-[#05070B] space-y-2">
                <div className="text-[11px] font-mono text-slate-400">
                  Tip: Remove or add <code className="text-rose-400">curl | bash</code> to test live AST blocking:
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
                  const isAdd = line.startsWith('+');
                  const isDel = line.startsWith('-');
                  const isFlagged = /(curl\s+.*\|\s*(bash|sh)|rm\s+-rf)/i.test(line);
                  return (
                    <div
                      key={idx}
                      className={`py-0.5 px-2 rounded flex items-center space-x-3 ${
                        isFlagged
                          ? 'bg-rose-600/30 text-rose-200 font-bold border border-rose-500'
                          : isAdd
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : isDel
                          ? 'bg-rose-500/15 text-rose-300'
                          : 'text-slate-400'
                      }`}
                    >
                      <span className="text-slate-600 select-none w-5 text-right text-[10px]">{idx + 1}</span>
                      <span className="flex-1">{line}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Pane (4 Cols): Enterprise SRE RCA & Interactive Canary Engine */}
        <div className="lg:col-span-4 space-y-4">
          <div className="p-6 rounded-2xl nf-card space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono font-bold text-emerald-400 uppercase tracking-wider">
                Autonomous RCA Evaluation
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
                STATUS: {current.status}
              </span>
            </div>

            <div className="text-lg font-bold text-white">{current.title}</div>

            {/* RCA Sub-Navigation Tabs */}
            <div className="grid grid-cols-3 gap-1 bg-[#090C14] p-1 rounded-xl border border-white/10 font-mono text-[10px]">
              <button
                onClick={() => setRcaTab('TELEMETRY')}
                className={`py-1.5 rounded-lg font-bold transition flex items-center justify-center space-x-1 ${
                  rcaTab === 'TELEMETRY' ? 'bg-emerald-500 text-slate-950 shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Activity className="w-3 h-3" />
                <span>Telemetry</span>
              </button>
              <button
                onClick={() => setRcaTab('CAUSAL_TREE')}
                className={`py-1.5 rounded-lg font-bold transition flex items-center justify-center space-x-1 ${
                  rcaTab === 'CAUSAL_TREE' ? 'bg-emerald-500 text-slate-950 shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Zap className="w-3 h-3" />
                <span>5-Whys</span>
              </button>
              <button
                onClick={() => setRcaTab('CANARY_SPLIT')}
                className={`py-1.5 rounded-lg font-bold transition flex items-center justify-center space-x-1 ${
                  rcaTab === 'CANARY_SPLIT' ? 'bg-emerald-500 text-slate-950 shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Layers className="w-3 h-3" />
                <span>Canary ({canaryPct}%)</span>
              </button>
            </div>

            {/* TAB 1: REALISTIC TELEMETRY & TRACE CONTEXT */}
            {rcaTab === 'TELEMETRY' && (
              <div className="space-y-3 font-mono text-xs animate-in fade-in duration-150">
                <p className="text-xs text-slate-300 leading-relaxed font-sans">{current.rcaSummary}</p>

                <div className="p-3 rounded-xl bg-[#07090F] border border-white/10 space-y-1.5 text-[11px]">
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Failure Signature</div>
                  <div className="flex justify-between text-slate-300">
                    <span>Failing Endpoint:</span>
                    <span className="text-rose-400 font-bold">POST /v1/auth/tokens/verify</span>
                  </div>
                  <div className="flex justify-between text-slate-300">
                    <span>Downstream Target:</span>
                    <span className="text-white font-bold">aurora-pg-primary:5432</span>
                  </div>
                  <div className="flex justify-between text-slate-300">
                    <span>Pool Active Sockets:</span>
                    <span className="text-rose-400 font-bold">100 / 100 (Max Capacity)</span>
                  </div>
                  <div className="flex justify-between text-slate-300">
                    <span>Kernel Sockets in TIME_WAIT:</span>
                    <span className="text-amber-400 font-bold">4,192 sockets</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[10px]">
                  <div className="p-2.5 rounded-xl bg-[#090C14] border border-white/10">
                    <span className="text-slate-500 block">BASELINE P99</span>
                    <span className="text-rose-400 font-bold text-sm">4,850 ms</span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-[#090C14] border border-white/10">
                    <span className="text-slate-500 block">EXPECTED POST-PATCH</span>
                    <span className="text-emerald-400 font-bold text-sm">18.4 ms</span>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: CAUSAL CHAIN & 5-WHYS */}
            {rcaTab === 'CAUSAL_TREE' && (
              <div className="p-3.5 rounded-xl bg-[#07090F] border border-white/10 space-y-2.5 font-mono text-[11px] animate-in fade-in duration-150">
                <div className="text-[10px] text-emerald-400 font-bold uppercase">Autonomous Causal Tree (5-Whys)</div>
                <div className="space-y-2 text-slate-300 leading-snug">
                  <div>
                    <span className="text-slate-500 font-bold">1. Symptom:</span> HTTP 504 Gateway Timeouts surged on user token verification.
                  </div>
                  <div>
                    <span className="text-slate-500 font-bold">2. Trigger:</span> Upstream Redis cache eviction caused query latency to climb from 3ms to 310ms.
                  </div>
                  <div>
                    <span className="text-slate-500 font-bold">3. Bottleneck:</span> <code className="text-rose-400">MAX_IDLE_CONNS: 10</code> forced repeated socket destruction & SSL renegotiations under load.
                  </div>
                  <div>
                    <span className="text-slate-500 font-bold">4. Cascade:</span> Worker goroutines piled up waiting to acquire DB connections until the 5000ms timeout breached.
                  </div>
                  <div className="text-emerald-300 font-bold">
                    <span>5. Remedy:</span> Expanding idle pool to 50 with 2500ms fail-fast ceiling and 1024Mi memory envelope.
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: INTERACTIVE CANARY CONTROLLER & TELEMETRY COMPARISON */}
            {rcaTab === 'CANARY_SPLIT' && (
              <div className="space-y-3 font-mono text-xs animate-in fade-in duration-150">
                {/* Traffic Split Slider */}
                <div className="p-3.5 rounded-xl bg-[#07090F] border border-white/10 space-y-2.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-400 font-bold uppercase">Traffic Weight Distribution</span>
                    <span className="text-emerald-400 font-bold">{canaryPct}% Canary</span>
                  </div>

                  {/* Visual Split Bar */}
                  <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden flex">
                    <div style={{ width: `${baselinePct}%` }} className="bg-slate-600 transition-all duration-300" title={`Baseline: ${baselinePct}%`} />
                    <div style={{ width: `${canaryPct}%` }} className="bg-gradient-to-r from-emerald-400 to-teal-400 transition-all duration-300" title={`Canary: ${canaryPct}%`} />
                  </div>

                  <div className="flex justify-between text-[10px] text-slate-400 pt-0.5">
                    <span>Stable v2.8.0 ({baselinePct}%)</span>
                    <span className="text-emerald-300 font-bold">Canary v2.8.1-patch ({canaryPct}%)</span>
                  </div>

                  {/* Stage Shift Buttons */}
                  <div className="grid grid-cols-4 gap-1.5 pt-1">
                    {[10, 25, 50, 100].map((pct) => (
                      <button
                        key={pct}
                        onClick={() => setCanaryStage(current.taskId, pct)}
                        className={`py-1.5 rounded-lg text-[10px] font-bold border transition ${
                          canaryPct === pct
                            ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow'
                            : 'bg-[#090C14] text-slate-300 border-white/10 hover:text-white'
                        }`}
                      >
                        {pct}% Weight
                      </button>
                    ))}
                  </div>
                </div>

                {/* Comparative Live Telemetry */}
                <div className="p-3 rounded-xl bg-[#07090F] border border-white/10 space-y-2 text-[11px]">
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Canary vs. Baseline Telemetry</div>
                  <div className="grid grid-cols-2 gap-2 text-center">
                    <div className="p-2 rounded bg-[#0D111C] border border-white/5">
                      <div className="text-[9px] text-slate-500">STABLE P99 LATENCY</div>
                      <div className="text-rose-400 font-bold text-sm mt-0.5">142 ms</div>
                    </div>
                    <div className="p-2 rounded bg-[#0D111C] border border-white/5">
                      <div className="text-[9px] text-slate-500">CANARY P99 LATENCY</div>
                      <div className="text-emerald-400 font-bold text-sm mt-0.5">18 ms (-87%)</div>
                    </div>
                  </div>

                  <div className="flex justify-between text-[10px] text-slate-400 pt-1">
                    <span>Canary Error Rate: <strong className="text-emerald-400">0.01%</strong></span>
                    <span>Safety Gate: <strong className="text-emerald-300">PASSING</strong></span>
                  </div>
                </div>
              </div>
            )}

            {/* Merge & Rollback Controls */}
            {current.status === 'APPROVED' && (
              <div className="p-4 rounded-xl bg-emerald-950/50 border border-emerald-500/50 text-xs font-mono text-emerald-200 space-y-3">
                <div className="font-bold text-emerald-400 flex items-center space-x-1.5">
                  <Check className="w-4 h-4" />
                  <span>PR #{current.prNumber} MERGED & CANARY ACTIVE</span>
                </div>
                <div className="flex items-center space-x-2 pt-1">
                  <button
                    onClick={() => rollbackPR(current.taskId)}
                    className="flex-1 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-amber-300 font-bold flex items-center justify-center space-x-1.5 transition"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                    <span>Rollback GitOps PR</span>
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
                  <span>PROPOSAL DECLINED BY OPERATOR</span>
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
                  <button
                    onClick={handleStartEdit}
                    className="px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 transition"
                  >
                    Edit Diff
                  </button>
                </div>
              </div>
            )}

            {current.status === 'PENDING' && showConfirm && (
              <div className="p-4 rounded-xl bg-[#101420] border border-amber-400/50 space-y-3">
                <div className="flex items-center justify-between text-amber-300 text-xs font-mono font-bold">
                  <span className="flex items-center space-x-1.5">
                    <AlertTriangle className="w-4 h-4" />
                    <span>Confirm Production Merge</span>
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
                    Confirm & Merge on GitHub
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
                      const sanitized = current.diff.filter((l) => !/(curl\s+.*\|\s*(bash|sh)|rm\s+-rf)/i.test(l));
                      updateProposalDiff(current.taskId, [
                        ...sanitized,
                        '+  # Sanitized by Operator: Replaced shell pipe with verified internal RPC',
                      ]);
                    }}
                    className="w-full py-2.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-amber-300 text-xs font-mono font-bold transition flex items-center justify-center space-x-2"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>Sanitize Malicious Line & Re-Verify AST</span>
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
                    <span>{githubConfig.isConnected ? 'Authorize & Merge on GitHub' : 'Authorize & Merge PR'}</span>
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
    </div>
  );
}


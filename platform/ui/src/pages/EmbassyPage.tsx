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
} from 'lucide-react';
import { toast } from 'sonner';
import { InfoTooltip } from '../components/common/Tooltip';

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
  } = useTelemetry();

  const [queueFilter, setQueueFilter] = useState<'ALL' | 'PENDING' | 'BLOCKED' | 'ACTIONED'>('ALL');
  const [selectedId, setSelectedId] = useState<string>(proposals[0]?.taskId || 'task-auth-gw-892');
  const [taskToken, setTaskToken] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [showDeclineReasons, setShowDeclineReasons] = useState(false);
  const [isEditingDiff, setIsEditingDiff] = useState(false);
  const [draftDiff, setDraftDiff] = useState('');

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
        description: 'Cannot dispatch a proposal containing prohibited shell primitives. Click "Sanitize Malicious Line" first.',
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

  const declineReasons = [
    'False Positive RCA',
    'Blast Radius Too Wide',
    'Malicious AST Primitive',
    'Defer to Maintenance Window',
  ];

  const pendingCount = proposals.filter((p) => p.status === 'PENDING').length;

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-2xl font-bold text-white tracking-tight">
              Autonomous Embassy — GitOps Patch Review (HITL)
            </h1>
            <InfoTooltip content="Human-in-the-Loop review for agent-proposed pull requests. Inspect diffs, verify AST security screenings, adjust canary traffic, and authorize merge." />
          </div>
          <p className="text-xs text-slate-300 mt-1">
            Target Fleet: <span className="text-emerald-400 font-mono font-bold">github.com/NeuroFabric/infrastructure-fleet</span> • Branch: <span className="text-white font-mono">refs/heads/prod-cluster-us-east</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={bulkApproveVerified}
            className="px-3 py-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/40 text-emerald-300 text-xs font-mono font-bold flex items-center space-x-1.5 transition"
          >
            <CheckCheck className="w-3.5 h-3.5" />
            <span>Bulk Approve Verified</span>
          </button>
          <button
            onClick={bulkDeclineBlocked}
            className="px-3 py-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-300 text-xs font-mono font-bold flex items-center space-x-1.5 transition"
          >
            <X className="w-3.5 h-3.5" />
            <span>Refuse All Blocked</span>
          </button>
          <button
            onClick={() => {
              const newId = synthesizeProposal('order-service');
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

      {/* 3-Pane Review Console */}
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

          <div className="space-y-2.5 max-h-[520px] overflow-y-auto pr-1">
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
                    <span className="text-[10px] font-mono text-slate-400 font-bold">PR #{prop.prNumber}</span>
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

        {/* Center Pane (5 Cols): GitOps PR Header + AST Banner + Diff Editor */}
        <div className="lg:col-span-5 space-y-4">
          {/* GitOps PR Metadata Header */}
          <div className="p-4 rounded-2xl nf-card space-y-2 font-mono text-xs">
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <div className="flex items-center space-x-2">
                <GitPullRequest className="w-4 h-4 text-emerald-400" />
                <span className="text-white font-bold text-sm">Pull Request #{current.prNumber}</span>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded bg-white/5 border border-white/10 text-slate-300">
                Commit: {current.commitSha}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400 pt-1">
              <div>
                <span className="text-slate-500 block text-[9px]">TARGET REPO</span>
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
                  rows={12}
                  className="w-full bg-[#090C14] border border-emerald-500/40 rounded-xl p-3 font-mono text-xs text-emerald-200 focus:outline-none"
                />
              </div>
            ) : (
              <div className="p-4 bg-[#05070B] font-mono text-xs overflow-x-auto leading-relaxed space-y-0.5">
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

        {/* Right Pane (4 Cols): RCA, Canary Traffic & Merge Authorization */}
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
            <p className="text-xs text-slate-300 leading-relaxed">{current.rcaSummary}</p>

            <div className="grid grid-cols-2 gap-3 font-mono text-xs">
              <div className="p-3 rounded-xl bg-[#090C14] border border-white/10">
                <div className="text-slate-400 text-[10px]">AGENT CONFIDENCE</div>
                <div className={`text-lg font-bold mt-1 ${current.confidence > 80 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {current.confidence}%
                </div>
                <div className="w-full h-1.5 bg-slate-800 rounded-full mt-1.5 overflow-hidden">
                  <div
                    style={{ width: `${current.confidence}%` }}
                    className={`h-full ${current.confidence > 80 ? 'bg-emerald-400' : 'bg-rose-400'}`}
                  />
                </div>
              </div>
              <div className="p-3 rounded-xl bg-[#090C14] border border-white/10">
                <div className="text-slate-400 text-[10px]">BLAST RADIUS</div>
                <div className="text-sm font-bold text-purple-300 mt-1.5">{current.blastRadius}</div>
              </div>
            </div>

            {/* Progressive Canary Rollout Slider */}
            <div className="p-3.5 rounded-xl bg-[#090C14] border border-white/10 space-y-2 font-mono text-xs">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-400 font-bold uppercase flex items-center space-x-1.5">
                  <Layers className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Canary Progressive Rollout</span>
                </span>
                <span className="text-cyan-300 font-bold">{current.canaryPercentage}% Weight</span>
              </div>
              <div className="flex items-center space-x-2 pt-1">
                {[10, 25, 50, 100].map((pct) => (
                  <button
                    key={pct}
                    onClick={() => setCanaryStage(current.taskId, pct)}
                    className={`flex-1 py-1 rounded text-[10px] font-bold transition ${
                      current.canaryPercentage === pct
                        ? 'bg-cyan-500 text-slate-950 shadow'
                        : 'bg-[#141A29] text-slate-400 hover:text-white'
                    }`}
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            </div>

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
                    <span>Confirm Production Rollout</span>
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
                    Confirm & Merge PR
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
                    <span>Authorize & Merge PR</span>
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

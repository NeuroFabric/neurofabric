import { useState } from 'react';
import { useTelemetry } from '../context/TelemetryContext';
import { ShieldCheck, ShieldAlert, GitPullRequest, Check, X, AlertTriangle, RotateCcw, FileCode } from 'lucide-react';
import { toast } from 'sonner';
import { InfoTooltip } from '../components/common/Tooltip';

export function EmbassyPage() {
  const { proposals, authorizePR, declinePR, resetProposals } = useTelemetry();
  const [selectedId, setSelectedId] = useState<string>(proposals[0]?.taskId || 'task-auth-gw-892');
  const [taskToken, setTaskToken] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [showDeclineReasons, setShowDeclineReasons] = useState(false);

  const current = proposals.find((p) => p.taskId === selectedId) || proposals[0];

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setShowConfirm(false);
    setShowDeclineReasons(false);
    setTaskToken('');
  };

  const handleApprove = async () => {
    if (current.astStatus === 'REJECT') {
      toast.error('AST Gate Policy Lock', {
        description: 'Cannot dispatch a proposal that failed AST syntax screening (HTTP 422).',
      });
      return;
    }
    if (!showConfirm) {
      setShowConfirm(true);
      setShowDeclineReasons(false);
      return;
    }
    if (taskToken.trim() !== current.taskId) {
      toast.error('Token Mismatch', {
        description: `Please enter or click to fill "${current.taskId}" to confirm production rollout.`,
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

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-2xl font-bold text-white tracking-tight">
              Autonomous Embassy — Patch Review (HITL)
            </h1>
            <InfoTooltip content="Three-pane Human-in-the-Loop GitOps console. Every approval or refusal mutates state and appends a SHA-256 leaf to the Merkle Ledger." />
          </div>
          <p className="text-xs text-slate-300 mt-1">
            Review agent-proposed GitOps diffs, verify AST security gates, and authorize or decline rollouts.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <span className="text-xs font-mono px-3 py-1.5 rounded-xl bg-amber-500/15 text-amber-300 border border-amber-500/30 font-bold">
            {proposals.filter((p) => p.status === 'PENDING').length} PENDING REVIEW
          </span>
          <button
            onClick={resetProposals}
            className="px-3 py-1.5 rounded-xl bg-[#141928] hover:bg-slate-800 border border-white/10 text-xs font-mono text-slate-300 flex items-center space-x-1.5 transition"
          >
            <RotateCcw className="w-3.5 h-3.5 text-cyan-400" />
            <span>Reset Demo Queue</span>
          </button>
        </div>
      </div>

      {/* 3-Pane Layout */}
      <div className="grid lg:grid-cols-12 gap-6">
        {/* Left Pane (3 Cols): Proposal Queue */}
        <div className="lg:col-span-3 space-y-3">
          <div className="text-[11px] font-mono font-bold uppercase tracking-wider text-slate-400 px-1">
            Proposal Queue ({proposals.length})
          </div>
          {proposals.map((prop) => {
            const isSelected = prop.taskId === current.taskId;
            return (
              <div
                key={prop.taskId}
                onClick={() => handleSelect(prop.taskId)}
                className={`p-4 rounded-2xl border cursor-pointer transition space-y-2 ${
                  isSelected
                    ? 'bg-gradient-to-br from-cyan-500/15 to-indigo-500/15 border-cyan-400 shadow-lg'
                    : 'bg-[#0D111C] border-white/10 hover:border-white/25'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono text-slate-400">{prop.taskId}</span>
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
                <div className="text-xs font-bold text-white">{prop.title}</div>
                <div className="text-[11px] font-mono text-cyan-400 truncate flex items-center space-x-1">
                  <FileCode className="w-3 h-3 shrink-0" />
                  <span className="truncate">{prop.target}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Center Pane (5 Cols): AST Banner + Unified Diff Viewer */}
        <div className="lg:col-span-5 space-y-4">
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

          <div className="rounded-2xl bg-[#0D111C] border border-white/10 overflow-hidden shadow-2xl">
            <div className="p-3.5 border-b border-white/10 flex items-center justify-between bg-[#131826] font-mono text-xs">
              <div className="flex items-center space-x-2">
                <GitPullRequest className="w-4 h-4 text-cyan-400" />
                <span className="text-white font-bold">{current.target}</span>
              </div>
              <span className="text-slate-400 text-[11px]">{current.taskId}</span>
            </div>

            <div className="p-4 bg-[#07090F] font-mono text-xs overflow-x-auto leading-relaxed space-y-0.5">
              {current.diff.map((line, idx) => {
                const isAdd = line.startsWith('+');
                const isDel = line.startsWith('-');
                const isFlagged = line.includes('curl');
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
          </div>
        </div>

        {/* Right Pane (4 Cols): Agent RCA & Stateful Action Controls */}
        <div className="lg:col-span-4 space-y-4">
          <div className="p-6 rounded-2xl bg-[#0D111C] border border-white/10 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono font-bold text-cyan-400 uppercase tracking-wider">
                Autonomous RCA Context
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

            {/* Confidence Bar & Blast Radius */}
            <div className="grid grid-cols-2 gap-3 font-mono text-xs">
              <div className="p-3 rounded-xl bg-[#131826] border border-white/10">
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
              <div className="p-3 rounded-xl bg-[#131826] border border-white/10">
                <div className="text-slate-400 text-[10px]">BLAST RADIUS</div>
                <div className="text-sm font-bold text-cyan-300 mt-1.5">{current.blastRadius}</div>
              </div>
            </div>

            {/* State Outcome Banner if Already Actioned */}
            {current.status === 'APPROVED' && (
              <div className="p-4 rounded-xl bg-emerald-950/60 border border-emerald-500/50 text-xs font-mono text-emerald-200 space-y-1">
                <div className="font-bold text-emerald-400 flex items-center space-x-1.5">
                  <Check className="w-4 h-4" />
                  <span>DISPATCHED TO GITOPS & MERKLE SEALED</span>
                </div>
                <div>This patch has been approved and committed to the cluster.</div>
              </div>
            )}

            {current.status === 'DECLINED' && (
              <div className="p-4 rounded-xl bg-rose-950/60 border border-rose-500/50 text-xs font-mono text-rose-200 space-y-1">
                <div className="font-bold text-rose-400 flex items-center space-x-1.5">
                  <X className="w-4 h-4" />
                  <span>PROPOSAL DECLINED BY OPERATOR</span>
                </div>
                <div>Reason: {current.declineReason || 'Operator Refused'}</div>
              </div>
            )}

            {/* Confirmation Step for Approval */}
            {current.status === 'PENDING' && showConfirm && (
              <div className="p-4 rounded-xl bg-[#141928] border border-amber-400/50 space-y-3">
                <div className="flex items-center justify-between text-amber-300 text-xs font-mono font-bold">
                  <span className="flex items-center space-x-1.5">
                    <AlertTriangle className="w-4 h-4" />
                    <span>Confirm Production Rollout</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setTaskToken(current.taskId)}
                    className="text-[10px] text-cyan-400 underline hover:text-cyan-300"
                  >
                    Auto-fill token
                  </button>
                </div>
                <p className="text-[11px] text-slate-300">
                  Type or click auto-fill for <span className="text-white font-mono font-bold">{current.taskId}</span>:
                </p>
                <input
                  type="text"
                  value={taskToken}
                  onChange={(e) => setTaskToken(e.target.value)}
                  placeholder={current.taskId}
                  className="w-full bg-[#080A10] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400"
                />
                <div className="flex items-center space-x-2 pt-1">
                  <button
                    onClick={handleApprove}
                    className="flex-1 py-2 bg-emerald-400 hover:bg-emerald-300 text-slate-950 font-bold rounded-lg text-xs font-mono transition"
                  >
                    Confirm & Dispatch PR
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

            {/* Decline Reason Chips */}
            {current.status === 'PENDING' && showDeclineReasons && (
              <div className="p-4 rounded-xl bg-[#141928] border border-rose-500/50 space-y-2.5">
                <div className="text-xs font-mono font-bold text-rose-300">
                  Select Refusal Reason (Sealed to Merkle Ledger):
                </div>
                <div className="grid grid-cols-1 gap-1.5">
                  {declineReasons.map((r) => (
                    <button
                      key={r}
                      onClick={() => handleDeclineWithReason(r)}
                      className="w-full text-left px-3 py-2 rounded-lg bg-[#090C14] hover:bg-rose-500/20 border border-white/10 hover:border-rose-500/40 text-xs font-mono text-slate-200 hover:text-rose-200 transition"
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

            {/* Primary Action Buttons */}
            {current.status === 'PENDING' && !showConfirm && !showDeclineReasons && (
              <div className="flex items-center space-x-3 pt-2">
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
                  <span>Authorize & Dispatch PR</span>
                </button>
                <button
                  onClick={() => setShowDeclineReasons(true)}
                  className="px-4 py-3 bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-300 rounded-xl text-xs font-mono font-bold transition flex items-center justify-center space-x-1.5"
                >
                  <X className="w-4 h-4" />
                  <span>Decline</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

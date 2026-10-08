import { useState } from 'react'
import { ShieldCheck, X } from 'lucide-react'
import { Card } from './card'
import { submitApproval } from '../lib/api'

export interface PatchProposal {
  patchId: string
  format: 'kubernetes' | 'terraform'
  document: string
  state: 'AWAITING_APPROVAL'
}

export interface PendingApprovalsProps {
  patches: PatchProposal[]
}

const GRID_COLS = 'grid-cols-[160px_104px_minmax(0,1fr)]'

export function PendingApprovals({ patches }: PendingApprovalsProps) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [verdict, setVerdict] = useState<{ patchId: string; status: 'approved' | 'rejected' } | null>(null)

  const handleApprove = async (patchId: string) => {
    setPending((prev) => new Set(prev).add(patchId))
    try {
      await submitApproval(patchId, 'approved')
      setVerdict({ patchId, status: 'approved' })
      setTimeout(() => setVerdict(null), 2500)
    } catch (e) {
      setVerdict({ patchId, status: 'rejected' })
      setTimeout(() => setVerdict(null), 2500)
      console.error('Failed to approve', e)
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(patchId)
        return next
      })
    }
  }

  const handleReject = async (patchId: string) => {
    setPending((prev) => new Set(prev).add(patchId))
    try {
      await submitApproval(patchId, 'rejected')
      setVerdict({ patchId, status: 'rejected' })
      setTimeout(() => setVerdict(null), 2500)
    } catch (e) {
      console.error('Failed to reject', e)
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(patchId)
        return next
      })
    }
  }

  return (
    <Card className="p-0 overflow-hidden">
      {/* Header row — identical grid template as data rows for perfect column alignment */}
      <div
        className={`grid ${GRID_COLS} items-center border-b border-white/[0.08] px-4 py-3 bg-white/[0.02] text-[10px] font-semibold uppercase tracking-wider text-slate-500`}
      >
        <div>Patch ID</div>
        <div>Format</div>
        <div>Actions</div>
      </div>

      <div className="grid gap-px bg-white/[0.08]">
        {patches.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 bg-[#0e1522] text-slate-500">
            <ShieldCheck size={22} strokeWidth={1.5} className="text-slate-600" />
            <p className="text-xs">Zero pending approvals</p>
            <p className="text-[10px] text-slate-600">The remediation queue is clear.</p>
          </div>
        ) : (
          patches.map((patch) => (
            <div
              key={patch.patchId}
              className={`grid ${GRID_COLS} items-center px-4 py-3 bg-[#0e1522] text-[11px] text-slate-300`}
            >
              <span className="font-mono tabular-nums truncate text-slate-400">{patch.patchId}</span>
              <span className="font-mono tabular-nums capitalize text-slate-400">{patch.format}</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setExpanded(expanded === patch.patchId ? null : patch.patchId)}
                  className="rounded border border-white/[0.08] bg-white/[0.05] px-2 py-1 font-mono text-[10px] text-slate-400 transition-all duration-150 ease-out hover:-translate-y-px hover:bg-white/[0.1] hover:text-slate-200 active:translate-y-0"
                >
                  {expanded === patch.patchId ? 'Hide' : 'View'}
                </button>
                <button
                  onClick={() => handleApprove(patch.patchId)}
                  disabled={pending.has(patch.patchId)}
                  className="rounded border border-emerald-500/30 bg-emerald-500/20 px-2 py-1 text-[10px] font-bold text-emerald-400 transition-all duration-150 ease-out hover:-translate-y-px hover:bg-emerald-500/30 hover:shadow-[0_0_12px_rgba(16,185,129,0.15)] active:translate-y-0 disabled:pointer-events-none disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  onClick={() => handleReject(patch.patchId)}
                  disabled={pending.has(patch.patchId)}
                  className="rounded border border-rose-500/30 bg-rose-500/20 px-2 py-1 text-[10px] font-bold text-rose-400 transition-all duration-150 ease-out hover:-translate-y-px hover:bg-rose-500/30 hover:shadow-[0_0_12px_rgba(244,63,94,0.15)] active:translate-y-0 disabled:pointer-events-none disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {verdict && (
        <div className="border-t border-white/[0.08] bg-[#070c16] px-4 py-2 font-mono text-[10px] tabular-nums text-slate-500">
          {verdict.patchId} → {verdict.status}
        </div>
      )}

      {expanded && (
        <div className="border-t border-white/[0.08] bg-[#070c16] p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-[10px] font-semibold uppercase tabular-nums tracking-wider text-amber-400">
              {expanded}
            </span>
            <button onClick={() => setExpanded(null)} className="text-slate-500 transition-opacity duration-150 hover:opacity-100 hover:text-white">
              <X size={16} />
            </button>
          </div>
          <pre className="code-block max-h-[400px] overflow-auto rounded-lg border border-white/[0.06] bg-[#0a101c] p-4 font-mono text-[11px] tabular-nums leading-relaxed text-emerald-100/90">
            {patches.find((p) => p.patchId === expanded)?.document}
          </pre>
        </div>
      )}
    </Card>
  )
}

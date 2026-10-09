import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'

export interface HitlProposal {
  taskId: string
  incidentId: string
  source: string
  severity: string
  message: string
  confidence: number
  blastRadius: 'low' | 'medium' | 'high'
  patch: unknown
  format: string
  status: string
  createdAt: string
}

function severityBadge(severity: string) {
  const s = severity?.toLowerCase()
  const color = s === 'critical' ? '#f43f5e' : s === 'warning' ? '#f59e0b' : '#06b6d4'
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
      style={{ backgroundColor: `${color}1a`, color, border: `1px solid ${color}33` }}>
      {severity}
    </span>
  )
}

function DiffViewer({ patch }: { patch: unknown }) {
  const text =
    typeof patch === 'object' && patch !== null && 'diff' in patch
      ? String((patch as { diff?: unknown }).diff ?? JSON.stringify(patch, null, 2))
      : typeof patch === 'string'
        ? patch
        : JSON.stringify(patch, null, 2)
  return (
    <pre className="max-h-56 overflow-auto rounded-md border border-white/[0.06] bg-[#070c16] p-3 font-mono text-[11px] leading-relaxed">
      {text.split('\n').map((line, i) => {
        let cls = 'text-zinc-500'
        if (line.startsWith('@@')) cls = 'text-cyan-400 tabular-nums'
        else if (line.startsWith('+')) cls = 'text-emerald-400 bg-emerald-500/[0.06]'
        else if (line.startsWith('-')) cls = 'text-rose-400 bg-rose-500/[0.06]'
        return <div key={i} className={cls}>{line}</div>
      })}
    </pre>
  )
}

export function HitlDeck({ proposals, onDecide }: {
  proposals: HitlProposal[]
  onDecide: (taskId: string, decision: 'APPROVED' | 'REJECTED') => void
}) {
  const [busy, setBusy] = useState<Set<string>>(new Set())

  const act = (taskId: string, decision: 'APPROVED' | 'REJECTED') => {
    setBusy((prev) => new Set(prev).add(taskId))
    onDecide(taskId, decision)
  }

  return (
    <div className="flex flex-col gap-3 max-h-96 overflow-auto pr-1">
      {proposals.length === 0 ? (
        <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-lg border border-white/[0.08] bg-[#111827] text-zinc-600">
          <ShieldCheck className="w-5 h-5 text-zinc-700" />
          <p className="text-xs">Zero pending approvals — the remediation queue is clear.</p>
        </div>
      ) : proposals.map((p) => (
        <div key={p.taskId} className="rounded-lg border border-white/[0.08] bg-[#111827] p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-[11px] tabular-nums text-zinc-300 truncate">{p.taskId}</span>
              {severityBadge(p.severity)}
              {p.blastRadius === 'high'
                ? <span className="rounded-full bg-rose-500/10 border border-rose-500/30 px-2 py-0.5 text-[10px] font-bold uppercase text-rose-400">Blast: High</span>
                : <span className="rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-400">Blast: {p.blastRadius}</span>}
            </div>
            <span className="text-[10px] tabular-nums text-zinc-500 shrink-0">{new Date(p.createdAt).toLocaleTimeString()}</span>
          </div>
          {p.message && <p className="text-xs text-zinc-400">{p.message}</p>}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <div className={`h-full ${p.confidence >= 90 ? 'bg-emerald-500' : 'bg-amber-500'}`}
                style={{ width: `${Math.min(100, p.confidence)}%` }} />
            </div>
            <span className="text-[10px] tabular-nums text-zinc-400 shrink-0">
              {p.confidence}%{p.confidence < 90 ? ' — Requires Human Gate' : ' — Auto-Eligible'}
            </span>
          </div>
          <DiffViewer patch={p.patch} />
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => act(p.taskId, 'APPROVED')}
              disabled={busy.has(p.taskId)}
              className="rounded border border-emerald-500/30 bg-emerald-500/20 px-3 py-1.5 text-[11px] font-bold text-emerald-400 transition-all hover:bg-emerald-500/30 hover:shadow-[0_0_12px_rgba(16,185,129,0.15)] disabled:opacity-50">
              Approve Patch
            </button>
            <button
              onClick={() => act(p.taskId, 'REJECTED')}
              disabled={busy.has(p.taskId)}
              className="rounded border border-rose-500/30 bg-transparent px-3 py-1.5 text-[11px] font-bold text-rose-400 transition-all hover:bg-rose-500/10 disabled:opacity-50">
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

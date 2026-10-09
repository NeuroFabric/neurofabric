import { Card } from './card'
import { type ApprovalLedgerRecord } from '../lib/api'

export function LedgerGrid({ records }: { records: ApprovalLedgerRecord[] | undefined }) {
  const items = Array.isArray(records) ? records : (records?.tasks || records?.records || []);
  if (!Array.isArray(items) || items.length === 0) {
    return (
      <Card className="flex h-32 flex-col items-center justify-center gap-2 text-slate-500">
        <p className="text-xs">No audit logs available.</p>
      </Card>
    )
  }

  return (
    <Card className="p-0 overflow-hidden">
      <div className="grid grid-cols-[160px_100px_160px_160px_160px] border-b border-white/[0.08] bg-white/[0.02] px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        <div>Token</div>
        <div>Status</div>
        <div>Decided At</div>
        <div>OWASP Ref</div>
        <div>NIST Ref</div>
      </div>
      <div className="grid gap-px bg-white/[0.08]">
        {items.map((record) => (
          <div
            key={record.token}
            className="grid grid-cols-[160px_100px_160px_160px_160px] items-center px-4 py-3 bg-[#0e1522] text-[11px] font-mono tabular-nums text-slate-300 transition-colors hover:bg-white/[0.02]"
          >
            <span className="truncate text-slate-400">{record.token}</span>
            <span
              className={`w-fit rounded-full px-2 py-0.5 text-[9px] font-bold uppercase ${
                record.status === 'approved' ? 'bg-emerald-500/10 text-emerald-400' :
                record.status === 'rejected' ? 'bg-rose-500/10 text-rose-400' : 'bg-slate-500/10 text-slate-400'
              }`}
            >
              {record.status}
            </span>
            <span className="text-slate-500">
              {record.decidedAt ? new Date(record.decidedAt).toLocaleString() : '—'}
            </span>
            <span className="truncate text-slate-500">{(record as any).owaspRef ?? '—'}</span>
            <span className="truncate text-slate-500">{(record as any).nistRef ?? '—'}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

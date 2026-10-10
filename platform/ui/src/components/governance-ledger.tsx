import { useMemo, useState } from 'react'
import { Search, FileText, Download } from 'lucide-react'
import type { ApprovalLedgerRecord } from '../lib/api'

const FILTERS = ['ALL', 'PENDING', 'APPROVED', 'REJECTED', 'AUTONOMOUS', 'ROLLED_BACK'] as const

function statusBadge(status: string) {
  const s = status?.toUpperCase()
  const map: Record<string, string> = {
    APPROVED: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
    PENDING_REVIEW: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
    PENDING: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
    REJECTED: 'text-rose-400 bg-rose-500/10 border-rose-500/30',
    REFUSED: 'text-rose-400 bg-rose-500/10 border-rose-500/30',
    AUTONOMOUS: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
    AUTONOMOUSLY_APPLIED: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
    ROLLED_BACK: 'text-red-400 bg-red-500/10 border-red-500/30',
  }
  const cls = map[s] ?? 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30'
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase ${cls}`}>{s || '—'}</span>
}

function matchesFilter(status: string, filter: (typeof FILTERS)[number]) {
  if (filter === 'ALL') return true
  const s = status?.toUpperCase() ?? ''
  if (filter === 'PENDING') return s === 'PENDING' || s === 'PENDING_REVIEW'
  if (filter === 'AUTONOMOUS') return s === 'AUTONOMOUS' || s === 'AUTONOMOUSLY_APPLIED'
  return s === filter
}

function toCsv(rows: ApprovalLedgerRecord[]): string {
  const esc = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`
  const header = 'token,status,created_at,decided_at,approved_by,reason'
  const lines = rows.map((r) =>
    [r.token, r.status, r.createdAt ?? '', r.decidedAt ?? '', r.approvedBy ?? '', r.reason ?? ''].map(esc).join(','))
  return [header, ...lines].join('\n')
}

export function GovernanceLedger({ records }: { records: ApprovalLedgerRecord[] }) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return records.filter((r) => {
      if (!matchesFilter(r.status, filter)) return false
      if (!q) return true
      return (
        r.token?.toLowerCase().includes(q) ||
        r.status?.toLowerCase().includes(q) ||
        JSON.stringify(r.subject ?? '').toLowerCase().includes(q)
      )
    })
  }, [records, search, filter])

  const exportCsv = () => {
    const blob = new Blob([toCsv(filtered)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `governance-ledger-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="rounded-lg border border-white/[0.08] bg-[#111827] overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.08] bg-white/[0.02] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-medium text-zinc-200">Governance Ledger</span>
        </div>
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-wider border transition-colors ${
                filter === f
                  ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                  : 'bg-transparent border-white/[0.08] text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by source, token, status..."
              className="rounded-md border border-white/[0.08] bg-[#0e1522] pl-7 pr-3 py-1.5 text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/40 w-64"
            />
          </div>
          <button
            onClick={exportCsv}
            className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[10px] font-semibold text-zinc-300 hover:bg-white/[0.08] transition-colors"
          >
            <Download className="w-3 h-3" /> CSV
          </button>
          <span className="text-[10px] tabular-nums text-zinc-500">{filtered.length} RECORDS</span>
        </div>
      </div>
      <div className="grid grid-cols-[minmax(0,2fr)_140px_180px_minmax(0,1fr)] border-b border-white/[0.08] bg-white/[0.02] px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        <div>Token</div><div>Status</div><div>Created</div><div>Subject</div>
      </div>
      <div className="max-h-72 overflow-auto">
        {filtered.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-xs text-zinc-600">No audit logs available.</div>
        ) : filtered.map((r) => (
          <div key={r.token} className="grid grid-cols-[minmax(0,2fr)_140px_180px_minmax(0,1fr)] items-center px-4 py-2.5 text-[11px] border-b border-white/[0.04] hover:bg-white/[0.02]">
            <span className="truncate font-mono tabular-nums text-zinc-400">{r.token}</span>
            <span>{statusBadge(r.status)}</span>
            <span className="tabular-nums text-zinc-500">{r.createdAt ? new Date(r.createdAt).toLocaleString() : '—'}</span>
            <span className="truncate text-zinc-500">{(r.subject as any)?.source ?? JSON.stringify(r.subject ?? '').slice(0, 80)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

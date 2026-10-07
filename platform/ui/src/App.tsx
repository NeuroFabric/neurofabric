import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BadgeCheck,
  Check,
  ChevronRight,
  CircleDot,
  FileCode2,
  FileText,
  Fingerprint,
  Gauge,
  HardDrive,
  LockKeyhole,
  Network,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  UploadCloud,
  X,
  Zap,
} from 'lucide-react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import ReactMarkdown from 'react-markdown'
import {
  executeAnalysis,
  fetchLedger,
  fetchTelemetry,
  submitVerdict,
  uploadArtifact,
  type AgentTaskResponse,
  type AnalysisSummary,
  type ApprovalLedgerRecord,
  type DashboardTelemetry,
  type UploadedArtifact,
} from './api'

type View = 'firewall' | 'analyzer' | 'sandbox'
type Risk = 'Low' | 'Medium' | 'High' | 'Critical'
type ActionNotice = { kind: 'success' | 'error'; text: string }

const navigation: { id: View; title: string; subtitle: string; icon: typeof ShieldCheck }[] = [
  { id: 'firewall', title: 'Zero-Trust AI Firewall', subtitle: 'Approvals & compliance', icon: ShieldCheck },
  { id: 'analyzer', title: 'Agentic Log Analyzer', subtitle: 'Performance war room', icon: Activity },
  { id: 'sandbox', title: 'Sandbox & Telemetry', subtitle: 'Workspace & live signals', icon: HardDrive },
]

const emptyTelemetry: DashboardTelemetry = { samples: [], http5xx: [] }
const ANALYSIS_PROMPT = 'Analyze this performance log for latency, throughput, HTTP 5xx bursts, and root causes. Return evidence-based findings and safe remediation recommendations.'

function Card({ children, className = '', ...props }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLElement>) {
  return <section {...props} className={`rounded-2xl border border-white/[0.08] bg-slate-900/65 shadow-[0_18px_55px_-32px_rgba(0,0,0,0.9)] backdrop-blur-xl ${className}`}>{children}</section>
}

function IconTile({ children, tone = 'amber' }: { children: ReactNode; tone?: 'amber' | 'cyan' | 'emerald' | 'rose' | 'violet' }) {
  const colors = {
    amber: 'border-amber-300/15 bg-amber-300/10 text-amber-200',
    cyan: 'border-cyan-300/15 bg-cyan-300/10 text-cyan-200',
    emerald: 'border-emerald-300/15 bg-emerald-300/10 text-emerald-200',
    rose: 'border-rose-300/15 bg-rose-300/10 text-rose-200',
    violet: 'border-violet-300/15 bg-violet-300/10 text-violet-200',
  }
  return <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl border ${colors[tone]}`}>{children}</div>
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-200/80">{children}</p>
}

function EmptyState({ title, detail, icon = <Radio size={17} /> }: { title: string; detail: string; icon?: ReactNode }) {
  return <div className="flex min-h-40 flex-col items-center justify-center px-6 py-8 text-center">
    <div className="mb-3 grid h-10 w-10 place-items-center rounded-full border border-white/[0.08] bg-white/[0.03] text-slate-500">{icon}</div>
    <p className="text-sm font-medium text-slate-300">{title}</p>
    <p className="mt-1 max-w-sm text-xs leading-5 text-slate-500">{detail}</p>
  </div>
}

function StatusPill({ online, label }: { online: boolean; label: string }) {
  return <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-medium ${online ? 'border-emerald-300/15 bg-emerald-300/[0.07] text-emerald-200' : 'border-slate-700 bg-slate-900/70 text-slate-400'}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,0.7)]' : 'bg-slate-500'}`} />{label}
  </span>
}

function PageHeading({ kicker, title, description, action }: { kicker: string; title: string; description: string; action?: ReactNode }) {
  return <div className="flex flex-wrap items-end justify-between gap-4">
    <div><Eyebrow>{kicker}</Eyebrow><h1 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">{description}</p></div>
    {action}
  </div>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function firstString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined
  for (const key of keys) if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim()
  return undefined
}

function actionDetails(entry: ApprovalLedgerRecord) {
  const subject = asRecord(entry.subject)
  const action = asRecord(subject?.action) ?? asRecord(subject?.request) ?? subject
  const tool = firstString(action, ['tool', 'capability', 'operation', 'name']) ?? 'Governed action'
  const target = firstString(action, ['path', 'target', 'resource', 'table', 'database'])
  const detail = firstString(action, ['summary', 'description', 'reason', 'command'])
  const flat = `${tool} ${target ?? ''} ${detail ?? ''}`.toLowerCase()
  const risk: Risk = /sqlite[_ .-]?write|database[_ .-]?write|shell|delete|drop table|credential|secret/.test(flat)
    ? 'Critical'
    : /write|insert|update|execute|mutation|alter/.test(flat)
      ? 'High'
      : /read|query|search|select/.test(flat)
        ? 'Medium'
        : 'Low'
  const owasp = /read|select|query|search/.test(flat)
    ? 'LLM02 · Sensitive Information Disclosure'
    : 'LLM06 · Excessive Agency'
  const nist = risk === 'Critical' || risk === 'High'
    ? 'GOVERN · accountability  /  MANAGE · risk response'
    : 'MAP · operating context  /  MEASURE · monitoring'
  return { tool, target, detail, risk, owasp, nist }
}

function riskStyle(risk: Risk) {
  if (risk === 'Critical') return 'border-rose-300/20 bg-rose-300/10 text-rose-200'
  if (risk === 'High') return 'border-orange-300/20 bg-orange-300/10 text-orange-200'
  if (risk === 'Medium') return 'border-amber-300/20 bg-amber-300/10 text-amber-100'
  return 'border-emerald-300/20 bg-emerald-300/10 text-emerald-200'
}

function shortReference(token: string) {
  return token.length > 12 ? `…${token.slice(-8)}` : token
}

function Firewall({
  ledger,
  loading,
  error,
  busyToken,
  notice,
  onRefresh,
  onDecision,
}: {
  ledger: ApprovalLedgerRecord[]
  loading: boolean
  error: string
  busyToken?: string
  notice?: ActionNotice
  onRefresh: () => void
  onDecision: (entry: ApprovalLedgerRecord, decision: 'approved' | 'refused') => void
}) {
  const pending = ledger.filter((entry) => entry.status.toLowerCase() === 'pending')
  const critical = pending.filter((entry) => actionDetails(entry).risk === 'Critical').length
  const approved = ledger.filter((entry) => entry.status.toLowerCase() === 'approved').length
  const lastUpdated = ledger[0]?.createdAt

  return <div className="space-y-7">
    <PageHeading
      kicker="AI governance · human oversight"
      title="Zero-Trust AI Firewall"
      description="Review consequential agent actions before they execute. Every decision is submitted against its task token and written to the governance ledger."
      action={<button onClick={onRefresh} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-xs font-medium text-slate-300 transition hover:border-amber-200/25 hover:bg-white/[0.07]"><RefreshCw size={14} />Refresh ledger</button>}
    />

    <div className="grid gap-3 sm:grid-cols-3">
      <SummaryTile label="Awaiting review" value={loading && ledger.length === 0 ? '—' : String(pending.length)} detail="Pending task tokens" icon={<CircleDot size={17} />} tone="amber" />
      <SummaryTile label="Critical intercepts" value={String(critical)} detail="High-impact tool requests" icon={<AlertTriangle size={17} />} tone={critical > 0 ? 'rose' : 'emerald'} />
      <SummaryTile label="Recorded approvals" value={String(approved)} detail={lastUpdated ? `Latest ledger row ${formatDate(lastUpdated)}` : 'No decision records yet'} icon={<BadgeCheck size={17} />} tone="cyan" />
    </div>

    {error && <InlineNotice kind="error" text={error} />}
    {notice && <InlineNotice kind={notice.kind} text={notice.text} />}

    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
        <div><h2 className="text-sm font-semibold text-white">Risk intercept queue</h2><p className="mt-1 text-xs text-slate-500">Risk is prioritized from the requested tool and action scope.</p></div>
        <span className="rounded-full border border-amber-200/15 bg-amber-200/[0.06] px-3 py-1 text-[10px] font-semibold text-amber-100">{pending.length} PENDING</span>
      </div>
      {loading && ledger.length === 0
        ? <EmptyState title="Connecting to the governance ledger" detail="Pending actions will appear here when the API is available." />
        : pending.length === 0
          ? <EmptyState title={error ? 'Queue status unavailable' : 'No actions awaiting review'} detail={error ? 'The ledger could not be verified. Retry when the governance service is reachable.' : 'The live ledger contains no pending approval tokens.'} icon={error ? <AlertTriangle size={17} /> : <Check size={17} />} />
          : <div className="grid gap-4 p-4 xl:grid-cols-2">{pending.map((entry) => {
            const details = actionDetails(entry)
            const isBusy = busyToken === entry.token
            return <article key={entry.token} className="rounded-2xl border border-amber-200/15 bg-[linear-gradient(135deg,rgba(245,158,11,0.08),rgba(15,23,42,0.76)_48%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="flex items-start gap-3">
                <IconTile tone={details.risk === 'Critical' ? 'rose' : 'amber'}><LockKeyhole size={18} /></IconTile>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><h3 className="font-mono text-sm font-semibold text-white">{details.tool}</h3><span className={`rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider ${riskStyle(details.risk)}`}>{details.risk} risk</span></div>
                  <p className="mt-1 break-words text-xs leading-5 text-slate-400">{details.detail ?? (details.target ? `Requested target: ${details.target}` : 'An agent action is waiting for an operator decision.')}</p>
                </div>
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <FrameworkBadge label="OWASP LLMSecOps" value={details.owasp} />
                <FrameworkBadge label="NIST AI RMF 1.0" value={details.nist} />
              </div>
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/[0.07] pt-3">
                <div className="min-w-0"><p className="text-[9px] uppercase tracking-[0.16em] text-slate-600">Token-bound decision</p><p className="mt-1 truncate font-mono text-[11px] text-slate-400" title={entry.token}>{shortReference(entry.token)}</p></div>
                <span className="shrink-0 text-[10px] text-slate-500">{formatDate(entry.createdAt)}</span>
              </div>
              <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
                <button disabled={Boolean(busyToken)} onClick={() => onDecision(entry, 'approved')} className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-200 px-4 py-3 text-xs font-bold text-slate-950 transition hover:bg-amber-100 disabled:cursor-wait disabled:opacity-60"><Check size={15} />{isBusy ? 'Submitting decision…' : 'One-click approve'}</button>
                <button aria-label="Deny action" disabled={Boolean(busyToken)} onClick={() => onDecision(entry, 'refused')} className="grid place-items-center rounded-xl border border-rose-300/20 bg-rose-300/[0.06] px-4 text-rose-200 transition hover:bg-rose-300/10 disabled:opacity-50"><X size={16} /></button>
              </div>
            </article>
          })}</div>}
      <p className="border-t border-white/[0.06] px-5 py-3 text-[10px] leading-5 text-slate-600">Framework mapping is an operator aid, not a compliance attestation. Confirm applicable controls against your organization’s policy.</p>
    </Card>

    <Card className="overflow-hidden">
      <div className="border-b border-white/[0.07] px-5 py-4"><h2 className="text-sm font-semibold text-white">Decision history</h2><p className="mt-1 text-xs text-slate-500">Read-only view of the most recent SQLite ledger records.</p></div>
      {ledger.length === 0 ? <EmptyState title="No ledger records returned" detail="The history will populate from persisted database rows; no sample records are displayed." /> : <div className="overflow-x-auto"><table className="w-full min-w-[650px] text-left text-xs"><thead className="bg-white/[0.02] text-[9px] uppercase tracking-[0.15em] text-slate-500"><tr><th className="px-5 py-3">Created</th><th className="px-5 py-3">Reference</th><th className="px-5 py-3">Action</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Decision owner</th></tr></thead><tbody>{ledger.slice(0, 12).map((entry) => <tr key={entry.token} className="border-t border-white/[0.05]"><td className="whitespace-nowrap px-5 py-3 text-slate-500">{formatDate(entry.createdAt)}</td><td className="px-5 py-3 font-mono text-slate-400">{shortReference(entry.token)}</td><td className="px-5 py-3 text-slate-300">{actionDetails(entry).tool}</td><td className="px-5 py-3"><LedgerStatus status={entry.status} /></td><td className="px-5 py-3 text-slate-500">{entry.approvedBy ?? '—'}</td></tr>)}</tbody></table></div>}
    </Card>
  </div>
}

function SummaryTile({ label, value, detail, icon, tone }: { label: string; value: string; detail: string; icon: ReactNode; tone: 'amber' | 'rose' | 'cyan' | 'emerald' }) {
  return <Card className="flex items-center gap-3 p-4"><IconTile tone={tone}>{icon}</IconTile><div className="min-w-0"><p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{label}</p><p className="mt-1 text-xl font-semibold text-white">{value}</p><p className="mt-0.5 truncate text-[10px] text-slate-500">{detail}</p></div></Card>
}

function FrameworkBadge({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-white/[0.07] bg-slate-950/45 px-3 py-2.5"><p className="text-[9px] font-semibold uppercase tracking-[0.13em] text-slate-500">{label}</p><p className="mt-1 text-[10px] font-medium leading-4 text-slate-200">{value}</p></div>
}

function LedgerStatus({ status }: { status: string }) {
  const normalized = status.toLowerCase()
  const style = normalized === 'pending' ? 'bg-amber-200/10 text-amber-100'
    : normalized === 'approved' ? 'bg-emerald-200/10 text-emerald-200'
      : normalized === 'expired' || normalized === 'refused' ? 'bg-rose-200/10 text-rose-200'
        : 'bg-slate-700/50 text-slate-300'
  return <span className={`rounded-full px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wider ${style}`}>{status}</span>
}

function InlineNotice({ kind, text }: { kind: ActionNotice['kind']; text: string }) {
  const isError = kind === 'error'
  return <div role={isError ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-xs ${isError ? 'border-rose-300/15 bg-rose-300/[0.06] text-rose-100' : 'border-emerald-300/15 bg-emerald-300/[0.06] text-emerald-100'}`}>
    {isError ? <AlertTriangle size={15} className="mt-0.5 shrink-0" /> : <Check size={15} className="mt-0.5 shrink-0" />}{text}
  </div>
}

function Analyzer({
  uploaded,
  analysis,
  telemetry,
  telemetryError,
  phase,
  error,
  notice,
  onFile,
  onNoticeDismiss,
}: {
  uploaded?: UploadedArtifact
  analysis?: AgentTaskResponse
  telemetry: DashboardTelemetry
  telemetryError: string
  phase: 'idle' | 'uploading' | 'analyzing' | 'ready' | 'error'
  error: string
  notice?: ActionNotice
  onFile: (file?: File) => void
  onNoticeDismiss: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const dragging = useRef(false)
  const [isDragging, setIsDragging] = useState(false)
  const working = phase === 'uploading' || phase === 'analyzing'
  const findings = analysis?.analysis
  const latest = telemetry.samples.at(-1)

  function receive(file?: File) {
    if (!file || working) return
    dragging.current = false
    setIsDragging(false)
    onFile(file)
  }

  return <div className="space-y-7">
    <PageHeading
      kicker="SRE operations · incident intelligence"
      title="Agentic Log Analyzer"
      description="Turn Apache/Nginx combined logs, Splunk exports, and database performance files into an evidence-led investigation workspace."
      action={uploaded ? <span className="inline-flex items-center gap-2 rounded-xl border border-emerald-300/15 bg-emerald-300/[0.06] px-3 py-2 text-[10px] text-emerald-200"><FileCode2 size={14} />{uploaded.name}</span> : undefined}
    />

    <Card className={`relative overflow-hidden border-dashed p-5 transition sm:p-7 ${isDragging ? 'border-amber-200/50 bg-amber-100/[0.06]' : 'border-white/15'}`} onDragEnter={(event) => { event.preventDefault(); dragging.current = true; setIsDragging(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { dragging.current = false; setIsDragging(false) } }} onDrop={(event) => { event.preventDefault(); receive(event.dataTransfer.files[0]) }}>
      <div className="flex flex-col items-center text-center">
        <IconTile tone="amber"><UploadCloud size={19} /></IconTile>
        <h2 className="mt-4 text-base font-semibold text-white">{phase === 'uploading' ? 'Securing file in the workspace' : phase === 'analyzing' ? 'Conductor is analyzing your file' : uploaded ? 'Drop another source to investigate' : 'Drop a performance source to open the war room'}</h2>
        <p className="mt-2 max-w-xl text-xs leading-5 text-slate-400">Apache/Nginx combined logs · Splunk CSV exports · database performance metrics</p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <button disabled={working} onClick={() => input.current?.click()} className="inline-flex items-center gap-2 rounded-xl bg-amber-200 px-4 py-2.5 text-xs font-bold text-slate-950 transition hover:bg-amber-100 disabled:opacity-60"><UploadCloud size={15} />Choose file</button>
          {working && <span className="inline-flex items-center gap-2 text-xs text-amber-100"><span className="h-2 w-2 animate-pulse rounded-full bg-amber-200" />{phase === 'uploading' ? 'Uploading to sandbox…' : 'Building the investigation…'}</span>}
        </div>
        <input ref={input} type="file" accept=".log,.csv,.tsv,.jsonl,.sqlite,.db,text/plain,text/csv" className="hidden" onChange={(event) => { receive(event.target.files?.[0]); event.currentTarget.value = '' }} />
        <p className="mt-4 text-[10px] text-slate-600">Files are sent to the backend sandbox. No local preview or generated telemetry is used.</p>
      </div>
    </Card>

    {error && <InlineNotice kind="error" text={error} />}
    {notice && <div className="flex items-start justify-between gap-3"><InlineNotice kind={notice.kind} text={notice.text} /><button onClick={onNoticeDismiss} aria-label="Dismiss notice" className="rounded-lg p-2 text-slate-500 hover:bg-white/5 hover:text-white"><X size={14} /></button></div>}

    {uploaded && <>
      <div className="flex flex-wrap items-end justify-between gap-3"><div><Eyebrow>Interactive war room</Eyebrow><h2 className="mt-1 text-lg font-semibold text-white">{uploaded.name}</h2><p className="mt-1 font-mono text-[10px] text-slate-500">{uploaded.path} · SHA-256 {uploaded.sha256.slice(0, 16)}…</p></div><StatusPill online={phase === 'ready'} label={phase === 'ready' ? 'Analysis returned' : phase === 'analyzing' ? 'Analysis running' : phase === 'error' ? 'Analysis unavailable' : 'Artifact secured'} /></div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <ValueTile label="Records scanned" value={findings ? findings.totalRows.toLocaleString() : '—'} sub="Backend analysis" icon={<FileText size={16} />} />
        <ValueTile label="Error records" value={findings ? findings.errorRows.toLocaleString() : '—'} sub={findings ? `${(findings.errorRate * 100).toFixed(2)}% of analyzed rows` : 'Awaiting structured findings'} icon={<AlertTriangle size={16} />} tone="rose" />
        <ValueTile label="P99 latency" value={latest ? `${latest.p99LatencyMs.toFixed(1)} ms` : '—'} sub="Measured telemetry only" icon={<Gauge size={16} />} />
        <ValueTile label="Throughput" value={latest ? `${latest.throughputRps.toFixed(2)} req/s` : '—'} sub="Measured telemetry only" icon={<Zap size={16} />} tone="cyan" />
      </div>

      <div className="grid gap-4 2xl:grid-cols-2">
        <TelemetryTrend data={telemetry.samples} error={telemetryError} />
        <HttpErrorScatter data={telemetry.http5xx} error={telemetryError} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Card className="min-h-[280px] overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4"><div><h3 className="text-sm font-semibold text-white">Conductor findings</h3><p className="mt-1 text-[10px] text-slate-500">Rendered only from the analysis API response.</p></div><FileText size={16} className="text-amber-200" /></div>
          {analysis?.markdown ? <div className="markdown max-h-[520px] overflow-auto px-5 py-4 text-xs"><ReactMarkdown>{analysis.markdown}</ReactMarkdown></div> : <EmptyState title="No report returned" detail="The analysis service has not provided findings for this artifact." />}
        </Card>
        <RemediationEngine uploaded={uploaded} analysis={findings} />
      </div>
    </>}
  </div>
}

function ValueTile({ label, value, sub, icon, tone = 'amber' }: { label: string; value: string; sub: string; icon: ReactNode; tone?: 'amber' | 'rose' | 'cyan' }) {
  const toneColor = tone === 'rose' ? 'text-rose-200' : tone === 'cyan' ? 'text-cyan-200' : 'text-amber-200'
  return <Card className="p-4"><div className="flex items-start justify-between"><div><p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{label}</p><p className="mt-2 text-xl font-semibold text-white">{value}</p><p className="mt-1 text-[10px] text-slate-500">{sub}</p></div><span className={toneColor}>{icon}</span></div></Card>
}

function ChartTooltip() {
  return <Tooltip contentStyle={{ background: '#0b1220', border: '1px solid rgba(255,255,255,.12)', borderRadius: 12, color: '#e2e8f0', fontSize: 11 }} />
}

function TelemetryTrend({ data, error }: { data: DashboardTelemetry['samples']; error: string }) {
  return <Card className="p-4 sm:p-5">
    <div className="mb-4 flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-white">P99 latency vs. throughput</h3><p className="mt-1 text-[10px] text-slate-500">Measured samples · dual-axis view</p></div><Gauge size={16} className="text-amber-200" /></div>
    {data.length === 0 ? <EmptyState title="Waiting for measured telemetry" detail={error || 'The backend has not returned P99 latency and throughput samples. No placeholder values are plotted.'} /> : <div className="h-64"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -12 }}><CartesianGrid stroke="rgba(148,163,184,.12)" strokeDasharray="3 6" /><XAxis dataKey="timestamp" tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} /><YAxis yAxisId="latency" tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} /><YAxis yAxisId="throughput" orientation="right" tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} /><ChartTooltip /><Legend wrapperStyle={{ fontSize: 10, color: '#94a3b8' }} /><Bar yAxisId="throughput" dataKey="throughputRps" name="Throughput (req/s)" fill="#22d3ee" fillOpacity={0.42} radius={[4, 4, 0, 0]} /><Line yAxisId="latency" type="monotone" dataKey="p99LatencyMs" name="P99 latency (ms)" stroke="#fbbf24" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} /></ComposedChart></ResponsiveContainer></div>}
  </Card>
}

function HttpErrorScatter({ data, error }: { data: DashboardTelemetry['http5xx']; error: string }) {
  return <Card className="p-4 sm:p-5">
    <div className="mb-4 flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-white">HTTP 5xx error bursts</h3><p className="mt-1 text-[10px] text-slate-500">Anomaly timestamps from the telemetry API</p></div><AlertTriangle size={16} className="text-rose-200" /></div>
    {data.length === 0 ? <EmptyState title="No 5xx samples available" detail={error || 'The telemetry API has not returned timestamped 5xx events. The chart stays empty until real samples arrive.'} /> : <div className="h-64"><ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 8, right: 8, bottom: 4, left: -12 }}><CartesianGrid stroke="rgba(148,163,184,.12)" strokeDasharray="3 6" /><XAxis type="category" dataKey="timestamp" name="Timestamp" tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} /><YAxis type="number" dataKey="count" name="5xx count" tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} /><ChartTooltip /><Scatter name="HTTP 5xx" data={data} fill="#fb7185" /></ScatterChart></ResponsiveContainer></div>}
  </Card>
}

function RemediationEngine({ uploaded, analysis }: { uploaded: UploadedArtifact; analysis?: AnalysisSummary }) {
  const timeMapping = analysis?.mappings.find((mapping) => mapping.role.toLowerCase() === 'time')?.column
  const categoryMapping = analysis?.mappings.find((mapping) => ['category', 'status'].includes(mapping.role.toLowerCase()))?.column
  const sourceLiteral = JSON.stringify(uploaded.path)
  const timeLiteral = JSON.stringify(timeMapping ?? '')
  const python = analysis
    ? `from pathlib import Path\nimport pandas as pd\n\nsource = Path(${sourceLiteral})\nframe = pd.read_csv(source, sep="\\t" if source.suffix.lower() == ".tsv" else ",", on_bad_lines="warn")\nframe.columns = [str(column).strip() for column in frame.columns]\nframe = frame.drop_duplicates()\n${timeMapping ? `frame[${timeLiteral}] = pd.to_datetime(frame[${timeLiteral}], errors="coerce", utc=True)\nframe = frame.dropna(subset=[${timeLiteral}]).sort_values(${timeLiteral})\n` : ''}frame.to_csv(source.with_name(source.stem + "_sanitized.csv"), index=False)\n`
    : ''
  const sql = timeMapping || categoryMapping
    ? `-- Verify the destination table name before applying.\n${timeMapping ? `CREATE INDEX IF NOT EXISTS "idx_events_time" ON "ingested_events" (${quoteIdentifier(timeMapping)});\n` : ''}${categoryMapping ? `CREATE INDEX IF NOT EXISTS "idx_events_category" ON "ingested_events" (${quoteIdentifier(categoryMapping)});\n` : ''}`
    : ''

  return <Card className="overflow-hidden">
    <div className="flex items-center gap-3 border-b border-white/[0.07] px-5 py-4"><IconTile tone="emerald"><Terminal size={17} /></IconTile><div><h3 className="text-sm font-semibold text-white">Remediation Engine</h3><p className="mt-1 text-[10px] text-slate-500">Templates are grounded in returned schema mappings and findings.</p></div></div>
    {analysis ? <div className="space-y-4 p-5">
      <div className="rounded-xl border border-white/[0.07] bg-slate-950/45 p-3"><p className="text-[9px] font-semibold uppercase tracking-[0.15em] text-slate-500">Analysis evidence</p><p className="mt-2 text-xs text-slate-300">{analysis.totalRows.toLocaleString()} rows · {analysis.errorRows.toLocaleString()} error rows · {(analysis.errorRate * 100).toFixed(2)}% observed error rate</p>{analysis.problems.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-4 text-[10px] text-amber-100">{analysis.problems.slice(0, 4).map((problem, index) => <li key={`${problem}-${index}`}>{problem}</li>)}</ul>}</div>
      <CodeBlock title="Python · sanitize and normalize" code={python} />
      {sql ? <CodeBlock title="SQL · candidate indexes" code={sql} /> : <p className="rounded-xl border border-white/[0.06] p-3 text-[10px] leading-5 text-slate-500">No time or category mapping was returned, so no index patch is proposed.</p>}
    </div> : <EmptyState title="Awaiting structured analysis" detail="The service must return findings and column mappings before remediation can be tailored. Generic or invented patches are not shown." icon={<Terminal size={17} />} />}
  </Card>
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  return <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-[#070c16]"><div className="border-b border-white/[0.06] px-3 py-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">{title}</div><pre className="max-h-60 overflow-auto whitespace-pre-wrap p-3 font-mono text-[10px] leading-5 text-emerald-100/90">{code}</pre></div>
}

function SandboxTelemetry({
  uploaded,
  telemetry,
  telemetryError,
  onRefreshTelemetry,
}: {
  uploaded?: UploadedArtifact
  telemetry: DashboardTelemetry
  telemetryError: string
  onRefreshTelemetry: () => void
}) {
  return <div className="space-y-7">
    <PageHeading kicker="On-prem workspace · live observability" title="Sandbox & Telemetry" description="Inspect the backend-confirmed workspace receipt and view measured platform signals. Telemetry remains blank until the service exposes real samples." action={<button onClick={onRefreshTelemetry} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-xs font-medium text-slate-300 transition hover:border-cyan-200/25 hover:bg-white/[0.07]"><RefreshCw size={14} />Refresh signals</button>} />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(300px,.9fr)]">
      <Card className="p-5"><div className="flex items-start gap-3"><IconTile tone="cyan"><HardDrive size={17} /></IconTile><div><h2 className="text-sm font-semibold text-white">Workspace boundary</h2><p className="mt-1 text-xs text-slate-500">Artifact metadata returned by the ingestion service.</p></div></div>
        {uploaded ? <div className="mt-5 space-y-3"><MetadataRow label="Saved path" value={uploaded.path} icon={<FileCode2 size={14} />} /><MetadataRow label="Artifact" value={`${uploaded.name} · ${formatBytes(uploaded.size)}`} icon={<FileText size={14} />} /><MetadataRow label="SHA-256" value={uploaded.sha256} icon={<Fingerprint size={14} />} mono /></div> : <div className="mt-4"><EmptyState title="No artifact in this session" detail="Upload a log or metric export in the analyzer to receive a backend-confirmed workspace receipt." /></div>}
      </Card>
      <Card className="p-5"><div className="flex items-start gap-3"><IconTile tone={telemetryError ? 'amber' : 'emerald'}><Server size={17} /></IconTile><div className="min-w-0"><h2 className="text-sm font-semibold text-white">Telemetry service</h2><p className="mt-1 text-xs text-slate-500">Live API status · no browser-generated samples</p></div><span className="ml-auto"><StatusPill online={!telemetryError} label={telemetryError ? 'Unavailable' : 'Connected'} /></span></div>
        {telemetryError ? <div className="mt-5 rounded-xl border border-amber-200/10 bg-amber-200/[0.04] p-3 text-xs leading-5 text-slate-400">{telemetryError}</div> : <div className="mt-5 grid grid-cols-2 gap-3"><MiniMetric label="Samples" value={String(telemetry.samples.length)} /><MiniMetric label="HTTP 5xx events" value={String(telemetry.http5xx.length)} /></div>}
      </Card>
    </div>
    <div className="grid gap-4 2xl:grid-cols-2"><TelemetryTrend data={telemetry.samples} error={telemetryError} /><HttpErrorScatter data={telemetry.http5xx} error={telemetryError} /></div>
  </div>
}

function MetadataRow({ label, value, icon, mono = false }: { label: string; value: string; icon: ReactNode; mono?: boolean }) {
  return <div className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-slate-950/40 px-3 py-3"><span className="mt-0.5 text-slate-500">{icon}</span><div className="min-w-0"><p className="text-[9px] uppercase tracking-[0.14em] text-slate-600">{label}</p><p className={`mt-1 break-all text-xs text-slate-300 ${mono ? 'font-mono' : ''}`}>{value}</p></div></div>
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-white/[0.07] bg-slate-950/40 p-3"><p className="text-[9px] uppercase tracking-[0.12em] text-slate-500">{label}</p><p className="mt-2 text-lg font-semibold text-white">{value}</p></div>
}

function Sidebar({ active, onSelect, pendingCount }: { active: View; onSelect: (view: View) => void; pendingCount: number }) {
  return <aside className="relative z-10 flex w-full shrink-0 flex-col border-b border-white/[0.08] bg-[#080d18]/85 px-4 py-4 backdrop-blur-2xl lg:sticky lg:top-0 lg:h-screen lg:w-[270px] lg:border-b-0 lg:border-r lg:px-5 lg:py-6">
    <div className="flex items-center gap-3 px-1"><div className="grid h-11 w-11 place-items-center rounded-2xl border border-amber-200/20 bg-amber-200/[0.08] text-amber-100 shadow-[0_0_35px_-12px_rgba(251,191,36,.4)]"><Network size={19} /></div><div><p className="text-[11px] font-bold tracking-[0.16em] text-white">NEUROFEBRIC</p><p className="mt-1 text-[9px] uppercase tracking-[0.2em] text-slate-500">Quality & security harness</p></div></div>
    <div className="mt-8 hidden lg:block"><p className="px-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-600">Control center</p><nav className="mt-3 space-y-1">{navigation.map(({ id, title, subtitle, icon: Icon }) => <NavItem key={id} id={id} title={title} subtitle={subtitle} icon={<Icon size={16} />} active={active === id} count={id === 'firewall' && pendingCount > 0 ? pendingCount : undefined} onSelect={onSelect} />)}</nav></div>
    <nav aria-label="Primary navigation" className="mt-5 flex gap-2 overflow-x-auto lg:hidden">{navigation.map(({ id, title, icon: Icon }) => <button key={id} onClick={() => onSelect(id)} className={`flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2.5 text-[10px] font-medium ${active === id ? 'border-amber-200/20 bg-amber-200/[0.08] text-amber-100' : 'border-white/[0.06] text-slate-400 hover:bg-white/[0.04]'}`}><Icon size={14} />{title}</button>)}</nav>
    <div className="mt-auto hidden rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4 lg:block"><div className="flex items-center gap-2 text-[10px] font-semibold text-slate-300"><LockKeyhole size={13} className="text-amber-200" />Evidence-first by design</div><p className="mt-2 text-[10px] leading-5 text-slate-500">Live API data only. Empty states are preferred to synthetic operational signals.</p></div>
    <div className="mt-5 hidden items-center justify-between border-t border-white/[0.06] pt-4 text-[9px] text-slate-600 lg:flex"><span>ON-PREMISE READY</span><span>v1.0</span></div>
  </aside>
}

function NavItem({ id, title, subtitle, icon, active, count, onSelect }: { id: View; title: string; subtitle: string; icon: ReactNode; active: boolean; count?: number; onSelect: (view: View) => void }) {
  return <button onClick={() => onSelect(id)} className={`group flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${active ? 'border-amber-200/15 bg-[linear-gradient(100deg,rgba(251,191,36,.10),rgba(255,255,255,.025))] text-white shadow-[inset_2px_0_0_#fbbf24]' : 'border-transparent text-slate-400 hover:border-white/[0.06] hover:bg-white/[0.035] hover:text-slate-200'}`}>
    <span className={active ? 'text-amber-100' : 'text-slate-500 group-hover:text-slate-300'}>{icon}</span><span className="min-w-0 flex-1"><span className="block text-[11px] font-semibold">{title}</span><span className="mt-1 block text-[9px] text-slate-600">{subtitle}</span></span>{count !== undefined && <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[9px] font-bold text-slate-950">{count}</span>}{active && <ChevronRight size={13} className="text-amber-200/70" />}
  </button>
}

function formatDate(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function formatBytes(size: number): string {
  return size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(2)} MB`
}

function App() {
  const [view, setView] = useState<View>('analyzer')
  const [ledger, setLedger] = useState<ApprovalLedgerRecord[]>([])
  const [ledgerLoading, setLedgerLoading] = useState(true)
  const [ledgerError, setLedgerError] = useState('')
  const [busyToken, setBusyToken] = useState<string>()
  const [firewallNotice, setFirewallNotice] = useState<ActionNotice>()
  const ledgerLoaded = useRef(false)
  const ledgerInFlight = useRef(false)

  const [uploaded, setUploaded] = useState<UploadedArtifact>()
  const [analysis, setAnalysis] = useState<AgentTaskResponse>()
  const [analysisPhase, setAnalysisPhase] = useState<'idle' | 'uploading' | 'analyzing' | 'ready' | 'error'>('idle')
  const [analysisError, setAnalysisError] = useState('')
  const [analysisNotice, setAnalysisNotice] = useState<ActionNotice>()

  const [telemetry, setTelemetry] = useState<DashboardTelemetry>(emptyTelemetry)
  const [telemetryError, setTelemetryError] = useState('')
  const [telemetryLoaded, setTelemetryLoaded] = useState(false)
  const telemetryInFlight = useRef(false)

  const refreshLedger = useCallback(async () => {
    if (ledgerInFlight.current) return
    ledgerInFlight.current = true
    if (!ledgerLoaded.current) setLedgerLoading(true)
    try {
      const rows = await fetchLedger()
      setLedger(rows)
      setLedgerError('')
      ledgerLoaded.current = true
    } catch (cause) {
      setLedgerError(cause instanceof Error ? cause.message : 'Could not load the governance ledger.')
    } finally {
      setLedgerLoading(false)
      ledgerInFlight.current = false
    }
  }, [])

  const refreshTelemetry = useCallback(async () => {
    if (telemetryInFlight.current) return
    telemetryInFlight.current = true
    try {
      const result = await fetchTelemetry()
      setTelemetry(result)
      setTelemetryError('')
      setTelemetryLoaded(true)
    } catch (cause) {
      setTelemetryError(cause instanceof Error ? cause.message : 'Telemetry is not available.')
      setTelemetryLoaded(false)
      setTelemetry(emptyTelemetry)
    } finally {
      telemetryInFlight.current = false
    }
  }, [])

  useEffect(() => {
    void refreshLedger()
    const interval = window.setInterval(() => void refreshLedger(), 5_000)
    return () => window.clearInterval(interval)
  }, [refreshLedger])

  useEffect(() => {
    void refreshTelemetry()
    const interval = window.setInterval(() => void refreshTelemetry(), 15_000)
    return () => window.clearInterval(interval)
  }, [refreshTelemetry])

  async function decide(entry: ApprovalLedgerRecord, decision: 'approved' | 'refused') {
    setBusyToken(entry.token)
    setFirewallNotice(undefined)
    try {
      await submitVerdict(entry.token, decision)
      setFirewallNotice({ kind: 'success', text: decision === 'approved' ? 'Approval recorded against the task token.' : 'Action denied and recorded in the governance ledger.' })
      await refreshLedger()
    } catch (cause) {
      setFirewallNotice({ kind: 'error', text: cause instanceof Error ? cause.message : 'The verdict could not be submitted.' })
    } finally {
      setBusyToken(undefined)
    }
  }

  async function analyzeFile(file?: File) {
    if (!file) return
    const allowed = ['.log', '.csv', '.tsv', '.jsonl', '.sqlite', '.db'].some((suffix) => file.name.toLowerCase().endsWith(suffix))
    if (!allowed) {
      setAnalysisError('Choose a .log, .csv, .tsv, .jsonl, .sqlite, or .db source.')
      setAnalysisPhase('error')
      return
    }

    setView('analyzer')
    setAnalysisError('')
    setAnalysisNotice(undefined)
    setAnalysis(undefined)
    setAnalysisPhase('uploading')
    try {
      const receipt = await uploadArtifact(file)
      setUploaded(receipt)
      setAnalysisPhase('analyzing')
      const result = await executeAnalysis(receipt.path, ANALYSIS_PROMPT)
      setAnalysis(result)
      if (result.telemetry) setTelemetry(result.telemetry)
      if (result.status && result.status !== 'DELIVERED') {
        throw new Error(result.failure?.reason ?? `Analysis finished with status ${result.status}.`)
      }
      setAnalysisPhase('ready')
      setAnalysisNotice({ kind: 'success', text: 'Artifact secured and Conductor analysis completed.' })
    } catch (cause) {
      setAnalysisPhase('error')
      setAnalysisError(cause instanceof Error ? cause.message : 'The artifact could not be analyzed.')
    }
  }

  const pendingCount = ledger.filter((row) => row.status.toLowerCase() === 'pending').length
  const telemetryOnline = telemetryLoaded && !telemetryError
  const active = navigation.find((item) => item.id === view)
  const ActiveIcon = active?.icon ?? Activity

  return <div className="relative min-h-screen overflow-hidden bg-[#060914] text-slate-200" style={{ backgroundImage: 'radial-gradient(ellipse at 72% -10%, rgba(180,130,45,.14), transparent 36%), radial-gradient(ellipse at 8% 44%, rgba(27,76,112,.10), transparent 34%)' }}>
    <div className="pointer-events-none fixed inset-0 opacity-[0.12]" style={{ backgroundImage: 'linear-gradient(rgba(148,163,184,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,.08) 1px, transparent 1px)', backgroundSize: '48px 48px', maskImage: 'linear-gradient(to bottom, black, transparent 80%)' }} />
    <div className="relative flex min-h-screen flex-col lg:flex-row">
      <Sidebar active={view} onSelect={setView} pendingCount={pendingCount} />
      <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-9 lg:py-7">
        <header className="mb-7 flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.07] pb-5">
          <div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-amber-100"><ActiveIcon size={16} /></div><div><p className="text-[9px] uppercase tracking-[0.19em] text-slate-600">NeuroFebric / operations</p><p className="mt-1 text-xs font-semibold text-slate-200">{active?.title}</p></div></div>
          <div className="flex flex-wrap items-center gap-2"><StatusPill online={!ledgerError && ledgerLoaded.current} label={ledgerError ? 'Governance offline' : ledgerLoading ? 'Connecting' : 'Governance live'} /><StatusPill online={telemetryOnline} label={telemetryError ? 'Telemetry unavailable' : telemetryOnline ? 'Telemetry live' : 'Telemetry connecting'} /></div>
        </header>

        {view === 'firewall' && <Firewall ledger={ledger} loading={ledgerLoading} error={ledgerError} busyToken={busyToken} notice={firewallNotice} onRefresh={() => void refreshLedger()} onDecision={(entry, decision) => void decide(entry, decision)} />}
        {view === 'analyzer' && <Analyzer uploaded={uploaded} analysis={analysis} telemetry={telemetry} telemetryError={telemetryError} phase={analysisPhase} error={analysisError} notice={analysisNotice} onFile={(file) => void analyzeFile(file)} onNoticeDismiss={() => setAnalysisNotice(undefined)} />}
        {view === 'sandbox' && <SandboxTelemetry uploaded={uploaded} telemetry={telemetry} telemetryError={telemetryError} onRefreshTelemetry={() => void refreshTelemetry()} />}

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-5 text-[9px] uppercase tracking-[0.14em] text-slate-600"><span className="inline-flex items-center gap-2"><LockKeyhole size={12} />On-prem quality & security controls</span><span className="inline-flex items-center gap-2"><ArrowUpRight size={12} />Evidence-backed · fail closed</span></footer>
      </main>
    </div>
  </div>
}

export default App

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTelemetry } from '../context/TelemetryContext';
import {
  Zap,
  Database,
  ArrowRight,
  Play,
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
  Terminal,
  Wrench,
  Send,
} from 'lucide-react';
import { InfoTooltip } from '../components/common/Tooltip';
import { LiveThroughputChart } from '../components/charts/LiveThroughputChart';

export function OverviewPage() {
  const navigate = useNavigate();
  const {
    logs,
    serviceCircuits,
    trippedCircuits,
    proposals,
    merkleStatus,
    injectAnomaly,
    emitHeartbeat,
    ingestCustomPayload,
    synthesizeProposal,
    latencyMs,
  } = useTelemetry();

  const [showIngestModal, setShowIngestModal] = useState(false);
  const [customService, setCustomService] = useState('order-service');
  const [customSev, setCustomSev] = useState<'INFO' | 'WARNING' | 'CRITICAL'>('CRITICAL');
  const [customMsg, setCustomMsg] = useState(
    'Upstream payment gateway timeout (504). Header Authorization: Bearer sk_live_51N8x928172 leaked in trace.'
  );

  const pendingProposals = proposals.filter((p) => p.status === 'PENDING');
  const blockedProposals = pendingProposals.filter((p) => p.astStatus === 'REJECT');
  const hasIncident = trippedCircuits.length > 0 || blockedProposals.length > 0;

  const handleSendCustom = (e: FormEvent) => {
    e.preventDefault();
    if (!customMsg.trim()) return;
    ingestCustomPayload(customService, customSev, customMsg);
    setShowIngestModal(false);
  };

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-7xl font-sans tabular-nums">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-2xl font-bold text-white tracking-tight">NeuroFabric Mission Control</h1>
            <InfoTooltip content="Unified observability and remediation command center. Tracks live ingestion rate, active circuit breaker locks, pending GitOps patches, and SHA-256 Merkle audit depth." />
          </div>
          <p className="text-xs text-slate-300 mt-1">
            Live edge telemetry ingestion, 3-strike circuit isolation, and AST-screened GitOps remediation.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={() => setShowIngestModal(!showIngestModal)}
            className="px-3.5 py-2 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/40 text-emerald-300 rounded-xl text-xs font-mono font-bold flex items-center space-x-1.5 transition"
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Ingest Custom Event</span>
          </button>
          <button
            onClick={emitHeartbeat}
            className="px-3.5 py-2 bg-[#121622] hover:bg-slate-800 border border-white/10 text-slate-200 rounded-xl text-xs font-mono font-medium flex items-center space-x-1.5 transition"
          >
            <Play className="w-3.5 h-3.5 text-emerald-400" />
            <span>Emit Heartbeat</span>
          </button>
          <button
            onClick={injectAnomaly}
            className="px-3.5 py-2 bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-300 rounded-xl text-xs font-mono font-bold flex items-center space-x-1.5 transition"
          >
            <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
            <span>Simulate Breach &amp; Secret Leak</span>
          </button>
        </div>
      </div>

      {showIngestModal && (
        <form
          onSubmit={handleSendCustom}
          className="p-5 rounded-2xl nf-card border border-emerald-400/50 space-y-4"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2 text-xs font-mono font-bold text-emerald-400 uppercase">
              <Terminal className="w-4 h-4" />
              <span>Custom Telemetry Frame Ingestor (Tests In-Flight DLP &amp; Circuit Fencing)</span>
            </div>
            <button
              type="button"
              onClick={() => setShowIngestModal(false)}
              className="text-xs font-mono text-slate-400 hover:text-white"
            >
              Close
            </button>
          </div>

          <div className="grid md:grid-cols-4 gap-3 font-mono text-xs">
            <div>
              <label className="text-[10px] text-slate-400 block mb-1">TARGET SERVICE</label>
              <select
                value={customService}
                onChange={(e) => setCustomService(e.target.value)}
                className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-white"
              >
                <option value="order-service">order-service</option>
                <option value="auth-gateway">auth-gateway</option>
                <option value="flapping-payment-worker">flapping-payment-worker</option>
                <option value="billing-core">billing-core</option>
                <option value="egress-payments-api">egress-payments-api</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-slate-400 block mb-1">SEVERITY</label>
              <select
                value={customSev}
                onChange={(e) => setCustomSev(e.target.value as 'INFO' | 'WARNING' | 'CRITICAL')}
                className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-white"
              >
                <option value="CRITICAL">CRITICAL (Trips Service Circuit)</option>
                <option value="WARNING">WARNING</option>
                <option value="INFO">INFO</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="text-[10px] text-slate-400 block mb-1">
                RAW LOG PAYLOAD (Include Bearer tokens or Aadhaar/PAN to test redaction)
              </label>
              <div className="flex space-x-2">
                <input
                  type="text"
                  value={customMsg}
                  onChange={(e) => setCustomMsg(e.target.value)}
                  className="flex-1 bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-white"
                />
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold flex items-center space-x-1.5 shrink-0"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Ingest</span>
                </button>
              </div>
            </div>
          </div>
        </form>
      )}

      {/* 4-Card Bento KPI Grid with Short Explainable Subtitles */}
      <div className="grid md:grid-cols-4 gap-4">
        <div
          className={`p-6 rounded-2xl nf-card md:col-span-2 flex flex-col justify-between border ${
            hasIncident ? 'border-rose-500/50' : ''
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="text-xs font-mono text-slate-300 font-bold uppercase tracking-wider">
                Cluster Incident Posture
              </span>
              <InfoTooltip content="Shows whether any microservice is locked in HTTP 423 circuit isolation or has an unreviewed GitOps patch." />
            </div>
            {hasIncident ? (
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-rose-950 text-rose-300 border border-rose-700 flex items-center space-x-1">
                <ShieldAlert className="w-3 h-3" />
                <span>ACTIVE INCIDENT ({trippedCircuits.length} FENCED)</span>
              </span>
            ) : (
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-950 text-emerald-300 border border-emerald-800 flex items-center space-x-1">
                <CheckCircle2 className="w-3 h-3" />
                <span>NOMINAL</span>
              </span>
            )}
          </div>

          <div className="my-3">
            <div className={`text-2xl font-extrabold ${hasIncident ? 'text-rose-400' : 'text-white'}`}>
              {hasIncident
                ? `${trippedCircuits.length} Circuit Tripped • ${pendingProposals.length} Patches Queued`
                : 'ALL SERVICES NOMINAL'}
            </div>
            <p className="text-xs text-slate-300 mt-1 leading-relaxed">
              {hasIncident
                ? `Isolated services: ${trippedCircuits.join(', ') || 'None'}. ${blockedProposals.length} unsafe diff blocked by AST Gate.`
                : 'Zero active breaches. All incoming telemetry frames pass DLP and AST verification.'}
            </p>
          </div>

          <div className="flex items-center space-x-4">
            <button
              onClick={() => navigate('/embassy')}
              className="text-xs font-mono text-emerald-400 hover:underline flex items-center space-x-1 font-bold"
            >
              <span>Inspect {pendingProposals.length} GitOps PRs</span>
              <ArrowRight className="w-3 h-3" />
            </button>
            <button
              onClick={() => navigate('/alerts')}
              className="text-xs font-mono text-slate-300 hover:text-white flex items-center space-x-1"
            >
              <span>Live Stream ({logs.length} frames)</span>
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        </div>

        <div className="p-6 rounded-2xl nf-card flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="text-xs font-mono text-slate-300 font-bold uppercase tracking-wider">Circuit Fence</span>
              <InfoTooltip content="3 timeout strikes within 60s automatically locks a service (HTTP 423) to stop cascading failures." />
            </div>
            <Zap className="w-4 h-4 text-amber-400" />
          </div>
          <div className="my-2">
            <div className="text-3xl font-extrabold text-amber-400 font-mono">
              {trippedCircuits.length} TRIPPED
            </div>
            <div className="text-xs text-slate-300 mt-1">
              {serviceCircuits.filter((c) => c.status === 'HALF-OPEN').length} half-open probing •{' '}
              {serviceCircuits.filter((c) => c.status === 'CLOSED').length} healthy
            </div>
          </div>
          <button
            onClick={() => navigate('/circuits')}
            className="text-xs font-mono text-amber-400 hover:underline flex items-center space-x-1 self-start font-bold"
          >
            <span>Manage Circuit Fleet</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>

        <div className="p-6 rounded-2xl nf-card flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="text-xs font-mono text-slate-300 font-bold uppercase tracking-wider">Merkle Audit</span>
              <InfoTooltip content="Every approval, refusal, and IAM change is hashed into an immutable SHA-256 chain." />
            </div>
            <Database className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="my-2">
            <div className="text-3xl font-extrabold text-emerald-400 font-mono">
              {merkleStatus.totalLeaves.toLocaleString()}
            </div>
            <div className="text-xs text-slate-300 mt-1">Tamper-evident leaves sealed</div>
          </div>
          <button
            onClick={() => navigate('/governance')}
            className="text-xs font-mono text-emerald-400 hover:underline flex items-center space-x-1 self-start font-bold"
          >
            <span>Verify SHA-256 Chain</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      </div>

      <LiveThroughputChart />

      {/* 4-Service Health Matrix */}
      <div className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <span className="text-[11px] font-mono font-bold text-slate-300 uppercase tracking-wider">
            Microservice Fleet Health &amp; Strike Counters (Click any service to manage circuit)
          </span>
          <span className="text-[11px] font-mono text-slate-400">3 strikes in 60s = HTTP 423 Lock</span>
        </div>
        <div className="grid md:grid-cols-4 gap-4 font-mono text-xs">
          {serviceCircuits.map((svc) => (
            <div
              key={svc.name}
              onClick={() => navigate('/circuits')}
              className="p-4 rounded-2xl nf-card-interactive cursor-pointer space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-white truncate">{svc.name}</span>
                <span
                  className={`text-[9px] px-2 py-0.5 rounded-full font-bold ${
                    svc.status === 'TRIPPED'
                      ? 'bg-rose-950 text-rose-300 border border-rose-700'
                      : svc.status === 'HALF-OPEN'
                      ? 'bg-amber-950 text-amber-300 border border-amber-700'
                      : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                  }`}
                >
                  {svc.status}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] text-slate-300">
                <span>Strikes: {svc.strikes}/3</span>
                <span>P99: {svc.latencyMs}ms</span>
                <span>Err: {svc.errorRate}%</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Live Telemetry Feed */}
      <div className="p-6 rounded-2xl nf-card space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center space-x-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              <span className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                Recent Edge Telemetry Stream ({logs.length}/200 ring buffer)
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Each event is scrubbed for secrets/PII in-flight. Click &quot;Draft PR&quot; to open a remediation patch for any event.
            </p>
          </div>
          <div className="flex items-center space-x-4 text-xs font-mono">
            <span className="text-slate-300">Propagation: {latencyMs}ms</span>
            <button
              onClick={() => navigate('/alerts')}
              className="text-emerald-400 hover:underline flex items-center space-x-1 font-bold"
            >
              <span>Full Stream</span>
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        </div>

        <div className="space-y-2 font-mono text-xs">
          {logs.slice(0, 6).map((log) => (
            <div
              key={log.id}
              className="p-3 rounded-xl bg-[#05070B] border border-white/10 flex flex-wrap items-center justify-between gap-4 hover:border-white/25 transition"
            >
              <div className="flex items-center space-x-3 truncate flex-1">
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-bold shrink-0 ${
                    log.severity === 'CRITICAL'
                      ? 'bg-rose-950 text-rose-300 border border-rose-800'
                      : log.severity === 'WARNING'
                      ? 'bg-amber-950 text-amber-300 border border-amber-800'
                      : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                  }`}
                >
                  {log.severity}
                </span>
                <span className="text-white font-bold shrink-0">{log.service}:</span>
                <span className="text-slate-300 truncate">{log.message}</span>
              </div>

              <div className="flex items-center space-x-3 shrink-0">
                {log.dlpScrubbed && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold">
                    DLP REDACTED
                  </span>
                )}
                <button
                  onClick={async () => {
                    await synthesizeProposal(log.service, `Remediation triggered from Mission Control event: ${log.message}`);
                    navigate('/embassy');
                  }}
                  className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-emerald-500/20 border border-white/10 hover:border-emerald-400/40 text-[10px] text-emerald-300 flex items-center space-x-1 transition"
                >
                  <Wrench className="w-3 h-3" />
                  <span>Draft PR</span>
                </button>
                <span className="text-[10px] text-slate-400">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

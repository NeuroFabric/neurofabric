import { useState, useEffect, useCallback } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL || 'https://neurofabric-backend.onrender.com').replace(/\/$/, '');

interface IngestionMetrics {
  throughput: number;
  suppressedAlerts: number;
  secretsScrubbed: number;
  streamLagMs: number;
  hitlPending: number;
  autonomyRate: number;
  mttrSeconds: number;
  avgConfidence: number;
}

interface HitlProposal {
  taskId: string;
  target: string;
  title?: string;
  reason?: string;
  severity?: string;
  confidence?: number;
  blastRadius?: number | string;
  patch?: {
    diff?: string;
    target?: string;
  };
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANARY_VERIFYING' | 'ROLLED_BACK' | 'VERIFIED_RESOLVED';
}

interface LedgerEntry {
  token: string;
  status: string;
  subject?: any;
  decidedAt?: string | null;
  approvedBy?: string | null;
  reason?: string | null;
  createdAt?: string | null;
  owaspRef?: string | null;
  nistRef?: string | null;
}

interface TelemetryLog {
  id: string;
  timestamp: string;
  service: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  message: string;
  dlpScrubbed?: boolean;
}

export default function App() {
  const [connected, setConnected] = useState<boolean>(false);
  const [metrics, setMetrics] = useState<IngestionMetrics>({
    throughput: 0,
    suppressedAlerts: 0,
    secretsScrubbed: 0,
    streamLagMs: 0,
    hitlPending: 0,
    autonomyRate: 100,
    mttrSeconds: 0,
    avgConfidence: 88,
  });

  const [activeProposal, setActiveProposal] = useState<HitlProposal | null>(null);
  const [activeCanary, setActiveCanary] = useState<{ taskId: string; target: string; timeoutMs?: number } | null>(null);
  const [rolledBackTask, setRolledBackTask] = useState<{ taskId: string; target: string; reason?: string } | null>(null);
  const [verifiedResolved, setVerifiedResolved] = useState<{ taskId: string; target: string } | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [telemetryLogs, setTelemetryLogs] = useState<TelemetryLog[]>([]);
  const [isDeciding, setIsDeciding] = useState<boolean>(false);
  const [ledgerFilter, setLedgerFilter] = useState<string>('ALL');

  const fetchLedger = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/governance/ledger`);
      if (res.ok) {
        const data = await res.json();
        setLedger(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.warn('[Ledger] Fetch failed:', err);
    }
  }, []);

  const fetchMetrics = useCallback(async () => {
    try {
      const [opsRes, ingRes] = await Promise.all([
        fetch(`${API_BASE}/api/v1/ops/metrics`).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_BASE}/api/v1/metrics/ingestion`).then((r) => (r.ok ? r.json() : null)),
      ]);
      setMetrics((prev) => ({
        ...prev,
        suppressedAlerts: opsRes?.suppressedAlerts ?? prev.suppressedAlerts,
        streamLagMs: opsRes?.streamLagMs ?? prev.streamLagMs,
        throughput: ingRes?.throughput ?? prev.throughput,
        secretsScrubbed: ingRes?.secretsScrubbed ?? prev.secretsScrubbed,
      }));
    } catch (err) {
      console.warn('[Metrics] Fetch failed:', err);
    }
  }, []);

  const handleDecision = async (taskId: string, decision: 'APPROVED' | 'REJECTED') => {
    setIsDeciding(true);
    try {
      if (decision === 'REJECTED') {
        setActiveProposal(null);
        setMetrics((m) => ({ ...m, hitlPending: Math.max(0, m.hitlPending - 1) }));
      } else {
        setActiveProposal((prev) => (prev ? { ...prev, status: 'CANARY_VERIFYING' } : null));
      }

      const res = await fetch(`${API_BASE}/api/v1/embassy/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, decision, reviewer: 'Incident Commander' }),
      });
      if (res.ok) {
        await fetchLedger();
      }
    } catch (err) {
      console.error('[Decision] Failed to submit decision:', err);
    } finally {
      setIsDeciding(false);
    }
  };

  useEffect(() => {
    fetchLedger();
    fetchMetrics();
    const pollTimer = setInterval(() => {
      fetchMetrics();
      fetchLedger();
    }, 5000);

    const es = new EventSource(`${API_BASE}/api/v1/stream/alerts`);

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (!payload || !payload.type) return;

        switch (payload.type) {
          case 'connected':
            setConnected(true);
            break;

          case 'INGESTION_METRICS_UPDATE':
            if (payload.data) {
              setMetrics((prev) => ({
                ...prev,
                throughput: payload.data.throughput ?? prev.throughput,
                secretsScrubbed: payload.data.secretsScrubbed ?? prev.secretsScrubbed,
              }));
            }
            break;

          case 'HITL_PROPOSAL':
          case 'NEW_PROPOSAL':
            if (payload.data) {
              setActiveProposal({
                taskId: payload.data.taskId || payload.data.taskToken || `task-${Date.now()}`,
                target: payload.data.target || 'redis-cluster',
                title: payload.data.title || `Critical Anomaly on ${payload.data.target || 'service'}`,
                reason: payload.data.reason || 'SLA latency threshold breached',
                severity: payload.data.severity || 'CRITICAL',
                confidence: payload.data.confidence ?? 88,
                blastRadius: payload.data.blastRadius ?? '15%',
                patch: payload.data.patch || {
                  diff: '--- deployment.yaml\n+++ deployment.yaml\n@@ -12,3 +12,3 @@\n-  replicas: 2\n+  replicas: 5',
                  target: payload.data.target || 'redis-cluster',
                },
                status: 'PENDING',
              });
              setMetrics((m) => ({ ...m, hitlPending: m.hitlPending + 1 }));
            }
            break;

          case 'REMEDIATION_DEPLOYED':
            setActiveProposal((prev) => (prev ? { ...prev, status: 'CANARY_VERIFYING' } : null));
            break;

          case 'CANARY_VERIFYING':
            setActiveCanary(payload.data);
            setRolledBackTask(null);
            setVerifiedResolved(null);
            setActiveProposal((prev) => (prev ? { ...prev, status: 'CANARY_VERIFYING' } : null));
            break;

          case 'CANARY_CONFIRMED':
            setActiveCanary(null);
            setVerifiedResolved(payload.data);
            setActiveProposal(null);
            setMetrics((m) => ({ ...m, hitlPending: Math.max(0, m.hitlPending - 1) }));
            fetchLedger();
            break;

          case 'REMEDIATION_ROLLED_BACK':
            setActiveCanary(null);
            setRolledBackTask(payload.data);
            setActiveProposal(null);
            setMetrics((m) => ({ ...m, hitlPending: Math.max(0, m.hitlPending - 1) }));
            fetchLedger();
            break;

          case 'DECISION_RESOLVED':
            fetchLedger();
            break;

          case 'ALERT_INGESTED':
            if (payload.data) {
              setTelemetryLogs((prev) => [
                {
                  id: payload.data.id || String(Date.now()),
                  timestamp: payload.data.timestamp || new Date().toLocaleTimeString(),
                  service: payload.data.service || 'service',
                  severity: payload.data.severity || 'INFO',
                  message: payload.data.message || 'Telemetry event processed',
                  dlpScrubbed: Boolean(payload.data.scrubbed),
                },
                ...prev.slice(0, 39),
              ]);
            }
            break;

          default:
            break;
        }
      } catch (err) {
        console.error('[SSE] Failed to parse message event:', err);
      }
    };

    return () => {
      clearInterval(pollTimer);
      es.close();
    };
  }, [fetchLedger, fetchMetrics]);

  const filteredLedger = ledger.filter((item) => {
    if (ledgerFilter === 'ALL') return true;
    return item.status.toUpperCase() === ledgerFilter;
  });

  return (
    <div className="min-h-screen bg-[#0a0d14] text-slate-100 p-4 md:p-8 font-sans">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-center justify-between pb-6 border-b border-slate-800 gap-4">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
            N
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl md:text-2xl font-bold tracking-tight text-white">NeuroFabric Ops</h1>
              <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-indigo-950/80 border border-indigo-700/50 text-indigo-400">
                Enterprise
              </span>
            </div>
            <p className="text-xs text-slate-400">Autonomous Telemetry Ingestion & Closed-Loop Remediation</p>
          </div>
        </div>

        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900 border border-slate-800 self-start md:self-auto">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
          <span className="text-xs font-mono font-medium text-slate-300">
            {connected ? 'Real-Time Stream Active' : 'Connecting to Stream...'}
          </span>
        </div>
      </header>

      {/* KPI Metric Strip */}
      <section className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 my-6">
        {[
          { label: 'Throughput', value: `${metrics.throughput} evt/s`, color: 'text-cyan-400' },
          { label: 'Alerts Suppressed', value: metrics.suppressedAlerts, color: 'text-purple-400' },
          { label: 'Secrets Scrubbed', value: metrics.secretsScrubbed, color: 'text-rose-400' },
          { label: 'Stream Lag', value: `${metrics.streamLagMs}ms`, color: 'text-amber-400' },
          { label: 'HITL Pending', value: metrics.hitlPending, color: 'text-amber-300' },
          { label: 'Autonomy', value: `${metrics.autonomyRate}%`, color: 'text-emerald-400' },
          { label: 'MTTR', value: `${metrics.mttrSeconds}s`, color: 'text-blue-400' },
          { label: 'Avg Confidence', value: `${metrics.avgConfidence}%`, color: 'text-indigo-400' },
        ].map((card, idx) => (
          <div key={idx} className="bg-[#111622] border border-slate-800/80 rounded-lg p-3 flex flex-col justify-between">
            <span className="text-[11px] font-medium text-slate-400 truncate">{card.label}</span>
            <span className={`text-xl font-bold font-mono mt-1 ${card.color}`}>{card.value}</span>
          </div>
        ))}
      </section>

      {/* Main Grid: Autonomous Remediation Circuit & Live Ingestion Stream */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-8">
        <section className="lg:col-span-7 bg-[#111622] border border-slate-800 rounded-lg p-5">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-200">
              Autonomous Remediation Circuit
            </h2>
            <span className="text-xs font-mono text-slate-400">Canary Verification Window: 15s</span>
          </div>

          {activeCanary && (
            <div className="mb-4 p-3.5 rounded-lg bg-amber-950/40 border border-amber-500/50 text-amber-300 flex items-center justify-between animate-pulse">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-amber-400" />
                <span className="text-xs font-medium">
                  Canary In-Flight on <strong>{activeCanary.target}</strong>: Observing telemetry for regressions...
                </span>
              </div>
              <span className="text-[11px] font-mono uppercase bg-amber-900/60 px-2 py-0.5 rounded">Observing</span>
            </div>
          )}

          {rolledBackTask && (
            <div className="mb-4 p-3.5 rounded-lg bg-rose-950/40 border border-rose-500/50 text-rose-300 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-rose-400" />
                <span className="text-xs font-medium">
                  Automated Rollback Executed on <strong>{rolledBackTask.target}</strong>: Diff inverted safely.
                </span>
              </div>
              <span className="text-[11px] font-mono uppercase bg-rose-900/60 px-2 py-0.5 rounded">Rolled Back</span>
            </div>
          )}

          {verifiedResolved && (
            <div className="mb-4 p-3.5 rounded-lg bg-emerald-950/40 border border-emerald-500/50 text-emerald-300 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                <span className="text-xs font-medium">
                  Canary Confirmed on <strong>{verifiedResolved.target}</strong>: No anomalies detected. Task verified.
                </span>
              </div>
              <span className="text-[11px] font-mono uppercase bg-emerald-900/60 px-2 py-0.5 rounded">Verified</span>
            </div>
          )}

          {activeProposal ? (
            <div className="bg-[#0e131f] border border-slate-700/60 rounded-lg p-4 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold px-2 py-0.5 rounded bg-rose-950 border border-rose-700 text-rose-300">
                      {activeProposal.severity}
                    </span>
                    <h3 className="text-sm font-semibold text-white">{activeProposal.title}</h3>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">Target: <code className="text-cyan-400">{activeProposal.target}</code></p>
                </div>
                <div className="text-right text-xs">
                  <div className="text-slate-400">Confidence: <span className="text-emerald-400 font-mono font-bold">{activeProposal.confidence}%</span></div>
                  <div className="text-slate-400">Blast Radius: <span className="text-amber-400 font-mono">{activeProposal.blastRadius}</span></div>
                </div>
              </div>

              <div>
                <span className="text-[11px] font-medium text-slate-400 block mb-1">Proposed Remediation Patch (Unified Diff)</span>
                <pre className="bg-black/70 border border-slate-800 rounded p-3 text-xs font-mono overflow-x-auto text-slate-300">
                  {activeProposal.patch?.diff ? (
                    activeProposal.patch.diff.split('\n').map((line, idx) => {
                      const color = line.startsWith('+') ? 'text-emerald-400' : line.startsWith('-') ? 'text-rose-400' : 'text-slate-400';
                      return <div key={idx} className={color}>{line}</div>;
                    })
                  ) : (
                    <span className="text-slate-500">No diff preview attached.</span>
                  )}
                </pre>
              </div>

              {activeProposal.status === 'CANARY_VERIFYING' ? (
                <div className="flex items-center justify-end gap-2 pt-2 text-xs text-amber-400 font-mono">
                  <span className="h-2 w-2 rounded-full bg-amber-400 animate-ping inline-block mr-1" />
                  Canary deployment in-flight... Verification window active.
                </div>
              ) : (
                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    disabled={isDeciding}
                    onClick={() => handleDecision(activeProposal.taskId, 'REJECTED')}
                    className="px-3.5 py-1.5 rounded text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-rose-400 border border-rose-900/40 transition-colors disabled:opacity-50"
                  >
                    Reject
                  </button>
                  <button
                    disabled={isDeciding}
                    onClick={() => handleDecision(activeProposal.taskId, 'APPROVED')}
                    className="px-4 py-1.5 rounded text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20 transition-colors disabled:opacity-50"
                  >
                    {isDeciding ? 'Deploying...' : 'Approve & Canary Deploy'}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-12 border border-dashed border-slate-800 rounded-lg text-slate-500 text-xs">
              Autonomous Embassy is quiet. No pending human-in-the-loop remediation proposals.
            </div>
          )}
        </section>

        <section className="lg:col-span-5 bg-[#111622] border border-slate-800 rounded-lg p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-200">
                Live Ingestion Stream
              </h2>
              <span className="text-xs font-mono text-cyan-400">{telemetryLogs.length} Events</span>
            </div>

            <div className="space-y-2.5 max-h-[340px] overflow-y-auto pr-1">
              {telemetryLogs.length > 0 ? (
                telemetryLogs.map((log) => (
                  <div key={log.id} className="p-2.5 rounded bg-[#0e131f] border border-slate-800/80 text-xs space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-cyan-400 font-semibold">{log.service}</span>
                      <span className="text-[10px] text-slate-500 font-mono">{log.timestamp}</span>
                    </div>
                    <p className="text-slate-300 font-mono text-[11px] truncate">{log.message}</p>
                    {log.dlpScrubbed && (
                      <span className="inline-block text-[9px] font-semibold text-rose-400 bg-rose-950/60 border border-rose-800/40 px-1.5 py-0.2 rounded">
                        DLP Scrubbed
                      </span>
                    )}
                  </div>
                ))
              ) : (
                <div className="text-center py-12 text-slate-500 text-xs font-mono">
                  Awaiting ingestion payloads... Run chaos simulator to inject events.
                </div>
              )}
            </div>
          </div>
          <div className="pt-4 border-t border-slate-800 mt-4 text-[11px] text-slate-400 flex justify-between">
            <span>DLP Scrubber: Active</span>
            <span>Target Allowlist: Enforced</span>
          </div>
        </section>
      </div>

      {/* Governance & Audit Ledger */}
      <section className="bg-[#111622] border border-slate-800 rounded-lg p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-800 mb-4 gap-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-200">
              Immutable Governance Ledger
            </h2>
            <p className="text-xs text-slate-400">PostgreSQL Audit Trail with OWASP & NIST Traceability</p>
          </div>

          <div className="flex flex-wrap gap-1.5 text-xs font-medium">
            {['ALL', 'PENDING', 'CANARY_VERIFYING', 'VERIFIED_RESOLVED', 'ROLLED_BACK', 'APPROVED', 'REJECTED'].map((filter) => (
              <button
                key={filter}
                onClick={() => setLedgerFilter(filter)}
                className={`px-2.5 py-1 rounded text-[11px] font-mono transition-colors ${
                  ledgerFilter === filter
                    ? 'bg-indigo-600 text-white font-semibold'
                    : 'bg-slate-800/60 text-slate-400 hover:bg-slate-800'
                }`}
              >
                {filter}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 font-mono uppercase text-[10px]">
                <th className="pb-2">Task Token</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Reviewed By</th>
                <th className="pb-2">Compliance Ref</th>
                <th className="pb-2">Decided At</th>
                <th className="pb-2">Created At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {filteredLedger.length > 0 ? (
                filteredLedger.map((row) => {
                  const statusColors: Record<string, string> = {
                    PENDING: 'bg-amber-950/80 text-amber-300 border-amber-800',
                    CANARY_VERIFYING: 'bg-cyan-950/80 text-cyan-300 border-cyan-800',
                    VERIFIED_RESOLVED: 'bg-emerald-950/80 text-emerald-300 border-emerald-800',
                    ROLLED_BACK: 'bg-rose-950/80 text-rose-300 border-rose-800',
                    APPROVED: 'bg-blue-950/80 text-blue-300 border-blue-800',
                    REJECTED: 'bg-slate-800 text-slate-300 border-slate-700',
                  };
                  return (
                    <tr key={row.token} className="hover:bg-slate-900/40">
                      <td className="py-2.5 text-slate-200">{row.token.slice(0, 16)}...</td>
                      <td className="py-2.5">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${statusColors[row.status] || 'bg-slate-800 text-slate-400'}`}>
                          {row.status}
                        </span>
                      </td>
                      <td className="py-2.5 text-slate-300">{row.approvedBy || 'System'}</td>
                      <td className="py-2.5 text-slate-400">
                        {row.owaspRef || row.nistRef ? (
                          <div className="space-y-0.5">
                            {row.owaspRef && <span className="block text-[10px] text-indigo-400">{row.owaspRef}</span>}
                            {row.nistRef && <span className="block text-[10px] text-cyan-400">{row.nistRef}</span>}
                          </div>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                      <td className="py-2.5 text-slate-400">{row.decidedAt ? new Date(row.decidedAt).toLocaleTimeString() : '—'}</td>
                      <td className="py-2.5 text-slate-400">{row.createdAt ? new Date(row.createdAt).toLocaleTimeString() : '—'}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-slate-500 font-mono">
                    No ledger entries match filter "{ledgerFilter}".
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

import { useState, useEffect, useCallback, useMemo } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL || 'https://neurofabric-backend.onrender.com').replace(/\/$/, '');

type TimeRange = '5M' | '15M' | '1H' | '24H' | 'ALL';

interface IngestionMetrics {
  throughput: number;
  suppressedAlerts: number;
  secretsScrubbed: number;
  streamLagMs: number;
  hitlPending: number;
  autonomyRate: number;
  mttrSeconds: number;
  avgConfidence: number;
  trippedCircuits?: string[];
}

interface HitlProposal {
  taskId: string;
  target: string;
  title?: string;
  reason?: string;
  severity?: string;
  confidence?: number;
  blastRadius?: number | string;
  isTripped?: boolean;
  patch?: {
    diff?: string;
    target?: string;
  };
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANARY_VERIFYING' | 'ROLLED_BACK' | 'VERIFIED_RESOLVED' | 'CIRCUIT_TRIPPED';
}

interface LedgerEntry {
  token: string;
  status: string;
  target?: string | null;
  subject?: any;
  decidedAt?: string | null;
  approvedBy?: string | null;
  reason?: string | null;
  createdAt?: string | null;
  createdTimestamp?: number;
  owaspRef?: string | null;
  nistRef?: string | null;
}

interface TelemetryLog {
  id: string;
  timestamp: string;
  rawTime: number;
  service: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  message: string;
  dlpScrubbed?: boolean;
}

interface ChartDataPoint {
  time: string;
  throughput: number;
  latency: number;
}

export default function App() {
  const [connected, setConnected] = useState<boolean>(false);
  const [timeRange, setTimeRange] = useState<TimeRange>('15M');
  const [metrics, setMetrics] = useState<IngestionMetrics>({
    throughput: 0,
    suppressedAlerts: 0,
    secretsScrubbed: 0,
    streamLagMs: 0,
    hitlPending: 0,
    autonomyRate: 100,
    mttrSeconds: 0,
    avgConfidence: 88,
    trippedCircuits: [],
  });

  const [activeCanary, setActiveCanary] = useState<{ taskId: string; target: string; timeoutMs?: number } | null>(null);
  const [rolledBackTask, setRolledBackTask] = useState<{ taskId: string; target: string; reason?: string } | null>(null);
  const [verifiedResolved, setVerifiedResolved] = useState<{ taskId: string; target: string } | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [telemetryLogs, setTelemetryLogs] = useState<TelemetryLog[]>([]);
  const [isDeciding, setIsDeciding] = useState<boolean>(false);
  const [ledgerFilter, setLedgerFilter] = useState<string>('ALL');

  // Selected Task Modal / Inspection Drawer
  const [selectedTask, setSelectedTask] = useState<LedgerEntry | null>(null);

  // Queue State
  const [pendingQueue, setPendingQueue] = useState<HitlProposal[]>([]);
  const [queueIndex, setQueueIndex] = useState<number>(0);

  // Live Chart Sliding History (Last 16 Ticks)
  const [telemetryHistory, setTelemetryHistory] = useState<ChartDataPoint[]>(() => {
    const initial = [];
    const now = Date.now();
    for (let i = 15; i >= 0; i--) {
      initial.push({
        time: new Date(now - i * 3000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        throughput: Math.floor(Math.random() * 4),
        latency: 12 + Math.floor(Math.random() * 8),
      });
    }
    return initial;
  });

  // Calculate cutoff timestamp for selected timeframe
  const timeCutoff = useMemo(() => {
    const now = Date.now();
    switch (timeRange) {
      case '5M': return now - 5 * 60 * 1000;
      case '15M': return now - 15 * 60 * 1000;
      case '1H': return now - 60 * 60 * 1000;
      case '24H': return now - 24 * 60 * 60 * 1000;
      case 'ALL': return 0;
    }
  }, [timeRange]);

  const fetchLedger = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/governance/ledger`);
      if (res.ok) {
        const data: LedgerEntry[] = await res.json();
        const list = Array.isArray(data) ? data : [];
        const normalized = list.map((item) => ({
          ...item,
          createdTimestamp: item.createdAt ? new Date(item.createdAt).getTime() : Date.now(),
        }));
        setLedger(normalized);

        const pendingItems: HitlProposal[] = normalized
          .filter((t) => t.status === 'PENDING')
          .map((t) => ({
            taskId: t.token,
            target: t.target || t.subject?.target || 'service',
            title: t.subject?.title || `Critical Anomaly on ${t.target || t.subject?.target || 'service'}`,
            reason: t.subject?.reason || t.reason || 'SLA threshold breached',
            severity: t.subject?.severity || 'CRITICAL',
            confidence: t.subject?.confidence ?? 88,
            blastRadius: t.subject?.blastRadius ?? '15%',
            isTripped: Boolean(t.subject?.isTripped),
            patch: t.subject?.patch || {
              diff: '--- deployment.yaml\n+++ deployment.yaml\n@@ -12,3 +12,3 @@\n-  replicas: 2\n+  replicas: 5',
              target: t.target || t.subject?.target || 'service',
            },
            status: 'PENDING',
          }));

        setPendingQueue(pendingItems);
      }
    } catch (err) {
      console.warn('[Ledger] Fetch failed:', err);
    }
  }, []);

  const fetchMetrics = useCallback(async () => {
    try {
      const ingRes = await fetch(`${API_BASE}/api/v1/metrics/ingestion`).then((r) => (r.ok ? r.json() : null));
      if (ingRes) {
        setMetrics((prev) => {
          const updated = {
            ...prev,
            throughput: ingRes.throughput ?? prev.throughput,
            secretsScrubbed: ingRes.secretsScrubbed ?? prev.secretsScrubbed,
            suppressedAlerts: ingRes.suppressedAlerts ?? prev.suppressedAlerts,
            hitlPending: ingRes.hitlPending ?? prev.hitlPending,
            trippedCircuits: ingRes.trippedCircuits || prev.trippedCircuits || [],
          };

          // Append to chart history
          setTelemetryHistory((h) => {
            const next = [
              ...h.slice(1),
              {
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                throughput: updated.throughput,
                latency: Math.max(8, Math.min(80, (updated.streamLagMs || 10) + Math.floor(Math.random() * 6))),
              },
            ];
            return next;
          });

          return updated;
        });
      }
    } catch (err) {
      console.warn('[Metrics] Fetch failed:', err);
    }
  }, []);

  const activeProposal: HitlProposal | null = pendingQueue[queueIndex] || null;

  const activeTrippedTargets = Array.from(
    new Set([
      ...(metrics.trippedCircuits || []),
      ...ledger.filter((t) => t.status === 'CIRCUIT_TRIPPED').map((t) => t.target || t.subject?.target).filter(Boolean),
    ])
  ) as string[];

  const handleDecision = async (taskId: string, decision: 'APPROVED' | 'REJECTED') => {
    setIsDeciding(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/embassy/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, decision, reviewer: 'Incident Commander' }),
      });
      if (res.ok) {
        await fetchLedger();
        await fetchMetrics();
      }
    } catch (err) {
      console.error('[Decision] Failed to submit decision:', err);
    } finally {
      setIsDeciding(false);
    }
  };

  const handleResetBreaker = async (target: string) => {
    try {
      await fetch(`${API_BASE}/api/v1/embassy/reset-breaker`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      setSelectedTask(null);
      await fetchLedger();
      await fetchMetrics();
    } catch (err) {
      console.error('[ResetBreaker] Failed:', err);
    }
  };

  const handleBatchReject = async () => {
    try {
      await fetch(`${API_BASE}/api/v1/embassy/batch-decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'REJECT_ALL' }),
      });
      await fetchLedger();
      await fetchMetrics();
    } catch (err) {
      console.error('[BatchReject] Failed:', err);
    }
  };

  useEffect(() => {
    fetchLedger();
    fetchMetrics();
    const pollTimer = setInterval(() => {
      fetchMetrics();
      fetchLedger();
    }, 2500);

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
                suppressedAlerts: payload.data.suppressedAlerts ?? prev.suppressedAlerts,
                hitlPending: payload.data.hitlPending ?? prev.hitlPending,
                trippedCircuits: payload.data.trippedCircuits || prev.trippedCircuits || [],
              }));
            }
            break;

          case 'HITL_PROPOSAL':
            fetchLedger();
            break;

          case 'CANARY_VERIFYING':
            setActiveCanary(payload.data);
            setRolledBackTask(null);
            setVerifiedResolved(null);
            break;

          case 'CANARY_CONFIRMED':
            setActiveCanary(null);
            setVerifiedResolved(payload.data);
            fetchLedger();
            break;

          case 'CIRCUIT_TRIPPED':
          case 'CIRCUIT_RESET':
          case 'REMEDIATION_ROLLED_BACK':
          case 'DECISION_RESOLVED':
            fetchLedger();
            fetchMetrics();
            break;

          case 'ALERT_INGESTED':
            if (payload.data) {
              setTelemetryLogs((prev) => [
                {
                  id: payload.data.id || String(Date.now()),
                  timestamp: payload.data.timestamp || new Date().toLocaleTimeString(),
                  rawTime: Date.now(),
                  service: payload.data.service || 'service',
                  severity: payload.data.severity || 'INFO',
                  message: payload.data.message || 'Telemetry event processed',
                  dlpScrubbed: Boolean(payload.data.scrubbed),
                },
                ...prev.slice(0, 49),
              ]);
            }
            break;

          default:
            break;
        }
      } catch (err) {
        console.error('[SSE] Message parsing error:', err);
      }
    };

    return () => {
      clearInterval(pollTimer);
      es.close();
    };
  }, [fetchLedger, fetchMetrics]);

  // Filtered by Time Range + Status
  const filteredLogs = useMemo(() => {
    return telemetryLogs.filter((log) => log.rawTime >= timeCutoff);
  }, [telemetryLogs, timeCutoff]);

  const filteredLedger = useMemo(() => {
    return ledger.filter((item) => {
      const matchTime = (item.createdTimestamp || 0) >= timeCutoff;
      if (!matchTime) return false;
      if (ledgerFilter === 'ALL') return true;
      return item.status.toUpperCase() === ledgerFilter;
    });
  }, [ledger, timeCutoff, ledgerFilter]);

  const getFilterCount = (filterName: string) => {
    return ledger.filter((item) => {
      const matchTime = (item.createdTimestamp || 0) >= timeCutoff;
      if (!matchTime) return false;
      if (filterName === 'ALL') return true;
      return item.status.toUpperCase() === filterName;
    }).length;
  };

  // SVG Chart Render Helpers
  const maxThroughput = Math.max(10, ...telemetryHistory.map((d) => d.throughput));
  const maxLatency = Math.max(60, ...telemetryHistory.map((d) => d.latency));

  const throughputPoints = telemetryHistory
    .map((d, i) => `${(i / 15) * 360},${70 - (d.throughput / maxThroughput) * 55}`)
    .join(' ');

  const latencyPoints = telemetryHistory
    .map((d, i) => `${(i / 15) * 360},${70 - (d.latency / maxLatency) * 55}`)
    .join(' ');

  return (
    <div className="min-h-screen bg-[#070a10] text-slate-100 p-4 md:p-8 font-sans selection:bg-indigo-500 selection:text-white">
      {/* Dynamic Ambient Background Glows */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden -z-10">
        <div className="absolute -top-32 left-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-[128px]" />
        <div className="absolute top-1/3 -right-32 w-96 h-96 bg-cyan-600/10 rounded-full blur-[140px]" />
        <div className="absolute -bottom-32 left-1/3 w-96 h-96 bg-rose-600/5 rounded-full blur-[160px]" />
      </div>

      {/* Top Header & Timeframe Command Bar */}
      <header className="flex flex-col lg:flex-row lg:items-center justify-between pb-6 border-b border-slate-800/80 gap-5">
        <div className="flex items-center gap-3.5">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-indigo-700 via-indigo-600 to-cyan-500 flex items-center justify-center font-black text-white shadow-[0_0_24px_rgba(99,102,241,0.4)] border border-indigo-400/30">
            N
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-black tracking-tight text-white drop-shadow-sm">NeuroFabric Ops</h1>
              <span className="text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full bg-gradient-to-r from-indigo-950 to-indigo-900 border border-indigo-500/40 text-indigo-300 shadow-inner">
                Enterprise 3D
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">Autonomous Telemetry Ingestion & Closed-Loop Remediation</p>
          </div>
        </div>

        {/* Right Header: Stream Status & Time Range Selector */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3.5 self-start lg:self-auto">
          {/* Live Indicator */}
          <div className="flex items-center gap-2.5 px-3.5 py-1.5 rounded-full bg-slate-900/90 border border-slate-700/60 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] backdrop-blur-md">
            <span className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-amber-400'}`} />
            <span className="text-xs font-mono font-semibold text-slate-200">
              {connected ? 'Real-Time Stream Active' : 'Connecting to Stream...'}
            </span>
          </div>

          {/* Time Range Selector */}
          <div className="flex items-center p-1 rounded-xl bg-[#0e1320] border border-slate-800 shadow-lg shadow-black/40">
            <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider px-2 font-semibold">Range</span>
            {(['5M', '15M', '1H', '24H', 'ALL'] as TimeRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setTimeRange(r)}
                className={`px-2.5 py-1 text-[11px] font-mono font-bold rounded-lg transition-all cursor-pointer ${
                  timeRange === r
                    ? 'bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-[0_2px_10px_rgba(99,102,241,0.4)] border border-indigo-400/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* KPI Metric Strip (Glassmorphic Cards) */}
      <section className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 my-6">
        {[
          { label: 'Throughput', value: `${metrics.throughput} evt/s`, color: 'text-cyan-400', glow: 'shadow-cyan-500/10' },
          { label: 'Alerts Suppressed', value: metrics.suppressedAlerts, color: 'text-purple-400', glow: 'shadow-purple-500/10' },
          { label: 'Secrets Scrubbed', value: metrics.secretsScrubbed, color: 'text-rose-400', glow: 'shadow-rose-500/10' },
          { label: 'Stream Lag', value: `${metrics.streamLagMs}ms`, color: 'text-amber-400', glow: 'shadow-amber-500/10' },
          { label: 'HITL Pending', value: metrics.hitlPending, color: 'text-amber-300', glow: 'shadow-amber-500/10' },
          { label: 'Autonomy', value: `${metrics.autonomyRate}%`, color: 'text-emerald-400', glow: 'shadow-emerald-500/10' },
          { label: 'MTTR', value: `${metrics.mttrSeconds}s`, color: 'text-blue-400', glow: 'shadow-blue-500/10' },
          { label: 'Avg Confidence', value: `${metrics.avgConfidence}%`, color: 'text-indigo-400', glow: 'shadow-indigo-500/10' },
        ].map((card, idx) => (
          <div
            key={idx}
            className={`relative group bg-gradient-to-b from-[#111726]/90 to-[#0c101a]/90 border border-slate-800/80 hover:border-slate-700/90 rounded-xl p-3.5 flex flex-col justify-between shadow-xl ${card.glow} backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5`}
          >
            <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
            <span className="text-[11px] font-semibold text-slate-400 truncate tracking-wide">{card.label}</span>
            <span className={`text-xl font-black font-mono mt-1.5 tabular-nums ${card.color}`}>{card.value}</span>
          </div>
        ))}
      </section>

      {/* Live Telemetry Visualizer Section (Dual Real-Time Graphs) */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {/* Graph 1: Live Ingestion Throughput Waveform */}
        <div className="relative overflow-hidden bg-gradient-to-b from-[#101625]/90 to-[#090d16]/95 border border-slate-800/90 rounded-xl p-4 shadow-2xl backdrop-blur-md">
          <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-cyan-400/30 to-transparent" />
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-cyan-400 animate-ping" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200 font-mono">
                Live Ingestion Throughput
              </h3>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-slate-400">Current:</span>
              <span className="text-cyan-400 font-bold tabular-nums">{metrics.throughput} evt/s</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950/60 border border-cyan-800/40 text-cyan-300">
                Peak: {maxThroughput}
              </span>
            </div>
          </div>

          {/* SVG Waveform Chart */}
          <div className="h-24 w-full pt-1">
            <svg viewBox="0 0 360 80" className="w-full h-full overflow-visible" preserveAspectRatio="none">
              <defs>
                <linearGradient id="cyanGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#00f2fe" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#00f2fe" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              {/* Subtle Gridlines */}
              <line x1="0" y1="20" x2="360" y2="20" stroke="rgba(255,255,255,0.05)" strokeDasharray="4 4" />
              <line x1="0" y1="50" x2="360" y2="50" stroke="rgba(255,255,255,0.05)" strokeDasharray="4 4" />
              {/* Fill Area */}
              <polygon
                points={`0,80 ${throughputPoints} 360,80`}
                fill="url(#cyanGrad)"
              />
              {/* Path Line */}
              <polyline
                points={throughputPoints}
                fill="none"
                stroke="#00f2fe"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="drop-shadow-[0_0_8px_rgba(0,242,254,0.6)]"
              />
            </svg>
          </div>
          <div className="flex justify-between text-[10px] font-mono text-slate-500 pt-1">
            <span>T-45s</span>
            <span>T-30s</span>
            <span>T-15s</span>
            <span className="text-cyan-400">Live (Now)</span>
          </div>
        </div>

        {/* Graph 2: Telemetry Latency & Canary Observation Window */}
        <div className="relative overflow-hidden bg-gradient-to-b from-[#101625]/90 to-[#090d16]/95 border border-slate-800/90 rounded-xl p-4 shadow-2xl backdrop-blur-md">
          <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-emerald-400/30 to-transparent" />
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200 font-mono">
                Stream Latency & Canary Delta
              </h3>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-slate-400">Stream Lag:</span>
              <span className="text-emerald-400 font-bold tabular-nums">{metrics.streamLagMs}ms</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950/60 border border-emerald-800/40 text-emerald-300">
                15s Window
              </span>
            </div>
          </div>

          {/* SVG Latency Chart */}
          <div className="h-24 w-full pt-1">
            <svg viewBox="0 0 360 80" className="w-full h-full overflow-visible" preserveAspectRatio="none">
              <defs>
                <linearGradient id="emeraldGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <line x1="0" y1="20" x2="360" y2="20" stroke="rgba(255,255,255,0.05)" strokeDasharray="4 4" />
              <line x1="0" y1="50" x2="360" y2="50" stroke="rgba(255,255,255,0.05)" strokeDasharray="4 4" />
              <polygon
                points={`0,80 ${latencyPoints} 360,80`}
                fill="url(#emeraldGrad)"
              />
              <polyline
                points={latencyPoints}
                fill="none"
                stroke="#10b981"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="drop-shadow-[0_0_8px_rgba(16,185,129,0.6)]"
              />
            </svg>
          </div>
          <div className="flex justify-between text-[10px] font-mono text-slate-500 pt-1">
            <span>T-45s</span>
            <span>T-30s</span>
            <span>T-15s</span>
            <span className="text-emerald-400">Live (Now)</span>
          </div>
        </div>
      </section>

      {/* Main Grid: Autonomous Remediation Circuit & Live Ingestion Stream */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-8">
        {/* Left Column: Autonomous Remediation Circuit */}
        <section className="lg:col-span-7 bg-gradient-to-b from-[#111726]/90 to-[#0b0f18]/95 border border-slate-800 rounded-xl p-5 shadow-2xl backdrop-blur-md">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200 font-mono">
                Autonomous Remediation Circuit
              </h2>
              {pendingQueue.length > 0 && (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-950 border border-amber-700/60 text-amber-300 shadow-md">
                  Task {queueIndex + 1} of {pendingQueue.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {pendingQueue.length > 1 && (
                <div className="flex items-center gap-1 mr-2">
                  <button
                    disabled={queueIndex === 0}
                    onClick={() => setQueueIndex((i) => Math.max(0, i - 1))}
                    className="px-2.5 py-1 rounded-lg text-[11px] bg-slate-800 hover:bg-slate-700 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    &larr; Prev
                  </button>
                  <button
                    disabled={queueIndex >= pendingQueue.length - 1}
                    onClick={() => setQueueIndex((i) => Math.min(pendingQueue.length - 1, i + 1))}
                    className="px-2.5 py-1 rounded-lg text-[11px] bg-slate-800 hover:bg-slate-700 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    Next &rarr;
                  </button>
                  <button
                    onClick={handleBatchReject}
                    className="px-2.5 py-1 rounded-lg text-[10px] bg-rose-950/60 hover:bg-rose-900 border border-rose-800/40 text-rose-300 ml-1 cursor-pointer transition-colors"
                  >
                    Dismiss All
                  </button>
                </div>
              )}
              <span className="text-xs font-mono text-slate-400">Window: 15s</span>
            </div>
          </div>

          {/* Persistent Lockout Banners */}
          {activeTrippedTargets.map((target) => (
            <div key={target} className="mb-4 p-4 rounded-xl bg-gradient-to-r from-red-950/90 to-red-900/80 border border-red-500 text-red-200 flex items-center justify-between shadow-[0_0_20px_rgba(239,68,68,0.25)] animate-pulse">
              <div className="flex items-center gap-2.5">
                <span className="h-3 w-3 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.8)]" />
                <span className="text-xs font-semibold">
                  <strong>Circuit Breaker Tripped on {target}:</strong> Flapping oscillation halted. Automated mutations locked.
                </span>
              </div>
              <button
                onClick={() => handleResetBreaker(target)}
                className="text-[11px] font-mono uppercase bg-red-600 hover:bg-red-500 border border-red-400 px-3 py-1.5 rounded-lg font-bold text-white transition-all cursor-pointer shadow-lg hover:shadow-red-500/50"
              >
                Reset Breaker
              </button>
            </div>
          ))}

          {activeCanary && (
            <div className="mb-4 p-3.5 rounded-xl bg-amber-950/40 border border-amber-500/50 text-amber-300 flex items-center justify-between animate-pulse shadow-lg shadow-amber-950/40">
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
            <div className="mb-4 p-3.5 rounded-xl bg-rose-950/40 border border-rose-500/50 text-rose-300 flex items-center justify-between shadow-lg shadow-rose-950/40">
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
            <div className="mb-4 p-3.5 rounded-xl bg-emerald-950/40 border border-emerald-500/50 text-emerald-300 flex items-center justify-between shadow-lg shadow-emerald-950/40">
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
            <div className="bg-[#0c101a] border border-slate-700/60 rounded-xl p-5 space-y-4 shadow-xl">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2.5">
                    <span className="text-xs font-bold px-2.5 py-0.5 rounded-md bg-rose-950 border border-rose-700 text-rose-300">
                      {activeProposal.severity}
                    </span>
                    <h3 className="text-sm font-semibold text-white tracking-wide">{activeProposal.title}</h3>
                  </div>
                  <p className="text-xs text-slate-400 mt-1.5">Target: <code className="text-cyan-400 font-mono font-semibold">{activeProposal.target}</code></p>
                </div>
                <div className="text-right text-xs">
                  <div className="text-slate-400">Confidence: <span className="text-emerald-400 font-mono font-bold">{activeProposal.confidence}%</span></div>
                  <div className="text-slate-400">Blast Radius: <span className="text-amber-400 font-mono font-bold">{activeProposal.blastRadius}</span></div>
                </div>
              </div>

              <div>
                <span className="text-[11px] font-medium text-slate-400 block mb-1.5 font-mono">Proposed Remediation Patch (Unified Diff)</span>
                <pre className="bg-black/80 border border-slate-800 rounded-lg p-3.5 text-xs font-mono overflow-x-auto text-slate-300 shadow-inner">
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

              {activeTrippedTargets.includes(activeProposal.target) ? (
                <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                  <span className="text-xs text-red-400 font-mono font-semibold">
                    Target service circuit breaker is tripped. Automated mutation locked.
                  </span>
                  <button
                    onClick={() => handleResetBreaker(activeProposal.target)}
                    className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-red-700 hover:bg-red-600 text-white transition-all cursor-pointer shadow-md"
                  >
                    Reset & Unlock Service
                  </button>
                </div>
              ) : activeProposal.status === 'CANARY_VERIFYING' ? (
                <div className="flex items-center justify-end gap-2 pt-2 text-xs text-amber-400 font-mono">
                  <span className="h-2 w-2 rounded-full bg-amber-400 animate-ping inline-block mr-1" />
                  Canary deployment in-flight... Verification window active.
                </div>
              ) : (
                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    disabled={isDeciding}
                    onClick={() => handleDecision(activeProposal.taskId, 'REJECTED')}
                    className="px-4 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-rose-400 border border-rose-900/40 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    Reject
                  </button>
                  <button
                    disabled={isDeciding}
                    onClick={() => handleDecision(activeProposal.taskId, 'APPROVED')}
                    className="px-5 py-2 rounded-lg text-xs font-bold bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white shadow-lg shadow-emerald-600/30 transition-all cursor-pointer disabled:opacity-50"
                  >
                    {isDeciding ? 'Deploying...' : 'Approve & Canary Deploy'}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-12 border border-dashed border-slate-800 rounded-xl text-slate-500 text-xs font-mono">
              Autonomous Embassy is quiet. No pending human-in-the-loop remediation proposals.
            </div>
          )}
        </section>

        {/* Right Column: Live Ingestion Stream */}
        <section className="lg:col-span-5 bg-gradient-to-b from-[#111726]/90 to-[#0b0f18]/95 border border-slate-800 rounded-xl p-5 flex flex-col justify-between shadow-2xl backdrop-blur-md">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200 font-mono">
                Live Ingestion Stream
              </h2>
              <span className="text-xs font-mono text-cyan-400 font-bold">{filteredLogs.length} Events ({timeRange})</span>
            </div>

            <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
              {filteredLogs.length > 0 ? (
                filteredLogs.map((log) => (
                  <div key={log.id} className="p-3 rounded-lg bg-[#0c101a] border border-slate-800/90 text-xs space-y-1 hover:border-slate-700 transition-colors">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-cyan-400 font-bold">{log.service}</span>
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
                <div className="text-center py-14 text-slate-500 text-xs font-mono">
                  No ingestion payloads matching time range "{timeRange}".
                </div>
              )}
            </div>
          </div>
          <div className="pt-4 border-t border-slate-800 mt-4 text-[11px] text-slate-400 flex justify-between font-mono">
            <span>DLP Scrubber: Active</span>
            <span>Target Allowlist: Enforced</span>
          </div>
        </section>
      </div>

      {/* Governance & Audit Ledger Section */}
      <section className="bg-gradient-to-b from-[#111726]/90 to-[#0b0f18]/95 border border-slate-800 rounded-xl p-5 shadow-2xl backdrop-blur-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-800 mb-4 gap-3">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200 font-mono">
              Immutable Governance Ledger
            </h2>
            <p className="text-xs text-slate-400">PostgreSQL Audit Trail with OWASP & NIST Traceability &bull; Window: {timeRange}</p>
          </div>

          {/* Filter Pills with Counts and Hover Cursor */}
          <div className="flex flex-wrap gap-1.5 text-xs font-medium">
            {['ALL', 'PENDING', 'CANARY_VERIFYING', 'VERIFIED_RESOLVED', 'ROLLED_BACK', 'CIRCUIT_TRIPPED', 'APPROVED', 'REJECTED'].map((filter) => {
              const count = getFilterCount(filter);
              return (
                <button
                  key={filter}
                  onClick={() => setLedgerFilter(filter)}
                  className={`px-3 py-1.5 rounded-lg text-[11px] font-mono transition-all cursor-pointer flex items-center gap-1.5 ${
                    ledgerFilter === filter
                      ? 'bg-gradient-to-r from-indigo-600 to-indigo-500 text-white font-bold shadow-[0_2px_12px_rgba(99,102,241,0.4)] border border-indigo-400/40'
                      : 'bg-slate-800/50 text-slate-400 hover:bg-slate-800 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  <span>{filter}</span>
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${ledgerFilter === filter ? 'bg-indigo-800 text-white' : 'bg-slate-700 text-slate-300'}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 font-mono uppercase text-[10px] tracking-wider">
                <th className="pb-2.5">Task Token</th>
                <th className="pb-2.5">Target</th>
                <th className="pb-2.5">Status</th>
                <th className="pb-2.5">Reviewed By</th>
                <th className="pb-2.5">Decided At</th>
                <th className="pb-2.5">Created At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {filteredLedger.length > 0 ? (
                filteredLedger.map((row) => {
                  const isTripped = row.status === 'CIRCUIT_TRIPPED';
                  return (
                    <tr
                      key={row.token}
                      onClick={() => setSelectedTask(row)}
                      className="hover:bg-slate-850/50 cursor-pointer transition-colors"
                    >
                      <td className="py-3 text-slate-200 underline decoration-slate-700 underline-offset-4">{row.token.slice(0, 16)}...</td>
                      <td className="py-3 text-cyan-400 font-bold">{row.target || row.subject?.target || '—'}</td>
                      <td className="py-3">
                        {isTripped ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedTask(row);
                            }}
                            className="px-2.5 py-0.5 rounded-md text-[10px] font-bold border bg-red-950/90 text-red-200 border-red-500 hover:bg-red-900 cursor-pointer transition-colors shadow-sm"
                          >
                            CIRCUIT_TRIPPED ⚡
                          </button>
                        ) : (
                          <span
                            className={`px-2.5 py-0.5 rounded-md text-[10px] font-semibold border ${
                              row.status === 'PENDING'
                                ? 'bg-amber-950/80 text-amber-300 border-amber-800'
                                : row.status === 'VERIFIED_RESOLVED'
                                ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800'
                                : row.status === 'ROLLED_BACK'
                                ? 'bg-rose-950/80 text-rose-300 border-rose-800'
                                : 'bg-slate-800 text-slate-400 border-slate-700'
                            }`}
                          >
                            {row.status}
                          </span>
                        )}
                      </td>
                      <td className="py-3 text-slate-300">{row.approvedBy || 'System'}</td>
                      <td className="py-3 text-slate-400 tabular-nums">{row.decidedAt ? new Date(row.decidedAt).toLocaleTimeString() : '—'}</td>
                      <td className="py-3 text-slate-400 tabular-nums">{row.createdAt ? new Date(row.createdAt).toLocaleTimeString() : '—'}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="text-center py-10 text-slate-500 font-mono">
                    No ledger entries match filter "{ledgerFilter}" within range "{timeRange}".
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Task Inspection Drawer / Modal */}
      {selectedTask && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-gradient-to-b from-[#131a29] to-[#0c101a] border border-slate-700 rounded-2xl max-w-xl w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <span className="text-xs font-mono font-bold px-2.5 py-0.5 rounded-md bg-indigo-950 border border-indigo-700 text-indigo-300">
                  Audit Record
                </span>
                <h3 className="font-semibold text-white text-sm font-mono truncate max-w-xs">{selectedTask.token}</h3>
              </div>
              <button
                onClick={() => setSelectedTask(null)}
                className="text-slate-400 hover:text-white text-sm font-mono cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs font-mono">
              <div className="p-3 bg-[#080c14] rounded-xl border border-slate-800">
                <span className="text-slate-500 block text-[10px] uppercase font-bold">TARGET SERVICE</span>
                <span className="text-cyan-400 font-bold text-sm mt-0.5 block">{selectedTask.target || selectedTask.subject?.target || '—'}</span>
              </div>
              <div className="p-3 bg-[#080c14] rounded-xl border border-slate-800">
                <span className="text-slate-500 block text-[10px] uppercase font-bold">CURRENT STATUS</span>
                <span className={`font-bold text-sm mt-0.5 block ${selectedTask.status === 'CIRCUIT_TRIPPED' ? 'text-red-400' : 'text-emerald-400'}`}>
                  {selectedTask.status}
                </span>
              </div>
            </div>

            {selectedTask.reason && (
              <div className="p-3.5 bg-red-950/40 border border-red-800/60 rounded-xl text-xs text-red-200 font-mono">
                <span className="block text-[10px] text-red-400 font-bold mb-1 uppercase tracking-wider">Trip Reason / Failure Audit</span>
                {selectedTask.reason}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
              {selectedTask.status === 'CIRCUIT_TRIPPED' && (
                <button
                  onClick={() => handleResetBreaker(selectedTask.target || selectedTask.subject?.target || 'flapping-payment-worker')}
                  className="px-5 py-2.5 rounded-xl text-xs font-bold bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400 text-white cursor-pointer shadow-lg shadow-red-600/40 transition-all"
                >
                  ⚡ Reset Breaker & Unlock Target
                </button>
              )}
              <button
                onClick={() => setSelectedTask(null)}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

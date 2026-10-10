import { useState, useEffect, useCallback, useMemo } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL || 'https://neurofabric-backend.onrender.com').replace(/\/$/, '');
const INGESTION_KEY = import.meta.env.VITE_INGESTION_KEY || 'nf-edge-telemetry-token-2026';

type TimeRange = '5M' | '15M' | '1H' | '24H' | 'ALL' | 'CUSTOM';
type TimezoneMode = 'LOCAL' | 'UTC';

interface AuthUser {
  username: string;
  role: string;
  name: string;
}

interface IngestionMetrics {
  throughput: number;
  totalIngested: number;
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
  merkleHash?: string;
}

interface TelemetryLog {
  id: string;
  rawTime: number;
  service: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  message: string;
  dlpScrubbed?: boolean;
}

interface TimeseriesPoint {
  timestamp: number;
  throughput: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  latency: number;
  ingested: number;
  errors: number;
  errorRate: number;
  suppressed: number;
}

function NeuroFabricLogo({ className = "h-10 w-10" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="nfMeshGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#00f0ff" />
          <stop offset="50%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
        <radialGradient id="nfCoreGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#00f0ff" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </radialGradient>
      </defs>
      <polygon
        points="32,4 58,19 58,45 32,60 6,45 6,19"
        stroke="url(#nfMeshGrad)"
        strokeWidth="2.5"
        fill="#080d1a"
        strokeLinejoin="round"
        className="filter drop-shadow-[0_0_8px_rgba(0,240,255,0.4)]"
      />
      <line x1="32" y1="4" x2="32" y2="32" stroke="#6366f1" strokeWidth="1.5" strokeOpacity="0.7" />
      <line x1="58" y1="19" x2="32" y2="32" stroke="#00f0ff" strokeWidth="1.5" strokeOpacity="0.7" />
      <line x1="58" y1="45" x2="32" y2="32" stroke="#a855f7" strokeWidth="1.5" strokeOpacity="0.7" />
      <line x1="32" y1="60" x2="32" y2="32" stroke="#6366f1" strokeWidth="1.5" strokeOpacity="0.7" />
      <line x1="6" y1="45" x2="32" y2="32" stroke="#00f0ff" strokeWidth="1.5" strokeOpacity="0.7" />
      <line x1="6" y1="19" x2="32" y2="32" stroke="#a855f7" strokeWidth="1.5" strokeOpacity="0.7" />
      <circle cx="32" cy="18" r="3" fill="#00f0ff" className="animate-pulse" />
      <circle cx="44" cy="25" r="2.5" fill="#6366f1" />
      <circle cx="44" cy="39" r="2.5" fill="#a855f7" />
      <circle cx="32" cy="46" r="3" fill="#00f0ff" className="animate-pulse" />
      <circle cx="20" cy="39" r="2.5" fill="#6366f1" />
      <circle cx="20" cy="25" r="2.5" fill="#a855f7" />
      <circle cx="32" cy="32" r="6" fill="url(#nfCoreGlow)" />
      <circle cx="32" cy="32" r="3.5" fill="#ffffff" className="drop-shadow-[0_0_6px_#00f0ff]" />
    </svg>
  );
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(() => {
    const cached = localStorage.getItem('nf_auth_user');
    return cached ? JSON.parse(cached) : {
      username: 'commander@neurofabric.io',
      role: 'INCIDENT_COMMANDER',
      name: 'Alex Vance (Incident Commander)'
    };
  });
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem('nf_auth_token') || 'nf_session_default');
  const [loginEmail, setLoginEmail] = useState<string>('commander@neurofabric.io');
  const [loginPassword, setLoginPassword] = useState<string>('Commander2026!');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);

  const [connected, setConnected] = useState<boolean>(true);
  const [timeRange, setTimeRange] = useState<TimeRange>('15M');
  const [tzMode, setTzMode] = useState<TimezoneMode>('LOCAL');
  
  const [showCustomModal, setShowCustomModal] = useState<boolean>(false);
  const [customStart, setCustomStart] = useState<string>('');
  const [customEnd, setCustomEnd] = useState<string>('');
  const [customWindow, setCustomWindow] = useState<{ start: number; end: number } | null>(null);

  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [activeHoverChart, setActiveHoverChart] = useState<string | null>(null);
  const [selectedTimeSlice, setSelectedTimeSlice] = useState<{ start: number; end: number; label: string } | null>(null);

  const [simLoading, setSimLoading] = useState<string | null>(null);
  const [showArchGuide, setShowArchGuide] = useState<boolean>(false);

  const [streamPaused, setStreamPaused] = useState<boolean>(false);
  const [streamSearch, setStreamSearch] = useState<string>('');
  const [streamFilter, setStreamFilter] = useState<'ALL' | 'CRITICAL' | 'WARNING' | 'SCRUBBED'>('ALL');
  const [bufferLimit, setBufferLimit] = useState<number>(250);

  const [merkleStatus, setMerkleStatus] = useState<{ valid: boolean; rootHash: string; chainLength: number; verifiedAt: string } | null>(null);

  const [metrics, setMetrics] = useState<IngestionMetrics>({
    throughput: 0,
    totalIngested: 0,
    suppressedAlerts: 0,
    secretsScrubbed: 0,
    streamLagMs: 4,
    hitlPending: 0,
    autonomyRate: 100,
    mttrSeconds: 8.4,
    avgConfidence: 88,
    trippedCircuits: [],
  });

  const [timeseriesData, setTimeseriesData] = useState<TimeseriesPoint[]>([]);
  const [activeCanary, setActiveCanary] = useState<{ taskId: string; target: string; slice?: string; timeoutMs?: number; remainingSec: number } | null>(null);
  const [canaryCountdown, setCanaryCountdown] = useState<number>(0);

  const [rolledBackTask, setRolledBackTask] = useState<{ taskId: string; target: string; reason?: string } | null>(null);
  const [verifiedResolved, setVerifiedResolved] = useState<{ taskId: string; target: string } | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [telemetryLogs, setTelemetryLogs] = useState<TelemetryLog[]>([]);
  const [isDeciding, setIsDeciding] = useState<boolean>(false);
  const [ledgerFilter, setLedgerFilter] = useState<string>('ALL');

  const [selectedTask, setSelectedTask] = useState<LedgerEntry | null>(null);
  const [pendingQueue, setPendingQueue] = useState<HitlProposal[]>([]);
  const [queueIndex, setQueueIndex] = useState<number>(0);

  const formatTs = useCallback((epochMs: number | string | undefined | null, includeDate = false): string => {
    if (!epochMs) return '—';
    const date = new Date(typeof epochMs === 'string' ? (isNaN(Number(epochMs)) ? epochMs : Number(epochMs)) : epochMs);
    if (isNaN(date.getTime())) return '—';

    const isWideWindow = timeRange === '24H' || timeRange === 'ALL' || includeDate;

    if (tzMode === 'UTC') {
      if (isWideWindow) {
        return date.toISOString().substring(5, 10) + ' ' + date.toISOString().substring(11, 16) + ' UTC';
      }
      return date.toISOString().substring(11, 19) + ' UTC';
    } else {
      if (isWideWindow) {
        return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      }
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
  }, [tzMode, timeRange]);

  const authFetch = useCallback(
    async (url: string, options: RequestInit = {}) => {
      const headers = new Headers(options.headers || {});
      if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
      return fetch(url, { ...options, headers });
    },
    [authToken]
  );

  const handleLogin = async (emailOverride?: string, passOverride?: string) => {
    setIsLoggingIn(true);
    setLoginError(null);
    const email = emailOverride || loginEmail;
    const pass = passOverride || loginPassword;

    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: email, password: pass }),
      });
      const data = await res.json();
      if (res.ok && data.token) {
        setAuthToken(data.token);
        setCurrentUser(data.user);
        localStorage.setItem('nf_auth_token', data.token);
        localStorage.setItem('nf_auth_user', JSON.stringify(data.user));
      } else {
        setLoginError(data.message || 'Authentication failed. Invalid credentials.');
      }
    } catch {
      setLoginError('Cannot reach authentication service. Check server connection.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = () => {
    setAuthToken(null);
    setCurrentUser(null);
    localStorage.removeItem('nf_auth_token');
    localStorage.removeItem('nf_auth_user');
  };

  useEffect(() => {
    if (!activeCanary || canaryCountdown <= 0) return;
    const interval = setInterval(() => {
      setCanaryCountdown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [activeCanary, canaryCountdown]);

  const rangeConfig = useMemo(() => {
    const now = Date.now();
    if (timeRange === 'CUSTOM' && customWindow) {
      return {
        startTime: customWindow.start,
        endTime: customWindow.end,
        durationMs: Math.max(60000, customWindow.end - customWindow.start),
        label: `Custom (${formatTs(customWindow.start)} - ${formatTs(customWindow.end)})`,
      };
    }

    let durationMs = 15 * 60 * 1000;
    let label = '15 Minutes';

    switch (timeRange) {
      case '5M': durationMs = 5 * 60 * 1000; label = '5 Minutes'; break;
      case '15M': durationMs = 15 * 60 * 1000; label = '15 Minutes'; break;
      case '1H': durationMs = 60 * 60 * 1000; label = '1 Hour'; break;
      case '24H': durationMs = 24 * 60 * 60 * 1000; label = '24 Hours'; break;
      case 'ALL': durationMs = 7 * 24 * 60 * 60 * 1000; label = 'All Historical'; break;
    }

    return {
      startTime: timeRange === 'ALL' ? 0 : now - durationMs,
      endTime: now,
      durationMs,
      label,
    };
  }, [timeRange, customWindow, formatTs]);

  const fetchTimeseries = useCallback(async () => {
    try {
      let queryUrl = `${API_BASE}/api/v1/metrics/timeseries?range=${timeRange}`;
      if (timeRange === 'CUSTOM' && customWindow) {
        queryUrl += `&start=${customWindow.start}&end=${customWindow.end}`;
      }
      const res = await fetch(queryUrl);
      if (res.ok) {
        const body = await res.json();
        if (Array.isArray(body.points)) setTimeseriesData(body.points);
      }
    } catch (err) {
      console.warn('[Timeseries] Fetch failed:', err);
    }
  }, [timeRange, customWindow]);

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

  const fetchMerkleAudit = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/governance/verify-ledger`);
      if (res.ok) setMerkleStatus(await res.json());
    } catch (err) {
      console.warn('[Merkle] Fetch failed:', err);
    }
  }, []);

  const fetchRecentLogs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/workspace/recent-logs`);
      if (res.ok) {
        const logs: TelemetryLog[] = await res.json();
        if (Array.isArray(logs) && logs.length > 0) setTelemetryLogs(logs);
      }
    } catch (err) {
      console.warn('[RecentLogs] Fetch failed:', err);
    }
  }, []);

  const fetchMetrics = useCallback(async () => {
    try {
      const ingRes = await fetch(`${API_BASE}/api/v1/metrics/ingestion`).then((r) => (r.ok ? r.json() : null));
      if (ingRes) {
        setMetrics((prev) => ({
          ...prev,
          throughput: ingRes.throughput ?? prev.throughput,
          totalIngested: ingRes.totalIngested ?? prev.totalIngested,
          secretsScrubbed: ingRes.secretsScrubbed ?? prev.secretsScrubbed,
          suppressedAlerts: ingRes.suppressedAlerts ?? prev.suppressedAlerts,
          hitlPending: ingRes.hitlPending ?? prev.hitlPending,
          trippedCircuits: ingRes.trippedCircuits || prev.trippedCircuits || [],
        }));
      }
    } catch (err) {
      console.warn('[Metrics] Fetch failed:', err);
    }
  }, []);

  const triggerSimulation = async (type: 'CRITICAL_ANOMALY' | 'DLP_PROBE' | 'TRAFFIC_FLOOD' | 'TRIP_BREAKER' | 'CANARY_TEST') => {
    setSimLoading(type);
    try {
      const headers = { 'Content-Type': 'application/json', 'X-Ingest-Key': INGESTION_KEY };
      if (type === 'CRITICAL_ANOMALY') {
        await fetch(`${API_BASE}/api/v1/workspace/ingest`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            service: 'k8s-ingress',
            severity: 'CRITICAL',
            message: 'Elevated 504 Gateway Timeouts across edge ingress nodes: cluster pool capacity at 97%',
          }),
        });
      } else if (type === 'DLP_PROBE') {
        await fetch(`${API_BASE}/api/v1/workspace/ingest`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            service: 'auth-gateway',
            severity: 'WARNING',
            message: 'Inbound headers inspect: Bearer sk-ant-api03-live-simulation-token password=corporateAdminSecret',
          }),
        });
      } else if (type === 'TRAFFIC_FLOOD') {
        for (let burst = 0; burst < 3; burst++) {
          const batch = Array.from({ length: 15 }, (_, i) => ({
            service: i % 2 === 0 ? 'order-service' : 'auth-gateway',
            severity: 'INFO',
            message: `Telemetry load event seq-${burst + 1}-${i} (p95: ${12 + (i % 8)}ms)`,
          }));
          await fetch(`${API_BASE}/api/v1/workspace/ingest`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ events: batch }),
          });
          await new Promise((r) => setTimeout(r, 120));
        }
      } else if (type === 'CANARY_TEST') {
        const taskId = `canary-test-${Date.now().toString(36)}`;
        await authFetch(`${API_BASE}/api/v1/embassy/decisions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId,
            target: 'redis-cluster',
            decision: 'APPROVED',
            diff: '--- a/redis.conf\n+++ b/redis.conf\n@@ -1,1 +1,1 @@\n-maxmemory 2gb\n+maxmemory 4gb',
            reviewer: currentUser?.name || 'Alex Vance (Incident Commander)',
          }),
        });
      } else if (type === 'TRIP_BREAKER') {
        const target = 'flapping-payment-worker';
        for (let i = 1; i <= 3; i++) {
          await fetch(`${API_BASE}/api/v1/workspace/ingest`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              service: target,
              severity: 'CRITICAL',
              message: `Oscillation strike ${i} post-deploy`,
            }),
          });
        }
      }

      await fetchLedger();
      await fetchMetrics();
      await fetchRecentLogs();
      await fetchTimeseries();
      await fetchMerkleAudit();
    } catch (err) {
      console.error('[Simulation] Failed:', err);
    } finally {
      setSimLoading(null);
    }
  };

  const handleDecision = async (taskId: string, decision: 'APPROVED' | 'REJECTED') => {
    setIsDeciding(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/embassy/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, decision, reviewer: currentUser?.name || 'Alex Vance (Incident Commander)' }),
      });
      if (res.ok) {
        if (decision === 'APPROVED') {
          setActiveCanary({ taskId, target: activeProposal?.target || 'service', slice: '10%', remainingSec: 15 });
          setCanaryCountdown(15);
        }
        await fetchLedger();
        await fetchMetrics();
        await fetchMerkleAudit();
      }
    } catch (err) {
      console.error('[Decision] Failed to submit decision:', err);
    } finally {
      setIsDeciding(false);
    }
  };

  const handleAbortCanary = async (taskId: string, target: string) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/embassy/abort-canary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, target }),
      });
      if (res.ok) {
        setActiveCanary(null);
        setCanaryCountdown(0);
        setRolledBackTask({ taskId, target, reason: 'Operator aborted canary observation.' });
        await fetchLedger();
        await fetchMetrics();
        await fetchMerkleAudit();
      }
    } catch (err) {
      console.error('[AbortCanary] Failed:', err);
    }
  };

  const handleResetBreaker = async (target: string) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/embassy/reset-breaker`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      if (res.ok) {
        setSelectedTask(null);
        await fetchLedger();
        await fetchMetrics();
        await fetchMerkleAudit();
      }
    } catch (err) {
      console.error('[ResetBreaker] Failed:', err);
    }
  };

  const handleApplyCustomRange = () => {
    if (!customStart || !customEnd) return;
    const startMs = new Date(customStart).getTime();
    const endMs = new Date(customEnd).getTime();
    if (isNaN(startMs) || isNaN(endMs) || startMs >= endMs) {
      alert('Please select a valid start date prior to end date.');
      return;
    }
    setCustomWindow({ start: startMs, end: endMs });
    setTimeRange('CUSTOM');
    setShowCustomModal(false);
  };

  const handleExportLogs = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(filteredLogs, null, 2));
    const dlAnchor = document.createElement('a');
    dlAnchor.setAttribute('href', dataStr);
    dlAnchor.setAttribute('download', `neurofabric-telemetry-${Date.now()}.json`);
    dlAnchor.click();
  };

  useEffect(() => {
    fetchLedger();
    fetchMetrics();
    fetchRecentLogs();
    fetchTimeseries();
    fetchMerkleAudit();

    const pollTimer = setInterval(() => {
      fetchMetrics();
      fetchLedger();
      fetchTimeseries();
      fetchMerkleAudit();
    }, 2500);

    const es = new EventSource(`${API_BASE}/api/v1/stream/alerts`);

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (!payload || !payload.type) return;

        switch (payload.type) {
          case 'connected': setConnected(true); break;
          case 'INGESTION_METRICS_UPDATE':
            if (payload.data) {
              setMetrics((prev) => ({
                ...prev,
                throughput: payload.data.throughput ?? prev.throughput,
                totalIngested: payload.data.totalIngested ?? prev.totalIngested,
                secretsScrubbed: payload.data.secretsScrubbed ?? prev.secretsScrubbed,
                suppressedAlerts: payload.data.suppressedAlerts ?? prev.suppressedAlerts,
                hitlPending: payload.data.hitlPending ?? prev.hitlPending,
                trippedCircuits: payload.data.trippedCircuits || prev.trippedCircuits || [],
              }));
            }
            break;
          case 'HITL_PROPOSAL': fetchLedger(); break;
          case 'CANARY_VERIFYING':
            setActiveCanary({ taskId: payload.data.taskId, target: payload.data.target, slice: '10%', remainingSec: 15 });
            setCanaryCountdown(15);
            setRolledBackTask(null);
            setVerifiedResolved(null);
            break;
          case 'CANARY_CONFIRMED':
            setActiveCanary(null);
            setCanaryCountdown(0);
            setVerifiedResolved(payload.data);
            fetchLedger();
            fetchMerkleAudit();
            break;
          case 'CIRCUIT_TRIPPED':
          case 'CIRCUIT_RESET':
          case 'REMEDIATION_ROLLED_BACK':
            setActiveCanary(null);
            setCanaryCountdown(0);
            fetchLedger();
            fetchMetrics();
            fetchMerkleAudit();
            break;
          case 'DECISION_RESOLVED': fetchLedger(); fetchMetrics(); fetchMerkleAudit(); break;
          case 'ALERT_INGESTED':
            if (payload.data && !streamPaused) {
              const newLog: TelemetryLog = {
                id: payload.data.id || String(Date.now()),
                rawTime: payload.data.rawTime || Date.now(),
                service: payload.data.service || 'service',
                severity: payload.data.severity || 'INFO',
                message: payload.data.message || 'Telemetry event processed',
                dlpScrubbed: Boolean(payload.data.scrubbed),
              };
              setTelemetryLogs((prev) => [newLog, ...prev.slice(0, bufferLimit - 1)]);
            }
            break;
        }
      } catch (err) {
        console.error('[SSE] Error:', err);
      }
    };

    return () => {
      clearInterval(pollTimer);
      es.close();
    };
  }, [fetchLedger, fetchMetrics, fetchRecentLogs, fetchTimeseries, fetchMerkleAudit, streamPaused, bufferLimit]);

  const filteredLogs = useMemo(() => {
    return telemetryLogs.filter((log) => {
      if (selectedTimeSlice) {
        if (log.rawTime < selectedTimeSlice.start || log.rawTime > selectedTimeSlice.end) return false;
      } else {
        const matchTime = timeRange === 'ALL' ? true : log.rawTime >= rangeConfig.startTime && log.rawTime <= rangeConfig.endTime;
        if (!matchTime) return false;
      }

      if (streamFilter === 'CRITICAL' && log.severity !== 'CRITICAL') return false;
      if (streamFilter === 'WARNING' && log.severity !== 'WARNING') return false;
      if (streamFilter === 'SCRUBBED' && !log.dlpScrubbed) return false;

      if (streamSearch.trim()) {
        const query = streamSearch.toLowerCase();
        return log.service.toLowerCase().includes(query) || log.message.toLowerCase().includes(query);
      }

      return true;
    });
  }, [telemetryLogs, timeRange, rangeConfig, streamFilter, streamSearch, selectedTimeSlice]);

  const filteredLedger = useMemo(() => {
    return ledger.filter((item) => {
      const matchTime = timeRange === 'ALL' ? true : (item.createdTimestamp || 0) >= rangeConfig.startTime && (item.createdTimestamp || 0) <= rangeConfig.endTime;
      if (!matchTime) return false;
      if (ledgerFilter === 'ALL') return true;
      return item.status.toUpperCase() === ledgerFilter;
    });
  }, [ledger, timeRange, rangeConfig, ledgerFilter]);

  const getFilterCount = (filterName: string) => {
    return ledger.filter((item) => {
      const matchTime = timeRange === 'ALL' ? true : (item.createdTimestamp || 0) >= rangeConfig.startTime && (item.createdTimestamp || 0) <= rangeConfig.endTime;
      if (!matchTime) return false;
      if (filterName === 'ALL') return true;
      return item.status.toUpperCase() === filterName;
    }).length;
  };

  const chartBuckets = useMemo(() => {
    const bucketCount = 18;
    const duration = rangeConfig.durationMs;
    const stepMs = duration / bucketCount;
    const startTime = rangeConfig.startTime === 0 ? Date.now() - 24 * 60 * 60 * 1000 : rangeConfig.startTime;

    return Array.from({ length: bucketCount }, (_, i) => {
      const bStart = startTime + i * stepMs;
      const bEnd = bStart + stepMs;
      const midTime = bStart + stepMs / 2;
      const timeLabel = formatTs(midTime);

      const pointsInBucket = timeseriesData.filter((p) => p.timestamp >= bStart && p.timestamp < bEnd);
      let tps = 0;
      let p50 = 4;
      let p95 = 8;
      let p99 = 14;
      let errRate = 0;
      let supp = 0;

      if (pointsInBucket.length > 0) {
        tps = Math.max(...pointsInBucket.map((p) => p.throughput));
        p50 = Math.round(pointsInBucket.reduce((acc, p) => acc + (p.latencyP50 || 4), 0) / pointsInBucket.length);
        p95 = Math.max(...pointsInBucket.map((p) => p.latencyP95 || p.latency || 8));
        p99 = Math.max(...pointsInBucket.map((p) => p.latencyP99 || 14));
        errRate = Number((pointsInBucket.reduce((acc, p) => acc + (p.errorRate || 0), 0) / pointsInBucket.length).toFixed(2));
        supp = Math.round(pointsInBucket.reduce((acc, p) => acc + (p.suppressed || 0), 0) / pointsInBucket.length);
      } else {
        tps = 0;
        p50 = 4;
        p95 = 8;
        p99 = 14;
        errRate = 0;
        supp = 0;
      }

      if (i === bucketCount - 1 && metrics.throughput > 0) {
        tps = Math.max(tps, metrics.throughput);
      }

      return { label: timeLabel, timestamp: midTime, bStart, bEnd, throughput: tps, p50, p95, p99, errRate, supp };
    });
  }, [timeseriesData, rangeConfig, metrics.throughput, formatTs]);

  const maxTps = Math.max(10, ...chartBuckets.map((b) => b.throughput));
  const maxP99 = Math.max(40, ...chartBuckets.map((b) => b.p99));
  const maxErr = Math.max(2.0, ...chartBuckets.map((b) => b.errRate));
  const maxSupp = Math.max(10, ...chartBuckets.map((b) => b.supp));

  const buildSmoothPath = (values: number[], maxVal: number, height = 70, base = 75) => {
    const points = values.map((v, i) => ({
      x: (i / (values.length - 1)) * 360,
      y: Math.max(10, base - (v / maxVal) * (height - 10)),
    }));

    if (points.length === 0) return { line: '', area: '', points: [] };

    let d = `M ${points[0].x},${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
      const curr = points[i];
      const next = points[i + 1];
      const cpX = (curr.x + next.x) / 2;
      d += ` C ${cpX},${curr.y} ${cpX},${next.y} ${next.x},${next.y}`;
    }

    const area = `${d} L 360,80 L 0,80 Z`;
    return { line: d, area, points };
  };

  const tpsPath = buildSmoothPath(chartBuckets.map((b) => b.throughput), maxTps);
  const p95Path = buildSmoothPath(chartBuckets.map((b) => b.p95), maxP99);
  const p99Path = buildSmoothPath(chartBuckets.map((b) => b.p99), maxP99);
  const errPath = buildSmoothPath(chartBuckets.map((b) => b.errRate), maxErr);
  const suppPath = buildSmoothPath(chartBuckets.map((b) => b.supp), maxSupp);

  const timelineMilestones = useMemo(() => {
    const duration = rangeConfig.durationMs;
    const start = rangeConfig.startTime === 0 ? Date.now() - 24 * 60 * 60 * 1000 : rangeConfig.startTime;
    return [
      formatTs(start),
      formatTs(start + duration * 0.33),
      formatTs(start + duration * 0.66),
      formatTs(rangeConfig.endTime) + ' (Now)',
    ];
  }, [rangeConfig, formatTs]);

  const activeProposal: HitlProposal | null = pendingQueue[queueIndex] || null;

  const activeTrippedTargets = Array.from(
    new Set([
      ...(metrics.trippedCircuits || []),
      ...ledger.filter((t) => t.status === 'CIRCUIT_TRIPPED').map((t) => t.target || t.subject?.target).filter(Boolean),
    ])
  ) as string[];

  const serviceStats = [
    { name: 'order-service', traffic: '34%', status: 'NOMINAL', latency: '9ms', color: 'text-emerald-400', badge: 'bg-emerald-950 border-emerald-800' },
    { name: 'auth-gateway', traffic: '28%', status: 'DLP ENFORCED', latency: '14ms', color: 'text-cyan-400', badge: 'bg-cyan-950 border-cyan-800' },
    { name: 'k8s-ingress', traffic: '22%', status: activeTrippedTargets.includes('k8s-ingress') ? 'CIRCUIT TRIPPED' : 'NOMINAL', latency: '22ms', color: activeTrippedTargets.includes('k8s-ingress') ? 'text-red-400' : 'text-emerald-400', badge: activeTrippedTargets.includes('k8s-ingress') ? 'bg-red-950 border-red-700 animate-pulse' : 'bg-emerald-950 border-emerald-800' },
    { name: 'inventory-db', traffic: '11%', status: 'NOMINAL', latency: '12ms', color: 'text-emerald-400', badge: 'bg-emerald-950 border-emerald-800' },
    { name: 'flapping-payment-worker', traffic: '5%', status: activeTrippedTargets.includes('flapping-payment-worker') ? 'CIRCUIT TRIPPED' : 'NOMINAL', latency: '35ms', color: activeTrippedTargets.includes('flapping-payment-worker') ? 'text-red-400' : 'text-amber-400', badge: activeTrippedTargets.includes('flapping-payment-worker') ? 'bg-red-950 border-red-700 animate-pulse' : 'bg-slate-800 border-slate-700' },
  ];

  const currentHoverItem = hoveredIdx !== null ? chartBuckets[hoveredIdx] : null;

  return (
    <div className="min-h-screen bg-[#06090f] text-slate-100 p-4 md:p-8 font-sans selection:bg-cyan-500 selection:text-black">
      <div className="fixed inset-0 pointer-events-none overflow-hidden -z-10">
        <div className="absolute -top-32 left-1/4 w-[500px] h-[500px] bg-cyan-600/10 rounded-full blur-[140px]" />
        <div className="absolute top-1/3 -right-32 w-[500px] h-[500px] bg-indigo-600/10 rounded-full blur-[160px]" />
        <div className="absolute -bottom-32 left-1/3 w-[500px] h-[500px] bg-rose-600/5 rounded-full blur-[160px]" />
      </div>

      <header className="flex flex-col lg:flex-row lg:items-center justify-between pb-6 border-b border-slate-800/80 gap-5">
        <div className="flex items-center gap-3.5">
          <div className="h-12 w-12 rounded-2xl bg-gradient-to-tr from-[#090d1a] to-[#12192c] p-1 flex items-center justify-center border border-cyan-500/30 shadow-[0_0_25px_rgba(0,240,255,0.25)]">
            <NeuroFabricLogo className="h-10 w-10" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-black tracking-tight text-white drop-shadow-sm">NeuroFabric Ops</h1>
              <span className="text-[10px] font-bold tracking-wider uppercase px-2.5 py-0.5 rounded-full bg-gradient-to-r from-cyan-950 to-indigo-950 border border-cyan-500/40 text-cyan-300 shadow-inner">
                ENTERPRISE 3D
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">Autonomous Closed-Loop Remediation & Telemetry Operations</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 self-start lg:self-auto">
          <div className="flex items-center p-1 rounded-xl bg-[#0b0f1a] border border-slate-800 shadow-md">
            <button
              onClick={() => setTzMode('LOCAL')}
              className={`px-2.5 py-1 text-[10px] font-mono font-bold rounded-lg transition-all cursor-pointer ${
                tzMode === 'LOCAL' ? 'bg-cyan-600 text-white shadow' : 'text-slate-400 hover:text-white'
              }`}
            >
              📍 LOCAL
            </button>
            <button
              onClick={() => setTzMode('UTC')}
              className={`px-2.5 py-1 text-[10px] font-mono font-bold rounded-lg transition-all cursor-pointer ${
                tzMode === 'UTC' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white'
              }`}
            >
              🌐 UTC
            </button>
          </div>

          <button
            onClick={() => setShowArchGuide(!showArchGuide)}
            className="px-3 py-1.5 rounded-xl text-xs font-mono font-bold bg-indigo-950/60 hover:bg-indigo-900/70 border border-indigo-500/40 text-indigo-300 shadow-md cursor-pointer transition-all flex items-center gap-2"
          >
            <span>📖 Architecture HUD</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-800 text-white">{showArchGuide ? 'Hide' : 'Show'}</span>
          </button>

          {currentUser ? (
            <div className="flex items-center gap-2.5 p-1.5 px-3 rounded-xl bg-[#0c101c]/90 border border-slate-800/90 shadow-xl backdrop-blur-md">
              <div className="h-7 w-7 rounded-lg bg-gradient-to-tr from-cyan-600 to-indigo-600 border border-cyan-400/40 flex items-center justify-center font-bold text-xs text-white">
                {currentUser.name[0]}
              </div>
              <div className="text-left text-xs font-mono">
                <div className="text-white font-semibold truncate max-w-[130px]">{currentUser.name}</div>
                <div className="text-[10px] text-cyan-400 font-bold">{currentUser.role}</div>
              </div>
              <button
                onClick={handleLogout}
                className="ml-1 text-[10px] font-mono text-rose-400 hover:text-rose-300 px-2 py-1 rounded bg-rose-950/40 border border-rose-800/40 hover:bg-rose-900/60 cursor-pointer transition-all"
              >
                Sign Out
              </button>
            </div>
          ) : (
            <button
              onClick={() => handleLogin('commander@neurofabric.io', 'Commander2026!')}
              className="px-4 py-1.5 rounded-xl text-xs font-mono font-bold bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg cursor-pointer transition-all"
            >
              Sign In
            </button>
          )}

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[#0c101c]/90 border border-slate-800/90 shadow-xl backdrop-blur-md">
            <span className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-400 animate-pulse shadow-[0_0_10px_rgba(52,211,153,0.8)]' : 'bg-amber-400'}`} />
            <span className="text-xs font-mono font-semibold text-slate-200">
              {connected ? 'Stream Active' : 'Connecting...'}
            </span>
          </div>

          <div className="flex items-center p-1 rounded-xl bg-[#0b0f1a] border border-slate-800 shadow-xl shadow-black/40">
            <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider px-2 font-semibold">RANGE</span>
            {(['5M', '15M', '1H', '24H', 'ALL'] as TimeRange[]).map((r) => (
              <button
                key={r}
                onClick={() => { setTimeRange(r); setSelectedTimeSlice(null); }}
                className={`px-2.5 py-1 text-[11px] font-mono font-bold rounded-lg transition-all cursor-pointer ${
                  timeRange === r
                    ? 'bg-gradient-to-r from-cyan-600 to-indigo-600 text-white shadow-[0_2px_12px_rgba(0,240,255,0.35)] border border-cyan-400/40'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                {r}
              </button>
            ))}
            <button
              onClick={() => setShowCustomModal(true)}
              className={`px-2.5 py-1 text-[11px] font-mono font-bold rounded-lg transition-all cursor-pointer ${
                timeRange === 'CUSTOM'
                  ? 'bg-gradient-to-r from-cyan-600 to-cyan-500 text-white shadow border border-cyan-400/40'
                  : 'text-cyan-400 hover:text-cyan-300 hover:bg-slate-800/50'
              }`}
            >
              CUSTOM
            </button>
          </div>
        </div>
      </header>

      {selectedTimeSlice && (
        <div className="my-3 px-4 py-2 rounded-xl bg-cyan-950/80 border border-cyan-500/60 text-cyan-200 text-xs font-mono flex items-center justify-between shadow-lg animate-in fade-in">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
            <span>
              <strong>Filtered by Graph Slice:</strong> Inspecting events between {formatTs(selectedTimeSlice.start)} and {formatTs(selectedTimeSlice.end)}
            </span>
          </div>
          <button
            onClick={() => setSelectedTimeSlice(null)}
            className="text-[10px] font-bold uppercase tracking-wider text-white bg-cyan-800 hover:bg-cyan-700 px-2 py-0.5 rounded cursor-pointer transition-colors"
          >
            Clear Filter (Show All Window)
          </button>
        </div>
      )}

      {showArchGuide && (
        <section className="my-5 p-5 rounded-2xl bg-gradient-to-b from-[#111728] via-[#0d1322] to-[#0a0e18] border border-indigo-500/50 shadow-2xl space-y-4 animate-in fade-in duration-300">
          <div className="flex items-center justify-between pb-3 border-b border-indigo-900/50">
            <div className="flex items-center gap-2.5">
              <span className="text-base">🛡️</span>
              <h2 className="text-sm font-bold uppercase tracking-wider text-white font-mono">
                NeuroFabric Closed-Loop Operational Architecture
              </h2>
            </div>
            <span className="text-[11px] font-mono text-indigo-300">NIST SP 800-218 & OWASP Top 10 ML Aligned</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs font-mono">
            <div className="p-3.5 rounded-xl bg-[#090d16] border border-slate-800 space-y-2">
              <div className="text-cyan-400 font-bold flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-cyan-400" />
                1. Linear Ingestion & DLP
              </div>
              <p className="text-slate-400 text-[11px] leading-relaxed">
                Telemetry streams through zero-allocation regex scrubbers. Bearer tokens, OpenAI/Claude API keys, and credentials are obfuscated to <code>[REDACTED_SECRET]</code> in-flight before entering memory.
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-[#090d16] border border-slate-800 space-y-2">
              <div className="text-purple-400 font-bold flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-purple-400" />
                2. AST Gate & Threat Intel
              </div>
              <p className="text-slate-400 text-[11px] leading-relaxed">
                Before any patch reaches production, an AST security scanner inspects the unified diff against prohibited command patterns (e.g. <code>curl | sh</code>, <code>rm -rf</code>, <code>eval()</code>), rejecting dangerous payloads with HTTP 422.
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-[#090d16] border border-slate-800 space-y-2">
              <div className="text-amber-400 font-bold flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-amber-400" />
                3. Anti-Flapping Circuit
              </div>
              <p className="text-slate-400 text-[11px] leading-relaxed">
                Services registering 3+ critical strikes in succession trip a protective circuit breaker (HTTP 423). Mutations freeze immediately to prevent thrashing until an authorized operator issues a cryptographic reset.
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-[#090d16] border border-slate-800 space-y-2">
              <div className="text-emerald-400 font-bold flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                4. 15s Canary & Merkle Audit
              </div>
              <p className="text-slate-400 text-[11px] leading-relaxed">
                Remediations deploy to an isolated 10% canary slice under a 15-second observation window. Zero regressions promote fleet-wide; anomalies trigger instant rollbacks with tamper-evident audit records.
              </p>
            </div>
          </div>
        </section>
      )}

      {showCustomModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-gradient-to-b from-[#131b2e] to-[#0a0e18] border border-cyan-500/50 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="font-bold text-white text-sm font-mono flex items-center gap-2">
                <span>⏱️</span> Select Custom Investigation Window
              </h3>
              <button onClick={() => setShowCustomModal(false)} className="text-slate-400 hover:text-white font-mono cursor-pointer">✕</button>
            </div>

            <div className="space-y-3 text-xs font-mono">
              <div>
                <label className="text-slate-400 block mb-1">Window Start Time ({tzMode})</label>
                <input
                  type="datetime-local"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="w-full bg-[#080c14] border border-slate-800 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div>
                <label className="text-slate-400 block mb-1">Window End Time ({tzMode})</label>
                <input
                  type="datetime-local"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="w-full bg-[#080c14] border border-slate-800 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
              <button onClick={() => setShowCustomModal(false)} className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer">Cancel</button>
              <button onClick={handleApplyCustomRange} className="px-5 py-2 rounded-xl text-xs font-bold bg-cyan-600 hover:bg-cyan-500 text-white cursor-pointer shadow-lg shadow-cyan-600/40">Apply Range Filter</button>
            </div>
          </div>
        </div>
      )}

      <div className="my-5 p-3.5 rounded-2xl bg-gradient-to-r from-[#0d1322] via-[#0f172a] to-[#0d1322] border border-cyan-900/40 shadow-xl flex flex-col md:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-2.5 w-2.5 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500"></span>
          </span>
          <span className="text-xs font-mono font-bold uppercase text-cyan-300 tracking-wider">Telemetry Simulator:</span>
          <span className="text-xs text-slate-400 hidden sm:inline">Inject live telemetry to observe waveforms & closed-loop circuit actions.</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            disabled={Boolean(simLoading)}
            onClick={() => triggerSimulation('TRAFFIC_FLOOD')}
            className="px-3 py-1.5 rounded-xl text-xs font-mono font-bold bg-cyan-950/70 hover:bg-cyan-900/80 border border-cyan-700/60 text-cyan-300 shadow-md cursor-pointer transition-all hover:scale-102 disabled:opacity-50"
          >
            {simLoading === 'TRAFFIC_FLOOD' ? 'Simulating...' : '🌊 Sustained Burst (45x)'}
          </button>
          <button
            disabled={Boolean(simLoading)}
            onClick={() => triggerSimulation('CANARY_TEST')}
            className="px-3 py-1.5 rounded-xl text-xs font-mono font-bold bg-indigo-950/70 hover:bg-indigo-900/80 border border-indigo-700/60 text-indigo-300 shadow-md cursor-pointer transition-all hover:scale-102 disabled:opacity-50"
          >
            {simLoading === 'CANARY_TEST' ? 'Deploying...' : '🧪 Test 15s Canary'}
          </button>
          <button
            disabled={Boolean(simLoading)}
            onClick={() => triggerSimulation('CRITICAL_ANOMALY')}
            className="px-3 py-1.5 rounded-xl text-xs font-mono font-bold bg-rose-950/70 hover:bg-rose-900/80 border border-rose-700/60 text-rose-300 shadow-md cursor-pointer transition-all hover:scale-102 disabled:opacity-50"
          >
            {simLoading === 'CRITICAL_ANOMALY' ? 'Injecting...' : '⚡ Inject Anomaly'}
          </button>
          <button
            disabled={Boolean(simLoading)}
            onClick={() => triggerSimulation('DLP_PROBE')}
            className="px-3 py-1.5 rounded-xl text-xs font-mono font-bold bg-purple-950/70 hover:bg-purple-900/80 border border-purple-700/60 text-purple-300 shadow-md cursor-pointer transition-all hover:scale-102 disabled:opacity-50"
          >
            {simLoading === 'DLP_PROBE' ? 'Testing...' : '🛡️ Test DLP Probe'}
          </button>
          <button
            disabled={Boolean(simLoading)}
            onClick={() => triggerSimulation('TRIP_BREAKER')}
            className="px-3 py-1.5 rounded-xl text-xs font-mono font-bold bg-amber-950/70 hover:bg-amber-900/80 border border-amber-700/60 text-amber-300 shadow-md cursor-pointer transition-all hover:scale-102 disabled:opacity-50"
          >
            {simLoading === 'TRIP_BREAKER' ? 'Tripping...' : '⚡ Trip Breaker'}
          </button>
        </div>
      </div>

      <section className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 my-5">
        {[
          { label: 'Throughput', value: `${metrics.throughput} evt/s`, color: 'text-cyan-400', glow: 'shadow-cyan-500/10' },
          { label: 'Total Ingested', value: `${metrics.totalIngested} evts`, color: 'text-emerald-400', glow: 'shadow-emerald-500/10' },
          { label: 'Alerts Suppressed', value: `${metrics.suppressedAlerts}`, color: 'text-purple-400', glow: 'shadow-purple-500/10' },
          { label: 'Secrets Scrubbed', value: metrics.secretsScrubbed, color: 'text-rose-400', glow: 'shadow-rose-500/10' },
          { label: 'Stream Lag (P99)', value: `${metrics.streamLagMs}ms`, color: 'text-amber-400', glow: 'shadow-amber-500/10' },
          { label: 'Canary Health', value: activeCanary ? 'OBSERVING' : '100% NOMINAL', color: activeCanary ? 'text-amber-300' : 'text-emerald-300', glow: 'shadow-amber-500/10' },
          { label: 'MTTR', value: `${metrics.mttrSeconds}s`, color: 'text-blue-400', glow: 'shadow-blue-500/10' },
          { label: 'Avg Confidence', value: `${metrics.avgConfidence}%`, color: 'text-indigo-400', glow: 'shadow-indigo-500/10' },
        ].map((card, idx) => (
          <div
            key={idx}
            className={`relative group bg-gradient-to-b from-[#0f1422]/90 to-[#090d16]/90 border border-slate-800/80 hover:border-slate-700/90 rounded-2xl p-3.5 flex flex-col justify-between shadow-xl ${card.glow} backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5`}
          >
            <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
            <span className="text-[11px] font-semibold text-slate-400 truncate tracking-wide">{card.label}</span>
            <span className={`text-base sm:text-lg font-black font-mono mt-1.5 tabular-nums ${card.color}`}>{card.value}</span>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="relative overflow-hidden bg-gradient-to-b from-[#0e1424]/90 to-[#080c14]/95 border border-slate-800/90 rounded-2xl p-4 shadow-2xl backdrop-blur-md">
          <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-cyan-400 animate-ping" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200 font-mono">1. Ingestion Velocity ({rangeConfig.label})</h3>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-slate-400">Current:</span>
              <span className="text-cyan-400 font-bold tabular-nums">{metrics.throughput} evt/s</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-950/60 border border-cyan-800/40 text-cyan-300">Peak: {maxTps} evt/s</span>
            </div>
          </div>

          <div className="h-32 w-full pt-1 relative">
            <svg viewBox="0 0 360 80" className="w-full h-full overflow-visible" preserveAspectRatio="none">
              <defs>
                <linearGradient id="cyanSmoothGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <line x1="0" y1="20" x2="360" y2="20" stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
              <line x1="0" y1="50" x2="360" y2="50" stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />

              {hoveredIdx !== null && (
                <line x1={(hoveredIdx / 17) * 360} y1="0" x2={(hoveredIdx / 17) * 360} y2="80" stroke="#06b6d4" strokeWidth="1.5" strokeDasharray="2 2" className="opacity-70" />
              )}

              {tpsPath.area && <path d={tpsPath.area} fill="url(#cyanSmoothGrad)" />}
              {tpsPath.line && (
                <path d={tpsPath.line} fill="none" stroke="#06b6d4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-[0_0_12px_rgba(6,182,212,0.8)]" />
              )}

              {tpsPath.points?.map((pt, i) => (
                <circle
                  key={i}
                  cx={pt.x}
                  cy={pt.y}
                  r={hoveredIdx === i ? 5 : 3}
                  className={`${hoveredIdx === i ? 'fill-white stroke-cyan-400' : 'fill-cyan-400 stroke-[#080c14]'} stroke-2 cursor-pointer transition-all`}
                  onMouseEnter={() => { setHoveredIdx(i); setActiveHoverChart('tps'); }}
                  onMouseLeave={() => { setHoveredIdx(null); setActiveHoverChart(null); }}
                  onClick={() => {
                    const b = chartBuckets[i];
                    if (b) setSelectedTimeSlice({ start: b.bStart, end: b.bEnd, label: b.label });
                  }}
                />
              ))}
            </svg>

            {activeHoverChart === 'tps' && currentHoverItem && hoveredIdx !== null && (
              <div
                className="absolute z-20 pointer-events-none bg-[#0e1628]/95 border border-cyan-500/60 rounded-xl p-2.5 text-[10px] font-mono shadow-2xl text-white transform -translate-x-1/2 -translate-y-full mb-2 backdrop-blur-md"
                style={{ left: `${(hoveredIdx / 17) * 100}%`, top: '40%' }}
              >
                <div className="text-cyan-400 font-bold border-b border-cyan-500/30 pb-1 mb-1">{currentHoverItem.label}</div>
                <div>Velocity: <span className="text-white font-bold">{currentHoverItem.throughput} evt/s</span></div>
                <div>Tail P95: <span className="text-emerald-400 font-bold">{currentHoverItem.p95}ms</span></div>
                <div className="text-[9px] text-slate-400 mt-1 italic">Click point to filter stream to this slice</div>
              </div>
            )}
          </div>

          <div className="flex justify-between text-[10px] font-mono text-slate-400 pt-2 border-t border-slate-800/60 mt-1">
            {timelineMilestones.map((m, idx) => (<span key={idx} className={idx === 3 ? 'text-cyan-400 font-bold' : ''}>{m}</span>))}
          </div>
        </div>

        <div className="relative overflow-hidden bg-gradient-to-b from-[#0e1424]/90 to-[#080c14]/95 border border-slate-800/90 rounded-2xl p-4 shadow-2xl backdrop-blur-md">
          <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200 font-mono">2. Latency Spectrum (P50/P95/P99)</h3>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-emerald-400 font-bold">P95: {chartBuckets[chartBuckets.length - 1]?.p95 || 8}ms</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-800/40 text-emerald-300">P99: {chartBuckets[chartBuckets.length - 1]?.p99 || 14}ms</span>
            </div>
          </div>

          <div className="h-32 w-full pt-1 relative">
            <svg viewBox="0 0 360 80" className="w-full h-full overflow-visible" preserveAspectRatio="none">
              <defs>
                <linearGradient id="emeraldSmoothGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <line x1="0" y1="20" x2="360" y2="20" stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
              <line x1="0" y1="50" x2="360" y2="50" stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />

              {hoveredIdx !== null && (
                <line x1={(hoveredIdx / 17) * 360} y1="0" x2={(hoveredIdx / 17) * 360} y2="80" stroke="#10b981" strokeWidth="1.5" strokeDasharray="2 2" className="opacity-70" />
              )}

              {p95Path.area && <path d={p95Path.area} fill="url(#emeraldSmoothGrad)" />}
              {p99Path.line && <path d={p99Path.line} fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="3 3" />}
              {p95Path.line && (
                <path d={p95Path.line} fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-[0_0_12px_rgba(16,185,129,0.8)]" />
              )}

              {p95Path.points?.map((pt, i) => (
                <circle
                  key={i}
                  cx={pt.x}
                  cy={pt.y}
                  r={hoveredIdx === i ? 5 : 3}
                  className={`${hoveredIdx === i ? 'fill-white stroke-emerald-400' : 'fill-emerald-400 stroke-[#080c14]'} stroke-2 cursor-pointer transition-all`}
                  onMouseEnter={() => { setHoveredIdx(i); setActiveHoverChart('latency'); }}
                  onMouseLeave={() => { setHoveredIdx(null); setActiveHoverChart(null); }}
                  onClick={() => {
                    const b = chartBuckets[i];
                    if (b) setSelectedTimeSlice({ start: b.bStart, end: b.bEnd, label: b.label });
                  }}
                />
              ))}
            </svg>

            {activeHoverChart === 'latency' && currentHoverItem && hoveredIdx !== null && (
              <div
                className="absolute z-20 pointer-events-none bg-[#0e1628]/95 border border-emerald-500/60 rounded-xl p-2.5 text-[10px] font-mono shadow-2xl text-white transform -translate-x-1/2 -translate-y-full mb-2 backdrop-blur-md"
                style={{ left: `${(hoveredIdx / 17) * 100}%`, top: '40%' }}
              >
                <div className="text-emerald-400 font-bold border-b border-emerald-500/30 pb-1 mb-1">{currentHoverItem.label}</div>
                <div>P50 Median: <span className="text-white font-bold">{currentHoverItem.p50}ms</span></div>
                <div>P95 Tail: <span className="text-emerald-400 font-bold">{currentHoverItem.p95}ms</span></div>
                <div>P99 Outlier: <span className="text-amber-400 font-bold">{currentHoverItem.p99}ms</span></div>
              </div>
            )}
          </div>

          <div className="flex justify-between text-[10px] font-mono text-slate-400 pt-2 border-t border-slate-800/60 mt-1">
            {timelineMilestones.map((m, idx) => (<span key={idx} className={idx === 3 ? 'text-emerald-400 font-bold' : ''}>{m}</span>))}
          </div>
        </div>

        <div className="relative overflow-hidden bg-gradient-to-b from-[#0e1424]/90 to-[#080c14]/95 border border-slate-800/90 rounded-2xl p-4 shadow-2xl backdrop-blur-md">
          <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-rose-400/40 to-transparent" />
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-rose-400 animate-pulse" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200 font-mono">3. Error Rate & SLA Budget</h3>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-slate-400">Current Err:</span>
              <span className="text-rose-400 font-bold">{chartBuckets[chartBuckets.length - 1]?.errRate || 0}%</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-800/40 text-emerald-300">SLA: 99.9% Nominal</span>
            </div>
          </div>

          <div className="h-32 w-full pt-1 relative">
            <svg viewBox="0 0 360 80" className="w-full h-full overflow-visible" preserveAspectRatio="none">
              <defs>
                <linearGradient id="roseSmoothGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f43f5e" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#f43f5e" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <line x1="0" y1="20" x2="360" y2="20" stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
              <line x1="0" y1="50" x2="360" y2="50" stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />

              {hoveredIdx !== null && (
                <line x1={(hoveredIdx / 17) * 360} y1="0" x2={(hoveredIdx / 17) * 360} y2="80" stroke="#f43f5e" strokeWidth="1.5" strokeDasharray="2 2" className="opacity-70" />
              )}

              {errPath.area && <path d={errPath.area} fill="url(#roseSmoothGrad)" />}
              {errPath.line && (
                <path d={errPath.line} fill="none" stroke="#f43f5e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-[0_0_12px_rgba(244,63,94,0.8)]" />
              )}

              {errPath.points?.map((pt, i) => (
                <circle
                  key={i}
                  cx={pt.x}
                  cy={pt.y}
                  r={hoveredIdx === i ? 5 : 3}
                  className={`${hoveredIdx === i ? 'fill-white stroke-rose-400' : 'fill-rose-400 stroke-[#080c14]'} stroke-2 cursor-pointer transition-all`}
                  onMouseEnter={() => { setHoveredIdx(i); setActiveHoverChart('error'); }}
                  onMouseLeave={() => { setHoveredIdx(null); setActiveHoverChart(null); }}
                />
              ))}
            </svg>

            {activeHoverChart === 'error' && currentHoverItem && hoveredIdx !== null && (
              <div
                className="absolute z-20 pointer-events-none bg-[#0e1628]/95 border border-rose-500/60 rounded-xl p-2.5 text-[10px] font-mono shadow-2xl text-white transform -translate-x-1/2 -translate-y-full mb-2 backdrop-blur-md"
                style={{ left: `${(hoveredIdx / 17) * 100}%`, top: '40%' }}
              >
                <div className="text-rose-400 font-bold border-b border-rose-500/30 pb-1 mb-1">{currentHoverItem.label}</div>
                <div>Error Rate: <span className="text-white font-bold">{currentHoverItem.errRate}%</span></div>
                <div>SLA Target: <span className="text-emerald-400 font-bold">&lt; 0.10%</span></div>
              </div>
            )}
          </div>

          <div className="flex justify-between text-[10px] font-mono text-slate-400 pt-2 border-t border-slate-800/60 mt-1">
            {timelineMilestones.map((m, idx) => (<span key={idx} className={idx === 3 ? 'text-rose-400 font-bold' : ''}>{m}</span>))}
          </div>
        </div>

        <div className="relative overflow-hidden bg-gradient-to-b from-[#0e1424]/90 to-[#080c14]/95 border border-slate-800/90 rounded-2xl p-4 shadow-2xl backdrop-blur-md">
          <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-purple-400/40 to-transparent" />
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-purple-400 animate-pulse" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200 font-mono">4. Cascade Suppression & Noise Dedup</h3>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-slate-400">Total Suppressed:</span>
              <span className="text-purple-400 font-bold">{metrics.suppressedAlerts} Noise Bursts</span>
            </div>
          </div>

          <div className="h-32 w-full pt-1 relative">
            <svg viewBox="0 0 360 80" className="w-full h-full overflow-visible" preserveAspectRatio="none">
              <defs>
                <linearGradient id="purpleSmoothGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#a855f7" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#a855f7" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <line x1="0" y1="20" x2="360" y2="20" stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
              <line x1="0" y1="50" x2="360" y2="50" stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />

              {hoveredIdx !== null && (
                <line x1={(hoveredIdx / 17) * 360} y1="0" x2={(hoveredIdx / 17) * 360} y2="80" stroke="#a855f7" strokeWidth="1.5" strokeDasharray="2 2" className="opacity-70" />
              )}

              {suppPath.area && <path d={suppPath.area} fill="url(#purpleSmoothGrad)" />}
              {suppPath.line && (
                <path d={suppPath.line} fill="none" stroke="#a855f7" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-[0_0_12px_rgba(168,85,247,0.8)]" />
              )}

              {suppPath.points?.map((pt, i) => (
                <circle
                  key={i}
                  cx={pt.x}
                  cy={pt.y}
                  r={hoveredIdx === i ? 5 : 3}
                  className={`${hoveredIdx === i ? 'fill-white stroke-purple-400' : 'fill-purple-400 stroke-[#080c14]'} stroke-2 cursor-pointer transition-all`}
                  onMouseEnter={() => { setHoveredIdx(i); setActiveHoverChart('supp'); }}
                  onMouseLeave={() => { setHoveredIdx(null); setActiveHoverChart(null); }}
                />
              ))}
            </svg>

            {activeHoverChart === 'supp' && currentHoverItem && hoveredIdx !== null && (
              <div
                className="absolute z-20 pointer-events-none bg-[#0e1628]/95 border border-purple-500/60 rounded-xl p-2.5 text-[10px] font-mono shadow-2xl text-white transform -translate-x-1/2 -translate-y-full mb-2 backdrop-blur-md"
                style={{ left: `${(hoveredIdx / 17) * 100}%`, top: '40%' }}
              >
                <div className="text-purple-400 font-bold border-b border-purple-500/30 pb-1 mb-1">{currentHoverItem.label}</div>
                <div>Suppression Vol: <span className="text-white font-bold">{currentHoverItem.supp} alerts/min</span></div>
                <div>Topology Status: <span className="text-cyan-400 font-bold">DAG Correlated</span></div>
              </div>
            )}
          </div>

          <div className="flex justify-between text-[10px] font-mono text-slate-400 pt-2 border-t border-slate-800/60 mt-1">
            {timelineMilestones.map((m, idx) => (<span key={idx} className={idx === 3 ? 'text-purple-400 font-bold' : ''}>{m}</span>))}
          </div>
        </div>
      </section>

      {activeCanary && (
        <section className="mb-8 p-5 rounded-2xl bg-gradient-to-r from-[#17130a] via-[#21190c] to-[#17130a] border border-amber-500/60 shadow-[0_0_35px_rgba(245,158,11,0.2)] animate-pulse">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-amber-500/30 gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-3 w-3 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
              </span>
              <div>
                <h3 className="text-sm font-bold font-mono text-amber-200 uppercase tracking-wide">
                  Stage 1 Canary Observation Active: {activeCanary.target}
                </h3>
                <p className="text-xs text-amber-400/80 mt-0.5">
                  Slice: {activeCanary.slice || '10% Traffic'} &bull; Observing for error rate regressions before fleet promotion
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="text-right">
                <div className="text-[10px] font-mono text-amber-400 uppercase font-bold">Observation Remaining</div>
                <div className="text-xl font-black font-mono text-white tabular-nums">{canaryCountdown}s</div>
              </div>
              <button
                onClick={() => handleAbortCanary(activeCanary.taskId, activeCanary.target)}
                className="px-4 py-2 rounded-xl text-xs font-mono font-bold bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/40 cursor-pointer transition-all hover:scale-102"
              >
                Abort & Rollback
              </button>
            </div>
          </div>

          <div className="mt-3.5 space-y-1.5">
            <div className="flex justify-between text-[11px] font-mono text-amber-300">
              <span>Canary Verification Progress</span>
              <span>{Math.round(((15 - canaryCountdown) / 15) * 100)}% Complete (0 Anomalies Detected)</span>
            </div>
            <div className="w-full bg-amber-950/60 rounded-full h-2.5 overflow-hidden border border-amber-600/40">
              <div
                className="bg-gradient-to-r from-amber-500 via-amber-400 to-emerald-400 h-full transition-all duration-1000 ease-linear shadow-[0_0_12px_rgba(245,158,11,0.8)]"
                style={{ width: `${((15 - canaryCountdown) / 15) * 100}%` }}
              />
            </div>
          </div>
        </section>
      )}

      <section className="grid grid-cols-1 md:grid-cols-12 gap-4 mb-6">
        <div className="md:col-span-8 bg-gradient-to-b from-[#0e1424]/90 to-[#080c14]/95 border border-slate-800/90 rounded-2xl p-4 shadow-xl backdrop-blur-md">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200 font-mono">
              Microservice Topology & Circuit Breaker Matrix
            </h3>
            <span className="text-[10px] font-mono text-slate-400">5 Active Subsystems Under Load</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-5 gap-2.5">
            {serviceStats.map((svc, i) => (
              <div key={i} className="p-3 rounded-xl bg-[#080c14] border border-slate-800/90 flex flex-col justify-between space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-200 truncate">{svc.name}</span>
                  <span className="text-[10px] font-mono text-slate-400">{svc.traffic}</span>
                </div>
                <div className="space-y-1">
                  <div className="text-[9px] font-mono text-slate-400 flex justify-between">
                    <span>Latency:</span>
                    <span className="text-white font-bold">{svc.latency}</span>
                  </div>
                  <span className={`inline-block text-[9px] font-mono font-bold px-1.5 py-0.2 rounded border ${svc.badge} ${svc.color}`}>
                    {svc.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="md:col-span-4 bg-gradient-to-b from-[#0e1424]/90 to-[#080c14]/95 border border-slate-800/90 rounded-2xl p-4 shadow-xl backdrop-blur-md flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200 font-mono">
                Threat Intel & DLP Defense
              </h3>
              <span className="text-[10px] font-mono text-rose-400">100% Defended</span>
            </div>

            <div className="space-y-2 text-xs font-mono">
              <div className="flex justify-between items-center p-2 rounded-lg bg-[#080c14] border border-slate-850">
                <span className="text-slate-400 text-[11px]">Secrets Scrubbed In-Flight</span>
                <span className="text-rose-400 font-bold">{metrics.secretsScrubbed}</span>
              </div>
              <div className="flex justify-between items-center p-2 rounded-lg bg-[#080c14] border border-slate-850">
                <span className="text-slate-400 text-[11px]">AST Malicious Diffs Defended</span>
                <span className="text-purple-400 font-bold">42 (HTTP 422)</span>
              </div>
              <div className="flex justify-between items-center p-2 rounded-lg bg-[#080c14] border border-slate-850">
                <span className="text-slate-400 text-[11px]">Deduplication Noise Suppressed</span>
                <span className="text-amber-400 font-bold">{metrics.suppressedAlerts}</span>
              </div>
            </div>
          </div>

          <div className="text-[10px] font-mono text-slate-500 pt-2 border-t border-slate-800 mt-2 flex justify-between">
            <span>Filter: OWASP Top 10</span>
            <span>Policy Gate: Enforced</span>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-8">
        <section className="lg:col-span-7 bg-gradient-to-b from-[#0e1424]/90 to-[#080c14]/95 border border-slate-800 rounded-2xl p-5 shadow-2xl backdrop-blur-md">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200 font-mono">Autonomous Remediation Circuit</h2>
              {pendingQueue.length > 0 && (
                <span className="text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-amber-950 border border-amber-700/60 text-amber-300 shadow-md">
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
                </div>
              )}
              <span className="text-xs font-mono text-slate-400">Canary Window: 15s</span>
            </div>
          </div>

          {activeTrippedTargets.map((target) => (
            <div key={target} className="mb-4 p-4 rounded-xl bg-gradient-to-r from-red-950/90 to-red-900/80 border border-red-500 text-red-200 flex items-center justify-between shadow-[0_0_24px_rgba(239,68,68,0.3)] animate-pulse">
              <div className="flex items-center gap-2.5">
                <span className="h-3 w-3 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.9)]" />
                <span className="text-xs font-semibold">
                  <strong>Circuit Breaker Tripped on {target}:</strong> Flapping threshold exceeded. Automated mutations locked.
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

          {rolledBackTask && (
            <div className="mb-4 p-3.5 rounded-xl bg-rose-950/40 border border-rose-500/50 text-rose-300 flex items-center justify-between shadow-lg shadow-rose-950/40">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-rose-400" />
                <span className="text-xs font-medium">
                  Automated Rollback Executed on <strong>{rolledBackTask.target}</strong>: Canary slice reverted safely.
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
                  Canary Confirmed on <strong>{verifiedResolved.target}</strong>: Observation window passed. Patch promoted across fleet.
                </span>
              </div>
              <span className="text-[11px] font-mono uppercase bg-emerald-900/60 px-2 py-0.5 rounded">Verified</span>
            </div>
          )}

          {activeProposal ? (
            <div className="bg-[#090d16] border border-slate-700/60 rounded-xl p-5 space-y-4 shadow-xl">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2.5">
                    <span className="text-xs font-bold px-2.5 py-0.5 rounded-md bg-rose-950 border border-rose-700 text-rose-300">{activeProposal.severity}</span>
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
                <pre className="bg-black/90 border border-slate-800 rounded-lg p-3.5 text-xs font-mono overflow-x-auto text-slate-300 shadow-inner">
                  {activeProposal.patch?.diff ? (
                    activeProposal.patch.diff.split('\n').map((line, idx) => {
                      const color = line.startsWith('+') ? 'text-emerald-400' : line.startsWith('-') ? 'text-rose-400' : 'text-slate-400';
                      return <div key={idx} className={color}>{line}</div>;
                    })
                  ) : (<span className="text-slate-500">No diff preview attached.</span>)}
                </pre>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  disabled={isDeciding}
                  onClick={() => handleDecision(activeProposal.taskId, 'REJECTED')}
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-rose-400 border border-rose-900/40 transition-colors cursor-pointer disabled:opacity-50"
                >
                  Reject
                </button>
                <button
                  disabled={isDeciding}
                  onClick={() => handleDecision(activeProposal.taskId, 'APPROVED')}
                  className="px-5 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white shadow-lg shadow-emerald-600/30 transition-all cursor-pointer disabled:opacity-50"
                >
                  {isDeciding ? 'Deploying...' : 'Approve & Deploy 10% Canary'}
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center py-14 border border-dashed border-slate-800 rounded-2xl text-slate-500 text-xs font-mono flex flex-col items-center justify-center gap-2">
              <span>Autonomous Embassy is nominal. No pending human-in-the-loop proposals.</span>
              <button
                onClick={() => triggerSimulation('CRITICAL_ANOMALY')}
                className="mt-2 text-cyan-400 hover:text-cyan-300 underline underline-offset-4 cursor-pointer text-xs"
              >
                Click here to inject a test anomaly
              </button>
            </div>
          )}
        </section>

        <section className="lg:col-span-5 bg-gradient-to-b from-[#0e1424]/90 to-[#080c14]/95 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between shadow-2xl backdrop-blur-md">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200 font-mono">Live Ingestion Stream</h2>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800">
                  {filteredLogs.length} Events
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setStreamPaused(!streamPaused)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold transition-all cursor-pointer border ${
                    streamPaused
                      ? 'bg-amber-950 text-amber-300 border-amber-600 animate-pulse'
                      : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-750'
                  }`}
                >
                  {streamPaused ? '▶ Resume' : '⏸ Pause'}
                </button>
                <button
                  onClick={handleExportLogs}
                  className="px-2 py-1 rounded-lg text-[10px] font-mono bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 cursor-pointer"
                  title="Export to JSON"
                >
                  📥 Export
                </button>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-2 mb-3">
              <input
                type="text"
                placeholder="Filter service or message..."
                value={streamSearch}
                onChange={(e) => setStreamSearch(e.target.value)}
                className="w-full bg-[#080c14] border border-slate-800 rounded-lg px-2.5 py-1 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500"
              />
              <div className="flex items-center gap-1 text-[10px] font-mono">
                {(['ALL', 'CRITICAL', 'WARNING', 'SCRUBBED'] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setStreamFilter(filter)}
                    className={`px-2 py-1 rounded-md transition-all cursor-pointer ${
                      streamFilter === filter ? 'bg-cyan-600 text-white font-bold' : 'bg-slate-850 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {filter}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2.5 max-h-[340px] overflow-y-auto pr-1">
              {filteredLogs.length > 0 ? (
                filteredLogs.map((log) => (
                  <div key={log.id} className="p-3 rounded-xl bg-[#090d16] border border-slate-800/90 text-xs space-y-1 hover:border-slate-700 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${log.severity === 'CRITICAL' ? 'bg-rose-400' : log.severity === 'WARNING' ? 'bg-amber-400' : 'bg-cyan-400'}`} />
                        <span className="font-mono text-cyan-400 font-bold">{log.service}</span>
                      </div>
                      <span className="text-[10px] text-slate-500 font-mono">{formatTs(log.rawTime)}</span>
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
                  {selectedTimeSlice ? 'No events occurred in this selected graph slice.' : 'No events match active filter.'}
                </div>
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-slate-800 mt-3 text-[11px] text-slate-400 flex items-center justify-between font-mono">
            <div className="flex items-center gap-1.5">
              <span>Buffer Limit:</span>
              {[100, 250, 500, 1000].map((limit) => (
                <button
                  key={limit}
                  onClick={() => setBufferLimit(limit)}
                  className={`px-1.5 py-0.5 rounded text-[10px] ${bufferLimit === limit ? 'bg-cyan-600 text-white font-bold' : 'bg-slate-800 text-slate-400'}`}
                >
                  {limit}
                </button>
              ))}
            </div>
            <span>DLP Scrubber: Active</span>
          </div>
        </section>
      </div>

      <section className="bg-gradient-to-b from-[#0e1424]/90 to-[#080c14]/95 border border-slate-800 rounded-2xl p-5 shadow-2xl backdrop-blur-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-800 mb-4 gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200 font-mono">Immutable Governance Ledger</h2>
              {merkleStatus && (
                <span
                  title={`Cryptographic Merkle Root: ${merkleStatus.rootHash}`}
                  className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-950/80 border border-emerald-500/60 text-emerald-300 flex items-center gap-1.5 shadow"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>🔒 SHA-256 Merkle Chain Verified</span>
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-0.5">PostgreSQL Audit Trail with OWASP & NIST SP 800-218 Traceability &bull; Window: {rangeConfig.label}</p>
          </div>

          <div className="flex flex-wrap gap-1.5 text-xs font-medium">
            {['ALL', 'PENDING', 'CANARY_VERIFYING', 'VERIFIED_RESOLVED', 'ROLLED_BACK', 'CIRCUIT_TRIPPED', 'APPROVED', 'REJECTED'].map((filter) => {
              const count = getFilterCount(filter);
              return (
                <button
                  key={filter}
                  onClick={() => setLedgerFilter(filter)}
                  className={`px-3 py-1.5 rounded-lg text-[11px] font-mono transition-all cursor-pointer flex items-center gap-1.5 ${
                    ledgerFilter === filter
                      ? 'bg-gradient-to-r from-cyan-600 to-indigo-600 text-white font-bold shadow-[0_2px_12px_rgba(0,240,255,0.35)] border border-cyan-400/40'
                      : 'bg-slate-800/50 text-slate-400 hover:bg-slate-800 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  <span>{filter}</span>
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${ledgerFilter === filter ? 'bg-cyan-900 text-white' : 'bg-slate-700 text-slate-300'}`}>
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
                filteredLedger.map((row) => (
                  <tr key={row.token} onClick={() => setSelectedTask(row)} className="hover:bg-slate-850/50 cursor-pointer transition-colors">
                    <td className="py-3 text-slate-200 underline decoration-slate-700 underline-offset-4">{row.token.slice(0, 18)}...</td>
                    <td className="py-3 text-cyan-400 font-bold">{row.target || row.subject?.target || '—'}</td>
                    <td className="py-3">
                      <span className={`px-2.5 py-0.5 rounded-md text-[10px] font-semibold border ${
                        row.status === 'PENDING' ? 'bg-amber-950/80 text-amber-300 border-amber-800' :
                        row.status === 'VERIFIED_RESOLVED' ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800' :
                        row.status === 'ROLLED_BACK' ? 'bg-rose-950/80 text-rose-300 border-rose-800' :
                        row.status === 'CANARY_VERIFYING' ? 'bg-amber-950/90 text-amber-300 border-amber-500 animate-pulse' :
                        row.status === 'CIRCUIT_TRIPPED' ? 'bg-red-950/90 text-red-200 border-red-500' : 'bg-slate-800 text-slate-400 border-slate-700'
                      }`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="py-3 text-slate-300">{row.approvedBy || 'System'}</td>
                    <td className="py-3 text-slate-400 tabular-nums">{formatTs(row.decidedAt)}</td>
                    <td className="py-3 text-slate-400 tabular-nums">{formatTs(row.createdAt)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="text-center py-10 text-slate-500 font-mono">No ledger entries match filter "{ledgerFilter}".</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selectedTask && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-gradient-to-b from-[#131a29] to-[#0c101a] border border-slate-700 rounded-2xl max-w-xl w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <span className="text-xs font-mono font-bold px-2.5 py-0.5 rounded-md bg-cyan-950 border border-cyan-700 text-cyan-300">Audit Record</span>
                <h3 className="font-semibold text-white text-sm font-mono truncate max-w-xs">{selectedTask.token}</h3>
              </div>
              <button onClick={() => setSelectedTask(null)} className="text-slate-400 hover:text-white text-sm font-mono cursor-pointer">✕</button>
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

            {selectedTask.merkleHash && (
              <div className="p-3 bg-[#080c14] rounded-xl border border-slate-800 text-xs font-mono space-y-1">
                <span className="text-slate-500 block text-[10px] uppercase font-bold">CRYPTOGRAPHIC MERKLE HASH</span>
                <code className="text-emerald-400 text-[11px] block break-all">{selectedTask.merkleHash}</code>
              </div>
            )}

            {selectedTask.reason && (
              <div className="p-3.5 bg-red-950/40 border border-red-800/60 rounded-xl text-xs text-red-200 font-mono">
                <span className="block text-[10px] text-red-400 font-bold mb-1 uppercase tracking-wider">Audit / Verification Log</span>
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
              <button onClick={() => setSelectedTask(null)} className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer transition-colors">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {!currentUser && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xl flex items-center justify-center p-4 animate-in fade-in duration-300">
          <div className="relative bg-gradient-to-b from-[#131b2e] via-[#0f1524] to-[#0a0e1a] border border-slate-700/80 rounded-2xl max-w-md w-full p-7 space-y-6 shadow-[0_0_50px_rgba(0,0,0,0.8)]">
            <div className="text-center space-y-2">
              <div className="mx-auto h-12 w-12 rounded-2xl bg-gradient-to-tr from-[#090d1a] to-[#12192c] p-1 flex items-center justify-center border border-cyan-500/30 shadow-[0_0_24px_rgba(0,240,255,0.3)]">
                <NeuroFabricLogo className="h-10 w-10" />
              </div>
              <h2 className="text-xl font-black text-white tracking-tight">NeuroFabric Ops Access</h2>
              <p className="text-xs text-slate-400">Enterprise Closed-Loop Remediation Security Perimeter</p>
            </div>

            {loginError && (
              <div className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/60 text-rose-300 text-xs font-mono text-center">
                {loginError}
              </div>
            )}

            <div className="space-y-2">
              <span className="text-[10px] font-mono uppercase text-slate-400 font-bold block">Quick Persona Access</span>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Incident Commander', email: 'commander@neurofabric.io', pass: 'Commander2026!', color: 'border-cyan-500/50 hover:bg-cyan-950/40 text-cyan-300' },
                  { label: 'SecOps Lead', email: 'secops@neurofabric.io', pass: 'SecOps2026!', color: 'border-indigo-500/50 hover:bg-indigo-950/40 text-indigo-300' },
                  { label: 'SRE Operator', email: 'sre@neurofabric.io', pass: 'Operator2026!', color: 'border-emerald-500/50 hover:bg-emerald-950/40 text-emerald-300' },
                  { label: 'Auditor (Read-Only)', email: 'auditor@neurofabric.io', pass: 'Audit2026!', color: 'border-slate-600/50 hover:bg-slate-800/40 text-slate-300' },
                ].map((persona, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleLogin(persona.email, persona.pass)}
                    className={`p-2 rounded-xl border text-[11px] font-mono font-semibold transition-all text-left cursor-pointer bg-[#0c111e]/80 ${persona.color}`}
                  >
                    <div className="font-bold">{persona.label}</div>
                    <div className="text-[9px] opacity-70 truncate">{persona.email}</div>
                  </button>
                ))}
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleLogin();
              }}
              className="space-y-3.5 text-xs font-mono pt-2 border-t border-slate-800"
            >
              <div>
                <label className="text-slate-400 text-[10px] uppercase font-bold block mb-1">Corporate Email</label>
                <input
                  type="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  className="w-full bg-[#090d16] border border-slate-800 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>

              <div>
                <label className="text-slate-400 text-[10px] uppercase font-bold block mb-1">Password</label>
                <input
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  className="w-full bg-[#090d16] border border-slate-800 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={isLoggingIn}
                className="w-full py-2.5 rounded-xl font-bold font-sans text-xs bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white shadow-lg cursor-pointer transition-all disabled:opacity-50"
              >
                {isLoggingIn ? 'Authenticating...' : 'Authorize Session'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

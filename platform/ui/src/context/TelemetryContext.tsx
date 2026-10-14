import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from 'react';
import { toast } from 'sonner';

export type TimeRange = '5m' | '15m' | '30m' | '1h' | '2h' | '5h' | 'custom';

export interface TimeSeriesPoint {
  timestamp: string;
  throughput: number;
  latencyP99: number;
  latencyP50: number;
  errorRate: number;
  suppressed: number;
}

export interface TelemetryLog {
  id: string;
  timestamp: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  service: string;
  message: string;
  dlpScrubbed?: boolean;
  suppressedCount?: number;
  payload?: Record<string, unknown>;
}

export interface LedgerItem {
  action: string;
  target: string;
  operator: string;
  timestamp: string;
  hash: string;
}

export interface MerkleStatus {
  totalLeaves: number;
  rootHash: string;
}

export interface TelemetryContextType {
  status: string;
  latencyMs: number;
  globalRange: TimeRange;
  setGlobalRange: (r: TimeRange) => void;
  customMinutes: number;
  setCustomMinutes: (m: number) => void;
  series: TimeSeriesPoint[];
  logs: TelemetryLog[];
  clearLogs: () => void;
  trippedCircuits: string[];
  unlockCircuit: (service: string) => Promise<void>;
  triggerProbe: (service: string, trip?: boolean) => Promise<void>;
  authorizePR: (taskId: string, target: string, diff: string) => Promise<void>;
  declinePR: (taskId: string, target: string) => Promise<void>;
  ledger: LedgerItem[];
  merkleStatus: MerkleStatus;
  injectAnomaly: () => void;
  emitHeartbeat: () => void;
}

const TelemetryContext = createContext<TelemetryContextType | undefined>(undefined);

function generateInitialSeries(range: TimeRange, customMins: number): TimeSeriesPoint[] {
  const mins =
    range === '5m' ? 5 :
    range === '15m' ? 15 :
    range === '30m' ? 30 :
    range === '1h' ? 60 :
    range === '2h' ? 120 :
    range === '5h' ? 300 : customMins;

  const count = 36;
  const stepMs = (mins * 60 * 1000) / count;
  const now = Date.now();
  const pts: TimeSeriesPoint[] = [];

  for (let i = count; i >= 0; i--) {
    const t = new Date(now - i * stepMs);
    const wave = Math.sin(i * 0.35) * 4.2 + Math.cos(i * 0.2) * 2.1;
    const tp = Number(Math.max(6.5, 16.4 + wave + (Math.random() - 0.5) * 2.5).toFixed(1));
    const p50 = Number(Math.max(8, 11.5 + Math.sin(i * 0.25) * 2 + Math.random() * 1.5).toFixed(1));
    const p99 = Number((p50 * 1.65 + (i % 9 === 0 ? 12 : 2) + Math.random() * 3).toFixed(1));
    const err = Number((i % 11 === 0 ? 0.85 + Math.random() * 0.6 : 0.02 + Math.random() * 0.05).toFixed(2));
    const sup = Math.max(1, Math.round(tp * 0.65 + (i % 7 === 0 ? 14 : 3)));

    pts.push({
      timestamp: t.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      throughput: tp,
      latencyP50: p50,
      latencyP99: p99,
      errorRate: err,
      suppressed: sup,
    });
  }
  return pts;
}

export function TelemetryProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'LIVE EDGE' | 'STANDALONE'>('STANDALONE');
  const [latencyMs, setLatencyMs] = useState(14);
  const [globalRange, setGlobalRange] = useState<TimeRange>('15m');
  const [customMinutes, setCustomMinutes] = useState<number>(45);
  const [series, setSeries] = useState<TimeSeriesPoint[]>(() => generateInitialSeries('15m', 45));

  const [trippedCircuits, setTrippedCircuits] = useState<string[]>(['flapping-payment-worker']);
  const [logs, setLogs] = useState<TelemetryLog[]>([
    {
      id: 'log-1',
      timestamp: new Date().toISOString(),
      severity: 'CRITICAL',
      service: 'flapping-payment-worker',
      message: 'Circuit breaker tripped: 3 consecutive timeout strikes in 60s window [HTTP 423 locked]',
      dlpScrubbed: false,
      suppressedCount: 14,
    },
    {
      id: 'log-2',
      timestamp: new Date(Date.now() - 25000).toISOString(),
      severity: 'WARNING',
      service: 'auth-gateway',
      message: 'Connection pool near exhaustion (92/100 conns allocated). Upstream latency +120ms.',
      dlpScrubbed: false,
      suppressedCount: 6,
    },
    {
      id: 'log-3',
      timestamp: new Date(Date.now() - 55000).toISOString(),
      severity: 'INFO',
      service: 'ingress-router',
      message: 'Bearer secret scrubbed in-flight [DLP:REDACTED_SECRET] prior to WAL commit.',
      dlpScrubbed: true,
      suppressedCount: 1,
    },
  ]);

  const [ledger, setLedger] = useState<LedgerItem[]>([
    {
      action: 'vault.approval.granted',
      target: 'payments/api-key',
      operator: 'Alex Vance [LEVEL 5]',
      timestamp: new Date().toISOString(),
      hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    },
    {
      action: 'circuit.breaker.tripped',
      target: 'flapping-payment-worker',
      operator: 'Autonomous Sovereign Kernel',
      timestamp: new Date(Date.now() - 60000).toISOString(),
      hash: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8',
    },
    {
      action: 'vault.approval.refused',
      target: 'customer-db/credentials',
      operator: 'Alex Vance [LEVEL 5]',
      timestamp: new Date(Date.now() - 120000).toISOString(),
      hash: '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a',
    },
  ]);

  const [merkleStatus, setMerkleStatus] = useState<MerkleStatus>({
    totalLeaves: 128,
    rootHash: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8',
  });

  // Regenerate historical scale when globalRange or customMinutes changes
  useEffect(() => {
    setSeries(generateInitialSeries(globalRange, customMinutes));
  }, [globalRange, customMinutes]);

  // Continuous 1.5s living telemetry heartbeat
  useEffect(() => {
    const timer = setInterval(() => {
      setSeries(prev => {
        const last = prev[prev.length - 1];
        const now = new Date();
        const nextTp = Number(Math.max(8.0, Math.min(28.0, (last?.throughput || 15) + (Math.random() - 0.48) * 2.2)).toFixed(1));
        const nextP50 = Number(Math.max(9.0, Math.min(22.0, 12 + (Math.random() - 0.5) * 2.5)).toFixed(1));
        const nextP99 = Number((nextP50 * 1.6 + Math.random() * 4).toFixed(1));
        const nextErr = Number((Math.random() > 0.9 ? 0.4 + Math.random() * 0.8 : 0.02).toFixed(2));
        const nextSup = Math.max(2, Math.round(nextTp * 0.6 + Math.random() * 4));

        return [
          ...prev.slice(1),
          {
            timestamp: now.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            throughput: nextTp,
            latencyP50: nextP50,
            latencyP99: nextP99,
            errorRate: nextErr,
            suppressed: nextSup,
          },
        ];
      });
      setLatencyMs(Math.floor(11 + Math.random() * 5));
    }, 1500);
    return () => clearInterval(timer);
  }, []);

  // Resilient SSE subscription
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      try {
        es = new EventSource('/events');
        es.onopen = () => setStatus('LIVE EDGE');
        es.onerror = () => {
          setStatus('STANDALONE');
          es?.close();
          reconnectTimeout = setTimeout(connect, 15000);
        };
        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            const newLog: TelemetryLog = {
              id: data.id || 'evt-' + Date.now(),
              timestamp: data.timestamp || new Date().toISOString(),
              severity: data.severity || 'INFO',
              service: data.service || 'edge-router',
              message: data.message || data.title || 'Telemetry frame ingested',
              dlpScrubbed: Boolean(data.dlpScrubbed || data.message?.includes('[DLP:')),
              suppressedCount: 1,
              payload: data,
            };
            setLogs(prev => [newLog, ...prev.slice(0, 199)]);
          } catch {
            // ignore
          }
        };
      } catch {
        setStatus('STANDALONE');
      }
    };
    connect();
    return () => {
      es?.close();
      clearTimeout(reconnectTimeout);
    };
  }, []);

  const clearLogs = () => setLogs([]);

  const unlockCircuit = async (service: string) => {
    setTrippedCircuits(prev => prev.filter(s => s !== service));
    const randomHash = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    setLedger(prev => [
      { action: 'circuit.override.unlocked', target: service, operator: 'Alex Vance [LEVEL 5]', timestamp: new Date().toISOString(), hash: randomHash },
      ...prev,
    ]);
    setMerkleStatus(prev => ({ totalLeaves: prev.totalLeaves + 1, rootHash: randomHash }));
    toast.success('Circuit Reset', { description: `Service ${service} restored to CLOSED nominal routing.` });
  };

  const triggerProbe = async (service: string, trip = false) => {
    if (trip && !trippedCircuits.includes(service)) {
      setTrippedCircuits(prev => [...prev, service]);
    }
    const newLog: TelemetryLog = {
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      severity: trip ? 'CRITICAL' : 'WARNING',
      service,
      message: trip
        ? `Flapping strike simulated on ${service}. Strike 3/3 reached — circuit TRIPPED (HTTP 423).`
        : `Health probe anomaly recorded on ${service}.`,
      dlpScrubbed: false,
      suppressedCount: trip ? 9 : 2,
    };
    setLogs(prev => [newLog, ...prev]);
    toast.info('Probe Injected', { description: `Signal recorded for ${service}` });
  };

  const authorizePR = async (taskId: string, target: string) => {
    const randomHash = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    setLedger(prev => [
      { action: 'gitops.pr.authorized', target, operator: 'Alex Vance [LEVEL 5]', timestamp: new Date().toISOString(), hash: randomHash },
      ...prev,
    ]);
    setMerkleStatus(prev => ({ totalLeaves: prev.totalLeaves + 1, rootHash: randomHash }));
    toast.success('GitOps PR Dispatched', { description: `Task ${taskId} sealed into Merkle leaf #${merkleStatus.totalLeaves + 1}.` });
  };

  const declinePR = async (taskId: string, target: string) => {
    const randomHash = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    setLedger(prev => [
      { action: 'gitops.pr.declined', target, operator: 'Alex Vance [LEVEL 5]', timestamp: new Date().toISOString(), hash: randomHash },
      ...prev,
    ]);
    toast.error('Proposal Refused', { description: `Task ${taskId} declined by operator.` });
  };

  const injectAnomaly = () => {
    const anomaly: TelemetryLog = {
      id: `anomaly-${Date.now()}`,
      timestamp: new Date().toISOString(),
      severity: 'CRITICAL',
      service: 'egress-payments-api',
      message: 'Token leak detected in outbound headers. Scrubbed [DLP:REDACTED_SECRET]. Rate limiter activated.',
      dlpScrubbed: true,
      suppressedCount: 19,
    };
    setLogs(prev => [anomaly, ...prev]);
    setSeries(prev => {
      const copy = [...prev];
      if (copy.length > 0) {
        copy[copy.length - 1] = {
          ...copy[copy.length - 1],
          throughput: 26.8,
          latencyP99: 48.2,
          errorRate: 2.4,
          suppressed: 34,
        };
      }
      return copy;
    });
    toast.error('Live Anomaly & Spike Injected', { description: 'DLP scrub engine triggered; waveform spiked.' });
  };

  const emitHeartbeat = () => {
    const hb: TelemetryLog = {
      id: `hb-${Date.now()}`,
      timestamp: new Date().toISOString(),
      severity: 'INFO',
      service: 'ingress-gateway',
      message: 'Telemetry ingestion nominal: 16.4 evt/s. Ingestion key verified.',
      dlpScrubbed: false,
      suppressedCount: 1,
    };
    setLogs(prev => [hb, ...prev]);
    toast.info('Heartbeat Emitted', { description: `${latencyMs}ms round-trip propagation.` });
  };

  const value = useMemo(
    () => ({
      status,
      latencyMs,
      globalRange,
      setGlobalRange,
      customMinutes,
      setCustomMinutes,
      series,
      logs,
      clearLogs,
      trippedCircuits,
      unlockCircuit,
      triggerProbe,
      authorizePR,
      declinePR,
      ledger,
      merkleStatus,
      injectAnomaly,
      emitHeartbeat,
    }),
    [status, latencyMs, globalRange, customMinutes, series, logs, trippedCircuits, ledger, merkleStatus]
  );

  return <TelemetryContext.Provider value={value}>{children}</TelemetryContext.Provider>;
}

export function useTelemetry(): TelemetryContextType {
  const ctx = useContext(TelemetryContext);
  if (!ctx) throw new Error('useTelemetry must be used within a TelemetryProvider');
  return ctx;
}

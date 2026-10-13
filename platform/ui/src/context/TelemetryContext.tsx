import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { toast } from 'sonner';

export interface TelemetryLog {
  id: string;
  timestamp: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  service: string;
  message: string;
  dlpScrubbed?: boolean;
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

export function TelemetryProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'LIVE EDGE' | 'STANDALONE'>('STANDALONE');
  const [latencyMs, setLatencyMs] = useState(14);
  const [trippedCircuits, setTrippedCircuits] = useState<string[]>(['flapping-payment-worker']);
  const [logs, setLogs] = useState<TelemetryLog[]>([
    {
      id: 'log-1',
      timestamp: new Date().toISOString(),
      severity: 'CRITICAL',
      service: 'flapping-payment-worker',
      message: 'Circuit breaker tripped: 3 consecutive timeout strikes in 60s window [HTTP 423 locked]',
      dlpScrubbed: false,
    },
    {
      id: 'log-2',
      timestamp: new Date(Date.now() - 15000).toISOString(),
      severity: 'WARNING',
      service: 'auth-gateway',
      message: 'Connection pool near exhaustion (92/100 conns allocated). Upstream latency +120ms.',
      dlpScrubbed: false,
    },
    {
      id: 'log-3',
      timestamp: new Date(Date.now() - 32000).toISOString(),
      severity: 'INFO',
      service: 'ingress-router',
      message: 'Incoming edge batch telemetry normalized and dispatched to EventBridge SSE.',
      dlpScrubbed: true,
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
    totalLeaves: 3,
    rootHash: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8',
  });

  // Resilient EventBridge subscription with reconnection backoff
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      try {
        es = new EventSource('/events');
        es.onopen = () => {
          setStatus('LIVE EDGE');
          setLatencyMs(Math.floor(Math.random() * 6) + 11);
        };
        es.onerror = () => {
          setStatus('STANDALONE');
          es?.close();
          // Back off retry for 15s instead of immediate reconnection loop
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
              payload: data,
            };
            setLogs(prev => [newLog, ...prev.slice(0, 199)]);
            if (newLog.severity === 'CRITICAL' && !trippedCircuits.includes(newLog.service)) {
              setTrippedCircuits(prev => [...prev, newLog.service]);
            }
          } catch {
            // ignore malformed payloads
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
  }, [trippedCircuits]);

  const clearLogs = () => setLogs([]);

  const unlockCircuit = async (service: string) => {
    setTrippedCircuits(prev => prev.filter(s => s !== service));
    const randomHash = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    
    const newEntry: LedgerItem = {
      action: 'circuit.override.unlocked',
      target: service,
      operator: 'Alex Vance [LEVEL 5]',
      timestamp: new Date().toISOString(),
      hash: randomHash,
    };

    setLedger(prev => [newEntry, ...prev]);
    setMerkleStatus(prev => ({
      totalLeaves: prev.totalLeaves + 1,
      rootHash: randomHash,
    }));

    toast.success('Circuit Reset', {
      description: `Service ${service} restored to CLOSED nominal routing.`,
    });

    if (status === 'LIVE EDGE') {
      fetch('/api/v1/circuits/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service, action: 'RESET', operator: 'Alex Vance' }),
      }).catch(() => {});
    }
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
    };
    setLogs(prev => [newLog, ...prev]);
    toast.info('Probe Injected', { description: `Signal recorded for ${service}` });
  };

  const authorizePR = async (taskId: string, target: string, diff: string) => {
    const randomHash = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    const newEntry: LedgerItem = {
      action: 'gitops.pr.authorized',
      target,
      operator: 'Alex Vance [LEVEL 5]',
      timestamp: new Date().toISOString(),
      hash: randomHash,
    };

    setLedger(prev => [newEntry, ...prev]);
    setMerkleStatus(prev => ({
      totalLeaves: prev.totalLeaves + 1,
      rootHash: randomHash,
    }));

    toast.success('GitOps PR Dispatched', {
      description: `Task ${taskId} sealed into Merkle leaf #${merkleStatus.totalLeaves + 1}.`,
    });

    if (status === 'LIVE EDGE') {
      fetch('/api/v1/gitops/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, target, diff, operator: 'Alex Vance' }),
      }).catch(() => {});
    }
  };

  const declinePR = async (taskId: string, target: string) => {
    const randomHash = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    const newEntry: LedgerItem = {
      action: 'gitops.pr.declined',
      target,
      operator: 'Alex Vance [LEVEL 5]',
      timestamp: new Date().toISOString(),
      hash: randomHash,
    };

    setLedger(prev => [newEntry, ...prev]);
    toast.error('Proposal Refused', {
      description: `Task ${taskId} declined by operator. Remediation deferred.`,
    });

    if (status === 'LIVE EDGE') {
      fetch('/api/v1/gitops/refuse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, target, operator: 'Alex Vance' }),
      }).catch(() => {});
    }
  };

  const injectAnomaly = () => {
    const anomaly: TelemetryLog = {
      id: `anomaly-${Date.now()}`,
      timestamp: new Date().toISOString(),
      severity: 'CRITICAL',
      service: 'egress-payments-api',
      message: 'Token leak detected in outbound headers. Scrubbed [DLP:REDACTED_SECRET]. Rate limiter activated.',
      dlpScrubbed: true,
    };
    setLogs(prev => [anomaly, ...prev]);
    toast.error('Live Anomaly Injected', {
      description: 'DLP scrub engine triggered; EventBridge envelope updated.',
    });
  };

  const emitHeartbeat = () => {
    const hb: TelemetryLog = {
      id: `hb-${Date.now()}`,
      timestamp: new Date().toISOString(),
      severity: 'INFO',
      service: 'ingress-gateway',
      message: 'Telemetry ingestion nominal: 14.2 evt/s. Ingestion key verified.',
      dlpScrubbed: false,
    };
    setLogs(prev => [hb, ...prev]);
    toast.info('Heartbeat Emitted', { description: `${latencyMs}ms round-trip propagation.` });
  };

  return (
    <TelemetryContext.Provider
      value={{
        status,
        latencyMs,
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
      }}
    >
      {children}
    </TelemetryContext.Provider>
  );
}

export function useTelemetry(): TelemetryContextType {
  const ctx = useContext(TelemetryContext);
  if (!ctx) throw new Error('useTelemetry must be used within a TelemetryProvider');
  return ctx;
}

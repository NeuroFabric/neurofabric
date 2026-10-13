import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import { ENV } from '../config/env';
import { api, type TelemetryLog, type TimeseriesPoint, type VerifyLedgerResponse } from '../api/client';

export const ConnectionStatus = {
  Connected: 'Connected',
  Reconnecting: 'Reconnecting',
  Disconnected: 'Disconnected',
} as const;
export type ConnectionStatus = (typeof ConnectionStatus)[keyof typeof ConnectionStatus];

interface TelemetryContextType {
  status: ConnectionStatus;
  logs: TelemetryLog[];
  timeseries: TimeseriesPoint[];
  merkleStatus: VerifyLedgerResponse | null;
  ledger: any[];
  trippedCircuits: string[];
  triggerProbe: (service: string, isCritical?: boolean) => Promise<void>;
  authorizePR: (taskId: string, target: string, diff: string) => Promise<void>;
  declinePR: (taskId: string, target: string) => Promise<void>;
  unlockCircuit: (service: string) => Promise<void>;
}

const TelemetryContext = createContext<TelemetryContextType | null>(null);

export function TelemetryProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.Reconnecting);
  const [logs, setLogs] = useState<TelemetryLog[]>([]);
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[]>([]);
  const [merkleStatus, setMerkleStatus] = useState<VerifyLedgerResponse | null>(null);
  const [ledger, setLedger] = useState<any[]>([]);
  const [trippedCircuits, setTrippedCircuits] = useState<string[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Poll metrics & ledger data
  const refreshMetrics = useCallback(async () => {
    try {
      const tsRes = await api.fetchTimeseries('5M');
      if (Array.isArray(tsRes.points)) setTimeseries(tsRes.points);
    } catch {}

    try {
      const vRes = await api.verifyLedger();
      setMerkleStatus(vRes);
    } catch {}

    try {
      const lRes = await api.fetchLedger();
      if (Array.isArray(lRes)) setLedger(lRes);
    } catch {}
  }, []);

  useEffect(() => {
    refreshMetrics();
    const interval = setInterval(refreshMetrics, 6000);
    return () => clearInterval(interval);
  }, [refreshMetrics]);

  // Connect Server-Sent Events (SSE)
  useEffect(() => {
    let active = true;

    function connectSSE() {
      if (eventSourceRef.current) eventSourceRef.current.close();
      const es = new EventSource(`${ENV.API_URL}/api/v1/events`);
      eventSourceRef.current = es;

      es.onopen = () => {
        if (active) setStatus(ConnectionStatus.Connected);
      };

      es.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.service) {
            setLogs((prev) => [payload, ...prev.slice(0, 199)]);
            if (payload.severity === 'CRITICAL') {
              setTrippedCircuits((prev) => Array.from(new Set([...prev, payload.service])));
            }
          }
        } catch {}
      };

      es.onerror = () => {
        if (active) {
          setStatus(ConnectionStatus.Reconnecting);
          es.close();
          setTimeout(connectSSE, 5000);
        }
      };
    }

    connectSSE();
    return () => {
      active = false;
      eventSourceRef.current?.close();
    };
  }, []);

  const triggerProbe = async (service: string, isCritical = false) => {
    const secrets = [
      'Bearer sk-live-99238410293840192830',
      'ghp_Abcdef1234567890abcdef1234567890',
      'AKIAIOSFODNN7EXAMPLE',
    ];
    const secret = secrets[Math.floor(Math.random() * secrets.length)];
    const msg = isCritical
      ? `Fatal pipeline exception with leaked credential: ${secret}`
      : `Standard telemetry heartbeat probe: ${Date.now()}`;

    await api.ingestTelemetry(service, isCritical ? 'CRITICAL' : 'INFO', msg);
    await refreshMetrics();
  };

  const authorizePR = async (taskId: string, target: string, diff: string) => {
    await api.submitDecision(taskId, target, true, diff);
    await refreshMetrics();
  };

  const declinePR = async (taskId: string, target: string) => {
    await api.submitDecision(taskId, target, false);
    await refreshMetrics();
  };

  const unlockCircuit = async (service: string) => {
    await api.resetBreaker(service);
    setTrippedCircuits((prev) => prev.filter((s) => s !== service));
    await refreshMetrics();
  };

  return (
    <TelemetryContext.Provider
      value={{
        status,
        logs,
        timeseries,
        merkleStatus,
        ledger,
        trippedCircuits,
        triggerProbe,
        authorizePR,
        declinePR,
        unlockCircuit,
      }}
    >
      {children}
    </TelemetryContext.Provider>
  );
}

export function useTelemetry() {
  const ctx = useContext(TelemetryContext);
  if (!ctx) throw new Error('useTelemetry must be used within TelemetryProvider');
  return ctx;
}

import { ENV } from '../config/env';

export async function apiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${ENV.API_URL}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  const headers = new Headers(options.headers || {});
  
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!headers.has('x-ingest-key')) headers.set('x-ingest-key', ENV.INGESTION_KEY);
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${ENV.COMMAND_TOKEN}`);

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    let errBody = '';
    try { errBody = await res.text(); } catch {}
    throw new Error(`HTTP ${res.status}: ${errBody || res.statusText}`);
  }
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

export interface TimeseriesPoint {
  timestamp: string;
  velocity?: number;
  throughput?: number;
  p50?: number;
  p95?: number;
  p99?: number;
  errorRate?: number;
  slaBudget?: number;
  suppressed?: number;
  [key: string]: any;
}

export interface TelemetryLog {
  id: string;
  service: string;
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  message: string;
  timestamp: string;
  dlpScrubbed?: boolean;
}

export interface VerifyLedgerResponse {
  status: string;
  valid?: boolean;
  totalLeaves?: number;
  rootHash: string;
  lastVerifiedAt?: string;
  frameworks?: string[];
}

export const api = {
  fetchTimeseries: (range = '5M') => 
    apiRequest<{ range: string; points: TimeseriesPoint[]; summary?: any }>(`/api/v1/metrics/timeseries?range=${range}`),
  
  verifyLedger: () => 
    apiRequest<VerifyLedgerResponse>('/api/v1/governance/verify-ledger'),

  fetchLedger: () => 
    apiRequest<any[]>('/api/v1/governance/ledger').catch(() => []),

  fetchRecentLogs: () => 
    apiRequest<TelemetryLog[]>('/api/v1/workspace/recent-logs').catch(() => []),

  ingestTelemetry: (service: string, severity: 'INFO' | 'CRITICAL', message: string) =>
    apiRequest<{ status: string; suppressed?: boolean }>('/api/v1/workspace/ingest', {
      method: 'POST',
      body: JSON.stringify({ service, severity, message }),
    }),

  submitDecision: (taskId: string, target: string, approved: boolean, diff?: string) =>
    apiRequest<{ success: boolean }>('/api/v1/embassy/decisions', {
      method: 'POST',
      body: JSON.stringify({ taskId, target, approved, diff }),
    }),

  resetBreaker: (target: string) =>
    apiRequest<{ success: boolean; target: string }>('/api/v1/embassy/reset-breaker', {
      method: 'POST',
      body: JSON.stringify({ target }),
    }),
};

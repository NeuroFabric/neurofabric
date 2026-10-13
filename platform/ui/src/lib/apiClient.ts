/**
 * Centralized API Client for NeuroFabric UI
 * Eliminates hardcoded URLs and provides unified request handling
 */

const INGESTION_KEY = 'nf-edge-telemetry-token-2026';

/**
 * Dynamically determines the API base URL based on environment
 * - VITE_API_URL / VITE_BACKEND_URL for explicit configuration
 * - Auto-detects Render deployment for production
 * - Falls back to localhost:10000 for local development
 */
export const API_BASE = (() => {
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL.replace(/\/$/, '');
  if (import.meta.env.VITE_BACKEND_URL) return import.meta.env.VITE_BACKEND_URL.replace(/\/$/, '');
  if (typeof window !== 'undefined' && window.location.hostname.includes('onrender.com')) {
    return 'https://neurofabric-backend.onrender.com';
  }
  return 'http://127.0.0.1:10000';
})();

/**
 * Builds a full URL for an API endpoint
 */
function buildUrl(endpoint: string): string {
  return `${API_BASE}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
}

/**
 * Default headers for all API requests
 */
function defaultHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Ingest-Key': INGESTION_KEY,
    ...extra,
  };
}

/**
 * Parses JSON response with proper error handling
 */
async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`API returned empty response (HTTP ${response.status})`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`API returned invalid JSON (HTTP ${response.status})`);
  }
}

/**
 * Generic GET request
 */
export async function apiGet<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
  const url = buildUrl(endpoint);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: defaultHeaders(init.headers as Record<string, string>),
      cache: 'no-store',
      ...init,
    });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'Failed to fetch'}`);
  }
  const result = await parseJson<T>(response);
  if (!response.ok) {
    const error = result as { failure?: { reason?: string }; error?: string };
    throw new Error(error.failure?.reason ?? error.error ?? `Request failed (HTTP ${response.status})`);
  }
  return result;
}

/**
 * Generic POST request
 */
export async function apiPost<T>(endpoint: string, body: unknown, init: RequestInit = {}): Promise<T> {
  const url = buildUrl(endpoint);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: defaultHeaders(init.headers as Record<string, string>),
      body: JSON.stringify(body),
      ...init,
    });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'Failed to fetch'}`);
  }
  const result = await parseJson<T>(response);
  if (!response.ok) {
    const error = result as { failure?: { reason?: string }; error?: string };
    throw new Error(error.failure?.reason ?? error.error ?? `Request failed (HTTP ${response.status})`);
  }
  return result;
}

/**
 * Generic PUT request
 */
export async function apiPut<T>(endpoint: string, body: unknown, init: RequestInit = {}): Promise<T> {
  const url = buildUrl(endpoint);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: defaultHeaders(init.headers as Record<string, string>),
      body: JSON.stringify(body),
      ...init,
    });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'Failed to fetch'}`);
  }
  const result = await parseJson<T>(response);
  if (!response.ok) {
    const error = result as { failure?: { reason?: string }; error?: string };
    throw new Error(error.failure?.reason ?? error.error ?? `Request failed (HTTP ${response.status})`);
  }
  return result;
}

/**
 * Health check endpoint
 */
export async function checkHealth(): Promise<{ status: string; gateway: string; timestamp: string }> {
  return apiGet('/health');
}

/**
 * Telemetry ingestion
 */
export interface IngestPayload {
  service: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  message: string;
}

export async function ingestTelemetry(payload: IngestPayload): Promise<{ status: string; suppressed: number }> {
  return apiPost('/api/v1/workspace/ingest', payload);
}

export async function ingestTelemetryBatch(events: IngestPayload[]): Promise<{ status: string; suppressed: number }> {
  return apiPost('/api/v1/workspace/ingest', { events });
}

/**
 * Recent logs
 */
export interface TelemetryLog {
  id: string;
  rawTime: number;
  service: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  message: string;
  dlpScrubbed?: boolean;
}

export async function fetchRecentLogs(limit = 50): Promise<TelemetryLog[]> {
  return apiGet(`/api/v1/workspace/recent-logs?limit=${limit}`);
}

/**
 * Timeseries metrics
 */
export interface TimeseriesPoint {
  timestamp: string;
  velocity: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;
  slaBudget: number;
  suppressed: number;
}

export interface TimeseriesResponse {
  range: string;
  points: TimeseriesPoint[];
  summary: {
    currentThroughput: number;
    p50: number;
    p95: number;
    errorRate: number;
    slaStatus: string;
  };
}

export async function fetchTimeseries(range: '5M' | '15M' | '1H' | '24H' | 'ALL' = '5M'): Promise<TimeseriesResponse> {
  return apiGet(`/api/v1/metrics/timeseries?range=${range}`);
}

/**
 * Ingestion metrics
 */
export interface IngestionMetrics {
  throughput: number;
  suppressedAlerts: number;
  secretsScrubbed: number;
}

export async function fetchIngestionMetrics(): Promise<IngestionMetrics> {
  return apiGet('/api/v1/metrics/ingestion');
}

/**
 * Recent logs
 */
export async function fetchRecentLogs(limit = 50): Promise<TelemetryLog[]> {
  return apiGet(`/api/v1/workspace/recent-logs?limit=${limit}`);
}

/**
 * Governance ledger
 */
export interface LedgerEntry {
  token: string;
  status: string;
  target?: string | null;
  subject?: unknown;
  decidedAt?: string | null;
  approvedBy?: string | null;
  reason?: string | null;
  createdAt?: string | null;
  createdTimestamp?: number;
  merkleHash?: string;
}

export async function fetchLedger(): Promise<LedgerEntry[]> {
  try {
    const data = await apiGet<any>('/api/v1/governance/ledger');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export interface VerifyLedgerResponse {
  status: 'VERIFIED' | 'FAILED';
  tamperDetected: boolean;
  totalLeaves: number;
  rootHash: string;
  lastVerifiedAt: string;
  complianceFrameworks: string[];
}

export async function verifyLedger(): Promise<VerifyLedgerResponse> {
  return apiGet('/api/v1/governance/verify-ledger');
}

/**
 * Embassy endpoints
 */
export interface DecisionPayload {
  taskId?: string;
  target: string;
  diff?: string;
  decision?: 'APPROVED' | 'REJECTED';
  reviewer?: string;
}

export interface DecisionResponse {
  status: string;
  taskToken: string;
  gitops: { mode: string; branch: string; title: string; committed: boolean };
  rca: { confidence: number; blastRadius: string };
}

export async function submitDecision(payload: DecisionPayload): Promise<DecisionResponse> {
  return apiPost('/api/v1/embassy/decisions', payload);
}

export async function resetBreaker(target: string): Promise<{ success: boolean; target: string }> {
  return apiPost('/api/v1/embassy/reset-breaker', { target });
}

export async function abortCanary(taskId: string, target: string): Promise<{ success: boolean }> {
  return apiPost('/api/v1/embassy/abort-canary', { taskId, target });
}

export async function diagnoseIssue(body: unknown): Promise<{ status: string; report: unknown }> {
  return apiPost('/api/v1/embassy/diagnose', body);
}

/**
 * Authentication
 */
export interface AuthResponse {
  token: string;
  role: 'COMMANDER' | 'AUDITOR';
}

export async function login(username: string, password: string): Promise<AuthResponse> {
  return apiPost('/api/v1/auth/login', { username, password });
}

/**
 * Server-Sent Events connection helper
 * Returns an EventSource that auto-reconnects
 */
export function createEventSource(): EventSource {
  const es = new EventSource(`${API_BASE}/api/v1/events`);
  return es;
}

/**
 * Connection status enum for UI indicator
 */
export enum ConnectionStatus {
  Connected = 'connected',
  Reconnecting = 'reconnecting',
  Disconnected = 'disconnected',
}

/**
 * Hook for managing SSE connection with status tracking
 */
export function useSSEConnection(
  onMessage: (event: MessageEvent) => void,
  onStatusChange?: (status: ConnectionStatus) => void
): { close: () => void } {
  let es: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let currentStatus = ConnectionStatus.Disconnected;

  const setStatus = (status: ConnectionStatus) => {
    if (currentStatus !== status) {
      currentStatus = status;
      onStatusChange?.(status);
    }
  };

  const connect = () => {
    if (es) es.close();
    setStatus(ConnectionStatus.Reconnecting);
    
    es = createEventSource();
    
    es.onopen = () => {
      setStatus(ConnectionStatus.Connected);
    };
    
    es.onmessage = (event) => {
      onMessage(event);
    };
    
    es.onerror = () => {
      setStatus(ConnectionStatus.Reconnecting);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 3000);
    };
  };

  connect();

  return {
    close: () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (es) es.close();
      setStatus(ConnectionStatus.Disconnected);
    },
  };
}
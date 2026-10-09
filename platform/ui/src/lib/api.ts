export type ApprovalLedgerRecord = {
  token: string
  status: string
  subject: unknown
  decidedAt: string | null
  approvedBy: string | null
  reason: string | null
  resultExpiresAt: string | null
  collectedAt: string | null
  createdAt: string | null
}

export type UploadedArtifact = {
  path: string
  name: string
  size: number
  sha256: string
}

export type AnalysisSummary = {
  totalRows: number
  errorRows: number
  errorRate: number
  problems: string[]
  mappings: { role: string; column: string; hypothesis: boolean; note: string }[]
  byHour: { key: string; count: number; errorCount: number; errorRate: number }[]
  latencyBands: { label: string; count: number }[]
  categories: { key: string; count: number; p95Elapsed: number | null }[]
}

export type DashboardTelemetry = {
  samples: { timestamp: string; p99LatencyMs: number; throughputRps: number }[]
  http5xx: { timestamp: string; count: number }[]
}

export type AgentTaskResponse = {
  status?: string
  state?: string
  markdown?: string
  failure?: { code?: string; reason?: string }
  artifacts?: string[]
  analysis?: AnalysisSummary
  telemetry?: DashboardTelemetry
}

export type VerdictResponse = {
  success?: boolean
  task_token?: string
  status?: string
  decided_at?: string
  error?: string
  message?: string
}

export type PatchProposal = {
  patchId: string
  format: 'kubernetes' | 'terraform'
  document: string
  state: 'AWAITING_APPROVAL'
}

export type ApprovalPayload = {
  task_token: string
  status: 'approved' | 'rejected'
}

export type ChatResponse = {
  status?: string
  sessionId?: string
  reply?: { kind: 'answer' | 'correction'; text: string; widgets: unknown[]; suggestions: string[] }
  failure?: { reason?: string }
  error?: string
}

async function responseJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text.trim()) throw new Error(`API returned an empty response (HTTP ${response.status}).`)
  try { return JSON.parse(text) as T } catch {
    throw new Error(`API returned invalid JSON (HTTP ${response.status})`)
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let response: Response
  try { response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
  catch { throw new Error('API is unreachable. Showing local telemetry until the service returns.') }
  const result = await responseJson<T>(response)
  if (!response.ok) throw new Error((result as { failure?: { reason?: string }; error?: string }).failure?.reason ?? (result as { error?: string }).error ?? `Request failed (HTTP ${response.status})`)
  return result
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try { response = await fetch(url, { cache: 'no-store', ...init } as any) }
  catch { throw new Error('API is unreachable. Showing local telemetry until the service returns.') }
  return responseJson<T>(response)
}

export async function fetchTelemetry(): Promise<DashboardTelemetry> {
  return requestJson('/api/v1/telemetry')
}

export async function uploadArtifact(file: File): Promise<UploadedArtifact> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch('/api/v1/workspace/ingest', { method: 'POST', body: form })
  return responseJson(response)
}

export async function executeAnalysis(path: string, message: string): Promise<AgentTaskResponse> {
  return postJson('/api/v1/agent/task', { path, message })
}

export async function fetchLedger(): Promise<ApprovalLedgerRecord[]> {
  try {
    const data = await requestJson<any>('/api/v1/governance/ledger');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function submitVerdict(token: string, status: 'approved' | 'refused'): Promise<VerdictResponse> {
  return postJson('/api/v1/governance/verdict', { task_token: token, status })
}

export async function fetchPatches(): Promise<PatchProposal[]> {
  const response = await fetch('/api/v1/remediation/patches')
  return responseJson(response)
}

export async function submitApproval(task_token: string, status: 'approved' | 'rejected'): Promise<void> {
  await postJson('/api/v1/remediation/approvals', { task_token, status })
}

export async function askNeuroFebric(path: string, message: string, sessionId?: string): Promise<ChatResponse> {
  return postJson('/api/chat', { path, message, sessionId })
}

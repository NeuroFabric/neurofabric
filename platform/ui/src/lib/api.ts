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

export type AgentTaskResponse = {
  status?: string
  state?: string
  markdown?: string
  failure?: { code?: string; reason?: string }
  artifacts?: string[]
  analysis?: AnalysisSummary
  /** Populated only when the backend returns measured telemetry samples. */
  telemetry?: DashboardTelemetry
}

export type DashboardTelemetry = {
  samples: { timestamp: string; p99LatencyMs: number; throughputRps: number }[]
  http5xx: { timestamp: string; count: number }[]
}

export type VerdictResponse = {
  success?: boolean
  task_token?: string
  status?: string
  decided_at?: string
  error?: string
  message?: string
}

async function responseJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text.trim()) throw new Error(`API returned an empty response (HTTP ${response.status}).`)

  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new Error(`API returned invalid JSON (HTTP ${response.status}).`)
  }

  if (!response.ok) {
    const body = value as { error?: unknown; failure?: { reason?: unknown } }
    const message = typeof body?.failure?.reason === 'string'
      ? body.failure.reason
      : typeof body?.error === 'string'
        ? body.error
        : `Request failed (HTTP ${response.status}).`
    throw new Error(message)
  }

  return value as T
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store', ...init } as any)
  } catch {
    throw new Error('The NeuroFebric API is unreachable. Data will remain empty until the service is available.')
  }
  return responseJson<T>(response)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseTelemetry(value: unknown): DashboardTelemetry {
  if (!isRecord(value) || !Array.isArray(value.samples) || !Array.isArray(value.http5xx)) {
    throw new Error('The telemetry API returned an invalid payload.')
  }
  const samples = value.samples.map((sample, index) => {
    if (!isRecord(sample) || typeof sample.timestamp !== 'string'
      || !finiteNumber(sample.p99LatencyMs) || !finiteNumber(sample.throughputRps)) {
      throw new Error(`The telemetry API returned an invalid sample at index ${index}.`)
    }
    return { timestamp: sample.timestamp, p99LatencyMs: sample.p99LatencyMs, throughputRps: sample.throughputRps }
  })
  const http5xx = value.http5xx.map((sample, index) => {
    if (!isRecord(sample) || typeof sample.timestamp !== 'string' || !finiteNumber(sample.count)) {
      throw new Error(`The telemetry API returned an invalid 5xx record at index ${index}.`)
    }
    return { timestamp: sample.timestamp, count: sample.count }
  })
  return { samples, http5xx }
}

function parseAnalysisSummary(value: unknown): AnalysisSummary {
  if (!isRecord(value) || !finiteNumber(value.totalRows) || !finiteNumber(value.errorRows)
    || !finiteNumber(value.errorRate) || !Array.isArray(value.problems)
    || !Array.isArray(value.mappings) || !Array.isArray(value.byHour)
    || !Array.isArray(value.latencyBands) || !Array.isArray(value.categories)) {
    throw new Error('The analysis API returned an invalid structured summary.')
  }

  const problems = value.problems.map((problem) => {
    if (typeof problem !== 'string') throw new Error('The analysis summary contains an invalid problem entry.')
    return problem
  })
  const mappings = value.mappings.map((mapping) => {
    if (!isRecord(mapping) || typeof mapping.role !== 'string' || typeof mapping.column !== 'string'
      || typeof mapping.hypothesis !== 'boolean' || typeof mapping.note !== 'string') {
      throw new Error('The analysis summary contains an invalid column mapping.')
    }
    return { role: mapping.role, column: mapping.column, hypothesis: mapping.hypothesis, note: mapping.note }
  })
  const byHour = value.byHour.map((bucket) => {
    if (!isRecord(bucket) || typeof bucket.key !== 'string' || !finiteNumber(bucket.count)
      || !finiteNumber(bucket.errorCount) || !finiteNumber(bucket.errorRate)) {
      throw new Error('The analysis summary contains an invalid hourly bucket.')
    }
    return { key: bucket.key, count: bucket.count, errorCount: bucket.errorCount, errorRate: bucket.errorRate }
  })
  const latencyBands = value.latencyBands.map((band) => {
    if (!isRecord(band) || typeof band.label !== 'string' || !finiteNumber(band.count)) {
      throw new Error('The analysis summary contains an invalid latency band.')
    }
    return { label: band.label, count: band.count }
  })
  const categories = value.categories.map((category) => {
    if (!isRecord(category) || typeof category.key !== 'string' || !finiteNumber(category.count)
      || !(category.p95Elapsed === null || finiteNumber(category.p95Elapsed))) {
      throw new Error('The analysis summary contains an invalid category statistic.')
    }
    return { key: category.key, count: category.count, p95Elapsed: category.p95Elapsed }
  })
  return { totalRows: value.totalRows, errorRows: value.errorRows, errorRate: value.errorRate, problems, mappings, byHour, latencyBands, categories }
}

export async function uploadArtifact(file: File): Promise<UploadedArtifact> {
  const form = new FormData()
  form.append('file', file, file.name)
  const result = await requestJson<unknown>('/api/v1/workspace/ingest', { method: 'POST', body: form })
  if (!isRecord(result) || typeof result.path !== 'string' || typeof result.name !== 'string'
    || typeof result.size !== 'number' || typeof result.sha256 !== 'string') {
    throw new Error('The ingestion API returned an invalid artifact receipt.')
  }
  const normalizedPath = result.path.replaceAll('\\', '/')
  if (!normalizedPath.startsWith('workspace/') || normalizedPath.split('/').includes('..')) {
    throw new Error('The ingestion API returned a path outside the workspace sandbox.')
  }
  if (!Number.isSafeInteger(result.size) || result.size <= 0 || !/^[a-f0-9]{64}$/i.test(result.sha256)) {
    throw new Error('The ingestion API returned invalid file metadata.')
  }
  return { path: normalizedPath, name: result.name, size: result.size, sha256: result.sha256 }
}

export async function fetchLedger(): Promise<ApprovalLedgerRecord[]> {
  const value = await requestJson<unknown>('/api/v1/governance/ledger')
  if (!Array.isArray(value)) throw new Error('The governance API returned an invalid ledger payload.')
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.token !== 'string' || typeof entry.status !== 'string') {
      throw new Error(`The governance ledger contains an invalid row at index ${index}.`)
    }
    return {
      token: entry.token,
      status: entry.status,
      subject: entry.subject,
      decidedAt: nullableString(entry.decidedAt),
      approvedBy: nullableString(entry.approvedBy),
      reason: nullableString(entry.reason),
      resultExpiresAt: nullableString(entry.resultExpiresAt),
      collectedAt: nullableString(entry.collectedAt),
      createdAt: nullableString(entry.createdAt),
    }
  })
}

export async function submitVerdict(
  tokenId: string,
  decision: 'approved' | 'refused',
): Promise<VerdictResponse> {
  return requestJson<VerdictResponse>('/api/v1/governance/verdict', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      task_token: tokenId,
      status: decision,
      approved_by: 'neurofebric-operator',
      reason: `Operator selected ${decision}`,
    }),
  })
}

export async function executeAnalysis(
  workspacePath: string,
  prompt: string,
): Promise<AgentTaskResponse> {
  const value = await requestJson<unknown>('/api/v1/agent/task', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspacePath, prompt }),
  })
  if (!isRecord(value)) throw new Error('The analysis API returned an invalid response.')
  if (value.analysis !== undefined && value.analysis !== null) {
    value.analysis = parseAnalysisSummary(value.analysis)
  }
  if (value.telemetry !== undefined && value.telemetry !== null) {
    value.telemetry = parseTelemetry(value.telemetry)
  }
  if (value.status !== undefined && typeof value.status !== 'string') {
    throw new Error('The analysis API returned an invalid status.')
  }
  if (value.markdown !== undefined && typeof value.markdown !== 'string') {
    throw new Error('The analysis API returned an invalid report.')
  }
  return value as AgentTaskResponse
}

/** The telemetry route is an explicit contract seam; until it exists, charts stay empty. */
export async function fetchTelemetry(): Promise<DashboardTelemetry> {
  return parseTelemetry(await requestJson<unknown>('/api/v1/telemetry'))
}

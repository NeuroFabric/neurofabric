export type Widget = { kind: string; title: string; note?: string; payload: unknown }
export type AgentReply = { kind: 'answer' | 'correction'; text: string; widgets: Widget[]; suggestions: string[] }
export type ChatResponse = { status?: string; sessionId?: string; reply?: AgentReply; failure?: { reason?: string }; error?: string }
export {
  executeAnalysis,
  fetchLedger,
  fetchTelemetry,
  submitVerdict,
  uploadArtifact,
} from './lib/api'
export type {
  AgentTaskResponse,
  AnalysisSummary,
  ApprovalLedgerRecord,
  DashboardTelemetry,
  UploadedArtifact,
  VerdictResponse,
} from './lib/api'

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text.trim()) throw new Error(`NeuroFebric API returned an empty response (HTTP ${response.status})`)
  try { return JSON.parse(text) as T } catch {
    throw new Error(`NeuroFebric API returned a non-JSON response (HTTP ${response.status})`)
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let response: Response
  try { response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
  catch { throw new Error('NeuroFebric API is unreachable. Showing local telemetry until the service returns.') }
  const result = await readJson<T>(response)
  if (!response.ok) throw new Error((result as { failure?: { reason?: string }; error?: string }).failure?.reason ?? (result as { error?: string }).error ?? `Request failed (HTTP ${response.status})`)
  return result
}

export async function askNeuroFebric(path: string, message: string, sessionId?: string): Promise<ChatResponse> {
  return postJson<ChatResponse>('/api/chat', { path, message, sessionId })
}


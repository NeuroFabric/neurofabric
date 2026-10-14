import { useState } from 'react';
import { useTelemetry } from '../context/TelemetryContext';
import {
  Copy,
  Check,
  RefreshCw,
  Terminal,
  Send,
  ShieldCheck,
  Cpu,
  Radio,
} from 'lucide-react';
import { InfoTooltip } from '../components/common/Tooltip';
import { toast } from 'sonner';

export function IntegrationsPage() {
  const { apiKey, rotateApiKey, connectors, ingestCustomPayload } = useTelemetry();
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [copiedOtel, setCopiedOtel] = useState(false);

  const [testService, setTestService] = useState('order-service');
  const [testSev, setTestSev] = useState<'INFO' | 'WARNING' | 'CRITICAL'>('CRITICAL');
  const [testPayload, setTestPayload] = useState(
    'Bearer token leaked in authorization header: Bearer sk_live_8831902812. Rate limiting activated.'
  );

  const curlSnippet = `curl -X POST https://neurofabric-backend.onrender.com/api/v1/telemetry \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"service": "payments-api", "severity": "CRITICAL", "message": "Connection timeout in pool (92/100 active)"}'`;

  const otelConfigSnippet = `receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

exporters:
  otlp/neurofabric:
    endpoint: https://neurofabric-backend.onrender.com:4317
    headers:
      Authorization: "Bearer ${apiKey}"

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp/neurofabric]
    metrics:
      receivers: [otlp]
      exporters: [otlp/neurofabric]`;

  const handleCopy = (text: string, setFn: (v: boolean) => void) => {
    navigator.clipboard.writeText(text);
    setFn(true);
    toast.success('Copied to Clipboard');
    setTimeout(() => setFn(false), 2000);
  };

  const handleFireTest = (e: React.FormEvent) => {
    e.preventDefault();
    if (!testPayload.trim()) return;
    ingestCustomPayload(testService, testSev, testPayload);
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-2xl font-bold text-white tracking-tight">Enterprise Ingestion & Connectors</h1>
            <InfoTooltip content="Integrate your Kubernetes clusters, Datadog agents, and OpenTelemetry collectors with NeuroFabric's closed-loop mesh." />
          </div>
          <p className="text-xs text-slate-300 mt-1">
            Connect external telemetry streams, configure OpenTelemetry pipelines, and dispatch webhooks into the closed loop.
          </p>
        </div>

        <button
          onClick={rotateApiKey}
          className="px-3.5 py-2 rounded-xl bg-[#121622] hover:bg-slate-800 border border-white/10 text-xs font-mono text-slate-200 flex items-center space-x-2 transition"
        >
          <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
          <span>Rotate Ingestion Key</span>
        </button>
      </div>

      {/* Ingestion Key Banner */}
      <div className="p-6 rounded-2xl nf-card space-y-3">
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-slate-400 uppercase font-bold flex items-center space-x-1.5">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Active Bearer Ingestion Token (AES-256 Encrypted)</span>
          </span>
          <span className="text-emerald-400 font-bold">RBAC: LEVEL 5 SOVEREIGN</span>
        </div>

        <div className="flex items-center space-x-3">
          <input
            type="text"
            readOnly
            value={apiKey}
            className="flex-1 bg-[#05070B] border border-white/10 rounded-xl px-4 py-2.5 font-mono text-xs text-emerald-300 select-all"
          />
          <button
            onClick={() => handleCopy(apiKey, setCopiedKey)}
            className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono font-bold text-xs flex items-center space-x-1.5 transition"
          >
            {copiedKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedKey ? 'Copied' : 'Copy Key'}</span>
          </button>
        </div>
      </div>

      {/* 4 Active Ingestion Protocols Grid */}
      <div className="grid md:grid-cols-4 gap-4">
        {connectors.map((c) => (
          <div key={c.id} className="p-5 rounded-2xl nf-card space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                {c.status}
              </span>
              <Radio className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
            </div>
            <div>
              <div className="text-sm font-bold text-white">{c.name}</div>
              <div className="text-[10px] font-mono text-slate-400 mt-1 truncate">{c.endpoint}</div>
            </div>
            <div className="pt-2 border-t border-white/10 flex items-center justify-between font-mono text-[10px] text-slate-400">
              <span>Events: {c.eventsCount.toLocaleString()}</span>
              <span>Ping: {c.lastPing}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Code Snippets & Ingest Tester */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Left: cURL & OpenTelemetry Config */}
        <div className="space-y-4">
          <div className="p-5 rounded-2xl nf-card space-y-3">
            <div className="flex items-center justify-between font-mono text-xs">
              <span className="text-white font-bold flex items-center space-x-2">
                <Terminal className="w-4 h-4 text-emerald-400" />
                <span>cURL Quickstart Ingestion Command</span>
              </span>
              <button
                onClick={() => handleCopy(curlSnippet, setCopiedCurl)}
                className="text-emerald-400 hover:underline flex items-center space-x-1 text-[11px]"
              >
                {copiedCurl ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                <span>{copiedCurl ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <pre className="p-3.5 rounded-xl bg-[#05070B] border border-white/10 text-[11px] font-mono text-slate-300 overflow-x-auto leading-relaxed">
              {curlSnippet}
            </pre>
          </div>

          <div className="p-5 rounded-2xl nf-card space-y-3">
            <div className="flex items-center justify-between font-mono text-xs">
              <span className="text-white font-bold flex items-center space-x-2">
                <Cpu className="w-4 h-4 text-purple-400" />
                <span>OpenTelemetry Collector YAML (`otel-config.yaml`)</span>
              </span>
              <button
                onClick={() => handleCopy(otelConfigSnippet, setCopiedOtel)}
                className="text-purple-300 hover:underline flex items-center space-x-1 text-[11px]"
              >
                {copiedOtel ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                <span>{copiedOtel ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <pre className="p-3.5 rounded-xl bg-[#05070B] border border-white/10 text-[10px] font-mono text-slate-300 overflow-x-auto max-h-56 leading-relaxed">
              {otelConfigSnippet}
            </pre>
          </div>
        </div>

        {/* Right: Live Interactive Ingest Console */}
        <div className="p-6 rounded-2xl nf-card space-y-4 flex flex-col justify-between">
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <div className="flex items-center space-x-2 font-mono text-xs font-bold text-white uppercase">
                <Send className="w-4 h-4 text-emerald-400" />
                <span>Live Telemetry Injector</span>
              </div>
              <span className="text-[10px] font-mono text-emerald-400">EDGE PIPELINE READY</span>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed font-sans">
              Fire custom payloads into your active closed loop to verify line-rate DLP secret scrubbing, AST gate filtering, and automated HITL proposal creation.
            </p>

            <form onSubmit={handleFireTest} className="space-y-3 font-mono text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-slate-400 block mb-1">SERVICE</label>
                  <select
                    value={testService}
                    onChange={(e) => setTestService(e.target.value)}
                    className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-white"
                  >
                    <option value="order-service">order-service</option>
                    <option value="auth-gateway">auth-gateway</option>
                    <option value="flapping-payment-worker">flapping-payment-worker</option>
                    <option value="billing-core">billing-core</option>
                    <option value="egress-payments-api">egress-payments-api</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-slate-400 block mb-1">SEVERITY</label>
                  <select
                    value={testSev}
                    onChange={(e) => setTestSev(e.target.value as 'INFO' | 'WARNING' | 'CRITICAL')}
                    className="w-full bg-[#05070B] border border-white/15 rounded-xl px-3 py-2 text-white"
                  >
                    <option value="CRITICAL">CRITICAL</option>
                    <option value="WARNING">WARNING</option>
                    <option value="INFO">INFO</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-[10px] text-slate-400 block mb-1">
                  PAYLOAD STRING (Includes Bearer tokens & shell commands)
                </label>
                <textarea
                  rows={4}
                  value={testPayload}
                  onChange={(e) => setTestPayload(e.target.value)}
                  className="w-full bg-[#05070B] border border-white/15 rounded-xl p-3 text-white text-xs font-mono focus:outline-none focus:border-emerald-400"
                />
              </div>

              <button
                type="submit"
                className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-400 to-teal-500 hover:from-emerald-300 hover:to-teal-400 text-slate-950 font-mono font-bold text-xs flex items-center justify-center space-x-2 transition shadow-lg shadow-emerald-500/20"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Inject Live Telemetry Frame</span>
              </button>
            </form>
          </div>

          <div className="p-3.5 rounded-xl bg-[#05070B] border border-white/10 text-[11px] font-mono text-slate-400 space-y-1">
            <div className="text-white font-bold text-xs">Closed-Loop Trigger Guarantee:</div>
            <div>• Payloads with Bearer tokens trigger in-flight DLP redaction (&lt;1.2ms).</div>
            <div>• CRITICAL events trip the service circuit breaker and synthesize a GitOps patch in /embassy.</div>
          </div>
        </div>
      </div>
    </div>
  );
}


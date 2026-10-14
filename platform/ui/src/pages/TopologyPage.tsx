import { useState, useEffect } from 'react';
import { Network, Server, ShieldCheck, Database, Cpu, Play, Pause, SkipForward, Zap, CheckCircle2, Terminal } from 'lucide-react';
import { useTelemetry } from '../context/TelemetryContext';
import { InfoTooltip } from '../components/common/Tooltip';

export function TopologyPage() {
  const { status, latencyMs, emitHeartbeat } = useTelemetry();
  const [selectedNode, setSelectedNode] = useState('gateway');
  const [activeStage, setActiveStage] = useState(0);
  const [isRunning, setIsRunning] = useState(true);
  const [packetsProcessed, setPacketsProcessed] = useState(1428);

  const stages = [
    {
      id: 0,
      name: '1. Ingest & DLP',
      node: 'edge',
      duration: '1.2ms',
      detail: 'Scrubbing incoming HTTP/SSE telemetry payloads against regex credential filters (Bearer, AWS, PAT).',
      trace: '[INGEST:8080] Batch #8821 -> 0 leaks -> Forwarded to Dedup Window',
    },
    {
      id: 1,
      name: '2. Dedup Window',
      node: 'gateway',
      duration: '0.8ms',
      detail: '60-second sliding hash window collapses duplicate alert bursts (94.2% suppression ratio).',
      trace: '[DEDUP] Fingerprinted 42 frames -> Collapsed 38 duplicates -> 4 unique emitted',
    },
    {
      id: 2,
      name: '3. Circuit Eval',
      node: 'gateway',
      duration: '1.5ms',
      detail: 'Evaluates service strike counts. 3 strikes within 60s triggers sovereign HTTP 423 lock.',
      trace: '[CIRCUIT] auth-gateway (0/3 CLOSED) | flapping-payment-worker (3/3 TRIPPED)',
    },
    {
      id: 3,
      name: '4. Agentic RCA',
      node: 'embassy',
      duration: '18.4ms',
      detail: 'Pi Agent inside workspace/ synthesizes causal root-cause analysis and generates minimal GitOps diff.',
      trace: '[EMBASSY:STDIO] Generated patch task-auth-gw-892 (Confidence: 96%)',
    },
    {
      id: 4,
      name: '5. AST Gate',
      node: 'gateway',
      duration: '2.1ms',
      detail: 'Deterministic syntax tree parser screens proposed diffs for prohibited shell escapes (curl | bash, rm -rf).',
      trace: '[AST-GATE] Screened 24 syntax nodes -> 0 forbidden primitives -> VERIFIED',
    },
    {
      id: 5,
      name: '6. HITL Review',
      node: 'bridge',
      duration: 'Awaiting Operator',
      detail: 'Streams verified diff and RCA report over EventBridge SSE to operator cockpit for human authorization.',
      trace: '[HITL] Proposal queued in Embassy console -> Token confirmation armed',
    },
    {
      id: 6,
      name: '7. GitOps PR',
      node: 'gateway',
      duration: '6.4ms',
      detail: 'Dispatches signed pull request to production cluster configuration repository.',
      trace: '[GITOPS] Commit 9f86d08 dispatched -> Rolling pod update initiated',
    },
    {
      id: 7,
      name: '8. Merkle Append',
      node: 'storage',
      duration: '0.9ms',
      detail: 'Appends SHA-256 leaf hash to immutable SQLite WAL ledger linking alert, diff, and operator signature.',
      trace: '[MERKLE:WAL] Sealed Leaf #129 -> Root hash verified via WebCrypto',
    },
  ];

  const nodes = [
    {
      id: 'edge',
      name: 'Edge Telemetry Probe',
      port: '8080/ingest',
      icon: Server,
      status: 'NOMINAL',
      latency: '2ms',
      cpu: '14%',
      mem: '128MB',
      desc: 'High-throughput edge collector performing line-rate DLP token redaction before persistence.',
    },
    {
      id: 'gateway',
      name: 'Ingress Gateway & RBAC',
      port: '8080',
      icon: ShieldCheck,
      status: 'ACTIVE',
      latency: '4ms',
      cpu: '22%',
      mem: '256MB',
      desc: 'Single control plane enforcing ADR-005, RBAC clearance levels, 3-strike circuit breakers, and AST diff gates.',
    },
    {
      id: 'bridge',
      name: 'EventBridge (IPC Pub/Sub)',
      port: 'IPC',
      icon: Network,
      status: status,
      latency: `${latencyMs}ms`,
      cpu: '8%',
      mem: '94MB',
      desc: 'Sub-85ms SQLite-backed event bus streaming real-time SSE frames to the operator cockpit.',
    },
    {
      id: 'embassy',
      name: 'Embassy (Pi Agent)',
      port: 'stdio',
      icon: Cpu,
      status: 'SYNTHESIZING',
      latency: '18ms',
      cpu: '38%',
      mem: '512MB',
      desc: 'Sandboxed autonomous diagnostic agent restricted strictly to workspace/ for root-cause synthesis.',
    },
    {
      id: 'storage',
      name: 'Sovereign SQLite (.db)',
      port: 'WAL',
      icon: Database,
      status: 'SEALED',
      latency: '1ms',
      cpu: '5%',
      mem: '180MB',
      desc: 'Write-Ahead Logging (WAL) sovereign storage housing telemetry indices and the SHA-256 Merkle audit chain.',
    },
  ];

  // Auto-advance the 8-stage pipeline every 2.2 seconds when running
  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => {
      setActiveStage((prev) => {
        const next = (prev + 1) % stages.length;
        setSelectedNode(stages[next].node);
        return next;
      });
      setPacketsProcessed((p) => p + Math.floor(Math.random() * 14) + 5);
    }, 2200);
    return () => clearInterval(timer);
  }, [isRunning]);

  const currentStageObj = stages[activeStage];
  const currentNodeObj = nodes.find((n) => n.id === selectedNode) || nodes[1];

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      {/* Header & Live Simulation Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-2xl font-bold text-white tracking-tight">
              Cluster Topology & Live Remediation Pipeline
            </h1>
            <InfoTooltip content="Watch the 8-stage closed-loop state machine execute in real time, or click any node/stage to inspect its live kernel telemetry." />
          </div>
          <p className="text-xs text-slate-300 mt-1">
            Active closed-loop state machine • Packets Processed:{' '}
            <span className="text-cyan-400 font-mono font-bold">{packetsProcessed.toLocaleString()}</span>
          </p>
        </div>

        <div className="flex items-center space-x-2.5">
          <button
            onClick={() => setIsRunning(!isRunning)}
            className={`px-3.5 py-2 rounded-xl text-xs font-mono font-bold border flex items-center space-x-1.5 transition ${
              isRunning
                ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-300'
                : 'bg-amber-500/20 border-amber-400/50 text-amber-300'
            }`}
          >
            {isRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span>{isRunning ? 'Pipeline Running (Auto)' : 'Pipeline Paused'}</span>
          </button>

          <button
            onClick={() => {
              const next = (activeStage + 1) % stages.length;
              setActiveStage(next);
              setSelectedNode(stages[next].node);
              setPacketsProcessed((p) => p + 12);
            }}
            className="px-3.5 py-2 rounded-xl bg-[#141928] hover:bg-slate-800 border border-white/10 text-xs font-mono text-slate-200 flex items-center space-x-1.5 transition"
          >
            <SkipForward className="w-3.5 h-3.5 text-cyan-400" />
            <span>Step Stage</span>
          </button>

          <button
            onClick={() => {
              emitHeartbeat();
              setPacketsProcessed((p) => p + 25);
            }}
            className="px-3.5 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono font-bold text-xs flex items-center space-x-1.5 transition shadow-lg shadow-cyan-500/20"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>Inject Burst</span>
          </button>
        </div>
      </div>

      {/* Animated Inter-Process Conduits */}
      <div className="p-6 rounded-2xl bg-[#0D111C] border border-white/10 space-y-5 shadow-2xl">
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="font-bold uppercase tracking-wider text-white flex items-center space-x-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            <span>Live Inter-Process Conduits (Active Stage: {currentStageObj.name})</span>
          </span>
          <span className="text-cyan-400">Edge Latency: {latencyMs}ms</span>
        </div>

        <div className="relative h-24 w-full bg-[#07090F] rounded-xl border border-white/10 flex items-center px-10 overflow-hidden">
          {/* Base Conduit Track */}
          <div className="absolute left-12 right-12 h-1.5 bg-slate-800 rounded-full" />

          {/* Active Progress Fill */}
          <div
            style={{ width: `${((activeStage + 1) / stages.length) * 88}%` }}
            className="absolute left-12 h-1.5 bg-gradient-to-r from-cyan-400 via-indigo-400 to-emerald-400 rounded-full transition-all duration-500"
          />

          <div className="relative w-full flex items-center justify-between z-10">
            {nodes.map((n) => {
              const isSelected = selectedNode === n.id;
              const isStageActiveNode = currentStageObj.node === n.id;
              const Icon = n.icon;
              return (
                <div
                  key={n.id}
                  onClick={() => setSelectedNode(n.id)}
                  className="flex flex-col items-center cursor-pointer group"
                >
                  <div
                    className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-300 border ${
                      isStageActiveNode
                        ? 'bg-gradient-to-br from-cyan-400 to-emerald-400 text-slate-950 border-white shadow-[0_0_25px_rgba(34,211,238,0.6)] scale-110'
                        : isSelected
                        ? 'bg-indigo-500/30 text-cyan-300 border-cyan-400'
                        : 'bg-[#121624] text-slate-400 border-white/10 group-hover:border-white/30'
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                  </div>
                  <span
                    className={`text-[10px] font-mono mt-2 font-bold ${
                      isStageActiveNode ? 'text-cyan-300' : 'text-slate-400 group-hover:text-white'
                    }`}
                  >
                    {n.name.split(' ')[0]}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 5 Cluster Nodes Cards */}
      <div className="grid md:grid-cols-5 gap-3.5">
        {nodes.map((n) => {
          const Icon = n.icon;
          const isSelected = selectedNode === n.id;
          const isStageActiveNode = currentStageObj.node === n.id;
          return (
            <div
              key={n.id}
              onClick={() => setSelectedNode(n.id)}
              className={`p-4 rounded-2xl border cursor-pointer transition flex flex-col justify-between space-y-4 ${
                isStageActiveNode
                  ? 'bg-gradient-to-b from-cyan-500/15 to-[#0D111C] border-cyan-400 shadow-lg shadow-cyan-500/10'
                  : isSelected
                  ? 'bg-[#141A29] border-indigo-400/60'
                  : 'bg-[#0D111C] border-white/10 hover:border-white/25'
              }`}
            >
              <div className="flex items-center justify-between">
                <Icon className={`w-5 h-5 ${isStageActiveNode ? 'text-cyan-400' : 'text-slate-400'}`} />
                <span className="text-[9px] font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  {n.status}
                </span>
              </div>
              <div>
                <div className="text-xs font-bold text-white">{n.name}</div>
                <div className="text-[10px] font-mono text-slate-400 mt-1">
                  Port: {n.port} • {n.latency}
                </div>
                <div className="text-[10px] font-mono text-cyan-400/90 mt-1">
                  CPU: {n.cpu} • MEM: {n.mem}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 8-Step Interactive Pipeline Grid */}
      <div className="p-6 rounded-2xl bg-[#0D111C] border border-white/10 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <div className="text-xs font-mono font-bold text-white uppercase tracking-wider">
            8-Step Autonomous Remediation Pipeline (Click any stage to inspect)
          </div>
          <span className="text-[11px] font-mono text-emerald-400 font-bold">
            Stage {activeStage + 1} of 8 Active ({currentStageObj.duration})
          </span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-8 gap-2.5 font-mono text-[11px]">
          {stages.map((stg, idx) => {
            const isCurr = idx === activeStage;
            const isPassed = idx < activeStage;
            return (
              <button
                key={stg.id}
                onClick={() => {
                  setActiveStage(idx);
                  setSelectedNode(stg.node);
                }}
                className={`p-3 rounded-xl border text-left transition flex flex-col justify-between space-y-2 ${
                  isCurr
                    ? 'bg-gradient-to-b from-cyan-500/25 to-indigo-500/20 border-cyan-400 text-white font-bold shadow-lg shadow-cyan-500/20 scale-[1.03]'
                    : isPassed
                    ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-300'
                    : 'bg-[#080A10] border-white/10 text-slate-400 hover:border-white/30'
                }`}
              >
                <div className="flex items-center justify-between w-full">
                  <span className="text-[9px] text-slate-400">STEP 0{idx + 1}</span>
                  {isCurr ? (
                    <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
                  ) : isPassed ? (
                    <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                  ) : null}
                </div>
                <div className="text-[11px] leading-tight">{stg.name.split('. ')[1]}</div>
                <div className="text-[9px] text-cyan-400/80">{stg.duration}</div>
              </button>
            );
          })}
        </div>

        {/* Live Stage & Node Deep Inspector */}
        <div className="mt-4 p-5 rounded-xl bg-[#07090F] border border-white/10 grid md:grid-cols-2 gap-6 font-mono text-xs">
          <div className="space-y-2">
            <div className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider flex items-center space-x-1.5">
              <Terminal className="w-3.5 h-3.5" />
              <span>Active Stage Telemetry: {currentStageObj.name}</span>
            </div>
            <p className="text-xs text-slate-200 font-sans leading-relaxed">{currentStageObj.detail}</p>
            <div className="p-2.5 rounded-lg bg-[#0D111C] border border-white/10 text-[11px] text-emerald-400">
              {currentStageObj.trace}
            </div>
          </div>

          <div className="space-y-2 border-t md:border-t-0 md:border-l border-white/10 md:pl-6">
            <div className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider">
              Selected Node Diagnostics: {currentNodeObj.name}
            </div>
            <p className="text-xs text-slate-300 font-sans leading-relaxed">{currentNodeObj.desc}</p>
            <div className="grid grid-cols-3 gap-2 pt-1 text-[11px]">
              <div className="p-2 rounded bg-[#0D111C] border border-white/5">
                <span className="text-slate-500 block text-[9px]">PORT / MODE</span>
                <span className="text-white font-bold">{currentNodeObj.port}</span>
              </div>
              <div className="p-2 rounded bg-[#0D111C] border border-white/5">
                <span className="text-slate-500 block text-[9px]">CPU LOAD</span>
                <span className="text-emerald-400 font-bold">{currentNodeObj.cpu}</span>
              </div>
              <div className="p-2 rounded bg-[#0D111C] border border-white/5">
                <span className="text-slate-500 block text-[9px]">MEMORY</span>
                <span className="text-cyan-400 font-bold">{currentNodeObj.mem}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

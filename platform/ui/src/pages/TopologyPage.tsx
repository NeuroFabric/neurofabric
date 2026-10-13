import { useState } from 'react';
import { Network, Server, ShieldCheck, Database, Cpu, Radio } from 'lucide-react';
import { useTelemetry } from '../context/TelemetryContext';

export function TopologyPage() {
  const { status, latencyMs } = useTelemetry();
  const [selectedNode, setSelectedNode] = useState('gateway');

  const nodes = [
    { id: 'edge', name: 'Edge Telemetry Probe', port: '8080/ingest', icon: Server, status: 'NOMINAL', latency: '2ms' },
    { id: 'gateway', name: 'Ingress Gateway & RBAC', port: '8080', icon: ShieldCheck, status: 'ACTIVE', latency: '4ms' },
    { id: 'bridge', name: 'EventBridge (IPC Pub/Sub)', port: 'IPC', icon: Network, status: status, latency: `${latencyMs}ms` },
    { id: 'embassy', name: 'Embassy (Pi Agent)', port: 'stdio', icon: Cpu, status: 'IDLE', latency: '12ms' },
    { id: 'storage', name: 'Sovereign SQLite (.db)', port: 'WAL', icon: Database, status: 'SEALED', latency: '1ms' },
  ];

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Cluster Topology & Closed-Loop Pipeline</h1>
          <p className="text-xs text-slate-400 mt-1">
            Real-time visual architecture graph mapping the 8-step operational remediation loop.
          </p>
        </div>
        <div className="flex items-center space-x-2 text-xs font-mono text-cyan-400 bg-cyan-950/60 border border-cyan-800 px-3 py-1.5 rounded-full font-bold">
          <Radio className="w-3.5 h-3.5 animate-pulse" />
          <span>EDGE LATENCY: {latencyMs}ms</span>
        </div>
      </div>

      <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800 space-y-6">
        <div className="flex items-center justify-between text-xs font-mono text-slate-400">
          <span className="font-bold uppercase tracking-wider text-white">Live Inter-Process Conduits</span>
          <span>Zero-Lag IPC Stream</span>
        </div>

        <div className="relative h-20 w-full bg-[#07090e] rounded-xl border border-slate-800/80 flex items-center px-8 overflow-hidden">
          <div className="absolute left-8 right-8 h-1 bg-slate-800 rounded-full" />
          <div className="absolute left-8 right-8 h-1 overflow-hidden pointer-events-none">
            <div className="w-24 h-full bg-gradient-to-r from-transparent via-cyan-400 to-transparent animate-pulse" />
          </div>

          <div className="relative w-full flex items-center justify-between z-10">
            {nodes.map(n => {
              const isSelected = selectedNode === n.id;
              const Icon = n.icon;
              return (
                <div
                  key={n.id}
                  onClick={() => setSelectedNode(n.id)}
                  className="flex flex-col items-center cursor-pointer group"
                >
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition border ${
                    isSelected
                      ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-lg shadow-cyan-500/30'
                      : 'bg-slate-900 text-slate-400 border-slate-700 group-hover:border-slate-500'
                  }`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <span className="text-[10px] font-mono mt-2 text-slate-400 font-bold group-hover:text-white">
                    {n.name.split(' ')[0]}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-5 gap-3">
        {nodes.map(n => {
          const Icon = n.icon;
          const isSelected = selectedNode === n.id;
          return (
            <div
              key={n.id}
              onClick={() => setSelectedNode(n.id)}
              className={`p-4 rounded-2xl border cursor-pointer transition flex flex-col justify-between space-y-4 ${
                isSelected
                  ? 'bg-cyan-950/40 border-cyan-500/80 shadow-lg shadow-cyan-950/20'
                  : 'bg-[#0d121d] border-slate-800 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between">
                <Icon className={`w-5 h-5 ${isSelected ? 'text-cyan-400' : 'text-slate-400'}`} />
                <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-950 text-emerald-400 border border-slate-800">
                  {n.status}
                </span>
              </div>
              <div>
                <div className="text-xs font-bold text-white">{n.name}</div>
                <div className="text-[10px] font-mono text-slate-500 mt-0.5">Port: {n.port} • {n.latency}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800 space-y-4">
        <div className="text-xs font-mono font-bold text-white uppercase tracking-wider">
          8-Step Autonomous Remediation Pipeline
        </div>
        <div className="grid grid-cols-2 md:grid-cols-8 gap-2 font-mono text-[11px] text-center">
          {[
            '1. Ingest & DLP',
            '2. Dedup Window',
            '3. Circuit Eval',
            '4. Agentic RCA',
            '5. AST Gate',
            '6. HITL Review',
            '7. GitOps PR',
            '8. Merkle Append',
          ].map((stage, idx) => (
            <div
              key={stage}
              className={`p-2.5 rounded-xl border ${
                idx === 5
                  ? 'bg-amber-950/40 border-amber-800 text-amber-300 font-bold'
                  : 'bg-slate-950 border-slate-800 text-slate-400'
              }`}
            >
              {stage}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

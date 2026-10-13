import { Sparkles, Cpu, Shield, Network } from 'lucide-react';

export function RoadmapPage() {
  const items = [
    {
      title: 'Sentinel Autonomous Kernel v2',
      quarter: 'Q4 2026',
      icon: Cpu,
      desc: 'Multi-agent orchestration loop with continuous causal hypothesis generation and automated rollbacks.',
    },
    {
      title: 'MeshGuard eBPF Packet Filter',
      quarter: 'Q1 2027',
      icon: Shield,
      desc: 'Kernel-level ingress packet filtering with sub-millisecond automated rate throttling and IP fencing.',
    },
    {
      title: 'Zero-Knowledge Merkle Proof Sealer',
      quarter: 'Q2 2027',
      icon: Network,
      desc: 'Cryptographic zero-knowledge proofs for third-party compliance audits without exposing proprietary telemetry.',
    },
  ];

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      <div className="flex items-center space-x-2">
        <Sparkles className="w-5 h-5 text-cyan-400" />
        <h1 className="text-2xl font-bold text-white tracking-tight">Future NeuroFabric Ecosystem Roadmap</h1>
      </div>
      <p className="text-xs text-slate-400">
        Planned architectural horizons and enterprise autonomous modules under active engineering.
      </p>

      <div className="grid md:grid-cols-3 gap-6 pt-4">
        {items.map(item => {
          const Icon = item.icon;
          return (
            <div key={item.title} className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800 space-y-4">
              <div className="flex items-center justify-between">
                <Icon className="w-5 h-5 text-cyan-400" />
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-300">
                  {item.quarter}
                </span>
              </div>
              <div>
                <h3 className="font-bold text-sm text-white">{item.title}</h3>
                <p className="text-xs text-slate-400 mt-2 leading-relaxed">{item.desc}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

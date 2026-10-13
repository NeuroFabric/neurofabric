import { Sparkles, Shield, Cpu, Network } from 'lucide-react';

export function RoadmapPage() {
  const products = [
    {
      title: 'NeuroFabric Sentinel',
      badge: 'ALPHA Q4 2026',
      icon: Shield,
      color: 'text-cyan-400',
      border: 'border-cyan-500/20',
      description:
        'Zero-day automated anomaly quarantine executing micro-isolation protocols without human latency.',
      features: ['Automated Pod Cordoning', 'Entropy-based Threat Scoring', 'Zero Network Disruption'],
    },
    {
      title: 'MeshGuard eBPF',
      badge: 'PLANNED Q1 2027',
      icon: Network,
      color: 'text-purple-400',
      border: 'border-purple-500/20',
      description:
        'Kernel-level socket filter running eBPF bytecode for microsecond TLS payload inspection with zero CPU overhead.',
      features: ['Kernel-space DLP Scrubbing', 'Sub-millisecond Packet Filters', 'Multi-Cloud Mesh Sync'],
    },
    {
      title: 'Autonomous Kernel v2',
      badge: 'IN DEV Q2 2027',
      icon: Cpu,
      color: 'text-emerald-400',
      border: 'border-emerald-500/20',
      description:
        'Multi-agent consensus protocol enabling distributed GitOps remediation with zero single points of failure.',
      features: ['Byzantine Fault Tolerant Rollbacks', 'Distributed Merkle Verification', 'Autonomous Canary Tests'],
    },
  ];

  return (
    <div className="p-8 space-y-8 max-w-6xl font-sans">
      <div>
        <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-cyan-950 border border-cyan-800/60 text-xs font-mono text-cyan-400 font-bold mb-2">
          <Sparkles className="w-3.5 h-3.5" />
          <span>Product Evolution Roadmap</span>
        </div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Future of NeuroFabric Ops</h1>
        <p className="text-xs text-slate-400 mt-1">Expanding from edge telemetry into autonomous kernel governance</p>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        {products.map((p) => {
          const Icon = p.icon;
          return (
            <div key={p.title} className={`p-6 rounded-2xl bg-[#0d121d] border ${p.border} flex flex-col justify-between space-y-6`}>
              <div>
                <div className="flex items-center justify-between">
                  <div className={`w-10 h-10 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center ${p.color}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded font-bold bg-slate-900 border border-slate-800 text-slate-300">
                    {p.badge}
                  </span>
                </div>

                <h3 className="font-bold text-white text-base mt-4">{p.title}</h3>
                <p className="text-xs text-slate-400 mt-2 leading-relaxed">{p.description}</p>
              </div>

              <div className="border-t border-slate-800 pt-4 space-y-2">
                {p.features.map((f, i) => (
                  <div key={i} className="text-xs font-mono text-slate-400 flex items-center space-x-2">
                    <span className="text-cyan-400">▹</span>
                    <span>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

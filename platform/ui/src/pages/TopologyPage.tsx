import { useTelemetry } from '../context/TelemetryContext';

export function TopologyPage() {
  const { trippedCircuits } = useTelemetry();

  const services = [
    { name: 'auth-gateway', transit: '28ms', dlp: true },
    { name: 'k8s-ingress', transit: '14ms', dlp: false },
    { name: 'billing-core', transit: '42ms', dlp: true },
    { name: 'mesh-router', transit: '18ms', dlp: false },
    { name: 'flapping-payment-worker', transit: '88ms', dlp: true },
  ];

  return (
    <div className="p-8 space-y-8 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Cluster Topology</h1>
        <p className="text-xs text-slate-400 mt-1">Distributed node latencies, DLP enforcement posture, and circuit state</p>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {services.map((svc) => {
          const isTripped = trippedCircuits.includes(svc.name);
          return (
            <div key={svc.name} className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white font-mono text-sm">{svc.name}</span>
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold ${
                      isTripped
                        ? 'bg-rose-950 text-rose-400 border border-rose-800'
                        : 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                    }`}
                  >
                    {isTripped ? 'CIRCUIT TRIPPED' : 'NOMINAL'}
                  </span>
                </div>
                <div className="text-xs font-mono text-slate-400 mt-3">
                  Edge Transit: <span className="text-cyan-400 font-bold">{svc.transit}</span>
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-slate-800 flex items-center justify-between text-xs">
                <span className="text-slate-500">DLP Scrubber:</span>
                <span className={`font-mono font-bold ${svc.dlp ? 'text-amber-400' : 'text-slate-400'}`}>
                  {svc.dlp ? 'ENFORCED' : 'BYPASS'}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

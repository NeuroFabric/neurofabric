import { useTelemetry } from '../context/TelemetryContext';
import { Zap, ShieldCheck, ShieldAlert, RotateCcw } from 'lucide-react';

export function CircuitsPage() {
  const { trippedCircuits, unlockCircuit, triggerProbe } = useTelemetry();

  const services = [
    { name: 'auth-gateway', strikes: 0, maxStrikes: 3, lastStrike: 'None', status: 'CLOSED' },
    {
      name: 'flapping-payment-worker',
      strikes: trippedCircuits.includes('flapping-payment-worker') ? 3 : 2,
      maxStrikes: 3,
      lastStrike: trippedCircuits.includes('flapping-payment-worker') ? 'Just now' : '45s ago',
      status: trippedCircuits.includes('flapping-payment-worker') ? 'TRIPPED' : 'DEGRADED',
    },
    { name: 'billing-core', strikes: 0, maxStrikes: 3, lastStrike: 'None', status: 'CLOSED' },
    { name: 'order-service', strikes: 1, maxStrikes: 3, lastStrike: '12m ago', status: 'CLOSED' },
  ];

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Circuit Breaker Fleet</h1>
          <p className="text-xs text-slate-400 mt-1">
            Anti-flapping sovereign fence. 3 strikes in 60 seconds isolates service from production mutations.
          </p>
        </div>
        <button
          onClick={() => triggerProbe('flapping-payment-worker', true)}
          className="px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/40 text-xs text-rose-300 rounded-xl transition font-medium flex items-center space-x-1.5"
        >
          <Zap className="w-3.5 h-3.5 text-rose-400" />
          <span>Simulate Flapping Strike</span>
        </button>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {services.map((svc) => {
          const isTripped = trippedCircuits.includes(svc.name) || svc.status === 'TRIPPED';
          return (
            <div
              key={svc.name}
              className={`p-6 rounded-2xl bg-[#0d121d] border flex flex-col justify-between space-y-6 transition ${
                isTripped
                  ? 'border-rose-500/50 shadow-lg shadow-rose-950/20'
                  : 'border-slate-800/80'
              }`}
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white text-base font-mono">{svc.name}</span>
                  <span
                    className={`text-[10px] font-mono px-2.5 py-0.5 rounded-full font-bold ${
                      isTripped
                        ? 'bg-rose-950 text-rose-300 border border-rose-800 animate-pulse'
                        : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                    }`}
                  >
                    {isTripped ? 'TRIPPED (HTTP 423)' : 'CLOSED (NOMINAL)'}
                  </span>
                </div>

                {/* Strike Dots (●●○) */}
                <div className="mt-4 flex items-center space-x-2">
                  <span className="text-xs text-slate-400">Strikes:</span>
                  <div className="flex items-center space-x-1.5 font-mono text-sm">
                    {[1, 2, 3].map((num) => (
                      <span
                        key={num}
                        className={`${
                          num <= (isTripped ? 3 : svc.strikes)
                            ? isTripped
                              ? 'text-rose-400'
                              : 'text-amber-400'
                            : 'text-slate-700'
                        }`}
                      >
                        ●
                      </span>
                    ))}
                  </div>
                  <span className="text-xs text-slate-500 font-mono ml-2">
                    ({isTripped ? 3 : svc.strikes}/3)
                  </span>
                </div>

                <div className="mt-2 text-xs text-slate-500 font-mono">
                  Last Strike: <span className="text-slate-400">{svc.lastStrike}</span>
                </div>
              </div>

              {isTripped ? (
                <div className="pt-4 border-t border-slate-800 flex items-center justify-between">
                  <div className="text-[11px] text-rose-400 flex items-center space-x-1.5">
                    <ShieldAlert className="w-4 h-4" />
                    <span>Requires Operator Level 5 Override</span>
                  </div>
                  <button
                    onClick={() => unlockCircuit(svc.name)}
                    className="px-4 py-2 bg-rose-500 hover:bg-rose-400 text-slate-950 font-bold rounded-xl text-xs transition flex items-center space-x-1.5"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Emergency Reset</span>
                  </button>
                </div>
              ) : (
                <div className="pt-4 border-t border-slate-800 text-xs text-slate-500 flex items-center space-x-1.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>Sovereign circuit healthy</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

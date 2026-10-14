import { useTelemetry } from '../context/TelemetryContext';
import { Zap, ShieldCheck, ShieldAlert, RotateCcw, Activity } from 'lucide-react';
import { InfoTooltip } from '../components/common/Tooltip';

export function CircuitsPage() {
  const { trippedCircuits, unlockCircuit, triggerProbe, globalRange, customMinutes } = useTelemetry();

  const services = [
    {
      name: 'auth-gateway',
      strikes: 0,
      maxStrikes: 3,
      lastStrike: 'None',
      status: 'CLOSED',
      history: [4, 5, 4, 6, 5, 4, 3, 5, 4, 4, 5, 4],
    },
    {
      name: 'flapping-payment-worker',
      strikes: trippedCircuits.includes('flapping-payment-worker') ? 3 : 1,
      maxStrikes: 3,
      lastStrike: trippedCircuits.includes('flapping-payment-worker') ? 'Just now' : '14m ago',
      status: trippedCircuits.includes('flapping-payment-worker') ? 'TRIPPED' : 'CLOSED',
      history: trippedCircuits.includes('flapping-payment-worker')
        ? [8, 14, 19, 45, 72, 88, 95, 100, 100, 98, 100, 100]
        : [12, 15, 10, 8, 9, 7, 6, 8, 5, 6, 5, 4],
    },
    {
      name: 'billing-core',
      strikes: 0,
      maxStrikes: 3,
      lastStrike: 'None',
      status: 'CLOSED',
      history: [3, 4, 3, 3, 5, 4, 3, 4, 3, 3, 4, 3],
    },
    {
      name: 'order-service',
      strikes: 1,
      maxStrikes: 3,
      lastStrike: '12m ago',
      status: 'CLOSED',
      history: [6, 9, 28, 14, 8, 7, 6, 9, 8, 7, 6, 6],
    },
  ];

  const activeWindowLabel = globalRange === 'custom' ? `${customMinutes}m` : globalRange;

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-2xl font-bold text-white tracking-tight">Circuit Breaker Fleet</h1>
            <InfoTooltip content="3 strikes within 60 seconds isolates the service with HTTP 423 Locked. Sparklines reflect the active Global Time Range." />
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Anti-flapping sovereign fence • Active Telemetry Window: <span className="text-emerald-400 font-mono font-bold">{activeWindowLabel}</span>
          </p>
        </div>
        <button
          onClick={() => triggerProbe('flapping-payment-worker', true)}
          className="px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/40 text-xs text-rose-300 rounded-xl transition font-mono font-bold flex items-center space-x-1.5"
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
              className={`p-6 rounded-2xl bg-[#111319] border flex flex-col justify-between space-y-5 transition shadow-xl ${
                isTripped ? 'border-rose-500/60 shadow-rose-950/20' : 'border-slate-800/90'
              }`}
            >
              <div className="space-y-4">
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

                <div className="flex items-center justify-between text-xs font-mono">
                  <div className="flex items-center space-x-2">
                    <span className="text-slate-400">Strikes:</span>
                    <div className="flex items-center space-x-1.5 text-sm">
                      {[1, 2, 3].map((num) => (
                        <span
                          key={num}
                          className={
                            num <= (isTripped ? 3 : svc.strikes)
                              ? isTripped
                                ? 'text-rose-400'
                                : 'text-amber-400'
                              : 'text-slate-700'
                          }
                        >
                          ●
                        </span>
                      ))}
                    </div>
                    <span className="text-slate-500">({isTripped ? 3 : svc.strikes}/3)</span>
                  </div>
                  <span className="text-slate-400">Last Strike: {svc.lastStrike}</span>
                </div>

                {/* Per-Service Time-Range Sparkline */}
                <div className="p-3 rounded-xl bg-[#090B10] border border-slate-800/80 space-y-2">
                  <div className="flex items-center justify-between text-[10px] font-mono text-slate-500">
                    <span className="flex items-center space-x-1">
                      <Activity className="w-3 h-3 text-emerald-400" />
                      <span>FLAPPING VELOCITY ({activeWindowLabel.toUpperCase()})</span>
                    </span>
                    <span className={isTripped ? 'text-rose-400 font-bold' : 'text-emerald-400'}>
                      {isTripped ? 'THRESHOLD BREACHED' : 'STABLE'}
                    </span>
                  </div>
                  <div className="flex items-end space-x-1.5 h-12 pt-1">
                    {svc.history.map((val, i) => (
                      <div
                        key={i}
                        style={{ height: `${Math.max(15, val)}%` }}
                        className={`flex-1 rounded-t transition-all ${
                          isTripped ? 'bg-rose-500/80' : val > 20 ? 'bg-amber-400' : 'bg-emerald-500/60'
                        }`}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {isTripped ? (
                <div className="pt-4 border-t border-slate-800 flex items-center justify-between">
                  <div className="text-[11px] text-rose-400 flex items-center space-x-1.5 font-mono">
                    <ShieldAlert className="w-4 h-4" />
                    <span>Requires Operator Level 5 Override</span>
                  </div>
                  <button
                    onClick={() => unlockCircuit(svc.name)}
                    className="px-4 py-2 bg-rose-500 hover:bg-rose-400 text-slate-950 font-bold rounded-xl text-xs font-mono transition flex items-center space-x-1.5"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Emergency Reset</span>
                  </button>
                </div>
              ) : (
                <div className="pt-4 border-t border-slate-800 text-xs text-slate-500 flex items-center justify-between font-mono">
                  <div className="flex items-center space-x-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    <span>Sovereign circuit healthy</span>
                  </div>
                  <button
                    onClick={() => triggerProbe(svc.name, false)}
                    className="text-[11px] text-slate-400 hover:text-white underline"
                  >
                    Send Test Probe
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

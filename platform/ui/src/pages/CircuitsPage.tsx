import { useTelemetry } from '../context/TelemetryContext';
import { Zap, ShieldCheck, ShieldAlert, RotateCcw, Activity, Flame } from 'lucide-react';
import { InfoTooltip } from '../components/common/Tooltip';

export function CircuitsPage() {
  const { serviceCircuits, unlockCircuit, triggerProbe, globalRange, customMinutes } = useTelemetry();
  const activeWindowLabel = globalRange === 'custom' ? `${customMinutes}m` : globalRange;
  const rangeMultiplier =
    globalRange === '5m' ? 1 :
    globalRange === '15m' ? 1.15 :
    globalRange === '30m' ? 1.25 :
    globalRange === '1h' ? 1.35 : 1.45;

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-2xl font-bold text-white tracking-tight">Circuit Breaker Fleet</h1>
            <InfoTooltip content="3 strikes within 60 seconds isolates the service with HTTP 423 Locked. Use '+1 Strike Probe' or 'Force Trip' on any card to test isolation." />
          </div>
          <p className="text-xs text-slate-300 mt-1">
            Anti-flapping sovereign fence • Active Telemetry Window:{' '}
            <span className="text-emerald-400 font-mono font-bold">{activeWindowLabel}</span>
          </p>
        </div>
        <button
          onClick={() => triggerProbe('order-service', true)}
          className="px-4 py-2 bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-xs text-rose-300 rounded-xl transition font-mono font-bold flex items-center space-x-1.5"
        >
          <Zap className="w-3.5 h-3.5 text-rose-400" />
          <span>Simulate Fleet Flapping Strike</span>
        </button>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {serviceCircuits.map((svc) => {
          const isTripped = svc.status === 'TRIPPED';
          return (
            <div
              key={svc.name}
              className={`p-6 rounded-2xl nf-card flex flex-col justify-between space-y-5 transition ${
                isTripped ? 'border-rose-500/60 shadow-[0_0_35px_rgba(244,63,94,0.15)]' : ''
              }`}
            >
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-bold text-white text-base font-mono">{svc.name}</span>
                    <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                      P99 Latency: <span className={isTripped ? 'text-rose-400 font-bold' : 'text-emerald-400'}>{svc.latencyMs}ms</span> • Error Rate:{' '}
                      <span className={svc.errorRate > 1 ? 'text-amber-400 font-bold' : 'text-slate-300'}>{svc.errorRate}%</span>
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-mono px-2.5 py-1 rounded-full font-bold ${
                      isTripped
                        ? 'bg-rose-950 text-rose-300 border border-rose-700 animate-pulse'
                        : svc.strikes === 2
                        ? 'bg-amber-950 text-amber-300 border border-amber-700'
                        : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                    }`}
                  >
                    {isTripped ? 'TRIPPED (HTTP 423)' : svc.strikes === 2 ? 'WARNING (2/3 STRIKES)' : 'CLOSED (NOMINAL)'}
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
                            num <= svc.strikes
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
                    <span className="text-slate-300 font-bold">({svc.strikes}/3)</span>
                  </div>
                  <span className="text-slate-400">Last Strike: {svc.lastStrike}</span>
                </div>

                {/* Dynamic Sparkline Scaled by Active Global Time Range */}
                <div className="p-3.5 rounded-xl bg-[#05070B] border border-white/10 space-y-2">
                  <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                    <span className="flex items-center space-x-1">
                      <Activity className="w-3 h-3 text-emerald-400" />
                      <span>FLAPPING VELOCITY ({activeWindowLabel.toUpperCase()})</span>
                    </span>
                    <span className={isTripped ? 'text-rose-400 font-bold' : svc.strikes > 0 ? 'text-amber-400' : 'text-emerald-400'}>
                      {isTripped ? 'ISOLATED (423 LOCK)' : svc.strikes > 0 ? 'ELEVATED JITTER' : 'STABLE'}
                    </span>
                  </div>
                  <div className="flex items-end space-x-1.5 h-14 pt-2">
                    {svc.history.map((val, i) => {
                      const scaled = Math.min(100, Math.max(18, Math.round(val * rangeMultiplier)));
                      return (
                        <div
                          key={i}
                          style={{ height: `${scaled}%` }}
                          className={`flex-1 rounded-t transition-all duration-300 ${
                            isTripped
                              ? 'bg-gradient-to-t from-rose-700 to-rose-400'
                              : scaled > 55
                              ? 'bg-gradient-to-t from-amber-600 to-amber-300'
                              : 'bg-gradient-to-t from-emerald-700/70 to-emerald-400'
                          }`}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>

              {isTripped ? (
                <div className="pt-4 border-t border-white/10 flex items-center justify-between">
                  <div className="text-[11px] text-rose-400 flex items-center space-x-1.5 font-mono">
                    <ShieldAlert className="w-4 h-4" />
                    <span>Requires Operator Level 5 Override</span>
                  </div>
                  <button
                    onClick={() => unlockCircuit(svc.name)}
                    className="px-4 py-2 bg-rose-500 hover:bg-rose-400 text-slate-950 font-bold rounded-xl text-xs font-mono transition flex items-center space-x-1.5 shadow-lg shadow-rose-500/20"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Emergency Reset</span>
                  </button>
                </div>
              ) : (
                <div className="pt-4 border-t border-white/10 text-xs text-slate-400 flex items-center justify-between font-mono">
                  <div className="flex items-center space-x-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    <span>Sovereign circuit healthy</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => triggerProbe(svc.name, false)}
                      className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] text-slate-200 transition"
                    >
                      +1 Strike Probe
                    </button>
                    <button
                      onClick={() => triggerProbe(svc.name, true)}
                      className="px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-[11px] text-rose-300 flex items-center space-x-1 transition"
                    >
                      <Flame className="w-3 h-3" />
                      <span>Force Trip</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

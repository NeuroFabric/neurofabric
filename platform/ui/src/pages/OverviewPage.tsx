import { useNavigate } from 'react-router-dom';
import { useTelemetry } from '../context/TelemetryContext';
import { Zap, Activity, Database, ArrowRight, Play, AlertTriangle } from 'lucide-react';

export function OverviewPage() {
  const navigate = useNavigate();
  const { logs, trippedCircuits, merkleStatus, injectAnomaly, emitHeartbeat } = useTelemetry();

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Mission Control Command Center</h1>
          <p className="text-xs text-slate-400 mt-1">
            Real-time situation room. Continuous edge telemetry, active circuit fences, and zero-trust GitOps.
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={emitHeartbeat}
            className="px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 rounded-xl text-xs font-mono font-medium flex items-center space-x-1.5 transition"
          >
            <Play className="w-3.5 h-3.5 text-cyan-400" />
            <span>Emit Heartbeat</span>
          </button>
          <button
            onClick={injectAnomaly}
            className="px-3 py-2 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/40 text-rose-300 rounded-xl text-xs font-mono font-medium flex items-center space-x-1.5 transition"
          >
            <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
            <span>Inject Anomaly & Leak</span>
          </button>
        </div>
      </div>

      {/* Bento Grid */}
      <div className="grid md:grid-cols-4 gap-4">
        <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800 md:col-span-2 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-slate-400 font-bold uppercase tracking-wider">Incident State</span>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950 text-emerald-300 border border-emerald-800">
              NOMINAL
            </span>
          </div>
          <div className="my-4">
            <div className="text-3xl font-extrabold text-white">ALL CLEAR</div>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              No active security breaches. Edge telemetries pass AST syntax verification.
            </p>
          </div>
          <button
            onClick={() => navigate('/alerts')}
            className="text-xs font-mono text-cyan-400 hover:underline flex items-center space-x-1 self-start"
          >
            <span>Inspect Live Stream</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>

        <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-slate-400 font-bold uppercase tracking-wider">Circuits</span>
            <Zap className="w-4 h-4 text-amber-400" />
          </div>
          <div className="my-2">
            <div className="text-3xl font-extrabold text-amber-400 font-mono">
              {trippedCircuits.length} TRIPPED
            </div>
            <div className="text-xs text-slate-400 mt-1">3 nominal services</div>
          </div>
          <button
            onClick={() => navigate('/circuits')}
            className="text-xs font-mono text-cyan-400 hover:underline flex items-center space-x-1 self-start"
          >
            <span>Manage Breakers</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>

        <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-slate-400 font-bold uppercase tracking-wider">Merkle Depth</span>
            <Database className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="my-2">
            <div className="text-3xl font-extrabold text-cyan-400 font-mono">
              {merkleStatus.totalLeaves}
            </div>
            <div className="text-xs text-slate-400 mt-1">Cryptographic leaves sealed</div>
          </div>
          <button
            onClick={() => navigate('/governance')}
            className="text-xs font-mono text-cyan-400 hover:underline flex items-center space-x-1 self-start"
          >
            <span>Verify Ledger</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* SVG Telemetry Waveform */}
      <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Activity className="w-4 h-4 text-cyan-400" />
            <span className="text-xs font-mono font-bold text-white uppercase tracking-wider">
              Real-Time Ingestion Throughput (14.2 evt/s rolling avg)
            </span>
          </div>
          <span className="text-[11px] font-mono text-slate-500">Propagation: &lt;85ms</span>
        </div>

        <div className="h-28 w-full bg-[#07090e] rounded-xl border border-slate-800/80 p-3 flex items-end">
          <svg viewBox="0 0 500 80" className="w-full h-full overflow-visible">
            <defs>
              <linearGradient id="waveGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.3" />
                <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.0" />
              </linearGradient>
            </defs>
            <path
              d="M0,50 Q40,20 80,45 T160,30 T240,60 T320,25 T400,40 T500,20 L500,80 L0,80 Z"
              fill="url(#waveGrad)"
            />
            <path
              d="M0,50 Q40,20 80,45 T160,30 T240,60 T320,25 T400,40 T500,20"
              fill="none"
              stroke="#06b6d4"
              strokeWidth="2"
            />
          </svg>
        </div>
      </div>

      {/* Recent Alerts Quick Preview */}
      <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-mono font-bold text-white uppercase tracking-wider">
            Recent Telemetry Stream
          </span>
          <button
            onClick={() => navigate('/alerts')}
            className="text-xs font-mono text-cyan-400 hover:underline flex items-center space-x-1"
          >
            <span>All Alerts</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>

        <div className="space-y-2 font-mono text-xs">
          {logs.slice(0, 3).map(log => (
            <div key={log.id} className="p-3 rounded-xl bg-slate-950 border border-slate-800/80 flex items-center justify-between gap-4">
              <div className="flex items-center space-x-3 truncate">
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                  log.severity === 'CRITICAL' ? 'bg-rose-950 text-rose-300' : 'bg-cyan-950 text-cyan-300'
                }`}>
                  {log.severity}
                </span>
                <span className="text-slate-300 font-bold">{log.service}:</span>
                <span className="text-slate-400 truncate">{log.message}</span>
              </div>
              <span className="text-[10px] text-slate-500 shrink-0">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

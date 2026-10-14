import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Radio, Clock, User, Calendar, Wifi, Play } from 'lucide-react';
import { useTelemetry, type TimeRange } from '../../context/TelemetryContext';

export function Topbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, status, latencyMs, globalRange, setGlobalRange, customMinutes, setCustomMinutes, emitHeartbeat } = useTelemetry();
  const [time, setTime] = useState('');
  const [isUTC, setIsUTC] = useState(false);
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [showStatusInfo, setShowStatusInfo] = useState(false);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTime(
        isUTC
          ? now.toUTCString().slice(17, 25) + ' UTC'
          : now.toLocaleTimeString('en-US', { hour12: false }) + ' LOCAL'
      );
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, [isUTC]);

  const pathName = location.pathname.replace('/', '') || 'overview';
  const breadcrumb = pathName.toUpperCase();
  const ranges: TimeRange[] = ['5m', '15m', '30m', '1h', '2h', '5h'];

  return (
    <header className="h-14 bg-[#0B0E17]/95 backdrop-blur-md border-b border-white/10 px-6 flex items-center justify-between text-xs select-none shrink-0 z-40 font-sans relative">
      <div className="flex items-center space-x-2 font-mono">
        <span className="text-slate-400 font-bold">NEUROFABRIC</span>
        <span className="text-slate-600">/</span>
        <span className="text-cyan-400 font-bold">{breadcrumb}</span>
        <span className="text-[10px] bg-indigo-500/15 border border-indigo-400/30 text-indigo-300 px-2 py-0.5 rounded ml-2 font-bold">
          RANGE: {globalRange === 'custom' ? `${customMinutes}M` : globalRange.toUpperCase()}
        </span>
      </div>

      {/* Global Time Range Selector */}
      <div className="hidden lg:flex items-center space-x-1 bg-[#121624] p-1 rounded-xl border border-white/10 font-mono text-[11px]">
        <span className="text-[10px] text-slate-400 px-2 font-bold uppercase tracking-wider">Time Window:</span>
        {ranges.map((r) => (
          <button
            key={r}
            onClick={() => {
              setGlobalRange(r);
              setShowCustomModal(false);
            }}
            className={`px-2.5 py-1 rounded-lg transition ${
              globalRange === r
                ? 'bg-gradient-to-r from-cyan-500 to-indigo-500 text-white font-bold shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            {r}
          </button>
        ))}
        <button
          onClick={() => setShowCustomModal(!showCustomModal)}
          className={`px-2.5 py-1 rounded-lg transition flex items-center space-x-1 ${
            globalRange === 'custom'
              ? 'bg-gradient-to-r from-cyan-500 to-indigo-500 text-white font-bold'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <Calendar className="w-3 h-3" />
          <span>{globalRange === 'custom' ? `${customMinutes}m` : 'Custom'}</span>
        </button>
      </div>

      {showCustomModal && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 mt-1 p-3.5 rounded-2xl bg-[#141928] border border-cyan-500/40 shadow-2xl flex items-center space-x-3 z-50 font-mono text-xs">
          <span className="text-slate-200">Custom Range (mins):</span>
          <input
            type="number"
            min={1}
            max={1440}
            value={customMinutes}
            onChange={(e) => setCustomMinutes(Number(e.target.value))}
            className="w-20 bg-[#080A10] border border-slate-700 rounded-lg px-2 py-1 text-white text-center"
          />
          <button
            onClick={() => {
              setGlobalRange('custom');
              setShowCustomModal(false);
            }}
            className="px-3 py-1 bg-cyan-400 text-slate-950 font-bold rounded-lg hover:bg-cyan-300"
          >
            Apply
          </button>
        </div>
      )}

      <div className="flex items-center space-x-3">
        <button
          onClick={() => setIsUTC(!isUTC)}
          title="Click to toggle Local / UTC time"
          className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-xl bg-[#121624] border border-white/10 hover:border-cyan-400/50 text-slate-200 font-mono transition"
        >
          <Clock className="w-3.5 h-3.5 text-cyan-400" />
          <span>{time}</span>
        </button>

        {/* Interactive Connection & Standalone Info Pill */}
        <div className="relative">
          <button
            onClick={() => setShowStatusInfo(!showStatusInfo)}
            className="flex items-center space-x-1.5 font-mono px-3 py-1.5 rounded-xl bg-[#121624] border border-white/10 hover:border-emerald-400/50 transition cursor-pointer"
          >
            <Radio className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
            <span className="text-emerald-400 font-bold">{status}</span>
            <span className="text-slate-400">({latencyMs}ms)</span>
          </button>

          {showStatusInfo && (
            <div className="absolute right-0 top-11 w-80 p-4 rounded-2xl bg-[#141928] border border-cyan-500/40 shadow-[0_16px_50px_rgba(0,0,0,0.9)] z-50 space-y-3 text-left">
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <div className="flex items-center space-x-2 font-mono font-bold text-cyan-400">
                  <Wifi className="w-4 h-4" />
                  <span>TELEMETRY ENGINE STATUS</span>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  ACTIVE
                </span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                {status === 'STANDALONE'
                  ? 'Running in browser-autonomous simulation mode. In-memory Web Crypto SHA-256 Merkle proofs, AST diff screening, and 1.5s telemetry waveforms are simulated locally without requiring port 8080.'
                  : 'Connected directly to the local NeuroFabric Supervisor Daemon on port 8080 via SSE EventBridge.'}
              </p>
              <div className="grid grid-cols-2 gap-2 font-mono text-[10px]">
                <div className="p-2 rounded-lg bg-[#090B12] border border-white/5">
                  <div className="text-slate-500">PROPAGATION</div>
                  <div className="text-emerald-400 font-bold mt-0.5">{latencyMs}ms (&lt;85ms SLA)</div>
                </div>
                <div className="p-2 rounded-lg bg-[#090B12] border border-white/5">
                  <div className="text-slate-500">CRYPTO ENGINE</div>
                  <div className="text-cyan-400 font-bold mt-0.5">WebCrypto SHA-256</div>
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={() => {
                    emitHeartbeat();
                    setShowStatusInfo(false);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono font-bold text-[11px] flex items-center space-x-1"
                >
                  <Play className="w-3 h-3" />
                  <span>Send Test Ping</span>
                </button>
                <button
                  onClick={() => setShowStatusInfo(false)}
                  className="text-[11px] font-mono text-slate-400 hover:text-white"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>

        <button
          onClick={() => navigate('/login')}
          title="Switch Operator Account"
          className="flex items-center space-x-2 px-3 py-1.5 rounded-xl bg-gradient-to-r from-indigo-500/20 to-cyan-500/20 border border-cyan-400/40 hover:border-cyan-300 transition text-cyan-200 font-mono font-bold"
        >
          <User className="w-3.5 h-3.5 text-cyan-400" />
          <span>{user.name} [{user.clearance}]</span>
        </button>
      </div>
    </header>
  );
}

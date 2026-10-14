import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Radio, Clock, User, Calendar, Wifi, Play, Palette } from 'lucide-react';
import { useTelemetry, type TimeRange, type UITheme } from '../../context/TelemetryContext';

export function Topbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    theme,
    setTheme,
    user,
    status,
    latencyMs,
    globalRange,
    setGlobalRange,
    customMinutes,
    setCustomMinutes,
    emitHeartbeat,
  } = useTelemetry();

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

  const cycleTheme = () => {
    const order: UITheme[] = ['apple-dark', 'aws-midnight', 'daylight'];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
  };

  const themeLabel =
    theme === 'apple-dark' ? 'Apple Pro' : theme === 'aws-midnight' ? 'AWS Ops' : 'Daylight';

  return (
    <header className="h-14 nf-glass border-b px-6 flex items-center justify-between text-xs select-none shrink-0 z-40 font-sans relative">
      <div className="flex items-center space-x-2 font-mono">
        <span className="text-slate-400 font-bold">NEUROFABRIC</span>
        <span className="text-slate-600">/</span>
        <span className="text-emerald-400 font-bold">{breadcrumb}</span>
        <span className="text-[10px] bg-emerald-500/15 border border-emerald-400/30 text-emerald-300 px-2 py-0.5 rounded ml-2 font-bold">
          RANGE: {globalRange === 'custom' ? `${customMinutes}M` : globalRange.toUpperCase()}
        </span>
      </div>

      {/* Global Time Window Selector */}
      <div className="hidden xl:flex items-center space-x-1 bg-[#121622] p-1 rounded-xl border border-white/10 font-mono text-[11px]">
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
                ? 'bg-emerald-500 text-slate-950 font-bold shadow'
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
              ? 'bg-emerald-500 text-slate-950 font-bold'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <Calendar className="w-3 h-3" />
          <span>{globalRange === 'custom' ? `${customMinutes}m` : 'Custom'}</span>
        </button>
      </div>

      {showCustomModal && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 mt-1 p-3.5 rounded-2xl nf-card border border-emerald-500/40 shadow-2xl flex items-center space-x-3 z-50 font-mono text-xs">
          <span className="text-slate-200">Custom Range (mins):</span>
          <input
            type="number"
            min={1}
            max={360}
            value={customMinutes}
            onChange={(e) => setCustomMinutes(Number(e.target.value))}
            className="w-20 bg-[#05070B] border border-slate-700 rounded-lg px-2 py-1 text-white text-center"
          />
          <button
            onClick={() => {
              setGlobalRange('custom');
              setShowCustomModal(false);
            }}
            className="px-3 py-1 bg-emerald-400 text-slate-950 font-bold rounded-lg hover:bg-emerald-300"
          >
            Apply
          </button>
        </div>
      )}

      <div className="flex items-center space-x-2.5">
        {/* Theme Switcher Button */}
        <button
          onClick={cycleTheme}
          title="Switch UI Theme (Apple Pro Dark / AWS Ops Midnight / Daylight)"
          className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-xl bg-[#121622] border border-white/10 hover:border-emerald-400/50 text-slate-200 font-mono transition"
        >
          <Palette className="w-3.5 h-3.5 text-emerald-400" />
          <span>{themeLabel}</span>
        </button>

        <button
          onClick={() => setIsUTC(!isUTC)}
          title="Click to toggle Local / UTC time"
          className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-xl bg-[#121622] border border-white/10 hover:border-emerald-400/50 text-slate-200 font-mono transition"
        >
          <Clock className="w-3.5 h-3.5 text-emerald-400" />
          <span>{time}</span>
        </button>

        <div className="relative">
          <button
            onClick={() => setShowStatusInfo(!showStatusInfo)}
            className="flex items-center space-x-1.5 font-mono px-3 py-1.5 rounded-xl bg-[#121622] border border-white/10 hover:border-emerald-400/50 transition cursor-pointer"
          >
            <Radio className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
            <span className="text-emerald-400 font-bold">{status}</span>
            <span className="text-slate-400">({latencyMs}ms)</span>
          </button>

          {showStatusInfo && (
            <div className="absolute right-0 top-11 w-80 p-4 rounded-2xl nf-card border border-emerald-500/40 shadow-2xl z-50 space-y-3 text-left">
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <div className="flex items-center space-x-2 font-mono font-bold text-emerald-400">
                  <Wifi className="w-4 h-4" />
                  <span>TELEMETRY ENGINE STATUS</span>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  ONLINE
                </span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                Autonomous browser-native WebCrypto SHA-256 Merkle engine, AST syntax gate, and 6-hour epoch ring buffer are active.
              </p>
              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={() => {
                    emitHeartbeat();
                    setShowStatusInfo(false);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono font-bold text-[11px] flex items-center space-x-1"
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
          className="flex items-center space-x-2 px-3 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-400/40 hover:border-emerald-300 transition text-emerald-200 font-mono font-bold"
        >
          <User className="w-3.5 h-3.5 text-emerald-400" />
          <span>{user.name} [{user.clearance}]</span>
        </button>
      </div>
    </header>
  );
}

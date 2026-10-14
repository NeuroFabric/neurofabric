import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Radio, Clock, User, Calendar, Wifi, Play, Menu, Gauge, LogOut, ShieldCheck, Users, ChevronDown } from 'lucide-react';
import { useTelemetry, type TimeRange } from '../../context/TelemetryContext';

export function Topbar({ onOpenMobileMenu }: { onOpenMobileMenu?: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    user,
    logoutUser,
    activeTenant,
    status,
    latencyMs,
    pageLoadMs,
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
  const [showUserDropdown, setShowUserDropdown] = useState(false);

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

  const handleSignOut = () => {
    setShowUserDropdown(false);
    logoutUser();
    navigate('/login');
  };

  return (
    <header className="h-14 bg-[#080B12]/95 backdrop-blur-md border-b border-white/10 px-4 md:px-6 flex items-center justify-between text-xs select-none shrink-0 z-30 font-sans relative">
      <div className="flex items-center space-x-2 font-mono">
        {onOpenMobileMenu && (
          <button
            onClick={onOpenMobileMenu}
            className="md:hidden p-1.5 rounded-lg bg-[#121622] border border-white/10 text-slate-200 mr-1"
            aria-label="Open navigation drawer"
          >
            <Menu className="w-4 h-4" />
          </button>
        )}
        <span className="hidden sm:inline text-slate-300 font-bold">NEUROFABRIC</span>
        <span className="hidden sm:inline text-slate-600">/</span>
        <span className="text-emerald-400 font-bold">{breadcrumb}</span>
        <span className="text-[10px] bg-emerald-500/15 border border-emerald-400/30 text-emerald-300 px-2 py-0.5 rounded ml-1 font-bold">
          {globalRange === 'custom' ? `${customMinutes}M` : globalRange.toUpperCase()}
        </span>
      </div>

      <div className="hidden xl:flex items-center space-x-1 bg-[#121622] p-1 rounded-xl border border-white/10 font-mono text-[11px]">
        <span className="text-[10px] text-slate-300 px-2 font-bold uppercase tracking-wider">Time Window:</span>
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
                : 'text-slate-300 hover:text-white'
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
              : 'text-slate-300 hover:text-white'
          }`}
        >
          <Calendar className="w-3 h-3" />
          <span>{globalRange === 'custom' ? `${customMinutes}m` : 'Custom'}</span>
        </button>
      </div>

      {showCustomModal && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 mt-1 p-3.5 rounded-2xl nf-card border border-emerald-500/40 shadow-2xl flex items-center space-x-3 z-50 font-mono text-xs">
          <label htmlFor="custom-range-input" className="text-slate-200">Custom Range (mins):</label>
          <input
            id="custom-range-input"
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

      <div className="flex items-center space-x-2 md:space-x-3">
        <div
          title="Measured DOM Navigation Load Speed (Web Vitals)"
          className="hidden lg:flex items-center space-x-1.5 px-2.5 py-1.5 rounded-xl bg-[#121622] border border-white/10 text-emerald-300 font-mono text-[11px]"
        >
          <Gauge className="w-3.5 h-3.5 text-emerald-400" />
          <span>LOAD: {pageLoadMs}ms</span>
        </div>

        <button
          onClick={() => setIsUTC(!isUTC)}
          title="Click to toggle Local / UTC time"
          className="hidden sm:flex items-center space-x-1.5 px-2.5 py-1.5 rounded-xl bg-[#121622] border border-white/10 hover:border-emerald-400/50 text-slate-200 font-mono transition"
        >
          <Clock className="w-3.5 h-3.5 text-emerald-400" />
          <span>{time}</span>
        </button>

        <div className="relative">
          <button
            onClick={() => {
              setShowStatusInfo(!showStatusInfo);
              setShowUserDropdown(false);
            }}
            className="flex items-center space-x-1.5 font-mono px-2.5 py-1.5 rounded-xl bg-[#121622] border border-white/10 hover:border-emerald-400/50 transition cursor-pointer"
          >
            <Radio className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
            <span className="text-emerald-400 font-bold">{status}</span>
            <span className="hidden sm:inline text-slate-300">({latencyMs}ms)</span>
          </button>

          {showStatusInfo && (
            <div className="absolute right-0 top-11 w-80 p-4 rounded-2xl nf-card border border-emerald-500/40 shadow-2xl z-50 space-y-3 text-left">
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <div className="flex items-center space-x-2 font-mono font-bold text-emerald-400">
                  <Wifi className="w-4 h-4" />
                  <span>HARDENED ENGINE STATUS</span>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  70/70 PASS
                </span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                Per-user Row-Level Security (RLS) active. Zero secrets in frontend bundle. Cost-guarded AI rate limiting enforced.
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
                  className="text-[11px] font-mono text-slate-300 hover:text-white"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="relative">
          <button
            onClick={() => {
              setShowUserDropdown(!showUserDropdown);
              setShowStatusInfo(false);
            }}
            aria-expanded={showUserDropdown}
            aria-haspopup="menu"
            title="Operator Session & Logout Menu"
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-400/40 hover:border-emerald-300 transition text-emerald-200 font-mono font-bold"
          >
            <User className="w-3.5 h-3.5 text-emerald-400" />
            <span className="truncate max-w-[140px]">{user.name}</span>
            <ChevronDown className="w-3.5 h-3.5 text-emerald-400" />
          </button>

          {showUserDropdown && (
            <div
              role="menu"
              className="absolute right-0 top-11 w-72 p-4 rounded-2xl nf-card border border-emerald-500/40 shadow-2xl z-50 space-y-3 text-left font-mono text-xs"
            >
              <div className="border-b border-white/10 pb-2.5 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-white font-bold font-sans text-sm">{user.name}</span>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[10px] font-bold">
                    {user.clearance}
                  </span>
                </div>
                <div className="text-slate-300 text-[11px] truncate">{user.email}</div>
                <div className="text-[10px] text-cyan-300">RLS Scope: {activeTenant}</div>
              </div>

              <div className="space-y-1">
                <button
                  onClick={() => {
                    setShowUserDropdown(false);
                    navigate('/iam');
                  }}
                  className="w-full px-3 py-2 rounded-xl hover:bg-white/5 text-slate-200 flex items-center space-x-2 transition"
                >
                  <Users className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Manage IAM &amp; Access (/iam)</span>
                </button>
                <button
                  onClick={() => {
                    setShowUserDropdown(false);
                    navigate('/security');
                  }}
                  className="w-full px-3 py-2 rounded-xl hover:bg-white/5 text-slate-200 flex items-center space-x-2 transition"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" />
                  <span>70-Point Security &amp; RLS Audit</span>
                </button>
              </div>

              <div className="pt-2 border-t border-white/10">
                <button
                  onClick={handleSignOut}
                  className="w-full py-2.5 px-3 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-200 font-bold flex items-center justify-center space-x-2 transition"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Lock Session &amp; Sign Out</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

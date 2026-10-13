import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Radio, Clock, User } from 'lucide-react';
import { useTelemetry } from '../../context/TelemetryContext';
import { InfoTooltip } from '../common/Tooltip';

export function Topbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { status, latencyMs } = useTelemetry();
  const [time, setTime] = useState('');
  const [isUTC, setIsUTC] = useState(false);

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

  return (
    <header className="h-14 bg-[#0D0F15]/90 backdrop-blur border-b border-slate-800/80 px-6 flex items-center justify-between text-xs select-none shrink-0 z-30 font-sans">
      <div className="flex items-center space-x-2 font-mono">
        <span className="text-slate-500 font-bold">NEUROFABRIC</span>
        <span className="text-slate-600">/</span>
        <span className="text-emerald-400 font-bold">{breadcrumb}</span>
        <span className="text-[10px] bg-[#141720] border border-slate-700/60 text-slate-400 px-2 py-0.5 rounded ml-2">
          LIVE EDGE
        </span>
      </div>

      <div className="flex items-center space-x-4">
        <button
          onClick={() => setIsUTC(!isUTC)}
          className="flex items-center space-x-1.5 px-2.5 py-1 rounded-xl bg-[#141720] border border-slate-800 hover:border-slate-700 text-slate-300 font-mono transition"
        >
          <Clock className="w-3 h-3 text-emerald-400" />
          <span>{time}</span>
        </button>

        <div className="flex items-center space-x-1.5 font-mono px-2.5 py-1 rounded-xl bg-[#141720] border border-slate-800">
          <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
          <span className="text-emerald-400 font-bold">{status}</span>
          <span className="text-slate-500">({latencyMs}ms)</span>
          <InfoTooltip content="Real-time SSE EventBridge link to Sovereign SQLite pub/sub engine." />
        </div>

        <button
          onClick={() => navigate('/login')}
          className="flex items-center space-x-2 px-3 py-1 rounded-xl bg-emerald-950/60 border border-emerald-800 hover:border-emerald-600 transition text-emerald-300 font-mono font-medium"
        >
          <User className="w-3.5 h-3.5" />
          <span>Alex Vance [LEVEL 5]</span>
        </button>
      </div>
    </header>
  );
}

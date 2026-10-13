import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, LayoutDashboard, Activity, ShieldAlert, Zap, Database, Network, LifeBuoy, Sparkles, Play, AlertTriangle } from 'lucide-react';
import { useTelemetry } from '../../context/TelemetryContext';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function CommandPalette({ isOpen, onClose }: Props) {
  const navigate = useNavigate();
  const { emitHeartbeat, injectAnomaly } = useTelemetry();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const actions = [
    { id: 'nav-overview', label: 'Go to Command Center', icon: LayoutDashboard, category: 'Navigation', run: () => navigate('/overview') },
    { id: 'nav-alerts', label: 'Go to Live Alerts', icon: Activity, category: 'Navigation', run: () => navigate('/alerts') },
    { id: 'nav-embassy', label: 'Go to Patch Review (HITL)', icon: ShieldAlert, category: 'Navigation', run: () => navigate('/embassy') },
    { id: 'nav-circuits', label: 'Go to Circuit Breakers', icon: Zap, category: 'Navigation', run: () => navigate('/circuits') },
    { id: 'nav-governance', label: 'Go to Merkle Audit Ledger', icon: Database, category: 'Navigation', run: () => navigate('/governance') },
    { id: 'nav-topology', label: 'Go to Cluster Topology', icon: Network, category: 'Navigation', run: () => navigate('/topology') },
    { id: 'nav-support', label: 'Go to Diagnostic Desk', icon: LifeBuoy, category: 'Navigation', run: () => navigate('/support') },
    { id: 'nav-roadmap', label: 'Go to Future Roadmap', icon: Sparkles, category: 'Navigation', run: () => navigate('/roadmap') },
    { id: 'act-heartbeat', label: 'Emit Gateway Heartbeat (14.2 evt/s)', icon: Play, category: 'Actions', run: () => emitHeartbeat() },
    { id: 'act-anomaly', label: 'Inject Anomaly & DLP Leak', icon: AlertTriangle, category: 'Actions', run: () => injectAnomaly() },
  ];

  const filtered = actions.filter(a => a.label.toLowerCase().includes(query.toLowerCase()) || a.category.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % (filtered.length || 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + filtered.length) % (filtered.length || 1));
      } else if (e.key === 'Enter' && filtered[selectedIndex]) {
        e.preventDefault();
        filtered[selectedIndex].run();
        onClose();
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, filtered, selectedIndex, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-[#07090e]/80 backdrop-blur-md z-50 flex items-start justify-center pt-[15vh] p-4 select-none">
      <div className="w-full max-w-xl rounded-2xl bg-[#0d121d] border border-slate-800 shadow-2xl overflow-hidden font-sans">
        <div className="flex items-center space-x-3 px-4 border-b border-slate-800">
          <Search className="w-4 h-4 text-cyan-400 shrink-0" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Type a command or jump to page..."
            className="w-full py-3.5 bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none font-mono"
            autoFocus
          />
          <kbd className="text-[10px] font-mono text-slate-500 border border-slate-800 px-1.5 py-0.5 rounded">ESC</kbd>
        </div>

        <div className="max-h-80 overflow-y-auto p-2 space-y-1">
          {filtered.map((item, idx) => {
            const Icon = item.icon;
            const isSelected = idx === selectedIndex;
            return (
              <div
                key={item.id}
                onClick={() => { item.run(); onClose(); }}
                className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl cursor-pointer text-xs transition ${
                  isSelected ? 'bg-cyan-500/10 text-cyan-300 font-bold border border-cyan-500/30' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                }`}
              >
                <div className="flex items-center space-x-3">
                  <Icon className="w-4 h-4 shrink-0 text-cyan-400" />
                  <span>{item.label}</span>
                </div>
                <span className="text-[10px] font-mono text-slate-600 uppercase">{item.category}</span>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="p-8 text-center text-xs text-slate-500 font-mono">No matching commands found.</div>
          )}
        </div>
      </div>
    </div>
  );
}

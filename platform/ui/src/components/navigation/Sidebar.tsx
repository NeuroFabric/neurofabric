import { useTelemetry, ConnectionStatus } from '../../context/TelemetryContext';

export type PageId = 'overview' | 'telemetry' | 'embassy' | 'governance' | 'topology';

interface SidebarProps {
  currentPage: PageId;
  onNavigate: (page: PageId) => void;
  onExit: () => void;
}

export function Sidebar({ currentPage, onNavigate, onExit }: SidebarProps) {
  const { status, trippedCircuits } = useTelemetry();

  const links: { id: PageId; label: string; badge?: string; badgeColor?: string }[] = [
    { id: 'overview', label: 'Command Center' },
    { id: 'telemetry', label: 'Live Telemetry & DLP' },
    { 
      id: 'embassy', 
      label: 'Autonomous Embassy',
      badge: trippedCircuits.length > 0 ? `${trippedCircuits.length} TRIPPED` : undefined,
      badgeColor: 'bg-rose-950 text-rose-400 border border-rose-800'
    },
    { id: 'governance', label: 'Merkle Audit Ledger' },
    { id: 'topology', label: 'Cluster Topology' },
  ];

  return (
    <aside className="w-64 bg-[#0d121d] border-r border-slate-800 flex flex-col justify-between shrink-0 select-none">
      <div>
        {/* Brand Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-cyan-500 flex items-center justify-center font-black text-slate-950 text-sm shadow-lg shadow-cyan-500/20">
              NF
            </div>
            <div>
              <div className="font-bold text-white tracking-tight leading-none">NeuroFabric</div>
              <div className="text-[10px] text-slate-500 font-mono mt-1">ENTERPRISE SRE HUD</div>
            </div>
          </div>
        </div>

        {/* Real-time SSE Connection Indicator */}
        <div className="px-5 py-3 bg-slate-900/60 border-b border-slate-800/80 flex items-center justify-between text-xs font-mono">
          <span className="text-slate-400">Telemetry Bus</span>
          <span
            className={`inline-flex items-center gap-1.5 font-bold ${
              status === ConnectionStatus.Connected
                ? 'text-emerald-400'
                : status === ConnectionStatus.Reconnecting
                ? 'text-amber-400'
                : 'text-rose-400'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                status === ConnectionStatus.Connected
                  ? 'bg-emerald-400 animate-pulse'
                  : 'bg-amber-400'
              }`}
            />
            {status}
          </span>
        </div>

        {/* Navigation Items */}
        <nav className="p-3 space-y-1">
          {links.map((link) => {
            const active = currentPage === link.id;
            return (
              <button
                key={link.id}
                onClick={() => onNavigate(link.id)}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition ${
                  active
                    ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border border-transparent'
                }`}
              >
                <span>{link.label}</span>
                {link.badge && (
                  <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-bold ${link.badgeColor}`}>
                    {link.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Return to Home / Sign Out */}
      <div className="p-4 border-t border-slate-800">
        <button
          onClick={onExit}
          className="w-full py-2.5 px-3 rounded-lg text-xs font-medium text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition flex items-center justify-center space-x-2"
        >
          <span>← Exit Console to Landing</span>
        </button>
      </div>
    </aside>
  );
}

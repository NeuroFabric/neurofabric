import { motion } from 'framer-motion';
import {
  LayoutDashboard,
  Activity,
  ShieldAlert,
  Database,
  Network,
  LifeBuoy,
  Sparkles,
  LogOut,
} from 'lucide-react';
import { useTelemetry, ConnectionStatus } from '../../context/TelemetryContext';
import { Logo } from '../common/Logo';

export type PageId = 'overview' | 'telemetry' | 'embassy' | 'governance' | 'topology' | 'support' | 'roadmap';

interface SidebarProps {
  currentPage: PageId;
  onNavigate: (page: PageId) => void;
  onExit: () => void;
}

export function Sidebar({ currentPage, onNavigate, onExit }: SidebarProps) {
  const { status, trippedCircuits } = useTelemetry();

  const primaryLinks = [
    { id: 'overview' as PageId, label: 'Command Center', icon: LayoutDashboard },
    { id: 'telemetry' as PageId, label: 'Live Telemetry & DLP', icon: Activity },
    {
      id: 'embassy' as PageId,
      label: 'Autonomous Embassy',
      icon: ShieldAlert,
      badge: trippedCircuits.length > 0 ? `${trippedCircuits.length} TRIPPED` : undefined,
    },
    { id: 'governance' as PageId, label: 'Merkle Audit Ledger', icon: Database },
    { id: 'topology' as PageId, label: 'Cluster Topology', icon: Network },
  ];

  const secondaryLinks = [
    { id: 'support' as PageId, label: 'Incident Desk & Query', icon: LifeBuoy },
    { id: 'roadmap' as PageId, label: 'Future Ecosystem', icon: Sparkles, badge: 'NEW' },
  ];

  return (
    <aside className="w-64 bg-[#0d121d] border-r border-slate-800/80 flex flex-col justify-between shrink-0 select-none z-20">
      <div>
        {/* Brand Header with Exact Isometric Logo */}
        <div className="p-4 border-b border-slate-800/80">
          <Logo size="md" />
        </div>

        {/* Real-Time SSE Status */}
        <div className="px-4 py-2.5 bg-slate-900/60 border-b border-slate-800/80 flex items-center justify-between text-xs font-mono">
          <span className="text-slate-400">Edge Stream</span>
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
                status === ConnectionStatus.Connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
              }`}
            />
            {status}
          </span>
        </div>

        {/* Primary Operational Links */}
        <div className="p-3">
          <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-slate-500 font-bold">
            Observability Mesh
          </div>
          <nav className="mt-1 space-y-1">
            {primaryLinks.map((link) => {
              const active = currentPage === link.id;
              const Icon = link.icon;
              return (
                <button
                  key={link.id}
                  onClick={() => onNavigate(link.id)}
                  className={`relative w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-medium transition ${
                    active ? 'text-cyan-400 font-bold' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {active && (
                    <motion.div
                      layoutId="activeSidebarPill"
                      className="absolute inset-0 bg-cyan-500/10 border border-cyan-500/30 rounded-xl -z-10 shadow-sm shadow-cyan-500/10"
                      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                    />
                  )}
                  <div className="flex items-center space-x-3">
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{link.label}</span>
                  </div>
                  {link.badge && (
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full font-bold bg-rose-950 text-rose-400 border border-rose-800">
                      {link.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Secondary Links */}
        <div className="p-3 pt-0">
          <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-slate-500 font-bold">
            Ecosystem & Support
          </div>
          <nav className="mt-1 space-y-1">
            {secondaryLinks.map((link) => {
              const active = currentPage === link.id;
              const Icon = link.icon;
              return (
                <button
                  key={link.id}
                  onClick={() => onNavigate(link.id)}
                  className={`relative w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-medium transition ${
                    active ? 'text-cyan-400 font-bold' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {active && (
                    <motion.div
                      layoutId="activeSidebarPill"
                      className="absolute inset-0 bg-cyan-500/10 border border-cyan-500/30 rounded-xl -z-10 shadow-sm shadow-cyan-500/10"
                      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                    />
                  )}
                  <div className="flex items-center space-x-3">
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{link.label}</span>
                  </div>
                  {link.badge && (
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full font-bold bg-cyan-950 text-cyan-400 border border-cyan-800">
                      {link.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Exit Button */}
      <div className="p-4 border-t border-slate-800/80">
        <button
          onClick={onExit}
          className="w-full py-2.5 px-3 rounded-xl text-xs font-medium text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition flex items-center justify-center space-x-2 border border-transparent hover:border-rose-500/20"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Exit to Public Portal</span>
        </button>
      </div>
    </aside>
  );
}

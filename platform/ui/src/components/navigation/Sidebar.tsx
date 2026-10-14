import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Activity,
  ShieldAlert,
  Database,
  Network,
  LifeBuoy,
  Sparkles,
  Zap,
  Table,
  LogOut,
} from 'lucide-react';
import { useTelemetry } from '../../context/TelemetryContext';
import { Logo } from '../common/Logo';

export function Sidebar() {
  const { trippedCircuits, logs, proposals } = useTelemetry();
  const pendingCount = proposals.filter((p) => p.status === 'PENDING').length;

  const primaryNav = [
    { to: '/overview', label: 'Command Center', icon: LayoutDashboard },
    { to: '/alerts', label: 'Live Alerts', icon: Activity, badge: logs.length > 0 ? `${logs.length}` : undefined },
    { to: '/telemetry', label: 'Telemetry Explorer', icon: Table },
    {
      to: '/embassy',
      label: 'Patch Review (HITL)',
      icon: ShieldAlert,
      badge: pendingCount > 0 ? `${pendingCount} PENDING` : 'ALL REVIEWED',
    },
    {
      to: '/circuits',
      label: 'Circuit Breakers',
      icon: Zap,
      badge: trippedCircuits.length > 0 ? `${trippedCircuits.length} TRIPPED` : undefined,
    },
    { to: '/governance', label: 'Merkle Audit Ledger', icon: Database },
    { to: '/topology', label: 'Cluster Topology', icon: Network, badge: 'LIVE SIM' },
  ];

  const secondaryNav = [
    { to: '/support', label: 'Incident Desk & Query', icon: LifeBuoy },
    { to: '/roadmap', label: 'Future Ecosystem', icon: Sparkles, badge: 'ROADMAP' },
  ];

  return (
    <aside className="w-64 bg-[#0B0E17] border-r border-white/10 flex flex-col justify-between shrink-0 select-none z-20">
      <div>
        <div className="p-4 border-b border-white/10">
          <Logo size="md" />
        </div>

        <div className="p-3">
          <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-slate-400 font-bold">
            Observability Mesh
          </div>
          <nav className="mt-1 space-y-1">
            {primaryNav.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `relative w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-medium transition ${
                      isActive
                        ? 'text-white font-bold bg-gradient-to-r from-cyan-500/20 to-indigo-500/20 border border-cyan-400/40 shadow-sm'
                        : 'text-slate-400 hover:text-slate-100 hover:bg-white/5 border border-transparent'
                    }`
                  }
                >
                  <div className="flex items-center space-x-3">
                    <Icon className="w-4 h-4 shrink-0 text-cyan-400" />
                    <span>{item.label}</span>
                  </div>
                  {item.badge && (
                    <span
                      className={`text-[9px] font-mono px-1.5 py-0.5 rounded-full font-bold ${
                        item.badge.includes('TRIPPED')
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                          : item.badge.includes('PENDING')
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                          : 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </NavLink>
              );
            })}
          </nav>
        </div>

        <div className="p-3 pt-0">
          <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-slate-400 font-bold">
            Ecosystem & Support
          </div>
          <nav className="mt-1 space-y-1">
            {secondaryNav.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `relative w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-medium transition ${
                      isActive
                        ? 'text-white font-bold bg-gradient-to-r from-cyan-500/20 to-indigo-500/20 border border-cyan-400/40'
                        : 'text-slate-400 hover:text-slate-100 hover:bg-white/5 border border-transparent'
                    }`
                  }
                >
                  <div className="flex items-center space-x-3">
                    <Icon className="w-4 h-4 shrink-0 text-indigo-400" />
                    <span>{item.label}</span>
                  </div>
                  {item.badge && (
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                      {item.badge}
                    </span>
                  )}
                </NavLink>
              );
            })}
          </nav>
        </div>
      </div>

      <div className="p-4 border-t border-white/10">
        <NavLink
          to="/"
          className="w-full py-2.5 px-3 rounded-xl text-xs font-medium text-slate-300 hover:text-rose-300 hover:bg-rose-500/15 transition flex items-center justify-center space-x-2 border border-white/5 hover:border-rose-500/30"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Exit to Launch Portal</span>
        </NavLink>
      </div>
    </aside>
  );
}

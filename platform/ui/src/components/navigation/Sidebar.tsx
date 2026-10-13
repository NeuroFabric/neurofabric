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
  const { trippedCircuits, logs } = useTelemetry();

  const primaryNav = [
    { to: '/overview', label: 'Command Center', icon: LayoutDashboard },
    { to: '/alerts', label: 'Live Alerts', icon: Activity, badge: logs.length > 0 ? `${logs.length}` : undefined },
    { to: '/telemetry', label: 'Telemetry Explorer', icon: Table },
    { to: '/embassy', label: 'Patch Review (HITL)', icon: ShieldAlert, badge: '1 PENDING' },
    { to: '/circuits', label: 'Circuit Breakers', icon: Zap, badge: trippedCircuits.length > 0 ? `${trippedCircuits.length} TRIPPED` : undefined },
    { to: '/governance', label: 'Merkle Audit Ledger', icon: Database },
    { to: '/topology', label: 'Cluster Topology', icon: Network },
  ];

  const secondaryNav = [
    { to: '/support', label: 'Incident Desk & Query', icon: LifeBuoy },
    { to: '/roadmap', label: 'Future Ecosystem', icon: Sparkles, badge: 'NEW' },
  ];

  return (
    <aside className="w-64 bg-[#0D0F15] border-r border-slate-800/80 flex flex-col justify-between shrink-0 select-none z-20">
      <div>
        <div className="p-4 border-b border-slate-800/80">
          <Logo size="md" />
        </div>

        <div className="p-3">
          <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-slate-500 font-bold">
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
                        ? 'text-emerald-400 font-bold bg-emerald-500/10 border border-emerald-500/30'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 border border-transparent'
                    }`
                  }
                >
                  <div className="flex items-center space-x-3">
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </div>
                  {item.badge && (
                    <span
                      className={`text-[9px] font-mono px-1.5 py-0.5 rounded-full font-bold ${
                        item.badge.includes('TRIPPED')
                          ? 'bg-rose-950 text-rose-400 border border-rose-800'
                          : item.badge.includes('PENDING')
                          ? 'bg-amber-950 text-amber-300 border border-amber-800'
                          : 'bg-slate-800 text-slate-300'
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
          <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-slate-500 font-bold">
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
                        ? 'text-emerald-400 font-bold bg-emerald-500/10 border border-emerald-500/30'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 border border-transparent'
                    }`
                  }
                >
                  <div className="flex items-center space-x-3">
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </div>
                  {item.badge && (
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full font-bold bg-emerald-950 text-emerald-400 border border-emerald-800">
                      {item.badge}
                    </span>
                  )}
                </NavLink>
              );
            })}
          </nav>
        </div>
      </div>

      <div className="p-4 border-t border-slate-800/80">
        <NavLink
          to="/"
          className="w-full py-2.5 px-3 rounded-xl text-xs font-medium text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition flex items-center justify-center space-x-2 border border-transparent hover:border-rose-500/20"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Exit to Public Portal</span>
        </NavLink>
      </div>
    </aside>
  );
}

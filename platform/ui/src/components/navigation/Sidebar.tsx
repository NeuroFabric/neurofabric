import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Activity,
  ShieldAlert,
  ShieldCheck,
  Database,
  Network,
  LifeBuoy,
  Sparkles,
  Zap,
  Table,
  Flame,
  Radio,
  Users,
  LogOut,
  X,
} from 'lucide-react';
import { useTelemetry } from '../../context/TelemetryContext';
import { Logo } from '../common/Logo';

interface SidebarProps {
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}

export function Sidebar({ mobileOpen = false, onCloseMobile }: SidebarProps) {
  const { trippedCircuits, logs, proposals, accessRequests, stress, logoutUser } = useTelemetry();
  const pendingCount = proposals.filter((p) => p.status === 'PENDING').length;
  const pendingReqCount = accessRequests.filter((r) => r.status === 'PENDING').length;

  const remSec = Math.max(0, stress.totalDurationSec - stress.elapsedSec);
  const stressBadge = stress.active
    ? `${Math.floor(remSec / 60)}:${(remSec % 60).toString().padStart(2, '0')} LIVE`
    : '15M SOAK';

  const primaryNav = [
    { to: '/overview', label: 'Command Center', icon: LayoutDashboard },
    {
      to: '/iam',
      label: 'User Access Portal (IAM)',
      icon: Users,
      badge: pendingReqCount > 0 ? `${pendingReqCount} REQ` : 'RBAC',
    },
    { to: '/stress', label: 'Stress & QA Lab (15m)', icon: Flame, badge: stressBadge },
    { to: '/alerts', label: 'Live Alerts Stream', icon: Activity, badge: logs.length > 0 ? `${logs.length}` : undefined },
    { to: '/telemetry', label: 'Telemetry Explorer', icon: Table },
    { to: '/integrations', label: 'Ingestion & Connectors', icon: Radio, badge: 'REST/OTEL' },
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

  // Security & India Gov remains third-last as requested
  const secondaryNav = [
    { to: '/security', label: 'Security & India Gov', icon: ShieldCheck, badge: 'DPDP/CERT' },
    { to: '/support', label: 'Incident Desk & Query', icon: LifeBuoy },
    { to: '/roadmap', label: 'Future Ecosystem', icon: Sparkles, badge: 'ROADMAP' },
  ];

  return (
    <>
      {mobileOpen && (
        <div
          onClick={onCloseMobile}
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40 md:hidden"
        />
      )}
      <aside
        className={`${
          mobileOpen ? 'fixed inset-y-0 left-0 z-50 flex' : 'hidden md:flex'
        } w-64 bg-[#080B12] border-r border-white/10 flex-col justify-between shrink-0 select-none z-20`}
      >
        <div>
          <div className="p-4 border-b border-white/10 flex items-center justify-between">
            <Logo size="md" />
            {onCloseMobile && (
              <button
                onClick={onCloseMobile}
                className="md:hidden p-1.5 rounded-lg text-slate-400 hover:text-white"
                aria-label="Close navigation menu"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          <div className="p-3">
            <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-slate-400 font-bold">
              Observability &amp; IAM Mesh
            </div>
            <nav className="mt-1 space-y-1">
              {primaryNav.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={onCloseMobile}
                    className={({ isActive }) =>
                      `relative w-full flex items-center justify-between px-3.5 py-2 rounded-xl text-xs font-medium transition ${
                        isActive
                          ? 'text-white font-bold bg-gradient-to-r from-emerald-500/20 to-teal-500/10 border border-emerald-400/40 shadow-sm'
                          : 'text-slate-400 hover:text-slate-100 hover:bg-white/5 border border-transparent'
                      }`
                    }
                  >
                    <div className="flex items-center space-x-3">
                      <Icon className={`w-4 h-4 shrink-0 ${item.to === '/stress' && stress.active ? 'text-amber-400 animate-spin' : 'text-emerald-400'}`} />
                      <span>{item.label}</span>
                    </div>
                    {item.badge && (
                      <span
                        className={`text-[9px] font-mono px-1.5 py-0.5 rounded-full font-bold ${
                          item.badge.includes('LIVE') || item.badge.includes('REQ')
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-400 animate-pulse'
                            : item.badge.includes('TRIPPED')
                            ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                            : item.badge.includes('PENDING')
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                            : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
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
              Governance, Security &amp; Support
            </div>
            <nav className="mt-1 space-y-1">
              {secondaryNav.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={onCloseMobile}
                    className={({ isActive }) =>
                      `relative w-full flex items-center justify-between px-3.5 py-2 rounded-xl text-xs font-medium transition ${
                        isActive
                          ? 'text-white font-bold bg-gradient-to-r from-emerald-500/20 to-teal-500/10 border border-emerald-400/40'
                          : 'text-slate-400 hover:text-slate-100 hover:bg-white/5 border border-transparent'
                      }`
                    }
                  >
                    <div className="flex items-center space-x-3">
                      <Icon className="w-4 h-4 shrink-0 text-cyan-400" />
                      <span>{item.label}</span>
                    </div>
                    {item.badge && (
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                        {item.badge}
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </nav>
          </div>
        </div>

        <div className="p-4 border-t border-white/10 space-y-2">
          <div className="flex items-center justify-between text-[10px] font-mono text-slate-500 px-1">
            <NavLink to="/privacy" className="hover:text-emerald-400">Privacy</NavLink>
            <span>•</span>
            <NavLink to="/terms" className="hover:text-emerald-400">Terms</NavLink>
            <span>•</span>
            <NavLink to="/security" className="hover:text-emerald-400">DPDP/CERT-In</NavLink>
          </div>
          <NavLink
            to="/login"
            onClick={logoutUser}
            className="w-full py-2 px-3 rounded-xl text-xs font-medium text-slate-300 hover:text-rose-300 hover:bg-rose-500/15 transition flex items-center justify-center space-x-2 border border-white/5 hover:border-rose-500/30"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Lock Session &amp; Sign Out</span>
          </NavLink>
        </div>
      </aside>
    </>
  );
}

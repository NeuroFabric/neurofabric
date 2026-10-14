import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTelemetry } from '../context/TelemetryContext';
import { Search, Pause, Play, Trash2, ChevronRight, ChevronDown, ShieldAlert, Wrench } from 'lucide-react';
import { InfoTooltip } from '../components/common/Tooltip';
import { toast } from 'sonner';

export function AlertsPage() {
  const navigate = useNavigate();
  const { logs, clearLogs, synthesizeProposal, globalRange, customMinutes } = useTelemetry();
  const [paused, setPaused] = useState(false);
  const [frozenLogs, setFrozenLogs] = useState<typeof logs | null>(null);
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState<'ALL' | 'INFO' | 'WARNING' | 'CRITICAL'>('ALL');
  const [expandedId, setExpandedId] = useState<string | null>(logs[0]?.id || null);

  const activeLogs = paused && frozenLogs ? frozenLogs : logs;
  const bufferedCount = paused && frozenLogs ? Math.max(0, logs.length - frozenLogs.length) : 0;

  const handleTogglePause = () => {
    if (!paused) {
      setFrozenLogs([...logs]);
      setPaused(true);
      toast.info('Live Tail Paused', { description: 'Incoming frames will queue in background without shifting view.' });
    } else {
      setFrozenLogs(null);
      setPaused(false);
      toast.success('Live Tail Resumed', { description: 'Display synchronized with live EventBridge buffer.' });
    }
  };

  const handleClear = () => {
    clearLogs();
    setFrozenLogs([]);
    toast.info('Buffer Cleared', { description: 'Emptied all telemetry frames in local ring buffer.' });
  };

  const filtered = activeLogs.filter((l) => {
    const matchesSev = severityFilter === 'ALL' || l.severity === severityFilter;
    const matchesSearch =
      l.service.toLowerCase().includes(search.toLowerCase()) ||
      l.message.toLowerCase().includes(search.toLowerCase());
    return matchesSev && matchesSearch;
  });

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-2xl font-bold text-white tracking-tight">Live Alerts Stream</h1>
            <InfoTooltip content="Real-time EventBridge feed. Clicking Pause freezes the visible list while incoming frames are held in a holding queue." />
          </div>
          <p className="text-xs text-slate-300 mt-1">
            Real-time EventBridge feed • Horizon:{' '}
            <span className="text-emerald-400 font-mono font-bold">
              {globalRange === 'custom' ? `${customMinutes}m` : globalRange}
            </span>{' '}
            • Buffer: {logs.length}/200 max
          </p>
        </div>

        <div className="flex items-center space-x-2.5">
          <button
            onClick={handleTogglePause}
            className={`px-3.5 py-2 rounded-xl text-xs font-mono font-bold border flex items-center space-x-1.5 transition ${
              paused
                ? 'bg-amber-500/20 border-amber-400 text-amber-300 shadow-lg shadow-amber-500/10'
                : 'bg-[#121622] border-white/10 text-slate-200 hover:text-white'
            }`}
          >
            {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            <span>{paused ? 'Resume Live Tail' : 'Pause Live Tail'}</span>
          </button>
          <button
            onClick={handleClear}
            className="px-3.5 py-2 rounded-xl bg-[#121622] hover:bg-rose-500/20 border border-white/10 hover:border-rose-500/40 text-xs font-mono text-slate-300 hover:text-rose-200 flex items-center space-x-1.5 transition"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear Buffer</span>
          </button>
        </div>
      </div>

      {/* Paused Live Tail Banner */}
      {paused && (
        <div className="p-3.5 rounded-2xl bg-amber-500/15 border border-amber-400/50 flex items-center justify-between text-xs font-mono text-amber-300 animate-in fade-in duration-150">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
            <span>STREAM PAUSED — {bufferedCount} new telemetry frames buffered in background.</span>
          </div>
          <button
            onClick={handleTogglePause}
            className="px-3 py-1 rounded-lg bg-amber-400 text-slate-950 font-bold hover:bg-amber-300"
          >
            Catch Up & Resume
          </button>
        </div>
      )}

      {/* Filter Bar */}
      <div className="p-3.5 rounded-2xl nf-card flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center space-x-2 font-mono text-xs">
          {(['ALL', 'INFO', 'WARNING', 'CRITICAL'] as const).map((sev) => (
            <button
              key={sev}
              onClick={() => setSeverityFilter(sev)}
              className={`px-3 py-1.5 rounded-xl font-bold transition ${
                severityFilter === sev
                  ? sev === 'CRITICAL'
                    ? 'bg-rose-500/25 text-rose-300 border border-rose-500/50'
                    : sev === 'WARNING'
                    ? 'bg-amber-500/25 text-amber-300 border border-amber-500/50'
                    : 'bg-emerald-500/25 text-emerald-300 border border-emerald-500/50'
                  : 'bg-[#090C14] text-slate-400 hover:text-white border border-white/5'
              }`}
            >
              {sev}
            </button>
          ))}
        </div>

        <div className="flex-1 max-w-md relative">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search service names, messages, or DLP tags..."
            className="w-full bg-[#05070B] border border-white/10 rounded-xl pl-9 pr-4 py-2 text-xs text-white placeholder-slate-500 font-mono focus:outline-none focus:border-emerald-400"
          />
        </div>
      </div>

      {/* Expandable Alert Rows */}
      <div className="space-y-2.5 font-mono text-xs">
        {filtered.slice(0, 40).map((log) => {
          const isExpanded = expandedId === log.id;
          return (
            <div key={log.id} className="rounded-2xl nf-card overflow-hidden transition">
              <div
                onClick={() => setExpandedId(isExpanded ? null : log.id)}
                className="p-4 flex items-center justify-between gap-4 cursor-pointer hover:bg-white/[0.03]"
              >
                <div className="flex items-center space-x-3 truncate">
                  <span className="text-[11px] text-slate-500 shrink-0">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold shrink-0 ${
                      log.severity === 'CRITICAL'
                        ? 'bg-rose-950 text-rose-300 border border-rose-800'
                        : log.severity === 'WARNING'
                        ? 'bg-amber-950 text-amber-300 border border-amber-800'
                        : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                    }`}
                  >
                    {log.severity}
                  </span>
                  <span className="text-white font-bold shrink-0">{log.service}:</span>
                  <span className="text-slate-300 truncate">{log.message}</span>
                </div>

                <div className="flex items-center space-x-2.5 shrink-0">
                  {log.dlpScrubbed && (
                    <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                      DLP SCRUBBED
                    </span>
                  )}
                  {log.suppressedCount && log.suppressedCount > 1 && (
                    <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/40">
                      {log.suppressedCount}x DEDUPED
                    </span>
                  )}
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-slate-500" />
                  )}
                </div>
              </div>

              {isExpanded && (
                <div className="p-4 bg-[#05070B] border-t border-white/10 grid md:grid-cols-3 gap-4">
                  <div className="md:col-span-2 space-y-1.5">
                    <div className="text-[10px] text-emerald-400 font-bold uppercase">
                      In-Flight EventBridge Envelope (SQLite WAL Record)
                    </div>
                    <pre className="p-3 rounded-xl bg-[#090C14] border border-white/10 text-[11px] text-slate-300 overflow-x-auto">
                      {log.rawEnvelope ||
                        JSON.stringify(
                          {
                            id: log.id,
                            timestamp: log.timestamp,
                            service: log.service,
                            severity: log.severity,
                            message: log.message,
                            dlpScrubbed: Boolean(log.dlpScrubbed),
                          },
                          null,
                          2
                        )}
                    </pre>
                  </div>

                  <div className="flex flex-col justify-between p-3.5 rounded-xl bg-[#090C14] border border-white/10 space-y-3">
                    <div className="space-y-1">
                      <div className="text-[10px] text-purple-300 font-bold uppercase flex items-center space-x-1">
                        <ShieldAlert className="w-3.5 h-3.5" />
                        <span>Autonomous Remediation</span>
                      </div>
                      <p className="text-[11px] text-slate-400 font-sans leading-relaxed">
                        Escalate this telemetry frame to the Autonomous Embassy to synthesize a verified GitOps patch.
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        synthesizeProposal(log.service, `Synthesized from alert ${log.id}: ${log.message}`);
                        navigate('/embassy');
                      }}
                      className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center space-x-1.5 transition"
                    >
                      <Wrench className="w-3.5 h-3.5" />
                      <span>Synthesize HITL Patch</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

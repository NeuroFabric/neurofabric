import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTelemetry } from '../context/TelemetryContext';
import { Search, Download, Filter, Wrench } from 'lucide-react';
import { InfoTooltip } from '../components/common/Tooltip';
import { toast } from 'sonner';

export function TelemetryExplorerPage() {
  const navigate = useNavigate();
  const { logs, synthesizeProposal } = useTelemetry();
  const [search, setSearch] = useState('');
  const [selectedService, setSelectedService] = useState('ALL');

  const services = [
    'ALL',
    'ingress-gateway',
    'auth-gateway',
    'order-service',
    'billing-core',
    'flapping-payment-worker',
    'egress-payments-api',
  ];

  const filtered = logs.filter((log) => {
    const matchesSvc = selectedService === 'ALL' || log.service === selectedService;
    const matchesSearch =
      log.service.toLowerCase().includes(search.toLowerCase()) ||
      log.message.toLowerCase().includes(search.toLowerCase());
    return matchesSvc && matchesSearch;
  });

  const exportCSV = () => {
    const headers = 'ID,Timestamp,Severity,Service,Message,DLPRedacted\n';
    const rows = filtered
      .map(
        (l) =>
          `"${l.id}","${l.timestamp}","${l.severity}","${l.service}","${l.message.replace(/"/g, '""')}","${Boolean(
            l.dlpScrubbed
          )}"`
      )
      .join('\n');
    const blob = new Blob([headers + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `neurofabric-telemetry-${Date.now()}.csv`;
    a.click();
    toast.success('CSV Report Exported', { description: `Exported ${filtered.length} telemetry records.` });
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-2xl font-bold text-white tracking-tight">Telemetry Explorer & Bottlenecks</h1>
            <InfoTooltip content="Searchable raw event logs captured in WAL storage across all 6 microservices with RFC-4180 CSV report generation." />
          </div>
          <p className="text-xs text-slate-300 mt-1">
            Query deep telemetry indices, verify in-flight DLP redaction, escalate to HITL, and download CSV audit reports.
          </p>
        </div>

        <button
          onClick={exportCSV}
          className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl text-xs font-mono transition flex items-center space-x-2 shadow-lg shadow-emerald-500/20"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export Bottleneck CSV</span>
        </button>
      </div>

      {/* Complete 6-Service Filter Bar */}
      <div className="p-3.5 rounded-2xl nf-card flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Filter className="w-4 h-4 text-slate-400 mr-1" />
          {services.map((svc) => (
            <button
              key={svc}
              onClick={() => setSelectedService(svc)}
              className={`px-3 py-1.5 rounded-xl text-xs font-mono font-medium transition ${
                selectedService === svc
                  ? 'bg-emerald-500 text-slate-950 font-bold shadow'
                  : 'bg-[#090C14] text-slate-400 hover:text-white border border-white/10'
              }`}
            >
              {svc}
            </button>
          ))}
        </div>

        <div className="flex-1 min-w-[240px] max-w-sm relative">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search records by keyword, hash, or route..."
            className="w-full bg-[#05070B] border border-white/10 rounded-xl pl-9 pr-4 py-2 text-xs text-white placeholder-slate-500 font-mono focus:outline-none focus:border-emerald-400"
          />
        </div>
      </div>

      {/* Telemetry Data Table */}
      <div className="rounded-2xl nf-card overflow-hidden divide-y divide-white/10 font-mono text-xs">
        <div className="p-3.5 bg-[#090C14] grid grid-cols-12 text-[10px] text-slate-400 uppercase tracking-wider font-bold">
          <div className="col-span-2">Timestamp</div>
          <div className="col-span-1">Severity</div>
          <div className="col-span-2">Service</div>
          <div className="col-span-5">Message Payload</div>
          <div className="col-span-1 text-center">DLP</div>
          <div className="col-span-1 text-right">Action</div>
        </div>

        {filtered.map((log) => (
          <div key={log.id} className="p-3.5 grid grid-cols-12 items-center hover:bg-white/[0.03] transition gap-2">
            <div className="col-span-2 text-slate-400 text-[11px] truncate">
              {new Date(log.timestamp).toLocaleTimeString()}
            </div>
            <div className="col-span-1">
              <span
                className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                  log.severity === 'CRITICAL'
                    ? 'bg-rose-950 text-rose-400 border border-rose-800'
                    : log.severity === 'WARNING'
                    ? 'bg-amber-950 text-amber-300 border border-amber-800'
                    : 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                }`}
              >
                {log.severity}
              </span>
            </div>
            <div className="col-span-2 text-white font-bold truncate">{log.service}</div>
            <div className="col-span-5 text-slate-300 truncate">{log.message}</div>
            <div className="col-span-1 text-center">
              {log.dlpScrubbed ? (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-800">
                  REDACTED
                </span>
              ) : (
                <span className="text-[9px] text-slate-500">CLEAN</span>
              )}
            </div>
            <div className="col-span-1 text-right">
              <button
                onClick={() => {
                  synthesizeProposal(log.service, `Escalated from Telemetry Explorer: ${log.message}`);
                  navigate('/embassy');
                }}
                className="px-2 py-1 rounded bg-white/5 hover:bg-emerald-500/20 border border-white/10 text-[10px] text-emerald-300 inline-flex items-center space-x-1"
                title="Synthesize HITL Patch"
              >
                <Wrench className="w-3 h-3" />
                <span>Fix</span>
              </button>
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="p-12 text-center text-slate-500">
            No telemetry records match the search filter.
          </div>
        )}
      </div>
    </div>
  );
}

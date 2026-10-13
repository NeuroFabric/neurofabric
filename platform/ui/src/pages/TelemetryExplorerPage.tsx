import { useState } from 'react';
import { useTelemetry } from '../context/TelemetryContext';
import { Search, Download, Filter } from 'lucide-react';
import { InfoTooltip } from '../components/common/Tooltip';
import { toast } from 'sonner';

export function TelemetryExplorerPage() {
  const { logs } = useTelemetry();
  const [search, setSearch] = useState('');
  const [selectedService, setSelectedService] = useState('ALL');

  const services = ['ALL', 'ingress-gateway', 'auth-gateway', 'flapping-payment-worker', 'egress-payments-api'];

  const filtered = logs.filter((log) => {
    const matchesSvc = selectedService === 'ALL' || log.service === selectedService;
    const matchesSearch = log.service.toLowerCase().includes(search.toLowerCase()) || log.message.toLowerCase().includes(search.toLowerCase());
    return matchesSvc && matchesSearch;
  });

  const exportCSV = () => {
    const headers = 'ID,Timestamp,Severity,Service,Message,DLPRedacted\n';
    const rows = filtered
      .map((l) => `"${l.id}","${l.timestamp}","${l.severity}","${l.service}","${l.message.replace(/"/g, '""')}","${Boolean(l.dlpScrubbed)}"`)
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
            <InfoTooltip content="Searchable raw event logs captured in WAL storage with RFC-4180 CSV report generation." />
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Query deep telemetry indices, verify in-flight DLP redaction, and download CSV audit reports.
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

      {/* Filters Toolbar */}
      <div className="p-3.5 rounded-2xl bg-[#111319] border border-slate-800 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center space-x-2">
          <Filter className="w-4 h-4 text-slate-500 mr-1" />
          {services.map((svc) => (
            <button
              key={svc}
              onClick={() => setSelectedService(svc)}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition ${
                selectedService === svc
                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-800 font-bold'
                  : 'bg-[#171A23] text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              {svc}
            </button>
          ))}
        </div>

        <div className="flex-1 max-w-sm relative">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search records by keyword, hash, or route..."
            className="w-full bg-[#0A0C10] border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs text-white placeholder-slate-500 font-mono focus:outline-none focus:border-emerald-500"
          />
        </div>
      </div>

      {/* Telemetry Data Table */}
      <div className="rounded-2xl bg-[#111319] border border-slate-800 overflow-hidden divide-y divide-slate-800/80 font-mono text-xs">
        <div className="p-3 bg-[#171A23] grid grid-cols-12 text-[10px] text-slate-400 uppercase tracking-wider font-bold">
          <div className="col-span-2">Timestamp</div>
          <div className="col-span-1">Severity</div>
          <div className="col-span-3">Service</div>
          <div className="col-span-5">Message Payload</div>
          <div className="col-span-1 text-right">DLP Scrub</div>
        </div>

        {filtered.map((log) => (
          <div key={log.id} className="p-3.5 grid grid-cols-12 items-center hover:bg-slate-900/40 transition">
            <div className="col-span-2 text-slate-500 text-[11px] truncate">
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
            <div className="col-span-3 text-slate-200 font-bold truncate">{log.service}</div>
            <div className="col-span-5 text-slate-400 truncate">{log.message}</div>
            <div className="col-span-1 text-right">
              {log.dlpScrubbed ? (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-800">
                  REDACTED
                </span>
              ) : (
                <span className="text-[9px] text-slate-600 font-mono">CLEAN</span>
              )}
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

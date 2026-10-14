import { useState, useMemo } from 'react';
import { Activity, Clock, Calendar, Check, BarChart3 } from 'lucide-react';
import { useTelemetry, type TimeRange, type TimeSeriesPoint } from '../../context/TelemetryContext';
import { InfoTooltip } from '../common/Tooltip';

export function LiveThroughputChart() {
  const { series, globalRange, setGlobalRange, customMinutes, setCustomMinutes } = useTelemetry();
  const [metricTab, setMetricTab] = useState<'throughput' | 'latency' | 'errors'>('throughput');
  const [isCustomOpen, setIsCustomOpen] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const { pathD, areaD, p50PathD, minVal, maxVal, currentVal } = useMemo(() => {
    if (series.length === 0) return { pathD: '', areaD: '', p50PathD: '', minVal: 0, maxVal: 1, currentVal: 0 };

    const getVal = (p: TimeSeriesPoint) =>
      metricTab === 'throughput' ? p.throughput : metricTab === 'latency' ? p.latencyP99 : p.errorRate;

    const vals = series.map(getVal);
    const min = Math.floor(Math.min(...vals) * 0.85);
    const max = Math.ceil(Math.max(...vals) * 1.15) || 1;

    const width = 800;
    const height = 150;
    const step = width / (series.length - 1);

    const coords = series.map((p, idx) => {
      const v = getVal(p);
      const x = idx * step;
      const y = height - ((v - min) / (max - min || 1)) * (height - 24) - 12;
      return { x, y };
    });

    let d = `M ${coords[0].x} ${coords[0].y}`;
    for (let i = 1; i < coords.length; i++) {
      const prev = coords[i - 1];
      const curr = coords[i];
      const midX = (prev.x + curr.x) / 2;
      d += ` C ${midX} ${prev.y}, ${midX} ${curr.y}, ${curr.x} ${curr.y}`;
    }

    // Secondary P50 comparison line for latency tab
    let p50D = '';
    if (metricTab === 'latency') {
      const p50Coords = series.map((p, idx) => {
        const x = idx * step;
        const y = height - ((p.latencyP50 - min) / (max - min || 1)) * (height - 24) - 12;
        return { x, y };
      });
      p50D = `M ${p50Coords[0].x} ${p50Coords[0].y}`;
      for (let i = 1; i < p50Coords.length; i++) {
        const prev = p50Coords[i - 1];
        const curr = p50Coords[i];
        const midX = (prev.x + curr.x) / 2;
        p50D += ` C ${midX} ${prev.y}, ${midX} ${curr.y}, ${curr.x} ${curr.y}`;
      }
    }

    const area = `${d} L ${width} ${height} L 0 ${height} Z`;

    return {
      pathD: d,
      areaD: area,
      p50PathD: p50D,
      minVal: min,
      maxVal: max,
      currentVal: vals[vals.length - 1],
    };
  }, [series, metricTab]);

  const ranges: TimeRange[] = ['5m', '15m', '30m', '1h', '2h', '5h'];
  const hoveredPoint = hoveredIdx !== null && series[hoveredIdx] ? series[hoveredIdx] : null;
  const strokeColor = metricTab === 'throughput' ? '#10B981' : metricTab === 'latency' ? '#38BDF8' : '#F43F5E';

  // Pick 6 evenly spaced X-axis labels
  const xLabels = useMemo(() => {
    if (series.length < 6) return [];
    const step = Math.floor((series.length - 1) / 5);
    return [0, step, step * 2, step * 3, step * 4, series.length - 1].map((idx) => series[idx]?.timestamp || '');
  }, [series]);

  return (
    <div className="grid lg:grid-cols-3 gap-4">
      {/* Main Waveform Panel (2 Cols) */}
      <div className="lg:col-span-2 p-6 rounded-2xl bg-[#111319] border border-slate-800/90 space-y-4 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-xl bg-emerald-950/60 border border-emerald-800 text-emerald-400">
              <Activity className="w-4 h-4 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center space-x-1.5">
                <h3 className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                  Real-Time Ingestion Waveform
                </h3>
                <InfoTooltip content="Synchronized with the Global Time Range. Displays live EventBridge throughput, P99/P50 latency, and error rates." />
              </div>
              <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                Active Window: <span className="text-emerald-400 font-bold">{globalRange === 'custom' ? `${customMinutes}m` : globalRange}</span> • Current:{' '}
                <span className="text-white font-bold">{currentVal}</span>{' '}
                {metricTab === 'throughput' ? 'evt/s' : metricTab === 'latency' ? 'ms (P99)' : '% err'}
              </div>
            </div>
          </div>

          {/* Metric Switcher */}
          <div className="flex items-center bg-[#171A23] p-1 rounded-xl border border-slate-800 text-[11px] font-mono">
            <button
              onClick={() => setMetricTab('throughput')}
              className={`px-2.5 py-1 rounded-lg transition ${
                metricTab === 'throughput' ? 'bg-slate-800 text-emerald-400 font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              Throughput
            </button>
            <button
              onClick={() => setMetricTab('latency')}
              className={`px-2.5 py-1 rounded-lg transition ${
                metricTab === 'latency' ? 'bg-slate-800 text-sky-400 font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              P99 Latency
            </button>
            <button
              onClick={() => setMetricTab('errors')}
              className={`px-2.5 py-1 rounded-lg transition ${
                metricTab === 'errors' ? 'bg-slate-800 text-rose-400 font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              Errors
            </button>
          </div>

          {/* Time Range Buttons */}
          <div className="flex items-center space-x-1 bg-[#171A23] p-1 rounded-xl border border-slate-800 text-[11px] font-mono">
            <Clock className="w-3 h-3 text-slate-500 ml-1.5 mr-1" />
            {ranges.map((r) => (
              <button
                key={r}
                onClick={() => {
                  setGlobalRange(r);
                  setIsCustomOpen(false);
                }}
                className={`px-2 py-1 rounded-lg transition ${
                  globalRange === r ? 'bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/40' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {r}
              </button>
            ))}
            <button
              onClick={() => setIsCustomOpen(!isCustomOpen)}
              className={`px-2 py-1 rounded-lg transition flex items-center space-x-1 ${
                globalRange === 'custom' ? 'bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/40' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Calendar className="w-3 h-3" />
              <span>Custom</span>
            </button>
          </div>
        </div>

        {isCustomOpen && (
          <div className="p-3 rounded-xl bg-[#171A23] border border-slate-700 flex items-center justify-between text-xs font-mono">
            <div className="flex items-center space-x-2">
              <span className="text-slate-300">Custom Time Range (Minutes):</span>
              <input
                type="number"
                min={5}
                max={1440}
                value={customMinutes}
                onChange={(e) => setCustomMinutes(Number(e.target.value))}
                className="w-20 bg-[#0A0C10] border border-slate-700 rounded-lg px-2 py-1 text-white text-center"
              />
            </div>
            <button
              onClick={() => {
                setGlobalRange('custom');
                setIsCustomOpen(false);
              }}
              className="px-3 py-1 bg-emerald-500 text-slate-950 font-bold rounded-lg flex items-center space-x-1"
            >
              <Check className="w-3 h-3" />
              <span>Apply</span>
            </button>
          </div>
        )}

        {/* Interactive Graph Canvas */}
        <div className="relative h-44 w-full bg-[#090B10] rounded-xl border border-slate-800/80 p-3 overflow-hidden select-none">
          <div className="absolute left-3 top-2 bottom-6 flex flex-col justify-between text-[10px] font-mono text-slate-500 pointer-events-none z-10">
            <span>{maxVal}</span>
            <span>{Math.round((maxVal + minVal) / 2)}</span>
            <span>{minVal}</span>
          </div>

          {hoveredPoint && (
            <div className="absolute right-3 top-2 px-3 py-1.5 rounded-lg bg-[#171A23]/95 border border-slate-700 text-[11px] font-mono text-slate-200 z-20 pointer-events-none shadow-lg">
              <span className="text-slate-400">{hoveredPoint.timestamp}</span> •{' '}
              <span className="text-emerald-400 font-bold">{hoveredPoint.throughput} evt/s</span> •{' '}
              <span className="text-sky-400">P99: {hoveredPoint.latencyP99}ms</span> •{' '}
              <span className="text-rose-400">Err: {hoveredPoint.errorRate}%</span>
            </div>
          )}

          <svg
            viewBox="0 0 800 150"
            preserveAspectRatio="none"
            className="w-full h-[130px] overflow-visible"
            onMouseLeave={() => setHoveredIdx(null)}
          >
            <defs>
              <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={strokeColor} stopOpacity="0.32" />
                <stop offset="100%" stopColor={strokeColor} stopOpacity="0.0" />
              </linearGradient>
            </defs>

            <line x1="0" y1="35" x2="800" y2="35" stroke="#181C26" strokeWidth="1" strokeDasharray="3 3" />
            <line x1="0" y1="75" x2="800" y2="75" stroke="#181C26" strokeWidth="1" strokeDasharray="3 3" />
            <line x1="0" y1="115" x2="800" y2="115" stroke="#181C26" strokeWidth="1" strokeDasharray="3 3" />

            <path d={areaD} fill="url(#areaGrad)" />
            <path d={pathD} fill="none" stroke={strokeColor} strokeWidth="2.2" strokeLinecap="round" />
            {metricTab === 'latency' && p50PathD && (
              <path d={p50PathD} fill="none" stroke="#10B981" strokeWidth="1.5" strokeDasharray="4 4" />
            )}

            {hoveredIdx !== null && (
              <line
                x1={(hoveredIdx * 800) / (series.length - 1)}
                y1={0}
                x2={(hoveredIdx * 800) / (series.length - 1)}
                y2={150}
                stroke="#94A3B8"
                strokeWidth="1"
                strokeDasharray="2 2"
              />
            )}

            {series.map((_, idx) => {
              const step = 800 / (series.length - 1);
              return (
                <rect
                  key={idx}
                  x={idx * step - step / 2}
                  y={0}
                  width={step}
                  height={150}
                  fill="transparent"
                  className="cursor-crosshair"
                  onMouseEnter={() => setHoveredIdx(idx)}
                />
              );
            })}
          </svg>

          {/* X-Axis Timestamps */}
          <div className="flex items-center justify-between px-6 pt-1 text-[10px] font-mono text-slate-500">
            {xLabels.map((lbl, i) => (
              <span key={i}>{lbl}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Second Synchronized Graph: Dedup & DLP Burst Suppression Histogram (1 Col) */}
      <div className="p-6 rounded-2xl bg-[#111319] border border-slate-800/90 flex flex-col justify-between space-y-4 shadow-xl">
        <div>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <BarChart3 className="w-4 h-4 text-amber-400" />
              <h3 className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                Dedup & DLP Burst Histogram
              </h3>
            </div>
            <InfoTooltip content="Shows duplicate alert storms collapsed in the sliding window for the active time range." />
          </div>
          <p className="text-[11px] text-slate-400 font-mono mt-1">
            Window: <span className="text-amber-400 font-bold">{globalRange === 'custom' ? `${customMinutes}m` : globalRange}</span> • Anti-Alert-Fatigue Engine
          </p>
        </div>

        <div className="h-44 bg-[#090B10] rounded-xl border border-slate-800/80 p-3 flex flex-col justify-end">
          <div className="flex items-end justify-between h-32 space-x-1">
            {series.slice(-18).map((pt, i) => {
              const heightPct = Math.min(100, Math.max(12, Math.round((pt.suppressed / 35) * 100)));
              return (
                <div key={i} className="flex-1 flex flex-col items-center group relative h-full justify-end">
                  <div
                    style={{ height: `${heightPct}%` }}
                    className={`w-full rounded-t transition-all duration-300 ${
                      pt.suppressed > 20 ? 'bg-amber-400' : 'bg-emerald-500/70 group-hover:bg-emerald-400'
                    }`}
                  />
                  <div className="opacity-0 group-hover:opacity-100 absolute -top-7 bg-[#171A23] border border-slate-700 text-[9px] font-mono text-white px-1.5 py-0.5 rounded pointer-events-none whitespace-nowrap z-20">
                    {pt.timestamp}: {pt.suppressed}x
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[10px] font-mono text-slate-500 pt-2 border-t border-slate-800/80 mt-2">
            <span>{series[Math.max(0, series.length - 18)]?.timestamp}</span>
            <span>Now ({series[series.length - 1]?.suppressed}x collapsed)</span>
          </div>
        </div>
      </div>
    </div>
  );
}

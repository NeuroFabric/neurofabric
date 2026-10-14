import { useState, useMemo } from 'react';
import { Activity, Clock, Calendar, Check, BarChart3, Pause, Play } from 'lucide-react';
import { useTelemetry, type TimeRange, type TimeSeriesPoint } from '../../context/TelemetryContext';
import { InfoTooltip } from '../common/Tooltip';

export function LiveThroughputChart() {
  const { series, globalRange, setGlobalRange, customMinutes, setCustomMinutes } = useTelemetry();
  const [metricTab, setMetricTab] = useState<'throughput' | 'latency' | 'errors'>('throughput');
  const [isCustomOpen, setIsCustomOpen] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [frozenSeries, setFrozenSeries] = useState<TimeSeriesPoint[] | null>(null);

  const activeSeries = paused && frozenSeries ? frozenSeries : series;

  const togglePause = () => {
    if (!paused) {
      setFrozenSeries(series);
      setPaused(true);
    } else {
      setFrozenSeries(null);
      setPaused(false);
    }
  };

  const { pathD, areaD, coords, minVal, maxVal, currentVal, avgVal } = useMemo(() => {
    if (activeSeries.length === 0)
      return { pathD: '', areaD: '', coords: [], minVal: 0, maxVal: 1, currentVal: 0, avgVal: 0 };

    const getVal = (p: TimeSeriesPoint) =>
      metricTab === 'throughput' ? p.throughput : metricTab === 'latency' ? p.latencyP99 : p.errorRate;

    const vals = activeSeries.map(getVal);
    const min = Math.floor(Math.min(...vals) * 0.85);
    const max = Math.ceil(Math.max(...vals) * 1.15) || 1;
    const sum = vals.reduce((a, b) => a + b, 0);
    const avg = Number((sum / vals.length).toFixed(2));

    const width = 800;
    const height = 160;
    const step = width / (activeSeries.length - 1);

    const pts = activeSeries.map((p, idx) => {
      const v = getVal(p);
      const x = idx * step;
      const y = height - ((v - min) / (max - min || 1)) * (height - 28) - 14;
      return { x, y, val: v, raw: p };
    });

    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const midX = (prev.x + curr.x) / 2;
      d += ` C ${midX} ${prev.y}, ${midX} ${curr.y}, ${curr.x} ${curr.y}`;
    }

    const area = `${d} L ${width} ${height} L 0 ${height} Z`;

    return {
      pathD: d,
      areaD: area,
      coords: pts,
      minVal: min,
      maxVal: max,
      currentVal: vals[vals.length - 1],
      avgVal: avg,
    };
  }, [activeSeries, metricTab]);

  const ranges: TimeRange[] = ['5m', '15m', '30m', '1h', '2h', '5h'];
  const hoveredCoord = hoveredIdx !== null && coords[hoveredIdx] ? coords[hoveredIdx] : null;
  const strokeColor = metricTab === 'throughput' ? '#22D3EE' : metricTab === 'latency' ? '#818CF8' : '#F43F5E';

  const xLabels = useMemo(() => {
    if (activeSeries.length < 6) return [];
    const step = Math.floor((activeSeries.length - 1) / 5);
    return [0, step, step * 2, step * 3, step * 4, activeSeries.length - 1].map(
      (idx) => activeSeries[idx]?.timestamp || ''
    );
  }, [activeSeries]);

  return (
    <div className="grid lg:grid-cols-3 gap-5">
      {/* Primary Interactive Waveform Card */}
      <div className="lg:col-span-2 p-6 rounded-2xl bg-[#0D111C] border border-white/10 space-y-4 shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-cyan-500/15 border border-cyan-400/30 text-cyan-400">
              <Activity className="w-4 h-4 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center space-x-1.5">
                <h3 className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                  Real-Time Ingestion Waveform
                </h3>
                <InfoTooltip content="Hover anywhere on the graph to inspect exact timestamp, event rate, P99/P50 latency, and duplicate suppression." />
              </div>
              <div className="text-[11px] text-slate-300 font-mono mt-0.5 flex items-center space-x-3">
                <span>
                  Window: <strong className="text-cyan-400">{globalRange === 'custom' ? `${customMinutes}m` : globalRange}</strong>
                </span>
                <span>•</span>
                <span>
                  Live: <strong className="text-emerald-400">{currentVal}</strong>{' '}
                  {metricTab === 'throughput' ? 'evt/s' : metricTab === 'latency' ? 'ms' : '%'}
                </span>
                <span>•</span>
                <span>
                  Rolling Avg: <strong className="text-white">{avgVal}</strong>
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {/* Pause / Resume Live Graph */}
            <button
              onClick={togglePause}
              className={`px-2.5 py-1.5 rounded-xl text-[11px] font-mono font-bold border flex items-center space-x-1 transition ${
                paused
                  ? 'bg-amber-500/20 border-amber-400/50 text-amber-300'
                  : 'bg-[#141A29] border-white/10 text-slate-300 hover:text-white'
              }`}
            >
              {paused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
              <span>{paused ? 'Resume' : 'Freeze'}</span>
            </button>

            {/* Metric Tabs */}
            <div className="flex items-center bg-[#141A29] p-1 rounded-xl border border-white/10 text-[11px] font-mono">
              <button
                onClick={() => setMetricTab('throughput')}
                className={`px-2.5 py-1 rounded-lg transition ${
                  metricTab === 'throughput' ? 'bg-cyan-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'
                }`}
              >
                Throughput
              </button>
              <button
                onClick={() => setMetricTab('latency')}
                className={`px-2.5 py-1 rounded-lg transition ${
                  metricTab === 'latency' ? 'bg-indigo-500 text-white font-bold' : 'text-slate-400 hover:text-white'
                }`}
              >
                P99 Latency
              </button>
              <button
                onClick={() => setMetricTab('errors')}
                className={`px-2.5 py-1 rounded-lg transition ${
                  metricTab === 'errors' ? 'bg-rose-500 text-white font-bold' : 'text-slate-400 hover:text-white'
                }`}
              >
                Error %
              </button>
            </div>
          </div>
        </div>

        {/* Time Range Bar inside Chart */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-white/5">
          <div className="text-[11px] font-mono text-slate-400">
            Select Time Horizon (synchronizes all console charts):
          </div>
          <div className="flex items-center space-x-1 bg-[#141A29] p-1 rounded-xl border border-white/10 text-[11px] font-mono">
            <Clock className="w-3 h-3 text-cyan-400 ml-1.5 mr-1" />
            {ranges.map((r) => (
              <button
                key={r}
                onClick={() => {
                  setGlobalRange(r);
                  setIsCustomOpen(false);
                }}
                className={`px-2 py-0.5 rounded-lg transition ${
                  globalRange === r ? 'bg-cyan-500/25 text-cyan-300 font-bold border border-cyan-400/40' : 'text-slate-400 hover:text-white'
                }`}
              >
                {r}
              </button>
            ))}
            <button
              onClick={() => setIsCustomOpen(!isCustomOpen)}
              className={`px-2 py-0.5 rounded-lg transition flex items-center space-x-1 ${
                globalRange === 'custom' ? 'bg-cyan-500/25 text-cyan-300 font-bold border border-cyan-400/40' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Calendar className="w-3 h-3" />
              <span>Custom</span>
            </button>
          </div>
        </div>

        {isCustomOpen && (
          <div className="p-3 rounded-xl bg-[#141A29] border border-cyan-500/40 flex items-center justify-between text-xs font-mono">
            <div className="flex items-center space-x-2">
              <span className="text-slate-200">Custom Window (Minutes):</span>
              <input
                type="number"
                min={5}
                max={1440}
                value={customMinutes}
                onChange={(e) => setCustomMinutes(Number(e.target.value))}
                className="w-20 bg-[#080A10] border border-slate-700 rounded-lg px-2 py-1 text-white text-center"
              />
            </div>
            <button
              onClick={() => {
                setGlobalRange('custom');
                setIsCustomOpen(false);
              }}
              className="px-3 py-1 bg-cyan-400 text-slate-950 font-bold rounded-lg flex items-center space-x-1"
            >
              <Check className="w-3 h-3" />
              <span>Apply Range</span>
            </button>
          </div>
        )}

        {/* Interactive SVG Canvas with Crosshair & Floating HUD */}
        <div className="relative h-52 w-full bg-[#07090F] rounded-xl border border-white/10 p-3 overflow-hidden select-none">
          {/* Y-Axis Labels */}
          <div className="absolute left-3 top-3 bottom-8 flex flex-col justify-between text-[10px] font-mono text-slate-400 pointer-events-none z-10">
            <span>{maxVal}</span>
            <span>{Math.round((maxVal + minVal) / 2)}</span>
            <span>{minVal}</span>
          </div>

          {/* Floating Hover Inspection Card */}
          {hoveredCoord ? (
            <div className="absolute left-14 top-2.5 px-3.5 py-2 rounded-xl bg-[#141928]/95 border border-cyan-400/50 text-[11px] font-mono text-white z-20 pointer-events-none shadow-2xl flex items-center space-x-4">
              <div>
                <span className="text-slate-400 text-[10px] block">TIMESTAMP</span>
                <span className="text-cyan-300 font-bold">{hoveredCoord.raw.timestamp}</span>
              </div>
              <div className="border-l border-white/10 pl-3">
                <span className="text-slate-400 text-[10px] block">THROUGHPUT</span>
                <span className="text-emerald-400 font-bold">{hoveredCoord.raw.throughput} evt/s</span>
              </div>
              <div className="border-l border-white/10 pl-3">
                <span className="text-slate-400 text-[10px] block">P99 / P50</span>
                <span className="text-indigo-300 font-bold">
                  {hoveredCoord.raw.latencyP99}ms / {hoveredCoord.raw.latencyP50}ms
                </span>
              </div>
              <div className="border-l border-white/10 pl-3">
                <span className="text-slate-400 text-[10px] block">ERRORS</span>
                <span className="text-rose-400 font-bold">{hoveredCoord.raw.errorRate}%</span>
              </div>
              <div className="border-l border-white/10 pl-3">
                <span className="text-slate-400 text-[10px] block">DEDUPED</span>
                <span className="text-amber-300 font-bold">{hoveredCoord.raw.suppressed}x</span>
              </div>
            </div>
          ) : (
            <div className="absolute right-3 top-2.5 text-[10px] font-mono text-slate-500 pointer-events-none">
              Hover curve to inspect telemetry frame
            </div>
          )}

          <svg
            viewBox="0 0 800 160"
            preserveAspectRatio="none"
            className="w-full h-[145px] overflow-visible"
            onMouseLeave={() => setHoveredIdx(null)}
          >
            <defs>
              <linearGradient id="wfGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={strokeColor} stopOpacity="0.38" />
                <stop offset="100%" stopColor={strokeColor} stopOpacity="0.0" />
              </linearGradient>
            </defs>

            <line x1="0" y1="35" x2="800" y2="35" stroke="#192030" strokeWidth="1" strokeDasharray="3 3" />
            <line x1="0" y1="80" x2="800" y2="80" stroke="#192030" strokeWidth="1" strokeDasharray="3 3" />
            <line x1="0" y1="125" x2="800" y2="125" stroke="#192030" strokeWidth="1" strokeDasharray="3 3" />

            <path d={areaD} fill="url(#wfGrad)" />
            <path d={pathD} fill="none" stroke={strokeColor} strokeWidth="2.5" strokeLinecap="round" />

            {/* Visible Interactive Data Points */}
            {coords.map((pt, idx) => (
              <circle
                key={idx}
                cx={pt.x}
                cy={pt.y}
                r={hoveredIdx === idx ? 5.5 : 2.2}
                fill={hoveredIdx === idx ? '#FFFFFF' : strokeColor}
                stroke={hoveredIdx === idx ? strokeColor : 'none'}
                strokeWidth={2}
              />
            ))}

            {/* Crosshair Lines on Hover */}
            {hoveredCoord && (
              <>
                <line
                  x1={hoveredCoord.x}
                  y1={0}
                  x2={hoveredCoord.x}
                  y2={160}
                  stroke="#38BDF8"
                  strokeWidth="1.2"
                  strokeDasharray="3 3"
                />
                <line
                  x1={0}
                  y1={hoveredCoord.y}
                  x2={800}
                  y2={hoveredCoord.y}
                  stroke="#38BDF8"
                  strokeWidth="0.8"
                  strokeDasharray="3 3"
                  strokeOpacity="0.5"
                />
              </>
            )}

            {/* Hit Columns for Smooth Hover Detection */}
            {coords.map((_, idx) => {
              const step = 800 / (coords.length - 1 || 1);
              return (
                <rect
                  key={idx}
                  x={idx * step - step / 2}
                  y={0}
                  width={step}
                  height={160}
                  fill="transparent"
                  className="cursor-crosshair"
                  onMouseEnter={() => setHoveredIdx(idx)}
                />
              );
            })}
          </svg>

          {/* X-Axis Timestamps */}
          <div className="flex items-center justify-between px-8 pt-1 text-[10px] font-mono text-slate-400 border-t border-white/5">
            {xLabels.map((lbl, i) => (
              <span key={i}>{lbl}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Secondary Synchronized Graph: Dedup & DLP Suppression Histogram */}
      <div className="p-6 rounded-2xl bg-[#0D111C] border border-white/10 flex flex-col justify-between space-y-4 shadow-2xl">
        <div>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <BarChart3 className="w-4 h-4 text-amber-400" />
              <h3 className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                Alert Dedup & Burst Suppression
              </h3>
            </div>
            <InfoTooltip content="Hover any bar to view exact timestamp and duplicate events collapsed within the sliding window." />
          </div>
          <p className="text-[11px] text-slate-300 font-mono mt-1">
            Range: <span className="text-amber-400 font-bold">{globalRange === 'custom' ? `${customMinutes}m` : globalRange}</span> • Total Collapsed:{' '}
            <span className="text-emerald-400 font-bold">
              {activeSeries.reduce((acc, p) => acc + p.suppressed, 0)} evts
            </span>
          </p>
        </div>

        <div className="h-52 bg-[#07090F] rounded-xl border border-white/10 p-3 flex flex-col justify-end">
          <div className="flex items-end justify-between h-36 space-x-1.5 pt-6">
            {activeSeries.slice(-16).map((pt, i) => {
              const heightPct = Math.min(100, Math.max(15, Math.round((pt.suppressed / 36) * 100)));
              return (
                <div key={i} className="flex-1 flex flex-col items-center group relative h-full justify-end cursor-pointer">
                  <div
                    style={{ height: `${heightPct}%` }}
                    className={`w-full rounded-t transition-all duration-200 ${
                      pt.suppressed > 20
                        ? 'bg-gradient-to-t from-amber-600 to-amber-400 group-hover:from-amber-400 group-hover:to-yellow-300'
                        : 'bg-gradient-to-t from-indigo-600/80 to-cyan-400/80 group-hover:from-cyan-400 group-hover:to-emerald-300'
                    }`}
                  />
                  <div className="opacity-0 group-hover:opacity-100 absolute -top-8 bg-[#141928] border border-cyan-400/40 text-[10px] font-mono text-white px-2 py-1 rounded-lg pointer-events-none whitespace-nowrap z-30 shadow-xl">
                    {pt.timestamp} • <span className="text-amber-300 font-bold">{pt.suppressed}x</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[10px] font-mono text-slate-400 pt-2 border-t border-white/10 mt-2">
            <span>{activeSeries[Math.max(0, activeSeries.length - 16)]?.timestamp}</span>
            <span className="text-cyan-300 font-bold">Latest: {activeSeries[activeSeries.length - 1]?.suppressed}x</span>
          </div>
        </div>
      </div>
    </div>
  );
}

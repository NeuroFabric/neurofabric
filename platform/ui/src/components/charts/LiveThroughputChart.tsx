import { useState, useMemo } from 'react';
import { Activity, Clock, Calendar, Check, BarChart3, Pause, Play } from 'lucide-react';
import { useTelemetry, type TimeRange, type TimeSeriesPoint } from '../../context/TelemetryContext';
import { InfoTooltip } from '../common/Tooltip';

export function LiveThroughputChart() {
  const {
    series,
    globalRange,
    setGlobalRange,
    customMinutes,
    setCustomMinutes,
    isStreamPaused,
    toggleStreamPause,
  } = useTelemetry();

  const [metricTab, setMetricTab] = useState<'throughput' | 'latency' | 'errors'>('throughput');
  const [isCustomOpen, setIsCustomOpen] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const { pathD, areaD, p50PathD, coords, minVal, maxVal, currentVal, avgVal, peakVal } = useMemo(() => {
    if (series.length === 0)
      return { pathD: '', areaD: '', p50PathD: '', coords: [], minVal: 0, maxVal: 1, currentVal: 0, avgVal: 0, peakVal: 0 };

    const getVal = (p: TimeSeriesPoint) =>
      metricTab === 'throughput' ? p.throughput : metricTab === 'latency' ? p.latencyP99 : p.errorRate;

    const vals = series.map(getVal);
    const min = Math.floor(Math.min(...vals) * 0.85);
    const max = Math.ceil(Math.max(...vals) * 1.15) || 1;
    const peak = Number(Math.max(...vals).toFixed(2));
    const sum = vals.reduce((a, b) => a + b, 0);
    const avg = Number((sum / vals.length).toFixed(2));

    const width = 800;
    const height = 165;
    const step = width / (series.length - 1 || 1);

    const pts = series.map((p, idx) => {
      const v = getVal(p);
      const x = idx * step;
      const y = height - ((v - min) / (max - min || 1)) * (height - 30) - 15;
      return { x, y, val: v, raw: p };
    });

    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const midX = (prev.x + curr.x) / 2;
      d += ` C ${midX} ${prev.y}, ${midX} ${curr.y}, ${curr.x} ${curr.y}`;
    }

    let p50D = '';
    if (metricTab === 'latency') {
      const p50Pts = series.map((p, idx) => {
        const x = idx * step;
        const y = height - ((p.latencyP50 - min) / (max - min || 1)) * (height - 30) - 15;
        return { x, y };
      });
      p50D = `M ${p50Pts[0].x} ${p50Pts[0].y}`;
      for (let i = 1; i < p50Pts.length; i++) {
        const prev = p50Pts[i - 1];
        const curr = p50Pts[i];
        const midX = (prev.x + curr.x) / 2;
        p50D += ` C ${midX} ${prev.y}, ${midX} ${curr.y}, ${curr.x} ${curr.y}`;
      }
    }

    const area = `${d} L ${width} ${height} L 0 ${height} Z`;

    return {
      pathD: d,
      areaD: area,
      p50PathD: p50D,
      coords: pts,
      minVal: min,
      maxVal: max,
      currentVal: vals[vals.length - 1],
      avgVal: avg,
      peakVal: peak,
    };
  }, [series, metricTab]);

  const ranges: TimeRange[] = ['5m', '15m', '30m', '1h', '2h', '5h'];
  const hoveredCoord = hoveredIdx !== null && coords[hoveredIdx] ? coords[hoveredIdx] : null;
  const strokeColor = metricTab === 'throughput' ? '#10B981' : metricTab === 'latency' ? '#A855F7' : '#F43F5E';

  const xLabels = useMemo(() => {
    if (series.length < 6) return [];
    const lastIdx = series.length - 1;
    const indices = [
      0,
      Math.round(lastIdx * 0.2),
      Math.round(lastIdx * 0.4),
      Math.round(lastIdx * 0.6),
      Math.round(lastIdx * 0.8),
      lastIdx,
    ];
    return indices.map((idx) => series[idx]?.timestamp || '');
  }, [series]);

  const spanBanner = series[series.length - 1]?.windowSpanLabel || '';

  return (
    <div className="grid lg:grid-cols-3 gap-5 tabular-nums">
      <div className="lg:col-span-2 p-6 rounded-2xl nf-card space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-emerald-500/15 border border-emerald-400/30 text-emerald-400 shadow-inner">
              <Activity className="w-4 h-4 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center space-x-1.5">
                <h3 className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                  Real-Time Ingestion Waveform
                </h3>
                <InfoTooltip content="Measures events/sec, P99/P50 tail latency (ms), and error % across the selected time window. Hover any point to inspect exact bucket metrics." />
              </div>
              <div className="text-[11px] text-slate-300 font-mono mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  Horizon: <strong className="text-emerald-400">{globalRange === 'custom' ? `${customMinutes}m` : globalRange}</strong>
                </span>
                <span>•</span>
                <span>
                  Live: <strong className="text-white">{currentVal}</strong>{' '}
                  {metricTab === 'throughput' ? 'evt/s' : metricTab === 'latency' ? 'ms' : '%'}
                </span>
                <span>•</span>
                <span>
                  Avg: <strong className="text-slate-200">{avgVal}</strong>
                </span>
                <span>•</span>
                <span>
                  Peak: <strong className="text-amber-400">{peakVal}</strong>
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={toggleStreamPause}
              className={`px-2.5 py-1.5 rounded-xl text-[11px] font-mono font-bold border flex items-center space-x-1 transition ${
                isStreamPaused
                  ? 'bg-amber-500/20 border-amber-400/50 text-amber-300'
                  : 'bg-[#121622] border-white/10 text-slate-300 hover:text-white'
              }`}
            >
              {isStreamPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
              <span>{isStreamPaused ? 'Resume' : 'Freeze'}</span>
            </button>

            <div className="flex items-center bg-[#121622] p-1 rounded-xl border border-white/10 text-[11px] font-mono">
              <button
                onClick={() => setMetricTab('throughput')}
                className={`px-2.5 py-1 rounded-lg transition ${
                  metricTab === 'throughput' ? 'bg-emerald-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'
                }`}
              >
                Throughput
              </button>
              <button
                onClick={() => setMetricTab('latency')}
                className={`px-2.5 py-1 rounded-lg transition ${
                  metricTab === 'latency' ? 'bg-purple-500 text-white font-bold' : 'text-slate-400 hover:text-white'
                }`}
              >
                P99 / P50
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

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-white/10">
          <div className="text-[11px] font-mono text-slate-400">
            Active Span: <span className="text-emerald-300 font-bold">{spanBanner}</span>
          </div>
          <div className="flex items-center space-x-1 bg-[#121622] p-1 rounded-xl border border-white/10 text-[11px] font-mono">
            <Clock className="w-3 h-3 text-emerald-400 ml-1.5 mr-1" />
            {ranges.map((r) => (
              <button
                key={r}
                onClick={() => {
                  setGlobalRange(r);
                  setIsCustomOpen(false);
                }}
                className={`px-2 py-0.5 rounded-lg transition ${
                  globalRange === r
                    ? 'bg-emerald-500/25 text-emerald-300 font-bold border border-emerald-400/40'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {r}
              </button>
            ))}
            <button
              onClick={() => setIsCustomOpen(!isCustomOpen)}
              className={`px-2 py-0.5 rounded-lg transition flex items-center space-x-1 ${
                globalRange === 'custom'
                  ? 'bg-emerald-500/25 text-emerald-300 font-bold border border-emerald-400/40'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Calendar className="w-3 h-3" />
              <span>Custom</span>
            </button>
          </div>
        </div>

        {isCustomOpen && (
          <div className="p-3 rounded-xl bg-[#121622] border border-emerald-500/40 flex items-center justify-between text-xs font-mono">
            <div className="flex items-center space-x-2">
              <span className="text-slate-200">Custom Horizon (Minutes):</span>
              <input
                type="number"
                min={1}
                max={360}
                value={customMinutes}
                onChange={(e) => setCustomMinutes(Number(e.target.value))}
                className="w-20 bg-[#06080D] border border-slate-700 rounded-lg px-2 py-1 text-white text-center"
              />
            </div>
            <button
              onClick={() => {
                setGlobalRange('custom');
                setIsCustomOpen(false);
              }}
              className="px-3 py-1 bg-emerald-400 text-slate-950 font-bold rounded-lg flex items-center space-x-1"
            >
              <Check className="w-3 h-3" />
              <span>Apply Window</span>
            </button>
          </div>
        )}

        <div className="relative h-52 w-full bg-[#05070B] rounded-xl border border-white/10 p-3 overflow-hidden select-none">
          <div className="absolute left-3 top-3 bottom-8 flex flex-col justify-between text-[10px] font-mono text-slate-400 pointer-events-none z-10">
            <span>{maxVal}</span>
            <span>{Math.round((maxVal + minVal) / 2)}</span>
            <span>{minVal}</span>
          </div>

          {hoveredCoord ? (
            <div className="absolute left-14 top-2.5 px-3.5 py-2 rounded-xl bg-[#111520]/95 border border-emerald-400/50 text-[11px] font-mono text-white z-20 pointer-events-none shadow-2xl flex items-center space-x-4">
              <div>
                <span className="text-slate-400 text-[9px] block">BUCKET TIME</span>
                <span className="text-emerald-300 font-bold">{hoveredCoord.raw.timestamp}</span>
              </div>
              <div className="border-l border-white/10 pl-3">
                <span className="text-slate-400 text-[9px] block">THROUGHPUT</span>
                <span className="text-emerald-400 font-bold">{hoveredCoord.raw.throughput} evt/s</span>
              </div>
              <div className="border-l border-white/10 pl-3">
                <span className="text-slate-400 text-[9px] block">P99 / P50</span>
                <span className="text-purple-300 font-bold">
                  {hoveredCoord.raw.latencyP99}ms / {hoveredCoord.raw.latencyP50}ms
                </span>
              </div>
              <div className="border-l border-white/10 pl-3">
                <span className="text-slate-400 text-[9px] block">ERRORS</span>
                <span className="text-rose-400 font-bold">{hoveredCoord.raw.errorRate}%</span>
              </div>
              <div className="border-l border-white/10 pl-3">
                <span className="text-slate-400 text-[9px] block">DEDUPED</span>
                <span className="text-amber-300 font-bold">{hoveredCoord.raw.suppressed}x</span>
              </div>
            </div>
          ) : (
            <div className="absolute right-3 top-2.5 text-[10px] font-mono text-slate-400 pointer-events-none">
              Measures events/sec, P99/P50 tail latency (ms), and error % across the selected time window
            </div>
          )}

          <svg
            viewBox="0 0 800 165"
            preserveAspectRatio="none"
            className="w-full h-[148px] overflow-visible"
            onMouseLeave={() => setHoveredIdx(null)}
          >
            <defs>
              <linearGradient id="wfGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={strokeColor} stopOpacity="0.36" />
                <stop offset="100%" stopColor={strokeColor} stopOpacity="0.0" />
              </linearGradient>
            </defs>

            <line x1="0" y1="35" x2="800" y2="35" stroke="#151A26" strokeWidth="1" strokeDasharray="3 3" />
            <line x1="0" y1="82" x2="800" y2="82" stroke="#151A26" strokeWidth="1" strokeDasharray="3 3" />
            <line x1="0" y1="130" x2="800" y2="130" stroke="#151A26" strokeWidth="1" strokeDasharray="3 3" />

            <path d={areaD} fill="url(#wfGrad)" />
            <path d={pathD} fill="none" stroke={strokeColor} strokeWidth="2.4" strokeLinecap="round" />

            {metricTab === 'latency' && p50PathD && (
              <path d={p50PathD} fill="none" stroke="#10B981" strokeWidth="1.6" strokeDasharray="4 4" />
            )}

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

            {hoveredCoord && (
              <>
                <line
                  x1={hoveredCoord.x}
                  y1={0}
                  x2={hoveredCoord.x}
                  y2={165}
                  stroke="#10B981"
                  strokeWidth="1.2"
                  strokeDasharray="3 3"
                />
                <line
                  x1={0}
                  y1={hoveredCoord.y}
                  x2={800}
                  y2={hoveredCoord.y}
                  stroke="#10B981"
                  strokeWidth="0.8"
                  strokeDasharray="3 3"
                  strokeOpacity="0.5"
                />
              </>
            )}

            {coords.map((_, idx) => {
              const step = 800 / (coords.length - 1 || 1);
              return (
                <rect
                  key={idx}
                  x={idx * step - step / 2}
                  y={0}
                  width={step}
                  height={165}
                  fill="transparent"
                  className="cursor-crosshair"
                  onMouseEnter={() => setHoveredIdx(idx)}
                />
              );
            })}
          </svg>

          <div className="flex items-center justify-between px-8 pt-1 text-[10px] font-mono text-slate-300 border-t border-white/10">
            {xLabels.map((lbl, i) => (
              <span key={i} className={i === xLabels.length - 1 ? 'text-emerald-400 font-bold' : ''}>
                {lbl}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="p-6 rounded-2xl nf-card flex flex-col justify-between space-y-4">
        <div>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <BarChart3 className="w-4 h-4 text-amber-400" />
              <h3 className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                Alert Dedup &amp; Burst Suppression
              </h3>
            </div>
            <InfoTooltip content="Shows how many duplicate alert storms were collapsed inside each 60-second deduplication bucket." />
          </div>
          <p className="text-[11px] text-slate-300 font-mono mt-1">
            Horizon: <span className="text-amber-400 font-bold">{globalRange === 'custom' ? `${customMinutes}m` : globalRange}</span> • Collapsed:{' '}
            <span className="text-emerald-400 font-bold">
              {series.reduce((acc, p) => acc + p.suppressed, 0)} evts
            </span>
          </p>
        </div>

        <div className="h-52 bg-[#05070B] rounded-xl border border-white/10 p-3 flex flex-col justify-end">
          <div className="flex items-end justify-between h-36 space-x-1.5 pt-6">
            {series.slice(-16).map((pt, i) => {
              const heightPct = Math.min(100, Math.max(15, Math.round((pt.suppressed / 38) * 100)));
              return (
                <div key={i} className="flex-1 flex flex-col items-center group relative h-full justify-end cursor-pointer">
                  <div
                    style={{ height: `${heightPct}%` }}
                    className={`w-full rounded-t transition-all duration-200 ${
                      pt.suppressed > 22
                        ? 'bg-gradient-to-t from-amber-600 to-amber-400 group-hover:from-amber-400 group-hover:to-yellow-300'
                        : 'bg-gradient-to-t from-emerald-700/80 to-emerald-400/90 group-hover:from-emerald-400 group-hover:to-teal-200'
                    }`}
                  />
                  <div className="opacity-0 group-hover:opacity-100 absolute -top-8 bg-[#111520] border border-emerald-400/40 text-[10px] font-mono text-white px-2 py-1 rounded-lg pointer-events-none whitespace-nowrap z-30 shadow-xl">
                    {pt.timestamp} • <span className="text-amber-300 font-bold">{pt.suppressed}x</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[10px] font-mono text-slate-400 pt-2 border-t border-white/10 mt-2">
            <span>{series[Math.max(0, series.length - 16)]?.timestamp}</span>
            <span className="text-emerald-400 font-bold">Now: {series[series.length - 1]?.suppressed}x</span>
          </div>
        </div>
      </div>
    </div>
  );
}

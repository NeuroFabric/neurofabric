import { useState, useEffect, useMemo } from 'react';
import { Activity, Clock, Calendar, ChevronDown, Check } from 'lucide-react';
import { InfoTooltip } from '../common/Tooltip';

export type TimeRange = '5m' | '15m' | '30m' | '1h' | '2h' | '5h' | 'custom';

interface DataPoint {
  time: string;
  value: number;
  latency: number;
  errorRate: number;
}

export function LiveThroughputChart() {
  const [range, setRange] = useState<TimeRange>('15m');
  const [metricTab, setMetricTab] = useState<'throughput' | 'latency' | 'errors'>('throughput');
  const [isCustomOpen, setIsCustomOpen] = useState(false);
  const [customMinutes, setCustomMinutes] = useState(45);
  const [hoveredPoint, setHoveredPoint] = useState<DataPoint | null>(null);

  // Generate initial history points based on range
  const pointCount = range === '5m' ? 20 : range === '15m' ? 30 : range === '30m' ? 45 : range === '1h' ? 60 : 75;

  const [points, setPoints] = useState<DataPoint[]>(() => {
    const list: DataPoint[] = [];
    const now = Date.now();
    for (let i = pointCount; i >= 0; i--) {
      const t = new Date(now - i * 15000);
      list.push({
        time: t.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        value: Number((12.5 + Math.sin(i * 0.4) * 3 + Math.random() * 2).toFixed(1)),
        latency: Number((12 + Math.cos(i * 0.3) * 4 + Math.random() * 2).toFixed(1)),
        errorRate: Number((Math.random() > 0.85 ? Math.random() * 1.5 : 0.02).toFixed(2)),
      });
    }
    return list;
  });

  // Ticking effect: push real-time point every 1.5 seconds to make it a living stream
  useEffect(() => {
    const interval = setInterval(() => {
      setPoints((prev) => {
        const now = new Date();
        const lastVal = prev[prev.length - 1]?.value || 14.0;
        const drift = (Math.random() - 0.48) * 1.8;
        const nextVal = Math.max(8.0, Math.min(24.0, Number((lastVal + drift).toFixed(1))));
        const nextLat = Math.max(9.0, Math.min(35.0, Number((13.5 + Math.random() * 3).toFixed(1))));
        const nextErr = Math.random() > 0.92 ? Number((Math.random() * 1.2).toFixed(2)) : 0.01;

        const newPoint: DataPoint = {
          time: now.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          value: nextVal,
          latency: nextLat,
          errorRate: nextErr,
        };
        return [...prev.slice(1), newPoint];
      });
    }, 1500);

    return () => clearInterval(interval);
  }, []);

  // Compute SVG Polyline / Path coords
  const { pathD, areaD, minVal, maxVal, currentVal } = useMemo(() => {
    if (points.length === 0) return { pathD: '', areaD: '', minVal: 0, maxVal: 0, currentVal: 0 };

    const getVal = (p: DataPoint) => (metricTab === 'throughput' ? p.value : metricTab === 'latency' ? p.latency : p.errorRate);
    const vals = points.map(getVal);
    const min = Math.floor(Math.min(...vals) * 0.9);
    const max = Math.ceil(Math.max(...vals) * 1.1) || 1;

    const width = 800;
    const height = 140;
    const step = width / (points.length - 1);

    const coords = points.map((p, idx) => {
      const v = getVal(p);
      const x = idx * step;
      const y = height - ((v - min) / (max - min || 1)) * (height - 20) - 10;
      return { x, y };
    });

    let d = `M ${coords[0].x} ${coords[0].y}`;
    for (let i = 1; i < coords.length; i++) {
      const prev = coords[i - 1];
      const curr = coords[i];
      const midX = (prev.x + curr.x) / 2;
      d += ` C ${midX} ${prev.y}, ${midX} ${curr.y}, ${curr.x} ${curr.y}`;
    }

    const area = `${d} L ${width} ${height} L 0 ${height} Z`;

    return {
      pathD: d,
      areaD: area,
      minVal: min,
      maxVal: max,
      currentVal: vals[vals.length - 1],
    };
  }, [points, metricTab]);

  const ranges: TimeRange[] = ['5m', '15m', '30m', '1h', '2h', '5h'];

  return (
    <div className="p-6 rounded-2xl bg-[#111319] border border-slate-800/80 space-y-4">
      {/* Header Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <div className="p-2 rounded-xl bg-emerald-950/60 border border-emerald-800 text-emerald-400">
            <Activity className="w-4 h-4 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                Telemetry Waveform Stream
              </h3>
              <InfoTooltip content="Continuous sub-85ms ingest rates aggregated from the Ingress Gateway buffer before dedup filtering." />
            </div>
            <div className="text-[11px] text-slate-400 font-mono mt-0.5">
              Live Rate: <span className="text-emerald-400 font-bold">{currentVal}</span>{' '}
              {metricTab === 'throughput' ? 'evt/s' : metricTab === 'latency' ? 'ms' : '% errors'}
            </div>
          </div>
        </div>

        {/* Metric Selector Tabs */}
        <div className="flex items-center bg-[#171A23] p-1 rounded-xl border border-slate-800 text-xs font-mono">
          <button
            onClick={() => setMetricTab('throughput')}
            className={`px-3 py-1.5 rounded-lg transition ${
              metricTab === 'throughput' ? 'bg-slate-800 text-emerald-400 font-bold shadow' : 'text-slate-400 hover:text-white'
            }`}
          >
            Throughput (evt/s)
          </button>
          <button
            onClick={() => setMetricTab('latency')}
            className={`px-3 py-1.5 rounded-lg transition ${
              metricTab === 'latency' ? 'bg-slate-800 text-cyan-400 font-bold shadow' : 'text-slate-400 hover:text-white'
            }`}
          >
            Ingest Latency (ms)
          </button>
          <button
            onClick={() => setMetricTab('errors')}
            className={`px-3 py-1.5 rounded-lg transition ${
              metricTab === 'errors' ? 'bg-slate-800 text-rose-400 font-bold shadow' : 'text-slate-400 hover:text-white'
            }`}
          >
            Error Rate (%)
          </button>
        </div>

        {/* Time Range Selector */}
        <div className="flex items-center space-x-1 bg-[#171A23] p-1 rounded-xl border border-slate-800 text-xs font-mono">
          <Clock className="w-3.5 h-3.5 text-slate-500 ml-2 mr-1" />
          {ranges.map((r) => (
            <button
              key={r}
              onClick={() => {
                setRange(r);
                setIsCustomOpen(false);
              }}
              className={`px-2.5 py-1 rounded-lg transition ${
                range === r ? 'bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/40' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {r}
            </button>
          ))}
          <button
            onClick={() => setIsCustomOpen(!isCustomOpen)}
            className={`px-2.5 py-1 rounded-lg transition flex items-center space-x-1 ${
              range === 'custom' ? 'bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/40' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Calendar className="w-3 h-3" />
            <span>Custom</span>
            <ChevronDown className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Custom Window Modal/Drawer */}
      {isCustomOpen && (
        <div className="p-4 rounded-xl bg-[#171A23] border border-slate-700/80 flex items-center justify-between text-xs font-mono animate-in fade-in duration-150">
          <div className="flex items-center space-x-3">
            <span className="text-slate-300">Custom Sliding Window:</span>
            <input
              type="number"
              min="5"
              max="720"
              value={customMinutes}
              onChange={(e) => setCustomMinutes(Number(e.target.value))}
              className="w-20 bg-[#0E1017] border border-slate-700 rounded-lg px-2.5 py-1 text-white text-center focus:outline-none focus:border-emerald-500"
            />
            <span className="text-slate-400">minutes</span>
          </div>
          <button
            onClick={() => {
              setRange('custom');
              setIsCustomOpen(false);
            }}
            className="px-3 py-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-lg transition flex items-center space-x-1"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Apply Window</span>
          </button>
        </div>
      )}

      {/* Living Interactive SVG Graph */}
      <div className="relative h-40 w-full bg-[#0A0C10] rounded-xl border border-slate-800/80 p-2 overflow-hidden select-none">
        {/* Y-Axis Labels */}
        <div className="absolute left-3 top-2 bottom-2 flex flex-col justify-between text-[10px] font-mono text-slate-500 pointer-events-none z-10">
          <span>{maxVal}</span>
          <span>{Math.round((maxVal + minVal) / 2)}</span>
          <span>{minVal}</span>
        </div>

        {/* Tooltip Hover Overlay */}
        {hoveredPoint && (
          <div className="absolute right-4 top-3 px-3 py-1.5 rounded-lg bg-[#171A23]/90 border border-slate-700 backdrop-blur text-[11px] font-mono text-slate-200 z-20 pointer-events-none">
            <span className="text-slate-400">{hoveredPoint.time}</span> |{' '}
            <span className="text-emerald-400 font-bold">
              {metricTab === 'throughput' ? `${hoveredPoint.value} evt/s` : metricTab === 'latency' ? `${hoveredPoint.latency} ms` : `${hoveredPoint.errorRate}%`}
            </span>
          </div>
        )}

        <svg
          viewBox="0 0 800 140"
          preserveAspectRatio="none"
          className="w-full h-full overflow-visible"
          onMouseLeave={() => setHoveredPoint(null)}
        >
          <defs>
            <linearGradient id="liveWaveGrad" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={metricTab === 'throughput' ? '#10B981' : metricTab === 'latency' ? '#06B6D4' : '#F43F5E'}
                stopOpacity="0.28"
              />
              <stop
                offset="100%"
                stopColor={metricTab === 'throughput' ? '#10B981' : metricTab === 'latency' ? '#06B6D4' : '#F43F5E'}
                stopOpacity="0.0"
              />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          <line x1="0" y1="35" x2="800" y2="35" stroke="#1D222E" strokeWidth="1" strokeDasharray="3 3" />
          <line x1="0" y1="70" x2="800" y2="70" stroke="#1D222E" strokeWidth="1" strokeDasharray="3 3" />
          <line x1="0" y1="105" x2="800" y2="105" stroke="#1D222E" strokeWidth="1" strokeDasharray="3 3" />

          {/* Area under curve */}
          <path d={areaD} fill="url(#liveWaveGrad)" />

          {/* Curve stroke */}
          <path
            d={pathD}
            fill="none"
            stroke={metricTab === 'throughput' ? '#10B981' : metricTab === 'latency' ? '#06B6D4' : '#F43F5E'}
            strokeWidth="2"
            strokeLinecap="round"
          />

          {/* Interactive invisible hit areas */}
          {points.map((p, idx) => {
            const step = 800 / (points.length - 1);
            const x = idx * step;
            return (
              <rect
                key={idx}
                x={x - step / 2}
                y={0}
                width={step}
                height={140}
                fill="transparent"
                className="cursor-crosshair"
                onMouseEnter={() => setHoveredPoint(p)}
              />
            );
          })}
        </svg>
      </div>

      <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 pt-1">
        <span>Window: {range === 'custom' ? `${customMinutes}m (Custom)` : range}</span>
        <span>Propagation SLA: &lt;85ms (Local IPC)</span>
      </div>
    </div>
  );
}

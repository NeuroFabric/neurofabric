import { ReactNode } from 'react';

interface HoverInspectionCardProps {
  /** Unique identifier for the chart */
  chartId: string;
  /** Current hover index */
  hoverIndex: number | null;
  /** Whether this chart is actively hovered */
  isActive: boolean;
  /** Chart data point at hover index */
  dataPoint: Record<string, unknown> | null;
  /** Chart-specific render function for the card content */
  renderContent: (point: Record<string, unknown>) => ReactNode;
  /** Position style for the tooltip */
  position?: { left: string; top: string };
  /** Chart accent color */
  accentColor: string;
}

/**
 * Floating inspection tooltip for chart hover states
 * Displays detailed telemetry for the hovered data point
 */
export function HoverInspectionCard({
  chartId,
  hoverIndex,
  isActive,
  dataPoint,
  renderContent,
  position,
  accentColor,
}: HoverInspectionCardProps): ReactNode {
  if (!isActive || hoverIndex === null || !dataPoint) return null;

  return (
    <div
      className="absolute z-20 pointer-events-none bg-[#0e1628]/95 border border-white/10 rounded-xl p-2.5 text-[10px] font-mono shadow-2xl text-white transform -translate-x-1/2 -translate-y-full mb-2 backdrop-blur-md"
      style={{
        ...position,
        borderColor: `${accentColor}99`,
        boxShadow: `0 0 20px ${accentColor}33`,
      }}
    >
      {renderContent(dataPoint)}
    </div>
  );
}

/**
 * Chart 1: Ingestion Velocity hover card
 * Displays throughput velocity, peak spikes, and dynamic backpressure limits
 */
export function VelocityHoverCard({ point }: { point: Record<string, unknown> }): ReactNode {
  return (
    <div>
      <div className="text-cyan-400 font-bold border-b border-cyan-500/30 pb-1 mb-1">
        {point.label as string}
      </div>
      <div>Velocity: <span className="text-white font-bold">{point.throughput} evt/s</span></div>
      <div>Peak: <span className="text-emerald-400 font-bold">{point.p95}ms</span></div>
      <div>Backpressure Limit: <span className="text-amber-400 font-bold">{Math.round((point.throughput as number) * 1.5)} evt/s</span></div>
      <div className="text-[9px] text-slate-400 mt-1 italic">Click to filter stream to this slice</div>
    </div>
  );
}

/**
 * Chart 2: Gateway Roundtrip Latency hover card
 * Displays p50 nominal transit, p95 critical path, and p99 tail distribution
 */
export function LatencyHoverCard({ point }: { point: Record<string, unknown> }): ReactNode {
  return (
    <div>
      <div className="text-emerald-400 font-bold border-b border-emerald-500/30 pb-1 mb-1">
        {point.label as string}
      </div>
      <div>P50 Transit: <span className="text-white font-bold">{point.p50}ms</span></div>
      <div>P95 Critical Path: <span className="text-emerald-400 font-bold">{point.p95}ms</span></div>
      <div>P99 Tail: <span className="text-amber-400 font-bold">{point.p99}ms</span></div>
      <div>Jitter: <span className="text-cyan-400 font-bold">±{Math.round(Math.abs((point.p95 as number) - (point.p50 as number)) * 0.3)}ms</span></div>
    </div>
  );
}

/**
 * Chart 3: Error Rate & SLA Budget hover card
 * Displays rolling error percentage, 99.9% SLA threshold, and remaining error budget
 */
export function ErrorRateHoverCard({ point }: { point: Record<string, unknown> }): ReactNode {
  const errorRate = point.errRate as number;
  const slaThreshold = 0.1;
  const remainingBudget = Math.max(0, ((slaThreshold - errorRate) / slaThreshold) * 100);

  return (
    <div>
      <div className="text-rose-400 font-bold border-b border-rose-500/30 pb-1 mb-1">
        {point.label as string}
      </div>
      <div>Error Rate: <span className="text-white font-bold">{errorRate}%</span></div>
      <div>SLA Target: <span className="text-emerald-400 font-bold">< 0.10%</span></div>
      <div>Error Budget: <span className={`font-bold ${remainingBudget > 50 ? 'text-emerald-400' : remainingBudget > 10 ? 'text-amber-400' : 'text-rose-400'}`}>
        {remainingBudget.toFixed(1)}% remaining
      </span></div>
      <div>Budget Burn Rate: <span className="text-cyan-400 font-bold">{errorRate > slaThreshold ? 'EXCEEDED' : 'NOMINAL'}</span></div>
    </div>
  );
}

/**
 * Chart 4: Cascade Suppression & Noise Dedup hover card
 * Displays suppressed noise bursts, deduplication ratio, and root-cause alert isolation
 */
export function SuppressionHoverCard({ point }: { point: Record<string, unknown> }): ReactNode {
  const suppressed = point.supp as number;
  const dedupRatio = suppressed > 0 ? Math.round(suppressed * 2.3) : 0;

  return (
    <div>
      <div className="text-purple-400 font-bold border-b border-purple-500/30 pb-1 mb-1">
        {point.label as string}
      </div>
      <div>Suppression Vol: <span className="text-white font-bold">{suppressed} alerts/min</span></div>
      <div>Dedup Ratio: <span className="text-emerald-400 font-bold">{dedupRatio}:1</span></div>
      <div>Topology Status: <span className="text-cyan-400 font-bold">DAG Correlated</span></div>
      <div>Root Cause Isolation: <span className="text-amber-400 font-bold">ACTIVE</span></div>
    </div>
  );
}

/**
 * Microservice topology node inspection card
 * Reveals transit latency, circuit breaker state, and active DLP rules on hover
 */
export function MicroserviceNodeCard({
  service,
  isHovered,
  position,
}: {
  service: {
    name: string;
    traffic: string;
    latency: string;
    status: string;
    isTripped: boolean;
    dlpRules?: string[];
  };
  isHovered: boolean;
  position?: { left: string; top: string };
}): ReactNode {
  if (!isHovered) return null;

  const breakerState = service.isTripped ? 'OPEN' : service.status.includes('TRIPPED') ? 'HALF-OPEN' : 'CLOSED';
  const breakerColor = breakerState === 'OPEN' ? '#ef4444' : breakerState === 'HALF-OPEN' ? '#f59e0b' : '#10b981';

  return (
    <div
      className="absolute z-20 pointer-events-none bg-[#0e1628]/95 border border-white/10 rounded-xl p-3 text-[10px] font-mono shadow-2xl text-white transform -translate-x-1/2 -translate-y-full mb-2 backdrop-blur-md min-w-[220px]"
      style={{
        ...position,
        boxShadow: `0 0 20px ${breakerColor}33`,
        borderColor: `${breakerColor}99`,
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base">{service.name === 'auth-gateway' ? '🔐' : service.name === 'k8s-ingress' ? '🌐' : '⚙️'}</span>
        <span className="text-white font-bold">{service.name}</span>
        <span
          className="ml-auto px-2 py-0.5 rounded text-[9px] font-bold"
          style={{ backgroundColor: `${breakerColor}22`, color: breakerColor, border: `1px solid ${breakerColor}66` }}
        >
          {breakerState}
        </span>
      </div>

      <div className="space-y-1 border-t border-white/10 pt-2">
        <div className="flex justify-between">
          <span className="text-slate-400">Transit Latency</span>
          <span className="text-white font-bold tabular-nums">{service.latency}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-400">Traffic Share</span>
          <span className="text-cyan-400 font-bold tabular-nums">{service.traffic}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-400">DLP Rules Active</span>
          <span className="text-rose-400 font-bold">{service.dlpRules?.length ?? 3} rules</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-400">Circuit Breaker</span>
          <span className="text-white font-bold" style={{ color: breakerColor }}>{breakerState}</span>
        </div>
      </div>

      {service.dlpRules && service.dlpRules.length > 0 && (
        <div className="mt-2 pt-2 border-t border-white/10">
          <div className="text-slate-400 text-[9px] mb-1">Active DLP Patterns:</div>
          <ul className="space-y-0.5">
            {service.dlpRules.map((rule, i) => (
              <li key={i} className="text-[9px] text-rose-300 font-mono">{rule}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
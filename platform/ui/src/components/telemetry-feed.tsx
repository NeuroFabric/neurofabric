import { AnimatePresence, motion } from 'framer-motion'
import { Activity } from 'lucide-react'
import { Card } from './card'

export interface Alert {
  severity: 'critical' | 'warning' | 'info'
  source: string
  timestamp: string
  message: string
}

const GRID_COLS = 'grid-cols-[88px_96px_176px_minmax(0,1fr)]'

export function TelemetryFeed({ alerts }: { alerts: Alert[] }) {
  return (
    <Card className="p-0 overflow-hidden">
      {/* Header row — identical grid template as data rows for perfect column alignment */}
      <div
        className={`grid ${GRID_COLS} items-center border-b border-white/[0.08] px-4 py-3 bg-white/[0.02] text-[10px] font-semibold uppercase tracking-wider text-slate-500`}
      >
        <div>Severity</div>
        <div>Source</div>
        <div>Timestamp</div>
        <div>Message</div>
      </div>

      <div className="grid gap-px bg-white/[0.08]">
        {alerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 bg-[#0e1522] text-slate-500">
            <Activity size={22} strokeWidth={1.5} className="text-slate-600" />
            <p className="text-xs">No telemetry</p>
            <p className="text-[10px] text-slate-600">Waiting for the stream to report events.</p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {alerts.map((alert, i) => (
              <motion.div
                key={`${alert.timestamp}-${alert.source}-${i}`}
                layout
                initial={{ opacity: 0, transform: 'translateY(-4px)' }}
                animate={{ opacity: 1, transform: 'translateY(0px)' }}
                exit={{ opacity: 0, transform: 'translateY(4px)' }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className={`grid ${GRID_COLS} items-center px-4 py-3 bg-[#0e1522] text-[11px] text-slate-300`}
              >
                <span
                  className={`w-fit rounded-full px-2 py-0.5 text-[9px] font-bold uppercase ${
                    alert.severity === 'critical'
                      ? 'bg-rose-500/10 text-rose-400'
                      : alert.severity === 'warning'
                        ? 'bg-amber-500/10 text-amber-400'
                        : 'bg-emerald-500/10 text-emerald-400'
                  }`}
                >
                  {alert.severity}
                </span>
                <span className="font-mono tabular-nums text-slate-400">{alert.source}</span>
                <span className="font-mono tabular-nums text-slate-500">{alert.timestamp}</span>
                <span className="font-mono tabular-nums truncate">{alert.message}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
    </Card>
  )
}

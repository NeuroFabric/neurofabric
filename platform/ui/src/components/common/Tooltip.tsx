import React, { useState } from 'react';
import { HelpCircle } from 'lucide-react';

interface Props {
  content: string;
  children?: React.ReactNode;
  position?: 'top' | 'bottom';
}

export function InfoTooltip({ content, children, position = 'bottom' }: Props) {
  const [visible, setVisible] = useState(false);

  const posClasses =
    position === 'bottom'
      ? 'top-full mt-2 left-1/2 -translate-x-1/2'
      : 'bottom-full mb-2 left-1/2 -translate-x-1/2';

  return (
    <div className="relative inline-flex items-center">
      {children ? (
        <div
          onMouseEnter={() => setVisible(true)}
          onMouseLeave={() => setVisible(false)}
          className="cursor-help inline-flex items-center"
        >
          {children}
        </div>
      ) : (
        <button
          type="button"
          onMouseEnter={() => setVisible(true)}
          onMouseLeave={() => setVisible(false)}
          onClick={() => setVisible(!visible)}
          className="text-slate-400 hover:text-cyan-300 ml-1.5 transition p-0.5 rounded"
          aria-label="Info"
        >
          <HelpCircle className="w-3.5 h-3.5" />
        </button>
      )}

      {visible && (
        <div
          className={`absolute ${posClasses} w-64 p-3 rounded-xl bg-[#141824] border border-cyan-500/40 shadow-[0_12px_40px_rgba(0,0,0,0.85)] z-[100] text-[11px] font-sans text-slate-200 leading-relaxed pointer-events-none`}
        >
          <div className="font-bold text-cyan-400 mb-1 font-mono text-[10px] uppercase tracking-wider">
            Telemetry Specification
          </div>
          {content}
        </div>
      )}
    </div>
  );
}

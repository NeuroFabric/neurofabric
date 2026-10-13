import React, { useState } from 'react';
import { HelpCircle } from 'lucide-react';

interface Props {
  content: string;
  children?: React.ReactNode;
}

export function InfoTooltip({ content, children }: Props) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative inline-flex items-center group">
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
          className="text-slate-500 hover:text-slate-300 ml-1.5 transition p-0.5 rounded"
          aria-label="Info"
        >
          <HelpCircle className="w-3.5 h-3.5" />
        </button>
      )}

      {visible && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2.5 rounded-xl bg-[#171A23] border border-slate-700/80 shadow-2xl z-50 text-[11px] font-sans text-slate-300 leading-relaxed pointer-events-none animate-in fade-in zoom-in-95 duration-150">
          <div className="font-semibold text-white mb-0.5 font-mono text-[10px] uppercase tracking-wider text-emerald-400">
            System Guide
          </div>
          {content}
          <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-[#171A23]" />
        </div>
      )}
    </div>
  );
}

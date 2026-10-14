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
          className="text-zinc-500 hover:text-amber-400 ml-1.5 transition p-0.5 rounded"
          aria-label="Info"
        >
          <HelpCircle className="w-3.5 h-3.5" />
        </button>
      )}

      {visible && (
        <div
          className={`absolute ${posClasses} w-64 p-3 rounded-xl bg-[#18181B] border border-zinc-700 shadow-[0_16px_40px_rgba(0,0,0,0.9)] z-[100] text-[11px] font-sans text-zinc-200 leading-relaxed pointer-events-none`}
        >
          <div className="font-bold text-amber-400 mb-1 font-mono text-[10px] uppercase tracking-wider">
            System Specification
          </div>
          {content}
        </div>
      )}
    </div>
  );
}

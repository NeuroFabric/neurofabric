import { useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { Link } from 'react-router-dom';

export function CookieConsentBanner() {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-6 md:max-w-md z-50 p-4 rounded-2xl bg-[#0D111C]/95 backdrop-blur-xl border border-emerald-500/40 shadow-2xl font-sans text-xs space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center space-x-2 text-emerald-400 font-mono font-bold">
          <ShieldCheck className="w-4 h-4 shrink-0" />
          <span>ZERO-TRUST COOKIE &amp; TELEMETRY NOTICE</span>
        </div>
        <button
          onClick={() => setDismissed(true)}
          aria-label="Close consent banner"
          className="text-slate-400 hover:text-white"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <p className="text-slate-300 leading-relaxed text-[11px]">
        NeuroFabric uses strictly necessary volatile memory sessions and zero third-party tracking cookies. Read our{' '}
        <Link to="/privacy" className="text-emerald-400 underline hover:text-emerald-300">
          Privacy Policy
        </Link>{' '}
        and{' '}
        <Link to="/terms" className="text-emerald-400 underline hover:text-emerald-300">
          Terms
        </Link>
        .
      </p>
      <div className="flex items-center justify-end space-x-2">
        <button
          onClick={() => setDismissed(true)}
          className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 font-mono text-[11px]"
        >
          Essential Only
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="px-3.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono font-bold text-[11px]"
        >
          Accept Sovereign Telemetry
        </button>
      </div>
    </div>
  );
}

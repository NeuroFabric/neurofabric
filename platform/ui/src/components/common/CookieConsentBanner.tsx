import { useState } from 'react';
import { ShieldCheck, X, Cookie } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';

export function CookieConsentBanner() {
  const [consentState, setConsentState] = useState<'UNSET' | 'ACCEPTED' | 'ESSENTIAL'>('UNSET');

  if (consentState !== 'UNSET') {
    return (
      <button
        onClick={() => {
          setConsentState('UNSET');
          toast.info('Cookie Consent Reset', { description: 'You can now review or clear your cookie preferences.' });
        }}
        title="Manage or Clear Cookie Consent"
        className="fixed bottom-3 right-3 z-40 px-2.5 py-1.5 rounded-xl bg-[#0D111C]/90 border border-white/10 hover:border-emerald-400/50 text-[10px] font-mono text-slate-300 flex items-center space-x-1.5 shadow-lg"
      >
        <Cookie className="w-3 h-3 text-emerald-400" />
        <span>Cookie Consent ({consentState})</span>
      </button>
    );
  }

  return (
    <div
      role="region"
      aria-label="Cookie and Telemetry Consent Notice"
      className="fixed bottom-4 left-4 right-4 md:left-auto md:right-6 md:max-w-md z-50 p-4 rounded-2xl bg-[#0D111C]/95 backdrop-blur-xl border border-emerald-500/40 shadow-2xl font-sans text-xs space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center space-x-2 text-emerald-400 font-mono font-bold">
          <ShieldCheck className="w-4 h-4 shrink-0" />
          <span>ZERO-TRACKING COOKIE &amp; DPDP NOTICE</span>
        </div>
        <button
          onClick={() => setConsentState('ESSENTIAL')}
          aria-label="Dismiss cookie banner"
          className="text-slate-300 hover:text-white"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <p className="text-slate-200 leading-relaxed text-[11px]">
        NeuroFabric uses zero third-party tracking embeds and collects only strictly necessary session data. Review our{' '}
        <Link to="/privacy" className="text-emerald-400 underline hover:text-emerald-300">
          Privacy Policy
        </Link>
        ,{' '}
        <Link to="/cookies" className="text-emerald-400 underline hover:text-emerald-300">
          Cookies Policy
        </Link>
        , and{' '}
        <Link to="/refund" className="text-emerald-400 underline hover:text-emerald-300">
          Refund Policy
        </Link>
        .
      </p>
      <div className="flex items-center justify-end space-x-2">
        <button
          onClick={() => setConsentState('ESSENTIAL')}
          className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-200 font-mono text-[11px]"
        >
          Reject Non-Essential
        </button>
        <button
          onClick={() => setConsentState('ACCEPTED')}
          className="px-3.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono font-bold text-[11px]"
        >
          Accept Essential Session
        </button>
      </div>
    </div>
  );
}

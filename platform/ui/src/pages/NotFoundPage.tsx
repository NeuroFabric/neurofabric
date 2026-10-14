import { useNavigate, useLocation } from 'react-router-dom';
import { ShieldAlert, ArrowLeft, Home } from 'lucide-react';

export function NotFoundPage() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center p-8 text-center font-sans">
      <div className="p-8 rounded-3xl nf-card max-w-md w-full space-y-5 border border-rose-500/30">
        <div className="w-12 h-12 rounded-2xl bg-rose-500/15 border border-rose-500/40 flex items-center justify-center text-rose-400 mx-auto">
          <ShieldAlert className="w-6 h-6" />
        </div>
        <div className="space-y-1">
          <div className="text-xs font-mono font-bold text-rose-400 uppercase tracking-wider">
            HTTP 404 • ROUTE NOT IN ALLOWLIST
          </div>
          <h1 className="text-2xl font-extrabold text-white">Sovereign Endpoint Not Found</h1>
          <p className="text-xs text-slate-400 mt-1 font-mono break-all">
            Path "{location.pathname}" does not match any registered cockpit module.
          </p>
        </div>
        <div className="flex items-center justify-center space-x-3 pt-2">
          <button
            onClick={() => navigate('/overview')}
            className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono font-bold text-xs flex items-center space-x-1.5 transition"
          >
            <Home className="w-3.5 h-3.5" />
            <span>Return to Command Center</span>
          </button>
          <button
            onClick={() => navigate('/')}
            className="px-4 py-2.5 rounded-xl bg-[#121622] hover:bg-slate-800 border border-white/10 text-slate-200 font-mono text-xs flex items-center space-x-1.5 transition"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Launch Portal</span>
          </button>
        </div>
      </div>
    </div>
  );
}

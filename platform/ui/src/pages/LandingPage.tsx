import { useNavigate } from 'react-router-dom';
import { Logo } from '../components/common/Logo';
import { ShieldCheck, Zap, Database, ArrowRight, Radio } from 'lucide-react';

export function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#07090e] text-slate-100 flex flex-col font-sans select-none">
      <header className="h-16 border-b border-slate-800/80 px-8 flex items-center justify-between">
        <Logo size="md" />
        <div className="flex items-center space-x-4">
          <button
            onClick={() => navigate('/login')}
            className="px-4 py-2 rounded-xl text-xs font-mono font-bold bg-slate-900 border border-slate-700 hover:border-cyan-500 text-slate-300 hover:text-white transition"
          >
            Operator Login
          </button>
          <button
            onClick={() => navigate('/overview')}
            className="px-4 py-2 rounded-xl text-xs font-mono font-bold bg-cyan-500 hover:bg-cyan-400 text-slate-950 flex items-center space-x-1.5 transition shadow-lg shadow-cyan-500/20"
          >
            <span>Launch Cockpit</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-6xl mx-auto px-8 py-16 flex flex-col items-center justify-center text-center">
        <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-cyan-950/60 border border-cyan-800/80 text-[11px] font-mono text-cyan-300 mb-6">
          <Radio className="w-3 h-3 text-cyan-400 animate-pulse" />
          <span>Sovereign Autonomous Incident Engineering</span>
        </div>

        <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight text-white max-w-3xl leading-tight">
          The 2 AM Cockpit for Exhausted SREs.
        </h1>
        <p className="text-sm md:text-base text-slate-400 max-w-2xl mt-4 leading-relaxed">
          Diagnose, review, verify AST safety gates, and dispatch GitOps remediations in under 90 seconds.
          Guaranteed zero-leak cryptographic Merkle auditability.
        </p>

        <div className="flex items-center space-x-4 mt-8">
          <button
            onClick={() => navigate('/overview')}
            className="px-6 py-3.5 rounded-xl font-mono text-xs font-bold bg-cyan-500 hover:bg-cyan-400 text-slate-950 flex items-center space-x-2 transition shadow-lg shadow-cyan-500/25"
          >
            <span>Enter Command Center</span>
            <ArrowRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => navigate('/alerts')}
            className="px-6 py-3.5 rounded-xl font-mono text-xs font-bold bg-slate-900 border border-slate-700 hover:border-slate-500 text-slate-300 transition"
          >
            View Live Stream
          </button>
        </div>

        <div className="grid md:grid-cols-3 gap-6 mt-16 w-full text-left">
          <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800">
            <ShieldCheck className="w-5 h-5 text-emerald-400 mb-3" />
            <h3 className="font-bold text-sm text-white">AST-Gated GitOps</h3>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              Every agent diff is syntactically screened against malicious shell primitives and curl escapes before human review.
            </p>
          </div>
          <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800">
            <Zap className="w-5 h-5 text-rose-400 mb-3" />
            <h3 className="font-bold text-sm text-white">Anti-Flapping Circuits</h3>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              Automated 3-strike isolation locks degraded microservices in 60s, stopping cascade retry storms immediately.
            </p>
          </div>
          <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800">
            <Database className="w-5 h-5 text-cyan-400 mb-3" />
            <h3 className="font-bold text-sm text-white">Merkle Audit Ledger</h3>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              Every human approval, refusal, and exposure action is cryptographically sealed in an append-only SHA-256 tree.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

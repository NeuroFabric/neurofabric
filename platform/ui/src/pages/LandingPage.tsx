import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ShieldCheck,
  Zap,
  Terminal,
  Database,
  ArrowRight,
  Send,
  UserCheck,
  HelpCircle,
} from 'lucide-react';
import { toast } from 'sonner';

interface LandingPageProps {
  onEnter: () => void;
}

export function LandingPage({ onEnter }: LandingPageProps) {
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [supportQuery, setSupportQuery] = useState('');
  const [queryResponse, setQueryResponse] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const personas = [
    { name: 'Alex Vance', role: 'Incident Commander', clearance: 'LEVEL 5 (Full Mutation)' },
    { name: 'Sarah Chen', role: 'SecOps Director', clearance: 'LEVEL 4 (DLP & AST Gate)' },
    { name: 'David Kim', role: 'Senior SRE Lead', clearance: 'LEVEL 3 (Canary & Breakers)' },
  ];

  const handleSupportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!supportQuery.trim()) return;
    setSubmitting(true);
    setTimeout(() => {
      setSubmitting(false);
      setQueryResponse(
        `NeuroFabric Diagnostic Kernel: Analyzed query "${supportQuery}". System identified nominal edge routing. 0 credential leaks detected in current 5-minute window. SLA budget operating at 99.98%.`
      );
      toast.success('Query resolved by Autonomous Diagnostic Engine');
    }, 800);
  };

  return (
    <div className="min-h-screen bg-[#07090e] text-slate-100 flex flex-col selection:bg-cyan-500/30 font-sans">
      {/* Glow Effects */}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-gradient-to-b from-cyan-500/10 via-blue-500/5 to-transparent blur-3xl pointer-events-none -z-10" />

      {/* Header */}
      <header className="border-b border-slate-800/80 bg-[#07090e]/80 backdrop-blur sticky top-0 z-40 px-8 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center font-black text-slate-950 text-xs shadow-lg shadow-cyan-500/20">
            NF
          </div>
          <span className="font-bold tracking-tight text-lg text-white">NeuroFabric</span>
          <span className="text-[10px] bg-cyan-950 text-cyan-400 border border-cyan-800/60 px-2 py-0.5 rounded-full font-mono uppercase font-semibold">
            v1.4 Enterprise
          </span>
        </div>

        <nav className="hidden md:flex items-center space-x-8 text-xs text-slate-400 font-medium">
          <a href="#problems" className="hover:text-white transition">Problems Solved</a>
          <a href="#future" className="hover:text-white transition">Future Ecosystem</a>
          <a href="#support" className="hover:text-white transition">AI Diagnostic Desk</a>
        </nav>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowLoginModal(true)}
            className="px-4 py-2 border border-slate-700 hover:border-slate-500 text-slate-300 hover:text-white rounded-xl text-xs font-semibold transition"
          >
            Sign In
          </button>
          <button
            onClick={onEnter}
            className="px-5 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-cyan-500/20 flex items-center space-x-1.5"
          >
            <span>Launch Live Console</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Hero Section */}
      <main className="flex-1 max-w-6xl mx-auto px-6 py-20 flex flex-col items-center text-center">
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-slate-900 border border-slate-700/60 text-xs text-slate-300 mb-8"
        >
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>Closed-Loop SRE Remediation & Zero-Trust Telemetry Mesh</span>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="text-4xl md:text-6xl font-extrabold text-white tracking-tight leading-tight max-w-4xl"
        >
          Automated Incident Remediation <br />
          <span className="bg-gradient-to-r from-cyan-400 via-teal-300 to-blue-500 bg-clip-text text-transparent">
            Without Hallucination Blindspots
          </span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="mt-6 text-base md:text-lg text-slate-400 max-w-2xl leading-relaxed"
        >
          NeuroFabric intercepts high-throughput edge telemetry, scrubs leaked credentials in-flight, evaluates agent-proposed GitOps diffs against an AST security gate, and seals all operations into an immutable SHA-256 Merkle ledger.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mt-10 flex flex-wrap justify-center gap-4"
        >
          <button
            onClick={onEnter}
            className="px-8 py-3.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold rounded-xl transition shadow-xl shadow-cyan-500/20 text-sm flex items-center space-x-2"
          >
            <span>Enter Enterprise HUD</span>
            <ArrowRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowLoginModal(true)}
            className="px-6 py-3.5 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-white font-medium rounded-xl transition text-sm flex items-center space-x-2"
          >
            <UserCheck className="w-4 h-4 text-cyan-400" />
            <span>Select Operator Persona</span>
          </button>
        </motion.div>

        {/* 4 Pillars Section */}
        <section id="problems" className="mt-28 grid md:grid-cols-4 gap-6 text-left w-full">
          <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800/80 relative overflow-hidden group">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center font-bold mb-4">
              <Zap className="w-5 h-5" />
            </div>
            <h3 className="font-semibold text-white text-sm">In-Flight DLP Scrubbing</h3>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              Regex and token scrubbers eliminate AWS keys, GitHub PATs, and bearer tokens in-flight before logs hit disk.
            </p>
          </div>

          <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800/80 relative overflow-hidden group">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center font-bold mb-4">
              <Terminal className="w-5 h-5" />
            </div>
            <h3 className="font-semibold text-white text-sm">AST Diff Security Gate</h3>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              Agent patches pass through AST policy analysis. Dangerous commands (curl piping, rm -rf) are deterministically rejected with HTTP 422.
            </p>
          </div>

          <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800/80 relative overflow-hidden group">
            <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center font-bold mb-4">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <h3 className="font-semibold text-white text-sm">Anti-Flapping Breaker</h3>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              Three strikes within 60 seconds automatically trips the circuit breaker, isolating unstable services from executing deployments.
            </p>
          </div>

          <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800/80 relative overflow-hidden group">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center font-bold mb-4">
              <Database className="w-5 h-5" />
            </div>
            <h3 className="font-semibold text-white text-sm">Merkle Audit Ledger</h3>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              Every remediation action is linked in a cryptographic SHA-256 Merkle chain compliant with NIST SP 800-218 and OWASP Top 10 for LLMs.
            </p>
          </div>
        </section>

        {/* Future Products Section */}
        <section id="future" className="mt-28 w-full text-left">
          <div className="flex items-center justify-between mb-8">
            <div>
              <span className="text-xs font-mono text-cyan-400 font-bold uppercase tracking-wider">Roadmap Preview</span>
              <h2 className="text-2xl font-bold text-white mt-1">Next-Gen NeuroFabric Ecosystem</h2>
            </div>
            <span className="text-xs font-mono px-3 py-1 bg-slate-900 border border-slate-800 rounded-full text-slate-400">
              Q4 2026 - Q1 2027
            </span>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            <div className="p-6 rounded-2xl bg-gradient-to-b from-[#0d121d] to-[#0a0e17] border border-cyan-500/20">
              <div className="flex items-center justify-between mb-3">
                <span className="text-cyan-400 font-bold text-sm">NeuroFabric Sentinel</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800 font-bold">ALPHA</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Autonomous zero-day anomaly quarantine executing local micro-isolation before traffic spreads across the cluster.
              </p>
            </div>

            <div className="p-6 rounded-2xl bg-gradient-to-b from-[#0d121d] to-[#0a0e17] border border-purple-500/20">
              <div className="flex items-center justify-between mb-3">
                <span className="text-purple-400 font-bold text-sm">MeshGuard eBPF</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800 font-bold">PLANNED</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Kernel-level socket filter running eBPF bytecode for microsecond TLS payload inspection with zero CPU context overhead.
              </p>
            </div>

            <div className="p-6 rounded-2xl bg-gradient-to-b from-[#0d121d] to-[#0a0e17] border border-emerald-500/20">
              <div className="flex items-center justify-between mb-3">
                <span className="text-emerald-400 font-bold text-sm">Autonomous Kernel v2</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 font-bold">IN DEV</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Multi-agent swarm coordination protocol enabling consensus-driven GitOps rollbacks without single points of failure.
              </p>
            </div>
          </div>
        </section>

        {/* Support & Real-Time Query Section */}
        <section id="support" className="mt-28 w-full text-left">
          <div className="p-8 rounded-3xl bg-[#0d121d] border border-slate-800">
            <div className="max-w-2xl">
              <div className="flex items-center space-x-2 text-cyan-400 text-xs font-mono font-bold uppercase">
                <HelpCircle className="w-4 h-4" />
                <span>Enterprise Diagnostic Query Desk</span>
              </div>
              <h2 className="text-2xl font-bold text-white mt-2">Ask NeuroFabric Kernel in Real-Time</h2>
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                Input any service name, error code, or incident query to run an instant autonomous analysis.
              </p>
            </div>

            <form onSubmit={handleSupportSubmit} className="mt-6 flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                value={supportQuery}
                onChange={(e) => setSupportQuery(e.target.value)}
                placeholder="e.g. Check auth-gateway credentials or payment circuit breaker state..."
                className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono"
              />
              <button
                type="submit"
                disabled={submitting}
                className="px-6 py-3 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-xs font-bold rounded-xl transition flex items-center justify-center space-x-2"
              >
                {submitting ? <span>Evaluating...</span> : <><Send className="w-3.5 h-3.5" /><span>Execute Query</span></>}
              </button>
            </form>

            {queryResponse && (
              <motion.div
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-4 p-4 rounded-xl bg-cyan-950/40 border border-cyan-800/80 text-xs font-mono text-cyan-300 leading-relaxed"
              >
                {queryResponse}
              </motion.div>
            )}
          </div>
        </section>
      </main>

      {/* Login / Persona Selection Modal */}
      <AnimatePresence>
        {showLoginModal && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-md bg-[#0d121d] border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-6"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-white">Select Operator Persona</h3>
                  <p className="text-xs text-slate-400 mt-0.5">Role-based authentication clearance</p>
                </div>
                <button
                  onClick={() => setShowLoginModal(false)}
                  className="text-slate-500 hover:text-white text-sm"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-3">
                {personas.map((p) => (
                  <button
                    key={p.name}
                    onClick={() => {
                      setShowLoginModal(false);
                      toast.success(`Authenticated as ${p.name}`, { description: p.clearance });
                      onEnter();
                    }}
                    className="w-full p-4 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-cyan-500/40 text-left transition flex items-center justify-between"
                  >
                    <div>
                      <div className="text-sm font-bold text-white">{p.name}</div>
                      <div className="text-xs text-slate-400">{p.role}</div>
                      <div className="text-[10px] font-mono text-cyan-400 mt-1 font-semibold">{p.clearance}</div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-slate-500" />
                  </button>
                ))}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

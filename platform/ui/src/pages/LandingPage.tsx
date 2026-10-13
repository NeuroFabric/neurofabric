
interface LandingPageProps {
  onEnter: () => void;
}

export function LandingPage({ onEnter }: LandingPageProps) {
  return (
    <div className="min-h-screen bg-[#07090e] text-slate-100 flex flex-col selection:bg-cyan-500/30">
      {/* Top Navbar */}
      <header className="border-b border-slate-800/80 bg-[#07090e]/80 backdrop-blur sticky top-0 z-50 px-8 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center font-bold text-white shadow-lg shadow-cyan-500/20">
            NF
          </div>
          <span className="font-bold tracking-tight text-lg text-white">NeuroFabric</span>
          <span className="text-[10px] bg-cyan-950 text-cyan-400 border border-cyan-800/60 px-2 py-0.5 rounded-full font-mono uppercase">
            v1.4 Enterprise
          </span>
        </div>

        <nav className="hidden md:flex items-center space-x-8 text-sm text-slate-400">
          <a href="#problems" className="hover:text-white transition">Problems Solved</a>
          <a href="#architecture" className="hover:text-white transition">Architecture</a>
          <a href="#security" className="hover:text-white transition">NIST & OWASP Traceability</a>
        </nav>

        <button
          onClick={onEnter}
          className="px-5 py-2.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white rounded-xl text-sm font-bold transition shadow-lg shadow-cyan-500/20"
        >
          Launch Live Console →
        </button>
      </header>

      {/* Hero Section */}
      <main className="flex-1 max-w-6xl mx-auto px-6 py-20 flex flex-col items-center text-center">
        <div className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-slate-900 border border-slate-700/60 text-xs text-slate-300 mb-8">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>Zero-Trust Infrastructure Telemetry & Autonomous SRE Remediation</span>
        </div>

        <h1 className="text-4xl md:text-6xl font-extrabold text-white tracking-tight leading-tight max-w-4xl">
          Automated Closed-Loop Infrastructure <br />
          <span className="bg-gradient-to-r from-cyan-400 via-teal-300 to-blue-500 bg-clip-text text-transparent">
            Without Hallucination Vulnerabilities
          </span>
        </h1>

        <p className="mt-6 text-lg text-slate-400 max-w-2xl leading-relaxed">
          NeuroFabric intercepts high-throughput edge telemetry, scrubs leaked credentials in-flight, evaluates AI-generated GitOps diffs against a strict AST security firewall, and seals every autonomous action into an immutable Merkle audit ledger.
        </p>

        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <button
            onClick={onEnter}
            className="px-8 py-3.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold rounded-xl transition shadow-xl shadow-cyan-500/20 text-base"
          >
            Launch Enterprise Console Now →
          </button>
        </div>

        {/* 4 Core Pillars */}
        <section id="problems" className="mt-28 grid md:grid-cols-4 gap-6 text-left w-full">
          <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800/80">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center font-bold mb-4">
              01
            </div>
            <h3 className="font-semibold text-white text-base">In-Flight DLP Redaction</h3>
            <p className="text-sm text-slate-400 mt-2 leading-relaxed">
              Regex and token scrubbers eliminate AWS keys, GitHub PATs, and bearer tokens in-flight before logs hit storage.
            </p>
          </div>

          <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800/80">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center font-bold mb-4">
              02
            </div>
            <h3 className="font-semibold text-white text-base">AST Diff Security Gate</h3>
            <p className="text-sm text-slate-400 mt-2 leading-relaxed">
              Agent patches pass through AST policy analysis. Dangerous commands (curl piping, rm -rf) are deterministically rejected with HTTP 422.
            </p>
          </div>

          <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800/80">
            <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center font-bold mb-4">
              03
            </div>
            <h3 className="font-semibold text-white text-base">Anti-Flapping Breaker</h3>
            <p className="text-sm text-slate-400 mt-2 leading-relaxed">
              Three strikes within 60 seconds automatically trips the circuit breaker, isolating unstable services from executing deployments.
            </p>
          </div>

          <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800/80">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center font-bold mb-4">
              04
            </div>
            <h3 className="font-semibold text-white text-base">Merkle Audit Ledger</h3>
            <p className="text-sm text-slate-400 mt-2 leading-relaxed">
              Every remediation action is linked in a cryptographic SHA-256 Merkle chain compliant with NIST SP 800-218 and OWASP Top 10 for LLMs.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

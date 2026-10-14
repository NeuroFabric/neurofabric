import { useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Logo } from '../components/common/Logo';
import {
  ShieldCheck,
  Zap,
  Database,
  ArrowRight,
  Radio,
  Terminal,
  Cpu,
  Layers,
  CheckCircle2,
  Play,
  AlertTriangle,
  Sparkles,
} from 'lucide-react';

function Interactive3DCard({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const [transform, setTransform] = useState('perspective(1000px) rotateX(0deg) rotateY(0deg)');
  const [glare, setGlare] = useState({ x: 50, y: 50, opacity: 0 });

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const rotateX = ((y - centerY) / centerY) * -7;
    const rotateY = ((x - centerX) / centerX) * 7;
    setTransform(`perspective(1000px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) scale3d(1.015, 1.015, 1.015)`);
    setGlare({ x: (x / rect.width) * 100, y: (y / rect.height) * 100, opacity: 0.14 });
  };

  const handleMouseLeave = () => {
    setTransform('perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)');
    setGlare((prev) => ({ ...prev, opacity: 0 }));
  };

  return (
    <div
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{ transform, transition: 'transform 180ms cubic-bezier(0.16, 1, 0.3, 1)' }}
      className={`relative overflow-hidden rounded-2xl bg-[#11141D] border border-slate-800/90 shadow-2xl ${className}`}
    >
      <div
        style={{
          background: `radial-gradient(circle at ${glare.x}% ${glare.y}%, rgba(52, 211, 153, ${glare.opacity}), transparent 60%)`,
        }}
        className="pointer-events-none absolute inset-0 transition-opacity duration-200"
      />
      <div className="relative z-10 h-full">{children}</div>
    </div>
  );
}

export function LandingPage() {
  const navigate = useNavigate();
  const [simStep, setSimStep] = useState<number>(0);

  const simStages = [
    {
      title: '1. In-Flight Edge Telemetry & DLP Scrub',
      status: 'NOMINAL (14ms)',
      desc: 'Intercepting 16.4 evt/s on port 8080. Bearer tokens and AWS keys redacted in-flight before hitting SQLite WAL.',
      log: '[EDGE:8080] POST /ingest -> Redacted [DLP:REDACTED_SECRET] -> EventBridge SSE',
      color: 'text-emerald-400',
    },
    {
      title: '2. 3-Strike Anti-Flapping Circuit Fence',
      status: 'FENCE ARMED (HTTP 423)',
      desc: 'Service flapping-payment-worker hit 3 timeout strikes in 60s. Sovereign circuit tripped to stop retry storms.',
      log: '[CIRCUIT] flapping-payment-worker -> 3/3 strikes -> LOCKED (HTTP 423)',
      color: 'text-amber-400',
    },
    {
      title: '3. AST Diff Security Gate & HITL Review',
      status: 'AST VERIFIED (PASS)',
      desc: 'Autonomous Embassy (Pi Agent) proposed pool-allocator patch. Screened against shell escapes & curl pipes.',
      log: '[AST-GATE] Scanned 24 AST nodes -> 0 shell primitives -> Ready for Operator',
      color: 'text-sky-400',
    },
    {
      title: '4. Immutable SHA-256 Merkle Audit Seal',
      status: 'LEAF #129 SEALED',
      desc: 'Operator approval cryptographically chained to previous leaf hash in append-only SQLite WAL.',
      log: '[MERKLE] Leaf #129 sealed -> Root: 9f86d081884c7d659a2feaa0c55ad015...',
      color: 'text-violet-400',
    },
  ];

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-[#07090E] text-slate-100 flex flex-col font-sans select-none overflow-x-hidden">
      {/* Ambient 3D Perspective Grid Background */}
      <div
        className="fixed inset-0 pointer-events-none opacity-25"
        style={{
          backgroundImage:
            'linear-gradient(to right, #1e293b 1px, transparent 1px), linear-gradient(to bottom, #1e293b 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'radial-gradient(ellipse at 50% 25%, black 30%, transparent 80%)',
        }}
      />

      {/* Sticky Top Header */}
      <header className="sticky top-0 z-40 h-16 bg-[#07090E]/85 backdrop-blur-md border-b border-slate-800/80 px-8 flex items-center justify-between">
        <Logo size="md" />

        <nav className="hidden md:flex items-center space-x-8 text-xs font-medium text-slate-300">
          <button onClick={() => scrollToSection('problems')} className="hover:text-emerald-400 transition">
            Problems Solved
          </button>
          <button onClick={() => scrollToSection('simulator')} className="hover:text-emerald-400 transition">
            3D Interactive Simulator
          </button>
          <button onClick={() => navigate('/roadmap')} className="hover:text-emerald-400 transition">
            Future Ecosystem
          </button>
          <button onClick={() => navigate('/support')} className="hover:text-emerald-400 transition">
            AI Diagnostic Desk
          </button>
        </nav>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => navigate('/login')}
            className="px-4 py-2 rounded-xl text-xs font-mono font-bold bg-[#11141D] border border-slate-700/80 hover:border-emerald-500/60 text-slate-200 transition"
          >
            Sign In
          </button>
          <button
            onClick={() => navigate('/overview')}
            className="px-4 py-2 rounded-xl text-xs font-mono font-bold bg-gradient-to-r from-emerald-400 to-teal-500 hover:from-emerald-300 hover:to-teal-400 text-slate-950 flex items-center space-x-1.5 transition shadow-lg shadow-emerald-500/20"
          >
            <span>Launch Live Console</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Hero Section */}
      <main className="relative z-10 flex-1 max-w-7xl mx-auto px-8 pt-14 pb-24 flex flex-col items-center text-center">
        <div className="inline-flex items-center space-x-2 px-3.5 py-1 rounded-full bg-emerald-950/60 border border-emerald-800/80 text-[11px] font-mono text-emerald-300 mb-6 shadow-inner">
          <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
          <span>Closed-Loop SRE Remediation & Zero-Trust Telemetry Mesh</span>
        </div>

        <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight text-white max-w-4xl leading-[1.1]">
          Automated Incident Remediation{' '}
          <span className="bg-gradient-to-r from-emerald-400 via-teal-300 to-sky-400 bg-clip-text text-transparent">
            Without Hallucination Blindspots
          </span>
        </h1>

        <p className="text-sm md:text-base text-slate-400 max-w-2xl mt-5 leading-relaxed">
          NeuroFabric intercepts high-throughput edge telemetry, scrubs leaked credentials in-flight,
          evaluates agent-proposed GitOps diffs against an AST security gate, and seals every operation
          into an immutable SHA-256 Merkle ledger — built for the 2 AM operator.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4 mt-8">
          <button
            onClick={() => navigate('/overview')}
            className="px-6 py-3.5 rounded-xl font-mono text-xs font-bold bg-gradient-to-r from-emerald-400 to-teal-500 hover:from-emerald-300 hover:to-teal-400 text-slate-950 flex items-center space-x-2 transition shadow-xl shadow-emerald-500/25"
          >
            <span>Enter Command Center</span>
            <ArrowRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => navigate('/login')}
            className="px-6 py-3.5 rounded-xl font-mono text-xs font-bold bg-[#11141D] border border-slate-700 hover:border-slate-500 text-slate-200 transition"
          >
            Select Operator Persona
          </button>
        </div>

        {/* 3D Interactive Isometric Closed-Loop Simulator */}
        <section id="simulator" className="w-full mt-16 text-left">
          <div className="p-6 md:p-8 rounded-3xl bg-gradient-to-b from-[#121621] to-[#0B0D14] border border-slate-800/90 shadow-[0_24px_80px_rgba(0,0,0,0.75)]">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-5">
              <div>
                <div className="flex items-center space-x-2">
                  <Layers className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-400">
                    Interactive 3D Closed-Loop Architecture Simulator
                  </span>
                </div>
                <h2 className="text-lg font-bold text-white mt-1">
                  Click any stage to inspect the live sovereign pipeline in 3D
                </h2>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setSimStep((prev) => (prev + 1) % simStages.length)}
                  className="px-3.5 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 text-xs font-mono font-bold flex items-center space-x-1.5 transition"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Step Pipeline</span>
                </button>
                <button
                  onClick={() => navigate('/embassy')}
                  className="px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 text-xs font-mono transition"
                >
                  Open Live HITL Diff
                </button>
              </div>
            </div>

            <div className="grid lg:grid-cols-12 gap-8 pt-6 items-center">
              {/* Left 5 Cols: 3D Isometric Stacked Layers */}
              <div className="lg:col-span-5 flex flex-col items-center justify-center py-4">
                <div className="relative w-full max-w-sm space-y-3" style={{ perspective: '900px' }}>
                  {simStages.map((stg, idx) => {
                    const active = simStep === idx;
                    return (
                      <div
                        key={idx}
                        onClick={() => setSimStep(idx)}
                        style={{
                          transform: active
                            ? 'rotateX(14deg) rotateY(-12deg) translateZ(18px) scale(1.03)'
                            : 'rotateX(14deg) rotateY(-12deg) translateZ(0px)',
                          transition: 'all 260ms cubic-bezier(0.16, 1, 0.3, 1)',
                        }}
                        className={`p-4 rounded-2xl border cursor-pointer flex items-center justify-between ${
                          active
                            ? 'bg-emerald-950/50 border-emerald-400 shadow-[0_12px_30px_rgba(16,185,129,0.22)]'
                            : 'bg-[#141824]/90 border-slate-800 hover:border-slate-700 opacity-75 hover:opacity-100'
                        }`}
                      >
                        <div className="flex items-center space-x-3">
                          <div
                            className={`w-7 h-7 rounded-lg flex items-center justify-center font-mono text-xs font-bold ${
                              active ? 'bg-emerald-400 text-slate-950' : 'bg-slate-800 text-slate-400'
                            }`}
                          >
                            0{idx + 1}
                          </div>
                          <div>
                            <div className="text-xs font-bold text-white">{stg.title.split('. ')[1]}</div>
                            <div className={`text-[10px] font-mono ${stg.color}`}>{stg.status}</div>
                          </div>
                        </div>
                        <CheckCircle2 className={`w-4 h-4 ${active ? 'text-emerald-400' : 'text-slate-700'}`} />
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Right 7 Cols: Live Stage Telemetry Inspector */}
              <div className="lg:col-span-7 space-y-4 bg-[#090B10] p-6 rounded-2xl border border-slate-800/90 font-mono">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <span className="text-xs font-bold text-white">{simStages[simStep].title}</span>
                  <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded bg-slate-900 border border-slate-700 ${simStages[simStep].color}`}>
                    {simStages[simStep].status}
                  </span>
                </div>

                <p className="text-xs text-slate-300 font-sans leading-relaxed">
                  {simStages[simStep].desc}
                </p>

                <div className="p-3.5 rounded-xl bg-[#050609] border border-slate-800/80 text-[11px] text-emerald-400">
                  <div className="text-[10px] text-slate-500 mb-1 uppercase">Live Kernel Trace</div>
                  {simStages[simStep].log}
                </div>

                <div className="grid grid-cols-3 gap-3 pt-2 text-center">
                  <div className="p-3 rounded-xl bg-[#11141D] border border-slate-800">
                    <div className="text-[10px] text-slate-500">PROPAGATION</div>
                    <div className="text-sm font-bold text-white mt-0.5">14.2 ms</div>
                  </div>
                  <div className="p-3 rounded-xl bg-[#11141D] border border-slate-800">
                    <div className="text-[10px] text-slate-500">DLP LEAKS</div>
                    <div className="text-sm font-bold text-emerald-400 mt-0.5">0 (SCRUBBED)</div>
                  </div>
                  <div className="p-3 rounded-xl bg-[#11141D] border border-slate-800">
                    <div className="text-[10px] text-slate-500">MERKLE STATE</div>
                    <div className="text-sm font-bold text-sky-400 mt-0.5">SHA-256 SEALED</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 4 Core Pillars in Interactive 3D Tilt Cards */}
        <section id="problems" className="w-full mt-16 text-left">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-xl font-bold text-white tracking-tight">Four Sovereign Security Guarantees</h2>
              <p className="text-xs text-slate-400 mt-1">
                Move your cursor across any card to inspect the 3D hardware-accelerated telemetry surface.
              </p>
            </div>
            <span className="text-xs font-mono text-emerald-400 flex items-center space-x-1">
              <Sparkles className="w-3.5 h-3.5" />
              <span>ADR-005 Verified</span>
            </span>
          </div>

          <div className="grid md:grid-cols-4 gap-5">
            <Interactive3DCard className="p-6">
              <div className="w-9 h-9 rounded-xl bg-emerald-950 border border-emerald-800 flex items-center justify-center text-emerald-400 mb-4">
                <Zap className="w-4 h-4" />
              </div>
              <h3 className="font-bold text-sm text-white">In-Flight DLP Scrubbing</h3>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                Regex and token scrubbers eliminate AWS keys, GitHub PATs, and bearer tokens in-flight before logs hit disk.
              </p>
              <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[10px] font-mono text-emerald-400">
                <span>LATENCY OVERHEAD</span>
                <span className="font-bold">&lt; 1.2ms</span>
              </div>
            </Interactive3DCard>

            <Interactive3DCard className="p-6">
              <div className="w-9 h-9 rounded-xl bg-violet-950 border border-violet-800 flex items-center justify-center text-violet-400 mb-4">
                <Terminal className="w-4 h-4" />
              </div>
              <h3 className="font-bold text-sm text-white">AST Diff Security Gate</h3>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                Agent patches pass through AST policy analysis. Dangerous commands (`curl` piping, `rm -rf`) are deterministically rejected with HTTP 422.
              </p>
              <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[10px] font-mono text-violet-400">
                <span>SHELL ESCAPES</span>
                <span className="font-bold">BLOCKED</span>
              </div>
            </Interactive3DCard>

            <Interactive3DCard className="p-6">
              <div className="w-9 h-9 rounded-xl bg-rose-950 border border-rose-800 flex items-center justify-center text-rose-400 mb-4">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <h3 className="font-bold text-sm text-white">Anti-Flapping Breaker</h3>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                Three strikes within 60 seconds automatically trips the circuit breaker, isolating unstable services from executing deployments.
              </p>
              <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[10px] font-mono text-rose-400">
                <span>FENCE LOCK</span>
                <span className="font-bold">HTTP 423</span>
              </div>
            </Interactive3DCard>

            <Interactive3DCard className="p-6">
              <div className="w-9 h-9 rounded-xl bg-amber-950 border border-amber-800 flex items-center justify-center text-amber-400 mb-4">
                <Database className="w-4 h-4" />
              </div>
              <h3 className="font-bold text-sm text-white">Merkle Audit Ledger</h3>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                Every remediation action is linked in a cryptographic SHA-256 Merkle chain compliant with NIST SP 800-218 and OWASP Top 10 for LLMs.
              </p>
              <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[10px] font-mono text-amber-400">
                <span>PROOF VERIFIER</span>
                <span className="font-bold">WEB CRYPTO</span>
              </div>
            </Interactive3DCard>
          </div>
        </section>
      </main>
    </div>
  );
}

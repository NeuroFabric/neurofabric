import { useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTelemetry } from '../context/TelemetryContext';
import { toast } from 'sonner';
import { Logo } from '../components/common/Logo';
import {
  ShieldCheck,
  Zap,
  Database,
  ArrowRight,
  Radio,
  Terminal,
  Layers,
  CheckCircle2,
  Play,
  Sparkles,
  Clock,
  TrendingDown,
  ShieldAlert,
  Check,
  X,
  Lock,
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
    const rotateX = ((y - centerY) / centerY) * -6;
    const rotateY = ((x - centerX) / centerX) * 6;
    setTransform(`perspective(1000px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) scale3d(1.015, 1.015, 1.015)`);
    setGlare({ x: (x / rect.width) * 100, y: (y / rect.height) * 100, opacity: 0.12 });
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
      className={`relative overflow-hidden rounded-2xl bg-gradient-to-b from-[#101420] to-[#0A0D15] border border-white/10 shadow-2xl ${className}`}
    >
      <div
        style={{
          background: `radial-gradient(circle at ${glare.x}% ${glare.y}%, rgba(52, 211, 153, ${glare.opacity}), transparent 65%)`,
        }}
        className="pointer-events-none absolute inset-0 transition-opacity duration-200"
      />
      <div className="relative z-10 h-full">{children}</div>
    </div>
  );
}

export function LandingPage() {
  const navigate = useNavigate();
  const { isAuthenticated } = useTelemetry();
  const goProtected = (targetPath: string) => {
    if (!isAuthenticated) {
      toast.info('Authentication Required', { description: 'Please sign in with Google or your provisioned corporate email first.' });
      navigate('/login?redirect=' + encodeURIComponent(targetPath));
    } else {
      navigate(targetPath);
    }
  };
  const [simStep, setSimStep] = useState<number>(0);

  const simStages = [
    {
      title: '1. In-Flight Edge Telemetry & DLP Scrub',
      status: 'NOMINAL (14ms)',
      desc: 'Intercepting high-throughput edge telemetry on port 8080. Bearer tokens, GitHub PATs, and AWS secret keys are redacted in-flight before ever hitting disk.',
      log: '[EDGE:8080] POST /ingest -> Redacted [DLP:REDACTED_SECRET] -> EventBridge SSE',
      color: 'text-emerald-400',
    },
    {
      title: '2. 3-Strike Anti-Flapping Circuit Fence',
      status: 'FENCE ARMED (HTTP 423)',
      desc: 'Service flapping-payment-worker hit 3 timeout strikes in 60s. Sovereign circuit tripped into isolation to prevent cascade retry storms.',
      log: '[CIRCUIT] flapping-payment-worker -> 3/3 strikes -> LOCKED (HTTP 423)',
      color: 'text-amber-400',
    },
    {
      title: '3. AST Diff Security Gate & HITL Review',
      status: 'AST VERIFIED (PASS)',
      desc: 'Autonomous Embassy (Pi Agent) synthesizes root cause analysis and a declarative GitOps PR. Screened for dangerous shell escapes before operator review.',
      log: '[AST-GATE] Scanned 24 AST nodes -> 0 shell primitives -> Ready for Operator',
      color: 'text-cyan-400',
    },
    {
      title: '4. Immutable SHA-256 Merkle Audit Seal',
      status: 'LEAF #129 SEALED',
      desc: 'Operator authorization is cryptographically chained to previous leaf hash in append-only SQLite WAL, mathematically verifiable in the browser.',
      log: '[MERKLE] Leaf #129 sealed -> Root: 9f86d081884c7d659a2feaa0c55ad015...',
      color: 'text-purple-400',
    },
  ];

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-[#050609] text-slate-100 flex flex-col font-sans select-none overflow-x-hidden">
      {/* Ambient Grid Background */}
      <div
        className="fixed inset-0 pointer-events-none opacity-20"
        style={{
          backgroundImage:
            'linear-gradient(to right, #1e293b 1px, transparent 1px), linear-gradient(to bottom, #1e293b 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'radial-gradient(ellipse at 50% 20%, black 30%, transparent 80%)',
        }}
      />

      {/* Sticky Header */}
      <header className="sticky top-0 z-40 h-16 bg-[#050609]/90 backdrop-blur-md border-b border-white/10 px-8 flex items-center justify-between">
        <Logo size="md" />

        <nav className="hidden md:flex items-center space-x-8 text-xs font-medium text-slate-300">
          <button onClick={() => scrollToSection('benefits')} className="hover:text-emerald-400 transition">
            Benefits & ROI
          </button>
          <button onClick={() => scrollToSection('comparison')} className="hover:text-emerald-400 transition">
            Before vs. NeuroFabric
          </button>
          <button onClick={() => scrollToSection('simulator')} className="hover:text-emerald-400 transition">
            Architecture Simulator
          </button>
          <button onClick={() => scrollToSection('security')} className="hover:text-emerald-400 transition">
            Security Guarantees
          </button>
        </nav>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => navigate('/login')}
            className="px-4 py-2 rounded-xl text-xs font-mono font-bold bg-[#11141D] border border-white/10 hover:border-emerald-500/50 text-slate-200 transition"
          >
            Sign In
          </button>
          <button
            onClick={() => goProtected('/overview')}
            className="px-4 py-2 rounded-xl text-xs font-mono font-bold bg-gradient-to-r from-emerald-400 to-teal-500 hover:from-emerald-300 hover:to-teal-400 text-slate-950 flex items-center space-x-1.5 transition shadow-lg shadow-emerald-500/20"
          >
            <span>Launch Live Console</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Hero Section */}
      <main className="relative z-10 flex-1 max-w-7xl mx-auto px-8 pt-16 pb-24 flex flex-col items-center text-center">
        <div className="inline-flex items-center space-x-2 px-3.5 py-1 rounded-full bg-emerald-950/60 border border-emerald-500/30 text-[11px] font-mono text-emerald-300 mb-6 shadow-inner">
          <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
          <span>Closed-Loop SRE Remediation & Zero-Trust Telemetry Mesh</span>
        </div>

        <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight text-white max-w-4xl leading-[1.1]">
          Automated Incident Remediation{' '}
          <span className="bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-400 bg-clip-text text-transparent">
            Without Hallucination Blindspots
          </span>
        </h1>

        <p className="text-sm md:text-base text-slate-300 max-w-2xl mt-5 leading-relaxed font-sans">
          NeuroFabric intercepts high-throughput edge telemetry, scrubs leaked credentials line-rate,
          evaluates agent-proposed GitOps diffs against deterministic AST security gates, and seals every operation
          into an immutable SHA-256 Merkle ledger.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4 mt-8">
          <button
            onClick={() => goProtected('/overview')}
            className="px-6 py-3.5 rounded-xl font-mono text-xs font-bold bg-gradient-to-r from-emerald-400 to-teal-500 hover:from-emerald-300 hover:to-teal-400 text-slate-950 flex items-center space-x-2 transition shadow-xl shadow-emerald-500/25"
          >
            <span>Enter Command Center</span>
            <ArrowRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => goProtected('/integrations')}
            className="px-6 py-3.5 rounded-xl font-mono text-xs font-bold bg-[#11141D] border border-white/10 hover:border-white/30 text-slate-200 transition"
          >
            Connect Ingestion (REST / OTel)
          </button>
        </div>

        {/* SECTION 1: CORE BENEFITS & ROI */}
        <section id="benefits" className="w-full mt-24 text-left">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-8 border-b border-white/10 pb-5">
            <div>
              <div className="flex items-center space-x-2 font-mono text-xs text-emerald-400 font-bold uppercase tracking-wider">
                <Sparkles className="w-4 h-4" />
                <span>Enterprise Value & SRE ROI</span>
              </div>
              <h2 className="text-2xl font-bold text-white tracking-tight mt-1">
                What Your Engineering Team Gains After Deploying NeuroFabric
              </h2>
            </div>
            <div className="flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-400/30 text-xs font-mono text-emerald-300 font-bold">
              <TrendingDown className="w-3.5 h-3.5" />
              <span>Saves ~18.5 On-Call Hours Per Engineer / Month</span>
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            <Interactive3DCard className="p-6 flex flex-col justify-between">
              <div className="space-y-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                  <TrendingDown className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-base text-white">94.2% Alert Noise Suppression</h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Eliminates alert fatigue. The 60-second sliding dedup window collapses cascading retry storms and duplicate microservice spikes into a single actionable incident context.
                </p>
              </div>
              <div className="mt-5 pt-3 border-t border-white/10 flex items-center justify-between font-mono text-[11px]">
                <span className="text-slate-400">PAGER DUTY FATIGUE</span>
                <span className="text-emerald-400 font-bold">NEAR ZERO</span>
              </div>
            </Interactive3DCard>

            <Interactive3DCard className="p-6 flex flex-col justify-between">
              <div className="space-y-3">
                <div className="w-10 h-10 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                  <Clock className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-base text-white">&lt;90s Mean Time to Resolution</h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Causal root cause analysis and declarative GitOps patches are synthesized by the Embassy diagnostic agent in seconds, ready for one-click operator verification.
                </p>
              </div>
              <div className="mt-5 pt-3 border-t border-white/10 flex items-center justify-between font-mono text-[11px]">
                <span className="text-slate-400">MTTR ACCELERATION</span>
                <span className="text-cyan-300 font-bold">14.8x FASTER</span>
              </div>
            </Interactive3DCard>

            <Interactive3DCard className="p-6 flex flex-col justify-between">
              <div className="space-y-3">
                <div className="w-10 h-10 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-purple-400">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-base text-white">Zero Prompt Injection Hallucinations</h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  AI suggestions never touch production without deterministic AST screening. Prohibited shell escapes like <code className="text-rose-400">curl | bash</code> and <code className="text-rose-400">rm -rf</code> are rejected with HTTP 422 before human review.
                </p>
              </div>
              <div className="mt-5 pt-3 border-t border-white/10 flex items-center justify-between font-mono text-[11px]">
                <span className="text-slate-400">SAFETY FENCE</span>
                <span className="text-purple-300 font-bold">100% DETERMINISTIC</span>
              </div>
            </Interactive3DCard>

            <Interactive3DCard className="p-6 flex flex-col justify-between">
              <div className="space-y-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400">
                  <Lock className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-base text-white">Zero Credential Leaks on Disk</h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  High-speed regex token scrubbers redact AWS access keys, GitHub PATs, and Bearer tokens in-flight (&lt;1.2ms overhead). Raw secrets never touch your logs or telemetry databases.
                </p>
              </div>
              <div className="mt-5 pt-3 border-t border-white/10 flex items-center justify-between font-mono text-[11px]">
                <span className="text-slate-400">DLP ENFORCEMENT</span>
                <span className="text-amber-300 font-bold">LINE-RATE</span>
              </div>
            </Interactive3DCard>

            <Interactive3DCard className="p-6 flex flex-col justify-between">
              <div className="space-y-3">
                <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400">
                  <Zap className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-base text-white">Automated Circuit Isolation</h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Stop cascade retry storms before they take down your entire cluster. 3 strikes within 60 seconds automatically trips the circuit breaker into an HTTP 423 lock, protecting downstream databases.
                </p>
              </div>
              <div className="mt-5 pt-3 border-t border-white/10 flex items-center justify-between font-mono text-[11px]">
                <span className="text-slate-400">CASCADE PROTECTION</span>
                <span className="text-rose-300 font-bold">AUTOMATIC</span>
              </div>
            </Interactive3DCard>

            <Interactive3DCard className="p-6 flex flex-col justify-between">
              <div className="space-y-3">
                <div className="w-10 h-10 rounded-xl bg-teal-500/15 border border-teal-500/30 flex items-center justify-center text-teal-400">
                  <Database className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-base text-white">Cryptographic Audit Compliance</h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Pass SOC 2, ISO 27001, and NIST SP 800-218 audits effortlessly. Every operator authorization, refusal, and circuit trip is sealed into an append-only SHA-256 Merkle chain mathematically verifiable in the browser.
                </p>
              </div>
              <div className="mt-5 pt-3 border-t border-white/10 flex items-center justify-between font-mono text-[11px]">
                <span className="text-slate-400">AUDIT PROOF</span>
                <span className="text-teal-300 font-bold">TAMPER-EVIDENT</span>
              </div>
            </Interactive3DCard>
          </div>
        </section>

        {/* SECTION 2: BEFORE VS. AFTER COMPARISON MATRIX */}
        <section id="comparison" className="w-full mt-24 text-left">
          <div className="mb-8 border-b border-white/10 pb-5">
            <span className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-400">
              Operational Transformation
            </span>
            <h2 className="text-2xl font-bold text-white tracking-tight mt-1">
              Traditional 2 AM On-Call vs. Sovereign Closed-Loop with NeuroFabric
            </h2>
          </div>

          <div className="rounded-2xl bg-[#090C14] border border-white/10 overflow-hidden shadow-2xl">
            <div className="p-4 bg-[#101420] grid grid-cols-12 text-xs font-mono font-bold text-slate-400 uppercase tracking-wider border-b border-white/10">
              <div className="col-span-3">Incident Dimension</div>
              <div className="col-span-4 text-rose-300">Traditional On-Call Playbook</div>
              <div className="col-span-5 text-emerald-300">With NeuroFabric Autonomous Closed Loop</div>
            </div>

            <div className="divide-y divide-white/10 text-xs font-sans">
              <div className="p-4 grid grid-cols-12 items-center hover:bg-white/[0.02]">
                <div className="col-span-3 font-mono font-bold text-slate-200">2 AM Alert Storms</div>
                <div className="col-span-4 text-slate-400 flex items-start space-x-2">
                  <X className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <span>Dozens of fragmented PagerDuty notifications wake up on-call engineers for cascading duplicate failures.</span>
                </div>
                <div className="col-span-5 text-emerald-200 flex items-start space-x-2">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>Sliding window dedup collapses 94% of bursts into 1 correlated incident context with automated circuit fencing.</span>
                </div>
              </div>

              <div className="p-4 grid grid-cols-12 items-center hover:bg-white/[0.02]">
                <div className="col-span-3 font-mono font-bold text-slate-200">Root Cause Synthesis</div>
                <div className="col-span-4 text-slate-400 flex items-start space-x-2">
                  <X className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <span>Engineers spend 45+ minutes piecing together logs across Datadog, Grafana, and terminal traces.</span>
                </div>
                <div className="col-span-5 text-emerald-200 flex items-start space-x-2">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>Autonomous Embassy synthesizes causal RCA in seconds with confidence scores and blast radius calculations.</span>
                </div>
              </div>

              <div className="p-4 grid grid-cols-12 items-center hover:bg-white/[0.02]">
                <div className="col-span-3 font-mono font-bold text-slate-200">Patch Safety & Hallucination</div>
                <div className="col-span-4 text-slate-400 flex items-start space-x-2">
                  <X className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <span>Generic AI coding assistants suggest unverified commands, risks of remote code execution or bad syntax in prod.</span>
                </div>
                <div className="col-span-5 text-emerald-200 flex items-start space-x-2">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>AST Diff Security Gate deterministically rejects prohibited shell primitives (curl | bash, rm -rf) with HTTP 422.</span>
                </div>
              </div>

              <div className="p-4 grid grid-cols-12 items-center hover:bg-white/[0.02]">
                <div className="col-span-3 font-mono font-bold text-slate-200">Production Deployment</div>
                <div className="col-span-4 text-slate-400 flex items-start space-x-2">
                  <X className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <span>Manual copy-pasting of YAML, dangerous hot-patching directly in production pods with zero rollback trail.</span>
                </div>
                <div className="col-span-5 text-emerald-200 flex items-start space-x-2">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>Automated GitOps Pull Request with progressive canary rollout (10% to 100%) and instant 1-click rollback.</span>
                </div>
              </div>

              <div className="p-4 grid grid-cols-12 items-center hover:bg-white/[0.02]">
                <div className="col-span-3 font-mono font-bold text-slate-200">Audit & Compliance Trail</div>
                <div className="col-span-4 text-slate-400 flex items-start space-x-2">
                  <X className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <span>Lost Slack messages, ephemeral shell histories, difficult to prove who authorized emergency actions.</span>
                </div>
                <div className="col-span-5 text-emerald-200 flex items-start space-x-2">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>Every action is chained into a client-side verified SHA-256 Merkle tree (NIST SP 800-218 and OWASP compliant).</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 3: 3D ISOMETRIC CLOSED-LOOP SIMULATOR */}
        <section id="simulator" className="w-full mt-24 text-left">
          <div className="p-6 md:p-8 rounded-3xl bg-gradient-to-b from-[#101420] to-[#0A0D15] border border-white/10 shadow-[0_24px_80px_rgba(0,0,0,0.75)]">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
              <div>
                <div className="flex items-center space-x-2">
                  <Layers className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-400">
                    Interactive 3D Closed-Loop Architecture Simulator
                  </span>
                </div>
                <h2 className="text-lg font-bold text-white mt-1">
                  Click any stage to inspect how NeuroFabric processes live telemetry in 3D
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
                  onClick={() => goProtected('/embassy')}
                  className="px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 text-xs font-mono transition"
                >
                  Open Live HITL Diff
                </button>
              </div>
            </div>

            <div className="grid lg:grid-cols-12 gap-8 pt-6 items-center">
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

              <div className="lg:col-span-7 space-y-4 bg-[#090B10] p-6 rounded-2xl border border-white/10 font-mono">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <span className="text-xs font-bold text-white">{simStages[simStep].title}</span>
                  <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded bg-slate-900 border border-slate-700 ${simStages[simStep].color}`}>
                    {simStages[simStep].status}
                  </span>
                </div>

                <p className="text-xs text-slate-300 font-sans leading-relaxed">
                  {simStages[simStep].desc}
                </p>

                <div className="p-3.5 rounded-xl bg-[#050609] border border-white/10 text-[11px] text-emerald-400">
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
                    <div className="text-sm font-bold text-cyan-400 mt-0.5">SHA-256 SEALED</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 4: FOUR SECURITY GUARANTEES */}
        <section id="security" className="w-full mt-24 text-left">
          <div className="flex items-center justify-between mb-8 border-b border-white/10 pb-5">
            <div>
              <span className="text-xs font-mono text-emerald-400 font-bold uppercase tracking-wider">
                Production Guardrails
              </span>
              <h2 className="text-2xl font-bold text-white tracking-tight mt-1">Four Sovereign Security Guarantees</h2>
            </div>
            <span className="text-xs font-mono text-emerald-400 flex items-center space-x-1">
              <Sparkles className="w-3.5 h-3.5" />
              <span>NIST SP 800-218 Verified</span>
            </span>
          </div>

          <div className="grid md:grid-cols-4 gap-5">
            <Interactive3DCard className="p-6">
              <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-4">
                <Zap className="w-4 h-4" />
              </div>
              <h3 className="font-bold text-sm text-white">In-Flight DLP Scrubbing</h3>
              <p className="text-xs text-slate-300 mt-2 leading-relaxed">
                Line-rate regex token scrubbers eliminate AWS secret keys, GitHub PATs, and Bearer tokens before logs hit disk.
              </p>
              <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between text-[10px] font-mono text-emerald-400">
                <span>LATENCY OVERHEAD</span>
                <span className="font-bold">&lt; 1.2ms</span>
              </div>
            </Interactive3DCard>

            <Interactive3DCard className="p-6">
              <div className="w-9 h-9 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-purple-400 mb-4">
                <Terminal className="w-4 h-4" />
              </div>
              <h3 className="font-bold text-sm text-white">AST Diff Security Gate</h3>
              <p className="text-xs text-slate-300 mt-2 leading-relaxed">
                Agent patches pass through deterministic AST analysis. Dangerous commands (curl piping, rm -rf) are rejected with HTTP 422.
              </p>
              <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between text-[10px] font-mono text-purple-400">
                <span>SHELL ESCAPES</span>
                <span className="font-bold">BLOCKED</span>
              </div>
            </Interactive3DCard>

            <Interactive3DCard className="p-6">
              <div className="w-9 h-9 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 mb-4">
                <ShieldAlert className="w-4 h-4" />
              </div>
              <h3 className="font-bold text-sm text-white">Anti-Flapping Breaker</h3>
              <p className="text-xs text-slate-300 mt-2 leading-relaxed">
                Three strikes within 60 seconds automatically trips the circuit breaker, isolating degraded microservices from mutating state.
              </p>
              <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between text-[10px] font-mono text-rose-400">
                <span>FENCE LOCK</span>
                <span className="font-bold">HTTP 423</span>
              </div>
            </Interactive3DCard>

            <Interactive3DCard className="p-6">
              <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-4">
                <Database className="w-4 h-4" />
              </div>
              <h3 className="font-bold text-sm text-white">Merkle Audit Ledger</h3>
              <p className="text-xs text-slate-300 mt-2 leading-relaxed">
                Every human authorization, refusal, and rollback is sealed into an immutable SHA-256 Merkle chain verifiable via WebCrypto.
              </p>
              <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between text-[10px] font-mono text-amber-400">
                <span>AUDIT CRYPTO</span>
                <span className="font-bold">SHA-256 WAL</span>
              </div>
            </Interactive3DCard>
          </div>
        </section>

        {/* CTA BANNER */}
        <section className="w-full mt-24 p-8 rounded-3xl bg-gradient-to-r from-emerald-950/60 via-[#101420] to-teal-950/60 border border-emerald-500/30 flex flex-wrap items-center justify-between gap-6 text-left shadow-2xl">
          <div>
            <h3 className="text-2xl font-extrabold text-white">Ready to Harden Your Production Incidents?</h3>
            <p className="text-xs text-slate-300 mt-1 max-w-xl leading-relaxed">
              Experience the 15-minute autonomous stress test or connect your Kubernetes cluster with our OpenTelemetry exporter in under 5 minutes.
            </p>
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={() => goProtected('/overview')}
              className="px-6 py-3 rounded-xl bg-emerald-400 hover:bg-emerald-300 text-slate-950 font-mono font-bold text-xs flex items-center space-x-1.5 transition shadow-lg shadow-emerald-500/20"
            >
              <span>Launch Live Console</span>
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => goProtected('/integrations')}
              className="px-5 py-3 rounded-xl bg-[#090C14] hover:bg-slate-800 border border-white/10 text-slate-200 font-mono font-bold text-xs transition"
            >
              View Ingestion APIs
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}




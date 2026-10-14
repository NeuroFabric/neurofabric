import { useNavigate } from 'react-router-dom';
import { Logo } from '../components/common/Logo';
import { ArrowLeft, Lock, FileText } from 'lucide-react';

export function PrivacyPolicyPage() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-[#050609] text-slate-200 p-8 font-sans">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between border-b border-white/10 pb-5">
          <Logo size="md" />
          <button
            onClick={() => navigate('/')}
            className="px-4 py-2 rounded-xl bg-[#101420] border border-white/10 text-xs font-mono text-emerald-400 flex items-center space-x-1.5 hover:border-emerald-400/50"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Portal</span>
          </button>
        </div>

        <div className="p-8 rounded-3xl nf-card space-y-6">
          <div className="flex items-center space-x-2 text-emerald-400 font-mono text-xs font-bold uppercase">
            <Lock className="w-4 h-4" />
            <span>Zero-Trust Data Privacy &amp; Sovereign Telemetry Policy</span>
          </div>
          <h1 className="text-3xl font-extrabold text-white">Privacy Policy</h1>
          <p className="text-xs text-slate-400 font-mono">Effective Date: October 14, 2026 • Compliance: GDPR, SOC 2 Type II, DPDP Act &amp; NIST SP 800-218</p>

          <div className="space-y-4 text-sm text-slate-300 leading-relaxed">
            <h2 className="text-base font-bold text-white">1. In-Flight Data Loss Prevention (Zero Raw Secret Storage)</h2>
            <p>
              NeuroFabric intercepts edge telemetry streams using deterministic line-rate regular expression and token scrubbers. Bearer tokens, AWS access keys, GitHub Personal Access Tokens, and PII are redacted in-flight into <code className="text-emerald-400">[DLP:REDACTED_SECRET]</code> prior to Write-Ahead Log (WAL) persistence.
            </p>

            <h2 className="text-base font-bold text-white">2. Zero Sensitive Browser Storage</h2>
            <p>
              NeuroFabric strictly prohibits storing authentication tokens, session secrets, or GitHub Personal Access Tokens in browser <code className="text-rose-400">localStorage</code> or unencrypted cookies. All operator credentials reside exclusively in volatile memory and are cryptographically purged upon session termination.
            </p>

            <h2 className="text-base font-bold text-white">3. Row-Level Security (RLS) &amp; Tenant Isolation</h2>
            <p>
              Every telemetry frame, GitOps patch proposal, and SHA-256 Merkle leaf is strictly partitioned by <code className="text-cyan-300">tenant_id</code> using parameterized SQL queries.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TermsPage() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-[#050609] text-slate-200 p-8 font-sans">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between border-b border-white/10 pb-5">
          <Logo size="md" />
          <button
            onClick={() => navigate('/')}
            className="px-4 py-2 rounded-xl bg-[#101420] border border-white/10 text-xs font-mono text-emerald-400 flex items-center space-x-1.5 hover:border-emerald-400/50"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Portal</span>
          </button>
        </div>

        <div className="p-8 rounded-3xl nf-card space-y-6">
          <div className="flex items-center space-x-2 text-emerald-400 font-mono text-xs font-bold uppercase">
            <FileText className="w-4 h-4" />
            <span>Enterprise Service Level &amp; Sovereign Governance Terms</span>
          </div>
          <h1 className="text-3xl font-extrabold text-white">Terms &amp; Conditions</h1>
          <p className="text-xs text-slate-400 font-mono">Last Updated: October 14, 2026 • Sovereign Enterprise Edition v3.1</p>

          <div className="space-y-4 text-sm text-slate-300 leading-relaxed">
            <h2 className="text-base font-bold text-white">1. Human-in-the-Loop (HITL) Authorization Requirement</h2>
            <p>
              Autonomous agents operating within the NeuroFabric Embassy are restricted to read-only <code className="text-emerald-400">workspace/</code> synthesis. No production GitOps pull request may be merged without deterministic AST Security Gate verification (<code className="text-emerald-400">PASS</code>) and explicit Level 3–5 operator authorization.
            </p>

            <h2 className="text-base font-bold text-white">2. Fail-Closed Security Guarantees</h2>
            <p>
              Any patch containing prohibited shell primitives (<code className="text-rose-400">curl | bash</code>, <code className="text-rose-400">rm -rf</code>, <code className="text-rose-400">eval</code>) fails closed with <code className="text-rose-400">HTTP 422 Unprocessable Entity</code>. Flapping microservices exceeding 3 timeout strikes in 60 seconds automatically lock with <code className="text-amber-400">HTTP 423 Locked</code>.
            </p>

            <h2 className="text-base font-bold text-white">3. Cryptographic Auditability</h2>
            <p>
              All operator approvals, refusals, and rollbacks are permanently chained into an append-only SHA-256 Merkle tree.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}


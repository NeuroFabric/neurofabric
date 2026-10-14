import { useNavigate, Link } from 'react-router-dom';
import { Logo } from '../components/common/Logo';
import { ArrowLeft, Lock, FileText, RotateCcw, Cookie, Building2 } from 'lucide-react';

function CorporateFooterBlock() {
  return (
    <div className="p-6 rounded-2xl bg-[#090C14] border border-white/10 font-mono text-xs space-y-2 text-slate-300">
      <div className="flex items-center space-x-2 text-emerald-400 font-bold uppercase">
        <Building2 className="w-4 h-4" />
        <span>Registered Corporate &amp; Statutory Grievance Details (India DPDP Act &amp; IT Rules)</span>
      </div>
      <div className="grid md:grid-cols-2 gap-2 text-[11px] font-sans">
        <div>
          <strong>Legal Entity:</strong> NeuroFabric Sovereign Systems Pvt. Ltd.
        </div>
        <div>
          <strong>Registered Office:</strong> Khanpur, New Delhi, Delhi 110062, India
        </div>
        <div>
          <strong>Data Protection &amp; Grievance Officer:</strong> Rishabh Sharma (dpo@neurofabric.io)
        </div>
        <div>
          <strong>Statutory Jurisdiction:</strong> Courts of New Delhi, India (IT Act 2000 &amp; DPDP Act 2023)
        </div>
      </div>
      <div className="flex flex-wrap gap-4 pt-2 border-t border-white/10 text-[11px] font-mono text-emerald-400">
        <Link to="/privacy" className="hover:underline">Privacy Policy</Link>
        <Link to="/terms" className="hover:underline">Terms &amp; Conditions</Link>
        <Link to="/refund" className="hover:underline">Refund &amp; Cancellation Policy</Link>
        <Link to="/cookies" className="hover:underline">Cookies Policy</Link>
      </div>
    </div>
  );
}

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
          <p className="text-xs text-slate-300 font-mono">
            Effective Date: October 14, 2026 • Compliance: India DPDP Act 2023 / Rules 2025 (G.S.R. 846(E)), CERT-In Sec 70B &amp; GDPR
          </p>

          <div className="space-y-4 text-sm text-slate-200 leading-relaxed">
            <h2 className="text-base font-bold text-white">1. Data Minimization (Only Necessary Data Collected)</h2>
            <p>
              NeuroFabric collects strictly the minimum data required to authenticate operators (Full Name, Corporate Email, and PBKDF2-HMAC-SHA256 password digest) and maintain per-user Row-Level Security (owner_user_id and tenant_id). We do not collect consumer behavioral profiles, location tracking, or advertising identifiers.
            </p>

            <h2 className="text-base font-bold text-white">2. In-Flight DLP Scrubbing</h2>
            <p>
              Incoming telemetry logs are screened in-flight using deterministic regular expression scrubbers to redact Aadhaar numbers, PAN, GSTIN, UPI handles, mobile numbers, and API Bearer tokens into [DLP:REDACTED_*] tags prior to storage.
            </p>

            <h2 className="text-base font-bold text-white">3. Data Principal Rights &amp; Grievance Redressal</h2>
            <p>
              Under Section 11–14 of the Digital Personal Data Protection Act, 2023 (India), operators may request access, correction, or erasure of their account profile by contacting dpo@neurofabric.io.
            </p>
          </div>

          <CorporateFooterBlock />
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
          <p className="text-xs text-slate-300 font-mono">Last Updated: October 14, 2026 • Sovereign Enterprise Edition v3.3</p>

          <div className="space-y-4 text-sm text-slate-200 leading-relaxed">
            <h2 className="text-base font-bold text-white">1. Mandatory Human-in-the-Loop (HITL) Governance</h2>
            <p>
              Autonomous agents operating within the NeuroFabric Embassy are restricted to read-only workspace/ synthesis. No production GitOps pull request is merged without AST Security Gate screening and explicit operator confirmation.
            </p>

            <h2 className="text-base font-bold text-white">2. API Rate Limits &amp; Cost Guardrails</h2>
            <p>
              To protect cluster stability and compute budgets, standard API routes are capped at 60 requests/minute, authentication routes at 10 requests/minute, and AI patch synthesis routes at 5 requests/minute per operator.
            </p>
          </div>

          <CorporateFooterBlock />
        </div>
      </div>
    </div>
  );
}

export function RefundPolicyPage() {
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
            <RotateCcw className="w-4 h-4" />
            <span>Enterprise Subscription Cancellation &amp; Refund Policy</span>
          </div>
          <h1 className="text-3xl font-extrabold text-white">Refund &amp; Cancellation Policy</h1>
          <p className="text-xs text-slate-300 font-mono">
            Effective Date: October 14, 2026 • Compliant with Consumer Protection (E-Commerce) Rules &amp; RBI Guidelines
          </p>

          <div className="space-y-4 text-sm text-slate-200 leading-relaxed">
            <h2 className="text-base font-bold text-white">1. 14-Day Full Refund Guarantee</h2>
            <p>
              Enterprise and team subscriptions cancelled within 14 calendar days of initial provisioning qualify for a 100% refund of subscription fees, credited back to the original payment instrument within 5–7 business days.
            </p>

            <h2 className="text-base font-bold text-white">2. Pro-Rated Mid-Cycle Cancellation &amp; SLA Credits</h2>
            <p>
              Subscriptions may be cancelled at any time without penalty. Unused full billing months on annual contracts are refunded on a pro-rata basis.
            </p>
          </div>

          <CorporateFooterBlock />
        </div>
      </div>
    </div>
  );
}

export function CookiesPolicyPage() {
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
            <Cookie className="w-4 h-4" />
            <span>Strictly Necessary Session Cookie &amp; Zero-Tracking Policy</span>
          </div>
          <h1 className="text-3xl font-extrabold text-white">Cookies Policy</h1>
          <p className="text-xs text-slate-300 font-mono">Effective Date: October 14, 2026 • Zero Third-Party Advertising Cookies</p>

          <div className="space-y-4 text-sm text-slate-200 leading-relaxed">
            <h2 className="text-base font-bold text-white">1. Strictly Necessary Security Cookies Only</h2>
            <p>
              NeuroFabric uses a single strictly necessary HttpOnly; Secure; SameSite=Strict session cookie (nf_session) when connected to the backend API. We never load third-party advertising pixels, cross-site trackers, or behavioral analytics embeds.
            </p>

            <h2 className="text-base font-bold text-white">2. Clearing &amp; Revoking Consent</h2>
            <p>
              Operators can clear their session and revoke cookie consent at any time using the Lock Session &amp; Sign Out button in the top-right profile menu or the bottom-right Cookie Preferences button.
            </p>
          </div>

          <CorporateFooterBlock />
        </div>
      </div>
    </div>
  );
}

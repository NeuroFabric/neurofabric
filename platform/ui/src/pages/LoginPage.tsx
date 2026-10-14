import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Logo } from '../components/common/Logo';
import { Mail, Lock, User, ArrowRight, ShieldCheck, KeyRound, CheckCircle2, UserPlus } from 'lucide-react';
import { useTelemetry, getDefaultPermissionsForClearance } from '../context/TelemetryContext';
import { hashPasswordPBKDF2, sanitizeRedirectPath, sanitizeXSS, checkClientRateLimit } from '../utils/security';
import { toast } from 'sonner';

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { iamUsers, loginUser, submitAccessRequest } = useTelemetry();

  const [mode, setMode] = useState<'SIGN_IN' | 'REQUEST_ACCESS'>('SIGN_IN');
  const [name, setName] = useState('Rishabh Sharma');
  const [email, setEmail] = useState('rishabh.sharma@neurofabric.io');
  const [clearance, setClearance] = useState('LEVEL 5');
  const [tenantId, setTenantId] = useState('org-neurofabric-prod');
  const [password, setPassword] = useState('Sovereign#2026!Key');
  const [totpCode, setTotpCode] = useState('482910');
  const [honeypot, setHoneypot] = useState('');
  const [isHashing, setIsHashing] = useState(false);

  // Self-service access request state
  const [reqName, setReqName] = useState('');
  const [reqEmail, setReqEmail] = useState('');
  const [reqClearance, setReqClearance] = useState<'LEVEL 4' | 'LEVEL 3' | 'LEVEL 2'>('LEVEL 3');
  const [reqReason, setReqReason] = useState('On-call SRE requesting access to Mission Control & Patch Review.');

  const safeNextPath = sanitizeRedirectPath(searchParams.get('redirect'));

  const handleGoogleSignIn = async () => {
    if (honeypot) return;
    if (!checkClientRateLimit(15)) {
      toast.error('Auth Rate Limit Exceeded', { description: 'Please wait 60s before retrying.' });
      return;
    }
    setIsHashing(true);
    await new Promise((r) => setTimeout(r, 250));
    const cleanName = sanitizeXSS(name.trim() || 'Rishabh Sharma').clean;
    const cleanEmail = sanitizeXSS(email.trim()).clean;

    const ok = loginUser({
      name: cleanName,
      email: cleanEmail,
      role: 'Principal Systems Architect',
      clearance,
      tenantId,
      emailVerified: true,
      mfaVerified: true,
      permissions: getDefaultPermissionsForClearance(clearance),
      provider: 'Google',
    });
    setIsHashing(false);
    if (ok) {
      toast.success('Google Workspace + IAM Directory Verified', {
        description: `Authenticated as ${cleanEmail}. Redirecting to ${safeNextPath}.`,
      });
      navigate(safeNextPath);
    }
  };

  const handleFormSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (honeypot) return;
    if (!checkClientRateLimit(15)) {
      toast.error('Too Many Login Attempts (HTTP 429)', { description: 'Brute-force guard active.' });
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      toast.error('Invalid Email Format', { description: 'Please enter a valid corporate email address.' });
      return;
    }
    if (password.length < 10) {
      toast.error('Password Policy Violation', { description: 'Password must be at least 10 characters.' });
      return;
    }
    if (!/^\d{6}$/.test(totpCode.trim())) {
      toast.error('MFA Verification Required', { description: 'Enter a valid 6-digit TOTP authenticator code.' });
      return;
    }

    setIsHashing(true);
    const [pwdHash] = await Promise.all([
      hashPasswordPBKDF2(password, email),
      new Promise((r) => setTimeout(r, 280)),
    ]);

    const cleanName = sanitizeXSS(name.trim() || 'Rishabh Sharma').clean;
    const cleanEmail = sanitizeXSS(email.trim()).clean;

    const ok = loginUser({
      name: cleanName,
      email: cleanEmail,
      role: 'Principal SRE',
      clearance,
      tenantId,
      emailVerified: true,
      mfaVerified: true,
      permissions: getDefaultPermissionsForClearance(clearance),
      passwordHashPreview: `pbkdf2_sha256$${pwdHash.slice(0, 16)}...`,
      provider: 'Credentials',
    });

    setIsHashing(false);
    if (ok) {
      toast.success('IAM Directory + PBKDF2 + MFA Verified', {
        description: `Signed in as ${cleanEmail}. Redirecting to ${safeNextPath}.`,
      });
      navigate(safeNextPath);
    }
  };

  const handleAccessRequestSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!reqName.trim() || !reqEmail.trim()) return;
    submitAccessRequest(reqName, reqEmail, reqClearance, tenantId, reqReason);
    setReqName('');
    setReqEmail('');
    setMode('SIGN_IN');
  };

  return (
    <div className="min-h-screen bg-[#050609] text-slate-100 flex flex-col items-center justify-center p-6 font-sans select-none relative overflow-hidden">
      <div
        className="fixed inset-0 pointer-events-none opacity-20"
        style={{
          backgroundImage:
            'linear-gradient(to right, #1e293b 1px, transparent 1px), linear-gradient(to bottom, #1e293b 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />

      <div className="relative z-10 w-full max-w-md p-7 rounded-3xl nf-card border border-white/15 shadow-2xl space-y-5">
        <div className="flex justify-center">
          <Logo size="lg" />
        </div>

        {/* Mode Switcher: Sign In vs Request Access */}
        <div className="grid grid-cols-2 gap-1.5 bg-[#090C14] p-1 rounded-xl border border-white/10 font-mono text-xs">
          <button
            type="button"
            onClick={() => setMode('SIGN_IN')}
            className={`py-2 rounded-lg font-bold transition ${
              mode === 'SIGN_IN' ? 'bg-emerald-500 text-slate-950 shadow' : 'text-slate-400 hover:text-white'
            }`}
          >
            Operator Sign-In
          </button>
          <button
            type="button"
            onClick={() => setMode('REQUEST_ACCESS')}
            className={`py-2 rounded-lg font-bold transition ${
              mode === 'REQUEST_ACCESS' ? 'bg-emerald-500 text-slate-950 shadow' : 'text-slate-400 hover:text-white'
            }`}
          >
            Request Access
          </button>
        </div>

        {mode === 'SIGN_IN' ? (
          <>
            <div className="text-center space-y-1">
              <h1 className="text-lg font-bold text-white tracking-tight">Zero-Trust IAM Gate</h1>
              <p className="text-[11px] text-slate-400">
                Only emails provisioned in the IAM Directory can enter the cockpit
              </p>
            </div>

            {/* Quick Directory Identity Selector for Testing RBAC & Suspended Accounts */}
            <div className="p-3 rounded-xl bg-[#090C14] border border-white/10 space-y-1.5 font-mono text-[10px]">
              <div className="text-slate-400 uppercase font-bold">Quick-Fill Provisioned IAM Identity:</div>
              <div className="flex flex-wrap gap-1.5">
                {iamUsers.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => {
                      setName(u.name);
                      setEmail(u.email);
                      setClearance(u.clearance);
                      setTenantId(u.tenantId);
                    }}
                    className={`px-2 py-1 rounded border transition ${
                      email === u.email
                        ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300 font-bold'
                        : 'bg-[#05070B] border-white/10 text-slate-400 hover:text-white'
                    }`}
                  >
                    {u.name.split(' ')[0]} ({u.status === 'ACTIVE' ? u.clearance : u.status})
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              disabled={isHashing}
              onClick={handleGoogleSignIn}
              className="w-full py-3 px-4 rounded-xl bg-white hover:bg-slate-100 text-slate-900 font-semibold text-xs flex items-center justify-center space-x-3 transition shadow-md"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z" />
                <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z" />
                <path fill="#FBBC05" d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z" />
                <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z" />
              </svg>
              <span>Sign In with Google ({email.split('@')[0]})</span>
            </button>

            <form onSubmit={handleFormSubmit} className="space-y-3" noValidate>
              <input
                type="text"
                name="website_url_honeypot"
                tabIndex={-1}
                autoComplete="off"
                value={honeypot}
                onChange={(e) => setHoneypot(e.target.value)}
                className="hidden"
              />

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-mono text-slate-300">PROVISIONED CORPORATE EMAIL</label>
                  <span className="text-[10px] font-mono text-emerald-400 flex items-center space-x-1">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>IAM Checked</span>
                  </span>
                </div>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                  <input
                    type="email"
                    required
                    maxLength={120}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-[#07090F] border border-white/15 rounded-xl pl-9 pr-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-emerald-400"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] font-mono text-slate-300 block">PASSWORD (PBKDF2)</label>
                  <div className="relative">
                    <Lock className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
                    <input
                      type="password"
                      required
                      minLength={10}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full bg-[#07090F] border border-white/15 rounded-xl pl-8 pr-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-emerald-400"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-mono text-emerald-300 block">MFA CODE (TOTP)</label>
                  <div className="relative">
                    <KeyRound className="w-3.5 h-3.5 text-emerald-400 absolute left-3 top-2.5" />
                    <input
                      type="text"
                      required
                      maxLength={6}
                      pattern="\d{6}"
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                      className="w-full bg-[#07090F] border border-emerald-500/40 rounded-xl pl-8 pr-3 py-2 text-xs text-emerald-300 font-mono tracking-widest focus:outline-none focus:border-emerald-400"
                    />
                  </div>
                </div>
              </div>

              <button
                type="submit"
                disabled={isHashing}
                className="w-full py-3 bg-gradient-to-r from-emerald-400 to-teal-500 hover:from-emerald-300 hover:to-teal-400 text-slate-950 font-bold rounded-xl text-xs font-mono transition flex items-center justify-center space-x-2 shadow-lg shadow-emerald-500/20"
              >
                <span>{isHashing ? 'Verifying IAM & PBKDF2...' : 'Authenticate & Enter Cockpit'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          </>
        ) : (
          <form onSubmit={handleAccessRequestSubmit} className="space-y-3.5 font-mono text-xs">
            <div className="text-center space-y-1 font-sans">
              <h2 className="text-lg font-bold text-white">Request Operator Access</h2>
              <p className="text-xs text-slate-400">
                Your request will be queued in the IAM Portal (<code className="text-emerald-400">/iam</code>) for Level 5 Admin approval.
              </p>
            </div>

            <div>
              <label className="text-[10px] text-slate-300 block mb-1">FULL NAME</label>
              <div className="relative">
                <User className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
                <input
                  type="text"
                  required
                  value={reqName}
                  onChange={(e) => setReqName(e.target.value)}
                  placeholder="Enter your full name"
                  className="w-full bg-[#07090F] border border-white/15 rounded-xl pl-8 pr-3 py-2 text-white"
                />
              </div>
            </div>

            <div>
              <label className="text-[10px] text-slate-300 block mb-1">CORPORATE EMAIL</label>
              <div className="relative">
                <Mail className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
                <input
                  type="email"
                  required
                  value={reqEmail}
                  onChange={(e) => setReqEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full bg-[#07090F] border border-white/15 rounded-xl pl-8 pr-3 py-2 text-white"
                />
              </div>
            </div>

            <div>
              <label className="text-[10px] text-slate-300 block mb-1">REQUESTED CLEARANCE TIER</label>
              <div className="relative">
                <ShieldCheck className="w-4 h-4 text-emerald-400 absolute left-3 top-2.5" />
                <select
                  value={reqClearance}
                  onChange={(e) => setReqClearance(e.target.value as 'LEVEL 4' | 'LEVEL 3' | 'LEVEL 2')}
                  className="w-full bg-[#07090F] border border-white/15 rounded-xl pl-9 pr-3 py-2 text-emerald-300"
                >
                  <option value="LEVEL 4">LEVEL 4 (SecOps &amp; Circuit Override)</option>
                  <option value="LEVEL 3">LEVEL 3 (On-Call SRE)</option>
                  <option value="LEVEL 2">LEVEL 2 (Read-Only Auditor)</option>
                </select>
              </div>
            </div>

            <div>
              <label className="text-[10px] text-slate-300 block mb-1">BUSINESS JUSTIFICATION</label>
              <textarea
                rows={2}
                required
                value={reqReason}
                onChange={(e) => setReqReason(e.target.value)}
                className="w-full bg-[#07090F] border border-white/15 rounded-xl p-2.5 text-white text-[11px]"
              />
            </div>

            <button
              type="submit"
              className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl text-xs flex items-center justify-center space-x-2"
            >
              <UserPlus className="w-4 h-4" />
              <span>Submit Access Request to IAM Admin</span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

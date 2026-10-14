import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Logo } from '../components/common/Logo';
import { Mail, Lock, User, ArrowRight, ShieldCheck } from 'lucide-react';
import { useTelemetry } from '../context/TelemetryContext';
import { toast } from 'sonner';

export function LoginPage() {
  const navigate = useNavigate();
  const { user, loginUser } = useTelemetry();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [clearance, setClearance] = useState(user.clearance);
  const [password, setPassword] = useState('••••••••••••••••');

  const handleGoogleSignIn = () => {
    const updated = {
      name: name.trim() || 'Rishabh Sharma',
      email: email.trim() || 'rishabh.sharma@google.com',
      role: 'Principal Systems Architect',
      clearance,
      provider: 'Google' as const,
    };
    loginUser(updated);
    toast.success('Google Workspace Authenticated', {
      description: `Signed in as ${updated.name} (${updated.email})`,
    });
    navigate('/overview');
  };

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    const updated = {
      name: name.trim() || 'Rishabh Sharma',
      email: email.trim() || 'operator@neurofabric.io',
      role: 'Principal SRE',
      clearance,
      provider: 'Credentials' as const,
    };
    loginUser(updated);
    toast.success('Operator Session Established', {
      description: `Authenticated as ${updated.name} [${updated.clearance}]`,
    });
    navigate('/overview');
  };

  return (
    <div className="min-h-screen bg-[#06070B] text-slate-100 flex flex-col items-center justify-center p-6 font-sans select-none relative overflow-hidden">
      <div
        className="fixed inset-0 pointer-events-none opacity-25"
        style={{
          backgroundImage:
            'linear-gradient(to right, #1e293b 1px, transparent 1px), linear-gradient(to bottom, #1e293b 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />

      <div className="relative z-10 w-full max-w-md p-8 rounded-3xl bg-[#0D111C] border border-white/15 shadow-[0_24px_80px_rgba(0,0,0,0.85)] space-y-6">
        <div className="flex justify-center">
          <Logo size="lg" />
        </div>

        <div className="text-center space-y-1">
          <h1 className="text-xl font-bold text-white tracking-tight">Sign in to NeuroFabric</h1>
          <p className="text-xs text-slate-400">
            Authenticate with Google Workspace SSO or your Operator ID
          </p>
        </div>

        {/* Official Google Sign-In Button */}
        <button
          type="button"
          onClick={handleGoogleSignIn}
          className="w-full py-3 px-4 rounded-xl bg-white hover:bg-slate-100 text-slate-900 font-semibold text-xs flex items-center justify-center space-x-3 transition shadow-md"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
            />
            <path
              fill="#34A853"
              d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z"
            />
            <path
              fill="#FBBC05"
              d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z"
            />
            <path
              fill="#EA4335"
              d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z"
            />
          </svg>
          <span>Continue with Google Workspace</span>
        </button>

        <div className="relative flex py-1 items-center">
          <div className="flex-grow border-t border-white/10" />
          <span className="flex-shrink mx-3 text-[10px] font-mono uppercase text-slate-500">
            or operator credentials
          </span>
          <div className="flex-grow border-t border-white/10" />
        </div>

        {/* Standard Operator Form */}
        <form onSubmit={handleFormSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[11px] font-mono text-slate-300 block">Operator Full Name</label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter your name"
                className="w-full bg-[#07090F] border border-white/15 rounded-xl pl-9 pr-4 py-2 text-xs text-white focus:outline-none focus:border-cyan-400"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-mono text-slate-300 block">Corporate / Google Email</label>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                className="w-full bg-[#07090F] border border-white/15 rounded-xl pl-9 pr-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[11px] font-mono text-slate-300 block">RBAC Clearance</label>
              <div className="relative">
                <ShieldCheck className="w-4 h-4 text-cyan-400 absolute left-3 top-2.5" />
                <select
                  value={clearance}
                  onChange={(e) => setClearance(e.target.value)}
                  className="w-full bg-[#07090F] border border-white/15 rounded-xl pl-9 pr-2 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400"
                >
                  <option value="LEVEL 5">LEVEL 5 (Admin)</option>
                  <option value="LEVEL 4">LEVEL 4 (SecOps)</option>
                  <option value="LEVEL 3">LEVEL 3 (SRE)</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-mono text-slate-300 block">Access Key / Pass</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-[#07090F] border border-white/15 rounded-xl pl-9 pr-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400"
                />
              </div>
            </div>
          </div>

          <button
            type="submit"
            className="w-full py-3 bg-gradient-to-r from-cyan-400 to-indigo-500 hover:from-cyan-300 hover:to-indigo-400 text-slate-950 font-bold rounded-xl text-xs font-mono transition flex items-center justify-center space-x-2 shadow-lg shadow-cyan-500/20 mt-2"
          >
            <span>Sign In to Cockpit</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
}

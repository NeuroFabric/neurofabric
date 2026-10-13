import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Logo } from '../components/common/Logo';
import { Shield, KeyRound, ArrowRight } from 'lucide-react';

export function LoginPage() {
  const navigate = useNavigate();
  const [selectedPersona, setSelectedPersona] = useState('alex');

  const personas = [
    { id: 'alex', name: 'Alex Vance', role: 'Principal SRE', level: 'LEVEL 5', color: 'text-cyan-400' },
    { id: 'elena', name: 'Elena Rostova', role: 'Staff SecOps Lead', level: 'LEVEL 4', color: 'text-emerald-400' },
    { id: 'marcus', name: 'Marcus Chen', role: 'On-Call Incident Responder', level: 'LEVEL 3', color: 'text-amber-400' },
  ];

  return (
    <div className="min-h-screen bg-[#07090e] text-slate-100 flex flex-col items-center justify-center p-6 font-sans select-none">
      <div className="w-full max-w-md p-8 rounded-2xl bg-[#0d121d] border border-slate-800 space-y-6">
        <div className="flex justify-center mb-2">
          <Logo size="lg" />
        </div>

        <div className="text-center">
          <h2 className="text-xl font-bold text-white tracking-tight">Operator Clearance Access</h2>
          <p className="text-xs text-slate-400 mt-1">Select an identity persona to establish RBAC gateway session.</p>
        </div>

        <div className="space-y-3">
          {personas.map(p => (
            <div
              key={p.id}
              onClick={() => setSelectedPersona(p.id)}
              className={`p-3.5 rounded-xl border cursor-pointer transition flex items-center justify-between ${
                selectedPersona === p.id
                  ? 'bg-cyan-950/40 border-cyan-500/60'
                  : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div>
                <div className="text-xs font-bold text-white flex items-center space-x-2">
                  <span>{p.name}</span>
                  <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded bg-slate-950 border border-slate-800 font-bold ${p.color}`}>
                    {p.level}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 mt-0.5">{p.role}</div>
              </div>
              <Shield className={`w-4 h-4 ${selectedPersona === p.id ? 'text-cyan-400' : 'text-slate-600'}`} />
            </div>
          ))}
        </div>

        <div className="relative">
          <KeyRound className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
          <input
            type="password"
            defaultValue="session-token-live-2026"
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-500"
          />
        </div>

        <button
          onClick={() => navigate('/overview')}
          className="w-full py-3 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold rounded-xl text-xs font-mono transition flex items-center justify-center space-x-2 shadow-lg shadow-cyan-500/20"
        >
          <span>Authenticate & Enter Console</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

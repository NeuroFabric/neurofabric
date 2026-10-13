import { useState } from 'react';
import { Send, LifeBuoy } from 'lucide-react';
import { toast } from 'sonner';

export function SupportPage() {
  const [ticketSubject, setTicketSubject] = useState('');
  const [ticketBody, setTicketBody] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticketSubject || !ticketBody) return;
    setSubmitted(true);
    toast.success('Incident Ticket Dispatched', {
      description: 'Routed to Tier-3 SRE On-Call with diagnostic telemetry snapshot.',
    });
    setTimeout(() => {
      setTicketSubject('');
      setTicketBody('');
      setSubmitted(false);
    }, 2000);
  };

  return (
    <div className="p-8 space-y-8 max-w-5xl font-sans">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Incident Desk & Customer Support</h1>
        <p className="text-xs text-slate-400 mt-1">Direct support channel for enterprise SLA guarantees and cluster diagnostics</p>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800 space-y-2">
          <div className="text-xs text-slate-400 font-medium">Enterprise SLA Tier</div>
          <div className="text-lg font-bold text-white font-mono">99.99% Platinum</div>
          <p className="text-xs text-slate-500">15-minute response time guarantee for Sev-1 breaker trips.</p>
        </div>

        <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800 space-y-2">
          <div className="text-xs text-slate-400 font-medium">Dedicated Incident Commander</div>
          <div className="text-lg font-bold text-cyan-400 font-mono">Alex Vance</div>
          <p className="text-xs text-slate-500">On-call rotation active. Status: NOMINAL.</p>
        </div>

        <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800 space-y-2">
          <div className="text-xs text-slate-400 font-medium">Live Diagnostics Status</div>
          <div className="text-lg font-bold text-emerald-400 font-mono">Healthy (0 Tripped)</div>
          <p className="text-xs text-slate-500">All edge mesh nodes operating within SLA budget.</p>
        </div>
      </div>

      {/* Ticket Generator */}
      <div className="p-8 rounded-2xl bg-[#0d121d] border border-slate-800">
        <div className="flex items-center space-x-2 text-cyan-400 text-xs font-mono font-bold uppercase mb-4">
          <LifeBuoy className="w-4 h-4" />
          <span>Dispatch Priority Support Ticket</span>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Incident Subject</label>
            <input
              type="text"
              value={ticketSubject}
              onChange={(e) => setTicketSubject(e.target.value)}
              placeholder="e.g. Unexpected rate spike in billing-core"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Incident Description & Context</label>
            <textarea
              rows={4}
              value={ticketBody}
              onChange={(e) => setTicketBody(e.target.value)}
              placeholder="Provide service names, error messages, or affected endpoints..."
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono"
            />
          </div>

          <button
            type="submit"
            disabled={submitted}
            className="px-6 py-2.5 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-xs font-bold rounded-xl transition flex items-center space-x-2"
          >
            <Send className="w-3.5 h-3.5" />
            <span>{submitted ? 'Dispatching...' : 'Submit Priority Ticket'}</span>
          </button>
        </form>
      </div>
    </div>
  );
}

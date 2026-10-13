import { useState } from 'react';
import { useTelemetry } from '../context/TelemetryContext';

export function EmbassyPage() {
  const { trippedCircuits, authorizePR, declinePR, unlockCircuit } = useTelemetry();
  const [feedback, setFeedback] = useState<string | null>(null);

  const mockDiff = `--- deployment.yaml
+++ deployment.yaml
@@ -14,3 +14,3 @@
- replicas: 2
+ replicas: 5`;

  const handleAuthorize = async () => {
    try {
      await authorizePR(`task-${Date.now()}`, 'auth-gateway', mockDiff);
      setFeedback('Remediation PR authorized and dispatched to GitOps pipeline.');
      setTimeout(() => setFeedback(null), 4000);
    } catch (err: any) {
      setFeedback(`Authorization failed: ${err.message}`);
    }
  };

  const handleDecline = async () => {
    try {
      await declinePR(`task-${Date.now()}`, 'auth-gateway');
      setFeedback('Remediation PR declined by operator.');
      setTimeout(() => setFeedback(null), 4000);
    } catch (err: any) {
      setFeedback(`Failed: ${err.message}`);
    }
  };

  const handleUnlock = async (service: string) => {
    try {
      await unlockCircuit(service);
      setFeedback(`Circuit lock cleared for ${service}.`);
      setTimeout(() => setFeedback(null), 4000);
    } catch (err: any) {
      setFeedback(`Unlock failed: ${err.message}`);
    }
  };

  return (
    <div className="p-8 space-y-8 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Autonomous Embassy</h1>
        <p className="text-xs text-slate-400 mt-1">AST diff verification, GitOps patch execution, and sovereign circuit locks</p>
      </div>

      {feedback && (
        <div className="p-4 bg-cyan-950/80 border border-cyan-800 text-cyan-300 text-xs rounded-xl font-medium">
          {feedback}
        </div>
      )}

      {/* Sovereign Circuit Locks */}
      <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800">
        <div className="text-sm font-semibold text-white mb-2">Sovereign Circuit Breaker Posture</div>
        <p className="text-xs text-slate-400 mb-4">
          Services locked by repeated anomalies cannot mutate deployment states until unlocked by an operator.
        </p>

        {trippedCircuits.length > 0 ? (
          <div className="space-y-3">
            {trippedCircuits.map((svc) => (
              <div key={svc} className="p-4 bg-rose-950/30 border border-rose-800/80 rounded-xl flex items-center justify-between">
                <div>
                  <span className="text-rose-400 font-bold font-mono text-sm">{svc}</span>
                  <div className="text-xs text-slate-400 mt-0.5">Tripped due to 3+ critical anomaly strikes within 60s</div>
                </div>
                <button
                  onClick={() => handleUnlock(svc)}
                  className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-lg transition"
                >
                  Emergency Unlock Circuit
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-4 bg-emerald-950/20 border border-emerald-800/50 rounded-xl text-emerald-400 text-xs font-mono">
            ✓ All circuits nominal. Zero flapping services detected.
          </div>
        )}
      </div>

      {/* Active GitOps Remediation Proposal */}
      <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm font-semibold text-white">Active Proposal // AST Diff Verification</div>
            <div className="text-xs text-slate-400 mt-0.5">Target: auth-gateway/deployment.yaml | AST Gate: PASSED</div>
          </div>
          <span className="px-2.5 py-1 bg-cyan-950 text-cyan-400 border border-cyan-800 text-[10px] font-mono rounded-full font-bold">
            CONFIDENCE: 94%
          </span>
        </div>

        <pre className="p-4 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-slate-300 leading-relaxed overflow-x-auto">
          {mockDiff}
        </pre>

        <div className="mt-6 flex items-center space-x-4">
          <button
            onClick={handleAuthorize}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition shadow-lg shadow-emerald-600/20"
          >
            Authorize GitOps PR
          </button>
          <button
            onClick={handleDecline}
            className="px-6 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-xl transition"
          >
            Decline Proposal
          </button>
        </div>
      </div>
    </div>
  );
}

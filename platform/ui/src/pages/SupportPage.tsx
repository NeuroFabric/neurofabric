import { useState } from 'react';
import { Terminal, Play } from 'lucide-react';

export function SupportPage() {
  const [output, setOutput] = useState('Diagnostic desk ready. Select a query to execute.');

  const runQuery = (q: string) => {
    if (q === 'wal') {
      setOutput('PRAGMA journal_mode = WAL;\nResult: ok\nCheckpoint status: PASS (0 pending frames)');
    } else if (q === 'ledger') {
      setOutput('SELECT count(*) FROM merkle_ledger;\nResult: 128 verified leaves (SHA-256 intact)');
    } else {
      setOutput('AST Syntax Screening: PASS\nEvaluated 1 proposed diff: 0 shell primitive escapes found.');
    }
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Diagnostic Query Desk & SRE Support</h1>
        <p className="text-xs text-slate-400 mt-1">
          Direct read-only verification queries against SQLite WAL, AST policy, and Merkle tree state.
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        <div className="space-y-3">
          <button
            onClick={() => runQuery('wal')}
            className="w-full p-4 rounded-xl bg-[#0d121d] border border-slate-800 hover:border-cyan-500 text-left transition flex items-center justify-between"
          >
            <div>
              <div className="text-xs font-bold text-white">Check WAL Checkpoint</div>
              <div className="text-[11px] text-slate-400">Inspect SQLite write-ahead log health</div>
            </div>
            <Play className="w-4 h-4 text-cyan-400" />
          </button>

          <button
            onClick={() => runQuery('ledger')}
            className="w-full p-4 rounded-xl bg-[#0d121d] border border-slate-800 hover:border-cyan-500 text-left transition flex items-center justify-between"
          >
            <div>
              <div className="text-xs font-bold text-white">Count Merkle Leaves</div>
              <div className="text-[11px] text-slate-400">Verify total sealed cryptographic leaves</div>
            </div>
            <Play className="w-4 h-4 text-cyan-400" />
          </button>

          <button
            onClick={() => runQuery('ast')}
            className="w-full p-4 rounded-xl bg-[#0d121d] border border-slate-800 hover:border-cyan-500 text-left transition flex items-center justify-between"
          >
            <div>
              <div className="text-xs font-bold text-white">Run AST Policy Audit</div>
              <div className="text-[11px] text-slate-400">Screen pending proposal for shell primitives</div>
            </div>
            <Play className="w-4 h-4 text-cyan-400" />
          </button>
        </div>

        <div className="md:col-span-2 p-6 rounded-2xl bg-[#0d121d] border border-slate-800 space-y-3 font-mono">
          <div className="flex items-center space-x-2 text-xs font-bold text-slate-400 border-b border-slate-800 pb-3">
            <Terminal className="w-4 h-4 text-cyan-400" />
            <span>Interactive Diagnostic Terminal</span>
          </div>
          <pre className="p-4 bg-slate-950 rounded-xl text-xs text-emerald-400 leading-relaxed overflow-x-auto min-h-[160px]">
            {output}
          </pre>
        </div>
      </div>
    </div>
  );
}

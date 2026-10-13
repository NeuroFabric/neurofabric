export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const dim = size === "sm" ? "w-6 h-6" : size === "lg" ? "w-10 h-10" : "w-8 h-8";

  return (
    <div className="flex items-center space-x-3 select-none">
      <div className={`${dim} relative shrink-0 flex items-center justify-center`}>
        <svg viewBox="0 0 40 40" fill="none" className="w-full h-full drop-shadow-[0_0_12px_rgba(16,185,129,0.35)]">
          <defs>
            <linearGradient id="nexusGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#34D399" />
              <stop offset="100%" stopColor="#059669" />
            </linearGradient>
          </defs>
          <rect x="4" y="4" width="32" height="32" rx="8" fill="#12151D" stroke="#262B37" strokeWidth="1.5" />
          <path d="M20 10L29 16V26L20 31L11 26V16L20 10Z" stroke="url(#nexusGrad)" strokeWidth="1.75" strokeLinejoin="round" />
          <circle cx="20" cy="20.5" r="3" fill="#34D399" />
          <line x1="20" y1="10" x2="20" y2="20.5" stroke="#34D399" strokeWidth="1.2" strokeDasharray="1.5 1.5" />
          <line x1="11" y1="26" x2="20" y2="20.5" stroke="#34D399" strokeWidth="1.2" strokeDasharray="1.5 1.5" />
          <line x1="29" y1="26" x2="20" y2="20.5" stroke="#34D399" strokeWidth="1.2" strokeDasharray="1.5 1.5" />
        </svg>
      </div>

      <div>
        <div className="flex items-center space-x-2">
          <span className="font-extrabold text-white tracking-tight leading-none text-base font-sans">
            NeuroFabric
          </span>
          <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-800/80">
            v2.6
          </span>
        </div>
        <div className="text-[10px] text-slate-400 font-medium tracking-tight mt-0.5">
          Autonomous Incident Cockpit
        </div>
      </div>
    </div>
  );
}

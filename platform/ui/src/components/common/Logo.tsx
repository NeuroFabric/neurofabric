export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const dim = size === "sm" ? "w-7 h-7" : size === "lg" ? "w-11 h-11" : "w-9 h-9";

  return (
    <div className="flex items-center space-x-3 select-none group">
      <div className={`${dim} relative shrink-0 flex items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/20 via-cyan-500/15 to-emerald-500/20 p-0.5 border border-white/15 shadow-[0_0_25px_rgba(56,189,248,0.35)]`}>
        <svg
          viewBox="0 0 48 48"
          fill="none"
          shapeRendering="geometricPrecision"
          className="w-full h-full"
        >
          <defs>
            <linearGradient id="nfTop" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#38BDF8" />
              <stop offset="100%" stopColor="#818CF8" />
            </linearGradient>
            <linearGradient id="nfLeft" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#06B6D4" />
              <stop offset="100%" stopColor="#10B981" />
            </linearGradient>
            <linearGradient id="nfRight" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#6366F1" />
              <stop offset="100%" stopColor="#4F46E5" />
            </linearGradient>
          </defs>

          {/* Outer High-Contrast Isometric Prism */}
          <polygon points="24,4 42,14.5 24,25 6,14.5" fill="url(#nfTop)" stroke="#E0F2FE" strokeWidth="1.2" />
          <polygon points="6,14.5 24,25 24,44 6,33.5" fill="url(#nfLeft)" stroke="#A7F3D0" strokeWidth="1.2" />
          <polygon points="24,25 42,14.5 42,33.5 24,44" fill="url(#nfRight)" stroke="#C7D2FE" strokeWidth="1.2" />

          {/* Crisp Inner Core & Neural Vectors */}
          <line x1="24" y1="4" x2="24" y2="25" stroke="#FFFFFF" strokeWidth="1.5" strokeOpacity="0.9" />
          <line x1="6" y1="33.5" x2="24" y2="25" stroke="#FFFFFF" strokeWidth="1.5" strokeOpacity="0.8" />
          <line x1="42" y1="33.5" x2="24" y2="25" stroke="#FFFFFF" strokeWidth="1.5" strokeOpacity="0.8" />

          <circle cx="24" cy="25" r="4.5" fill="#FFFFFF" />
          <circle cx="24" cy="25" r="2.2" fill="#06B6D4" />
          <circle cx="24" cy="4" r="2" fill="#FFFFFF" />
          <circle cx="6" cy="14.5" r="2" fill="#E0F2FE" />
          <circle cx="42" cy="14.5" r="2" fill="#E0F2FE" />
          <circle cx="24" cy="44" r="2" fill="#A7F3D0" />
        </svg>
      </div>

      <div>
        <div className="flex items-center space-x-2">
          <span className="font-black text-white tracking-tight leading-none text-[17px] font-sans drop-shadow-sm">
            NeuroFabric
          </span>
          <span className="text-[9px] font-mono font-extrabold px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-400/30">
            v2.8
          </span>
        </div>
        <div className="text-[10px] text-slate-300 font-medium tracking-tight mt-0.5">
          Autonomous Incident Cockpit
        </div>
      </div>
    </div>
  );
}

export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const dim = size === "sm" ? "w-7 h-7" : size === "lg" ? "w-11 h-11" : "w-9 h-9";

  return (
    <div className="flex items-center space-x-3 select-none">
      <div
        className={`${dim} relative shrink-0 flex items-center justify-center rounded-xl bg-[#141417] p-0.5 border border-white/15 shadow-[0_0_20px_rgba(245,158,11,0.18)]`}
      >
        <svg viewBox="0 0 48 48" fill="none" shapeRendering="geometricPrecision" className="w-full h-full">
          <defs>
            <linearGradient id="nfTopFacet" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#FAFAFA" />
              <stop offset="100%" stopColor="#A1A1AA" />
            </linearGradient>
            <linearGradient id="nfLeftFacet" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#F59E0B" />
              <stop offset="100%" stopColor="#D97706" />
            </linearGradient>
            <linearGradient id="nfRightFacet" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#10B981" />
              <stop offset="100%" stopColor="#059669" />
            </linearGradient>
          </defs>

          <polygon points="24,4 42,14.5 24,25 6,14.5" fill="url(#nfTopFacet)" stroke="#FFFFFF" strokeWidth="1.2" />
          <polygon points="6,14.5 24,25 24,44 6,33.5" fill="url(#nfLeftFacet)" stroke="#FDE68A" strokeWidth="1.2" />
          <polygon points="24,25 42,14.5 42,33.5 24,44" fill="url(#nfRightFacet)" stroke="#A7F3D0" strokeWidth="1.2" />

          <circle cx="24" cy="25" r="4.2" fill="#09090B" stroke="#FAFAFA" strokeWidth="1.8" />
          <circle cx="24" cy="4" r="2" fill="#FAFAFA" />
          <circle cx="6" cy="14.5" r="2" fill="#FDE68A" />
          <circle cx="42" cy="14.5" r="2" fill="#A7F3D0" />
          <circle cx="24" cy="44" r="2" fill="#FAFAFA" />
        </svg>
      </div>

      <div>
        <div className="flex items-center space-x-2">
          <span className="font-bold text-white tracking-tight leading-none text-[16px] font-sans">
            NeuroFabric
          </span>
          <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
            v3.0
          </span>
        </div>
        <div className="text-[10px] text-zinc-400 font-medium tracking-tight mt-0.5">
          Autonomous SRE & GitOps Plane
        </div>
      </div>
    </div>
  );
}

export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const dim = size === "sm" ? "w-6 h-6" : size === "lg" ? "w-10 h-10" : "w-8 h-8";

  return (
    <div className="flex items-center space-x-3 select-none">
      {/* 3D Isometric Neural Hex-Cube */}
      <div className={`${dim} relative shrink-0 flex items-center justify-center`}>
        <svg viewBox="0 0 48 48" fill="none" className="w-full h-full drop-shadow-[0_0_12px_rgba(6,182,212,0.6)]">
          <defs>
            <linearGradient id="cubeTop" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#38bdf8" />
              <stop offset="100%" stopColor="#0284c7" />
            </linearGradient>
            <linearGradient id="cubeLeft" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#06b6d4" />
              <stop offset="100%" stopColor="#0e7490" />
            </linearGradient>
            <linearGradient id="cubeRight" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#818cf8" />
              <stop offset="100%" stopColor="#4f46e5" />
            </linearGradient>
            <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* Isometric Facets */}
          <polygon points="24,4 42,14 24,24 6,14" fill="url(#cubeTop)" fillOpacity="0.85" stroke="#38bdf8" strokeWidth="1.2" />
          <polygon points="6,14 24,24 24,44 6,34" fill="url(#cubeLeft)" fillOpacity="0.75" stroke="#06b6d4" strokeWidth="1.2" />
          <polygon points="24,24 42,14 42,34 24,44" fill="url(#cubeRight)" fillOpacity="0.8" stroke="#818cf8" strokeWidth="1.2" />

          {/* Neural Core & Vertex Nodes */}
          <circle cx="24" cy="24" r="3" fill="#ffffff" filter="url(#glow)" />
          <circle cx="24" cy="4" r="1.5" fill="#38bdf8" />
          <circle cx="42" cy="14" r="1.5" fill="#818cf8" />
          <circle cx="6" cy="14" r="1.5" fill="#06b6d4" />
          <circle cx="24" cy="44" r="1.5" fill="#38bdf8" />
          <circle cx="6" cy="34" r="1.5" fill="#06b6d4" />
          <circle cx="42" cy="34" r="1.5" fill="#818cf8" />

          {/* Internal Synapse Lines */}
          <line x1="24" y1="4" x2="24" y2="24" stroke="#ffffff" strokeWidth="1" strokeOpacity="0.6" strokeDasharray="2 2" />
          <line x1="6" y1="34" x2="24" y2="24" stroke="#ffffff" strokeWidth="1" strokeOpacity="0.6" strokeDasharray="2 2" />
          <line x1="42" y1="34" x2="24" y2="24" stroke="#ffffff" strokeWidth="1" strokeOpacity="0.6" strokeDasharray="2 2" />
        </svg>
      </div>

      {/* Typography from Final HUD Spec */}
      <div>
        <div className="flex items-center space-x-2">
          <span className="font-extrabold text-white tracking-tight leading-none text-base">NeuroFabric Ops</span>
          <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800/80 tracking-wider">
            ENTERPRISE 3D
          </span>
        </div>
        <div className="text-[10px] text-slate-400 font-medium tracking-tight mt-0.5">
          Autonomous Closed-Loop Remediation & Telemetry Operations
        </div>
      </div>
    </div>
  );
}

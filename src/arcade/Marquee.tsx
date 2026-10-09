/** Hand-drawn cover art for each cabinet card. Pure SVG so the lobby stays light. */
export function Marquee({ id }: { id: string }) {
  if (id === "breakwater")
    return (
      <svg viewBox="0 0 320 160" aria-hidden>
        <rect width="320" height="160" fill="#17324d" />
        {[0, 1, 2].map((i) => (
          <path key={i} d={`M-10 ${44 + i * 18} q20 -12 40 0 t40 0 t40 0 t40 0 t40 0 t40 0 t40 0 t40 0 t40 0`} fill="none" stroke="#f2ece0" strokeOpacity={0.18 + i * 0.1} strokeWidth="3" />
        ))}
        <rect y="96" width="320" height="64" fill="#e8dcc2" />
        {[60, 120, 236].map((x) => (
          <g key={x}>
            <rect x={x} y="118" width="30" height="22" fill="#f7f1e3" stroke="#3b3226" strokeWidth="2.5" />
            <path d={`M${x - 5} ${120} L${x + 15} ${102} L${x + 35} ${120}Z`} fill="#e2603f" stroke="#3b3226" strokeWidth="2.5" strokeLinejoin="round" />
          </g>
        ))}
        <circle cx="178" cy="70" r="17" fill="#3a1f1a" stroke="#e2603f" strokeWidth="3" />
        <path d="M178 90 Q 200 112 218 112" fill="none" stroke="#e2603f" strokeWidth="5" strokeLinecap="round" strokeDasharray="1 9" />
        <path d="M212 104 l10 8 -12 4" fill="#e2603f" />
        <rect x="160" y="112" width="34" height="34" rx="8" fill="#1f5f8b" stroke="#0f2f47" strokeWidth="2.5" />
        <text x="177" y="136" textAnchor="middle" fontSize="20" fontWeight="800" fill="#fff">銛</text>
      </svg>
    );
  if (id === "wildfire")
    return (
      <svg viewBox="0 0 320 160" aria-hidden>
        <defs>
          <linearGradient id="mq-fire" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#ff8a3d" />
            <stop offset="1" stopColor="#ffd36b" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect width="320" height="160" fill="#2a2420" />
        <rect x="0" y="0" width="140" height="160" fill="url(#mq-fire)" opacity="0.55" />
        {Array.from({ length: 11 }, (_, i) => {
          const x = 14 + i * 28;
          const burnt = i < 4;
          return <path key={i} d={`M${x} 140 l14 -46 l14 46z`} fill={burnt ? "#3d3530" : "#3f6b3a"} stroke={burnt ? "#ff8a3d" : "#2c4d29"} strokeWidth="2" />;
        })}
        <rect x="146" y="40" width="16" height="110" fill="#6b4a2f" />
        <path d="M150 52 l4 -12 l4 12" fill="none" stroke="#f6e7d0" strokeWidth="2.5" />
        <g stroke="#f6e7d0" strokeWidth="3" strokeLinecap="round" opacity="0.6">
          <path d="M200 30 h60 m-12 -8 l12 8 -12 8" fill="none" />
        </g>
      </svg>
    );
  return (
    <svg viewBox="0 0 320 160" aria-hidden>
      <rect width="320" height="160" fill="#0f2e2e" />
      {Array.from({ length: 6 }, (_, i) => (
        <rect key={i} x={120 - i * 2} y={i * 27} width={80 + i * 4} height="27" fill={`hsl(176 40% ${22 - i * 3}%)`} />
      ))}
      <path d="M160 0 V 132" stroke="#e8f0e6" strokeOpacity="0.5" strokeWidth="2" strokeDasharray="4 5" />
      <circle cx="160" cy="138" r="9" fill="#e8f0e6" />
      <path d="M150 128 l10 -10 10 10" fill="none" stroke="#e8f0e6" strokeWidth="2" />
      <path d="M230 98 l14 -16 14 16 -14 22z" fill="#e8b54a" stroke="#fff3c4" strokeWidth="2" />
      <path d="M62 110 l10 -12 10 12 -10 16z" fill="#e8b54a" opacity="0.7" />
      <text x="40" y="54" fontSize="28" fill="#e2603f" opacity="0.8">!</text>
    </svg>
  );
}

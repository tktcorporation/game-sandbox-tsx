import { GAMES, type GameId, type GameEntry } from "../catalog";

export function Hub({ onPlay }: { onPlay: (id: GameId) => void }) {
  return (
    <div className="arcade">
      <div className="arcade-glow" aria-hidden />
      <header className="arcade-mast">
        <p className="arcade-stamp">Sandbox Arcade</p>
        <h1>Pick a cabinet.</h1>
        <p className="arcade-lead">
          Two games. One browser. Progress stays on this device.
        </p>
      </header>
      <div className="cabinet-row">
        {GAMES.map((game) => (
          <Cabinet key={game.id} game={game} onPlay={onPlay} />
        ))}
      </div>
    </div>
  );
}

function Cabinet({ game, onPlay }: { game: GameEntry; onPlay: (id: GameId) => void }) {
  return (
    <article className={`cabinet cabinet-${game.id}`}>
      <div className="cabinet-bezel">
        <div className="cabinet-screen" aria-hidden>
          {game.id === "clash" ? <ClashPreview /> : <FoundryPreview />}
        </div>
      </div>
      <div className="cabinet-plaque">
        <span className="cabinet-kicker">{game.kicker}</span>
        {game.origin ? <span className="cabinet-origin">from {game.origin}</span> : null}
        <h2>{game.title}</h2>
        <p className="cabinet-tag">{game.tagline}</p>
        <p className="cabinet-blurb">{game.blurb}</p>
        <button type="button" className="cabinet-play" onClick={() => onPlay(game.id)}>
          {game.playLabel}
        </button>
      </div>
    </article>
  );
}

function ClashPreview() {
  return (
    <svg className="preview-svg" viewBox="0 0 160 110" role="img">
      <defs>
        <linearGradient id="clash-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7eb4e6" />
          <stop offset="55%" stopColor="#3f7a4a" />
          <stop offset="100%" stopColor="#2a5a32" />
        </linearGradient>
      </defs>
      <rect width="160" height="110" fill="url(#clash-sky)" />
      <ellipse cx="80" cy="92" rx="54" ry="14" fill="#1d4a24" />
      <path d="M48 78 L80 42 L112 78 Z" fill="#c9a36a" stroke="#5b3719" strokeWidth="2" />
      <rect x="70" y="62" width="20" height="16" fill="#7a4d27" />
      <circle cx="36" cy="70" r="8" fill="#6cb238" />
      <circle cx="124" cy="68" r="7" fill="#f5bd2b" />
      <rect x="22" y="82" width="18" height="8" fill="#ec5e29" />
    </svg>
  );
}

function FoundryPreview() {
  return (
    <svg className="preview-svg" viewBox="0 0 160 110" role="img">
      <rect width="160" height="110" fill="#8e8a80" />
      <rect x="12" y="18" width="136" height="74" fill="#c9c4b8" stroke="#3a3832" />
      <rect x="24" y="50" width="52" height="10" fill="#6e6a62" />
      <rect x="28" y="52" width="6" height="6" fill="#e6c200" />
      <rect x="40" y="52" width="6" height="6" fill="#e6c200" />
      <rect x="52" y="52" width="6" height="6" fill="#e6c200" />
      <rect x="76" y="50" width="28" height="10" fill="#6e6a62" />
      <rect x="80" y="52" width="6" height="6" fill="#e6c200" />
      <rect x="28" y="26" width="28" height="22" fill="#6a7a52" stroke="#2a3228" />
      <rect x="104" y="34" width="28" height="28" fill="#2a6a68" stroke="#163832" />
      <circle cx="44" cy="55" r="3" fill="#9aa8b8" />
      <circle cx="90" cy="55" r="3" fill="#e07a3a" />
      <rect x="112" y="44" width="12" height="8" fill="#e6c200" />
    </svg>
  );
}

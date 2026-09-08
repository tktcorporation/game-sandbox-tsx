import type { Shape, Species, Stage } from "./types";
import { speciesOf } from "./species";

export function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)} ${s}% ${l}%)`;
}

export function palette(species: Species, shiny: boolean) {
  const h = shiny ? (species.hue + 168) % 360 : species.hue;
  const s = shiny ? Math.min(86, species.sat + 18) : species.sat;
  const l = shiny ? Math.min(68, species.lit + 6) : species.lit;
  return {
    body: hsl(h, s, l),
    deep: hsl(h, s + 6, Math.max(18, l - 18)),
    light: hsl(h, Math.max(20, s - 10), Math.min(88, l + 18)),
    blush: hsl((h + 20) % 360, 62, 72),
    ink: "#3a2414",
    eye: shiny ? "#3a1c08" : "#2a1810",
    shine: "#fff8e8",
  };
}

export function TataSprite({
  speciesId,
  stage = 1,
  shiny = false,
  size = 72,
  mood = "idle",
  silhouette = false,
  title,
}: {
  speciesId: string;
  stage?: Stage;
  shiny?: boolean;
  size?: number;
  mood?: "idle" | "happy" | "sad" | "fight";
  silhouette?: boolean;
  title?: string;
}) {
  const species = speciesOf(speciesId);
  const pal = palette(species, shiny);
  const scale = 0.72 + stage * 0.1;
  const extras = stage >= 3;
  return (
    <svg
      className="tata-sprite"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title ?? species.name}
    >
      {silhouette ? (
        <g transform="translate(32 36) scale(0.92)" fill="#3a2a18" opacity="0.45">
          <Body shape={species.shape} pal={{ ...pal, body: "#3a2a18", deep: "#2a1c10", light: "#4a3824" }} extras={false} mood="idle" />
        </g>
      ) : (
        <g transform={`translate(32 38) scale(${scale})`}>
          <ellipse cx="0" cy="18" rx="14" ry="4.5" fill="#3a2414" opacity="0.18" />
          <Body shape={species.shape} pal={pal} extras={extras} mood={mood} speciesId={speciesId} />
          {shiny ? <Sparkles /> : null}
          {extras ? <Crown /> : null}
        </g>
      )}
    </svg>
  );
}

function Body({
  shape,
  pal,
  extras,
  mood,
  speciesId,
}: {
  shape: Shape;
  pal: ReturnType<typeof palette>;
  extras: boolean;
  mood: "idle" | "happy" | "sad" | "fight";
  speciesId?: string;
}) {
  const drool = speciesId === "fulugg";
  const sadStone = speciesId === "nanmonaishi";
  switch (shape) {
    case "frog":
      return <Frog pal={pal} extras={extras} drool={drool} mood={mood} />;
    case "stone":
      return <Stone pal={pal} extras={extras} sad={sadStone || mood === "sad"} />;
    case "cat":
      return <Cat pal={pal} extras={extras} mood={mood} />;
    case "bird":
      return <Bird pal={pal} extras={extras} />;
    case "blob":
      return <Blob pal={pal} extras={extras} mood={mood} />;
    case "bug":
      return <Bug pal={pal} extras={extras} />;
    case "fish":
      return <Fish pal={pal} extras={extras} />;
    case "shroom":
      return <Shroom pal={pal} extras={extras} />;
    case "star":
      return <Star pal={pal} extras={extras} />;
    case "drake":
      return <Drake pal={pal} extras={extras} />;
    case "ghost":
      return <Ghost pal={pal} extras={extras} />;
    case "sweet":
      return <Sweet pal={pal} extras={extras} />;
  }
}

type Pal = ReturnType<typeof palette>;

function Face({ pal, mood, y = -2 }: { pal: Pal; mood: "idle" | "happy" | "sad" | "fight"; y?: number }) {
  const smile = mood === "sad" ? "M -5 3 Q 0 1 5 3" : mood === "fight" ? "M -4 3 L 4 3" : "M -5 2 Q 0 6 5 2";
  return (
    <g>
      <ellipse cx="-5.5" cy={y} rx="3.2" ry="3.6" fill={pal.shine} />
      <ellipse cx="5.5" cy={y} rx="3.2" ry="3.6" fill={pal.shine} />
      <circle cx="-5.2" cy={y + 0.4} r="1.7" fill={pal.eye} />
      <circle cx="5.8" cy={y + 0.4} r="1.7" fill={pal.eye} />
      <circle cx="-4.4" cy={y - 0.5} r="0.7" fill="#fff" />
      <circle cx="6.6" cy={y - 0.5} r="0.7" fill="#fff" />
      <path d={smile} fill="none" stroke={pal.ink} strokeWidth="1.3" strokeLinecap="round" />
      <ellipse cx="-8" cy={4} rx="3" ry="2" fill={pal.blush} opacity="0.7" />
      <ellipse cx="8" cy={4} rx="3" ry="2" fill={pal.blush} opacity="0.7" />
    </g>
  );
}

function Frog({ pal, extras, drool, mood }: { pal: Pal; extras: boolean; drool: boolean; mood: "idle" | "happy" | "sad" | "fight" }) {
  return (
    <g>
      <ellipse cx="-11" cy="10" rx="5" ry="3.5" fill={pal.deep} />
      <ellipse cx="11" cy="10" rx="5" ry="3.5" fill={pal.deep} />
      <ellipse cx="0" cy="2" rx="16" ry="13" fill={pal.body} stroke={pal.ink} strokeWidth="2.2" />
      <ellipse cx="-9" cy="-10" rx="7" ry="6.5" fill={pal.body} stroke={pal.ink} strokeWidth="2.2" />
      <ellipse cx="9" cy="-10" rx="7" ry="6.5" fill={pal.body} stroke={pal.ink} strokeWidth="2.2" />
      <ellipse cx="0" cy="6" rx="10" ry="6" fill={pal.light} opacity="0.55" />
      <Face pal={pal} mood={drool ? "happy" : mood} y={-9} />
      {drool ? <path d="M 3 4 Q 6 10 4 16" fill="none" stroke="#9ad4e8" strokeWidth="2.2" strokeLinecap="round" /> : null}
      {extras ? <path d="M -4 -18 L 0 -24 L 4 -18" fill={pal.light} stroke={pal.ink} strokeWidth="1.4" /> : null}
    </g>
  );
}

function Stone({ pal, extras, sad }: { pal: Pal; extras: boolean; sad: boolean }) {
  return (
    <g>
      <path
        d="M -15 6 Q -18 -6 -8 -14 Q 0 -18 10 -12 Q 18 -4 16 8 Q 8 16 -2 15 Q -14 14 -15 6 Z"
        fill={pal.body}
        stroke={pal.ink}
        strokeWidth="2.2"
      />
      <path d="M -6 -4 L 2 2" stroke={pal.deep} strokeWidth="1.4" />
      <ellipse cx="-6" cy="-2" rx="3" ry="3.4" fill={pal.shine} />
      <ellipse cx="6" cy="-2" rx="3" ry="3.4" fill={pal.shine} />
      <circle cx="-5.8" cy="-1.6" r="1.4" fill={pal.eye} />
      <circle cx="6.2" cy="-1.6" r="1.4" fill={pal.eye} />
      <path d={sad ? "M -4 5 Q 0 2 4 5" : "M -4 4 Q 0 7 4 4"} fill="none" stroke={pal.ink} strokeWidth="1.3" strokeLinecap="round" />
      {extras ? <circle cx="0" cy="-16" r="3.2" fill={pal.light} stroke={pal.ink} strokeWidth="1.4" /> : null}
    </g>
  );
}

function Cat({ pal, extras, mood }: { pal: Pal; extras: boolean; mood: "idle" | "happy" | "sad" | "fight" }) {
  return (
    <g>
      <path d="M 12 4 Q 22 0 18 12" fill="none" stroke={pal.deep} strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="0" cy="2" rx="14" ry="13" fill={pal.body} stroke={pal.ink} strokeWidth="2.2" />
      <path d="M -12 -8 L -16 -20 L -4 -12 Z" fill={pal.body} stroke={pal.ink} strokeWidth="2" />
      <path d="M 12 -8 L 16 -20 L 4 -12 Z" fill={pal.body} stroke={pal.ink} strokeWidth="2" />
      <path d="M -14 -14 L -12 -18" stroke={pal.light} strokeWidth="1.2" />
      <path d="M 14 -14 L 12 -18" stroke={pal.light} strokeWidth="1.2" />
      <Face pal={pal} mood={mood} y={-2} />
      <path d="M -16 2 H -10 M 10 2 H 16" stroke={pal.ink} strokeWidth="1" />
      {extras ? <path d="M -3 -16 Q 0 -22 3 -16" fill={pal.blush} stroke={pal.ink} strokeWidth="1.3" /> : null}
    </g>
  );
}

function Bird({ pal, extras }: { pal: Pal; extras: boolean }) {
  return (
    <g>
      <ellipse cx="0" cy="2" rx="13" ry="12" fill={pal.body} stroke={pal.ink} strokeWidth="2.2" />
      <ellipse cx="-10" cy="2" rx="6" ry="5" fill={pal.deep} stroke={pal.ink} strokeWidth="1.6" />
      <path d="M 10 0 L 20 -2 L 12 4 Z" fill="#f0b030" stroke={pal.ink} strokeWidth="1.4" />
      <path d="M -4 14 L -2 20 M 4 14 L 6 20" stroke={pal.ink} strokeWidth="1.6" strokeLinecap="round" />
      <Face pal={pal} mood="idle" y={-2} />
      {extras ? <path d="M -2 -16 L 0 -22 L 2 -16" fill="#f0b030" stroke={pal.ink} strokeWidth="1.2" /> : null}
    </g>
  );
}

function Blob({ pal, extras, mood }: { pal: Pal; extras: boolean; mood: "idle" | "happy" | "sad" | "fight" }) {
  return (
    <g>
      <ellipse cx="0" cy="2" rx="16" ry="14" fill={pal.body} stroke={pal.ink} strokeWidth="2.2" />
      <ellipse cx="-4" cy="-4" rx="6" ry="4" fill={pal.light} opacity="0.55" />
      <Face pal={pal} mood={mood} />
      {extras ? (
        <g>
          <circle cx="-12" cy="-12" r="3" fill={pal.light} stroke={pal.ink} strokeWidth="1.2" />
          <circle cx="12" cy="-10" r="2.4" fill={pal.light} stroke={pal.ink} strokeWidth="1.2" />
        </g>
      ) : null}
    </g>
  );
}

function Bug({ pal, extras }: { pal: Pal; extras: boolean }) {
  return (
    <g>
      <ellipse cx="-8" cy="4" rx="8" ry="8" fill={pal.deep} stroke={pal.ink} strokeWidth="2" />
      <ellipse cx="6" cy="2" rx="11" ry="11" fill={pal.body} stroke={pal.ink} strokeWidth="2.2" />
      <path d="M 10 -8 L 16 -16 M 4 -10 L 6 -18" stroke={pal.ink} strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="15" cy="-16" r="1.6" fill={pal.blush} />
      <circle cx="6" cy="-18" r="1.6" fill={pal.blush} />
      <Face pal={pal} mood="idle" y={-1} />
      {extras ? <path d="M -2 12 L 10 12" stroke={pal.deep} strokeWidth="2" /> : null}
    </g>
  );
}

function Fish({ pal, extras }: { pal: Pal; extras: boolean }) {
  return (
    <g>
      <path d="M 10 0 L 22 -8 L 20 0 L 22 8 Z" fill={pal.deep} stroke={pal.ink} strokeWidth="1.8" />
      <ellipse cx="-2" cy="1" rx="15" ry="11" fill={pal.body} stroke={pal.ink} strokeWidth="2.2" />
      <path d="M -4 10 Q 0 16 6 10" fill={pal.deep} />
      <Face pal={pal} mood="idle" y={-2} />
      {extras ? <circle cx="8" cy="-8" r="3" fill={pal.light} stroke={pal.ink} strokeWidth="1.2" /> : null}
    </g>
  );
}

function Shroom({ pal, extras }: { pal: Pal; extras: boolean }) {
  return (
    <g>
      <ellipse cx="0" cy="10" rx="8" ry="7" fill={pal.light} stroke={pal.ink} strokeWidth="2" />
      <path d="M -16 2 Q 0 -18 16 2 Q 8 8 0 6 Q -8 8 -16 2 Z" fill={pal.body} stroke={pal.ink} strokeWidth="2.2" />
      <circle cx="-6" cy="-4" r="2.4" fill={pal.light} />
      <circle cx="5" cy="-2" r="3" fill={pal.light} />
      <Face pal={pal} mood="idle" y={6} />
      {extras ? <circle cx="0" cy="-16" r="2.6" fill={pal.blush} stroke={pal.ink} strokeWidth="1.2" /> : null}
    </g>
  );
}

function Star({ pal, extras }: { pal: Pal; extras: boolean }) {
  return (
    <g>
      <path
        d="M 0 -18 L 4 -4 L 18 -4 L 7 5 L 11 18 L 0 10 L -11 18 L -7 5 L -18 -4 L -4 -4 Z"
        fill={pal.body}
        stroke={pal.ink}
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <Face pal={pal} mood="happy" y={0} />
      {extras ? <circle cx="0" cy="-22" r="2.4" fill="#fff4c8" stroke={pal.ink} strokeWidth="1.1" /> : null}
    </g>
  );
}

function Drake({ pal, extras }: { pal: Pal; extras: boolean }) {
  return (
    <g>
      <path d="M -16 2 Q -24 -6 -10 -4" fill={pal.deep} stroke={pal.ink} strokeWidth="1.6" />
      <ellipse cx="0" cy="2" rx="15" ry="12" fill={pal.body} stroke={pal.ink} strokeWidth="2.2" />
      <path d="M -6 -10 L -10 -20 L -2 -12 M 6 -10 L 10 -20 L 2 -12" fill={pal.deep} stroke={pal.ink} strokeWidth="1.6" />
      <path d="M 12 0 L 22 -10 L 16 6 Z" fill={pal.deep} stroke={pal.ink} strokeWidth="1.5" />
      <Face pal={pal} mood="fight" />
      {extras ? <path d="M -2 -18 L 0 -26 L 2 -18" fill="#f0b030" stroke={pal.ink} strokeWidth="1.3" /> : null}
    </g>
  );
}

function Ghost({ pal, extras }: { pal: Pal; extras: boolean }) {
  return (
    <g>
      <path
        d="M -13 12 Q -16 -10 0 -16 Q 16 -10 13 12 Q 9 8 6 12 Q 3 8 0 12 Q -3 8 -6 12 Q -9 8 -13 12 Z"
        fill={pal.body}
        stroke={pal.ink}
        strokeWidth="2.2"
      />
      <Face pal={pal} mood="happy" y={-4} />
      {extras ? <circle cx="12" cy="-12" r="3" fill="#fff4c8" opacity="0.8" /> : null}
    </g>
  );
}

function Sweet({ pal, extras }: { pal: Pal; extras: boolean }) {
  return (
    <g>
      <ellipse cx="0" cy="6" rx="14" ry="10" fill={pal.body} stroke={pal.ink} strokeWidth="2.2" />
      <path d="M -12 2 Q 0 -8 12 2" fill={pal.light} stroke={pal.ink} strokeWidth="1.6" />
      <circle cx="2" cy="-10" r="4" fill="#d94a4a" stroke={pal.ink} strokeWidth="1.5" />
      <Face pal={pal} mood="happy" y={4} />
      {extras ? <path d="M 2 -14 Q 8 -18 6 -10" fill="none" stroke="#6a3020" strokeWidth="1.3" /> : null}
    </g>
  );
}

function Sparkles() {
  return (
    <g fill="#fff4c8" stroke="#3a2414" strokeWidth="0.8">
      <path d="M -20 -8 L -18 -12 L -16 -8 L -18 -4 Z" />
      <path d="M 18 -2 L 20 -6 L 22 -2 L 20 2 Z" />
      <path d="M 12 -16 L 21 -14 L 14 -12 Z" />
    </g>
  );
}

function Crown() {
  return (
    <g transform="translate(0 -22)">
      <path d="M -8 4 L -6 -4 L 0 2 L 6 -4 L 8 4 Z" fill="#f0b030" stroke="#3a2414" strokeWidth="1.4" />
    </g>
  );
}

export function ZombieSprite({
  kind = "walker",
  size = 56,
}: {
  kind?: "walker" | "runner" | "brute" | "boss";
  size?: number;
}) {
  const scale = kind === "boss" ? 1.15 : kind === "brute" ? 1.05 : kind === "runner" ? 0.86 : 1;
  const body = kind === "boss" ? "#6a6e4a" : kind === "brute" ? "#5a6a48" : "#7a8a52";
  return (
    <svg className="tata-sprite" width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <g transform={`translate(32 38) scale(${scale})`}>
        <ellipse cx="0" cy="16" rx="12" ry="3.5" fill="#1a140c" opacity="0.25" />
        <ellipse cx="0" cy="2" rx="14" ry="13" fill={body} stroke="#2a2010" strokeWidth="2.2" />
        <path d="M -10 10 Q 0 16 10 8" fill="#4a5234" />
        <circle cx="-5" cy="-2" r="3.4" fill="#f0ead0" />
        <circle cx="6" cy="-2" r="3.4" fill="#f0ead0" />
        <path d="M -7 -2 L -3 -2 M 4 -2 L 8 -2" stroke="#2a2010" strokeWidth="1.4" />
        <path d="M -4 6 Q 0 4 5 7" fill="none" stroke="#2a2010" strokeWidth="1.4" />
        {kind === "brute" || kind === "boss" ? (
          <path d="M -12 -4 H 12 V 6 H -12 Z" fill="none" stroke="#8a7a48" strokeWidth="2" />
        ) : null}
      </g>
    </svg>
  );
}

export function FurnitureSprite({ type, size = 48 }: { type: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className="tata-sprite">
      {type === "nest" ? (
        <g>
          <ellipse cx="32" cy="44" rx="22" ry="10" fill="#c47a3a" stroke="#3a2414" strokeWidth="2.2" />
          <ellipse cx="32" cy="40" rx="14" ry="6" fill="#f0d090" />
          <circle cx="26" cy="38" r="5" fill="#f6ead0" stroke="#3a2414" strokeWidth="1.4" />
        </g>
      ) : type === "pool" ? (
        <g>
          <ellipse cx="32" cy="36" rx="24" ry="14" fill="#3a7ca8" stroke="#3a2414" strokeWidth="2.2" />
          <ellipse cx="32" cy="34" rx="18" ry="9" fill="#7ec8e0" />
          <path d="M 18 32 Q 24 28 30 32" fill="none" stroke="#fff" strokeWidth="1.6" />
        </g>
      ) : type === "snack" ? (
        <g>
          <rect x="16" y="28" width="32" height="18" rx="4" fill="#c47a3a" stroke="#3a2414" strokeWidth="2" />
          <circle cx="26" cy="26" r="6" fill="#d94a4a" stroke="#3a2414" strokeWidth="1.5" />
          <circle cx="38" cy="24" r="5" fill="#88c050" stroke="#3a2414" strokeWidth="1.5" />
        </g>
      ) : type === "lantern" ? (
        <g>
          <rect x="26" y="14" width="12" height="8" fill="#3a2414" />
          <rect x="20" y="22" width="24" height="22" rx="4" fill="#f0b030" stroke="#3a2414" strokeWidth="2" />
          <rect x="28" y="44" width="8" height="8" fill="#3a2414" />
        </g>
      ) : type === "garden" ? (
        <g>
          <ellipse cx="32" cy="44" rx="20" ry="8" fill="#5a8a3a" stroke="#3a2414" strokeWidth="2" />
          <circle cx="22" cy="30" r="7" fill="#e85d2c" stroke="#3a2414" strokeWidth="1.5" />
          <circle cx="36" cy="26" r="8" fill="#f0b030" stroke="#3a2414" strokeWidth="1.5" />
          <circle cx="42" cy="34" r="6" fill="#e85d2c" stroke="#3a2414" strokeWidth="1.5" />
        </g>
      ) : (
        <g>
          <rect x="12" y="36" width="40" height="8" rx="4" fill="#e85d2c" stroke="#3a2414" strokeWidth="2" />
          <rect x="18" y="22" width="28" height="16" rx="3" fill="#f6ead0" stroke="#3a2414" strokeWidth="2" />
        </g>
      )}
    </svg>
  );
}

import { useState, type CSSProperties, type ReactNode } from "react";
import { isMuted, setMuted } from "./sfx";

/** Shared chrome for every cabinet: back to the lobby, the title, a sound toggle, and game-specific slots. */
export function Frame({ title, children, className, style, right }: {
  title: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  right?: ReactNode;
}) {
  const [muted, setM] = useState(isMuted);
  return (
    <div className={`frame ${className ?? ""}`} style={style}>
      <header className="frame-bar">
        <a className="frame-back" href="#/" aria-label="アーケードに戻る">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="square" />
          </svg>
        </a>
        <h1 className="frame-title">{title}</h1>
        <div className="frame-right">{right}</div>
        <button
          className="frame-mute"
          aria-label={muted ? "音を出す" : "消音"}
          aria-pressed={muted}
          onClick={() => {
            setMuted(!muted);
            setM(!muted);
          }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
            {muted ? (
              <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="2" />
            ) : (
              <path d="M16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12" stroke="currentColor" strokeWidth="2" fill="none" />
            )}
          </svg>
        </button>
      </header>
      {children}
    </div>
  );
}

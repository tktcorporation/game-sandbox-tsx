import type { CSSProperties, ReactNode } from "react";

/** Shared chrome for every cabinet: a way back to the lobby and the title, nothing else. */
export function Frame({ title, children, className, style, right }: {
  title: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  right?: ReactNode;
}) {
  return (
    <div className={`frame ${className ?? ""}`} style={style}>
      <header className="frame-bar">
        <a className="frame-back" href="#/" aria-label="アーケードに戻る">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
        <h1 className="frame-title">{title}</h1>
        <div className="frame-right">{right}</div>
      </header>
      {children}
    </div>
  );
}

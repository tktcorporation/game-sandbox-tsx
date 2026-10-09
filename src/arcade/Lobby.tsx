import { CABINETS, type Cabinet } from "./cabinets";
import { Preview } from "./Previews";

export function Lobby() {
  return (
    <main className="lobby">
      <header className="lobby-head">
        <p className="eyebrow">SANDBOX ARCADE · 3 CABINETS</p>
        <h1>
          迷う場面が
          <br />
          ひとつだけある。
        </h1>
      </header>
      <ol className="lobby-list">
        {CABINETS.map((c) => (
          <li key={c.id}>
            <CabinetCard c={c} />
          </li>
        ))}
      </ol>
      <footer className="lobby-foot">進行はこのブラウザにだけ保存されます</footer>
    </main>
  );
}

function CabinetCard({ c }: { c: Cabinet }) {
  return (
    <a className="cab panel" href={`#/${c.id}`} style={{ "--world": c.hue.bg, "--sig": c.hue.accent } as React.CSSProperties}>
      <div className="cab-screen">
        <Preview id={c.id} />
      </div>
      <div className="cab-body">
        <h2>{c.title}</h2>
        <p className="cab-decision">{c.decision}</p>
        <div className="cab-foot">
          <ul className="cab-tags">
            {c.tags.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <span className="btn primary small">遊ぶ</span>
        </div>
      </div>
    </a>
  );
}

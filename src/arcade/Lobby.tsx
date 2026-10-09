import { CABINETS, type Cabinet } from "./cabinets";
import { Marquee } from "./Marquee";

export function Lobby() {
  return (
    <main className="lobby">
      <header className="lobby-head">
        <p className="lobby-kicker">SANDBOX ARCADE</p>
        <h1>
          判断ひとつで、
          <br />
          勝ち負けが変わる。
        </h1>
        <p className="lobby-lede">3 台のゲーム機。どれも、迷う場面がひとつだけ用意してある。</p>
      </header>
      <ol className="lobby-list">
        {CABINETS.map((c, i) => (
          <li key={c.id}>
            <CabinetCard c={c} n={i + 1} />
          </li>
        ))}
      </ol>
      <footer className="lobby-foot">進行はこのブラウザにだけ保存されます</footer>
    </main>
  );
}

function CabinetCard({ c, n }: { c: Cabinet; n: number }) {
  return (
    <a className="cab" href={`#/${c.id}`} style={{ "--bg": c.hue.bg, "--ink": c.hue.ink, "--accent": c.hue.accent } as React.CSSProperties}>
      <div className="cab-art">
        <Marquee id={c.id} />
        <span className="cab-no">{String(n).padStart(2, "0")}</span>
      </div>
      <div className="cab-body">
        <div className="cab-title">
          <h2>{c.title}</h2>
          <span>{c.reading}</span>
        </div>
        <p className="cab-decision">{c.decision}</p>
        <ul className="cab-tags">
          {c.tags.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
    </a>
  );
}

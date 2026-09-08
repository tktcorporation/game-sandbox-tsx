import { useEffect } from "react";
import { ArcadeBack } from "../../shell/ArcadeBack";
import { ELEMENT_LABEL, STARTERS, speciesOf } from "./species";
import { currentStamina } from "./logic";
import { STAMINA_MAX } from "./types";
import { useTata, type Screen } from "./store";
import { TataSprite } from "./TataSprite";
import { Album } from "./components/Album";
import { BattleView } from "./components/BattleView";
import { Stroll } from "./components/Stroll";
import { Yard } from "./components/Yard";
import "./tata.css";

export default function TataApp({ onLeave }: { onLeave: () => void }) {
  const started = useTata((s) => s.started);
  const screen = useTata((s) => s.screen);
  const toast = useTata((s) => s.toast);
  const setScreen = useTata((s) => s.setScreen);
  const berries = useTata((s) => s.berries);
  const shards = useTata((s) => s.shards);
  const scrap = useTata((s) => s.scrap);
  const stamina = useTata((s) => currentStamina(s));
  const clock = useTata((s) => s.clock);
  const dexOwned = useTata((s) => new Set(s.tatas.map((t) => t.speciesId)).size);
  void clock;

  useEffect(() => {
    if (!started) return;
    const pulse = () => useTata.getState().tick();
    pulse();
    const id = window.setInterval(pulse, 1000);
    return () => window.clearInterval(id);
  }, [started]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => {
      if (useTata.getState().toast?.id === toast.id) useTata.setState({ toast: null });
    }, 2200);
    return () => window.clearTimeout(id);
  }, [toast]);

  if (!started) return <Starter onLeave={onLeave} />;

  return (
    <div className="tata-root">
      <header className="tata-top">
        <ArcadeBack onLeave={onLeave} />
        <div className="res berry">
          <span>きのみ</span>
          <strong>{berries}</strong>
        </div>
        <div className="res shard">
          <span>かけら</span>
          <strong>{shards}</strong>
        </div>
        <div className="res scrap">
          <span>くず</span>
          <strong>{scrap}</strong>
        </div>
        <div className="res stam">
          <span>げんき</span>
          <strong>
            {stamina}/{STAMINA_MAX}
          </strong>
        </div>
      </header>

      <div className="tata-stage">
        {screen === "home" ? <Yard /> : null}
        {screen === "album" ? <Album /> : null}
        {screen === "stroll" ? <Stroll /> : null}
        {screen === "battle" ? <BattleView /> : null}
      </div>

      {toast ? (
        <p className="tata-toast" key={toast.id}>
          {toast.msg}
        </p>
      ) : null}

      <nav className="tata-dock">
        <DockBtn id="home" label="おうち" on={screen === "home"} onPick={setScreen} />
        <DockBtn id="stroll" label="おさんぽ" on={screen === "stroll"} onPick={setScreen} />
        <DockBtn id="battle" label="たたかい" on={screen === "battle"} onPick={setScreen} />
        <DockBtn id="album" label={`ずかん ${dexOwned}`} on={screen === "album"} onPick={setScreen} />
      </nav>
    </div>
  );
}

function DockBtn({
  id,
  label,
  on,
  onPick,
}: {
  id: Screen;
  label: string;
  on: boolean;
  onPick: (s: Screen) => void;
}) {
  return (
    <button type="button" className={on ? "on" : ""} onClick={() => onPick(id)}>
      {label}
    </button>
  );
}

function Starter({ onLeave }: { onLeave: () => void }) {
  const startWith = useTata((s) => s.startWith);
  return (
    <div className="tata-root tata-starter">
      <header className="tata-top">
        <ArcadeBack onLeave={onLeave} />
        <p className="starter-kicker">モンスターサバイバル</p>
      </header>
      <div className="starter-copy">
        <h1>はじめてのタタを選んで。</h1>
        <p>
          100ひき以上のタタが草むらにいる。餌付けして4だんかい進化、陣形を組んでゾンビを払い、おうちを建てよう。ナンモナイシは勝手についてくる。
        </p>
      </div>
      <div className="starter-row">
        {STARTERS.map((id) => {
          const s = speciesOf(id);
          return (
            <button key={id} type="button" className="starter-card" onClick={() => startWith(id)}>
              <TataSprite speciesId={id} stage={1} size={96} mood="happy" />
              <p className={`el-chip el-${s.element}`}>{ELEMENT_LABEL[s.element]}</p>
              <h2>{s.name}</h2>
              <p>{s.blurb}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Frame } from "../../arcade/Frame";
import { dailySeed } from "../../arcade/rng";
import { useSaved } from "../../arcade/save";
import {
  ascend, beginDive, buy, canBuy, descend, finished, HAZARD_NAME, HAZARDS, newRun, newSeed, remaining, SHOP, tier,
  useLantern,
  type Card, type Item, type Run,
} from "./logic";
import "./abyss.css";

interface Save {
  best: number;
  daily: { day: number; best: number };
}

export default function Abyss() {
  const [save, setSave] = useSaved<Save>("abyss", { best: 0, daily: { day: 0, best: 0 } });
  const [run, setRun] = useState<Run | null>(null);
  const [daily, setDaily] = useState(false);
  const shaft = useRef<HTMLOListElement>(null);
  const today = dailySeed();

  const d = run?.current ?? null;
  const done = run ? finished(run) : false;

  useEffect(() => {
    shaft.current?.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [d?.drawn.length]);

  useEffect(() => {
    if (!run || !done) return;
    setSave((v) => ({
      best: Math.max(v.best, run.bank),
      daily: daily ? { day: today, best: v.daily.day === today ? Math.max(v.daily.best, run.bank) : run.bank } : v.daily,
    }));
  }, [done]);

  const start = (isDaily: boolean) => {
    setDaily(isDaily);
    setRun(beginDive(newRun(isDaily ? today : newSeed())));
  };

  if (!run)
    return (
      <Frame title="深淵採掘" className="ab">
        <section className="ab-intro">
          <p className="ab-lede">坑道を 1 枚ずつ潜って宝石を集める。6 回潜った合計が得点になる。</p>
          <ul className="ab-rules">
            <li><b>同じ危険が 2 回</b>出ると崩落し、その潜行で持っていた宝石を失う。</li>
            <li>深いほど宝石の価値が上がる。5 枚目から 2 倍、9 枚目から 3 倍。</li>
            <li>崩落を起こした危険のカードは、以後の潜行から 1 枚抜ける。</li>
          </ul>
          <div className="ab-start">
            <button className="primary" onClick={() => start(false)}>新しい坑道</button>
            <button className="ghost" onClick={() => start(true)}>
              今日の坑道
              <small>{save.daily.day === today && save.daily.best ? `今日の最高 ${save.daily.best}` : "全員同じ並び"}</small>
            </button>
          </div>
          {save.best > 0 && <p className="ab-best">自己最高 {save.best}</p>}
        </section>
      </Frame>
    );

  const left = d ? remaining(d) : null;
  const deadly = d && left ? d.seen.reduce((n, h) => n + left.hazards[h], 0) : 0;
  const shielded = !!d && run.owned.helmet > 0 && !d.helmetUsed;
  const between = !!d?.end && !done;
  const nextTier = d ? tier(d.drawn.length + 1) : 1;

  return (
    <Frame
      title="深淵採掘"
      className="ab"
      right={
        <div className="ab-top">
          <span>{run.dive}/{run.dives}</span>
          <b>{run.bank}</b>
        </div>
      }
    >
      {d && (
        <>
          <ol className="ab-shaft" ref={shaft}>
            <li className="ab-surface">地上</li>
            {d.drawn.map((c, i) => (
              <Row
                key={i}
                card={c}
                depth={i + 1}
                deadlyAt={isDeadlyAt(d.drawn, i)}
                shielded={d.helmetUsed && d.drawn.findIndex((_, j) => isDeadlyAt(d.drawn, j)) === i}
              />
            ))}
            {!d.end && (
              <li className={`ab-next t${nextTier}`}>
                <span className="dep">{d.drawn.length + 1}</span>
                <span className="q">{d.peek === "safe" ? "危険なし" : d.peek === "hazard" ? "危険あり" : "?"}</span>
                <span className="mult">×{nextTier}</span>
              </li>
            )}
          </ol>

          {!d.end && left && (
            <section className="ab-odds" aria-label="残りの山札">
              <div className="ab-odds-head">
                <span>
                  次の 1 枚で崩れるのは <b className={deadly ? "warn" : ""}>{deadly}</b> / {left.total} 枚
                </span>
                <span className="o2">酸素 {d.o2}</span>
              </div>
              <div className="ab-deck">
                <div className="gem">
                  <i />
                  <span>宝石 {left.gems}</span>
                </div>
                {HAZARDS.map((h) => (
                  <div key={h} className={`hz ${d.seen.includes(h) ? "seen" : ""}`}>
                    <span className="pips">{Array.from({ length: 3 - run.removed[h] }, (_, i) => <i key={i} className={i < left.hazards[h] ? "on" : ""} />)}</span>
                    <span>{HAZARD_NAME[h]}</span>
                  </div>
                ))}
              </div>
              {shielded && <p className="ab-shield">鉄兜が 1 回崩落を耐える</p>}
            </section>
          )}

          {!d.end && (
            <div className="ab-actions">
              <button className="ghost" onClick={() => setRun(ascend(run))}>
                引き返す
                <small>+{d.carry} を持ち帰る</small>
              </button>
              <button className="primary" onClick={() => setRun(descend(run))}>
                潜る
                <small>持っている宝石 {d.carry}</small>
              </button>
              {run.owned.lantern > 0 && (
                <button className="lamp" disabled={d.lanternUsed} onClick={() => setRun(useLantern(run))}>
                  照らす
                </button>
              )}
            </div>
          )}

          {d.end && (
            <section className={`ab-result ${d.end}`}>
              <h2>{d.end === "bust" ? "崩落" : d.end === "air" ? "酸素切れで浮上" : "地上へ戻った"}</h2>
              <p>
                {d.end === "bust"
                  ? run.owned.rope
                    ? `命綱で ${d.carry} だけ持ち帰った。`
                    : "持っていた宝石はすべて失った。"
                  : `${d.carry} を持ち帰った。`}
                {d.end === "bust" && " 崩れた危険のカードは山から 1 枚抜けた。"}
              </p>
            </section>
          )}
        </>
      )}

      {between && (
        <section className="ab-shop">
          <h3>補給所 <span>持ち帰った宝石で買う · 得点からは引かれる</span></h3>
          {(Object.keys(SHOP) as Item[]).map((it) => (
            <button key={it} className="ab-item" disabled={!canBuy(run, it)} onClick={() => setRun(buy(run, it))}>
              <span className="n">{SHOP[it].name}</span>
              <span className="t">{SHOP[it].text}</span>
              <span className="c">{run.owned[it] >= SHOP[it].max ? "所持" : SHOP[it].cost}</span>
            </button>
          ))}
          <button className="ab-go" onClick={() => setRun(beginDive(run))}>
            {run.dive + 1} 回目の潜行へ
          </button>
        </section>
      )}

      {done && (
        <section className="ab-final">
          <h2>{run.bank}</h2>
          <p>{daily ? "今日の坑道" : "坑道"}の合計 · 自己最高 {Math.max(save.best, run.bank)}</p>
          <div className="ab-hist">
            {run.history.map((h, i) => (
              <div key={i} className={h.end ?? ""}>
                <i style={{ height: `${Math.min(100, h.carry / 1.6)}%` }} />
                <span>{h.depth}</span>
              </div>
            ))}
          </div>
          <p className="sub">棒は各潜行で持ち帰った量、数字は潜った深さ</p>
          <div className="ab-start">
            <button className="primary" onClick={() => start(false)}>新しい坑道</button>
            <button className="ghost" onClick={() => setRun(null)}>最初の画面へ</button>
          </div>
        </section>
      )}
    </Frame>
  );
}

function isDeadlyAt(drawn: Card[], i: number) {
  const c = drawn[i];
  return c.kind === "hazard" && drawn.slice(0, i).some((p) => p.kind === "hazard" && p.h === c.h);
}

function Row({ card, depth, deadlyAt, shielded }: { card: Card; depth: number; deadlyAt: boolean; shielded: boolean }) {
  const t = tier(depth);
  return (
    <li className={`ab-row t${t} ${card.kind} ${deadlyAt ? (shielded ? "held" : "boom") : ""}`}>
      <span className="dep">{depth}</span>
      {card.kind === "gem" ? (
        <>
          <svg viewBox="0 0 20 20" className="ab-gem" aria-hidden>
            <path d="M10 2l7 6-7 10-7-10z" />
          </svg>
          <span className="v">
            {card.value}
            {t > 1 && <small> ×{t} = {card.value * t}</small>}
          </span>
        </>
      ) : (
        <span className="hzname">{HAZARD_NAME[card.h]}{deadlyAt ? (shielded ? " · 鉄兜で耐えた" : " · 2 回目") : ""}</span>
      )}
    </li>
  );
}

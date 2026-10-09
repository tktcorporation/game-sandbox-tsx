import { useEffect, useRef, useState } from "react";
import { Frame } from "../../arcade/Frame";
import { shake, useCountUp, wait } from "../../arcade/juice";
import { dailySeed } from "../../arcade/rng";
import { useSaved } from "../../arcade/save";
import { sfx } from "../../arcade/sfx";
import {
  ascend, beginDive, buy, canBuy, descend, finished, HAZARD_NAME, HAZARDS, newRun, newSeed, remaining, shareText, SHOP, tier,
  useLantern,
  type Card, type Item, type Run,
} from "./logic";
import "./abyss.css";

interface Save {
  best: number;
  daily: { day: number; best: number };
  seenHint: boolean;
}

const ITEM_GLYPH: Record<Item, string> = { helmet: "兜", rope: "綱", lantern: "灯" };

export default function Abyss() {
  const [save, setSave] = useSaved<Save>("abyss-v2", { best: 0, daily: { day: 0, best: 0 }, seenHint: false });
  const [run, setRun] = useState<Run | null>(null);
  const [daily, setDaily] = useState(false);
  const [flipping, setFlipping] = useState(false);
  const [copied, setCopied] = useState(false);
  const shaft = useRef<HTMLOListElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const today = dailySeed();

  const d = run?.current ?? null;
  const done = run ? finished(run) : false;
  const bank = useCountUp(run?.bank ?? 0, 700);
  const carry = useCountUp(d?.carry ?? 0, 350);

  useEffect(() => {
    shaft.current?.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [d?.drawn.length, flipping]);

  useEffect(() => {
    if (!run || !done) return;
    setSave((v) => ({
      ...v,
      best: Math.max(v.best, run.bank),
      daily: daily ? { day: today, best: v.daily.day === today ? Math.max(v.daily.best, run.bank) : run.bank } : v.daily,
    }));
  }, [done]);

  const start = (isDaily: boolean) => {
    setDaily(isDaily);
    setCopied(false);
    setRun(beginDive(newRun(isDaily ? today : newSeed())));
    sfx.select();
  };

  /** The draw waits a beat face-down before it flips: tension before the reveal (Buckshot Roulette, Wordle). */
  const draw = async () => {
    if (!run || !d || d.end || flipping) return;
    setFlipping(true);
    for (let i = 0; i < 3; i++) {
      sfx.flipTick();
      await wait(110 + i * 40);
    }
    const next = descend(run);
    const nd = next.current!;
    const card = nd.drawn.at(-1)!;
    setFlipping(false);
    setRun(next);
    if (!save.seenHint) setSave((v) => ({ ...v, seenHint: true }));
    if (nd.end === "bust") {
      sfx.bust();
      shake(root.current, 40);
    } else if (card.kind === "gem") {
      sfx.gem(nd.drawn.length + 2);
      shake(root.current, card.value * tier(nd.drawn.length) * 0.2);
      if (nd.end === "air") window.setTimeout(sfx.bank, 300);
    } else {
      sfx.warn();
      shake(root.current, 2);
    }
  };

  const surface = () => {
    if (!run) return;
    setRun(ascend(run));
    sfx.bank();
  };

  const share = async () => {
    if (!run) return;
    const text = shareText(run, daily ? new Date().toISOString().slice(0, 10) : "");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const depth = d?.drawn.length ?? 0;

  if (!run)
    return (
      <Frame title="深淵採掘" className="ab">
        <section className="ab-intro">
          <div className="ab-sample">
            <SampleCard kind="gem" text="宝石 7" />
            <SampleCard kind="hz" text="毒ガス" />
            <SampleCard kind="gem" text="宝石 11" />
            <SampleCard kind="boom" text="毒ガス · 崩落" />
          </div>
          <p className="ab-lede">同じ危険を 2 枚引いたら、持っていた宝石を失う。</p>
          <div className="ab-start">
            <button className="btn primary" onClick={() => start(false)}>
              潜る
              <small>6 回潜った合計</small>
            </button>
            <button className="btn ghost" onClick={() => start(true)}>
              今日の坑道
              <small>{save.daily.day === today && save.daily.best ? `今日の最高 ${save.daily.best}` : "全員が同じ並び"}</small>
            </button>
          </div>
          {save.best > 0 && <p className="ab-best num">自己最高 {save.best}</p>}
        </section>
      </Frame>
    );

  const left = d ? remaining(d) : null;
  const deadly = d && left ? d.seen.reduce((n, h) => n + left.hazards[h], 0) : 0;
  const shielded = !!d && run.owned.helmet > 0 && !d.helmetUsed;
  const between = !!d?.end && !done;
  const nextTier = tier(depth + 1);
  const lostCarry = d?.end === "bust" ? lostAmount(d.drawn) : 0;

  return (
    <Frame
      title="深淵採掘"
      className="ab"
      style={{ "--depth": Math.min(depth, 14) } as React.CSSProperties}
      right={
        <div className="ab-top">
          <span className="num">{run.dive}/{run.dives}</span>
          <b className="num">{bank}</b>
        </div>
      }
    >
      <div ref={root}>
        {d && (
          <ol className="ab-shaft" ref={shaft}>
            <li className="ab-surface">地上</li>
            {d.drawn.map((c, i) => (
              <Row key={i} card={c} depth={i + 1} state={rowState(d.drawn, i, d.helmetUsed, d.end === "bust" && i === d.drawn.length - 1)} />
            ))}
            {!d.end && (
              <li className={`ab-slot ${flipping ? "flipping" : ""} ${d.peek ?? ""}`}>
                <span className="dep num">{depth + 1}</span>
                <span className="back">{d.peek === "safe" ? "危険なし" : d.peek === "hazard" ? "危険あり" : ""}</span>
                <span className="mult num">×{nextTier}</span>
              </li>
            )}
          </ol>
        )}

        {d && !d.end && left && (
          <section className="ab-read" aria-label="残りの山札">
            <div className="ab-odds">
              <div className="danger">
                <span>崩れる札</span>
                <b className={`num ${deadly ? "hot" : ""}`}>{deadly}</b>
                <span className="num">/ {left.total}</span>
              </div>
              <div className="haul">
                <span>今浮上すれば</span>
                <b className="num">+{carry}</b>
              </div>
            </div>
            <div className="ab-deck">
              {HAZARDS.map((h) => (
                <div key={h} className={`hz ${d.seen.includes(h) ? "seen" : ""}`}>
                  <span className="pips">
                    {Array.from({ length: 3 - run.removed[h] }, (_, i) => <i key={i} className={i < left.hazards[h] ? "on" : ""} />)}
                  </span>
                  <span>{HAZARD_NAME[h]}</span>
                </div>
              ))}
              <div className="gem">
                <i />
                <span className="num">宝石 {left.gems}</span>
              </div>
            </div>
            {!save.seenHint && <p className="ab-hint">赤い枠の危険は、もう一度引くと崩落する</p>}
            {shielded && <p className="ab-shield">鉄兜が崩落を 1 回だけ耐える</p>}
          </section>
        )}

        {d?.end && (
          <section className={`ab-result ${d.end === "bust" ? "bust" : "up"}`}>
            <p className="tag">{d.end === "bust" ? "崩落" : d.end === "air" ? "酸素切れで浮上" : "浮上"}</p>
            <p className="amount num">
              {d.end === "bust" && <s>{lostCarry}</s>}
              <b>+{d.carry}</b>
            </p>
            <p className="sub">{d.end === "bust" ? (run.owned.rope ? "命綱で半分を持ち帰った" : "持っていた宝石を失った") + "。崩れた危険は山から 1 枚抜ける" : `${depth} 枚目まで潜った`}</p>
          </section>
        )}
      </div>

      {d && !d.end && (
        <div className="ab-dock">
          {run.owned.lantern > 0 && (
            <button className="btn ghost lamp" disabled={d.lanternUsed || flipping} onClick={() => { setRun(useLantern(run)); sfx.select(); }}>
              探照灯で次を照らす
            </button>
          )}
          <button className="btn ghost" disabled={flipping} onClick={surface}>
            浮上
            <small className="num">+{d.carry} を持ち帰る</small>
          </button>
          <button className="btn primary" disabled={flipping} onClick={draw}>
            潜る ×{nextTier}
            <small className="num">酸素 {d.o2}</small>
          </button>
        </div>
      )}

      {between && (
        <div className="sheet-wrap">
          <div className="sheet ab-shop">
            <h2>補給所</h2>
            <p className="ab-shop-sub">買った分は得点から引かれる。</p>
            <div className="ab-items">
              {(Object.keys(SHOP) as Item[]).map((it) => {
                const owned = run.owned[it] >= SHOP[it].max;
                return (
                  <button key={it} className={`ab-item ${owned ? "owned" : ""}`} disabled={!canBuy(run, it)} onClick={() => { setRun(buy(run, it)); sfx.bank(); }}>
                    <span className="glyph">{ITEM_GLYPH[it]}</span>
                    <span className="n">{SHOP[it].name}</span>
                    <span className="t">{SHOP[it].text}</span>
                    <span className="c num">{owned ? "所持" : `◆ ${SHOP[it].cost}`}</span>
                  </button>
                );
              })}
            </div>
            <button className="btn primary go" onClick={() => { setRun(beginDive(run)); sfx.select(); }}>
              {run.dive + 1} 回目の潜行へ
              <small className="num">持ち帰った合計 {run.bank}</small>
            </button>
          </div>
        </div>
      )}

      {done && (
        <div className="sheet-wrap">
          <div className="sheet ab-final">
            <p className="tag">{daily ? "今日の坑道" : "坑道"}の合計</p>
            <h2 className="num">{bank}</h2>
            <div className="ab-hist">
              {run.history.map((h, i) => (
                <div key={i} className={h.end === "bust" ? "bust" : ""}>
                  <i style={{ height: `${Math.max(4, Math.min(100, h.carry / 1.6))}%` }} />
                  <span className="num">{h.carry}</span>
                </div>
              ))}
            </div>
            <p className="sub num">自己最高 {Math.max(save.best, run.bank)}</p>
            <div className="row">
              <button className="btn ghost" onClick={share}>{copied ? "コピーした" : "結果をコピー"}</button>
              <button className="btn primary" onClick={() => start(daily)}>もう一度潜る</button>
            </div>
          </div>
        </div>
      )}
    </Frame>
  );
}

function lostAmount(drawn: Card[]): number {
  return drawn.reduce((n, c, i) => n + (c.kind === "gem" ? c.value * tier(i + 1) : 0), 0);
}

type RowState = "plain" | "boom" | "held";
function rowState(drawn: Card[], i: number, helmetUsed: boolean, isBust: boolean): RowState {
  const c = drawn[i];
  const dup = c.kind === "hazard" && drawn.slice(0, i).some((p) => p.kind === "hazard" && p.h === c.h);
  if (!dup) return "plain";
  if (isBust) return "boom";
  return helmetUsed ? "held" : "plain";
}

function Row({ card, depth, state }: { card: Card; depth: number; state: RowState }) {
  const t = tier(depth);
  return (
    <li className={`ab-row t${t} ${card.kind} ${state}`}>
      <span className="dep num">{depth}</span>
      {card.kind === "gem" ? (
        <>
          <i className="gemi" />
          <span className="v num">
            {card.value}
            {t > 1 && <small> ×{t}</small>}
          </span>
          <span className="sum num">+{card.value * t}</span>
        </>
      ) : (
        <span className="hzname">
          {HAZARD_NAME[card.h]}
          {state === "boom" ? " · 崩落" : state === "held" ? " · 鉄兜で耐えた" : ""}
        </span>
      )}
    </li>
  );
}

function SampleCard({ kind, text }: { kind: "gem" | "hz" | "boom"; text: string }) {
  return <div className={`ab-row ${kind === "gem" ? "gem" : "hazard"} ${kind === "boom" ? "boom" : ""}`}>{kind === "gem" ? <><i className="gemi" /><span className="v">{text}</span></> : <span className="hzname">{text}</span>}</div>;
}

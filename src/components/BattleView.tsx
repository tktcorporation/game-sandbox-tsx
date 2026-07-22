import { useEffect, useRef, useState } from "react";
import { useGame } from "../game/store";
import { SPECIES } from "../game/species";
import type { BattleResult, SquadMonster } from "../game/types";

type Phase = "loading" | "preview" | "battling" | "result" | "error";

function MonsterChip({ m }: { m: SquadMonster }) {
  const def = SPECIES[m.speciesId];
  return (
    <div className={`monster-chip elem-${def.element}`}>
      <div className="big">{def.emoji}</div>
      <div className="nm">{def.name}</div>
      <div className="lim">
        ❤️{m.hp} ⚔️{m.atk} 🛡️{m.def}
      </div>
    </div>
  );
}

export function BattleView({ onExit }: { onExit: () => void }) {
  const fetchOpponent = useGame((s) => s.fetchOpponent);
  const resolveBattle = useGame((s) => s.resolveBattle);
  const opponent = useGame((s) => s.opponent);

  const [phase, setPhase] = useState<Phase>("loading");
  const [result, setResult] = useState<BattleResult | null>(null);
  const [visibleLines, setVisibleLines] = useState(0);
  const logRef = useRef<HTMLDivElement | null>(null);

  // The squad snapshot the match ticket is pinned against — not live colonies, which keep
  // growing via the idle loop while the player sits on this preview. Showing anything else here
  // could display a different squad than the one resolveBattle/the server will actually use.
  const mySquad = opponent?.mySquad ?? [];

  useEffect(() => {
    let cancelled = false;
    fetchOpponent().then((op) => {
      if (cancelled) return;
      setPhase(op ? "preview" : "error");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== "battling" || !result) return;
    if (visibleLines >= result.log.length) {
      setPhase("result");
      return;
    }
    const t = setTimeout(() => setVisibleLines((v) => v + 1), 260);
    return () => clearTimeout(t);
  }, [phase, visibleLines, result]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [visibleLines]);

  const startBattle = async () => {
    if (!opponent) return;
    setPhase("battling");
    setVisibleLines(0);
    const r = await resolveBattle(opponent);
    setResult(r);
  };

  return (
    <div className="battle-view">
      <div className="battle-header">
        <button className="btn ghost" onClick={onExit}>
          ← もどる
        </button>
        <h2>対戦</h2>
      </div>

      {phase === "loading" && <p className="hint center">対戦相手を探しています…</p>}
      {phase === "error" && (
        <>
          <p className="hint center">対戦相手が見つかりませんでした。</p>
          <button className="btn gold" onClick={onExit}>
            もどる
          </button>
        </>
      )}

      {(phase === "preview" || phase === "battling" || phase === "result") && opponent && (
        <div className="battle-lanes">
          <div className="lane">
            <h3>あなた</h3>
            <div className="lane-monsters">
              {mySquad.map((m, i) => (
                <MonsterChip key={i} m={m} />
              ))}
            </div>
          </div>
          <div className="lane-vs">VS</div>
          <div className="lane">
            <h3>
              {opponent.name} (🏆{opponent.rating})
            </h3>
            <div className="lane-monsters">
              {opponent.monsters.map((m, i) => (
                <MonsterChip key={i} m={m} />
              ))}
            </div>
          </div>
        </div>
      )}

      {phase === "preview" && (
        <button className="btn gold big-btn" onClick={startBattle}>
          🗡️ たたかう
        </button>
      )}

      {(phase === "battling" || phase === "result") && result && (
        <div className="battle-log" ref={logRef}>
          {result.log.slice(0, visibleLines).map((line, i) => (
            <div key={i} className={`log-line ${line.side}`}>
              {line.text}
            </div>
          ))}
        </div>
      )}

      {phase === "result" && result && (
        <div className="battle-result">
          <div className={`result-banner ${result.won ? "win" : "lose"}`}>{result.won ? "勝利!" : "敗北…"}</div>
          <div className="hint center">獲得 ✨{result.reward}</div>
          <button className="btn gold big-btn" onClick={onExit}>
            もどる
          </button>
        </div>
      )}
    </div>
  );
}

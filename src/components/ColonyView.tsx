import { useGame } from "../game/store";
import { formatNumber } from "../game/logic";
import { SPECIES, capOf } from "../game/species";

const ELEMENT_LABEL: Record<string, string> = {
  neutral: "無属性",
  water: "水",
  fire: "火",
  earth: "土",
  light: "光",
};

export function ColonyView() {
  const colonies = useGame((s) => s.colonies);
  const nestLevel = useGame((s) => s.nestLevel);

  const sorted = [...colonies].sort((a, b) => {
    const ta = SPECIES[a.speciesId].tier;
    const tb = SPECIES[b.speciesId].tier;
    return ta !== tb ? ta - tb : a.speciesId.localeCompare(b.speciesId);
  });

  return (
    <div className="colony-view">
      <p className="hint">巣の中で群れが増え、育ち、集まると別の種類に進化します。</p>
      <div className="colony-grid">
        {sorted.map((c) => {
          const def = SPECIES[c.speciesId];
          const cap = capOf(c.speciesId, nestLevel);
          const mature = c.growth >= 1;
          const readyToEvolve = def.evolvesTo.length > 0 && mature && c.count >= def.evolveThreshold;
          return (
            <div key={c.speciesId} className={`colony-card elem-${def.element} ${readyToEvolve ? "ready" : ""}`}>
              <div className="colony-emoji">{def.emoji}</div>
              <div className="colony-name">{def.name}</div>
              <div className="colony-elem">{ELEMENT_LABEL[def.element]} · Tier {def.tier}</div>
              <div className="track">
                <div className="fill pop" style={{ width: `${Math.min(100, (c.count / cap) * 100)}%` }} />
              </div>
              <div className="colony-count">
                {formatNumber(c.count)} / {formatNumber(cap)}
              </div>
              <div className="track thin">
                <div className="fill growth" style={{ width: `${Math.min(100, c.growth * 100)}%` }} />
              </div>
              <div className="colony-status">
                {def.evolvesTo.length === 0
                  ? "最終形態"
                  : readyToEvolve
                    ? "まもなく進化…"
                    : mature
                      ? `あと ${Math.max(0, Math.ceil(def.evolveThreshold - c.count))} で進化判定`
                      : "成長中…"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

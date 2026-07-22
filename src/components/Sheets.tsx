import { type ReactNode, useEffect, useState } from "react";
import { useGame } from "../game/store";
import { colonyOf, formatNumber } from "../game/logic";
import { SPECIES, SPECIES_LIST, nestUpgradeCost } from "../game/species";
import type { SpeciesId } from "../game/types";
import { useUi } from "../ui";

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>
          {title}
          <button onClick={onClose}>✕</button>
        </h2>
        {children}
      </div>
    </div>
  );
}

export function Dex({ onClose }: { onClose: () => void }) {
  const dex = useGame((s) => s.dex);
  const colonies = useGame((s) => s.colonies);
  const discovered = new Set(dex);
  const sorted = [...SPECIES_LIST].sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.name.localeCompare(b.name)));

  return (
    <Sheet title={`📖 図鑑 (${dex.length}/${SPECIES_LIST.length})`} onClose={onClose}>
      <div className="dex-grid">
        {sorted.map((def) => {
          const known = discovered.has(def.id);
          const owned = colonyOf(colonies, def.id)?.count ?? 0;
          return (
            <div key={def.id} className={`dex-card ${known ? "" : "locked"}`}>
              <div className="big">{known ? def.emoji : "❓"}</div>
              <div className="nm">{known ? def.name : "???"}</div>
              {known && (
                <div className="lim">
                  ❤️{def.baseStats.hp} ⚔️{def.baseStats.atk} 🛡️{def.baseStats.def}
                  <br />
                  所有 {formatNumber(owned)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}

export function SquadBuilder({ onClose }: { onClose: () => void }) {
  const dex = useGame((s) => s.dex);
  const colonies = useGame((s) => s.colonies);
  const squad = useGame((s) => s.squad);
  const setSquad = useGame((s) => s.setSquad);
  const syncSquad = useGame((s) => s.syncSquad);
  const showToast = useUi((s) => s.showToast);
  const [draft, setDraft] = useState<SpeciesId[]>(squad);

  const owned = dex.filter((id) => (colonyOf(colonies, id)?.count ?? 0) >= 1);

  const toggle = (id: SpeciesId) => {
    setDraft((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (cur.length >= 5) return cur;
      return [...cur, id];
    });
  };

  return (
    <Sheet title={`⚔️ チーム編成 (${draft.length}/5)`} onClose={onClose}>
      <p className="hint">対戦に出す仲間を最大5体まで選んでください。</p>
      <div className="dex-grid">
        {owned.map((id) => {
          const def = SPECIES[id];
          const selected = draft.includes(id);
          return (
            <button
              key={id}
              className={`dex-card selectable ${selected ? "selected" : ""}`}
              onClick={() => toggle(id)}
            >
              <div className="big">{def.emoji}</div>
              <div className="nm">{def.name}</div>
              <div className="lim">
                ❤️{def.baseStats.hp} ⚔️{def.baseStats.atk} 🛡️{def.baseStats.def}
              </div>
            </button>
          );
        })}
      </div>
      <button
        className="btn gold"
        style={{ marginTop: 12 }}
        onClick={async () => {
          setSquad(draft);
          await syncSquad();
          showToast("チームを保存しました");
          onClose();
        }}
      >
        保存
      </button>
    </Sheet>
  );
}

export function Leaderboard({ onClose }: { onClose: () => void }) {
  const leaderboard = useGame((s) => s.leaderboard);
  const fetchLeaderboard = useGame((s) => s.fetchLeaderboard);
  const playerId = useGame((s) => s.playerId);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchLeaderboard().finally(() => setLoading(false));
  }, [fetchLeaderboard]);

  return (
    <Sheet title="🏆 ランキング" onClose={onClose}>
      {loading && <p className="hint">読み込み中…</p>}
      {!loading && leaderboard.length === 0 && <p className="hint">まだ誰もランクインしていません。</p>}
      <div className="leaderboard-list">
        {leaderboard.map((e, i) => (
          <div key={e.id} className={`leaderboard-row ${e.id === playerId ? "me" : ""}`}>
            <span className="rank">#{i + 1}</span>
            <span className="nm">{e.name}</span>
            <span className="rating">🏆 {formatNumber(e.rating)}</span>
            <span className="power">⚔️ {formatNumber(e.power)}</span>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

export function Settings({ onClose }: { onClose: () => void }) {
  const playerName = useGame((s) => s.playerName);
  const setPlayerName = useGame((s) => s.setPlayerName);
  const syncSquad = useGame((s) => s.syncSquad);
  const reset = useGame((s) => s.reset);
  const nestLevel = useGame((s) => s.nestLevel);
  const shineStones = useGame((s) => s.shineStones);
  const upgradeNest = useGame((s) => s.upgradeNest);
  const showToast = useUi((s) => s.showToast);
  const [name, setName] = useState(playerName);
  const cost = nestUpgradeCost(nestLevel);

  return (
    <Sheet title="⚙️ 設定" onClose={onClose}>
      <div className="info-row">
        <span>巣のレベル</span>
        <span>{nestLevel}</span>
      </div>
      <button
        className="btn gold"
        onClick={() => {
          const r = upgradeNest();
          showToast(r.ok ? "巣を拡張しました!" : (r.reason ?? "拡張できません"));
        }}
        disabled={shineStones < cost}
      >
        巣を拡張 (✨{formatNumber(cost)})
      </button>

      <p className="hint" style={{ marginTop: 14 }}>
        トレーナー名
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="text-input"
          value={name}
          maxLength={24}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="btn ghost"
          onClick={async () => {
            setPlayerName(name);
            await syncSquad();
            showToast("プレイヤー情報を更新しました");
          }}
        >
          保存
        </button>
      </div>

      <button
        className="btn ghost"
        style={{ marginTop: 16 }}
        onClick={() => {
          if (confirm("最初からやり直しますか?この操作は取り消せません。")) reset();
        }}
      >
        ♻️ 最初からやり直す
      </button>
    </Sheet>
  );
}

import { useMemo } from "react";
import { FURNITURE, FURNITURE_ORDER } from "../furniture";
import { canPlaceFurniture } from "../logic";
import { ELEMENT_LABEL, STAGE_LABEL, speciesOf } from "../species";
import { useTata } from "../store";
import { FurnitureSprite, TataSprite } from "../TataSprite";
import type { OwnedTata } from "../types";
import { YARD_H, YARD_W } from "../types";
import { canEvolve, feedCost, labelTata, tataAtk, tataHp } from "../logic";
import { POWER_COST, POWER_MAX, STAGE_XP } from "../types";

export function Yard() {
  const furniture = useTata((s) => s.furniture);
  const tatas = useTata((s) => s.tatas);
  const buildId = useTata((s) => s.buildId);
  const selectedUid = useTata((s) => s.selectedUid);
  const clock = useTata((s) => s.clock);
  const place = useTata((s) => s.place);
  const select = useTata((s) => s.select);
  const setBuild = useTata((s) => s.setBuild);
  const scrap = useTata((s) => s.scrap);

  const cells = useMemo(() => {
    const list: { x: number; y: number }[] = [];
    for (let y = 0; y < YARD_H; y++) for (let x = 0; x < YARD_W; x++) list.push({ x, y });
    return list;
  }, []);

  return (
    <div className="tata-yard-wrap">
      <div className="tata-sky" aria-hidden>
        <span className="tata-sun" />
        <span className="tata-hill" />
      </div>
      <div
        className="tata-yard"
        style={{ gridTemplateColumns: `repeat(${YARD_W}, 1fr)`, gridTemplateRows: `repeat(${YARD_H}, 1fr)` }}
      >
        {cells.map((c) => {
          const occupant = furniture.find((f) => {
            const def = FURNITURE[f.type];
            return c.x >= f.x && c.x < f.x + def.w && c.y >= f.y && c.y < f.y + def.h && !(c.x === f.x && c.y === f.y);
          });
          const origin = furniture.find((f) => f.x === c.x && c.y === f.y);
          const ok = buildId ? canPlaceFurniture(furniture, buildId, c.x, c.y) : false;
          return (
            <button
              key={`${c.x}-${c.y}`}
              type="button"
              className={`tata-cell${origin ? ` furn-${origin.type}` : ""}${occupant ? " occupied" : ""}${buildId && ok ? " drop-ok" : ""}${buildId && !ok ? " drop-no" : ""}`}
              onClick={() => {
                if (buildId) place(c.x, c.y);
                else select(null);
              }}
            >
              {origin ? (
                <span className="furn-hold" style={{ width: `${FURNITURE[origin.type].w * 100}%` }}>
                  <FurnitureSprite type={origin.type} size={40} />
                </span>
              ) : null}
            </button>
          );
        })}
        {tatas.map((t) => (
          <YardTata key={t.uid} tata={t} clock={clock} selected={selectedUid === t.uid} onPick={() => select(t.uid)} />
        ))}
      </div>

      <div className="tata-build-tray">
        {FURNITURE_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            className={`build-chip${buildId === id ? " on" : ""}`}
            onClick={() => setBuild(buildId === id ? null : id)}
          >
            <FurnitureSprite type={id} size={28} />
            <span>{FURNITURE[id].name}</span>
            <em>{FURNITURE[id].scrap}</em>
          </button>
        ))}
        <p className="build-hint">
          {buildId ? `${FURNITURE[buildId].blurb} くず ${scrap}` : "家具を選んで芝生をタッチ。くずで建てる。"}
        </p>
      </div>

      {selectedUid ? <Inspect uid={selectedUid} /> : null}
    </div>
  );
}

function YardTata({
  tata,
  clock,
  selected,
  onPick,
}: {
  tata: OwnedTata;
  clock: number;
  selected: boolean;
  onPick: () => void;
}) {
  const furniture = useTata((s) => s.furniture);
  const pool = furniture.find((f) => f.type === "pool");
  const spec = speciesOf(tata.speciesId);
  const hash = hashUid(tata.uid);
  const inPool = spec.id === "nekoori" && pool;
  const px = inPool
    ? ((pool.x + 0.6) / YARD_W) * 100
    : 8 + ((hash % 80) + Math.sin(clock / 900 + hash) * 6);
  const py = inPool
    ? ((pool.y + 0.3) / YARD_H) * 100
    : 18 + (((hash >> 5) % 62) + Math.cos(clock / 1100 + hash) * 5);
  return (
    <button
      type="button"
      className={`yard-tata${selected ? " on" : ""}${inPool ? " swimming" : ""}`}
      style={{ left: `${px}%`, top: `${py}%` }}
      onClick={(e) => {
        e.stopPropagation();
        onPick();
      }}
    >
      <TataSprite speciesId={tata.speciesId} stage={tata.stage} shiny={tata.shiny} size={52} mood={inPool ? "happy" : "idle"} />
    </button>
  );
}

function Inspect({ uid }: { uid: string }) {
  const tata = useTata((s) => s.tatas.find((t) => t.uid === uid));
  const feed = useTata((s) => s.feed);
  const power = useTata((s) => s.power);
  const pet = useTata((s) => s.pet);
  const setParty = useTata((s) => s.setParty);
  const select = useTata((s) => s.select);
  const berries = useTata((s) => s.berries);
  const shards = useTata((s) => s.shards);
  const furniture = useTata((s) => s.furniture);
  const lantern = furniture.some((f) => f.type === "lantern");
  if (!tata) return null;
  const spec = speciesOf(tata.speciesId);
  const need = STAGE_XP[tata.stage];
  const cost = feedCost({ ...useTata.getState(), furniture });
  return (
    <aside className="tata-sheet">
      <button type="button" className="sheet-x" onClick={() => select(null)}>
        とじる
      </button>
      <div className="sheet-hero">
        <TataSprite speciesId={tata.speciesId} stage={tata.stage} shiny={tata.shiny} size={88} mood="happy" />
        <div>
          <p className={`el-chip el-${spec.element}`}>{ELEMENT_LABEL[spec.element]}</p>
          <h3>{labelTata(tata)}</h3>
          <p className="sheet-blurb">{spec.blurb}</p>
        </div>
      </div>
      <dl className="sheet-stats">
        <div>
          <dt>たいりょく</dt>
          <dd>{tataHp(tata)}</dd>
        </div>
        <div>
          <dt>こうげき</dt>
          <dd>{tataAtk(tata, lantern)}</dd>
        </div>
        <div>
          <dt>だんかい</dt>
          <dd>{STAGE_LABEL[tata.stage]}</dd>
        </div>
        <div>
          <dt>なつき</dt>
          <dd>{tata.bond}</dd>
        </div>
      </dl>
      {tata.stage < 3 ? (
        <p className="xp-line">
          しんかまで {tata.xp}/{need}
          {canEvolve(tata) ? " えさをあげて進化！" : ""}
        </p>
      ) : (
        <p className="xp-line">{tata.shiny ? "ピカピカ形態 解放ずみ" : "かくせい済み。ピカピカはまだ…"}</p>
      )}
      <div className="sheet-actions">
        <button type="button" className="btn-hero" onClick={() => feed(uid)}>
          えさやり <small>きのみ {cost}/{berries}</small>
        </button>
        <button type="button" className="btn-sub" onClick={() => power(uid)} disabled={tata.power >= POWER_MAX}>
          パワーアップ <small>かけら {POWER_COST}/{shards} · {tata.power}/{POWER_MAX}</small>
        </button>
        <button type="button" className="btn-sub" onClick={() => pet(uid)}>
          ふれあい
        </button>
      </div>
      <div className="party-row">
        <span>じんけい</span>
        {([0, 1, 2] as const).map((slot) => (
          <button
            key={slot}
            type="button"
            className={tata.partySlot === slot ? "on" : ""}
            onClick={() => setParty(uid, tata.partySlot === slot ? null : slot)}
          >
            {slot === 2 ? "うしろ" : slot === 0 ? "まえ左" : "まえ右"}
          </button>
        ))}
      </div>
    </aside>
  );
}

function hashUid(uid: string): number {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 33 + uid.charCodeAt(i)) | 0;
  return Math.abs(h);
}


import type { ReactNode } from "react";
import { BUILD_ORDER, BUILDINGS, TROOP_ORDER, TROOPS } from "../game/buildings";
import { useGame } from "../game/store";
import {
  armyHousing,
  capacityOf,
  countOfType,
  formatDuration,
  formatNumber,
  limitForType,
  townHallLevel,
} from "../game/logic";
import type { Cost } from "../game/types";
import { useUi } from "../ui";
import {
  BUILDING_ICON,
  BUILDING_TONE,
  GameIcon,
  IconText,
  RESOURCE_ICON,
  TROOP_ICON,
  TROOP_TONE,
} from "../ui/icons";

function Sheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>
          <span className="sheet-title">{title}</span>
          <button onClick={onClose} aria-label="Close">
            <GameIcon name="close" size={16} tone="cream" />
          </button>
        </h2>
        {children}
      </div>
    </div>
  );
}

function CostLabel({ cost }: { cost: Cost }) {
  return (
    <span className="cost-line">
      {cost.gold ? (
        <span className="ct gold">
          <IconText icon="gold" tone="gold" size={13}>
            {formatNumber(cost.gold)}
          </IconText>
        </span>
      ) : null}
      {cost.elixir ? (
        <span className="ct elixir">
          <IconText icon="elixir" tone="elixir" size={13}>
            {formatNumber(cost.elixir)}
          </IconText>
        </span>
      ) : null}
    </span>
  );
}

export function Shop({ onClose }: { onClose: () => void }) {
  const buildings = useGame((s) => s.buildings);
  const placeBuilding = useGame((s) => s.placeBuilding);
  const showToast = useUi((s) => s.showToast);
  const th = townHallLevel(buildings);

  return (
    <Sheet
      title={
        <>
          <GameIcon name="build" size={22} tone="gold" />
          Build
        </>
      }
      onClose={onClose}
    >
      <p className="hint">Buildings are placed automatically — drag them around on the map.</p>
      <div className="shop-grid">
        {BUILD_ORDER.filter((t) => t !== "townhall").map((type) => {
          const def = BUILDINGS[type];
          const locked = def.requiredTh > th;
          const count = countOfType(buildings, type);
          const limit = limitForType(buildings, type);
          const atLimit = count >= limit;
          const cost = def.cost(1);
          return (
            <button
              key={type}
              className={`shop-card ${locked || atLimit ? "locked" : ""}`}
              disabled={locked}
              onClick={() => {
                const r = placeBuilding(type);
                if (!r.ok) showToast(r.reason ?? "Cannot build");
                else showToast(`${def.name} placed!`);
              }}
            >
              <div className="big">
                <GameIcon name={BUILDING_ICON[type]} size={32} tone={BUILDING_TONE[type]} />
              </div>
              <div className="nm">{def.name}</div>
              {locked ? (
                <div className="lim">
                  <IconText icon="lock" size={11}>
                    Town Hall {def.requiredTh}
                  </IconText>
                </div>
              ) : (
                <>
                  <CostLabel cost={cost} />
                  <div className="lim">
                    {count}/{limit}
                  </div>
                </>
              )}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

export function Army({ onClose }: { onClose: () => void }) {
  const state = useGame();
  const trainTroop = useGame((s) => s.trainTroop);
  const showToast = useUi((s) => s.showToast);
  const housing = armyHousing(state);
  const hasBarracks = state.buildings.some((b) => b.type === "barracks" && !b.upgradeDoneAt);

  return (
    <Sheet
      title={
        <>
          <GameIcon name="army" size={22} tone="ember" />
          Train Army ({housing.used}/{housing.total})
        </>
      }
      onClose={onClose}
    >
      {!hasBarracks && <p className="hint">Build & finish a Barracks to train troops.</p>}
      <div className="shop-grid">
        {TROOP_ORDER.map((type) => {
          const t = TROOPS[type];
          return (
            <button
              key={type}
              className="shop-card"
              disabled={!hasBarracks}
              onClick={() => {
                const r = trainTroop(type);
                if (!r.ok) showToast(r.reason ?? "Cannot train");
              }}
            >
              <div className="big">
                <GameIcon name={TROOP_ICON[type]} size={32} tone={TROOP_TONE[type]} />
              </div>
              <div className="nm">
                {t.name} ×{state.army[type]}
              </div>
              <CostLabel cost={t.cost} />
              <div className="lim">
                <IconText icon="hp" size={11}>
                  {t.hp}
                </IconText>
                <span>·</span>
                <IconText icon="dps" size={11}>
                  {t.dps}
                </IconText>
                <span>·</span>
                <IconText icon="housing" size={11}>
                  {t.housing}
                </IconText>
              </div>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

export function BuildingInfo({ id, onClose }: { id: string; onClose: () => void }) {
  const buildings = useGame((s) => s.buildings);
  const upgradeBuilding = useGame((s) => s.upgradeBuilding);
  const showToast = useUi((s) => s.showToast);
  const b = buildings.find((x) => x.id === id);
  if (!b) return null;
  const def = BUILDINGS[b.type];
  const maxed = b.level >= def.maxLevel;
  const next = b.level + 1;
  const cost = maxed ? null : def.cost(next);

  return (
    <Sheet
      title={
        <>
          <GameIcon name={BUILDING_ICON[b.type]} size={22} tone={BUILDING_TONE[b.type]} />
          {def.name}
        </>
      }
      onClose={onClose}
    >
      <div className="info-row">
        <span>Level</span>
        <span>
          {b.level}
          {!maxed ? ` → ${next}` : " (MAX)"}
        </span>
      </div>
      {def.production && (
        <>
          <div className="info-row">
            <span>Produces</span>
            <span>
              <IconText icon={RESOURCE_ICON[def.production.resource]} tone={def.production.resource} size={14}>
                {def.production.perMin(b.level)}/min
              </IconText>
            </span>
          </div>
          <div className="info-row">
            <span>Capacity</span>
            <span>{formatNumber(def.production.cap(b.level))}</span>
          </div>
        </>
      )}
      {def.storage && (
        <div className="info-row">
          <span>Stores</span>
          <span>
            <IconText icon={RESOURCE_ICON[def.storage.resource]} tone={def.storage.resource} size={14}>
              {formatNumber(def.storage.capacity(b.level))}
            </IconText>
          </span>
        </div>
      )}
      {def.defense && def.defense.range > 0 && (
        <>
          <div className="info-row">
            <span>Damage</span>
            <span>{def.defense.dps(b.level)} dps</span>
          </div>
          <div className="info-row">
            <span>Hitpoints / Range</span>
            <span>
              <IconText icon="hp" size={14}>
                {def.defense.hp(b.level)}
              </IconText>
              <span> · {def.defense.range} tiles</span>
            </span>
          </div>
        </>
      )}
      {def.housing && (
        <div className="info-row">
          <span>Housing space</span>
          <span>
            <IconText icon="housing" size={14}>
              {def.housing(b.level)}
            </IconText>
          </span>
        </div>
      )}

      {b.upgradeDoneAt ? (
        <p className="hint">
          <IconText icon="constructing" size={14}>
            Under construction…
          </IconText>
        </p>
      ) : maxed ? (
        <button className="btn ghost" disabled>
          Max level reached
        </button>
      ) : (
        <button
          className="btn gold"
          onClick={() => {
            const r = upgradeBuilding(b.id);
            if (!r.ok) showToast(r.reason ?? "Cannot upgrade");
            else {
              showToast(`Upgrading to level ${next}`);
              onClose();
            }
          }}
        >
          <IconText icon="upgrade" size={16}>
            Upgrade
          </IconText>
          {cost && (
            <>
              <span style={{ marginLeft: 4 }} />
              <CostLabel cost={cost} />
            </>
          )}
          <span style={{ opacity: 0.8, marginLeft: 6 }}>({formatDuration(def.buildTime(next))})</span>
        </button>
      )}
    </Sheet>
  );
}

export function HelpReset() {
  const reset = useGame((s) => s.reset);
  const grantGems = useGame((s) => s.grantGems);
  const buildings = useGame((s) => s.buildings);
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
      <button
        className="btn ghost"
        onClick={() => {
          if (confirm("Reset your village? This cannot be undone.")) reset();
        }}
      >
        <IconText icon="reset" size={14}>
          Reset village
        </IconText>
      </button>
      <button className="btn ghost" onClick={() => grantGems(250)}>
        <IconText icon="gems" tone="gem" size={14}>
          +250 gems
        </IconText>
      </button>
      <span className="cap-note">
        Cap{" "}
        <IconText icon="gold" tone="gold" size={12}>
          {formatNumber(capacityOf(buildings, "gold"))}
        </IconText>
      </span>
    </div>
  );
}

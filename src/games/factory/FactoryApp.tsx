import { ArcadeBack } from "../../shell/ArcadeBack";
import { FactoryCanvas } from "./FactoryCanvas";
import { factoryGoal, factoryThroughput, useFactory } from "./store";
import { toolHint, toolLabel, TOOL_ORDER } from "./logic";
import { currentOrder, isToolUnlocked } from "./progress";
import { ITEM_LOOK, MACHINE_SPEC, machineStatus, recipeLine } from "./recipes";
import {
  exportValue,
  itemLabel,
  machineAtCell,
  machineCost,
  machineName,
  type ItemKind,
  type MachineKind,
  type PlacementTool,
} from "./types";
import { foundrySound } from "./sound";
import "./factory.css";

export default function FactoryApp({ onLeave }: { onLeave: () => void }) {
  const money = useFactory((s) => s.money);
  const exported = useFactory((s) => s.totalExported);
  const tool = useFactory((s) => s.tool);
  const log = useFactory((s) => s.log);
  const selected = useFactory((s) => s.selected);
  const grid = useFactory((s) => s.grid);
  const clock = useFactory((s) => s.clock);
  const reset = useFactory((s) => s.reset);
  const tryTool = useFactory((s) => s.tryTool);
  const toggleMiner = useFactory((s) => s.toggleMiner);
  const copperUnlocked = useFactory((s) => s.copperUnlocked);
  const contractsCompleted = useFactory((s) => s.contractsCompleted);
  const honorFlash = useFactory((s) => s.honorFlash);
  const lastHonor = useFactory((s) => s.lastHonor);
  const goal = factoryGoal();
  const rate = factoryThroughput();
  const lastLog = log[log.length - 1] ?? "";
  const inspect = selected ? machineAtCell(grid, selected.x, selected.y) : null;
  void clock;

  return (
    <div className="foundry-root">
      <header className="foundry-top">
        <ArcadeBack onLeave={onLeave} />
        <p className="foundry-bay">Bay A · Shift {contractsCompleted + 1}</p>
        <div className="foundry-stat coin">
          <span className="k">Coin</span>
          <strong>${money}</strong>
        </div>
        <div className="foundry-stat">
          <span className="k">Shipped</span>
          <strong>{exported}</strong>
        </div>
        <div className="foundry-stat">
          <span className="k">Flow</span>
          <strong>{rate.toFixed(1)}/s</strong>
        </div>
        <p className="foundry-goal">{goal}</p>
        <button type="button" className="foundry-reset" onClick={reset}>
          Reset floor
        </button>
      </header>

      <OrderTicket />
      {honorFlash > 18 && lastHonor ? <p className="foundry-honor">{lastHonor}</p> : null}

      <div className="foundry-stage">
        <FactoryCanvas />
        {inspect ? (
          <aside className="foundry-inspect">
            <h3>{machineName(inspect.kind)}</h3>
            <p className="foundry-recipe">{recipeLine(inspect.kind, inspect.mode)}</p>
            <IoRow kind={inspect.kind} />
            <p className={`foundry-status ${machineStatus(inspect).id}`}>
              {machineStatus(inspect).label}
            </p>
            {inspect.kind === "fabricator" ? (
              <p className="muted">
                Iron plate {inspect.inputBuffer.filter((i) => i === "ironPlate").length} · copper
                plate {inspect.inputBuffer.filter((i) => i === "copperPlate").length}
              </p>
            ) : (
              <p className="muted">
                In {inspect.inputBuffer.length} · out {inspect.outputBuffer.length}
              </p>
            )}
            {inspect.kind === "miner" ? (
              <button
                type="button"
                onClick={() => {
                  if (selected) toggleMiner(selected.x, selected.y);
                }}
              >
                Vein: {inspect.mode === "iron" ? "iron" : "copper"}
                {!copperUnlocked ? " (locked)" : ""}
              </button>
            ) : null}
            <p className="muted">Worked {inspect.statProduced} pieces.</p>
          </aside>
        ) : null}
      </div>

      <SpecRail />

      <p className="foundry-log">{lastLog}</p>
      <p className="foundry-hint">{toolHint(tool)}</p>

      <nav className="foundry-dock">
        <ToolBtn id="none" active={tool === "none"} onPick={tryTool} cost={null} />
        {TOOL_ORDER.map((id) => (
          <ToolBtn
            key={id}
            id={id}
            active={tool === id}
            onPick={tryTool}
            cost={id === "belt" ? 2 : id === "delete" || id === "none" ? null : machineCost(id)}
          />
        ))}
      </nav>
    </div>
  );
}

function OrderTicket() {
  const contractsCompleted = useFactory((s) => s.contractsCompleted);
  const contractProgress = useFactory((s) => s.contractProgress);
  const order = currentOrder({ contractsCompleted });
  const pct = Math.min(100, (contractProgress / order.need) * 100);
  const look = ITEM_LOOK[order.item];

  return (
    <section className="foundry-order" aria-label="Current order">
      <div className="foundry-order-meta">
        <span className="foundry-order-no">Order {String(contractsCompleted + 1).padStart(2, "0")}</span>
        <strong>{order.title}</strong>
      </div>
      <p className="foundry-order-brief">{order.brief}</p>
      <div className="foundry-order-need">
        <span className="foundry-chip mini" style={{ background: look.fill, color: look.ink }}>
          {look.short}
        </span>
        <span>
          {contractProgress}/{order.need}
        </span>
        <span className="foundry-order-pay">Pay ${order.reward}</span>
        <span className="foundry-order-then">Then {order.then}</span>
      </div>
      <div className="foundry-order-bar" aria-hidden>
        <i style={{ width: `${pct}%` }} />
      </div>
    </section>
  );
}

function SpecRail() {
  const unlocked = useFactory((s) => s.unlocked);
  const copper = useFactory((s) => s.copperUnlocked);
  const focus = useFactory((s) => s.focusItem);
  const furnace = unlocked.includes("smelter");
  const press = unlocked.includes("assembler");
  const bench = unlocked.includes("fabricator");

  return (
    <section className="foundry-spec" aria-label="Recipe spec">
      <p className="foundry-spec-k">Spec plate · tap a part to highlight the floor</p>
      <div className="foundry-spec-row">
        <ItemChip item="ironOre" on={focus === "ironOre"} />
        <Arrow />
        <MachNode kind="smelter" locked={!furnace} />
        <Arrow />
        <ItemChip item="ironPlate" on={focus === "ironPlate"} locked={!furnace} />
        <Arrow />
        <MachNode kind="assembler" locked={!press} />
        <Arrow />
        <ItemChip item="gear" on={focus === "gear"} locked={!press} />
        <Arrow />
        <span className="foundry-node dock">Dock</span>
      </div>
      <div className={`foundry-spec-row ${copper ? "" : "dim"}`}>
        <ItemChip item="copperOre" on={focus === "copperOre"} locked={!copper} />
        <Arrow />
        <MachNode kind="smelter" locked={!furnace} />
        <Arrow />
        <ItemChip item="copperPlate" on={focus === "copperPlate"} locked={!copper} />
        <Arrow />
        <MachNode kind="fabricator" locked={!bench} />
        <Arrow />
        <ItemChip item="circuit" on={focus === "circuit"} locked={!bench} />
      </div>
    </section>
  );
}

function Arrow() {
  return <span className="foundry-arrow" aria-hidden />;
}

function ItemChip({
  item,
  on,
  locked,
}: {
  item: ItemKind;
  on?: boolean;
  locked?: boolean;
}) {
  const look = ITEM_LOOK[item];
  const setFocusItem = useFactory((s) => s.setFocusItem);
  const focusItem = useFactory((s) => s.focusItem);
  return (
    <button
      type="button"
      className={`foundry-chip ${on ? "on" : ""} ${locked ? "lock" : ""}`}
      style={locked ? undefined : { background: look.fill, color: look.ink, borderColor: look.rim }}
      onClick={() => setFocusItem(focusItem === item ? null : item)}
      title={locked ? "Still locked" : `${itemLabel(item)} sells for $${exportValue(item)}`}
    >
      <span className="nm">{locked ? "???" : look.short}</span>
      <span className="pr">${locked ? "?" : exportValue(item)}</span>
    </button>
  );
}

function MachNode({ kind, locked }: { kind: MachineKind; locked: boolean }) {
  const tryTool = useFactory((s) => s.tryTool);
  const tool = useFactory((s) => s.tool);
  return (
    <button
      type="button"
      className={`foundry-node ${kind} ${tool === kind ? "on" : ""} ${locked ? "lock" : ""}`}
      onClick={() => {
        if (locked) foundrySound.error();
        else foundrySound.click();
        tryTool(kind);
      }}
    >
      {locked ? "Locked" : machineName(kind)}
    </button>
  );
}

function IoRow({ kind }: { kind: MachineKind }) {
  const spec = MACHINE_SPEC[kind];
  return (
    <div className="foundry-io">
      <span>
        IN{" "}
        {spec.takes === null
          ? "—"
          : spec.takes === "any"
            ? "anything"
            : spec.takes.map((i) => ITEM_LOOK[i].short).join(" / ")}
      </span>
      <span>
        OUT{" "}
        {spec.products === "sell"
          ? "coin"
          : spec.products.map((i) => ITEM_LOOK[i].short).join(" / ")}
      </span>
    </div>
  );
}

function ToolBtn({
  id,
  active,
  onPick,
  cost,
}: {
  id: PlacementTool;
  active: boolean;
  onPick: (t: PlacementTool) => boolean;
  cost: number | null;
}) {
  const unlocked = useFactory((s) => isToolUnlocked(s, id));
  const recipe =
    id === "none" || id === "belt" || id === "delete" ? null : recipeLine(id);
  return (
    <button
      type="button"
      className={`foundry-tool ${id} ${active ? "on" : ""} ${unlocked ? "" : "lock"}`}
      onClick={() => {
        const ok = onPick(id);
        if (ok) foundrySound.click();
        else foundrySound.error();
      }}
    >
      <span className="nm">{unlocked ? toolLabel(id) : toolLabel(id)}</span>
      {unlocked ? (
        cost != null ? (
          <span className="pr">${cost}</span>
        ) : (
          <span className="pr">{recipe ?? " "}</span>
        )
      ) : (
        <span className="pr">Locked</span>
      )}
      {unlocked && recipe && cost != null ? <span className="io">{recipe}</span> : null}
    </button>
  );
}

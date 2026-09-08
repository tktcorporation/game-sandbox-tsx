import { ArcadeBack } from "../../shell/ArcadeBack";
import { FactoryCanvas } from "./FactoryCanvas";
import { factoryGoal, factoryThroughput, useFactory } from "./store";
import { toolHint, toolLabel, TOOL_ORDER } from "./logic";
import { machineAtCell, machineCost, machineName, recipeTime, type PlacementTool } from "./types";
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
  const setTool = useFactory((s) => s.setTool);
  const toggleMiner = useFactory((s) => s.toggleMiner);
  const goal = factoryGoal();
  const rate = factoryThroughput();
  const lastLog = log[log.length - 1] ?? "";
  const inspect = selected ? machineAtCell(grid, selected.x, selected.y) : null;
  void clock;

  return (
    <div className="foundry-root">
      <header className="foundry-top">
        <ArcadeBack onLeave={onLeave} />
        <p className="foundry-bay">Bay A</p>
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

      <div className="foundry-stage">
        <FactoryCanvas />
        {inspect ? (
          <aside className="foundry-inspect">
            <h3>{machineName(inspect.kind)}</h3>
            <p>
              {inspect.progress}/{recipeTime(inspect.kind)} ticks · in {inspect.inputBuffer.length} · out{" "}
              {inspect.outputBuffer.length}
            </p>
            {inspect.kind === "miner" ? (
              <button
                type="button"
                onClick={() => {
                  if (selected) toggleMiner(selected.x, selected.y);
                }}
              >
                Vein: {inspect.mode === "iron" ? "iron" : "copper"}
              </button>
            ) : null}
            <p className="muted">Worked {inspect.statProduced} pieces.</p>
          </aside>
        ) : null}
      </div>

      <p className="foundry-log">{lastLog}</p>
      <p className="foundry-hint">{toolHint(tool)}</p>

      <nav className="foundry-dock">
        <ToolBtn id="none" active={tool === "none"} onPick={setTool} cost={null} />
        {TOOL_ORDER.map((id) => (
          <ToolBtn
            key={id}
            id={id}
            active={tool === id}
            onPick={setTool}
            cost={id === "belt" ? 2 : id === "delete" || id === "none" ? null : machineCost(id)}
          />
        ))}
      </nav>
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
  onPick: (t: PlacementTool) => void;
  cost: number | null;
}) {
  return (
    <button
      type="button"
      className={`foundry-tool ${id} ${active ? "on" : ""}`}
      onClick={() => {
        foundrySound.click();
        onPick(id);
      }}
    >
      <span className="nm">{toolLabel(id)}</span>
      {cost != null ? <span className="pr">${cost}</span> : <span className="pr"> </span>}
    </button>
  );
}

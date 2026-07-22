import { useEffect } from "react";
import { create } from "zustand";
import { useGame } from "./game/store";
import { SPECIES } from "./game/species";
import type { SpeciesId } from "./game/types";

export type Mode = "home" | "battle";
export type Sheet = "dex" | "squad" | "leaderboard" | "settings" | null;

interface Toast {
  id: number;
  msg: string;
}

interface UiStore {
  mode: Mode;
  sheet: Sheet;
  toasts: Toast[];
  setMode: (m: Mode) => void;
  setSheet: (s: Sheet) => void;
  showToast: (msg: string) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 0;

export const useUi = create<UiStore>((set) => ({
  mode: "home",
  sheet: null,
  toasts: [],
  setMode: (mode) => set({ mode }),
  setSheet: (sheet) => set({ sheet }),
  showToast: (msg) => set((s) => ({ toasts: [...s.toasts, { id: ++toastSeq, msg }].slice(-4) })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Ticks the idle simulation once per second (and on tab focus) and announces
 * any evolutions that happened since the last tick as toasts. */
export function useGameLoop() {
  const tick = useGame((s) => s.tick);
  const showToast = useUi((s) => s.showToast);

  useEffect(() => {
    const run = () => {
      const events = tick();
      if (events.length === 0) return;
      const grouped = new Map<string, number>();
      for (const e of events) {
        const key = `${e.from}|${e.to}`;
        grouped.set(key, (grouped.get(key) ?? 0) + e.amount);
      }
      for (const [key, amount] of grouped) {
        const [from, to] = key.split("|") as [SpeciesId, SpeciesId];
        showToast(`${SPECIES[from].emoji}${SPECIES[from].name} → ${SPECIES[to].emoji}${SPECIES[to].name} ×${amount} 進化!`);
      }
    };
    let handle: number | undefined;
    let unsub: (() => void) | undefined;
    const start = () => {
      run();
      handle = window.setInterval(run, 1000);
    };
    // tick() writes lastTick/colonies straight back to the store, so it must never run
    // before the persisted save has finished loading — otherwise it'd stamp the fresh
    // default state over real progress before rehydration gets a chance to restore it.
    if (useGame.persist.hasHydrated()) {
      start();
    } else {
      unsub = useGame.persist.onFinishHydration(start);
    }

    const onVisible = () => run();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (handle !== undefined) window.clearInterval(handle);
      unsub?.();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tick, showToast]);
}

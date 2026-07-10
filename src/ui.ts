import { useEffect } from "react";
import { create } from "zustand";
import { BUILDINGS } from "./game/buildings";
import { sound } from "./game/sfx";
import { useGame } from "./game/store";

export type Mode = "home" | "battle";

interface UiStore {
  mode: Mode;
  selectedId: string | null;
  toast: { id: number; msg: string } | null;
  setMode: (m: Mode) => void;
  select: (id: string | null) => void;
  showToast: (msg: string) => void;
  clearToast: () => void;
}

let toastSeq = 0;

export const useUi = create<UiStore>((set) => ({
  mode: "home",
  selectedId: null,
  toast: null,
  setMode: (mode) => set({ mode, selectedId: null }),
  select: (selectedId) => set({ selectedId }),
  showToast: (msg) => set({ toast: { id: ++toastSeq, msg } }),
  clearToast: () => set({ toast: null }),
}));

/** Ticks the game once per second to finalise construction timers and refresh
 * production counters. Also re-renders the components subscribed to `clock`. */
export function useGameLoop() {
  const tick = useGame((s) => s.tick);
  useEffect(() => {
    tick();
    const handle = window.setInterval(tick, 1000);
    const onVisible = () => tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(handle);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tick]);

  // celebrate constructions the moment they finish (timer or gem skip)
  useEffect(() => {
    return useGame.subscribe((s, prev) => {
      if (s.buildings === prev.buildings) return;
      for (const pb of prev.buildings) {
        if (!pb.upgradeDoneAt) continue;
        const nb = s.buildings.find((b) => b.id === pb.id);
        if (nb && !nb.upgradeDoneAt) {
          sound.play("finish");
          useUi.getState().showToast(`🔨 ${BUILDINGS[nb.type].name} Lv${nb.level} completed!`);
        }
      }
    });
  }, []);

  // the AudioContext needs one user gesture before it may make noise
  useEffect(() => {
    const unlock = () => sound.unlock();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);
}

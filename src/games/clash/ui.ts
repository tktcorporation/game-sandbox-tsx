import { useEffect } from "react";
import { create } from "zustand";
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
}

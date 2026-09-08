import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  assignParty,
  autoFillParty,
  befriend,
  collectNests,
  currentStamina,
  feedTata,
  initialState,
  now,
  petTata,
  placeFurniture,
  powerUp,
  startAdventure,
  stroll,
} from "./logic";

import type { FurnitureId, PartySlot, TataGameState } from "./types";

export type Screen = "home" | "album" | "stroll" | "battle";

export interface StrollEncounter {
  speciesId: string;
  shiny: boolean;
}

interface TataStore extends TataGameState {
  clock: number;
  screen: Screen;
  selectedUid: string | null;
  buildId: FurnitureId | null;
  toast: { id: number; msg: string } | null;
  encounter: StrollEncounter | null;
  lastStroll: string;
  startWith: (starterId: string) => void;
  setScreen: (screen: Screen) => void;
  select: (uid: string | null) => void;
  setBuild: (id: FurnitureId | null) => void;
  feed: (uid: string) => void;
  power: (uid: string) => void;
  pet: (uid: string) => void;
  setParty: (uid: string, slot: PartySlot | null) => void;
  fillParty: () => void;
  place: (x: number, y: number) => void;
  goStroll: () => void;
  catchWild: () => void;
  shooWild: () => void;
  applyRewards: (berries: number, shards: number, scrap: number, waves: number) => void;
  tick: () => void;
  reset: () => void;
  showToast: (msg: string) => void;
}

let toastSeq = 0;

export const useTata = create<TataStore>()(
  persist(
    (set, get) => ({
      ...initialState(),
      clock: now(),
      screen: "home",
      selectedUid: null,
      buildId: null,
      toast: null,
      encounter: null,
      lastStroll: "くさむらをタッチして、タタをさがそう。",

      startWith: (starterId) => {
        set({ ...startAdventure(get(), starterId), screen: "home", selectedUid: null });
        get().showToast("ナンモナイシもついてきた。しょんぼりしてる。");
      },

      setScreen: (screen) => set({ screen, selectedUid: null, buildId: null, encounter: null }),
      select: (selectedUid) => set({ selectedUid, buildId: null }),
      setBuild: (buildId) => set({ buildId, selectedUid: null }),

      feed: (uid) => {
        const r = feedTata(get(), uid);
        if (r.reason) {
          get().showToast(r.reason);
          return;
        }
        set(r.state);
        if (r.shinyUnlock) get().showToast("ピカピカ形態、解放！");
        else if (r.evolved) get().showToast("しんかした！");
        else get().showToast("もぐもぐ。");
      },

      power: (uid) => {
        const r = powerUp(get(), uid);
        if (r.reason) {
          get().showToast(r.reason);
          return;
        }
        set(r.state);
        get().showToast("パワーアップ！");
      },

      pet: (uid) => {
        const r = petTata(get(), uid);
        if (r.reason) {
          get().showToast(r.reason);
          return;
        }
        set(r.state);
        if (r.poolFun) get().showToast("ネコオリ、プールでぽちゃぽちゃ！ きのみ +" + r.berries);
        else get().showToast(`ふれあい。きのみ +${r.berries}`);
      },

      setParty: (uid, slot) => set(assignParty(get(), uid, slot)),
      fillParty: () => set(autoFillParty(get())),

      place: (x, y) => {
        const id = get().buildId;
        if (!id) return;
        const r = placeFurniture(get(), id, x, y);
        if (r.reason) {
          get().showToast(r.reason);
          return;
        }
        set({ ...r.state, buildId: null });
        get().showToast("おいた！");
      },

      goStroll: () => {
        const seed = (Math.random() * 1e9) | 0;
        const r = stroll(get(), seed);
        if (r.reason) {
          get().showToast(r.reason);
          return;
        }
        if (r.find.kind === "tata") {
          set({
            ...r.state,
            encounter: { speciesId: r.find.speciesId, shiny: r.find.shiny },
            lastStroll: r.find.shiny ? "ぴかぴかが草むらから！" : "草むらが動いた…",
          });
          return;
        }
        if (r.find.kind === "berries") {
          set({ ...r.state, lastStroll: `きのみを${r.find.n}こひろった。` });
          get().showToast(`きのみ +${r.find.n}`);
          return;
        }
        if (r.find.kind === "scrap") {
          set({ ...r.state, lastStroll: `くずを${r.find.n}こひろった。おうちに使えそう。` });
          get().showToast(`くず +${r.find.n}`);
          return;
        }
        set({ ...r.state, lastStroll: "かぜだけ。つぎの草むらへ。" });
      },

      catchWild: () => {
        const enc = get().encounter;
        if (!enc) return;
        const r = befriend(get(), enc.speciesId, enc.shiny);
        if (r.reason) {
          get().showToast(r.reason);
          return;
        }
        set({ ...r.state, encounter: null, lastStroll: "なついた！" });
        get().showToast(enc.shiny ? "ピカタタ、ゲット！" : "タタ、ゲット！");
      },

      shooWild: () => set({ encounter: null, lastStroll: "にがした。また会えるかも。" }),

      applyRewards: (berries, shards, scrap, waves) => {
        const s = get();
        set({
          berries: Math.min(999, s.berries + berries),
          shards: Math.min(999, s.shards + shards),
          scrap: Math.min(99, s.scrap + scrap),
          stamina: Math.min(8, currentStamina(s) + 2),
          staminaAt: now(),
          waveBest: Math.max(s.waveBest, waves),
          screen: "home",
        });
        get().showToast(`おかえり。きのみ+${berries} かけら+${shards} くず+${scrap}`);
      },

      tick: () => {
        const s = get();
        const nest = collectNests(s);
        if (nest.amount > 0) {
          set({ ...nest.state, clock: now() });
          get().showToast(`ベッドできのみ +${nest.amount}`);
          return;
        }
        set({ clock: now() });
      },

      reset: () =>
        set({
          ...initialState(),
          clock: now(),
          screen: "home",
          selectedUid: null,
          buildId: null,
          encounter: null,
          lastStroll: "くさむらをタッチして、タタをさがそう。",
        }),

      showToast: (msg) => set({ toast: { id: ++toastSeq, msg } }),
    }),
    {
      name: "tata-survival-v1",
      partialize: (s) => ({
        berries: s.berries,
        shards: s.shards,
        scrap: s.scrap,
        stamina: s.stamina,
        staminaAt: s.staminaAt,
        started: s.started,
        tatas: s.tatas,
        furniture: s.furniture,
        seen: s.seen,
        waveBest: s.waveBest,
        nestAt: s.nestAt,
      }),
    },
  ),
);

/**
 * Player-facing feature switches. Logic stays in the tree; when a switch is off the
 * player does not see or earn from that system. Flip back to revive (see
 * docs/ringfall/simplify-candidates.md §復活, docs/ringfall/pvp-clarity.md).
 *
 * Tests that need a switch on can set `FEATURES.* = true` for the process.
 */
export const FEATURES = {
  /**
   * 依頼板: 入門の依頼・今日の依頼・物語の依頼.
   * Off so the line is only 出撃 → 前線を押す → 持ち帰る → 拠点を育てる.
   */
  questBoard: false,
  /**
   * 反応型の対人守り: 来る遠征の予告表示、核で固めるの迎撃導線、出撃の来る遠征欄.
   * Off = Clash of Clans 型（守りは自動・結果は後から島の知らせ。攻めだけ能動）.
   * Server / AI still resolve expeditions while the owner is away.
   */
  reactiveDefense: false,
};

/** Whether the 依頼板 is in play for the player. */
export const questBoardOn = () => FEATURES.questBoard;

/** Whether reactive PvP defence (来る遠征 → 固める) is shown and playable. */
export const reactiveDefenseOn = () => FEATURES.reactiveDefense;

/**
 * Player-facing feature switches. Logic stays in the tree; when a switch is off the
 * player does not see or earn from that system. Flip back to revive (see
 * docs/ringfall/simplify-candidates.md §復活).
 *
 * Tests that need the board on can set `FEATURES.questBoard = true` for the process.
 */
export const FEATURES = {
  /**
   * 依頼板: 入門の依頼・今日の依頼・物語の依頼.
   * Off so the line is only 出撃 → 前線を押す → 持ち帰る → 拠点を育てる.
   */
  questBoard: false,
};

/** Whether the 依頼板 is in play for the player. */
export const questBoardOn = () => FEATURES.questBoard;

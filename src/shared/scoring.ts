/**
 * Live scoring (M4) — the single source of truth for ring geometry and values.
 *
 * Score is derived ENTIRELY from current board state: a stone is worth the
 * points of the innermost ring containing its center, right now. No banking,
 * no snapshots, no extra storage — the leaderboard can never disagree with
 * the board the player is looking at.
 *
 * The client renders rings from this same array (colors live client-side);
 * the server scores from it. Do not duplicate these radii anywhere.
 */
import type { StoneState } from './api';
import { BOARD } from './physics';

/** Outer -> inner. Innermost containing ring wins. */
export const SCORING_RINGS = [
  { radius: 240, points: 1 },
  { radius: 160, points: 2 },
  { radius: 80, points: 3 },
] as const;

/** Reserved owner for seeded stones; never appears on the leaderboard. */
export const BOARD_OWNER = 'board';

export type ScoreEntry = {
  owner: string;
  score: number;
  /** Alive stones this owner has on the board (scoring or not). */
  stones: number;
};

/** Points for a single position: innermost ring whose radius contains it. */
export function pointsAt(x: number, y: number): number {
  const d = Math.hypot(x - BOARD.centerX, y - BOARD.centerY);
  let points = 0;
  for (const ring of SCORING_RINGS) {
    if (d <= ring.radius) points = ring.points; // rings are ordered outer->inner
  }
  return points;
}

/**
 * Aggregates the live leaderboard from board state.
 * Dead stones score nothing; seed stones are excluded entirely.
 * Sorted by score desc, then stone count desc, then name for stability.
 */
export function scoreBoard(stones: StoneState[]): ScoreEntry[] {
  const byOwner = new Map<string, ScoreEntry>();
  for (const s of stones) {
    if (!s.alive || s.owner === BOARD_OWNER) continue;
    const entry = byOwner.get(s.owner) ?? { owner: s.owner, score: 0, stones: 0 };
    entry.score += pointsAt(s.x, s.y);
    entry.stones += 1;
    byOwner.set(s.owner, entry);
  }
  return [...byOwner.values()].sort(
    (a, b) => b.score - a.score || b.stones - a.stones || a.owner.localeCompare(b.owner)
  );
}

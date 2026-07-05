/**
 * Client-side VISUAL configuration only.
 *
 * All physics numbers (board size, stone properties, flick tuning, sim
 * parameters) live in src/shared/physics.ts — the single source of truth
 * imported by both client and server. Do not duplicate physics values here.
 */
import { BOARD as SHARED_BOARD } from '../../shared/physics';
import { SCORING_RINGS } from '../../shared/scoring';

/** Board dimensions re-exported for rendering; felt color is client-only. */
export const BOARD = {
  ...SHARED_BOARD,
  backgroundColor: 0x0e3b2e, // felt green
} as const;

/** Ring COLORS only — radii (and point values) come from shared/scoring.ts,
 *  the single source, so the rings players see are exactly what scores. */
const RING_COLORS = [0x14503d, 0x1f7a5a, 0xf2b705] as const;

/** Rings drawn outer -> inner (largest first), radius paired with color. */
export const RINGS = SCORING_RINGS.map((ring, i) => ({
  radius: ring.radius,
  points: ring.points,
  color: RING_COLORS[i]!,
}));

export const STONE_COLOR = 0xd9d9d9; // other players' / board stones
export const PLAYER_COLOR = 0xff4500; // reddit orange: your stones this session

/** Finger-friendly grab area multiplier around the spawn point when aiming. */
export const GRAB_RADIUS_MULT = 2.4;

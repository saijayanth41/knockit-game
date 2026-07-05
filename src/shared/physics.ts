/**
 * Shared physics constants — the single source of truth imported by BOTH
 * src/client and src/server.
 *
 * Premortem risk: if client and server physics configs silently diverge, the
 * shooter's felt experience and the server's authoritative result disconnect.
 * Mitigation: every physics number lives here and only here. Do not copy these
 * values into client or server code.
 *
 * The SERVER is authoritative: it is the only place real shots are simulated.
 * The client uses these values solely for aim-line drawing and playback timing.
 */

/** Fixed logical board. Client letterboxes this via Scale.FIT. */
export const BOARD = {
  width: 1024,
  height: 768,
  centerX: 512,
  centerY: 384,
} as const;

/** Physical properties applied to every stone body (player and board stones). */
export const STONE = {
  radius: 26,
  frictionAir: 0.02, // slowdown: stones coast, then settle
  friction: 0.005, // surface friction on contact
  restitution: 0.9, // bounciness of the knock
  density: 0.01, // equal mass => clean momentum transfer
} as const;

/** Where a newly shot stone enters the board. Kept high enough off the bottom
 *  edge (158px) that a full-power drag fits on screen (M2 review fix #1). */
export const SPAWN = { x: 512, y: 610 } as const;

/**
 * Drag-and-release tuning. `power` in a ShotRequest is the drag distance in
 * board pixels; the server clamps it and converts to a launch velocity.
 *
 * maxDragDistance is deliberately smaller than the room below SPAWN so a
 * straight-back full-power drag never runs off the board. powerScale is scaled
 * up to compensate — top speed is unchanged (150 * 0.15 = 22.5, capped at 20).
 */
export const FLICK = {
  maxDragDistance: 150, // px; drags beyond this are clamped (caps power)
  powerScale: 0.15, // px of drag -> Matter velocity units
  maxVelocity: 20, // hard server-side cap on launch speed
} as const;

/**
 * Server simulation parameters.
 *
 * substeps=4: proven anti-tunneling measure (empirically, tunneling through the
 * 60px walls starts at ~120 px/step; our cap is 20, and substepping x4 contains
 * even a hostile 120). positionIterations was tested and does NOT fix
 * tunneling — do not reach for it.
 */
export const SIM = {
  fps: 60, // trajectory frame rate (client playback rate)
  substeps: 4, // physics updates per frame
  maxFrames: 600, // hard stop: 10s of sim per shot
  restSpeed: 0.05, // all bodies slower than this => board is at rest
  wallThickness: 60,
} as const;

/**
 * Stones a brand-new rink starts with (mirrors the approved M1 board layout so
 * the first shooter of the day has targets). Owner is the reserved name
 * "board". FLAGGED DECISION: bootstrap-vs-empty rink is reversible — delete
 * this array's use in rink bootstrap to start rinks empty.
 */
/**
 * Seven rotating daily layouts (day-of-year % 7). Every layout includes the
 * "first-shot stone" at (512, 545): directly in the straight-up launch lane,
 * sitting in the outer ring — a brand-new player's very first instinctive
 * shot produces a satisfying collision within seconds.
 * All pairwise gaps verified >= 60px; all stones clear of the spawn point.
 */
export const LAYOUTS: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>> = [
  [
    // L0 — open spread (the original M2-review layout)
    { x: 512, y: 384 },
    { x: 512, y: 260 },
    { x: 400, y: 330 },
    { x: 624, y: 330 },
    { x: 350, y: 450 },
    { x: 674, y: 450 },
    { x: 440, y: 520 },
    { x: 584, y: 520 },
    { x: 512, y: 545 },
  ],
  [
    // L1 — vertical/horizontal cross
    { x: 512, y: 304 },
    { x: 512, y: 464 },
    { x: 432, y: 384 },
    { x: 592, y: 384 },
    { x: 512, y: 214 },
    { x: 342, y: 384 },
    { x: 682, y: 384 },
    { x: 512, y: 545 },
  ],
  [
    // L2 — center prize, guarded corners
    { x: 512, y: 384 },
    { x: 412, y: 284 },
    { x: 612, y: 284 },
    { x: 412, y: 484 },
    { x: 612, y: 484 },
    { x: 512, y: 164 },
    { x: 302, y: 384 },
    { x: 722, y: 384 },
    { x: 512, y: 545 },
  ],
  [
    // L3 — lopsided left cluster (angle-shot day)
    { x: 452, y: 344 },
    { x: 432, y: 444 },
    { x: 352, y: 284 },
    { x: 302, y: 444 },
    { x: 592, y: 324 },
    { x: 652, y: 444 },
    { x: 512, y: 244 },
    { x: 512, y: 545 },
  ],
  [
    // L4 — orbit ring around the gold
    { x: 512, y: 384 },
    { x: 512, y: 254 },
    { x: 625, y: 319 },
    { x: 625, y: 449 },
    { x: 399, y: 449 },
    { x: 399, y: 319 },
    { x: 512, y: 545 },
  ],
  [
    // L5 — gauntlet lane
    { x: 512, y: 304 },
    { x: 462, y: 404 },
    { x: 562, y: 404 },
    { x: 412, y: 504 },
    { x: 612, y: 504 },
    { x: 512, y: 204 },
    { x: 362, y: 304 },
    { x: 662, y: 304 },
    { x: 512, y: 545 },
  ],
  [
    // L6 — wide corners, empty middle band
    { x: 512, y: 384 },
    { x: 392, y: 264 },
    { x: 632, y: 264 },
    { x: 392, y: 504 },
    { x: 632, y: 504 },
    { x: 272, y: 384 },
    { x: 752, y: 384 },
    { x: 512, y: 545 },
  ],
];

/** Layout for a UTC date string (YYYY-MM-DD): rotates through all seven. */
export function layoutForDate(date: string): ReadonlyArray<{ x: number; y: number }> {
  const dayMs = Date.parse(`${date}T00:00:00Z`);
  const dayIndex = Math.floor(dayMs / 86_400_000);
  return LAYOUTS[((dayIndex % 7) + 7) % 7]!;
}

/** @deprecated M2-era single layout; bootstrap now uses layoutForDate(). */
export const INITIAL_STONES = LAYOUTS[0]!;

/** Converts a validated shot into a launch velocity. Server-side use only for
 *  real shots; exported so tests can assert the same mapping. */
export function launchVelocity(angle: number, power: number): { vx: number; vy: number } {
  const clamped = Math.min(Math.max(power, 0), FLICK.maxDragDistance);
  const speed = Math.min(clamped * FLICK.powerScale, FLICK.maxVelocity);
  return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
}

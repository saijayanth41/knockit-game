/**
 * Shared API contract between the webview client and the Devvit server.
 */
import type { ScoreEntry } from './scoring';

/** One stone as persisted in the rink (ratified schema, v1). */
export type StoneState = {
  id: string;
  owner: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  alive: boolean;
};

/** Value stored at rink:{date}:{n} (ratified schema, v1). */
export type BoardState = {
  v: 1;
  stones: StoneState[];
  updatedAt: number;
  /** M6 accrual watermark: survival points are banked up to this timestamp.
   *  Absent on pre-M6 boards (falls back to updatedAt). */
  lastAccrualAt?: number;
};

/** M6: banked (permanent) accrual points — survive knockouts. */
export type BankedEntry = {
  owner: string;
  points: number;
};

/** The most recent shot on the rink, replayable by spectators. */
export type LastShot = {
  stoneId: string;
  owner: string;
  fps: number;
  frames: TrajectoryFrame[];
};

export type BoardResponse = {
  type: 'board';
  rinkKey: string;
  board: BoardState;
  username: string;
  /** Server-authoritative shots left for this user today (0 when logged out). */
  shotsRemaining: number;
  /** False for logged-out viewers — client shows "log in to play". */
  loggedIn: boolean;
  /** Live leaderboard, server-computed from this same board state (M4). */
  scores: ScoreEntry[];
  /** Banked accrual points for today (M6) — permanent, knockout-proof. */
  banked: BankedEntry[];
  /** Latest shot on the rink — spectators replay it instead of snapping. */
  lastShot: LastShot | null;
  /** Consecutive days played (0 = hasn't played yet). */
  streak: number;
  /** Revenge state (M5): set when someone knocked your stone out of the
   *  rings today and you haven't used your bonus shot yet. */
  revenge: RevengeInfo;
};

/** M5 revenge shot: ONE bonus shot the day you get knocked out. */
export type RevengeInfo = {
  available: boolean;
  /** Username of the player who knocked you out (display only). */
  against: string | null;
};

/** One knockout caused by a shot: whose stone left the scoring rings. */
export type Knockout = {
  owner: string;
  stoneId: string;
};

/** Client -> server: the only inputs a shot takes. The server derives the
 *  launch velocity itself (shared/physics.ts) and clamps power. */
export type ShotRequest = {
  angle: number; // radians
  power: number; // drag distance in board px; clamped server-side
};

/** One playback frame: positions of every stone that moved this frame. */
export type TrajectoryFrame = {
  stones: { id: string; x: number; y: number }[];
};

export type ShotResponse = {
  type: 'shot';
  stoneId: string; // id of the newly launched stone
  fps: number; // playback rate for frames
  frames: TrajectoryFrame[];
  board: BoardState; // authoritative post-shot state
  /** Server-authoritative shots left for this user today, post-decrement. */
  shotsRemaining: number;
  /** Live leaderboard after this shot settled (M4). */
  scores: ScoreEntry[];
  /** Whether this shot consumed the revenge bonus instead of a daily shot. */
  usedRevenge: boolean;
  /** Consecutive-day streak after this shot. */
  streak: number;
  /** Set when a revenge shot knocked out the original attacker: their
   *  username. Earns the shooter a banked bonus. */
  revengeServedOn: string | null;
  /** Post-shot revenge state for THIS shooter (may be freshly false). */
  revenge: RevengeInfo;
  /** Stones this shot knocked out of the rings (attacker-side feedback). */
  knockouts: Knockout[];
};

/** Who's live on the rink (activity in the last 45s). Poll-based presence. */
export type PresenceResponse = {
  type: 'presence';
  count: number;
  users: string[];
};

export type ErrorResponse = {
  status: 'error';
  /**
   * 'locked'          => rink busy; client retries with jittered backoff.
   * 'no_shots'        => daily shot allowance exhausted (server-enforced).
   * 'unauthenticated' => not logged in; shots require a Reddit account.
   */
  code?: 'locked' | 'no_shots' | 'unauthenticated';
  message: string;
};

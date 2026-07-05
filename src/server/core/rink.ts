/**
 * Rink persistence + locking (ratified Redis schema).
 *
 * Keys:
 *   rink:{date}:{n}      JSON BoardState (schema v1, stones carry `alive`)
 *   rinklock:{date}:{n}  short-lived shot lock, TTL 15s
 *
 * M2 runs a single rink (n = 0). Multi-rink and daily rotation arrive with the
 * scheduler milestone; the key shape already supports them.
 */
import { redis } from '@devvit/web/server';
import type { BoardState, LastShot, StoneState } from '../../shared/api';
import { layoutForDate } from '../../shared/physics';

// --------------------------------------------------
//
// TEMP M3
//
// Single shared rink.
//
// Used only to validate multiplayer: every user, every request, lands on
// rink:{today}:0 so two Reddit accounts provably see and affect the same
// board. Multi-rink assignment is intentionally disabled.
//
// Remove during M4.
//
// --------------------------------------------------
export const RINK_NUMBER = 0;
const LOCK_TTL_SECONDS = 15;
const DAILY_SHOTS = 3;

// --------------------------------------------------
// DEV MODE (off for release): unlimited shots while building out the app.
// While true: everyone's record is topped up to DEV_SHOTS on read, and the
// revenge-consumption path effectively never triggers (shots never reach 0).
// --------------------------------------------------
const UNLIMITED_SHOTS_FOR_TESTING = false;
const DEV_SHOTS = 99;

/**
 * The game day rolls at MIDNIGHT US CENTRAL (12:00 AM CDT = 05:00 UTC), per
 * product decision. Fixed UTC-5 offset — during the hackathon window (July)
 * Central is on daylight time; revisit if the game outlives November.
 * Everything date-scoped (rink, banks, shots, presence) resets together.
 */
export const GAME_DAY_OFFSET_HOURS = 5;

/** Current game day, e.g. "2026-07-05" — shared by every player worldwide. */
export function todayUtc(nowMs: number = Date.now()): string {
  return new Date(nowMs - GAME_DAY_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10);
}

export function rinkKey(date: string = todayUtc(), n: number = RINK_NUMBER): string {
  return `rink:${date}:${n}`;
}

function lockKey(date: string = todayUtc(), n: number = RINK_NUMBER): string {
  return `rinklock:${date}:${n}`;
}

/**
 * FLAGGED DECISION (reversible): a brand-new rink bootstraps with the approved
 * M1 stone layout (owner "board") so the first shooter has targets. To start
 * rinks empty instead, return `[]` here.
 */
function bootstrapStones(date: string): StoneState[] {
  return layoutForDate(date).map((pos, i) => ({
    id: `board-${date}-${i}`,
    owner: 'board',
    x: pos.x,
    y: pos.y,
    vx: 0,
    vy: 0,
    alive: true,
  }));
}

/** Loads today's rink, creating (and persisting) it on first access.
 *  `wasCreated` feeds the TEMP M3 debug overlay. */
export async function loadRink(
  key: string,
  date: string
): Promise<{ board: BoardState; wasCreated: boolean }> {
  const raw = await redis.get(key);
  if (raw) {
    return { board: JSON.parse(raw) as BoardState, wasCreated: false };
  }
  const fresh: BoardState = { v: 1, stones: bootstrapStones(date), updatedAt: Date.now() };
  await redis.set(key, JSON.stringify(fresh));
  return { board: fresh, wasCreated: true };
}

export async function saveRink(key: string, board: BoardState): Promise<void> {
  await redis.set(key, JSON.stringify(board));
}

/**
 * Acquires the per-rink shot lock. Returns true if this request holds it.
 *
 * Implementation note: Devvit's SetOptions types don't document what `set`
 * with `nx` returns on failure, so instead of SET NX we use the unambiguous
 * atomic primitive: INCR. The first caller sees 1 (lock acquired) and stamps
 * the TTL; everyone else sees >1 (busy).
 *
 * Self-healing: losers also re-stamp the TTL. If a holder crashed in the gap
 * between incrBy and expire (orphaned, TTL-less lock), the next contender's
 * expire guarantees the key still dies within LOCK_TTL_SECONDS, so a rink can
 * never deadlock for the rest of the day. Refreshing a live holder's TTL is
 * harmless — real shots finish in ~50ms and release explicitly.
 */
export async function acquireLock(date: string = todayUtc()): Promise<boolean> {
  const key = lockKey(date);
  const n = await redis.incrBy(key, 1);
  await redis.expire(key, LOCK_TTL_SECONDS);
  return n === 1;
}

export async function releaseLock(date: string = todayUtc()): Promise<void> {
  await redis.del(lockKey(date));
}

// ---------------------------------------------------------------------------
// Per-user daily record (M3 shot limit + M5 revenge).
//
// Key:   user:{userId}:{date}
// Value: { shotsLeft, rink, returnShotAvailable, revengeAgainst, revengeUsed }
//
// Master-schema fields: rink, shotsLeft, returnShotAvailable.
// Extensions (flagged in the M5 report): revengeAgainst — attacker username
// for the "who hit me" banner; revengeUsed — enforces at most ONE revenge
// grant per day (prevents knockout ping-pong inflating shot counts).
//
// The client only DISPLAYS this state; the server validates, decrements,
// grants, and consumes. Mutations happen inside the rink lock, so concurrent
// shots cannot double-spend or double-grant.
// ---------------------------------------------------------------------------

export type UserShots = {
  shotsLeft: number;
  rink: number;
  returnShotAvailable: boolean;
  revengeAgainst: string | null;
  revengeUsed: boolean;
};

function userKey(userId: string, date: string): string {
  return `user:${userId}:${date}`;
}

/** Streak reward: a LIVE streak of 3+ days (played yesterday, streak >= 3)
 *  earns a 4th daily stone. Checked only when the daily record is created. */
const STREAK_BONUS_MIN_DAYS = 3;
const STREAK_BONUS_SHOTS = 1;

async function dailyShotsFor(userId: string, date: string): Promise<number> {
  const meta = await loadUserMeta(userId);
  const yesterday = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const liveStreak = meta.lastPlayedDate === yesterday && meta.streak >= STREAK_BONUS_MIN_DAYS;
  return DAILY_SHOTS + (liveStreak ? STREAK_BONUS_SHOTS : 0);
}

/** Loads the user's daily record, creating it on first access (3 shots, or 4
 *  with a live 3+ day streak). Reads pre-M5 records too (field migration). */
export async function loadUserShots(userId: string, date: string): Promise<UserShots> {
  const raw = await redis.get(userKey(userId, date));
  if (raw) {
    const parsed = JSON.parse(raw) as Partial<UserShots> & { shotsRemaining?: number };
    const stored = parsed.shotsLeft ?? parsed.shotsRemaining ?? DAILY_SHOTS;
    // Clamp to the legal daily max so records inflated by a past dev-mode
    // session can never carry unlimited shots into release.
    const legalMax = DAILY_SHOTS + STREAK_BONUS_SHOTS;
    return {
      shotsLeft: UNLIMITED_SHOTS_FOR_TESTING
        ? Math.max(stored, DEV_SHOTS)
        : Math.min(stored, legalMax),
      rink: parsed.rink ?? RINK_NUMBER,
      returnShotAvailable: parsed.returnShotAvailable ?? false,
      revengeAgainst: parsed.revengeAgainst ?? null,
      revengeUsed: parsed.revengeUsed ?? false,
    };
  }
  const fresh: UserShots = {
    shotsLeft: UNLIMITED_SHOTS_FOR_TESTING ? DEV_SHOTS : await dailyShotsFor(userId, date),
    rink: RINK_NUMBER,
    returnShotAvailable: false,
    revengeAgainst: null,
    revengeUsed: false,
  };
  await redis.set(userKey(userId, date), JSON.stringify(fresh));
  return fresh;
}

/**
 * Grants the victim their revenge shot (M5). At most ONE grant per day:
 * skipped if one is already pending or already used. Returns true if granted.
 */
export async function grantRevenge(
  victimUserId: string,
  date: string,
  attackerUsername: string
): Promise<boolean> {
  const record = await loadUserShots(victimUserId, date);
  if (record.returnShotAvailable || record.revengeUsed) return false;
  record.returnShotAvailable = true;
  record.revengeAgainst = attackerUsername;
  await saveUserShots(victimUserId, date, record);
  return true;
}

export async function saveUserShots(
  userId: string,
  date: string,
  record: UserShots
): Promise<void> {
  await redis.set(userKey(userId, date), JSON.stringify(record));
}

// ---------------------------------------------------------------------------
// Streaks — consecutive days played (ratified key user:{userId}:meta).
// ---------------------------------------------------------------------------

type UserMeta = {
  streak: number;
  lastPlayedDate: string | null;
};

function userMetaKey(userId: string): string {
  return `user:${userId}:meta`;
}

async function loadUserMeta(userId: string): Promise<UserMeta> {
  const raw = await redis.get(userMetaKey(userId));
  if (raw) {
    const parsed = JSON.parse(raw) as Partial<UserMeta>;
    return { streak: parsed.streak ?? 0, lastPlayedDate: parsed.lastPlayedDate ?? null };
  }
  return { streak: 0, lastPlayedDate: null };
}

/** Current streak without modifying it (for board reads). */
export async function getStreak(userId: string): Promise<number> {
  return (await loadUserMeta(userId)).streak;
}

/**
 * Records a play on `date` and returns the updated streak:
 * consecutive-day play extends it, a gap resets to 1, same-day repeat is a
 * no-op. Called on successful shots only.
 */
export async function bumpStreak(userId: string, date: string): Promise<number> {
  const meta = await loadUserMeta(userId);
  if (meta.lastPlayedDate === date) return meta.streak;
  const yesterday = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const streak = meta.lastPlayedDate === yesterday ? meta.streak + 1 : 1;
  await redis.set(userMetaKey(userId), JSON.stringify({ streak, lastPlayedDate: date }));
  return streak;
}

// ---------------------------------------------------------------------------
// Last shot — spectator replay (day-5 sprint).
//
// Key: lastshot:{date}:{rink} — JSON LastShot (latest trajectory, ~50KB).
// Written on every shot; clients that poll and see an unseen shot id play
// the trajectory back instead of snapping stones to new positions.
// ---------------------------------------------------------------------------

function lastShotKey(date: string): string {
  return `lastshot:${date}:${RINK_NUMBER}`;
}

export async function saveLastShot(date: string, shot: LastShot): Promise<void> {
  await redis.set(lastShotKey(date), JSON.stringify(shot));
  await redis.expire(lastShotKey(date), 48 * 3600);
}

export async function getLastShot(date: string): Promise<LastShot | null> {
  const raw = await redis.get(lastShotKey(date));
  return raw ? (JSON.parse(raw) as LastShot) : null;
}

// ---------------------------------------------------------------------------
// Presence — "who is live on this rink right now".
//
// Key:   presence:{date}:{rink}   (sorted set: member = username,
//                                  score = last-seen epoch ms)
//
// Polling model (Devvit has no websockets): every /board, /shot, or
// /presence request stamps the caller; readers prune entries older than
// PRESENCE_WINDOW_MS and return what's left. The key self-expires so stale
// days cost nothing.
// ---------------------------------------------------------------------------

const PRESENCE_WINDOW_MS = 45_000;
const PRESENCE_KEY_TTL_SECONDS = 120;

function presenceKey(date: string): string {
  return `presence:${date}:${RINK_NUMBER}`;
}

/** Marks a user as live now. Best-effort — callers should not fail on error. */
export async function touchPresence(username: string, date: string = todayUtc()): Promise<void> {
  const key = presenceKey(date);
  await redis.zAdd(key, { member: username, score: Date.now() });
  await redis.expire(key, PRESENCE_KEY_TTL_SECONDS);
}

/** Prunes stale entries and returns everyone active in the last 45s. */
export async function getPresence(date: string = todayUtc()): Promise<string[]> {
  const key = presenceKey(date);
  const cutoff = Date.now() - PRESENCE_WINDOW_MS;
  await redis.zRemRangeByScore(key, 0, cutoff);
  const members = await redis.zRange(key, 0, -1);
  return members.map((m) => m.member);
}

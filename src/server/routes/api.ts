import { Hono } from 'hono';
import { context, reddit, redis } from '@devvit/web/server';
import type {
  BoardResponse,
  ErrorResponse,
  PresenceResponse,
  ShotRequest,
  ShotResponse,
} from '../../shared/api';
import { SIM } from '../../shared/physics';
import { BOARD_OWNER, pointsAt, scoreBoard } from '../../shared/scoring';
import { simulateShot } from '../core/physics';
import {
  acquireLock,
  bumpStreak,
  getLastShot,
  getPresence,
  getStreak,
  grantRevenge,
  loadRink,
  loadUserShots,
  releaseLock,
  rinkKey,
  saveLastShot,
  saveRink,
  saveUserShots,
  todayUtc,
  touchPresence,
} from '../core/rink';
import type { Knockout, StoneState } from '../../shared/api';
import { accrueBoard, getBanked, lbKey } from '../core/settle';

/** Banked bonus for knocking out the player who knocked you out. */
const REVENGE_SERVED_BONUS = 3;

/**
 * M5 knockout rule: a stone that was SCORING before the shot (inside any
 * ring) and is NON-SCORING after. Being pushed to a lesser ring is not a
 * knockout. Seed stones and the shooter's own stones never produce revenge.
 */
function detectKnockouts(
  before: StoneState[],
  after: StoneState[],
  shooter: string
): Knockout[] {
  const afterById = new Map(after.map((s) => [s.id, s]));
  const knockouts: Knockout[] = [];
  for (const pre of before) {
    if (!pre.alive || pre.owner === BOARD_OWNER || pre.owner === shooter) continue;
    if (pointsAt(pre.x, pre.y) === 0) continue; // wasn't scoring
    const post = afterById.get(pre.id);
    if (post && post.alive && pointsAt(post.x, post.y) === 0) {
      knockouts.push({ owner: pre.owner, stoneId: pre.id });
    }
  }
  return knockouts;
}

/** Best-effort presence stamp: never let presence failures break gameplay. */
async function stampPresence(username: string | undefined, date: string): Promise<void> {
  if (!username) return; // logged-out viewers aren't listed
  try {
    await touchPresence(username, date);
  } catch (error) {
    console.error('presence stamp failed:', error);
  }
}

export const api = new Hono();

/**
 * Current rink state + who's asking + their remaining shots.
 *
 * Identity is derived exclusively from the authenticated Devvit server
 * context (context.userId / reddit.getCurrentUsername()) — never from
 * anything the client sends.
 */
api.get('/board', async (c) => {
  try {
    const date = todayUtc();
    const key = rinkKey(date);
    const userId = context.userId; // authenticated Devvit context; undefined if logged out
    const [{ board }, username] = await Promise.all([
      loadRink(key, date),
      reddit.getCurrentUsername(),
    ]);

    // Logged-out visitors can watch the board but have no shots.
    const shots = userId ? await loadUserShots(userId, date) : null;

    await stampPresence(username, date);
    const [banked, lastShot, streak] = await Promise.all([
      getBanked(date),
      getLastShot(date),
      userId ? getStreak(userId) : Promise.resolve(0),
    ]);

    return c.json<BoardResponse>({
      type: 'board',
      rinkKey: key,
      board,
      username: username ?? 'anonymous',
      shotsRemaining: shots?.shotsLeft ?? 0,
      loggedIn: Boolean(userId),
      scores: scoreBoard(board.stones),
      banked,
      lastShot,
      streak,
      revenge: {
        available: shots?.returnShotAvailable ?? false,
        against: shots?.revengeAgainst ?? null,
      },
    });
  } catch (error) {
    console.error('GET /api/board failed:', error);
    return c.json<ErrorResponse>({ status: 'error', message: 'failed to load board' }, 500);
  }
});

/**
 * Presence heartbeat: stamps the caller as live and returns who else is.
 * Polled by the client every ~30s — cheap (two sorted-set ops + a range read).
 */
api.get('/presence', async (c) => {
  try {
    const date = todayUtc();
    const username = await reddit.getCurrentUsername();
    await stampPresence(username, date);
    const users = await getPresence(date);
    return c.json<PresenceResponse>({ type: 'presence', count: users.length, users });
  } catch (error) {
    console.error('GET /api/presence failed:', error);
    return c.json<ErrorResponse>({ status: 'error', message: 'presence unavailable' }, 500);
  }
});

/**
 * Server-authoritative shot.
 *
 * Order of enforcement:
 *   1. Reject any client-supplied identity (owner/username/user fields).
 *   2. Require an authenticated user (context.userId) — 401 otherwise.
 *   3. Validate physics inputs.
 *   4. Acquire the rink lock (serializes all mutations on the shared rink).
 *   5. Enforce the daily shot allowance — 403 no_shots at zero.
 *   6. Simulate, persist rink + decremented allowance, release, respond.
 */
api.post('/shot', async (c) => {
  let body: ShotRequest & Record<string, unknown>;
  try {
    body = (await c.req.json()) as ShotRequest & Record<string, unknown>;
  } catch {
    return c.json<ErrorResponse>({ status: 'error', message: 'invalid JSON body' }, 400);
  }

  // Identity comes from the authenticated context ONLY. A client that tries
  // to name an owner is either buggy or hostile — reject loudly.
  if ('owner' in body || 'username' in body || 'user' in body || 'userId' in body) {
    return c.json<ErrorResponse>(
      { status: 'error', message: 'identity fields are not accepted; owner is server-derived' },
      400
    );
  }

  const userId = context.userId;
  if (!userId) {
    return c.json<ErrorResponse>(
      { status: 'error', code: 'unauthenticated', message: 'log in to shoot' },
      401
    );
  }

  if (typeof body.angle !== 'number' || !Number.isFinite(body.angle)) {
    return c.json<ErrorResponse>({ status: 'error', message: 'angle must be a finite number' }, 400);
  }
  if (typeof body.power !== 'number' || !Number.isFinite(body.power) || body.power <= 0) {
    return c.json<ErrorResponse>({ status: 'error', message: 'power must be a positive number' }, 400);
  }

  const date = todayUtc();

  const locked = await acquireLock(date);
  if (!locked) {
    return c.json<ErrorResponse>(
      { status: 'error', code: 'locked', message: 'rink busy, retry shortly' },
      409
    );
  }

  try {
    // Allowance is read and spent INSIDE the lock, so a user double-tapping
    // cannot spend the same stone twice (nor double-consume revenge).
    const shots = await loadUserShots(userId, date);
    const usingRevenge = shots.shotsLeft <= 0 && shots.returnShotAvailable;
    if (shots.shotsLeft <= 0 && !usingRevenge) {
      return c.json<ErrorResponse>(
        { status: 'error', code: 'no_shots', message: 'no shots remaining today' },
        403
      );
    }

    const key = rinkKey(date);
    const [{ board }, username] = await Promise.all([
      loadRink(key, date),
      reddit.getCurrentUsername(),
    ]);
    const owner = username ?? userId; // display name; identity itself is userId

    await stampPresence(username, date);

    // M6: bank survival accrual up to THIS moment, at pre-shot positions,
    // before the shot rearranges the board. We hold the rink lock here.
    const now = Date.now();
    const accrued = await accrueBoard(board, date, now);

    // power is re-clamped inside launchVelocity — never trust the client's number.
    const result = simulateShot(accrued.stones, owner, body.angle, body.power);

    const newBoard = {
      v: 1 as const,
      stones: result.finalStones,
      updatedAt: now,
      lastAccrualAt: now, // accrueBoard just banked up to `now`
    };
    const newShots = usingRevenge
      ? { ...shots, returnShotAvailable: false, revengeAgainst: null, revengeUsed: true }
      : { ...shots, shotsLeft: shots.shotsLeft - 1 };
    await saveRink(key, newBoard);
    await saveUserShots(userId, date, newShots);

    // Spectator replay: persist this trajectory for polling clients.
    await saveLastShot(date, {
      stoneId: result.stoneId,
      owner,
      fps: SIM.fps,
      frames: result.frames,
    });

    const streak = await bumpStreak(userId, date);

    // M5: knockouts grant the victims their revenge shot. Best-effort — a
    // failed username lookup must never fail the shot itself.
    const knockouts = detectKnockouts(board.stones, newBoard.stones, owner);

    // Revenge served: this WAS a revenge shot and it knocked out the very
    // player who caused it — bank a bonus on top of the poetry.
    const avengedTarget = usingRevenge ? shots.revengeAgainst : null;
    const revengeServedOn =
      avengedTarget && knockouts.some((k) => k.owner === avengedTarget) ? avengedTarget : null;
    if (revengeServedOn) {
      await redis.zIncrBy(lbKey(date), owner, REVENGE_SERVED_BONUS);
    }
    for (const victim of new Set(knockouts.map((k) => k.owner))) {
      try {
        const user = await reddit.getUserByUsername(victim);
        if (user) await grantRevenge(user.id, date, owner);
      } catch (error) {
        console.error(`revenge grant failed for ${victim}:`, error);
      }
    }

    return c.json<ShotResponse>({
      type: 'shot',
      stoneId: result.stoneId,
      fps: SIM.fps,
      frames: result.frames,
      board: newBoard,
      shotsRemaining: newShots.shotsLeft,
      scores: scoreBoard(newBoard.stones),
      usedRevenge: usingRevenge,
      streak,
      revengeServedOn,
      revenge: {
        available: newShots.returnShotAvailable,
        against: newShots.revengeAgainst,
      },
      knockouts,
    });
  } catch (error) {
    console.error('POST /api/shot failed:', error);
    return c.json<ErrorResponse>({ status: 'error', message: 'shot simulation failed' }, 500);
  } finally {
    await releaseLock(date);
  }
});

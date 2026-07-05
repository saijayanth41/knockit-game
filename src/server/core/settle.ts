/**
 * M6 — accrual banking + daily settle.
 *
 * Scoring model (ratified A1 "staged both"):
 *  - LIVE scores (M4) stay: ring value of your stones right now, volatile.
 *  - ACCRUAL banks survival: ringPoints-per-HOUR for every hour a stone sits
 *    in a ring. Banked points are permanent — a later knockout stops future
 *    accrual but never claws back the bank. This kills the end-of-day
 *    camping exploit and rewards checking in.
 *
 * Accrual is LAZY (no hourly cron): every shot first banks the elapsed time
 * since the board's lastAccrualAt watermark; the daily settle job banks the
 * final tail, rolls lb:{date} into lb:alltime, and posts the results thread.
 *
 * Keys:
 *   lb:{date}    ZSET  member=username score=banked points   (ratified)
 *   lb:alltime   ZSET  cumulative across days                (ratified)
 *   settle:{date} INCR flag — settle idempotency             (M6 addition)
 */
import { redis, reddit, context } from '@devvit/web/server';
import type { BankedEntry, BoardState, StoneState } from '../../shared/api';
import { pointsAt, BOARD_OWNER } from '../../shared/scoring';
import { GAME_DAY_OFFSET_HOURS, RINK_NUMBER, loadRink, rinkKey, saveRink } from './rink';

const MS_PER_HOUR = 3_600_000;

export function lbKey(date: string): string {
  return `lb:${date}`;
}
export const LB_ALLTIME_KEY = 'lb:alltime';

/**
 * Pure accrual math: points each owner earns for `elapsedMs` of survival at
 * current positions. ringPoints per hour, fractional, 2-decimal precision.
 * Seed and dead stones never accrue.
 */
export function computeAccruals(stones: StoneState[], elapsedMs: number): BankedEntry[] {
  if (elapsedMs <= 0) return [];
  const hours = elapsedMs / MS_PER_HOUR;
  const byOwner = new Map<string, number>();
  for (const s of stones) {
    if (!s.alive || s.owner === BOARD_OWNER) continue;
    const ring = pointsAt(s.x, s.y);
    if (ring === 0) continue;
    byOwner.set(s.owner, (byOwner.get(s.owner) ?? 0) + ring * hours);
  }
  return [...byOwner.entries()]
    .map(([owner, points]) => ({ owner, points: Math.round(points * 100) / 100 }))
    .filter((e) => e.points > 0);
}

/**
 * Banks accrual for `board` up to `nowMs` and advances the watermark.
 * Caller must hold the rink lock (or be the settle job for a closed day).
 * Returns the board with the new watermark; caller persists it.
 */
export async function accrueBoard(
  board: BoardState,
  date: string,
  nowMs: number
): Promise<BoardState> {
  const from = board.lastAccrualAt ?? board.updatedAt;
  const entries = computeAccruals(board.stones, nowMs - from);
  for (const e of entries) {
    await redis.zIncrBy(lbKey(date), e.owner, e.points);
  }
  return { ...board, lastAccrualAt: nowMs };
}

/** Today's banked standings, highest first. */
export async function getBanked(date: string): Promise<BankedEntry[]> {
  const members = await redis.zRange(lbKey(date), 0, -1);
  return members
    .map((m) => ({ owner: m.member, points: Math.round(m.score * 100) / 100 }))
    .sort((a, b) => b.points - a.points);
}

/**
 * Daily settle for `date` (normally yesterday, run by cron at 00:05 UTC).
 * Idempotent: the settle:{date} flag guarantees exactly-once banking and
 * exactly-one results post, even if the job fires twice.
 */
export async function settleDay(date: string): Promise<string> {
  const flag = await redis.incrBy(`settle:${date}`, 1);
  await redis.expire(`settle:${date}`, 7 * 24 * 3600);
  if (flag !== 1) {
    return `already settled (flag=${flag})`;
  }

  // Bank the tail: survival from the last watermark to end of the game day.
  // Game day {date} spans [{date} 05:00Z, {date}+1 05:00Z) — midnight Central.
  const endOfDayMs =
    Date.parse(`${date}T00:00:00Z`) + (24 + GAME_DAY_OFFSET_HOURS) * 3_600_000;
  const key = rinkKey(date, RINK_NUMBER);
  const { board } = await loadRink(key, date);
  const settled = await accrueBoard(board, date, endOfDayMs);
  await saveRink(key, settled);

  // Roll the day into the all-time board.
  const standings = await getBanked(date);
  for (const e of standings) {
    await redis.zIncrBy(LB_ALLTIME_KEY, e.owner, e.points);
  }

  // Results thread — top finishers get a screenshot-worthy title card line.
  const medals = ['🏆', '🥈', '🥉'];
  const titles = ['Rink Champion', 'Runner-up', 'Third Stone'];
  const lines =
    standings.length === 0
      ? ['No stones scored today. The rings sit empty, waiting.']
      : standings.slice(0, 10).map((e, i) => {
          const badge = medals[i] ?? `${i + 1}.`;
          const title = titles[i] ? ` — **${titles[i]}**` : '';
          return `${badge} u/${e.owner}${title} · banked **${e.points}** pts surviving the rings`;
        });
  const body = [
    `# Knockit — Daily Results for ${date}`,
    '',
    ...lines,
    '',
    '*Points accrue every hour your stones survive in the rings — knockouts stop the clock but never rob the bank.*',
    '',
    "*Today's board is live. The board remembers everyone.*",
  ].join('\n');

  try {
    await reddit.submitPost({
      subredditName: context.subredditName,
      title: `Knockit Daily Results — ${date}`,
      text: body,
    });
  } catch (error) {
    // Banking succeeded; a failed post shouldn't mark the day unsettled.
    console.error(`settle ${date}: results post failed:`, error);
    return `settled; results post FAILED: ${String(error)}`;
  }
  return `settled; ${standings.length} players banked`;
}

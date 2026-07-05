import { Hono } from 'hono';
import { createPost } from '../core/post';
import { settleDay } from '../core/settle';
import { todayUtc } from '../core/rink';

export const scheduler = new Hono();

/**
 * Daily settle (cron "5 0 * * *" UTC, declared in devvit.json).
 * 1. Settles YESTERDAY: banks the accrual tail, rolls lb:{date} into
 *    lb:alltime, posts the results thread. Idempotent via settle:{date}.
 * 2. Content flywheel: creates TODAY's fresh game post so the subreddit
 *    always has a live board at the top of the feed (posts decay; the
 *    game shouldn't).
 */
scheduler.post('/daily-settle', async (c) => {
  // Yesterday IN GAME DAYS (midnight-Central rollover), not calendar UTC.
  const yesterday = todayUtc(Date.now() - 24 * 3600 * 1000);
  try {
    const outcome = await settleDay(yesterday);
    console.log(`daily-settle ${yesterday}: ${outcome}`);
  } catch (error) {
    console.error(`daily-settle ${yesterday} failed:`, error);
    return c.json({ status: 'error' }, 500);
  }

  // Fresh daily post — failure here shouldn't fail the settle.
  // Numbered like the featured daily games ("Hot and cold #335"): the count
  // signals an unbroken daily streak to anyone landing on the subreddit.
  try {
    const today = todayUtc();
    const dayNumber =
      Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse('2026-07-01T00:00:00Z')) / 86_400_000);
    await createPost(`Knockit Daily #${dayNumber} — the board remembers everyone`);
  } catch (error) {
    console.error('daily post creation failed:', error);
  }
  return c.json({ status: 'ok' }, 200);
});

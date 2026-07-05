# Knockit

**The board remembers everyone.**

Knockit is an asynchronous multiplayer physics game built for Reddit with Devvit Web and Phaser. Every day, one shared board. Every player gets three stones. Nothing resets when you leave — the stones you flick stay on the board for every Redditor who plays after you, and theirs can knock yours around while you're gone.

## How to play

1. Open the daily Knockit post and tap **Start**.
2. You have **three stones** per day. Drag back from the orange stone to aim — the dashed line shows your launch direction and a power meter shows your strength.
3. Release to shoot. The server simulates your shot with real physics; you watch the actual trajectory play back, collisions and all.
4. **Land in the rings to score.** Gold center = 3 points, middle ring = 2, outer ring = 1.
5. Your score has two parts:
   - **Live score** — the ring value of your stones right now. Other players can knock you out and take it away.
   - **Banked points** — accrue automatically for every hour your stones survive in the rings. Banked points are permanent; a knockout stops the clock but never robs the bank.
6. **Revenge:** if another player knocks your stone out of the rings, you get **one bonus revenge shot** that day — the game names who hit you. Come back and answer.
7. At the end of each day (UTC), the board settles: final points bank, results post to the subreddit, and a fresh board spawns.

The whole loop: shoot, leave, wonder what happened to your stones, come back, find out, get even.

## What makes it multiplayer

- **One shared persistent board per day** — every player affects every other player's game.
- **Presence** — see who else is on the rink right now (green counter, tap for names).
- **Auto-refresh** — other players' shots appear on your board while you watch.
- **Live leaderboard** — live ring scores plus banked survival points, updated with every shot.
- **Daily results thread** — champions crowned every day in the subreddit.

## Architecture

- **Client (Phaser 4):** rendering, aim input, and trajectory playback only. The client never simulates a real shot — it sends `{angle, power}` and animates whatever the server returns.
- **Server (Devvit Web, Hono, headless Matter.js):** the single source of truth. Every shot acquires a per-board Redis lock, rebuilds the physics world from persisted state, simulates with anti-tunneling substepping, banks survival accrual, detects knockouts, grants revenge, and persists the result.
- **Redis:** daily board state, per-user shot allowances and revenge flags, banked-score leaderboards (daily + all-time), presence.
- **Scheduler:** a daily job settles yesterday's board, posts results, and creates today's post.
- Identity is derived exclusively from Reddit's authenticated context server-side; the client cannot claim a username.

## Development

```bash
npm install
npm run dev     # playtest against the dev subreddit
npm run deploy  # type-check, lint, and upload
```

Built with the Devvit Phaser starter (thanks to the Phaser team for the template). Created for Reddit's "Games with a Hook" hackathon, 2026.

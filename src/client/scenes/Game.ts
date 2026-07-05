import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import type {
  BankedEntry,
  BoardResponse,
  BoardState,
  ErrorResponse,
  Knockout,
  PresenceResponse,
  RevengeInfo,
  ShotRequest,
  ShotResponse,
} from '../../shared/api';
import type { ScoreEntry } from '../../shared/scoring';
import { STONE, SPAWN, FLICK } from '../../shared/physics';
import { pointsAt } from '../../shared/scoring';
import { BOARD, RINGS, STONE_COLOR, PLAYER_COLOR, GRAB_RADIUS_MULT } from '../config/board';

/**
 * Milestone 2 — server-authoritative board.
 *
 * The client no longer simulates real shots. It:
 *   1. GETs /api/board and renders the persisted rink state.
 *   2. Lets the player aim (drag-and-release from the spawn point).
 *   3. POSTs {angle, power} to /api/shot (with jittered retry on 409).
 *   4. Plays back the trajectory frames the server returns.
 *   5. Snaps to the authoritative final board state.
 *
 * The aim line shows pull + launch direction only; there is no predictive
 * trajectory, by design (server is the single source of truth).
 */
export class Game extends Scene {
  /** Rendered stones, keyed by persisted stone id. */
  private stoneSprites = new Map<string, Phaser.GameObjects.Arc>();
  /** Stone owner lookup for tap-to-identify. */
  private ownerById = new Map<string, string>();
  private username = 'anonymous';

  /** Ghost stone marking the spawn point while aiming. */
  private ghost!: Phaser.GameObjects.Arc;
  private aimGraphics!: Phaser.GameObjects.Graphics;
  private statusText!: Phaser.GameObjects.Text;

  private isAiming = false;
  private isShooting = false; // POST in flight or playback running

  /**
   * Server-authoritative shot allowance (M3). The client never decides this
   * value — it displays whatever GET /api/board and POST /api/shot return and
   * gates input locally purely as UX; the server enforces the real limit.
   */
  private shotsRemaining = 0;
  private shotsText!: Phaser.GameObjects.Text;

  /** M5 revenge state — server-driven, never computed locally. */
  private revenge: RevengeInfo = { available: false, against: null };
  private loggedIn = true; // assume yes until /board says otherwise
  private streak = 0; // consecutive days played (server-computed)
  /** Knockouts from the just-fired shot, shown when playback settles. */
  private lastKnockouts: Knockout[] = [];
  /** Set when the last shot avenged you on your attacker (banked bonus). */
  private lastRevengeServedOn: string | null = null;

  /** Onboarding panel; blocks aiming until dismissed. */
  private onboarding: Phaser.GameObjects.Container | null = null;

  /** End-of-session card (shown once when the last stone is spent). */
  private sessionEndPanel: Phaser.GameObjects.Container | null = null;
  private sessionEndShown = false;
  /** My current live ring score (for the copy-result line). */
  private myLiveScore = 0;

  /** Live-player presence (polled every 30s; "live" = activity in last 45s). */
  private presenceChip!: Phaser.GameObjects.Text;
  private presenceList!: Phaser.GameObjects.Text;
  private presenceExpanded = false;

  /** Live leaderboard (M4) — displays whatever the server computed. */
  private leaderboardText!: Phaser.GameObjects.Text;
  /** Banked accrual points (M6), keyed by owner. Shown as "(+N)". */
  private bankedByOwner = new Map<string, number>();

  /** Trajectory playback state. */
  private frames: ShotResponse['frames'] = [];
  private playbackFps = 60;
  private playbackIndex = 0;
  private playbackElapsedMs = 0;
  private pendingBoard: BoardState | null = null;
  /** The stone launched by the shot being played back (drives impact juice). */
  private playbackStoneId: string | null = null;
  private impactShakeFired = false;

  /** Spectator replay bookkeeping: last shot id we've seen/played. */
  private lastSeenShotId: string | null = null;
  private hasRenderedOnce = false;

  /** Juice: score popup queued for when playback settles ({x, y, pts}). */
  private pendingScorePopup: { x: number; y: number; pts: number } | null = null;
  /** WebAudio synth (no asset files); created on first user gesture. */
  private audioCtx: AudioContext | null = null;

  constructor() {
    super('Game');
  }

  create() {
    this.stoneSprites = new Map();
    this.isAiming = false;
    this.isShooting = false;
    this.frames = [];
    this.pendingBoard = null;

    this.drawBoard();

    // 6px white dot texture for impact spark particles (drawn, not loaded).
    if (!this.textures.exists('spark')) {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(0xffffff, 1).fillCircle(3, 3, 3);
      g.generateTexture('spark', 6, 6);
      g.destroy();
    }

    this.ghost = this.add
      .circle(SPAWN.x, SPAWN.y, STONE.radius, PLAYER_COLOR, 0.85)
      .setStrokeStyle(2, 0xffffff, 0.6)
      .setDepth(4);

    this.aimGraphics = this.add.graphics().setDepth(5);

    this.statusText = this.add
      .text(BOARD.centerX, 40, 'Loading board…', {
        fontFamily: 'Arial Black',
        fontSize: 22,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setDepth(10);

    this.shotsRemaining = 0; // unknown until the server answers
    this.shotsText = this.add
      .text(BOARD.width - 24, 24, '', {
        fontFamily: 'Arial Black',
        fontSize: 26,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 6,
      })
      .setOrigin(1, 0)
      .setDepth(10);
    this.updateShotsHud();

    // Live leaderboard (M4): compact, top-left, out of the play area (rings
    // start ~270px from the left edge at their widest).
    this.leaderboardText = this.add
      .text(24, 24, '', {
        fontFamily: 'Courier',
        fontSize: 18,
        color: '#ffffff',
        backgroundColor: '#00000088',
        padding: { x: 10, y: 8 } as Phaser.Types.GameObjects.Text.TextPadding,
      })
      .setDepth(10)
      .setInteractive({ useHandCursor: true });
    // Tap the leaderboard for the one-line rules of scoring.
    this.leaderboardText.on('pointerup', () => {
      this.setStatus('Rings pay per hour survived. (+N) = banked — knockout-proof.', '#9be8c5');
    });
    this.renderScores([]);

    // Presence chip: count always visible, tap to expand the name list.
    this.presenceExpanded = false;
    this.presenceChip = this.add
      .text(BOARD.width - 24, 68, '🟢 …', {
        fontFamily: 'Arial Black',
        fontSize: 20,
        color: '#9be8c5',
        backgroundColor: '#00000088',
        padding: { x: 10, y: 6 } as Phaser.Types.GameObjects.Text.TextPadding,
      })
      .setOrigin(1, 0)
      .setDepth(10)
      .setInteractive({ useHandCursor: true });
    this.presenceList = this.add
      .text(BOARD.width - 24, 148, '', {
        fontFamily: 'Courier',
        fontSize: 16,
        color: '#ffffff',
        backgroundColor: '#000000aa',
        padding: { x: 10, y: 8 } as Phaser.Types.GameObjects.Text.TextPadding,
        align: 'right',
      })
      .setOrigin(1, 0)
      .setDepth(10)
      .setVisible(false);
    this.presenceChip.on('pointerup', () => {
      this.presenceExpanded = !this.presenceExpanded;
      this.presenceList.setVisible(this.presenceExpanded && this.presenceList.text.length > 0);
    });

    // Explicit opt-in subscribe button (userActions compliance: its own
    // distinct action, never automatic, never gates play).
    const joinBtn = this.add
      .text(BOARD.width - 24, 104, '➕ Join the rink', {
        fontFamily: 'Arial Black',
        fontSize: 18,
        color: '#ffffff',
        backgroundColor: '#1a4d8f',
        padding: { x: 10, y: 6 } as Phaser.Types.GameObjects.Text.TextPadding,
      })
      .setOrigin(1, 0)
      .setDepth(10)
      .setInteractive({ useHandCursor: true });
    joinBtn.on('pointerup', () => {
      void (async () => {
        try {
          const res = await fetch('/api/subscribe', { method: 'POST' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          joinBtn.setText('✓ Joined').setBackgroundColor('#1f7a5a').disableInteractive();
        } catch {
          this.setStatus('Subscribe failed — try again', '#ff8888');
        }
      })();
    });

    // Heartbeat: poll immediately, then every 15s (scene-scoped timer).
    void this.fetchPresence();
    this.time.addEvent({ delay: 15_000, loop: true, callback: () => void this.fetchPresence() });

    this.setupInput();
    this.showOnboarding();

    void this.fetchBoard();
  }

  /** 30s heartbeat: updates the presence chip AND auto-refreshes the board
   *  (replacing the removed Reload button). The refresh is skipped while the
   *  player is aiming or a shot is playing back, so stones never jump mid-action. */
  private async fetchPresence(): Promise<void> {
    try {
      const res = await fetch('/api/presence', { cache: 'no-store' });
      if (!res.ok) return; // presence is cosmetic; fail silently
      const data = (await res.json()) as PresenceResponse;
      this.presenceChip.setText(`🟢 ${data.count} online`);
      const shown = data.users.slice(0, 8).map((u) => `u/${u}`);
      const extra = data.users.length - shown.length;
      this.presenceList.setText(shown.join('\n') + (extra > 0 ? `\n+${extra} more` : ''));
      this.presenceList.setVisible(this.presenceExpanded && data.users.length > 0);
    } catch {
      /* cosmetic — never interrupt gameplay for presence */
    }

    if (!this.isAiming && !this.isShooting) {
      await this.fetchBoard();
    }
  }

  /** Onboarding copy (M3 spec). Tap anywhere to dismiss and start playing. */
  private showOnboarding(): void {
    const bg = this.add
      .rectangle(BOARD.centerX, BOARD.centerY, 620, 420, 0x000000, 0.82)
      .setStrokeStyle(2, 0xffffff, 0.4);
    const text = this.add
      .text(
        BOARD.centerX,
        BOARD.centerY - 20,
        [
          'Welcome to Knockit',
          '',
          'You have three stones.',
          'Drag to aim.',
          'Release to shoot.',
          'Land in the rings to score.',
          '',
          'Every stone stays on the shared board.',
          'Other Redditors can move your stones.',
          '',
          'The board updates automatically as others play.',
        ].join('\n'),
        {
          fontFamily: 'Arial Black',
          fontSize: 24,
          color: '#ffffff',
          align: 'center',
        }
      )
      .setOrigin(0.5);
    const tapHint = this.add
      .text(BOARD.centerX, BOARD.centerY + 170, 'tap to start', {
        fontFamily: 'Arial Black',
        fontSize: 20,
        color: '#f2b705',
      })
      .setOrigin(0.5);

    this.onboarding = this.add.container(0, 0, [bg, text, tapHint]).setDepth(30);
  }

  /** Can the player fire right now? Daily shots, or the revenge bonus. */
  private canShoot(): boolean {
    return this.shotsRemaining > 0 || this.revenge.available;
  }

  private updateShotsHud(): void {
    if (!this.loggedIn) {
      this.shotsText.setText('Log in to play').setColor('#f2b705');
      return;
    }
    if (this.shotsRemaining <= 0 && this.revenge.available) {
      this.shotsText.setText('⚔ REVENGE SHOT').setColor('#f2b705');
      return;
    }
    const flame = this.streak > 1 ? `  🔥${this.streak}` : '';
    this.shotsText.setText(`Shots Remaining: ${this.shotsRemaining}${flame}`);
    this.shotsText.setColor(this.shotsRemaining === 0 ? '#ff8888' : '#ffffff');
  }

  override update(_time: number, deltaMs: number) {
    if (this.frames.length === 0) return;

    // Advance playback by real elapsed time so it runs at the server's fps.
    this.playbackElapsedMs += deltaMs;
    const targetIndex = Math.floor((this.playbackElapsedMs / 1000) * this.playbackFps);

    while (this.playbackIndex <= targetIndex && this.playbackIndex < this.frames.length) {
      const frame = this.frames[this.playbackIndex]!;
      for (const s of frame.stones) {
        const sprite = this.stoneSprites.get(s.id) ?? this.spawnSprite(s.id);
        sprite.setPosition(s.x, s.y);
      }
      // Impact juice: the first frame where anything BESIDES the launched
      // stone moves is the moment of first contact — shake, sparks, thock.
      if (!this.impactShakeFired) {
        const struck = frame.stones.find((s) => s.id !== this.playbackStoneId);
        if (struck) {
          this.impactShakeFired = true;
          this.cameras.main.shake(130, 0.005);
          this.burstSparks(struck.x, struck.y);
          this.playThock();
        }
      }
      this.playbackIndex++;
    }

    if (this.playbackIndex >= this.frames.length) {
      this.finishPlayback();
    }
  }

  // ---------------------------------------------------------------- rendering

  private drawBoard(): void {
    const g = this.add.graphics();
    g.fillStyle(BOARD.backgroundColor, 1).fillRect(0, 0, BOARD.width, BOARD.height);
    for (const ring of RINGS) {
      g.fillStyle(ring.color, 1).fillCircle(BOARD.centerX, BOARD.centerY, ring.radius);
      g.lineStyle(2, 0xffffff, 0.35).strokeCircle(BOARD.centerX, BOARD.centerY, ring.radius);
    }
  }

  /** Creates the Arc for a stone id (yours = orange, everyone else = grey). */
  private spawnSprite(id: string, x: number = SPAWN.x, y: number = SPAWN.y): Phaser.GameObjects.Arc {
    const isMine = id.startsWith(`${this.username}-`);
    const arc = this.add
      .circle(x, y, STONE.radius, isMine ? PLAYER_COLOR : STONE_COLOR)
      .setStrokeStyle(2, 0x000000, 0.4)
      .setDepth(3);
    this.stoneSprites.set(id, arc);
    return arc;
  }

  /** Replaces all rendered stones with the given authoritative state. */
  private renderBoard(board: BoardState): void {
    for (const sprite of this.stoneSprites.values()) sprite.destroy();
    this.stoneSprites.clear();
    this.ownerById.clear();
    for (const stone of board.stones) {
      if (!stone.alive) continue;
      this.ownerById.set(stone.id, stone.owner);
      this.spawnSprite(stone.id, stone.x, stone.y);
    }
  }

  private setStatus(msg: string, color = '#ffffff'): void {
    this.statusText.setText(msg).setColor(color);
  }

  // ---------------------------------------------------------------- juice

  private burstSparks(x: number, y: number): void {
    const emitter = this.add.particles(x, y, 'spark', {
      speed: { min: 60, max: 200 },
      lifespan: 350,
      scale: { start: 1, end: 0 },
      emitting: false,
    });
    emitter.setDepth(6);
    emitter.explode(14, 0, 0);
    this.time.delayedCall(600, () => emitter.destroy());
  }

  /** Floating "+N" over a freshly scored stone. */
  private showScorePopup(x: number, y: number, pts: number): void {
    const label = this.add
      .text(x, y - 30, `+${pts}`, {
        fontFamily: 'Arial Black',
        fontSize: 34,
        color: '#f2b705',
        stroke: '#000000',
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setDepth(7);
    this.tweens.add({
      targets: label,
      y: y - 90,
      alpha: 0,
      duration: 900,
      ease: 'Cubic.easeOut',
      onComplete: () => label.destroy(),
    });
  }

  /** Lazy WebAudio synth — sounds without asset files. Requires a prior user
   *  gesture; ensureAudio() is called from pointerdown. */
  private ensureAudio(): void {
    if (!this.audioCtx) {
      try {
        this.audioCtx = new AudioContext();
      } catch {
        this.audioCtx = null; // no audio support — stay silent
      }
    }
    if (this.audioCtx?.state === 'suspended') void this.audioCtx.resume();
  }

  private playTone(
    freqFrom: number,
    freqTo: number,
    ms: number,
    type: OscillatorType,
    delayMs = 0
  ): void {
    const ctx = this.audioCtx;
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime + delayMs / 1000;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqFrom, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(freqTo, 1), t0 + ms / 1000);
    gain.gain.setValueAtTime(0.12, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + ms / 1000);
  }

  /** Stone-on-stone contact — pitch varies so repeated shots don't sound canned. */
  private playThock(): void {
    const base = 140 + Math.random() * 60;
    this.playTone(base, base * 0.45, 90, 'triangle');
  }

  /** Score payoff. */
  private playDing(): void {
    this.playTone(660, 880, 160, 'sine');
  }

  /** Rising three-note sting for the best moment in the game. */
  private playRevengeSting(): void {
    this.playTone(440, 440, 110, 'sine', 0);
    this.playTone(554, 554, 110, 'sine', 120);
    this.playTone(659, 880, 220, 'sine', 240);
  }

  /** Renders the server-computed leaderboard. "►" marks your own row.
   *  Format: live ring score, then banked accrual as "(+N)" when present. */
  private renderScores(scores: ScoreEntry[]): void {
    this.myLiveScore = scores.find((s) => s.owner === this.username)?.score ?? 0;
    const top = scores.slice(0, 5);
    const lines = ['🏆 Scores'];
    if (top.length === 0 && this.bankedByOwner.size === 0) {
      lines.push('No scores yet —', 'land in the rings');
    } else {
      for (const s of top) {
        const marker = s.owner === this.username ? '► ' : '  ';
        const banked = Math.round(this.bankedByOwner.get(s.owner) ?? 0);
        const bank = banked > 0 ? ` (+${banked})` : '';
        lines.push(`${marker}${s.owner.slice(0, 12).padEnd(12)} ${s.score}${bank}`);
      }
    }
    this.leaderboardText.setText(lines.join('\n'));
  }

  private setBanked(banked: BankedEntry[]): void {
    this.bankedByOwner = new Map(banked.map((b) => [b.owner, b.points]));
  }

  /** Shown once per session when the final stone is spent: the comeback pitch. */
  private showSessionEnd(): void {
    if (this.sessionEndShown) return;
    this.sessionEndShown = true;

    const bg = this.add
      .rectangle(BOARD.centerX, BOARD.centerY, 640, 330, 0x000000, 0.85)
      .setStrokeStyle(2, 0xf2b705, 0.6);
    const banked = this.bankedByOwner.get(this.username) ?? 0;
    const streakLine =
      this.streak > 1 ? `🔥 ${this.streak}-day streak — safe until midnight UTC.` : '';
    const text = this.add
      .text(
        BOARD.centerX,
        BOARD.centerY - 40,
        [
          'Out of stones for today',
          '',
          'Your stones keep banking points every hour they survive.',
          'If someone knocks you out, a revenge shot will be waiting.',
          streakLine,
        ].join('\n'),
        { fontFamily: 'Arial Black', fontSize: 22, color: '#ffffff', align: 'center' }
      )
      .setOrigin(0.5);

    const copyBtn = this.add
      .text(BOARD.centerX, BOARD.centerY + 75, '📋 Copy today\'s result', {
        fontFamily: 'Arial Black',
        fontSize: 20,
        color: '#ffffff',
        backgroundColor: '#1a4d8f',
        padding: { x: 14, y: 8 } as Phaser.Types.GameObjects.Text.TextPadding,
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    copyBtn.on('pointerup', () => {
      const line = `🥌 Knockit: my stones hold ${this.myLiveScore} pts on today's board (+${banked} banked). Come knock me out — the board remembers everyone. r/knockit_game_dev`;
      navigator.clipboard
        ?.writeText(line)
        .then(() => copyBtn.setText('✓ Copied!').setBackgroundColor('#1f7a5a'))
        .catch(() => copyBtn.setText('Copy blocked — screenshot instead'));
    });

    const hint = this.add
      .text(BOARD.centerX, BOARD.centerY + 135, 'tap anywhere to close', {
        fontFamily: 'Arial Black',
        fontSize: 16,
        color: '#9be8c5',
      })
      .setOrigin(0.5);

    this.sessionEndPanel = this.add.container(0, 0, [bg, text, copyBtn, hint]).setDepth(30);
  }

  // ---------------------------------------------------------------- API calls

  private async fetchBoard(): Promise<void> {
    try {
      // no-store: the webview may otherwise serve a cached GET and make
      // Reload appear dead (M2 review fix #3).
      const res = await fetch('/api/board', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as BoardResponse;
      this.username = data.username;

      // Spectator replay: if another player's shot landed since our last look,
      // play their trajectory from the (pre-shot) positions we're rendering,
      // then snap to the authoritative board. First load never replays.
      const shot = data.lastShot;
      const replaying = Boolean(
        shot &&
          shot.stoneId !== this.lastSeenShotId &&
          shot.owner !== data.username &&
          this.hasRenderedOnce &&
          !this.isShooting &&
          !this.isAiming
      );
      if (shot) this.lastSeenShotId = shot.stoneId;

      if (replaying && shot) {
        this.ownerById.set(shot.stoneId, shot.owner);
        this.frames = shot.frames;
        this.playbackFps = shot.fps;
        this.playbackIndex = 0;
        this.playbackElapsedMs = 0;
        this.pendingBoard = data.board;
        this.playbackStoneId = shot.stoneId;
        this.impactShakeFired = false;
        this.isShooting = true;
        this.ghost.setVisible(false);
        this.setStatus(`▶ u/${shot.owner} shoots…`, '#9be8c5');
      } else if (!this.isShooting) {
        this.renderBoard(data.board);
      }
      this.hasRenderedOnce = true;

      // Shot allowance + revenge are the server's word, never computed locally.
      this.shotsRemaining = data.shotsRemaining;
      this.loggedIn = data.loggedIn;
      this.streak = data.streak;
      this.revenge = data.revenge;
      this.updateShotsHud();
      this.setBanked(data.banked);
      this.renderScores(data.scores);
      this.ghost.setVisible(!this.isShooting && this.canShoot());

      // Revenge banner outranks the routine status line — it's the hook.
      if (replaying) {
        /* keep the "u/X shoots…" line during replay */
      } else if (this.revenge.available) {
        const who = this.revenge.against ? `u/${this.revenge.against}` : 'Someone';
        this.setStatus(`⚔ ${who} knocked your stone out — take your revenge shot!`, '#f2b705');
      } else {
        // Visible confirmation that the reload really happened, even when the
        // board content is unchanged.
        const at = new Date(data.board.updatedAt).toLocaleTimeString();
        const alive = data.board.stones.filter((s) => s.alive).length;
        this.setStatus(`u/${data.username} · ${alive} stones · updated ${at}`);
      }
    } catch (error) {
      console.error('fetchBoard failed:', error);
      this.setStatus('Failed to load board — retrying shortly', '#ff8888');
    }
  }

  /**
   * POSTs the shot. On 409 (rink locked by another player's shot) retries with
   * jittered 150–400ms backoff; the player only sees an error if all retries
   * are exhausted (ratified requirement — no raw 409s surfaced).
   */
  private async postShot(shot: ShotRequest): Promise<ShotResponse | null> {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch('/api/shot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(shot),
      });
      if (res.ok) return (await res.json()) as ShotResponse;

      let err: ErrorResponse | null = null;
      try {
        err = (await res.json()) as ErrorResponse;
      } catch {
        /* non-JSON error body */
      }

      if (res.status === 409 && err?.code === 'locked' && attempt < maxAttempts) {
        const backoff = 150 + Math.random() * 250; // 150–400ms, jittered
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      // Surface the server's code so shoot() can react specifically.
      throw new Error(err?.code ?? `http_${res.status}`);
    }
    return null;
  }

  // ---------------------------------------------------------------- input

  private setupInput(): void {
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.ensureAudio(); // WebAudio needs a user gesture to unlock
      // First tap dismisses the onboarding panel instead of aiming.
      if (this.onboarding) {
        this.onboarding.destroy();
        this.onboarding = null;
        return;
      }
      if (this.sessionEndPanel) {
        // Taps on the copy button must reach it — only outside taps dismiss.
        const copyBtn = this.sessionEndPanel.getAt(2) as Phaser.GameObjects.Text;
        if (!copyBtn.getBounds().contains(p.x, p.y)) {
          this.sessionEndPanel.destroy();
          this.sessionEndPanel = null;
        }
        return;
      }
      if (!this.isShooting && this.canShoot()) {
        const d = Phaser.Math.Distance.Between(p.x, p.y, SPAWN.x, SPAWN.y);
        if (d <= STONE.radius * GRAB_RADIUS_MULT) {
          this.isAiming = true;
          this.drawAim(p);
          return;
        }
      }
      this.identifyStoneAt(p);
    });

    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.isAiming) this.drawAim(p);
    });

    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (!this.isAiming) return;
      this.isAiming = false;
      this.aimGraphics.clear();

      const dx = SPAWN.x - p.x;
      const dy = SPAWN.y - p.y;
      const power = Math.min(Math.hypot(dx, dy), FLICK.maxDragDistance);
      if (power < 4) {
        this.setStatus(`u/${this.username} — drag the orange stone`);
        return; // ignore taps / accidental micro-drags
      }

      void this.shoot({ angle: Math.atan2(dy, dx), power });
    });
  }

  /** Tap-to-identify: owner, current ring value, and time on the board.
   *  Age comes from the timestamp embedded in the stone id — no extra state. */
  private identifyStoneAt(p: Phaser.Input.Pointer): void {
    for (const [id, sprite] of this.stoneSprites) {
      if (Phaser.Math.Distance.Between(p.x, p.y, sprite.x, sprite.y) <= STONE.radius * 1.4) {
        const owner = this.ownerById.get(id) ?? '?';
        const pts = pointsAt(sprite.x, sprite.y);
        if (owner === 'board') {
          this.setStatus(`house stone · ${pts} pt${pts === 1 ? '' : 's'}`, '#9be8c5');
          return;
        }
        const born = /-(\d{13})-\d+$/.exec(id);
        const age = born ? this.formatAge(Date.now() - Number(born[1])) : null;
        const survival = age ? ` · surviving ${age}` : '';
        this.setStatus(`u/${owner} · ${pts} pt${pts === 1 ? '' : 's'}${survival}`, '#9be8c5');
        return;
      }
    }
  }

  /** "3h 12m" / "47m" — how long a stone has been on the board. */
  private formatAge(ms: number): string {
    const mins = Math.max(1, Math.floor(ms / 60_000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  /**
   * Aiming guide (M2 review fix #2): faint pull line under the finger, a bold
   * dashed launch line in the opposite direction, and a power readout. Color
   * shifts white -> gold -> red as power rises. Direction + power only — no
   * trajectory prediction (server is authoritative).
   */
  private drawAim(p: Phaser.Input.Pointer): void {
    const angle = Math.atan2(p.y - SPAWN.y, p.x - SPAWN.x);
    const len = Math.min(Math.hypot(p.x - SPAWN.x, p.y - SPAWN.y), FLICK.maxDragDistance);
    const frac = len / FLICK.maxDragDistance;
    const dx = Math.cos(angle) * len;
    const dy = Math.sin(angle) * len;

    const powerColor = frac < 0.5 ? 0xffffff : frac < 0.85 ? 0xf2b705 : 0xff3b30;

    this.aimGraphics.clear();

    // Max-drag ring: shows how far back a full-power pull reaches.
    this.aimGraphics
      .lineStyle(2, 0xffffff, 0.15)
      .strokeCircle(SPAWN.x, SPAWN.y, FLICK.maxDragDistance);

    // Pull line: thin, under the finger.
    this.aimGraphics
      .lineStyle(3, 0xffffff, 0.3)
      .lineBetween(SPAWN.x, SPAWN.y, SPAWN.x + dx, SPAWN.y + dy);

    // Launch line: bold and dashed, opposite the pull, scaled by power.
    this.drawDashedLine(SPAWN.x, SPAWN.y, SPAWN.x - dx * 1.6, SPAWN.y - dy * 1.6, powerColor);

    this.setStatus(`Power ${Math.round(frac * 100)}%`);
  }

  /** Phaser Graphics has no dash style; draw 12px segments with 8px gaps. */
  private drawDashedLine(x1: number, y1: number, x2: number, y2: number, color: number): void {
    const total = Math.hypot(x2 - x1, y2 - y1);
    if (total < 1) return;
    const ux = (x2 - x1) / total;
    const uy = (y2 - y1) / total;
    this.aimGraphics.lineStyle(6, color, 0.95);
    for (let d = 0; d < total; d += 20) {
      const seg = Math.min(12, total - d);
      this.aimGraphics.lineBetween(
        x1 + ux * d,
        y1 + uy * d,
        x1 + ux * (d + seg),
        y1 + uy * (d + seg)
      );
    }
  }

  // ---------------------------------------------------------------- shooting

  private async shoot(shot: ShotRequest): Promise<void> {
    this.isShooting = true;
    this.ghost.setVisible(false);
    this.setStatus('Shooting…');

    try {
      const result = await this.postShot(shot);
      if (!result) throw new Error('no result');

      // The server already validated, decremented, and persisted the
      // allowance — display its numbers, don't compute them.
      this.shotsRemaining = result.shotsRemaining;
      this.revenge = result.revenge;
      this.streak = result.streak;
      this.lastKnockouts = result.knockouts;
      this.lastRevengeServedOn = result.revengeServedOn;
      this.lastSeenShotId = result.stoneId; // don't replay our own shot
      this.updateShotsHud();
      this.renderScores(result.scores);

      // Start playback; update() drives the frames from here.
      this.frames = result.frames;
      this.playbackFps = result.fps;
      this.playbackIndex = 0;
      this.playbackElapsedMs = 0;
      this.pendingBoard = result.board;
      this.playbackStoneId = result.stoneId;
      this.impactShakeFired = false;

      // Queue the "+N" popup for where MY stone came to rest (if it scored).
      const mine = result.board.stones.find((s) => s.id === result.stoneId);
      const pts = mine ? pointsAt(mine.x, mine.y) : 0;
      this.pendingScorePopup = mine && pts > 0 ? { x: mine.x, y: mine.y, pts } : null;
    } catch (error) {
      console.error('shoot failed:', error);
      const code = error instanceof Error ? error.message : '';
      if (code === 'no_shots') {
        // Server says the allowance is spent — trust it, sync the HUD.
        this.shotsRemaining = 0;
        this.updateShotsHud();
        this.setStatus('No shots remaining today', '#ff8888');
      } else if (code === 'unauthenticated') {
        this.setStatus('Log in to Reddit to shoot', '#ff8888');
      } else {
        this.setStatus('Board busy — try again', '#ff8888');
      }
      this.isShooting = false;
      this.ghost.setVisible(this.canShoot());
    }
  }

  private finishPlayback(): void {
    this.frames = [];
    if (this.pendingBoard) {
      this.renderBoard(this.pendingBoard); // snap to authoritative state
      this.pendingBoard = null;
    }
    this.isShooting = false;

    // Score payoff: floating "+N" where the stone settled.
    if (this.pendingScorePopup) {
      const { x, y, pts } = this.pendingScorePopup;
      this.showScorePopup(x, y, pts);
      this.playDing();
      this.pendingScorePopup = null;
    }

    // Best payoff in the game: you avenged yourself on your attacker.
    if (this.lastRevengeServedOn) {
      this.setStatus(
        `⚔ REVENGE SERVED on u/${this.lastRevengeServedOn}! +3 banked`,
        '#f2b705'
      );
      this.playRevengeSting();
      this.lastRevengeServedOn = null;
      this.lastKnockouts = [];
      this.ghost.setVisible(this.canShoot());
      return;
    }

    // Attacker-side payoff: name who you just knocked out.
    if (this.lastKnockouts.length > 0) {
      const victims = [...new Set(this.lastKnockouts.map((k) => `u/${k.owner}`))].join(', ');
      this.setStatus(`💥 You knocked out ${victims}!`, '#f2b705');
      this.playDing();
      this.lastKnockouts = [];
    } else if (!this.canShoot()) {
      this.setStatus('No shots remaining', '#ff8888');
      this.showSessionEnd();
    } else {
      this.setStatus(`u/${this.username} — drag the orange stone`);
    }

    this.ghost.setVisible(this.canShoot());
  }

}

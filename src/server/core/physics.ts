/**
 * Server-authoritative shot simulation (headless Matter.js).
 *
 * This is the ONLY place real Knockit shots are simulated. The client never
 * runs shot physics; it plays back the trajectory this module returns.
 *
 * Anti-tunneling: the sim substeps each frame (SIM.substeps). Empirically
 * verified: substepping contains even 6x-over-cap launch speeds, while raising
 * positionIterations does NOT prevent tunneling — don't swap this for that.
 */
import { Engine, Bodies, Composite, Body } from 'matter-js';
import type { StoneState, TrajectoryFrame } from '../../shared/api';
import { BOARD, STONE, SPAWN, SIM, launchVelocity } from '../../shared/physics';

export type ShotSimResult = {
  stoneId: string;
  frames: TrajectoryFrame[];
  /** Every stone (existing + the new one) at rest, ready to persist. */
  finalStones: StoneState[];
};

const stoneBodyOptions = {
  frictionAir: STONE.frictionAir,
  friction: STONE.friction,
  restitution: STONE.restitution,
  density: STONE.density,
} as const;

/** Rebuilds the physics world from persisted rink state. */
function buildWorld(stones: StoneState[]): {
  engine: Engine;
  bodies: Map<string, Body>;
} {
  const engine = Engine.create();
  engine.gravity.x = 0;
  engine.gravity.y = 0;

  const t = SIM.wallThickness;
  const walls = [
    Bodies.rectangle(BOARD.width / 2, -t / 2, BOARD.width, t, { isStatic: true }),
    Bodies.rectangle(BOARD.width / 2, BOARD.height + t / 2, BOARD.width, t, { isStatic: true }),
    Bodies.rectangle(-t / 2, BOARD.height / 2, t, BOARD.height, { isStatic: true }),
    Bodies.rectangle(BOARD.width + t / 2, BOARD.height / 2, t, BOARD.height, { isStatic: true }),
  ];
  Composite.add(engine.world, walls);

  const bodies = new Map<string, Body>();
  for (const s of stones) {
    if (!s.alive) continue;
    const body = Bodies.circle(s.x, s.y, STONE.radius, { ...stoneBodyOptions });
    Body.setVelocity(body, { x: s.vx, y: s.vy });
    Composite.add(engine.world, body);
    bodies.set(s.id, body);
  }
  return { engine, bodies };
}

/**
 * Simulates one shot against the given rink state.
 *
 * A new stone spawns at SPAWN, receives the (server-clamped) launch velocity,
 * and the whole board is stepped until everything rests or SIM.maxFrames is
 * hit. Frames record only stones that actually moved, keeping the response
 * small.
 */
export function simulateShot(
  existingStones: StoneState[],
  owner: string,
  angle: number,
  power: number
): ShotSimResult {
  const { engine, bodies } = buildWorld(existingStones);

  const stoneId = `${owner}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const playerBody = Bodies.circle(SPAWN.x, SPAWN.y, STONE.radius, { ...stoneBodyOptions });
  Composite.add(engine.world, playerBody);
  bodies.set(stoneId, playerBody);

  const { vx, vy } = launchVelocity(angle, power); // clamped inside
  Body.setVelocity(playerBody, { x: vx, y: vy });

  const frames: TrajectoryFrame[] = [];
  const frameMs = 1000 / SIM.fps;
  const lastRecorded = new Map<string, { x: number; y: number }>();
  for (const [id, body] of bodies) {
    lastRecorded.set(id, { x: body.position.x, y: body.position.y });
  }

  for (let frame = 0; frame < SIM.maxFrames; frame++) {
    for (let s = 0; s < SIM.substeps; s++) {
      Engine.update(engine, frameMs / SIM.substeps);
    }

    // Record only stones displaced since their last recorded position.
    const moved: TrajectoryFrame['stones'] = [];
    for (const [id, body] of bodies) {
      const prev = lastRecorded.get(id)!;
      const dx = body.position.x - prev.x;
      const dy = body.position.y - prev.y;
      if (dx * dx + dy * dy > 0.25 * 0.25) {
        moved.push({
          id,
          x: Math.round(body.position.x * 100) / 100,
          y: Math.round(body.position.y * 100) / 100,
        });
        lastRecorded.set(id, { x: body.position.x, y: body.position.y });
      }
    }
    if (moved.length > 0) frames.push({ stones: moved });

    const maxSpeed = Math.max(
      ...[...bodies.values()].map((b) => Math.hypot(b.velocity.x, b.velocity.y))
    );
    if (maxSpeed < SIM.restSpeed) break;
  }

  // Authoritative final state: everything at rest at its settled position.
  const finalStones: StoneState[] = [];
  for (const s of existingStones) {
    if (!s.alive) {
      finalStones.push(s); // preserve dead stones untouched (schema keeps them)
      continue;
    }
    const body = bodies.get(s.id)!;
    finalStones.push({
      ...s,
      x: Math.round(body.position.x * 100) / 100,
      y: Math.round(body.position.y * 100) / 100,
      vx: 0,
      vy: 0,
    });
  }
  finalStones.push({
    id: stoneId,
    owner,
    x: Math.round(playerBody.position.x * 100) / 100,
    y: Math.round(playerBody.position.y * 100) / 100,
    vx: 0,
    vy: 0,
    alive: true,
  });

  return { stoneId, frames, finalStones };
}

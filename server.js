// Echo.io multiplayer server
//   npm install ws
//   node server.js        then open http://localhost:3000
//
// One shared arena. The server runs the game and the browsers only send input and draw what they receive.
// AI bots fill the empty space: there are always about TARGET_ENTITIES things in the arena,
// so bots step aside as more real players join.

const http = require('http');
const fs = require('fs');
const path = require('path');

let WebSocketServer;
try { ({ WebSocketServer } = require('ws')); }
catch (e) { console.error('Missing dependency. Run:  npm install ws'); process.exit(1); }

const PORT = +process.env.PORT || 3000;
const TARGET_ENTITIES = +process.env.TARGET_ENTITIES || 8; // players + bots
const MIN_BOTS = +process.env.MIN_BOTS || 2;
const MAX_PLAYERS = +process.env.MAX_PLAYERS || 16;

// Same rules as the "Regular" difficulty in the browser game
const W = 1400, H = 800;
const PLAYER_RADIUS = 12, MAX_RADIUS = 90;
const ECHO_RADIUS = 5, ECHO_SPEED = 140, HUMAN_ECHO_LIFE = 5000, BOT_ECHO_LIFE = 1000;
const PLAYER_FIRE_MS = 900, BOT_FIRE_MS = 1800, BOT_SPEED = 45, BOT_RESPAWN_MS = 2500;
const ORB_COUNT = 20, ORB_SCORE = 10, ORB_GROWTH = 0.4;
const KILL_SCORE = 75, KILL_GROWTH = 0.15, SPAWN_PROTECT_MS = 2500;

const TAU = Math.PI * 2;
const rand = (a, b) => Math.random() * (b - a) + a;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v)) ? clamp(v, lo, hi) : d;

let players = [], echoes = [], orbs = [], events = [];
let time = 0, nextId = 1, botNumber = 1;

function newOrb() { return { x: rand(30, W - 30), y: rand(30, H - 30), r: rand(5, 8) }; }
while (orbs.length < ORB_COUNT) orbs.push(newOrb());

function spot() { // random point away from living humans
  let x, y;
  for (let i = 0; i < 30; i++) {
    x = rand(60, W - 60); y = rand(60, H - 60);
    if (!players.some(p => !p.isBot && p.alive && Math.hypot(x - p.x, y - p.y) < 200)) break;
  }
  return { x, y };
}

function addEntity(name, skin, isBot) {
  const s = spot();
  const p = {
    id: nextId++, name, skin, isBot, x: s.x, y: s.y, vx: 0, vy: 0, radius: PLAYER_RADIUS, alive: true,
    angle: rand(0, TAU), lastEchoAt: isBot ? time - rand(0, BOT_FIRE_MS) : time, respawnIn: 0,
    invulnUntil: isBot ? 0 : time + SPAWN_PROTECT_MS, score: 0,
    input: { kx: 0, ky: 0, mx: s.x, my: s.y }
  };
  players.push(p);
  return p;
}

function removeEntity(p) {
  players = players.filter(q => q !== p);
  echoes = echoes.filter(e => e.owner !== p);
}

function respawn(p) {
  const s = spot();
  Object.assign(p, { x: s.x, y: s.y, vx: 0, vy: 0, radius: PLAYER_RADIUS, alive: true, score: 0,
    invulnUntil: time + SPAWN_PROTECT_MS, lastEchoAt: time });
  p.input.mx = s.x; p.input.my = s.y;
}

// Bots fill the empty space
function balanceBots() {
  const humans = players.filter(p => !p.isBot).length;
  const want = Math.max(MIN_BOTS, TARGET_ENTITIES - humans);
  const bots = players.filter(p => p.isBot).sort((a, b) => b.alive - a.alive); // dead bots go first
  while (bots.length < want) bots.push(addEntity('Bot ' + botNumber++, '', true));
  while (bots.length > want) removeEntity(bots.pop());
}

function fireEcho(p) {
  let a;
  if (p.isBot) a = p.angle;
  else if (Math.hypot(p.vx, p.vy) > 10) a = Math.atan2(p.vy, p.vx);
  else {
    const dx = p.input.mx - p.x, dy = p.input.my - p.y;
    a = (dx || dy) ? Math.atan2(dy, dx) : p.angle;
  }
  const off = p.radius + ECHO_RADIUS + 4;
  echoes.push({
    x: p.x + Math.cos(a) * off, y: p.y + Math.sin(a) * off,
    vx: Math.cos(a) * ECHO_SPEED, vy: Math.sin(a) * ECHO_SPEED,
    r: ECHO_RADIUS, owner: p, spawnAt: time, lifetime: p.isBot ? BOT_ECHO_LIFE : HUMAN_ECHO_LIFE
  });
  if (!p.isBot) events.push({ k: 'shot', by: p.id });
}

function step(dt) {
  time += dt * 1000;

  for (const p of players) {
    if (!p.alive) {
      if (p.isBot && (p.respawnIn -= dt * 1000) <= 0) {
        const s = spot();
        Object.assign(p, { x: s.x, y: s.y, alive: true, radius: PLAYER_RADIUS, lastEchoAt: time - rand(0, BOT_FIRE_MS) });
      }
      continue;
    }
    if (p.isBot) {
      if (Math.random() < dt * 1.5) p.angle = rand(0, TAU);
      p.x += Math.cos(p.angle) * BOT_SPEED * dt;
      p.y += Math.sin(p.angle) * BOT_SPEED * dt;
      if (p.x < p.radius || p.x > W - p.radius) p.angle = Math.PI - p.angle;
      if (p.y < p.radius || p.y > H - p.radius) p.angle = -p.angle;
    } else {
      const i = p.input;
      const max = 160 * Math.min(1.5, 1 + (p.radius - PLAYER_RADIUS) / 130);
      let tx = 0, ty = 0;
      if (i.kx || i.ky) { const m = Math.hypot(i.kx, i.ky); tx = i.kx / m * max; ty = i.ky / m * max; }
      else {
        const dx = i.mx - p.x, dy = i.my - p.y, d = Math.hypot(dx, dy);
        if (d > 10) { const s = Math.min(max, d * 3.5); tx = dx / d * s; ty = dy / d * s; }
      }
      const f = Math.min(1, 8 * dt);
      p.vx += (tx - p.vx) * f; p.vy += (ty - p.vy) * f;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (Math.hypot(p.vx, p.vy) > 1) p.angle = Math.atan2(p.vy, p.vx);
      p.score += 3 * dt;
    }
    p.x = clamp(p.x, p.radius, W - p.radius);
    p.y = clamp(p.y, p.radius, H - p.radius);

    if (time - p.lastEchoAt >= (p.isBot ? BOT_FIRE_MS : PLAYER_FIRE_MS)) { fireEcho(p); p.lastEchoAt = time; }
  }

  for (let k = echoes.length - 1; k >= 0; k--) {
    const e = echoes[k];
    e.x += e.vx * dt; e.y += e.vy * dt;
    if (e.x < e.r) { e.x = e.r; e.vx = Math.abs(e.vx); }
    if (e.x > W - e.r) { e.x = W - e.r; e.vx = -Math.abs(e.vx); }
    if (e.y < e.r) { e.y = e.r; e.vy = Math.abs(e.vy); }
    if (e.y > H - e.r) { e.y = H - e.r; e.vy = -Math.abs(e.vy); }
    if (time - e.spawnAt > e.lifetime) { echoes.splice(k, 1); continue; }

    for (const t of players) {
      if (!t.alive || t === e.owner || (t.isBot && e.owner.isBot)) continue; // bots never hurt bots
      if (Math.hypot(e.x - t.x, e.y - t.y) >= t.radius + e.r) continue;
      if (!t.isBot && time < t.invulnUntil) continue;                         // spawn protection
      t.alive = false;
      if (t.isBot) t.respawnIn = BOT_RESPAWN_MS;
      const o = e.owner;
      if (!o.isBot) {
        o.radius = Math.min(MAX_RADIUS, o.radius + t.radius * KILL_GROWTH);
        o.score += KILL_SCORE;
      }
      events.push({ k: 'kill', x: Math.round(t.x), y: Math.round(t.y), by: o.id, v: t.id, vb: t.isBot ? 1 : 0, vk: t.skin, bn: o.name, bb: o.isBot ? 1 : 0 });
      echoes.splice(k, 1);
      break;
    }
  }

  for (const p of players) {
    if (p.isBot || !p.alive) continue;
    for (let i = orbs.length - 1; i >= 0; i--) {
      const o = orbs[i];
      if (Math.hypot(o.x - p.x, o.y - p.y) < o.r + p.radius * 0.95) {
        orbs.splice(i, 1);
        p.score += ORB_SCORE;
        p.radius = Math.min(MAX_RADIUS, p.radius + ORB_GROWTH);
        events.push({ k: 'orb', x: Math.round(o.x), y: Math.round(o.y), by: p.id });
      }
    }
  }
  while (orbs.length < ORB_COUNT) orbs.push(newOrb());
}

function snapshot() {
  const q = n => Math.round(n * 10) / 10;
  return JSON.stringify({
    t: 's',
    p: players.map(p => ({ id: p.id, n: p.name, k: p.skin, b: p.isBot ? 1 : 0, x: q(p.x), y: q(p.y), r: q(p.radius), a: p.alive ? 1 : 0, iu: Math.max(0, Math.round(p.invulnUntil - time)), s: Math.floor(p.score) })),
    e: echoes.map(e => ({ x: q(e.x), y: q(e.y), vx: Math.round(e.vx), vy: Math.round(e.vy), o: e.owner.id, ag: Math.round(time - e.spawnAt), lt: e.lifetime })),
    o: orbs.map(o => ({ x: Math.round(o.x), y: Math.round(o.y), r: q(o.r) })),
    ev: events
  });
}

// ---------- web server: serves the game page, plus the WebSocket endpoint ----------
const server = http.createServer((req, res) => {
  const file = path.join(__dirname, 'echo-io.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('echo-io.html must be in the same folder as server.js'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 2048 });

wss.on('connection', ws => {
  let me = null;
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'join' && !me) {
      if (players.filter(p => !p.isBot).length >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'full' })); ws.close(); return; }
      const name = String(m.name || '').replace(/[^\w .-]/g, '').trim().slice(0, 14) || 'Player';
      const skin = /^[a-z0-9]{2,16}$/.test(m.skin) ? m.skin : 'cyan';
      me = addEntity(name, skin, false);
      ws.player = me;
      balanceBots();
      ws.send(JSON.stringify({ t: 'welcome', id: me.id, w: W, h: H }));
    } else if (!me) {
      return;
    } else if (m.t === 'in') {
      me.input.kx = num(m.kx, -1, 1, 0);
      me.input.ky = num(m.ky, -1, 1, 0);
      me.input.mx = num(m.mx, 0, W, me.x);
      me.input.my = num(m.my, 0, H, me.y);
    } else if (m.t === 'respawn') {
      if (!me.alive) respawn(me);
    } else if (m.t === 'skin') {
      if (/^[a-z0-9]{2,16}$/.test(m.k)) me.skin = m.k;
    }
  });
  ws.on('close', () => {
    if (me) { removeEntity(me); me = null; balanceBots(); }
  });
});

// 30 simulation ticks per second, 15 snapshots per second
let tick = 0, lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  step(dt);
  if (++tick % 2 === 0) {
    if (wss.clients.size) {
      const msg = snapshot();
      for (const c of wss.clients) if (c.player && c.readyState === 1) c.send(msg);
    }
    events = [];
  }
}, 1000 / 30);

balanceBots();
server.listen(PORT, () => console.log(`Echo.io server running: http://localhost:${PORT}  (WebSocket on the same port)`));

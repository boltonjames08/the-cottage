// The Cottage: tiny web server + WebSocket relay. No dependencies: run with `node server.js`.
// The DM's browser runs each game session; this server only links browsers that share a session code.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---- Voice relay (TURN). Voice normally goes straight between browsers; some home, school, work and phone
   networks block that, and then people can see each other talking but not hear them. A TURN server relays
   the voice instead. Set ONE of these on Render (Environment tab):
     METERED_API_KEY + METERED_APP   free account at metered.ca (Open Relay, 20 GB a month free)
     TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL   any other TURN server (urls comma-separated)
   With nothing set, the free public Open Relay server is tried. ---- */
let iceCache = null, iceAt = 0;
async function getIce() {
  const env = process.env;
  if (env.TURN_URLS) return [{ urls: env.TURN_URLS.split(',').map(u => u.trim()).filter(Boolean), username: env.TURN_USERNAME || '', credential: env.TURN_CREDENTIAL || '' }];
  if (env.METERED_API_KEY && env.METERED_APP) {
    if (iceCache && Date.now() - iceAt < 30 * 60000) return iceCache;
    try {
      const r = await fetch(`https://${env.METERED_APP}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY)}`);
      const j = await r.json(); if (Array.isArray(j)) { iceCache = j; iceAt = Date.now(); return j; }
      console.warn('TURN: unexpected reply from Metered', JSON.stringify(j).slice(0, 200));
    } catch (e) { console.warn('TURN: could not reach Metered', e.message); }
    return iceCache || [];
  }
  const user = Math.floor(Date.now() / 1000 + 24 * 3600) + ':cottage';
  const credential = crypto.createHmac('sha1', 'openrelayprojectsecret').update(user).digest('base64');
  const h = 'staticauth.openrelay.metered.ca';
  return [{ urls: [`turn:${h}:80`, `turn:${h}:80?transport=tcp`, `turn:${h}:443`, `turns:${h}:443?transport=tcp`], username: user, credential }];
}
async function sendIce(res) {
  let list = []; try { list = await getIce(); } catch (e) {}
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ iceServers: list }));
}

const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOMS = 300, MAX_PER_ROOM = 40, MAX_MSG = 2 * 1024 * 1024; // big enough for the shared Investigator's Book
// Optional: extra ICE servers for voice (for example a TURN service), as JSON in the ICE_SERVERS setting.
let ICE = null;
try { if (process.env.ICE_SERVERS) ICE = JSON.parse(process.env.ICE_SERVERS); } catch (e) { console.warn('ICE_SERVERS is not valid JSON, ignoring it'); }

// the game page can live in public/index.html or right next to this file (either works)
const PAGE_FILES = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html'), path.join(__dirname, 'the-cottage.html')];
const pageFile = () => PAGE_FILES.find(f => fs.existsSync(f));
// The Spell Circle (spell papers + voice call) lives at /spells
const SPELL_FILES = [path.join(__dirname, 'public', 'spells.html'), path.join(__dirname, 'spells.html')];
const spellFile = () => SPELL_FILES.find(f => fs.existsSync(f));
const inject = html => html.replace('<head>', '<head><script>window.COTTAGE_RELAY=true;' + (ICE ? 'window.COTTAGE_ICE=' + JSON.stringify(ICE) + ';' : '') + '</script>');
const page = () => fs.readFileSync(pageFile(), 'utf8')
  .replace('<head>', '<head><script>window.COTTAGE_RELAY=true;' + (ICE ? 'window.COTTAGE_ICE=' + JSON.stringify(ICE) + ';' : '') + '</script>');

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/ice') return sendIce(res); // voice relay (TURN) settings for people whose network blocks direct voice
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if ((url === '/' || url === '/index.html') && !pageFile()) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('The game page is missing. Upload index.html (from the zip) to your GitHub repository, next to server.js.');
  }
  if (url === '/spells' || url === '/spells/' || url === '/spells.html') {
    if (!spellFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('The Spell Circle page is missing. Upload spells.html to your GitHub repository, next to server.js.'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache',
      'Permissions-Policy': 'microphone=(self)', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    return res.end(inject(fs.readFileSync(spellFile(), 'utf8')));
  }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache',
      'Permissions-Policy': 'microphone=(self)', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    return res.end(page());
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
});

/* ---------- minimal WebSocket (RFC 6455) ---------- */
function frame(op, data) {
  const n = data.length; let head;
  if (n < 126) head = Buffer.from([0x80 | op, n]);
  else if (n < 65536) head = Buffer.from([0x80 | op, 126, n >> 8, n & 255]);
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, data]);
}
function accept(req, socket, onOpen) {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') return socket.destroy();
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0), closed = false, frag = null;
  const conn = {
    id: crypto.randomBytes(6).toString('hex'), alive: true,
    send(text) { if (!closed) socket.write(frame(1, Buffer.from(text))); },
    close() { if (!closed) { closed = true; try { socket.end(frame(8, Buffer.alloc(0))); } catch (e) {} } },
    ping() { if (!closed) socket.write(frame(9, Buffer.alloc(0))); },
    kill() { closed = true; socket.destroy(); },
    onMessage: null, onClose: null,
  };
  const end = () => { closed = true; const f = conn.onClose; conn.onClose = null; if (f) f(); };
  socket.on('data', d => {
    buf = Buffer.concat([buf, d]);
    if (buf.length > MAX_MSG * 2) return socket.destroy();
    while (buf.length >= 2) {
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MSG) return socket.destroy();
      const masked = (buf[1] & 128) !== 0; if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) { const mk = buf.subarray(off - 4, off); for (let i = 0; i < len; i++) payload[i] ^= mk[i & 3]; }
      const fin = (buf[0] & 128) !== 0, op = buf[0] & 15;
      buf = buf.subarray(off + len);
      if (op === 1 || (op === 0 && frag)) {
        frag = frag ? Buffer.concat([frag, payload]) : payload;
        if (frag.length > MAX_MSG) return socket.destroy();
        if (fin) { const t = frag.toString(); frag = null; if (conn.onMessage) conn.onMessage(t); }
      } else if (op === 8) { conn.close(); end(); return; }
      else if (op === 9) socket.write(frame(10, payload));
      else if (op === 10) conn.alive = true;
    }
  });
  socket.on('close', end); socket.on('error', end);
  onOpen(conn);
}

/* ---------- rooms: one DM (host) + players, keyed by session code ---------- */
const rooms = new Map(); // code -> { host, conns:Set }
server.on('upgrade', (req, socket) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/ws') return socket.destroy();
  if (u.searchParams.get('app') === 'spells') return accept(req, socket, spConn); // The Spell Circle: hosted here
  const code = String(u.searchParams.get('room') || '').toUpperCase();
  const asHost = u.searchParams.get('host') === '1', key = String(u.searchParams.get('key') || '');
  const rk = (u.searchParams.get('app') === 'spells' ? 'spells:' : '') + code; // The Cottage and The Spell Circle keep separate sessions
  accept(req, socket, conn => {
    const sys = (c, o) => c.send(JSON.stringify(o));
    if (!/^[A-Z0-9]{3,12}$/.test(code)) { sys(conn, { sys: 'no-room' }); return conn.close(); }
    let room = rooms.get(rk);
    if (room && asHost && /^[a-z0-9]{8,40}$/.test(key) && room.key === key) { // the same DM coming back (e.g. a refresh): the old tab's session ends
      room.dead = true; rooms.delete(rk);
      for (const c of room.conns) { sys(c, { sys: c === room.host ? 'replaced' : 'host-gone' }); c.close(); }
      room = null;
    }
    if (asHost) {
      if (room) { sys(conn, { sys: 'host-taken' }); return conn.close(); }
      if (rooms.size >= MAX_ROOMS) { sys(conn, { sys: 'full' }); return conn.close(); }
      room = { host: conn, conns: new Set([conn]), key }; rooms.set(rk, room);
    } else {
      if (!room) { sys(conn, { sys: 'no-room' }); return conn.close(); }
      if (room.conns.size >= MAX_PER_ROOM) { sys(conn, { sys: 'full' }); return conn.close(); }
      room.conns.add(conn);
    }
    conn.onMessage = text => {
      let d; try { d = JSON.parse(text); } catch (e) { return; }
      if (!d || typeof d !== 'object' || Array.isArray(d)) return;
      delete d.sys; delete d._h; d._c = conn.id;               // stamp the real sender; nobody can fake these
      if (conn === room.host) d._h = 1;
      const out = JSON.stringify(d);
      for (const c of room.conns) if (c !== conn) c.send(out);
    };
    conn.onClose = () => {
      if (room.dead) return;
      room.conns.delete(conn);
      if (conn === room.host) { for (const c of room.conns) { sys(c, { sys: 'host-gone' }); c.close(); } rooms.delete(rk); }
      else if (room.host) sys(room.host, { sys: 'gone', _c: conn.id });
    };
  });
});

/* =====================================================================================================
   The Spell Circle runs ON THIS SERVER (not in the DM's tab), so nobody has to keep the page open:
   phones can lock, people can switch apps, and they're shown as "away" until they come back.
   Spell folders and sessions are saved in a small online database, so they survive restarts.

   SAVING ONLINE: make a free database at https://upstash.com (Redis), then on Render → Environment add
     UPSTASH_REDIS_REST_URL   and   UPSTASH_REDIS_REST_TOKEN   (copy both from the database's "REST API" box)
   Without them everything is kept in a file next to this one, which Render's free plan wipes on restart.
   ===================================================================================================== */
const db = (() => {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const cmd = async (...args) => {
      const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(args) });
      const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
    };
    return { kind: 'online',
      async get(k) { const v = await cmd('GET', k); return v ? JSON.parse(v) : null; },
      async set(k, v) { await cmd('SET', k, JSON.stringify(v)); },
      async create(k, v) { return (await cmd('SET', k, JSON.stringify(v), 'NX')) === 'OK'; } };
  }
  const file = process.env.DATA_FILE || path.join(__dirname, 'data', 'spells-data.json');
  let data = {}; try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  let t = null; const flush = () => { clearTimeout(t); t = setTimeout(() => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { console.warn('Could not save', e.message); } }, 300); };
  return { kind: 'file',
    async get(k) { return data[k] === undefined ? null : JSON.parse(JSON.stringify(data[k])); },
    async set(k, v) { data[k] = JSON.parse(JSON.stringify(v)); flush(); },
    async create(k, v) { if (k in data) return false; data[k] = JSON.parse(JSON.stringify(v)); flush(); return true; } };
})();
console.log('Spell Circle storage: ' + (db.kind === 'online' ? 'online database (Upstash)' : 'local file (not permanent on Render free; see server.js)'));

const SP = { rooms: new Map(), conns: new Set(), folders: new Map() };
const spCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
const fCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
const fKey = c => 'spells:folder:' + crypto.createHash('sha256').update('spell-folder:' + c).digest('hex');
const rKey = c => 'spells:room:' + c;
const sText = (s, fb, n = 20) => (typeof s === 'string' && s.trim() ? s.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : fb);
const sColour = s => (typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s) ? s : '#4aa3ff');
const sId = s => (typeof s === 'string' && /^[a-z0-9]{6,32}$/.test(s) ? s : null);
const sNum = n => (typeof n === 'number' && isFinite(n) ? n : 0);
function cleanLines(a) {
  const out = []; if (!Array.isArray(a)) return out;
  for (const l of a.slice(0, 32)) { const h = Array.isArray(l) ? l[0] | 0 : -1, k = Array.isArray(l) ? l[1] | 0 : 0; if (h >= 0 && h < 8 && k >= 1 && k <= 4 && !out.some(x => x[0] === h && x[1] === k)) out.push([h, k]); }
  return out;
}
const spSend = (conn, m) => { if (conn) conn.send(JSON.stringify(m)); };

/* ---- sessions ---- */
async function spLoadRoom(code) {
  let room = SP.rooms.get(code); if (room) return room;
  let saved = null; try { saved = await db.get(rKey(code)); } catch (e) { console.warn('load room', e.message); }
  room = SP.rooms.get(code); if (room) return room; // loaded meanwhile
  room = { code, dmKey: saved?.dmKey || '', dmPid: saved?.dmPid || '', players: new Map(), papers: saved?.papers || [], paperSeq: saved?.paperSeq || 1,
    chat: [], live: false, saveT: null, flushT: null, lastConn: Date.now() };
  SP.rooms.set(code, room); return room;
}
function spSave(room) {
  clearTimeout(room.saveT);
  room.saveT = setTimeout(() => { db.set(rKey(room.code), { dmKey: room.dmKey, dmPid: room.dmPid, papers: room.papers, paperSeq: room.paperSeq }).catch(e => console.warn('save room', e.message)); }, 1500);
}
function spDirty(room, papersChanged) {
  if (papersChanged) spSave(room);
  if (room.flushT) return;
  room.flushT = setTimeout(() => { room.flushT = null; spFlush(room); }, 60);
}
function spFlush(room) {
  const list = [...room.players.values()].map(p => ({ id: p.pid, name: p.name, color: p.color, role: p.role, away: !p.conn, talk: !!p.talk && !!p.conn, mic: !!p.mic && !!p.conn, muted: !!p.muted, deaf: !!p.deaf }));
  const counts = {}; for (const pp of room.papers) counts[pp.owner] = (counts[pp.owner] || 0) + 1;
  for (const p of room.players.values()) {
    if (!p.conn) continue;
    spSend(p.conn, { t: 'state', players: list, papers: room.papers.filter(x => x.owner === p.pid), counts: p.role === 'dm' ? counts : undefined });
  }
}
function spAttach(conn, room, pid, role, name, color) {
  let p = room.players.get(pid);
  if (p && p.conn && p.conn !== conn) { const old = p.conn; old.sp = null; spSend(old, { t: 'ended', msg: 'You opened this session somewhere else, so it closed here.' }); old.close(); }
  if (!p) { p = { pid, role }; room.players.set(pid, p); }
  Object.assign(p, { role, name, color, conn, awayAt: 0, talk: false });
  conn.sp = { room, pid }; room.lastConn = Date.now();
  spSend(conn, { t: 'joined', id: pid, code: room.code, role, storage: db.kind,
    chat: room.chat.filter(m => m.scope === 'all' || m.from === pid || m.toId === pid) });
  spDirty(room);
}
function spDetach(conn, leaving) {
  const s = conn.sp; if (!s) return; conn.sp = null;
  const { room, pid } = s, p = room.players.get(pid); if (!p || p.conn !== conn) return;
  if (leaving) room.players.delete(pid); // their papers stay theirs for next time
  else { p.conn = null; p.awayAt = Date.now(); p.talk = false; }
  spDirty(room);
}
const dmHere = room => { const d = room.players.get(room.dmPid); return d && (d.conn || Date.now() - d.awayAt < 30 * 60000); };

/* ---- spell folders (one per code; anyone with the code can open it) ---- */
async function spFolder(code) {
  const c = SP.folders.get(code); if (c && Date.now() - c.at < 10 * 60000) return c.f;
  const f = await db.get(fKey(code)); if (f) SP.folders.set(code, { f, at: Date.now() }); return f;
}
async function spFolderSave(code, f) { SP.folders.set(code, { f, at: Date.now() }); await db.set(fKey(code), f); }

async function spHandle(conn, m) {
  if (!m || typeof m !== 'object') return;
  const now = Date.now();
  // ---------- folders ----------
  if (m.t === 'folder-create' || m.t === 'folder-open') {
    conn.fTries = (conn.fTries || []).filter(t => now - t < 60000);
    if (conn.fTries.length >= 10) return spSend(conn, { t: 'folder-error', msg: 'Too many tries. Wait a minute and try again.' });
    conn.fTries.push(now);
    const code = fCode(m.code);
    if (code.replace(/-/g, '').length < 4) return spSend(conn, { t: 'folder-error', msg: 'A folder code needs at least 4 letters or numbers.' });
    let f;
    try {
      if (m.t === 'folder-create') {
        f = { v: 1, made: now, spells: [], seq: 1 };
        if (!(await db.create(fKey(code), f))) return spSend(conn, { t: 'folder-error', msg: 'That folder code is already taken. Pick another one.' });
        SP.folders.set(code, { f, at: now });
      } else {
        f = await spFolder(code);
        if (!f) return spSend(conn, { t: 'folder-error', msg: 'No folder has that code. Check it, or make a new folder.', quiet: !!m.quiet });
      }
    } catch (e) { console.warn('folder', e.message); return spSend(conn, { t: 'folder-error', msg: 'Could not reach the folder storage. Try again in a moment.' }); }
    (conn.folders = conn.folders || new Set()).add(code);
    return spSend(conn, { t: 'folder', code, spells: f.spells, made: m.t === 'folder-create', quiet: !!m.quiet });
  }
  if (m.t === 'folder-save' || m.t === 'folder-edit' || m.t === 'folder-del') {
    const code = fCode(m.code); if (!conn.folders?.has(code)) return spSend(conn, { t: 'folder-error', msg: 'Open your folder first.' });
    try {
      const f = await spFolder(code); if (!f) return spSend(conn, { t: 'folder-error', msg: 'That folder is gone.' });
      if (m.t === 'folder-save') {
        if (f.spells.length >= 500) return spSend(conn, { t: 'folder-error', msg: 'Your folder is full (500 spells). Delete a few first.' });
        f.spells.push({ id: f.seq++, title: sText(m.title, 'Untitled spell', 60), note: sText(m.note, '', 1000), lines: cleanLines(m.lines), saved: now });
      } else if (m.t === 'folder-edit') {
        const s = f.spells.find(x => x.id === sNum(m.id)); if (!s) return;
        if (typeof m.title === 'string') s.title = sText(m.title, 'Untitled spell', 60);
        if (typeof m.note === 'string') s.note = sText(m.note, '', 1000);
      } else f.spells = f.spells.filter(x => x.id !== sNum(m.id));
      await spFolderSave(code, f);
      for (const c of SP.conns) if (c.folders?.has(code)) spSend(c, { t: 'folder', code, spells: f.spells, saved: m.t === 'folder-save' && c === conn }); // open on two phones? both update
    } catch (e) { console.warn('folder', e.message); spSend(conn, { t: 'folder-error', msg: 'Could not save to your folder. Try again in a moment.' }); }
    return;
  }
  // ---------- joining ----------
  if (m.t === 'create' || m.t === 'join') {
    const code = spCode(m.code), pid = sId(m.pid);
    if (code.length < 3 || !pid) return spSend(conn, { t: 'error', msg: 'That code needs 3 to 12 letters or numbers.' });
    if (conn.sp) spDetach(conn, false);
    const name = sText(m.name, m.t === 'create' ? 'Dungeon Master' : 'Adventurer'), color = sColour(m.color);
    if (m.t === 'create') {
      const key = sId(m.key); if (!key) return spSend(conn, { t: 'error', msg: 'Something went wrong. Reload the page.' });
      const room = await spLoadRoom(code);
      if (room.dmKey && room.dmKey !== key && room.live && dmHere(room)) return spSend(conn, { t: 'error', msg: 'Someone else is already running a session with that code. Pick a different code.' });
      if (room.dmPid && room.dmPid !== pid) { // the DM on a new phone or computer: their papers follow them
        for (const pp of room.papers) if (pp.owner === room.dmPid) pp.owner = pid;
        const old = room.players.get(room.dmPid); if (old?.conn) { old.conn.sp = null; spSend(old.conn, { t: 'ended', msg: 'You opened this session somewhere else, so it closed here.' }); }
        room.players.delete(room.dmPid);
      }
      const restored = !room.live && room.papers.length > 0;
      room.dmKey = key; room.dmPid = pid; room.live = true; spSave(room);
      spAttach(conn, room, pid, 'dm', name, color);
      if (restored) spSend(conn, { t: 'toast', msg: 'Welcome back! Your spell papers are just as you left them.' });
    } else {
      let room = SP.rooms.get(code);
      if (!room) { const saved = await db.get(rKey(code)).catch(() => null); if (saved?.dmKey) { room = await spLoadRoom(code); room.live = true; } } // a saved session (e.g. after a server restart)
      if (!room || !room.live) return spSend(conn, { t: 'error', msg: 'Session not found. Check the code, and make sure your DM has started it.', code: 'no-room' });
      if (pid === room.dmPid) return spSend(conn, { t: 'error', msg: 'You are the DM of this session: use "Start as DM" with this code.' });
      if (!room.players.has(pid) && room.players.size >= MAX_PER_ROOM) return spSend(conn, { t: 'error', msg: 'That session is full.' });
      const back = room.players.has(pid) || room.papers.some(x => x.owner === pid);
      spAttach(conn, room, pid, 'player', name, color);
      if (back && room.papers.some(x => x.owner === pid)) spSend(conn, { t: 'toast', msg: 'Your spell papers are here, just as you left them.' });
    }
    return;
  }
  // ---------- in a session ----------
  const s = conn.sp; if (!s) return;
  const { room, pid } = s, p = room.players.get(pid); if (!p) return;
  const dm = p.role === 'dm', paper = id => room.papers.find(x => x.id === sNum(id));
  switch (m.t) {
    case 'ping': break;
    case 'leave': spDetach(conn, true); break;
    case 'recolor': p.color = sColour(m.color); spDirty(room); break;
    case 'talk': if (!!m.on !== !!p.talk) { p.talk = !!m.on; spDirty(room); } break;
    case 'mic': p.mic = !!m.on; spDirty(room); break;
    case 'rtc': { const q = room.players.get(m.to); if (q?.conn && q.pid !== pid) spSend(q.conn, { t: 'rtc', from: pid, data: m.data }); break; }
    case 'mute': case 'deafen': { const q = dm && room.players.get(m.id); if (q && q.role !== 'dm') { const f = m.t === 'mute' ? 'muted' : 'deaf'; q[f] = !q[f]; spDirty(room); } break; }
    case 'kick': { const q = dm && room.players.get(m.id); if (q && q.pid !== pid) { if (q.conn) { q.conn.sp = null; spSend(q.conn, { t: 'ended', msg: 'You were removed by the DM.' }); } room.players.delete(q.pid); spDirty(room); } break; }
    case 'chat': {
      p.chatT = (p.chatT || []).filter(t => now - t < 4000); if (p.chatT.length >= 6) break; p.chatT.push(now);
      const text = sText(m.text, '', 500); if (!text) break;
      const base = { t: 'chat', from: pid, name: p.name, color: p.color, text, ts: now };
      let msg;
      if (m.to === 'all') { msg = { ...base, scope: 'all' }; for (const q of room.players.values()) spSend(q.conn, msg); }
      else { const q = room.players.get(m.to); if (!q || q.pid === pid || (!dm && q.role !== 'dm')) break; msg = { ...base, scope: 'private', toId: q.pid, toName: q.name }; spSend(q.conn, msg); spSend(conn, msg); }
      room.chat.push(msg); if (room.chat.length > 200) room.chat.shift();
      break;
    }
    case 'paper-new': { // the DM hands out a blank paper, or one written in the spell maker
      if (!dm || room.papers.length >= 400) break;
      const to = room.players.has(m.to) ? m.to : pid;
      room.papers.push({ id: room.paperSeq++, owner: to, lines: cleanLines(m.lines), from: pid, fromName: p.name });
      const q = room.players.get(to); if (to !== pid) spSend(q?.conn, { t: 'toast', msg: 'The DM gave you a spell paper.' });
      spDirty(room, true); break;
    }
    case 'paper-toggle': { // add or rub out one line
      const pp = paper(m.id); if (!pp || pp.owner !== pid) break;
      const [l] = cleanLines([[m.h, m.k]]); if (!l) break;
      const i = pp.lines.findIndex(x => x[0] === l[0] && x[1] === l[1]);
      if (i >= 0) pp.lines.splice(i, 1); else if (pp.lines.length < 32) pp.lines.push(l);
      spDirty(room, true); break;
    }
    case 'paper-clear': { const pp = paper(m.id); if (pp && pp.owner === pid) { pp.lines = []; spDirty(room, true); } break; }
    case 'paper-fill': { const pp = paper(m.id); if (pp && pp.owner === pid && !pp.lines.length) { pp.lines = cleanLines(m.lines); spDirty(room, true); } break; } // copy a saved spell onto a blank paper
    case 'paper-give': {
      const pp = paper(m.id), q = room.players.get(m.to);
      if (!pp || pp.owner !== pid || !q || q.pid === pid || (!dm && q.role !== 'dm')) break;
      pp.owner = q.pid; pp.from = pid; pp.fromName = p.name;
      spSend(q.conn, { t: 'toast', msg: p.name + ' handed you a spell paper.' });
      spDirty(room, true); break;
    }
    case 'paper-del': { const i = room.papers.findIndex(x => x.id === sNum(m.id) && (x.owner === pid || dm)); if (i >= 0) { room.papers.splice(i, 1); spDirty(room, true); } break; }
  }
}
function spConn(conn) {
  SP.conns.add(conn); conn.q = Promise.resolve();
  spSend(conn, { t: 'hello', storage: db.kind });
  conn.onMessage = text => {
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    conn.alive = true;
    conn.q = conn.q.then(() => spHandle(conn, m)).catch(e => console.warn('spell circle', e));
  };
  conn.onClose = () => { SP.conns.delete(conn); spDetach(conn, false); };
}
setInterval(() => { // keep connections alive (phones in the background still answer these), drop dead ones, tidy up
  for (const c of SP.conns) { if (!c.alive) { c.kill(); continue; } c.alive = false; c.ping(); }
  const now = Date.now();
  for (const room of SP.rooms.values()) {
    let changed = false, anyone = false;
    for (const p of [...room.players.values()]) { if (p.conn) anyone = true; else if (now - p.awayAt > 3 * 3600000) { room.players.delete(p.pid); changed = true; } }
    if (anyone) room.lastConn = now;
    if (changed) spDirty(room);
    if (!anyone && now - room.lastConn > 2 * 3600000) { clearTimeout(room.saveT); db.set(rKey(room.code), { dmKey: room.dmKey, dmPid: room.dmPid, papers: room.papers, paperSeq: room.paperSeq }).catch(() => {}); SP.rooms.delete(room.code); }
  }
}, 25000);

// keep connections alive through hosting proxies, and drop dead ones
setInterval(() => { for (const r of rooms.values()) for (const c of r.conns) c.ping(); }, 25000);

server.listen(PORT, () => console.log('The Cottage is running on port ' + PORT + (pageFile() ? ' (page: ' + path.relative(__dirname, pageFile()) + ')' : ' - WARNING: index.html not found')));

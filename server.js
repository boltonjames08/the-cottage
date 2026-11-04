// The Cottage: tiny web server + WebSocket relay. No dependencies: run with `node server.js`.
// The DM's browser runs each game session; this server only links browsers that share a session code.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOMS = 300, MAX_PER_ROOM = 40, MAX_MSG = 2 * 1024 * 1024; // big enough for the shared Investigator's Book
// Optional: extra ICE servers for voice (for example a TURN service), as JSON in the ICE_SERVERS setting.
let ICE = null;
try { if (process.env.ICE_SERVERS) ICE = JSON.parse(process.env.ICE_SERVERS); } catch (e) { console.warn('ICE_SERVERS is not valid JSON, ignoring it'); }

// the game page can live in public/index.html or right next to this file (either works)
const PAGE_FILES = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html'), path.join(__dirname, 'the-cottage.html')];
const pageFile = () => PAGE_FILES.find(f => fs.existsSync(f));
const page = () => fs.readFileSync(pageFile(), 'utf8')
  .replace('<head>', '<head><script>window.COTTAGE_RELAY=true;' + (ICE ? 'window.COTTAGE_ICE=' + JSON.stringify(ICE) + ';' : '') + '</script>');

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if ((url === '/' || url === '/index.html') && !pageFile()) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('The game page is missing. Upload index.html (from the zip) to your GitHub repository, next to server.js.');
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
  const code = String(u.searchParams.get('room') || '').toUpperCase();
  const asHost = u.searchParams.get('host') === '1', key = String(u.searchParams.get('key') || '');
  accept(req, socket, conn => {
    const sys = (c, o) => c.send(JSON.stringify(o));
    if (!/^[A-Z0-9]{3,12}$/.test(code)) { sys(conn, { sys: 'no-room' }); return conn.close(); }
    let room = rooms.get(code);
    if (room && asHost && /^[a-z0-9]{8,40}$/.test(key) && room.key === key) { // the same DM coming back (e.g. a refresh): the old tab's session ends
      room.dead = true; rooms.delete(code);
      for (const c of room.conns) { sys(c, { sys: c === room.host ? 'replaced' : 'host-gone' }); c.close(); }
      room = null;
    }
    if (asHost) {
      if (room) { sys(conn, { sys: 'host-taken' }); return conn.close(); }
      if (rooms.size >= MAX_ROOMS) { sys(conn, { sys: 'full' }); return conn.close(); }
      room = { host: conn, conns: new Set([conn]), key }; rooms.set(code, room);
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
      if (conn === room.host) { for (const c of room.conns) { sys(c, { sys: 'host-gone' }); c.close(); } rooms.delete(code); }
      else if (room.host) sys(room.host, { sys: 'gone', _c: conn.id });
    };
  });
});
// keep connections alive through hosting proxies, and drop dead ones
setInterval(() => { for (const r of rooms.values()) for (const c of r.conns) c.ping(); }, 25000);

server.listen(PORT, () => console.log('The Cottage is running on port ' + PORT + (pageFile() ? ' (page: ' + path.relative(__dirname, pageFile()) + ')' : ' - WARNING: index.html not found')));

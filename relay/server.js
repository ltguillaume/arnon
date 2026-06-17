const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = parseInt(process.argv.find((_, i, a) => a[i-1] === '--port') || '9444', 10);

// Trust X-Forwarded-For ONLY when behind a known proxy (Caddy/nginx).
// Set TRUST_PROXY=1 in that case. Otherwise the source IP is taken from the
// socket, so a client cannot forge it to bypass per-IP limits.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const rooms = new Map();
const ipRooms = new Map();   // ip -> count of rooms created
const ipConns = new Map();   // ip -> count of open sockets

const MAX_MSG_SIZE = 1024 * 1024;   // 1MB
const MAX_ROOMS_PER_IP = 5;
const MAX_CONNS_PER_IP = 10;        // open sockets per IP
const MAX_TOTAL_ROOMS = 5000;       // global ceiling (botnet protection)
const ROOM_ID_BYTES = 12;           // 96-bit room id
const IDLE_MS = 30000;              // drop a socket that never joins/creates
const LONE_ROOM_MS = 600000;       // 10 min: destroy a created-but-never-joined room even if its
                                   // socket keeps answering heartbeats (bounds abandoned rooms).
                                   // Generous enough to share a link and wait for the peer.
const MSG_BURST = 20;               // token bucket size
const MSG_REFILL = 10;              // tokens added per second
const HEARTBEAT_MS = 30000;

// Bind to loopback by default: Caddy (same host / same network namespace) reverse-proxies
// to it; it is never meant to face the public interface directly. HOST can override this for
// container setups where the proxy is a sidecar — but see the warning.
//
// ⚠ SECURITY: never combine a non-loopback HOST (e.g. 0.0.0.0) with TRUST_PROXY=1.
// TRUST_PROXY=1 makes the relay trust the last X-Forwarded-For hop; if any client can reach
// the relay directly, it can forge that header and bypass every per-IP limit. TRUST_PROXY=1
// is only safe when the ONLY thing that can reach this socket is a trusted reverse proxy.
const HOST = process.env.HOST || '127.0.0.1';
if (HOST !== '127.0.0.1' && HOST !== '::1' && TRUST_PROXY) {
  console.warn('[arnon-relay] WARNING: TRUST_PROXY=1 with non-loopback HOST=' + HOST +
    ' — X-Forwarded-For is forgeable unless a trusted proxy is the only reachable client.');
}
const wss = new WebSocketServer({ host: HOST, port: PORT, maxPayload: MAX_MSG_SIZE });
console.log('[arnon-relay] ' + HOST + ':' + PORT + (TRUST_PROXY ? ' (trust-proxy)' : ''));

function clientIp(req) {
  if (TRUST_PROXY) {
    var xff = req.headers['x-forwarded-for'];
    if (xff) {
      var parts = xff.split(',');
      return parts[parts.length - 1].trim(); // last hop = what our proxy saw
    }
  }
  return req.socket.remoteAddress;
}

function inc(map, key) { map.set(key, (map.get(key) || 0) + 1); }
function dec(map, key) { var n = map.get(key) || 1; if (n <= 1) map.delete(key); else map.set(key, n - 1); }

wss.on('connection', function(ws, req) {
  var ip = clientIp(req);
  if (!ip) { ws.close(1011); return; }

  // per-IP connection cap
  if ((ipConns.get(ip) || 0) >= MAX_CONNS_PER_IP) { ws.close(1008, 'too_many_connections'); return; }
  inc(ipConns, ip);

  var room = null;
  ws.isAlive = true;
  ws.tokens = MSG_BURST;
  ws.lastRefill = Date.now();

  // idle timeout: must create or join within IDLE_MS
  var idleTimer = setTimeout(function() {
    if (!room) { try { ws.close(1008, 'idle'); } catch(e) {} }
  }, IDLE_MS);

  ws.on('pong', function() { ws.isAlive = true; });

  function allowMessage() {
    var now = Date.now();
    ws.tokens = Math.min(MSG_BURST, ws.tokens + (now - ws.lastRefill) / 1000 * MSG_REFILL);
    ws.lastRefill = now;
    if (ws.tokens < 1) return false;
    ws.tokens -= 1;
    return true;
  }

  ws.on('message', function(raw) {
    if (raw.length > MAX_MSG_SIZE) return;
    // Token-bucket every inbound frame — including create/join and even unparseable
    // garbage — so the pre-room handshake can't be used as a cheap flood vector.
    if (!allowMessage()) { try { ws.close(1008, 'rate'); } catch(e) {} return; }
    var m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.type === 'create') {
      if (room) return; // already in a room on this socket
      if (rooms.size >= MAX_TOTAL_ROOMS) return ws.send(JSON.stringify({ type: 'error', msg: 'busy' }));
      if ((ipRooms.get(ip) || 0) >= MAX_ROOMS_PER_IP) return ws.send(JSON.stringify({ type: 'error', msg: 'rate_limited' }));

      var id = crypto.randomBytes(ROOM_ID_BYTES).toString('hex');
      var ttl = Math.min(Math.max(parseInt(m.ttl, 10) || 0, 0), 3600);
      var r = { peers: new Set([ws]), created: Date.now(), ttl: ttl, ip: ip };
      if (ttl > 0) r.timer = setTimeout(function() { destroyRoom(id); }, ttl * 1000);
      // tear down the room if a second peer never shows up, regardless of heartbeat
      r.loneTimer = setTimeout(function() {
        var rr = rooms.get(id);
        if (rr && rr.peers.size < 2) destroyRoom(id);
      }, LONE_ROOM_MS);
      rooms.set(id, r);
      room = id;
      clearTimeout(idleTimer);
      inc(ipRooms, ip);
      ws.send(JSON.stringify({ type: 'created', room: id, ttl: ttl }));
    }

    else if (m.type === 'join') {
      if (room) return;
      if (!m.room || !rooms.has(m.room)) return ws.send(JSON.stringify({ type: 'error', msg: 'not_found' }));
      var r = rooms.get(m.room);
      if (r.peers.size >= 2) return ws.send(JSON.stringify({ type: 'error', msg: 'full' }));
      r.peers.add(ws);
      if (r.loneTimer) { clearTimeout(r.loneTimer); r.loneTimer = null; }   // second peer arrived
      room = m.room;
      clearTimeout(idleTimer);
      var elapsed = Math.floor((Date.now() - r.created) / 1000);
      ws.send(JSON.stringify({ type: 'joined', ttl: r.ttl, elapsed: elapsed }));
      r.peers.forEach(function(p) {
        if (p !== ws && p.readyState === 1) p.send(JSON.stringify({ type: 'peer_joined', ttl: r.ttl, elapsed: elapsed }));
      });
    }

    else if (m.type === 'key' || m.type === 'msg' || m.type === 'voice' || m.type === 'bye') {
      if (!room || !rooms.has(room)) return;
      rooms.get(room).peers.forEach(function(p) { if (p !== ws && p.readyState === 1) p.send(raw); });
    }
  });

  ws.on('close', function() {
    clearTimeout(idleTimer);
    dec(ipConns, ip);
    if (!room || !rooms.has(room)) return;
    var r = rooms.get(room);
    r.peers.delete(ws);
    r.peers.forEach(function(p) { if (p.readyState === 1) p.send(JSON.stringify({ type: 'peer_left' })); });
    if (r.peers.size === 0) destroyRoom(room);
  });
});

function destroyRoom(id) {
  if (!rooms.has(id)) return;
  var r = rooms.get(id);
  if (r.timer) clearTimeout(r.timer);
  if (r.loneTimer) clearTimeout(r.loneTimer);
  dec(ipRooms, r.ip);
  r.peers.forEach(function(p) {
    if (p.readyState === 1) {
      p.send(JSON.stringify({ type: 'destroyed' }));
      p.close();
    }
  });
  rooms.delete(id);
}

// heartbeat: terminate sockets that stop responding to pings
var hb = setInterval(function() {
  wss.clients.forEach(function(ws) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch(e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch(e) {}
  });
}, HEARTBEAT_MS);

// periodic cleanup of empty rooms
var cleanup = setInterval(function() {
  rooms.forEach(function(r, id) {
    r.peers.forEach(function(ws) { if (ws.readyState !== 1) r.peers.delete(ws); });
    if (r.peers.size === 0) destroyRoom(id);
  });
}, 60000);

wss.on('close', function() { clearInterval(hb); clearInterval(cleanup); });

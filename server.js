// Baxberi — canlı yayım platforması (hesablar + WebSocket + WebRTC signaling)
// Yalnız bir asılılıq: ws
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const PUB = path.join(__dirname, 'public');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const DAY = 864e5;

process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));

// ---------- sadə JSON verilənlər bazası ----------
// null-prototype obyektlər: "constructor", "__proto__" kimi adlar problem yaratmasın
const dict = o => Object.assign(Object.create(null), o);
let db = { users: dict(), sessions: dict(), chats: dict() };
try {
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db = { users: dict(raw.users), sessions: dict(raw.sessions), chats: dict(raw.chats), follows: dict(raw.follows), gifts: Array.isArray(raw.gifts) ? raw.gifts : [], reactions: dict(raw.reactions), visitors: dict(raw.visitors) };
} catch {}
db.follows ||= dict(); db.gifts ||= []; db.reactions ||= dict(); db.visitors ||= dict();
let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) { console.error('Bazanı yazmaq alınmadı:', e.message); }
  }, 300);
}

// ---------- şifrə və sessiya ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => e ? rej(e) : res(salt + ':' + k.toString('hex'))));
async function verify(pw, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const x = (await hash(pw, salt)).split(':')[1];
  return crypto.timingSafeEqual(Buffer.from(x, 'hex'), Buffer.from(h, 'hex'));
}
const parseCookie = (h = '') => Object.fromEntries(h.split(';').map(s => s.trim().split('=')).filter(a => a[0])
  .map(([k, ...v]) => { let val = v.join('='); try { val = decodeURIComponent(val); } catch {} return [k, val]; }));
function userFrom(req) {
  const tok = parseCookie(req.headers.cookie).sid;
  const s = tok && db.sessions[sha(tok)];
  return s && s.exp > Date.now() && db.users[s.u] ? s.u : null;
}
const isSecure = req => req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',').pop().trim();
function newSession(req, u) {
  const tok = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(tok)] = { u, exp: Date.now() + 30 * DAY };
  save();
  return `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${isSecure(req) ? '; Secure' : ''}`;
}
setInterval(() => {
  const n = Date.now();
  for (const k of Object.keys(db.sessions)) if (db.sessions[k].exp < n) delete db.sessions[k];
}, 36e5).unref();

// sürət limiti: uğursuz girişlər və qeydiyyatlar (10 dəqiqədə)
const fails = new Map(), regs = new Map();
const count = (m, ip) => { const n = Date.now(), a = (m.get(ip) || []).filter(x => n - x < 6e5); m.set(ip, a); return a.length; };
const hit = (m, ip) => { count(m, ip); m.get(ip).push(Date.now()); };
setInterval(() => { fails.clear(); regs.clear(); }, 36e5).unref();

// ---------- HTTP ----------
const json = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};
const readJson = (req, limit = 4096) => new Promise(resolve => {
  let b = '', n = 0;
  req.on('data', c => { n += c.length; if (n > limit) { req.destroy(); resolve({}); } else b += c; });
  req.on('end', () => { try { const j = JSON.parse(b || '{}'); resolve(j && typeof j === 'object' ? j : {}); } catch { resolve({}); } });
  req.on('error', () => resolve({}));
  req.on('close', () => resolve({}));
});
const profile = u => { const x = db.users[u]; return { username:u, name:x.name, displayName:x.displayName || x.name, bio:x.bio || '', age:x.age || '', city:x.city || '', interests:x.interests || [], status:x.status || 'available', avatar:x.avatar || '', cover:x.cover || '' }; };
const pub = u => profile(u);
const auth = (req,res) => { const u=userFrom(req); if (!u) json(res,401,{error:'Daxil ol'}); return u; };

const routes = {
  'POST /api/register': async (req, res, body) => {
    const ip = clientIp(req);
    if (count(regs, ip) >= 10) return json(res, 429, { error: 'Çox qeydiyyat cəhdi. Bir az sonra yenə yoxla.' });
    const name = String(body.username || '').trim(), pw = String(body.password || '');
    if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return json(res, 400, { error: 'Ad 3–20 simvol olmalıdır (hərf, rəqəm, _).' });
    if (pw.length < 6 || pw.length > 100) return json(res, 400, { error: 'Şifrə ən azı 6 simvol olmalıdır.' });
    const key = name.toLowerCase();
    if (db.users[key]) return json(res, 409, { error: 'Bu ad artıq götürülüb.' });
    hit(regs, ip);
    const pass = await hash(pw);
    if (db.users[key]) return json(res, 409, { error: 'Bu ad artıq götürülüb.' });
    db.users[key] = { name, pass, created: Date.now() };
    const cookie = newSession(req, key);
    json(res, 200, { user: pub(key) }, { 'Set-Cookie': cookie });
  },
  'POST /api/login': async (req, res, body) => {
    const ip = clientIp(req);
    if (count(fails, ip) >= 15) return json(res, 429, { error: 'Çox uğursuz cəhd. Bir az sonra yenə yoxla.' });
    const key = String(body.username || '').trim().toLowerCase(), u = db.users[key];
    if (!u || !(await verify(String(body.password || ''), u.pass))) {
      hit(fails, ip);
      return json(res, 401, { error: 'Ad və ya şifrə səhvdir.' });
    }
    json(res, 200, { user: pub(key) }, { 'Set-Cookie': newSession(req, key) });
  },
  'POST /api/logout': (req, res) => {
    const tok = parseCookie(req.headers.cookie).sid;
    if (tok) { delete db.sessions[sha(tok)]; save(); }
    json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  },
  'GET /api/me': (req, res) => { const u = userFrom(req); json(res, 200, { user: u ? pub(u) : null }); },
  'GET /api/profile': (req,res) => { const viewer=auth(req,res); if(!viewer)return; const u=new URL(req.url,'http://x').searchParams.get('u') || viewer; if(!db.users[u])return json(res,404,{error:'İstifadəçi tapılmadı'}); if(u!==viewer){ db.visitors[u] ||= []; db.visitors[u]=db.visitors[u].filter(v=>v.u!==viewer); db.visitors[u].unshift({u:viewer,ts:Date.now()}); db.visitors[u]=db.visitors[u].slice(0,100); save(); } json(res,200,{profile:pub(u),following:(db.follows[viewer]||[]).includes(u),followers:Object.values(db.follows).filter(a=>a.includes(u)).length,visitors:u===viewer?(db.visitors[u]||[]).map(v=>({...v,profile:pub(v.u)})):undefined}); },
  'POST /api/profile': async (req,res,body) => { const u=auth(req,res); if(!u)return; const x=db.users[u]; const str=(v,n)=>String(v||'').trim().slice(0,n); x.displayName=str(body.displayName,50)||x.name; x.bio=str(body.bio,500); x.age=body.age===''?'':Math.max(13,Math.min(120,Number(body.age)||0)); x.city=str(body.city,80); x.status=['available','busy','looking','offline'].includes(body.status)?body.status:'available'; x.interests=Array.isArray(body.interests)?body.interests.slice(0,20).map(v=>str(v,32)).filter(Boolean):[]; for(const field of ['avatar','cover']) { const v=String(body[field]||''); if(v && !(/^https:\/\//i.test(v)||/^\/uploads\/[a-f0-9]+\.(png|jpg|webp|gif)$/.test(v)))return json(res,400,{error:'Şəkil ünvanı yanlışdır.'}); x[field]=v.slice(0,1000); } save(); json(res,200,{profile:pub(u)}); },
  'POST /api/upload': (req,res,body) => { const u=auth(req,res);if(!u)return;const m=String(body.image||'').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);if(!m)return json(res,400,{error:'PNG, JPEG, WEBP və ya GIF seç.'});const data=Buffer.from(m[2],'base64');if(!data.length||data.length>2*1024*1024)return json(res,413,{error:'Şəkil 2 MB-dan kiçik olmalıdır.'});const signatures={'image/png':data.length>8&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'image/jpeg':data[0]===255&&data[1]===216&&data[2]===255,'image/gif':data.subarray(0,3).toString()==='GIF','image/webp':data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP'};if(!signatures[m[1]])return json(res,400,{error:'Şəkil formatı məzmunla uyğun gəlmir.'});const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'}[m[1]],name=crypto.randomBytes(18).toString('hex')+'.'+ext;try{fs.mkdirSync(UPLOAD_DIR,{recursive:true});fs.writeFileSync(path.join(UPLOAD_DIR,name),data,{flag:'wx'});}catch{return json(res,500,{error:'Şəkli saxlamaq alınmadı.'});}json(res,200,{url:'/uploads/'+name}); },
  'POST /api/follow': (req,res,body) => { const u=auth(req,res); if(!u)return; const to=String(body.username||''); if(!db.users[to]||to===u)return json(res,400,{error:'İstifadəçi seçimi yanlışdır.'}); db.follows[u] ||= []; const i=db.follows[u].indexOf(to); if(i<0)db.follows[u].push(to);else db.follows[u].splice(i,1); save(); json(res,200,{following:i<0}); },
  'POST /api/gift': (req,res,body) => { const u=auth(req,res);if(!u)return;const to=String(body.username||''),gift=String(body.gift||'🎁').slice(0,8);if(!db.users[to]||to===u)return json(res,400,{error:'İstifadəçi seçimi yanlışdır.'}); db.gifts.push({from:u,to,gift,ts:Date.now()});db.gifts=db.gifts.slice(-1000);save();json(res,200,{ok:true}); },
  'POST /api/reaction': (req,res,body) => { const u=auth(req,res);if(!u)return;const to=String(body.username||''),emoji=String(body.emoji||'❤️').slice(0,8);if(!db.users[to]||!['❤️','😂','👏','🔥','😍'].includes(emoji))return json(res,400,{error:'Reaksiya yanlışdır.'});db.reactions[to] ||= [];db.reactions[to].push({from:u,emoji,ts:Date.now()});db.reactions[to]=db.reactions[to].slice(-100);save();json(res,200,{ok:true}); },
  'GET /api/social': (req,res) => { const u=auth(req,res);if(!u)return; json(res,200,{gifts:db.gifts.filter(g=>g.to===u||g.from===u).slice(-30),reactions:db.reactions}); },
  'GET /api/ice': (req, res) => {
    const s = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (process.env.TURN_URL) s.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER, credential: process.env.TURN_PASS });
    json(res, 200, { iceServers: s });
  }
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(PUB, p);
  if (!f.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Tapılmadı'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : d);
  });
}
const server = http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/healthz') return json(res, 200, { ok: true });
    if (p.startsWith('/api/')) {
      const route = routes[req.method + ' ' + p];
      if (!route) return json(res, 404, { error: 'Tapılmadı' });
      return await route(req, res, req.method === 'POST' ? await readJson(req, req.url==='/api/profile'?12000:req.url==='/api/upload'?3*1024*1024:4096) : {});
    }
    if(p.startsWith('/uploads/')) { const name=path.basename(p); if(name!==p.slice('/uploads/'.length))return json(res,400,{error:'Yanlış yol'}); const f=path.join(UPLOAD_DIR,name); return fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':({'jpg':'image/jpeg','png':'image/png','webp':'image/webp','gif':'image/gif'}[path.extname(f).slice(1)]||'application/octet-stream'),'Cache-Control':'public,max-age=31536000,immutable','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:d);}); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Server xətası' }); else res.end();
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 32768 });
wss.on('error', e => console.error('wss:', e.message));
const conns = new Map(); // username -> ws
server.on('upgrade', (req, sock, head) => {
  sock.on('error', () => {});
  let u = null, ok = false;
  try { u = userFrom(req); ok = new URL(req.headers.origin).host === req.headers.host; } catch {}
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !u || !ok) {
    sock.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return sock.destroy();
  }
  wss.handleUpgrade(req, sock, head, ws => { ws.user = u; wss.emit('connection', ws); });
});
const tx = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
function broadcastOnline() {
  const all = [...conns.values()];
  const list = all.map(c => ({
    u: c.user, name: db.users[c.user].name, live: c.live, title: c.title,
    viewers: all.filter(x => x.watching === c.user && x !== c).length
  }));
  all.forEach(c => tx(c, { t: 'online', list }));
}
wss.on('connection', ws => {
  ws.on('error', () => {});
  const old = conns.get(ws.user);
  if (old) { tx(old, { t: 'dup' }); old.close(); }
  Object.assign(ws, { live: false, title: '', watching: null, last: 0, alive: true });
  ws.on('pong', () => { ws.alive = true; });
  conns.set(ws.user, ws);
  broadcastOnline();
  ws.on('message', raw => {
    try {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'live') {
        ws.live = !!m.on; ws.title = ws.live ? String(m.title || '').slice(0, 60) : '';
        broadcastOnline();
      } else if (m.t === 'watch') {
        ws.watching = typeof m.to === 'string' && db.users[m.to] ? m.to : null;
        if (ws.watching) tx(ws, { t: 'history', ch: ws.watching, msgs: (db.chats[ws.watching] || []).slice(-50) });
        broadcastOnline();
      } else if (m.t === 'chat') {
        const text = String(m.text || '').trim().slice(0, 200), ch = m.ch, n = Date.now();
        if (!text || typeof ch !== 'string' || !db.users[ch] || n - ws.last < 500) return;
        ws.last = n;
        const msg = { u: db.users[ws.user].name, text, ts: n };
        (db.chats[ch] = db.chats[ch] || []).push(msg);
        if (db.chats[ch].length > 100) db.chats[ch].shift();
        save();
        conns.forEach(c => { if (c.watching === ch || c.user === ch) tx(c, { t: 'chat', ch, msg }); });
      } else if (m.t === 'sig') {
        const to = typeof m.to === 'string' && conns.get(m.to);
        if (to && m.d && typeof m.d === 'object') tx(to, { t: 'sig', from: ws.user, d: m.d });
      }
    } catch (e) { console.error('ws mesaj xətası:', e); }
  });
  ws.on('close', () => { if (conns.get(ws.user) === ws) conns.delete(ws.user); broadcastOnline(); });
});
// proksilər boş WebSocket-i bağlamasın deyə yoxlama
setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; try { ws.ping(); } catch {} });
}, 25000).unref();

server.listen(PORT, () => console.log('Baxberi işləyir: http://localhost:' + PORT));

// Baxberi — canlı yayım platforması (hesablar + WebSocket + WebRTC signaling)
// Yalnız bir asılılıq: ws
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const PUB = path.join(__dirname, 'public');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const LEGACY_SUPABASE_KEY = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SECRET_KEY;
const REMOTE_DB = !!(SUPABASE_URL && SUPABASE_SECRET_KEY);
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '', CF_R2_BUCKET = process.env.CF_R2_BUCKET || '';
const CF_API_TOKEN = process.env.CF_API_TOKEN || '', R2_PUBLIC_URL = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
const REMOTE_IMAGES = !!(CF_ACCOUNT_ID && CF_R2_BUCKET && CF_API_TOKEN && R2_PUBLIC_URL);
const DAY = 864e5;

process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));

// ---------- sadə JSON verilənlər bazası ----------
// null-prototype obyektlər: "constructor", "__proto__" kimi adlar problem yaratmasın
const dict = o => Object.assign(Object.create(null), o);
let db = { users: dict(), sessions: dict(), chats: dict() };
try { if (!REMOTE_DB) {
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db = { users: dict(raw.users), sessions: dict(raw.sessions), chats: dict(raw.chats), follows: dict(raw.follows), gifts: Array.isArray(raw.gifts) ? raw.gifts : [], reactions: dict(raw.reactions), visitors: dict(raw.visitors) };
} } catch {}
db.follows ||= dict(); db.gifts ||= []; db.reactions ||= dict(); db.visitors ||= dict();
let timer = null;
function save() {
  if (REMOTE_DB) return;
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

async function rest(table, query = '', method = 'GET', body, prefer = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query ? '?' + query : ''}`;
  const headers = { apikey: SUPABASE_SECRET_KEY, Accept: 'application/json' };
  if(LEGACY_SUPABASE_KEY)headers.Authorization=`Bearer ${SUPABASE_SECRET_KEY}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`PostgreSQL REST ${method} ${table} failed (${r.status})`);
  if(r.status===204)return [];
  const text=await r.text();return text?JSON.parse(text):[];
}
const userQuery = u => `username=eq.${encodeURIComponent(u)}&select=*`;
function fromRow(row) { return row ? { username:row.username, ...row.data } : null; }
async function getUser(u) {
  if (!u) return null;
  if (!REMOTE_DB) return db.users[u] || null;
  const rows = await rest('users', userQuery(u)); const user = fromRow(rows[0]);
  if (user) db.users[u] = user; else delete db.users[u];
  return user;
}
async function putUser(u, data) {
  db.users[u] = data;
  if (REMOTE_DB) await rest('users', 'on_conflict=username', 'POST', { username:u, data }, 'resolution=merge-duplicates,return=minimal'); else save();
}
async function createUser(u,data){if(REMOTE_DB)await rest('users','','POST',{username:u,data},'return=minimal');db.users[u]=data;if(!REMOTE_DB)save();}
async function getSession(req) {
  const token = parseCookie(req.headers.cookie).sid; if (!token) return null;
  const tokenHash = sha(token);
  if (!REMOTE_DB) { const s=db.sessions[tokenHash]; return s && s.exp>Date.now() && await getUser(s.u) ? s.u : null; }
  const rows = await rest('sessions', `token_hash=eq.${tokenHash}&expires_at=gt.${Date.now()}&select=username&limit=1`);
  if (!rows[0]) return null;
  return await getUser(rows[0].username) ? rows[0].username : null;
}
async function makeSession(u) {
  const tok=crypto.randomBytes(32).toString('hex'), tokenHash=sha(tok), exp=Date.now()+30*DAY;
  if (REMOTE_DB) await rest('sessions', '', 'POST', { token_hash:tokenHash, username:u, expires_at:exp }, 'return=minimal');
  else { db.sessions[tokenHash]={u,exp}; save(); }
  return tok;
}
async function deleteSession(req) {
  const token=parseCookie(req.headers.cookie).sid;if(!token)return;
  const tokenHash=sha(token);
  if(REMOTE_DB) await rest('sessions',`token_hash=eq.${tokenHash}`,'DELETE'); else { delete db.sessions[tokenHash];save(); }
}
async function getChatHistory(channel) {
  if (!REMOTE_DB) return (db.chats[channel] || []).slice(-50);
  const rows=await rest('chats',`channel=eq.${encodeURIComponent(channel)}&select=sender,text,created_at&order=id.desc&limit=50`);
  return rows.reverse().map(r=>({u:r.sender,text:r.text,ts:Number(r.created_at)}));
}
async function addChat(channel,msg) {
  if(!REMOTE_DB){(db.chats[channel]=db.chats[channel]||[]).push(msg);if(db.chats[channel].length>100)db.chats[channel].shift();save();return;}
  await rest('chats','','POST',{channel,sender:msg.username,text:msg.text,created_at:msg.ts},'return=minimal');
  await rest('rpc/trim_chat_history','','POST',{p_channel:channel},'return=minimal');
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
const isSecure = req => req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
async function newSession(req, u) { const tok=await makeSession(u);return `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30*86400}${isSecure(req)?'; Secure':''}`; }
setInterval(() => {
  const n = Date.now();
  if (REMOTE_DB) rest('sessions',`expires_at=lt.${n}`,'DELETE').catch(e=>console.error('sessions cleanup:',e.message));
  else for (const k of Object.keys(db.sessions)) if (db.sessions[k].exp < n) delete db.sessions[k];
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
const auth = async (req,res) => { const u=await getSession(req); if (!u) json(res,401,{error:'Daxil ol'}); return u; };

const routes = {
  'POST /api/register': async (req, res, body) => {
    const ip = clientIp(req);
    if (count(regs, ip) >= 10) return json(res, 429, { error: 'Çox qeydiyyat cəhdi. Bir az sonra yenə yoxla.' });
    const name = String(body.username || '').trim(), pw = String(body.password || '');
    if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return json(res, 400, { error: 'Ad 3–20 simvol olmalıdır (hərf, rəqəm, _).' });
    if (pw.length < 6 || pw.length > 100) return json(res, 400, { error: 'Şifrə ən azı 6 simvol olmalıdır.' });
    const key = name.toLowerCase();
    if (await getUser(key)) return json(res, 409, { error: 'Bu ad artıq götürülüb.' });
    hit(regs, ip);
    const pass = await hash(pw);
    if (await getUser(key)) return json(res, 409, { error: 'Bu ad artıq götürülüb.' });
    try { await createUser(key, { name, pass, created: Date.now() }); }
    catch(e) { if(String(e.message).includes('(409)'))return json(res,409,{error:'Bu ad artıq götürülüb.'});throw e; }
    const cookie = await newSession(req, key);
    json(res, 200, { user: pub(key) }, { 'Set-Cookie': cookie });
  },
  'POST /api/login': async (req, res, body) => {
    const ip = clientIp(req);
    if (count(fails, ip) >= 15) return json(res, 429, { error: 'Çox uğursuz cəhd. Bir az sonra yenə yoxla.' });
    const key = String(body.username || '').trim().toLowerCase(), u = await getUser(key);
    if (!u || !(await verify(String(body.password || ''), u.pass))) {
      hit(fails, ip);
      return json(res, 401, { error: 'Ad və ya şifrə səhvdir.' });
    }
    json(res, 200, { user: pub(key) }, { 'Set-Cookie': await newSession(req, key) });
  },
  'POST /api/logout': async (req, res) => {
    await deleteSession(req);
    json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  },
  'GET /api/me': async (req, res) => { const u = await getSession(req); const x=u&&await getUser(u); json(res, 200, { user: x ? pub(u) : null }); },
  'GET /api/profile': async (req,res) => {
    const viewer=await auth(req,res);if(!viewer)return;const u=new URL(req.url,'http://x').searchParams.get('u')||viewer;const target=await getUser(u);if(!target)return json(res,404,{error:'İstifadəçi tapılmadı'});
    let following=false,followers=0,visitors=[];
    if(REMOTE_DB){
      if(u!==viewer)await rest('visitors','on_conflict=profile_username,visitor_username','POST',{profile_username:u,visitor_username:viewer,visited_at:Date.now()},'resolution=merge-duplicates,return=minimal');
      const [f,fr,v]=await Promise.all([rest('follows',`follower=eq.${encodeURIComponent(viewer)}&following=eq.${encodeURIComponent(u)}&select=following&limit=1`),rest('follows',`following=eq.${encodeURIComponent(u)}&select=follower`),u===viewer?rest('visitors',`profile_username=eq.${encodeURIComponent(u)}&select=visitor_username,visited_at&order=visited_at.desc&limit=100`):Promise.resolve([])]);
      following=!!f.length;followers=fr.length;visitors=v;
    } else {
      if(u!==viewer){db.visitors[u]||=[];db.visitors[u]=db.visitors[u].filter(v=>v.u!==viewer);db.visitors[u].unshift({u:viewer,ts:Date.now()});db.visitors[u]=db.visitors[u].slice(0,100);save();}
      following=(db.follows[viewer]||[]).includes(u);followers=Object.values(db.follows).filter(a=>a.includes(u)).length;visitors=(u===viewer?db.visitors[u]||[]:[]).map(v=>({visitor_username:v.u,visited_at:v.ts}));
    }
    const visitorProfiles=[];for(const v of visitors){const vp=await getUser(v.visitor_username);if(vp)visitorProfiles.push({u:v.visitor_username,ts:Number(v.visited_at),profile:pub(v.visitor_username)});}
    json(res,200,{profile:pub(u),following,followers,visitors:u===viewer?visitorProfiles:undefined});
  },
  'POST /api/profile': async (req,res,body) => { const u=await auth(req,res);if(!u)return;const x=await getUser(u);const str=(v,n)=>String(v||'').trim().slice(0,n);x.displayName=str(body.displayName,50)||x.name;x.bio=str(body.bio,500);x.age=body.age===''?'':Math.max(13,Math.min(120,Number(body.age)||0));x.city=str(body.city,80);x.status=['available','busy','looking','offline'].includes(body.status)?body.status:'available';x.interests=Array.isArray(body.interests)?body.interests.slice(0,20).map(v=>str(v,32)).filter(Boolean):[];for(const field of ['avatar','cover']){const v=String(body[field]||'');if(v&&!( /^https:\/\//i.test(v)||/^\/uploads\/[a-f0-9]+\.(png|jpg|webp|gif)$/.test(v)))return json(res,400,{error:'Şəkil ünvanı yanlışdır.'});x[field]=v.slice(0,1000);}await putUser(u,x);json(res,200,{profile:pub(u)}); },
  'POST /api/upload': async (req,res,body) => {
    const u=await auth(req,res);if(!u)return;const m=String(body.image||'').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);if(!m)return json(res,400,{error:'PNG, JPEG, WEBP və ya GIF seç.'});const data=Buffer.from(m[2],'base64');if(!data.length||data.length>2*1024*1024)return json(res,413,{error:'Şəkil 2 MB-dan kiçik olmalıdır.'});const signatures={'image/png':data.length>8&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'image/jpeg':data[0]===255&&data[1]===216&&data[2]===255,'image/gif':data.subarray(0,3).toString()==='GIF','image/webp':data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP'};if(!signatures[m[1]])return json(res,400,{error:'Şəkil formatı məzmunla uyğun gəlmir.'});const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'}[m[1]],name=crypto.randomBytes(18).toString('hex')+'.'+ext;
    if(REMOTE_IMAGES){try{const key=`profiles/${encodeURIComponent(u)}/${name}`,url=`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(CF_ACCOUNT_ID)}/r2/buckets/${encodeURIComponent(CF_R2_BUCKET)}/objects/${key.split('/').map(encodeURIComponent).join('/')}`,boundary='----Baxberi'+crypto.randomBytes(12).toString('hex'),body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="body"; filename="${name}"\r\nContent-Type: ${m[1]}\r\n\r\n`),data,Buffer.from(`\r\n--${boundary}--\r\n`)]);const r=await fetch(url,{method:'PUT',headers:{Authorization:`Bearer ${CF_API_TOKEN}`,'Content-Type':`multipart/form-data; boundary=${boundary}`},body,signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error(`R2 upload ${r.status}`);json(res,200,{url:`${R2_PUBLIC_URL}/${key}`});}catch(e){console.error('R2 upload failed:',e.message);json(res,502,{error:'Şəkli object storage-a yükləmək alınmadı.'});}return;}
    if(REMOTE_DB&&process.env.NODE_ENV==='production')return json(res,503,{error:'Cloudflare R2 ayarları tələb olunur.'});try{fs.mkdirSync(UPLOAD_DIR,{recursive:true});fs.writeFileSync(path.join(UPLOAD_DIR,name),data,{flag:'wx'});}catch{return json(res,500,{error:'Şəkli saxlamaq alınmadı.'});}json(res,200,{url:'/uploads/'+name});
  },
  'POST /api/follow': async (req,res,body) => { const u=await auth(req,res);if(!u)return;const to=String(body.username||'');if(!await getUser(to)||to===u)return json(res,400,{error:'İstifadəçi seçimi yanlışdır.'});let following=false;if(REMOTE_DB){const q=`follower=eq.${encodeURIComponent(u)}&following=eq.${encodeURIComponent(to)}&select=following&limit=1`;if((await rest('follows',q)).length)await rest('follows',`follower=eq.${encodeURIComponent(u)}&following=eq.${encodeURIComponent(to)}`,'DELETE');else await rest('follows','','POST',{follower:u,following:to},'resolution=ignore-duplicates,return=minimal');following=(await rest('follows',q)).length>0;}else{db.follows[u]||=[];const i=db.follows[u].indexOf(to);if(i<0)db.follows[u].push(to);else db.follows[u].splice(i,1);following=i<0;save();}json(res,200,{following}); },
  'POST /api/gift': async (req,res,body) => { const u=await auth(req,res);if(!u)return;const to=String(body.username||''),gift=String(body.gift||'🎁').slice(0,8);if(!await getUser(to)||to===u)return json(res,400,{error:'İstifadəçi seçimi yanlışdır.'});if(REMOTE_DB)await rest('gifts','','POST',{sender:u,recipient:to,gift,created_at:Date.now()},'return=minimal');else{db.gifts.push({from:u,to,gift,ts:Date.now()});db.gifts=db.gifts.slice(-1000);save();}json(res,200,{ok:true}); },
  'POST /api/reaction': async (req,res,body) => { const u=await auth(req,res);if(!u)return;const to=String(body.username||''),emoji=String(body.emoji||'❤️').slice(0,8);if(!await getUser(to)||to===u||!['❤️','😂','👏','🔥','😍'].includes(emoji))return json(res,400,{error:'Reaksiya yanlışdır.'});if(REMOTE_DB)await rest('reactions','','POST',{sender:u,recipient:to,emoji,created_at:Date.now()},'return=minimal');else{db.reactions[to]||=[];db.reactions[to].push({from:u,emoji,ts:Date.now()});db.reactions[to]=db.reactions[to].slice(-100);save();}json(res,200,{ok:true}); },
  'GET /api/social': async (req,res) => { const u=await auth(req,res);if(!u)return;if(REMOTE_DB){const [g,r]=await Promise.all([rest('gifts',`or=(sender.eq.${encodeURIComponent(u)},recipient.eq.${encodeURIComponent(u)})&select=*&order=id.desc&limit=30`),rest('reactions',`recipient=eq.${encodeURIComponent(u)}&select=*&order=id.desc&limit=100`)]);return json(res,200,{gifts:g,reactions:r});}json(res,200,{gifts:db.gifts.filter(g=>g.to===u||g.from===u).slice(-30),reactions:db.reactions}); },
  'GET /api/ice': async (req, res) => {
    const u=await auth(req,res);if(!u)return;
    const s = [{ urls: 'stun:stun.l.google.com:19302' }];
    if(process.env.TURN_URL&&process.env.TURN_SECRET){const username=`${Math.floor(Date.now()/1000)+3600}:${u}`,credential=crypto.createHmac('sha1',process.env.TURN_SECRET).update(username).digest('base64');s.push({urls:process.env.TURN_URL.split(',').map(x=>x.trim()),username,credential});}
    else if (process.env.TURN_URL&&process.env.TURN_USER&&process.env.TURN_PASS) s.push({ urls: process.env.TURN_URL.split(',').map(x=>x.trim()), username: process.env.TURN_USER, credential: process.env.TURN_PASS });
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
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy','camera=(self), microphone=(self)');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/healthz') return json(res, 200, { ok: true });
    if (p === '/readyz') { try { if(REMOTE_DB)await rest('users','select=username&limit=1'); else if(process.env.NODE_ENV==='production')return json(res,503,{ok:false}); json(res,200,{ok:true}); } catch { json(res,503,{ok:false}); } return; }
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
const quizGames = new Map();
setInterval(()=>{const now=Date.now();for(const [id,game] of quizGames)if(game.exp<now)quizGames.delete(id);},60000).unref();
const QUIZZES = [
  {q:'Ən böyük okean hansıdır?',options:['Atlantik okeanı','Sakit okean','Hind okeanı'],answer:1},
  {q:'Günəş sistemində ən böyük planet hansıdır?',options:['Saturn','Yer','Yupiter'],answer:2},
  {q:'Azərbaycanın paytaxtı hansıdır?',options:['Gəncə','Bakı','Şuşa'],answer:1},
  {q:'Bir həftədə neçə gün var?',options:['5','7','8'],answer:1}
];
server.on('upgrade', async (req, sock, head) => {
  sock.on('error', () => {});
  let u = null, ok = false;
  try { u = await getSession(req); ok = new URL(req.headers.origin).host === req.headers.host; } catch {}
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !u || !ok) {
    sock.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return sock.destroy();
  }
  wss.handleUpgrade(req, sock, head, ws => { ws.user = u; wss.emit('connection', ws); });
});
const tx = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
function broadcastOnline() {
  const all = [...conns.values()];
  const list = all.map(c => ({
    ...profile(c.user), u: c.user, name: db.users[c.user].displayName || db.users[c.user].name, live: c.live, title: c.title,
    viewers: all.filter(x => x.watching === c.user && x !== c).length
  }));
  all.forEach(c => tx(c, { t: 'online', list }));
}
wss.on('connection', ws => {
  ws.on('error', () => {});
  const old = conns.get(ws.user);
  if (old) { tx(old, { t: 'dup' }); old.close(); }
  Object.assign(ws, { live: false, title: '', watching: null, last: 0, gameLast:0, alive: true });
  ws.on('pong', () => { ws.alive = true; });
  conns.set(ws.user, ws);
  broadcastOnline();
  ws.on('message', async raw => {
    try {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'live') {
        ws.live = !!m.on; ws.title = ws.live ? String(m.title || '').slice(0, 60) : '';
        broadcastOnline();
      } else if (m.t === 'watch') {
        ws.watching = typeof m.to === 'string' && await getUser(m.to) ? m.to : null;
        if (ws.watching) tx(ws, { t: 'history', ch: ws.watching, msgs: await getChatHistory(ws.watching) });
        broadcastOnline();
      } else if (m.t === 'chat') {
        const text = String(m.text || '').trim().slice(0, 200), ch = m.ch, n = Date.now();
        if (!text || typeof ch !== 'string' || !await getUser(ch) || n - ws.last < 500) return;
        ws.last = n;
        const sender=await getUser(ws.user);const msg = { u: sender.displayName || sender.name, username:ws.user, text, ts: n };
        await addChat(ch,msg);
        conns.forEach(c => { if (c.watching === ch || c.user === ch) tx(c, { t: 'chat', ch, msg }); });
      } else if (m.t === 'quiz') {
        const n=Date.now(),peer=ws.watching,q=QUIZZES[Number(m.q)];
        if(!peer||!q||n-ws.gameLast<5000||!conns.has(peer))return;
        ws.gameLast=n;const id=crypto.randomBytes(12).toString('hex');quizGames.set(id,{host:ws.user,opponent:peer,answer:q.answer,exp:n+60000});
        const peerWs=conns.get(peer);tx(peerWs,{t:'quiz',id,question:q.q,options:q.options,from:db.users[ws.user].displayName||db.users[ws.user].name});
      } else if(m.t==='quiz_answer'){
        const game=quizGames.get(String(m.id||''));if(!game||game.opponent!==ws.user||game.exp<Date.now()||![0,1,2].includes(Number(m.answer)))return;quizGames.delete(String(m.id));
        const ok=Number(m.answer)===game.answer,txt=`🧠 Quiz: ${ok?'Düzgün cavab!':'Bu dəfə alınmadı.'}`;const msg={username:game.host,u:db.users[game.host].displayName||db.users[game.host].name,text:txt,ts:Date.now()};
        await addChat(game.opponent,msg);conns.forEach(c=>{if(c.watching===game.opponent||c.user===game.opponent)tx(c,{t:'chat',ch:game.opponent,msg});});
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

async function start(){
  if(process.env.NODE_ENV==='production'&&!REMOTE_DB)throw new Error('SUPABASE_URL və SUPABASE_SECRET_KEY production üçün tələb olunur.');
  if(process.env.NODE_ENV==='production'&&!REMOTE_IMAGES)throw new Error('Cloudflare R2 environment settings are required in production.');
  if(process.env.NODE_ENV==='production'&&(!process.env.TURN_URL||(!process.env.TURN_SECRET&&(!process.env.TURN_USER||!process.env.TURN_PASS))))throw new Error('Production TURN settings are required.');
  if(REMOTE_DB)await rest('users','select=username&limit=1');
  server.listen(PORT, () => console.log('Baxberi işləyir: http://localhost:' + PORT));
}
start().catch(e=>{console.error('Baxberi startup failed:',e.message);process.exit(1);});

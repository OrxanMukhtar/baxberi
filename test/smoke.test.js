const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { WebSocket } = require('ws');

const root = path.resolve(__dirname, '..');
let child, port, base, temp;

async function freePort() {
  const s = net.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const p = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return p;
}
async function waitForServer() {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    try { if ((await fetch(base + '/healthz')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Baxberi server did not start');
}
async function post(route, session, data) {
  return fetch(base + route, { method:'POST', headers:{'Content-Type':'application/json', ...(session ? {Cookie:session} : {})}, body:JSON.stringify(data) });
}
async function register(username) {
  const r=await post('/api/register',null,{username,password:'test-password-123'});
  assert.equal(r.status,200,await r.text());
  return r.headers.get('set-cookie').split(';')[0];
}
function socket(session) {
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{headers:{Origin:base,Cookie:session}});
    ws.once('open',()=>resolve(ws));ws.once('error',reject);
  });
}
function waitMessage(ws,predicate,timeout=3000){return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.off('message',onMessage);reject(new Error('WebSocket message timeout'))},timeout);
  function onMessage(raw){let msg;try{msg=JSON.parse(raw)}catch{return}if(predicate(msg)){clearTimeout(timer);ws.off('message',onMessage);resolve(msg)}}
  ws.on('message',onMessage);
});}

before(async()=>{
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'baxberi-smoke-'));port=await freePort();base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env:{...process.env,PORT:String(port),DB_FILE:path.join(temp,'db.json'),UPLOAD_DIR:path.join(temp,'uploads'),NODE_ENV:'test'},stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',data=>process.stderr.write(data));await waitForServer();
});
after(async()=>{if(child&&!child.killed){child.kill();await new Promise(resolve=>child.once('exit',resolve));}if(temp)await fs.rm(temp,{recursive:true,force:true});});

test('profile, follow, gift, reaction, visitors, upload and TURN settings',async()=>{
  const a=await register('test_user_a'),b=await register('test_user_b');
  let r=await post('/api/profile',a,{displayName:'Tester A',bio:'hello',age:'28',city:'Baku',interests:['music','books'],status:'available'});assert.equal(r.status,200);
  const profile=await (await fetch(base+'/api/profile?u=test_user_a',{headers:{Cookie:b}})).json();assert.equal(profile.profile.displayName,'Tester A');
  const mine=await (await fetch(base+'/api/profile',{headers:{Cookie:a}})).json();assert.equal(mine.visitors[0].profile.username,'test_user_b');
  r=await post('/api/follow',a,{username:'test_user_b'});assert.equal((await r.json()).following,true);
  assert.equal((await (await fetch(base+'/api/profile?u=test_user_b',{headers:{Cookie:a}})).json()).followers,1);
  assert.equal((await post('/api/gift',a,{username:'test_user_b',gift:'🌹'})).status,200);
  assert.equal((await post('/api/reaction',a,{username:'test_user_b',emoji:'❤️'})).status,200);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pV8AAAAASUVORK5CYII=';
  const upload=await post('/api/upload',a,{image:'data:image/png;base64,'+png});assert.equal(upload.status,200);assert.match((await upload.json()).url,/^\/uploads\//);
  assert.equal((await post('/api/upload',a,{image:'data:image/png;base64,aGVsbG8='})).status,400);
  assert.equal((await (await fetch(base+'/api/ice',{headers:{Cookie:a}})).json()).iceServers[0].urls,'stun:stun.l.google.com:19302');
});

test('quiz is interactive and the server validates the answer',async()=>{
  const a=await register('quiz_host'),b=await register('quiz_guest');
  const host=await socket(a),guest=await socket(b);
  try{
    host.send(JSON.stringify({t:'watch',to:'quiz_guest'}));
    await waitMessage(host,m=>m.t==='online');
    const incoming=waitMessage(guest,m=>m.t==='quiz');
    host.send(JSON.stringify({t:'quiz',q:1}));
    const quiz=await incoming;assert.equal(quiz.question,'Günəş sistemində ən böyük planet hansıdır?');
    const result=waitMessage(host,m=>m.t==='chat'&&m.msg.text.includes('Düzgün cavab'));
    guest.send(JSON.stringify({t:'quiz_answer',id:quiz.id,answer:2}));await result;
  }finally{host.close();guest.close();}
});

// One-time import from the previous Baxberi JSON database. Session tokens are
// intentionally never imported, so all old browser sessions must sign in again.
const fs = require('node:fs');
const path = require('node:path');

const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const legacy = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SECRET_KEY;
const file = process.argv[2] || path.join(process.cwd(), 'data', 'db.json');
if (!supabaseUrl || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY before importing.');
if (!fs.existsSync(file)) throw new Error(`JSON database not found: ${file}`);

async function call(table, rows, prefer) {
  const headers={apikey:key,'Content-Type':'application/json',Prefer:prefer};
  if(legacy)headers.Authorization=`Bearer ${key}`;
  const r=await fetch(`${supabaseUrl}/rest/v1/${table}`,{method:'POST',headers,body:JSON.stringify(rows),signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error(`Import into ${table} failed (${r.status})`);
}

async function main(){
  const old=JSON.parse(fs.readFileSync(file,'utf8'));
  const users=Object.entries(old.users||{}).map(([username,data])=>({username,data}));
  for(let i=0;i<users.length;i+=100)await call('users',users.slice(i,i+100),'resolution=ignore-duplicates,return=minimal');
  const byName=new Map(users.map(x=>[String(x.data.name||'').toLowerCase(),x.username]));
  const chats=[];
  for(const [channel,messages] of Object.entries(old.chats||{}))for(const m of messages||[]){
    const sender=byName.get(String(m.u||'').toLowerCase());
    if(sender&&old.users[channel])chats.push({channel,sender,text:String(m.text||'').slice(0,200),created_at:Number(m.ts)||Date.now()});
  }
  for(let i=0;i<chats.length;i+=100)await call('chats',chats.slice(i,i+100),'return=minimal');
  console.log(`Imported ${users.length} accounts and ${chats.length} chat messages. Old sessions were intentionally invalidated.`);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

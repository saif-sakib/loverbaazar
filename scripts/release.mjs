// All credentials arrive via environment/event files, never command arguments or logs.
import {readFile,appendFile} from 'node:fs/promises';
const mode=process.argv[2], origin=new URL(process.env.CATALOG_URL).origin;
async function request(path,body,headers={}) {
 const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(90000)});
 if(!r.ok) throw new Error(`Release API returned ${r.status}`);
 return r.json();
}
if(mode==='init') {
 const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
 const release=event.client_payload?.id ? event.client_payload : await request('/api/publish/prepare',{}, {'X-Publish-Token':process.env.PUBLISH_TOKEN||''});
 if(!/^[A-F0-9]{32}$/.test(release.id)||!/^[A-F0-9]{64}$/.test(release.key))throw new Error('Invalid release identity');
 console.log('::add-mask::'+release.key);
 await appendFile(process.env.GITHUB_ENV,`BUILD_ID=${release.id}\nBUILD_KEY=${release.key}\n`);
 await request(`/api/build/${release.id}/result`,{State:'running',Commit:process.env.GITHUB_SHA},{'X-Build-Key':release.key});
} else {
 if(!process.env.BUILD_ID)process.exit(0);
 if(mode==='published'){
  const r=await fetch(new URL('/release.json',process.env.STORE_URL||origin),{cache:'no-store',signal:AbortSignal.timeout(30000)});
  const visible=await r.json();if(!r.ok||visible.id!==process.env.BUILD_ID||visible.commit!==process.env.GITHUB_SHA)throw new Error('Deployed release did not match');
 }
 await request(`/api/build/${process.env.BUILD_ID}/result`,{State:mode,Commit:process.env.GITHUB_SHA},{'X-Build-Key':process.env.BUILD_KEY});
}

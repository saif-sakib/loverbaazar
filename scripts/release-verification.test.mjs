import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyDeployment} from './release-verification.mjs';
const id='release-under-test',commit='expected-commit';
const good=()=>Response.json({id,commit});
function options(fetchImpl, extra={}) {
  return {storeURL:'https://preview.example',id,commit,attempts:4,delayMS:0,sleep:async()=>{},fetchImpl,...extra};
}
test('404 HTML, old metadata and malformed JSON are retried before accepting the correct artifact',async()=>{
  const responses=[new Response('<!DOCTYPE html>old 404 page',{status:404}),Response.json({id:'old',commit}),new Response('{broken',{headers:{'Content-Type':'application/json'}}),good()];
  let calls=0,sleeps=0;
  await verifyDeployment(options(async(url,init)=>{
    assert.equal(url.pathname,'/release.json');
    assert.equal(url.searchParams.get('release'),id);
    assert.equal(init.cache,'no-store');assert.equal(init.redirect,'error');
    return responses[calls++];
  },{sleep:async()=>{sleeps++;}}));
  assert.equal(calls,4);assert.equal(sleeps,3);
});
test('an HTTP 200 HTML fallback fails with a concise error without logging its body',async()=>{
  const reports=[];
  await assert.rejects(verifyDeployment(options(async()=>new Response('<html>do not log this body</html>',{headers:{'Content-Type':'text/html'}}),{attempts:2,report:line=>reports.push(line)})),error=>{
    assert.match(error.message,/after 2 attempts/);assert.match(error.message,/response is not JSON/);
    assert.doesNotMatch(error.message,/do not log|Unexpected token/);return true;
  });
  assert.equal(reports.length,2);assert.doesNotMatch(reports.join(),/do not log/);
});
test('a matching release ID with the wrong commit never confirms publication',async()=>{
  await assert.rejects(verifyDeployment(options(async()=>Response.json({id,commit:'wrong'}),{attempts:2})),/does not match/);
});
test('network errors recover, and a matching artifact confirms without additional requests',async()=>{
  let calls=0;
  await verifyDeployment(options(async()=>{if(++calls===1)throw new Error('private transport details');return good();}));
  assert.equal(calls,2);
});
test('missing or null metadata never confirms publication',async()=>{
  for(const value of [null,{}, {commit}, {id}]) {
    await assert.rejects(verifyDeployment(options(async()=>Response.json(value),{attempts:1})),/No publication acknowledgment was sent/);
  }
});

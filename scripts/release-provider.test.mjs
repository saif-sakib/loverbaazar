import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deployRender, verifyAPI, fingerprint, promote } from "./release-provider.mjs";

const commit = "a".repeat(40);
const pause = async () => {};

test("Render receives the exact commit and rejects an incompatible service before deployment", async () => {
  let sent;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (options.method === "POST") {
      sent = JSON.parse(options.body);
      return Response.json({id:"dep-test"});
    }
    if (path.endsWith("/dep-test")) return Response.json({status:"live",commit:{id:commit}});
    return Response.json({autoDeploy:"no",serviceDetails:{plan:"free"}});
  };
  assert.equal(await deployRender("srv-test","fixture",commit,{fetchImpl,pause}),"dep-test");
  assert.deepEqual(sent,{commitId:commit});
  await assert.rejects(deployRender("srv-test","fixture",commit,{pause,fetchImpl: async (_,options) => {
    assert.notEqual(options.method,"POST");
    return Response.json({autoDeploy:"yes",serviceDetails:{plan:"free"}});
  }}), /Auto-Deploy Off/);
});

test("failed health, stale revision or sleeping origin never pass the readiness gate", async () => {
  const inputs = [new Response("loading",{status:503}), Response.json({ready:true,version:"old"}), Response.json({ready:false,version:commit})];
  await assert.rejects(verifyAPI("https://store.test",commit,{attempts:3,pause,fetchImpl:async () => inputs.shift()}),/readiness/);
  await verifyAPI("https://store.test",commit,{attempts:1,pause,fetchImpl:async () => Response.json({ready:true,version:commit})});
});

test("failed promotion restores the previous version only when the candidate still owns traffic", async () => {
  let active = "prior", rolledBack = 0;
  const scenario = {
    previous:"prior", candidate:"next", current:async () => active, deploy:async value => {active=value},
    rollback:async value => {active=value;rolledBack++}, verify:async () => {throw new Error("unavailable")},
  };
  await assert.rejects(promote(scenario),/Previous Worker version restored/);
  assert.equal(active,"prior");
  assert.equal(rolledBack,1);
  await assert.rejects(promote({...scenario, verify:async () => {active="external";throw new Error("changed")}}),/promotion was not confirmed/);
  assert.equal(active,"external");
  assert.equal(rolledBack,1);
  await assert.rejects(promote(scenario),/changed while the candidate/);
});

test("artifact fingerprint is stable, ignores its own manifest and changes with assets", async () => {
  const dir = await mkdtemp(join(tmpdir(),"lb-artifact-test-"));
  try {
    await writeFile(join(dir,"index.html"),"one");
    const first = await fingerprint(dir);
    await writeFile(join(dir,"release.json"),"metadata");
    assert.equal(await fingerprint(dir),first);
    await writeFile(join(dir,"index.html"),"two");
    assert.notEqual(await fingerprint(dir),first);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

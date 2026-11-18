// Only called by the serialized main-branch publication workflow. Reads secrets from its environment.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { verifyDeployment } from "./release-verification.mjs";

const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = /^[a-f0-9]{40}$/i;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

async function json(url, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(12000), ...options, headers: {"User-Agent":"loverbaazar-release/1.0", ...(options.headers ?? {})} });
  if (!response.ok) throw new Error(`Service HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Service response was not JSON");
  return response.json();
}

export async function verifyAPI(store, commit, { fetchImpl = fetch, pause = sleep, attempts = 20 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await json(new URL("/api/ready", store), {}, fetchImpl);
      if (result.ready === true && result.version === commit) return;
    } catch { /* Render may be waking or initializing the snapshots. */ }
    if (i + 1 < attempts) await pause(5000);
  }
  throw new Error("API readiness did not confirm the tested code revision");
}

export async function deployRender(service, key, commit, { fetchImpl = fetch, pause = sleep, attempts = 60 } = {}) {
  if (!/^srv-[a-z0-9]+$/.test(service ?? "") || !key || !sha.test(commit)) throw new Error("Missing Render service ID, API key or code revision");
  const url = `https://api.render.com/v1/services/${service}`;
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const config = await json(url, {headers}, fetchImpl);
  if (config.autoDeploy !== "no" || config.serviceDetails?.plan !== "free") throw new Error("Render requires Free compute with Auto-Deploy Off");
  const deployed = await json(url + "/deploys", { method: "POST", headers, body: JSON.stringify({ commitId: commit }) }, fetchImpl);
  if (!/^dep-[a-z0-9]+$/.test(deployed.id ?? "")) throw new Error("Render did not return a deploy ID");
  const active = new Set(["created", "build_in_progress", "pre_deploy_in_progress", "update_in_progress", "queued"]);
  for (let i = 0; i < attempts; i++) {
    await pause(7000);
    let deployment;
    try {
      deployment = await json(url + "/deploys/" + deployed.id, { headers }, fetchImpl);
    } catch {
      continue;
    }
    if (deployment.status === "live" && deployment.commit?.id === commit) return deployed.id;
    if (!active.has(deployment.status)) throw new Error("Render did not make the requested revision live");
  }
  throw new Error("Render deployment timed out");
}

export async function fingerprint(folder) {
  const hash = createHash("sha256");
  let files = 0;
  async function visit(path) {
    const entries = await readdir(join(folder, path), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = path ? `${path}/${entry.name}` : entry.name;
      if (name === "release.json") continue;
      if (entry.isDirectory()) {
        await visit(name);
        continue;
      }
      if (!entry.isFile()) throw new Error("Store artifact contains a non-file");
      const data = await readFile(join(folder, name));
      // Cloudflare Workers Free static asset limits.
      if (++files > 20_000 || data.length > 25 * 1024 * 1024) throw new Error("Store exceeds Cloudflare Free static assets limits");
      hash.update(JSON.stringify([name, createHash("sha256").update(data).digest("hex")]) + "\n");
    }
  }
  await visit("");
  if (!files) throw new Error("Empty store artifact");
  return hash.digest("hex");
}

export async function promote({ previous, candidate, current, deploy, rollback, verify }) {
  if (await current() !== previous) throw new Error("Cloudflare deployment changed while the candidate was building");
  try {
    await deploy(candidate);
    await verify();
  } catch {
    if (await current() === candidate) {
      await rollback(previous);
      if (await current() !== previous) throw new Error("Cloudflare rollback was not confirmed");
      throw new Error("Candidate verification failed. Previous Worker version restored.");
    }
    throw new Error("Cloudflare promotion was not confirmed. Check deployment history.");
  }
}

function wrangler(args, env = process.env) {
  return run(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...args], {env, maxBuffer: 2_000_000});
}
async function currentVersion() {
  const { stdout } = await wrangler(["deployments", "list", "--json"]);
  const deployed = JSON.parse(stdout)[0]?.versions;
  if (deployed?.length !== 1 || deployed[0].percentage !== 100 || !uuid.test(deployed[0].version_id)) throw new Error("Expected one current Cloudflare version at 100%");
  return deployed[0].version_id;
}

async function main() {
  const { GITHUB_SHA: commit, STORE_URL: store, RENDER_SERVICE_ID, RENDER_API_KEY } = process.env;
  if (!sha.test(commit) || new URL(store).protocol !== "https:") throw new Error("Release requires a tested SHA and HTTPS storefront");
  const journal = process.env.RUNNER_TEMP && join(process.env.RUNNER_TEMP, "lb-promotion.json");
  switch (process.argv[2]) {
    case "recover": {
      if (!journal) throw new Error("Recovery needs the workflow runner journal");
      let entry;
      try { entry = JSON.parse(await readFile(journal, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      if (!uuid.test(entry.previous) || !uuid.test(entry.candidate) || entry.previous === entry.candidate) throw new Error("Invalid promotion journal");
      if (await currentVersion() !== entry.candidate) return;
      await wrangler(["rollback", entry.previous, "--yes", "--message", "Incomplete coordinated publication"]);
      if (await currentVersion() !== entry.previous) throw new Error("Incomplete promotion rollback was not confirmed");
      console.log(`Restored previous Worker ${entry.previous}`);
      break;
    }
    case "api":
      if (process.env.DEPLOY_RENDER === "true") {
        const id = await deployRender(RENDER_SERVICE_ID, RENDER_API_KEY, commit);
        console.log(`Render deployment ${id} is live`);
      } else {
        const current = await json(new URL("/release.json", store));
        if (current.commit !== commit) throw new Error("Publish changes needs the tested code release deployed first");
      }
      await verifyAPI(store, commit);
      break;
    case "store": {
      const folder = resolve("dist");
      const file = join(folder, "release.json");
      const metadata = JSON.parse(await readFile(file));
      if (metadata.commit !== commit || metadata.id !== process.env.BUILD_ID || !Number.isSafeInteger(metadata.revision)) throw new Error("Artifact identity mismatch");
      metadata.artifact = await fingerprint(folder);
      await writeFile(file, JSON.stringify(metadata));
      const work = await mkdtemp(join(tmpdir(), "lb-worker-promotion-"));
      try {
        const previous = await currentVersion();
        const machineOutput = join(work, "version.jsonl");
        await wrangler(["versions", "upload", "--message", `Release ${metadata.id}`], {...process.env, WRANGLER_OUTPUT_FILE_PATH: machineOutput});
        const records = (await readFile(machineOutput,"utf8")).trim().split("\n").map(line => JSON.parse(line));
        const candidate = records.findLast(record => record.type === "version-upload")?.version_id;
        if (!uuid.test(candidate)) throw new Error("Cloudflare did not return the candidate version");
        const { stdout } = await run("git", ["ls-remote","origin","refs/heads/main"]);
        if (stdout.split(/\s+/)[0] !== commit) throw new Error("A newer main revision is waiting");
        await run(process.execPath, ["../../scripts/release.mjs","running"]);
        if (!journal) throw new Error("Workflow runner journal is required");
        await writeFile(journal, JSON.stringify({ previous, candidate }), {mode:0o600});
        await promote({
          previous, candidate, current: currentVersion,
          deploy: id => wrangler(["versions", "deploy", `${id}@100`, "--yes"]),
          rollback: id => wrangler(["rollback", id, "--yes", "--message", "Candidate verification failed"]),
          verify: () => verifyDeployment({storeURL:store,id:metadata.id,commit,artifact:metadata.artifact,report:console.log}),
        });
        console.log(`Release ${metadata.id}, revision ${metadata.revision}, artifact SHA-256 ${metadata.artifact}, Worker ${candidate} (previous ${previous})`);
      } finally {
        await rm(work,{recursive:true,force:true});
      }
      break;
    }
    default:
      throw new Error("Unknown deployment stage");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { await main(); }
  catch (error) {
    // Child-process errors can include command arguments or unexpectedly verbose provider output.
    console.error(error.cmd || error.name !== "Error" ? "Release stage failed. Inspect the provider deployment history." : error.message);
    process.exitCode = 1;
  }
}

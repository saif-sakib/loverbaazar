// Credentials arrive in environment variables or the GitHub event file.
import { readFile, appendFile } from "node:fs/promises";
import { verifyDeployment } from "./release-verification.mjs";

const mode = process.argv[2];
const origin = new URL(process.env.CATALOG_URL).origin;
async function request(path, body, headers = {}) {
  const response = await fetch(origin + path, {
    method: body ? "POST" : "GET", redirect: "error",
    headers: { "Content-Type": "application/json", "User-Agent": "loverbaazar-release/1.0", ...headers },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000),
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error(`Release API returned HTTP ${response.status} or an invalid response`);
  return response.json();
}

const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
const identity = ({ id, key }) => {
  if (!/^[A-F0-9]{32}$/.test(id) || !/^[A-F0-9]{64}$/.test(key)) throw new Error("Invalid release identity");
  return { id, key };
};
const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runID, GITHUB_RUN_ATTEMPT: attempt } = process.env;
// The admin links failures to this exact run; the API accepts only GitHub run URLs.
const run = server === "https://github.com" && repo && runID ? `${server}/${repo}/actions/runs/${runID}${attempt ? `/attempts/${attempt}` : ""}` : "";
const result = ({id, key}, state, artifact = "", error = "") => request(`/api/build/${id}/result`, { State:state, Commit:process.env.GITHUB_SHA, Artifact:artifact, Error:error, Run:run }, {"X-Build-Key":key});

if (mode === "init") {
  const release = identity(event.client_payload?.id ? event.client_payload : await request("/api/publish/prepare", {}, {"X-Publish-Token":process.env.PUBLISH_TOKEN || ""}));
  console.log("::add-mask::" + release.key);
  await appendFile(process.env.GITHUB_ENV, `BUILD_ID=${release.id}\nBUILD_KEY=${release.key}\n`);
  const bundle = await request(`/api/build/${release.id}`, undefined, {"X-Build-Key":release.key});
  if (!Number.isSafeInteger(bundle.revision) || bundle.revision < 0) throw new Error("Invalid frozen catalog revision");
  await appendFile(process.env.GITHUB_ENV, `BUILD_REVISION=${bundle.revision}\n`);
  await result(release, "running");
} else {
  const selected = process.env.BUILD_ID ? {id:process.env.BUILD_ID,key:process.env.BUILD_KEY} : event.client_payload;
  if (!selected?.id) process.exit(0);
  const release = identity(selected);
  console.log("::add-mask::" + release.key);
  if (mode === "published") {
    const { artifact } = JSON.parse(await readFile("dist/release.json","utf8"));
    if (!/^[a-f0-9]{64}$/.test(artifact)) throw new Error("Missing artifact fingerprint");
    await verifyDeployment({storeURL:process.env.STORE_URL || origin,id:release.id,commit:process.env.GITHUB_SHA,artifact,report:console.log});
    for (let i=0; ;i++) {
      try {
        const confirmation = await result(release, mode, artifact);
        if (confirmation.state !== "published") throw new Error("Publication was not recorded as published");
        break;
      } catch (error) {
        if (i === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  } else if (mode === "running") {
    await result(release, mode);
  } else if (mode === "failed") {
    await result(release, mode, "", (process.env.PUBLISH_FAILURE || "").slice(0, 300));
  } else {
    throw new Error("Unknown release stage");
  }
}

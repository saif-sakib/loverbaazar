// Confirm the visible artifact before allowing the API to mark a release published.
export async function verifyDeployment({
  storeURL, id, commit, attempts = 12, delayMS = 5000,
  fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  report = () => {},
}) {
  const url = new URL('/release.json', storeURL);
  url.searchParams.set('release', id);
  let reason = 'metadata unavailable';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json', 'User-Agent': 'loverbaazar-release/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        reason = `HTTP ${response.status}`;
        await response.body?.cancel();
      } else if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        reason = 'response is not JSON';
        await response.body?.cancel();
      } else {
        let visible;
        try { visible = await response.json(); }
        catch { reason = 'metadata contains invalid JSON'; }
        if (visible && visible.id === id && visible.commit === commit) return;
        if (visible) reason = 'visible release ID or commit does not match';
      }
    } catch {
      reason = 'metadata request failed or timed out';
    }
    report(`Deployment verification ${attempt}/${attempts}: ${reason}.`);
    if (attempt < attempts) await sleep(delayMS);
  }
  // Never include an HTML error page, credentials or an arbitrary response body in CI logs.
  throw new Error(`Deployment could not be confirmed at ${url.origin}/release.json after ${attempts} attempts (${reason}). No publication acknowledgment was sent.`);
}

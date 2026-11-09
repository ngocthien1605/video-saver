'use strict';
// Fetch pipeline for the downloader: retries, fallback from a direct request to fetching
// through the video tab (on 403 etc.), and signed-query inheritance.
// Adapters (injected): ext(url, range) and page(url, range) → { data, contentRange, status },
// throwing an error with .status on HTTP failure. page is null when there is no video tab.
function createFetcher({ ext, page, getMaster, log, sleep }) {
  let mode = 'ext'; // 'ext' = direct with replayed headers; 'page' = through the video tab
  let inherit = false; // server wants the manifest's ?query on child requests

  // Some CDNs sign the whole folder: the manifest's ?token must be added to every
  // child playlist / segment that is listed without one.
  function inheritQuery(url) {
    try {
      const u = new URL(url), m = new URL(getMaster());
      if (u.search || !m.search || u.origin !== m.origin) return null;
      u.search = m.search; // place signature before a fragment, not inside it
      return u.href;
    } catch { return null; }
  }

  async function once(url, range) {
    if (mode === 'page') return page(url, range);
    try {
      return await ext(url, range);
    } catch (e) {
      if (!page) throw e;
      let r;
      try {
        r = await page(url, range);
      } catch (pe) {
        if (pe.status) throw pe;
        e.message += ` (fallback through video tab also failed: ${pe.message})`;
        throw e;
      }
      if (mode !== 'page') {
        mode = 'page';
        log(`Direct request failed (${e.status ? 'HTTP ' + e.status : e.message}). Switching to fetching through the video tab.`, 'ok');
      }
      return r;
    }
  }

  async function reqRaw(url, range) {
    for (let i = 0; ; i++) {
      try {
        return await once(url, range);
      } catch (e) {
        const retryable = !e.status || e.status >= 500 || e.status === 429;
        if (!retryable || i >= 3) throw e;
        await sleep(600 * 2 ** i);
      }
    }
  }

  async function req(url, range = null) {
    const alt = inheritQuery(url);
    if (alt && inherit) return reqRaw(alt, range);
    try {
      return await reqRaw(url, range);
    } catch (e) {
      if (!alt || ![401, 403].includes(e.status)) throw e;
      const r = await reqRaw(alt, range);
      if (!inherit) {
        inherit = true;
        log('The server wants the playlist’s signature on every request. Adding it automatically.', 'ok');
      }
      return r;
    }
  }

  async function get(url, { type = 'buf', range = null } = {}) {
    const r = await req(url, range);
    return type === 'text' ? new TextDecoder().decode(r.data) : r.data;
  }

  return { req, get, get mode() { return mode; } };
}

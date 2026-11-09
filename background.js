// Stream Saver — background service worker
// - Sniffs network responses for media and keeps a per-tab list in storage.session.
// - Records the exact request headers the page used (Referer, Origin, Cookie,
//   Authorization, custom X-* tokens) so they can be replayed — the usual cause of 403s.
// - Runs direct file downloads with those headers, and falls back to fetching
//   through the original tab if the server still refuses.

importScripts('common.js', 'captures.js', 'replay.js');

const MIN_FILE_SIZE = 512 * 1024;
const SEGMENT_RE = /\.(m4s|ts|m4f|cmfv|cmfa|aac)(\?|#|$)/i;
// Headers that are browser plumbing, not auth — never replayed.
const SKIP_HDR = /^(host|connection|accept|accept-encoding|accept-language|range|content-length|content-type|cache-control|pragma|priority|dnt|te|upgrade-insecure-requests|if-.*|sec-.*)$/;

function classify(url, ct = '') {
  const u = url.toLowerCase();
  ct = ct.toLowerCase();
  if (/\.m3u8(\?|#|$)/.test(u) || ct.includes('mpegurl')) return 'hls';
  if (/\.mpd(\?|#|$)/.test(u) || ct.includes('dash+xml')) return 'dash';
  if (SEGMENT_RE.test(u)) return null;
  if (u.includes('m3u8')) return 'hls'; // e.g. .../source?f=m3u8
  if (/\.webm(\?|#|$)/.test(u) || ct.startsWith('video/webm')) return 'webm';
  if (/\.(mp4|m4v|mov)(\?|#|$)/.test(u) || ct.startsWith('video/mp4') || ct.startsWith('video/quicktime')) return 'mp4';
  if (/\.(m4a|mp3|ogg|opus|flac|wav)(\?|#|$)/.test(u) || ct.startsWith('audio/')) return 'audio';
  if (ct.startsWith('video/') && !/mp2t|iso\.segment/.test(ct)) return 'mp4'; // mkv, 3gp, ogv… and extensionless URLs (e.g. Google Drive videoplayback)
  return null;
}

function updateBadge(tabId, d) {
  const n =
    Object.keys(d.items).length +
    Object.values(d.mse).reduce(
      (s, st) => s + (st.tracks || []).filter((t) => t.bytes > 0).length + (st.blobs || []).length,
      0
    );
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' }).catch(() => {});
}

const locks = new Map();
function withTab(tabId, fn) {
  const prev = locks.get(tabId) || Promise.resolve();
  const next = prev
    .then(async () => {
      const d = await readTab(tabId);
      await fn(d);
      await writeTab(tabId, d);
      updateBadge(tabId, d);
    })
    .catch((e) => console.warn('[Stream Saver]', e));
  locks.set(tabId, next);
  return next;
}

/* -------- capture request headers (extraHeaders exposes Cookie/Referer) -------- */
const reqHdrs = new Map();
chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0) return;
    if (d.initiator && d.initiator.startsWith('chrome-extension://')) return;
    const o = {};
    for (const h of d.requestHeaders || []) {
      const n = h.name.toLowerCase();
      if (!SKIP_HDR.test(n) && h.value != null) o[n] = h.value;
    }
    reqHdrs.set(d.requestId, o);
    if (reqHdrs.size > 3000) reqHdrs.delete(reqHdrs.keys().next().value);
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);
chrome.webRequest.onErrorOccurred.addListener((d) => reqHdrs.delete(d.requestId), { urls: ['<all_urls>'] });

chrome.webRequest.onHeadersReceived.addListener(
  (det) => {
    const hdr = reqHdrs.get(det.requestId);
    reqHdrs.delete(det.requestId);
    if (det.tabId < 0 || det.statusCode >= 300) return; // skip redirects and errors
    if (det.initiator && det.initiator.startsWith('chrome-extension://')) return;
    const h = {};
    for (const x of det.responseHeaders || []) h[x.name.toLowerCase()] = x.value || '';
    const kind = classify(det.url, h['content-type']);
    if (!kind) return;

    let size = +h['content-length'] || 0;
    const m = /\/(\d+)\s*$/.exec(h['content-range'] || '');
    if (m) size = +m[1];
    if ((kind === 'mp4' || kind === 'webm' || kind === 'audio') && size && size < MIN_FILE_SIZE) return;

    const url = cleanUrl(det.url);
    withTab(det.tabId, (d) => {
      const it = d.items[url] || (d.items[url] = { url, kind, size, ct: h['content-type'] || '' });
      if (size > it.size) it.size = size;
      // Always keep the newest headers: cookies and tokens rotate.
      if (hdr) it.hdr = hdr;
      it.frameId = det.frameId;
      it.page = det.initiator || it.page || '';
      it.t = Date.now();
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

/* ------------------------- direct file downloads ------------------------- */
async function directDownload({ url, filename, tabId }) {
  const parsed = httpUrl(url);
  if (!parsed || typeof filename !== 'string' || !filename || !Number.isInteger(tabId)) throw new Error('Invalid media download URL or filename');
  const it = itemFor(await readTab(tabId), url) || { url, kind: 'mp4' };
  // -1 = requests not tied to a tab, which is what chrome.downloads makes.
  const rids = await installRules(replayRules(replayHeaders(it), { tabId: -1, host: parsed.hostname, origin: parsed.origin }));
  let id;
  try {
    id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  } catch (e) {
    removeRules(rids);
    throw e;
  }
  await chrome.storage.session.set({
    ['dl_' + id]: { rids, url, tabId, frameId: it.frameId || 0, title: filename.replace(/\.[^.]+$/, ''), ext: (/\.([^.]+)$/.exec(filename) || [])[1] || 'mp4' },
  });
  settle(id);
  return { id };
}

// Runs when a download ends. Also called right after the record is saved, because a
// download that fails instantly can finish before the record exists.
const settling = new Set();
async function settle(id) {
  const k = 'dl_' + id;
  if (settling.has(id)) return;
  settling.add(id);
  try {
    const info = (await chrome.storage.session.get(k))[k];
    const [item] = await chrome.downloads.search({ id });
    if (!info || !item || item.state === 'in_progress') return;
    await chrome.storage.session.remove(k);
    removeRules(info.rids);
    if (item.state !== 'interrupted' || item.error === 'USER_CANCELED') return;
    // Server refused the browser download (403 etc.): retry through the original tab.
    const q = new URLSearchParams({ url: info.url, kind: 'file', tab: info.tabId, frame: info.frameId, title: info.title, ext: info.ext, why: item.error || '' });
    chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html?' + q) });
  } finally {
    settling.delete(id);
  }
}
chrome.downloads.onChanged.addListener((c) => {
  if (c.state && c.state.current !== 'in_progress') settle(c.id);
});

/* -------------------------------- messages -------------------------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === MSG.MSE_STATE && sender.tab) {
    const state = mediaState(msg.state);
    if (!state) return;
    withTab(sender.tab.id, (d) => {
      d.mse[sender.frameId] = state;
    });
    return;
  }
  if (msg.type === MSG.DOM_MEDIA && sender.tab) {
    if (!httpUrl(msg.url) || !['video', 'audio'].includes(msg.tag)) return;
    const url = cleanUrl(msg.url);
    const page = httpUrl(sender.url) || httpUrl(sender.tab.url);
    withTab(sender.tab.id, (d) => {
      d.items[url] = d.items[url] || { url, kind: msg.tag === 'audio' ? 'audio' : 'mp4', size: 0, frameId: sender.frameId, page: page ? page.origin : '', t: Date.now() };
    });
    return;
  }
  if (msg.type === MSG.CLEAR && msg.tabId != null) {
    withTab(msg.tabId, (d) => {
      d.items = {};
    }).then(() => sendResponse(true));
    return true;
  }
  if (msg.type === MSG.DIRECT_DOWNLOAD) {
    directDownload(msg).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    withTab(tabId, (d) => {
      d.items = {};
      d.mse = {};
    });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  removeTab(tabId);
  locks.delete(tabId);
  // Header rules created by a downloader tab.
  const k = 'rules_' + tabId;
  const ids = (await chrome.storage.session.get(k))[k];
  if (ids) {
    removeRules(ids);
    chrome.storage.session.remove(k);
  }
});

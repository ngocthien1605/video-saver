'use strict';
// Stream Saver — downloader page for HLS / DASH / direct files.
//
// 403 handling, in order:
//   1. Replay the request headers the page itself sent (Referer, Origin, Cookie,
//      Authorization, X-* tokens) via a declarativeNetRequest rule scoped to this tab.
//   2. If the server still refuses, fetch every request *through the original tab*
//      (bridge.js), so it carries the page's real origin, cookies and session.
//   3. If HLS segment links expire mid-download, reload the playlist and retry
//      with fresh links.
// DRM-protected streams are detected and refused.

const P = new URLSearchParams(location.search);
const SRC = P.get('url');
const KIND = P.get('kind');
const SRC_TAB = P.has('tab') ? +P.get('tab') : null;
let SRC_FRAME = +(P.get('frame') || 0);
const REFERER = P.get('referer') || '';
const TITLE = safe(P.get('title'));
const CONCURRENCY = 6;
let stopFlag = false;
let MASTER = SRC; // current (freshest) signed URL of the manifest

/* ------------------- signed / expiring links (CloudFront etc.) ------------------- */
const clock = (ms) => new Date(ms).toLocaleTimeString();

// Newest URL with the same path that the video tab has requested since (new signature).
async function newestCapture(u) {
  if (SRC_TAB == null) return null;
  const d = await readTab(SRC_TAB);
  const best = freshestCapture(d.items, u);
  return best && best.url;
}

// Returns a usable signed URL for u, waiting (up to 3 min) for the video tab to
// request a fresh one when the current signature has expired.
async function ensureFresh(u, label, force = false) {
  const exp = expiryOf(u);
  if (!force && (!exp || exp - Date.now() > 20000)) return u;
  if (exp) log(`The ${label} link ${exp < Date.now() ? 'expired' : 'expires'} at ${clock(exp)}. Looking for a newer signed link…`);
  // ponytail: a link with no recognisable expiry gets 30s, not 3min (it is probably not a stale signature).
  for (let i = 0; i < (exp ? 180 : 30); i++) {
    const n = await newestCapture(u);
    const ne = n && expiryOf(n);
    if (n && (!ne || ne > Date.now() + 20000)) {
      log(`Got a fresh signed link${ne ? ` (valid until ${clock(ne)})` : ''}.`, 'ok');
      return n;
    }
    if (i === 0) {
      if (SRC_TAB == null) break;
      log('→ Go to the video tab and reload it (or press play again). Stream Saver will pick up the new link automatically and continue.', 'err');
    }
    await sleep(1000);
  }
  const e = new Error(`No fresh ${label} link appeared. Reload the video page, press play, then open the stream again from the popup.`);
  e.status = 403;
  throw e;
}

class DRMError extends Error {
  constructor() {
    super('This stream is DRM-protected (Widevine / PlayReady / FairPlay or sample-level encryption). Stream Saver does not decrypt or bypass DRM.');
  }
}
class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} — ${url}`);
    this.status = status;
  }
}

function log(msg, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  $('#log').append(line);
  $('#log').scrollTop = 1e9;
}
function fail(e) {
  if (e instanceof DRMError) return log('🔒 ' + e.message, 'err');
  log('Error: ' + e.message, 'err');
  console.error(e);
  if (e.status === 401 || e.status === 403 || e.status === 410) {
    log(
      SRC_TAB == null
        ? 'The server refused the request. Open this download from the popup while the video tab is open, so it can be fetched through that tab.'
        : 'The server refused the request, even through the video tab. The link has probably expired or is tied to the player session. To fix it:\n' +
            '  1. Go back to the video tab, reload it and press play.\n' +
            '  2. Open Stream Saver, press Clear, wait a few seconds, then use the new entry.\n' +
            '  3. Keep the video tab open until the download finishes.',
      'err'
    );
  }
}

const prog = { done: 0, total: 0, bytes: 0, live: false };
function tick() {
  const bar = $('#bar');
  if (prog.live) bar.removeAttribute('value');
  else {
    bar.max = prog.total || 1;
    bar.value = prog.done;
  }
  $('#stat').textContent = `${prog.done}${prog.total && !prog.live ? ' / ' + prog.total : ''} ${KIND === 'file' ? 'chunks' : 'segments'} · ${fmt(prog.bytes)}${fetcher.mode === 'page' ? ' · via video tab' : ''}`;
}

/* ------------------------- step 1: replay headers ------------------------- */
async function setupHeaders() {
  const me = await chrome.tabs.getCurrent();
  if (!me) return;
  const rk = 'rules_' + me.id;
  const old = (await chrome.storage.session.get(rk))[rk];
  if (old) await removeRules(old);

  let item = null;
  if (SRC_TAB != null) {
    item = itemFor(await readTab(SRC_TAB), SRC);
    if (item && item.frameId != null && !P.has('frame')) SRC_FRAME = item.frameId;
  }
  const hdr = replayHeaders(item, REFERER);
  const parsed = httpUrl(SRC);
  if (!parsed) throw new Error('Invalid media URL (expected HTTP or HTTPS)');
  // Credentials only go to the host they were captured for.
  const ids = await installRules(replayRules(hdr, { tabId: me.id, host: parsed.hostname, origin: parsed.origin, anyHost: true }));
  if (!ids.length) return;
  try { await chrome.storage.session.set({ [rk]: ids }); }
  catch (e) { await removeRules(ids); throw e; }
  addEventListener('pagehide', () => { removeRules(ids).catch(console.warn); }, { once: true });
  log(`Sending the page’s request headers: ${Object.keys(hdr).join(', ')}`);
}

/* --------------------- step 2: fetch through original tab --------------------- */
function b64dec(b) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(b);
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

async function extReq(url, range) {
  const headers = range ? { Range: `bytes=${range[0]}-${range[1]}` } : {};
  const r = await fetch(url, { credentials: 'include', headers, cache: 'no-store' });
  if (!r.ok) throw new HttpError(r.status, url);
  return { data: new Uint8Array(await r.arrayBuffer()), contentRange: r.headers.get('content-range'), status: r.status };
}

async function pageReq(url, range) {
  let res;
  const send = (frameId) => chrome.tabs.sendMessage(SRC_TAB, { type: MSG.PAGE_FETCH, url, range }, { frameId });
  try {
    res = await send(SRC_FRAME);
  } catch (e) {
    if (SRC_FRAME !== 0) {
      SRC_FRAME = 0; // player iframe was reloaded; try the top frame
      try { res = await send(0); } catch {}
    }
    if (!res) throw new Error('Can’t reach the video tab. Keep it open on the video page (reload it once if the extension was installed after it was opened).');
  }
  if (!res) throw new Error('The video tab didn’t answer. Reload it so Stream Saver can attach.');
  if (res.error) throw new Error('In video tab: ' + res.error);
  if (res.status >= 400) throw new HttpError(res.status, url);
  return { data: b64dec(res.b64), contentRange: res.contentRange, status: res.status };
}

const fetcher = createFetcher({ ext: extReq, page: SRC_TAB == null ? null : pageReq, getMaster: () => MASTER, log, sleep });
const { req, get } = fetcher;

/* --------------------------------- helpers --------------------------------- */
async function pool(n, items, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length && !stopFlag) {
      const k = next++;
      await worker(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

async function save(chunks, filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const types = { ts: 'video/mp2t', mp4: 'video/mp4', webm: 'video/webm', m4a: 'audio/mp4' };
  const blob = new Blob(chunks, { type: types[ext] || 'application/octet-stream' });
  const it = await downloadBlob(blob, { filename, conflictAction: 'uniquify', saveAs: false });
  // Chrome may have renamed it ("Title (1).mp4"); report the real name so the ffmpeg hints are right.
  const name = (it && it.filename && it.filename.split(/[\\/]/).pop()) || filename;
  log(`✔ Saved ${name} — ${fmt(blob.size)}`, 'ok');
  return name;
}

function addSelect(label, options, withNone) {
  const wrap = document.createElement('label');
  wrap.append(label);
  const sel = document.createElement('select');
  if (withNone) sel.add(new Option('— none —', '-1'));
  options.forEach((o, i) => sel.add(new Option(o, String(i))));
  if (options.length) sel.value = '0';
  wrap.append(sel);
  $('#controls').append(wrap);
  return sel;
}

function mergeHint(files) {
  const [v, a] = files;
  log('To merge video + audio into one file:');
  log(ffmpegCommand([v, a], `${TITLE}.merged.mp4`, isWin()), 'cmd');
}

/* ------------------------------ direct file ------------------------------ */
async function filePrepare() {
  const why = P.get('why');
  log(`Direct file${why ? ` (the browser download failed: ${why})` : ''}. It will be fetched in 8 MB chunks with the page’s headers.`);
  const ext = P.get('ext') || 'mp4';
  return async () => {
    const CH = 8 << 20;
    const chunks = [];
    let off = 0;
    let total = 0;
    while (!stopFlag) {
      const r = await req(MASTER, [off, off + CH - 1]);
      chunks.push(r.data);
      off += r.data.byteLength;
      prog.done++;
      prog.bytes = off;
      if (r.status === 200) break; // server ignored Range and sent the whole file
      const m = /\/(\d+)\s*$/.exec(r.contentRange || '');
      if (m) total = +m[1];
      if (total) prog.total = Math.ceil(total / CH);
      tick();
      if ((total && off >= total) || r.data.byteLength < CH) break;
    }
    tick();
    if (!chunks.length) throw new Error('Nothing downloaded');
    await save(chunks, `${TITLE}.${ext}`);
  };
}

/* ---------------------------------- HLS ---------------------------------- */
function attrs(s) {
  const o = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) o[m[1]] = m[2].replace(/^"|"$/g, '');
  return o;
}
function parseBR(s, prevEnd) {
  const [len, off] = s.split('@').map(Number);
  const start = Number.isFinite(off) ? off : prevEnd;
  return [start, start + len - 1];
}

function parseM3U8(text, base) {
  if (!/^\s*#EXTM3U/.test(text)) throw new Error('Not an M3U8 playlist (the server may have returned an error page)');
  const res = { variants: [], media: [], segments: [], end: false, vod: false, seq: 0, target: 6, sessionKeys: [] };
  let inf = null, sv = null, key = null, map = null, br = null, nextOff = 0, n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (!l.startsWith('#')) {
      const uri = new URL(l, base).href;
      if (sv) {
        res.variants.push({ ...sv, uri });
        sv = null;
      } else {
        res.segments.push({ uri, dur: inf || 0, key, map, br, seq: res.seq + n++ });
        inf = null;
        br = null;
      }
      continue;
    }
    const c = l.indexOf(':');
    const tag = c < 0 ? l : l.slice(0, c);
    const rest = c < 0 ? '' : l.slice(c + 1);
    switch (tag) {
      case '#EXT-X-STREAM-INF': sv = attrs(rest); break;
      case '#EXT-X-MEDIA': {
        const a = attrs(rest);
        if (a.URI) a.URI = new URL(a.URI, base).href;
        res.media.push(a);
        break;
      }
      case '#EXT-X-MEDIA-SEQUENCE': res.seq = +rest; break;
      case '#EXT-X-TARGETDURATION': res.target = +rest; break;
      case '#EXT-X-ENDLIST': res.end = true; break;
      case '#EXT-X-PLAYLIST-TYPE': res.vod = rest.trim() === 'VOD'; break;
      case '#EXTINF': inf = parseFloat(rest); break;
      case '#EXT-X-SESSION-KEY': res.sessionKeys.push(attrs(rest)); break;
      case '#EXT-X-KEY': {
        const a = attrs(rest);
        key = a.METHOD === 'NONE' ? null : {
          method: a.METHOD,
          uri: a.URI ? new URL(a.URI, base).href : null,
          iv: a.IV || null,
          fmt: a.KEYFORMAT || 'identity',
        };
        break;
      }
      case '#EXT-X-MAP': {
        const a = attrs(rest);
        map = { uri: new URL(a.URI, base).href, br: a.BYTERANGE ? parseBR(a.BYTERANGE, 0) : null, key };
        break;
      }
      case '#EXT-X-BYTERANGE': br = parseBR(rest, nextOff); nextOff = br[1] + 1; break;
    }
  }
  return res;
}

const isDRMKey = (k) => !!k && (k.method !== 'AES-128' || k.fmt !== 'identity' || !k.uri);
const isDRMAttrs = (a) =>
  (a.KEYFORMAT || 'identity') !== 'identity' || (a.METHOD && a.METHOD !== 'AES-128' && a.METHOD !== 'NONE');

function ivFor(k, seq) {
  const iv = new Uint8Array(16);
  if (k.iv) {
    const h = k.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(h.substr(i * 2, 2), 16);
  } else {
    new DataView(iv.buffer).setBigUint64(8, BigInt(seq));
  }
  return iv;
}

async function hlsPrepare() {
  const pl = parseM3U8(await get(MASTER, { type: 'text' }), MASTER);
  if (pl.sessionKeys.some(isDRMAttrs)) throw new DRMError();
  const exp = expiryOf(MASTER);
  if (exp) log(`Signed link, valid until ${clock(exp)}. If it expires mid-download, new links are fetched automatically (keep the video tab open).`);

  if (!pl.variants.length) {
    log(`Media playlist · ${pl.segments.length} segments${pl.end || pl.vod ? '' : ' · LIVE'}`);
    return async () => {
      const f = await hlsTrack({ uri: MASTER, parsed: pl }, '');
      if (f && f.endsWith('.ts')) tsHint(f);
    };
  }

  const vs = pl.variants
    .map((v) => ({ ...v, bw: +(v['AVERAGE-BANDWIDTH'] || v.BANDWIDTH || 0) }))
    .sort((a, b) => b.bw - a.bw);
  const sel = addSelect(
    'Quality',
    vs.map((v) =>
      [v.RESOLUTION || 'no resolution listed', (v.bw / 1e6).toFixed(2) + ' Mbps', v['FRAME-RATE'] ? v['FRAME-RATE'] + ' fps' : '', v.CODECS || '']
        .filter(Boolean)
        .join(' · ')
    )
  );
  const audios = pl.media.filter((m) => m.TYPE === 'AUDIO' && m.URI);
  log(`Master playlist · ${vs.length} variants${audios.length ? ` · ${audios.length} separate audio rendition(s)` : ''}`);

  return async () => {
    const v = vs[+sel.value];
    const group = audios.filter((a) => a['GROUP-ID'] === v.AUDIO);
    const a = group.find((x) => x.DEFAULT === 'YES') || group[0];
    if (a) log(`Audio rendition: ${a.NAME || a.LANGUAGE || a['GROUP-ID']}`);
    const files = await Promise.all([
      hlsTrack({ uri: v.uri, variantPath: pathKey(v.uri) }, ''),
      a ? hlsTrack({ uri: a.URI, variantPath: pathKey(a.URI) }, '.audio') : null,
    ]);
    if (files[0] && files[1]) mergeHint(files);
    else if (files[0] && files[0].endsWith('.ts')) tsHint(files[0]);
  };
}

function tsHint(f) {
  log('Optional: remux the .ts into .mp4 without re-encoding:');
  log(ffmpegCommand([f], f.replace(/\.ts$/, '.mp4'), isWin()), 'cmd');
}

async function hlsTrack(t, suffix) {
  // Load (or reload) this track's playlist; if its signed URL has expired, get a
  // freshly signed master from the video tab and re-resolve the same variant.
  const reloadPlaylist = async () => {
    try {
      return parseM3U8(await get(t.uri, { type: 'text' }), t.uri);
    } catch (e) {
      if (![401, 403, 410].includes(e.status)) throw e;
      if (t.variantPath) {
        MASTER = await ensureFresh(MASTER, 'master playlist', true);
        const m = parseM3U8(await get(MASTER, { type: 'text' }), MASTER);
        const all = [...m.variants, ...m.media.filter((x) => x.URI).map((x) => ({ uri: x.URI }))];
        const v = all.find((x) => pathKey(x.uri) === t.variantPath);
        if (!v) throw e;
        t.uri = v.uri;
      } else {
        t.uri = MASTER = await ensureFresh(t.uri, 'playlist', true);
      }
      return parseM3U8(await get(t.uri, { type: 'text' }), t.uri);
    }
  };

  let pl = t.parsed || (await reloadPlaylist());
  if (pl.variants.length) throw new Error('Expected a media playlist but got a master playlist');
  const live = !pl.end && !pl.vod;
  if (live) {
    prog.live = true;
    log(`Live stream${suffix ? ' (audio)' : ''}: recording until you press “Stop & save” or the stream ends.`);
  }

  const chunks = [];
  const keys = new Map();
  const inits = new Set();
  let lastSeq = -1;
  let fmp4 = false;
  const firstUri = (pl.segments[0] && pl.segments[0].uri) || '';

  // step 3: expired segment links → reload the playlist for fresh signed URLs.
  const freshBySeq = new Map();
  let refreshing = null;
  let lastRefresh = 0;
  const refresh = () => {
    if (!refreshing) {
      refreshing = (async () => {
        const wait = 10000 - (Date.now() - lastRefresh);
        if (wait > 0) await sleep(wait); // links just reloaded and still failed: wait, then reload again
        lastRefresh = Date.now();
        log('Segment links seem to have expired. Reloading the playlist to get fresh links…');
        const np = await reloadPlaylist();
        freshBySeq.clear(); // only the current window matters; keeps the map bounded
        for (const s of np.segments) freshBySeq.set(s.seq, s);
      })().finally(() => (refreshing = null));
    }
    return refreshing;
  };
  const fetchSeg = async (s) => {
    try {
      return await get(s.uri, { range: s.br });
    } catch (e) {
      if (![401, 403, 404, 410].includes(e.status)) throw e;
      await refresh().catch(() => {});
      const n = freshBySeq.get(s.seq);
      if (!n || n.uri === s.uri) throw e;
      s.uri = n.uri;
      s.br = n.br;
      if (n.key) s.key = n.key;
      return get(s.uri, { range: s.br });
    }
  };

  const keyFor = (uri) => {
    if (!keys.has(uri)) {
      keys.set(uri, get(uri).then((b) => {
        if (b.byteLength !== 16) throw new Error(`AES key is ${b.byteLength} bytes, expected 16 (the key server probably returned an error page; play the video in its tab and try again)`);
        return crypto.subtle.importKey('raw', b, 'AES-CBC', false, ['decrypt']);
      }).catch((e) => { keys.delete(uri); throw e; })); // don't cache a failure
    }
    return keys.get(uri);
  };
  const dec = async (data, k, seq) =>
    k ? new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(k, seq) }, await keyFor(k.uri), data)) : data;

  const batch = async (segs) => {
    for (const s of segs) {
      if (isDRMKey(s.key) || (s.map && isDRMKey(s.map.key))) throw new DRMError();
    }
    if (!live) prog.total += segs.length;
    tick();
    const out = new Array(segs.length);
    await pool(CONCURRENCY, segs, async (s, i) => {
      out[i] = await dec(await fetchSeg(s), s.key, s.seq);
      prog.done++;
      prog.bytes += out[i].byteLength;
      tick();
    });
    for (let i = 0; i < segs.length && out[i]; i++) {
      const m = segs[i].map;
      if (m) {
        const id = m.uri + '|' + m.br;
        if (!inits.has(id)) {
          inits.add(id);
          fmp4 = true;
          chunks.push(await dec(await get(m.uri, { range: m.br }), m.key, segs[i].seq));
        }
      }
      chunks.push(out[i]);
    }
  };

  if (!live) {
    await batch(pl.segments);
  } else {
    while (!stopFlag) {
      const fresh = pl.segments.filter((s) => s.seq > lastSeq);
      if (fresh.length) {
        await batch(fresh);
        lastSeq = fresh[fresh.length - 1].seq;
      }
      if (pl.end) break;
      await sleep(Math.max(1000, pl.target * 500));
      if (stopFlag) break;
      try {
        pl = await reloadPlaylist();
      } catch (e) {
        log('Playlist refresh failed: ' + e.message, 'err');
      }
    }
  }

  if (!chunks.length) {
    log('Nothing was downloaded for this track.', 'err');
    return null;
  }
  const u = firstUri.split('?')[0].toLowerCase();
  const ext = fmp4 || /\.(m4s|mp4|m4a|m4v|cmf[va])$/.test(u)
    ? (suffix ? 'm4a' : 'mp4')
    : /\.aac$/.test(u) ? 'aac' : /\.mp3$/.test(u) ? 'mp3' : 'ts';
  return save(chunks, `${TITLE}${suffix}.${ext}`);
}

/* ---------------------------------- DASH ---------------------------------- */
function isoDur(s) {
  const m = /P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?/.exec(s || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}
const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0];
const baseOf = (el, base) => {
  const b = kid(el, 'BaseURL');
  return b ? new URL(b.textContent.trim(), base).href : base;
};

function parseMPD(text, url) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== 'MPD') throw new Error('Not an MPD manifest (the server may have returned an error page)');
  if (doc.getElementsByTagNameNS('*', 'ContentProtection').length) throw new DRMError();
  if (mpd.getAttribute('type') === 'dynamic')
    throw new Error('Live DASH isn’t supported here. Use “Captured from player” in the popup while it plays.');

  const mpdBase = baseOf(mpd, url);
  const periods = kids(mpd, 'Period');
  if (periods.length > 1) log(`Note: ${periods.length} periods found; only the first is downloaded.`);
  const period = periods[0];
  if (!period) throw new Error('No Period in manifest');
  const pBase = baseOf(period, mpdBase);
  const pDur = isoDur(period.getAttribute('duration')) || isoDur(mpd.getAttribute('mediaPresentationDuration'));

  const reps = [];
  for (const as of kids(period, 'AdaptationSet')) {
    const aBase = baseOf(as, pBase);
    for (const rep of kids(as, 'Representation')) {
      const g = (n) => rep.getAttribute(n) ?? as.getAttribute(n);
      const mime = g('mimeType') || '';
      const type = as.getAttribute('contentType') || mime.split('/')[0];
      if (type !== 'video' && type !== 'audio') continue;
      reps.push({
        id: rep.getAttribute('id'), type, mime, codecs: g('codecs') || '',
        bw: +rep.getAttribute('bandwidth') || 0, w: g('width'), h: g('height'),
        lang: as.getAttribute('lang') || '', rep, as, period, pDur, base: baseOf(rep, aBase),
      });
    }
  }
  return reps;
}

function segmentsFor(r) {
  const tpls = [kid(r.period, 'SegmentTemplate'), kid(r.as, 'SegmentTemplate'), kid(r.rep, 'SegmentTemplate')].filter(Boolean);
  if (tpls.length) {
    const A = {};
    let timeline = null;
    for (const t of tpls) {
      for (const a of t.attributes) A[a.name] = a.value;
      timeline = kid(t, 'SegmentTimeline') || timeline;
    }
    if (!A.media) throw new Error('SegmentTemplate has no media attribute');
    const ts = +(A.timescale || 1);
    const start = +(A.startNumber ?? 1);
    if (!Number.isFinite(ts) || ts <= 0 || !Number.isSafeInteger(start) || start < 0) throw new Error('Invalid DASH timescale or start number');
    const fill = (s, num, time) =>
      s.replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$/g, (_, k, w) => {
        const v = String(k === 'RepresentationID' ? r.id : k === 'Number' ? num : k === 'Time' ? time : r.bw);
        return w ? v.padStart(+w, '0') : v;
      }).replace(/\$\$/g, '$');
    const init = A.initialization ? { uri: new URL(fill(A.initialization, start, 0), r.base).href } : null;
    const segs = [];
    if (timeline) {
      let t = 0, num = start;
      const end = r.pDur ? r.pDur * ts + +(A.presentationTimeOffset || 0) : Infinity;
      for (const S of kids(timeline, 'S')) {
        if (S.hasAttribute('t')) t = +S.getAttribute('t');
        const d = +S.getAttribute('d');
        if (!Number.isFinite(t) || t < 0 || !Number.isFinite(d) || d <= 0) throw new Error('Invalid DASH timeline duration or time');
        let rep = +(S.getAttribute('r') || 0);
        if (!Number.isSafeInteger(rep) || rep < -1) throw new Error('Invalid DASH timeline repeat');
        if (rep < 0) {
          if (!Number.isFinite(end)) throw new Error('Open-ended SegmentTimeline without a duration');
          rep = Math.ceil((end - t) / d) - 1;
        }
        segmentCount(segs.length + segmentCount(rep + 1));
        for (let i = 0; i <= rep; i++) {
          segs.push({ uri: new URL(fill(A.media, num++, t), r.base).href });
          t += d;
        }
      }
    } else {
      const d = +A.duration;
      if (!Number.isFinite(d) || d <= 0) throw new Error('Invalid DASH segment duration');
      const count = segmentCount(Math.ceil((r.pDur * ts) / d));
      for (let i = 0; i < count; i++) segs.push({ uri: new URL(fill(A.media, start + i, i * d), r.base).href });
    }
    return { init, segs };
  }

  const sl = kid(r.rep, 'SegmentList') || kid(r.as, 'SegmentList');
  if (sl) {
    const rng = (s) => (s ? s.split('-').map(Number) : null);
    const ini = kid(sl, 'Initialization');
    const init = ini ? { uri: new URL(ini.getAttribute('sourceURL') || '', r.base).href, br: rng(ini.getAttribute('range')) } : null;
    const segs = kids(sl, 'SegmentURL').map((s) => ({
      uri: new URL(s.getAttribute('media') || '', r.base).href,
      br: rng(s.getAttribute('mediaRange')),
    }));
    return { init, segs };
  }

  return { init: null, segs: [{ uri: r.base }] };
}

async function dashPrepare() {
  const reps = parseMPD(await get(MASTER, { type: 'text' }), MASTER);
  const V = reps.filter((r) => r.type === 'video').sort((a, b) => b.bw - a.bw);
  const A = reps.filter((r) => r.type === 'audio').sort((a, b) => b.bw - a.bw);
  if (!V.length && !A.length) throw new Error('No audio or video representations found');
  const vs = V.length ? addSelect('Video', V.map((r) => `${r.w || '?'}×${r.h || '?'} · ${(r.bw / 1e6).toFixed(2)} Mbps · ${r.codecs}`), true) : null;
  const as = A.length ? addSelect('Audio', A.map((r) => `${r.lang ? r.lang + ' · ' : ''}${(r.bw / 1e3).toFixed(0)} kbps · ${r.codecs}`), true) : null;
  log(`DASH manifest · ${V.length} video / ${A.length} audio representations`);

  return async () => {
    const picks = [];
    if (vs && vs.value !== '-1') picks.push([V[+vs.value], '']);
    if (as && as.value !== '-1') picks.push([A[+as.value], picks.length ? '.audio' : '']);
    if (!picks.length) throw new Error('Pick at least one track');
    const files = (await Promise.all(picks.map(([r, sfx]) => dashTrack(r, sfx)))).filter(Boolean);
    if (files.length === 2) mergeHint(files);
  };
}

async function dashTrack(r, sfx) {
  const { init, segs } = segmentsFor(r);
  prog.total += segs.length + (init ? 1 : 0);
  tick();
  let head = null;
  if (init) {
    head = await get(init.uri, { range: init.br });
    prog.done++;
    prog.bytes += head.byteLength;
    tick();
  }
  const out = new Array(segs.length);
  await pool(CONCURRENCY, segs, async (s, i) => {
    out[i] = await get(s.uri, { range: s.br });
    prog.done++;
    prog.bytes += out[i].byteLength;
    tick();
  });
  const chunks = head ? [head] : [];
  for (const c of out) {
    if (!c) break;
    chunks.push(c);
  }
  if (chunks.length <= (head ? 1 : 0)) {
    log('Nothing was downloaded for this track.', 'err');
    return null;
  }
  const ext = /webm/.test(r.mime) ? 'webm' : r.type === 'audio' ? 'm4a' : 'mp4';
  return save(chunks, `${TITLE}${sfx}.${ext}`);
}

/* ---------------------------------- main ---------------------------------- */
(async () => {
  $('#title').textContent = TITLE;
  $('#src').textContent = SRC || '';
  if (!SRC) return fail(new Error('No URL given'));
  try {
    await setupHeaders();
    MASTER = await ensureFresh(SRC, 'stream');
    const job = KIND === 'dash' ? await dashPrepare() : KIND === 'file' ? await filePrepare() : await hlsPrepare();
    const start = async () => {
      $('#start').disabled = true;
      $('#stop').disabled = false;
      for (const s of document.querySelectorAll('#controls select')) s.disabled = true;
      try {
        await job();
        log('Done.', 'ok');
      } catch (e) {
        fail(e);
      } finally {
        $('#stop').disabled = true;
        prog.live = false;
        tick();
      }
    };
    $('#start').disabled = false;
    $('#start').onclick = start;
    $('#stop').onclick = () => {
      stopFlag = true;
      $('#stop').disabled = true;
      log('Stopping. Saving what has been downloaded…');
    };
    if (KIND === 'file') start();
  } catch (e) {
    fail(e);
  }
})();

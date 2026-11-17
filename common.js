'use strict';
// Shared by popup.js and downloader.js (loaded first via <script>).
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) =>
  !n ? '' : n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' KB';
const safe = (s) =>
  (s || 'video').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'video';

// Windows commands target PowerShell, not cmd.exe. Keep every argument literal
// and single-line; file-name sanitizing alone is not shell quoting.
const shellQuote = (s, win) => {
  const value = String(s).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '');
  // PowerShell also recognizes Unicode smart apostrophes as delimiters.
  return "'" + (win ? value.replace(/['\u2018-\u201b]/g, '$&$&') : value.replace(/'/g, "'\\''")) + "'";
};
const isWin = () => /win/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform);
function ffmpegCommand(files, output, win) {
  return ['ffmpeg', ...files.flatMap((f) => ['-i', shellQuote(f, win)]), '-c', 'copy', shellQuote(output, win)].join(' ');
}

function httpUrl(value) {
  if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const u = new URL(value);
    return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u : null;
  } catch { return null; }
}

// Serialize read/modify/write work for one key and release settled closures.
function queueTask(queues, key, fn) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  queues.set(key, next);
  const done = () => { if (queues.get(key) === next) queues.delete(key); };
  next.then(done, done);
  return next;
}

// HLS AES-128 (RFC 8216) is AES-CBC with PKCS#7 padding, and WebCrypto always
// strips that padding. Some packagers emit the same CBC blocks without it, which
// makes WebCrypto reject the final block. Retry with one appended ciphertext block
// whose plaintext is a full pad block: decryption then succeeds and the unpad step
// consumes only that synthetic block, leaving the real plaintext intact.
async function aesCbcDecrypt(key, iv, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, bytes));
  } catch (e) {
    if (e.name !== 'OperationError' || !bytes.length || bytes.length % 16) throw e;
    // C' = AES(lastBlock XOR pad16); CBC chaining makes lastBlock the IV.
    const pad = new Uint8Array(16).fill(16);
    const last = bytes.subarray(bytes.length - 16);
    const extra = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CBC', iv: last }, key, pad)
    ).subarray(0, 16);
    const joined = new Uint8Array(bytes.length + 16);
    joined.set(bytes);
    joined.set(extra, bytes.length);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, joined));
  }
}

function segmentCount(value) {
  // A corrupt timeline must not create an infinite loop or an enormous array.
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1e6) throw new Error('Invalid or excessive DASH segment count');
  return value;
}

// MAIN-world state is untrusted: a page can forge postMessage events. Copy only
// bounded metadata; never let malformed arrays break the background or popup.
function mediaState(value) {
  if (!value || typeof value.eme !== 'boolean') return null;
  const valid = (xs, text, fields) => Array.isArray(xs) && xs.length <= 1024 && xs.every((x) =>
    x && typeof x[text] === 'string' && x[text].length <= 256 &&
    fields.every((k) => Number.isSafeInteger(x[k]) && x[k] >= 0));
  if (!valid(value.tracks, 'mime', ['id', 'bytes', 'chunks']) || !valid(value.blobs, 'type', ['id', 'size'])) return null;
  return {
    eme: value.eme,
    tracks: value.tracks.map(({id, mime, bytes, chunks}) => ({id, mime, bytes, chunks})),
    blobs: value.blobs.map(({id, type, size}) => ({id, type, size})),
  };
}

// Keep a Blob alive until the browser finishes reading it. Register before
// starting, then search once to cover a completion before download() returns.
async function downloadBlob(blob, options, downloads = chrome.downloads, urls = URL, lifecycle = globalThis) {
  const url = urls.createObjectURL(blob);
  let id, released = false;
  const release = () => {
    if (released) return;
    released = true;
    downloads.onChanged.removeListener(changed);
    lifecycle.removeEventListener('pagehide', release);
    urls.revokeObjectURL(url);
  };
  const changed = (c) => {
    if (c.id === id && c.state && c.state.current !== 'in_progress') release();
  };
  downloads.onChanged.addListener(changed);
  lifecycle.addEventListener('pagehide', release, { once: true });
  try {
    id = await downloads.download({ ...options, url });
    const [item] = await downloads.search({ id });
    if (!item || item.state !== 'in_progress') release();
    return { id, filename: item && item.filename };
  } catch (e) {
    release();
    throw e;
  }
}
// Expiry of a signed URL in ms (CloudFront "Expires", Akamai/Bunny "exp"/"expires", …), or 0.
function expiryOf(u) {
  try {
    const sp = new URL(u).searchParams;
    for (const k of ['Expires', 'expires', 'exp', 'Expiry', 'expiry', 'e']) {
      const v = sp.get(k);
      if (v && /^\d{10}$/.test(v)) return +v * 1000;
    }
  } catch {}
  return 0;
}

// chrome.runtime message tags (popup / background / bridge / downloader). One place to spell them.
const MSG = {
  MSE_STATE: 'mse-state', MSE_CMD: 'mse-cmd', PAGE_FETCH: 'page-fetch',
  DOM_MEDIA: 'dom-media', CLEAR: 'clear', DIRECT_DOWNLOAD: 'direct-download',
};

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
  return "'" + value.replace(/'/g, win ? "''" : "'\\''") + "'";
};
const isWin = () => /win/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform);
function ffmpegCommand(files, output, win) {
  return ['ffmpeg', ...files.flatMap((f) => ['-i', shellQuote(f, win)]), '-c', 'copy', shellQuote(output, win)].join(' ');
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

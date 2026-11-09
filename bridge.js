// Stream Saver — isolated-world bridge.
// 1) Relays MSE capture state from inject.js to the extension.
// 2) "Page fetch": downloads a URL from inside the video page/frame, so the request
//    carries the page's own Origin, Referer, cookies and session — exactly like the
//    player's. Used when the server answers 403 to direct requests.
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__mdl !== 'state') return;
  const state = mediaState(e.data.state);
  if (!state) return;
  // After the extension reloads, this orphaned script throws synchronously ("context invalidated").
  try { chrome.runtime.sendMessage({ type: MSG.MSE_STATE, state }).catch(() => {}); } catch {}
});

// Plain <video>/<audio> files the network sniffer can miss (cache, service worker, odd content types).
document.addEventListener('loadedmetadata', (e) => {
  const el = e.target, u = el && el.currentSrc;
  if (!/^https?:/.test(u || '') || /m3u8|\.mpd(\?|$)/i.test(u)) return;
  try { chrome.runtime.sendMessage({ type: MSG.DOM_MEDIA, url: u, tag: el.localName }).catch(() => {}); } catch {}
}, true);

function toB64(u8) {
  if (u8.toBase64) return u8.toBase64();
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

async function pageFetch({ url, range }) {
  if (!httpUrl(url)) throw new Error('Invalid media URL (expected HTTP or HTTPS)');
  const headers = range ? { Range: `bytes=${range[0]}-${range[1]}` } : {};
  let r;
  try {
    r = await fetch(url, { headers, credentials: 'include', cache: 'no-store' });
  } catch {
    // A CDN answering "Access-Control-Allow-Origin: *" rejects credentialed requests.
    r = await fetch(url, { headers, credentials: 'omit', cache: 'no-store' });
  }
  if (!r.ok) return { status: r.status };
  const buf = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, contentRange: r.headers.get('content-range'), b64: toB64(buf) };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === MSG.MSE_CMD) {
    if (!['save-track', 'save-blob', 'turbo', 'reset'].includes(msg.cmd)) return;
    window.postMessage({ ...(msg.args || {}), __mdlCmd: msg.cmd }, '*');
    return;
  }
  if (msg.type === MSG.PAGE_FETCH) {
    pageFetch(msg).then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
    return true;
  }
});

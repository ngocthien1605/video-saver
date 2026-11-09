'use strict';
// The per-tab record of captured media: { items: {url → item}, mse: {frameId → state} }.
// Only this file knows the storage key and shape. `store` is injectable (tests pass a fake).

const tabKey = (id) => `tab_${id}`;
const emptyTab = () => ({ items: {}, mse: {} });

// Drive/YouTube-style players fetch one URL in many ranges; drop the range params so they merge into one item.
function cleanUrl(u) {
  u = u.split('#')[0];
  if (!/\/videoplayback/.test(u)) return u;
  try { const x = new URL(u); for (const k of ['range', 'rn', 'rbuf']) x.searchParams.delete(k); return x.href; } catch { return u; }
}

async function readTab(id, store = chrome.storage.session) {
  return (await store.get(tabKey(id)))[tabKey(id)] || emptyTab();
}
const writeTab = (id, d, store = chrome.storage.session) => store.set({ [tabKey(id)]: d });
const removeTab = (id, store = chrome.storage.session) => store.remove(tabKey(id));
// Look an item up by any spelling of its URL.
const itemFor = (d, url) => d.items[cleanUrl(url)] || d.items[url];

const pathKey = (u) => {
  try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; }
};

// Prefer longest validity, then latest capture. Unknown expiry sorts as zero;
// do not replace a known later expiry just because a shorter link arrived last.
function freshestCapture(items, url) {
  const key = pathKey(url);
  let best = null;
  for (const it of Object.values(items)) {
    if (it.url === url || pathKey(it.url) !== key) continue;
    const exp = expiryOf(it.url), prev = best ? expiryOf(best.url) : -1;
    if (!best || exp > prev || (exp === prev && (it.t || 0) > (best.t || 0))) best = it;
  }
  return best;
}

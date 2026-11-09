'use strict';
// Replay a captured request's headers: used by background (browser downloads),
// downloader (segment fetches) and popup (yt-dlp command).

// Referer from the capture (or the page / a fallback); Origin derived from it, because
// Chrome would otherwise send "Origin: chrome-extension://…", which many CDNs reject.
function replayHeaders(item, fallbackReferer = '') {
  const hdr = { ...((item && item.hdr) || {}) };
  const referer = hdr.referer || (item && item.page ? item.page.replace(/\/?$/, '/') : '') || fallbackReferer;
  if (referer) hdr.referer = referer;
  if (!hdr.origin && referer) try { hdr.origin = new URL(referer).origin; } catch {}
  return hdr;
}

// declarativeNetRequest rules for those headers on requests from `tabId`.
// Cookie/Authorization only ever go to `host`. Other headers go to `host` too, unless anyHost.
function replayRules(hdr, { tabId, host, origin, anyHost = false }) {
  const parsed = httpUrl(origin || ('https://' + host + '/'));
  if (!host || !parsed || parsed.hostname !== host) return [];
  const escape = (s) => s.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
  // requestDomains includes subdomains. Anchor the exact origin as well, so a
  // redirect/subdomain, different port or HTTPS downgrade cannot receive auth.
  const exactOrigin = '^' + escape(parsed.origin) + '/';
  const general = [], scoped = [];
  for (const [header, value] of Object.entries(hdr)) {
    // Unknown headers may contain secrets (e.g. X-API-Key); scope them too.
    const publicHeader = /^(referer|origin|user-agent)$/.test(header.toLowerCase());
    ((anyHost && publicHeader) ? general : scoped).push({ header, operation: 'set', value });
  }
  const rule = (priority, requestHeaders, scopedToHost) => ({
    id: 1 + Math.floor(Math.random() * 2e9),
    priority,
    action: { type: 'modifyHeaders', requestHeaders },
    condition: { tabIds: [tabId], ...(scopedToHost && { regexFilter: exactOrigin }) },
  });
  const rules = [];
  if (general.length) rules.push(rule(1, general, false));
  if (scoped.length && host) rules.push(rule(2, scoped, true));
  return rules;
}

async function installRules(rules) {
  if (rules.length) await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
  return rules.map((r) => r.id);
}
// Let callers retain their ownership record and retry cleanup if Chrome fails.
const removeRules = (ids) => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });

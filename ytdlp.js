'use strict';
// Builds yt-dlp commands using common.js's PowerShell / POSIX argument quoting.

// A captured stream: replays the page's headers + exported cookies file.
function ytdlpStreamCommand({ item, tabUrl, title, ua, cookiePath, win }) {
  const q = (s) => shellQuote(s, win);
  const h = replayHeaders(item, tabUrl);
  const parts = ['yt-dlp'];
  if (h.referer) parts.push('--referer', q(h.referer));
  if (h.origin) parts.push('--add-header', q('Origin:' + h.origin));
  parts.push('--user-agent', q(h['user-agent'] || ua));
  for (const [k, v] of Object.entries(h)) {
    if (!['referer', 'origin', 'user-agent', 'cookie'].includes(k)) parts.push('--add-header', q(`${k}:${v}`));
  }
  if (cookiePath) parts.push('--cookies', q(cookiePath));
  parts.push('-N', '8', '-o', q(safe(title).replace(/%/g, '%%') + '.%(ext)s'), q(item.url));
  return parts.join(' ');
}

// A page on a site yt-dlp supports (see SITES in popup.js); audio=true gives MP3 instead of MP4.
function ytdlpPageCommand({ url, win, audio }) {
  const q = (s) => shellQuote(s, win);
  const fmtArgs = audio ? ['-x', '--audio-format', 'mp3'] : ['-f', q('bv*+ba/b'), '--merge-output-format', 'mp4'];
  return ['yt-dlp', '--cookies-from-browser', 'chrome', ...fmtArgs, '-o', q('%(title).150B.%(ext)s'), q(url)].join(' ');
}

// Dropbox / SharePoint file-share page -> direct-download URL (null for anything else, e.g. folders, home, http-less input).
// ponytail: query flag only; consumer OneDrive and 1drv.ms links need a redirect, so they are left to yt-dlp / the browser.
function shareDirectUrl(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (/(^|\.)dropbox\.com$/.test(u.hostname) && /^\/(s|scl\/fi|sh)\//.test(u.pathname)) u.searchParams.set('dl', '1');
  else if (/\.sharepoint\.com$/.test(u.hostname) && /^\/:\w:\//.test(u.pathname)) u.searchParams.set('download', '1');
  else return null;
  return u.href;
}

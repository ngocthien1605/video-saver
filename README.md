# Stream Saver

A local Chrome / Edge extension (Manifest V3) that finds video on the page you're watching and saves it.

## Fork and credit

This repository is a security and robustness fork of [camtonguyen/stream-saver](https://github.com/camtonguyen/stream-saver), based on commit `e7e69c58c41b6c8975b2026a5700c977305764cf`. The original author's Git history is preserved. Version 1.2.1 hardens command quoting, credential header scoping, input validation, signed-link selection and resource cleanup without adding dependencies, remote code or permissions.

## Install
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder. After code changes, press the ↻ button instead.
3. **Reload the video tab**, then press play. The extension only sees requests made after it loads.

## How to save a video
Click the extension icon while the video plays. What you see depends on the site:

| Row in the popup | What to do |
|---|---|
| **HLS / DASH** (`.m3u8`, `.mpd`) | Click **Open**, then **Start**. If there are several, pick the highest quality (e.g. `1080`). |
| **MP4 / WebM / audio** | Click **Download**. |
| **MSE / BLOB** (under *Captured from player*) | Last resort. Click **Turbo 16×** to buffer the video fast, then **Save**. Video and audio come as separate files. |
| **This page** (YouTube, Facebook, TikTok, X, Instagram, Xiaohongshu/RedNote) | Click **Copy yt-dlp command** and paste it into a terminal. |

Other buttons: **yt-dlp** copies a command with the page's headers and saves a `stream-saver-cookies.txt`. **Copy** copies the stream URL.

Terminal commands target **PowerShell on Windows (not cmd.exe)** and a **POSIX shell on macOS/Linux**, including the ffmpeg hints. Do not paste Windows commands into cmd.exe.

## Good to know
- HLS downloads are saved as `.ts`. Convert to MP4 without re-encoding:
  `ffmpeg -i in.ts -c copy out.mp4`
- Separate video and audio files (from MSE or DASH) merge the same way:
  `ffmpeg -i video.mp4 -i audio.m4a -c copy out.mp4`
- For YouTube and similar sites, install the tools first: `brew install yt-dlp ffmpeg`.
- The cookies file holds your login. Keep it private and delete it afterwards.

## Fixing 403 Forbidden
The extension already replays the page's Referer, cookies and headers, refreshes expired signed links, and falls back to fetching through the video tab. So:
- **Keep the video tab open** while downloading.
- With yt-dlp, run the command within a few minutes, on the same computer and network.
- Still 403? Use `pip install -U "yt-dlp[default,curl-cffi]"` and add `--impersonate chrome`.

## Supported
Progressive MP4 / WebM / audio, HLS (including AES-128 and live), static DASH, and blob/MSE buffers.

## Not supported
DRM (Widevine, PlayReady, FairPlay, SAMPLE-AES) is detected and refused. Geo-blocks, expired subscriptions and IP bans can't be fixed from the client.

Only download content you have the right to save.

## Security and lifecycle limits

- Browser header replay confines Cookie/Authorization and custom request headers to the original media origin (scheme, exact hostname and port). Only Referer, Origin and User-Agent may follow cross-host playlist requests for CDN compatibility. Sites requiring custom auth across different origins may need separate captures.
- Cookie export is explicit, contains login material and remains on disk until you delete it. Copied commands may contain credentials; keep clipboard and terminal history private.
- MAIN-world media controls use a page-visible message channel. Page scripts can observe or forge these media-only messages and access their own media buffers. A token sent on that channel would not authenticate the extension. Metadata and command input are validated, but this is not a security boundary against the page itself.
- The MV3 worker can lose volatile request headers while idle. Captures use session storage; persisted download/rule records are reconciled when the worker wakes. Normal completion, interruption, storage failure and tab closure clean up owned rules. Abrupt termination between installing a rule and recording ownership remains a browser-lifecycle limitation; session rules are cleared on browser shutdown.
- Downloads buffer media in memory. Large/live streams and retained player Blobs can consume substantial RAM. Corrupt DASH timelines are rejected, with a limit of one million generated segments.
- Host permissions remain broad so the extension can work on arbitrary video sites. Direct browser downloads share Chrome's tabId=-1 rules; overlapping downloads from the same origin with different logins should be avoided. These are existing design limits, not newly added permissions.

## Development
`node test.js` runs the tests (no dependencies). Shared code: `common.js` (helpers, message tags), `captures.js` (per-tab record), `replay.js` (header replay), `fetcher.js` (403 fallback), `ytdlp.js` (command builder).

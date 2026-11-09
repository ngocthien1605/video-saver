// Stream Saver — runs in the page's MAIN world at document_start.
// Hooks MediaSource/SourceBuffer to record the bytes a player appends, and
// URL.createObjectURL to remember media Blobs. If the page sets up EME (DRM),
// capture is switched off and recorded data is discarded.
(() => {
  if (window.__streamSaver) return;
  const S = (window.__streamSaver = { tracks: [], blobs: [], eme: false, timer: 0 });
  const sbMap = new WeakMap();
  const origCreateURL = URL.createObjectURL;

  const post = () => {
    if (S.timer) return; // throttle: at most one update per 300ms, so constant appends can't starve it
    S.timer = setTimeout(() => {
      S.timer = 0;
      window.postMessage(
        {
          __mdl: 'state',
          state: {
            eme: S.eme,
            tracks: S.tracks.map((t) => ({ id: t.id, mime: t.mime, bytes: t.bytes, chunks: t.chunks.length })),
            blobs: S.blobs.map((b) => ({ id: b.id, type: b.blob.type, size: b.blob.size })),
          },
        },
        '*'
      );
    }, 300);
  };

  const toU8 = (d) =>
    d instanceof ArrayBuffer
      ? new Uint8Array(d.slice(0))
      : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));

  // Init segments: MP4 'ftyp' box, or WebM EBML header.
  const isInit = (u8) =>
    (u8.length > 8 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) ||
    (u8.length > 4 && u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3);

  const hookMediaSource = (MS) => {
    if (!MS || !MS.prototype || !MS.prototype.addSourceBuffer) return;
    const orig = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function (mime) {
      const sb = orig.apply(this, arguments);
      const t = { id: S.tracks.length, mime: String(mime), chunks: [], bytes: 0 };
      S.tracks.push(t);
      sbMap.set(sb, t);
      post();
      return sb;
    };
  };
  hookMediaSource(window.MediaSource);
  hookMediaSource(window.ManagedMediaSource);

  if (window.SourceBuffer) {
    const origAppend = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
      const t = sbMap.get(this);
      // ponytail: stop recording past ~1 GB per page so long videos/livestreams can't exhaust memory; raise if needed.
      if (t && !S.eme && data && S.tracks.reduce((n, x) => n + x.bytes, 0) < 1e9) {
        try {
          const u8 = toU8(data);
          t.chunks.push(u8);
          t.bytes += u8.byteLength;
          post();
        } catch (e) {}
      }
      return origAppend.apply(this, arguments);
    };
  }

  // DRM detection: keys being attached to a media element, or an 'encrypted' event.
  const markEme = () => {
    if (S.eme) return;
    S.eme = true;
    for (const t of S.tracks) {
      t.chunks = [];
      t.bytes = 0;
    }
    post();
  };
  if (window.HTMLMediaElement && HTMLMediaElement.prototype.setMediaKeys) {
    const origSet = HTMLMediaElement.prototype.setMediaKeys;
    HTMLMediaElement.prototype.setMediaKeys = function (keys) {
      if (keys) markEme();
      return origSet.apply(this, arguments);
    };
  }
  document.addEventListener('encrypted', markEme, true);

  URL.createObjectURL = function (obj) {
    const url = origCreateURL.apply(this, arguments);
    try {
      if (obj instanceof Blob && /^(video|audio)\//i.test(obj.type)) {
        S.blobs.push({ id: S.blobs.length, blob: obj, url });
        post();
      }
    } catch (e) {}
    return url;
  };

  const extFor = (mime) => {
    const m = (mime || '').toLowerCase();
    if (m.includes('webm')) return 'webm';
    if (m.includes('mp2t')) return 'ts';
    if (m.includes('mpeg') && m.startsWith('audio')) return 'mp3';
    if (m.includes('aac')) return 'aac';
    if (m.startsWith('audio/mp4')) return 'm4a';
    if (m.includes('ogg')) return 'ogg';
    return 'mp4';
  };

  const saveBlob = (blob, name) => {
    const a = document.createElement('a');
    const u = origCreateURL.call(URL, blob);
    a.href = u;
    a.download = name;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(u);
      a.remove();
    }, 60000);
  };

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.__mdlCmd == null) return;
    // MAIN-world messages are observable/forgeable by the page. A token sent
    // over this same channel would not authenticate the extension. Validate
    // input, but do not treat these media-only controls as a security boundary.
    if (!['save-track', 'save-blob', 'turbo', 'reset'].includes(m.__mdlCmd)) return;
    if (m.name != null && typeof m.name !== 'string') return;
    if (m.__mdlCmd.startsWith('save-') && (!Number.isSafeInteger(m.id) || m.id < 0)) return;
    const base = (m.name || 'capture').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 100) || 'capture';

    if (m.__mdlCmd === 'save-track') {
      const t = S.tracks[m.id];
      if (!t || S.eme || !t.chunks.length) return;
      const kind = /^audio/i.test(t.mime) ? 'audio' : 'video';
      saveBlob(new Blob(t.chunks, { type: t.mime.split(';')[0] }), `${base}.${kind}${t.id}.${extFor(t.mime)}`);
    } else if (m.__mdlCmd === 'save-blob') {
      const b = S.blobs[m.id];
      if (b && !S.eme) saveBlob(b.blob, `${base}.${extFor(b.blob.type)}`);
    } else if (m.__mdlCmd === 'turbo') {
      for (const v of document.querySelectorAll('video, audio')) {
        v.muted = true;
        v.playbackRate = 16;
        v.play().catch(() => {});
      }
    } else if (m.__mdlCmd === 'reset') {
      // Keep the most recent init segment so later media segments stay playable.
      for (const t of S.tracks) {
        const init = [...t.chunks].reverse().find(isInit);
        t.chunks = init ? [init] : [];
        t.bytes = init ? init.byteLength : 0;
      }
      post();
    }
  });
})();

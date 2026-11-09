// Run: node test.js   (no framework; loads the extension's classic scripts into one shared context)
const assert = require('assert'), vm = require('vm'), fs = require('fs'), cp = require('child_process');
const ctx = vm.createContext({ console, URL, TextDecoder });
for (const f of ['common.js', 'captures.js', 'replay.js', 'fetcher.js', 'ytdlp.js']) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
const g = (n) => vm.runInContext(n, ctx);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --- replay (A)
test('replayHeaders derives Referer and Origin (browser downloads used to miss Origin)', () => {
  const h = g('replayHeaders')({ page: 'https://site.dev/course', hdr: { cookie: 'a=1' } });
  assert.equal(h.referer, 'https://site.dev/course/');
  assert.equal(h.origin, 'https://site.dev');
  assert.equal(h.cookie, 'a=1');
});
test('replayRules: cookie only to host; anyHost sends the rest everywhere', () => {
  const r = g('replayRules')({ cookie: 'a=1', referer: 'https://x/' }, { tabId: 7, host: 'cdn.x', anyHost: true });
  assert.equal(r.length, 2);
  const general = r.find((x) => x.priority === 1), scoped = r.find((x) => x.priority === 2);
  assert.deepEqual(general.condition, { tabIds: [7] });
  assert.deepEqual(scoped.condition, { tabIds: [7], requestDomains: ['cdn.x'] });
  assert.equal(scoped.action.requestHeaders[0].header, 'cookie');
  assert.equal(g('replayRules')({ referer: 'https://x/' }, { tabId: -1, host: 'cdn.x' })[0].condition.requestDomains[0], 'cdn.x');
});

// --- captures (C)
test('captures: cleanUrl merges range requests; store is fakeable', async () => {
  const cu = g('cleanUrl');
  assert.equal(cu('https://d/videoplayback?id=1&range=0-99&rn=3#x'), 'https://d/videoplayback?id=1');
  const mem = {}, store = { get: async (k) => ({ [k]: mem[k] }), set: async (o) => Object.assign(mem, o) };
  const d = await g('readTab')(5, store);
  d.items['https://d/videoplayback?id=1'] = { kind: 'mp4' };
  await g('writeTab')(5, d, store);
  const back = await g('readTab')(5, store);
  assert.ok(g('itemFor')(back, 'https://d/videoplayback?id=1&range=0-9'));
});

// --- fetcher (B)
const E = (status) => Object.assign(new Error('HTTP ' + status), { status });
const ok = (s) => ({ data: new TextEncoder().encode(s), status: 200 });
const mk = (ext, page) => g('createFetcher')({ ext, page, getMaster: () => 'https://h/m.m3u8?sig=1', log() {}, sleep: async () => {} });
test('fetcher: 403 on direct switches to the video tab and stays there', async () => {
  let ec = 0; const f = mk(async () => { ec++; throw E(403); }, async () => ok('hi'));
  assert.equal(await f.get('https://h/a', { type: 'text' }), 'hi');
  await f.get('https://h/b');
  assert.equal(ec, 1); assert.equal(f.mode, 'page');
});
test('fetcher: retries 5xx, gives up on 404', async () => {
  let n = 0; const f = mk(async () => { if (++n < 3) throw E(503); return ok('x'); }, null);
  await f.get('https://h/a'); assert.equal(n, 3);
  await assert.rejects(mk(async () => { throw E(404); }, null).get('https://h/a'), { status: 404 });
});
test('fetcher: inherits the manifest query after a 403', async () => {
  const seen = []; const f = mk(async (u) => { seen.push(u); if (!u.includes('sig=1')) throw E(403); return ok('s'); }, null);
  await f.get('https://h/seg1.ts'); await f.get('https://h/seg2.ts');
  assert.deepEqual(seen, ['https://h/seg1.ts', 'https://h/seg1.ts?sig=1', 'https://h/seg2.ts?sig=1']);
});

// --- yt-dlp (D)
test('ytdlp: page URL can not inject shell code', () => {
  const c = g('ytdlpPageCommand')({ url: "https://y.com/watch?v=$(touch pwn)`id`'", win: false });
  assert.ok(c.includes("'https://y.com/watch?v=$(touch pwn)`id`'\\'''"), c);
});
test('ytdlp: audio flag and share links', () => {
  assert.ok(g('ytdlpPageCommand')({ url: 'https://v.com/1', win: false, audio: true }).includes('-x --audio-format mp3'));
  assert.equal(g('shareDirectUrl')('https://www.dropbox.com/s/a/f.mp4?dl=0'), 'https://www.dropbox.com/s/a/f.mp4?dl=1');
  assert.ok(g('shareDirectUrl')('https://x.sharepoint.com/:v:/s/t/abc').endsWith('download=1'));
  const s = g('shareDirectUrl');
  assert.equal(s('https://youtube.com/watch'), null);
  assert.equal(s('https://www.dropbox.com/home'), null);
  assert.equal(s('https://x.sharepoint.com/sites/team'), null);
  assert.equal(s('javascript:alert(1)'), null);
  assert.equal(s('nope'), null);
  assert.equal(s('https://www.dropbox.com/scl/fi/a/f.mp4?rlkey=k&dl=0#x'), 'https://www.dropbox.com/scl/fi/a/f.mp4?rlkey=k&dl=1#x');
});
test('ytdlp: stream command carries referer/origin/cookies', () => {
  const c = g('ytdlpStreamCommand')({ item: { url: 'https://cdn/x.m3u8', page: 'https://s.dev/p', hdr: {} }, tabUrl: '', title: 'T/1', ua: 'UA', cookiePath: '/c.txt', win: false });
  assert.ok(c.includes("--referer 'https://s.dev/p/'") && c.includes("'Origin:https://s.dev'") && c.includes("--cookies '/c.txt'") && c.includes("'T 1.%(ext)s'"), c);
});

test('ytdlp: % in the title is escaped for the -o template', () => {
  const c = g('ytdlpStreamCommand')({ item: { url: 'https://c/x' }, tabUrl: '', title: '100% Real', ua: 'UA', win: false });
  assert.ok(c.includes("'100%% Real.%(ext)s'"), c);
});

test('quoting: PowerShell and POSIX preserve payloads as single literal arguments', () => {
  const payloads = ['$(calc)', '`id`', '& calc', '"; calc; "', "'", '%PATH%', '$var', 'a\nb\rc\u0000d\u007fe\u0085f\u2028g'];
  const quote = g('shellQuote');
  for (const p of payloads) {
    const stripped = p.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '');
    assert.equal(quote(p, true), "'" + stripped.replace(/'/g, "''") + "'");
    assert.equal(quote(p, false), "'" + stripped.replace(/'/g, "'\\''") + "'");
    for (const win of [true, false]) {
      const c = g('ytdlpStreamCommand')({ item: { url: p, hdr: { 'x-token': p } }, tabUrl: '', title: p, ua: p, cookiePath: p, win });
      assert.ok(c.includes(quote(p, win)) && c.includes(quote('x-token:' + p, win)), c);
      assert.ok(!/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(c), c);
      assert.ok(g('ytdlpPageCommand')({url: p, win}).endsWith(quote(p, win)));
    }
  }
});
test('ffmpeg hints quote every input and output with the selected shell', () => {
  const input = "a' $(calc) `id` & %PATH%\n.ts", output = '$(calc).mp4';
  for (const win of [true, false]) {
    const q = (s) => g('shellQuote')(s, win);
    assert.equal(g('ffmpegCommand')([input, 'audio.m4a'], output, win), `ffmpeg -i ${q(input)} -i ${q('audio.m4a')} -c copy ${q(output)}`);
  }
});

test('httpUrl rejects malformed and non-network inputs without throwing', () => {
  const url = g('httpUrl');
  for (const value of [null, undefined, {}, '', 'nope', '/relative', 'javascript:alert(1)', 'file:///a', 'https://a/\nb', 'https://u:p@a/']) assert.equal(url(value), null);
  assert.equal(url('https://media.example/a.mp4?x=1').hostname, 'media.example');
  assert.equal(url('http://localhost:8000/v').origin, 'http://localhost:8000');
});
test('mediaState rejects forged malformed state and copies only valid metadata', () => {
  const normalize = g('mediaState');
  for (const value of [null, {}, {eme: false, tracks: {}, blobs: []}, {eme: false, tracks: [{id:0}], blobs: []}]) assert.equal(normalize(value), null);
  const input = {eme: true, tracks: [{id:0, mime:'video/mp4', bytes:5, chunks:1, extra:'ignored'}], blobs:[]};
  const state = normalize(input);
  assert.equal(state.eme, true);
  assert.equal(state.tracks[0].extra, undefined);
  input.tracks[0].bytes = 999;
  assert.equal(state.tracks[0].bytes, 5);
  assert.equal(normalize({eme:false, tracks:[], blobs: new Array(1025).fill({id:0,type:'video/mp4',size:1})}), null);
});

test('freshestCapture orders by expiry first, timestamp only on ties', () => {
  const find = g('freshestCapture'), base = 'https://cdn.example/v.m3u8';
  const later = {url:base+'?Expires=2000000000&sig=a', t:1};
  const newer = {url:base+'?Expires=1900000000&sig=b', t:100};
  const tie = {url:base+'?Expires=2000000000&sig=c', t:2};
  const unknown = {url:base+'?sig=d', t:200};
  for (const values of [[later,newer,unknown], [unknown,newer,later]]) assert.equal(find(values, base), later);
  assert.equal(find([later,tie], base), tie);
  assert.equal(find([tie,later], base), tie);
  assert.equal(find([tie], tie.url), null);
  assert.equal(find([{url:'https://other.example/v.m3u8',t:999}], base), null);
});

test('fetcher query inheritance preserves fragments and never crosses origin', async () => {
  const seen = [];
  const f = mk(async (u) => { seen.push(u); if (!new URL(u).search) throw E(403); return ok('s'); }, null);
  await f.get('https://h/seg.ts#part');
  assert.deepEqual(seen, ['https://h/seg.ts#part', 'https://h/seg.ts?sig=1#part']);
  for (const url of ['http://h/seg.ts','https://other/seg.ts','https://h:444/seg.ts']) {
    seen.length = 0;
    await assert.rejects(f.get(url), {status:403});
    assert.deepEqual(seen, [url]);
  }
});

// --- all files parse
test('all scripts pass node --check', () => {
  for (const f of fs.readdirSync('.').filter((x) => x.endsWith('.js') && x !== 'test.js')) cp.execFileSync('node', ['--check', f]);
});

(async () => {
  let bad = 0;
  for (const [n, fn] of tests) {
    try { await fn(); console.log('ok  ', n); } catch (e) { bad++; console.log('FAIL', n, '\n    ', e.message); }
  }
  process.exit(bad ? 1 : 0);
})();

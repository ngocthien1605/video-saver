// Run: node test.js   (no framework; loads the extension's classic scripts into one shared context)
const assert = require('assert'), vm = require('vm'), fs = require('fs'), cp = require('child_process');
const nodeCrypto = require('crypto');
const ctx = vm.createContext({ console, URL, TextDecoder, crypto: nodeCrypto.webcrypto });
for (const f of ['common.js', 'captures.js', 'replay.js', 'fetcher.js', 'ytdlp.js']) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
const g = (n) => vm.runInContext(n, ctx);
// downloader.js needs a DOM and chrome APIs, so only its pure parser helpers are
// loaded here. They are shared by the DASH and HLS tests below.
const downloaderSource = fs.readFileSync('downloader.js', 'utf8');
const sliceBetween = (start, end) => downloaderSource.slice(downloaderSource.indexOf(start), downloaderSource.indexOf(end));
vm.runInContext(
  sliceBetween('function attrs(', 'async function hlsPrepare') +
    sliceBetween('function isoDur(', 'function parseMPD') +
    sliceBetween('function segmentsFor(', 'async function dashPrepare'),
  ctx,
  { filename: 'downloader.js#parsers' },
);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --- replay (A)
test('replayHeaders derives Referer and Origin (browser downloads used to miss Origin)', () => {
  const h = g('replayHeaders')({ page: 'https://site.dev/course', hdr: { cookie: 'a=1' } });
  assert.equal(h.referer, 'https://site.dev/course/');
  assert.equal(h.origin, 'https://site.dev');
  assert.equal(h.cookie, 'a=1');
});
test('replayRules: credentials stay on exact origin; public headers may follow media', () => {
  const r = g('replayRules')({ cookie: 'a=1', referer: 'https://x/' }, { tabId: 7, host: 'cdn.x', anyHost: true });
  assert.equal(r.length, 2);
  const general = r.find((x) => x.priority === 1), scoped = r.find((x) => x.priority === 2);
  assert.deepEqual(general.condition, { tabIds: [7] });
  assert.deepEqual(scoped.condition, { tabIds: [7], regexFilter: '^https://cdn\\.x/' });
  assert.equal(scoped.action.requestHeaders[0].header, 'cookie');
  assert.equal(g('replayRules')({ referer: 'https://x/' }, { tabId: -1, host: 'cdn.x' })[0].condition.regexFilter, '^https://cdn\\.x/');
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
    assert.equal(quote(p, true), "'" + stripped.replace(/['\u2018-\u201b]/g, '$&$&') + "'");
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

test('replayRules confines custom secrets, subdomains, ports and scheme changes', () => {
  const rules = g('replayRules')({cookie:'c=1', authorization:'Bearer fake', 'x-api-key':'fake', 'X-Token':'fake', referer:'https://page/'},
    {tabId:7, host:'media.example', origin:'https://media.example:8443', anyHost:true});
  const secretRule = rules.find(r => r.priority === 2);
  assert.deepEqual(Array.from(secretRule.action.requestHeaders, h => h.header), ['cookie','authorization','x-api-key','X-Token']);
  const matches = new RegExp(secretRule.condition.regexFilter);
  assert.ok(matches.test('https://media.example:8443/v.ts'));
  for (const url of ['https://sub.media.example:8443/v.ts','http://media.example:8443/v.ts','https://media.example/v.ts','https://media.example:8443.evil/v.ts','https://evil/v.ts']) assert.ok(!matches.test(url), url);
  assert.equal(g('replayRules')({cookie:'c=1'}, {tabId:7}).length, 0);
  assert.equal(g('replayRules')({cookie:'c=1'}, {tabId:7,host:'media.example',origin:'https://evil/'}).length, 0);
});

test('downloadBlob revokes on finish, interruption, API failure and page exit', async () => {
  for (const mode of ['complete', 'interrupted', 'early', 'reject', 'search-error', 'pagehide']) {
    const listeners = new Set(), exits = new Set(), revoked = [];
    const downloads = {
      onChanged: {addListener: f => listeners.add(f), removeListener: f => listeners.delete(f)},
      download: async () => { if (mode === 'reject') throw Error('blocked'); return 8; },
      search: async () => { if (mode === 'search-error') throw Error('search failed'); return [{state:mode === 'early' ? 'complete' : 'in_progress', filename:'actual.mp4'}]; },
    };
    const urls = {createObjectURL: () => 'blob:synthetic', revokeObjectURL: u => revoked.push(u)};
    const lifecycle = {addEventListener: (n,f) => exits.add(f), removeEventListener: (n,f) => exits.delete(f)};
    const pending = g('downloadBlob')({}, {filename:'v.mp4'}, downloads, urls, lifecycle);
    if (['reject','search-error'].includes(mode)) await assert.rejects(pending);
    else {
      assert.equal((await pending).filename, 'actual.mp4');
      if (mode !== 'early') {
        assert.equal(revoked.length, 0, 'do not revoke an active download');
        for (const fn of listeners) fn({id:9, state:{current:'complete'}});
        assert.equal(revoked.length, 0, 'ignore unrelated downloads');
        if (mode === 'pagehide') for (const fn of [...exits]) fn();
        else for (const fn of [...listeners]) fn({id:8,state:{current:mode}});
      }
    }
    assert.deepEqual(revoked, ['blob:synthetic'], mode);
    assert.equal(listeners.size, 0);
    assert.equal(exits.size, 0);
  }
});

test('queueTask serializes work, recovers after errors, and releases settled keys', async () => {
  const queues = new Map(), order = [], enqueue = g('queueTask');
  let resume;
  const blocked = new Promise(r => {resume=r;});
  const first = enqueue(queues, 7, async () => {order.push('first'); await blocked; throw Error('failed');});
  const failed = assert.rejects(first);
  const second = enqueue(queues, 7, async () => {order.push('second');});
  await Promise.resolve();
  assert.equal(queues.size, 1);
  resume();
  await failed;
  await second;
  assert.deepEqual(order, ['first','second']);
  assert.equal(queues.size, 0);
});

// Browser lifecycle tests use in-memory Chrome adapters, never a real profile.
function backgroundHarness(initial = {}) {
  const records = JSON.parse(JSON.stringify(initial)), rules = new Map(), warnings = [];
  const event = () => ({listeners: [], addListener(fn) {this.listeners.push(fn);}, emit(...args) {return this.listeners.map(fn => fn(...args));}});
  const webRequest = Object.fromEntries(['onSendHeaders','onHeadersReceived','onErrorOccurred','onCompleted'].map(n => [n,event()]));
  let failStore = false, failRemoval = false, downloadState = ['complete'], createdTabs = 0;
  const changed = event();
  const chrome = {
    storage: {session: {
      get: async (k) => JSON.parse(JSON.stringify(k == null ? records : {[k]:records[k]})),
      set: async (o) => {if (failStore && Object.keys(o).some(k => k.startsWith('dl_'))) throw Error('quota'); Object.assign(records, JSON.parse(JSON.stringify(o)));},
      remove: async (k) => {delete records[k];},
    }},
    webRequest,
    declarativeNetRequest: {updateSessionRules: async ({addRules=[],removeRuleIds=[]}) => {
      if (failRemoval && removeRuleIds.length) throw Error('cleanup failed');
      for (const rule of addRules) rules.set(rule.id,rule);
      for (const id of removeRuleIds) rules.delete(id);
    }},
    action: {setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},
    runtime: {onMessage:event(),getURL:s=>'chrome-extension://synthetic/'+s},
    downloads: {
      download:async()=>{ changed.emit({id:8,state:{current:'complete'}}); return 8; },
      search:async()=>[{id:8,state:downloadState[0],error:downloadState[1]}],
      onChanged:changed,
    },
    tabs: {onUpdated:event(),onRemoved:event(),get:async()=>{throw Error('tab closed');},create:async()=>{createdTabs++;return {id:99};}},
  };
  const context = vm.createContext({chrome, URL, URLSearchParams, console:{warn:(...a)=>warnings.push(a)}});
  context.importScripts = (...names) => {for (const name of names) vm.runInContext(fs.readFileSync(name,'utf8'), context, {filename:name});};
  vm.runInContext(fs.readFileSync('background.js','utf8'), context, {filename:'background.js'});
  return {records,rules,chrome,warnings,run:s=>vm.runInContext(s,context),
    createdTabs:()=>createdTabs,
    downloadState:(state,error)=>{downloadState=[state,error];},
    failStore:()=>{failStore=true;}, failRemoval:value=>{failRemoval=value;}};
}
test('background tolerates lost request headers and malformed page messages', async () => {
  const h = backgroundHarness();
  await h.run('recovery');
  h.chrome.runtime.onMessage.emit(null, {tab:{id:7}}, ()=>{});
  h.chrome.runtime.onMessage.emit({type:'mse-state',state:null}, {tab:{id:7},frameId:0}, ()=>{});
  h.chrome.runtime.onMessage.emit({type:'dom-media',url:'https://media.example/v.mp4',tag:'video'}, {tab:{id:7,url:'https://page.example/'},frameId:0}, ()=>{});
  h.chrome.webRequest.onHeadersReceived.emit({requestId:'lost',tabId:7,frameId:0,statusCode:200,url:'https://media.example/v.mp4',responseHeaders:[]});
  await h.run('Promise.all([...locks.values()])');
  assert.equal(h.records.tab_7.items['https://media.example/v.mp4'].page, 'https://page.example');
  assert.equal(h.warnings.length, 0);
  await assert.rejects(h.run("directDownload({url:'bad',filename:'v.mp4',tabId:7})"), /Invalid media/);
});
test('background cleans completed downloads even when completion precedes record creation', async () => {
  const h = backgroundHarness();
  await h.run('recovery');
  h.records.tab_7 = {items:{'https://media.example/v.mp4':{url:'https://media.example/v.mp4',hdr:{cookie:'synthetic'}}},mse:{}};
  await h.run("directDownload({url:'https://media.example/v.mp4',filename:'v.mp4',tabId:7})");
  assert.equal(h.rules.size, 0);
  assert.equal(h.records.dl_8, undefined);
  assert.equal(h.run('settling.size'), 0);
  h.failStore();
  await assert.rejects(h.run("directDownload({url:'https://media.example/v.mp4',filename:'v.mp4',tabId:7})"), /quota/);
  assert.equal(h.rules.size, 0, 'storage failure must remove installed rules');
});
test('background retries recoverable interruptions through the video tab, not fatal ones', async () => {
  const h = backgroundHarness();
  await h.run('recovery');
  const interrupted = async (error) => {
    h.records.dl_8 = {rids: [], url: 'https://media.example/v.mp4', tabId: 7, title: 'v', ext: 'mp4'};
    h.downloadState('interrupted', error);
    await h.run('settle(8)');
    return h.createdTabs();
  };
  // Recoverable: refusals need the page's session; SERVER_NO_RANGE needs a
  // re-fetch without Range, which filePrepare() handles (it stops on status 200).
  let expected = 0;
  for (const error of ['SERVER_FORBIDDEN', 'SERVER_UNAUTHORIZED', 'SERVER_NO_RANGE', 'NETWORK_INVALID_REQUEST']) {
    expected++;
    assert.equal(await interrupted(error), expected, `${error} should open the fallback tab`);
  }
  // Fatal: disk and network faults would fail identically in the video tab.
  for (const error of ['FILE_NO_SPACE', 'NETWORK_TIMEOUT', 'FILE_TOO_LARGE', 'USER_CANCELED', 'FILE_ACCESS_DENIED', 'CRASH']) {
    assert.equal(await interrupted(error), expected, `${error} must not open a doomed retry tab`);
  }
  assert.equal(h.records.dl_8, undefined, 'download records are always cleaned up');
});

test('background recovery retries rule cleanup and removes orphaned tab records', async () => {
  const h = backgroundHarness({dl_8:{rids:[41],url:'https://media.example/v.mp4'},rules_99:[42]});
  await h.run('recovery');
  assert.equal(h.records.dl_8, undefined);
  assert.equal(h.records.rules_99, undefined);
  h.records.dl_8 = {rids:[41]};
  h.rules.set(41,{});
  h.failRemoval(true);
  await h.run('settle(8)');
  assert.ok(h.records.dl_8, 'retain ownership when removal fails');
  h.failRemoval(false);
  await h.run('settle(8)');
  assert.equal(h.records.dl_8, undefined);
  assert.equal(h.rules.size, 0);
  const first = h.run("withTab(7, d => { d.items.a = {url:'https://media.example/a'}; })");
  const second = h.run("withTab(7, d => { d.items.b = {url:'https://media.example/b'}; })");
  const closing = h.run('cleanupTab(7)');
  await Promise.all([first,second,closing]);
  assert.equal(h.records.tab_7, undefined, 'queued captures must not recreate closed tab storage');
  assert.equal(h.run('locks.size'), 0);
});

test('DASH rejects non-finite and excessive counts before allocating segments', () => {
  const count = g('segmentCount');
  for (const n of [0,-1,Infinity,NaN,1.5,1000001]) assert.throws(() => count(n), /segment count/);
  assert.equal(count(1), 1);
  assert.equal(count(1000000), 1000000);
  // Exercise the actual segment builder with small fake XML nodes.
  const node = (name, attrs={}, children=[]) => ({
    localName:name, children,
    attributes:Object.entries(attrs).map(([name,value])=>({name,value:String(value)})),
    getAttribute:k=>attrs[k] == null ? null : String(attrs[k]),
    hasAttribute:k=>Object.hasOwn(attrs,k),
  });
  const representation = (duration, repeat) => ({
    rep:node('Representation'), as:node('AdaptationSet'),
    period:node('Period',{},[node('SegmentTemplate',{media:'s$Number$.m4s'},[node('SegmentTimeline',{},[node('S',{d:duration,r:repeat})])])]),
    pDur:10, base:'https://media.example/', id:'v', bw:1,
  });
  assert.throws(()=>g('segmentsFor')(representation(0,-1)), /duration/);
  assert.throws(()=>g('segmentsFor')(representation(1,1e9)), /segment count/);
  assert.equal(g('segmentsFor')(representation(2,2)).segs.length, 3);
});

test('MAIN-world media controls ignore malformed commands without claiming authentication', () => {
  const listeners = {}, media = {play:async()=>{}};
  const window = {addEventListener:(name,fn)=>{listeners[name]=fn;}};
  const context = vm.createContext({window, URL:class extends URL {static createObjectURL(){return 'blob:fake';}},
    document:{addEventListener(){},querySelectorAll:()=>[media]}});
  vm.runInContext(fs.readFileSync('inject.js','utf8'), context);
  for (const data of [{__mdlCmd:'save-track',name:{}},{__mdlCmd:'save-blob',id:-1},{__mdlCmd:'unknown'},null]) {
    assert.doesNotThrow(()=>listeners.message({source:window,data}));
  }
  listeners.message({source:window,data:{__mdlCmd:'turbo'}});
  assert.equal(media.muted, true);
  assert.equal(media.playbackRate, 16);
});

// Shared MAIN-world sandbox for inject.js: fake URL/Blob so ids and revocations
// are observable, and a synchronous setTimeout so the throttled post() flushes.
function mainWorld({ blobSize } = {}) {
  const saved = [], messages = [];
  class FakeBlob {
    constructor(parts, opts = {}) {
      this.type = opts.type || '';
      this.size = blobSize != null ? blobSize : parts.reduce((n, p) => n + (p.byteLength || p.size || 0), 0);
    }
  }
  class FakeURL extends URL {
    static createObjectURL(obj) {
      if (obj instanceof FakeBlob) saved.push(obj);
      return 'blob:' + (FakeURL.next++);
    }
    static revokeObjectURL() {}
  }
  FakeURL.next = 0;
  const window = {
    addEventListener: (n, f) => { window.listeners[n] = f; },
    postMessage: (m) => messages.push(m),
    listeners: {},
  };
  const context = vm.createContext({
    window, URL: FakeURL, Blob: FakeBlob,
    document: {
      addEventListener() {}, querySelectorAll: () => [],
      body: { appendChild() {} }, documentElement: {},
      createElement: () => ({ style: {}, click() {}, remove() {} }),
    },
    setTimeout: (fn) => { fn(); return 0; },
  });
  vm.runInContext(fs.readFileSync('inject.js', 'utf8'), context);
  return {
    context, window, saved, messages,
    blobs: () => (messages.length ? messages[messages.length - 1].state.blobs : []),
    cmd: (data) => window.listeners.message({ source: window, data }),
  };
}

test('MAIN-world capture keeps a Blob saveable after the page revokes its URL', () => {
  const w = mainWorld();
  const url = w.context.URL.createObjectURL(new w.context.Blob([], { type: 'video/mp4' }));
  assert.equal(w.blobs().length, 1);

  // Players revoke as soon as the media element has loaded. The capture must survive.
  w.context.URL.revokeObjectURL(url);
  assert.equal(w.blobs().length, 1, 'revocation must not drop a still-saveable capture');

  const blob = w.saved[w.saved.length - 1];
  w.saved.length = 0;
  w.cmd({ __mdlCmd: 'save-blob', id: 0, name: 'clip' });
  assert.deepEqual(w.saved, [blob], 'the Blob is still saved, through a freshly minted URL');
});

test('MAIN-world capture caps retained Blobs by evicting the oldest', () => {
  const w = mainWorld({ blobSize: 400 * 1024 * 1024 });
  w.context.URL.createObjectURL(new w.context.Blob([], { type: 'video/mp4' })); // id 0
  w.context.URL.createObjectURL(new w.context.Blob([], { type: 'video/mp4' })); // id 1, now 800 MB
  assert.deepEqual(w.blobs().map((b) => b.id), [1], 'the oldest entry is evicted to stay under the cap');

  w.context.URL.createObjectURL(new w.context.Blob([], { type: 'video/mp4' })); // id 2, still 800 MB
  assert.deepEqual(w.blobs().map((b) => b.id), [2], 'memory stays bounded across many captures');

  // An over-cap Blob is skipped rather than evicting everything else.
  const w2 = mainWorld({ blobSize: 600 * 1024 * 1024 });
  w2.context.URL.createObjectURL(new w2.context.Blob([], { type: 'video/mp4' }));
  assert.deepEqual(w2.blobs(), [], 'a single Blob larger than the cap is not retained');
});

test('MAIN-world save-blob resolves by id, and stale ids save nothing', () => {
  const w = mainWorld();
  const a = w.context.URL.createObjectURL(new w.context.Blob([], { type: 'video/mp4' })); // id 0
  w.context.URL.createObjectURL(new w.context.Blob([], { type: 'video/mp4' }));           // id 1
  w.context.URL.revokeObjectURL(a); // id 0 becomes a dead handle but keeps its capture

  const second = w.saved[w.saved.length - 1];
  w.saved.length = 0;
  w.cmd({ __mdlCmd: 'save-blob', id: 1, name: 'clip' });
  assert.deepEqual(w.saved, [second], 'id 1 resolves to the right Blob');

  w.saved.length = 0;
  w.cmd({ __mdlCmd: 'save-blob', id: 99, name: 'clip' });
  assert.deepEqual(w.saved, [], 'an unknown id saves nothing');
});

// --- HLS / DASH parsers (previously untested: this is where the AES-CBC padding bug hid)
const M3U8_BASE = 'https://media.example/hls/master.m3u8';
const MEDIA_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:10',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-KEY:METHOD=AES-128,URI="https://media.example/key.bin",IV=0x0123456789ABCDEF0123456789ABCDEF',
  '#EXT-X-MAP:URI="init.mp4",BYTERANGE="800@0"',
  '#EXTINF:6.0,',
  'seg10.m4s',
  '#EXTINF:6.0,',
  '#EXT-X-BYTERANGE:1000@900',
  'seg11.m4s',
  '#EXT-X-ENDLIST',
].join('\n');

test('parseM3U8 resolves keys, maps, byte ranges and sequence numbers', () => {
  const pl = g('parseM3U8')(MEDIA_PLAYLIST, M3U8_BASE);
  assert.equal(pl.variants.length, 0);
  assert.equal(pl.segments.length, 2);
  assert.equal(pl.vod, true);
  assert.equal(pl.end, true);
  assert.equal(pl.target, 6);
  assert.equal(pl.segments[0].uri, 'https://media.example/hls/seg10.m4s');
  assert.equal(pl.segments[0].seq, 10);
  assert.equal(pl.segments[1].seq, 11);
  assert.deepEqual(pl.segments[1].br, [900, 1899], 'implicit byte range continues from the previous one');
  assert.equal(pl.segments[0].map.uri, 'https://media.example/hls/init.mp4');
  assert.deepEqual(pl.segments[0].map.br, [0, 799]);
  assert.equal(pl.segments[0].key.method, 'AES-128');
  assert.equal(pl.segments[1].key.uri, 'https://media.example/key.bin', 'keys carry to following segments');
});

test('parseM3U8 separates variants, renditions and DRM keys', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="subs/en.m3u8"',
    '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://key"',
    '#EXT-X-STREAM-INF:BANDWIDTH=4000000,AVERAGE-BANDWIDTH=3500000,RESOLUTION=1920x1080,CODECS="avc1.64"',
    'v1080/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'v360/index.m3u8',
  ].join('\n');
  const pl = g('parseM3U8')(master, M3U8_BASE);
  assert.equal(pl.variants.length, 2);
  assert.deepEqual(pl.variants.map((v) => v.uri), [
    'https://media.example/hls/v1080/index.m3u8',
    'https://media.example/hls/v360/index.m3u8',
  ]);
  assert.equal(pl.variants[0].RESOLUTION, '1920x1080');
  assert.equal(pl.media.length, 2);
  assert.equal(pl.media[0].URI, 'https://media.example/hls/audio/en.m3u8');
  assert.equal(pl.sessionKeys.length, 1);
  assert.equal(g('isDRMAttrs')(pl.sessionKeys[0]), true, 'SAMPLE-AES is refused, not decrypted');
  assert.equal(g('isDRMAttrs')({ METHOD: 'AES-128', KEYFORMAT: 'identity' }), false);
});

test('parseM3U8 rejects non-playlists and malformed byte ranges instead of guessing', () => {
  assert.throws(() => g('parseM3U8')('<html>error</html>', M3U8_BASE), /Not an M3U8 playlist/);
  assert.throws(() => g('parseBR')('abc', 0), /byte range/);
  assert.throws(() => g('parseBR')('0@0', 0), /byte range/);
  assert.throws(() => g('parseBR')('100', -5), /offset/);
  assert.deepEqual(g('parseBR')('100', 40), [40, 139]);
});

test('ivFor uses the explicit IV, else the media sequence as a big-endian 64-bit suffix', () => {
  const hex = (u8) => Buffer.from(u8).toString('hex');
  assert.equal(hex(g('ivFor')({ iv: '0x0123456789ABCDEF0123456789ABCDEF' }, 99)), '0123456789abcdef0123456789abcdef');
  assert.equal(hex(g('ivFor')({}, 1)), '00000000000000000000000000000001');
  assert.equal(hex(g('ivFor')({}, 258)), '00000000000000000000000000000102');
  assert.equal(hex(g('ivFor')({ iv: '1f' }, 7)), '0000000000000000000000000000001f', 'short IVs are left-padded');
});

test('isoDur parses ISO-8601 durations and ignores junk', () => {
  const d = g('isoDur');
  assert.equal(d('PT1H2M3S'), 3723);
  assert.equal(d('P1DT1S'), 86401);
  assert.equal(d('PT0.5S'), 0.5);
  assert.equal(d(''), 0);
  assert.equal(d(null), 0);
  assert.equal(d('garbage'), 0);
});

test('aes-128 HLS: PKCS#7 and unpadded CBC segments both decrypt intact', async () => {
  const decrypt = g('aesCbcDecrypt'), subtle = nodeCrypto.webcrypto.subtle;
  const raw = nodeCrypto.randomBytes(16), iv = nodeCrypto.randomBytes(16);
  const key = await subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt', 'encrypt']);
  const padded = (p) => { const c = nodeCrypto.createCipheriv('aes-128-cbc', raw, iv); return Buffer.concat([c.update(p), c.final()]); };
  const rawBlocks = (p) => { const c = nodeCrypto.createCipheriv('aes-128-cbc', raw, iv); c.setAutoPadding(false); return Buffer.concat([c.update(p), c.final()]); };
  // Deterministic payloads: a trailing byte above 0x10 is unambiguously not PKCS#7.
  // (Random bytes can accidentally end in valid-looking padding, which no
  // implementation can distinguish from a real padded stream.)
  for (const size of [16, 1024, 1504]) {
    const plain = Buffer.alloc(size, 0x41);
    assert.deepEqual(Buffer.from(await decrypt(key, iv, padded(plain))), plain, `padded ${size}`);
    assert.deepEqual(Buffer.from(await decrypt(key, iv, rawBlocks(plain))), plain, `unpadded ${size}`);
  }
  // A truncated (non block-aligned) segment must fail loudly, not return partial data.
  await assert.rejects(decrypt(key, iv, nodeCrypto.randomBytes(24)), /OperationError|operation/);
});

test('PowerShell quoting escapes every Unicode single-quote delimiter', () => {
  for (const quote of ["'",'\u2018','\u2019','\u201a','\u201b']) {
    const payload = 'x' + quote + '; $(calc); #';
    assert.equal(g('shellQuote')(payload, true), "'x" + quote + quote + "; $(calc); #'");
    assert.equal(g('shellQuote')(quote, false), quote === "'" ? "''\\'''" : "'" + quote + "'");
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

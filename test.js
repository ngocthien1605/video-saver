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
  let failStore = false, failRemoval = false;
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
      search:async()=>[{id:8,state:'complete'}],
      onChanged:changed,
    },
    tabs: {onUpdated:event(),onRemoved:event(),get:async()=>{throw Error('tab closed');},create:async()=>({id:99})},
  };
  const context = vm.createContext({chrome, URL, console:{warn:(...a)=>warnings.push(a)}});
  context.importScripts = (...names) => {for (const name of names) vm.runInContext(fs.readFileSync(name,'utf8'), context, {filename:name});};
  vm.runInContext(fs.readFileSync('background.js','utf8'), context, {filename:'background.js'});
  return {records,rules,chrome,warnings,run:s=>vm.runInContext(s,context),
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
  const source = fs.readFileSync('downloader.js','utf8');
  const helpers = source.slice(source.indexOf('const kids ='), source.indexOf('function parseMPD'));
  const builder = source.slice(source.indexOf('function segmentsFor'), source.indexOf('async function dashPrepare'));
  vm.runInContext(helpers + builder, ctx);
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

// Downloads a pack into the phone: concatenates tile parts into carte.pmtiles, gunzips the graph/search files.
importScripts('storage.js');
let abortCtl = null, openHandle = null;
self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.cmd === 'abort') { if (abortCtl) abortCtl.abort(); return; }
  if (m.cmd !== 'download') return;
  const { id, base } = m;
  abortCtl = new AbortController();
  try {
    const pack = await (await fetch(base + id + '/pack.json', { cache: 'no-store', signal: abortCtl.signal })).json();
    const total = pack.size; let done = 0;
    const post = (phase) => self.postMessage({ type: 'progress', id, done, total, phase });
    const outputs = pack.outputs.map(o => ({ name: o.name, gz: o.gz, srcs: o.parts.map(p => p.path) }));
    // tuiles en dernier (les plus grosses) ; les fichiers .gz découpés sont réassemblés puis décompressés en flux
    const dir = await PackStore.opfsDir(id, true);
    let useOpfs = false;
    if (dir) { try { const t = await dir.getFileHandle('__t', { create: true }); const h = await t.createSyncAccessHandle(); h.close(); await dir.removeEntry('__t'); useOpfs = true; } catch (e) { useOpfs = false; } }
    const cache = useOpfs ? null : await caches.open(PackStore.CACHE_PREFIX + id);
    for (const o of outputs) {
      let handle = null, pos = 0, chunks = [];
      if (useOpfs) { const fh = await dir.getFileHandle(o.name, { create: true }); handle = await fh.createSyncAccessHandle(); openHandle = handle; handle.truncate(0); }
      const write = (u8) => { if (handle) { handle.write(u8, { at: pos }); pos += u8.byteLength; } else chunks.push(u8); };
      // concatène les morceaux en un seul flux (avec reprise par morceau), puis décompresse si besoin
      const fetchPart = async (src) => {
        for (let attempt = 0; ; attempt++) {
          try { const r = await fetch(base + id + '/' + src + '?v=' + pack.version, { signal: abortCtl.signal });
            if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + src);
            const rd = r.body.getReader(); const chunks = []; let n = 0;
            try { for (;;) { const { value, done: d } = await rd.read(); if (d) break; chunks.push(value); n += value.byteLength; done += value.byteLength; post(o.name); } }
            catch (e) { done -= n; throw e; }
            const buf = new Uint8Array(n); let q = 0; for (const c of chunks) { buf.set(c, q); q += c.byteLength; } return buf; }
          catch (e) { if (abortCtl.signal.aborted || attempt >= 3) throw e; await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); }
        }
      };
      let idx = 0;
      let stream = new ReadableStream({ async pull(ctl) {
        if (idx >= o.srcs.length) { ctl.close(); return; }
        const buf = await fetchPart(o.srcs[idx++]); ctl.enqueue(buf);
      } });
      if (o.gz) stream = stream.pipeThrough(new DecompressionStream('gzip'));
      const rd = stream.getReader();
      for (;;) { const { value, done: d } = await rd.read(); if (d) break; write(value); }
      if (handle) { handle.flush(); handle.close(); openHandle = null; }
      else await cache.put('/__pack/' + id + '/' + o.name, new Response(new Blob(chunks)));
    }
    const meta = Object.assign({}, pack, { complete: true, storage: useOpfs ? 'opfs' : 'cache', installed: Date.now() });
    const mb = new TextEncoder().encode(JSON.stringify(meta));
    if (useOpfs) { const fh = await dir.getFileHandle('meta.json', { create: true }); const h = await fh.createSyncAccessHandle(); h.truncate(0); h.write(mb, { at: 0 }); h.flush(); h.close(); }
    else await cache.put('/__pack/' + id + '/meta.json', new Response(mb));
    self.postMessage({ type: 'done', id, meta });
  } catch (e) {
    if (openHandle) { try { openHandle.close(); } catch (x) {} openHandle = null; }
    self.postMessage({ type: 'error', id, error: String(e && e.message || e), aborted: abortCtl.signal.aborted });
    await PackStore.remove(id).catch(() => {});
  }
};

// Pack storage abstraction: OPFS when available (preferred), Cache Storage fallback.
// Usable from window and workers (classic scripts: self.PackStore).
(function (g) {
  const CACHE_PREFIX = 'pack-';
  async function opfsRoot() {
    try { if (navigator.storage && navigator.storage.getDirectory) return await navigator.storage.getDirectory(); } catch (e) {}
    return null;
  }
  async function opfsDir(id, create) {
    const root = await opfsRoot(); if (!root) return null;
    try { const packs = await root.getDirectoryHandle('packs', { create });
      return await packs.getDirectoryHandle(id, { create }); } catch (e) { return null; }
  }
  const PackStore = {
    // returns Blob (File) or null
    async get(id, name) {
      const d = await opfsDir(id, false);
      if (d) { try { const fh = await d.getFileHandle(name); const f = await fh.getFile(); if (f.size > 0) return f; } catch (e) {} }
      try { const c = await caches.open(CACHE_PREFIX + id); const r = await c.match('/__pack/' + id + '/' + name); if (r) return await r.blob(); } catch (e) {}
      return null;
    },
    async getMeta(id) { const b = await this.get(id, 'meta.json'); if (!b) return null; try { return JSON.parse(await b.text()); } catch (e) { return null; } },
    async list() {
      const out = new Set();
      const root = await opfsRoot();
      if (root) { try { const packs = await root.getDirectoryHandle('packs', { create: false });
        for await (const [n] of packs.entries()) out.add(n); } catch (e) {} }
      try { for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX)) out.add(k.slice(CACHE_PREFIX.length)); } catch (e) {}
      const res = [];
      for (const id of out) { const m = await this.getMeta(id); if (m && m.complete) res.push(m); }
      return res;
    },
    async remove(id) {
      const root = await opfsRoot();
      if (root) { try { const packs = await root.getDirectoryHandle('packs', { create: false }); await packs.removeEntry(id, { recursive: true }); } catch (e) {} }
      try { await caches.delete(CACHE_PREFIX + id); } catch (e) {}
    },
    opfsDir, CACHE_PREFIX
  };
  g.PackStore = PackStore;
})(self);

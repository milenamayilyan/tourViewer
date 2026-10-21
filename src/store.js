/* Draft storage (IndexedDB), image preparation, and a tiny zip writer. */

const open = () => new Promise((res, rej) => {
  const r = indexedDB.open('land-tour', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const run = async (mode, fn) => {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => res(req?.result);
    tx.onerror = () => rej(tx.error);
  });
};
export const getMeta = () => run('readonly', (s) => s.get('meta'));
export const saveMeta = (m) => run('readwrite', (s) => s.put(m, 'meta'));
export const saveProject = (r) => run('readwrite', (s) => s.put(r, 'p:' + r.slug));
export const loadProject = (slug) => run('readonly', (s) => s.get('p:' + slug));
export const deleteProject = (slug) => run('readwrite', (s) => s.delete('p:' + slug));
export const clearAll = () => run('readwrite', (s) => s.clear());

/** Re-encode a photo as JPEG, max 8192 px wide (keeps files small and GPU-safe). */
export async function processImage(file, maxW = 8192) {
  const bmp = await createImageBitmap(file);
  const w = Math.min(bmp.width, maxW), h = Math.round((bmp.height * w) / bmp.width);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', 0.88));
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b) => { let c = ~0; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };

/** files: [{ name, data: Uint8Array }] -> zip Blob (no compression). */
export function makeZip(files) {
  const enc = new TextEncoder(), parts = [], cen = [];
  let off = 0;
  for (const f of files) {
    const n = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true);
    h.setUint16(26, n.length, true);
    parts.push(new Uint8Array(h.buffer), n, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, sz, true); c.setUint32(24, sz, true);
    c.setUint16(28, n.length, true); c.setUint32(42, off, true);
    cen.push(new Uint8Array(c.buffer), n);
    off += 30 + n.length + sz;
  }
  const cs = cen.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cs, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cen, new Uint8Array(e.buffer)], { type: 'application/zip' });
}

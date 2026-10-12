const FRONT = "/home/joshua/rust/audio/front";
const { createServer } = await import(FRONT + "/node_modules/vite/dist/node/index.js");
const { unzipSync } = await import(FRONT + "/node_modules/fflate/esm/index.mjs");
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
// XMLHttpRequest minimal au-dessus de fetch (Node n'en a pas) : progression simulée à la fin.
globalThis.XMLHttpRequest = class {
  upload = {}; headers = {};
  open(m, u) { this.m = m; this.u = u; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  send(body) {
    fetch(this.u, { method: this.m, headers: this.headers, body }).then(async (r) => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 });
      this.status = r.status; this.response = await r.arrayBuffer(); this.onload();
    }, () => this.onerror());
  }
};
const vite = await createServer({ root: FRONT, configFile: FRONT + "/vite.config.ts", server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { ChatStore } = await vite.ssrLoadModule("/src/chat/store.ts");
const Z = await vite.ssrLoadModule("/src/chat/zip-folder.ts");
const M = await vite.ssrLoadModule("/src/chat/media.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, what, ms = 5000) { for (let t = 0; t < ms; t += 25) { if (f()) return; await sleep(25); } console.log("ÉCHEC (timeout)", what); process.exit(1); }
const ok = (c, m) => { if (!c) { console.log("ÉCHEC", m); process.exit(1); } console.log("ok", m); };
const s = (x) => x.getSnapshot();
const t = (n) => `00000000-0000-0000-0000-00000000000${n}`;
async function user(n, pseudo) { const x = new ChatStore(t(n)); x.start(); await until(() => s(x).phase === "pseudo", pseudo); await x.setPseudo(pseudo); return x; }
const A = await user(1, "Léa"), B = await user(2, "Bob");
const video = new Uint8Array(200_000); video.set([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypisom")]);
const v = await A.uploadMedia(new Blob([video]), { name: "clip.mp4" });
ok(v.isVideo && !v.isImage && s(A).media[v.id].url?.startsWith("blob:"), "vidéo envoyée : lue depuis le fichier local");
B.ensureMedia(v.id);
await until(() => s(B).media[v.id]?.url, "Bob obtient l'adresse de lecture");
const url = s(B).media[v.id].url;
ok(url.includes(`/media/${v.id}?ticket=`), "adresse de lecture par ticket");
const r = await fetch(url, { headers: { Range: "bytes=0-99" } });
ok(r.status === 206 && (await r.arrayBuffer()).byteLength === 100, "le lecteur peut lire par plages avec cette adresse");
await B.refreshStream(v.id);
ok(s(B).media[v.id].url !== url, "ticket renouvelable (onglet resté ouvert)");
A.dispose(); B.dispose(); await vite.close(); process.exit(0);

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

ok(M.formatBytes(0) === "0 o" && M.formatBytes(1536) === "1,5 Ko" && M.formatBytes(3.2 * 2 ** 30) === "3,2 Go", "tailles lisibles");
const A = await user(1, "Léa"), B = await user(2, "Bob");
let progress = 0;
const doc = await A.uploadMedia(new Blob(["contenu du rapport"]), { name: "rapport été.odt", onProgress: (r) => (progress = r) });
ok(doc && !doc.isImage && doc.name === "rapport été.odt" && doc.size === 18 && progress === 1, "fichier quelconque envoyé, progression remontée");
B.ensureMedia(doc.id);
await until(() => s(B).media[doc.id]?.status === "ready", "Bob lit les métadonnées");
ok(s(B).media[doc.id].info.name === "rapport été.odt" && s(B).media[doc.id].url === undefined, "Bob voit nom et taille sans télécharger le fichier");

const big = new Uint8Array(300_000).fill(65);
const folder = { name: "Vacances", entries: [
  { path: "Vacances/notes.txt", file: new File([big], "notes.txt") },
  { path: "Vacances/photos/plage.jpg", file: new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], "plage.jpg") },
] };
let zipProgress = 0;
const zip = await Z.zipFolder(folder, (r) => (zipProgress = r));
const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
ok(Object.keys(files).sort().join() === "Vacances/notes.txt,Vacances/photos/plage.jpg" && files["Vacances/notes.txt"].length === 300_000, "ZIP valide : arborescence et contenu intacts");
ok(zip.size < 10_000 && zipProgress === 1, `texte compressé (300 Ko → ${zip.size} o), progression 100 %`);
const up = await A.uploadMedia(zip, { name: "Vacances.zip", folder: { files: 2, size: Z.folderSize(folder) } });
B.ensureMedia(up.id); await until(() => s(B).media[up.id]?.status === "ready", "Bob lit le dossier");
ok(s(B).media[up.id].info.folderFiles === 2 && s(B).media[up.id].info.folderSize === 300_006, "Bob voit : dossier, 2 fichiers, taille d'origine");
const parts = Z.foldersFromInput([Object.assign(new File(["x"], "a.txt"), {}), ].map((f) => Object.defineProperty(f, "webkitRelativePath", { value: "Projet/src/a.txt" })));
ok(parts.length === 1 && parts[0].name === "Projet" && parts[0].entries[0].path === "Projet/src/a.txt", "dossier choisi au sélecteur : nom et chemins");
A.dispose(); B.dispose(); await vite.close(); process.exit(0);

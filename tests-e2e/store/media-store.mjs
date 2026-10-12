const FRONT = "/home/joshua/rust/audio/front";
const { createServer } = await import(FRONT + "/node_modules/vite/dist/node/index.js");
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
globalThis.window = { location: { origin: "http://localhost:5173" } };
globalThis.XMLHttpRequest = class {
  upload = {}; headers = {};
  open(m, u) { this.m = m; this.u = u; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  send(body) { fetch(this.u, { method: this.m, headers: this.headers, body }).then(async (r) => { this.status = r.status; this.response = await r.arrayBuffer(); this.onload(); }, () => this.onerror()); }
};
const vite = await createServer({ root: FRONT, configFile: FRONT + "/vite.config.ts", server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { ChatStore } = await vite.ssrLoadModule("/src/chat/store.ts");
const M = await vite.ssrLoadModule("/src/chat/media.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, what, ms = 5000) { for (let t = 0; t < ms; t += 25) { if (f()) return; await sleep(25); } console.log("ÉCHEC (timeout)", what); process.exit(1); }
const ok = (c, m) => { if (!c) { console.log("ÉCHEC", m); process.exit(1); } console.log("ok", m); };
const s = (x) => x.getSnapshot();
const t = (n) => `00000000-0000-0000-0000-00000000000${n}`;
async function user(n, pseudo) { const x = new ChatStore(t(n)); x.start(); await until(() => s(x).phase === "pseudo", pseudo); await x.setPseudo(pseudo); return x; }
function png(w, h, total) { const b = new Uint8Array(total); b.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,0x49,0x48,0x44,0x52]); const v = new DataView(b.buffer); v.setUint32(16, w); v.setUint32(20, h); return b; }

// utilitaires de liens
const id0 = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const parts = M.splitContent(`avant /media/${id0}\napres https://exemple.fr/media/${id0}fin`);
ok(parts.length === 5 && parts[1].kind === "media" && parts[2].text === "\napres " && parts[3].kind === "media" && parts[4].text === "fin", "liens relatifs et absolus reconnus, texte autour gardé");
ok(M.withoutMedia(`a /media/${id0} b`, id0) === "a  b", "retirer une image d'un message");
ok(M.plainText(`regarde /media/${id0}`).includes("🖼 image"), "aperçu de citation");
ok(M.shareLink(id0) === `http://localhost:5173/media/${id0}`, "lien à partager absolu");

const A = await user(1, "Léa"), B = await user(2, "Bob");
await A.createChannel("g"); const ch = s(A).channels[0].id; A.open(ch); B.open(ch);
await until(() => s(A).messages[ch] && s(B).messages[ch], "sync");
const id = (await A.uploadMedia(new Blob([png(800, 600, 50_000)], { type: "image/png" }), { name: "photo.png" }))?.id;
ok(id && s(A).media[id]?.status === "ready" && s(A).media[id].info.ownerId === s(A).me.id && s(A).media[id].url, "envoi : id rendu, mis en cache sans retéléchargement");
ok(await A.send(ch, `regarde ça\n${M.mediaToken(id)}\net ça encore`), "message texte + image + texte");
await until(() => s(B).messages[ch].length === 1, "Bob reçoit le message");
const parts2 = M.splitContent(s(B).messages[ch][0].content);
ok(parts2.map((p) => p.kind).join() === "text,media,text", "ordre texte / image / texte conservé");
B.ensureMedia(id); B.ensureMedia(id);
await until(() => s(B).media[id]?.url, "Bob charge l'image");
ok(s(B).media[id].info.ownerId === s(A).me.id && s(B).media[id].info.mime === "image/png", "propriétaire et type connus de Bob");
const other = await A.uploadMedia(new Blob([new TextEncoder().encode("pas une image")]), { name: "notes.txt" }); ok(other && !other.isImage, "non-image : fichier, pas d'erreur");
await B.deleteMediaEverywhere(id); ok(s(B).error && s(B).media[id].status === "ready", "Bob ne peut pas la supprimer pour tout le monde"); B.clearError();
await A.deleteMediaEverywhere(id);
await until(() => s(B).media[id]?.status === "missing", "chez Bob : image supprimée");
ok(s(A).media[id].status === "missing", "supprimée partout");
const C = await user(3, "Cléo"); C.ensureMedia(id); await until(() => s(C).media[id]?.status === "missing", "Cléo");
ok(true, "nouvel arrivant : image supprimée (404)");
for (const x of [A, B, C]) x.dispose(); await vite.close(); process.exit(0);

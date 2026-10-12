import * as P from "/home/joshua/rust/audio/front/src/lib/protocol.ts";
import { chat } from "/home/joshua/rust/audio/front/src/proto/messages.js";
const BASE = "https://127.0.0.1:8444";
const ok = (c: any, m: string) => { if (!c) { console.log("ÉCHEC", m); process.exit(1); } console.log("ok", m); };
const ws = new WebSocket("wss://127.0.0.1:8444"); await new Promise((r) => (ws.onopen = r));
const c = new P.ProtocolClient(ws as any);
const token = (await c.request(P.authRequest("00000000-0000-0000-0000-000000000001"))).authResponse!.sessionToken!;
await c.request(P.setPseudo("Léa"));
const auth = { Authorization: `Bearer ${token}` };
const up = async (body: Uint8Array, headers: Record<string, string>) => {
  const r = await fetch(BASE + "/media", { method: "POST", headers: { ...auth, ...headers }, body });
  return { status: r.status, m: r.status === 201 ? chat.MediaUploaded.decode(new Uint8Array(await r.arrayBuffer())).media! : null };
};
const big = new Uint8Array(20 * 1024 * 1024).map((_, i) => (i * 7) % 256);
let r = await up(big, { "X-Media-Name": encodeURIComponent("rapport final été.pdf") });
ok(r.status === 201 && r.m!.mime === "application/octet-stream" && r.m!.name === "rapport final été.pdf" && Number(r.m!.size) === big.length, "fichier quelconque de 20 Mo accepté, nom UTF-8 gardé");
const fileId = r.m!.id;
r = await up(new TextEncoder().encode("<html><script>alert(1)</script>"), { "X-Media-Name": encodeURIComponent("../../piège.html") });
ok(r.status === 201 && r.m!.name === "piège.html" && r.m!.mime === "application/octet-stream", "HTML accepté comme simple fichier, chemin retiré du nom");
const htmlId = r.m!.id;
const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(500).fill(1)]);
r = await up(zip, { "X-Media-Name": encodeURIComponent("Photos vacances.zip"), "X-Folder-Files": "124", "X-Folder-Size": "3400000000" });
ok(r.m!.folderFiles === 124 && Number(r.m!.folderSize) === 3400000000, "dossier : nombre de fichiers et taille d'origine");
const zipId = r.m!.id;
const png = new Uint8Array(1000); png.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,0x49,0x48,0x44,0x52,0,0,1,0,0,0,0,200]);
r = await up(png, { "X-Media-Name": "capture.png" });
ok(r.m!.mime === "image/png" && r.m!.width === 256 && r.m!.name === "capture.png", "image propre toujours reconnue, avec son nom");
const imgId = r.m!.id;

let g = await fetch(`${BASE}/media/${htmlId}`, { headers: auth });
ok(g.headers.get("content-type") === "application/octet-stream" && g.headers.get("x-content-type-options") === "nosniff" && g.headers.get("content-disposition")?.startsWith("attachment"), "fichier servi en pièce jointe, nosniff");
ok(g.headers.get("content-disposition")!.includes("filename*=UTF-8''pi%C3%A8ge.html"), "nom UTF-8 dans Content-Disposition");
g = await fetch(`${BASE}/media/${imgId}`, { headers: auth });
ok(g.headers.get("content-type") === "image/png" && !g.headers.get("content-disposition"), "image servie en ligne pour l'affichage");

const info = (await c.request(P.getMedia([fileId, zipId, "pas-un-id", "6f9619ff-8b86-4011-b42d-00c04fc964ff"]))).mediaInfo!;
ok(info.media.length === 2 && info.media.find((m) => m.id === zipId)!.folderFiles === 124, "GetMedia : métadonnées sans contenu, ids inconnus absents");

ok((await fetch(`${BASE}/media/${fileId}`)).status === 401, "sans session ni ticket : 401");
ok((await fetch(`${BASE}/media/${fileId}?ticket=6f9619ff-8b86-4011-b42d-00c04fc964ff`)).status === 401, "ticket inventé : 401");
const t = (await c.request(P.requestDownload(fileId))).downloadTicket!;
g = await fetch(`${BASE}/media/${fileId}?ticket=${t.ticket}`);
const body = new Uint8Array(await g.arrayBuffer());
ok(g.status === 200 && body.length === big.length && body[12345] === big[12345] && g.headers.get("content-disposition")?.startsWith("attachment"), "ticket : 20 Mo téléchargés sans session, en pièce jointe");
ok((await fetch(`${BASE}/media/${zipId}?ticket=${t.ticket}`)).status === 401, "ticket d'un autre fichier : refusé");
ok((await c.request(P.requestDownload("6f9619ff-8b86-4011-b42d-00c04fc964ff"))).error?.code === 404, "ticket pour un fichier inconnu : 404");
g = await fetch(`${BASE}/media/${imgId}?ticket=${(await c.request(P.requestDownload(imgId))).downloadTicket!.ticket}`);
ok(g.headers.get("content-disposition")?.includes("capture.png"), "image téléchargée par ticket : en pièce jointe");
process.exit(0);

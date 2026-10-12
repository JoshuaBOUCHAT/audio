import { readdirSync } from "node:fs";
import * as P from "/home/joshua/rust/audio/front/src/lib/protocol.ts";
import { chat } from "/home/joshua/rust/audio/front/src/proto/messages.js";
const BASE = "https://127.0.0.1:8444";
const DIR = process.argv[2];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (c: any, m: string) => { if (!c) { console.log("ÉCHEC", m); process.exit(1); } console.log("ok", m); };
const t = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
async function conn(n: number, pseudo: string) {
  const ws = new WebSocket("wss://127.0.0.1:8444");
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const c = new P.ProtocolClient(ws as any); const ev: any[] = []; c.onEvent((e) => ev.push(e));
  const auth = (await c.request(P.authRequest(t(n)))).authResponse!;
  await c.request(P.setPseudo(pseudo));
  return { c, ev, token: auth.sessionToken!, id: Number(auth.me!.id) };
}
function png(w: number, h: number, total: number) {
  const b = new Uint8Array(total);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  for (let i = 32; i < total; i++) b[i] = (i * 31) % 251;
  return b;
}
const up = (token: string | null, body: Uint8Array) => fetch(BASE + "/media", { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body });
const err = async (r: Response) => chat.Error.decode(new Uint8Array(await r.arrayBuffer()));
const files = () => readdirSync(DIR).filter((f) => f !== "tmp");

const A = await conn(1, "Léa"), B = await conn(2, "Bob");
let r = await up(null, png(10, 10, 100)); ok(r.status === 401, "envoi sans session : 401");
r = await up(A.token, new TextEncoder().encode("<svg onload=alert(1)></svg>")); ok(r.status === 201 && chat.MediaUploaded.decode(new Uint8Array(await r.arrayBuffer())).media!.mime === "application/octet-stream", "SVG : simple fichier, jamais affiché");
r = await up(A.token, png(20000, 10, 200)); ok(r.status === 201 && chat.MediaUploaded.decode(new Uint8Array(await r.arrayBuffer())).media!.mime === "application/octet-stream", "bombe de pixels : fichier, pas image affichée");
const big = png(1920, 1080, 3 * 1024 * 1024 + 123);
r = await up(A.token, big); ok(r.status === 201, "image de 3 Mo acceptée (corps en flux)");
const m1 = chat.MediaUploaded.decode(new Uint8Array(await r.arrayBuffer()));
ok(m1.media!.mime === "image/png" && m1.media!.width === 1920 && Number(m1.media!.size) === big.length, "métadonnées : PNG 1920×1080, taille exacte");
r = await fetch(BASE + "/media/" + m1.media!.id); ok(r.status === 401, "lecture sans session : 401");
r = await fetch(BASE + "/media/" + m1.media!.id, { headers: { Authorization: `Bearer ${B.token}` } });
const got = new Uint8Array(await r.arrayBuffer());
ok(r.status === 200 && got.length === big.length && got.every((v, i) => v === big[i]), "Bob relit l'image octet pour octet");
ok(r.headers.get("content-type") === "image/png" && Number(r.headers.get("x-media-owner")) === A.id, "type et propriétaire en en-tête");
const gif = new Uint8Array([...new TextEncoder().encode("GIF89a"), 0x40, 0x01, 0xf0, 0, 0, 0, 0, 0x3b]);
r = await up(B.token, gif); ok(r.status === 201, "GIF accepté");
r = await up(B.token, big); const m2 = chat.MediaUploaded.decode(new Uint8Array(await r.arrayBuffer()));
ok(m2.media!.id !== m1.media!.id && files().length === 4, "même contenu envoyé par Bob : nouvel id, un seul fichier (dédup)");
r = await up(A.token, png(10, 10, 2 * 1024 * 1024)); ok(r.status === 413, "quota dépassé : " + (await err(r)).message);
// suppression
let d = await B.c.request(P.deleteMedia(m1.media!.id)); ok(d.error?.code === 403, "Bob ne supprime pas l'image de Léa");
d = await A.c.request(P.deleteMedia(m1.media!.id)); await sleep(100);
ok(d.mediaDeleted && B.ev.some((e) => e.mediaDeleted?.mediaId === m1.media!.id), "Léa supprime : diffusé à Bob");
r = await fetch(BASE + "/media/" + m1.media!.id, { headers: { Authorization: `Bearer ${B.token}` } }); ok(r.status === 404, "image supprimée : 404");
ok(files().length === 4, "fichier gardé : encore désigné par l'image de Bob");
r = await fetch(BASE + "/media/" + m2.media!.id, { headers: { Authorization: `Bearer ${A.token}` } }); ok(r.status === 200, "l'image de Bob (même fichier) reste lisible");
await B.c.request(P.deleteMedia(m2.media!.id)); await sleep(50);
ok(files().length === 3, "dernière image du fichier supprimée : fichier effacé");
r = await up(A.token, png(10, 10, 2 * 1024 * 1024)); ok(r.status === 201, "quota rendu après suppression");
r = await fetch(BASE + "/media/../../etc/passwd", { headers: { Authorization: `Bearer ${A.token}` } }); ok(r.status === 404 || r.status === 400, "chemin hors media : refusé");
r = await fetch(BASE + "/media/" + "6f9619ff-8b86-4011-b42d-00c04fc964ff", { headers: { Authorization: `Bearer ${A.token}` } }); ok(r.status === 404, "id inconnu : 404");
const msg = (await A.c.request(P.createChannel("g"))).channelCreated; ok(msg, "le WebSocket marche toujours après les requêtes HTTP");
process.exit(0);

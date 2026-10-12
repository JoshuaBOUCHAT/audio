import * as P from "/home/joshua/rust/audio/front/src/lib/protocol.ts";
import { chat } from "/home/joshua/rust/audio/front/src/proto/messages.js";
const D = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (c: any, m: string) => { if (!c) { console.log("ÉCHEC", m); process.exit(1); } console.log("ok", m); };
const t = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
async function conn(n: number) {
  const ws = new WebSocket("wss://127.0.0.1:8444");
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const c = new P.ProtocolClient(ws as any); const ev: any[] = []; c.onEvent((e) => ev.push(e));
  const auth = (await c.request(P.authRequest(t(n)))).authResponse!;
  return { c, ev, ws, auth, id: Number(auth.me!.id) };
}
const pres = (o: any, id: number) => o.ev.filter((e: any) => e.presenceChanged && Number(e.presenceChanged.userId) === id).map((e: any) => e.presenceChanged.online);

const O = await conn(2); // observateur
const A = await conn(1);
await sleep(D / 2);
ok(pres(O, A.id).length === 0, "A connecté depuis D/2 : pas encore annoncé");
await sleep(D);
ok(JSON.stringify(pres(O, A.id)) === "[true]", "A annoncé en ligne après le délai");
ok(JSON.stringify(pres(A, A.id)) === "[true]", "A reçoit aussi sa propre annonce");

const B = await conn(3);
const r = await B.c.request(P.setStatus(chat.Status.INVISIBLE));
ok(r.statusSet?.status === chat.Status.INVISIBLE, "B passe invisible pendant le délai");
await sleep(D * 2);
ok(pres(O, B.id).length === 0, "B jamais annoncé");
const O2 = await conn(2);
const online = O2.auth.onlineUserIds.map(Number);
ok(online.includes(A.id) && !online.includes(B.id), "online_user_ids : A oui, B (invisible) non");
B.ws.close(); await sleep(100);
const B2 = await conn(3);
ok(B2.auth.me!.status === chat.Status.INVISIBLE, "statut invisible mémorisé");
await sleep(D * 2);
ok(pres(O, B.id).length === 0, "B reconnecté invisible : toujours pas annoncé");
await B2.c.request(P.setStatus(chat.Status.ONLINE)); await sleep(100);
ok(JSON.stringify(pres(O, B.id)) === "[true]", "B repasse en ligne : annoncé tout de suite");
await B2.c.request(P.setStatus(chat.Status.INVISIBLE)); await sleep(100);
ok(JSON.stringify(pres(O, B.id)) === "[true,false]", "B invisible : hors ligne tout de suite");

const A2 = await conn(1); A.ws.close(); await sleep(D * 2);
ok(JSON.stringify(pres(O, A.id)) === "[true]", "A ferme un onglet sur deux : reste en ligne");
A2.ws.close(); await sleep(D / 2);
const A3 = await conn(1); await sleep(D * 2);
ok(JSON.stringify(pres(O, A.id)) === "[true]", "A se reconnecte pendant le délai : ni hors ligne, ni nouvelle attente");
A3.ws.close(); await sleep(D / 2);
ok(JSON.stringify(pres(O, A.id)) === "[true]", "A déconnecté depuis D/2 : encore en ligne");
await sleep(D);
ok(JSON.stringify(pres(O, A.id)) === "[true,false]", "A hors ligne après le délai");
const A4 = await conn(1); A4.ws.close(); await sleep(D * 2);
ok(JSON.stringify(pres(O, A.id)) === "[true,false]", "connexion plus courte que le délai : jamais annoncé");
process.exit(0);

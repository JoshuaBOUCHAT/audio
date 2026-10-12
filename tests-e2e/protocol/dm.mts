import * as P from "/home/joshua/rust/audio/front/src/lib/protocol.ts";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (c: any, m: string) => { if (!c) { console.log("ÉCHEC", m); process.exit(1); } console.log("ok", m); };
const t = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
async function conn(n: number, pseudo?: string) {
  const ws = new WebSocket("wss://127.0.0.1:8444");
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const c = new P.ProtocolClient(ws as any); const ev: any[] = []; c.onEvent((e) => ev.push(e));
  const auth = (await c.request(P.authRequest(t(n)))).authResponse!;
  if (pseudo) await c.request(P.setPseudo(pseudo));
  return { c, ev, ws, auth, id: Number(auth.me!.id) };
}
const kinds = (x: any) => x.ev.filter((e: any) => e.payload !== "presenceChanged" && e.payload !== "userUpdated").map((e: any) => e.payload);
const A = await conn(1, "Admin"), B = await conn(2, "Bob"), C = await conn(3, "Cléo");
const A2 = await conn(1);
await A.c.request(P.createChannel("général"));
const nobody = await conn(4); await sleep(100); for (const x of [A, B, C, A2]) x.ev.length = 0;
let r = await A.c.request(P.openDm(A.id)); ok(r.error?.code === 400, "DM avec soi-même : 400");
r = await A.c.request(P.openDm(nobody.id)); ok(r.error?.code === 404, "DM avec un compte sans pseudo : 404");
r = await A.c.request(P.openDm(2 ** 40)); ok(r.error?.code === 404, "DM avec un id hors borne : 404");

const ab = (await A.c.request(P.openDm(B.id))).dmOpened!.conversation!;
const abId = Number(ab.channel!.id);
ok(ab.channel!.participantIds.map(Number).sort().join() === [A.id, B.id].sort().join() && Number(ab.lastMessageId) === 0, "A ouvre un DM avec B (vide)");
await sleep(100);
ok(kinds(B).length === 0, "B ne voit rien tant qu'aucun message");
ok(kinds(A2).includes("dmOpened"), "l'autre onglet de A le reçoit");
ok(Number((await A.c.request(P.openDm(B.id))).dmOpened!.conversation!.channel!.id) === abId, "rouvrir : même DM");
ok(Number((await B.c.request(P.openDm(A.id))).dmOpened!.conversation!.channel!.id) === abId, "B ouvre vers A : même DM");

const ac = (await A.c.request(P.openDm(C.id))).dmOpened!.conversation!; const acId = Number(ac.channel!.id);
C.ev.length = 0; B.ev.length = 0;
const m1 = (await A.c.request(P.sendMessage(acId, "salut Cléo"))).newMessage!.message!;
await sleep(100);
ok(kinds(C).join() === "dmOpened,newMessage", "C découvre le DM puis le message, dans cet ordre");
ok(Number(C.ev.find((e: any) => e.dmOpened).dmOpened.conversation.lastMessageId) === Number(m1.id), "conversation révélée avec son dernier message");
ok(kinds(B).length === 0, "B (non participant) ne reçoit rien");
r = await C.c.request(P.sendMessage(acId, "coucou")); await sleep(100);
ok(kinds(C).filter((k: string) => k === "dmOpened").length === 1, "pas de nouvelle révélation au 2e message");

// B ↔ C : l'admin A ne voit rien
const bc = Number((await B.c.request(P.openDm(C.id))).dmOpened!.conversation!.channel!.id);
A.ev.length = 0; A2.ev.length = 0;
const secret = (await B.c.request(P.sendMessage(bc, "secret"))).newMessage!.message!;
await sleep(100);
ok(kinds(A).length === 0 && kinds(A2).filter((k: string) => k === "newMessage").length === 0, "admin non participant : rien reçu");
ok((await A.c.request(P.syncRequest(bc, 0))).error?.code === 404, "admin : sync d'un DM des autres → 404");
ok((await A.c.request(P.sendMessage(bc, "x"))).error?.code === 404, "admin : envoi → 404");
ok((await A.c.request(P.deleteMessage(bc, Number(secret.id)))).error?.code === 404, "admin : suppression → 404");
ok((await A.c.request(P.editMessage(bc, Number(secret.id), "x"))).error?.code === 404, "admin : modification → 404");
const cMsg = (await C.c.request(P.sendMessage(acId, "à moi"))).newMessage!.message!;
r = await A.c.request(P.deleteMessage(acId, Number(cMsg.id)));
ok(r.error?.code === 403, "admin participant : ne supprime pas le message de l'autre (" + r.error?.message + ")");
r = await A.c.request(P.sendMessage(acId, "réponse", Number(cMsg.id)));
ok(r.newMessage, "réponse dans un DM");
ok((await A.c.request(P.sendMessage(acId, "x", Number(secret.id)))).error?.code === 404, "citer un message d'un autre DM : 404");

const B2 = await conn(2), C2 = await conn(3), A3 = await conn(1);
const ids = (x: any) => x.auth.dms.map((d: any) => Number(d.channel.id)).sort().join();
ok(ids(B2) === [abId, bc].sort().join(), "B : ses DM (A-B ouvert par lui, B-C)");
ok(ids(C2) === [acId, bc].sort().join(), "C : A-C (révélé) et B-C (révélé)");
ok(ids(A3) === [abId, acId].sort().join(), "A : ses deux DM, pas B-C");
ok(A3.auth.channels.length === 1, "les DM ne sont pas dans la liste des salons");
const last = Number(C2.auth.dms.find((d: any) => Number(d.channel.id) === acId).lastMessageId);
ok(last === Number(r.newMessage!.message!.id), "dernier message du DM pour le tri");
process.exit(0);

const FRONT = "/home/joshua/rust/audio/front";
const { createServer } = await import(FRONT + "/node_modules/vite/dist/node/index.js");
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {} }), location: { origin: "x" }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { hidden: false, hasFocus: () => false, addEventListener() {}, removeEventListener() {}, documentElement: { classList: { toggle() {} }, style: {} } };
const vite = await createServer({ root: FRONT, configFile: FRONT + "/vite.config.ts", server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { ChatStore } = await vite.ssrLoadModule("/src/chat/store.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, what, ms = 8000) { for (let t = 0; t < ms; t += 25) { if (f()) return; await sleep(25); } console.log("ÉCHEC (timeout)", what); process.exit(1); }
const ok = (c, m) => { if (!c) { console.log("ÉCHEC", m); process.exit(1); } console.log("ok", m); };
const s = (x) => x.getSnapshot();
const A = new ChatStore("00000000-0000-0000-0000-000000000001"); A.start(); await until(() => s(A).phase === "pseudo", "A"); await A.setPseudo("Léa");
await A.createChannel("g"); const ch = s(A).channels[0].id;
const sent = [];
for (let i = 0; i < 150; i++) { await A.send(ch, "m" + i); }
const B = new ChatStore("00000000-0000-0000-0000-000000000002"); B.start(); await until(() => s(B).phase === "pseudo", "B"); await B.setPseudo("Bob");
B.open(ch); await until(() => s(B).messages[ch], "première page");
const msgs = () => s(B).messages[ch];
ok(msgs().length === 64 && msgs().at(-1).content === "m149" && s(B).history[ch].hasMore, "ouverture : 64 derniers messages, il en reste");
await B.loadOlder(ch);
ok(msgs().length === 128 && msgs()[0].content === "m22" && s(B).history[ch].hasMore, "page précédente : 128 contigus");
const firstReal = msgs()[0].id - 22;
await B.loadOlder(ch);
ok(msgs().length === 150 && msgs()[0].content === "m0" && !s(B).history[ch].hasMore, "début atteint : 150, plus rien à charger");
await B.loadOlder(ch); ok(msgs().length === 150, "charger encore : sans effet");
const ids = msgs().map((m) => m.id); ok(ids.every((id, i) => i === 0 || id > ids[i - 1]), "ordre et aucun doublon");
// citation d'un original ancien
const C = new ChatStore("00000000-0000-0000-0000-000000000003"); C.start(); await until(() => s(C).phase === "pseudo", "C"); await C.setPseudo("Cléo");
C.open(ch); await until(() => s(C).messages[ch], "C page");
ok(await C.loadUntil(ch, ids[5]) && s(C).messages[ch].some((m) => m.id === ids[5]), "aller à un message ancien : pages chargées jusqu'à lui");
ok(!(await C.loadUntil(ch, 999999999)), "message inexistant : échec propre");
await A.send(ch, "nouveau"); await until(() => msgs().at(-1).content === "nouveau", "temps réel");
ok(msgs().length === 151, "nouveau message ajouté en bas, historique gardé");
for (const x of [A, B, C]) x.dispose(); await vite.close(); process.exit(0);

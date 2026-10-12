import { execSync } from "node:child_process";
const FRONT = "/home/joshua/rust/audio/front";
const { createServer } = await import(FRONT + "/node_modules/vite/dist/node/index.js");
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
const vite = await createServer({ root: FRONT, configFile: FRONT + "/vite.config.ts", server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { ChatStore } = await vite.ssrLoadModule("/src/chat/store.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, what, ms = 20000) { for (let t = 0; t < ms; t += 50) { if (f()) return; await sleep(50); } console.log("ÉCHEC (timeout)", what); process.exit(1); }
const ok = (c, m) => { if (!c) { console.log("ÉCHEC", m); process.exit(1); } console.log("ok", m); };
const s = (x) => x.getSnapshot();
const ADMIN = "00000000-0000-0000-0000-000000000001";
const restart = (wipe) => {
  execSync(`kill -TERM $(pgrep -f "AUDIO_TEST_MARK") 2>/dev/null; true`);
};
const A = new ChatStore(null); A.start();
await until(() => s(A).phase === "login", "login");
await A.login(ADMIN); await A.setPseudo("Léa");
await A.createChannel("ancien"); const ch = s(A).channels[0].id;
A.open(ch); await until(() => s(A).messages[ch], "sync");
await A.send(ch, "message de l'ancienne base");
await A.setAvatar(Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]));
A.ensureAvatar(s(A).me.id); await until(() => s(A).avatars[s(A).me.id], "photo en cache");
ok(s(A).messages[ch].length === 1, "ancienne base : 1 message, photo en cache");
// ancienne base effacée, serveur relancé
process.send?.("restart");
console.log("RESTART"); await until(() => s(A).phase === "login" || s(A).phase === "pseudo", "session perdue avec la base");
ok(true, "session de l'ancienne base refusée → " + s(A).phase);
await A.login(ADMIN);
ok(s(A).phase === "pseudo", "nouveau compte dans la nouvelle base");
await A.setPseudo("Léa"); await A.createChannel("nouveau");
const ch2 = s(A).channels[0].id;
console.log("ids : ancien salon", ch, "nouveau salon", ch2);
A.open(ch2); await until(() => s(A).messages[ch2], "sync nouveau salon"); await sleep(200);
ok(s(A).messages[ch2].length === 0, "plus aucun message de l'ancienne base");
ok(Object.keys(s(A).avatars).length === 0, "cache photo vidé");
A.dispose(); await vite.close(); process.exit(0);

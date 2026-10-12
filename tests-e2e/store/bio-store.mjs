const FRONT = "/home/joshua/rust/audio/front";
const { createServer } = await import(FRONT + "/node_modules/vite/dist/node/index.js");
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
const vite = await createServer({ root: FRONT, configFile: FRONT + "/vite.config.ts", server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { ChatStore } = await vite.ssrLoadModule("/src/chat/store.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, what, ms = 5000) { for (let t = 0; t < ms; t += 25) { if (f()) return; await sleep(25); } console.log("ÉCHEC (timeout)", what); process.exit(1); }
const ok = (c, m) => { if (!c) { console.log("ÉCHEC", m); process.exit(1); } console.log("ok", m); };
const s = (x) => x.getSnapshot();
const t = (n) => `00000000-0000-0000-0000-00000000000${n}`;
async function user(n, pseudo) { const x = new ChatStore(t(n)); x.start(); await until(() => s(x).phase === "pseudo", pseudo); await x.setPseudo(pseudo); return x; }
const A = await user(1, "Léa"), B = await user(2, "Bob");
const aId = s(A).me.id;
ok(await A.setBio("  Fan de radix\net de café ☕  ") && s(A).me.bio === "Fan de radix\net de café ☕", "description trimée, multiligne, emoji");
await until(() => s(B).users[aId]?.bio === "Fan de radix\net de café ☕", "Bob la reçoit");
ok(true, "Bob reçoit la description en direct");
ok(!(await A.setBio("x".repeat(191))) && s(A).error, "191 caractères refusés : " + s(A).error); A.clearError();
ok(!(await A.setBio("a\tb")) && s(A).error, "tabulation refusée"); A.clearError();
B.dispose();
const B2 = new ChatStore(t(2)); B2.start(); await until(() => s(B2).phase === "ready", "B2");
ok(s(B2).users[aId].bio === "Fan de radix\net de café ☕", "description persistée (AuthResponse.users)");
ok(await A.setBio(""), "retirer la description"); await until(() => s(B2).users[aId].bio === "", "retrait diffusé"); ok(true, "retrait diffusé");
A.dispose(); B2.dispose(); await vite.close(); process.exit(0);

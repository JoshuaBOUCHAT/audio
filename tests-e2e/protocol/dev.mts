import * as P from "/home/joshua/rust/audio/front/src/lib/protocol.ts";
const ok = (c: any, m: string) => { if (!c) { console.log("ÉCHEC", m); process.exit(1); } console.log("ok", m); };
async function auth(token: string) {
  const ws = new WebSocket("wss://127.0.0.1:8443");
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const r = await new P.ProtocolClient(ws as any).request(P.authRequest(token)); ws.close(); return r;
}
const t = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const a1 = await auth(t(1)), a1b = await auth(t(1));
ok(a1.authResponse?.me?.isAdmin && a1.authResponse.me.email === "admin@x.fr", "token 1 = admin du bootstrap");
ok(a1b.authResponse && String(a1b.authResponse.me!.id) === String(a1.authResponse!.me!.id), "token 1 réutilisable, même compte");
ok(a1.authResponse!.sessionToken !== a1b.authResponse!.sessionToken, "une session par connexion");
const a2 = await auth(t(2));
ok(!a2.authResponse?.me?.isAdmin && a2.authResponse?.me?.email === "dev2@dev.local", "token 2 = dev2@dev.local");
ok((await auth(t(10))).error?.code === 401 && (await auth(t(0))).error?.code === 401, "tokens 0 et 10 refusés");
process.exit(0);

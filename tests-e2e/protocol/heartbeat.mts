import { WebSocket } from "/home/joshua/rust/audio/front/node_modules/ws/wrapper.mjs";
const ok = (c: any, m: string) => { if (!c) { console.log("ÉCHEC", m); process.exit(1); } console.log("ok", m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open = (autoPong: boolean) => new Promise<{ ws: WebSocket; closed: () => boolean; pings: () => number }>((resolve) => {
  const ws = new WebSocket("wss://127.0.0.1:8444", { rejectUnauthorized: false, autoPong });
  let closed = false, pings = 0;
  ws.on("ping", () => pings++); ws.on("close", () => (closed = true));
  ws.on("open", () => resolve({ ws, closed: () => closed, pings: () => pings }));
});
const alive = await open(true), dead = await open(false);
await sleep(250);
ok(alive.pings() >= 1 && dead.pings() >= 1, "le serveur pingue toutes les connexions, même non authentifiées");
await sleep(450); // > 3 intervalles de 200 ms
ok(dead.closed(), "connexion qui ne répond pas aux pings : fermée par le serveur");
ok(!alive.closed(), "connexion qui répond (pong automatique) : gardée");
await sleep(600); ok(!alive.closed(), "toujours gardée bien après");
process.exit(0);

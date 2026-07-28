// Test d'intégration bout-en-bout du protocole, pas un test unitaire : valide qu'un
// ClientEnvelope encodé côté JS est bien décodé côté Rust et que la réponse repasse
// par le même chemin dans l'autre sens. Découplé de src/lib/protocol.ts — ce script
// se contente d'utiliser l'outil, pas de le construire (voir CLAUDE.md discussion).
//
// Prérequis : le back-end tourne (cargo run, écoute wss://127.0.0.1:8443).
// Lancement : npm run test:proto

import { WebSocket } from "ws";
import { ProtocolClient, requestMagicLink } from "../src/lib/protocol.ts";

const BACK_END_URL = process.env.BACK_END_URL ?? "wss://127.0.0.1:8443";

function connect(): Promise<WebSocket> {
  // rejectUnauthorized: false — certs/ contient un cert auto-signé de dev (cf.
  // back-end/src/main.rs), pas une CA reconnue.
  const socket = new WebSocket(BACK_END_URL, { rejectUnauthorized: false });
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", (event) => reject(event), { once: true });
  });
}

async function test_requestMagicLink(): Promise<void> {
  const socket = await connect();
  const client = new ProtocolClient(socket);

  const response = await client.request(requestMagicLink("ping-pong@example.test"));

  if (response.payload !== "magicLinkSent") {
    throw new Error(
      `attendu payload "magicLinkSent", reçu "${response.payload}" — ${JSON.stringify(response)}`,
    );
  }

  socket.close();
  console.log("OK test_requestMagicLink");
}

await test_requestMagicLink();

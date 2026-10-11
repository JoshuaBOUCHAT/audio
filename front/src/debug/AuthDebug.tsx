// Page de debug du flow d'auth (zéro CSS) : RequestMagicLink → token copié depuis les
// logs serveur → AuthRequest → AuthResponse brute. Accessible sur /debug.

import { useState } from "react"
import { ProtocolClient, authRequest, requestMagicLink } from "@/lib/protocol"

const BACK_END_URL = "wss://127.0.0.1:8443"

// Une connexion WS neuve par requête : l'auth étant liée à la connexion, ça permet
// aussi de rejouer une reprise de session (session_token) sur un WS vierge.
function connect(): Promise<{ socket: WebSocket; client: ProtocolClient }> {
  const socket = new WebSocket(BACK_END_URL)
  const client = new ProtocolClient(socket)
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve({ socket, client }), { once: true })
    socket.addEventListener("error", () => reject(new Error(
      `connexion à ${BACK_END_URL} impossible — back-end lancé ? cert auto-signé accepté sur https://127.0.0.1:8443 ?`,
    )), { once: true })
  })
}

export function AuthDebug() {
  const [email, setEmail] = useState("")
  const [token, setToken] = useState("")
  const [output, setOutput] = useState("")

  async function send(payload: Parameters<ProtocolClient["request"]>[0]) {
    try {
      const { socket, client } = await connect()
      const response = await client.request(payload)
      socket.close()
      setOutput(JSON.stringify(response.toJSON(), null, 2))
    } catch (e) {
      setOutput(String(e))
    }
  }

  return (
    <div>
      <h1>Debug auth</h1>

      <form onSubmit={(e) => { e.preventDefault(); void send(requestMagicLink(email)) }}>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
        <button type="submit">RequestMagicLink</button>
      </form>

      <form onSubmit={(e) => { e.preventDefault(); void send(authRequest(token.trim())) }}>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="token (lien magique ou session)"
          size={40}
        />
        <button type="submit">AuthRequest</button>
      </form>

      <pre>{output}</pre>
    </div>
  )
}

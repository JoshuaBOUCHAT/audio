// Page de debug (zéro CSS) : RequestMagicLink → token copié depuis les logs serveur →
// AuthRequest → CreateChannel / SendMessage / SyncRequest / DeleteMessage, réponses et broadcasts reçus bruts. Accessible sur
// /debug (ouvrir deux onglets pour voir un broadcast passer de l'un à l'autre).

import { useRef, useState } from "react"
import {
  ProtocolClient,
  authRequest,
  createChannel,
  deleteMessage,
  requestMagicLink,
  sendMessage,
  syncRequest,
} from "@/lib/protocol"
import { BACK_END_URL } from "@/lib/config"

type Connection = { socket: WebSocket; client: ProtocolClient }

function connect(onEvent: (json: string) => void): Promise<Connection> {
  const socket = new WebSocket(BACK_END_URL)
  const client = new ProtocolClient(socket)
  client.onEvent((envelope) => onEvent(JSON.stringify(envelope.toJSON())))
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
  const [channelName, setChannelName] = useState("")
  const [channelId, setChannelId] = useState("")
  const [content, setContent] = useState("")
  const [messageId, setMessageId] = useState("")
  const [output, setOutput] = useState("")
  const [events, setEvents] = useState<string[]>([])
  // L'auth est liée à la connexion WS (story 33) : une seule connexion réutilisée
  // pour toutes les requêtes, « Nouvelle connexion » pour repartir d'un WS vierge
  // (ex. tester une reprise de session avec le session_token).
  const connection = useRef<Connection | null>(null)

  async function send(payload: Parameters<ProtocolClient["request"]>[0]) {
    try {
      if (connection.current?.socket.readyState !== WebSocket.OPEN) {
        connection.current = await connect((json) => setEvents((prev) => [...prev, json]))
      }
      const response = await connection.current.client.request(payload)
      setOutput(JSON.stringify(response.toJSON(), null, 2))
    } catch (e) {
      setOutput(String(e))
    }
  }

  function reconnect() {
    connection.current?.socket.close()
    connection.current = null
    setOutput("connexion fermée — la prochaine requête ouvre un WS vierge (non authentifié)")
  }

  return (
    <div>
      <h1>Debug auth</h1>

      <button type="button" onClick={reconnect}>Nouvelle connexion</button>

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

      <form onSubmit={(e) => { e.preventDefault(); void send(createChannel(channelName)) }}>
        <input
          value={channelName}
          onChange={(e) => setChannelName(e.target.value)}
          placeholder="nom du salon"
        />
        <button type="submit">CreateChannel</button>
      </form>

      <form onSubmit={(e) => { e.preventDefault(); void send(sendMessage(Number(channelId), content)) }}>
        <input
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          placeholder="id du salon"
          size={8}
        />
        <input value={content} onChange={(e) => setContent(e.target.value)} placeholder="message" />
        <button type="submit">SendMessage</button>
        <button type="button" onClick={() => void send(syncRequest(Number(channelId), 0))}>
          SyncRequest (depuis 0)
        </button>
      </form>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void send(deleteMessage(Number(channelId), Number(messageId)))
        }}
      >
        <input
          value={messageId}
          onChange={(e) => setMessageId(e.target.value)}
          placeholder="id du message"
          size={8}
        />
        <button type="submit">DeleteMessage (salon ci-dessus)</button>
      </form>

      <pre>{output}</pre>

      <h2>Broadcasts reçus</h2>
      <pre>{events.join("\n")}</pre>
    </div>
  )
}

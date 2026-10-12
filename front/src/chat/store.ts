// État du client et cycle de vie de la connexion, hors de React (lu via
// useSyncExternalStore) : une seule connexion WS par onglet, qui survit aux re-rendus
// et au double montage de StrictMode.
//
// L'auth est liée à la connexion (story 33) : chaque nouveau WS rejoue AuthRequest
// avec le token de session, puis resync depuis 0 les salons déjà chargés (story 15 —
// seul moyen de voir les suppressions survenues pendant la coupure).

import { BACK_END_URL } from "@/lib/config"
import {
  ProtocolClient,
  authRequest,
  createChannel,
  deleteMessage,
  requestMagicLink,
  sendMessage,
  syncRequest,
  type ClientEnvelopeShape,
  type ServerEnvelope,
} from "@/lib/protocol"
import {
  isTextChannel,
  mergeMessages,
  toChannel,
  toMe,
  toMessage,
  toNumber,
  type ChatChannel,
  type ChatMessage,
  type Me,
} from "./model"
import { clearSessionToken, loadSessionToken, saveSessionToken } from "./session"

export type Phase =
  | "connecting" // premier WS en cours d'ouverture
  | "login" // connecté, pas de session : écran de login
  | "authenticating" // AuthRequest envoyé
  | "ready"
  | "offline" // WS fermé, reconnexion programmée (story 17)

export type ChatState = {
  phase: Phase
  me: Me | null
  channels: ChatChannel[]
  /** Messages par salon ; absent = salon jamais synchronisé. */
  messages: Record<number, ChatMessage[]>
  /** Dernière erreur à afficher (réponse Error du serveur ou échec réseau). */
  error: string | null
  /** RequestMagicLink accepté : le lien a été émis côté serveur. */
  linkSent: boolean
}

const INITIAL: ChatState = {
  phase: "connecting",
  me: null,
  channels: [],
  messages: {},
  error: null,
  linkSent: false,
}

const RECONNECT_MAX_MS = 10_000

export class ChatStore {
  private state: ChatState = INITIAL
  private readonly listeners = new Set<() => void>()
  private socket: WebSocket | null = null
  private client: ProtocolClient | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 500
  private disposed = false
  /** Token de lien magique lu dans l'URL, consommé à la première connexion. */
  private pendingMagicToken: string | null

  constructor(magicToken: string | null) {
    this.pendingMagicToken = magicToken
  }

  // --- useSyncExternalStore ---

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ChatState => this.state

  private set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  // --- cycle de vie ---

  start(): void {
    this.disposed = false
    if (!this.socket) this.connect()
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close()
    this.socket = null
    this.client = null
  }

  private connect(): void {
    const socket = new WebSocket(BACK_END_URL)
    const client = new ProtocolClient(socket)
    this.socket = socket
    this.client = client
    client.onEvent((envelope) => this.onEvent(envelope))

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return
      this.reconnectDelay = 500
      void this.authenticate()
    })
    socket.addEventListener("close", () => {
      client.failPending(new Error("connexion fermée"))
      if (this.socket !== socket) return
      this.socket = null
      this.client = null
      if (this.disposed) return
      this.set({ phase: this.state.me ? "offline" : "connecting" })
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    })
  }

  /** Lien magique de l'URL en priorité, sinon session stockée, sinon écran de login. */
  private async authenticate(): Promise<void> {
    const magic = this.pendingMagicToken
    this.pendingMagicToken = null
    const token = magic ?? loadSessionToken()
    if (!token) {
      this.set({ phase: "login" })
      return
    }
    await this.login(token, magic !== null)
  }

  private async request(payload: ClientEnvelopeShape): Promise<ServerEnvelope | null> {
    if (!this.client) {
      this.set({ error: "hors ligne" })
      return null
    }
    try {
      const response = await this.client.request(payload)
      if (response.payload === "error") {
        this.set({ error: response.error?.message ?? "erreur serveur" })
        return null
      }
      return response
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  // --- actions ---

  clearError = (): void => this.set({ error: null })

  requestLink = async (email: string): Promise<void> => {
    this.set({ error: null, linkSent: false })
    const response = await this.request(requestMagicLink(email))
    if (response) this.set({ linkSent: true })
  }

  /** `fromLoginScreen` : un token refusé reste sur l'écran de login avec l'erreur. */
  login = async (token: string, fromLoginScreen = true): Promise<void> => {
    const client = this.client
    if (!client) return
    this.set({ phase: "authenticating", error: null })
    let response: ServerEnvelope
    try {
      response = await client.request(authRequest(token))
    } catch {
      return // WS fermé pendant l'auth : la reconnexion rejouera le token stocké
    }
    const auth = response.authResponse
    if (!auth) {
      // Refus explicite du serveur (lien expiré/consommé, session inconnue) : on ne
      // rejoue pas un token de session mort à chaque reconnexion.
      if (!fromLoginScreen) clearSessionToken()
      this.set({ phase: "login", error: response.error?.message ?? "authentification refusée" })
      return
    }
    saveSessionToken(auth.sessionToken ?? "")
    const loaded = Object.keys(this.state.messages).map(Number)
    this.set({
      phase: "ready",
      me: toMe(auth.me),
      channels: (auth.channels ?? []).filter(isTextChannel).map(toChannel),
      linkSent: false,
    })
    // Reconnexion : resync complète des salons déjà ouverts.
    for (const id of loaded) void this.sync(id)
  }

  logout = (): void => {
    clearSessionToken()
    // La connexion reste authentifiée côté serveur : on repart d'un WS vierge.
    this.state = INITIAL
    this.socket?.close()
  }

  /** Charge un salon à sa première ouverture ; ensuite les broadcasts le tiennent à jour. */
  open = (channelId: number): void => {
    if (!(channelId in this.state.messages)) void this.sync(channelId)
  }

  private async sync(channelId: number): Promise<void> {
    const response = await this.request(syncRequest(channelId, 0))
    const sync = response?.syncResponse
    if (!sync) return
    const synced = (sync.messages ?? []).map(toMessage)
    this.setMessages(channelId, (current) => mergeMessages(current, synced))
  }

  send = async (channelId: number, content: string): Promise<boolean> => {
    const response = await this.request(sendMessage(channelId, content))
    const message = response?.newMessage?.message
    if (!message) return false
    this.addMessage(toMessage(message))
    return true
  }

  remove = async (channelId: number, messageId: number): Promise<void> => {
    const response = await this.request(deleteMessage(channelId, messageId))
    if (response?.messageDeleted) this.markDeleted(channelId, messageId)
  }

  createChannel = async (name: string): Promise<boolean> => {
    const response = await this.request(createChannel(name))
    const channel = response?.channelCreated?.channel
    if (!channel) return false
    this.addChannel(toChannel(channel))
    return true
  }

  // --- broadcasts ---

  private onEvent(envelope: ServerEnvelope): void {
    switch (envelope.payload) {
      case "newMessage":
        if (envelope.newMessage?.message) this.addMessage(toMessage(envelope.newMessage.message))
        break
      case "messageDeleted": {
        const d = envelope.messageDeleted
        if (d) this.markDeleted(toNumber(d.channelId), toNumber(d.messageId))
        break
      }
      case "channelCreated": {
        const channel = envelope.channelCreated?.channel
        if (channel && isTextChannel(channel)) this.addChannel(toChannel(channel))
        break
      }
    }
  }

  private setMessages(channelId: number, update: (current: ChatMessage[]) => ChatMessage[]): void {
    const current = this.state.messages[channelId] ?? []
    this.set({ messages: { ...this.state.messages, [channelId]: update(current) } })
  }

  /** Un salon jamais ouvert n'est pas tenu en mémoire : sa sync le chargera en entier. */
  private addMessage(message: ChatMessage): void {
    if (!(message.channelId in this.state.messages)) return
    this.setMessages(message.channelId, (current) => mergeMessages(current, [message]))
  }

  private markDeleted(channelId: number, messageId: number): void {
    if (!(channelId in this.state.messages)) return
    this.setMessages(channelId, (current) =>
      current.map((m) => (m.id === messageId ? { ...m, deleted: true, content: "" } : m)),
    )
  }

  private addChannel(channel: ChatChannel): void {
    if (this.state.channels.some((c) => c.id === channel.id)) return
    this.set({ channels: [...this.state.channels, channel].sort((a, b) => a.id - b.id) })
  }
}

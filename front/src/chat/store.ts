// État du client et cycle de vie de la connexion, hors de React (lu via
// useSyncExternalStore) : une seule connexion WS par onglet, qui survit aux re-rendus
// et au double montage de StrictMode.
//
// L'auth est liée à la connexion (story 33) : chaque nouveau WS rejoue AuthRequest
// avec le token de session, puis resync depuis 0 les salons déjà chargés (story 15 —
// seul moyen de voir les suppressions survenues pendant la coupure).

import { BACK_END_URL, MEDIA_BASE } from "@/lib/config"
import {
  ProtocolClient,
  authRequest,
  createChannel,
  deleteMedia,
  deleteMessage,
  editMessage,
  getMedia,
  requestDownload,
  openDm,
  getAvatar,
  requestMagicLink,
  sendMessage,
  setAvatar,
  setBio,
  setPseudo,
  setStatus,
  syncRequest,
  type ClientEnvelopeShape,
  type ServerEnvelope,
} from "@/lib/protocol"
import {
  isTextChannel,
  mergeMessages,
  toChannel,
  toConversation,
  toMediaInfo,
  toMe,
  toMessage,
  toNumber,
  toProfile,
  type ChatChannel,
  type ChatMessage,
  type Conversation,
  type Me,
  type MediaInfo,
  type Profile,
} from "./model"
import { chat } from "@/proto/messages.js"
import { clearSessionToken, loadSessionToken, saveSessionToken } from "./session"

export type Phase =
  | "connecting" // premier WS en cours d'ouverture
  | "login" // connecté, pas de session : écran de login
  | "authenticating" // AuthRequest envoyé
  | "ready"
  | "pseudo" // authentifié sans pseudo : choix obligatoire (story 34)
  | "offline" // WS fermé, reconnexion programmée (story 17)

export type MediaEntry =
  | { status: "loading" }
  /**
   * Métadonnées connues ; `url` : image chargée (story 27) ou adresse de lecture d'une
   * vidéo (ticket, story 54) — jamais pour un fichier.
   */
  | { status: "ready"; info: MediaInfo; url?: string }
  /** Supprimé pour tout le monde (story 50) ou inconnu. */
  | { status: "missing" }

export type ChatState = {
  phase: Phase
  me: Me | null
  channels: ChatChannel[]
  /** Stories 28-30 : mes conversations privées (non triées, cf. `byLastActivity`). */
  dms: Conversation[]
  /** Profils publics par id (story 36), `me` compris. */
  users: Record<number, Profile>
  /** Story 23 : ids vus en ligne par les autres (délais et invisibles appliqués par le serveur). */
  online: ReadonlySet<number>
  /** Images (story 27) chargées ou en cours, par id. */
  media: Record<string, MediaEntry>
  /** Confirmation brève (« Lien copié »), effacée seule. */
  toast: string | null
  /** Photos chargées : object URL de la version connue (story 36). */
  avatars: Record<number, { version: number; url: string }>
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
  dms: [],
  users: {},
  online: new Set(),
  media: {},
  toast: null,
  avatars: {},
  messages: {},
  error: null,
  linkSent: false,
}

const RECONNECT_MAX_MS = 10_000

/** Story 23 : vu par les autres. Pour soi, on suit son propre choix (story 41). */
export function isShownOnline(state: ChatState, userId: number): boolean {
  if (userId === state.me?.id) return !state.me.invisible
  return state.online.has(userId)
}

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
  /** Clés `id:version` des photos en cours de chargement. */
  private readonly avatarRequests = new Set<string>()
  /** Token de la session courante : authentifie les requêtes HTTP d'images (story 48). */
  private sessionToken: string | null = null
  /** Ids dont les métadonnées sont à demander, envoyés en un seul `GetMedia`. */
  private mediaQueue = new Set<string>()
  private toastTimer: ReturnType<typeof setTimeout> | null = null

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
    this.sessionToken = auth.sessionToken ?? null
    const me = toMe(auth.me)
    const users: Record<number, Profile> = {}
    for (const p of auth.users ?? []) users[toNumber(p.id)] = toProfile(p)
    const channels = (auth.channels ?? []).filter(isTextChannel).map(toChannel)
    const dms = (auth.dms ?? []).map((c) => toConversation(c, me.id))

    // Tout ce qui précède cette auth est périmé : le serveur a pu redémarrer sur une
    // autre base, où les mêmes ids (compteur global) désignent d'autres salons,
    // messages et photos. On ne garde que les salons ouverts qui existent encore,
    // pour le même compte, le temps que leur resync les remplace.
    const sameAccount = this.state.me?.id === me.id
    const kept: Record<number, ChatMessage[]> = {}
    if (sameAccount) {
      for (const { id } of [...channels, ...dms]) {
        if (this.state.messages[id]) kept[id] = this.state.messages[id]
      }
    }
    // Les versions de photo viennent du même compteur : cache vidé, rechargé à la demande.
    for (const { url } of Object.values(this.state.avatars)) URL.revokeObjectURL(url)
    this.avatarRequests.clear()

    this.set({
      phase: me.pseudo ? "ready" : "pseudo",
      me,
      users,
      channels,
      dms,
      online: new Set((auth.onlineUserIds ?? []).map(toNumber)),
      messages: kept,
      avatars: {},
      linkSent: false,
    })
    // Reconnexion : resync complète des salons encore ouverts.
    for (const id of Object.keys(kept).map(Number)) void this.sync(id)
  }

  logout = (): void => {
    clearSessionToken()
    this.sessionToken = null
    for (const entry of Object.values(this.state.media)) {
      if (entry.status === "ready" && entry.url?.startsWith("blob:")) URL.revokeObjectURL(entry.url)
    }
    for (const { url } of Object.values(this.state.avatars)) URL.revokeObjectURL(url)
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
    // Resync depuis 0 = état complet du salon : il remplace la copie locale (pas de
    // fusion, qui garderait des messages disparus du serveur). Un broadcast reçu avant
    // cette réponse a été traité avant elle côté serveur (même file d'envoi), donc il
    // y est déjà ; ceux qui suivent se fusionnent normalement.
    const synced = (sync.messages ?? []).map(toMessage)
    this.setMessages(channelId, () => synced)
  }

  /** `replyToId` : message cité (story 39), 0 = pas une réponse. */
  send = async (channelId: number, content: string, replyToId = 0): Promise<boolean> => {
    const response = await this.request(sendMessage(channelId, content, replyToId))
    const message = response?.newMessage?.message
    if (!message) return false
    this.addMessage(toMessage(message))
    this.bumpDm(toMessage(message))
    return true
  }

  /** Story 40. */
  edit = async (channelId: number, messageId: number, content: string): Promise<boolean> => {
    const response = await this.request(editMessage(channelId, messageId, content))
    const message = response?.messageEdited?.message
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

  /** Stories 34-35. `true` si accepté ; sinon l'erreur (409 : pris) est dans `error`. */
  setPseudo = async (pseudo: string): Promise<boolean> => {
    this.set({ error: null })
    const response = await this.request(setPseudo(pseudo))
    const profile = response?.userUpdated?.profile
    if (!profile) return false
    this.applyProfile(toProfile(profile))
    return true
  }

  /**
   * Story 28 : DM avec `userId` (l'existant ou un nouveau). Rend son id, pour basculer
   * dessus ; `null` si refusé (erreur dans `error`).
   */
  openDm = async (userId: number): Promise<number | null> => {
    const response = await this.request(openDm(userId))
    const conversation = response?.dmOpened?.conversation
    if (!conversation || !this.state.me) return null
    const dm = toConversation(conversation, this.state.me.id)
    this.upsertDm(dm)
    return dm.id
  }

  private upsertDm(dm: Conversation): void {
    const others = this.state.dms.filter((d) => d.id !== dm.id)
    this.set({ dms: [...others, dm] })
  }

  /** Story 30 : un message dans un DM le remonte, qu'il soit chargé ou non. */
  private bumpDm(message: ChatMessage): void {
    const dm = this.state.dms.find((d) => d.id === message.channelId)
    if (dm && message.id > dm.lastMessageId) this.upsertDm({ ...dm, lastMessageId: message.id })
  }

  flash = (toast: string): void => {
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.set({ toast })
    this.toastTimer = setTimeout(() => this.set({ toast: null }), 2000)
  }

  /**
   * Stories 27, 51-52 : envoie un fichier (`POST /media`), image ou non. Rend ses
   * métadonnées, pour placer son lien dans le message ; `null` si refusé (quota :
   * erreur dans `error`). Une image envoyée est mise en cache sans la retélécharger.
   * XMLHttpRequest plutôt que fetch : seul à donner la progression de l'envoi.
   */
  uploadMedia = (
    file: Blob,
    options: { name: string; folder?: { files: number; size: number }; onProgress?: (ratio: number) => void },
  ): Promise<MediaInfo | null> => {
    const token = this.sessionToken
    if (!token || !this.state.me) return Promise.resolve(null)
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest()
      xhr.open("POST", `${MEDIA_BASE}/media`)
      xhr.responseType = "arraybuffer"
      xhr.setRequestHeader("Authorization", `Bearer ${token}`)
      xhr.setRequestHeader("X-Media-Name", encodeURIComponent(options.name))
      if (options.folder) {
        xhr.setRequestHeader("X-Folder-Files", String(options.folder.files))
        xhr.setRequestHeader("X-Folder-Size", String(options.folder.size))
      }
      xhr.upload.onprogress = (e) => e.lengthComputable && options.onProgress?.(e.loaded / e.total)
      xhr.onerror = () => {
        this.set({ error: "envoi impossible (réseau)" })
        resolve(null)
      }
      xhr.onload = () => {
        const body = new Uint8Array(xhr.response as ArrayBuffer)
        if (xhr.status !== 201) {
          this.set({ error: httpError(body, xhr.status) })
          resolve(null)
          return
        }
        const media = chat.MediaUploaded.decode(body).media
        if (!media?.id) return resolve(null)
        const info = toMediaInfo(media)
        this.setMedia(info.id, {
          status: "ready",
          info,
          // Image ou vidéo qu'on vient d'envoyer : lue depuis le fichier local.
          url: info.isImage || info.isVideo ? URL.createObjectURL(file) : undefined,
        })
        resolve(info)
      }
      xhr.send(file)
    })
  }

  /**
   * Métadonnées d'un média (story 51), demandées par lots par le WebSocket, puis le
   * contenu s'il s'agit d'une image (`GET /media/{id}` avec le token, story 48) — un
   * fichier n'est jamais chargé pour s'afficher. Appelé au rendu : idempotent.
   */
  ensureMedia = (id: string): void => {
    if (this.state.media[id] || !this.client) return
    this.setMedia(id, { status: "loading" })
    this.mediaQueue.add(id)
    if (this.mediaQueue.size === 1) queueMicrotask(() => void this.flushMediaQueue())
  }

  private async flushMediaQueue(): Promise<void> {
    const ids = [...this.mediaQueue]
    this.mediaQueue.clear()
    const response = await this.request(getMedia(ids))
    if (!response?.mediaInfo) {
      // Réseau : réessayé au prochain rendu.
      for (const id of ids) this.forgetMedia(id)
      return
    }
    const found = new Map((response.mediaInfo.media ?? []).map((m) => [m.id ?? "", toMediaInfo(m)]))
    for (const id of ids) {
      const info = found.get(id)
      if (!info) this.setMedia(id, { status: "missing" })
      else {
        this.setMedia(id, { status: "ready", info })
        if (info.isImage) void this.loadImage(info)
        if (info.isVideo) void this.refreshStream(id)
      }
    }
  }

  private async loadImage(info: MediaInfo): Promise<void> {
    try {
      const response = await fetch(`${MEDIA_BASE}/media/${info.id}`, {
        headers: { Authorization: `Bearer ${this.sessionToken}` },
      })
      if (response.status === 404) return this.markMediaMissing(info.id)
      if (!response.ok) throw new Error(String(response.status))
      const url = URL.createObjectURL(await response.blob())
      this.setMedia(info.id, { status: "ready", info, url })
    } catch {
      this.forgetMedia(info.id)
    }
  }

  /**
   * Story 54 : adresse de lecture d'une vidéo — le lecteur du navigateur ne porte pas
   * de token, il lit par plages avec un ticket de lecture (1 h, prolongée à chaque
   * requête). Rappelé par le lecteur si le ticket a expiré (onglet resté ouvert).
   */
  refreshStream = async (id: string): Promise<void> => {
    const response = await this.request(requestDownload(id, true))
    const ticket = response?.downloadTicket?.ticket
    const entry = this.state.media[id]
    if (!ticket || entry?.status !== "ready") return
    this.setMedia(id, { ...entry, url: `${MEDIA_BASE}/media/${id}?ticket=${ticket}` })
  }

  private forgetMedia(id: string): void {
    const { [id]: _forgotten, ...media } = this.state.media
    this.set({ media })
  }

  /**
   * Story 53 : téléchargement natif — ticket de 60 s, puis le navigateur télécharge
   * lui-même (son gestionnaire, sans passer par la mémoire de l'app).
   */
  download = async (id: string): Promise<void> => {
    const response = await this.request(requestDownload(id))
    const ticket = response?.downloadTicket?.ticket
    if (!ticket) return
    const a = document.createElement("a")
    a.href = `${MEDIA_BASE}/media/${id}?ticket=${ticket}`
    a.click()
  }

  /** Story 50 : « pour tout le monde », par celle ou celui qui l'a envoyée. */
  deleteMediaEverywhere = async (id: string): Promise<void> => {
    const response = await this.request(deleteMedia(id))
    if (response?.mediaDeleted) this.markMediaMissing(id)
  }

  private setMedia(id: string, entry: MediaEntry): void {
    this.set({ media: { ...this.state.media, [id]: entry } })
  }

  private markMediaMissing(id: string): void {
    const entry = this.state.media[id]
    if (entry?.status === "ready" && entry.url?.startsWith("blob:")) URL.revokeObjectURL(entry.url)
    this.setMedia(id, { status: "missing" })
  }

  /** Story 41 : appliqué tout de suite côté serveur (pas de délai, story 42). */
  setInvisible = async (invisible: boolean): Promise<void> => {
    const response = await this.request(setStatus(invisible ? chat.Status.INVISIBLE : chat.Status.ONLINE))
    const me = this.state.me
    if (response?.statusSet && me) {
      this.set({ me: { ...me, invisible: response.statusSet.status === chat.Status.INVISIBLE } })
    }
  }

  /** Story 43. `true` si acceptée ; sinon l'erreur est dans `error`. */
  setBio = async (bio: string): Promise<boolean> => {
    this.set({ error: null })
    const response = await this.request(setBio(bio))
    const profile = response?.userUpdated?.profile
    if (!profile) return false
    this.applyProfile(toProfile(profile))
    return true
  }

  /** Story 37 : image déjà réduite (cf. avatar-image.ts) ; vide = retirer la photo. */
  setAvatar = async (image: Uint8Array): Promise<boolean> => {
    this.set({ error: null })
    const response = await this.request(setAvatar(image))
    const profile = response?.userUpdated?.profile
    if (!profile) return false
    this.applyProfile(toProfile(profile))
    return true
  }

  /**
   * Charge la photo d'un utilisateur si la version connue n'est pas encore en cache.
   * Appelé au rendu de chaque avatar : idempotent, une seule requête par version.
   */
  ensureAvatar = (userId: number): void => {
    const version = this.state.users[userId]?.avatarVersion ?? 0
    if (version === 0 || this.state.avatars[userId]?.version === version) return
    const key = `${userId}:${version}`
    if (this.avatarRequests.has(key) || !this.client) return
    this.avatarRequests.add(key)
    void this.client
      .request(getAvatar(userId))
      .then((response) => {
        const avatar = response.avatar
        if (!avatar?.image) return
        const loaded = toNumber(avatar.avatarVersion)
        // Une version plus récente a pu arriver entre-temps : on garde la plus récente.
        if ((this.state.avatars[userId]?.version ?? 0) >= loaded) return
        const previous = this.state.avatars[userId]
        if (previous) URL.revokeObjectURL(previous.url)
        // Type laissé vide : le navigateur reconnaît PNG/JPEG/WebP à leurs octets.
        const url = URL.createObjectURL(new Blob([avatar.image as Uint8Array<ArrayBuffer>]))
        this.set({ avatars: { ...this.state.avatars, [userId]: { version: loaded, url } } })
      })
      .catch(() => {}) // WS fermé : rechargée au prochain rendu après reconnexion
      .finally(() => this.avatarRequests.delete(key))
  }

  private applyProfile(profile: Profile): void {
    const users = { ...this.state.users, [profile.id]: profile }
    const me = this.state.me
    if (me && me.id === profile.id) {
      const updated = { ...me, pseudo: profile.pseudo, avatarVersion: profile.avatarVersion, bio: profile.bio }
      this.set({ users, me: updated, phase: this.state.phase === "pseudo" ? "ready" : this.state.phase })
    } else {
      this.set({ users })
    }
    if (profile.avatarVersion === 0 && this.state.avatars[profile.id]) {
      const { [profile.id]: removed, ...avatars } = this.state.avatars
      URL.revokeObjectURL(removed.url)
      this.set({ avatars })
    }
  }

  // --- broadcasts ---

  private onEvent(envelope: ServerEnvelope): void {
    switch (envelope.payload) {
      case "newMessage":
        if (envelope.newMessage?.message) {
          const message = toMessage(envelope.newMessage.message)
          this.addMessage(message)
          this.bumpDm(message)
        }
        break
      case "dmOpened": {
        // Premier message d'un DM ouvert par l'autre, ou DM ouvert dans un autre onglet.
        const conversation = envelope.dmOpened?.conversation
        if (conversation && this.state.me) this.upsertDm(toConversation(conversation, this.state.me.id))
        break
      }
      case "messageEdited":
        // Même id : `mergeMessages` remplace la version précédente.
        if (envelope.messageEdited?.message) this.addMessage(toMessage(envelope.messageEdited.message))
        break
      case "messageDeleted": {
        const d = envelope.messageDeleted
        if (d) this.markDeleted(toNumber(d.channelId), toNumber(d.messageId))
        break
      }
      case "mediaDeleted":
        if (envelope.mediaDeleted?.mediaId) this.markMediaMissing(envelope.mediaDeleted.mediaId)
        break
      case "presenceChanged": {
        const change = envelope.presenceChanged
        if (!change) break
        const online = new Set(this.state.online)
        if (change.online) online.add(toNumber(change.userId))
        else online.delete(toNumber(change.userId))
        this.set({ online })
        break
      }
      case "userUpdated": {
        const profile = envelope.userUpdated?.profile
        if (profile) this.applyProfile(toProfile(profile))
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

/** Corps d'une erreur HTTP : un `Error` protobuf, comme sur le WebSocket. */
function httpError(body: Uint8Array, status: number): string {
  try {
    return chat.Error.decode(body).message || `erreur ${status}`
  } catch {
    return `erreur ${status}`
  }
}

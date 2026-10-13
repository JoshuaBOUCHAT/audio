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
  acceptInvite,
  checkInvite,
  createInvite,
  createLoginLink,
  deleteMedia,
  deleteMessage,
  listInvites,
  passwordLogin,
  revokeInvite,
  setPassword,
  markRead,
  editMessage,
  getMedia,
  heartbeat,
  requestDownload,
  openDm,
  getAvatar,
  sendMessage,
  setAvatar,
  setBio,
  setSettings,
  setTheme,
  setPseudo,
  setStatus,
  syncPage,
  type ClientEnvelopeShape,
  type ServerEnvelope,
} from "@/lib/protocol"
import {
  isTextChannel,
  mergeMessages,
  toChannel,
  DEFAULT_CHANNEL_RULE,
  DEFAULT_PERSON_RULE,
  fromNotifySettings,
  fromThemeChoice,
  toConversation,
  toNotifySettings,
  toMediaInfo,
  toThemeChoice,
  toMe,
  toMessage,
  toNumber,
  toProfile,
  type ChatChannel,
  type ChatMessage,
  type Conversation,
  type Me,
  type MediaInfo,
  type ChannelRule,
  type NotifySettings,
  type PersonRule,
  type Profile,
} from "./model"
import { applyTheme, type ThemeChoice } from "@/lib/theme"
import { chat } from "@/proto/messages.js"
import { mentions, plainText } from "./media"
import { playSound } from "./sounds"
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
  /** Story 56 : non-lus par conversation (salon ou DM) ; story 62 : dont mentions de moi. */
  unread: Record<number, { count: number; mentions: number; lastReadId: number }>
  /** Stories 57-60. */
  settings: NotifySettings
  /** Confirmation brève (« Lien copié »), effacée seule. */
  toast: string | null
  /** Photos chargées : object URL de la version connue (story 36). */
  avatars: Record<number, { version: number; url: string }>
  /** Story 64 : il reste des messages plus anciens à charger ; un chargement est en cours. */
  history: Record<number, { hasMore: boolean; loading: boolean }>
  /** Messages par salon ; absent = salon jamais synchronisé. */
  messages: Record<number, ChatMessage[]>
  /** Dernière erreur à afficher (réponse Error du serveur ou échec réseau). */
  error: string | null
  /** Story 65 : jeton d'invitation de l'URL, tant que le compte n'est pas créé. */
  invite: string | null
  /** Story 66 : invitation vérifiée à l'ouverture ; `null` tant que la réponse n'est pas là. */
  inviteValid: boolean | null
}

const INITIAL: ChatState = {
  phase: "connecting",
  me: null,
  channels: [],
  dms: [],
  users: {},
  online: new Set(),
  media: {},
  unread: {},
  settings: { sound: "pop", desktop: false, channels: {}, persons: {} },
  toast: null,
  avatars: {},
  messages: {},
  history: {},
  error: null,
  invite: null,
  inviteValid: null,
}

const RECONNECT_MAX_MS = 10_000
/** Story 69 : heartbeat client (le ping serveur, lui, est invisible depuis JS). */
const HEARTBEAT_EVERY_MS = 20_000
const HEARTBEAT_TIMEOUT_MS = 10_000
/** Story 64 : messages par page d'historique. */
const PAGE_SIZE = 64

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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
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
  /** Conversation affichée (`setActive`) : ses messages ne notifient pas, ils sont lus. */
  private active: number | null = null
  private lastSound = 0
  /** Clic sur une notification système : l'interface bascule sur la conversation. */
  onOpenConversation: ((channelId: number) => void) | null = null

  constructor(magicToken: string | null, inviteToken: string | null = null) {
    this.pendingMagicToken = magicToken
    this.state = { ...INITIAL, invite: inviteToken }
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
    // Story 56 : revenir sur l'onglet, c'est lire la conversation affichée.
    window.addEventListener("focus", this.markActiveRead)
    document.addEventListener("visibilitychange", this.markActiveRead)
  }

  dispose(): void {
    this.disposed = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    window.removeEventListener("focus", this.markActiveRead)
    document.removeEventListener("visibilitychange", this.markActiveRead)
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
      if (this.state.invite && this.state.inviteValid === null) void this.checkInvite(client)
      void this.authenticate()
    })
    socket.addEventListener("close", () => this.lost(socket, client))
    this.startHeartbeat(socket, client)
  }

  /** Connexion perdue (fermée, ou déclarée morte par le heartbeat) : reconnexion. */
  private lost(socket: WebSocket, client: ProtocolClient): void {
    client.failPending(new Error("connexion fermée"))
    if (this.socket !== socket) return
    this.socket = null
    this.client = null
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.disposed) return
    this.set({ phase: this.state.me ? "offline" : "connecting" })
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
  }

  /**
   * Story 69 : un réseau perdu sans fermeture propre laisse la socket « ouverte » de
   * longues minutes. Toutes les 20 s (onglet visible), un Heartbeat sans réponse sous
   * 10 s déclare la connexion morte et relance aussitôt — sans attendre la fermeture
   * d'une socket qui ne répondra plus.
   */
  private startHeartbeat(socket: WebSocket, client: ProtocolClient): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      if (document.hidden || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
      const deadline = setTimeout(() => {
        this.lost(socket, client)
        socket.close()
      }, HEARTBEAT_TIMEOUT_MS)
      client.request(heartbeat()).then(
        () => clearTimeout(deadline),
        () => clearTimeout(deadline),
      )
    }, HEARTBEAT_EVERY_MS)
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
    this.onAuthenticated(auth)
  }

  /** Story 67 : email + mot de passe. */
  loginWithPassword = async (email: string, password: string): Promise<void> => {
    await this.authenticateWith(passwordLogin(email, password))
  }

  /** Story 66 : création du compte depuis l'invitation de l'URL. */
  acceptInvite = async (email: string, pseudo: string, password: string): Promise<void> => {
    const invite = this.state.invite
    if (!invite) return
    const refused = await this.authenticateWith(acceptInvite(invite, email, pseudo, password), () =>
      this.set({ invite: null }),
    )
    // Révoquée ou expirée entre l'ouverture et l'envoi.
    if (refused === 404) this.set({ inviteValid: false })
  }

  /** Story 66 : un lien mort n'affiche pas de formulaire voué à échouer. */
  private async checkInvite(client: ProtocolClient): Promise<void> {
    const invite = this.state.invite
    if (!invite) return
    let response: ServerEnvelope
    try {
      response = await client.request(checkInvite(invite))
    } catch {
      return // WS fermé : nouvelle vérification à la reconnexion
    }
    if (this.state.invite === invite) this.set({ inviteValid: !!response.inviteChecked })
  }

  /** Story 67 : `current` vide si le compte n'a pas encore de mot de passe. */
  setPassword = async (current: string, password: string): Promise<boolean> => {
    this.set({ error: null })
    const response = await this.request(setPassword(current, password))
    if (!response?.passwordSet) return false
    const me = this.state.me
    if (me) this.set({ me: { ...me, hasPassword: true } })
    return true
  }

  // --- administration (stories 65, 68) ---

  createInvite = async (ttlSeconds: number): Promise<chat.IInvite | null> =>
    (await this.request(createInvite(ttlSeconds)))?.inviteCreated?.invite ?? null

  listInvites = async (): Promise<chat.IInvite[]> => (await this.request(listInvites()))?.invites?.invites ?? []

  revokeInvite = async (token: string): Promise<boolean> => !!(await this.request(revokeInvite(token)))?.inviteRevoked

  createLoginLink = async (userId: number, ttlSeconds: number): Promise<chat.ILoginLinkCreated | null> =>
    (await this.request(createLoginLink(userId, ttlSeconds)))?.loginLinkCreated ?? null

  /** Revenir à l'écran de connexion depuis celui d'une invitation. */
  dropInvite = (): void => this.set({ invite: null, error: null })

  /** Code d'erreur du refus éventuel (`null` si connecté ou connexion perdue). */
  private async authenticateWith(payload: ClientEnvelopeShape, onSuccess?: () => void): Promise<number | null> {
    const client = this.client
    if (!client) return null
    this.set({ phase: "authenticating", error: null })
    let response: ServerEnvelope
    try {
      response = await client.request(payload)
    } catch {
      this.set({ phase: "login", error: "connexion perdue, réessaie" })
      return null
    }
    if (!response.authResponse) {
      this.set({ phase: "login", error: response.error?.message ?? "authentification refusée" })
      return response.error?.code ?? null
    }
    onSuccess?.()
    this.onAuthenticated(response.authResponse)
    return null
  }

  /** Fin commune de toutes les portes d'entrée : session gardée, état chargé. */
  private onAuthenticated(auth: chat.IAuthResponse): void {
    saveSessionToken(auth.sessionToken ?? "")
    this.sessionToken = auth.sessionToken ?? null
    const me = toMe(auth.me)
    const users: Record<number, Profile> = {}
    for (const p of auth.users ?? []) users[toNumber(p.id)] = toProfile(p)
    // Story 55 : le thème du compte l'emporte sur la copie locale (autre appareil).
    applyTheme(me.theme)
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

    const unread: ChatState["unread"] = {}
    for (const u of auth.unread ?? []) {
      unread[toNumber(u.channelId)] = {
        count: u.count ?? 0,
        mentions: u.mentions ?? 0,
        lastReadId: toNumber(u.lastReadId),
      }
    }
    this.set({
      phase: me.pseudo ? "ready" : "pseudo",
      me,
      users,
      channels,
      dms,
      unread,
      settings: toNotifySettings(auth.settings),
      online: new Set((auth.onlineUserIds ?? []).map(toNumber)),
      messages: kept,
      avatars: {},
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

  /**
   * Story 64 : dernière page de la conversation. Elle **remplace** la copie locale (à
   * la reconnexion aussi, story 15 : modifications et suppressions pendant la coupure
   * prises en compte ; on remonte à nouveau si besoin). Un broadcast reçu avant cette
   * réponse a été traité avant elle côté serveur (même file d'envoi), donc il y est
   * déjà ; ceux qui suivent se fusionnent normalement.
   */
  private async sync(channelId: number): Promise<void> {
    const response = await this.request(syncPage(channelId, 0, PAGE_SIZE))
    const sync = response?.syncResponse
    if (!sync) return
    const synced = (sync.messages ?? []).map(toMessage)
    this.setMessages(channelId, () => synced)
    this.set({ history: { ...this.state.history, [channelId]: { hasMore: sync.hasMore ?? false, loading: false } } })
    if (channelId === this.active) this.markActiveRead()
  }

  /** Story 64 : page précédente, avant le plus ancien message chargé. */
  loadOlder = async (channelId: number): Promise<void> => {
    const history = this.state.history[channelId]
    const oldest = this.state.messages[channelId]?.[0]
    if (!history?.hasMore || history.loading || !oldest) return
    this.set({ history: { ...this.state.history, [channelId]: { ...history, loading: true } } })
    const response = await this.request(syncPage(channelId, oldest.id, PAGE_SIZE))
    const sync = response?.syncResponse
    const hasMore = sync ? (sync.hasMore ?? false) : history.hasMore
    if (sync) this.setMessages(channelId, (current) => mergeMessages(current, (sync.messages ?? []).map(toMessage)))
    this.set({ history: { ...this.state.history, [channelId]: { hasMore, loading: false } } })
  }

  /** Story 64 : remonte page par page jusqu'à `messageId` (citation d'un original ancien). */
  loadUntil = async (channelId: number, messageId: number): Promise<boolean> => {
    for (let page = 0; page < 100; page++) {
      const messages = this.state.messages[channelId]
      if (messages?.some((m) => m.id === messageId)) return true
      if (!this.state.history[channelId]?.hasMore || !messages?.length || messages[0].id < messageId) return false
      await this.loadOlder(channelId)
    }
    return false
  }

  /** `replyToId` : message cité (story 39), 0 = pas une réponse. */
  send = async (channelId: number, content: string, replyToId = 0): Promise<boolean> => {
    const response = await this.request(sendMessage(channelId, content, replyToId))
    const message = response?.newMessage?.message
    if (!message) return false
    this.addMessage(toMessage(message))
    this.bumpDm(toMessage(message))
    this.markActiveRead() // répondre, c'est avoir lu ce qui précède
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
          // Image, vidéo ou son qu'on vient d'envoyer : lu depuis le fichier local.
          url: info.isImage || info.isVideo || info.isAudio ? URL.createObjectURL(file) : undefined,
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
        if (info.isVideo || info.isAudio) void this.refreshStream(id)
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

  // --- non-lus et notifications (stories 56-60) ---

  /** Conversation affichée, `null` si aucune. Elle est marquée lue. */
  setActive = (channelId: number | null): void => {
    this.active = channelId
    if (channelId !== null) this.markActiveRead()
  }

  /**
   * Marque lue la conversation affichée si la fenêtre est au premier plan (sinon on
   * ne l'a pas vraiment lue) : au changement de conversation, au retour sur l'onglet,
   * à l'arrivée d'un message, une fois ses messages chargés.
   */
  markActiveRead = (): void => {
    const id = this.active
    if (id === null || document.hidden || !document.hasFocus()) return
    const messages = this.state.messages[id]
    if (!messages) return
    const last = messages.at(-1)?.id ?? 0
    const current = this.state.unread[id]
    if (last === 0 || (current && current.count === 0 && current.lastReadId >= last)) return
    const lastReadId = Math.max(last, current?.lastReadId ?? 0)
    this.set({ unread: { ...this.state.unread, [id]: { count: 0, mentions: 0, lastReadId } } })
    void this.request(markRead(id, last))
  }

  /**
   * Total affiché en badge, conversations coupées exclues : les mentions de moi pour les
   * salons (story 62), tous les non-lus pour les DM.
   */
  badgeTotal = (ids: number[], kind: "mentions" | "count"): number =>
    ids.reduce((n, id) => n + (this.isMuted(id) ? 0 : (this.state.unread[id]?.[kind] ?? 0)), 0)

  /** Story 63 : salon réglé sur « rien », ou DM d'une personne dont les messages ne notifient pas. */
  isMuted = (conversationId: number): boolean => {
    const { channels, persons } = this.state.settings
    if (this.state.channels.some((c) => c.id === conversationId)) return channels[conversationId]?.level === "nothing"
    const dm = this.state.dms.find((d) => d.id === conversationId)
    return dm ? (persons[dm.otherId]?.dmMuted ?? false) : false
  }

  channelRule = (channelId: number): ChannelRule => this.state.settings.channels[channelId] ?? DEFAULT_CHANNEL_RULE
  personRule = (userId: number): PersonRule => this.state.settings.persons[userId] ?? DEFAULT_PERSON_RULE

  setChannelRule = (channelId: number, rule: ChannelRule): Promise<void> =>
    this.setNotifySettings({ ...this.state.settings, channels: { ...this.state.settings.channels, [channelId]: rule } })

  setPersonRule = (userId: number, rule: PersonRule): Promise<void> =>
    this.setNotifySettings({ ...this.state.settings, persons: { ...this.state.settings.persons, [userId]: rule } })

  setNotifySettings = async (settings: NotifySettings): Promise<void> => {
    this.set({ settings })
    await this.request(setSettings(fromNotifySettings(settings)))
  }

  /**
   * Story 63 : « Tout couper » règle chaque salon sur « rien » et chaque personne sur
   * « ne pas notifier », un par un — on peut ensuite n'en réactiver qu'un. `false`
   * retire toutes les règles.
   */
  muteAll = (muted: boolean): Promise<void> => {
    const channels: NotifySettings["channels"] = {}
    const persons: NotifySettings["persons"] = {}
    if (muted) {
      for (const { id } of this.state.channels) channels[id] = { level: "nothing", silent: false }
      for (const user of Object.values(this.state.users)) {
        if (user.id !== this.state.me?.id) {
          persons[user.id] = { dmMuted: true, dmSilent: false, mentionsMuted: true, mentionsSilent: false }
        }
      }
    }
    return this.setNotifySettings({ ...this.state.settings, channels, persons })
  }

  /** Message d'un autre reçu en direct : non-lu ou lu, son, popup système. */
  private onIncoming(message: ChatMessage): void {
    const me = this.state.me
    if (!me || message.userId === me.id) return
    const id = message.channelId
    const looking = this.active === id && !document.hidden && document.hasFocus()
    if (looking) {
      this.markActiveRead()
      return
    }
    const mentioned = mentions(message.content, me.id)
    const current = this.state.unread[id] ?? { count: 0, mentions: 0, lastReadId: 0 }
    if (message.id > current.lastReadId) {
      const next = {
        ...current,
        count: Math.min(current.count + 1, 100),
        mentions: Math.min(current.mentions + (mentioned ? 1 : 0), 100),
      }
      this.set({ unread: { ...this.state.unread, [id]: next } })
    }
    // Story 63 : DM = réglage de la personne ; salon = niveau du salon, et pour une
    // mention, l'accord de la personne aussi.
    const person = this.personRule(message.userId)
    let notify: boolean
    let withSound: boolean
    if (this.state.dms.some((d) => d.id === id)) {
      notify = !person.dmMuted
      withSound = !person.dmSilent
    } else {
      const channel = this.channelRule(id)
      notify = channel.level !== "nothing" && (mentioned ? !person.mentionsMuted : channel.level === "all")
      withSound = !channel.silent && (!mentioned || !person.mentionsSilent)
    }
    if (!notify) return
    const { sound, desktop } = this.state.settings
    if (sound && withSound && Date.now() - this.lastSound > 1000) {
      this.lastSound = Date.now()
      playSound(sound)
    }
    if (desktop && (document.hidden || !document.hasFocus()) && "Notification" in window && Notification.permission === "granted") {
      this.desktopNotification(message)
    }
  }

  private desktopNotification(message: ChatMessage): void {
    const author = this.state.users[message.userId]?.pseudo ?? "Quelqu'un"
    const channel = this.state.channels.find((c) => c.id === message.channelId)
    const notification = new Notification(channel ? `${author} dans #${channel.name}` : author, {
      body: plainText(message.content, (userId) => this.state.users[userId]?.pseudo ?? "quelqu'un")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200),
      tag: `conversation-${message.channelId}`,
      silent: true, // le son vient de l'app, réglable (story 57)
    })
    notification.onclick = () => {
      window.focus()
      this.onOpenConversation?.(message.channelId)
      notification.close()
    }
  }

  /** Story 55 : appliqué tout de suite, mémorisé avec le compte, poussé à mes autres appareils. */
  setTheme = async (theme: ThemeChoice): Promise<void> => {
    const me = this.state.me
    if (!me) return
    applyTheme(theme)
    this.set({ me: { ...me, theme } })
    await this.request(setTheme(fromThemeChoice(theme)))
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
          this.onIncoming(message)
        }
        break
      case "readMarked": {
        // Lu sur un autre de mes appareils : badge effacé ici aussi.
        const marked = envelope.readMarked
        if (!marked) break
        const id = toNumber(marked.channelId)
        const lastReadId = toNumber(marked.lastReadId)
        const me = this.state.me
        const after = (this.state.messages[id] ?? []).filter((m) => m.id > lastReadId && m.userId !== me?.id && !m.deleted)
        const mentioned = after.filter((m) => me && mentions(m.content, me.id)).length
        this.set({ unread: { ...this.state.unread, [id]: { count: after.length, mentions: mentioned, lastReadId } } })
        break
      }
      case "settingsSet":
        if (envelope.settingsSet) this.set({ settings: toNotifySettings(envelope.settingsSet.settings) })
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
      case "themeSet": {
        // Changé depuis un autre onglet ou appareil.
        const me = this.state.me
        if (!me || !envelope.themeSet) break
        const theme = toThemeChoice(envelope.themeSet.theme)
        applyTheme(theme)
        this.set({ me: { ...me, theme } })
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

// État du client et cycle de vie de la connexion, hors de React (lu via
// useSyncExternalStore) : une seule connexion WS par onglet, qui survit aux re-rendus
// et au double montage de StrictMode.
//
// L'auth est liée à la connexion (story 33) : chaque nouveau WS rejoue AuthRequest
// avec le token de session, puis resync depuis 0 les salons déjà chargés (story 15 —
// seul moyen de voir les suppressions survenues pendant la coupure).

import { BACK_END_URL } from "@/lib/config"
import {
  acceptInvite,
  authRequest,
  checkInvite,
  createInvite,
  createLoginLink,
  heartbeat,
  listInvites,
  passwordLogin,
  ProtocolClient,
  revokeInvite,
  setPassword,
  type ClientEnvelopeShape,
  type ServerEnvelope,
} from "@/lib/protocol"
import { applyTheme } from "@/lib/theme"
import { chat } from "@/proto/messages.js"
import { mentions } from "./media"
import {
  isTextChannel,
  isVoiceChannel,
  toChannel,
  toConversation,
  toMe,
  toMessage,
  toNotifySettings,
  toNumber,
  toProfile,
  toThemeChoice,
  type ChatMessage,
  type Profile,
} from "./model"
import { clearSessionToken, loadSessionToken, saveSessionToken } from "./session"
import { VoiceLayer, loadVoicePrefs, loadVoiceSelf } from "./store-voice"
import { INITIAL, type ChatState } from "./store-core"

// Types et utilitaires de l'état, importés par les composants depuis "./store".
export { isShownOnline, type ChatState, type MediaEntry, type Phase } from "./store-core"

const RECONNECT_MAX_MS = 10_000
/** Story 69 : heartbeat client (le ping serveur, lui, est invisible depuis JS). */
const HEARTBEAT_EVERY_MS = 20_000
const HEARTBEAT_TIMEOUT_MS = 10_000

export class ChatStore extends VoiceLayer {
  private socket: WebSocket | null = null

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  private reconnectDelay = 500

  private disposed = false

  /** Token de lien magique lu dans l'URL, consommé à la première connexion. */
  private pendingMagicToken: string | null

  constructor(magicToken: string | null, inviteToken: string | null = null) {
    super()
    this.pendingMagicToken = magicToken
    this.state = { ...INITIAL, invite: inviteToken, voicePrefs: loadVoicePrefs(), voiceSelf: loadVoiceSelf() }
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
    this.voiceLost()
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

  // --- connexion (stories 33, 65-67) ---

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
    this.voiceAuthenticated(auth)
  }

  logout = (): void => {
    clearSessionToken()
    this.sessionToken = null
    for (const entry of Object.values(this.state.media)) {
      if (entry.status === "ready" && entry.url?.startsWith("blob:")) URL.revokeObjectURL(entry.url)
    }
    for (const { url } of Object.values(this.state.avatars)) URL.revokeObjectURL(url)
    this.rejoinChannel = null
    this.stopEngine()
    // La connexion reste authentifiée côté serveur : on repart d'un WS vierge (la
    // fermeture vaut aussi départ du vocal). Les réglages de l'appareil restent.
    this.state = { ...INITIAL, voicePrefs: this.state.voicePrefs, voiceSelf: this.state.voiceSelf }
    this.socket?.close()
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
        if (channel && isVoiceChannel(channel)) this.addVoiceChannel(toChannel(channel))
        break
      }
      case "voiceOffer":
        if (envelope.voiceOffer) void this.onVoiceOffer(envelope.voiceOffer)
        break
      case "voiceChanged":
        if (envelope.voiceChanged) this.onVoiceChanged(envelope.voiceChanged)
        break
      case "voiceLeft":
        this.onVoiceLeft()
        break
      case "voiceVolumeSet":
        if (envelope.voiceVolumeSet) this.onVoiceVolumeSet(envelope.voiceVolumeSet)
        break
    }
  }
}

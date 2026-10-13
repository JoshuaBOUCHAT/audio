// Socle du store : l'état (lu par React via useSyncExternalStore), ses abonnés, et la
// requête au serveur sur la connexion courante. Chaque couche (store-*.ts) ajoute un
// domaine par-dessus ; `ChatStore` (store.ts) est la dernière et porte la connexion.

import { ProtocolClient, type ClientEnvelopeShape, type ServerEnvelope } from "@/lib/protocol"
import {
  type ChatChannel,
  type ChatMessage,
  type Conversation,
  type Me,
  type MediaInfo,
  type NotifySettings,
  type Profile,
  type VoiceMember,
} from "./model"
import { DEFAULT_VOICE_PREFS, type VoicePrefs } from "./voice-engine"

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
  /** Story 70 : salons vocaux (à part des salons texte). */
  voiceChannels: ChatChannel[]
  /** Stories 22, 73 : qui est dans chaque salon vocal, avec micro coupé / sourdine. */
  voiceMembers: Record<number, VoiceMember[]>
  /** Story 18 : mon vocal ; `connected` une fois l'audio établi. */
  voice: { channelId: number; connected: boolean } | null
  /** Story 73 : mon micro coupé / ma sourdine, gardés hors vocal et sur l'appareil. */
  voiceSelf: { muted: boolean; deafened: boolean }
  /** Story 72 : qui parle en ce moment (moi compris). */
  speaking: ReadonlySet<number>
  /** Story 76 : volume de chaque personne pour moi, en % (absent = 100). */
  voiceVolumes: Record<number, number>
  /** Stories 71, 74, 75 : réglages de l'appareil. */
  voicePrefs: VoicePrefs
  /** Story 79 : débit des vocaux en kbps, `0` = le défaut, sinon les salons réglés. */
  voiceBitrates: Record<number, number>
}

export const INITIAL: ChatState = {
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
  voiceChannels: [],
  voiceMembers: {},
  voice: null,
  voiceSelf: { muted: false, deafened: false },
  speaking: new Set(),
  voiceVolumes: {},
  voicePrefs: DEFAULT_VOICE_PREFS,
  voiceBitrates: {},
}

/** Story 23 : vu par les autres. Pour soi, on suit son propre choix (story 41). */
export function isShownOnline(state: ChatState, userId: number): boolean {
  if (userId === state.me?.id) return !state.me.invisible
  return state.online.has(userId)
}

export abstract class StoreCore {
  protected state: ChatState = INITIAL

  protected readonly listeners = new Set<() => void>()

  protected client: ProtocolClient | null = null

  /** Token de la session courante : authentifie les requêtes HTTP d'images (story 48). */
  protected sessionToken: string | null = null

  protected toastTimer: ReturnType<typeof setTimeout> | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ChatState => this.state

  protected set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  protected async request(payload: ClientEnvelopeShape): Promise<ServerEnvelope | null> {
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

  clearError = (): void => this.set({ error: null })

  flash = (toast: string): void => {
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.set({ toast })
    this.toastTimer = setTimeout(() => this.set({ toast: null }), 2000)
  }
}

// Vocal (stories 18, 21-22, 70-76) : rejoindre / quitter, négociation avec le serveur,
// micro coupé et sourdine, volumes par personne, réglages de l'appareil, sons
// d'arrivée / départ (story 77), push-to-talk (story 78), débit choisi par l'admin
// (story 79). Le son lui-même
// vit dans `VoiceEngine` ; ici, l'état affiché et le dialogue avec le serveur.

import {
  createChannel,
  joinVoice,
  leaveVoice,
  setVoiceBitrate,
  setVoiceState,
  setVoiceVolume,
  voiceAnswer,
} from "@/lib/protocol"
import { chat } from "@/proto/messages.js"
import { isVoiceChannel, toChannel, toNumber, toVoiceMembers, type ChatChannel } from "./model"
import { playVoiceSound } from "./sounds"
import { ConversationsLayer } from "./store-conversations"
import { DEFAULT_VOICE_PREFS, micLevelTest, VoiceEngine, type VoicePrefs } from "./voice-engine"

const PREFS_KEY = "voice-prefs"
const SELF_KEY = "voice-self"
/** Story 79 : sans réglage de l'admin. */
export const DEFAULT_VOICE_BITRATE = 64

/** Story 78 : la voix part encore un instant après la touche relâchée (fin de mot). */
const PTT_RELEASE_MS = 150

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // stockage indisponible (navigation privée) : réglage gardé pour cette session
  }
}

/** Stories 71, 74, 75 : réglages de l'appareil. */
export function loadVoicePrefs(): VoicePrefs {
  return load(PREFS_KEY, DEFAULT_VOICE_PREFS)
}

/** Story 73 : micro coupé / sourdine survivent au rechargement. */
export function loadVoiceSelf(): { muted: boolean; deafened: boolean } {
  return load(SELF_KEY, { muted: false, deafened: false })
}

export abstract class VoiceLayer extends ConversationsLayer {
  protected engine: VoiceEngine | null = null
  /** Story 21 : vocal à rejoindre une fois reconnecté. */
  protected rejoinChannel: number | null = null
  /** Story 73 : micro coupé avant la sourdine, rendu en l'enlevant. */
  private mutedBeforeDeafen = false
  private readonly levelListeners = new Set<(db: number) => void>()
  /** Test du micro des Paramètres, hors vocal. */
  private micTest: VoiceEngine | null = null
  private pttRelease: ReturnType<typeof setTimeout> | null = null

  /** Story 70 (admin). */
  createVoiceChannel = async (name: string): Promise<boolean> => {
    const channel = (await this.request(createChannel(name, chat.Channel.Type.VOICE)))?.channelCreated?.channel
    if (!channel) return false
    this.addVoiceChannel(toChannel(channel))
    return true
  }

  /** Story 18 : un seul vocal à la fois, le serveur libère l'ancienne place. */
  joinVoice = async (channelId: number): Promise<void> => {
    if (this.state.voice?.channelId === channelId) return
    this.stopEngine()
    const { muted, deafened } = this.state.voiceSelf
    const engine = new VoiceEngine(this.state.voicePrefs, {
      onSpeaking: (who, speaking) => this.setSpeaking(who === "me" ? (this.state.me?.id ?? 0) : who, speaking),
      onLevel: (db) => this.levelListeners.forEach((l) => l(db)),
      onConnected: (connected) => {
        if (this.engine === engine && this.state.voice) this.set({ voice: { ...this.state.voice, connected } })
      },
    })
    this.engine = engine
    this.set({ voice: { channelId, connected: false } })
    let offer: string
    try {
      offer = await engine.start(muted, deafened, this.state.voiceVolumes, this.voiceBitrate(channelId))
    } catch (e) {
      this.stopEngine()
      this.set({ voice: null, error: `micro inaccessible : ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    const response = await this.request(joinVoice(channelId, offer, muted, deafened))
    if (this.engine !== engine) return
    if (!response?.voiceJoined) {
      this.stopEngine()
      this.set({ voice: null })
      return
    }
    await engine.applyAnswer(response.voiceJoined.sdp ?? "")
  }

  /** Story 21. */
  leaveVoice = async (): Promise<void> => {
    this.rejoinChannel = null
    if (!this.state.voice) return
    this.voiceSound("leave")
    this.stopEngine()
    this.set({ voice: null })
    await this.request(leaveVoice())
  }

  /** Story 73 : sous sourdine, réactiver le micro enlève aussi la sourdine. */
  toggleMute = (): void => {
    const { muted, deafened } = this.state.voiceSelf
    this.applySelf(deafened ? { muted: false, deafened: false } : { muted: !muted, deafened: false })
  }

  /** Story 73 : la sourdine coupe le micro ; l'enlever rend le micro d'avant. */
  toggleDeafen = (): void => {
    const { muted, deafened } = this.state.voiceSelf
    if (deafened) {
      this.applySelf({ muted: this.mutedBeforeDeafen, deafened: false })
    } else {
      this.mutedBeforeDeafen = muted
      this.applySelf({ muted: true, deafened: true })
    }
  }

  /** Story 78 : touche ou bouton « maintenir pour parler ». */
  pushToTalk = (held: boolean): void => {
    if (this.pttRelease) clearTimeout(this.pttRelease)
    this.pttRelease = null
    if (held) this.engine?.setPttHeld(true)
    else this.pttRelease = setTimeout(() => this.engine?.setPttHeld(false), PTT_RELEASE_MS)
  }

  /** Story 76 : appliqué tout de suite, puis gardé dans le compte. */
  setVoiceVolume = async (userId: number, volume: number): Promise<void> => {
    const voiceVolumes = { ...this.state.voiceVolumes, [userId]: volume }
    if (volume === 100) delete voiceVolumes[userId]
    this.set({ voiceVolumes })
    this.engine?.setVolumes(voiceVolumes)
    await this.request(setVoiceVolume(userId, volume))
  }

  /** Curseur en cours de glissement : entendu tout de suite, rien d'envoyé. */
  previewVoiceVolume = (userId: number, volume: number): void => {
    this.engine?.setVolumes({ ...this.state.voiceVolumes, [userId]: volume })
  }

  /** Story 79 : débit d'un salon vocal (le sien, sinon le défaut), en kbps. */
  voiceBitrate = (channelId: number): number =>
    this.state.voiceBitrates[channelId] ?? this.state.voiceBitrates[0] ?? DEFAULT_VOICE_BITRATE

  /** Story 79 (admin) : `channelId` 0 = le défaut, `kbps` 0 = revenir au défaut. */
  setVoiceBitrate = async (channelId: number, kbps: number): Promise<void> => {
    const set = (await this.request(setVoiceBitrate(channelId, kbps)))?.voiceBitrate
    if (set) this.onVoiceBitrate(set)
  }

  voiceVolume = (userId: number): number => this.state.voiceVolumes[userId] ?? 100

  /** Stories 71, 74, 75 : réglages de l'appareil, appliqués à chaud. */
  setVoicePrefs = (prefs: VoicePrefs): void => {
    save(PREFS_KEY, prefs)
    this.set({ voicePrefs: prefs })
    for (const engine of [this.engine, this.micTest]) {
      void engine?.setPrefs(prefs).catch((e) => this.set({ error: `micro : ${e instanceof Error ? e.message : e}` }))
    }
  }

  /**
   * Jauge du micro (Paramètres) : celle du vocal en cours, sinon un test du micro le
   * temps que la jauge est affichée. Rend la fonction d'arrêt.
   */
  watchMicLevel = (listener: (db: number) => void): (() => void) => {
    this.levelListeners.add(listener)
    let stopped = false
    if (!this.engine && !this.micTest) {
      void micLevelTest(this.state.voicePrefs, (db) => this.levelListeners.forEach((l) => l(db))).then(
        (engine) => {
          if (stopped) engine.stop()
          else this.micTest = engine
        },
        (e) => this.set({ error: `micro inaccessible : ${e instanceof Error ? e.message : e}` }),
      )
    }
    return () => {
      stopped = true
      this.levelListeners.delete(listener)
      if (this.levelListeners.size === 0) {
        this.micTest?.stop()
        this.micTest = null
      }
    }
  }

  private applySelf(self: { muted: boolean; deafened: boolean }): void {
    save(SELF_KEY, self)
    this.set({ voiceSelf: self })
    this.engine?.setMuted(self.muted, self.deafened)
    if (this.state.voice) void this.request(setVoiceState(self.muted, self.deafened))
  }

  private setSpeaking(userId: number, speaking: boolean): void {
    if (this.state.speaking.has(userId) === speaking) return
    const next = new Set(this.state.speaking)
    if (speaking) next.add(userId)
    else next.delete(userId)
    this.set({ speaking: next })
  }

  private voiceSound(kind: "join" | "leave"): void {
    if (this.state.voicePrefs.voiceSounds) playVoiceSound(kind)
  }

  protected stopEngine(): void {
    if (this.pttRelease) clearTimeout(this.pttRelease)
    this.pttRelease = null
    this.engine?.stop()
    this.engine = null
    if (this.state.speaking.size > 0) this.set({ speaking: new Set() })
  }

  // --- appelés par ChatStore ---

  /** Story 18 : renégociation du serveur (arrivée ou départ). */
  protected async onVoiceOffer(offer: chat.IVoiceOffer): Promise<void> {
    const engine = this.engine
    if (!engine) return
    const tracks = (offer.tracks ?? []).map((t) => ({ mid: t.mid ?? "", userId: toNumber(t.userId) }))
    let answer: string | null
    try {
      answer = await engine.handleOffer(offer.sdp ?? "", tracks)
    } catch (e) {
      this.set({ error: `vocal : ${e instanceof Error ? e.message : e}` })
      return
    }
    if (answer && this.engine === engine) await this.request(voiceAnswer(toNumber(offer.offerId), answer))
  }

  protected onVoiceChanged(changed: chat.IVoiceChanged): void {
    const channelId = toNumber(changed.channelId)
    const members = toVoiceMembers(changed)
    // Story 77 : arrivée (moi compris) ou départ dans le vocal où je suis.
    if (this.state.voice?.channelId === channelId) {
      const before = new Set((this.state.voiceMembers[channelId] ?? []).map((m) => m.userId))
      const after = new Set(members.map((m) => m.userId))
      if ([...after].some((id) => !before.has(id))) this.voiceSound("join")
      else if ([...before].some((id) => !after.has(id))) this.voiceSound("leave")
    }
    this.set({ voiceMembers: { ...this.state.voiceMembers, [channelId]: members } })
  }

  /** Sorti par le serveur : vocal rejoint depuis un autre appareil, ou audio perdu. */
  protected onVoiceLeft(): void {
    this.rejoinChannel = null
    if (this.state.voice) this.voiceSound("leave")
    this.stopEngine()
    this.set({ voice: null })
  }

  /** Story 21 : connexion perdue = départ côté serveur ; on rejoindra à la reconnexion. */
  protected voiceLost(): void {
    if (!this.state.voice) return
    this.rejoinChannel = this.state.voice.channelId
    this.stopEngine()
    this.set({ voice: null })
  }

  protected voiceAuthenticated(auth: chat.IAuthResponse): void {
    const voiceMembers: Record<number, ReturnType<typeof toVoiceMembers>> = {}
    for (const changed of auth.voice ?? []) voiceMembers[toNumber(changed.channelId)] = toVoiceMembers(changed)
    const voiceVolumes: Record<number, number> = {}
    for (const v of auth.voiceVolumes ?? []) voiceVolumes[toNumber(v.userId)] = v.volume ?? 100
    const voiceChannels: ChatChannel[] = (auth.channels ?? []).filter(isVoiceChannel).map(toChannel)
    const voiceBitrates: Record<number, number> = {}
    for (const b of auth.voiceBitrates ?? []) voiceBitrates[toNumber(b.channelId)] = b.kbps ?? DEFAULT_VOICE_BITRATE
    this.set({ voiceChannels, voiceMembers, voiceVolumes, voiceBitrates })
    this.applyBitrate()
    const rejoin = this.rejoinChannel
    this.rejoinChannel = null
    if (rejoin !== null && voiceChannels.some((c) => c.id === rejoin)) void this.joinVoice(rejoin)
  }

  protected addVoiceChannel(channel: ChatChannel): void {
    if (this.state.voiceChannels.some((c) => c.id === channel.id)) return
    this.set({ voiceChannels: [...this.state.voiceChannels, channel].sort((a, b) => a.id - b.id) })
  }

  protected onVoiceBitrate(set: chat.IVoiceBitrate): void {
    const voiceBitrates = { ...this.state.voiceBitrates, [toNumber(set.channelId)]: set.kbps ?? 0 }
    if (!set.kbps) delete voiceBitrates[toNumber(set.channelId)]
    this.set({ voiceBitrates })
    this.applyBitrate()
  }

  private applyBitrate(): void {
    if (this.state.voice) this.engine?.setBitrate(this.voiceBitrate(this.state.voice.channelId))
  }

  protected onVoiceVolumeSet(set: chat.IVoiceVolumeSet): void {
    const userId = toNumber(set.userId)
    const voiceVolumes = { ...this.state.voiceVolumes, [userId]: set.volume ?? 100 }
    if (set.volume === 100) delete voiceVolumes[userId]
    this.set({ voiceVolumes })
    this.engine?.setVolumes(voiceVolumes)
  }
}

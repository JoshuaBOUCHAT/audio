// Moteur audio du vocal (stories 18, 71-76), hors de React et du store : micro, gain,
// détection de voix, connexion WebRTC, lecture des autres avec un volume par personne.
//
// Envoi : micro → gain (0-200 %, story 75) → détection de voix (AudioWorklet) → piste
// envoyée. Sous le seuil pendant HANGOVER_MS, ou micro coupé, la piste est détachée de
// la connexion (`replaceTrack(null)`) : plus aucun paquet (story 71). La détection
// tourne dans le moteur audio et non sur un minuteur, que les navigateurs ralentissent
// à une fois par seconde dans un onglet en arrière-plan.
//
// Réception : une piste par autre participant (`mid` → personne d'après le dernier
// VoiceOffer), chacune → gain de la personne (story 76) → gain général (story 74) →
// sortie. Chrome ne fait passer le son d'une piste WebRTC dans Web Audio que si elle
// est aussi attachée à un élément <audio> (muet) : on le fait.
//
// Négociation (story 18) : une seule offre du navigateur (`start`), puis il ne fait que
// répondre aux offres du serveur. Les opérations SDP sont mises en file : une offre du
// serveur peut arriver avant que la réponse à la nôtre soit appliquée.

/** Réglages de l'appareil (stories 71, 74, 75), mémorisés localement. */
export type VoicePrefs = {
  inputDevice: string // "" = défaut
  outputDevice: string
  micGain: number // %, 0-200
  threshold: number // dB, -70 à -20
  masterVolume: number // %, 0-100
  noiseSuppression: boolean
  echoCancellation: boolean
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  inputDevice: "",
  outputDevice: "",
  micGain: 100,
  threshold: -50,
  masterVolume: 100,
  noiseSuppression: true,
  echoCancellation: true,
}

/**
 * Débit Opus demandé à l'émetteur : 64 kbps au lieu des ~32 de Chrome, voix plus nette
 * et place pour la correction d'erreurs intégrée (FEC, `useinbandfec=1`, déjà
 * négociée : chaque paquet porte une version allégée du précédent, qui remplace un
 * paquet perdu sans latence ajoutée). Trames de 20 ms : plus longues, ce serait autant
 * de latence en plus.
 */
const OPUS_BITRATE = 64_000

/**
 * str0m ne sait pas annoncer `maxaveragebitrate` : ajouté à la description du serveur
 * avant de l'appliquer. Côté émetteur, c'est elle qui fixe le débit d'encodage.
 */
function withOpusBitrate(sdp: string): string {
  const opus = /^a=rtpmap:(\d+) opus\/48000/im.exec(sdp)?.[1]
  if (!opus) return sdp
  return sdp.replace(new RegExp(`^(a=fmtp:${opus} .*)$`, "gm"), (line) =>
    line.includes("maxaveragebitrate") ? line : `${line};maxaveragebitrate=${OPUS_BITRATE}`,
  )
}

/** Silence au-delà duquel l'envoi s'arrête : ne pas manger les fins de mots. */
const HANGOVER_MS = 400
/** Niveau au-dessus duquel une personne reçue « parle » (story 72). */
const SPEAKING_DB = -55
const SPEAKING_POLL_MS = 100

// Niveau par trame de 20 ms (960 échantillons à 48 kHz, quelques blocs de 128) ; la
// décision « parle / se tait » est prise ici, les messages ne partent qu'au changement
// (et le niveau toutes les 100 ms, pour la jauge des Paramètres). Laisse passer le son.
const VAD_WORKLET = `
class Vad extends AudioWorkletProcessor {
  constructor() {
    super()
    this.threshold = -50
    this.sum = 0
    this.count = 0
    this.lastVoice = -Infinity
    this.speaking = false
    this.lastLevel = 0
    this.port.onmessage = (e) => { this.threshold = e.data.threshold }
  }
  process(inputs, outputs) {
    const input = inputs[0][0]
    if (input) {
      outputs[0][0].set(input)
      for (let i = 0; i < input.length; i++) this.sum += input[i] * input[i]
      this.count += input.length
    }
    if (this.count >= sampleRate / 50) {
      const db = 10 * Math.log10(this.sum / this.count + 1e-12)
      this.sum = 0
      this.count = 0
      const now = currentTime * 1000
      if (db > this.threshold) this.lastVoice = now
      const speaking = now - this.lastVoice < ${HANGOVER_MS}
      if (speaking !== this.speaking) {
        this.speaking = speaking
        this.port.postMessage({ speaking })
      }
      if (now - this.lastLevel >= 100) {
        this.lastLevel = now
        this.port.postMessage({ db })
      }
    }
    return true
  }
}
registerProcessor("vad", Vad)
`

type Pipe = {
  element: HTMLAudioElement
  gain: GainNode
  analyser: AnalyserNode
}

export type VoiceEvents = {
  /** Story 72 : qui parle (moi compris : `me`). */
  onSpeaking: (who: number | "me", speaking: boolean) => void
  /** Niveau du micro en dB, après gain (jauge des Paramètres). */
  onLevel: (db: number) => void
  /** ICE/DTLS établi, ou perdu. */
  onConnected: (connected: boolean) => void
}

export class VoiceEngine {
  private ctx: AudioContext | null = null
  private mic: MediaStream | null = null
  private micSource: MediaStreamAudioSourceNode | null = null
  private micGain: GainNode | null = null
  private vad: AudioWorkletNode | null = null
  private sendTrack: MediaStreamTrack | null = null
  private master: GainNode | null = null
  private pc: RTCPeerConnection | null = null
  private sender: RTCRtpSender | null = null
  private readonly pipes = new Map<string, Pipe>()
  /** `mid` → personne, d'après le dernier VoiceOffer. */
  private mapping = new Map<string, number>()
  private volumes: Record<number, number> = {}
  private queue: Promise<unknown> = Promise.resolve()
  private speakingTimer: ReturnType<typeof setInterval> | null = null
  private readonly othersSpeaking = new Set<number>()
  private voiceDetected = false
  private muted = false
  private deafened = false
  private prefs: VoicePrefs
  private readonly events: VoiceEvents

  constructor(prefs: VoicePrefs, events: VoiceEvents) {
    this.prefs = prefs
    this.events = events
  }

  /** Micro et graphe audio ; rend l'offre SDP (sans candidats ICE, pas de trickle). */
  async start(muted: boolean, deafened: boolean, volumes: Record<number, number>): Promise<string> {
    this.muted = muted
    this.deafened = deafened
    this.volumes = volumes
    await this.openMic()
    const pc = new RTCPeerConnection()
    this.pc = pc
    this.sender = pc.addTransceiver("audio", { direction: "sendonly" }).sender
    pc.ontrack = (e) => this.onTrack(e)
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.events.onConnected(true)
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") this.events.onConnected(false)
    }
    await pc.setLocalDescription(await pc.createOffer())
    this.speakingTimer = setInterval(() => this.pollSpeaking(), SPEAKING_POLL_MS)
    return pc.localDescription!.sdp
  }

  /** Paramètres, hors vocal : le micro et la jauge seulement, sans connexion. */
  async testMic(): Promise<void> {
    this.muted = true
    await this.openMic()
  }

  /** Réponse du serveur à notre offre (`VoiceJoined`). */
  applyAnswer(sdp: string): Promise<void> {
    return this.enqueue(async () => {
      await this.pc?.setRemoteDescription({ type: "answer", sdp: withOpusBitrate(sdp) })
    })
  }

  /** Offre du serveur (`VoiceOffer`) : rend notre réponse. */
  handleOffer(sdp: string, tracks: { mid: string; userId: number }[]): Promise<string | null> {
    return this.enqueue(async () => {
      const pc = this.pc
      if (!pc) return null
      await pc.setRemoteDescription({ type: "offer", sdp: withOpusBitrate(sdp) })
      this.mapping = new Map(tracks.map((t) => [t.mid, t.userId]))
      for (const mid of this.pipes.keys()) this.applyVolume(mid)
      await pc.setLocalDescription(await pc.createAnswer())
      return pc.localDescription!.sdp
    })
  }

  setMuted(muted: boolean, deafened: boolean): void {
    this.muted = muted || deafened
    this.deafened = deafened
    this.updateSending()
    if (this.master) this.master.gain.value = deafened ? 0 : this.prefs.masterVolume / 100
  }

  setVolumes(volumes: Record<number, number>): void {
    this.volumes = volumes
    for (const mid of this.pipes.keys()) this.applyVolume(mid)
  }

  /** Réglages de l'appareil modifiés : appliqués à chaud, micro rouvert si besoin. */
  async setPrefs(prefs: VoicePrefs): Promise<void> {
    const reopen =
      prefs.inputDevice !== this.prefs.inputDevice ||
      prefs.noiseSuppression !== this.prefs.noiseSuppression ||
      prefs.echoCancellation !== this.prefs.echoCancellation
    this.prefs = prefs
    if (this.micGain) this.micGain.gain.value = prefs.micGain / 100
    this.vad?.port.postMessage({ threshold: prefs.threshold })
    if (this.master) this.master.gain.value = this.deafened ? 0 : prefs.masterVolume / 100
    await this.applyOutputDevice()
    if (reopen && this.ctx) await this.openMic()
  }

  stop(): void {
    if (this.speakingTimer) clearInterval(this.speakingTimer)
    this.speakingTimer = null
    this.pc?.close()
    this.pc = null
    this.sender = null
    for (const pipe of this.pipes.values()) pipe.element.srcObject = null
    this.pipes.clear()
    this.mic?.getTracks().forEach((t) => t.stop())
    this.mic = null
    this.micSource = null
    void this.ctx?.close()
    this.ctx = null
    this.micGain = null
    this.vad = null
    this.master = null
    this.sendTrack = null
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** (Ré)ouvre le micro avec les réglages courants ; crée le graphe au premier appel. */
  private async openMic(): Promise<void> {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.prefs.inputDevice ? { exact: this.prefs.inputDevice } : undefined,
        noiseSuppression: this.prefs.noiseSuppression,
        echoCancellation: this.prefs.echoCancellation,
        // Le gain est le nôtre (story 75) : pas de correction automatique par-dessus.
        autoGainControl: false,
      },
    })
    this.mic?.getTracks().forEach((t) => t.stop())
    this.mic = mic
    if (!this.ctx) {
      const ctx = new AudioContext()
      this.ctx = ctx
      // Rejoint sans clic (reconnexion, story 21) : le navigateur peut le créer en pause.
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined)
      const url = URL.createObjectURL(new Blob([VAD_WORKLET], { type: "text/javascript" }))
      await ctx.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)
      this.micGain = ctx.createGain()
      this.vad = new AudioWorkletNode(ctx, "vad")
      this.vad.port.onmessage = (e) => this.onVad(e.data)
      const out = ctx.createMediaStreamDestination()
      this.micGain.connect(this.vad).connect(out)
      this.sendTrack = out.stream.getAudioTracks()[0]
      this.master = ctx.createGain()
      this.master.connect(ctx.destination)
      await this.applyOutputDevice()
    }
    this.micGain!.gain.value = this.prefs.micGain / 100
    this.vad!.port.postMessage({ threshold: this.prefs.threshold })
    this.master!.gain.value = this.deafened ? 0 : this.prefs.masterVolume / 100
    this.micSource?.disconnect()
    this.micSource = this.ctx.createMediaStreamSource(mic)
    this.micSource.connect(this.micGain!)
  }

  private async applyOutputDevice(): Promise<void> {
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null
    if (ctx?.setSinkId) await ctx.setSinkId(this.prefs.outputDevice).catch(() => undefined)
  }

  private onVad(data: { speaking?: boolean; db?: number }): void {
    if (data.db !== undefined) this.events.onLevel(data.db)
    if (data.speaking === undefined) return
    this.voiceDetected = data.speaking
    this.updateSending()
  }

  /** Story 71 : la piste n'est attachée que si l'on parle et que le micro est ouvert. */
  private updateSending(): void {
    const sending = this.voiceDetected && !this.muted
    void this.sender?.replaceTrack(sending ? this.sendTrack : null)
    this.events.onSpeaking("me", sending)
  }

  private onTrack(e: RTCTrackEvent): void {
    const mid = e.transceiver.mid
    if (!mid || !this.ctx || !this.master || this.pipes.has(mid)) return
    const stream = new MediaStream([e.track])
    const element = new Audio()
    element.srcObject = stream
    element.muted = true
    void element.play().catch(() => undefined)
    const gain = this.ctx.createGain()
    const analyser = this.ctx.createAnalyser()
    analyser.fftSize = 512
    const source = this.ctx.createMediaStreamSource(stream)
    source.connect(gain).connect(this.master)
    source.connect(analyser)
    this.pipes.set(mid, { element, gain, analyser })
    this.applyVolume(mid)
  }

  private applyVolume(mid: string): void {
    const pipe = this.pipes.get(mid)
    const user = this.mapping.get(mid)
    if (!pipe) return
    pipe.gain.gain.value = user === undefined ? 0 : (this.volumes[user] ?? 100) / 100
  }

  /** Story 72 : niveau de chaque piste reçue, toutes les 100 ms. */
  private pollSpeaking(): void {
    const samples = new Float32Array(512)
    const now = new Set<number>()
    for (const [mid, pipe] of this.pipes) {
      const user = this.mapping.get(mid)
      if (user === undefined) continue
      pipe.analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const v of samples) sum += v * v
      if (10 * Math.log10(sum / samples.length + 1e-12) > SPEAKING_DB) now.add(user)
    }
    for (const user of now) if (!this.othersSpeaking.has(user)) this.events.onSpeaking(user, true)
    for (const user of this.othersSpeaking) if (!now.has(user)) this.events.onSpeaking(user, false)
    this.othersSpeaking.clear()
    for (const user of now) this.othersSpeaking.add(user)
  }
}

/** Test du micro dans les Paramètres hors vocal : la même chaîne, sans connexion. */
export async function micLevelTest(prefs: VoicePrefs, onLevel: (db: number) => void): Promise<VoiceEngine> {
  const engine = new VoiceEngine(prefs, { onSpeaking: () => {}, onLevel, onConnected: () => {} })
  await engine.testMic()
  return engine
}

// Moteur audio du vocal (stories 18, 71-76), hors de React et du store : micro, gain,
// détection de voix, connexion WebRTC, lecture des autres avec un volume par personne.
//
// Envoi : micro → gain (0-200 %, story 75) → détection de voix (AudioWorklet) → piste
// envoyée. En push-to-talk (story 78), la touche remplace la détection. Sous le seuil pendant HANGOVER_MS, ou micro coupé, la détection laisse
// passer du silence numérique (fondu de quelques ms) : avec `usedtx=1`, Opus n'envoie
// plus qu'un paquet minuscule toutes les 400 ms (story 71). La piste reste attachée :
// la détacher (`replaceTrack(null)`) gelait les horodatages RTP pendant le silence, et
// le navigateur qui écoute, voyant chaque reprise de parole arriver « en retard » de
// toute la durée du silence, gonflait sa mémoire tampon jusqu'à 1,4 s (mesuré sous
// Firefox). La détection tourne dans le moteur audio et non sur un minuteur, que les
// navigateurs ralentissent à une fois par seconde dans un onglet en arrière-plan.
//
// Réception : une piste par autre participant (`mid` → personne d'après le dernier
// VoiceOffer), chacune → gain de la personne (story 76) → gain général (story 74) →
// limiteur → sortie. Les volumes en % suivent l'oreille (`loudness`) : linéaire, 50 %
// ne s'entendait presque pas moins fort que 100 %. Le limiteur évite qu'une voix
// poussée à 200 % sature. Chrome ne fait passer le son d'une piste WebRTC dans Web Audio que si elle
// est aussi attachée à un élément <audio> (muet) : on le fait.
//
// Négociation (story 18) : une seule offre du navigateur (`start`), puis il ne fait que
// répondre aux offres du serveur. Les opérations SDP sont mises en file : une offre du
// serveur peut arriver avant que la réponse à la nôtre soit appliquée.

/** Réglages de l'appareil (stories 71, 74, 75, 77, 78), mémorisés localement. */
export type VoicePrefs = {
  inputDevice: string // "" = défaut
  outputDevice: string
  micGain: number // %, 0-200
  threshold: number // dB, -70 à -20
  masterVolume: number // %, 0-100
  noiseSuppression: boolean
  echoCancellation: boolean
  voiceSounds: boolean
  pushToTalk: boolean
  pttKey: string // KeyboardEvent.code
  pttLabel: string // la touche telle qu'affichée au moment du choix
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  inputDevice: "",
  outputDevice: "",
  micGain: 100,
  threshold: -50,
  masterVolume: 100,
  noiseSuppression: true,
  echoCancellation: true,
  voiceSounds: true,
  pushToTalk: false,
  pttKey: "Backquote",
  pttLabel: "²",
}

/**
 * Débit Opus de l'émetteur, choisi par l'admin (story 79, 64 kbps par défaut au lieu
 * des ~32 de Chrome : voix plus nette et place pour la correction d'erreurs intégrée,
 * FEC, `useinbandfec=1`, déjà négociée : chaque paquet porte une version allégée du
 * précédent, qui remplace un paquet perdu sans latence ajoutée). Trames de 20 ms :
 * plus longues, ce serait autant de latence en plus. Inscrit dans chaque négociation
 * (`maxaveragebitrate`) et appliqué à chaud (`setParameters`) quand il change.
 */

/**
 * str0m ne sait pas annoncer `maxaveragebitrate` : ajouté à la description du serveur
 * avant de l'appliquer. Côté émetteur, c'est elle qui fixe le débit d'encodage.
 */
function withOpusBitrate(sdp: string, kbps: number): string {
  const opus = /^a=rtpmap:(\d+) opus\/48000/im.exec(sdp)?.[1]
  if (!opus) return sdp
  return sdp.replace(new RegExp(`^(a=fmtp:${opus} .*)$`, "gm"), (line) =>
    line.includes("maxaveragebitrate") ? line : `${line};maxaveragebitrate=${kbps * 1000}`,
  )
}

/** Silence au-delà duquel l'envoi s'arrête : ne pas manger les fins de mots. */
const HANGOVER_MS = 400
/** Niveau au-dessus duquel une personne reçue « parle » (story 72). */
const SPEAKING_DB = -55
const SPEAKING_POLL_MS = 100

/** Volume d'écoute en % → gain : au carré, soit -12 dB à 50 % et +12 dB à 200 %. */
const loudness = (percent: number) => (percent / 100) ** 2

// Niveau par trame de 20 ms (960 échantillons à 48 kHz, quelques blocs de 128) ; la
// décision « parle / se tait » est prise ici, les messages ne partent qu'au changement
// (et le niveau toutes les 100 ms, pour la jauge des Paramètres). Laisse passer le son
// quand on parle micro ouvert (en push-to-talk : touche maintenue), sinon du silence,
// avec un fondu (~2 ms) contre les clics.
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
    this.muted = false
    this.ptt = false
    this.held = false
    this.gain = 0
    this.port.onmessage = (e) => {
      if (e.data.threshold !== undefined) this.threshold = e.data.threshold
      if (e.data.muted !== undefined) this.muted = e.data.muted
      if (e.data.ptt !== undefined) this.ptt = e.data.ptt
      if (e.data.held !== undefined) this.held = e.data.held
    }
  }
  process(inputs, outputs) {
    const input = inputs[0][0]
    const output = outputs[0][0]
    const target = (this.ptt ? this.held : this.speaking) && !this.muted ? 1 : 0
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.sum += input[i] * input[i]
        this.gain += (target - this.gain) * 0.01
        output[i] = input[i] * this.gain
      }
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
  private master: GainNode | null = null
  private pc: RTCPeerConnection | null = null
  /** Sortie de la détection de voix, envoyée telle quelle (silence compris). */
  private sendTrack: MediaStreamTrack | null = null
  private readonly pipes = new Map<string, Pipe>()
  /** `mid` → personne, d'après le dernier VoiceOffer. */
  private mapping = new Map<string, number>()
  private volumes: Record<number, number> = {}
  /** Story 79 : kbps. */
  private bitrate = 64
  private queue: Promise<unknown> = Promise.resolve()
  private speakingTimer: ReturnType<typeof setInterval> | null = null
  private readonly othersSpeaking = new Set<number>()
  private voiceDetected = false
  private pttHeld = false
  private muted = false
  private deafened = false
  private prefs: VoicePrefs
  private readonly events: VoiceEvents

  constructor(prefs: VoicePrefs, events: VoiceEvents) {
    this.prefs = prefs
    this.events = events
  }

  /** Micro et graphe audio ; rend l'offre SDP (sans candidats ICE, pas de trickle). */
  async start(muted: boolean, deafened: boolean, volumes: Record<number, number>, bitrate: number): Promise<string> {
    this.bitrate = bitrate
    this.muted = muted
    this.deafened = deafened
    this.volumes = volumes
    await this.openMic()
    const pc = new RTCPeerConnection()
    this.pc = pc
    pc.addTransceiver(this.sendTrack!, { direction: "sendonly" })
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
      await this.pc?.setRemoteDescription({ type: "answer", sdp: withOpusBitrate(sdp, this.bitrate) })
    })
  }

  /** Offre du serveur (`VoiceOffer`) : rend notre réponse. */
  handleOffer(sdp: string, tracks: { mid: string; userId: number }[]): Promise<string | null> {
    return this.enqueue(async () => {
      const pc = this.pc
      if (!pc) return null
      await pc.setRemoteDescription({ type: "offer", sdp: withOpusBitrate(sdp, this.bitrate) })
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
    if (this.master) this.master.gain.value = deafened ? 0 : loudness(this.prefs.masterVolume)
  }

  /** Story 78 : touche du push-to-talk enfoncée ou relâchée. */
  setPttHeld(held: boolean): void {
    this.pttHeld = held
    this.updateSending()
  }

  /** Story 79 : débit changé par l'admin pendant le vocal. */
  setBitrate(kbps: number): void {
    if (kbps === this.bitrate) return
    this.bitrate = kbps
    void this.enqueue(async () => {
      for (const sender of this.pc?.getSenders() ?? []) {
        const params = sender.getParameters()
        if (!params.encodings?.length) continue
        params.encodings[0].maxBitrate = kbps * 1000
        await sender.setParameters(params)
      }
    }).catch(() => undefined)
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
    this.vad?.port.postMessage({ threshold: prefs.threshold, ptt: prefs.pushToTalk })
    this.updateSending()
    if (this.master) this.master.gain.value = this.deafened ? 0 : loudness(prefs.masterVolume)
    await this.applyOutputDevice()
    if (reopen && this.ctx) await this.openMic()
  }

  stop(): void {
    if (this.speakingTimer) clearInterval(this.speakingTimer)
    this.speakingTimer = null
    this.pc?.close()
    this.pc = null
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
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -3
      limiter.knee.value = 0
      limiter.ratio.value = 20
      limiter.attack.value = 0.002
      limiter.release.value = 0.1
      this.master.connect(limiter).connect(ctx.destination)
      await this.applyOutputDevice()
    }
    this.micGain!.gain.value = this.prefs.micGain / 100
    this.vad!.port.postMessage({ threshold: this.prefs.threshold, muted: this.muted, ptt: this.prefs.pushToTalk })
    this.master!.gain.value = this.deafened ? 0 : loudness(this.prefs.masterVolume)
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

  /** Stories 71, 78 : la voix ne part que si l'on parle (ou touche maintenue) micro ouvert. */
  private updateSending(): void {
    this.vad?.port.postMessage({ muted: this.muted, held: this.pttHeld })
    const talking = this.prefs.pushToTalk ? this.pttHeld : this.voiceDetected
    this.events.onSpeaking("me", talking && !this.muted)
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
    pipe.gain.gain.value = user === undefined ? 0 : loudness(this.volumes[user] ?? 100)
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

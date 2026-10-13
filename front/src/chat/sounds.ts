// Story 57 : sons de notification synthétisés en Web Audio — aucun fichier à héberger,
// aucune licence. Chaque son est une suite de notes courtes (fréquence, forme d'onde,
// début, durée), avec une enveloppe attaque rapide / décroissance exponentielle.

type Note = { freq: number; to?: number; wave: OscillatorType; at: number; dur: number; gain: number }

export const SOUNDS: { id: string; label: string; notes: Note[] }[] = [
  {
    id: "pop",
    label: "Pop",
    notes: [{ freq: 900, to: 450, wave: "sine", at: 0, dur: 0.09, gain: 0.35 }],
  },
  {
    id: "ding",
    label: "Ding",
    notes: [
      { freq: 1318, wave: "triangle", at: 0, dur: 0.6, gain: 0.25 },
      { freq: 2636, wave: "sine", at: 0, dur: 0.3, gain: 0.06 },
    ],
  },
  {
    id: "bulle",
    label: "Bulle",
    notes: [
      { freq: 320, to: 880, wave: "sine", at: 0, dur: 0.08, gain: 0.3 },
      { freq: 420, to: 1100, wave: "sine", at: 0.09, dur: 0.08, gain: 0.25 },
    ],
  },
  {
    id: "carillon",
    label: "Carillon",
    notes: [
      { freq: 784, wave: "sine", at: 0, dur: 0.5, gain: 0.22 },
      { freq: 1175, wave: "sine", at: 0.12, dur: 0.6, gain: 0.2 },
    ],
  },
  {
    id: "doux",
    label: "Doux",
    notes: [{ freq: 523, wave: "sine", at: 0, dur: 0.35, gain: 0.18 }],
  },
]

/** Story 77 : arrivée (montant) et départ (descendant) dans le vocal. */
const VOICE_SOUNDS: Record<"join" | "leave", Note[]> = {
  join: [
    { freq: 587, wave: "sine", at: 0, dur: 0.12, gain: 0.2 },
    { freq: 880, wave: "sine", at: 0.09, dur: 0.18, gain: 0.2 },
  ],
  leave: [
    { freq: 880, wave: "sine", at: 0, dur: 0.12, gain: 0.2 },
    { freq: 587, wave: "sine", at: 0.09, dur: 0.18, gain: 0.2 },
  ],
}

let context: AudioContext | null = null

/**
 * Les navigateurs bloquent le son tant que la page n'a reçu aucune interaction : le
 * contexte audio est (re)lancé au premier clic ou à la première touche.
 */
export function unlockAudioOnInteraction(): void {
  const unlock = () => {
    context ??= new AudioContext()
    void context.resume()
  }
  window.addEventListener("pointerdown", unlock, { once: true })
  window.addEventListener("keydown", unlock, { once: true })
}

export function playSound(id: string): void {
  const sound = SOUNDS.find((s) => s.id === id)
  if (sound) play(sound.notes)
}

export function playVoiceSound(kind: "join" | "leave"): void {
  play(VOICE_SOUNDS[kind])
}

function play(notes: Note[]): void {
  context ??= new AudioContext()
  const ctx = context
  if (ctx.state === "suspended") void ctx.resume()
  const start = ctx.currentTime + 0.01
  for (const note of notes) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = note.wave
    osc.frequency.setValueAtTime(note.freq, start + note.at)
    if (note.to) osc.frequency.exponentialRampToValueAtTime(note.to, start + note.at + note.dur)
    gain.gain.setValueAtTime(0.0001, start + note.at)
    gain.gain.exponentialRampToValueAtTime(note.gain, start + note.at + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.dur)
    osc.connect(gain).connect(ctx.destination)
    osc.start(start + note.at)
    osc.stop(start + note.at + note.dur + 0.05)
  }
}

// Paramètres › Voix (stories 71, 74, 75) : micro et sortie, gain du micro, sensibilité
// de la détection de voix avec la jauge en direct, volume général, traitements du
// navigateur. Tout est propre à l'appareil.

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import type { ChatState, ChatStore } from "./store"
import type { VoicePrefs } from "./voice-engine"

/** Bornes de la jauge et du seuil, en dB. */
const METER_MIN = -70
const METER_MAX = -20

function Slider({
  label,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  unit: string
  onChange: (value: number) => void
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="flex justify-between">
        {label}
        <span className="text-muted-foreground tabular-nums">
          {value} {unit}
        </span>
      </span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

function DeviceSelect({
  label,
  kind,
  value,
  devices,
  onChange,
}: {
  label: string
  kind: MediaDeviceKind
  value: string
  devices: MediaDeviceInfo[]
  onChange: (id: string) => void
}) {
  const options = devices.filter((d) => d.kind === kind && d.deviceId !== "default")
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border bg-background px-2 text-sm"
      >
        <option value="">Par défaut</option>
        {options.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Périphérique ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  )
}

export function VoiceSettings({ state, store }: { state: ChatState; store: ChatStore }) {
  const prefs = state.voicePrefs
  const update = (patch: Partial<VoicePrefs>) => store.setVoicePrefs({ ...prefs, ...patch })
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [level, setLevel] = useState(METER_MIN)

  // La jauge ouvre le micro (ou suit celui du vocal) ; les noms des périphériques ne
  // sont visibles qu'une fois le micro autorisé.
  useEffect(() => store.watchMicLevel(setLevel), [store])
  useEffect(() => {
    const refresh = () =>
      void navigator.mediaDevices
        .enumerateDevices()
        .then(setDevices)
        .catch(() => setDevices([]))
    refresh()
    navigator.mediaDevices.addEventListener("devicechange", refresh)
    const later = setTimeout(refresh, 1000)
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", refresh)
      clearTimeout(later)
    }
  }, [])

  const canPickOutput = "setSinkId" in AudioContext.prototype
  const percent = (db: number) => ((Math.min(Math.max(db, METER_MIN), METER_MAX) - METER_MIN) / (METER_MAX - METER_MIN)) * 100
  const sending = level > prefs.threshold

  return (
    <div className="flex max-w-md flex-col gap-5">
      <DeviceSelect
        label="Micro"
        kind="audioinput"
        value={prefs.inputDevice}
        devices={devices}
        onChange={(inputDevice) => update({ inputDevice })}
      />
      {canPickOutput && (
        <DeviceSelect
          label="Sortie"
          kind="audiooutput"
          value={prefs.outputDevice}
          devices={devices}
          onChange={(outputDevice) => update({ outputDevice })}
        />
      )}
      <Slider
        label="Gain du micro"
        value={prefs.micGain}
        min={0}
        max={200}
        unit="%"
        onChange={(micGain) => update({ micGain })}
      />

      <div className="flex flex-col gap-1 text-sm">
        <span className="flex justify-between">
          Sensibilité de la détection de voix
          <span className="text-muted-foreground tabular-nums">{prefs.threshold} dB</span>
        </span>
        {/* Jauge du micro (après gain), le seuil en repère : au-dessus, ta voix part. */}
        <div className="relative h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full transition-[width] duration-100", sending ? "bg-emerald-500" : "bg-muted-foreground/40")}
            style={{ width: `${percent(level)}%` }}
          />
          <div className="absolute top-0 h-full w-0.5 bg-foreground" style={{ left: `${percent(prefs.threshold)}%` }} />
        </div>
        <input
          type="range"
          min={METER_MIN}
          max={METER_MAX}
          value={prefs.threshold}
          onChange={(e) => update({ threshold: Number(e.target.value) })}
        />
        <p className="text-xs text-muted-foreground">
          {sending ? "Ta voix est envoyée." : "Silence : rien n'est envoyé."} Règle le repère juste au-dessus de ton
          bruit de fond.
        </p>
      </div>

      <Slider
        label="Volume des vocaux"
        value={prefs.masterVolume}
        min={0}
        max={100}
        unit="%"
        onChange={(masterVolume) => update({ masterVolume })}
      />

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={prefs.noiseSuppression}
          onChange={(e) => update({ noiseSuppression: e.target.checked })}
        />
        Suppression du bruit
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={prefs.echoCancellation}
          onChange={(e) => update({ echoCancellation: e.target.checked })}
        />
        Annulation d'écho (utile sans casque)
      </label>
    </div>
  )
}

// Story 60 : menu Paramètres (⚙ en bas à gauche) — Profil, Apparence, Notifications,
// extensible (vidéo, audio…). Chaque onglet est une section indépendante.

import { useEffect, useState } from "react"
import { Bell, BellOff, Mic, Monitor, Moon, Palette, Play, ShieldCheck, Sun, User, VolumeX, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { AdminSettings } from "./AdminSettings"
import { ProfileSettings } from "./ProfileSettings"
import { playSound, SOUNDS } from "./sounds"
import type { ChatState, ChatStore } from "./store"
import { VoiceSettings } from "./VoiceSettings"

export type SettingsTab = "profile" | "appearance" | "notifications" | "voice" | "admin"

const TABS = [
  { id: "profile", label: "Profil", Icon: User },
  { id: "appearance", label: "Apparence", Icon: Palette },
  { id: "notifications", label: "Notifications", Icon: Bell },
  { id: "voice", label: "Voix", Icon: Mic },
  { id: "admin", label: "Administration", Icon: ShieldCheck },
] as const

export function SettingsPanel({
  state,
  store,
  initialTab,
  onClose,
}: {
  state: ChatState
  store: ChatStore
  initialTab: SettingsTab
  onClose: () => void
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal
      aria-label="Paramètres"
    >
      <div className="flex h-[min(42rem,100%)] w-full max-w-3xl overflow-hidden rounded-xl border bg-background shadow-xl">
        <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r bg-muted/40 p-2">
          <span className="px-2 pt-1 pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Paramètres
          </span>
          {TABS.filter((t) => t.id !== "admin" || state.me?.isAdmin).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                tab === id && "bg-muted font-medium text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center justify-between border-b px-5">
            <h2 className="font-semibold">{TABS.find((t) => t.id === tab)!.label}</h2>
            <Button variant="ghost" size="icon-sm" onClick={onClose} title="Fermer (Échap)">
              <X />
            </Button>
          </header>
          <div className="flex-1 overflow-y-auto p-5">
            {tab === "profile" && <ProfileSettings state={state} store={store} />}
            {tab === "appearance" && <AppearanceSettings state={state} store={store} />}
            {tab === "notifications" && <NotificationSettings state={state} store={store} />}
            {tab === "voice" && <VoiceSettings state={state} store={store} />}
            {tab === "admin" && state.me?.isAdmin && <AdminSettings state={state} store={store} />}
          </div>
        </section>
      </div>
    </div>
  )
}

const THEMES = [
  { value: "system", label: "Système", Icon: Monitor },
  { value: "light", label: "Clair", Icon: Sun },
  { value: "dark", label: "Sombre", Icon: Moon },
] as const

/** Story 55. */
function AppearanceSettings({ state, store }: { state: ChatState; store: ChatStore }) {
  const me = state.me!
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">Thème</span>
      <div className="grid max-w-md grid-cols-3 gap-2" role="radiogroup" aria-label="Thème">
        {THEMES.map(({ value, label, Icon }) => (
          <Button
            key={value}
            type="button"
            role="radio"
            aria-checked={me.theme === value}
            variant={me.theme === value ? "secondary" : "ghost"}
            className={cn(me.theme === value && "ring-1 ring-border")}
            onClick={() => void store.setTheme(value)}
          >
            <Icon />
            {label}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Mémorisé avec ton compte, sur tous tes appareils.</p>
    </div>
  )
}

/** Stories 57-59. */
function NotificationSettings({ state, store }: { state: ChatState; store: ChatStore }) {
  const settings = state.settings
  const [permission, setPermission] = useState(() =>
    "Notification" in window ? Notification.permission : ("unsupported" as const),
  )
  const update = (patch: Partial<typeof settings>) => void store.setNotifySettings({ ...settings, ...patch })
  const others = Object.values(state.users).filter((u) => u.id !== state.me?.id)
  const allMuted =
    state.channels.every((c) => store.channelRule(c.id).level === "nothing") &&
    others.every((u) => store.personRule(u.id).dmMuted && store.personRule(u.id).mentionsMuted) &&
    state.channels.length + others.length > 0

  async function toggleDesktop() {
    if (settings.desktop) return update({ desktop: false })
    if (permission === "unsupported") return
    const granted = permission === "granted" ? "granted" : await Notification.requestPermission()
    setPermission(granted)
    if (granted === "granted") update({ desktop: true })
    else store.flash("Notifications refusées par le navigateur")
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Son</h3>
        <div className="flex flex-wrap gap-2">
          {[{ id: "", label: "Aucun" }, ...SOUNDS].map((sound) => (
            <Button
              key={sound.id}
              type="button"
              size="sm"
              variant={settings.sound === sound.id ? "secondary" : "ghost"}
              className={cn(settings.sound === sound.id && "ring-1 ring-border")}
              onClick={() => {
                update({ sound: sound.id })
                if (sound.id) playSound(sound.id)
              }}
            >
              {sound.id ? <Play /> : <VolumeX />}
              {sound.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Joué quand un message arrive dans une conversation que tu ne regardes pas : chaque message
          d'un DM, seulement les mentions de toi (@) dans un salon.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Notifications système</h3>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-foreground"
            checked={settings.desktop}
            disabled={permission === "unsupported"}
            onChange={() => void toggleDesktop()}
          />
          Afficher une notification de l'OS quand l'app n'est pas au premier plan
        </label>
        {permission === "denied" && (
          <p className="text-xs text-destructive">Bloquées dans le navigateur : autorise-les dans ses réglages du site.</p>
        )}
        {permission === "unsupported" && (
          <p className="text-xs text-muted-foreground">Non disponibles dans ce navigateur.</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Par salon et par personne</h3>
        <p className="text-xs text-muted-foreground">
          Clic droit sur une personne (liste Privé, membres) ou sur un salon — ou son bouton 🔔 — pour régler ses
          notifications : salon (tous les messages, mentions seulement, rien ; son), personne (ses messages privés et ses
          mentions de toi ; son). Par défaut : chaque message privé, les mentions de toi dans les salons.
        </p>
        <div>
          <Button variant="outline" size="sm" onClick={() => void store.muteAll(!allMuted)}>
            {allMuted ? <Bell /> : <BellOff />}
            {allMuted ? "Tout réactiver" : "Tout couper"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          « Tout couper » règle chaque salon sur « rien » et chaque personne sur « ne pas notifier », un par un : tu peux
          ensuite n'en réactiver qu'un.
        </p>
      </section>
    </div>
  )
}

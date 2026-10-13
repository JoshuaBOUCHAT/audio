// Story 63 : réglages de notification là où sont les gens et les salons — clic droit
// sur une personne ou un salon, bouton 🔔 d'un salon, section de la carte de profil.
// Les mêmes options servent partout (`PersonNotifyOptions`, `ChannelNotifyOptions`).

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Hash, MessageCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ChannelLevel } from "./model"
import type { ChatState, ChatStore } from "./store"

/** Menu flottant à une position (clic droit, bouton) ; se ferme au clic à côté / Échap. */
export function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number
  y: number
  onClose: () => void
  children: ReactNode
}) {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  // Gardé dans la fenêtre une fois sa taille connue.
  useLayoutEffect(() => {
    const el = menu.current
    if (!el) return
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)),
    })
  }, [x, y])

  useEffect(() => {
    const onDown = (e: MouseEvent) => !menu.current?.contains(e.target as Node) && onClose()
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    window.addEventListener("blur", onClose)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("blur", onClose)
    }
  }, [onClose])

  return (
    <div
      ref={menu}
      role="menu"
      className="fixed z-40 w-64 rounded-lg border bg-popover p-1 text-popover-foreground shadow-xl"
      style={position ?? { left: x, top: y, visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  )
}

export function MenuTitle({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 px-2 pt-1.5 pb-1 text-sm font-semibold">{children}</div>
}

export function MenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted [&_svg]:size-4"
    >
      {children}
    </button>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="py-1">
      <div className="px-2 pb-0.5 text-[0.7rem] font-semibold tracking-wide text-muted-foreground uppercase">{title}</div>
      {children}
    </div>
  )
}

/** Interrupteur sur une ligne, désactivable (le son quand les notifications sont coupées). */
function Toggle({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm enabled:hover:bg-muted disabled:opacity-40"
    >
      {label}
      <span
        className={cn(
          "relative h-4.5 w-8 shrink-0 rounded-full transition-colors",
          checked && !disabled ? "bg-emerald-500" : "bg-muted-foreground/30",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-[left]",
            checked ? "left-4" : "left-0.5",
          )}
        />
      </span>
    </button>
  )
}

/** Story 63 : ses messages privés et ses mentions de moi — notifier, son. */
export function PersonNotifyOptions({ userId, store }: { userId: number; state: ChatState; store: ChatStore }) {
  const rule = store.personRule(userId)
  const set = (patch: Partial<typeof rule>) => void store.setPersonRule(userId, { ...rule, ...patch })
  return (
    <>
      <Section title="Ses messages privés">
        <Toggle label="Notifier" checked={!rule.dmMuted} onChange={(on) => set({ dmMuted: !on })} />
        <Toggle label="Avec son" checked={!rule.dmSilent} disabled={rule.dmMuted} onChange={(on) => set({ dmSilent: !on })} />
      </Section>
      <Section title="Ses mentions de toi">
        <Toggle label="Notifier" checked={!rule.mentionsMuted} onChange={(on) => set({ mentionsMuted: !on })} />
        <Toggle
          label="Avec son"
          checked={!rule.mentionsSilent}
          disabled={rule.mentionsMuted}
          onChange={(on) => set({ mentionsSilent: !on })}
        />
      </Section>
    </>
  )
}

const LEVELS: { value: ChannelLevel; label: string }[] = [
  { value: "all", label: "Tous les messages" },
  { value: "mentions", label: "Mentions seulement" },
  { value: "nothing", label: "Rien" },
]

/** Story 63 : tous les messages / mentions seulement / rien, et son. */
export function ChannelNotifyOptions({ channelId, store }: { channelId: number; state: ChatState; store: ChatStore }) {
  const rule = store.channelRule(channelId)
  return (
    <>
      <Section title="Notifier pour">
        {LEVELS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            role="menuitemradio"
            aria-checked={rule.level === value}
            onClick={() => void store.setChannelRule(channelId, { ...rule, level: value })}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
          >
            <span
              className={cn(
                "flex size-4 items-center justify-center rounded-full border",
                rule.level === value && "border-foreground",
              )}
            >
              {rule.level === value && <span className="size-2 rounded-full bg-foreground" />}
            </span>
            {label}
          </button>
        ))}
      </Section>
      <Section title="Son">
        <Toggle
          label="Avec son"
          checked={!rule.silent}
          disabled={rule.level === "nothing"}
          onChange={(on) => void store.setChannelRule(channelId, { ...rule, silent: !on })}
        />
      </Section>
    </>
  )
}

/** Clic droit sur une personne (liste Privé, membres). */
export function PersonMenu({
  userId,
  x,
  y,
  state,
  store,
  onClose,
  onMessage,
}: {
  userId: number
  x: number
  y: number
  state: ChatState
  store: ChatStore
  onClose: () => void
  /** Absent quand on est déjà dans sa conversation. */
  onMessage?: (userId: number) => void
}) {
  const pseudo = state.users[userId]?.pseudo ?? `Utilisateur #${userId}`
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <MenuTitle>{pseudo}</MenuTitle>
      {onMessage && (
        <MenuItem
          onClick={() => {
            onClose()
            onMessage(userId)
          }}
        >
          <MessageCircle />
          Envoyer un message
        </MenuItem>
      )}
      <PersonNotifyOptions userId={userId} state={state} store={store} />
      <VoiceVolume userId={userId} state={state} store={store} />
    </ContextMenu>
  )
}

/**
 * Story 76 : volume de la personne pour moi (0-200 %), dans les vocaux et plus tard
 * les appels privés. Envoyé et appliqué au relâchement du curseur.
 */
function VoiceVolume({ userId, state, store }: { userId: number; state: ChatState; store: ChatStore }) {
  const saved = state.voiceVolumes[userId] ?? 100
  const [value, setValue] = useState(saved)
  useEffect(() => setValue(saved), [saved])
  const commit = () => value !== saved && void store.setVoiceVolume(userId, value)
  return (
    <label className="flex flex-col gap-1 border-t px-2 pt-2 pb-1 text-sm">
      <span className="flex justify-between">
        Volume (vocal)
        <span className="text-muted-foreground tabular-nums">{value} %</span>
      </span>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
      />
    </label>
  )
}

/** Bouton 🔔 ou clic droit sur un salon. */
export function ChannelMenu({
  channelId,
  x,
  y,
  state,
  store,
  onClose,
}: {
  channelId: number
  x: number
  y: number
  state: ChatState
  store: ChatStore
  onClose: () => void
}) {
  const name = state.channels.find((c) => c.id === channelId)?.name ?? ""
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <MenuTitle>
        <Hash className="size-4 text-muted-foreground" />
        {name}
      </MenuTitle>
      <ChannelNotifyOptions channelId={channelId} state={state} store={store} />
    </ContextMenu>
  )
}

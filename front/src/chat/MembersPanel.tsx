// Story 23 : membres à droite, « En ligne — N » puis « Hors ligne — N », triés par
// pseudo. Hors ligne inclut les invisibles (indiscernables, story 41) ; soi-même suit
// son propre statut. Clic : sa carte de profil (story 44), d'où
// on lui écrit en privé (story 28) ; clic droit : ses notifications (story 63).

import { useState } from "react"
import { cn } from "@/lib/utils"
import { PresenceAvatar } from "./Avatar"
import type { Profile } from "./model"
import { PersonMenu } from "./NotifyMenus"
import { ProfileCard } from "./ProfileCard"
import { isShownOnline, type ChatState, type ChatStore } from "./store"

const byPseudo = (a: Profile, b: Profile) => a.pseudo.localeCompare(b.pseudo, "fr", { sensitivity: "base" })

export function MembersPanel({
  state,
  store,
  onMessage,
  onEditProfile,
}: {
  state: ChatState
  store: ChatStore
  onMessage: (userId: number) => void
  onEditProfile: () => void
}) {
  const [card, setCard] = useState<{ userId: number; anchor: HTMLElement } | null>(null)
  // Story 63 : clic droit sur un membre → ses réglages de notification.
  const [menu, setMenu] = useState<{ userId: number; x: number; y: number } | null>(null)
  const members = Object.values(state.users).filter((u) => u.pseudo).sort(byPseudo)
  const online = members.filter((u) => isShownOnline(state, u.id))
  const offline = members.filter((u) => !isShownOnline(state, u.id))
  // Re-cliquer sur le membre dont la carte est ouverte la referme.
  const select = (userId: number, anchor: HTMLElement) =>
    setCard((open) => (open?.userId === userId ? null : { userId, anchor }))

  return (
    <aside className="w-60 shrink-0 overflow-y-auto border-l bg-muted/40 p-2">
      <Group
        title="En ligne"
        members={online}
        state={state}
        store={store}
        selected={card?.userId}
        onSelect={select}
        onMenu={(userId, x, y) => setMenu({ userId, x, y })}
      />
      <Group
        title="Hors ligne"
        members={offline}
        state={state}
        store={store}
        selected={card?.userId}
        onSelect={select}
        onMenu={(userId, x, y) => setMenu({ userId, x, y })}
        dimmed
      />
      {menu && (
        <PersonMenu
          userId={menu.userId}
          x={menu.x}
          y={menu.y}
          state={state}
          store={store}
          onClose={() => setMenu(null)}
          onMessage={onMessage}
        />
      )}
      {card && (
        <ProfileCard
          userId={card.userId}
          anchor={card.anchor}
          state={state}
          store={store}
          onMessage={onMessage}
          onEditProfile={onEditProfile}
          onClose={() => setCard(null)}
        />
      )}
    </aside>
  )
}

function Group({
  title,
  members,
  state,
  store,
  selected,
  onSelect,
  onMenu,
  dimmed = false,
}: {
  title: string
  members: Profile[]
  state: ChatState
  store: ChatStore
  selected: number | undefined
  onSelect: (userId: number, anchor: HTMLElement) => void
  onMenu: (userId: number, x: number, y: number) => void
  dimmed?: boolean
}) {
  if (members.length === 0) return null
  return (
    <section className="mb-4">
      <h2 className="px-2 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title} — {members.length}
      </h2>
      <ul>
        {members.map((u) => (
          <li key={u.id}>
            <button
              type="button"
              onClick={(e) => onSelect(u.id, e.currentTarget)}
              onContextMenu={(e) => {
                if (u.id === state.me?.id) return
                e.preventDefault()
                onMenu(u.id, e.clientX, e.clientY)
              }}
              aria-expanded={selected === u.id}
              title={`Profil de ${u.pseudo}`}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted",
                selected === u.id && "bg-muted",
                dimmed && selected !== u.id && "opacity-50 hover:opacity-100",
              )}
            >
              <PresenceAvatar userId={u.id} state={state} store={store} className="size-8" />
              <span className="min-w-0 truncate text-sm">
                {u.pseudo}
                {u.id === state.me?.id && <span className="ml-1 text-xs text-muted-foreground">(toi)</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

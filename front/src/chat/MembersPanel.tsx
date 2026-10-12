// Story 23 : membres à droite, « En ligne — N » puis « Hors ligne — N », triés par
// pseudo. Hors ligne inclut les invisibles (indiscernables, story 41) ; soi-même suit
// son propre statut.

import { cn } from "@/lib/utils"
import { PresenceAvatar } from "./Avatar"
import type { Profile } from "./model"
import { isShownOnline, type ChatState, type ChatStore } from "./store"

const byPseudo = (a: Profile, b: Profile) => a.pseudo.localeCompare(b.pseudo, "fr", { sensitivity: "base" })

export function MembersPanel({ state, store }: { state: ChatState; store: ChatStore }) {
  const members = Object.values(state.users).filter((u) => u.pseudo).sort(byPseudo)
  const online = members.filter((u) => isShownOnline(state, u.id))
  const offline = members.filter((u) => !isShownOnline(state, u.id))

  return (
    <aside className="w-60 shrink-0 overflow-y-auto border-l bg-muted/40 p-2">
      <Group title="En ligne" members={online} state={state} store={store} />
      <Group title="Hors ligne" members={offline} state={state} store={store} dimmed />
    </aside>
  )
}

function Group({
  title,
  members,
  state,
  store,
  dimmed = false,
}: {
  title: string
  members: Profile[]
  state: ChatState
  store: ChatStore
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
          <li
            key={u.id}
            className={cn("flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted", dimmed && "opacity-50 hover:opacity-100")}
          >
            <PresenceAvatar userId={u.id} state={state} store={store} className="size-8" />
            <span className="min-w-0 truncate text-sm">
              {u.pseudo}
              {u.id === state.me?.id && <span className="ml-1 text-xs text-muted-foreground">(toi)</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

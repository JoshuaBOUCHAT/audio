// Vue principale : colonne de gauche qui bascule entre salons (création si admin,
// story 7) et conversations privées (stories 28-30), fil de la conversation choisie
// (`ChannelFeed`), membres à droite (story 23, carte de profil au clic, story 44).

import { useEffect, useState } from "react"
import { AtSign, Hash, LogOut, MessageCircle, Plus, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { PresenceAvatar } from "./Avatar"
import { MembersPanel } from "./MembersPanel"
import { ChannelFeed } from "./ChannelFeed"
import { byLastActivity } from "./model"
import { ProfilePanel } from "./ProfilePanel"
import type { ChatState, ChatStore } from "./store"

type View = "channels" | "dms"

export function ChatView({ state, store }: { state: ChatState; store: ChatStore }) {
  const [view, setView] = useState<View>("channels")
  const [selectedChannel, setSelectedChannel] = useState<number | null>(null)
  const [selectedDm, setSelectedDm] = useState<number | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const [membersOpen, setMembersOpen] = useState(true)
  const me = state.me!
  const pseudoOf = (userId: number) => state.users[userId]?.pseudo ?? `Utilisateur #${userId}`

  // Choix de l'utilisateur s'il existe encore, sinon le premier de la liste.
  const dms = [...state.dms].sort(byLastActivity)
  const channel =
    state.channels.find((c) => c.id === selectedChannel) ?? state.channels[0] ?? null
  const dm = dms.find((d) => d.id === selectedDm) ?? dms[0] ?? null
  const currentId = view === "channels" ? channel?.id : dm?.id

  useEffect(() => {
    if (currentId !== undefined) store.open(currentId)
  }, [currentId, store])

  // Story 28 : ouvrir un DM depuis la liste des membres bascule dessus.
  async function messageUser(userId: number) {
    const id = await store.openDm(userId)
    if (id === null) return
    setSelectedDm(id)
    setView("dms")
  }

  return (
    <div className="flex h-svh">
      <aside className="relative flex w-60 shrink-0 flex-col border-r bg-muted/40">
        <div className="flex h-12 items-center gap-1 border-b px-2">
          <div className="flex flex-1 rounded-lg bg-muted p-0.5" role="tablist">
            {(["channels", "dms"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-sm text-muted-foreground",
                  view === v && "bg-background font-medium text-foreground shadow-sm",
                )}
              >
                {v === "channels" ? <Hash className="size-3.5" /> : <MessageCircle className="size-3.5" />}
                {v === "channels" ? "Salons" : "Privé"}
              </button>
            ))}
          </div>
          {view === "channels" && me.isAdmin && <CreateChannel store={store} />}
        </div>

        <nav className="flex-1 overflow-y-auto p-2">
          {view === "channels" ? (
            <>
              {state.channels.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedChannel(c.id)}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                    c.id === channel?.id && "bg-muted font-medium text-foreground",
                  )}
                >
                  <Hash className="size-4 shrink-0" />
                  <span className="truncate">{c.name}</span>
                </button>
              ))}
              {state.channels.length === 0 && (
                <p className="px-2 text-sm text-muted-foreground">
                  {me.isAdmin ? "Aucun salon : crée le premier avec +." : "Aucun salon pour l'instant."}
                </p>
              )}
            </>
          ) : (
            <>
              {dms.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setSelectedDm(d.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                    d.id === dm?.id && "bg-muted font-medium text-foreground",
                  )}
                >
                  <PresenceAvatar userId={d.otherId} state={state} store={store} className="size-8" />
                  <span className="truncate">{pseudoOf(d.otherId)}</span>
                </button>
              ))}
              {dms.length === 0 && (
                <p className="px-2 text-sm text-muted-foreground">
                  Aucune conversation privée. Clique sur un membre à droite pour lui écrire.
                </p>
              )}
            </>
          )}
        </nav>

        <div className="flex items-center gap-1 border-t p-2">
          <button
            type="button"
            onClick={() => setProfileOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left hover:bg-muted"
            title="Modifier le profil"
          >
            <PresenceAvatar userId={me.id} state={state} store={store} className="size-8" />
            <span className="min-w-0 truncate text-sm font-medium">
              {me.pseudo}
              {me.isAdmin && <span className="ml-1 text-xs font-normal text-muted-foreground">(admin)</span>}
            </span>
          </button>
          <Button variant="ghost" size="icon-sm" onClick={store.logout} title="Se déconnecter">
            <LogOut />
          </Button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1.5 border-b px-4">
          {view === "channels" && channel && (
            <>
              <Hash className="size-4 text-muted-foreground" />
              <span className="font-semibold">{channel.name}</span>
            </>
          )}
          {view === "dms" && dm && (
            <>
              <AtSign className="size-4 text-muted-foreground" />
              <span className="font-semibold">{pseudoOf(dm.otherId)}</span>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            {state.phase === "offline" && <span className="text-sm text-muted-foreground">Reconnexion…</span>}
            <Button
              variant={membersOpen ? "secondary" : "ghost"}
              size="icon-sm"
              className="hidden lg:inline-flex"
              onClick={() => setMembersOpen((open) => !open)}
              title={membersOpen ? "Masquer les membres" : "Afficher les membres"}
            >
              <Users />
            </Button>
          </div>
        </header>

        {state.error && (
          <div className="flex items-center justify-between border-b bg-destructive/10 px-4 py-1.5 text-sm text-destructive">
            <span>{state.error}</span>
            <Button variant="ghost" size="xs" onClick={store.clearError}>
              Fermer
            </Button>
          </div>
        )}

        {view === "channels" && channel ? (
          <ChannelFeed key={channel.id} conversationId={channel.id} label={`#${channel.name}`} state={state} store={store} />
        ) : view === "dms" && dm ? (
          <ChannelFeed key={dm.id} conversationId={dm.id} label={`@${pseudoOf(dm.otherId)}`} isDm state={state} store={store} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {view === "channels" ? "Aucun salon sélectionné." : "Aucune conversation sélectionnée."}
          </div>
        )}
      </main>

      {membersOpen && (
        <div className="hidden lg:flex">
          <MembersPanel
            state={state}
            store={store}
            onMessage={(id) => void messageUser(id)}
            onEditProfile={() => setProfileOpen(true)}
          />
        </div>
      )}

      {profileOpen && <ProfilePanel state={state} store={store} onClose={() => setProfileOpen(false)} />}
    </div>
  )
}

function CreateChannel({ store }: { store: ChatStore }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")

  if (!open) {
    return (
      <Button variant="ghost" size="icon-sm" onClick={() => setOpen(true)} title="Créer un salon">
        <Plus />
      </Button>
    )
  }
  return (
    <form
      className="absolute top-12 left-0 z-10 flex w-60 gap-1 border-b border-r bg-background p-2"
      onSubmit={async (e) => {
        e.preventDefault()
        if (await store.createChannel(name)) {
          setName("")
          setOpen(false)
        }
      }}
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        placeholder="nom du salon"
        autoFocus
      />
      <Button type="submit" size="sm" className="h-9">
        Créer
      </Button>
    </form>
  )
}

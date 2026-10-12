// Vue principale : liste des salons (création si admin, story 7) + fil du salon
// sélectionné (`ChannelFeed`).

import { useEffect, useState } from "react"
import { Hash, LogOut, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { Avatar } from "./Avatar"
import { ChannelFeed } from "./ChannelFeed"
import { ProfilePanel } from "./ProfilePanel"
import type { ChatState, ChatStore } from "./store"

export function ChatView({ state, store }: { state: ChatState; store: ChatStore }) {
  const [selected, setSelected] = useState<number | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const me = state.me!
  // Salon affiché : le choix de l'utilisateur s'il existe encore, sinon le premier.
  const channelId = state.channels.some((c) => c.id === selected)
    ? selected
    : (state.channels[0]?.id ?? null)
  const channel = state.channels.find((c) => c.id === channelId)

  useEffect(() => {
    if (channelId !== null) store.open(channelId)
  }, [channelId, store])

  return (
    <div className="flex h-svh">
      <aside className="relative flex w-60 shrink-0 flex-col border-r bg-muted/40">
        <div className="flex h-12 items-center justify-between border-b px-3">
          <span className="font-semibold">Salons</span>
          {me.isAdmin && <CreateChannel store={store} />}
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {state.channels.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelected(c.id)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                c.id === channelId && "bg-muted font-medium text-foreground",
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
        </nav>
        <div className="flex items-center gap-1 border-t p-2">
          <button
            type="button"
            onClick={() => setProfileOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left hover:bg-muted"
            title="Modifier le profil"
          >
            <Avatar userId={me.id} state={state} store={store} className="size-8" />
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
          {channel && (
            <>
              <Hash className="size-4 text-muted-foreground" />
              <span className="font-semibold">{channel.name}</span>
            </>
          )}
          {state.phase === "offline" && (
            <span className="ml-auto text-sm text-muted-foreground">Reconnexion…</span>
          )}
        </header>

        {state.error && (
          <div className="flex items-center justify-between border-b bg-destructive/10 px-4 py-1.5 text-sm text-destructive">
            <span>{state.error}</span>
            <Button variant="ghost" size="xs" onClick={store.clearError}>
              Fermer
            </Button>
          </div>
        )}

        {channel ? (
          <ChannelFeed key={channel.id} channel={channel} state={state} store={store} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Aucun salon sélectionné.
          </div>
        )}
      </main>

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

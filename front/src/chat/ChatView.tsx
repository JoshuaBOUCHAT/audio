// Vue principale : colonne de gauche qui bascule entre salons (création si admin,
// story 7) et conversations privées (stories 28-30), fil de la conversation choisie
// (`ChannelFeed`), membres à droite (story 23, carte de profil au clic, story 44).

import { useEffect, useState } from "react"
import { AtSign, Bell, BellOff, Hash, LogOut, MessageCircle, Moon, Plus, Settings, Sun, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { resolvedTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"
import { PresenceAvatar } from "./Avatar"
import { MembersPanel } from "./MembersPanel"
import { ChannelFeed } from "./ChannelFeed"
import { byLastActivity } from "./model"
import { ChannelMenu, PersonMenu } from "./NotifyMenus"
import { SettingsPanel, type SettingsTab } from "./SettingsPanel"
import type { ChatState, ChatStore } from "./store"

type View = "channels" | "dms"

const BASE_TITLE = document.title

/** Story 56 : compteur de non-lus ; grisé pour une conversation coupée (story 58). */
function UnreadBadge({ count, muted }: { count: number; muted: boolean }) {
  if (count === 0) return null
  return (
    <span
      className={cn(
        "ml-auto min-w-5 shrink-0 rounded-full px-1.5 text-center text-[0.7rem] leading-5 font-semibold",
        muted ? "bg-muted-foreground/30 text-foreground" : "bg-destructive text-white",
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  )
}

export function ChatView({ state, store }: { state: ChatState; store: ChatStore }) {
  const [view, setView] = useState<View>("channels")
  const [selectedChannel, setSelectedChannel] = useState<number | null>(null)
  const [selectedDm, setSelectedDm] = useState<number | null>(null)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  // Story 63 : menu de notification ouvert (clic droit, bouton 🔔).
  const [menu, setMenu] = useState<
    { kind: "person"; userId: number; x: number; y: number } | { kind: "channel"; channelId: number; x: number; y: number } | null
  >(null)
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
    // Story 56 : la conversation affichée est lue et ne notifie pas.
    store.setActive(currentId ?? null)
  }, [currentId, store])
  useEffect(() => () => store.setActive(null), [store])

  // Story 59 : cliquer une notification système ouvre sa conversation.
  useEffect(() => {
    store.onOpenConversation = (id) => {
      if (store.getSnapshot().channels.some((c) => c.id === id)) {
        setSelectedChannel(id)
        setView("channels")
      } else {
        setSelectedDm(id)
        setView("dms")
      }
    }
    return () => {
      store.onOpenConversation = null
    }
  }, [store])

  // Story 56, 62 : badges = mentions de moi pour les salons, tous les non-lus pour les
  // DM (conversations coupées exclues) ; leur somme dans le titre.
  const channelUnread = store.badgeTotal(state.channels.map((c) => c.id), "mentions")
  const dmUnread = store.badgeTotal(state.dms.map((d) => d.id), "count")
  useEffect(() => {
    const total = channelUnread + dmUnread
    document.title = total > 0 ? `(${total > 99 ? "99+" : total}) ${BASE_TITLE}` : BASE_TITLE
  }, [channelUnread, dmUnread])
  const badge = (id: number, kind: "mentions" | "count") => (
    <UnreadBadge count={state.unread[id]?.[kind] ?? 0} muted={store.isMuted(id)} />
  )

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
                <UnreadBadge count={v === "channels" ? channelUnread : dmUnread} muted={false} />
              </button>
            ))}
          </div>
          {view === "channels" && me.isAdmin && <CreateChannel store={store} />}
        </div>

        <nav className="flex-1 overflow-y-auto p-2">
          {view === "channels" ? (
            <>
              {state.channels.map((c) => (
                <div key={c.id} className="group/channel relative">
                  <button
                    type="button"
                    onClick={() => setSelectedChannel(c.id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ kind: "channel", channelId: c.id, x: e.clientX, y: e.clientY })
                    }}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-md py-1.5 pr-8 pl-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                      c.id === channel?.id && "bg-muted font-medium text-foreground",
                    )}
                  >
                    <Hash className="size-4 shrink-0" />
                    <span
                      className={cn(
                        "truncate",
                        (state.unread[c.id]?.count ?? 0) > 0 && !store.isMuted(c.id) && "font-semibold text-foreground",
                      )}
                    >
                      {c.name}
                    </span>
                    {badge(c.id, "mentions")}
                  </button>
                  {/* Story 63 : réglage du salon ; visible au survol, ou s'il n'est pas au défaut. */}
                  <button
                    type="button"
                    title="Notifications du salon"
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect()
                      setMenu({ kind: "channel", channelId: c.id, x: r.right + 4, y: r.top })
                    }}
                    className={cn(
                      "absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground",
                      store.channelRule(c.id).level === "mentions" && !store.channelRule(c.id).silent
                        ? "invisible group-hover/channel:visible"
                        : "visible",
                    )}
                  >
                    {store.channelRule(c.id).level === "nothing" ? (
                      <BellOff className="size-3.5" />
                    ) : (
                      <Bell className="size-3.5" />
                    )}
                  </button>
                </div>
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
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ kind: "person", userId: d.otherId, x: e.clientX, y: e.clientY })
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                    d.id === dm?.id && "bg-muted font-medium text-foreground",
                  )}
                >
                  <PresenceAvatar userId={d.otherId} state={state} store={store} className="size-8" />
                  <span
                    className={cn(
                      "truncate",
                      (state.unread[d.id]?.count ?? 0) > 0 && !store.isMuted(d.id) && "font-semibold text-foreground",
                    )}
                  >
                    {pseudoOf(d.otherId)}
                  </span>
                  {store.isMuted(d.id) && <BellOff className="size-3.5 shrink-0 text-muted-foreground" />}
                  {badge(d.id, "count")}
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
            onClick={() => setSettingsTab("profile")}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left hover:bg-muted"
            title="Modifier le profil"
          >
            <PresenceAvatar userId={me.id} state={state} store={store} className="size-8" />
            <span className="min-w-0 truncate text-sm font-medium">
              {me.pseudo}
              {me.isAdmin && <span className="ml-1 text-xs font-normal text-muted-foreground">(admin)</span>}
            </span>
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void store.setTheme(resolvedTheme(me.theme) === "dark" ? "light" : "dark")}
            title={resolvedTheme(me.theme) === "dark" ? "Passer en clair" : "Passer en sombre"}
          >
            {resolvedTheme(me.theme) === "dark" ? <Sun /> : <Moon />}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setSettingsTab("profile")} title="Paramètres">
            <Settings />
          </Button>
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
            onEditProfile={() => setSettingsTab("profile")}
          />
        </div>
      )}

      {settingsTab && (
        <SettingsPanel state={state} store={store} initialTab={settingsTab} onClose={() => setSettingsTab(null)} />
      )}

      {menu?.kind === "person" && (
        <PersonMenu userId={menu.userId} x={menu.x} y={menu.y} state={state} store={store} onClose={() => setMenu(null)} />
      )}
      {menu?.kind === "channel" && (
        <ChannelMenu channelId={menu.channelId} x={menu.x} y={menu.y} state={state} store={store} onClose={() => setMenu(null)} />
      )}

      {state.toast && (
        <div
          role="status"
          className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-foreground px-3 py-1.5 text-sm text-background shadow-lg"
        >
          {state.toast}
        </div>
      )}
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

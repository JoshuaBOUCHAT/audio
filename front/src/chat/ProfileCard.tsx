// Story 44 : carte de profil ouverte au clic sur un membre — grande photo, pseudo,
// statut, description (story 43) et bouton pour lui écrire en privé (story 28), ou
// pour modifier son propre profil.

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { MessageCircle, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PresenceAvatar } from "./Avatar"
import { userColor } from "./model"
import { isShownOnline, type ChatState, type ChatStore } from "./store"

const MARGIN = 8

export function ProfileCard({
  userId,
  anchor,
  state,
  store,
  onMessage,
  onEditProfile,
  onClose,
}: {
  userId: number
  /** Élément cliqué : la carte s'ouvre à sa gauche, à sa hauteur. */
  anchor: HTMLElement
  state: ChatState
  store: ChatStore
  onMessage: (userId: number) => void
  onEditProfile: () => void
  onClose: () => void
}) {
  const card = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const profile = state.users[userId]
  const self = userId === state.me?.id
  const online = isShownOnline(state, userId)

  // Placée après rendu, une fois sa hauteur connue, et gardée dans la fenêtre.
  useLayoutEffect(() => {
    const el = card.current
    if (!el) return
    const rect = anchor.getBoundingClientRect()
    const top = Math.min(Math.max(rect.top, MARGIN), window.innerHeight - el.offsetHeight - MARGIN)
    const left = Math.max(rect.left - el.offsetWidth - MARGIN, MARGIN)
    setPosition({ top, left })
  }, [anchor, profile])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!card.current?.contains(target) && !anchor.contains(target)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [anchor, onClose])

  if (!profile) return null
  return (
    <div
      ref={card}
      role="dialog"
      aria-label={`Profil de ${profile.pseudo}`}
      className="fixed z-30 w-72 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl"
      style={position ?? { top: 0, left: 0, visibility: "hidden" }}
    >
      <div className="h-16" style={{ backgroundColor: userColor(userId) }} />
      <div className="px-4 pb-4">
        <div className="-mt-10 mb-2 w-fit rounded-full border-4 border-popover bg-popover">
          <PresenceAvatar
            userId={userId}
            state={state}
            store={store}
            className="size-20 text-3xl"
            dotClassName="size-6 border-4 border-popover -right-0.5 -bottom-0.5"
          />
        </div>
        <div className="text-lg leading-tight font-semibold break-words">{profile.pseudo}</div>
        <div className="text-xs text-muted-foreground">
          {online ? "En ligne" : self ? "Invisible" : "Hors ligne"}
        </div>

        {profile.bio && (
          <section className="mt-3 rounded-lg bg-muted/60 p-3">
            <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              À propos de moi
            </h3>
            <p className="text-sm whitespace-pre-wrap break-words">{profile.bio}</p>
          </section>
        )}

        {self ? (
          <Button
            variant="secondary"
            className="mt-4 w-full"
            onClick={() => {
              onClose()
              onEditProfile()
            }}
          >
            <Pencil />
            Modifier mon profil
          </Button>
        ) : (
          <Button
            className="mt-4 w-full"
            onClick={() => {
              onClose()
              onMessage(userId)
            }}
          >
            <MessageCircle />
            Envoyer un message
          </Button>
        )}
      </div>
    </div>
  )
}

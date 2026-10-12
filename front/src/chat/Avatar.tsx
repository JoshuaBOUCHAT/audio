import { useEffect } from "react"
import { cn } from "@/lib/utils"
import { isShownOnline, type ChatState, type ChatStore } from "./store"

/** Photo de profil, ou initiale du pseudo sur fond coloré tant qu'il n'y en a pas. */
export function Avatar({
  userId,
  state,
  store,
  className,
}: {
  userId: number
  state: ChatState
  store: ChatStore
  className?: string
}) {
  const profile = state.users[userId]
  const url = state.avatars[userId]?.url
  const version = profile?.avatarVersion ?? 0

  useEffect(() => {
    if (version !== 0) store.ensureAvatar(userId)
  }, [userId, version, store])

  const pseudo = profile?.pseudo ?? "?"
  return (
    <div
      className={cn(
        "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-semibold text-white select-none",
        className,
      )}
      style={{ backgroundColor: `hsl(${(userId * 67) % 360} 45% 45%)` }}
      aria-hidden
    >
      {version !== 0 && url ? (
        <img src={url} alt="" className="size-full object-cover" />
      ) : (
        pseudo.charAt(0).toUpperCase()
      )}
    </div>
  )
}

/** Avatar avec pastille de statut : verte en ligne, grise hors ligne / invisible. */
export function PresenceAvatar({
  userId,
  state,
  store,
  className,
}: {
  userId: number
  state: ChatState
  store: ChatStore
  className?: string
}) {
  const online = isShownOnline(state, userId)
  return (
    <div className="relative shrink-0">
      <Avatar userId={userId} state={state} store={store} className={className} />
      <span
        className={cn(
          "absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full border-[3px] border-background",
          online ? "bg-emerald-500" : "bg-muted-foreground/50",
        )}
        title={online ? "En ligne" : userId === state.me?.id ? "Invisible" : "Hors ligne"}
      />
    </div>
  )
}

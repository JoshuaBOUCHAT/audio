import { useEffect } from "react"
import { cn } from "@/lib/utils"
import type { ChatState, ChatStore } from "./store"

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

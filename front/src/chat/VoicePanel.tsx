// Vocal dans la colonne de gauche : salons vocaux avec qui y est (stories 22, 72-73),
// barre du vocal en cours (story 21), boutons micro coupé / sourdine (story 73),
// bouton « maintenir pour parler » (story 78). En fenêtre étroite, la même barre passe
// sous l'en-tête du fil (`VoiceStrip`) pour ne pas devoir ouvrir le tiroir.

import { Headphones, HeadphoneOff, Mic, MicOff, PhoneOff, Volume2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Avatar } from "./Avatar"
import type { ChatState, ChatStore } from "./store"

/** Raccourcis (onglet actif) : Ctrl+Alt+M micro, Ctrl+Alt+D sourdine. */
export const MUTE_SHORTCUT = "Ctrl+Alt+M"
export const DEAFEN_SHORTCUT = "Ctrl+Alt+D"

export function VoiceChannelList({
  state,
  store,
  onPersonMenu,
}: {
  state: ChatState
  store: ChatStore
  onPersonMenu: (userId: number, x: number, y: number) => void
}) {
  if (state.voiceChannels.length === 0) return null
  const pseudoOf = (userId: number) => state.users[userId]?.pseudo ?? `Utilisateur #${userId}`
  return (
    <div className="mt-3">
      <p className="px-2 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Vocal</p>
      {state.voiceChannels.map((c) => {
        const here = state.voice?.channelId === c.id
        const members = state.voiceMembers[c.id] ?? []
        return (
          <div key={c.id}>
            <button
              type="button"
              onClick={() => void store.joinVoice(c.id)}
              title={here ? "Tu es dans ce vocal" : "Rejoindre le vocal"}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                here && "font-medium text-foreground",
              )}
            >
              <Volume2 className="size-4 shrink-0" />
              <span className="truncate">{c.name}</span>
            </button>
            {members.map((m) => (
              <div
                key={m.userId}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (m.userId !== state.me?.id) onPersonMenu(m.userId, e.clientX, e.clientY)
                }}
                className="flex items-center gap-2 rounded-md py-1 pr-2 pl-7 text-sm text-muted-foreground"
              >
                <Avatar
                  userId={m.userId}
                  state={state}
                  store={store}
                  className={cn(
                    "size-6 text-xs ring-2 ring-transparent transition-shadow",
                    state.speaking.has(m.userId) && "ring-emerald-500",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{pseudoOf(m.userId)}</span>
                {m.deafened ? (
                  <HeadphoneOff className="size-3.5 shrink-0" aria-label="sourdine" />
                ) : (
                  m.muted && <MicOff className="size-3.5 shrink-0" aria-label="micro coupé" />
                )}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function VoiceStatus({ state }: { state: ChatState }) {
  const name = state.voiceChannels.find((c) => c.id === state.voice?.channelId)?.name ?? ""
  return (
    <div className="min-w-0 flex-1">
      <p className={cn("text-xs font-semibold", state.voice?.connected ? "text-emerald-600" : "text-muted-foreground")}>
        {state.voice?.connected ? "Vocal connecté" : "Connexion au vocal…"}
      </p>
      <p className="truncate text-xs text-muted-foreground">{name}</p>
    </div>
  )
}

function LeaveButton({ store }: { store: ChatStore }) {
  return (
    <Button variant="ghost" size="icon-sm" onClick={() => void store.leaveVoice()} title="Quitter le vocal">
      <PhoneOff />
    </Button>
  )
}

/** Story 78 : au doigt ou à la souris, parle tant qu'il est enfoncé. */
function PushToTalkButton({ state, store }: { state: ChatState; store: ChatStore }) {
  if (!state.voicePrefs.pushToTalk) return null
  const talking = state.me ? state.speaking.has(state.me.id) : false
  return (
    <button
      type="button"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        store.pushToTalk(true)
      }}
      onPointerUp={() => store.pushToTalk(false)}
      onPointerCancel={() => store.pushToTalk(false)}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(
        "w-full touch-none rounded-md border py-2 text-sm font-medium select-none",
        talking ? "border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-background",
      )}
    >
      {talking ? "Tu parles…" : `Maintenir pour parler (${state.voicePrefs.pttLabel})`}
    </button>
  )
}

/** Vocal en cours : où, état de la connexion audio, quitter. */
export function VoiceBar({ state, store }: { state: ChatState; store: ChatStore }) {
  if (!state.voice) return null
  return (
    <div className="flex flex-col gap-2 border-t px-3 py-2">
      <div className="flex items-center gap-2">
        <VoiceStatus state={state} />
        <LeaveButton store={store} />
      </div>
      <PushToTalkButton state={state} store={store} />
    </div>
  )
}

/** Fenêtre étroite : vocal en cours sous l'en-tête, micro et sourdine compris. */
export function VoiceStrip({ state, store }: { state: ChatState; store: ChatStore }) {
  if (!state.voice) return null
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b bg-muted/40 px-3 py-1.5">
      <div className="flex items-center gap-1">
        <VoiceStatus state={state} />
        <SelfVoiceButtons state={state} store={store} />
        <LeaveButton store={store} />
      </div>
      <PushToTalkButton state={state} store={store} />
    </div>
  )
}

/** Story 73 : toujours visibles, réglés avant même d'entrer dans un vocal. */
export function SelfVoiceButtons({ state, store }: { state: ChatState; store: ChatStore }) {
  const { muted, deafened } = state.voiceSelf
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={store.toggleMute}
        title={`${muted ? "Réactiver le micro" : "Couper le micro"} (${MUTE_SHORTCUT})`}
        className={cn(muted && "text-destructive")}
      >
        {muted ? <MicOff /> : <Mic />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={store.toggleDeafen}
        title={`${deafened ? "Enlever la sourdine" : "Sourdine"} (${DEAFEN_SHORTCUT})`}
        className={cn(deafened && "text-destructive")}
      >
        {deafened ? <HeadphoneOff /> : <Headphones />}
      </Button>
    </>
  )
}

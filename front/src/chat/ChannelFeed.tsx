// Fil d'un salon ou d'un DM (même interface, stories 30-31) : messages (stories 10-14, 36), réponse à un message avec saut vers
// l'original (story 39), modification dans la barre de saisie (story 40), suppression
// confirmée (story 38). Monté avec `key={conversationId}` : changer de conversation
// remet à zéro le mode de saisie et le brouillon. Sans survol (écran tactile), toucher
// un message affiche ses boutons.

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { CornerUpRight, FolderUp, Paperclip, Pencil, Reply, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { Avatar } from "./Avatar"
import { Composer, type ComposerHandle } from "./Composer"
import { mentions, plainText } from "./media"
import { MessageBody } from "./MessageBody"
import { foldersFromInput } from "./zip-folder"
import type { ChatMessage } from "./model"
import type { ChatState, ChatStore } from "./store"

type Mode =
  | { kind: "new" }
  | { kind: "reply"; target: ChatMessage }
  | { kind: "edit"; target: ChatMessage; draft: string } // `draft` : saisie en cours avant la modification, restaurée ensuite

export function ChannelFeed({
  conversationId,
  label,
  isDm = false,
  state,
  store,
}: {
  conversationId: number
  /** `#salon` ou `@pseudo`, pour la barre de saisie. */
  label: string
  /** Story 32 : dans un DM, l'admin ne supprime pas les messages de l'autre. */
  isDm?: boolean
  state: ChatState
  store: ChatStore
}) {
  const me = state.me!
  const messages = state.messages[conversationId]
  const [mode, setMode] = useState<Mode>({ kind: "new" })
  const [confirmDelete, setConfirmDelete] = useState<ChatMessage | null>(null)
  // `nonce` relance l'animation quand on reclique sur la même citation.
  const [flash, setFlash] = useState<{ id: number; nonce: number } | null>(null)
  const [touched, setTouched] = useState<number | null>(null)
  const composer = useRef<ComposerHandle>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const history = state.history[conversationId]
  const firstId = messages?.[0]?.id
  const lastId = messages?.at(-1)?.id
  /** Collé en bas : un nouveau message garde la vue en bas ; sinon on ne bouge pas. */
  const atBottom = useRef(true)
  /** Hauteur et position avant l'ajout d'une page au-dessus, pour ne pas faire sauter la lecture. */
  const beforePrepend = useRef<{ height: number; top: number } | null>(null)

  // Story 64 : une page plus ancienne s'insère au-dessus — on décale d'autant.
  useLayoutEffect(() => {
    const el = scroller.current
    const before = beforePrepend.current
    if (el && before) {
      el.scrollTop = el.scrollHeight - before.height + before.top
      beforePrepend.current = null
    }
  }, [firstId])

  // Nouveau message en bas (ou première page) : on suit si on était en bas.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [lastId])

  function loadOlder() {
    const el = scroller.current
    if (!el || !history?.hasMore || history.loading) return
    beforePrepend.current = { height: el.scrollHeight, top: el.scrollTop }
    void store.loadOlder(conversationId)
  }

  // Page trop courte pour défiler : on charge la suivante sans attendre de scroll.
  useEffect(() => {
    const el = scroller.current
    if (el && el.scrollHeight <= el.clientHeight && history?.hasMore && !history.loading) loadOlder()
  })

  const byId = new Map(messages?.map((m) => [m.id, m]))
  const pseudoOf = (userId: number) => state.users[userId]?.pseudo ?? `Utilisateur #${userId}`

  function startReply(target: ChatMessage) {
    if (mode.kind === "edit") composer.current?.setValue(mode.draft)
    setMode({ kind: "reply", target })
    composer.current?.focus()
  }

  function startEdit(target: ChatMessage) {
    const draft = mode.kind === "edit" ? mode.draft : (composer.current?.getValue() ?? "")
    setMode({ kind: "edit", target, draft })
    composer.current?.setValue(target.content)
    composer.current?.focus()
  }

  function cancelMode() {
    if (mode.kind === "edit") composer.current?.setValue(mode.draft)
    setMode({ kind: "new" })
  }

  /** Story 39 ; story 64 : un original pas encore chargé l'est d'abord, page par page. */
  async function jumpTo(id: number) {
    if (!byId.has(id)) {
      const el = scroller.current
      if (el) beforePrepend.current = { height: el.scrollHeight, top: el.scrollTop }
      if (!(await store.loadUntil(conversationId, id))) {
        store.flash("Message d'origine introuvable")
        return
      }
      await new Promise(requestAnimationFrame)
    }
    document.getElementById(`message-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
    setFlash((f) => ({ id, nonce: (f?.nonce ?? 0) + 1 }))
  }

  async function submit() {
    const editor = composer.current
    if (!editor) return
    if (editor.isUploading()) {
      store.flash("Attends la fin de l'envoi des images")
      return
    }
    const text = editor.getValue().trim()
    if (!text) return
    if (mode.kind === "edit") {
      // Contenu inchangé : rien à envoyer, on sort simplement du mode modification.
      if (text === mode.target.content.trim() || (await store.edit(conversationId, mode.target.id, text))) {
        editor.setValue(mode.draft)
        setMode({ kind: "new" })
      }
      return
    }
    // Vidé seulement si le serveur a accepté : un échec garde le texte à renvoyer.
    if (await store.send(conversationId, text, mode.kind === "reply" ? mode.target.id : 0)) {
      editor.setValue("")
      setMode({ kind: "new" })
    }
  }

  return (
    <>
      {!messages ? (
        <div className="flex-1 p-4 text-sm text-muted-foreground">Chargement…</div>
      ) : (
        <div
          ref={scroller}
          className="flex-1 overflow-y-auto py-2"
          onScroll={(e) => {
            const el = e.currentTarget
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            if (el.scrollTop < 400) loadOlder()
          }}
        >
          {history?.hasMore ? (
            <div className="flex justify-center py-3 text-xs text-muted-foreground">
              {history.loading ? "Chargement des messages précédents…" : ""}
            </div>
          ) : (
            messages.length > 0 && (
              <p className="px-4 pt-2 pb-4 text-xs text-muted-foreground">Début de la conversation.</p>
            )
          )}
          {messages.length === 0 && (
            <p className="px-4 text-sm text-muted-foreground">Pas encore de message. Lance la discussion.</p>
          )}
          {messages.map((m, i) => {
            const previous = messages[i - 1]
            // Une réponse affiche toujours son en-tête, comme le premier message d'un groupe.
            const grouped =
              previous !== undefined && previous.userId === m.userId && !previous.deleted && m.replyToId === 0
            const isMine = m.userId === me.id
            const targeted = mode.kind !== "new" && mode.target.id === m.id
            const mentionsMe = !m.deleted && mentions(m.content, me.id)
            return (
              <div
                key={m.id}
                id={`message-${m.id}`}
                onClick={(e) => {
                  if (m.deleted || !matchMedia("(hover: none)").matches) return
                  if ((e.target as Element).closest("a, button, img, video, audio, input")) return
                  setTouched((id) => (id === m.id ? null : m.id))
                }}
                className={cn(
                  "group relative py-0.5 pr-4 pl-16 hover:bg-muted/50 sm:pr-24",
                  !grouped && "mt-3",
                  mentionsMe && "bg-amber-400/10 shadow-[inset_2px_0_0_var(--color-amber-500)] hover:bg-amber-400/15",
                  targeted && "bg-primary/5 shadow-[inset_2px_0_0_var(--primary)]",
                  touched === m.id && "bg-muted/50",
                )}
              >
                {flash?.id === m.id && (
                  <div key={flash.nonce} className="pointer-events-none absolute inset-0 animate-message-flash" />
                )}
                {m.replyToId !== 0 && (
                  <ReplyQuote
                    target={byId.get(m.replyToId)}
                    state={state}
                    store={store}
                    pseudoOf={pseudoOf}
                    onJump={() => void jumpTo(m.replyToId)}
                  />
                )}
                {!grouped && (
                  <>
                    <Avatar
                      userId={m.userId}
                      state={state}
                      store={store}
                      className={cn("absolute left-4", m.replyToId !== 0 ? "top-6" : "top-1")}
                    />
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-semibold">{pseudoOf(m.userId)}</span>
                      <time className="text-xs text-muted-foreground" dateTime={new Date(m.timestamp).toISOString()}>
                        {formatTime(m.timestamp)}
                      </time>
                    </div>
                  </>
                )}
                {m.deleted ? (
                  <p className="text-sm italic text-muted-foreground">message supprimé</p>
                ) : (
                  <MessageBody message={m} state={state} store={store} />
                )}
                {!m.deleted && (
                  <div
                    onClick={() => setTouched(null)}
                    className={cn(
                      "absolute -top-3 right-4 hidden rounded-md border bg-background shadow-sm group-hover:flex",
                      touched === m.id && "flex",
                    )}
                  >
                    <Button variant="ghost" size="icon-sm" onClick={() => startReply(m)} title="Répondre">
                      <Reply />
                    </Button>
                    {isMine && (
                      <Button variant="ghost" size="icon-sm" onClick={() => startEdit(m)} title="Modifier">
                        <Pencil />
                      </Button>
                    )}
                    {(isMine || (me.isAdmin && !isDm)) && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setConfirmDelete(m)}
                        title="Supprimer"
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <form
        className="shrink-0 p-4 pt-0"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {mode.kind !== "new" && (
          <div
            className={cn(
              "flex items-center gap-2 rounded-t-lg border border-b-0 px-3 py-1.5 text-xs",
              mode.kind === "edit" ? "border-primary/40 bg-primary/10" : "bg-muted",
            )}
          >
            {mode.kind === "reply" ? (
              <>
                <CornerUpRight className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">
                  Réponse à <span className="font-semibold">{pseudoOf(mode.target.userId)}</span>
                  <span className="ml-1.5 text-muted-foreground">{excerpt(mode.target, pseudoOf)}</span>
                </span>
              </>
            ) : (
              <>
                <Pencil className="size-3.5 shrink-0 text-primary" />
                <span className="min-w-0 truncate">
                  <span className="font-semibold">Modification du message</span>
                  <span className="ml-1.5 text-muted-foreground">Échap pour annuler · Entrée pour enregistrer</span>
                </span>
              </>
            )}
            <Button type="button" variant="ghost" size="icon-xs" className="ml-auto" onClick={cancelMode} title="Annuler">
              <X />
            </Button>
          </div>
        )}
        <div
          className={cn(
            "flex items-end rounded-lg border border-input focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
            mode.kind !== "new" && "rounded-t-none",
            mode.kind === "edit" && "border-primary/40 focus-within:border-primary",
          )}
        >
          <div className="m-1 flex">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => fileInput.current?.click()}
              disabled={state.phase !== "ready"}
              title="Joindre des fichiers ou des images (ou Ctrl+V, ou glisser-déposer)"
            >
              <Paperclip />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => folderInput.current?.click()}
              disabled={state.phase !== "ready"}
              title="Envoyer un dossier (compressé en ZIP)"
            >
              <FolderUp />
            </Button>
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              composer.current?.insertFiles([...(e.target.files ?? [])])
              e.target.value = ""
            }}
          />
          <input
            ref={folderInput}
            type="file"
            hidden
            // Sélection d'un dossier entier (story 52) : attribut non standard, mais
            // reconnu par tous les navigateurs actuels.
            {...{ webkitdirectory: "" }}
            onChange={(e) => {
              composer.current?.insertFolders(foldersFromInput([...(e.target.files ?? [])]))
              e.target.value = ""
            }}
          />
          <div className="min-w-0 flex-1">
            <Composer
              ref={composer}
              state={state}
              store={store}
              placeholder={mode.kind === "edit" ? "Nouveau contenu du message" : `Message ${label}`}
              disabled={state.phase !== "ready"}
              className="pl-0"
              onSubmit={() => void submit()}
              onKeyDown={(e, empty) => {
                if (e.key === "Escape" && mode.kind !== "new") {
                  e.preventDefault()
                  cancelMode()
                } else if (e.key === "ArrowUp" && empty && mode.kind === "new" && messages) {
                  // Raccourci : modifier son dernier message.
                  const last = messages.findLast((m) => m.userId === me.id && !m.deleted)
                  if (last) {
                    e.preventDefault()
                    startEdit(last)
                  }
                }
              }}
            />
          </div>
        </div>
        <p className="mt-1 hidden text-[0.7rem] text-muted-foreground sm:block">
          Entrée pour envoyer · Maj+Entrée pour aller à la ligne
        </p>
      </form>

      {confirmDelete && (
        <ConfirmDelete
          message={confirmDelete}
          pseudo={pseudoOf(confirmDelete.userId)}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            void store.remove(confirmDelete.channelId, confirmDelete.id)
            if (mode.kind !== "new" && mode.target.id === confirmDelete.id) cancelMode()
            setConfirmDelete(null)
          }}
        />
      )}
    </>
  )
}

/** Citation au-dessus d'une réponse (story 39), lue dans le message d'origine. */
function ReplyQuote({
  target,
  state,
  store,
  pseudoOf,
  onJump,
}: {
  target: ChatMessage | undefined
  state: ChatState
  store: ChatStore
  pseudoOf: (userId: number) => string
  onJump: () => void
}) {
  if (!target) {
    // Story 64 : plus ancien que la page chargée — un clic le charge et y va.
    return (
      <button
        type="button"
        onClick={onJump}
        className="mb-0.5 flex items-center gap-1.5 text-xs text-muted-foreground italic hover:text-foreground"
        title="Charger et aller au message d'origine"
      >
        <CornerUpRight className="size-3.5 shrink-0" />
        message plus ancien — cliquer pour y aller
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onJump}
      className="mb-0.5 flex max-w-full items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
      title="Aller au message d'origine"
    >
      <CornerUpRight className="size-3.5 shrink-0" />
      <Avatar userId={target.userId} state={state} store={store} className="size-4 text-[0.55rem]" />
      <span className="shrink-0 font-semibold">{pseudoOf(target.userId)}</span>
      <span className={cn("truncate", target.deleted && "italic")}>{excerpt(target, pseudoOf)}</span>
    </button>
  )
}

/** Story 38 : la suppression est définitive, on la fait confirmer. */
function ConfirmDelete({
  message,
  pseudo,
  onCancel,
  onConfirm,
}: {
  message: ChatMessage
  pseudo: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
      role="dialog"
      aria-modal
    >
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Supprimer ce message ?</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border bg-muted/50 p-3 text-sm">
            <div className="font-semibold">{pseudo}</div>
            <p className="line-clamp-4 whitespace-pre-wrap break-words">{plainText(message.content)}</p>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">Cette action est définitive.</p>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Annuler
          </Button>
          {/* Focus sur Supprimer : Entrée confirme, Échap annule. */}
          <Button variant="destructive" onClick={onConfirm} autoFocus>
            Supprimer
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}

function excerpt(message: ChatMessage, pseudoOf: (userId: number) => string): string {
  if (message.deleted) return "message supprimé"
  const text = plainText(message.content, pseudoOf).replace(/\s+/g, " ").trim()
  return text.length > 100 ? `${text.slice(0, 100)}…` : text
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], { dateStyle: "short", timeStyle: "short" })
}

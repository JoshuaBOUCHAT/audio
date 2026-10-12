// Corps d'un message (story 27) : texte et images dans l'ordre où ils ont été écrits.
// Au survol d'une image : copier son lien (story 46), l'enregistrer en local (story 49),
// la supprimer ici ou pour tout le monde (story 50) ; au clic, vue en grand (story 49).

import { useEffect, useState } from "react"
import { Download, ImageOff, Link, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { fileName, shareLink, splitContent, withoutMedia } from "./media"
import type { ChatMessage } from "./model"
import type { ChatState, ChatStore, MediaEntry } from "./store"

export function MessageBody({ message, state, store }: { message: ChatMessage; state: ChatState; store: ChatStore }) {
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  return (
    <div className="text-sm break-words whitespace-pre-wrap">
      {splitContent(message.content).map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.text}</span>
        ) : (
          <MediaImage
            key={i}
            id={part.id}
            state={state}
            store={store}
            onOpen={() => setLightbox(part.id)}
            onDelete={() => setDeleting(part.id)}
            canDelete={message.userId === state.me?.id || isOwner(state.media[part.id], state)}
          />
        ),
      )}
      {message.editedAt !== 0 && (
        <span
          className="ml-1.5 text-[0.7rem] text-muted-foreground"
          title={`modifié le ${new Date(message.editedAt).toLocaleString()}`}
        >
          (modifié)
        </span>
      )}
      {lightbox && <Lightbox id={lightbox} state={state} store={store} onClose={() => setLightbox(null)} />}
      {deleting && (
        <DeleteImage
          id={deleting}
          message={message}
          state={state}
          store={store}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  )
}

function isOwner(entry: MediaEntry | undefined, state: ChatState): boolean {
  return entry?.status === "ready" && entry.ownerId === state.me?.id
}

function MediaImage({
  id,
  state,
  store,
  onOpen,
  onDelete,
  canDelete,
}: {
  id: string
  state: ChatState
  store: ChatStore
  onOpen: () => void
  onDelete: () => void
  canDelete: boolean
}) {
  const entry = state.media[id]
  useEffect(() => {
    if (!entry) store.ensureMedia(id)
  }, [entry, id, store])

  if (entry?.status === "missing") {
    return (
      <span className="my-1 inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground italic">
        <ImageOff className="size-4" />
        image supprimée
      </span>
    )
  }
  if (entry?.status !== "ready") {
    return <span className="my-1 inline-block h-32 w-48 animate-pulse rounded-lg bg-muted align-bottom" />
  }
  return (
    <span className="group/image relative my-1 inline-block align-bottom">
      <button type="button" onClick={onOpen} className="block cursor-zoom-in" title="Voir en grand">
        <img src={entry.url} alt="" className="max-h-80 max-w-[min(100%,24rem)] rounded-lg border" />
      </button>
      <span className="absolute top-1.5 right-1.5 hidden gap-0.5 rounded-md border bg-background/90 p-0.5 shadow-sm group-hover/image:flex">
        <ImageActions id={id} entry={entry} store={store} />
        {canDelete && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
            title="Supprimer l'image"
          >
            <Trash2 />
          </Button>
        )}
      </span>
    </span>
  )
}

function ImageActions({
  id,
  entry,
  store,
}: {
  id: string
  entry: Extract<MediaEntry, { status: "ready" }>
  store: ChatStore
}) {
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        title="Copier le lien (ne s'ouvre que dans l'app)"
        onClick={() => {
          void navigator.clipboard.writeText(shareLink(id)).then(() => store.flash("Lien de l'image copié"))
        }}
      >
        <Link />
      </Button>
      <Button variant="ghost" size="icon-xs" title="Enregistrer l'image" onClick={() => download(entry.url, fileName(id, entry.mime))}>
        <Download />
      </Button>
    </>
  )
}

function download(url: string, name: string) {
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
}

/** Story 49 : image en grand, Échap ou clic à côté pour fermer. */
function Lightbox({ id, state, store, onClose }: { id: string; state: ChatState; store: ChatStore; onClose: () => void }) {
  const entry = state.media[id]
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])
  if (entry?.status !== "ready") return null
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/85 p-6 whitespace-normal"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal
      aria-label="Image en grand"
    >
      <img src={entry.url} alt="" className="max-h-full max-w-full rounded-md object-contain shadow-2xl" />
      <div className="absolute top-4 right-4 flex gap-1 rounded-lg bg-background/90 p-1 shadow">
        <ImageActions id={id} entry={entry} store={store} />
        <Button variant="ghost" size="icon-xs" onClick={onClose} title="Fermer">
          <X />
        </Button>
      </div>
    </div>
  )
}

/**
 * Story 50 : « ici » retire l'image de mon message (modification, ou suppression du
 * message s'il ne contenait qu'elle) ; « pour tout le monde », réservé à qui l'a
 * envoyée, la supprime du serveur — partout où elle est partagée.
 */
function DeleteImage({
  id,
  message,
  state,
  store,
  onClose,
}: {
  id: string
  message: ChatMessage
  state: ChatState
  store: ChatStore
  onClose: () => void
}) {
  const canHere = message.userId === state.me?.id
  const canEverywhere = isOwner(state.media[id], state)

  async function here() {
    onClose()
    const content = withoutMedia(message.content, id)
    if (content.trim() === "") await store.remove(message.channelId, message.id)
    else await store.edit(message.channelId, message.id, content)
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4 whitespace-normal"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="dialog"
      aria-modal
    >
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Supprimer cette image ?</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
          {canHere && <p>« Ici » la retire seulement de ce message.</p>}
          {canEverywhere && (
            <p>
              « Pour tout le monde » la supprime du serveur : partout où elle a été partagée, elle sera remplacée par
              « image supprimée ». C'est définitif.
            </p>
          )}
        </CardContent>
        <CardFooter className="flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} autoFocus={!canHere && !canEverywhere}>
            Annuler
          </Button>
          {canHere && (
            <Button variant="secondary" onClick={() => void here()} autoFocus>
              Ici
            </Button>
          )}
          {canEverywhere && (
            <Button
              variant="destructive"
              onClick={() => {
                onClose()
                void store.deleteMediaEverywhere(id)
              }}
            >
              Pour tout le monde
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  )
}

// Corps d'un message (stories 27, 51-52, 54) : texte, images, vidéos et fichiers dans
// l'ordre où ils ont été écrits. Une image s'affiche (clic : vue en grand, story 49),
// une vidéo se lit sur place, un fichier ou un dossier est une carte (nom, taille). Actions : copier le lien (story 46), télécharger
// (ticket, story 53), supprimer ici ou pour tout le monde (story 50).

import { useEffect, useState, type ReactNode } from "react"
import { Download, File as FileIcon, FileX, Film, FolderArchive, Link, Music, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { formatBytes, shareLink, splitContent, withoutMedia } from "./media"
import { Avatar } from "./Avatar"
import { userHue, type ChatMessage, type MediaInfo } from "./model"
import type { ChatState, ChatStore, MediaEntry } from "./store"

export function MessageBody({ message, state, store }: { message: ChatMessage; state: ChatState; store: ChatStore }) {
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  return (
    <div className="text-sm break-words whitespace-pre-wrap">
      {splitContent(message.content).map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.text}</span>
        ) : part.kind === "mention" ? (
          <Mention key={i} userId={part.userId} state={state} store={store} />
        ) : (
          <MediaPart
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

/** Story 62 : pastille de mention — mini photo et pseudo à la couleur de la personne. */
function Mention({ userId, state, store }: { userId: number; state: ChatState; store: ChatStore }) {
  const pseudo = state.users[userId]?.pseudo
  return (
    <span
      className="mention inline-flex items-center gap-1 rounded-md px-1 align-bottom font-medium whitespace-nowrap"
      style={{ "--mention-h": userHue(userId) } as React.CSSProperties}
    >
      {pseudo && <Avatar userId={userId} state={state} store={store} className="size-4 text-[0.55rem]" />}@
      {pseudo ?? "inconnu"}
    </span>
  )
}

function isOwner(entry: MediaEntry | undefined, state: ChatState): boolean {
  return entry?.status === "ready" && entry.info.ownerId === state.me?.id
}

function MediaPart({
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
        <FileX className="size-4" />
        fichier supprimé
      </span>
    )
  }
  const actions = entry?.status === "ready" && (
    <span className="hidden gap-0.5 rounded-md border bg-background/90 p-0.5 shadow-sm group-hover/media:flex">
      <MediaActions info={entry.info} store={store} />
      {canDelete && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
          title="Supprimer"
        >
          <Trash2 />
        </Button>
      )}
    </span>
  )
  if (entry?.status === "ready" && entry.info.isVideo) {
    return <VideoPart id={id} url={entry.url} info={entry.info} store={store} actions={actions} />
  }
  if (entry?.status === "ready" && entry.info.isAudio) {
    return <AudioPart id={id} url={entry.url} info={entry.info} store={store} actions={actions} />
  }
  if (entry?.status === "ready" && !entry.info.isImage) {
    return (
      <span className="group/media relative my-1 inline-flex max-w-full items-center gap-3 rounded-lg border bg-muted/50 py-2 pr-2 pl-3 align-bottom whitespace-normal">
        <FileCard info={entry.info} />
        <Button variant="secondary" size="icon-sm" onClick={() => void store.download(id)} title="Télécharger">
          <Download />
        </Button>
        <span className="absolute -top-3 right-1.5">{actions}</span>
      </span>
    )
  }
  if (entry?.status !== "ready" || !entry.url) {
    return <span className="my-1 inline-block h-32 w-48 animate-pulse rounded-lg bg-muted align-bottom" />
  }
  return (
    <span className="group/media relative my-1 inline-block align-bottom">
      <button type="button" onClick={onOpen} className="block cursor-zoom-in" title="Voir en grand">
        <img src={entry.url} alt="" className="max-h-80 max-w-[min(100%,24rem)] rounded-lg border" />
      </button>
      <span className="absolute top-1.5 right-1.5">{actions}</span>
    </span>
  )
}

/**
 * Story 54 : lecteur intégré. Le navigateur lit par plages avec le ticket de lecture ;
 * à la première erreur le ticket est renouvelé (expiré si l'onglet est resté ouvert
 * longtemps), à la seconde c'est le format qui n'est pas lisible ici : carte fichier.
 */
function VideoPart({
  id,
  url,
  info,
  store,
  actions,
}: {
  id: string
  url: string | undefined
  info: MediaInfo
  store: ChatStore
  actions: ReactNode
}) {
  const [retried, setRetried] = useState(false)
  const [unplayable, setUnplayable] = useState(false)
  if (unplayable) {
    return (
      <span className="group/media relative my-1 inline-flex max-w-full items-center gap-3 rounded-lg border bg-muted/50 py-2 pr-2 pl-3 align-bottom whitespace-normal">
        <FileCard info={info} />
        <span className="text-xs text-muted-foreground">format non lisible ici</span>
        <Button variant="secondary" size="icon-sm" onClick={() => void store.download(id)} title="Télécharger">
          <Download />
        </Button>
        <span className="absolute -top-3 right-1.5">{actions}</span>
      </span>
    )
  }
  if (!url) return <span className="my-1 inline-block h-48 w-80 animate-pulse rounded-lg bg-muted align-bottom" />
  return (
    <span className="group/media relative my-1 inline-block align-bottom">
      <video
        src={url}
        controls
        playsInline
        preload="metadata"
        className="max-h-80 max-w-[min(100%,28rem)] rounded-lg border bg-black"
        onError={() => {
          if (!retried && !url.startsWith("blob:")) {
            setRetried(true)
            void store.refreshStream(id)
          } else {
            setUnplayable(true)
          }
        }}
      />
      <span className="absolute top-1.5 right-1.5">{actions}</span>
    </span>
  )
}

/** Story 61 : carte du son avec lecteur ; même renouvellement de ticket que la vidéo. */
function AudioPart({
  id,
  url,
  info,
  store,
  actions,
}: {
  id: string
  url: string | undefined
  info: MediaInfo
  store: ChatStore
  actions: ReactNode
}) {
  const [retried, setRetried] = useState(false)
  const [unplayable, setUnplayable] = useState(false)
  return (
    <span className="group/media relative my-1 inline-flex w-[min(100%,24rem)] flex-col gap-2 rounded-lg border bg-muted/50 p-3 align-bottom whitespace-normal">
      <span className="flex items-center gap-3">
        <FileCard info={info} />
        {unplayable && (
          <Button variant="secondary" size="icon-sm" className="ml-auto" onClick={() => void store.download(id)} title="Télécharger">
            <Download />
          </Button>
        )}
      </span>
      {unplayable ? (
        <span className="text-xs text-muted-foreground">format non lisible ici</span>
      ) : url ? (
        <audio
          src={url}
          controls
          preload="metadata"
          className="h-9 w-full"
          onError={() => {
            if (!retried && !url.startsWith("blob:")) {
              setRetried(true)
              void store.refreshStream(id)
            } else {
              setUnplayable(true)
            }
          }}
        />
      ) : (
        <span className="h-9 animate-pulse rounded-md bg-muted" />
      )}
      <span className="absolute -top-3 right-1.5">{actions}</span>
    </span>
  )
}

/** Story 52 : un dossier montre son nombre de fichiers et sa taille d'origine. */
function FileCard({ info }: { info: MediaInfo }) {
  const folder = info.folderFiles > 0
  const Icon = folder ? FolderArchive : info.isVideo ? Film : info.isAudio ? Music : FileIcon
  return (
    <>
      <Icon className="size-8 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="block max-w-72 truncate text-sm font-medium" title={info.name}>
          {info.name}
        </span>
        <span className="block text-xs text-muted-foreground">
          {folder
            ? `Dossier · ${info.folderFiles} fichier${info.folderFiles > 1 ? "s" : ""} · ${formatBytes(info.folderSize)} (${formatBytes(info.size)} compressé)`
            : formatBytes(info.size)}
        </span>
      </span>
    </>
  )
}

function MediaActions({ info, store }: { info: MediaInfo; store: ChatStore }) {
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        title="Copier le lien (ne s'ouvre que dans l'app)"
        onClick={() => {
          void navigator.clipboard.writeText(shareLink(info.id)).then(() => store.flash("Lien copié"))
        }}
      >
        <Link />
      </Button>
      <Button variant="ghost" size="icon-xs" title="Télécharger" onClick={() => void store.download(info.id)}>
        <Download />
      </Button>
    </>
  )
}

/** Story 49 : image en grand, Échap ou clic à côté pour fermer. */
function Lightbox({ id, state, store, onClose }: { id: string; state: ChatState; store: ChatStore; onClose: () => void }) {
  const entry = state.media[id]
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])
  if (entry?.status !== "ready" || !entry.url) return null
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
        <MediaActions info={entry.info} store={store} />
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
          <CardTitle>Supprimer ce fichier ?</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
          {canHere && <p>« Ici » le retire seulement de ce message.</p>}
          {canEverywhere && (
            <p>
              « Pour tout le monde » le supprime du serveur : partout où il a été partagé, il sera remplacé par
              « fichier supprimé ». C'est définitif.
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

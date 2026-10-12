// Barre de saisie riche (stories 27, 45, 51-52, 62) : texte, images, fichiers, dossiers
// et mentions librement mélangés, dans l'ordre où on les place. `@` ouvre une
// autocomplétion des membres ; la personne choisie devient une pastille. Chacun est une miniature insérée
// au curseur (bouton, Ctrl+V, glisser-déposer, ou lien `/media/…` collé, story 46) —
// une image en vignette, un fichier ou un dossier en carte ; le contenu se lit comme
// le texte du message, chaque média y devenant son lien.
//
// `contenteditable` piloté à la main (non contrôlé par React) : React ne touche jamais
// à son DOM, les miniatures y sont posées par les fonctions ci-dessous. Entrée envoie,
// Maj+Entrée saute une ligne.

import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from "react"
import { cn } from "@/lib/utils"
import { Avatar } from "./Avatar"
import { formatBytes, mediaToken, mentionToken, splitContent, type Part } from "./media"
import { userColor, userHue, type MediaInfo, type Profile } from "./model"
import type { ChatState, ChatStore } from "./store"
import { folderSize, readDropped, zipFolder, type Folder } from "./zip-folder"

export type ComposerHandle = {
  /** Contenu du message : texte, images remplacées par leur lien. */
  getValue(): string
  setValue(content: string): void
  focus(): void
  insertFiles(files: File[]): void
  insertFolders(folders: Folder[]): void
  /** Un média est encore en cours d'envoi : le message ne peut pas partir. */
  isUploading(): boolean
}

export function Composer({
  ref,
  state,
  store,
  placeholder,
  disabled,
  className,
  onSubmit,
  onKeyDown,
}: {
  ref: Ref<ComposerHandle>
  state: ChatState
  store: ChatStore
  placeholder: string
  disabled: boolean
  className?: string
  onSubmit: () => void
  /** Appelé avant le traitement d'Entrée ; `preventDefault()` pour l'intercepter. */
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>, empty: boolean) => void
}) {
  const editor = useRef<HTMLDivElement>(null)
  const savedRange = useRef<Range | null>(null)
  const [empty, setEmpty] = useState(true)
  const [uploading, setUploading] = useState(0)
  /** Story 62 : autocomplétion ouverte par `@`, texte tapé après et choix surligné. */
  const [suggest, setSuggest] = useState<{ query: string; index: number } | null>(null)
  const candidates = suggest ? matchMembers(Object.values(state.users), suggest.query) : []

  const refresh = () => {
    const el = editor.current
    if (!el) return
    fixTrailingNewline(el)
    setEmpty(isEmpty(el))
    detectMention()
  }

  /** `@` + quelques caractères juste avant le curseur, en début de mot. */
  function detectMention() {
    const selection = window.getSelection()
    const node = selection?.anchorNode
    if (!selection?.isCollapsed || !node || node.nodeType !== Node.TEXT_NODE || !editor.current?.contains(node)) {
      setSuggest(null)
      return
    }
    const before = (node as Text).data.slice(0, selection.anchorOffset)
    const match = /(?:^|[\s\u00a0])@([^\s@]{0,32})$/.exec(before)
    setSuggest((current) => (match ? { query: match[1], index: current?.query === match[1] ? current.index : 0 } : null))
  }

  /** Remplace `@texte` par la pastille de la personne, suivie d'une espace. */
  function selectMention(user: Profile) {
    const selection = window.getSelection()
    const node = selection?.anchorNode
    if (!selection || !node || node.nodeType !== Node.TEXT_NODE || !suggest) return
    const end = selection.anchorOffset
    const range = document.createRange()
    range.setStart(node, end - suggest.query.length - 1)
    range.setEnd(node, end)
    range.deleteContents()
    selection.removeAllRanges()
    selection.addRange(range)
    insertNode(createMention(user.id))
    insertText(" ")
    setSuggest(null)
    refresh()
  }

  // Dernière position du curseur dans l'éditeur : le bouton d'ajout d'image lui prend
  // le focus, l'image doit quand même arriver là où on écrivait.
  useEffect(() => {
    const onSelection = () => {
      const selection = window.getSelection()
      const el = editor.current
      if (el && selection?.rangeCount && el.contains(selection.anchorNode)) {
        savedRange.current = selection.getRangeAt(0).cloneRange()
      }
    }
    document.addEventListener("selectionchange", onSelection)
    return () => document.removeEventListener("selectionchange", onSelection)
  }, [])

  // Les miniatures des médias envoyés (édition, lien collé, envoi terminé) suivent le
  // cache : vignette pour une image, carte pour un fichier.
  useEffect(() => {
    const el = editor.current
    if (!el) return
    for (const chip of el.querySelectorAll<HTMLElement>("[data-media-id]")) {
      const entry = state.media[chip.dataset.mediaId!]
      if (!entry) store.ensureMedia(chip.dataset.mediaId!)
      else if (entry.status === "missing") renderFile(chip, { name: "fichier supprimé", detail: "", folder: false })
      else if (entry.status === "ready") renderInfo(chip, entry.info, entry.url)
      chip.classList.toggle("opacity-40", entry?.status === "missing")
    }
    for (const chip of el.querySelectorAll<HTMLElement>("[data-mention-id]")) {
      const userId = Number(chip.dataset.mentionId)
      if (state.users[userId]?.avatarVersion) store.ensureAvatar(userId)
      renderMention(chip, state.users[userId]?.pseudo ?? "inconnu", state.avatars[userId]?.url)
    }
  })

  function insertNode(node: Node) {
    const el = editor.current!
    const selection = window.getSelection()!
    let range: Range
    if (selection.rangeCount && el.contains(selection.anchorNode)) range = selection.getRangeAt(0)
    else if (savedRange.current && el.contains(savedRange.current.startContainer)) range = savedRange.current
    else {
      range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
    }
    range.deleteContents()
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    savedRange.current = range.cloneRange()
  }

  function insertText(text: string) {
    insertNode(document.createTextNode(text))
  }

  /** Texte collé : liens de médias et mentions deviennent des pastilles (stories 46, 62). */
  function insertContent(content: string) {
    for (const part of splitContent(content)) insertNode(partNode(part))
    refresh()
  }

  /** Envoi d'un média : la miniature affiche la progression, puis devient son lien. */
  function upload(
    chip: HTMLElement,
    blob: Blob,
    options: { name: string; folder?: { files: number; size: number } },
    progress: (ratio: number) => void,
  ) {
    void store.uploadMedia(blob, { ...options, onProgress: progress }).then((info) => {
      if (info) {
        chip.dataset.mediaId = info.id
        delete chip.dataset.uploading
      } else {
        chip.remove()
      }
      setUploading((n) => n - 1)
      refresh()
    })
  }

  function insertFiles(files: File[]) {
    if (files.length === 0) return
    editor.current?.focus()
    for (const file of files) {
      const chip = createChip(null)
      if (file.type.startsWith("image/")) renderImage(chip, URL.createObjectURL(file), true)
      else
        renderFile(chip, {
          name: file.name,
          detail: "Envoi…",
          folder: false,
          video: file.type.startsWith("video/"),
          audio: file.type.startsWith("audio/"),
        })
      insertNode(chip)
      setUploading((n) => n + 1)
      upload(chip, file, { name: file.name || "fichier" }, (ratio) => {
        if (!file.type.startsWith("image/")) setDetail(chip, `Envoi ${percent(ratio)}`)
      })
    }
    refresh()
  }

  /** Story 52 : chaque dossier est compressé en ZIP puis envoyé comme un fichier. */
  function insertFolders(folders: Folder[]) {
    if (folders.length === 0) return
    editor.current?.focus()
    for (const folder of folders) {
      const chip = createChip(null)
      renderFile(chip, { name: `${folder.name}.zip`, detail: "Compression…", folder: true })
      insertNode(chip)
      setUploading((n) => n + 1)
      const size = folderSize(folder)
      zipFolder(folder, (ratio) => setDetail(chip, `Compression ${percent(ratio)}`))
        .then((zip) =>
          upload(
            chip,
            zip,
            { name: `${folder.name}.zip`, folder: { files: folder.entries.length, size } },
            (ratio) => setDetail(chip, `Envoi ${percent(ratio)} de ${formatBytes(zip.size)}`),
          ),
        )
        .catch(() => {
          store.flash(`Compression de « ${folder.name} » impossible`)
          chip.remove()
          setUploading((n) => n - 1)
          refresh()
        })
    }
    refresh()
  }

  useImperativeHandle(ref, () => ({
    getValue: () => (editor.current ? serialize(editor.current) : ""),
    setValue: (content: string) => {
      const el = editor.current
      if (!el) return
      el.replaceChildren()
      for (const part of splitContent(content)) {
        el.append(partNode(part))
      }
      refresh()
      placeCaretAtEnd(el)
    },
    focus: () => {
      const el = editor.current
      if (!el) return
      el.focus()
      placeCaretAtEnd(el)
    },
    insertFiles,
    insertFolders,
    isUploading: () => uploading > 0,
  }))

  return (
    <div className="relative">
      {suggest && candidates.length > 0 && (
        <ul
          role="listbox"
          aria-label="Mentionner"
          className="absolute bottom-full left-0 z-10 mb-2 w-64 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {candidates.map((user, i) => (
            <li
              key={user.id}
              role="option"
              aria-selected={i === suggest.index}
              // mousedown : choisir sans faire perdre le focus (donc le curseur) à l'éditeur.
              onMouseDown={(e) => {
                e.preventDefault()
                selectMention(user)
              }}
              onMouseEnter={() => setSuggest({ ...suggest, index: i })}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                i === suggest.index && "bg-muted",
              )}
            >
              <Avatar userId={user.id} state={state} store={store} className="size-6 text-xs" />
              <span className="truncate">{user.pseudo}</span>
            </li>
          ))}
        </ul>
      )}
      {empty && (
        <div className="pointer-events-none absolute top-0 left-0 px-2.5 py-2 text-sm text-muted-foreground select-none">
          {placeholder}
        </div>
      )}
      <div
        ref={editor}
        role="textbox"
        aria-multiline
        aria-label={placeholder}
        aria-disabled={disabled}
        contentEditable={!disabled}
        suppressContentEditableWarning
        className={cn(
          "max-h-60 min-h-9 overflow-y-auto px-2.5 py-2 text-sm break-words whitespace-pre-wrap outline-none",
          className,
        )}
        onInput={refresh}
        onKeyDown={(e) => {
          // Autocomplétion ouverte : elle prend les flèches, Entrée, Tab et Échap.
          if (suggest && candidates.length > 0) {
            const move = { ArrowDown: 1, ArrowUp: -1 }[e.key as "ArrowDown" | "ArrowUp"]
            if (move) {
              e.preventDefault()
              setSuggest({ ...suggest, index: (suggest.index + move + candidates.length) % candidates.length })
              return
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault()
              selectMention(candidates[suggest.index] ?? candidates[0])
              return
            }
            if (e.key === "Escape") {
              e.preventDefault()
              setSuggest(null)
              return
            }
          }
          onKeyDown?.(e, isEmpty(e.currentTarget))
          if (e.defaultPrevented || e.key !== "Enter" || e.nativeEvent.isComposing) return
          e.preventDefault()
          if (e.shiftKey) {
            insertText("\n")
            refresh()
          } else {
            onSubmit()
          }
        }}
        onPaste={(e) => {
          e.preventDefault()
          const files = [...e.clipboardData.files]
          if (files.length > 0) insertFiles(files)
          else insertContent(e.clipboardData.getData("text/plain"))
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault()
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length === 0) return
          e.preventDefault()
          const range = document.caretRangeFromPoint?.(e.clientX, e.clientY)
          if (range) {
            const selection = window.getSelection()!
            selection.removeAllRanges()
            selection.addRange(range)
            savedRange.current = range.cloneRange()
          }
          // Synchrone : les entrées ne sont plus lisibles après le premier `await`.
          const entries = [...e.dataTransfer.items]
            .map((item) => item.webkitGetAsEntry())
            .filter((entry): entry is FileSystemEntry => entry !== null)
          void readDropped(entries).then(({ files, folders }) => {
            insertFiles(files)
            insertFolders(folders)
          })
        }}
        onKeyUp={(e) => {
          if (e.key.startsWith("Arrow") && !suggest) detectMention()
        }}
        onBlur={() => setSuggest(null)}
        onClick={(e) => {
          // Croix d'une miniature : retire l'image du message en cours.
          const remove = (e.target as HTMLElement).closest("[data-remove]")
          if (remove) {
            remove.parentElement?.remove()
            refresh()
          }
        }}
      />
      {uploading > 0 && (
        <div className="px-2.5 pb-1.5 text-xs text-muted-foreground">
          Envoi de {uploading} image{uploading > 1 ? "s" : ""}…
        </div>
      )}
    </div>
  )
}

/**
 * Miniature de média dans l'éditeur : un bloc non éditable, effacé d'un coup, avec une
 * croix pour le retirer. Son contenu (vignette ou carte) est posé par `render*`.
 * Tout texte venant de l'utilisateur (nom de fichier) passe par `textContent`.
 */
function createChip(id: string | null): HTMLSpanElement {
  const chip = document.createElement("span")
  chip.contentEditable = "false"
  chip.className = "relative mx-0.5 my-0.5 inline-block align-bottom transition-opacity"
  if (id) chip.dataset.mediaId = id
  else chip.dataset.uploading = "1"
  const body = document.createElement("span")
  body.dataset.body = "1"
  chip.append(body)
  const remove = document.createElement("button")
  remove.type = "button"
  remove.dataset.remove = "1"
  remove.title = "Retirer"
  remove.textContent = "×"
  remove.className =
    "absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-xs leading-none text-background"
  chip.append(remove)
  if (id === null) body.dataset.view = ""
  return chip
}

function renderInfo(chip: HTMLElement, info: MediaInfo, url: string | undefined) {
  if (info.isImage) renderImage(chip, url ?? "", false)
  else {
    const detail = info.folderFiles
      ? `${info.folderFiles} fichiers · ${formatBytes(info.folderSize)}`
      : formatBytes(info.size)
    renderFile(chip, { name: info.name, detail, folder: info.folderFiles > 0, video: info.isVideo, audio: info.isAudio })
  }
}

function renderImage(chip: HTMLElement, url: string, uploading: boolean) {
  const body = chip.querySelector<HTMLElement>("[data-body]")!
  const view = `image:${url}:${uploading}`
  if (body.dataset.view === view) return
  body.dataset.view = view
  const img = document.createElement("img")
  img.className = "h-16 w-16 rounded-md border bg-muted object-cover"
  img.alt = ""
  if (url) img.src = url
  body.replaceChildren(img)
  if (uploading) {
    const spinner = document.createElement("span")
    spinner.className =
      "absolute inset-0 m-auto size-6 animate-spin rounded-full border-2 border-white border-t-transparent"
    body.append(spinner)
  }
}

function renderFile(
  chip: HTMLElement,
  file: { name: string; detail: string; folder: boolean; video?: boolean; audio?: boolean },
) {
  const body = chip.querySelector<HTMLElement>("[data-body]")!
  const view = `file:${file.name}:${file.detail}:${file.folder}:${file.video}:${file.audio}`
  if (body.dataset.view === view) return
  body.dataset.view = view
  const card = document.createElement("span")
  card.className = "inline-flex max-w-64 items-center gap-2 rounded-md border bg-muted px-2.5 py-1.5 text-xs"
  const icon = document.createElement("span")
  icon.className = "text-lg leading-none"
  icon.textContent = file.folder ? "🗂️" : file.video ? "🎬" : file.audio ? "🎵" : "📄"
  const text = document.createElement("span")
  text.className = "min-w-0"
  const name = document.createElement("span")
  name.className = "block truncate font-medium"
  name.textContent = file.name
  const detail = document.createElement("span")
  detail.dataset.detail = "1"
  detail.className = "block text-muted-foreground"
  detail.textContent = file.detail
  text.append(name, detail)
  card.append(icon, text)
  body.replaceChildren(card)
}

/** Progression : mise à jour directe du texte, sans reconstruire la carte. */
function setDetail(chip: HTMLElement, detail: string) {
  const el = chip.querySelector<HTMLElement>("[data-detail]")
  if (el) el.textContent = detail
}

function percent(ratio: number): string {
  return `${Math.floor(ratio * 100)} %`
}

function partNode(part: Part): Node {
  if (part.kind === "text") return document.createTextNode(part.text)
  if (part.kind === "media") return createChip(part.id)
  return createMention(part.userId)
}

/** Story 62 : pastille de mention non éditable — mini photo et pseudo coloré. */
function createMention(userId: number): HTMLSpanElement {
  const chip = document.createElement("span")
  chip.contentEditable = "false"
  chip.dataset.mentionId = String(userId)
  chip.className = "mention mx-0.5 inline-flex items-center gap-1 rounded-md px-1 align-bottom font-medium"
  chip.style.setProperty("--mention-h", String(userHue(userId)))
  return chip
}

function renderMention(chip: HTMLElement, pseudo: string, avatarUrl: string | undefined) {
  const view = `${pseudo}:${avatarUrl ?? ""}`
  if (chip.dataset.view === view) return
  chip.dataset.view = view
  const avatar = document.createElement(avatarUrl ? "img" : "span")
  avatar.className =
    "inline-flex size-4 items-center justify-center rounded-full object-cover text-[0.55rem] font-semibold text-white"
  if (avatar instanceof HTMLImageElement) {
    avatar.src = avatarUrl!
    avatar.alt = ""
  } else {
    avatar.style.backgroundColor = userColor(Number(chip.dataset.mentionId))
    avatar.textContent = pseudo.charAt(0).toUpperCase()
  }
  const name = document.createElement("span")
  name.textContent = `@${pseudo}`
  chip.replaceChildren(avatar, name)
}

/** Insensible à la casse et aux accents ; ceux qui commencent par la saisie d'abord. */
function matchMembers(users: Profile[], query: string): Profile[] {
  const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
  const q = norm(query)
  return users
    .filter((u) => u.pseudo && norm(u.pseudo).includes(q))
    .sort((a, b) => {
      const starts = Number(norm(b.pseudo).startsWith(q)) - Number(norm(a.pseudo).startsWith(q))
      return starts || a.pseudo.localeCompare(b.pseudo, "fr", { sensitivity: "base" })
    })
    .slice(0, 8)
}

function serialize(root: HTMLElement): string {
  let out = ""
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += (child as Text).data
      } else if (child instanceof HTMLElement) {
        if (child.dataset.mediaId) out += mediaToken(child.dataset.mediaId)
        else if (child.dataset.mentionId) out += mentionToken(Number(child.dataset.mentionId))
        else if (child.dataset.uploading || child.dataset.end) continue
        else if (child.tagName === "BR") out += "\n"
        else {
          // Bloc inséré par le navigateur (glisser du texte…) : nouvelle ligne.
          if ((child.tagName === "DIV" || child.tagName === "P") && out && !out.endsWith("\n")) out += "\n"
          walk(child)
        }
      }
    }
  }
  walk(root)
  return out
}

function isEmpty(root: HTMLElement): boolean {
  return serialize(root).trim() === "" && !root.querySelector("[data-uploading]")
}

/**
 * Un saut de ligne final dans un `contenteditable` ne s'affiche pas (le curseur reste
 * sur la ligne d'avant) tant qu'il n'est suivi de rien : un `<br data-end>` sentinelle,
 * ignoré à la lecture, lui donne sa ligne.
 */
function fixTrailingNewline(root: HTMLElement) {
  root.querySelectorAll("br[data-end]").forEach((br) => br.remove())
  if (serialize(root).endsWith("\n")) {
    const br = document.createElement("br")
    br.dataset.end = "1"
    root.append(br)
  }
}

function placeCaretAtEnd(root: HTMLElement) {
  const range = document.createRange()
  const sentinel = root.querySelector("br[data-end]")
  if (sentinel) range.setStartBefore(sentinel)
  else {
    range.selectNodeContents(root)
    range.collapse(false)
  }
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

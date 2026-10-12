// Barre de saisie riche (stories 27, 45) : texte et images librement mélangés, dans
// l'ordre où on les place. Une image est une miniature insérée au curseur (bouton,
// Ctrl+V, glisser-déposer, ou lien `/media/…` collé, story 46) ; le contenu se lit
// comme le texte du message, chaque image y devenant son lien.
//
// `contenteditable` piloté à la main (non contrôlé par React) : React ne touche jamais
// à son DOM, les miniatures y sont posées par les fonctions ci-dessous. Entrée envoie,
// Maj+Entrée saute une ligne.

import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from "react"
import { cn } from "@/lib/utils"
import { mediaToken, splitContent } from "./media"
import type { ChatState, ChatStore } from "./store"

export type ComposerHandle = {
  /** Contenu du message : texte, images remplacées par leur lien. */
  getValue(): string
  setValue(content: string): void
  focus(): void
  insertFiles(files: File[]): void
  /** Une image est encore en cours d'envoi : le message ne peut pas partir. */
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

  const refresh = () => {
    const el = editor.current
    if (!el) return
    fixTrailingNewline(el)
    setEmpty(isEmpty(el))
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

  // Les miniatures d'images déjà envoyées (édition, lien collé) suivent le cache.
  useEffect(() => {
    const el = editor.current
    if (!el) return
    for (const chip of el.querySelectorAll<HTMLElement>("[data-media-id]")) {
      const id = chip.dataset.mediaId!
      const entry = state.media[id]
      const img = chip.querySelector("img")!
      if (!entry) store.ensureMedia(id)
      else if (entry.status === "ready" && !img.src) img.src = entry.url
      chip.classList.toggle("opacity-40", entry?.status === "missing")
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

  /** Texte collé : les liens d'images deviennent des miniatures (story 46). */
  function insertContent(content: string) {
    for (const part of splitContent(content)) {
      insertNode(part.kind === "text" ? document.createTextNode(part.text) : createChip(part.id, null))
    }
    refresh()
  }

  function insertFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"))
    if (images.length === 0) {
      if (files.length > 0) store.flash("Seules les images sont acceptées")
      return
    }
    editor.current?.focus()
    for (const file of images) {
      // Aperçu local immédiat, le lien remplace la miniature en attente une fois envoyée.
      const chip = createChip(null, URL.createObjectURL(file))
      insertNode(chip)
      setUploading((n) => n + 1)
      void store.uploadMedia(file).then((id) => {
        if (id) {
          chip.dataset.mediaId = id
          delete chip.dataset.uploading
          chip.querySelector("[data-spinner]")?.remove()
        } else {
          chip.remove()
        }
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
        el.append(part.kind === "text" ? document.createTextNode(part.text) : createChip(part.id, null))
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
    isUploading: () => uploading > 0,
  }))

  return (
    <div className="relative">
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
          const files = [...e.dataTransfer.files]
          if (files.length === 0) return
          e.preventDefault()
          const range = document.caretRangeFromPoint?.(e.clientX, e.clientY)
          if (range) {
            const selection = window.getSelection()!
            selection.removeAllRanges()
            selection.addRange(range)
          }
          insertFiles(files)
        }}
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

/** Miniature d'image dans l'éditeur : un bloc non éditable, effacé d'un coup. */
function createChip(id: string | null, preview: string | null): HTMLSpanElement {
  const chip = document.createElement("span")
  chip.contentEditable = "false"
  chip.className = "relative mx-0.5 inline-block align-bottom transition-opacity"
  if (id) chip.dataset.mediaId = id
  else chip.dataset.uploading = "1"
  const img = document.createElement("img")
  img.className = "h-16 w-16 rounded-md border bg-muted object-cover"
  img.alt = ""
  if (preview) img.src = preview
  chip.append(img)
  if (!id) {
    const spinner = document.createElement("span")
    spinner.dataset.spinner = "1"
    spinner.className =
      "absolute inset-0 m-auto size-6 animate-spin rounded-full border-2 border-white border-t-transparent"
    chip.append(spinner)
  }
  const remove = document.createElement("button")
  remove.type = "button"
  remove.dataset.remove = "1"
  remove.title = "Retirer l'image"
  remove.textContent = "×"
  remove.className =
    "absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-xs leading-none text-background"
  chip.append(remove)
  return chip
}

function serialize(root: HTMLElement): string {
  let out = ""
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += (child as Text).data
      } else if (child instanceof HTMLElement) {
        if (child.dataset.mediaId) out += mediaToken(child.dataset.mediaId)
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

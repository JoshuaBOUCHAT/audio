// Images, vidéos et fichiers (stories 27, 45-54) : envoi, métadonnées groupées,
// chargement authentifié, lecture et téléchargement par ticket.

import { MEDIA_BASE } from "@/lib/config"
import { deleteMedia, getMedia, requestDownload } from "@/lib/protocol"
import { chat } from "@/proto/messages.js"
import { toMediaInfo, type MediaInfo } from "./model"
import { StoreCore } from "./store-core"
import { type MediaEntry } from "./store-core"

export abstract class MediaLayer extends StoreCore {
  /** Ids dont les métadonnées sont à demander, envoyés en un seul `GetMedia`. */
  protected mediaQueue = new Set<string>()

  /**
   * Stories 27, 51-52 : envoie un fichier (`POST /media`), image ou non. Rend ses
   * métadonnées, pour placer son lien dans le message ; `null` si refusé (quota :
   * erreur dans `error`). Une image envoyée est mise en cache sans la retélécharger.
   * XMLHttpRequest plutôt que fetch : seul à donner la progression de l'envoi.
   */
  uploadMedia = (
    file: Blob,
    options: { name: string; folder?: { files: number; size: number }; onProgress?: (ratio: number) => void },
  ): Promise<MediaInfo | null> => {
    const token = this.sessionToken
    if (!token || !this.state.me) return Promise.resolve(null)
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest()
      xhr.open("POST", `${MEDIA_BASE}/media`)
      xhr.responseType = "arraybuffer"
      xhr.setRequestHeader("Authorization", `Bearer ${token}`)
      xhr.setRequestHeader("X-Media-Name", encodeURIComponent(options.name))
      if (options.folder) {
        xhr.setRequestHeader("X-Folder-Files", String(options.folder.files))
        xhr.setRequestHeader("X-Folder-Size", String(options.folder.size))
      }
      xhr.upload.onprogress = (e) => e.lengthComputable && options.onProgress?.(e.loaded / e.total)
      xhr.onerror = () => {
        this.set({ error: "envoi impossible (réseau)" })
        resolve(null)
      }
      xhr.onload = () => {
        const body = new Uint8Array(xhr.response as ArrayBuffer)
        if (xhr.status !== 201) {
          this.set({ error: httpError(body, xhr.status) })
          resolve(null)
          return
        }
        const media = chat.MediaUploaded.decode(body).media
        if (!media?.id) return resolve(null)
        const info = toMediaInfo(media)
        this.setMedia(info.id, {
          status: "ready",
          info,
          // Image, vidéo ou son qu'on vient d'envoyer : lu depuis le fichier local.
          url: info.isImage || info.isVideo || info.isAudio ? URL.createObjectURL(file) : undefined,
        })
        resolve(info)
      }
      xhr.send(file)
    })
  }

  /**
   * Métadonnées d'un média (story 51), demandées par lots par le WebSocket, puis le
   * contenu s'il s'agit d'une image (`GET /media/{id}` avec le token, story 48) — un
   * fichier n'est jamais chargé pour s'afficher. Appelé au rendu : idempotent.
   */
  ensureMedia = (id: string): void => {
    if (this.state.media[id] || !this.client) return
    this.setMedia(id, { status: "loading" })
    this.mediaQueue.add(id)
    if (this.mediaQueue.size === 1) queueMicrotask(() => void this.flushMediaQueue())
  }

  protected async flushMediaQueue(): Promise<void> {
    const ids = [...this.mediaQueue]
    this.mediaQueue.clear()
    const response = await this.request(getMedia(ids))
    if (!response?.mediaInfo) {
      // Réseau : réessayé au prochain rendu.
      for (const id of ids) this.forgetMedia(id)
      return
    }
    const found = new Map((response.mediaInfo.media ?? []).map((m) => [m.id ?? "", toMediaInfo(m)]))
    for (const id of ids) {
      const info = found.get(id)
      if (!info) this.setMedia(id, { status: "missing" })
      else {
        this.setMedia(id, { status: "ready", info })
        if (info.isImage) void this.loadImage(info)
        if (info.isVideo || info.isAudio) void this.refreshStream(id)
      }
    }
  }

  protected async loadImage(info: MediaInfo): Promise<void> {
    try {
      const response = await fetch(`${MEDIA_BASE}/media/${info.id}`, {
        headers: { Authorization: `Bearer ${this.sessionToken}` },
      })
      if (response.status === 404) return this.markMediaMissing(info.id)
      if (!response.ok) throw new Error(String(response.status))
      const url = URL.createObjectURL(await response.blob())
      this.setMedia(info.id, { status: "ready", info, url })
    } catch {
      this.forgetMedia(info.id)
    }
  }

  /**
   * Story 54 : adresse de lecture d'une vidéo — le lecteur du navigateur ne porte pas
   * de token, il lit par plages avec un ticket de lecture (1 h, prolongée à chaque
   * requête). Rappelé par le lecteur si le ticket a expiré (onglet resté ouvert).
   */
  refreshStream = async (id: string): Promise<void> => {
    const response = await this.request(requestDownload(id, true))
    const ticket = response?.downloadTicket?.ticket
    const entry = this.state.media[id]
    if (!ticket || entry?.status !== "ready") return
    this.setMedia(id, { ...entry, url: `${MEDIA_BASE}/media/${id}?ticket=${ticket}` })
  }

  protected forgetMedia(id: string): void {
    const { [id]: _forgotten, ...media } = this.state.media
    this.set({ media })
  }

  /**
   * Story 53 : téléchargement natif — ticket de 60 s, puis le navigateur télécharge
   * lui-même (son gestionnaire, sans passer par la mémoire de l'app).
   */
  download = async (id: string): Promise<void> => {
    const response = await this.request(requestDownload(id))
    const ticket = response?.downloadTicket?.ticket
    if (!ticket) return
    const a = document.createElement("a")
    a.href = `${MEDIA_BASE}/media/${id}?ticket=${ticket}`
    a.click()
  }

  /** Story 50 : « pour tout le monde », par celle ou celui qui l'a envoyée. */
  deleteMediaEverywhere = async (id: string): Promise<void> => {
    const response = await this.request(deleteMedia(id))
    if (response?.mediaDeleted) this.markMediaMissing(id)
  }

  protected setMedia(id: string, entry: MediaEntry): void {
    this.set({ media: { ...this.state.media, [id]: entry } })
  }

  protected markMediaMissing(id: string): void {
    const entry = this.state.media[id]
    if (entry?.status === "ready" && entry.url?.startsWith("blob:")) URL.revokeObjectURL(entry.url)
    this.setMedia(id, { status: "missing" })
  }
}

/** Corps d'une erreur HTTP : un `Error` protobuf, comme sur le WebSocket. */
function httpError(body: Uint8Array, status: number): string {
  try {
    return chat.Error.decode(body).message || `erreur ${status}`
  } catch {
    return `erreur ${status}`
  }
}

// Contenu d'un message : du texte où un lien `/media/{id}` (relatif, ou absolu copié
// depuis l'app, story 46) est une image ou un fichier à sa place (story 27), et
// `<@{id}>` une mention (story 62).

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const MEDIA_LINK = new RegExp(`(?:https?://[^\\s/]+)?/media/(${UUID})`, "g")
const TOKEN = new RegExp(`(?:https?://[^\\s/]+)?/media/(${UUID})|<@(\\d+)>`, "g")

export type Part =
  | { kind: "text"; text: string }
  | { kind: "media"; id: string }
  | { kind: "mention"; userId: number }

export function splitContent(content: string): Part[] {
  const parts: Part[] = []
  let last = 0
  for (const match of content.matchAll(TOKEN)) {
    if (match.index > last) parts.push({ kind: "text", text: content.slice(last, match.index) })
    parts.push(match[1] ? { kind: "media", id: match[1] } : { kind: "mention", userId: Number(match[2]) })
    last = match.index + match[0].length
  }
  if (last < content.length) parts.push({ kind: "text", text: content.slice(last) })
  return parts
}

/** Story 62 : forme stockée d'une mention. */
export function mentionToken(userId: number): string {
  return `<@${userId}>`
}

export function mentions(content: string, userId: number): boolean {
  return content.includes(mentionToken(userId))
}

function partToText(part: Part): string {
  return part.kind === "text" ? part.text : part.kind === "media" ? mediaToken(part.id) : mentionToken(part.userId)
}

/** Forme stockée dans le message : relative, indépendante de l'hôte. */
export function mediaToken(id: string): string {
  return `/media/${id}`
}

/** Lien à partager (story 46) : absolu, mais ne s'ouvre que dans l'app. */
export function shareLink(id: string): string {
  return `${window.location.origin}/media/${id}`
}

/**
 * Aperçu texte (citation, popup système) : chaque média devient « 🖼 fichier », chaque
 * mention « @pseudo ».
 */
export function plainText(content: string, pseudoOf?: (userId: number) => string): string {
  return content
    .replace(MEDIA_LINK, " 🖼 fichier ")
    .replace(/<@(\d+)>/g, (_, id: string) => `@${pseudoOf?.(Number(id)) ?? "quelqu'un"}`)
}

/** Retire une image d'un message (« supprimer ici », story 50). */
export function withoutMedia(content: string, id: string): string {
  return splitContent(content)
    .filter((p) => p.kind !== "media" || p.id !== id)
    .map(partToText)
    .join("")
}

/** Taille lisible, unités binaires à la française : « 3,2 Go ». */
export function formatBytes(bytes: number): string {
  const units = ["o", "Ko", "Mo", "Go", "To"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  return `${value.toLocaleString("fr-FR", { maximumFractionDigits: digits })} ${units[unit]}`
}

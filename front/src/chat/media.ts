// Story 27 : une image est un lien `/media/{id}` placé dans le texte du message. Tout
// lien de cette forme (relatif, ou absolu copié depuis l'app, story 46) s'affiche en
// image, à sa place.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const MEDIA_LINK = new RegExp(`(?:https?://[^\\s/]+)?/media/(${UUID})`, "g")

export type Part = { kind: "text"; text: string } | { kind: "media"; id: string }

export function splitContent(content: string): Part[] {
  const parts: Part[] = []
  let last = 0
  for (const match of content.matchAll(MEDIA_LINK)) {
    if (match.index > last) parts.push({ kind: "text", text: content.slice(last, match.index) })
    parts.push({ kind: "media", id: match[1] })
    last = match.index + match[0].length
  }
  if (last < content.length) parts.push({ kind: "text", text: content.slice(last) })
  return parts
}

/** Forme stockée dans le message : relative, indépendante de l'hôte. */
export function mediaToken(id: string): string {
  return `/media/${id}`
}

/** Lien à partager (story 46) : absolu, mais ne s'ouvre que dans l'app. */
export function shareLink(id: string): string {
  return `${window.location.origin}/media/${id}`
}

/** Aperçu texte (citation d'une réponse) : chaque image devient « 🖼 image ». */
export function plainText(content: string): string {
  return content.replace(MEDIA_LINK, " 🖼 image ")
}

/** Retire une image d'un message (« supprimer ici », story 50). */
export function withoutMedia(content: string, id: string): string {
  return splitContent(content)
    .filter((p) => p.kind === "text" || p.id !== id)
    .map((p) => (p.kind === "text" ? p.text : mediaToken(p.id)))
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

// Story 37 : la photo est recadrée (carré centré) et réduite côté client avant
// l'envoi, le serveur n'acceptant que PNG/JPEG/WebP ≤ 256 Kio sans décoder l'image.

const SIZE = 256
const MAX_BYTES = 256 * 1024

export async function toAvatarBytes(file: File): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("image illisible")
  })
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement("canvas")
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext("2d")!
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    SIZE,
    SIZE,
  )
  bitmap.close()
  // WebP si le navigateur sait l'encoder (sinon toBlob rend du PNG), JPEG en repli
  // si le résultat dépasse la limite serveur.
  for (const [type, quality] of [["image/webp", 0.85], ["image/jpeg", 0.85], ["image/jpeg", 0.6]] as const) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
    if (blob && blob.size <= MAX_BYTES) return new Uint8Array(await blob.arrayBuffer())
  }
  throw new Error("image trop lourde même réduite")
}

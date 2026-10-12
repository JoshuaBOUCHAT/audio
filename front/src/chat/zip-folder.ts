// Story 52 : un dossier part comme un seul ZIP, compressé dans le navigateur par fflate
// (deflate dans des workers, la page ne gèle pas). Les fichiers déjà compressés sont
// stockés tels quels : les recompresser coûterait du temps pour rien.
//
// Limite v1 : l'archive est entièrement construite avant l'envoi (HTTP/1.1 n'a pas
// d'envoi en flux depuis le navigateur) ; le navigateur peut la garder sur disque.


export type FolderEntry = { path: string; file: File }
export type Folder = { name: string; entries: FolderEntry[] }

const ALREADY_COMPRESSED =
  /\.(jpe?g|png|gif|webp|avif|heic|mp4|m4v|mkv|mov|webm|avi|mp3|m4a|aac|ogg|opus|flac|zip|7z|rar|gz|tgz|bz2|xz|zst|docx|xlsx|pptx|odt|ods|apk|jar|woff2?)$/i

export function folderSize(folder: Folder): number {
  return folder.entries.reduce((n, e) => n + e.file.size, 0)
}

/** fflate n'est chargé qu'au premier dossier envoyé : hors du bundle principal. */
export async function zipFolder(folder: Folder, onProgress: (ratio: number) => void): Promise<Blob> {
  const { AsyncZipDeflate, Zip, ZipPassThrough } = await import("fflate")
  const total = folderSize(folder) || 1
  let read = 0
  const chunks: Uint8Array[] = []
  return new Promise((resolve, reject) => {
    const zip = new Zip((err, data, final) => {
      if (err) return reject(err)
      chunks.push(data)
      if (final) resolve(new Blob(chunks as BlobPart[], { type: "application/zip" }))
    })
    const run = async () => {
      for (const { path, file } of folder.entries) {
        const entry = ALREADY_COMPRESSED.test(path) ? new ZipPassThrough(path) : new AsyncZipDeflate(path, { level: 6 })
        entry.mtime = file.lastModified
        zip.add(entry)
        const reader = file.stream().getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          // Longueur lue avant `push` : le deflate asynchrone transfère le buffer au
          // worker, qui le vide côté page.
          read += value.length
          entry.push(value, false)
          onProgress(read / total)
        }
        entry.push(new Uint8Array(0), true)
      }
      zip.end()
    }
    run().catch(reject)
  })
}

/**
 * Dossiers choisis par `<input webkitdirectory>` : chaque fichier porte son chemin
 * relatif, le premier segment est le nom du dossier.
 */
export function foldersFromInput(files: File[]): Folder[] {
  const byName = new Map<string, FolderEntry[]>()
  for (const file of files) {
    const path = file.webkitRelativePath || file.name
    const name = path.split("/")[0]
    byName.set(name, [...(byName.get(name) ?? []), { path, file }])
  }
  return [...byName].map(([name, entries]) => ({ name, entries }))
}

/**
 * Glisser-déposer : fichiers isolés et dossiers (parcourus récursivement). Les entrées
 * doivent être prises de façon synchrone dans l'événement `drop` : `entries` vient de
 * `webkitGetAsEntry()` appelé avant tout `await`.
 */
export async function readDropped(entries: FileSystemEntry[]): Promise<{ files: File[]; folders: Folder[] }> {
  const files: File[] = []
  const folders: Folder[] = []
  for (const entry of entries) {
    if (entry.isFile) files.push(await fileOf(entry as FileSystemFileEntry))
    else if (entry.isDirectory) {
      const collected: FolderEntry[] = []
      await walk(entry as FileSystemDirectoryEntry, entry.name, collected)
      folders.push({ name: entry.name, entries: collected })
    }
  }
  return { files, folders }
}

async function walk(dir: FileSystemDirectoryEntry, prefix: string, out: FolderEntry[]) {
  for (const entry of await readAll(dir)) {
    const path = `${prefix}/${entry.name}`
    if (entry.isFile) out.push({ path, file: await fileOf(entry as FileSystemFileEntry) })
    else if (entry.isDirectory) await walk(entry as FileSystemDirectoryEntry, path, out)
  }
}

/** `readEntries` rend les entrées par paquets (100 max sous Chrome) : lire jusqu'au vide. */
async function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  const all: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (batch.length === 0) return all
    all.push(...batch)
  }
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

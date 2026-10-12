// Onglet Profil des paramètres (story 60) : photo (37), statut (41), pseudo (35),
// description (43).

import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { Avatar } from "./Avatar"
import { toAvatarBytes } from "./avatar-image"
import type { ChatState, ChatStore } from "./store"

/** Story 43, même borne que le serveur (`validate::MAX_BIO_CHARS`). */
const MAX_BIO_CHARS = 190

export function ProfileSettings({ state, store }: { state: ChatState; store: ChatStore }) {
  const me = state.me!
  const [pseudo, setPseudo] = useState(me.pseudo)
  const [bio, setBio] = useState(me.bio)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  async function run(action: () => Promise<boolean>, done: string) {
    setBusy(true)
    setNotice(null)
    if (await action()) setNotice(done)
    setBusy(false)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <Avatar userId={me.id} state={state} store={store} className="size-20 text-2xl" />
        <div className="flex flex-col gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
            {me.avatarVersion ? "Changer la photo" : "Ajouter une photo"}
          </Button>
          {me.avatarVersion !== 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => run(() => store.setAvatar(new Uint8Array()), "Photo retirée.")}
            >
              Retirer la photo
            </Button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ""
              if (!file) return
              try {
                const bytes = await toAvatarBytes(file)
                await run(() => store.setAvatar(bytes), "Photo mise à jour.")
              } catch (err) {
                setNotice(err instanceof Error ? err.message : String(err))
              }
            }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Statut</span>
        <div className="grid grid-cols-2 gap-2">
          {([false, true] as const).map((invisible) => (
            <Button
              key={String(invisible)}
              type="button"
              variant={me.invisible === invisible ? "secondary" : "ghost"}
              className={cn("justify-start", me.invisible === invisible && "ring-1 ring-border")}
              onClick={() => void store.setInvisible(invisible)}
              aria-pressed={me.invisible === invisible}
            >
              <span
                className={cn("size-2.5 rounded-full", invisible ? "bg-muted-foreground/50" : "bg-emerald-500")}
              />
              {invisible ? "Invisible" : "En ligne"}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {me.invisible
            ? "Les autres te voient hors ligne, mais tu peux tout faire normalement."
            : "Les autres te voient en ligne 15 s après ta connexion."}
        </p>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void run(() => store.setPseudo(pseudo), "Pseudo mis à jour.")
        }}
      >
        <Input value={pseudo} onChange={(e) => setPseudo(e.target.value)} maxLength={32} required />
        <Button type="submit" disabled={busy || pseudo.trim() === me.pseudo}>
          Enregistrer
        </Button>
      </form>

      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          void run(() => store.setBio(bio), bio.trim() ? "Description mise à jour." : "Description retirée.")
        }}
      >
        <label htmlFor="bio" className="text-sm font-medium">
          À propos de moi
        </label>
        <textarea
          id="bio"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={MAX_BIO_CHARS}
          rows={3}
          placeholder="Quelques mots sur toi…"
          className="min-h-20 w-full resize-none rounded-lg border border-input bg-transparent dark:bg-input/30 px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {[...bio].length} / {MAX_BIO_CHARS}
          </span>
          <Button type="submit" size="sm" disabled={busy || bio.trim() === me.bio}>
            Enregistrer
          </Button>
        </div>
      </form>

      <p className="text-xs text-muted-foreground">Connecté avec {me.email} (visible de toi seul).</p>
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      {notice && !state.error && <p className="text-sm text-muted-foreground">{notice}</p>}
    </div>
  )
}

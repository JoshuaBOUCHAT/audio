// Profils (stories 34-37, 41, 43, 55) : pseudo, statut, description, thème, photos.

import { getAvatar, setAvatar, setBio, setPseudo, setStatus, setTheme } from "@/lib/protocol"
import { applyTheme, type ThemeChoice } from "@/lib/theme"
import { chat } from "@/proto/messages.js"
import { fromThemeChoice, toNumber, toProfile, type Profile } from "./model"
import { MediaLayer } from "./store-media"

export abstract class ProfilesLayer extends MediaLayer {
  /** Clés `id:version` des photos en cours de chargement. */
  protected readonly avatarRequests = new Set<string>()

  /** Stories 34-35. `true` si accepté ; sinon l'erreur (409 : pris) est dans `error`. */
  setPseudo = async (pseudo: string): Promise<boolean> => {
    this.set({ error: null })
    const response = await this.request(setPseudo(pseudo))
    const profile = response?.userUpdated?.profile
    if (!profile) return false
    this.applyProfile(toProfile(profile))
    return true
  }

  /** Story 55 : appliqué tout de suite, mémorisé avec le compte, poussé à mes autres appareils. */
  setTheme = async (theme: ThemeChoice): Promise<void> => {
    const me = this.state.me
    if (!me) return
    applyTheme(theme)
    this.set({ me: { ...me, theme } })
    await this.request(setTheme(fromThemeChoice(theme)))
  }

  /** Story 41 : appliqué tout de suite côté serveur (pas de délai, story 42). */
  setInvisible = async (invisible: boolean): Promise<void> => {
    const response = await this.request(setStatus(invisible ? chat.Status.INVISIBLE : chat.Status.ONLINE))
    const me = this.state.me
    if (response?.statusSet && me) {
      this.set({ me: { ...me, invisible: response.statusSet.status === chat.Status.INVISIBLE } })
    }
  }

  /** Story 43. `true` si acceptée ; sinon l'erreur est dans `error`. */
  setBio = async (bio: string): Promise<boolean> => {
    this.set({ error: null })
    const response = await this.request(setBio(bio))
    const profile = response?.userUpdated?.profile
    if (!profile) return false
    this.applyProfile(toProfile(profile))
    return true
  }

  /** Story 37 : image déjà réduite (cf. avatar-image.ts) ; vide = retirer la photo. */
  setAvatar = async (image: Uint8Array): Promise<boolean> => {
    this.set({ error: null })
    const response = await this.request(setAvatar(image))
    const profile = response?.userUpdated?.profile
    if (!profile) return false
    this.applyProfile(toProfile(profile))
    return true
  }

  /**
   * Charge la photo d'un utilisateur si la version connue n'est pas encore en cache.
   * Appelé au rendu de chaque avatar : idempotent, une seule requête par version.
   */
  ensureAvatar = (userId: number): void => {
    const version = this.state.users[userId]?.avatarVersion ?? 0
    if (version === 0 || this.state.avatars[userId]?.version === version) return
    const key = `${userId}:${version}`
    if (this.avatarRequests.has(key) || !this.client) return
    this.avatarRequests.add(key)
    void this.client
      .request(getAvatar(userId))
      .then((response) => {
        const avatar = response.avatar
        if (!avatar?.image) return
        const loaded = toNumber(avatar.avatarVersion)
        // Une version plus récente a pu arriver entre-temps : on garde la plus récente.
        if ((this.state.avatars[userId]?.version ?? 0) >= loaded) return
        const previous = this.state.avatars[userId]
        if (previous) URL.revokeObjectURL(previous.url)
        // Type laissé vide : le navigateur reconnaît PNG/JPEG/WebP à leurs octets.
        const url = URL.createObjectURL(new Blob([avatar.image as Uint8Array<ArrayBuffer>]))
        this.set({ avatars: { ...this.state.avatars, [userId]: { version: loaded, url } } })
      })
      .catch(() => {}) // WS fermé : rechargée au prochain rendu après reconnexion
      .finally(() => this.avatarRequests.delete(key))
  }

  protected applyProfile(profile: Profile): void {
    const users = { ...this.state.users, [profile.id]: profile }
    const me = this.state.me
    if (me && me.id === profile.id) {
      const updated = { ...me, pseudo: profile.pseudo, avatarVersion: profile.avatarVersion, bio: profile.bio }
      this.set({ users, me: updated, phase: this.state.phase === "pseudo" ? "ready" : this.state.phase })
    } else {
      this.set({ users })
    }
    if (profile.avatarVersion === 0 && this.state.avatars[profile.id]) {
      const { [profile.id]: removed, ...avatars } = this.state.avatars
      URL.revokeObjectURL(removed.url)
      this.set({ avatars })
    }
  }
}

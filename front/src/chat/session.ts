// Token de session (story 33) en localStorage. Toute lecture/écriture peut échouer
// (navigation privée, stockage bloqué) : le client retombe alors sur l'écran de login.

const KEY = "audio.session_token"

export function loadSessionToken(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function saveSessionToken(token: string): void {
  try {
    localStorage.setItem(KEY, token)
  } catch {
    // session non persistée : il faudra un nouveau lien magique au prochain chargement
  }
}

export function clearSessionToken(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // rien à effacer
  }
}

/** Paramètre d'URL lu une fois puis retiré de l'URL, pour ne pas le rejouer. */
function takeUrlParam(name: string): string | null {
  const url = new URL(window.location.href)
  const value = url.searchParams.get(name)
  if (!value) return null
  url.searchParams.delete(name)
  window.history.replaceState(null, "", url)
  return value
}

/** Lien de connexion (story 68) : `?token=`. */
export function takeMagicLinkToken(): string | null {
  return takeUrlParam("token")
}

/** Lien d'invitation (story 65) : `?invite=`. */
export function takeInviteToken(): string | null {
  return takeUrlParam("invite")
}

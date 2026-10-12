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

/** Token de lien magique passé en `?token=` ; retiré de l'URL pour ne pas le rejouer. */
export function takeMagicLinkToken(): string | null {
  const url = new URL(window.location.href)
  const token = url.searchParams.get("token")
  if (!token) return null
  url.searchParams.delete("token")
  window.history.replaceState(null, "", url)
  return token
}

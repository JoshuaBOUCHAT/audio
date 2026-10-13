// URL du back-end. Surchargeable par VITE_BACK_END_URL (fichier .env de Vite) ; par
// défaut, en dev le serveur local et son cert auto-signé, en prod la même origine que
// la page (le front est servi par le binaire du back-end).
export const BACK_END_URL: string =
  import.meta.env.VITE_BACK_END_URL ??
  (import.meta.env.DEV ? "wss://127.0.0.1:8443" : `wss://${location.host}/`)

// Base HTTP des images (story 27). Vide = même origine que la page : en dev, le proxy
// Vite transmet `/media` au back-end (vite.config.ts) ; en prod, le serveur sert tout.
export const MEDIA_BASE: string = import.meta.env.VITE_MEDIA_BASE ?? ""

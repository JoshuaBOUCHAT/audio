// URL du back-end. Surchargeable par VITE_BACK_END_URL (fichier .env de Vite) ; par
// défaut le serveur de dev local et son cert auto-signé.
export const BACK_END_URL: string = import.meta.env.VITE_BACK_END_URL ?? "wss://127.0.0.1:8443"

// Base HTTP des images (story 27). Vide = même origine que la page : en dev, le proxy
// Vite transmet `/media` au back-end (vite.config.ts) ; en prod, le serveur sert tout.
export const MEDIA_BASE: string = import.meta.env.VITE_MEDIA_BASE ?? ""

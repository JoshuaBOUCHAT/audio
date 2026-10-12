// Story 55 : thème Système / Clair / Sombre. Le choix vit avec le compte (serveur) ;
// une copie locale l'applique dès le chargement (script inline d'index.html, même clé),
// avant que l'app ne se connecte : pas d'écran blanc furtif en sombre.

export type ThemeChoice = "system" | "light" | "dark"

const KEY = "audio.theme"
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)")
let current: ThemeChoice = loadCachedTheme()

export function loadCachedTheme(): ThemeChoice {
  try {
    const cached = localStorage.getItem(KEY)
    return cached === "light" || cached === "dark" ? cached : "system"
  } catch {
    return "system"
  }
}

export function resolvedTheme(choice: ThemeChoice = current): "light" | "dark" {
  if (choice === "system") return prefersDark.matches ? "dark" : "light"
  return choice
}

export function applyTheme(choice: ThemeChoice): void {
  current = choice
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    // pas de copie locale : le thème du compte s'appliquera à la connexion
  }
  const resolved = resolvedTheme(choice)
  document.documentElement.classList.toggle("dark", resolved === "dark")
  document.documentElement.style.colorScheme = resolved
}

/** En « Système », suit les changements de thème de l'OS en direct. */
export function watchSystemTheme(): void {
  prefersDark.addEventListener("change", () => {
    if (current === "system") applyTheme("system")
  })
}

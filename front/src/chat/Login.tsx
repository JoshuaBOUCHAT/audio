// Stories 1-2 : email → lien magique. En v1 le lien n'est pas envoyé par email mais
// loggé côté serveur (CLAUDE.md § Authentification) : on accepte donc aussi le token
// collé à la main, en plus du lien `?token=` ouvert directement.
//
// Pas de champ mot de passe (passwordless) : les navigateurs ne proposent donc pas
// d'enregistrer des identifiants, seulement de mémoriser l'email (`autoComplete`).

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import type { ChatState, ChatStore } from "./store"

/** Tokens permanents du back-end en build debug (`dev_login_email` dans main.rs). */
const DEV_LOGINS = [
  { label: "Admin", token: "00000000-0000-0000-0000-000000000001" },
  { label: "Dev 2", token: "00000000-0000-0000-0000-000000000002" },
  { label: "Dev 3", token: "00000000-0000-0000-0000-000000000003" },
]

export function Login({ state, store }: { state: ChatState; store: ChatStore }) {
  const [email, setEmail] = useState("")
  const [token, setToken] = useState("")
  const busy = state.phase === "authenticating"

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Connexion</CardTitle>
          <CardDescription>
            Entre ton email pour recevoir un lien de connexion.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (email.trim()) void store.requestLink(email.trim())
            }}
          >
            <Input
              type="email"
              name="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="toi@exemple.fr"
              autoFocus
              required
            />
            <Button type="submit">Recevoir un lien</Button>
          </form>

          {state.linkSent && (
            <p className="text-sm text-muted-foreground">
              Lien émis. Ouvre-le, ou colle ci-dessous le token qu'il contient.
            </p>
          )}

          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (token.trim()) void store.login(token.trim())
            }}
          >
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="token du lien"
              name="token"
              autoComplete="one-time-code"
              spellCheck={false}
            />
            <Button type="submit" variant="outline" disabled={busy}>
              {busy ? "Connexion…" : "Se connecter avec le token"}
            </Button>
          </form>

          {state.error && <p className="text-sm text-destructive">{state.error}</p>}

          {import.meta.env.DEV && (
            <div className="flex flex-col gap-2 border-t pt-4">
              <p className="text-xs text-muted-foreground">
                Dev : connexion directe (back-end lancé en build debug)
              </p>
              <div className="flex gap-2">
                {DEV_LOGINS.map(({ label, token }) => (
                  <Button
                    key={token}
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void store.login(token)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

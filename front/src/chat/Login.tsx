// Stories 1-2 : email → lien magique. En v1 le lien n'est pas envoyé par email mais
// loggé côté serveur (CLAUDE.md § Authentification) : on accepte donc aussi le token
// collé à la main, en plus du lien `?token=` ouvert directement.

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import type { ChatState, ChatStore } from "./store"

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
              spellCheck={false}
            />
            <Button type="submit" variant="outline" disabled={busy}>
              {busy ? "Connexion…" : "Se connecter avec le token"}
            </Button>
          </form>

          {state.error && <p className="text-sm text-destructive">{state.error}</p>}
        </CardContent>
      </Card>
    </div>
  )
}

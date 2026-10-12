// Story 34 : choix du pseudo obligatoire à la première connexion, avant le chat.

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import type { ChatState, ChatStore } from "./store"

export function PseudoScreen({ state, store }: { state: ChatState; store: ChatStore }) {
  const [pseudo, setPseudo] = useState("")
  const [busy, setBusy] = useState(false)

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Choisis ton pseudo</CardTitle>
          <CardDescription>
            C'est le nom que les autres verront. Ton email reste privé. Tu pourras le changer
            plus tard.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-2"
            onSubmit={async (e) => {
              e.preventDefault()
              setBusy(true)
              await store.setPseudo(pseudo)
              setBusy(false)
            }}
          >
            <Input
              value={pseudo}
              onChange={(e) => setPseudo(e.target.value)}
              placeholder="pseudo"
              maxLength={32}
              autoFocus
              required
            />
            <Button type="submit" disabled={busy || state.phase === "offline"}>
              Continuer
            </Button>
            {state.error && <p className="text-sm text-destructive">{state.error}</p>}
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

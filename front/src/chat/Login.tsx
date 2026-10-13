// Stories 65-68 : connexion par email et mot de passe ; création du compte depuis un
// lien d'invitation (`?invite=`) ; un lien de connexion de l'admin (`?token=`) connecte
// directement (ChatStore). On ne demande plus soi-même un lien.
//
// Champs `autoComplete` (username, current-password, new-password) : les navigateurs
// et gestionnaires de mots de passe proposent d'enregistrer les identifiants.

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

/** Même borne que le serveur (`accounts::MIN_PASSWORD_CHARS`). */
const MIN_PASSWORD_CHARS = 8

function Screen({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
    </div>
  )
}

export function Login({ state, store }: { state: ChatState; store: ChatStore }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const busy = state.phase === "authenticating"

  return (
    <Screen title="Connexion" description="Connecte-toi avec ton email et ton mot de passe.">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void store.loginWithPassword(email.trim(), password)
        }}
      >
        <Input
          type="email"
          name="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="toi@exemple.fr"
          autoFocus
          required
        />
        <Input
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="mot de passe"
          required
        />
        <Button type="submit" disabled={busy}>
          {busy ? "Connexion…" : "Se connecter"}
        </Button>
      </form>
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      <p className="text-xs text-muted-foreground">
        Pas encore de compte ? Demande un lien d'invitation à l'admin. Mot de passe oublié ? L'admin peut te
        donner un lien de connexion.
      </p>

      {import.meta.env.DEV && (
        <div className="flex flex-col gap-2 border-t pt-4">
          <p className="text-xs text-muted-foreground">Dev : connexion directe (back-end lancé en build debug)</p>
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
    </Screen>
  )
}

/** Story 66 : ouverture d'un lien d'invitation — création du compte, puis connecté. */
export function InviteScreen({ state, store }: { state: ChatState; store: ChatStore }) {
  const [email, setEmail] = useState("")
  const [pseudo, setPseudo] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const busy = state.phase === "authenticating"
  const mismatch = confirm !== "" && confirm !== password

  if (state.inviteValid !== true) {
    const dead = state.inviteValid === false
    return (
      <Screen
        title={dead ? "Lien plus valable" : "Invitation"}
        description={
          dead
            ? "Ce lien d'invitation a expiré, a été révoqué ou a déjà servi. Demande un nouveau lien à l'admin."
            : "Vérification du lien…"
        }
      >
        {dead && (
          <Button variant="link" size="sm" className="self-start px-0" onClick={store.dropInvite}>
            J'ai déjà un compte
          </Button>
        )}
      </Screen>
    )
  }

  return (
    <Screen title="Bienvenue !" description="Tu as été invité : crée ton compte pour rejoindre le serveur.">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!mismatch) void store.acceptInvite(email.trim(), pseudo.trim(), password)
        }}
      >
        <Input
          type="email"
          name="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email"
          autoFocus
          required
        />
        <Input
          name="pseudo"
          autoComplete="nickname"
          value={pseudo}
          onChange={(e) => setPseudo(e.target.value)}
          placeholder="pseudo (visible des autres)"
          maxLength={32}
          required
        />
        <Input
          type="password"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={`mot de passe (${MIN_PASSWORD_CHARS} caractères min)`}
          minLength={MIN_PASSWORD_CHARS}
          required
        />
        <Input
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="confirmer le mot de passe"
          aria-invalid={mismatch}
          required
        />
        {mismatch && <p className="text-xs text-destructive">Les deux mots de passe diffèrent.</p>}
        <Button type="submit" disabled={busy || mismatch}>
          {busy ? "Création…" : "Créer mon compte"}
        </Button>
      </form>
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      <Button variant="link" size="sm" className="self-start px-0" onClick={store.dropInvite}>
        J'ai déjà un compte
      </Button>
    </Screen>
  )
}

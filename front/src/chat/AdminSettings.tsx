// Stories 65 et 68 : onglet Administration des paramètres, visible de l'admin seul —
// invitations à usage unique (durée choisie, liste, révocation) et liens de connexion
// de dépannage pour un membre.

import { useEffect, useState } from "react"
import { Copy, Link as LinkIcon, Trash2, UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { chat } from "@/proto/messages.js"
import { toNumber } from "./model"
import type { ChatState, ChatStore } from "./store"

const DURATIONS = [
  { label: "1 heure", seconds: 3600 },
  { label: "24 heures", seconds: 24 * 3600 },
  { label: "7 jours", seconds: 7 * 24 * 3600 },
  { label: "30 jours", seconds: 30 * 24 * 3600 },
]

const LOGIN_DURATIONS = [
  { label: "15 minutes", seconds: 15 * 60 },
  { label: "1 heure", seconds: 3600 },
  { label: "24 heures", seconds: 24 * 3600 },
]

const selectClass =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring dark:bg-input/30"

function inviteLink(token: string): string {
  return `${window.location.origin}/?invite=${token}`
}

function loginLink(token: string): string {
  return `${window.location.origin}/?token=${token}`
}

function expiry(ms: number | Long | null | undefined): string {
  return new Date(toNumber(ms)).toLocaleString([], { dateStyle: "short", timeStyle: "short" })
}

export function AdminSettings({ state, store }: { state: ChatState; store: ChatStore }) {
  const [invites, setInvites] = useState<chat.IInvite[]>([])
  const [inviteTtl, setInviteTtl] = useState(DURATIONS[2].seconds)
  const [created, setCreated] = useState<string | null>(null)
  const members = Object.values(state.users)
    .filter((u) => u.id !== state.me?.id && u.pseudo)
    .sort((a, b) => a.pseudo.localeCompare(b.pseudo, "fr"))
  const [member, setMember] = useState<number | null>(null)
  const [loginTtl, setLoginTtl] = useState(LOGIN_DURATIONS[0].seconds)
  const [login, setLogin] = useState<{ link: string; expires: string } | null>(null)

  const refresh = () => void store.listInvites().then(setInvites)
  useEffect(refresh, [store])

  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(() => store.flash(`${what} copié`))

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium">Inviter quelqu'un</h3>
          <p className="text-xs text-muted-foreground">
            Lien à usage unique : la personne crée son compte (email, pseudo, mot de passe) en l'ouvrant.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className={selectClass} value={inviteTtl} onChange={(e) => setInviteTtl(Number(e.target.value))}>
            {DURATIONS.map((d) => (
              <option key={d.seconds} value={d.seconds}>
                valable {d.label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            onClick={async () => {
              const invite = await store.createInvite(inviteTtl)
              if (!invite?.token) return
              setCreated(inviteLink(invite.token))
              copy(inviteLink(invite.token), "Lien d'invitation")
              refresh()
            }}
          >
            <UserPlus />
            Créer une invitation
          </Button>
        </div>
        {created && <LinkBox link={created} onCopy={() => copy(created, "Lien d'invitation")} />}

        {invites.length > 0 && (
          <div className="rounded-lg border">
            <div className="border-b px-3 py-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Invitations en cours
            </div>
            <ul className="divide-y">
              {invites.map((invite) => (
                <li key={invite.token} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <LinkIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{invite.token}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">expire le {expiry(invite.expiresAt)}</span>
                  <Button variant="ghost" size="icon-sm" title="Copier le lien" onClick={() => copy(inviteLink(invite.token!), "Lien d'invitation")}>
                    <Copy />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:text-destructive"
                    title="Révoquer"
                    onClick={async () => {
                      if (await store.revokeInvite(invite.token!)) {
                        if (created === inviteLink(invite.token!)) setCreated(null)
                        refresh()
                      }
                    }}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium">Lien de connexion pour un membre</h3>
          <p className="text-xs text-muted-foreground">
            Mot de passe oublié : ce lien à usage unique le connecte directement ; il pourra ensuite en définir un
            nouveau dans son profil.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={selectClass}
            value={member ?? ""}
            onChange={(e) => setMember(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">— membre —</option>
            {members.map((u) => (
              <option key={u.id} value={u.id}>
                {u.pseudo}
              </option>
            ))}
          </select>
          <select className={selectClass} value={loginTtl} onChange={(e) => setLoginTtl(Number(e.target.value))}>
            {LOGIN_DURATIONS.map((d) => (
              <option key={d.seconds} value={d.seconds}>
                valable {d.label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            disabled={member === null}
            onClick={async () => {
              if (member === null) return
              const created = await store.createLoginLink(member, loginTtl)
              if (!created?.token) return
              setLogin({ link: loginLink(created.token), expires: expiry(created.expiresAt) })
              copy(loginLink(created.token), "Lien de connexion")
            }}
          >
            <LinkIcon />
            Créer le lien
          </Button>
        </div>
        {login && (
          <>
            <LinkBox link={login.link} onCopy={() => copy(login.link, "Lien de connexion")} />
            <p className="text-xs text-muted-foreground">Expire le {login.expires}. À n'envoyer qu'à la personne concernée.</p>
          </>
        )}
      </section>
    </div>
  )
}

function LinkBox({ link, onCopy }: { link: string; onCopy: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2">
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{link}</span>
      <Button size="sm" variant="outline" onClick={onCopy}>
        <Copy />
        Copier
      </Button>
    </div>
  )
}

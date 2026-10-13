// Stories 65 et 68 : onglet Administration des paramètres, visible de l'admin seul —
// invitations à usage unique (durée choisie, liste, révocation) et liens de connexion
// de dépannage pour un membre, débit des vocaux (story 79).

import { useEffect, useRef, useState } from "react"
import { Copy, Link as LinkIcon, Trash2, UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { chat } from "@/proto/messages.js"
import { toNumber } from "./model"
import type { ChatState, ChatStore } from "./store"
import { DEFAULT_VOICE_BITRATE } from "./store-voice"

/** Story 79 : plage d'Opus, en kbps. */
const MIN_BITRATE = 6
const MAX_BITRATE = 510

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

      <VoiceBitrates state={state} store={store} />
    </div>
  )
}

/** Story 79 : débit par défaut des vocaux, et celui de chaque salon qui le remplace. */
function VoiceBitrates({ state, store }: { state: ChatState; store: ChatStore }) {
  const fallback = state.voiceBitrates[0] ?? DEFAULT_VOICE_BITRATE
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium">Débit audio des vocaux</h3>
        <p className="text-xs text-muted-foreground">
          De {MIN_BITRATE} à {MAX_BITRATE} kbps. Plus haut, la voix est plus nette, mais chacun envoie et reçoit
          davantage : le serveur relaie le débit de chacun vers tous les autres. 64 kbps suffit pour la voix ; au-delà
          de 128 kbps, la différence ne s'entend guère que pour de la musique.
        </p>
      </div>
      <BitrateControl
        label="Par défaut"
        value={fallback}
        onCommit={(kbps) => void store.setVoiceBitrate(0, kbps)}
      />
      {state.voiceChannels.map((c) => {
        const own = state.voiceBitrates[c.id]
        return (
          <div key={c.id} className="flex flex-col gap-1.5 border-t pt-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={own !== undefined}
                onChange={(e) => void store.setVoiceBitrate(c.id, e.target.checked ? fallback : 0)}
              />
              <span className="truncate">{c.name}</span>
              <span className="text-xs text-muted-foreground">
                {own === undefined ? `suit le défaut (${fallback} kbps)` : "débit propre"}
              </span>
            </label>
            {own !== undefined && (
              <BitrateControl label="" value={own} onCommit={(kbps) => void store.setVoiceBitrate(c.id, kbps)} />
            )}
          </div>
        )
      })}
    </section>
  )
}

/** Curseur et champ liés ; envoyé une fois la valeur immobile (pas à chaque cran). */
function BitrateControl({ label, value, onCommit }: { label: string; value: number; onCommit: (kbps: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  // Paramètres fermés avant les 500 ms : envoyé quand même.
  const pending = useRef<{ kbps: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const flush = () => {
    if (!pending.current) return
    clearTimeout(pending.current.timer)
    onCommit(pending.current.kbps)
    pending.current = null
  }
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => () => flushRef.current(), [])
  const change = (text: string) => {
    setDraft(text)
    if (pending.current) clearTimeout(pending.current.timer)
    pending.current = null
    const kbps = Number(text)
    if (!Number.isInteger(kbps) || kbps < MIN_BITRATE || kbps > MAX_BITRATE || kbps === value) return
    pending.current = { kbps, timer: setTimeout(() => flushRef.current(), 500) }
  }
  const invalid = !(Number(draft) >= MIN_BITRATE && Number(draft) <= MAX_BITRATE)
  return (
    <div className="flex items-center gap-3 text-sm">
      {label && <span className="w-20 shrink-0">{label}</span>}
      <input
        type="range"
        className="min-w-0 flex-1"
        min={MIN_BITRATE}
        max={MAX_BITRATE}
        value={invalid ? value : Number(draft)}
        onChange={(e) => change(e.target.value)}
      />
      <label className="flex shrink-0 items-center gap-1">
        <input
          type="number"
          min={MIN_BITRATE}
          max={MAX_BITRATE}
          value={draft}
          onChange={(e) => change(e.target.value)}
          onBlur={() => invalid && setDraft(String(value))}
          className={`${selectClass} w-20 tabular-nums ${invalid ? "border-destructive" : ""}`}
        />
        kbps
      </label>
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

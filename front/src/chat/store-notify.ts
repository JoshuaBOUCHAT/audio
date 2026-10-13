// Non-lus et notifications (stories 56-63) : conversation affichée, badges, règles
// par salon et par personne, son et notification système.

import { markRead, setSettings } from "@/lib/protocol"
import { mentions, plainText } from "./media"
import {
  DEFAULT_CHANNEL_RULE,
  DEFAULT_PERSON_RULE,
  fromNotifySettings,
  type ChannelRule,
  type ChatMessage,
  type NotifySettings,
  type PersonRule,
} from "./model"
import { playSound } from "./sounds"
import { ProfilesLayer } from "./store-profiles"

export abstract class NotifyLayer extends ProfilesLayer {
  /** Conversation affichée (`setActive`) : ses messages ne notifient pas, ils sont lus. */
  protected active: number | null = null

  protected lastSound = 0

  /** Clic sur une notification système : l'interface bascule sur la conversation. */
  onOpenConversation: ((channelId: number) => void) | null = null

  /** Conversation affichée, `null` si aucune. Elle est marquée lue. */
  setActive = (channelId: number | null): void => {
    this.active = channelId
    if (channelId !== null) this.markActiveRead()
  }

  /**
   * Marque lue la conversation affichée si la fenêtre est au premier plan (sinon on
   * ne l'a pas vraiment lue) : au changement de conversation, au retour sur l'onglet,
   * à l'arrivée d'un message, une fois ses messages chargés.
   */
  markActiveRead = (): void => {
    const id = this.active
    if (id === null || document.hidden || !document.hasFocus()) return
    const messages = this.state.messages[id]
    if (!messages) return
    const last = messages.at(-1)?.id ?? 0
    const current = this.state.unread[id]
    if (last === 0 || (current && current.count === 0 && current.lastReadId >= last)) return
    const lastReadId = Math.max(last, current?.lastReadId ?? 0)
    this.set({ unread: { ...this.state.unread, [id]: { count: 0, mentions: 0, lastReadId } } })
    void this.request(markRead(id, last))
  }

  /**
   * Total affiché en badge, conversations coupées exclues : les mentions de moi pour les
   * salons (story 62), tous les non-lus pour les DM.
   */
  badgeTotal = (ids: number[], kind: "mentions" | "count"): number =>
    ids.reduce((n, id) => n + (this.isMuted(id) ? 0 : (this.state.unread[id]?.[kind] ?? 0)), 0)

  /** Story 63 : salon réglé sur « rien », ou DM d'une personne dont les messages ne notifient pas. */
  isMuted = (conversationId: number): boolean => {
    const { channels, persons } = this.state.settings
    if (this.state.channels.some((c) => c.id === conversationId)) return channels[conversationId]?.level === "nothing"
    const dm = this.state.dms.find((d) => d.id === conversationId)
    return dm ? (persons[dm.otherId]?.dmMuted ?? false) : false
  }

  channelRule = (channelId: number): ChannelRule => this.state.settings.channels[channelId] ?? DEFAULT_CHANNEL_RULE

  personRule = (userId: number): PersonRule => this.state.settings.persons[userId] ?? DEFAULT_PERSON_RULE

  setChannelRule = (channelId: number, rule: ChannelRule): Promise<void> =>
    this.setNotifySettings({ ...this.state.settings, channels: { ...this.state.settings.channels, [channelId]: rule } })

  setPersonRule = (userId: number, rule: PersonRule): Promise<void> =>
    this.setNotifySettings({ ...this.state.settings, persons: { ...this.state.settings.persons, [userId]: rule } })

  setNotifySettings = async (settings: NotifySettings): Promise<void> => {
    this.set({ settings })
    await this.request(setSettings(fromNotifySettings(settings)))
  }

  /**
   * Story 63 : « Tout couper » règle chaque salon sur « rien » et chaque personne sur
   * « ne pas notifier », un par un — on peut ensuite n'en réactiver qu'un. `false`
   * retire toutes les règles.
   */
  muteAll = (muted: boolean): Promise<void> => {
    const channels: NotifySettings["channels"] = {}
    const persons: NotifySettings["persons"] = {}
    if (muted) {
      for (const { id } of this.state.channels) channels[id] = { level: "nothing", silent: false }
      for (const user of Object.values(this.state.users)) {
        if (user.id !== this.state.me?.id) {
          persons[user.id] = { dmMuted: true, dmSilent: false, mentionsMuted: true, mentionsSilent: false }
        }
      }
    }
    return this.setNotifySettings({ ...this.state.settings, channels, persons })
  }

  /** Message d'un autre reçu en direct : non-lu ou lu, son, popup système. */
  protected onIncoming(message: ChatMessage): void {
    const me = this.state.me
    if (!me || message.userId === me.id) return
    const id = message.channelId
    const looking = this.active === id && !document.hidden && document.hasFocus()
    if (looking) {
      this.markActiveRead()
      return
    }
    const mentioned = mentions(message.content, me.id)
    const current = this.state.unread[id] ?? { count: 0, mentions: 0, lastReadId: 0 }
    if (message.id > current.lastReadId) {
      const next = {
        ...current,
        count: Math.min(current.count + 1, 100),
        mentions: Math.min(current.mentions + (mentioned ? 1 : 0), 100),
      }
      this.set({ unread: { ...this.state.unread, [id]: next } })
    }
    // Story 63 : DM = réglage de la personne ; salon = niveau du salon, et pour une
    // mention, l'accord de la personne aussi.
    const person = this.personRule(message.userId)
    let notify: boolean
    let withSound: boolean
    if (this.state.dms.some((d) => d.id === id)) {
      notify = !person.dmMuted
      withSound = !person.dmSilent
    } else {
      const channel = this.channelRule(id)
      notify = channel.level !== "nothing" && (mentioned ? !person.mentionsMuted : channel.level === "all")
      withSound = !channel.silent && (!mentioned || !person.mentionsSilent)
    }
    if (!notify) return
    const { sound, desktop } = this.state.settings
    if (sound && withSound && Date.now() - this.lastSound > 1000) {
      this.lastSound = Date.now()
      playSound(sound)
    }
    if (desktop && (document.hidden || !document.hasFocus()) && "Notification" in window && Notification.permission === "granted") {
      this.desktopNotification(message)
    }
  }

  protected desktopNotification(message: ChatMessage): void {
    const author = this.state.users[message.userId]?.pseudo ?? "Quelqu'un"
    const channel = this.state.channels.find((c) => c.id === message.channelId)
    const notification = new Notification(channel ? `${author} dans #${channel.name}` : author, {
      body: plainText(message.content, (userId) => this.state.users[userId]?.pseudo ?? "quelqu'un")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200),
      tag: `conversation-${message.channelId}`,
      silent: true, // le son vient de l'app, réglable (story 57)
    })
    notification.onclick = () => {
      window.focus()
      this.onOpenConversation?.(message.channelId)
      notification.close()
    }
  }
}

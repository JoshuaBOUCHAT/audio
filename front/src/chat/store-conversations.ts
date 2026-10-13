// Salons, DM et messages (stories 7-15, 28-30, 39-40, 64) : ouverture et resync,
// pages d'historique, envoi, modification, suppression.

import { createChannel, deleteMessage, editMessage, openDm, sendMessage, syncPage } from "@/lib/protocol"
import {
  mergeMessages,
  toChannel,
  toConversation,
  toMessage,
  type ChatChannel,
  type ChatMessage,
  type Conversation,
} from "./model"
import { NotifyLayer } from "./store-notify"

/** Story 64 : messages par page d'historique. */
const PAGE_SIZE = 64

export abstract class ConversationsLayer extends NotifyLayer {
  /** Charge un salon à sa première ouverture ; ensuite les broadcasts le tiennent à jour. */
  open = (channelId: number): void => {
    if (!(channelId in this.state.messages)) void this.sync(channelId)
  }

  /**
   * Story 64 : dernière page de la conversation. Elle **remplace** la copie locale (à
   * la reconnexion aussi, story 15 : modifications et suppressions pendant la coupure
   * prises en compte ; on remonte à nouveau si besoin). Un broadcast reçu avant cette
   * réponse a été traité avant elle côté serveur (même file d'envoi), donc il y est
   * déjà ; ceux qui suivent se fusionnent normalement.
   */
  protected async sync(channelId: number): Promise<void> {
    const response = await this.request(syncPage(channelId, 0, PAGE_SIZE))
    const sync = response?.syncResponse
    if (!sync) return
    const synced = (sync.messages ?? []).map(toMessage)
    this.setMessages(channelId, () => synced)
    this.set({ history: { ...this.state.history, [channelId]: { hasMore: sync.hasMore ?? false, loading: false } } })
    if (channelId === this.active) this.markActiveRead()
  }

  /** Story 64 : page précédente, avant le plus ancien message chargé. */
  loadOlder = async (channelId: number): Promise<void> => {
    const history = this.state.history[channelId]
    const oldest = this.state.messages[channelId]?.[0]
    if (!history?.hasMore || history.loading || !oldest) return
    this.set({ history: { ...this.state.history, [channelId]: { ...history, loading: true } } })
    const response = await this.request(syncPage(channelId, oldest.id, PAGE_SIZE))
    const sync = response?.syncResponse
    const hasMore = sync ? (sync.hasMore ?? false) : history.hasMore
    if (sync) this.setMessages(channelId, (current) => mergeMessages(current, (sync.messages ?? []).map(toMessage)))
    this.set({ history: { ...this.state.history, [channelId]: { hasMore, loading: false } } })
  }

  /** Story 64 : remonte page par page jusqu'à `messageId` (citation d'un original ancien). */
  loadUntil = async (channelId: number, messageId: number): Promise<boolean> => {
    for (let page = 0; page < 100; page++) {
      const messages = this.state.messages[channelId]
      if (messages?.some((m) => m.id === messageId)) return true
      if (!this.state.history[channelId]?.hasMore || !messages?.length || messages[0].id < messageId) return false
      await this.loadOlder(channelId)
    }
    return false
  }

  /** `replyToId` : message cité (story 39), 0 = pas une réponse. */
  send = async (channelId: number, content: string, replyToId = 0): Promise<boolean> => {
    const response = await this.request(sendMessage(channelId, content, replyToId))
    const message = response?.newMessage?.message
    if (!message) return false
    this.addMessage(toMessage(message))
    this.bumpDm(toMessage(message))
    this.markActiveRead() // répondre, c'est avoir lu ce qui précède
    return true
  }

  /** Story 40. */
  edit = async (channelId: number, messageId: number, content: string): Promise<boolean> => {
    const response = await this.request(editMessage(channelId, messageId, content))
    const message = response?.messageEdited?.message
    if (!message) return false
    this.addMessage(toMessage(message))
    return true
  }

  remove = async (channelId: number, messageId: number): Promise<void> => {
    const response = await this.request(deleteMessage(channelId, messageId))
    if (response?.messageDeleted) this.markDeleted(channelId, messageId)
  }

  createChannel = async (name: string): Promise<boolean> => {
    const response = await this.request(createChannel(name))
    const channel = response?.channelCreated?.channel
    if (!channel) return false
    this.addChannel(toChannel(channel))
    return true
  }

  /**
   * Story 28 : DM avec `userId` (l'existant ou un nouveau). Rend son id, pour basculer
   * dessus ; `null` si refusé (erreur dans `error`).
   */
  openDm = async (userId: number): Promise<number | null> => {
    const response = await this.request(openDm(userId))
    const conversation = response?.dmOpened?.conversation
    if (!conversation || !this.state.me) return null
    const dm = toConversation(conversation, this.state.me.id)
    this.upsertDm(dm)
    return dm.id
  }

  protected upsertDm(dm: Conversation): void {
    const others = this.state.dms.filter((d) => d.id !== dm.id)
    this.set({ dms: [...others, dm] })
  }

  /** Story 30 : un message dans un DM le remonte, qu'il soit chargé ou non. */
  protected bumpDm(message: ChatMessage): void {
    const dm = this.state.dms.find((d) => d.id === message.channelId)
    if (dm && message.id > dm.lastMessageId) this.upsertDm({ ...dm, lastMessageId: message.id })
  }

  protected setMessages(channelId: number, update: (current: ChatMessage[]) => ChatMessage[]): void {
    const current = this.state.messages[channelId] ?? []
    this.set({ messages: { ...this.state.messages, [channelId]: update(current) } })
  }

  /** Un salon jamais ouvert n'est pas tenu en mémoire : sa sync le chargera en entier. */
  protected addMessage(message: ChatMessage): void {
    if (!(message.channelId in this.state.messages)) return
    this.setMessages(message.channelId, (current) => mergeMessages(current, [message]))
  }

  protected markDeleted(channelId: number, messageId: number): void {
    if (!(channelId in this.state.messages)) return
    this.setMessages(channelId, (current) =>
      current.map((m) => (m.id === messageId ? { ...m, deleted: true, content: "" } : m)),
    )
  }

  protected addChannel(channel: ChatChannel): void {
    if (this.state.channels.some((c) => c.id === channel.id)) return
    this.set({ channels: [...this.state.channels, channel].sort((a, b) => a.id - b.id) })
  }
}

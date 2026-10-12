// Types d'affichage du client, convertis depuis les messages protobuf décodés : les
// uint64 arrivent en `Long` (le paquet `long` est installé) et deviennent des number
// — sans perte, les ids serveur tiennent sur 36 bits (back-end/src/keys.rs).

import type Long from "long"
import { chat } from "@/proto/messages.js"

export type Me = {
  id: number
  email: string
  isAdmin: boolean
  pseudo: string
  avatarVersion: number
  /** Story 41 : statut choisi, mémorisé avec le compte. */
  invisible: boolean
  /** Story 43 : description, vide = aucune. */
  bio: string
}
/** Profil public (story 36) : jamais l'email. `avatarVersion` 0 = pas de photo. */
export type Profile = { id: number; pseudo: string; avatarVersion: number; bio: string }
export type ChatChannel = { id: number; name: string }
/** Conversation privée (stories 28-30), vue depuis `me`. */
export type Conversation = { id: number; otherId: number; lastMessageId: number }
export type ChatMessage = {
  id: number
  channelId: number
  userId: number
  content: string
  timestamp: number
  deleted: boolean
  /** Story 39 : message cité, 0 = pas une réponse. */
  replyToId: number
  /** Story 40 : ms epoch de la dernière modification, 0 = jamais. */
  editedAt: number
}

/** Couleur stable par utilisateur : fond de l'initiale, bandeau de la carte de profil. */
export function userColor(userId: number): string {
  return `hsl(${(userId * 67) % 360} 45% 45%)`
}

export function toNumber(value: number | Long | null | undefined): number {
  if (value == null) return 0
  return typeof value === "number" ? value : value.toNumber()
}

export function toMe(user: chat.IUser | null | undefined): Me {
  return {
    id: toNumber(user?.id),
    email: user?.email ?? "",
    isAdmin: user?.isAdmin ?? false,
    pseudo: user?.pseudo ?? "",
    avatarVersion: toNumber(user?.avatarVersion),
    invisible: user?.status === chat.Status.INVISIBLE,
    bio: user?.bio ?? "",
  }
}

export function toProfile(profile: chat.IUserProfile): Profile {
  return {
    id: toNumber(profile.id),
    pseudo: profile.pseudo ?? "",
    avatarVersion: toNumber(profile.avatarVersion),
    bio: profile.bio ?? "",
  }
}

/** Seuls les salons texte sont affichés : DM et vocal n'existent pas encore côté v1. */
export function isTextChannel(channel: chat.IChannel): boolean {
  return (channel.type ?? chat.Channel.Type.TEXT) === chat.Channel.Type.TEXT
}

export function toChannel(channel: chat.IChannel): ChatChannel {
  return { id: toNumber(channel.id), name: channel.name ?? "" }
}

export function toConversation(conversation: chat.IConversation, meId: number): Conversation {
  const ids = (conversation.channel?.participantIds ?? []).map(toNumber)
  return {
    id: toNumber(conversation.channel?.id),
    otherId: ids.find((id) => id !== meId) ?? 0,
    lastMessageId: toNumber(conversation.lastMessageId),
  }
}

/**
 * Story 30 : dernière activité d'abord. Les ids viennent du compteur global, donc le
 * plus grand de (dernier message, création du DM) date la conversation.
 */
export function byLastActivity(a: Conversation, b: Conversation): number {
  return Math.max(b.lastMessageId, b.id) - Math.max(a.lastMessageId, a.id)
}

export function toMessage(message: chat.IMessage): ChatMessage {
  return {
    id: toNumber(message.id),
    channelId: toNumber(message.channelId),
    userId: toNumber(message.userId),
    content: message.content ?? "",
    timestamp: toNumber(message.timestamp),
    deleted: message.deleted ?? false,
    replyToId: toNumber(message.replyToId),
    editedAt: toNumber(message.editedAt),
  }
}

/**
 * Fusionne des messages dans une liste triée par id : un id déjà présent est remplacé
 * (tombstone qui arrive par sync), les ids sont uniques et croissants (compteur global
 * serveur), donc l'ordre par id est l'ordre d'envoi.
 */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return current
  const byId = new Map(current.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

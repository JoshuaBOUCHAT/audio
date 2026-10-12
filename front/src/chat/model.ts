// Types d'affichage du client, convertis depuis les messages protobuf décodés : les
// uint64 arrivent en `Long` (le paquet `long` est installé) et deviennent des number
// — sans perte, les ids serveur tiennent sur 36 bits (back-end/src/keys.rs).

import type Long from "long"
import { chat } from "@/proto/messages.js"

export type Me = { id: number; email: string; isAdmin: boolean }
export type ChatChannel = { id: number; name: string }
export type ChatMessage = {
  id: number
  channelId: number
  userId: number
  content: string
  timestamp: number
  deleted: boolean
}

export function toNumber(value: number | Long | null | undefined): number {
  if (value == null) return 0
  return typeof value === "number" ? value : value.toNumber()
}

export function toMe(user: chat.IUser | null | undefined): Me {
  return { id: toNumber(user?.id), email: user?.email ?? "", isAdmin: user?.isAdmin ?? false }
}

/** Seuls les salons texte sont affichés : DM et vocal n'existent pas encore côté v1. */
export function isTextChannel(channel: chat.IChannel): boolean {
  return (channel.type ?? chat.Channel.Type.TEXT) === chat.Channel.Type.TEXT
}

export function toChannel(channel: chat.IChannel): ChatChannel {
  return { id: toNumber(channel.id), name: channel.name ?? "" }
}

export function toMessage(message: chat.IMessage): ChatMessage {
  return {
    id: toNumber(message.id),
    channelId: toNumber(message.channelId),
    userId: toNumber(message.userId),
    content: message.content ?? "",
    timestamp: toNumber(message.timestamp),
    deleted: message.deleted ?? false,
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

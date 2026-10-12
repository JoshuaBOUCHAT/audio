// Intégration protobuf côté client — encode/decode et corrélation requête/réponse,
// indépendants de tout code de test. Générés depuis proto/messages.proto (voir
// `npm run proto:gen`), jamais édités à la main : @/proto/messages.

import { chat } from "../proto/messages.js";

export type ClientEnvelopeShape = chat.ClientEnvelope.$Shape;
export type ServerEnvelope = chat.ServerEnvelope & chat.ServerEnvelope.$Shape;

// protobufjs alloue toujours un ArrayBuffer ordinaire (jamais SharedArrayBuffer) ;
// le cast est ce que WebSocket.send du DOM exige depuis TS 5.7.
export function encodeClientEnvelope(payload: ClientEnvelopeShape): Uint8Array<ArrayBuffer> {
  return chat.ClientEnvelope.encode(chat.ClientEnvelope.create(payload)).finish() as Uint8Array<ArrayBuffer>;
}

export function decodeServerEnvelope(bytes: Uint8Array): ServerEnvelope {
  return chat.ServerEnvelope.decode(bytes);
}

export function requestMagicLink(email: string): ClientEnvelopeShape {
  return { payload: "requestMagicLink", requestMagicLink: { email } };
}

export function authRequest(token: string): ClientEnvelopeShape {
  return { payload: "auth", auth: { token } };
}

export function createChannel(name: string): ClientEnvelopeShape {
  return { payload: "createChannel", createChannel: { name } };
}

/** `replyToId` : message cité (story 39), 0 = pas une réponse. */
export function sendMessage(channelId: number, content: string, replyToId = 0): ClientEnvelopeShape {
  return { payload: "sendMessage", sendMessage: { channelId, content, replyToId } };
}

export function editMessage(channelId: number, messageId: number, content: string): ClientEnvelopeShape {
  return { payload: "editMessage", editMessage: { channelId, messageId, content } };
}

/** Story 64 : les `limit` messages précédant `beforeId` (0 = les plus récents). */
export function syncPage(channelId: number, beforeId: number, limit: number): ClientEnvelopeShape {
  return { payload: "sync", sync: { channelId, beforeId, limit } };
}

/** `lastSeenId = 0` : resync complète du salon, à utiliser à la reconnexion (story 15). */
export function syncRequest(channelId: number, lastSeenId: number): ClientEnvelopeShape {
  return { payload: "sync", sync: { channelId, lastSeenId } };
}

/** Story 28 : DM avec `userId`, l'existant ou un nouveau. */
export function openDm(userId: number): ClientEnvelopeShape {
  return { payload: "openDm", openDm: { userId } };
}

/** Story 67. */
export function passwordLogin(email: string, password: string): ClientEnvelopeShape {
  return { payload: "passwordLogin", passwordLogin: { email, password } };
}

/** Story 66 : création du compte depuis un lien d'invitation. */
export function acceptInvite(token: string, email: string, pseudo: string, password: string): ClientEnvelopeShape {
  return { payload: "acceptInvite", acceptInvite: { token, email, pseudo, password } };
}

/** Story 67 : `current` vide si le compte n'a pas encore de mot de passe. */
export function setPassword(current: string, password: string): ClientEnvelopeShape {
  return { payload: "setPassword", setPassword: { current, password } };
}

/** Stories 65, 68 (admin). */
export function createInvite(ttlSeconds: number): ClientEnvelopeShape {
  return { payload: "createInvite", createInvite: { ttlSeconds } };
}

export function listInvites(): ClientEnvelopeShape {
  return { payload: "listInvites", listInvites: {} };
}

export function revokeInvite(token: string): ClientEnvelopeShape {
  return { payload: "revokeInvite", revokeInvite: { token } };
}

export function createLoginLink(userId: number, ttlSeconds: number): ClientEnvelopeShape {
  return { payload: "createLoginLink", createLoginLink: { userId, ttlSeconds } };
}

/** Story 69 : « tu es là ? ». */
export function heartbeat(): ClientEnvelopeShape {
  return { payload: "heartbeat", heartbeat: {} };
}

/** Story 56 : tout jusqu'à `messageId` compris est lu. */
export function markRead(channelId: number, messageId: number): ClientEnvelopeShape {
  return { payload: "markRead", markRead: { channelId, messageId } };
}

/** Stories 57-60 : remplace tous mes réglages de notification. */
export function setSettings(settings: chat.Settings.$Properties): ClientEnvelopeShape {
  return { payload: "setSettings", setSettings: { settings } };
}

/** Story 55 : thème mémorisé avec le compte. */
export function setTheme(theme: chat.Theme): ClientEnvelopeShape {
  return { payload: "setTheme", setTheme: { theme } };
}

/** Story 41 : En ligne ou Invisible (mémorisé avec le compte). */
export function setStatus(status: chat.Status): ClientEnvelopeShape {
  return { payload: "setStatus", setStatus: { status } };
}

/** Story 50 : supprimer une image pour tout le monde (celui qui l'a envoyée). */
export function deleteMedia(mediaId: string): ClientEnvelopeShape {
  return { payload: "deleteMedia", deleteMedia: { mediaId } };
}

/** Story 51 : métadonnées de médias, sans les télécharger. */
export function getMedia(mediaIds: string[]): ClientEnvelopeShape {
  return { payload: "getMedia", getMedia: { mediaIds } };
}

/**
 * Story 53 : ticket de téléchargement natif (60 s). Story 54 : `inline` = ticket de
 * lecture (vidéo servie en ligne, par plages), 1 h prolongée à chaque requête.
 */
export function requestDownload(mediaId: string, inline = false): ClientEnvelopeShape {
  return { payload: "requestDownload", requestDownload: { mediaId, inline } };
}

/** Story 43 : vide = retirer la description. */
export function setBio(bio: string): ClientEnvelopeShape {
  return { payload: "setBio", setBio: { bio } };
}

export function setPseudo(pseudo: string): ClientEnvelopeShape {
  return { payload: "setPseudo", setPseudo: { pseudo } };
}

/** `image` vide : retirer la photo (story 37). */
export function setAvatar(image: Uint8Array): ClientEnvelopeShape {
  return { payload: "setAvatar", setAvatar: { image } };
}

export function getAvatar(userId: number): ClientEnvelopeShape {
  return { payload: "getAvatar", getAvatar: { userId } };
}

export function deleteMessage(channelId: number, messageId: number): ClientEnvelopeShape {
  return { payload: "deleteMessage", deleteMessage: { channelId, messageId } };
}

/**
 * Sous-ensemble de l'API WebSocket dont ProtocolClient a besoin — le DOM (navigateur)
 * et le paquet npm `ws` (Node) l'implémentent tous les deux, ce qui permet au même
 * client de tourner côté front et côté script de test sans branche spécifique.
 */
export interface WebSocketLike {
  binaryType: string;
  send(data: Uint8Array<ArrayBuffer>): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

/**
 * Corrèle chaque ClientEnvelope envoyé à sa réponse via `request_id` : une requête,
 * une Promise résolue par le ServerEnvelope portant le même id. Les messages non
 * sollicités (broadcast, `request_id` vide — ex. ChannelCreated d'un autre client)
 * vont au listener enregistré par `onEvent`.
 */
export class ProtocolClient {
  private readonly socket: WebSocketLike;
  private readonly pending = new Map<
    string,
    { resolve: (envelope: ServerEnvelope) => void; reject: (reason: Error) => void }
  >();
  private eventListener: ((envelope: ServerEnvelope) => void) | null = null;

  constructor(socket: WebSocketLike) {
    this.socket = socket;
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("message", (event) => this.onMessage(event));
  }

  request(payload: ClientEnvelopeShape): Promise<ServerEnvelope> {
    const requestId = payload.requestId ?? crypto.randomUUID();
    const bytes = encodeClientEnvelope({ ...payload, requestId });
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.socket.send(bytes);
    });
  }

  /**
   * Rejette toutes les requêtes en attente. À appeler quand le socket se ferme : leurs
   * réponses n'arriveront jamais (l'auth et l'état serveur sont liés à la connexion).
   */
  failPending(reason: Error): void {
    for (const { reject } of this.pending.values()) reject(reason);
    this.pending.clear();
  }

  onEvent(listener: (envelope: ServerEnvelope) => void): void {
    this.eventListener = listener;
  }

  private onMessage(event: { data: unknown }): void {
    const envelope = decodeServerEnvelope(new Uint8Array(event.data as ArrayBuffer));
    if (!envelope.requestId) {
      this.eventListener?.(envelope);
      return;
    }
    const pending = this.pending.get(envelope.requestId);
    if (!pending) return;
    this.pending.delete(envelope.requestId);
    pending.resolve(envelope);
  }
}

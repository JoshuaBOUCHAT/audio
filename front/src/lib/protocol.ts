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

export function sendMessage(channelId: number, content: string): ClientEnvelopeShape {
  return { payload: "sendMessage", sendMessage: { channelId, content } };
}

/** `lastSeenId = 0` : resync complète du salon, à utiliser à la reconnexion (story 15). */
export function syncRequest(channelId: number, lastSeenId: number): ClientEnvelopeShape {
  return { payload: "sync", sync: { channelId, lastSeenId } };
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

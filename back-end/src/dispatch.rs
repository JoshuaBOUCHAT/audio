//! Aiguillage de chaque `ClientEnvelope` vers son traitement, et contrôles d'accès
//! communs (connecté, admin).

use oxidart::OxidArt;

use crate::auth::{accept_invite, handle_auth, password_login, set_password};
use crate::channels::{create_channel, is_voice_channel, open_dm, set_voice_bitrate};
use crate::connection::{event, notify, server_frame};
use crate::media::get_media_info;
use crate::messages::{delete_message, edit_message, load_conversation, send_message, sync_messages};
use crate::registry::{self, ConnId};
use crate::users::{
    get_avatar, load_user, require_pseudo, set_avatar, set_bio, set_pseudo, set_status, set_theme, set_voice_volume,
    user_updated,
};
use crate::{AppState, accounts, keys, media, presence, proto, reads, validate, voice};

pub async fn handle_client_envelope(
    envelope: proto::ClientEnvelope,
    state: &AppState,
    conn: ConnId,
    user_id: &mut Option<u64>,
) -> Option<proto::ServerEnvelope> {
    use proto::client_envelope::Payload;

    let payload = match envelope.payload {
        // Stories 65-68 : on ne demande plus soi-même un lien ; seul l'admin en crée.
        Some(Payload::RequestMagicLink(_)) => proto::server_envelope::Payload::Error(proto::Error {
            code: 403,
            message: "les liens de connexion sont créés par l'admin".to_string(),
        }),
        Some(Payload::Auth(req)) => {
            let result = validate::validate_auth_request(req).and_then(|valid| handle_auth(valid.token, state, user_id));
            authenticated(state, conn, result)
        }
        Some(Payload::PasswordLogin(req)) => authenticated(state, conn, password_login(req, state, user_id).await),
        Some(Payload::AcceptInvite(req)) => authenticated(state, conn, accept_invite(req, state, user_id).await),
        Some(Payload::SetPassword(req)) => match set_password(req, state, *user_id).await {
            Ok(()) => proto::server_envelope::Payload::PasswordSet(proto::PasswordSet {}),
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::CreateInvite(req)) => {
            let created = (|| {
                let mut art = state.art.borrow_mut();
                require_admin(&mut art, *user_id)?;
                let ttl = accounts::link_ttl(req.ttl_seconds)?;
                state.dirty.set(true);
                Ok(accounts::create_invite(&mut art, ttl))
            })();
            match created {
                Ok(invite) => proto::server_envelope::Payload::InviteCreated(proto::InviteCreated { invite: Some(invite) }),
                Err(err) => proto::server_envelope::Payload::Error(err),
            }
        }
        Some(Payload::ListInvites(_)) => {
            let listed = (|| {
                let mut art = state.art.borrow_mut();
                require_admin(&mut art, *user_id)?;
                Ok(accounts::list_invites(&art))
            })();
            match listed {
                Ok(invites) => proto::server_envelope::Payload::Invites(proto::Invites { invites }),
                Err(err) => proto::server_envelope::Payload::Error(err),
            }
        }
        Some(Payload::CheckInvite(req)) => match accounts::invite_expiry(&mut state.art.borrow_mut(), &req.token) {
            Some(expires_at) => proto::server_envelope::Payload::InviteChecked(proto::InviteChecked { expires_at }),
            None => proto::server_envelope::Payload::Error(proto::Error {
                code: 404,
                message: "invitation invalide, expirée ou déjà utilisée".to_string(),
            }),
        },
        Some(Payload::RevokeInvite(req)) => {
            let revoked = (|| {
                let mut art = state.art.borrow_mut();
                require_admin(&mut art, *user_id)?;
                if !accounts::take_invite(&mut art, &req.token) {
                    return Err(proto::Error {
                        code: 404,
                        message: "invitation inconnue ou déjà utilisée".to_string(),
                    });
                }
                state.dirty.set(true);
                Ok(())
            })();
            match revoked {
                Ok(()) => proto::server_envelope::Payload::InviteRevoked(proto::InviteRevoked { token: req.token }),
                Err(err) => proto::server_envelope::Payload::Error(err),
            }
        }
        Some(Payload::CreateLoginLink(req)) => {
            let created = (|| {
                let mut art = state.art.borrow_mut();
                require_admin(&mut art, *user_id)?;
                let ttl = accounts::link_ttl(req.ttl_seconds)?;
                if !keys::is_sortable(req.user_id) || art.get(format!("user:{}", req.user_id).as_bytes()).is_none() {
                    return Err(proto::Error {
                        code: 404,
                        message: "membre inconnu".to_string(),
                    });
                }
                let email = load_user(&mut art, req.user_id).email;
                state.dirty.set(true);
                Ok(accounts::create_login_link(&mut art, &email, ttl))
            })();
            match created {
                Ok(link) => proto::server_envelope::Payload::LoginLinkCreated(link),
                Err(err) => proto::server_envelope::Payload::Error(err),
            }
        }
        Some(Payload::CreateChannel(req)) => match create_channel(req, state, *user_id) {
            Ok(channel) => {
                let created = proto::server_envelope::Payload::ChannelCreated(
                    proto::ChannelCreated {
                        channel: Some(channel),
                    },
                );
                // Les autres clients authentifiés l'apprennent par broadcast
                // (request_id vide) ; l'émetteur, par sa réponse ci-dessous.
                let event = proto::ServerEnvelope {
                    request_id: String::new(),
                    payload: Some(created.clone()),
                };
                registry::broadcast(&state.registry, conn, &server_frame(&event));
                created
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::SendMessage(req)) => match send_message(req, state, *user_id) {
            Ok(sent) => {
                // Story 28 : premier message d'un DM, l'autre découvre la conversation
                // juste avant le message (même file d'envoi, donc dans cet ordre).
                if let Some((other, conversation)) = sent.dm_revealed {
                    let opened = event(proto::server_envelope::Payload::DmOpened(
                        proto::DmOpened {
                            conversation: Some(conversation),
                        },
                    ));
                    registry::send_to_users(&state.registry, &[other], None, &opened);
                }
                let new_message = proto::server_envelope::Payload::NewMessage(
                    proto::NewMessage {
                        message: Some(sent.message),
                    },
                );
                // Story 11 : broadcast global pour un salon (pas d'abonnement), story 29 :
                // aux seuls participants pour un DM ; l'émetteur le reçoit en réponse.
                notify(state, conn, &sent.audience, &new_message);
                new_message
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::Sync(req)) => match sync_messages(req, state, *user_id) {
            Ok(response) => proto::server_envelope::Payload::SyncResponse(response),
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::DeleteMessage(req)) => match delete_message(req, state, *user_id) {
            Ok((deleted, audience)) => {
                let deleted = proto::server_envelope::Payload::MessageDeleted(deleted);
                notify(state, conn, &audience, &deleted);
                deleted
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::EditMessage(req)) => match edit_message(req, state, *user_id) {
            Ok((message, audience)) => {
                let edited = proto::server_envelope::Payload::MessageEdited(
                    proto::MessageEdited {
                        message: Some(message),
                    },
                );
                notify(state, conn, &audience, &edited);
                edited
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::OpenDm(req)) => match open_dm(req, state, *user_id) {
            Ok(conversation) => {
                let opened = proto::server_envelope::Payload::DmOpened(proto::DmOpened {
                    conversation: Some(conversation),
                });
                // Mes autres onglets/appareils l'ont aussi ; l'autre participant
                // seulement au premier message (story 28).
                let me = user_id.expect("open_dm exige l'auth");
                registry::send_to_users(&state.registry, &[me], Some(conn), &event(opened.clone()));
                opened
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::SetStatus(req)) => match set_status(req, state, *user_id) {
            Ok(status) => {
                presence::status_changed(
                    &state.presence,
                    &state.registry,
                    user_id.expect("set_status exige l'auth"),
                    status == proto::Status::Invisible,
                );
                proto::server_envelope::Payload::StatusSet(proto::StatusSet {
                    status: status as i32,
                })
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::SetTheme(req)) => match set_theme(req, state, *user_id) {
            Ok(theme) => {
                let set = proto::server_envelope::Payload::ThemeSet(proto::ThemeSet { theme: theme as i32 });
                // Story 55 : mes autres onglets/appareils basculent aussi, personne d'autre.
                let me = user_id.expect("set_theme exige l'auth");
                registry::send_to_users(&state.registry, &[me], Some(conn), &event(set.clone()));
                set
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::MarkRead(req)) => {
            let marked = require_auth(*user_id).and_then(|me| {
                let mut art = state.art.borrow_mut();
                load_conversation(&mut art, req.channel_id, me)?;
                let last = reads::mark_read(&mut art, me, req.channel_id, req.message_id.min(keys::MAX_ID));
                state.dirty.set(true);
                Ok((me, last))
            });
            match marked {
                Ok((me, last_read_id)) => {
                    let marked = proto::server_envelope::Payload::ReadMarked(proto::ReadMarked {
                        channel_id: req.channel_id,
                        last_read_id,
                    });
                    // Story 56 : mes autres appareils effacent aussi le badge.
                    registry::send_to_users(&state.registry, &[me], Some(conn), &event(marked.clone()));
                    marked
                }
                Err(err) => proto::server_envelope::Payload::Error(err),
            }
        }
        Some(Payload::SetSettings(req)) => {
            let saved = require_auth(*user_id).and_then(|me| {
                let settings = req.settings.unwrap_or_default();
                let saved = reads::set_settings(&mut state.art.borrow_mut(), me, settings)?;
                state.dirty.set(true);
                Ok((me, saved))
            });
            match saved {
                Ok((me, settings)) => {
                    let set = proto::server_envelope::Payload::SettingsSet(proto::SettingsSet {
                        settings: Some(settings),
                    });
                    registry::send_to_users(&state.registry, &[me], Some(conn), &event(set.clone()));
                    set
                }
                Err(err) => proto::server_envelope::Payload::Error(err),
            }
        }
        Some(Payload::Heartbeat(_)) => proto::server_envelope::Payload::HeartbeatAck(proto::HeartbeatAck {}),
        Some(Payload::SetPseudo(req)) => match set_pseudo(req, state, *user_id) {
            Ok(profile) => user_updated(state, conn, profile),
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::DeleteMedia(req)) => {
            let deleted = require_auth(*user_id).and_then(|me| {
                media::delete(&mut state.art.borrow_mut(), &state.media, &req.media_id, me)
            });
            match deleted {
                Ok(()) => {
                    state.dirty.set(true);
                    let deleted = proto::server_envelope::Payload::MediaDeleted(proto::MediaDeleted {
                        media_id: req.media_id,
                    });
                    // Story 50 : partout où le lien apparaît, « image supprimée ».
                    registry::broadcast(&state.registry, conn, &event(deleted.clone()));
                    deleted
                }
                Err(err) => proto::server_envelope::Payload::Error(err),
            }
        }
        Some(Payload::GetMedia(req)) => match get_media_info(req, state, *user_id) {
            Ok(info) => proto::server_envelope::Payload::MediaInfo(info),
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::RequestDownload(req)) => {
            let ticket = require_auth(*user_id).and_then(|_| {
                let mut art = state.art.borrow_mut();
                if !media::is_media_id(&req.media_id) || media::load(&mut art, &req.media_id).is_none() {
                    return Err(media::not_found());
                }
                let kind = if req.inline { media::Ticket::Stream } else { media::Ticket::Download };
                Ok(media::create_ticket(&mut art, &req.media_id, kind))
            });
            match ticket {
                Ok(ticket) => proto::server_envelope::Payload::DownloadTicket(proto::DownloadTicket {
                    media_id: req.media_id,
                    ticket,
                }),
                Err(err) => proto::server_envelope::Payload::Error(err),
            }
        }
        Some(Payload::SetBio(req)) => match set_bio(req, state, *user_id) {
            Ok(profile) => user_updated(state, conn, profile),
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::SetAvatar(req)) => match set_avatar(req, state, *user_id) {
            Ok(profile) => user_updated(state, conn, profile),
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::GetAvatar(req)) => match get_avatar(req, state, *user_id) {
            Ok(avatar) => proto::server_envelope::Payload::Avatar(avatar),
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::JoinVoice(req)) => match join_voice(req, state, conn, *user_id).await {
            Ok(joined) => proto::server_envelope::Payload::VoiceJoined(joined),
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::LeaveVoice(_)) => match require_auth(*user_id) {
            Ok(_) => {
                state.voice.borrow_mut().leave(conn);
                proto::server_envelope::Payload::VoiceLeft(proto::VoiceLeft {})
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::SetVoiceState(req)) => {
            let set = require_auth(*user_id).and_then(|_| state.voice.borrow_mut().set_state(conn, req.muted, req.deafened));
            match set {
                Ok(()) => proto::server_envelope::Payload::VoiceStateSet(proto::VoiceStateSet {}),
                Err(err) => proto::server_envelope::Payload::Error(err),
            }
        }
        Some(Payload::SetVoiceVolume(req)) => match set_voice_volume(req, state, *user_id) {
            Ok(set) => {
                let set = proto::server_envelope::Payload::VoiceVolumeSet(set);
                // Story 76 : mes autres appareils suivent, personne d'autre.
                let me = user_id.expect("set_voice_volume exige l'auth");
                registry::send_to_users(&state.registry, &[me], Some(conn), &event(set.clone()));
                set
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::SetVoiceBitrate(req)) => match set_voice_bitrate(req, state, *user_id) {
            Ok(set) => {
                let set = proto::server_envelope::Payload::VoiceBitrate(set);
                registry::broadcast(&state.registry, conn, &event(set.clone()));
                set
            }
            Err(err) => proto::server_envelope::Payload::Error(err),
        },
        Some(Payload::VoiceAnswer(req)) => {
            let answered = require_auth(*user_id).and_then(|_| state.voice.borrow_mut().answer(conn, req.offer_id, &req.sdp));
            match answered {
                Ok(()) => proto::server_envelope::Payload::VoiceAnswered(proto::VoiceAnswered {}),
                Err(err) => proto::server_envelope::Payload::Error(err),
            }
        }
        _ => {
            eprintln!("[ws] type de ClientEnvelope non géré");
            return None;
        }
    };

    Some(proto::ServerEnvelope {
        request_id: envelope.request_id,
        payload: Some(payload),
    })
}

/// Fin commune de toutes les portes d'entrée (lien, session, mot de passe,
/// invitation) : la connexion rejoint les broadcasts et la présence.
pub fn authenticated(
    state: &AppState,
    conn: ConnId,
    result: Result<proto::AuthResponse, proto::Error>,
) -> proto::server_envelope::Payload {
    match result {
        Ok(mut response) => {
            let me = response.me.as_ref().expect("AuthResponse.me toujours rempli");
            state.registry.borrow_mut().mark_authenticated(conn, me.id);
            presence::connected(
                &state.presence,
                &state.registry,
                conn,
                me.id,
                me.status() == proto::Status::Invisible,
            );
            response.online_user_ids = state.presence.borrow().online_ids();
            response.voice = state.voice.borrow().snapshot();
            proto::server_envelope::Payload::AuthResponse(response)
        }
        Err(err) => proto::server_envelope::Payload::Error(err),
    }
}

/// Story 18 : entrée dans le vocal d'un salon VOICE (pseudo requis, comme pour écrire).
async fn join_voice(
    req: proto::JoinVoice,
    state: &AppState,
    conn: ConnId,
    user_id: Option<u64>,
) -> Result<proto::VoiceJoined, proto::Error> {
    let user_id = require_auth(user_id)?;
    {
        let mut art = state.art.borrow_mut();
        require_pseudo(&mut art, user_id)?;
        if !is_voice_channel(&mut art, req.channel_id) {
            return Err(proto::Error {
                code: 404,
                message: "salon vocal inconnu".to_string(),
            });
        }
    }
    let public_ip = voice::public_ip(&state.voice).await;
    let sdp = state.voice.borrow_mut().join(conn, user_id, &req, public_ip)?;
    Ok(proto::VoiceJoined {
        channel_id: req.channel_id,
        sdp,
    })
}

/// Stories 65, 68 : actions réservées à l'admin.
pub fn require_admin(art: &mut OxidArt, user_id: Option<u64>) -> Result<(), proto::Error> {
    let user_id = require_auth(user_id)?;
    if !load_user(art, user_id).is_admin {
        return Err(proto::Error {
            code: 403,
            message: "réservé à l'admin".to_string(),
        });
    }
    Ok(())
}

pub fn require_auth(user_id: Option<u64>) -> Result<u64, proto::Error> {
    user_id.ok_or_else(|| proto::Error {
        code: 401,
        message: "non authentifié".to_string(),
    })
}

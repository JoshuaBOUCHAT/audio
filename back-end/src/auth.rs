//! Portes d'entrée (stories 3, 6, 33, 65-68) : session, email + mot de passe, invitation,
//! lien de dépannage de l'admin, et les tokens fixes du build debug. Le stockage des
//! invitations et des mots de passe vit dans `accounts.rs`.

use oxidart::{OxidArt, Value};
use radixox_lib::shared_byte::SharedByte;
use uuid::Uuid;

use crate::channels::{list_channels, list_dms, voice_bitrates};
use crate::dispatch::require_auth;
use crate::email::Email;
use crate::users::{list_profiles, load_user, pseudo_index_key, save_user, voice_volumes};
use crate::{AppState, accounts, proto, reads, validate};

/// Nombre de tokens de connexion de dev (`dev_login_email`).
pub const DEV_LOGIN_TOKENS: u128 = 9;

/// **Build debug uniquement** (absent d'un `cargo build --release`) : tokens fixes
/// `00000000-0000-0000-0000-00000000000N`, N de 1 à 9, qui se comportent comme un lien
/// magique jamais consommé ni expiré — se connecter en dev sans aller chercher un lien
/// dans les logs. Le token 1 est le compte admin du bootstrap (s'il est fourni), les
/// autres `devN@dev.local`. En release le flow d'auth reste strict (CLAUDE.md
/// § Authentification).
#[cfg(debug_assertions)]
pub fn dev_login_email(token: Uuid, state: &AppState) -> Option<Email> {
    let n = token.as_u128();
    if !(1..=DEV_LOGIN_TOKENS).contains(&n) {
        return None;
    }
    if n == 1
        && let Some(admin) = &state.bootstrap_admin_email
    {
        return Some(admin.clone());
    }
    Some(Email::parse(&format!("dev{n}@dev.local")).expect("email de dev valide"))
}

#[cfg(not(debug_assertions))]
pub fn dev_login_email(_token: Uuid, _state: &AppState) -> Option<Email> {
    None
}

/// `token` = token de lien magique OU token de session (story 33), le serveur ne
/// distingue pas les deux formats a priori : il regarde d'abord `magic_link:{token}`
/// (et le consomme, usage unique), sinon retente sur `session:{token}` (jamais
/// consommé, story 6 — session valide indéfiniment).
///
/// Toute la suite de mutations OxidArt ci-dessous représente un état métier valide
/// une fois terminée (consommation du lien + résolution/création de l'utilisateur +
/// émission de session) — appliquée en un seul emprunt `borrow_mut()`, donc atomique
/// vis-à-vis des autres tâches monoio (cf. CLAUDE.md § OxidArt).
pub fn handle_auth(
    token: Uuid,
    state: &AppState,
    user_id_slot: &mut Option<u64>,
) -> Result<proto::AuthResponse, proto::Error> {
    let mut art = state.art.borrow_mut();

    let invalid_token = || proto::Error {
        code: 401,
        message: "token invalide ou expiré".to_string(),
    };

    let magic_link_key = format!("magic_link:{token}");
    let login_email = match art.get(magic_link_key.as_bytes()) {
        Some(email_val) => {
            art.del(magic_link_key.as_bytes());
            let email_bytes = email_val
                .as_bytes()
                .expect("magic_link:{token} toujours stocké en Value::String");
            let email_str = email_bytes
                .as_str()
                .expect("email toujours UTF-8 (garanti par Email::parse à l'écriture)");
            Some(Email::parse(email_str).expect("email re-normalisé toujours valide"))
        }
        None => dev_login_email(token, state),
    };
    let (user, session_token) = if let Some(email) = login_email {
        let user = match find_user_by_email(&mut art, &email) {
            Some(id) => load_user(&mut art, id),
            None => create_user(&mut art, state, &email),
        };
        let session_token = new_session(&mut art, user.id);
        state.dirty.set(true);
        (user, session_token)
    } else {
        let id = session_user(&mut art, token).ok_or_else(invalid_token)?;
        (load_user(&mut art, id), token) // token de session déjà valide : pas de rotation, renvoyé tel quel
    };
    user_id_slot.replace(user.id);
    Ok(auth_response(&mut art, user, session_token))
}

pub fn find_user_by_email(art: &mut OxidArt, email: &Email) -> Option<u64> {
    let id_val = art.get(format!("email_index:{email}").as_bytes())?;
    Some(
        id_val
            .as_bytes()
            .expect("email_index:{email} toujours Value::String")
            .as_str()
            .expect("id toujours ASCII")
            .parse()
            .expect("id_counter toujours numérique"),
    )
}

/// Nouveau compte (pseudo vide : choisi ensuite, story 34) ; admin si c'est l'email
/// du bootstrap (story 3).
pub fn create_user(art: &mut OxidArt, state: &AppState, email: &Email) -> proto::User {
    let id = art
        .incr(SharedByte::from_str("id_counter"))
        .expect("id_counter jamais utilisé pour autre chose qu'un entier") as u64;
    let user = proto::User {
        id,
        email: email.to_string(),
        is_admin: state.bootstrap_admin_email.as_ref() == Some(email),
        status: proto::Status::Online as i32,
        theme: proto::Theme::System as i32,
        ..Default::default()
    };
    save_user(art, &user);
    art.set(
        SharedByte::from_str(&format!("email_index:{email}")),
        Value::String(SharedByte::from_str(&id.to_string())),
    );
    user
}

pub fn new_session(art: &mut OxidArt, user_id: u64) -> Uuid {
    let session_token = Uuid::new_v4();
    art.set(
        SharedByte::from_str(&format!("session:{session_token}")),
        Value::String(SharedByte::from_str(&user_id.to_string())),
    );
    session_token
}

/// Tout ce qu'un client reçoit en se connectant, quelle que soit la porte (lien,
/// session, mot de passe, invitation).
pub fn auth_response(art: &mut OxidArt, mut user: proto::User, session_token: Uuid) -> proto::AuthResponse {
    user.has_password = accounts::password_hash(art, user.id).is_some();
    let channels = list_channels(art);
    let users = list_profiles(art);
    let dms = list_dms(art, user.id);
    // Story 56 : non-lus de chaque conversation visible.
    let unread = channels
        .iter()
        .map(|c| c.id)
        .chain(dms.iter().filter_map(|d| d.channel.as_ref().map(|c| c.id)))
        .map(|id| reads::unread(art, user.id, id))
        .collect();
    let settings = Some(reads::settings(art, user.id));
    let voice_volumes = voice_volumes(art, user.id);
    let voice_bitrates = voice_bitrates(art);
    proto::AuthResponse {
        me: Some(user),
        channels,
        session_token: session_token.to_string(),
        users,
        online_user_ids: Vec::new(), // rempli par `authenticated`, après `presence::connected`
        dms,
        unread,
        settings,
        voice: Vec::new(), // rempli par `authenticated`, comme la présence
        voice_volumes,
        voice_bitrates,
    }
}

/// Story 67 : email + mot de passe. Même erreur pour un email inconnu et un mauvais
/// mot de passe (un hash factice est vérifié : même durée) ; 10 échecs bloquent
/// l'email 15 min.
///
/// Le hash rend la main (~200 ms en tranches) : la base n'est pas empruntée pendant.
/// L'échec est compté **avant** le hash et effacé en cas de succès — sinon des essais
/// lancés en parallèle passeraient tous `check_lockout` avant le premier échec compté.
pub async fn password_login(
    req: proto::PasswordLogin,
    state: &AppState,
    user_id_slot: &mut Option<u64>,
) -> Result<proto::AuthResponse, proto::Error> {
    let email = Email::parse(&req.email)?;
    let (id, hash) = {
        let mut art = state.art.borrow_mut();
        accounts::check_lockout(&mut art, email.as_ref())?;
        accounts::record_failure(&mut art, email.as_ref());
        let id = find_user_by_email(&mut art, &email);
        (id, id.and_then(|id| accounts::password_hash(&mut art, id)))
    };
    if !state.passwords.verify(&req.password, hash.as_deref()).await {
        return Err(proto::Error {
            code: 401,
            message: "email ou mot de passe incorrect".to_string(),
        });
    }
    let id = id.expect("mot de passe vérifié : compte existant");
    // Hash d'avant le coût 12 : refait maintenant que le mot de passe est connu.
    let rehash = match hash {
        Some(old) if accounts::needs_rehash(&old) => Some((old, state.passwords.hash(&req.password).await)),
        _ => None,
    };
    let mut art = state.art.borrow_mut();
    accounts::clear_failures(&mut art, email.as_ref());
    if let Some((old, new)) = rehash
        && accounts::password_hash(&mut art, id).as_deref() == Some(old.as_str())
    {
        accounts::store_password(&mut art, id, &new);
    }
    let user = load_user(&mut art, id);
    let session = new_session(&mut art, user.id);
    state.dirty.set(true);
    user_id_slot.replace(user.id);
    Ok(auth_response(&mut art, user, session))
}

/// Story 66 : création du compte sur invitation (email, pseudo, mot de passe), puis
/// connexion. L'invitation n'est consommée qu'une fois tout validé.
pub async fn accept_invite(
    req: proto::AcceptInvite,
    state: &AppState,
    user_id_slot: &mut Option<u64>,
) -> Result<proto::AuthResponse, proto::Error> {
    let email = Email::parse(&req.email)?;
    let pseudo = validate::validate_set_pseudo(proto::SetPseudo { pseudo: req.pseudo })?.pseudo;
    accounts::validate_password(&req.password)?;
    let hash = state.passwords.hash(&req.password).await;
    let mut art = state.art.borrow_mut();
    if !accounts::invite_exists(&mut art, &req.token) {
        return Err(proto::Error {
            code: 404,
            message: "invitation invalide, expirée ou déjà utilisée".to_string(),
        });
    }
    if find_user_by_email(&mut art, &email).is_some() {
        return Err(proto::Error {
            code: 409,
            message: "un compte existe déjà avec cet email".to_string(),
        });
    }
    if art.get(pseudo_index_key(&pseudo).as_bytes()).is_some() {
        return Err(proto::Error {
            code: 409,
            message: "pseudo déjà pris".to_string(),
        });
    }
    accounts::take_invite(&mut art, &req.token);
    let mut user = create_user(&mut art, state, &email);
    art.set(
        SharedByte::from_str(&pseudo_index_key(&pseudo)),
        Value::String(SharedByte::from_str(&user.id.to_string())),
    );
    user.pseudo = pseudo;
    save_user(&mut art, &user);
    accounts::store_password(&mut art, user.id, &hash);
    let session = new_session(&mut art, user.id);
    state.dirty.set(true);
    user_id_slot.replace(user.id);
    Ok(auth_response(&mut art, user, session))
}

/// Story 67 : définir (compte venu d'un lien) ou changer son mot de passe — l'actuel
/// est demandé s'il existe. Les hash rendent la main : si le mot de passe a changé
/// entre-temps (autre appareil), on refuse plutôt que d'écraser.
pub async fn set_password(req: proto::SetPassword, state: &AppState, user_id: Option<u64>) -> Result<(), proto::Error> {
    let user_id = require_auth(user_id)?;
    accounts::validate_password(&req.password)?;
    let current = accounts::password_hash(&mut state.art.borrow_mut(), user_id);
    if current.is_some() && !state.passwords.verify(&req.current, current.as_deref()).await {
        return Err(proto::Error {
            code: 401,
            message: "mot de passe actuel incorrect".to_string(),
        });
    }
    let hash = state.passwords.hash(&req.password).await;
    let mut art = state.art.borrow_mut();
    if accounts::password_hash(&mut art, user_id) != current {
        return Err(proto::Error {
            code: 409,
            message: "mot de passe modifié entre-temps : réessaie".to_string(),
        });
    }
    accounts::store_password(&mut art, user_id, &hash);
    state.dirty.set(true);
    Ok(())
}

/// Utilisateur d'un token de session (story 33) : WebSocket (`AuthRequest`) et HTTP
/// (`Authorization: Bearer`, images).
pub fn session_user(art: &mut OxidArt, token: Uuid) -> Option<u64> {
    let id_val = art.get(format!("session:{token}").as_bytes())?;
    Some(
        id_val
            .as_bytes()
            .expect("session:{token} toujours Value::String")
            .as_str()
            .expect("id toujours ASCII")
            .parse()
            .expect("session id toujours numérique"),
    )
}

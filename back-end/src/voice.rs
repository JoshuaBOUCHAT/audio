//! Vocal (stories 18, 21, 22, 70-71) : SFU sur un seul socket UDP. Chaque participant a
//! son `Rtc` (str0m, sans I/O) ; une seule tâche lit le socket, donne chaque datagramme
//! au `Rtc` qui le reconnaît (`accepts`), fait suivre l'audio reçu aux autres
//! participants du même salon sans le décoder, et envoie ce que les `Rtc` produisent.
//!
//! Négociation (story 18) : le navigateur fait une seule offre, avec `JoinVoice` (son
//! micro). Ensuite seul le serveur propose (`VoiceOffer`), une offre à la fois par
//! participant : un changement survenu pendant une négociation attend la réponse. La
//! piste d'un participant parti passe en `inactive` et resservira au prochain arrivant
//! (str0m ne recycle pas de lui-même les lignes qu'il a stoppées) : le SDP compte au
//! plus autant de pistes que de participants vus ensemble. Les offres partent de la
//! boucle UDP, jamais du traitement d'une requête : `VoiceJoined` (réponse) précède
//! toujours le premier `VoiceOffer`.
//!
//! Pas de trickle ICE : le serveur est en ICE-lite et apprend l'adresse du navigateur
//! par ses requêtes STUN (validé par `examples/voice_echo.rs`). État en mémoire
//! seulement : un redémarrage vide les vocaux, les clients rejoignent d'eux-mêmes.

use std::cell::RefCell;
use std::net::{IpAddr, SocketAddr};
use std::rc::Rc;
use std::time::{Duration, Instant};

use monoio::net::udp::UdpSocket;
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::format::{Codec, FormatParams};
use str0m::media::{Direction, Frequency, MediaData, MediaKind, Mid, Pt};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};

use crate::connection::event;
use crate::proto;
use crate::registry::{self, ConnId, SharedRegistry};

pub type SharedVoice = Rc<RefCell<Voice>>;

/// Délai maximal entre deux passages de la boucle sans datagramme : une offre préparée
/// par une requête (arrivée, réponse) part au plus tard après ce délai.
const IDLE_TICK: Duration = Duration::from_millis(20);
/// Plus grand datagramme lu (MTU WebRTC ~1200 octets).
const DATAGRAM_MAX: usize = 2048;

pub struct Voice {
    registry: SharedRegistry,
    /// Adresse locale des datagrammes reçus (`Receive::destination`), et premier
    /// candidat annoncé.
    local: SocketAddr,
    candidates: Vec<SocketAddr>,
    participants: Vec<Participant>,
    next_offer_id: u64,
}

struct Participant {
    conn: ConnId,
    user_id: u64,
    channel_id: u64,
    rtc: Rtc,
    /// Pistes d'envoi vers ce navigateur : une par autre participant du salon, plus
    /// les pistes libres en attente d'un arrivant.
    tracks: Vec<TrackOut>,
    /// Offre envoyée, réponse attendue.
    pending: Option<(u64, SdpPendingOffer)>,
    /// Une renégociation est à faire dès que possible.
    renegotiate: bool,
}

struct TrackOut {
    mid: Mid,
    /// Utilisateur dont la voix part sur cette piste ; `None` : piste libre (inactive).
    source: Option<u64>,
    /// Négociée avec sa source actuelle : l'audio de la source y part. Faux entre
    /// l'offre qui l'affecte et la réponse.
    live: bool,
}

impl Voice {
    /// `AUDIO_VOICE_LISTEN` : adresse UDP (défaut `0.0.0.0:8443`, en prod
    /// `0.0.0.0:443`). `AUDIO_PUBLIC_IP` : IP publique annoncée en plus de l'IP locale
    /// (serveur derrière une box : le port UDP doit y être redirigé).
    pub fn bind(registry: SharedRegistry) -> (SharedVoice, Rc<UdpSocket>) {
        let listen: SocketAddr = std::env::var("AUDIO_VOICE_LISTEN")
            .ok()
            .map(|v| v.parse().expect("AUDIO_VOICE_LISTEN : adresse ip:port"))
            .unwrap_or_else(|| "0.0.0.0:8443".parse().unwrap());
        let socket = UdpSocket::bind(listen).unwrap_or_else(|e| panic!("bind UDP {listen}: {e}"));
        let port = socket.local_addr().expect("adresse du socket UDP").port();
        // Jamais 127.0.0.1 : les navigateurs refusent les candidats loopback.
        let ip = if listen.ip().is_unspecified() { local_ip() } else { listen.ip() };
        let local = SocketAddr::new(ip, port);
        let mut candidates = vec![local];
        if let Some(public) = std::env::var("AUDIO_PUBLIC_IP").ok().filter(|v| !v.is_empty()) {
            let public: IpAddr = public.parse().expect("AUDIO_PUBLIC_IP : adresse IP");
            candidates.push(SocketAddr::new(public, port));
        }
        println!("[voice] UDP {listen}, candidats annoncés : {candidates:?}");
        (Rc::new(RefCell::new(Voice::new(registry, local, candidates))), Rc::new(socket))
    }

    fn new(registry: SharedRegistry, local: SocketAddr, candidates: Vec<SocketAddr>) -> Self {
        Voice {
            registry,
            local,
            candidates,
            participants: Vec::new(),
            next_offer_id: 1,
        }
    }

    /// Story 22 : qui est dans chaque salon vocal (salons vides absents).
    pub fn snapshot(&self) -> Vec<proto::VoiceChanged> {
        let mut channels: Vec<proto::VoiceChanged> = Vec::new();
        for p in &self.participants {
            match channels.iter_mut().find(|c| c.channel_id == p.channel_id) {
                Some(c) => c.user_ids.push(p.user_id),
                None => channels.push(proto::VoiceChanged {
                    channel_id: p.channel_id,
                    user_ids: vec![p.user_id],
                }),
            }
        }
        channels
    }

    fn members(&self, channel_id: u64) -> Vec<u64> {
        self.participants
            .iter()
            .filter(|p| p.channel_id == channel_id)
            .map(|p| p.user_id)
            .collect()
    }

    /// Story 22 : diffusé à tout le monde, même le salon devenu vide.
    fn announce(&self, channel_id: u64) {
        let payload = proto::server_envelope::Payload::VoiceChanged(proto::VoiceChanged {
            channel_id,
            user_ids: self.members(channel_id),
        });
        registry::broadcast_all(&self.registry, &event(payload));
    }

    /// Tous les participants du salon ont une piste à ajouter ou à arrêter.
    fn renegotiate_channel(&mut self, channel_id: u64) {
        for p in self.participants.iter_mut().filter(|p| p.channel_id == channel_id) {
            p.renegotiate = true;
        }
    }

    /// Story 18 : entrée dans le vocal avec l'offre du navigateur. Un utilisateur n'est
    /// que dans un vocal à la fois : son ancienne place (autre salon, autre appareil)
    /// est libérée d'abord. Les pistes vers les autres partiront dans un `VoiceOffer`.
    pub fn join(&mut self, conn: ConnId, user_id: u64, channel_id: u64, sdp: &str) -> Result<String, proto::Error> {
        let bad_offer = |e: String| proto::Error {
            code: 400,
            message: format!("offre SDP refusée : {e}"),
        };
        let offer = SdpOffer::from_sdp_string(sdp).map_err(|e| bad_offer(format!("{e:?}")))?;
        let mut rtc = self.new_rtc();
        let answer = rtc
            .sdp_api()
            .accept_offer(offer)
            .map_err(|e| bad_offer(format!("{e:?}")))?;
        if let Some(previous) = self.participants.iter().position(|p| p.user_id == user_id) {
            let previous_conn = self.participants[previous].conn;
            self.remove(previous);
            if previous_conn != conn {
                // Autre appareil : il apprend qu'il n'est plus dans le vocal.
                let left = event(proto::server_envelope::Payload::VoiceLeft(proto::VoiceLeft {}));
                registry::send(&self.registry, previous_conn, &left);
            }
        }
        self.participants.push(Participant {
            conn,
            user_id,
            channel_id,
            rtc,
            tracks: Vec::new(),
            pending: None,
            renegotiate: false,
        });
        self.renegotiate_channel(channel_id);
        self.announce(channel_id);
        println!("[voice] {user_id} rejoint le salon {channel_id}");
        Ok(answer.to_sdp_string())
    }

    /// Story 21 : départ explicite, ou connexion WebSocket fermée. `false` si cette
    /// connexion n'était pas dans un vocal.
    pub fn leave(&mut self, conn: ConnId) -> bool {
        match self.participants.iter().position(|p| p.conn == conn) {
            Some(index) => {
                self.remove(index);
                true
            }
            None => false,
        }
    }

    fn remove(&mut self, index: usize) {
        let p = self.participants.swap_remove(index);
        println!("[voice] {} quitte le salon {}", p.user_id, p.channel_id);
        self.renegotiate_channel(p.channel_id);
        self.announce(p.channel_id);
    }

    /// Story 18 : réponse du navigateur à une offre du serveur.
    pub fn answer(&mut self, conn: ConnId, offer_id: u64, sdp: &str) -> Result<(), proto::Error> {
        let p = self
            .participants
            .iter_mut()
            .find(|p| p.conn == conn)
            .ok_or_else(|| proto::Error {
                code: 409,
                message: "pas dans un vocal".to_string(),
            })?;
        // Réponse à une offre dépassée : ignorée, la suivante suivra.
        if p.pending.as_ref().map(|(id, _)| *id) != Some(offer_id) {
            return Ok(());
        }
        let (_, pending) = p.pending.take().expect("offre en attente vérifiée");
        let answer = SdpAnswer::from_sdp_string(sdp).map_err(|e| proto::Error {
            code: 400,
            message: format!("réponse SDP refusée : {e:?}"),
        })?;
        p.rtc.sdp_api().accept_answer(pending, answer).map_err(|e| proto::Error {
            code: 400,
            message: format!("réponse SDP refusée : {e:?}"),
        })?;
        for t in &mut p.tracks {
            t.live = t.source.is_some();
        }
        Ok(())
    }

    /// Opus seul (comme le défaut de str0m) plus `usedtx=1` (story 71) : le navigateur
    /// n'envoie presque rien pendant les silences.
    fn new_rtc(&self) -> Rtc {
        let mut config = Rtc::builder().set_ice_lite(true).clear_codecs();
        config.codec_config().add_config(
            Pt::from(111),
            None,
            Codec::Opus,
            Frequency::FORTY_EIGHT_KHZ,
            Some(2),
            FormatParams {
                min_p_time: Some(10),
                use_inband_fec: Some(true),
                use_dtx: Some(true),
                ..Default::default()
            },
        );
        let mut rtc = config.build(Instant::now());
        for &addr in &self.candidates {
            let candidate = Candidate::host(addr, "udp").expect("candidat UDP valide");
            rtc.add_local_candidate(candidate);
        }
        rtc
    }

    /// Prépare les offres des participants qui en attendent une et n'en ont pas déjà
    /// une en cours. Rend les enveloppes à envoyer (connexion, offre).
    fn negotiate(&mut self) -> Vec<(ConnId, proto::VoiceOffer)> {
        let mut offers = Vec::new();
        for i in 0..self.participants.len() {
            let p = &self.participants[i];
            if !p.renegotiate || p.pending.is_some() {
                continue;
            }
            let wanted: Vec<u64> = self
                .participants
                .iter()
                .filter(|o| o.channel_id == p.channel_id && o.user_id != p.user_id)
                .map(|o| o.user_id)
                .collect();
            let offer_id = self.next_offer_id;
            let p = &mut self.participants[i];
            p.renegotiate = false;
            let mut change = p.rtc.sdp_api();
            // Départs : la piste est libérée, inactive.
            for t in &mut p.tracks {
                if t.source.is_some_and(|s| !wanted.contains(&s)) {
                    change.set_direction(t.mid, Direction::Inactive);
                    t.source = None;
                    t.live = false;
                }
            }
            // Arrivées : une piste libre reprend du service, sinon une nouvelle.
            for &source in &wanted {
                if p.tracks.iter().any(|t| t.source == Some(source)) {
                    continue;
                }
                match p.tracks.iter_mut().find(|t| t.source.is_none()) {
                    Some(t) => {
                        change.set_direction(t.mid, Direction::SendOnly);
                        t.source = Some(source);
                    }
                    None => {
                        let mid = change.add_media(MediaKind::Audio, Direction::SendOnly, None, None, None);
                        p.tracks.push(TrackOut {
                            mid,
                            source: Some(source),
                            live: false,
                        });
                    }
                }
            }
            let Some((offer, pending)) = change.apply() else {
                continue;
            };
            self.next_offer_id += 1;
            p.pending = Some((offer_id, pending));
            let tracks = p
                .tracks
                .iter()
                .filter_map(|t| {
                    Some(proto::VoiceTrack {
                        mid: t.mid.to_string(),
                        user_id: t.source?,
                    })
                })
                .collect();
            offers.push((
                p.conn,
                proto::VoiceOffer {
                    offer_id,
                    sdp: offer.to_sdp_string(),
                    tracks,
                },
            ));
        }
        offers
    }

    /// Fait avancer chaque `Rtc` : délais échus, sorties, audio reçu transmis aux autres
    /// participants du salon (ce qui produit de nouvelles sorties). Rend les datagrammes
    /// à envoyer et l'instant du prochain délai.
    fn drive(&mut self, now: Instant, out: &mut Vec<(Vec<u8>, SocketAddr)>) -> Instant {
        let mut next = now + IDLE_TICK;
        let mut gone: Vec<usize> = Vec::new();
        for p in &mut self.participants {
            if p.rtc.handle_input(Input::Timeout(now)).is_err() {
                p.rtc.disconnect();
            }
        }
        loop {
            let mut media: Vec<(u64, u64, MediaData)> = Vec::new();
            for (i, p) in self.participants.iter_mut().enumerate() {
                loop {
                    match p.rtc.poll_output() {
                        Ok(Output::Timeout(t)) => {
                            next = next.min(t);
                            break;
                        }
                        Ok(Output::Transmit(t)) => out.push((t.contents.to_vec(), t.destination)),
                        Ok(Output::Event(Event::MediaData(data))) => media.push((p.channel_id, p.user_id, data)),
                        Ok(Output::Event(Event::IceConnectionStateChange(IceConnectionState::Disconnected))) => {
                            p.rtc.disconnect();
                        }
                        Ok(Output::Event(_)) => {}
                        Err(e) => {
                            eprintln!("[voice] {} : {e:?}", p.user_id);
                            p.rtc.disconnect();
                            break;
                        }
                    }
                }
                if !p.rtc.is_alive() && !gone.contains(&i) {
                    gone.push(i);
                }
            }
            if media.is_empty() {
                break;
            }
            for (channel_id, source, data) in media {
                self.forward(channel_id, source, &data);
            }
        }
        // ICE perdu (onglet fermé, réseau coupé) : comme un départ (story 21).
        gone.sort_unstable();
        for &i in gone.iter().rev() {
            let conn = self.participants[i].conn;
            self.remove(i);
            let left = event(proto::server_envelope::Payload::VoiceLeft(proto::VoiceLeft {}));
            registry::send(&self.registry, conn, &left);
        }
        next
    }

    /// Le paquet Opus de `source`, tel quel, sur la piste de `source` chez chaque autre
    /// participant du salon.
    fn forward(&mut self, channel_id: u64, source: u64, data: &MediaData) {
        for p in self.participants.iter_mut().filter(|p| p.channel_id == channel_id && p.user_id != source) {
            let Some(track) = p.tracks.iter().find(|t| t.live && t.source == Some(source)) else {
                continue;
            };
            let Some(writer) = p.rtc.writer(track.mid) else { continue };
            let Some(pt) = writer.match_params(data.params) else { continue };
            if let Err(e) = writer.write(pt, data.network_time, data.time, data.data.clone()) {
                eprintln!("[voice] envoi vers {} : {e:?}", p.user_id);
            }
        }
    }

    fn input<'a>(&self, now: Instant, source: SocketAddr, bytes: &'a [u8]) -> Option<Input<'a>> {
        let contents = bytes.try_into().ok()?;
        Some(Input::Receive(
            now,
            Receive {
                proto: Protocol::Udp,
                source,
                destination: self.local,
                contents,
            },
        ))
    }

    fn receive(&mut self, now: Instant, source: SocketAddr, bytes: &[u8]) {
        let Some(input) = self.input(now, source, bytes) else { return };
        if let Some(p) = self.participants.iter_mut().find(|p| p.rtc.accepts(&input))
            && p.rtc.handle_input(input).is_err()
        {
            p.rtc.disconnect();
        }
    }
}

/// La seule tâche qui touche au socket : lit un datagramme (ou attend le prochain délai
/// de str0m, au plus `IDLE_TICK`), puis fait avancer tout le monde et envoie.
pub async fn run(voice: SharedVoice, socket: Rc<UdpSocket>) {
    let mut buf = vec![0u8; DATAGRAM_MAX];
    let mut out: Vec<(Vec<u8>, SocketAddr)> = Vec::new();
    loop {
        let next = {
            let mut voice = voice.borrow_mut();
            let next = voice.drive(Instant::now(), &mut out);
            for (conn, offer) in voice.negotiate() {
                let payload = proto::server_envelope::Payload::VoiceOffer(offer);
                registry::send(&voice.registry, conn, &event(payload));
            }
            next
        };
        for (bytes, dest) in out.drain(..) {
            let _ = socket.send_to(bytes, dest).await;
        }
        let wait = next.saturating_duration_since(Instant::now()).min(IDLE_TICK);
        match monoio::time::timeout(wait, socket.recv_from(buf)).await {
            Ok((res, b)) => {
                buf = b;
                if let Ok((n, source)) = res {
                    voice.borrow_mut().receive(Instant::now(), source, &buf[..n]);
                }
            }
            // Délai écoulé : le tampon prêté à io_uring part avec la lecture annulée.
            Err(_) => buf = vec![0u8; DATAGRAM_MAX],
        }
    }
}

/// IP de l'interface de la route par défaut : un socket UDP « connecté » ne fait que
/// choisir sa route, aucun paquet ne part.
fn local_ip() -> IpAddr {
    let probe = std::net::UdpSocket::bind("0.0.0.0:0").expect("socket UDP");
    probe.connect("192.0.2.1:9").expect("aucune route réseau");
    probe.local_addr().expect("adresse locale").ip()
}

#[cfg(test)]
mod tests {
    use super::*;
    use str0m::media::MediaTime;

    const CHANNEL: u64 = 7;

    /// Un navigateur simulé par str0m (ICE complet, contrôlant) : il fait l'offre
    /// initiale, répond aux offres du serveur et « parle » toutes les 20 ms.
    struct Browser {
        user: u64,
        conn: ConnId,
        addr: SocketAddr,
        rtc: Rtc,
        mic: Option<Mid>,
        speaking: bool,
        last_frame: Option<Instant>,
        /// Paquets audio reçus, par piste.
        received: Vec<(Mid, usize)>,
        /// Piste → utilisateur, d'après le dernier VoiceOffer.
        tracks: Vec<proto::VoiceTrack>,
        /// Lignes `m=` du dernier VoiceOffer.
        m_lines: usize,
    }

    impl Browser {
        fn new(user: u64, now: Instant) -> Self {
            let addr: SocketAddr = format!("10.0.0.{}:5000", 10 + user).parse().unwrap();
            let mut rtc = Rtc::builder().build(now);
            rtc.add_local_candidate(Candidate::host(addr, "udp").unwrap());
            Browser {
                user,
                conn: ConnId::test(user as u32),
                addr,
                rtc,
                mic: None,
                speaking: true,
                last_frame: None,
                received: Vec::new(),
                tracks: Vec::new(),
                m_lines: 0,
            }
        }

        fn join(&mut self, voice: &mut Voice) {
            let mut api = self.rtc.sdp_api();
            let mic = api.add_media(MediaKind::Audio, Direction::SendOnly, None, None, None);
            let (offer, pending) = api.apply().unwrap();
            let answer = voice.join(self.conn, self.user, CHANNEL, &offer.to_sdp_string()).unwrap();
            self.rtc
                .sdp_api()
                .accept_answer(pending, SdpAnswer::from_sdp_string(&answer).unwrap())
                .unwrap();
            self.mic = Some(mic);
        }

        /// Paquets reçus sur la piste qui porte la voix de `user`.
        fn heard(&self, user: u64) -> usize {
            let Some(track) = self.tracks.iter().find(|t| t.user_id == user) else { return 0 };
            self.received
                .iter()
                .filter(|(mid, _)| mid.to_string() == track.mid)
                .map(|(_, n)| n)
                .sum()
        }
    }

    /// Fait tourner serveur et navigateurs `ms` millisecondes, réseau en mémoire.
    fn run_for(voice: &mut Voice, browsers: &mut [Browser], now: &mut Instant, ms: u64) {
        for _ in 0..ms / 5 {
            *now += Duration::from_millis(5);
            for b in browsers.iter_mut() {
                b.rtc.handle_input(Input::Timeout(*now)).unwrap();
                let due = b.last_frame.is_none_or(|t| *now - t >= Duration::from_millis(20));
                if b.speaking
                    && due
                    && let Some(mic) = b.mic
                    && let Some(writer) = b.rtc.writer(mic)
                {
                    let Some(pt) = writer.payload_params().next().map(|p| p.pt()) else { continue };
                    let time = MediaTime::new(now.elapsed().as_millis() as u64 * 48, Frequency::FORTY_EIGHT_KHZ);
                    let _ = writer.write(pt, *now, time, vec![0xF8, 0xFF, 0xFE]);
                    b.last_frame = Some(*now);
                }
            }
            let mut out = Vec::new();
            voice.drive(*now, &mut out);
            for (conn, offer) in voice.negotiate() {
                let b = browsers.iter_mut().find(|b| b.conn == conn).unwrap();
                let answer = b
                    .rtc
                    .sdp_api()
                    .accept_offer(SdpOffer::from_sdp_string(&offer.sdp).unwrap())
                    .unwrap();
                b.tracks = offer.tracks;
                b.m_lines = offer.sdp.lines().filter(|l| l.starts_with("m=")).count();
                voice.answer(conn, offer.offer_id, &answer.to_sdp_string()).unwrap();
            }
            for (bytes, dest) in out {
                if let Some(b) = browsers.iter_mut().find(|b| b.addr == dest) {
                    let input = Input::Receive(
                        *now,
                        Receive {
                            proto: Protocol::Udp,
                            source: voice.local,
                            destination: dest,
                            contents: bytes.as_slice().try_into().unwrap(),
                        },
                    );
                    b.rtc.handle_input(input).unwrap();
                }
            }
            for b in browsers.iter_mut() {
                loop {
                    match b.rtc.poll_output().unwrap() {
                        Output::Timeout(_) => break,
                        Output::Transmit(t) => voice.receive(*now, b.addr, &t.contents),
                        Output::Event(Event::MediaData(data)) => {
                            match b.received.iter_mut().find(|(mid, _)| *mid == data.mid) {
                                Some((_, n)) => *n += 1,
                                None => b.received.push((data.mid, 1)),
                            }
                        }
                        Output::Event(_) => {}
                    }
                }
            }
        }
    }

    fn voice() -> Voice {
        let local: SocketAddr = "10.0.0.1:8443".parse().unwrap();
        Voice::new(SharedRegistry::default(), local, vec![local])
    }

    /// Story 18 : trois personnes s'entendent ; une quatrième arrive, une part ; la
    /// piste libérée est recyclée (le SDP ne grossit pas).
    #[test]
    fn salon_vocal_a_plusieurs() {
        let mut now = Instant::now();
        let mut voice = voice();
        let mut browsers: Vec<Browser> = (1..=3).map(|u| Browser::new(u, now)).collect();
        for b in &mut browsers {
            b.join(&mut voice);
        }
        assert_eq!(voice.snapshot()[0].user_ids.len(), 3);
        run_for(&mut voice, &mut browsers, &mut now, 3000);
        for b in &browsers {
            let others: Vec<u64> = (1..=3).filter(|&u| u != b.user).collect();
            assert_eq!(b.tracks.len(), 2, "{} : une piste par autre participant", b.user);
            for u in others {
                assert!(b.heard(u) > 50, "{} entend {} : {} paquets", b.user, u, b.heard(u));
            }
        }

        // Le 2 part : plus de piste pour lui chez les autres.
        let gone = browsers.remove(1);
        assert!(voice.leave(gone.conn));
        run_for(&mut voice, &mut browsers, &mut now, 500);
        for b in &browsers {
            assert!(b.tracks.iter().all(|t| t.user_id != 2), "{} : piste du 2 retirée", b.user);
        }
        let lines_before = browsers[0].m_lines;

        // Le 4 arrive : il entend 1 et 3, eux l'entendent ; la ligne du 2 est recyclée.
        let mut fourth = Browser::new(4, now);
        fourth.join(&mut voice);
        browsers.push(fourth);
        run_for(&mut voice, &mut browsers, &mut now, 3000);
        let heard_before: Vec<usize> = browsers.iter().map(|b| b.heard(4)).collect();
        assert!(browsers[2].heard(1) > 50 && browsers[2].heard(3) > 50, "le 4 entend 1 et 3");
        assert!(heard_before[0] > 50 && heard_before[1] > 50, "1 et 3 entendent le 4");
        assert_eq!(browsers[0].m_lines, lines_before, "ligne SDP du 2 recyclée pour le 4");

        // Story 71 : le 4 se tait, plus rien n'arrive de lui.
        browsers[2].speaking = false;
        run_for(&mut voice, &mut browsers, &mut now, 200);
        let after_silence: Vec<usize> = browsers.iter().map(|b| b.heard(4)).collect();
        run_for(&mut voice, &mut browsers, &mut now, 1000);
        assert_eq!(browsers.iter().map(|b| b.heard(4)).collect::<Vec<_>>(), after_silence);
    }

    /// Story 18 : un seul vocal par utilisateur — rejoindre ailleurs libère l'ancienne place.
    #[test]
    fn un_seul_vocal_a_la_fois() {
        let now = Instant::now();
        let mut voice = voice();
        let mut a = Browser::new(1, now);
        a.join(&mut voice);
        let mut again = Browser::new(1, now);
        again.conn = ConnId::test(99);
        again.join(&mut voice);
        assert_eq!(voice.participants.len(), 1);
        assert!(voice.participants[0].conn == again.conn);
    }
}

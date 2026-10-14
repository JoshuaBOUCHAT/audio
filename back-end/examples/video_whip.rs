// Spike vidéo (stories 19-20) : un diffuseur natif (GStreamer, `whipclientsink`, encodeur
// GPU) envoie en WHIP, le serveur fait suivre la vidéo H264 telle quelle à des
// navigateurs. Valide, avant d'écrire les stories et le proto :
// - WHIP reçu par str0m piloté par monoio, sur le même socket UDP que tout le reste ;
// - H264 Constrained Baseline au niveau 5.2 (assez pour du 1080p120) accepté par
//   l'émetteur et décodé par Firefox / Chrome ;
// - cadence, débit et latence réels, de l'encodeur GPU jusqu'à l'image affichée ;
// - relais des demandes d'image clé (arrivée d'un spectateur, perte de paquets).
//
// Usage : cargo run --release --example video_whip, puis http://localhost:3000 dans le
// navigateur, et côté émetteur `python back-end/examples/screen_whip.py 120 30` (écran),
// ou une mire :
//   gst-launch-1.0 videotestsrc is-live=true pattern=smpte horizontal-speed=8 ! \
//     video/x-raw,format=NV12,width=1920,height=1080,framerate=120/1 ! timeoverlay ! \
//     whipclientsink signaller::whip-endpoint=http://127.0.0.1:3000/whip stun-server="" \
//     congestion-control=disabled start-bitrate=15000000 video-caps=video/x-h264
// Un seul diffuseur à la fois (le suivant remplace le précédent), autant de spectateurs
// qu'on veut. `SPIKE_IP` : adresse annoncée (défaut : l'IP locale, jamais 127.0.0.1),
// `SPIKE_UDP` : port UDP (défaut 50001), `SPIKE_HTTP` : port HTTP (défaut 3000).

use std::cell::RefCell;
use std::net::{IpAddr, SocketAddr};
use std::rc::Rc;
use std::time::{Duration, Instant};

use monoio::io::{AsyncReadRent, AsyncWriteRentExt};
use monoio::net::udp::UdpSocket;
use monoio::net::{TcpListener, TcpStream};
use str0m::bwe::Bitrate;
use str0m::change::SdpOffer;
use str0m::media::{KeyframeRequestKind, MediaKind, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};

/// H264 Constrained Baseline (0x42e0), niveau 5.2 (0x34) : un émetteur ou un navigateur
/// qui annonce un niveau inférieur est accepté (str0m : niveau offert ≤ le nôtre).
const H264_PROFILE: u32 = 0x42e034;
/// Débit visé vers chaque spectateur : le pacer lisse l'envoi à environ deux fois
/// l'estimation de bande passante, qui part de là.
const VIEWER_MBPS: u64 = 60;
/// Pas plus d'une demande d'image clé vers le diffuseur par intervalle.
const KEYFRAME_THROTTLE: Duration = Duration::from_millis(500);

#[derive(PartialEq)]
enum Role {
    Publisher,
    Viewer,
}

struct Client {
    id: u32,
    role: Role,
    rtc: Rtc,
    /// Piste vidéo : reçue (diffuseur) ou envoyée (spectateur).
    mid: Option<Mid>,
    /// Spectateur : n'écrit qu'à partir d'une image clé (sinon le décodeur reçoit des
    /// images qui dépendent d'images qu'il n'a jamais vues).
    started: bool,
    datagrams: u64,
    bytes: u64,
    frames: u64,
    reported: (u64, u64, u64),
    last_time: Option<str0m::media::MediaTime>,
    same_time: u64,
}

#[derive(Default)]
struct State {
    clients: Vec<Client>,
    /// Une image clé est à demander au diffuseur (nouveau spectateur, perte, PLI).
    want_keyframe: bool,
    last_keyframe_request: Option<Instant>,
}

type Shared = Rc<RefCell<State>>;

#[monoio::main(timer_enabled = true)]
async fn main() {
    let ip: IpAddr = std::env::var("SPIKE_IP").ok().and_then(|v| v.parse().ok()).unwrap_or_else(local_ip);
    let port: u16 = std::env::var("SPIKE_UDP").ok().and_then(|v| v.parse().ok()).unwrap_or(50001);
    // Tampon de réception agrandi : une image clé 1080p arrive en rafale de centaines de
    // paquets ; avec les ~200 Ko par défaut, le noyau en jette (RcvbufErrors) avant que
    // la boucle ait vidé le socket. Plafonné par `net.core.rmem_max`.
    let std_socket = socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::DGRAM, None).expect("socket UDP");
    std_socket.set_recv_buffer_size(16 << 20).expect("SO_RCVBUF");
    std_socket.bind(&SocketAddr::new([0, 0, 0, 0].into(), port).into()).expect("bind UDP");
    println!("tampon de réception UDP : {} Ko", std_socket.recv_buffer_size().unwrap_or(0) / 1024);
    let socket = Rc::new(UdpSocket::from_std(std_socket.into()).expect("socket monoio"));
    let announced = SocketAddr::new(ip, port);
    let state = Shared::default();
    monoio::spawn(udp_loop(socket, state.clone(), announced));

    let http_port: u16 = std::env::var("SPIKE_HTTP").ok().and_then(|v| v.parse().ok()).unwrap_or(3000);
    let listener = TcpListener::bind(("127.0.0.1", http_port)).expect("bind HTTP");
    println!("http://localhost:{http_port} — WHIP : http://127.0.0.1:{http_port}/whip — média sur {announced}/udp");
    let mut next_id = 0;
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        next_id += 1;
        monoio::spawn(http(stream, state.clone(), announced, next_id));
    }
}

/// IP de l'interface qui sert la route par défaut (aucun paquet ne part).
fn local_ip() -> IpAddr {
    let probe = std::net::UdpSocket::bind("0.0.0.0:0").expect("socket UDP");
    probe.connect("192.0.2.1:9").expect("aucune route réseau");
    probe.local_addr().expect("adresse locale").ip()
}

async fn udp_loop(socket: Rc<UdpSocket>, state: Shared, announced: SocketAddr) {
    let mut buf = vec![0u8; 2000];
    let mut last_report = Instant::now();
    loop {
        let next = drive(&socket, &state).await;
        let wait = next.saturating_duration_since(Instant::now()).min(Duration::from_millis(20));
        match monoio::time::timeout(wait, socket.recv_from(buf)).await {
            Ok((res, b)) => {
                buf = b;
                if let Ok((n, source)) = res {
                    let Ok(contents) = buf[..n].try_into() else { continue };
                    let input = Input::Receive(
                        Instant::now(),
                        Receive { proto: Protocol::Udp, source, destination: announced, contents },
                    );
                    let mut state = state.borrow_mut();
                    match state.clients.iter_mut().find(|c| c.rtc.accepts(&input)) {
                        Some(client) => {
                            client.datagrams += 1;
                            client.bytes += n as u64;
                            if let Err(e) = client.rtc.handle_input(input) {
                                println!("[{}] entrée refusée : {e:?}", client.id);
                                client.rtc.disconnect();
                            }
                        }
                        None => println!("[udp] datagramme de {source} : aucun client"),
                    }
                }
            }
            Err(_) => buf = vec![0u8; 2000],
        }
        if last_report.elapsed() >= Duration::from_secs(2) {
            let secs = last_report.elapsed().as_secs_f64();
            last_report = Instant::now();
            for c in state.borrow_mut().clients.iter_mut() {
                let (d, b, f) = (c.datagrams - c.reported.0, c.bytes - c.reported.1, c.frames - c.reported.2);
                let what = if c.role == Role::Publisher { "reçues" } else { "envoyées" };
                println!(
                    "[{}] {:.0} datagrammes/s reçus, {:.1} Mbps reçus, {:.0} images/s {what}",
                    c.id,
                    d as f64 / secs,
                    b as f64 * 8.0 / secs / 1e6,
                    f as f64 / secs
                );
                if c.same_time > 0 {
                    println!("[{}] {} images avec l'horodatage de la précédente", c.id, c.same_time);
                    c.same_time = 0;
                }
                c.reported = (c.datagrams, c.bytes, c.frames);
            }
        }
    }
}

/// Fait avancer chaque `Rtc`, fait suivre les images du diffuseur aux spectateurs,
/// relaie les demandes d'image clé, envoie les datagrammes. Rend le prochain délai.
async fn drive(socket: &UdpSocket, state: &Shared) -> Instant {
    let now = Instant::now();
    let mut next = now + Duration::from_millis(100);
    let mut out: Vec<(Vec<u8>, SocketAddr)> = Vec::new();
    {
        let state = &mut *state.borrow_mut();
        for c in state.clients.iter_mut() {
            if c.rtc.handle_input(Input::Timeout(now)).is_err() {
                c.rtc.disconnect();
            }
        }
        loop {
            let mut frames = Vec::new();
            for c in state.clients.iter_mut() {
                loop {
                    match c.rtc.poll_output() {
                        Ok(Output::Timeout(t)) => {
                            next = next.min(t);
                            break;
                        }
                        Ok(Output::Transmit(t)) => out.push((t.contents.to_vec(), t.destination)),
                        Ok(Output::Event(Event::IceConnectionStateChange(s))) => {
                            println!("[{}] ICE : {s:?}", c.id);
                            if s == IceConnectionState::Disconnected {
                                c.rtc.disconnect();
                            }
                        }
                        Ok(Output::Event(Event::Connected)) => {
                            println!("[{}] connecté (DTLS + SRTP)", c.id);
                            if c.role == Role::Viewer {
                                state.want_keyframe = true;
                            }
                        }
                        Ok(Output::Event(Event::MediaAdded(m))) if m.kind == MediaKind::Video => c.mid = Some(m.mid),
                        Ok(Output::Event(Event::MediaData(data))) if c.role == Role::Publisher => {
                            c.frames += 1;
                            // Diagnostic : horodatage RTP identique à l'image précédente.
                            if c.last_time == Some(data.time) {
                                c.same_time += 1;
                            }
                            c.last_time = Some(data.time);
                            if !data.contiguous {
                                state.want_keyframe = true;
                            }
                            frames.push(data);
                        }
                        Ok(Output::Event(Event::EgressBitrateEstimate(e))) => {
                            println!("[{}] estimation de bande passante : {e:?}", c.id);
                        }
                        Ok(Output::Event(Event::KeyframeRequest(req))) => {
                            println!("[{}] demande d'image clé ({:?})", c.id, req.kind);
                            state.want_keyframe = true;
                        }
                        Ok(Output::Event(_)) => {}
                        Err(e) => {
                            println!("[{}] erreur : {e:?}", c.id);
                            c.rtc.disconnect();
                            break;
                        }
                    }
                }
            }
            if frames.is_empty() {
                break;
            }
            for data in frames {
                let keyframe = data.is_keyframe();
                for v in state.clients.iter_mut().filter(|c| c.role == Role::Viewer) {
                    v.started |= keyframe;
                    let (true, Some(mid)) = (v.started, v.mid) else { continue };
                    let Some(writer) = v.rtc.writer(mid) else { continue };
                    let Some(pt) = writer.match_params(data.params) else {
                        println!("[{}] codec du diffuseur refusé : {:?}", v.id, data.params.spec());
                        continue;
                    };
                    if writer.write(pt, data.network_time, data.time, data.data.clone()).is_ok() {
                        v.frames += 1;
                    }
                }
            }
        }
        let throttled = state.last_keyframe_request.is_some_and(|t| now - t < KEYFRAME_THROTTLE);
        if state.want_keyframe && !throttled {
            let publisher = state.clients.iter_mut().find(|c| c.role == Role::Publisher);
            if let Some(p) = publisher
                && let Some(mid) = p.mid
                && let Some(mut writer) = p.rtc.writer(mid)
                && writer.request_keyframe(None, KeyframeRequestKind::Pli).is_ok()
            {
                state.want_keyframe = false;
                state.last_keyframe_request = Some(now);
            }
        }
        state.clients.retain(|c| {
            let alive = c.rtc.is_alive();
            if !alive {
                println!("[{}] parti", c.id);
            }
            alive
        });
    }
    for (bytes, dest) in out {
        let _ = socket.send_to(bytes, dest).await;
    }
    next
}

/// HTTP minimal : `GET /` → la page ; `POST /whip` (diffuseur) et `POST /watch`
/// (spectateur) : corps = offre SDP, réponse = SDP ; `DELETE /whip/…` : fin de diffusion.
async fn http(mut stream: TcpStream, state: Shared, announced: SocketAddr, id: u32) {
    let mut req: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; 8192];
    let (method, path, body) = loop {
        let (res, b) = stream.read(buf).await;
        buf = b;
        let Ok(n) = res else { return };
        if n == 0 {
            return;
        }
        req.extend_from_slice(&buf[..n]);
        let mut headers = [httparse::EMPTY_HEADER; 32];
        let mut parsed = httparse::Request::new(&mut headers);
        let Ok(httparse::Status::Complete(head)) = parsed.parse(&req) else { continue };
        let length = parsed
            .headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case("content-length"))
            .and_then(|h| std::str::from_utf8(h.value).ok()?.parse::<usize>().ok())
            .unwrap_or(0);
        if req.len() >= head + length {
            let method = parsed.method.unwrap_or("").to_string();
            let path = parsed.path.unwrap_or("").to_string();
            break (method, path, req[head..head + length].to_vec());
        }
    };
    println!("[http] {method} {path}");
    let mut extra = String::new();
    let (status, content_type, body) = match (method.as_str(), path.as_str()) {
        ("POST", "/whip" | "/watch") => {
            let role = if path == "/whip" { Role::Publisher } else { Role::Viewer };
            match answer(&body, announced, &role) {
                Ok((rtc, sdp)) => {
                    let mut state = state.borrow_mut();
                    if role == Role::Publisher {
                        state.clients.retain(|c| c.role != Role::Publisher);
                        extra = format!("Location: /whip/{id}\r\n");
                    }
                    let who = if role == Role::Publisher { "diffuseur" } else { "spectateur" };
                    println!("[{id}] {who} : offre acceptée");
                    state.clients.push(Client {
                        id,
                        role,
                        rtc,
                        mid: None,
                        started: false,
                        datagrams: 0,
                        bytes: 0,
                        frames: 0,
                        reported: (0, 0, 0),
                        last_time: None,
                        same_time: 0,
                    });
                    let status = if path == "/whip" { "201 Created" } else { "200 OK" };
                    (status, "application/sdp", sdp.into_bytes())
                }
                Err(e) => {
                    println!("[{id}] offre refusée : {e}");
                    ("400 Bad Request", "text/plain", e.into_bytes())
                }
            }
        }
        ("DELETE", _) => {
            for c in state.borrow_mut().clients.iter_mut().filter(|c| c.role == Role::Publisher) {
                c.rtc.disconnect();
            }
            ("200 OK", "text/plain", Vec::new())
        }
        // Stats du spectateur automatique (`?auto`), pour mesurer sans regarder.
        ("POST", "/stats") => {
            println!("[stats] {}", String::from_utf8_lossy(&body));
            ("204 No Content", "text/plain", Vec::new())
        }
        // Trickle ICE (PATCH) inutile : le serveur est en ICE-lite.
        ("PATCH", _) => ("204 No Content", "text/plain", Vec::new()),
        ("GET", "/") => ("200 OK", "text/html; charset=utf-8", PAGE.as_bytes().to_vec()),
        _ => ("404 Not Found", "text/plain", Vec::new()),
    };
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(&body);
    let _ = stream.write_all(response).await;
}

fn answer(offer: &[u8], announced: SocketAddr, role: &Role) -> Result<(Rtc, String), String> {
    let sdp = std::str::from_utf8(offer).map_err(|e| e.to_string())?;
    if *role == Role::Publisher {
        let h264: Vec<&str> = sdp.lines().filter(|l| l.starts_with("a=fmtp") || l.starts_with("a=rtpmap")).collect();
        println!("[whip] offre du diffuseur :\n  {}", h264.join("\n  "));
    }
    let offer = SdpOffer::from_sdp_string(sdp).map_err(|e| format!("{e:?}"))?;
    let mut config = Rtc::builder().set_ice_lite(true).clear_codecs();
    let pacing = *role == Role::Viewer && std::env::var("SPIKE_PACING").is_ok_and(|v| v == "1");
    if pacing {
        // Le pacer de str0m n'existe qu'avec l'estimation de bande passante : sans lui,
        // chaque image part d'un bloc (des centaines de paquets d'un coup à 50 Mbps) et
        // déborde le tampon de réception du navigateur — pertes, gels.
        config = config.enable_bwe(Some(Bitrate::mbps(VIEWER_MBPS)));
    }
    config.codec_config().add_h264(102.into(), Some(103.into()), true, H264_PROFILE);
    let mut rtc = config.build(Instant::now());
    // Désactivé par défaut : l'estimation (TWCC) fait des dents de scie (monte vers le
    // débit voulu à coups de sondes, s'effondre, recommence) ; sous le débit du diffuseur,
    // la file du pacer grossit — le direct prend du retard puis accélère pour rattraper.
    if pacing {
        rtc.bwe().set_desired_bitrate(Bitrate::mbps(VIEWER_MBPS));
    }
    let candidate = Candidate::host(announced, "udp").map_err(|e| format!("{e:?}"))?;
    rtc.add_local_candidate(candidate);
    let answer = rtc.sdp_api().accept_offer(offer).map_err(|e| format!("{e:?}"))?;
    Ok((rtc, answer.to_sdp_string()))
}

const PAGE: &str = r#"<!doctype html>
<meta charset="utf-8">
<title>Spike vidéo — WHIP</title>
<style>
body{font:15px system-ui;margin:1rem;background:#111;color:#eee}
video{width:100%;max-height:75vh;background:#000}
#clock{font:bold 48px monospace;color:#ff0}
pre{color:#9f9;font-size:14px}
.row{display:flex;gap:2rem;align-items:flex-start;flex-wrap:wrap}
</style>
<p>Latence : partage <b>cet écran</b> depuis le diffuseur ; l'horloge filmée dans la vidéo
retarde sur l'horloge réelle d'autant que la chaîne complète.</p>
<div id="clock">—</div>
<video id="v" autoplay muted playsinline></video>
<div class="row"><button id="go">Regarder</button><pre id="out"></pre></div>
<script>
const clock = document.getElementById("clock")
const tick = () => {
  const d = new Date()
  clock.textContent = d.toLocaleTimeString("fr-FR") + "." + String(d.getMilliseconds()).padStart(3, "0")
  requestAnimationFrame(tick)
}
tick()
async function start() {
  document.getElementById("go").disabled = true
  const pc = new RTCPeerConnection()
  pc.addTransceiver("video", { direction: "recvonly" })
  pc.ontrack = (e) => { document.getElementById("v").srcObject = new MediaStream([e.track]) }
  await pc.setLocalDescription(await pc.createOffer())
  const res = await fetch("/watch", { method: "POST", body: pc.localDescription.sdp })
  await pc.setRemoteDescription({ type: "answer", sdp: await res.text() })
  let last = null
  setInterval(async () => {
    const stats = await pc.getStats()
    for (const s of stats.values()) {
      if (s.type !== "inbound-rtp" || s.kind !== "video") continue
      const codec = stats.get(s.codecId)
      const dt = last ? (s.timestamp - last.timestamp) / 1000 : 1
      const r = {
        t: new Date().toLocaleTimeString("fr-FR"),
        ice: pc.iceConnectionState,
        codec: codec ? `${codec.mimeType} ${codec.sdpFmtpLine ?? ""}` : "?",
        decoder: s.decoderImplementation,
        resolution: `${s.frameWidth}x${s.frameHeight}`,
        "images/s (décodées)": last ? ((s.framesDecoded - last.framesDecoded) / dt).toFixed(0) : "-",
        "images/s (navigateur)": s.framesPerSecond,
        "débit Mbps": last ? (((s.bytesReceived - last.bytesReceived) * 8) / dt / 1e6).toFixed(1) : "-",
        "tampon de gigue ms": s.jitterBufferEmittedCount ? ((s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000).toFixed(0) : "-",
        "décodage ms/image": s.framesDecoded ? ((s.totalDecodeTime / s.framesDecoded) * 1000).toFixed(1) : "-",
        "paquets perdus": s.packetsLost,
        "images perdues": s.framesDropped,
        gels: s.freezeCount,
        "images clés": s.keyFramesDecoded,
        PLI: s.pliCount,
      }
      document.getElementById("out").textContent = JSON.stringify(r, null, 2)
      if (location.search.includes("auto")) fetch("/stats", { method: "POST", body: JSON.stringify(r) })
      last = s
    }
  }, 1000)
}
document.getElementById("go").onclick = start
if (location.search.includes("auto")) start()
</script>
"#;

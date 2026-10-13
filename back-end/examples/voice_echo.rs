// Spike vocal (story 18) : chaque navigateur s'entend lui-même à travers le serveur.
// Valide, avant d'écrire les stories et le proto définitifs :
// - str0m (sans I/O) piloté par monoio : un seul socket UDP pour tous les clients,
//   démultiplexé par `Rtc::accepts` ;
// - ICE-lite **sans candidats du client** : l'offre part sans attendre la collecte, le
//   serveur apprend l'adresse du navigateur par ses requêtes STUN (peer-reflexive) —
//   si ça tient, plus besoin de trickle ICE ni de message `IceCandidate`.
//
// Usage : cargo run --example voice_echo, puis http://localhost:3000 (localhost suffit
// au navigateur pour autoriser le micro). `SPIKE_IP` : adresse annoncée au navigateur
// (défaut : l'IP locale de la machine — jamais 127.0.0.1, que les navigateurs
// refusent pour WebRTC : ICE reste bloqué en Checking puis échoue),
//
// Silence : le serveur demande la transmission discontinue d'Opus (`usedtx=1` dans sa
// réponse SDP) et la page coupe l'envoi quand la détection de voix ne voit plus rien
// (micro détaché de la connexion, `replaceTrack(null)` : plus aucun paquet audio).
//
// `SPIKE_UDP` : port UDP (défaut 50000), `SPIKE_HTTP` : port de la page (défaut 3000).

use std::cell::RefCell;
use std::net::{IpAddr, SocketAddr};
use std::rc::Rc;
use std::time::{Duration, Instant};

use monoio::io::{AsyncReadRent, AsyncWriteRentExt};
use monoio::net::udp::UdpSocket;
use monoio::net::{TcpListener, TcpStream};
use str0m::change::SdpOffer;
use str0m::format::{Codec, FormatParams};
use str0m::media::{Frequency, Pt};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};

struct Client {
    id: u32,
    rtc: Rtc,
    received: u64,
    echoed: u64,
    /// Valeurs au dernier rapport : débit sur les 2 dernières secondes.
    reported: (u64, u64),
}

type Clients = Rc<RefCell<Vec<Client>>>;

#[monoio::main(timer_enabled = true)]
async fn main() {
    let ip: IpAddr = std::env::var("SPIKE_IP").ok().and_then(|v| v.parse().ok()).unwrap_or_else(local_ip);
    let port: u16 = std::env::var("SPIKE_UDP").ok().and_then(|v| v.parse().ok()).unwrap_or(50000);
    let socket = Rc::new(UdpSocket::bind(SocketAddr::new([0, 0, 0, 0].into(), port)).expect("bind UDP"));
    let announced = SocketAddr::new(ip, port);
    let clients = Clients::default();
    monoio::spawn(udp_loop(socket, clients.clone(), announced));

    let http_port: u16 = std::env::var("SPIKE_HTTP").ok().and_then(|v| v.parse().ok()).unwrap_or(3000);
    let listener = TcpListener::bind(("127.0.0.1", http_port)).expect("bind HTTP");
    println!("http://localhost:{http_port} — média annoncé sur {announced}/udp");
    let mut next_id = 0;
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        next_id += 1;
        monoio::spawn(http(stream, clients.clone(), announced, next_id));
    }
}

/// IP de l'interface qui sert la route par défaut : un socket UDP « connecté » ne
/// fait que choisir sa route, aucun paquet ne part.
fn local_ip() -> IpAddr {
    let probe = std::net::UdpSocket::bind("0.0.0.0:0").expect("socket UDP");
    probe.connect("192.0.2.1:9").expect("aucune route réseau");
    probe.local_addr().expect("adresse locale").ip()
}

/// Une seule tâche pour tout l'UDP : lit un datagramme (ou attend le prochain délai
/// de str0m), le donne au client qui le reconnaît, puis vide les sorties de chacun.
async fn udp_loop(socket: Rc<UdpSocket>, clients: Clients, announced: SocketAddr) {
    let mut buf = vec![0u8; 2000];
    let mut last_report = Instant::now();
    loop {
        let next = drive(&socket, &clients).await;
        // Plafond de 20 ms : un client ajouté par la tâche HTTP est pris en compte vite.
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
                    let mut clients = clients.borrow_mut();
                    match clients.iter_mut().find(|c| c.rtc.accepts(&input)) {
                        Some(client) => {
                            client.received += 1;
                            if let Err(e) = client.rtc.handle_input(input) {
                                println!("[client {}] entrée refusée : {e:?}", client.id);
                                client.rtc.disconnect();
                            }
                        }
                        None => println!("[udp] datagramme de {source} : aucun client"),
                    }
                }
            }
            // Délai écoulé : le tampon prêté à io_uring est perdu avec la lecture annulée.
            Err(_) => buf = vec![0u8; 2000],
        }
        if last_report.elapsed() >= Duration::from_secs(2) {
            last_report = Instant::now();
            for c in clients.borrow_mut().iter_mut() {
                println!(
                    "[client {}] 2 dernières s : {} datagrammes reçus, {} paquets audio renvoyés",
                    c.id,
                    c.received - c.reported.0,
                    c.echoed - c.reported.1
                );
                c.reported = (c.received, c.echoed);
            }
        }
    }
}

/// Fait avancer chaque `Rtc` (délais échus), renvoie l'audio reçu à son émetteur,
/// envoie les datagrammes produits. Retourne l'instant du prochain délai.
async fn drive(socket: &UdpSocket, clients: &Clients) -> Instant {
    let now = Instant::now();
    let mut next = now + Duration::from_millis(100);
    let mut out: Vec<(Vec<u8>, SocketAddr)> = Vec::new();
    {
        let mut clients = clients.borrow_mut();
        for c in clients.iter_mut() {
            if c.rtc.handle_input(Input::Timeout(now)).is_err() {
                c.rtc.disconnect();
                continue;
            }
            loop {
                match c.rtc.poll_output() {
                    Ok(Output::Timeout(t)) => {
                        next = next.min(t);
                        break;
                    }
                    Ok(Output::Transmit(t)) => out.push((t.contents.to_vec(), t.destination)),
                    Ok(Output::Event(Event::IceConnectionStateChange(state))) => {
                        println!("[client {}] ICE : {state:?}", c.id);
                        if state == IceConnectionState::Disconnected {
                            c.rtc.disconnect();
                        }
                    }
                    Ok(Output::Event(Event::Connected)) => println!("[client {}] connecté (DTLS + SRTP)", c.id),
                    Ok(Output::Event(Event::MediaData(data))) => {
                        // Écho : même piste (sendrecv), même codec.
                        let Some(writer) = c.rtc.writer(data.mid) else { continue };
                        let Some(pt) = writer.match_params(data.params) else { continue };
                        if writer.write(pt, data.network_time, data.time, data.data).is_ok() {
                            c.echoed += 1;
                        }
                    }
                    Ok(Output::Event(_)) => {}
                    Err(e) => {
                        println!("[client {}] erreur : {e:?}", c.id);
                        c.rtc.disconnect();
                        break;
                    }
                }
            }
        }
        clients.retain(|c| {
            let alive = c.rtc.is_alive();
            if !alive {
                println!("[client {}] parti", c.id);
            }
            alive
        });
    }
    for (bytes, dest) in out {
        let _ = socket.send_to(bytes, dest).await;
    }
    next
}

/// HTTP minimal : `GET /` → la page, `POST /offer` (corps = SDP) → SDP de réponse.
async fn http(mut stream: TcpStream, clients: Clients, announced: SocketAddr, id: u32) {
    let mut req: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; 8192];
    let (method, body) = loop {
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
            break (parsed.method.unwrap_or("").to_string(), req[head..head + length].to_vec());
        }
    };
    let (status, content_type, body) = if method == "POST" {
        match answer(&body, announced) {
            Ok(rtc) => {
                let (rtc, sdp) = rtc;
                clients.borrow_mut().push(Client { id, rtc, received: 0, echoed: 0, reported: (0, 0) });
                println!("[client {id}] offre acceptée");
                ("200 OK", "application/sdp", sdp.into_bytes())
            }
            Err(e) => ("400 Bad Request", "text/plain", e.into_bytes()),
        }
    } else {
        ("200 OK", "text/html; charset=utf-8", PAGE.as_bytes().to_vec())
    };
    let mut response =
        format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len())
            .into_bytes();
    response.extend_from_slice(&body);
    let _ = stream.write_all(response).await;
}

fn answer(offer: &[u8], announced: SocketAddr) -> Result<(Rtc, String), String> {
    let sdp = std::str::from_utf8(offer).map_err(|e| e.to_string())?;
    let candidates = sdp.lines().filter(|l| l.starts_with("a=candidate")).count();
    println!("[offre] {candidates} candidat(s) ICE du client dans le SDP");
    let offer = SdpOffer::from_sdp_string(sdp).map_err(|e| format!("{e:?}"))?;
    // Opus seul, comme le réglage par défaut de str0m, plus `usedtx=1` : le navigateur
    // n'envoie plus qu'un paquet toutes les 400 ms quand le son est du silence.
    let mut config = Rtc::builder().set_ice_lite(true).clear_codecs();
    config.codec_config().add_config(
        Pt::from(111),
        None,
        Codec::Opus,
        Frequency::FORTY_EIGHT_KHZ,
        Some(2),
        FormatParams { min_p_time: Some(10), use_inband_fec: Some(true), use_dtx: Some(true), ..Default::default() },
    );
    let mut rtc = config.build(Instant::now());
    let candidate = Candidate::host(announced, "udp").map_err(|e| format!("{e:?}"))?;
    rtc.add_local_candidate(candidate);
    let answer = rtc.sdp_api().accept_offer(offer).map_err(|e| format!("{e:?}"))?;
    Ok((rtc, answer.to_sdp_string()))
}

const PAGE: &str = r#"<!doctype html>
<meta charset="utf-8">
<title>Spike vocal — écho</title>
<style>body{font:16px system-ui;margin:2rem;background:#111;color:#eee}pre{color:#9f9}</style>
<h1>Écho vocal</h1>
<p>Parle : tu dois t'entendre avec un léger retard (aller-retour par le serveur).</p>
<button id="go">Démarrer</button>
<label>Sensibilité <input id="threshold" type="range" min="-70" max="-20" value="-50"> <span id="db">-50</span> dB</label>
<p id="vad">—</p>
<pre id="out"></pre>
<script>
const out = document.getElementById("out")
window.spike = { ice: "new", candidatesInOffer: -1, sent: 0, received: 0, level: 0, speaking: false }
const threshold = document.getElementById("threshold")
threshold.oninput = () => { document.getElementById("db").textContent = threshold.value }
/** Silence au-delà duquel on coupe : ne pas manger les fins de mots. */
const HANGOVER_MS = 400

// Détection de voix : niveau RMS du micro toutes les 20 ms (une trame Opus) ; au-dessus
// du seuil, le micro est rattaché à la connexion, sinon détaché après HANGOVER_MS.
function voiceGate(mic, sender) {
  const ctx = new AudioContext()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  ctx.createMediaStreamSource(mic).connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  const track = mic.getAudioTracks()[0]
  let lastVoice = 0
  setInterval(() => {
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (const v of samples) sum += v * v
    const db = 10 * Math.log10(sum / samples.length + 1e-12)
    const now = performance.now()
    if (db > Number(threshold.value)) lastVoice = now
    const speaking = now - lastVoice < HANGOVER_MS
    if (speaking !== spike.speaking) {
      spike.speaking = speaking
      void sender.replaceTrack(speaking ? track : null)
    }
    document.getElementById("vad").textContent = `${db.toFixed(0)} dB — ${speaking ? "🎙️ envoi" : "🔇 silence, rien n'est envoyé"}`
  }, 20)
}
async function start() {
  document.getElementById("go").disabled = true
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false } })
  const pc = new RTCPeerConnection()
  // Transceiver créé sans piste : l'envoi ne démarre qu'à la première voix détectée.
  const { sender } = pc.addTransceiver("audio", { direction: "sendrecv" })
  voiceGate(mic, sender)
  pc.ontrack = (e) => { const a = new Audio(); a.srcObject = new MediaStream([e.track]); a.play() }
  pc.oniceconnectionstatechange = () => { spike.ice = pc.iceConnectionState }
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  // Envoyée tout de suite : pas d'attente de la collecte, donc aucun candidat.
  const sdp = pc.localDescription.sdp
  spike.candidatesInOffer = sdp.split("\r\n").filter((l) => l.startsWith("a=candidate")).length
  const res = await fetch("/offer", { method: "POST", body: sdp })
  await pc.setRemoteDescription({ type: "answer", sdp: await res.text() })
  setInterval(async () => {
    for (const s of (await pc.getStats()).values()) {
      if (s.type === "outbound-rtp" && s.kind === "audio") spike.sent = s.packetsSent
      if (s.type === "inbound-rtp" && s.kind === "audio") { spike.received = s.packetsReceived; spike.level = s.audioLevel ?? 0 }
    }
    out.textContent = JSON.stringify(spike, null, 2)
  }, 500)
}
document.getElementById("go").onclick = start
if (location.search.includes("auto")) start()
</script>
"#;

#!/usr/bin/env python3
# Spike vidéo, côté diffuseur : capture d'écran Wayland (portail xdg-desktop-portal →
# PipeWire, DMA-BUF) → nvautogpuh264enc (NVENC) → whipclientsink → WHIP vers
# `cargo run --release --example video_whip`. Préfigure le cœur natif de l'app Tauri.
# Validé le 2026-10-14 : 1080p120 fluide sur RTX 3060 Ti / KDE Wayland (cf. HANDOFF).
#
# Usage : python back-end/examples/screen_whip.py [fps] [Mbps]   (défaut : 120, 15)
#   MEM=dmabuf-mix    défaut : image restée sur le GPU (DMA-BUF), copiée par OpenGL,
#                     cadence fixe par glvideomixer (répète sa copie quand l'écran est
#                     immobile), passée à CUDA ; variantes de comparaison : dmabuf-cuda
#                     (keepalive + videorate : texte tapé qui saute), dmabuf, dmabuf-q-cuda,
#                     dmabuf-dl, dmabuf-dl-q, shm (copie GPU → RAM par KWin : 1-9 images/s)
#   SINK=whip|measure|encode   diffuser, mesurer la cadence de capture seule, ou
#                     capture + encodeur sans whipclientsink
#   ENCODER=nvautogpuh264enc|nvh264enc   (nvh264enc plafonne vers 100 images/s ici)
#   ENC="prop=valeur,…"   réglages de l'encodeur (défaut : CBR, p4, ultra-low-latency)
# Le premier lancement demande l'écran à partager ; le choix est mémorisé (jeton du
# portail dans ~/.cache/audio-screen-token) pour les suivants.
# Affiche la cadence réellement fournie par le compositeur.

import os
import sys
import time

import dbus
import gi
from dbus.mainloop.glib import DBusGMainLoop

gi.require_version("Gst", "1.0")
from gi.repository import GLib, Gst

FPS = int(sys.argv[1]) if len(sys.argv) > 1 else 120
MBPS = int(sys.argv[2]) if len(sys.argv) > 2 else 15
MEM = os.environ.get("MEM", "dmabuf-mix")
SINK = os.environ.get("SINK", "whip")
ENDPOINT = "http://127.0.0.1:3000/whip"
TOKEN_FILE = os.path.expanduser("~/.cache/audio-screen-token")

# nvh264enc (rang le plus haut, donc choisi par whipclientsink) plafonne vers 100 images/s
# en capture directe : il attend une synchronisation GPU par image. nvautogpuh264enc tient
# la cadence du compositeur (160+). ENCODER=nvh264enc pour comparer.
if os.environ.get("ENCODER", "nvautogpuh264enc") == "nvautogpuh264enc":
    os.environ.setdefault("GST_PLUGIN_FEATURE_RANK", "nvautogpuh264enc:MAX")
DBusGMainLoop(set_as_default=True)
Gst.init(None)
loop = GLib.MainLoop()
bus = dbus.SessionBus()
portal = bus.get_object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")
screencast = dbus.Interface(portal, "org.freedesktop.portal.ScreenCast")
sender = bus.get_unique_name()[1:].replace(".", "_")
counter = 0
session = None
pipeline = None


def request(method, *args, then):
    """Appel du portail : la réponse arrive par le signal Response de l'objet Request."""
    global counter
    counter += 1
    token = f"audio{counter}"
    path = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"

    def on_response(code, results):
        if code != 0:
            print(f"portail : {method} refusé ({code})")
            loop.quit()
            return
        then(results)

    bus.add_signal_receiver(on_response, "Response", "org.freedesktop.portal.Request", path=path)
    args[-1]["handle_token"] = token
    getattr(screencast, method)(*args)


def created(results):
    global session
    session = results["session_handle"]
    # types 1 = écran, 2 = fenêtre ; cursor_mode 2 = curseur incrusté ; persist_mode 2 =
    # choix mémorisé jusqu'à révocation.
    opts = {
        "types": dbus.UInt32(1 | 2),
        "multiple": False,
        "cursor_mode": dbus.UInt32(2),
        "persist_mode": dbus.UInt32(2),
    }
    if os.path.exists(TOKEN_FILE):
        opts["restore_token"] = open(TOKEN_FILE).read().strip()
    request("SelectSources", session, opts, then=selected)


def selected(_results):
    request("Start", session, "", {}, then=started)


# whipclientsink ne sait pas régler nvautogpuh264enc (il le laisserait sans limite de débit) :
# CBR, faible latence, image clé seulement à la demande (PLI d'un spectateur).
ENC = os.environ.get(
    "ENC",
    f"bitrate={MBPS * 1000},rc-mode=cbr,preset=p4,tune=ultra-low-latency,zerolatency=true,gop-size=-1,"
    # Marge du débit (VBV) de 4 images : par défaut ~1 s, l'encodeur thésaurise pendant un
    # écran immobile et dépense tout au mouvement suivant (pics à 2× le débit, rafales).
    f"vbv-buffer-size={MBPS * 1000 * 4 // FPS}",
)

ENCODER_PROPS = ["preset", "tune", "rc-mode", "bitrate", "max-bitrate", "vbv-buffer-size", "gop-size",
                 "spatial-aq", "temporal-aq", "rc-lookahead", "multi-pass", "b-frames", "zerolatency"]


def encoder_setup(_sink, _peer, _stream, encoder):
    """ENC="prop=valeur,…" : réglages imposés à l'encodeur. Affiche ceux en vigueur
    une seconde plus tard (whipclientsink règle aussi le débit de son côté)."""
    for pair in filter(None, ENC.split(",")):
        key, value = pair.split("=", 1)
        Gst.util_set_object_arg(encoder, key, value)

    def show():
        values = []
        for p in ENCODER_PROPS:
            if encoder.find_property(p):
                v = encoder.get_property(p)
                values.append(f"{p}={v.value_nick if hasattr(v, 'value_nick') else v}")
        caps = encoder.get_static_pad("sink").get_current_caps()
        print(f"encodeur {encoder.get_factory().get_name()} : {' '.join(values)}", flush=True)
        print(f"  entrée : {caps.to_string() if caps else '?'}", flush=True)
        return False

    GLib.timeout_add_seconds(1, show)
    GLib.timeout_add_seconds(10, show)
    # Vrai : whipclientsink n'applique pas ses propres réglages par-dessus les nôtres.
    return bool(ENC)


def started(results):
    global pipeline
    if "restore_token" in results:
        with open(TOKEN_FILE, "w") as f:
            f.write(results["restore_token"])
    node, props = results["streams"][0]
    fd = screencast.OpenPipeWireRemote(session, dbus.Dictionary(signature="sv")).take()
    print(f"flux PipeWire {node}, taille {tuple(props.get('size', ()))}, mémoire {MEM}, sortie {SINK}")
    # keepalive-time = une image : KWin n'envoie rien quand l'écran est immobile, et videorate
    # ne comble un trou qu'à l'arrivée de l'image suivante — après une seconde immobile, il en
    # sortait 120 d'un coup au premier mouvement (avalanche : retard puis rattrapage).
    keepalive = max(1, 1000 // FPS)
    if MEM == "dmabuf-mix":
        # Pas de keepalive ici : il renvoie le tampon DMA-BUF de KWin lui-même, que KWin a pu
        # réutiliser entre-temps (image plus ancienne ou en cours d'écriture : du texte tapé
        # qui apparaît, disparaît, réapparaît).
        keepalive = 0
    source = f"pipewiresrc name=src fd={fd} path={node} do-timestamp=true keepalive-time={keepalive}"
    if MEM == "dmabuf-mix":
        # glvideomixer, en direct, sort FPS images/s à son propre rythme en répétant SA copie
        # de la dernière image (glcolorconvert BGRA → RGBA = une copie) : cadence régulière
        # sans keepalive ni videorate, et le tampon de KWin est rendu aussitôt.
        w, h = (int(v) for v in props["size"])
        source += (
            " ! video/x-raw(memory:DMABuf) ! glupload ! glcolorconvert"
            " ! video/x-raw(memory:GLMemory),format=NV12 ! glcolorconvert"
            " ! video/x-raw(memory:GLMemory),format=RGBA ! glvideomixer force-live=true background=black"
            f" ! video/x-raw(memory:GLMemory),format=RGBA,width={w},height={h},framerate={FPS}/1"
            " ! glcolorconvert ! video/x-raw(memory:GLMemory),format=NV12 ! cudaupload"
            " ! queue max-size-buffers=3 max-size-time=0 max-size-bytes=0 leaky=downstream"
        )
    elif MEM == "dmabuf-dl":
        # Variante : NV12 converti sur le GPU puis rapatrié en RAM, NVENC le recopie.
        source += " ! video/x-raw(memory:DMABuf) ! glupload ! glcolorconvert ! video/x-raw(memory:GLMemory),format=NV12 ! gldownload"
    elif MEM == "dmabuf-q-cuda":
        # Variante : file juste après la conversion GL, la copie CUDA passe côté encodeur.
        source += " ! video/x-raw(memory:DMABuf) ! glupload ! glcolorconvert ! video/x-raw(memory:GLMemory),format=NV12 ! queue max-size-buffers=3 max-size-time=0 max-size-bytes=0 leaky=downstream ! cudaupload"
    elif MEM == "dmabuf-dl-q":
        # Variante : rapatrié en RAM côté capture, l'encodeur reprend dans son propre fil.
        source += " ! video/x-raw(memory:DMABuf) ! glupload ! glcolorconvert ! video/x-raw(memory:GLMemory),format=NV12 ! gldownload ! queue max-size-buffers=3 max-size-time=0 max-size-bytes=0 leaky=downstream"
    elif MEM == "dmabuf-cuda":
        # Variante : passage OpenGL → CUDA explicite (cudaupload) avant l'encodeur.
        source += " ! video/x-raw(memory:DMABuf) ! glupload ! glcolorconvert ! video/x-raw(memory:GLMemory),format=NV12 ! cudaupload ! queue max-size-buffers=3 max-size-time=0 max-size-bytes=0 leaky=downstream"
    elif MEM == "dmabuf":
        # L'image reste sur le GPU : importée en texture OpenGL puis convertie en NV12 (format
        # natif de NVENC) — une copie, qui rend aussitôt son tampon à KWin ; sinon l'encodeur
        # le garde et KWin, à court de tampons, saute des images.
        source += " ! video/x-raw(memory:DMABuf) ! glupload ! glcolorconvert ! video/x-raw(memory:GLMemory),format=NV12"
    if SINK == "measure":
        sink = "fakesink sync=false"
    elif SINK == "encode":
        enc = " ".join(ENC.split(","))
        sink = f"{os.environ.get('ENCODER', 'nvautogpuh264enc')} bitrate={MBPS * 1000} {enc} ! fakesink sync=false"
    else:
        # videorate : cadence constante pour l'encodeur (son budget par image en dépend) ;
        # inutile derrière glvideomixer, qui la donne déjà.
        rate = "" if MEM == "dmabuf-mix" else f"videorate ! video/x-raw(ANY),framerate={FPS}/1 ! "
        sink = (
            f"{rate}"
            f"whipclientsink name=whip signaller::whip-endpoint={ENDPOINT} stun-server=\"\" "
            f"congestion-control=disabled start-bitrate={MBPS * 1_000_000} max-bitrate={MBPS * 1_000_000} "
            f"video-caps=video/x-h264"
        )
    pipeline = Gst.parse_launch(f"{source} ! {sink}")
    whip = pipeline.get_by_name("whip")
    if whip:
        whip.connect("encoder-setup", encoder_setup)
    frames = [0, time.monotonic()]

    def count(_pad, _info):
        frames[0] += 1
        return Gst.PadProbeReturn.OK

    pipeline.get_by_name("src").get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, count)

    def report():
        now = time.monotonic()
        print(f"compositeur : {frames[0] / (now - frames[1]):.0f} images/s", flush=True)
        frames[0], frames[1] = 0, now
        return True

    GLib.timeout_add_seconds(2, report)

    def on_message(_bus, msg):
        if msg.type == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            print(f"erreur : {err.message}\n{dbg}")
            loop.quit()
        elif msg.type == Gst.MessageType.EOS:
            loop.quit()
        elif msg.type == Gst.MessageType.STATE_CHANGED and msg.src == pipeline:
            _, new, _ = msg.parse_state_changed()
            if new == Gst.State.PLAYING:
                caps = pipeline.get_by_name("src").get_static_pad("src").get_current_caps()
                print(f"format négocié : {caps.to_string() if caps else '?'}", flush=True)

    gbus = pipeline.get_bus()
    gbus.add_signal_watch()
    gbus.connect("message", on_message)
    pipeline.set_state(Gst.State.PLAYING)


request("CreateSession", {"session_handle_token": "audio_session"}, then=created)
try:
    loop.run()
except KeyboardInterrupt:
    pass
if pipeline:
    pipeline.send_event(Gst.Event.new_eos())
    pipeline.get_bus().timed_pop_filtered(3 * Gst.SECOND, Gst.MessageType.EOS)
    pipeline.set_state(Gst.State.NULL)

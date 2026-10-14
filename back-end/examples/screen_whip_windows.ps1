# Spike vidéo, côté diffuseur, version Windows : capture d'écran D3D11 (DXGI) → NVENC
# (nvd3d11h264enc, réglé ici : whipclientsink reçoit du H264 déjà encodé) → WHIP vers
# `cargo run --release --example video_whip` lancé sur une autre machine avec
# SPIKE_HTTP_BIND=0.0.0.0. Pendant Windows de screen_whip.py (Linux / PipeWire).
#
# Prérequis : GStreamer 1.28 pour Windows (MSVC, installation « Complete »), avec
# `gst-inspect-1.0 whipclientsink` et `gst-inspect-1.0 nvd3d11h264enc` qui répondent.
#
# Usage (PowerShell) :
#   .\screen_whip_windows.ps1 -Server 192.168.1.42            # diffuser
#   .\screen_whip_windows.ps1 -Measure                         # cadence de capture seule
#   .\screen_whip_windows.ps1 -Measure -Encode                 # capture + NVENC, sans réseau
# -Monitor : index de l'écran (0, 1…) ; -Fps 120 ; -Mbps 30.

param(
    [string]$Server = "127.0.0.1",
    [int]$Monitor = 0,
    [int]$Fps = 120,
    [int]$Mbps = 30,
    [switch]$Measure,
    [switch]$Encode
)

$kbps = $Mbps * 1000
# Marge du débit (VBV) de 4 images, comme sous Linux : sinon l'encodeur thésaurise pendant
# un écran immobile et dépense tout au mouvement suivant.
$vbv = [int]($kbps * 4 / $Fps)

# La capture DXGI ne livre une image que si l'écran change : d3d11compositor (live) sort
# $Fps images/s à son rythme en répétant sa copie de la dernière, comme glvideomixer sous
# Linux. Conversion NV12 sur le GPU (format natif de NVENC).
$capture = @(
    "d3d11screencapturesrc", "monitor-index=$Monitor", "show-cursor=true", "!",
    "d3d11compositor", "force-live=true", "background=black", "!",
    "video/x-raw(memory:D3D11Memory),framerate=$Fps/1", "!",
    "d3d11convert", "!", "video/x-raw(memory:D3D11Memory),format=NV12"
)
# H264 Constrained Baseline (ce que le serveur annonce et que Firefox décode), CBR, faible
# latence, image clé seulement à la demande (PLI d'un spectateur).
$encoder = @(
    "nvd3d11h264enc", "bitrate=$kbps", "rc-mode=cbr", "preset=p4", "tune=ultra-low-latency",
    "zerolatency=true", "gop-size=-1", "vbv-buffer-size=$vbv", "!",
    "video/x-h264,profile=constrained-baseline", "!", "h264parse", "config-interval=-1"
)

if ($Measure) {
    $tail = @("!", "fpsdisplaysink", "video-sink=fakesink", "text-overlay=false", "sync=false")
    if ($Encode) { $pipeline = $capture + @("!") + $encoder + $tail }
    else { $pipeline = $capture + $tail }
    & gst-launch-1.0 -v @pipeline | Select-String "last-message"
} else {
    $whip = @(
        "!", "whipclientsink", "signaller::whip-endpoint=http://${Server}:3000/whip",
        'stun-server=""', "congestion-control=disabled"
    )
    & gst-launch-1.0 @($capture + @("!") + $encoder + $whip)
}

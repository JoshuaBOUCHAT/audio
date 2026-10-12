//! Persistance v1 = snapshot oxidart only (CLAUDE.md § Résilience) : reload du dump au
//! démarrage, `SAVE` bloquante périodique (si quelque chose a changé) et sur
//! SIGINT/SIGTERM. Version allégée (sans zstd) de
//! `resp_cmd/bgsave.rs` + `resp_cmd/shutdown.rs` du binaire radixox — oxidart n'expose
//! que les briques (`save_start`/`save_step`/`finish_save`, `format::footer`,
//! `load_file`), pas la gestion de fichier.
//!
//! La save périodique est la `SAVE` bloquante (fsync compris) faute de BGSAVE exposée
//! par la lib oxidart : le serveur est figé le temps de l'écriture. À remplacer par la
//! BGSAVE d'oxidart si elle passe un jour du binaire radixox à la lib.

use std::cell::Cell;
use std::io::{self, Write};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use oxidart::monoio::SharedArt;
use oxidart::save::format;

const FILE_NAME: &str = "dump.rxd";
const TMP_NAME: &str = "dump.rxd.tmp";
/// Taille des `write` de la save : le DFS remplit le buffer, le noyau écrit en parallèle.
const CHUNK: usize = 8 << 20;
/// Budget d'un pas de DFS (seulement pour borner le buffer, la save ne rend jamais la main).
const STEP_BUDGET: u32 = 1 << 16;
/// Perte maximale sur crash : ce qui a changé depuis la dernière save.
const SAVE_INTERVAL: Duration = Duration::from_secs(10);

/// `AUDIO_DATA_DIR`, défaut `./data` (architecture.md § Déploiement).
pub fn data_dir() -> PathBuf {
    PathBuf::from(std::env::var("AUDIO_DATA_DIR").unwrap_or_else(|_| "data".into()))
}

/// Recharge `data/dump.rxd` dans l'arbre (vide) avant d'accepter des connexions.
/// Fichier absent : démarrage à vide. Fichier illisible, tronqué ou corrompu : erreur,
/// le serveur ne démarre pas (on n'écrase pas un dump qu'on n'a pas su lire).
pub fn load_at_startup(art: &SharedArt) -> io::Result<()> {
    let path = data_dir().join(FILE_NAME);
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io::Error::new(e.kind(), format!("{}: {e}", path.display()))),
    };
    let start = Instant::now();
    let mut art = art.borrow_mut();
    // Les clés dont le TTL est passé (liens magiques) sont sautées au reload.
    art.tick();
    let stats = art.load_file(file).map_err(|e| {
        let kind = match &e {
            oxidart::LoadError::Io(e) => e.kind(),
            oxidart::LoadError::Dump(_) => io::ErrorKind::InvalidData,
        };
        io::Error::new(kind, format!("{}: {e}", path.display()))
    })?;
    println!(
        "[load] {} : {} clés ({} expirées sautées) en {:?}",
        path.display(),
        stats.keys,
        stats.expired,
        start.elapsed()
    );
    #[cfg(debug_assertions)]
    crate::codec::upgrade_dev(&mut art);
    Ok(())
}

/// `SAVE` bloquante : DFS d'une traite (aucun `.await`, donc aucune mutation ne peut
/// s'intercaler), écriture dans `dump.rxd.tmp`, fsync, puis rename atomique — si quoi
/// que ce soit échoue avant le rename, l'ancien dump fait foi.
pub fn save_sync(art: &SharedArt) -> io::Result<u64> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join(TMP_NAME);
    let res = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        let mut art = art.borrow_mut();
        let mut buf = Vec::with_capacity(CHUNK + CHUNK / 4);
        let mut crc = crc32fast::Hasher::new();
        let mut written = 0u64;
        let mut cur = art.save_start(&mut buf);
        loop {
            let done = art.save_step(&mut cur, &mut buf, STEP_BUDGET);
            if done {
                // Le curseur se libère avant finish_save (SAVE_DESIGN.md, pièges connus).
                drop(cur);
                art.finish_save();
                crc.update(&buf);
                buf.extend_from_slice(&format::footer(crc.finalize()));
                file.write_all(&buf)?;
                written += buf.len() as u64;
                break;
            }
            if buf.len() >= CHUNK {
                crc.update(&buf);
                file.write_all(&buf)?;
                written += buf.len() as u64;
                buf.clear();
            }
        }
        drop(art);
        file.sync_data()?;
        drop(file);
        std::fs::rename(&tmp, dir.join(FILE_NAME))?;
        std::fs::File::open(&dir)?.sync_all()?;
        Ok(written)
    })();
    if res.is_err() {
        if art.borrow().is_saving() {
            art.borrow_mut().finish_save();
        }
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// Toutes les `SAVE_INTERVAL`, `SAVE` si `dirty` est levé. Le drapeau est baissé
/// avant la save (aucun `.await` entre les deux, donc aucune mutation perdue) et
/// relevé si elle échoue.
pub fn install_periodic_save(art: SharedArt, dirty: Rc<Cell<bool>>) {
    monoio::spawn(async move {
        loop {
            monoio::time::sleep(SAVE_INTERVAL).await;
            if !dirty.replace(false) {
                continue;
            }
            let start = Instant::now();
            match save_sync(&art) {
                Ok(bytes) => println!("[save] {bytes} octets en {:?}", start.elapsed()),
                Err(e) => {
                    eprintln!("[save] échec : {e}");
                    dirty.set(true);
                }
            }
        }
    });
}

static STOP: AtomicBool = AtomicBool::new(false);
const SIGINT: i32 = 2;
const SIGTERM: i32 = 15;
/// Délai de réaction au signal.
const POLL: Duration = Duration::from_millis(20);

unsafe extern "C" {
    fn signal(sig: i32, handler: extern "C" fn(i32)) -> usize;
    fn _exit(code: i32) -> !;
}

extern "C" fn on_signal(_sig: i32) {
    if STOP.swap(true, Ordering::SeqCst) {
        // Second signal : sortie immédiate, sans save (`_exit` est sûr ici).
        unsafe { _exit(130) }
    }
}

/// SIGINT / SIGTERM → `SAVE` puis sortie. Le gestionnaire ne fait que lever un
/// drapeau (rien d'autre n'est sûr dans un gestionnaire de signal) ; une tâche monoio
/// le surveille et fait la save hors du gestionnaire.
pub fn install_shutdown(art: SharedArt) {
    // SAFETY: `on_signal` ne touche qu'un atomique et `_exit`.
    unsafe {
        signal(SIGINT, on_signal);
        signal(SIGTERM, on_signal);
    }
    monoio::spawn(async move {
        while !STOP.load(Ordering::SeqCst) {
            monoio::time::sleep(POLL).await;
        }
        let start = Instant::now();
        match save_sync(&art) {
            Ok(bytes) => {
                println!("[shutdown] save : {bytes} octets en {:?}", start.elapsed());
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!("[shutdown] échec de la save : {e}");
                std::process::exit(1);
            }
        }
    });
}

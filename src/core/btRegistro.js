/**
 * Registro locale delle righe di prova non ancora consegnate alla piattaforma: un file per fase,
 * scritto su un temporaneo e poi rinominato, cosi' non resta mai a meta'.
 *
 * Gli id delle fasi sono piccoli e la stessa macchina parla col locale e con la produzione dalla
 * stessa ~/.pinealgos: la fase 9 di una piattaforma non e' la fase 9 dell'altra. Con `ambito` (l'URL
 * di base della piattaforma) i file stanno in una sottocartella sua, ricavata da host e porta.
 */
import nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** "http://127.0.0.1:8000" -> "127.0.0.1_8000", "https://pinealgos.com/" -> "pinealgos.com". */
function cartellaDi(ambito) {
  let nome;
  try {
    const u = new URL(String(ambito));
    nome = u.port ? `${u.hostname}_${u.port}` : u.hostname;
  } catch {
    nome = String(ambito);
  }
  return nome.replace(/[^A-Za-z0-9.-]/g, '_') || '_';
}

export function creaRegistro({ dir = join(homedir(), '.pinealgos', 'campagne'), ambito = null, fs = nodeFs } = {}) {
  const base = ambito ? join(dir, cartellaDi(ambito)) : dir;
  const percorso = (phaseId) => join(base, `fase-${phaseId}.json`);
  return {
    leggi(phaseId) {
      try {
        return JSON.parse(fs.readFileSync(percorso(phaseId), 'utf8'));
      } catch {
        return null;
      }
    },
    scrivi(phaseId, dati) {
      fs.mkdirSync(base, { recursive: true });
      const finale = percorso(phaseId);
      const temp = `${finale}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(dati), 'utf8');
      fs.renameSync(temp, finale);
    },
    cancella(phaseId) {
      try {
        fs.rmSync(percorso(phaseId), { force: true });
      } catch { /* gia' assente */ }
    },
    /**
     * Mette da parte un file che non si puo' consegnare (di un'altra campagna, o con prove che la
     * fase non ha): non si cancella, perche' potrebbe servire a capire da dove viene.
     */
    scarta(phaseId) {
      const da = percorso(phaseId);
      if (!fs.existsSync(da)) return;
      const quando = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(da, join(base, `fase-${phaseId}.scartato-${quando}.json`));
    },
  };
}

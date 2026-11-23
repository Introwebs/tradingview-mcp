/**
 * Registro locale delle righe di prova non ancora consegnate alla piattaforma: un file per fase,
 * scritto su un temporaneo e poi rinominato, cosi' non resta mai a meta'.
 */
import nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function creaRegistro({ dir = join(homedir(), '.pinealgos', 'campagne'), fs = nodeFs } = {}) {
  const percorso = (phaseId) => join(dir, `fase-${phaseId}.json`);
  return {
    leggi(phaseId) {
      try {
        return JSON.parse(fs.readFileSync(percorso(phaseId), 'utf8'));
      } catch {
        return null;
      }
    },
    scrivi(phaseId, dati) {
      fs.mkdirSync(dir, { recursive: true });
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
  };
}

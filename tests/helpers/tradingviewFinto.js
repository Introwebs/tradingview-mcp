/**
 * Le dipendenze TradingView finte del nucleo per-prova (misuraProva), condivise dai test di
 * bt_prova e dal banco dello strumento di fase. Imitano `makeDeps` di bt_grind.test.js: chart finto
 * che tiene simbolo, timeframe, periodo e input; il modello del backtest esteso non leggibile;
 * `sleep` vuoto. Niente `api`, `captureScreenshot` ne' `setPanelMaximized`: il nucleo non deve
 * averne bisogno.
 */

// Un input di logica e una Proprieta' (Initial Capital: senza group, nome nella lista verificata).
export const INFO_FINTO = [
  { id: 'in_0', name: 'Risk/Reward', type: 'float', group: 'Ingressi' },
  { id: 'in_40', name: 'Initial Capital', type: 'float', group: null },
];

export const M = (over = {}) => ({
  net_profit: 100, net_profit_percent: 1, max_drawdown: 10, max_drawdown_percent: 0.5,
  profit_factor: 1.5, total_trades: 20, percent_profitable: 50,
  ...over,
});

export function creaTradingViewFinto({
  metricsSeq, metricheFerme = false,
  symbol = 'EURUSD', resolution = '15', periodo = { label: 'Storico completo', from: null, to: null },
} = {}) {
  // `call` avanza quando cambia qualcosa (input, symbol, timeframe, periodo), non a ogni lettura.
  let call = 0;
  const metricaCorrente = () => {
    if (call < metricsSeq.length) return metricsSeq[call];
    const ultimo = metricsSeq[metricsSeq.length - 1];
    return metricheFerme ? ultimo : { ...ultimo, net_profit: 100000 + call };
  };
  let applied = { in_0: 1, in_40: 10000 };
  let loadingPending = false;
  const chart = { symbol, resolution, periodo: { ...periodo }, setInputsChiamate: 0 };
  const now = () => performance.now();
  const deps = {
    setInputs: async ({ inputs }) => {
      chart.setInputsChiamate += 1;
      applied = { ...applied, ...inputs }; loadingPending = true; call += 1;
      return { updated_inputs: inputs, missing: [] };
    },
    readInputValues: async () => ({ ...applied }),
    readReportFor: async () => ({ success: true, metrics: metricaCorrente() }),
    readStrategyLoading: async () => {
      if (loadingPending) { loadingPending = false; return true; }
      return false;
    },
    readStudyStatus: async () => ({ ok: true, type: 0, error: null }),
    readCommissionFor: async () => ({ success: false, error: 'stub: commissioni non lette' }),
    setSymbol: async ({ symbol: s }) => { chart.symbol = s; call += 1; return { success: true }; },
    setTimeframe: async ({ timeframe }) => { chart.resolution = String(timeframe); call += 1; return { success: true }; },
    getChartState: async () => ({ symbol: chart.symbol, resolution: chart.resolution }),
    setCustomPeriod: async (from, to) => {
      chart.periodo = { label: `${from} — ${to}`, from, to };
      call += 1;
      return { applied: true, ...chart.periodo };
    },
    readTestPeriod: async () => ({ ...chart.periodo }),
    readPanelMetrics: async () => ({ success: true, source: 'panel', metrics: metricaCorrente() }),
    readPeriodReport: async () => ({ found: false, error: 'stub: report non disponibile' }),
    ensureTesterPanel: async () => ({ ok: true, altezza: 400 }),
    aggiornaReportSeObsoleto: async () => ({ obsoleto: false, cliccato: false }),
    attendiReportAggiornato: async () => ({ aggiornato: true, click: 0 }),
    readDeepState: async () => ({ found: false }),
    reportObsoleto: async () => false,
    sleep: async () => {},
    now,
  };
  return { deps, chart };
}

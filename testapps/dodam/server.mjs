// Dodam Work — fictional HR/groupware SaaS used as a demo customer site.
// Zero dependencies: node:http + node:sqlite. Listens on 127.0.0.1:3500.
//
//   node seed.mjs        # recreate data/dodam.db from scratch
//   node server.mjs      # DODAM_LABELS=v2 renames a few labels, DODAM_TODAY=YYYY-MM-DD moves "today"

// node:sqlite prints an ExperimentalWarning when it loads; drop the default
// warning printer before importing it (hence the dynamic import below).
process.removeAllListeners('warning');

const { startServer } = await import('./lib/app.mjs');
startServer();

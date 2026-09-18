// node:sqlite is still flagged experimental; that warning is noise for CLI users.
// Import this module before node:sqlite to drop just that one warning, keeping
// every other process warning visible.
const isSqliteExperimental = (warning) =>
  String(warning?.message ?? warning).includes('SQLite is an experimental feature');

const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (isSqliteExperimental(warning)) return;
  return originalEmitWarning.call(process, warning, ...rest);
};

// Node prints warnings from its own default 'warning' listener, so replace it.
const defaultListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (isSqliteExperimental(warning)) return;
  for (const listener of defaultListeners) listener(warning);
  if (defaultListeners.length === 0) console.error(`${warning.name}: ${warning.message}`);
});

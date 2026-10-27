/**
 * Knip preprocessor: drops the findings listed in knip.ts's `allow` and fails the run when an
 * entry matches nothing, so the list can only shrink.
 */
export default function applyAllowances(data) {
  const { allow = [] } = data.preprocessorOptions ? JSON.parse(data.preprocessorOptions) : {};
  const stale = [];
  for (const entry of allow) {
    if (!data.report[entry.type]) continue;
    const symbol = entry.symbol ?? entry.file;
    const records = data.issues[entry.type]?.[entry.file];
    if (records?.[symbol]) {
      delete records[symbol];
      if (Object.keys(records).length === 0) delete data.issues[entry.type][entry.file];
      data.counters[entry.type] -= 1;
    } else {
      stale.push(`${entry.type}  ${entry.file}${entry.symbol ? `  ${entry.symbol}` : ''}`);
    }
  }
  if (stale.length > 0) {
    console.error(`Allowances in knip.ts that match nothing; remove them (${stale.length}):`);
    for (const line of stale) console.error(`  ${line}`);
    process.exitCode = 1;
  }
  return data;
}

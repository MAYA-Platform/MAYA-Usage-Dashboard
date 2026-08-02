import fs from 'node:fs';
import path from 'node:path';

export const MAYA_BURN_RATE_VERSION = 'maya_burn_rate_v1';

const DEFAULT_COST_DB_PATH = null; // resolved from rootDir

/**
 * Resolve where balance-history.jsonl lives, in priority order:
 *   1. MAYA_BALANCE_HISTORY_PATH env var (explicit override)
 *   2. <rootDir>/maya-agent/state/balance-history.jsonl (repo-local, portable)
 * Returns the repo-local default for writing.
 */
export function resolveBalanceHistoryPath({ rootDir, envPath = process.env.MAYA_BALANCE_HISTORY_PATH } = {}) {
  if (envPath && envPath.trim()) return envPath.trim();
  return rootDir
    ? path.join(rootDir, 'maya-agent', 'state', 'balance-history.jsonl')
    : 'maya-agent/state/balance-history.jsonl';
}

/**
 * Append a balance point to the history file (self-populating burn rate).
 * Throttled: skips if the last recorded point for this provider is newer
 * than throttleHours. Creates the file + parent dirs on first write.
 * Returns { ok, recorded: boolean, reason? }.
 */
export function recordBalancePoint({
  filePath,
  provider,
  balance,
  timestamp = new Date().toISOString(),
  throttleHours = 1
} = {}) {
  if (!filePath || !provider || balance == null) {
    return { ok: false, recorded: false, reason: 'missing filePath/provider/balance' };
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lines = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim())
      : [];
    const last = [...lines].reverse().map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).find((e) => e && e.provider === provider);
    if (last && last.timestamp) {
      const lastMs = Date.parse(last.timestamp);
      const nowMs = Date.parse(timestamp);
      if (Number.isFinite(lastMs) && Number.isFinite(nowMs) && (nowMs - lastMs) < throttleHours * 3_600_000) {
        return { ok: true, recorded: false, reason: `within ${throttleHours}h throttle (last ${last.timestamp})` };
      }
    }
    const entry = {
      provider,
      balance: Number(balance),
      timestamp,
      tier: 'SELF',
      source: 'maya-server-burn-rate'
    };
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
    return { ok: true, recorded: true, point: entry };
  } catch (error) {
    return { ok: false, recorded: false, reason: error.message };
  }
}

export function parseTimestamp(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

export function hoursBetween(a, b) {
  return Math.abs(b - a) / 3_600_000;
}

/**
 * Read balance-history.jsonl produced by the provider balance watchdog.
 * Returns per-provider series of { timestamp, balanceMs: number|null, status }.
 */
export function readBalanceHistory(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'balance-history file not found' };
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim());
    const series = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const ts = parseTimestamp(entry.timestamp);
        if (!ts) continue;
        let balance = null;
        if (typeof entry.balance === 'number') balance = entry.balance;
        else if (entry.raw?.balance_infos?.[0]?.total_balance) {
          const parsed = Number(entry.raw.balance_infos[0].total_balance);
          if (Number.isFinite(parsed)) balance = parsed;
        }
        series.push({
          provider: String(entry.provider || 'unknown'),
          timestamp: entry.timestamp,
          epochMs: ts,
          balance,
          status: entry.status || (balance != null ? 'balance' : 'unknown'),
          tier: entry.tier || null,
          note: entry.note || null
        });
      } catch {
        // skip malformed line
      }
    }
    series.sort((a, b) => a.epochMs - b.epochMs);
    return { ok: true, entries: series };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Compute a dollars-per-day burn for one provider series using its balance
 * deltas over time (real money movement). Returns null when there are not
 * enough points or no measurable movement.
 */
export function computeProviderDailyBurn(entries) {
  const points = entries.filter((e) => e.balance != null);
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const hours = hoursBetween(first.epochMs, last.epochMs);
  if (hours < 1) return null;
  const delta = first.balance - last.balance; // positive = burned
  if (delta < 0) return null; // topped up or flat; cannot claim burn
  const perDay = (delta / hours) * 24;
  return {
    provider: first.provider,
    startBalance: first.balance,
    endBalance: last.balance,
    burned: delta,
    windowHours: hours,
    dailyBurn: perDay,
    firstSeen: first.timestamp,
    lastSeen: last.timestamp,
    points: points.length
  };
}

/**
 * Summarize the whole balance history into a burn-rate picture.
 * Also folds in cost-attribution estimates when present.
 */
export function buildBurnRate({
  rootDir,
  balanceHistoryPath = null,
  costSummary = null
} = {}) {
  const historyPath = balanceHistoryPath || resolveBalanceHistoryPath({ rootDir });
  const history = readBalanceHistory(historyPath);
  const byProvider = {};
  if (history.ok) {
    for (const entry of history.entries) {
      if (!byProvider[entry.provider]) byProvider[entry.provider] = [];
      byProvider[entry.provider].push(entry);
    }
  }

  const providers = Object.entries(byProvider).map(([name, entries]) => {
    const burn = computeProviderDailyBurn(entries);
    const last = entries[entries.length - 1];
    const first = entries[0];
    return {
      provider: name,
      lastBalance: last?.balance ?? null,
      lastStatus: last?.status ?? null,
      lastSeen: last?.timestamp ?? null,
      firstSeen: first?.timestamp ?? null,
      note: last?.note ?? null,
      dailyBurn: burn ? Number(burn.dailyBurn.toFixed(4)) : null,
      windowHours: burn ? Number(burn.windowHours.toFixed(1)) : null,
      burned: burn ? Number(burn.burned.toFixed(4)) : null,
      points: entries.length
    };
  }).sort((a, b) => (b.dailyBurn || 0) - (a.dailyBurn || 0));

  // Aggregate: only providers with a measurable burn contribute to total burn.
  const measurable = providers.filter((p) => p.dailyBurn != null && p.dailyBurn > 0);
  const totalDailyBurn = measurable.reduce((s, p) => s + p.dailyBurn, 0);
  const balances = providers
    .filter((p) => p.lastBalance != null)
    .map((p) => ({ provider: p.provider, balance: p.lastBalance }));
  const totalBalance = balances.reduce((s, b) => s + b.balance, 0);

  // Runway: current balance / daily burn. Only meaningful when both exist.
  let runwayDays = null;
  if (totalDailyBurn > 0 && totalBalance > 0) {
    runwayDays = Number((totalBalance / totalDailyBurn).toFixed(1));
  }

  // Cost-attribution fold-in (historical estimates, may be stale or empty).
  let costRows = null;
  if (costSummary && Array.isArray(costSummary.byProvider)) {
    costRows = costSummary.byProvider.map((row) => ({
      provider: row.provider || 'unknown',
      runs: row.runs || 0,
      estimatedCost: Number((row.cost || 0).toFixed(4))
    }));
  }

  return {
    ok: true,
    version: MAYA_BURN_RATE_VERSION,
    generatedAt: new Date().toISOString(),
    historyFile: history.ok ? historyPath : null,
    historyError: history.ok ? null : history.error,
    totalDailyBurn: Number(totalDailyBurn.toFixed(4)),
    totalBalance: Number(totalBalance.toFixed(4)),
    runwayDays,
    weeklyBurn: Number((totalDailyBurn * 7).toFixed(4)),
    monthlyBurn: Number((totalDailyBurn * 30).toFixed(4)),
    providers,
    costAttribution: costRows,
    notes: [
      'Burn is measured from real provider balance deltas over the observed window.',
      'Merge Gateway uses free monthly credits and exposes no balance endpoint, so its burn is not directly measurable.',
      'Providers with flat or topped-up balances are excluded from the burn total.'
    ]
  };
}

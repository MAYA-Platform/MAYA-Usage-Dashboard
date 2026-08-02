import fs from 'node:fs';
import path from 'node:path';
import { resolveBalanceHistoryPath, recordBalancePoint, buildBurnRate } from './mayaBurnRate.js';

export const MAYA_WATCHDOG_VERSION = 'maya_provider_watchdog_v1';
export const DEFAULT_ROTATION_DAYS = 90;

// Known balance endpoints. Each probe is optional — it only runs when the
// matching env key exists, so the watchdog adapts to whatever provider the
// user configured. Providers without a public balance endpoint are skipped
// with a note (they can still appear via manual history entries).
//
// Key lifecycle fields per probe:
//   rotationDays: after this many days since first seen, the watchdog
//     reminds the user to rotate the key (best practice for static keys).
//   refresh: OPTIONAL OAuth-style token refresh. Only providers that expose
//     a refresh flow get one. Static API keys (DeepSeek/OpenAI/Anthropic)
//     cannot be auto-rotated — no public rotate endpoint — so they get
//     detection + rotation reminders instead of silent self-refresh.
//     Signature: async (env) => { ok, newKey?, error?, instructions? }
const BALANCE_PROBES = [
  {
    id: 'deepseek',
    envKey: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek',
    rotationDays: 90,
    refresh: null, // static key, no public rotate endpoint
    async probe(apiKey) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch('https://api.deepseek.com/user/balance', {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal
        });
        const data = await response.json().catch(() => ({}));
        const balance = data.balance_infos?.[0]?.total_balance ?? null;
        return { ok: response.ok, balance: balance != null ? Number(balance) : null, error: response.ok ? undefined : (response.status === 401 ? 'auth failed' : `HTTP ${response.status}`) };
      } finally {
        clearTimeout(timer);
      }
    }
  },
  {
    id: 'openai',
    envKey: 'OPENAI_API_KEY',
    label: 'OpenAI',
    rotationDays: 90,
    refresh: null, // static key, no public rotate endpoint
    async probe(apiKey) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch('https://api.openai.com/v1/dashboard/billing/credit_grants', {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal
        });
        const data = await response.json().catch(() => ({}));
        const balance = data.total_granted != null ? data.total_granted - (data.total_used ?? 0) : null;
        return { ok: response.ok, balance, error: response.ok ? undefined : (response.status === 401 ? 'auth failed' : `HTTP ${response.status}`) };
      } finally {
        clearTimeout(timer);
      }
    }
  },
  {
    id: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    label: 'Anthropic',
    rotationDays: 90,
    refresh: null, // static key, no public rotate endpoint
    async probe(apiKey) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch('https://api.anthropic.com/v1/organizations/usage/billing', {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          signal: controller.signal
        });
        const data = await response.json().catch(() => ({}));
        const balance = data.balance ?? data.available_credit ?? null;
        return { ok: response.ok, balance: balance != null ? Number(balance) : null, error: response.ok ? undefined : (response.status === 401 ? 'auth failed' : `HTTP ${response.status}`) };
      } finally {
        clearTimeout(timer);
      }
    }
  }
];

// ---------------------------------------------------------------------------
// Key health classification
// ---------------------------------------------------------------------------

/**
 * Classify a single probe result into a key-health state.
 *   healthy     - probe succeeded and (if applicable) balance is visible
 *   connected   - probe succeeded but no balance endpoint visibility
 *   auth_failed - 401/403: the key is dead, expired, or lacks permission
 *   unreachable - network/endpoint failure: key may be fine, cannot confirm
 *   no_key      - provider not configured (no env key)
 */
export function classifyKeyHealth(probe) {
  if (!probe || !probe.configured) return 'no_key';
  if (probe.ok) {
    return probe.balance != null ? 'healthy' : 'connected';
  }
  const err = String(probe.error || '').toLowerCase();
  if (err.includes('auth') || err.includes('401') || err.includes('403') || err.includes('key')) {
    return 'auth_failed';
  }
  return 'unreachable';
}

const KEY_HEALTH_SEVERITY = {
  healthy: 0,
  connected: 0,
  unreachable: 1,
  auth_failed: 2,
  no_key: 0
};

export function keyHealthSeverity(state) {
  return KEY_HEALTH_SEVERITY[state] ?? 0;
}

/**
 * Build a key-health summary for all configured providers, including
 * rotation advisories based on how long the key has been in use (first
 * balance point in history).
 */
export function buildKeyHealth({ probed, burn, rotationDays = DEFAULT_ROTATION_DAYS, env = process.env } = {}) {
  const now = Date.now();
  const history = burn && burn.providers ? burn.providers : [];
  const firstSeenByProvider = {};
  for (const provider of history) {
    if (!firstSeenByProvider[provider.provider] && provider.firstSeen) {
      firstSeenByProvider[provider.provider] = provider.firstSeen;
    }
  }

  return (probed || []).map((probe) => {
    const state = classifyKeyHealth(probe);
    const firstSeen = firstSeenByProvider[probe.provider] || null;
    const ageDays = firstSeen ? (now - Date.parse(firstSeen)) / 86_400_000 : 0;
    const rotationDue = probe.rotationDays != null && ageDays > probe.rotationDays;
    return {
      provider: probe.provider,
      label: probe.label,
      state,
      severity: keyHealthSeverity(state),
      balance: probe.balance ?? null,
      error: probe.error || null,
      firstSeen,
      ageDays: firstSeen ? Number(ageDays.toFixed(1)) : null,
      rotationDays: probe.rotationDays ?? null,
      rotationDue,
      refreshAvailable: Boolean(probe.refresh),
      refresh: probe.refresh
        ? { available: true, note: 'OAuth-style refresh flow exists for this provider.' }
        : { available: false, note: 'Static API keys cannot be auto-rotated; rotate manually at the provider console.' }
    };
  });
}

// ---------------------------------------------------------------------------
// Probe + tick
// ---------------------------------------------------------------------------
export async function probeConfiguredProviders(env = process.env, probes = BALANCE_PROBES) {
  const results = [];
  for (const probe of probes) {
    const apiKey = env[probe.envKey];
    if (!apiKey || !apiKey.trim()) continue;
    try {
      const outcome = await probe.probe(apiKey.trim());
      results.push({
        provider: probe.id,
        label: probe.label,
        configured: true,
        ok: Boolean(outcome.ok),
        balance: outcome.balance ?? null,
        error: outcome.error || null,
        probedAt: new Date().toISOString()
      });
    } catch (error) {
      results.push({
        provider: probe.id,
        label: probe.label,
        configured: true,
        ok: false,
        balance: null,
        error: error.message,
        probedAt: new Date().toISOString()
      });
    }
  }
  return results;
}

/**
 * One watchdog tick: probe configured providers, record any balance points,
 * and summarize current state (including stale detection). This is the
 * shared watchdog used by both the in-server hourly tick and the standalone
 * tools/maya-usage-watchdog.mjs script.
 */
export async function runWatchdogTick({ rootDir = process.cwd(), env = process.env, probes = null } = {}) {
  const historyPath = resolveBalanceHistoryPath({ rootDir });
  const probed = probes ? probes : await probeConfiguredProviders(env);
  const recorded = [];
  for (const probe of probed) {
    if (probe.balance != null) {
      const outcome = recordBalancePoint({
        filePath: historyPath,
        provider: probe.provider,
        balance: probe.balance,
        throttleHours: 1
      });
      recorded.push({ provider: probe.provider, recorded: outcome.recorded, reason: outcome.reason || null });
    }
  }

  const burn = buildBurnRate({ rootDir, balanceHistoryPath: historyPath });

  // Stale detection: a provider with a balance in history but no fresh point
  // in 48h is likely misconfigured or dead. Providers with no key are absent.
  const now = Date.now();
  const stale = (burn.providers || [])
    .filter((p) => p.lastSeen)
    .map((p) => {
      const ageHours = (now - Date.parse(p.lastSeen)) / 3_600_000;
      return {
        provider: p.provider,
        lastSeen: p.lastSeen,
        ageHours: Number(ageHours.toFixed(1)),
        stale: ageHours > 48,
        warning: ageHours > 48 ? `no balance point in ${Math.round(ageHours)}h — provider may be misconfigured or the key may be invalid` : null
      };
    });

  // Key health + rotation advisories (the "dead key / refresh" layer).
  const keyHealth = buildKeyHealth({ probed, burn });

  // Security posture — what the watchdog does and does not touch. Keys are
  // only read from env in-memory, never logged, never stored, never sent.
  const security = {
    keysStored: false,
    keysLogged: false,
    keysInReports: false,
    historyStores: ['provider', 'balance', 'timestamp'],
    localOnly: true,
    telemetry: false,
    note: 'Provider keys are read from environment variables in-memory only. The balance history file stores provider, balance, and timestamp — never key material. No telemetry or outbound traffic beyond the provider balance endpoints themselves.'
  };

  return {
    ok: true,
    version: MAYA_WATCHDOG_VERSION,
    generatedAt: new Date().toISOString(),
    historyFile: historyPath,
    configuredProviders: probed.length,
    probes: probed,
    recorded,
    stale,
    staleCount: stale.filter((s) => s.stale).length,
    keyHealth,
    keyHealthSeverity: Math.max(0, ...keyHealth.map((k) => k.severity)),
    authFailures: keyHealth.filter((k) => k.state === 'auth_failed').map((k) => k.provider),
    rotationDue: keyHealth.filter((k) => k.rotationDue).map((k) => k.provider),
    security,
    burn: {
      totalDailyBurn: burn.totalDailyBurn,
      totalBalance: burn.totalBalance,
      runwayDays: burn.runwayDays
    }
  };
}

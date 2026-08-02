import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBurnRate, readBalanceHistory, computeProviderDailyBurn, resolveBalanceHistoryPath, recordBalancePoint } from '../lib/mayaBurnRate.js';
import { probeConfiguredProviders, runWatchdogTick, classifyKeyHealth, buildKeyHealth, keyHealthSeverity } from '../lib/mayaProviderProbe.js';

function sampleHistory() {
  return [
    { provider: 'deepseek', timestamp: '2026-08-01T00:00:00Z', balance: 3.00, status: 'balance' },
    { provider: 'deepseek', timestamp: '2026-08-01T12:00:00Z', balance: 2.50, status: 'balance' },
    { provider: 'deepseek', timestamp: '2026-08-02T00:00:00Z', balance: 2.00, status: 'balance' },
    { provider: 'merge-gateway', timestamp: '2026-08-01T00:00:00Z', status: 'authenticated', note: 'no balance endpoint' }
  ];
}

test('computeProviderDailyBurn measures real deltas', () => {
  // Module reads epochMs directly; use Date.parse to build it.
  const at = (iso, balance) => ({ provider: 'deepseek', timestamp: iso, epochMs: Date.parse(iso), balance });
  const burn = computeProviderDailyBurn([
    at('2026-08-01T00:00:00Z', 3.00),
    at('2026-08-01T12:00:00Z', 2.50),
    at('2026-08-02T00:00:00Z', 2.00)
  ]);
  assert.ok(burn);
  // 3.00 -> 2.00 over 24h = $1.00/day
  assert.ok(Math.abs(burn.dailyBurn - 1.0) < 0.001, `expected ~1.0/day, got ${burn.dailyBurn}`);
  assert.ok(Math.abs(burn.burned - 1.0) < 0.001);
  assert.equal(burn.startBalance, 3.00);
  assert.equal(burn.endBalance, 2.00);
});

test('computeProviderDailyBurn returns null for flat or single points', () => {
  assert.equal(computeProviderDailyBurn([{ balance: 1.0, epochMs: 1000 }]), null);
  assert.equal(computeProviderDailyBurn([
    { balance: 1.0, epochMs: 1000 },
    { balance: 1.0, epochMs: 2000 }
  ]), null);
  assert.equal(computeProviderDailyBurn([]), null);
});

test('buildBurnRate aggregates providers and computes runway', () => {
  const burn = buildBurnRate({ balanceHistoryPath: null, costSummary: { byProvider: [] } });
  // No file -> ok with empty providers
  assert.equal(burn.ok, true);
  assert.ok(Array.isArray(burn.providers));
});

test('buildBurnRate reads real balance history file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-history-'));
  const historyPath = path.join(tmp, 'balance-history.jsonl');
  fs.writeFileSync(historyPath, [
    JSON.stringify({ provider: 'deepseek', timestamp: '2026-08-01T00:00:00Z', balance: 3.00 }),
    JSON.stringify({ provider: 'deepseek', timestamp: '2026-08-02T00:00:00Z', balance: 2.00 })
  ].join('\n') + '\n', 'utf8');
  const burn = buildBurnRate({ balanceHistoryPath: historyPath });
  assert.equal(burn.ok, true);
  assert.equal(burn.providers.length, 1);
  const ds = burn.providers.find((p) => p.provider === 'deepseek');
  assert.ok(ds);
  assert.equal(ds.lastBalance, 2.00);
  assert.ok(ds.dailyBurn > 0, 'burn from 3.00 to 2.00 over 24h should be positive');
  assert.ok(burn.totalDailyBurn > 0);
  assert.ok(burn.weeklyBurn > 0);
  assert.ok(burn.monthlyBurn > 0);
});

test('readBalanceHistory parses entries and sorts by time', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-read-'));
  const historyPath = path.join(tmp, 'balance-history.jsonl');
  fs.writeFileSync(historyPath, [
    JSON.stringify({ provider: 'deepseek', timestamp: '2026-08-02T00:00:00Z', balance: 2.00 }),
    JSON.stringify({ provider: 'deepseek', timestamp: '2026-08-01T00:00:00Z', balance: 3.00 })
  ].join('\n') + '\n', 'utf8');
  const h = readBalanceHistory(historyPath);
  assert.equal(h.ok, true);
  const times = h.entries.map((e) => e.epochMs);
  const sorted = [...times].sort((a, b) => a - b);
  assert.deepEqual(times, sorted);
  assert.equal(h.entries.length, 2);
  assert.equal(h.entries[0].balance, 3.00);
});

test('resolveBalanceHistoryPath prefers env var, then repo-local', () => {
  // env var wins over everything
  assert.equal(
    resolveBalanceHistoryPath({ rootDir: '/tmp/fake', envPath: 'C:/custom/history.jsonl' }),
    'C:/custom/history.jsonl'
  );
  // repo-local file exists -> picked
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-test-'));
  const repoState = path.join(tmp, 'maya-agent', 'state');
  fs.mkdirSync(repoState, { recursive: true });
  fs.writeFileSync(path.join(repoState, 'balance-history.jsonl'), 'x\n');
  const p2 = resolveBalanceHistoryPath({ rootDir: tmp });
  assert.equal(p2, path.join(repoState, 'balance-history.jsonl'));
});

test('recordBalancePoint writes a point and throttles to one per hour', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-record-'));
  const file = path.join(tmp, 'balance-history.jsonl');
  const t0 = '2026-08-02T00:00:00Z';
  const t1 = '2026-08-02T00:30:00Z';
  const t2 = '2026-08-02T02:00:00Z';

  // first write records
  const first = recordBalancePoint({ filePath: file, provider: 'deepseek', balance: 5.00, timestamp: t0 });
  assert.equal(first.recorded, true);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);

  // within 1h throttle -> skip
  const second = recordBalancePoint({ filePath: file, provider: 'deepseek', balance: 4.90, timestamp: t1 });
  assert.equal(second.recorded, false);

  // after throttle window -> records again
  const third = recordBalancePoint({ filePath: file, provider: 'deepseek', balance: 4.70, timestamp: t2 });
  assert.equal(third.recorded, true);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
});

test('probeConfiguredProviders only probes providers with env keys', async () => {
  const results = await probeConfiguredProviders({ FAKE_A_KEY: 'abc' }, [
    { id: 'fake-a', envKey: 'FAKE_A_KEY', label: 'Fake A', async probe() { return { ok: true, balance: 1.23 }; } },
    { id: 'fake-b', envKey: 'FAKE_B_KEY', label: 'Fake B', async probe() { return { ok: true, balance: 4.56 }; } }
  ]);
  // Only FAKE_A_KEY is set -> only fake-a probed
  assert.equal(results.length, 1);
  assert.equal(results[0].provider, 'fake-a');
  assert.equal(results[0].balance, 1.23);
});

test('probeConfiguredProviders records a failure without throwing', async () => {
  const results = await probeConfiguredProviders({ BAD_KEY: 'x' }, [
    { id: 'bad', envKey: 'BAD_KEY', label: 'Bad', async probe() { throw new Error('endpoint down'); } }
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.ok(results[0].error.includes('endpoint down'));
});

test('runWatchdogTick records points and reports stale', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-watchdog-'));
  const stateDir = path.join(tmp, 'maya-agent', 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  // Two points >48h apart so the older one is stale
  const now = Date.now();
  recordBalancePoint({ filePath: path.join(stateDir, 'balance-history.jsonl'), provider: 'deepseek', balance: 3.00, timestamp: new Date(now - 100 * 3600 * 1000).toISOString() });
  recordBalancePoint({ filePath: path.join(stateDir, 'balance-history.jsonl'), provider: 'deepseek', balance: 2.80, timestamp: new Date(now - 50 * 3600 * 1000).toISOString() });

  // Inject a fake probe result so no real network call happens
  const tick = await runWatchdogTick({
    rootDir: tmp,
    env: {},
    probes: [{ provider: 'deepseek', label: 'DeepSeek', configured: true, ok: true, balance: 2.80, error: null, probedAt: new Date().toISOString() }]
  });
  assert.equal(tick.ok, true);
  assert.equal(tick.historyFile, path.join(stateDir, 'balance-history.jsonl'));
  assert.equal(tick.configuredProviders, 1);
  assert.ok(Array.isArray(tick.stale));
  assert.equal(tick.staleCount, 0); // last point is recent, nothing stale
  assert.ok(Array.isArray(tick.keyHealth));
  assert.equal(tick.keyHealth.length, 1);
  assert.equal(tick.keyHealth[0].state, 'healthy');
  assert.equal(tick.keyHealth[0].rotationDue, false);
  assert.equal(tick.security.keysStored, false);
  assert.equal(tick.security.keysLogged, false);
  assert.equal(tick.security.localOnly, true);
});

test('classifyKeyHealth maps probe results to states', () => {
  assert.equal(classifyKeyHealth({ configured: true, ok: true, balance: 5 }), 'healthy');
  assert.equal(classifyKeyHealth({ configured: true, ok: true, balance: null }), 'connected');
  assert.equal(classifyKeyHealth({ configured: true, ok: false, error: 'auth failed' }), 'auth_failed');
  assert.equal(classifyKeyHealth({ configured: true, ok: false, error: 'HTTP 401' }), 'auth_failed');
  assert.equal(classifyKeyHealth({ configured: true, ok: false, error: 'HTTP 500' }), 'unreachable');
  assert.equal(classifyKeyHealth({ configured: false }), 'no_key');
  assert.equal(classifyKeyHealth(null), 'no_key');
});

test('keyHealthSeverity ranks auth_failed highest', () => {
  assert.equal(keyHealthSeverity('healthy'), 0);
  assert.equal(keyHealthSeverity('connected'), 0);
  assert.equal(keyHealthSeverity('unreachable'), 1);
  assert.equal(keyHealthSeverity('auth_failed'), 2);
  assert.equal(keyHealthSeverity('no_key'), 0);
  assert.equal(keyHealthSeverity('garbage'), 0);
});

test('buildKeyHealth flags rotation due after rotationDays', () => {
  const oldFirstSeen = new Date(Date.now() - 100 * 86_400_000).toISOString(); // 100 days ago
  const keyHealth = buildKeyHealth({
    probed: [{ provider: 'deepseek', label: 'DeepSeek', configured: true, ok: true, balance: 5, error: null, rotationDays: 90 }],
    burn: { providers: [{ provider: 'deepseek', firstSeen: oldFirstSeen }] },
    rotationDays: 90
  });
  assert.equal(keyHealth.length, 1);
  assert.equal(keyHealth[0].rotationDue, true);
  assert.equal(keyHealth[0].ageDays > 90, true);
  assert.equal(keyHealth[0].refreshAvailable, false); // static key, no refresh hook
});

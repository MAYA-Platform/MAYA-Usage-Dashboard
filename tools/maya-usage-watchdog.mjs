#!/usr/bin/env node
/**
 * MAYA Usage Watchdog — standalone dashboard watchdog for the MAYA Usage Dashboard.
 *
 * Probes every provider whose key exists in the environment (DeepSeek,
 * OpenAI, Anthropic), records balance points to the burn-rate history, and
 * reports stale/misconfigured providers. Run it on a schedule (Windows Task
 * Scheduler, cron, systemd timer) or let the MAYA server's built-in hourly
 * tick do the same job with zero setup.
 *
 * Usage:
 *   node tools/maya-usage-watchdog.mjs            # one tick, compact report
 *   node tools/maya-usage-watchdog.mjs --json     # machine-readable report
 *   node tools/maya-usage-watchdog.mjs --quiet    # print only on problems
 *
 * Exit codes:
 *   0 = ok (possibly nothing configured / throttled)
 *   2 = stale or failing providers detected
 *   3 = tick failed
 */
import { runWatchdogTick } from '../lib/mayaProviderProbe.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const quiet = args.includes('--quiet');

async function main() {
  const tick = await runWatchdogTick({ rootDir: process.cwd(), env: process.env });

  if (asJson) {
    console.log(JSON.stringify(tick, null, 2));
  } else if (!quiet) {
    const recorded = (tick.recorded || []).filter((r) => r.recorded).map((r) => r.provider);
    const lines = [
      `MAYA usage watchdog — ${tick.generatedAt}`,
      `  configured providers: ${tick.configuredProviders}`,
      `  recorded points: ${recorded.length ? recorded.join(', ') : 'none (throttled or no balance)'}`,
      `  stale providers: ${tick.staleCount}`,
      `  key health: ${(tick.keyHealth || []).map((k) => `${k.label}: ${k.state}${k.rotationDue ? ' (rotation due)' : ''}`).join(', ') || 'none'}`
    ];
    for (const probe of tick.probes || []) {
      lines.push(`  ${probe.label} (${probe.provider}): ${probe.ok ? (probe.balance != null ? `balance $${probe.balance}` : 'ok, no balance endpoint') : `FAILED — ${probe.error}`}`);
    }
    for (const s of tick.stale || []) {
      lines.push(`  STALE ${s.provider}: ${s.warning}`);
    }
    for (const k of tick.keyHealth || []) {
      if (k.state === 'auth_failed') lines.push(`  AUTH FAILURE ${k.label}: key rejected (${k.error}) — rotate the key at the provider console`);
      if (k.rotationDue) lines.push(`  ROTATION DUE ${k.label}: key in use ${k.ageDays} days — rotate for best practice`);
    }
    lines.push(`  security: ${tick.security && tick.security.keysStored === false ? 'keys never stored/logged; local-only; no telemetry' : 'see security block'}`);
    console.log(lines.join('\n'));
  } else if (tick.staleCount > 0 || (tick.authFailures || []).length > 0) {
    for (const s of tick.stale || []) {
      console.log(`STALE ${s.provider}: ${s.warning}`);
    }
    for (const k of tick.keyHealth || []) {
      if (k.state === 'auth_failed') console.log(`AUTH FAILURE ${k.label}: ${k.error}`);
    }
  }

  const fatal = tick.staleCount > 0 || (tick.authFailures || []).length > 0;
  process.exit(fatal ? 2 : 0);
}

main().catch((error) => {
  console.error(`MAYA usage watchdog failed: ${error.message}`);
  process.exit(3);
});

#!/usr/bin/env node
/**
 * MAYA Usage Dashboard — standalone public server.
 *
 * Serves the public usage dashboard and its two API endpoints with zero
 * dependencies beyond Node's built-in runtime:
 *
 *   GET /                                 -> usage-dashboard-public.html
 *   GET /api/maya-agent/burn-rate         -> burn rate + provider watchdog
 *   GET /api/maya-agent/realtime-usage    -> provider health / usage snapshot
 *
 * The dashboard is provider-agnostic: it probes whatever provider keys exist
 * in the environment (DeepSeek, OpenAI, Anthropic) and records balance points
 * to a repo-local history file, so burn rate self-populates over time.
 *
 * Usage:
 *   node server.mjs                 # default port 8765
 *   PORT=9000 node server.mjs       # custom port
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBurnRate } from './lib/mayaBurnRate.js';
import { runWatchdogTick, probeConfiguredProviders } from './lib/mayaProviderProbe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8765);
const DASHBOARD_PATH = path.join(ROOT, 'public', 'usage-dashboard-public.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

async function handleBurnRate(req, res) {
  try {
    const rootDir = ROOT;
    let watchdog = null;
    try {
      watchdog = await runWatchdogTick({ rootDir, env: process.env });
    } catch (watchdogError) {
      watchdog = { ok: false, error: watchdogError.message };
    }

    // Cost attribution is intentionally not part of the public dashboard
    // (it reads agent-platform-specific logs). Burn rate works standalone.
    const historyPath = watchdog?.historyFile || null;
    const payload = buildBurnRate({ rootDir, balanceHistoryPath: historyPath, costSummary: null });
    payload.selfPopulated = watchdog?.recorded || [];
    payload.watchdog = watchdog
      ? {
          ok: watchdog.ok,
          version: watchdog.version,
          generatedAt: watchdog.generatedAt,
          configuredProviders: watchdog.configuredProviders,
          probes: watchdog.probes,
          stale: watchdog.stale,
          staleCount: watchdog.staleCount,
          keyHealth: watchdog.keyHealth || [],
          keyHealthSeverity: watchdog.keyHealthSeverity || 0,
          authFailures: watchdog.authFailures || [],
          rotationDue: watchdog.rotationDue || [],
          security: watchdog.security || null
        }
      : null;
    return sendJson(res, 200, payload);
  } catch (error) {
    return sendJson(res, 500, { ok: false, version: 'maya_burn_rate_v1', error: error.message });
  }
}

async function handleRealtimeUsage(req, res) {
  try {
    const probed = await probeConfiguredProviders(process.env);
    const providers = probed.map((p) => ({
      id: p.provider,
      label: p.label,
      configured: true,
      health: p.ok ? (p.balance != null ? 'healthy' : 'connected') : 'unreachable'
    }));

    // Minimal public-safe payload: the public dashboard only renders provider
    // health / balances from this endpoint. No internal state ever leaves
    // this server.
    return sendJson(res, 200, {
      ok: true,
      version: 'maya_realtime_usage_v1',
      fetchedAt: new Date().toISOString(),
      providers,
      providerHealth: { providers, readiness: { cloudConfigured: providers.length } }
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, version: 'maya_realtime_usage_v1', error: error.message });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/maya-agent/burn-rate') {
    return handleBurnRate(req, res);
  }
  if (req.method === 'GET' && pathname === '/api/maya-agent/realtime-usage') {
    return handleRealtimeUsage(req, res);
  }
  if (req.method === 'GET' && (pathname === '/' || pathname === '/usage-dashboard-public.html')) {
    return sendFile(res, DASHBOARD_PATH);
  }
  return sendJson(res, 404, { ok: false, error: 'not_found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MAYA Usage Dashboard running at http://127.0.0.1:${PORT}`);
});

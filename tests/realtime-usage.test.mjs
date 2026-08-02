import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 8899;

function startServer(env = {}) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(PORT), ...env },
    stdio: 'ignore'
  });
  return child;
}

function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (Date.now() > deadline) reject(new Error('server did not start'));
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

test('server serves the public dashboard at /', async () => {
  const child = startServer();
  try {
    await waitForServer();
    const html = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
    assert.ok(html.includes('MAYA Usage Dashboard'), 'dashboard HTML served');
  } finally {
    child.kill();
  }
});

test('realtime-usage returns minimal public payload (no internal state)', async () => {
  const child = startServer({ DEEPSEEK_API_KEY: 'sk-test-public' });
  try {
    await waitForServer();
    const data = await getJson('/api/maya-agent/realtime-usage');
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.providers));
    assert.ok(data.providerHealth && Array.isArray(data.providerHealth.providers));
    // Public contract: no internal state or config exposure
    for (const key of ['memoryUsage', 'triad', 'bridge', 'hermesHome', 'moe', 'crl', 'codex']) {
      assert.ok(!(key in data), `public payload must not contain ${key}`);
    }
  } finally {
    child.kill();
  }
});

test('burn-rate endpoint returns burn + watchdog shape', async () => {
  const child = startServer();
  try {
    await waitForServer();
    const data = await getJson('/api/maya-agent/burn-rate');
    assert.equal(data.ok, true);
    assert.ok('totalDailyBurn' in data);
    assert.ok('totalBalance' in data);
    assert.ok('watchdog' in data);
    assert.ok('security' in data.watchdog);
    assert.equal(data.watchdog.security.keysStored, false);
    assert.equal(data.watchdog.security.keysLogged, false);
    assert.equal(data.watchdog.security.keysInReports, false);
  } finally {
    child.kill();
  }
});

test('unknown route returns 404 JSON', async () => {
  const child = startServer();
  try {
    await waitForServer();
    const status = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/nope' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
    });
    assert.equal(status, 404);
  } finally {
    child.kill();
  }
});

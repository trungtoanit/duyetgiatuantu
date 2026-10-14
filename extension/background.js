import { DEFAULT_CONFIG } from './config.js';

const ALARM = 'sync-scripts';
let running = null;

async function getConfig() {
  const { config } = await chrome.storage.sync.get('config');
  return { ...DEFAULT_CONFIG, ...(config || {}) };
}

// chrome.userScripts chỉ dùng được khi người dùng bật "Allow User Scripts"
// (Chrome 138+) hoặc Developer mode (Chrome 120–137).
function userScriptsAvailable() {
  try {
    chrome.userScripts.getScripts().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function authHeaders(cfg) {
  return cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {};
}

// Lấy SHA commit mới nhất của nhánh. Đọc file theo SHA giúp tránh cache
// 5 phút của raw.githubusercontent.com.
async function resolveSha(cfg) {
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/commits/${encodeURIComponent(cfg.branch)}`;
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/vnd.github.sha', ...authHeaders(cfg) },
  });
  if (!res.ok) throw new Error(`GitHub API trả về ${res.status} (${url})`);
  return (await res.text()).trim();
}

async function fetchFile(cfg, ref, path) {
  const dir = cfg.dir.replace(/^\/+|\/+$/g, '');
  const url = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${ref}/${dir ? dir + '/' : ''}${path}`;
  const res = await fetch(url, { cache: 'no-store', headers: authHeaders(cfg) });
  if (!res.ok) throw new Error(`Không tải được ${path}: ${res.status}`);
  return res.text();
}

async function downloadBundle(cfg, sha) {
  const manifest = JSON.parse(await fetchFile(cfg, sha, 'manifest.json'));
  const scripts = await Promise.all(
    (manifest.scripts || []).map(async (s) => {
      const files = s.files || [s.file];
      const code = await Promise.all(
        files.map(async (f) => `${await fetchFile(cfg, sha, f)}\n//# sourceURL=duyetgia/${f}`),
      );
      return { ...s, files, code };
    }),
  );
  return { version: manifest.version || '', scripts };
}

async function register(bundle) {
  if (!userScriptsAvailable()) throw new Error('USER_SCRIPTS_DISABLED');
  await chrome.userScripts.unregister();
  const list = bundle.scripts
    .filter((s) => s.enabled !== false)
    .map((s) => {
      const item = {
        id: s.id,
        matches: s.matches,
        js: s.code.map((code) => ({ code })),
        runAt: s.runAt || 'document_idle',
        world: s.world || 'USER_SCRIPT',
        allFrames: !!s.allFrames,
      };
      if (s.excludeMatches) item.excludeMatches = s.excludeMatches;
      return item;
    });
  if (list.length) await chrome.userScripts.register(list);
}

async function setStatus(patch) {
  const { status } = await chrome.storage.local.get('status');
  await chrome.storage.local.set({ status: { ...(status || {}), ...patch } });
}

async function doSync(force) {
  const cfg = await getConfig();
  const { sha: currentSha, bundle } = await chrome.storage.local.get(['sha', 'bundle']);
  try {
    const sha = await resolveSha(cfg);
    if (!force && sha === currentSha && bundle) {
      await register(bundle); // đảm bảo script vẫn được đăng ký
      await setStatus({ lastCheck: Date.now(), error: null });
      return;
    }
    const next = await downloadBundle(cfg, sha);
    await register(next);
    await chrome.storage.local.set({ sha, bundle: next });
    await setStatus({ lastCheck: Date.now(), lastUpdate: Date.now(), error: null });
  } catch (e) {
    // Mất mạng / lỗi GitHub: vẫn chạy bản đã lưu gần nhất.
    if (bundle) await register(bundle).catch(() => {});
    await setStatus({ lastCheck: Date.now(), error: String(e.message || e) });
  }
}

function sync(force = false) {
  if (!running) running = doSync(force).finally(() => (running = null));
  return running;
}

async function scheduleAlarm() {
  const cfg = await getConfig();
  await chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, Number(cfg.intervalMinutes) || 5) });
}

chrome.runtime.onInstalled.addListener(async () => {
  await scheduleAlarm();
  await sync(true);
});

chrome.runtime.onStartup.addListener(() => sync());

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) sync();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'sync' && changes.config) {
    await scheduleAlarm();
    await sync(true);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'syncNow') await sync(true);
    const [cfg, local] = await Promise.all([
      getConfig(),
      chrome.storage.local.get(['sha', 'bundle', 'status']),
    ]);
    sendResponse({
      config: cfg,
      sha: local.sha,
      version: local.bundle?.version,
      scripts: (local.bundle?.scripts || []).map(({ code, ...s }) => s),
      status: local.status || {},
      userScriptsAvailable: userScriptsAvailable(),
    });
  })();
  return true;
});

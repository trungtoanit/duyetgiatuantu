import { DEFAULT_CONFIG } from './config.js';

const ALARM = 'sync-scripts';
let running = null;

async function getConfig() {
  const { config } = await chrome.storage.sync.get('config');
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  if (Number(cfg.intervalMinutes) === 5) cfg.intervalMinutes = 1; // mặc định cũ 5 phút → 1 phút
  return cfg;
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
// Lấy SHA commit mới nhất của nhánh. Repo public: đọc trang commits.atom của GitHub (luôn mới,
// không tính vào giới hạn 60 lần/giờ của API) nên kiểm tra mỗi phút được. Repo private (có token)
// hoặc atom lỗi: dùng GitHub API. Đọc file theo SHA giúp tránh cache của raw.githubusercontent.com.
async function resolveSha(cfg) {
  if (!cfg.token) {
    try {
      const res = await fetch(`https://github.com/${cfg.owner}/${cfg.repo}/commits/${encodeURIComponent(cfg.branch)}.atom`, {
        cache: 'no-store',
      });
      const sha = res.ok && (await res.text()).match(/Commit\/([0-9a-f]{40})/)?.[1];
      if (sha) return sha;
    } catch {}
  }
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
  // Cho script ở world USER_SCRIPT gọi chrome.runtime.sendMessage về background.
  await chrome.userScripts.configureWorld({ messaging: true });
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
  await chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, Number(cfg.intervalMinutes) || 1) });
}

chrome.runtime.onInstalled.addListener(async () => {
  await scheduleAlarm();
  await sync(true);
});

chrome.runtime.onStartup.addListener(() => {
  sync();
  pullRemote();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) {
    sync();
    pullRemote();
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'sync' && changes.config) {
    await scheduleAlarm();
    await sync(true);
  }
});

// ---- Dịch vụ cho các script trên git (lưu trữ + gọi Claude) ----
// Script chạy trong trang chỉ gọi qua đây, nên API key không bao giờ lộ ra trang web.

let kvQueue = Promise.resolve();
function kvSerial(fn) {
  const p = kvQueue.then(fn);
  kvQueue = p.catch(() => {});
  return p;
}
const kvKey = (key) => `kv:${key}`;

async function kvGet(key) {
  const o = await chrome.storage.local.get(kvKey(key));
  return o[kvKey(key)] ?? null;
}

// ---- Theo dõi chi phí Claude ----
// API key thường không đọc được số dư tài khoản Anthropic, nên extension tự cộng chi phí từ `usage`
// của mỗi lần gọi (giá USD / 1 triệu token). Người dùng nhập số dư hiện tại trong popup để tính số còn lại.
const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01 },
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5 },
};
const vnDate = (t = Date.now()) => new Date(t + 7 * 3600 * 1000).toISOString().slice(0, 10); // ngày theo giờ VN

function costOf(model, u = {}) {
  const p = PRICES[model] || PRICES['claude-opus-5-5'];
  const cacheWrite = (u.cache_creation_input_tokens || 0) * p.in * 1.25;
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_read_input_tokens || 0) * p.cacheRead + cacheWrite) / 1e6;
}

let spendQueue = Promise.resolve();
function addSpend(usd) {
  spendQueue = spendQueue.then(async () => {
    const { spend = { total: 0, days: {} } } = await chrome.storage.sync.get('spend');
    const day = vnDate();
    spend.total = (spend.total || 0) + usd;
    spend.days = spend.days || {};
    spend.days[day] = (spend.days[day] || 0) + usd;
    const keep = Object.keys(spend.days).sort().slice(-62); // giữ ~2 tháng
    spend.days = Object.fromEntries(keep.map((d) => [d, spend.days[d]]));
    await chrome.storage.sync.set({ spend });
  }).catch(() => {});
  return spendQueue;
}

async function getSpend() {
  const { spend = { total: 0, days: {} }, balance } = await chrome.storage.sync.get(['spend', 'balance']);
  const today = vnDate();
  const month = today.slice(0, 7);
  const sum = (pred) => Object.entries(spend.days || {}).filter(([d]) => pred(d)).reduce((a, [, v]) => a + v, 0);
  const out = { today: sum((d) => d === today), month: sum((d) => d.startsWith(month)), total: spend.total || 0 };
  if (balance?.amount != null) {
    out.balance = balance.amount;
    out.balanceAt = balance.at;
    out.remaining = balance.amount - (out.total - (balance.totalAtSet || 0));
  }
  return out;
}

async function setBalance(amount) {
  const { spend = { total: 0 } } = await chrome.storage.sync.get('spend');
  await chrome.storage.sync.set({ balance: { amount: Number(amount), at: Date.now(), totalAtSet: spend.total || 0 } });
}

async function callClaude({ system, prompt, maxTokens = 16000 }) {
  const cfg = await getConfig();
  if (!cfg.anthropicKey) throw new Error('Chưa nhập Anthropic API key trong popup của extension.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: cfg.model || 'claude-opus-5-5',
      max_tokens: maxTokens,
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message || `Claude API lỗi ${res.status}`);
  await addSpend(costOf(j.model || cfg.model, j.usage)); // tính cả khi bị từ chối (vẫn bị tính tiền)
  if (j.stop_reason === 'refusal') throw new Error('Claude từ chối xử lý yêu cầu này.');
  return j.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// ---- Đồng bộ dữ liệu giữa các máy qua Supabase ----
// Bảng dg_items(ns, id, data, updated_at): mỗi báo giá / bình luận / gợi ý... là 1 dòng.
// Bảo vệ bằng RLS + header x-team-secret (mật khẩu nhóm). Thông tin kết nối chỉ nhập trong popup.
// Không đồng bộ: 'me' (tài khoản CRM của từng người), settings, khoá/ trạng thái thu thập.
const SYNC_NS = ['quotes', 'comments', 'suggests', 'evals', 'collected'];

async function remoteCfg() {
  const cfg = await getConfig();
  if (!cfg.supabaseUrl || !cfg.supabaseKey || !cfg.teamSecret) return null;
  return {
    url: `${cfg.supabaseUrl.replace(/\/+$/, '')}/rest/v1/dg_items`,
    headers: {
      apikey: cfg.supabaseKey,
      Authorization: `Bearer ${cfg.supabaseKey}`,
      'x-team-secret': cfg.teamSecret,
      'content-type': 'application/json',
    },
  };
}

async function setSyncStatus(patch) {
  const { syncStatus } = await chrome.storage.local.get('syncStatus');
  await chrome.storage.local.set({ syncStatus: { ...(syncStatus || {}), ...patch } });
}

async function pushRemote(ns, patch) {
  try {
    const rc = await remoteCfg();
    if (!rc) return;
    const rows = Object.entries(patch).map(([id, data]) => ({ ns, id: String(id), data }));
    for (let i = 0; i < rows.length; i += 500) {
      const res = await fetch(rc.url, {
        method: 'POST',
        headers: { ...rc.headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows.slice(i, i + 500)),
      });
      if (!res.ok) throw new Error(`Đẩy dữ liệu lỗi ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    await setSyncStatus({ lastPush: Date.now(), error: null });
  } catch (e) {
    await setSyncStatus({ error: String(e.message || e) });
  }
}

// Gộp bình luận theo id luồng (không ghi đè mất luồng mà máy này đã có)
function mergeEntry(ns, local, remote) {
  if (ns !== 'comments' || !local?.threads) return remote;
  const m = new Map(local.threads.map((t) => [t.id, t]));
  for (const t of remote.threads || []) m.set(t.id, t);
  return { ...remote, threads: [...m.values()].sort((a, b) => a.createdAt - b.createdAt) };
}

let pulling = null;
function pullRemote() {
  if (!pulling) pulling = doPull().finally(() => (pulling = null));
  return pulling;
}
async function doPull() {
  try {
    const rc = await remoteCfg();
    if (!rc) return;
    const { syncCursor } = await chrome.storage.local.get('syncCursor');
    let cursor = syncCursor || '1970-01-01T00:00:00Z';
    for (let page = 0; page < 50; page++) {
      const q = `?select=ns,id,data,updated_at&updated_at=gt.${encodeURIComponent(cursor)}&order=updated_at.asc&limit=1000`;
      const res = await fetch(rc.url + q, { headers: rc.headers, cache: 'no-store' });
      if (!res.ok) throw new Error(`Kéo dữ liệu lỗi ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const rows = await res.json();
      if (!rows.length) break;
      const byNs = {};
      for (const r of rows) (byNs[r.ns] ||= []).push(r);
      await kvSerial(async () => {
        for (const [ns, list] of Object.entries(byNs)) {
          if (!SYNC_NS.includes(ns)) continue;
          const cur = (await kvGet(ns)) || {};
          for (const r of list) cur[r.id] = mergeEntry(ns, cur[r.id], r.data);
          await chrome.storage.local.set({ [kvKey(ns)]: cur });
        }
      });
      cursor = rows[rows.length - 1].updated_at;
      await chrome.storage.local.set({ syncCursor: cursor });
      if (rows.length < 1000) break;
    }
    await setSyncStatus({ lastPull: Date.now(), error: null });
  } catch (e) {
    await setSyncStatus({ error: String(e.message || e) });
  }
}

// Lần đầu bật đồng bộ: đẩy toàn bộ dữ liệu máy này lên rồi kéo dữ liệu các máy khác về
async function syncAllNow() {
  if (!(await remoteCfg())) throw new Error('Chưa nhập đủ Supabase URL, key và mật khẩu nhóm.');
  for (const ns of SYNC_NS) {
    const data = (await kvGet(ns)) || {};
    if (Object.keys(data).length) await pushRemote(ns, data);
  }
  await chrome.storage.local.remove('syncCursor');
  await pullRemote();
}

const services = {
  'kv.get': ({ key }) => kvGet(key),
  'kv.set': ({ key, value }) => kvSerial(() => chrome.storage.local.set({ [kvKey(key)]: value })),
  // Gộp nông một object map (vd. quotes theo id) – chạy tuần tự để không mất dữ liệu.
  'kv.merge': ({ key, patch }) =>
    kvSerial(async () => {
      const cur = (await kvGet(key)) || {};
      await chrome.storage.local.set({ [kvKey(key)]: Object.assign(cur, patch) });
      if (SYNC_NS.includes(key)) pushRemote(key, patch); // đồng bộ lên máy chủ (không chờ)
    }),
  claude: callClaude,
  'spend.get': getSpend,
};

chrome.runtime.onUserScriptMessage.addListener((msg, _sender, sendResponse) => {
  const fn = services[msg?.type];
  if (!fn) return false;
  Promise.resolve(fn(msg))
    .then((result) => sendResponse({ result }))
    .catch((e) => sendResponse({ error: String(e.message || e) }));
  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'syncNow') await sync(true);
    if (msg.type === 'setBalance') await setBalance(msg.amount);
    if (msg.type === 'syncAll') await syncAllNow().catch((e) => setSyncStatus({ error: String(e.message || e) }));
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
      spend: await getSpend(),
      syncStatus: (await chrome.storage.local.get('syncStatus')).syncStatus || {},
      syncEnabled: !!(await remoteCfg()),
    });
  })();
  return true;
});

const $ = (id) => document.getElementById(id);
const form = $('form');

// "vừa xong", "3 phút trước", "2 giờ trước"…
function ago(ts) {
  if (!ts) return '–';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} giờ trước` : new Date(ts).toLocaleString('vi-VN');
}

function render(data) {
  const { config, sha, version, scripts, status, userScriptsAvailable } = data;
  $('warn').hidden = userScriptsAvailable;
  $('repo').textContent = `${config.owner}/${config.repo} · ${config.branch}`;
  $('sha').textContent = sha ? sha.slice(0, 7) : '–';
  $('version').textContent = version || '–';
  $('lastCheck').textContent = ago(status.lastCheck);
  $('lastCheck').title = status.lastCheck ? new Date(status.lastCheck).toLocaleString('vi-VN') : '';
  $('error').textContent = status.error ? `Lỗi: ${status.error}` : '';

  const bad = !userScriptsAvailable || !!status.error;
  $('pill').classList.toggle('err', bad);
  $('pillText').textContent = !userScriptsAvailable ? 'Chưa bật' : status.error ? 'Có lỗi' : 'Đang chạy';

  const usd = (n) => `$${(n || 0).toFixed(2)}`;
  if (data.spend) {
    const { today, month, remaining, balance } = data.spend;
    $('spendToday').textContent = usd(today);
    $('spendMonth').textContent = usd(month);
    const low = remaining != null && remaining < 5;
    $('remaining').textContent = remaining != null ? usd(remaining) : 'chưa nhập';
    $('remaining').classList.toggle('low', low);
    const pct = remaining != null && balance ? Math.max(0, Math.min(100, (remaining / balance) * 100)) : 0;
    $('remainBar').style.width = `${pct}%`;
    $('remainBar').classList.toggle('low', low);
    if (balance != null && !$('balance').value) $('balance').value = balance;
  } else {
    $('remaining').textContent = 'cần tải lại extension';
  }

  const ss = data.syncStatus || {};
  $('syncInfo').textContent = !data.syncEnabled
    ? 'Chưa bật – nhập Supabase URL, key và mật khẩu nhóm trong Cài đặt'
    : `🟢 Tự đồng bộ ngầm · kéo về ${ago(ss.lastPull)} · đẩy lên ${ago(ss.lastPush)}`;
  $('syncInfo').title = ss.pushed ? `Đã đẩy: ${Object.entries(ss.pushed).map(([k, v]) => `${k} ${v}`).join(', ')}` : '';
  $('syncAll').disabled = !data.syncEnabled;
  $('syncErr').textContent = ss.error ? `Lỗi đồng bộ: ${ss.error}` : '';

  const box = $('scripts');
  box.replaceChildren();
  for (const s of scripts) {
    const chip = document.createElement('span');
    chip.className = `chip${s.enabled === false ? ' off' : ''}`;
    chip.textContent = s.id;
    chip.title = s.matches.join(', ');
    box.append(chip);
  }
  if (!scripts.length) box.innerHTML = '<span class="muted">Chưa có script</span>';

  for (const [k, v] of Object.entries(config)) {
    if (form.elements[k] && document.activeElement !== form.elements[k]) form.elements[k].value = v;
  }
  $('teamInfo').textContent = [
    data.hasTeamFile ? '✅ Kết nối đồng bộ lấy sẵn từ gói cài (team.json).' : '',
    data.teamShared ? '✅ Đang dùng Anthropic key chung của nhóm.' : '',
  ].filter(Boolean).join(' ');
}

async function send(type) {
  render(await chrome.runtime.sendMessage({ type }));
}

$('sync').onclick = async () => {
  $('sync').disabled = true;
  $('sync').textContent = 'Đang cập nhật…';
  await send('syncNow');
  // Cập nhật xong → tự tải lại tab CRM đang mở để chạy bản mới
  // Tải lại MỌI tab CRM đang mở (tab cũ còn chạy bản script cũ sẽ ghi đè dữ liệu bằng định dạng cũ)
  const tabs = await chrome.tabs.query({ url: 'https://sale.tuantu.com.vn/*' });
  if (tabs.length) {
    $('sync').textContent = `Đang tải lại ${tabs.length} tab CRM…`;
    await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id, { bypassCache: true }).catch(() => {})));
  }
  $('sync').disabled = false;
  $('sync').textContent = '⟳ Cập nhật ngay';
};

$('reload').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.reload(tab.id);
};

$('syncAll').onclick = async () => {
  $('syncAll').disabled = true;
  $('syncAll').textContent = '…';
  render(await chrome.runtime.sendMessage({ type: 'syncAll' }));
  $('syncAll').textContent = '↻';
};

$('saveBalance').onclick = async () => {
  const amount = Number($('balance').value);
  if (!Number.isFinite(amount)) return;
  render(await chrome.runtime.sendMessage({ type: 'setBalance', amount }));
};

$('openExt').onclick = () => {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
};

form.onsubmit = async (e) => {
  e.preventDefault();
  const config = Object.fromEntries(new FormData(form));
  config.intervalMinutes = Number(config.intervalMinutes) || 1;
  await chrome.storage.sync.set({ config }); // background tự đồng bộ lại khi config đổi
  if ($('shareTeam').checked && config.anthropicKey) {
    await chrome.runtime.sendMessage({ type: 'shareTeam', anthropicKey: config.anthropicKey, model: config.model });
  }
  setTimeout(() => send('getStatus'), 1500);
};

// ---- Tính năng trên CRM (lưu chung kho dữ liệu với script trên trang: chrome.storage.local "kv:*") ----
const KV = (k) => `kv:${k}`;
async function loadCrm() {
  const o = await chrome.storage.local.get([KV('settings'), KV('collectStatus'), KV('collected'), KV('fullCollect'), KV('quotes')]);
  const st = { auto: true, autoOpen: false, ...(o[KV('settings')] || {}) };
  $('optAuto').checked = !!st.auto;
  $('optAutoOpen').checked = !!st.autoOpen;
  const c = o[KV('collectStatus')];
  const n = Object.keys(o[KV('collected')] || {}).length;
  let text = `Đã thu thập ${n} báo giá`;
  if (c?.running && Date.now() - c.at < 120000) {
    text = c.current === 'phân tích'
      ? `Đang soạn gợi ý (${c.suggested})…`
      : /^danh sách/.test(c.current) ? `Đang đọc ${c.current}…` : `Đang đọc ${c.current} (${c.done}/${c.total})…`;
  } else if (c?.lastRun) {
    text += ` · lần cuối ${ago(c.lastRun)}: ${c.done} báo giá, ${c.suggested} gợi ý`;
  }
  $('collectStatus').textContent = text;
  const fc = o[KV('fullCollect')];
  const total = Object.keys(o[KV('quotes')] || {}).length;
  if (fc?.on) {
    $('fullStatus').textContent = `Đang thu thập toàn bộ: ${fc.listDone ? `đã đọc danh sách (${total} báo giá)` : 'đang đọc các trang danh sách…'}${c?.full && c.remaining != null ? ` · còn ${c.remaining} báo giá chưa đọc bình luận` : ''}`;
    $('fullCollect').textContent = '⏹ Dừng';
  } else {
    $('fullStatus').textContent = fc?.doneAt
      ? `Đã thu thập toàn bộ xong lúc ${new Date(fc.doneAt).toLocaleString('vi-VN')} (${total} báo giá)`
      : 'Đọc tất cả báo giá + bình luận và đẩy lên máy chủ (chạy liên tục tới khi xong)';
    $('fullCollect').textContent = '📦 Thu thập toàn bộ';
  }
}
async function saveSetting(patch) {
  const o = await chrome.storage.local.get(KV('settings'));
  await chrome.storage.local.set({ [KV('settings')]: { auto: true, autoOpen: false, ...(o[KV('settings')] || {}), ...patch } });
}
$('optAuto').onchange = (e) => saveSetting({ auto: e.target.checked });
$('optAutoOpen').onchange = (e) => saveSetting({ autoOpen: e.target.checked });
$('collectNow').onclick = async () => {
  await chrome.storage.local.set({ [KV('collectNow')]: Date.now() }); // tab CRM đang mở sẽ bắt đầu trong vài giây
  $('collectStatus').textContent = 'Đã yêu cầu – tab CRM đang mở sẽ bắt đầu trong vài giây…';
};
$('fullCollect').onclick = async () => {
  const o = await chrome.storage.local.get(KV('fullCollect'));
  const cur = o[KV('fullCollect')] || {};
  await chrome.storage.local.set({ [KV('fullCollect')]: cur.on ? { ...cur, on: false } : { on: true, startedAt: Date.now() } });
  loadCrm();
};
loadCrm();
setInterval(loadCrm, 2000);

send('getStatus');

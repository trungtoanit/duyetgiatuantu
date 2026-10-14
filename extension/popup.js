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
    if (form.elements[k]) form.elements[k].value = v;
  }
}

async function send(type) {
  render(await chrome.runtime.sendMessage({ type }));
}

$('sync').onclick = async () => {
  $('sync').disabled = true;
  $('sync').textContent = 'Đang cập nhật…';
  await send('syncNow');
  // Cập nhật xong → tự tải lại tab CRM đang mở để chạy bản mới
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /^https:\/\/sale\.tuantu\.com\.vn\//.test(tab.url || '')) {
    $('sync').textContent = 'Đang tải lại trang…';
    await chrome.tabs.reload(tab.id, { bypassCache: true });
  }
  $('sync').disabled = false;
  $('sync').textContent = '⟳ Cập nhật ngay';
};

$('reload').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.reload(tab.id);
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
  setTimeout(() => send('getStatus'), 1500);
};

send('getStatus');

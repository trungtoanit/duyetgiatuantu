const $ = (id) => document.getElementById(id);
const form = $('form');

function fmt(ts) {
  return ts ? new Date(ts).toLocaleString('vi-VN') : '–';
}

function render(data) {
  const { config, sha, version, scripts, status, userScriptsAvailable } = data;
  $('warn').hidden = userScriptsAvailable;
  $('repo').textContent = `${config.owner}/${config.repo}@${config.branch}`;
  $('sha').textContent = sha ? sha.slice(0, 7) : '–';
  $('version').textContent = version || '–';
  $('lastCheck').textContent = fmt(status.lastCheck);
  $('error').textContent = status.error ? `Lỗi: ${status.error}` : '';
  const usd = (n) => `$${(n || 0).toFixed(2)}`;
  if (data.spend) {
    $('spend').textContent = `${usd(data.spend.today)} / ${usd(data.spend.month)}`;
    $('remaining').textContent = data.spend.remaining != null ? usd(data.spend.remaining) : 'chưa nhập số dư';
    if (data.spend.balance != null && !$('balance').value) $('balance').value = data.spend.balance;
  }

  const ul = $('scripts');
  ul.replaceChildren();
  for (const s of scripts) {
    const li = document.createElement('li');
    li.textContent = `${s.id}${s.enabled === false ? ' (tắt)' : ''} — ${s.matches.join(', ')}`;
    ul.append(li);
  }
  if (!scripts.length) ul.innerHTML = '<li class="muted">Chưa có</li>';

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
  $('sync').textContent = 'Cập nhật ngay';
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

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
  $('sync').disabled = false;
  $('sync').textContent = 'Cập nhật ngay';
};

$('reload').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.reload(tab.id);
};

$('openExt').onclick = () => {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
};

form.onsubmit = async (e) => {
  e.preventDefault();
  const config = Object.fromEntries(new FormData(form));
  config.intervalMinutes = Number(config.intervalMinutes) || 5;
  await chrome.storage.sync.set({ config }); // background tự đồng bộ lại khi config đổi
  setTimeout(() => send('getStatus'), 1500);
};

send('getStatus');

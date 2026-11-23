// Chạy trong world USER_SCRIPT trên www.google.com/maps (chỉ đọc – không bấm lưu / đánh giá / sửa gì trên Google Maps).
// Đọc địa chỉ các công ty trên Google Maps → kv 'mapsPlaces' (đồng bộ cloud) để bảng Trợ lý ERP dùng (đối chiếu địa chỉ khách, giao hàng…):
//  • Mở 1 địa điểm (bảng chi tiết bên trái) → tự lưu: tên, loại hình, địa chỉ đầy đủ, SĐT, website, Plus code, toạ độ.
//  • Danh sách kết quả tìm kiếm (vd. tìm "công ty") → nút "⬇️ Lưu danh sách" tự cuộn hết danh sách và lưu từng công ty.
//  • Nút "🔍 Quét công ty màn hình này" → tìm "công ty" tại vùng bản đồ đang xem rồi tự lưu danh sách.
(() => {
  if (window.top !== window || window.__dgMaps) return;
  window.__dgMaps = true;

  const call = (msg) =>
    new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return reject(new Error('no runtime'));
      chrome.runtime.sendMessage(msg, (r) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else if (r?.error) reject(new Error(r.error));
        else resolve(r?.result);
      });
    });
  const kvGet = async (key) => (await call({ type: 'kv.get', key })) || {};
  const kvMerge = (key, patch) => call({ type: 'kv.merge', key, patch });
  // 🤖 AI luôn dùng OpenAI (không dùng Claude API nữa): key + model lấy từ kv 'aiCfg' (cài ở bảng Trợ lý ERP › ⚙️ Cài đặt)
  async function aiAsk({ system, prompt, maxTokens }) {
    const c = (await kvGet('aiCfg').catch(() => ({}))) || {};
    if (!c.openaiKey) throw new Error('Chưa cài OpenAI API key (bảng Trợ lý ERP › ⚙️ Cài đặt › AI của dự án)');
    const body = { model: c.openaiModel || 'gpt-4.1-mini', messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }] };
    if (maxTokens) body.max_completion_tokens = maxTokens;
    const res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.openaiKey}` }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OpenAI: ${j.error?.message || `lỗi ${res.status}`}`);
    return j.choices?.[0]?.message?.content || '';
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const KEY = 'mapsPlaces';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // id địa điểm (0x…:0x…) + toạ độ từ đường dẫn /maps/place/…/data=…!1s0x…:0x…!…!3d<lat>!4d<lng>
  const fromUrl = (u) => {
    const s = decodeURIComponent(String(u || ''));
    const id = (s.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i) || [])[1] || '';
    const lat = Number((s.match(/!3d(-?\d+\.\d+)/) || [])[1]) || null;
    const lng = Number((s.match(/!4d(-?\d+\.\d+)/) || [])[1]) || null;
    const name = ((s.match(/\/maps\/place\/([^/@]+)/) || [])[1] || '').replace(/\+/g, ' ').trim();
    return { id, lat, lng, name };
  };
  const PHONE_RE = /(\+84|0)(\s?\d){8,10}/;
  // SĐT di động (03/05/07/08/09) nổi bật (xanh đậm, nền xanh nhạt, 📱); số bàn (02…) màu xám nhạt (☎)
  function phoneHtml(p) {
    let d = String(p || '').replace(/\D/g, '');
    if (d.startsWith('84')) d = `0${d.slice(2)}`;
    const mobile = /^0[35789]\d{8}$/.test(d);
    return mobile
      ? `<a href="zalo://conversation?phone=84${d.slice(1)}" title="Di động – bấm để mở app Zalo trên máy (chat với ${d})" style="display:inline-block;padding:0 6px;border-radius:6px;background:#dcfce7;color:#15803d;font-weight:900;text-decoration:none">📱 ${esc(String(p).trim().replace(/^\+?84[\s.-]*/, '0'))} <span style="font-size:10px;color:#0068ff">Zalo ↗</span></a>`
      : `<span title="Số bàn" style="color:#94a3b8">☎ ${esc(String(p).trim().replace(/^\+?84[\s.-]*/, '0'))}</span>`;
  }
  const cleanPhone = (p) => String(p || '').replace(/^phone:tel:/, '').replace(/\s+/g, ' ').trim();
  const stripLabel = (t) => String(t || '').replace(/^[^:]{2,20}:\s*/, '').trim(); // "Address: …" / "Địa chỉ: …"

  // ⭐ Số sao + số lượt đánh giá Google: aria-label "4.5 stars 123 Reviews" / "4,5 sao 123 bài đánh giá", hoặc chữ "4,5 (123)"
  const numVn = (t) => Number(String(t).replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  function rateOf(el) {
    if (!el) return {};
    let rate = null;
    let n = null;
    for (const x of el.querySelectorAll('[role="img"][aria-label], [aria-label]')) {
      const l = x.getAttribute('aria-label') || '';
      const m = l.match(/(\d[.,]\d)\s*(?:stars?|sao)/i);
      if (m && rate == null) rate = numVn(m[1]);
      const r = l.match(/([\d.,]+)\s*(?:reviews?|bài đánh giá|đánh giá|lượt đánh giá)/i);
      if (r && n == null) n = numVn(r[1]);
    }
    if (rate == null) {
      const box = el.querySelector('.F7nice, .MW4etd')?.closest('div') || el.querySelector('.F7nice');
      const m = (box?.innerText || '').match(/(\d[.,]\d)\s*\(?\s*([\d.,]+)?\s*\)?/);
      if (m) {
        rate = numVn(m[1]);
        if (m[2] && n == null) n = numVn(m[2]);
      }
    }
    if (n == null) {
      const u = el.querySelector('.UY7F9')?.innerText;
      if (u) n = numVn(u.replace(/[()]/g, ''));
    }
    return rate != null && rate > 0 && rate <= 5 ? { rate, rateN: Number.isFinite(n) ? n : 0 } : {};
  }
  // Bảng chi tiết 1 địa điểm đang mở
  function readDetail() {
    const u = fromUrl(location.href);
    if (!u.id || !/\/maps\/place\//.test(location.pathname)) return null;
    const q = (s) => document.querySelector(s);
    const name = q('h1.DUwDvf')?.innerText.trim() || document.title.replace(/\s*-\s*Google Maps\s*$/, '').trim() || u.name;
    const addr = stripLabel(q('button[data-item-id="address"]')?.getAttribute('aria-label') || q('button[data-item-id="address"]')?.innerText);
    if (!name || !addr) return null;
    return {
      id: u.id,
      name,
      cat: q('button[jsaction*="category"]')?.innerText.trim() || '',
      addr,
      phone: cleanPhone(q('button[data-item-id^="phone:tel:"]')?.getAttribute('data-item-id')),
      web: q('a[data-item-id="authority"]')?.href || '',
      plus: stripLabel(q('button[data-item-id="oloc"]')?.getAttribute('aria-label')),
      lat: u.lat,
      lng: u.lng,
      url: `https://www.google.com/maps/place/?q=place_id:${u.id}`,
      href: location.href.split('?')[0],
      full: true,
      ...rateOf(q('div[role="main"]') || document),
    };
  }
  // Các mục trong danh sách kết quả (div[role=feed])
  function readFeed() {
    const out = [];
    for (const a of document.querySelectorAll('div[role="feed"] div[role="article"]')) {
      const link = a.querySelector('a[href*="/maps/place/"]');
      const u = fromUrl(link?.href);
      if (!u.id) continue;
      const name = a.querySelector('.qBF1Pd')?.innerText.trim() || link.getAttribute('aria-label') || u.name;
      const lines = a.innerText.split('\n').map((x) => x.trim()).filter(Boolean);
      const catLine = lines.find((x) => x.includes('·') && !/^(Open|Closed|Đang mở|Đã đóng|Mở cửa|Đóng cửa)/i.test(x)) || '';
      const parts = catLine.split('·').map((x) => x.trim()).filter(Boolean);
      const phone = (lines.join(' ').match(PHONE_RE) || [''])[0];
      out.push({ id: u.id, name, cat: parts[0] || '', addr: parts.slice(1).join(', '), phone: cleanPhone(phone), lat: u.lat, lng: u.lng, url: `https://www.google.com/maps/place/?q=place_id:${u.id}`, href: link.href.split('?')[0], full: false, ...rateOf(a) });
    }
    return out;
  }
  // 🚫 Bỏ công ty bất động sản / xây lắp (tên / loại hình): BĐS, BDS, bất động sản, địa ốc, xây lắp, real estate, realty, property, land…
  const RE_RE = /b[aấâ]t\s*đ[oộô]ng\s*s[aả]n|\bb[đd]s\b|đ[iị]a\s*[oố]c|real\s*estate|realt(y|or)|propert(y|ies)|\bland\b|nh[aà]\s*đ[aấ]t|môi giới nhà/i;
  // so cả bản bỏ dấu (tên viết "Dia Oc", "BAT DONG SAN", chữ tổ hợp NFD…) để không sót "địa ốc"
  const IND_DROP = new Set(['Dịch vụ – tư vấn – phần mềm']); // ngành không cần (xoá khỏi danh sách)
  // 🗺 Ngoài 7 tỉnh (ranh giới cũ: Long An, Bình Dương, TP.HCM, Đồng Nai, BR-VT, Bình Phước, Tây Ninh) → loại.
  // Theo chữ trong địa chỉ / tên / KCN (tỉnh khác, kể cả tên tỉnh mới sau sáp nhập: Đồng Tháp gồm Tiền Giang, Lâm Đồng gồm Bình Thuận…)
  // và theo toạ độ (ngoài khung 7 tỉnh, hoặc phía nam sông Vàm Cỏ – vùng Tiền Giang). Sửa thì sửa cả maps.js và maps-tab.js.
  const OUT7_RE = /\b(tien giang|dong thap|ben tre|tra vinh|soc trang|hau giang|bac lieu|ca mau|lam dong|ninh thuan|dak lak|dak nong|my tho|go cong|cai lay|cai be|sa dec|cao lanh|phan thiet|bao loc|long giang|tan my chanh|(?:tinh|thanh pho|tp\.?) (?:vinh long|can tho|an giang|kien giang|binh thuan|khanh hoa|gia lai|kon tum|phu yen|binh dinh|quang ngai|quang nam|da nang|ha noi|hai phong|da lat))\b/;
  const out7Why = (c) => {
    const u = String(`${c?.addr || ''} | ${c?.legalAddr || ''} | ${c?.kcn || ''} | ${c?.name || ''} | ${c?.legalName || ''}`).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
    const m = u.match(OUT7_RE);
    if (m) return `ngoài 7 tỉnh (${m[1]})`;
    const la = Number(c?.lat);
    const ln = Number(c?.lng);
    if (la && ln && (la < 10.3 || la > 12.35 || ln < 105.8 || ln > 107.65 || (la < 10.42 && ln < 106.8))) return 'ngoài 7 tỉnh (toạ độ)';
    return '';
  };
  const isRealEstate = (c) => {
    if (c?.hidden) return true; // 🙈 người dùng đã ẩn công ty này
    if (out7Why(c)) return true; // 🗺 ngoài 7 tỉnh
    if (c?.ind && IND_DROP.has(c.ind)) return true; // 🏷 ngành bị loại (AI gắn nhãn)
    // tên chỉ có mỗi chữ "Công ty" (± TNHH / CP / MTV / dấu câu) – không có tên riêng
    if (c?.name && !String(c.name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/\b(cong\s*ty|cty|tnhh|co\s*phan|cp|mtv|mot\s*thanh\s*vien|company|co|ltd|limited)\b/g, '').replace(/[^a-z0-9]/g, '')) return true;
    const t = `${c?.name || ''} | ${c?.legalName || ''} | ${c?.cat || ''}`.normalize('NFC');
    const u = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
    return RE_RE.test(t) || /dia[\s.\-_]*oc|bat[\s.\-_]*dong[\s.\-_]*san|\bbds\b|real\s*estate|xay\s*lap|xay\s*dung|construction|phat\s*trien\s*nha|bao\s*ve\b|security/.test(u); // + xây lắp, xây dựng, phát triển nhà, bảo vệ
  };
  // Ẩn luôn các công ty bị loại (BĐS / địa ốc / xây dựng…) trong danh sách kết quả của chính Google Maps (cột trái)
  setInterval(() => {
    for (const a of document.querySelectorAll('div[role="feed"] div[role="article"]:not([data-dg-re])')) {
      const name = a.querySelector('.qBF1Pd')?.innerText || a.getAttribute('aria-label') || a.innerText.split('\n')[0] || '';
      const cat = (a.innerText.split('\n').find((x) => x.includes('·')) || '').split('·')[0];
      const pid = fromUrl(a.querySelector('a[href*="/maps/place/"]')?.href).id;
      a.dataset.dgRe = isRealEstate({ name, cat, hidden: !!(pid && cache?.[pid]?.hidden), ind: pid ? cache?.[pid]?.ind : '' }) ? '1' : '0';
      if (a.dataset.dgRe === '1') {
        const box = a.parentElement;
        (box && box.children.length <= 2 ? box : a).style.display = 'none';
      }
    }
  }, 1000);
  // Lưu: bản chi tiết (full) không bị bản danh sách (địa chỉ rút gọn) ghi đè
  let cache = null;
  let cacheAt = 0;
  // 💾 Bản JSON lưu trên máy (IndexedDB của google.com): mở Maps là có ngay danh sách để lọc, không chờ tải cloud;
  // cloud tải lại ngầm (lúc mở + 5 phút / lần khi tab đang xem) rồi ghi đè bản máy.
  const lIdb = () => new Promise((ok, bad) => {
    const r = indexedDB.open('dgMapsLocal', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
  const lGet = async () => { const db = await lIdb(); return new Promise((ok) => { const q = db.transaction('kv').objectStore('kv').get('places'); q.onsuccess = () => ok(q.result || null); q.onerror = () => ok(null); }); };
  let lT = 0;
  const localSave = () => { clearTimeout(lT); lT = setTimeout(() => cache && lIdb().then((db) => db.transaction('kv', 'readwrite').objectStore('kv').put({ at: Date.now(), places: cache }, 'places')).catch(() => {}), 1500); };
  async function cloudLoad() {
    const c = await kvGet(KEY).catch(() => null);
    if (c && Object.keys(c).length) {
      cache = c;
      cacheAt = Date.now();
      localSave();
    }
    return cache || {};
  }
  const localReady = lGet().then((d) => { if (d?.places && !cache) cache = d.places; }).catch(() => {}).finally(() => {
    cloudLoad().catch(() => {});
    setInterval(() => document.visibilityState === 'visible' && cloudLoad().catch(() => {}), 5 * 60e3);
  });
  async function save(list) {
    list = list.filter((p) => !isRealEstate(p));
    if (!list.length) return 0;
    // đọc lại kho nếu bản trong tab cũ hơn 1 phút – tránh ghi đè MST nhập tay / xoá / kết nối ERP vừa làm ở tab 📍 Công ty Maps (CRM)
    await localReady;
    if (!cache || Date.now() - cacheAt > 60e3) {
      await cloudLoad();
      cache = cache || {};
      cacheAt = Date.now();
    }
    const patch = {};
    for (const p0 of list) {
      const k = typeof kcnOf === 'function' ? kcnOf(p0) : '';
      const p = k ? { ...p0, kcn: k } : p0;
      const old = cache[p.id];
      if (old?.hidden) continue; // 🙈 đã ẩn → không lưu / cập nhật lại
      const v = old?.full && !p.full ? { ...p, ...old, lat: old.lat ?? p.lat, lng: old.lng ?? p.lng, phone: old.phone || p.phone, seenAt: Date.now() } : { ...(old || {}), ...p, at: Date.now(), seenAt: Date.now() };
      if (p.rate != null) Object.assign(v, { rate: p.rate, rateN: p.rateN || 0 }); // ⭐ số sao mới nhất đọc được
      if (JSON.stringify({ ...old, at: 0, seenAt: 0 }) === JSON.stringify({ ...v, at: 0, seenAt: 0 })) continue;
      patch[p.id] = v;
      cache[p.id] = v;
    }
    if (Object.keys(patch).length) {
      await kvMerge(KEY, patch);
      localSave();
    }
    return Object.keys(patch).length;
  }

  // ---- Thanh nhỏ góc dưới trái ----
  const box = document.createElement('div');
  box.id = 'dg-maps';
  box.setAttribute('style', 'position:fixed;left:72px;bottom:16px;z-index:2147483000;font:13px/1.4 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a;background:#fff;border:2px solid #2563eb;border-radius:14px;box-shadow:0 10px 28px rgba(15,23,42,.25);padding:8px 10px;max-width:360px');
  const btn = 'cursor:pointer;border:1px solid #93c5fd;background:#eff6ff;color:#1d4ed8;border-radius:8px;padding:3px 9px;font:inherit;font-size:12px;font-weight:800';
  let msg = '';
  let busy = false;
  async function draw() {
    await localReady;
    cache = cache || (await cloudLoad()) || {};
    const n = Object.keys(cache).length;
    const feedN = document.querySelectorAll('div[role="feed"] div[role="article"]').length;
    box.innerHTML = `<div style="display:flex;align-items:center;gap:6px;font-weight:900;color:#1e3a8a">📍 Trợ lý ERP · địa chỉ công ty <span title="Đã chuẩn hoá tên + MST từ masothue.com (tra ngầm 15 giây / công ty)" style="margin-left:auto;background:#f3e8ff;color:#6d28d9;border-radius:99px;padding:0 8px">🧾 ${Object.values(cache).filter((x) => x?.mst).length}</span><span style="background:#dbeafe;border-radius:99px;padding:0 8px">${n}</span><span data-m="min" title="Thu nhỏ" style="cursor:pointer;color:#94a3b8">–</span></div>
<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${feedN ? `<button data-m="feed" style="${btn}">⬇️ Lưu danh sách (${feedN}+)</button>` : ''}<button data-m="scan" style="${btn}">🔍 Quét công ty màn hình này</button><button data-m="kcnscan" title="Tự đi vào từng KCN / CCN trong 7 tỉnh (chia điểm ~2 km), tìm “công ty”, lưu lên cloud. Điểm đã quét được đánh dấu – F5 / máy khác chạy tiếp phần còn lại." style="${btn};${crawlOn && crawlMode === 'kcn' ? 'background:#fee2e2;border-color:#fca5a5;color:#b91c1c' : 'background:#ffedd5;border-color:#fdba74;color:#9a3412'}">🏭 ${crawlOn && crawlMode === 'kcn' ? 'Dừng quét KCN' : 'Tự quét KCN'}${kcnIndex ? (() => { const pr = kcnProgress(); return ` · ${pr.kcnDone}/${pr.kcn} KCN`; })() : ''}</button><button data-m="crawl" title="Tự dời bản đồ qua từng ô ~5 km trong 7 tỉnh, tìm “công ty”, lưu lên cloud (20–35 giây / ô). Ô đã chạy được đánh dấu – F5 hay máy khác chỉ chạy tiếp ô chưa quét." style="${btn};${crawlOn && crawlMode === 'grid' ? 'background:#fee2e2;border-color:#fca5a5;color:#b91c1c' : 'background:#e0f2fe;border-color:#7dd3fc;color:#0369a1'}">🛰 ${crawlOn && crawlMode === 'grid' ? 'Dừng tự chạy' : 'Tự chạy 7 tỉnh'} · ${crawlCells.filter(([k]) => crawlDone?.[k] && Date.now() - crawlDone[k] < 30 * 86400e3).length}/${crawlCells.length} ô</button><button data-m="auto" title="Tự quét khi dừng bản đồ (zoom gần) ở Long An, Bình Dương, TP.HCM, Đồng Nai, Vũng Tàu, Bình Phước, Tây Ninh" style="${btn};${autoScan ? 'background:#dcfce7;border-color:#86efac;color:#166534' : ''}">🤖 Tự quét 7 tỉnh: ${autoScan ? 'Bật' : 'Tắt'}</button><button data-m="csv" style="${btn}">📄 Xuất CSV</button>${Object.values(cache).some((x) => x?.hidden) ? `<button data-m="hidden" title="Xem / hiện lại công ty đã ẩn" style="${btn}">🙈 Đã ẩn (${Object.values(cache).filter((x) => x?.hidden).length})</button>` : ''}${localStorage.getItem('dgMstMode') === 'tab' && !mstTabAlive ? `<a href="https://masothue.com/#dgmst" target="_blank" rel="noopener" title="masothue.com chặn tra ngầm – mở 1 tab masothue (để chạy nền) để tự tra tên + MST, 15 giây / công ty" style="${btn};text-decoration:none;background:#f3e8ff;border-color:#c4b5fd;color:#6d28d9">🧾 Mở tab tra MST</a>` : ''}<button data-m="kcn" style="${btn};${kcnOn ? 'background:#ffedd5;border-color:#fb923c;color:#9a3412' : ''}">🏭 Viền KCN: ${kcnOn ? 'Bật' : 'Tắt'}</button>${kcnOn ? `<button data-m="kdraw" style="${btn};background:#dcfce7;border-color:#86efac;color:#166534">✏️ Vẽ viền KCN</button>${Object.values(kcnCustom).some((x) => x && !x.deleted) ? `<button data-m="klist" style="${btn}">🗂 KCN tự vẽ (${Object.values(kcnCustom).filter((x) => x && !x.deleted).length})</button>` : ''}` : ''}</div>
${msg ? `<div style="margin-top:5px;font-size:12px;color:#334155">${esc(msg)}</div>` : ''}`;
  }
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-m]');
    if (!b || busy) return;
    const k = b.dataset.m;
    if (k === 'min') {
      box.style.display = 'none';
      return;
    }
    if (k === 'scan') {
      // quét đúng màn hình đang xem (vị trí vừa kéo tới):
      // 1) có nút "Search this area" → bấm; 2) gõ "công ty" vào ô tìm kiếm (Maps tìm trong khung đang xem, không tải lại);
      // 3) cuối cùng mới tải lại theo toạ độ + zoom hiện tại (URL dạng …z hoặc …m)
      busy = true;
      try {
        const before = document.querySelector('div[role="feed"] div[role="article"] a[href*="/maps/place/"]')?.href || '';
        const sta = [...document.querySelectorAll('button')].find((b) => /^(Search this area|Tìm kiếm khu vực này|Tìm khu vực này)$/i.test(b.innerText.trim()) && b.getClientRects().length);
        const inp = document.querySelector('input#searchboxinput, input[name="q"]');
        const go = document.querySelector('button#searchbox-searchbutton, button[aria-label="Search"], button[aria-label="Tìm kiếm"]');
        msg = '🔍 Đang tìm công ty trong màn hình này…';
        draw();
        if (sta) sta.click();
        else if (inp && go) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, 'công ty');
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          go.click();
        } else {
          const v = mapView();
          sessionStorage.setItem('dgMapsAuto', '1');
          location.href = `https://www.google.com/maps/search/c%C3%B4ng+ty/${v ? `@${v.lat},${v.lng},${Math.max(13, Math.round(v.z))}z` : ''}`;
          return;
        }
        for (let i = 0; i < 24; i++) {
          await sleep(500);
          const first = document.querySelector('div[role="feed"] div[role="article"] a[href*="/maps/place/"]')?.href || '';
          if (first && first !== before) break;
        }
      } finally {
        busy = false;
      }
      if (document.querySelector('div[role="feed"] div[role="article"]')) await saveFeedAll();
      else {
        msg = 'Không thấy danh sách công ty trong màn hình này.';
        draw();
      }
      sideCalcKey = '';
      return;
    }
    if (k === 'csv') {
      cache = (await kvGet(KEY).catch(() => ({}))) || {};
      const rows = Object.values(cache).filter((x) => x?.name && !isRealEstate(x));
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = '﻿' + [['Tên', 'Ngành (AI)', 'Tên pháp lý (masothue)', 'MST', 'Địa chỉ đăng ký', 'KCN', 'Loại hình', 'Địa chỉ', 'SĐT', 'Website', 'Plus code', 'Vĩ độ', 'Kinh độ', 'Google Maps'].map(q).join(',')].concat(rows.map((x) => [x.name, x.ind, x.legalName, x.mst, x.legalAddr, x.kcn, x.cat, x.addr, x.phone, x.web, x.plus, x.lat, x.lng, x.href || x.url].map(q).join(','))).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = `dia-chi-cong-ty-google-maps-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      return;
    }
    if (k === 'kcnscan' || k === 'crawl') {
      const mode = k === 'kcnscan' ? 'kcn' : 'grid';
      // đang chạy chế độ khác → chuyển sang chế độ vừa bấm; bấm lại đúng chế độ đang chạy → dừng
      crawlOn = !(crawlOn && crawlMode === mode);
      crawlMode = mode;
      localStorage.setItem('dgMapsCrawlMode', mode);
      sessionStorage.removeItem('dgCrawlNext');
      if (mode === 'kcn' && crawlOn) kcnIndexLoad().then(() => draw()).catch(() => {});
      localStorage.setItem('dgMapsCrawl', crawlOn ? '1' : '0');
      if (!crawlOn) sessionStorage.removeItem('dgCrawlCell');
      else crawlDone = (await kvGet('mapsCrawl').catch(() => ({}))) || {};
      msg = crawlOn ? (mode === 'kcn' ? '🏭 Bắt đầu tự quét các KCN – để tab Google Maps này mở.' : '🛰 Bắt đầu tự chạy 7 tỉnh – để tab Google Maps này mở.') : '⏹ Đã dừng (chỗ đã quét vẫn được nhớ).';
      draw();
      return;
    }
    if (k === 'hidden') {
      const list = Object.values(cache).filter((x) => x?.hidden).sort((a, b) => (b.hiddenAt || 0) - (a.hiddenAt || 0));
      const pick = prompt(`Công ty đã ẩn – nhập số để HIỆN LẠI:\n${list.slice(0, 40).map((x, i) => `${i + 1}. ${x.legalName || x.name}`).join('\n')}`, '');
      const it = list[Number(pick) - 1];
      if (it) {
        await hidePlace(it.id, false);
        sideDraw();
      }
      return;
    }
    if (k === 'auto') {
      autoScan = !autoScan;
      localStorage.setItem('dgMapsAutoScan', autoScan ? '1' : '0');
      draw();
      return;
    }
    if (k === 'kdraw') {
      const n = prompt('Tên khu công nghiệp cần vẽ (vd. KCN Hải Sơn mở rộng):', '');
      if (!n || !n.trim()) return;
      drawName = n.trim();
      drawPts = [];
      drawUi();
      return;
    }
    if (k === 'klist') {
      const list = Object.entries(kcnCustom).filter(([, x]) => x && !x.deleted);
      const pick = prompt(`KCN tự vẽ – nhập số để XOÁ:\n${list.map(([, x], i) => `${i + 1}. ${x.name}${x.by ? ` (${x.by})` : ''}`).join('\n')}`, '');
      const it = list[Number(pick) - 1];
      if (it && confirm(`Xoá viền “${it[1].name}”?`)) {
        await kvMerge('kcnCustom', { [it[0]]: { ...it[1], deleted: true, at: Date.now() } });
        kcnCustom[it[0]] = { ...it[1], deleted: true };
        kcnData.delete(`c/${it[0]}`);
        kcnDraw();
        draw();
      }
      return;
    }
    if (k === 'kcn') {
      kcnOn = !kcnOn;
      localStorage.setItem('dgKcnOn', kcnOn ? '1' : '0');
      kcnUrl = '';
      kcnDraw();
      draw();
      return;
    }
    if (k === 'feed') await saveFeedAll();
  });
  // Cuộn hết danh sách kết quả (Google tải thêm khi cuộn tới cuối) rồi lưu
  async function saveFeedAll() {
    busy = true;
    try {
      const feed = document.querySelector('div[role="feed"]');
      let last = -1;
      let same = 0;
      for (let i = 0; i < 60 && same < 4; i++) {
        const n = feed.querySelectorAll('div[role="article"]').length;
        msg = `⏳ Đang cuộn danh sách… ${n} công ty`;
        draw();
        await save(readFeed());
        if (/You've reached the end|Bạn đã xem hết/i.test(feed.innerText)) break;
        feed.scrollTop = feed.scrollHeight;
        await sleep(1200);
        same = n === last ? same + 1 : 0;
        last = n;
      }
      const got = readFeed();
      await save(got);
      msg = `✅ Đã lưu ${got.length} công ty trong danh sách. Bấm vào từng công ty để lưu địa chỉ đầy đủ.`;
    } catch (err) {
      msg = `⚠️ ${err.message || err}`;
    } finally {
      busy = false;
      draw();
    }
  }

  // ---------- 🏭 Viền khu công nghiệp (KCN) trên bản đồ ----------
  // Ranh giới lấy từ OpenStreetMap (Overpass API: landuse=industrial có tên Khu công nghiệp / KCN / Industrial Park) theo khung đang xem
  // – chỉ gửi toạ độ khung bản đồ, không gửi dữ liệu nào khác. Lưu tạm localStorage 7 ngày.
  // Vẽ lớp SVG đè lên bản đồ theo phép chiếu Web Mercator từ tâm + mức zoom trên URL (@lat,lng,zoom). Đang kéo / cuộn thì ẩn, dừng thì vẽ lại.
  let kcnOn = localStorage.getItem('dgKcnOn') !== '0';
  const KCN_RE = 'Khu công nghiệp|Khu Công Nghiệp|KHU CÔNG NGHIỆP|KCN|Khu CN|Industrial Park|Industrial Zone|Cụm công nghiệp|Cụm CN|CCN';
  const svgNS = 'http://www.w3.org/2000/svg';
  const kcnSvg = document.createElementNS(svgNS, 'svg');
  kcnSvg.id = 'dg-kcn';
  kcnSvg.setAttribute('style', 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:5;overflow:visible');
  let kcnData = new Map(); // id → { name, rings: [[ [lat,lng]… ]] }
  const tileKey = (s, w) => `${Math.floor(s * 4) / 4},${Math.floor(w * 4) / 4}`; // ô 0,25°
  const kcnLoaded = new Set();
  function mapView() {
    const m = decodeURIComponent(location.href).match(/@(-?\d+\.\d+),(-?\d+\.\d+),(\d+(?:\.\d+)?)(z|m)/);
    if (!m) return null;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    const cv = [...document.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const r = cv && cv.width > 200 ? cv : { left: 0, top: 0, width: innerWidth, height: innerHeight };
    // "…z" = mức zoom; "…m" (vệ tinh / 3D) = chiều cao vùng nhìn theo mét → đổi ra zoom
    const z = m[4] === 'z' ? Number(m[3]) : Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180) * r.height) / Number(m[3]));
    return { lat, lng, z, r };
  }
  const proj = (lat, lng, z) => {
    const s = 256 * 2 ** z;
    const sin = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
    return [((lng + 180) / 360) * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
  };
  const unproj = (x, y, z) => {
    const s = 256 * 2 ** z;
    const lng = (x / s) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * y) / s;
    return [(180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng];
  };
  // 1 lượt Overpass cho cả khung đang xem (làm tròn ra ô 0,25°, tối đa ~1,5° mỗi chiều); ô đã có thì bỏ qua.
  // Máy chủ báo bận (429 / 504) → nghỉ 60 giây, thử máy chủ dự phòng.
  const KCN_HOSTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let kcnFail = 0;
  let kcnBusy = false;
  let kcnCloud = null; // kv kcnOsm { ô: { at, list } } – ranh giới KCN đã tải, đồng bộ mọi máy
  let kcnWait = 0;
  async function kcnFetch(v) {
    if (kcnBusy || Date.now() < kcnWait) return;
    const [cx, cy] = proj(v.lat, v.lng, v.z);
    const [n, w] = unproj(cx - v.r.width / 2, cy - v.r.height / 2, v.z);
    const [s, e] = unproj(cx + v.r.width / 2, cy + v.r.height / 2, v.z);
    const S = Math.floor(s * 4) / 4;
    const W = Math.floor(w * 4) / 4;
    const N = Math.ceil(n * 4) / 4;
    const E = Math.ceil(e * 4) / 4;
    if (N - S > 1.5 || E - W > 1.5) return; // zoom quá xa → không tải
    const tiles = [];
    for (let a = S; a < N; a += 0.25) for (let b = W; b < E; b += 0.25) tiles.push(tileKey(a, b));
    // ô đã có trên cloud (máy khác tải rồi) → dùng luôn, khỏi gọi Overpass
    if (!kcnCloud) kcnCloud = (await kvGet('kcnOsm').catch(() => ({}))) || {};
    for (const k of tiles) {
      const c = kcnCloud[k];
      if (!kcnLoaded.has(k) && c?.list && Date.now() - c.at < 30 * 86400e3) {
        for (const [id, p] of c.list) kcnData.set(id, p);
        kcnLoaded.add(k);
      }
    }
    const need = tiles.filter((k) => {
      if (kcnLoaded.has(k)) return false;
      try {
        const c = JSON.parse(localStorage.getItem(`dgKcn2:${k}`) || 'null');
        // bản lưu cũ (trước khi đổi bộ lọc tên) → vẽ tạm trong lúc chờ tải bản mới
        const old = JSON.parse(localStorage.getItem(`dgKcn:${k}`) || 'null');
        if (old?.list) for (const [id, p] of old.list) if (!kcnData.has(id)) kcnData.set(id, p);
        if (c && Date.now() - c.at < 7 * 86400e3) {
          for (const [id, p] of c.list) kcnData.set(id, p);
          kcnLoaded.add(k);
          return false;
        }
      } catch {}
      return true;
    });
    if (!need.length) return kcnDraw();
    kcnBusy = true;
    const bb = `${S},${W},${N},${E}`;
    const q = `[out:json][timeout:40];(way["landuse"="industrial"]["name"~"${KCN_RE}",i](${bb});relation["landuse"="industrial"]["name"~"${KCN_RE}",i](${bb});way["industrial"="industrial_park"](${bb});relation["industrial"="industrial_park"](${bb}););out geom;`;
    try {
      let j = null;
      for (const host of KCN_HOSTS) {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 45e3);
        const res = await fetch(host, { method: 'POST', body: `data=${encodeURIComponent(q)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: ac.signal }).catch(() => null);
        clearTimeout(to);
        if (res?.ok) {
          j = await res.json().catch(() => null);
          if (j) break;
        }
      }
      if (!j) {
        // mọi máy chủ Overpass đang bận → tự thử lại (30 giây, 1, 2, 4 … tối đa 8 phút), không chờ người dùng kéo bản đồ
        kcnFail++;
        const wait = Math.min(480e3, 30e3 * 2 ** (kcnFail - 1));
        kcnWait = Date.now() + wait;
        setTimeout(() => {
          const v2 = mapView();
          if (v2 && v2.z >= 10 && kcnOn) kcnFetch(v2).catch(() => {});
        }, wait + 500);
        return;
      }
      kcnFail = 0;
      // chia phần tử về từng ô theo điểm đầu tiên → lưu cache theo ô
      const byTile = Object.fromEntries(tiles.map((k) => [k, []]));
      for (const el of j.elements || []) {
        const name = el.tags?.name || el.tags?.['name:vi'] || '';
        let rings = [];
        if (el.type === 'way' && el.geometry) rings = [el.geometry.map((g) => [g.lat, g.lon])];
        else if (el.type === 'relation') rings = (el.members || []).filter((m) => m.role !== 'inner' && m.geometry).map((m) => m.geometry.map((g) => [g.lat, g.lon]));
        if (!rings.length) continue;
        const id = `${el.type}/${el.id}`;
        const p = { name, rings };
        kcnData.set(id, p);
        const k = tileKey(rings[0][0][0], rings[0][0][1]);
        (byTile[k] ||= []).push([id, p]);
      }
      const cloudPatch = {};
      for (const k of tiles) {
        kcnLoaded.add(k);
        const val = { at: Date.now(), list: byTile[k] || [] };
        cloudPatch[k] = val;
        try {
          localStorage.setItem(`dgKcn2:${k}`, JSON.stringify(val));
        } catch {}
      }
      kcnCloud = { ...(kcnCloud || {}), ...cloudPatch };
      kvMerge('kcnOsm', cloudPatch).catch(() => {});
    } finally {
      kcnBusy = false;
    }
    kcnDraw();
  }
  // ✏️ KCN tự vẽ (OSM chưa có, vd. KCN Hải Sơn mở rộng): kv kcnCustom { id: { name, rings, by, at } } – đồng bộ cloud
  let kcnCustom = {};
  const loadCustom = async () => {
    kcnCustom = (await kvGet('kcnCustom').catch(() => ({}))) || {};
    for (const [id, p] of Object.entries(kcnCustom)) if (p?.rings?.length && !p.deleted) kcnData.set(`c/${id}`, { ...p, custom: true });
    for (const k of [...kcnData.keys()]) if (k.startsWith('c/') && (!kcnCustom[k.slice(2)] || kcnCustom[k.slice(2)].deleted)) kcnData.delete(k);
  };
  loadCustom().then(() => kcnDraw()).catch(() => {});
  setInterval(() => loadCustom().then(() => kcnDraw()).catch(() => {}), 60e3);
  let drawPts = null; // đang vẽ: [[lat,lng]…]
  let drawName = '';
  const drawLayer = document.createElement('div');
  drawLayer.setAttribute('style', 'position:fixed;inset:0;z-index:2147482000;cursor:crosshair;display:none');
  const drawBar = document.createElement('div');
  drawBar.setAttribute('style', 'position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:2147482001;background:#0f172a;color:#fff;border-radius:12px;padding:8px 12px;font:700 13px -apple-system,"Segoe UI",Roboto,Arial,sans-serif;display:none;gap:8px;align-items:center;box-shadow:0 10px 28px rgba(0,0,0,.35)');
  const drawPreview = document.createElementNS(svgNS, 'svg');
  drawPreview.setAttribute('style', 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147481999');
  function drawUi() {
    const on = !!drawPts;
    drawLayer.style.display = on ? 'block' : 'none';
    drawBar.style.display = on ? 'flex' : 'none';
    if (!on) return (drawPreview.innerHTML = '');
    if (!drawLayer.isConnected) document.body.append(drawPreview, drawLayer, drawBar);
    drawBar.innerHTML = `✏️ Vẽ viền “${esc(drawName)}”: bấm từng góc trên bản đồ (${drawPts.length} điểm) <button data-d="undo" style="cursor:pointer;border:0;border-radius:6px;padding:2px 8px;font:inherit">↶ Bỏ điểm</button><button data-d="ok" style="cursor:pointer;border:0;border-radius:6px;padding:2px 10px;font:inherit;background:#22c55e;color:#fff" ${drawPts.length < 3 ? 'disabled' : ''}>✔ Xong</button><button data-d="x" style="cursor:pointer;border:0;border-radius:6px;padding:2px 8px;font:inherit;background:#ef4444;color:#fff">✕ Huỷ</button>`;
    const v = mapView();
    if (!v) return;
    const [cx, cy] = proj(v.lat, v.lng, v.z);
    const pts = drawPts.map(([la, ln]) => {
      const [x, y] = proj(la, ln, v.z);
      return [x - cx + v.r.left + v.r.width / 2, y - cy + v.r.top + v.r.height / 2];
    });
    drawPreview.innerHTML = `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="rgba(34,197,94,.25)" stroke="#fff" stroke-width="7"/><polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#16a34a" stroke-width="3.5"/>${pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5" fill="#fff" stroke="#16a34a" stroke-width="3"/>`).join('')}`;
  }
  drawLayer.addEventListener('click', (e) => {
    const v = mapView();
    if (!v || !drawPts) return;
    const [cx, cy] = proj(v.lat, v.lng, v.z);
    drawPts.push(unproj(cx + e.clientX - v.r.left - v.r.width / 2, cy + e.clientY - v.r.top - v.r.height / 2, v.z));
    drawUi();
  });
  drawBar.addEventListener('click', async (e) => {
    const k = e.target.closest('[data-d]')?.dataset.d;
    if (!k) return;
    if (k === 'undo') drawPts.pop();
    if (k === 'x') drawPts = null;
    if (k === 'ok' && drawPts.length >= 3) {
      const id = `${Date.now().toString(36)}`;
      const me = (await kvGet('me').catch(() => ({})))?.name || '';
      const p = { name: drawName, rings: [drawPts.map(([a, b]) => [Number(a.toFixed(6)), Number(b.toFixed(6))])], by: me, at: Date.now() };
      await kvMerge('kcnCustom', { [id]: p });
      kcnCustom[id] = p;
      kcnData.set(`c/${id}`, { ...p, custom: true });
      drawPts = null;
      msg = `✅ Đã lưu viền “${p.name}” (đồng bộ cho mọi máy).`;
      draw();
      kcnDraw();
    }
    drawUi();
  });
  addEventListener('keydown', (e) => {
    if (drawPts && e.key === 'Escape') {
      drawPts = null;
      drawUi();
    }
  });
  // Điểm (lat,lng) nằm trong đa giác (vòng ngoài) – tia ngang
  const inRing = (la, ln, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ai, bi] = ring[i];
      const [aj, bj] = ring[j];
      if (ai > la !== aj > la && ln < ((bj - bi) * (la - ai)) / (aj - ai) + bi) inside = !inside;
    }
    return inside;
  };
  const inKcn = (la, ln, p) => p.rings.some((r) => inRing(la, ln, r));
  // Công ty đã lưu (mapsPlaces) nằm trong 1 KCN
  function kcnCompanies(p) {
    if (!cache) return [];
    if (!p._bb) {
      const all = p.rings.flat();
      p._bb = [Math.min(...all.map((x) => x[0])), Math.max(...all.map((x) => x[0])), Math.min(...all.map((x) => x[1])), Math.max(...all.map((x) => x[1]))];
    }
    const [s1, n1, w1, e1] = p._bb;
    return Object.values(cache).filter((c) => c?.lat && !isRealEstate(c) && c.lat >= s1 && c.lat <= n1 && c.lng >= w1 && c.lng <= e1 && inKcn(c.lat, c.lng, p));
  }
  // KCN chứa 1 công ty (tên) – dùng cho bảng chi tiết / danh sách
  const kcnOf = (c) => (c?.lat ? [...kcnData.values()].find((p) => inKcn(c.lat, c.lng, p))?.name || '' : '');
  // Bấm nhãn KCN → bảng danh sách công ty trong KCN đó
  kcnSvg.addEventListener('click', (e) => {
    const g = e.target.closest('[data-kcn]');
    if (!g) return;
    e.stopPropagation();
    kcnListShow(g.dataset.kcn);
  });
  function kcnListShow(kid) {
    const p = kcnData.get(kid);
    if (!p) return;
    document.getElementById('dg-kcn-list')?.remove();
    const list = kcnCompanies(p).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    const el = document.createElement('div');
    el.id = 'dg-kcn-list';
    el.setAttribute('style', 'position:fixed;right:70px;top:80px;z-index:2147483000;width:min(440px,90vw);max-height:72vh;overflow:auto;background:#fff;border-radius:14px;border:2px solid #f59e0b;box-shadow:0 18px 44px rgba(15,23,42,.3);padding:10px 12px;font:13px/1.45 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a');
    el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><b style="flex:1;font-size:14.5px">🏭 ${esc(p.name)}</b><span data-x style="cursor:pointer;color:#64748b;font-weight:900">✕</span></div>
<div style="font-size:12px;color:#475569;margin-bottom:6px"><b>${list.length}</b> công ty đã lưu nằm trong KCN${list.length ? '' : ' – bấm “🔍 Quét công ty màn hình này” khi đang xem KCN để lưu thêm'}</div>
${list.map((c, i) => `<div style="padding:6px 0;border-top:1px solid #f1f5f9"><div><b>${i + 1}. <a href="${esc(c.href || c.url)}" data-go="${esc(c.id)}" style="color:#1d4ed8;text-decoration:none">${esc(dispName(c))}</a></b>${erpBadge(c)}${c.cat ? ` <span style="color:#64748b;font-size:11.5px">· ${esc(c.cat)}</span>` : ''}</div><div style="font-size:12px;color:#334155">${esc(c.addr || '')}${c.phone ? ` · ${phoneHtml(c.phone)}` : ''}</div></div>`).join('')}`;
    el.querySelector('[data-x]').onclick = () => el.remove();
    document.body.append(el);
  }
  function kcnDraw() {
    if (drawPts) drawUi();
    if (!kcnOn) {
      kcnSvg.innerHTML = '';
      return;
    }
    const v = mapView();
    if (!v || v.z < 10) {
      kcnSvg.innerHTML = '';
      return;
    }
    if (!kcnSvg.isConnected) document.body.append(kcnSvg);
    const [cx, cy] = proj(v.lat, v.lng, v.z);
    const ox = v.r.left + v.r.width / 2 - cx;
    const oy = v.r.top + v.r.height / 2 - cy;
    let html = '';
    let labels = '';
    for (const [kid, p] of kcnData) {
      let lx = 0;
      let ly = 0;
      let cnt = 0;
      let on = false;
      const paths = p.rings.map((ring) => ring.map(([la, ln], i) => {
        const [x, y] = proj(la, ln, v.z);
        const X = x + ox;
        const Y = y + oy;
        lx += X;
        ly += Y;
        cnt++;
        if (X > v.r.left - 200 && X < v.r.right + 200 && Y > v.r.top - 200 && Y < v.r.bottom + 200) on = true;
        return `${i ? 'L' : 'M'}${X.toFixed(1)},${Y.toFixed(1)}`;
      }).join('') + 'Z').join('');
      if (!on) continue;
      // mỗi KCN 1 màu sáng (theo tên) – viền lót trắng dày + viền màu, nền màu nhạt → nổi trên ảnh vệ tinh
      const PAL = ['#f43f5e', '#f59e0b', '#22c55e', '#06b6d4', '#a855f7', '#3b82f6', '#ec4899', '#84cc16', '#ef4444', '#14b8a6'];
      let hsh = 0;
      for (const ch of p.name || '') hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
      const col = p.custom ? '#16a34a' : PAL[hsh % PAL.length];
      html += `<path d="${paths}" fill="${col}" fill-opacity=".22" stroke="#fff" stroke-width="7" stroke-linejoin="round" stroke-opacity=".9"/><path d="${paths}" fill="none" stroke="${col}" stroke-width="3.5" stroke-linejoin="round"/>`;
      if (p.name && v.z >= 12) {
        const nIn = kcnCompanies(p).length;
        const t = `${p.custom ? '✏️' : '🏭'}${nIn ? ` ${nIn} cty ·` : ''} ${p.name.replace(/^Khu công nghiệp\s*/i, 'KCN ').replace(/^Cụm công nghiệp\s*/i, 'CCN ')}`;
        const fs = v.z >= 14 ? 14 : 12;
        const tw = Math.round(t.length * fs * 0.56) + 16;
        const X = (lx / cnt).toFixed(1);
        const Y = (ly / cnt).toFixed(1);
        labels += `<g transform="translate(${X},${Y})" data-kcn="${esc(kid)}" style="pointer-events:auto;cursor:pointer"><rect x="${-tw / 2}" y="${-(fs + 12) / 2}" width="${tw}" height="${fs + 12}" rx="${(fs + 12) / 2}" fill="#fff" stroke="${col}" stroke-width="2.5" filter="url(#dgKcnSh)"/><text x="0" y="${Math.round(fs * 0.36)}" text-anchor="middle" font-size="${fs}" font-weight="900" fill="#0f172a" font-family="-apple-system,Segoe UI,Roboto,Arial,sans-serif">${esc(t)}</text></g>`;
      }
    }
    html = `<defs><filter id="dgKcnSh" x="-20%" y="-50%" width="140%" height="200%"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity=".45"/></filter></defs>${html}${labels}`;
    kcnSvg.innerHTML = html;
  }
  // đang kéo / cuộn bản đồ → ẩn lớp viền (URL chỉ cập nhật khi dừng), dừng lại thì vẽ theo vị trí mới
  let kcnUrl = '';
  let kcnDrawnUrl = '';
  let kcnMoving = 0;
  const kcnHide = () => {
    kcnSvg.style.visibility = 'hidden';
    kcnMoving = Date.now();
  };
  // chỉ thao tác TRÊN BẢN ĐỒ mới tính (cuộn danh sách kết quả / panel của mình / ô tìm kiếm thì bỏ qua → không vẽ lại, đỡ lag)
  const OFF_MAP = '#dg-maps,#dg-maps-side,#dg-kcn-list,div[role="feed"],div[role="main"],#searchbox,[role="navigation"],[role="dialog"],input,button';
  const onMap = (e) => {
    const t = e.target;
    if (!t?.closest) return false;
    if (t.closest(OFF_MAP)) return false;
    return t.tagName === 'CANVAS' || !!t.closest('#scene, [aria-label="Map"], .widget-scene');
  };
  addEventListener('wheel', (e) => onMap(e) && kcnHide(), { passive: true, capture: true });
  addEventListener('pointerdown', (e) => onMap(e) && kcnHide(), true);
  addEventListener('resize', () => kcnDraw());
  setInterval(() => {
    if (!kcnOn) return;
    if (location.href !== kcnUrl) {
      kcnUrl = location.href;
      kcnMoving = Date.now();
      kcnSvg.style.visibility = 'hidden';
      return;
    }
    if (kcnSvg.style.visibility === 'hidden' && Date.now() - kcnMoving > 600) {
      if (kcnDrawnUrl !== location.href) {
        kcnDrawnUrl = location.href;
        kcnDraw();
      }
      kcnSvg.style.visibility = 'visible';
      const v = mapView();
      if (v && v.z >= 10) kcnFetch(v).catch(() => {});
    }
  }, 250);
  // 🤖 Tự quét công ty khi đi ngang Long An, Bình Dương, TP.HCM, Đồng Nai, Bà Rịa – Vũng Tàu, Bình Phước, Tây Ninh:
  // bản đồ dừng ≥ 4 giây ở zoom ≥ 14 trong vùng, ô ~3 km chưa quét 30 ngày → tìm "công ty" tại chỗ (ô tìm kiếm) và lưu danh sách.
  // Chỉ chạy sau khi NGƯỜI DÙNG kéo / cuộn bản đồ (không tự quét dây chuyền khi kết quả làm bản đồ dời đi).
  const REGION = [
    [10.35, 106.0, 11.15, 106.95], // Long An – TP.HCM
    [10.75, 106.3, 11.85, 106.95], // Tây Ninh – Bình Dương
    [10.55, 106.75, 11.65, 107.55], // Đồng Nai
    [10.3, 106.95, 10.85, 107.6], // Bà Rịa – Vũng Tàu
    [11.25, 106.4, 12.3, 107.45], // Bình Phước
    [10.95, 105.8, 11.8, 106.5], // Tây Ninh
  ];
  const inRegion = (la, ln) => REGION.some(([s1, w1, n1, e1]) => la >= s1 && la <= n1 && ln >= w1 && ln <= e1);
  let autoScan = localStorage.getItem('dgMapsAutoScan') !== '0';
  let userMoved = false;
  let urlAt = Date.now();
  let urlNow = location.href;
  addEventListener('wheel', (e) => onMap(e) && (userMoved = true), { passive: true, capture: true });
  addEventListener('pointerdown', (e) => onMap(e) && (userMoved = true), true);
  const scanned = () => {
    try {
      return JSON.parse(localStorage.getItem('dgMapsScanned') || '{}');
    } catch {
      return {};
    }
  };
  // ---------- 🛰 Tự chạy 7 tỉnh: tự dời bản đồ qua từng ô ~5 km, tìm "công ty", lưu danh sách (đồng bộ cloud) ----------
  // Ô đã chạy đánh dấu kv mapsCrawl { "lat,lng": at } (đồng bộ mọi máy) → F5 / máy khác chỉ chạy tiếp ô CHƯA quét (30 ngày).
  // Mỗi ô nghỉ 20–35 giây. Google hiện trang chặn / CAPTCHA ("unusual traffic", /sorry/) → tự TẮT, không vượt.
  const CRAWL_STEP = 0.05;
  const CRAWL_CENTER = [10.98, 106.68]; // ưu tiên gần Bình Dương – TP.HCM trước
  const crawlCells = (() => {
    const set = new Map();
    for (const [s1, w1, n1, e1] of REGION)
      for (let a = Math.floor(s1 / CRAWL_STEP) * CRAWL_STEP; a <= n1; a += CRAWL_STEP)
        for (let b = Math.floor(w1 / CRAWL_STEP) * CRAWL_STEP; b <= e1; b += CRAWL_STEP) {
          const la = Number((a + CRAWL_STEP / 2).toFixed(3));
          const ln = Number((b + CRAWL_STEP / 2).toFixed(3));
          set.set(`${la},${ln}`, [la, ln]);
        }
    return [...set.entries()].sort((x, y) => Math.hypot(x[1][0] - CRAWL_CENTER[0], x[1][1] - CRAWL_CENTER[1]) - Math.hypot(y[1][0] - CRAWL_CENTER[0], y[1][1] - CRAWL_CENTER[1]));
  })();
  let crawlOn = localStorage.getItem('dgMapsCrawl') === '1';
  let crawlDone = null; // kv mapsCrawl
  const crawlSt = { phase: '', cell: '' };
  const crawlBlocked = () => /\/sorry\//.test(location.pathname) || /unusual traffic|lưu lượng truy cập bất thường|not a robot|không phải là người máy/i.test(document.body?.innerText?.slice(0, 3000) || '') || !!document.querySelector('iframe[src*="recaptcha"]');
  // 🏭 Tự quét KCN: danh sách KCN / CCN trong 7 tỉnh (Overpass "out bb", lưu kv kcnIndex 30 ngày – đồng bộ) + KCN tự vẽ.
  // Mỗi KCN chia điểm dừng ~2 km (zoom 16) → tìm "công ty" từng điểm; điểm xong đánh dấu chung kv mapsCrawl ("k:<kcn>:<i>").
  let crawlMode = localStorage.getItem('dgMapsCrawlMode') || 'grid'; // 'grid' (cả 7 tỉnh) | 'kcn'
  let kcnIndex = null;
  async function kcnIndexLoad(force = false) {
    if (kcnIndex && !force) return kcnIndex;
    const cur = (await kvGet('kcnIndex').catch(() => ({})))?.all;
    if (cur?.list?.length && Date.now() - cur.at < 30 * 86400e3 && !force) return (kcnIndex = cur.list);
    const bb = '10.3,105.8,12.3,107.6';
    const q = `[out:json][timeout:90];(way["landuse"="industrial"]["name"~"${KCN_RE}",i](${bb});relation["landuse"="industrial"]["name"~"${KCN_RE}",i](${bb});way["industrial"="industrial_park"](${bb});relation["industrial"="industrial_park"](${bb}););out tags bb;`;
    for (const host of KCN_HOSTS) {
      const res = await fetch(host, { method: 'POST', body: `data=${encodeURIComponent(q)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } }).catch(() => null);
      const j = res?.ok ? await res.json().catch(() => null) : null;
      if (!j) continue;
      const list = (j.elements || []).filter((e) => e.bounds && (e.tags?.name || e.tags?.['name:vi'])).map((e) => ({ id: `${e.type}/${e.id}`, name: e.tags.name || e.tags['name:vi'], bb: [e.bounds.minlat, e.bounds.minlon, e.bounds.maxlat, e.bounds.maxlon] }))
        .filter((k) => inRegion((k.bb[0] + k.bb[2]) / 2, (k.bb[1] + k.bb[3]) / 2));
      if (list.length) {
        await kvMerge('kcnIndex', { all: { at: Date.now(), list } });
        return (kcnIndex = list);
      }
    }
    return (kcnIndex = cur?.list || []);
  }
  // điểm dừng của các KCN (gần Bình Dương – TP.HCM trước; KCN tự vẽ cũng quét)
  function kcnStops() {
    const ks = [...(kcnIndex || [])];
    for (const [id, p] of Object.entries(kcnCustom || {})) {
      if (!p?.rings?.length || p.deleted) continue;
      const all = p.rings.flat();
      ks.push({ id: `c/${id}`, name: p.name, bb: [Math.min(...all.map((x) => x[0])), Math.min(...all.map((x) => x[1])), Math.max(...all.map((x) => x[0])), Math.max(...all.map((x) => x[1]))] });
    }
    const out = [];
    const ST = 0.02;
    for (const k of ks) {
      const [s1, w1, n1, e1] = k.bb;
      const ny = Math.max(1, Math.round((n1 - s1) / ST));
      const nx = Math.max(1, Math.round((e1 - w1) / ST));
      let i = 0;
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) out.push([`k:${k.id}:${i++}`, [Number((s1 + ((y + 0.5) * (n1 - s1)) / ny).toFixed(5)), Number((w1 + ((x + 0.5) * (e1 - w1)) / nx).toFixed(5)), 16], k.name]);
    }
    return out.sort((a, b) => Math.hypot(a[1][0] - CRAWL_CENTER[0], a[1][1] - CRAWL_CENTER[1]) - Math.hypot(b[1][0] - CRAWL_CENTER[0], b[1][1] - CRAWL_CENTER[1]));
  }
  const crawlList = () => (crawlMode === 'kcn' ? kcnStops() : crawlCells);
  const crawlLeft = () => crawlList().filter(([k]) => !(crawlDone?.[k] && Date.now() - crawlDone[k] < 30 * 86400e3));
  const kcnProgress = () => {
    const st = kcnStops();
    const byK = new Map();
    for (const [k, , name] of st) {
      const id = k.split(':').slice(1, -1).join(':');
      const g = byK.get(id) || { name, n: 0, done: 0 };
      g.n++;
      if (crawlDone?.[k] && Date.now() - crawlDone[k] < 30 * 86400e3) g.done++;
      byK.set(id, g);
    }
    const all = [...byK.values()];
    return { kcn: all.length, kcnDone: all.filter((g) => g.done === g.n).length, stops: st.length };
  };
  let crawlBusy = false;
  async function crawlTick() {
    if (!crawlOn || crawlBusy) return;
    crawlBusy = true;
    try {
      if (crawlBlocked()) {
        crawlOn = false;
        localStorage.setItem('dgMapsCrawl', '0');
        sessionStorage.removeItem('dgCrawlCell');
        msg = '⛔ Google hiện trang xác minh (unusual traffic / CAPTCHA) – đã TẮT tự chạy. Tự xác minh, đợi một lúc rồi bật lại.';
        draw();
        return;
      }
      crawlDone = crawlDone || (await kvGet('mapsCrawl').catch(() => ({}))) || {};
      const cur = sessionStorage.getItem('dgCrawlCell');
      if (cur) {
        // đang ở 1 ô: chờ danh sách hiện (≤ 25 giây) → cuộn lưu hết → đánh dấu ô xong
        const at = Number(sessionStorage.getItem('dgCrawlAt')) || 0;
        const feed = document.querySelector('div[role="feed"] div[role="article"]');
        if (!feed && Date.now() - at < 25e3) return;
        crawlSt.phase = 'save';
        crawlSt.cell = cur;
        if (feed) await saveFeedAll();
        else {
          const d = readDetail(); // chỉ 1 kết quả → Google mở thẳng bảng chi tiết
          if (d) await save([d]).catch(() => 0);
        }
        crawlDone[cur] = Date.now();
        await kvMerge('mapsCrawl', { [cur]: crawlDone[cur] });
        sessionStorage.removeItem('dgCrawlCell');
        sessionStorage.setItem('dgCrawlNext', String(Date.now() + 20e3 + Math.random() * 15e3));
        return;
      }
      const next = Number(sessionStorage.getItem('dgCrawlNext')) || 0;
      if (Date.now() < next) {
        crawlSt.phase = 'wait';
        return;
      }
      if (crawlMode === 'kcn' && !kcnIndex) {
        msg = '🏭 Đang lấy danh sách KCN trong 7 tỉnh…';
        draw();
        await kcnIndexLoad();
      }
      const left = crawlLeft();
      if (!left.length) {
        crawlOn = false;
        localStorage.setItem('dgMapsCrawl', '0');
        msg = crawlMode === 'kcn' ? (kcnIndex?.length ? '✅ Đã quét hết các KCN.' : '⚠️ Chưa lấy được danh sách KCN (máy chủ OSM bận) – thử lại sau.') : '✅ Đã chạy hết các ô trong 7 tỉnh.';
        draw();
        return;
      }
      const [k, [la, ln, zz], kname] = left[0];
      if (kname) {
        msg = `🏭 Đang quét ${kname}…`;
        draw();
      }
      sessionStorage.setItem('dgCrawlCell', k);
      sessionStorage.setItem('dgCrawlAt', String(Date.now()));
      crawlSt.phase = 'go';
      crawlSt.cell = k;
      location.href = `https://www.google.com/maps/search/c%C3%B4ng+ty/@${la},${ln},${zz || 15}z`;
    } catch {
    } finally {
      crawlBusy = false;
    }
  }
  setInterval(() => crawlTick().catch(() => {}), 2000);
  // máy khác chạy song song → cập nhật ô đã xong mỗi 2 phút
  setInterval(async () => {
    if (crawlOn) crawlDone = (await kvGet('mapsCrawl').catch(() => ({}))) || crawlDone;
  }, 120e3);
  async function autoScanTick() {
    if (!autoScan || busy || drawPts || crawlOn) return;
    if (location.href !== urlNow) {
      urlNow = location.href;
      urlAt = Date.now();
      return;
    }
    // khung đang xem chưa có công ty nào đã lưu → tự quét ngầm luôn, không cần người dùng kéo bản đồ / bấm quét
    const emptyHere = sideInView === 0;
    if ((!userMoved && !emptyHere) || Date.now() - urlAt < 2500) return;
    // 🔄 Đang có danh sách tìm kiếm mà vừa kéo / zoom sang chỗ khác → Google hiện nút "Search this area" (không tự tìm lại):
    // tự bấm rồi lưu danh sách mới – quét ngầm đúng các công ty trong khung đang xem
    const sta = [...document.querySelectorAll('button')].find((b) => /^(Search this area|Tìm kiếm khu vực này|Tìm khu vực này)$/i.test(b.innerText.trim()) && b.getClientRects().length);
    if (sta) {
      userMoved = false;
      msg = '🔄 Tự tìm lại công ty trong khung đang xem…';
      draw();
      const before = document.querySelector('div[role="feed"] div[role="article"] a[href*="/maps/place/"]')?.href || '';
      sta.click();
      for (let i = 0; i < 24; i++) {
        await sleep(500);
        const first = document.querySelector('div[role="feed"] div[role="article"] a[href*="/maps/place/"]')?.href || '';
        if (first && first !== before) break;
      }
      if (document.querySelector('div[role="feed"] div[role="article"]')) await saveFeedAll();
      urlNow = location.href;
      urlAt = Date.now();
      sideCalcKey = '';
      return;
    }
    if (Date.now() - urlAt < 4000) return;
    const v = mapView();
    if (!v || v.z < (emptyHere ? 13 : 14) || !inRegion(v.lat, v.lng)) return;
    const cell = `${Math.round(v.lat / 0.03)},${Math.round(v.lng / 0.03)}`;
    const sc = scanned();
    // ô đã quét: bình thường 30 ngày mới quét lại; khung trống thì 1 ngày (tránh quét lặp khi chỗ đó thật sự không có công ty)
    if (sc[cell] && Date.now() - sc[cell] < (emptyHere ? 86400e3 : 30 * 86400e3)) return;
    userMoved = false;
    sc[cell] = Date.now();
    try {
      localStorage.setItem('dgMapsScanned', JSON.stringify(sc));
    } catch {}
    const inp = document.querySelector('input#searchboxinput, input[name="q"]');
    const go = document.querySelector('button#searchbox-searchbutton, button[aria-label="Search"], button[aria-label="Tìm kiếm"]');
    if (!inp || !go) return;
    msg = '🤖 Tự quét công ty khu vực này…';
    draw();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, 'công ty');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    go.click();
    for (let i = 0; i < 20 && !document.querySelector('div[role="feed"] div[role="article"]'); i++) await sleep(500);
    if (document.querySelector('div[role="feed"] div[role="article"]')) {
      await saveFeedAll();
      urlNow = location.href;
      urlAt = Date.now();
    } else {
      msg = '';
      draw();
    }
  }
  setInterval(() => autoScanTick().catch(() => {}), 1000);

  // ✅ Đối chiếu khách hàng ERP (kv customersAll – đồng bộ từ trang Khách hàng): CHỈ theo tên công ty, giống 100% (không phân biệt hoa thường)
  // "Công ty TNHH / Cổ phần / MTV…", dấu, ký tự đặc biệt (tên ≥ 6 ký tự) → đánh dấu "tồn tại trong ERP"
  const ERP_HOST = 'https://sale.tuantu.com.vn';
  const unacc = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const coKey = (t) => unacc(t)
    .replace(/\b(cong ty|cty|ct|tnhh|co phan|cp|mtv|mot thanh vien|hai thanh vien|trach nhiem huu han|san xuat|thuong mai|dich vu|xuat nhap khau|xnk|tm|dv|sx|viet nam|vn|company|co\.?|ltd\.?|limited|corp\.?|corporation|jsc|vietnam|inc\.?)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
  const exactKey = (t) => String(t || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const phoneKey = (t) => String(t || '').replace(/\D/g, '').slice(-9);
  let erpIdx = null;
  let erpAt = 0;
  async function erpLoad() {
    if (erpIdx && Date.now() - erpAt < 5 * 60e3) return erpIdx;
    erpAt = Date.now();
    const all = (await kvGet('customersAll').catch(() => ({}))) || {};
    const byPhone = new Map();
    const byName = new Map();
    const byTax = new Map();
    const byCode = new Map(); // mã KH ERP (vd. "NOA", "HÀ KHANG") – thường là tên ngắn của công ty
    for (const c of Object.values(all)) {
      if (!c?.id) continue;
      for (const ph of [c.phone, c.deliveryPhone]) {
        const k = phoneKey(ph);
        if (k.length === 9) byPhone.set(k, c);
      }
      const nk = exactKey(c.name);
      if (nk) byName.set(nk, c);
      const ck = coKey(c.code);
      if (ck.length >= 3 && !byCode.has(ck)) byCode.set(ck, c);
      const tx = String(c.taxCode || '').replace(/[^\d-]/g, '');
      if (tx.length >= 10) byTax.set(tx.slice(0, 10), c);
    }
    erpIdx = { byPhone, byName, byTax, byCode, byId: new Map(Object.values(all).filter((c) => c?.id).map((c) => [String(c.id), c])), n: Object.keys(all).length };
    sideKey = '';
    return erpIdx;
  }
  erpLoad().catch(() => {});
  setInterval(() => erpLoad().catch(() => {}), 60e3);
  const erpOf = (c) => {
    if (!erpIdx || !c) return null;
    if (c.erpNo) return null; // đã bỏ kết nối ở tab 📍 Công ty Maps (ERP)
    if (c.erpId && erpIdx.byId?.has(String(c.erpId))) return erpIdx.byId.get(String(c.erpId)); // kết nối tay
    // tên giống 100% (chỉ không phân biệt HOA / thường, khoảng trắng thừa) – không bỏ "Công ty TNHH…", không bỏ dấu, không so mã KH
    const byKey = (t) => {
      const k = exactKey(t);
      return k ? erpIdx.byName.get(k) || null : null;
    };
    // đối chiếu theo TÊN công ty (tên trên Google Maps + tên chuẩn từ masothue), không dùng MST / SĐT
    return byKey(c.name) || (c.legalName && byKey(c.legalName)) || null;
  };
  // Tên hiển thị: có trong ERP → TÊN TRÊN ERP (ưu tiên), không thì tên chuẩn masothue, cuối cùng tên Google
  // 📍 Khoảng cách (km, đường chim bay) từ xưởng Tuấn Tú (48/13 KP Bình Phước B, An Phú) – như tab Công ty Maps
  let homeLL = null;
  const homeAt = () => {
    if (homeLL) return homeLL;
    const me = Object.values(cache || {}).find((c) => c?.lat && /tu[aấ]n\s*t[uú]/i.test(`${c.name} ${c.legalName || ''}`) && /48\/13|b[iì]nh ph[uư][oớ]c b/i.test(`${c.addr || ''} ${c.legalAddr || ''}`));
    return me ? (homeLL = [me.lat, me.lng]) : [10.9446, 106.7373];
  };
  const kmOf = (c) => {
    if (!c?.lat || !c?.lng) return null;
    const [la, ln] = homeAt();
    const r = Math.PI / 180;
    const x = Math.sin(((c.lat - la) * r) / 2) ** 2 + Math.cos(la * r) * Math.cos(c.lat * r) * Math.sin(((c.lng - ln) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(x));
  };
  const kmTag = (c) => { const d = kmOf(c); return d == null ? '' : `<b title="Khoảng cách đường chim bay từ xưởng Tuấn Tú" style="color:#0369a1;white-space:nowrap">📍 ${d.toFixed(1)} km</b> · `; };
  const rateTag = (c) => (c.rate ? ` <span title="Đánh giá Google Maps: ${c.rate} sao · ${c.rateN || 0} lượt" style="color:#b45309;font-size:11px;font-weight:800;white-space:nowrap">⭐ ${String(c.rate).replace('.', ',')}${c.rateN ? ` <span style="color:#94a3b8;font-weight:600">(${c.rateN.toLocaleString('vi-VN')})</span>` : ''}</span>` : '');
  const dispName = (c) => String(erpOf(c)?.name || c.legalName || c.name || '').toLocaleUpperCase('vi'); // tên công ty viết HOA toàn bộ
  const erpBadge = (c) => {
    const e = erpOf(c);
    return e ? ` <a href="${ERP_HOST}/khach-hang/view/${e.id}?dgNoPanel=1" target="_blank" rel="noopener" title="Tồn tại trong ERP: ${esc(e.name)}${e.staff?.name ? ` · NVKD ${esc(e.staff.name)}` : ''}${e.totalOrder ? ` · ${e.totalOrder} đơn` : ''}" style="display:inline-block;padding:0 6px;border-radius:6px;background:#dcfce7;border:1px solid #86efac;color:#166534;font-size:10.5px;font-weight:900;text-decoration:none;white-space:nowrap">✅ ERP${e.code ? ` · ${esc(e.code)}` : ''}</a>` : '';
  };

  // Bấm tên công ty (panel phải / danh sách KCN) → mở trong Google Maps KHÔNG tải lại trang: gõ "tên + địa chỉ" vào ô tìm kiếm
  // của Maps (ứng dụng tự dời bản đồ tới công ty và mở bảng chi tiết). Giữ Cmd/Ctrl khi bấm → mở tab mới như link thường.
  function goPlace(c) {
    const inp = document.querySelector('input#searchboxinput, input[name="q"]');
    const go = document.querySelector('button#searchbox-searchbutton, button[aria-label="Search"], button[aria-label="Tìm kiếm"]');
    if (!inp || !go) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, `${c.name}${c.addr && !/^[A-Z0-9]{4}\+[A-Z0-9]{2,3}$/.test(c.addr) ? `, ${c.addr}` : ''}`);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    go.click();
    return true;
  }
  // 🙈 Ẩn 1 công ty: cờ hidden lưu kv (đồng bộ) → không hiện ở panel / danh sách KCN / danh sách Google, không lưu đè, không tra MST
  async function hidePlace(id, on = true) {
    const c = cache?.[id];
    if (!c) return;
    const v = { ...c, hidden: on, hiddenAt: Date.now() };
    cache[id] = v;
    await kvMerge(KEY, { [id]: v });
    localSave();
    sideCalcKey = '';
    document.querySelectorAll('div[role="feed"] div[role="article"][data-dg-re]').forEach((x) => x.removeAttribute('data-dg-re'));
    draw();
  }
  document.addEventListener('click', (e) => {
    const h = e.target.closest?.('[data-hide]');
    if (h) {
      e.preventDefault();
      e.stopPropagation();
      h.closest('div')?.style.setProperty('opacity', '.3');
      hidePlace(h.dataset.hide).then(() => sideDraw());
      return;
    }
    const a = e.target.closest?.('a[data-go]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const c = cache?.[a.dataset.go];
    if (!c) return;
    if (goPlace(c)) {
      e.preventDefault();
      e.stopPropagation();
      side.querySelectorAll('[data-sel]').forEach((x) => x.removeAttribute('data-sel'));
      const row = a.closest('div');
      if (row) {
        row.dataset.sel = '1';
        row.style.outline = '2px solid #2563eb';
        setTimeout(() => (row.style.outline = ''), 2500);
      }
    }
  }, true);

  // 🧾 Chuẩn hoá tên + MST từ masothue.com: NGẦM, mỗi 15 giây 1 công ty chưa có MST (qua background – không CORS, không lag).
  // Chọn kết quả khớp nhất (tên đã bỏ loại hình / dấu, đường / KCN trong địa chỉ, tỉnh mới sau sáp nhập); đủ chắc (≥ 0,75) mới lưu.
  // Không khớp → đánh dấu mstSkip, KHÔNG tra lại. Bị chặn / lỗi → nghỉ 10 phút.
  const MST_STOP = new Set(['cong', 'ty', 'tnhh', 'co', 'phan', 'cp', 'mtv', 'mot', 'thanh', 'vien', 'viet', 'nam', 'vn', 'company', 'limited', 'ltd', 'chi', 'nhanh', 'san', 'xuat', 'thuong', 'mai', 'dich', 'vu', 'va', 'xuat', 'nhap', 'khau', 'tm', 'dv', 'sx']);
  const words = (t) => unacc(t).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !MST_STOP.has(w));
  function mstScore(c, r) {
    const a = coKey(c.name);
    const b = coKey(r.name);
    let sc = 0;
    if (a && a === b) sc = 1;
    else if (a.length >= 5 && b.length >= 5 && (b.includes(a) || a.includes(b))) sc = 0.8;
    else {
      const wa = new Set(words(c.name));
      const wb = new Set(words(r.name));
      const inter = [...wa].filter((w) => wb.has(w)).length;
      sc = wa.size && wb.size ? (inter / Math.max(wa.size, wb.size)) * 0.8 : 0;
    }
    const ra = unacc(r.addr);
    // đường / lô trong địa chỉ Google (vd. "Đường số 6 Vsip II", "Đ. N6b") có trong địa chỉ đăng ký
    const at = words(c.addr).filter((w) => w.length >= 2 && !/^(duong|so|d|lo|kcn|khu|binh|duong)$/.test(w));
    if (at.length && at.filter((w) => ra.includes(w)).length / at.length >= 0.5) sc += 0.15;
    if (c.kcn && words(c.kcn).filter((w) => !/^(khu|cong|nghiep|kcn)$/.test(w)).every((w) => ra.includes(w))) sc += 0.15;
    if (/ho chi minh|dong nai|tay ninh|binh duong|long an|vung tau|binh phuoc/.test(ra)) sc += 0.05;
    else sc -= 0.2;
    return Math.round(sc * 100) / 100;
  }
  function mstParse(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('div[data-prefetch]')].map((d) => {
      const a = d.querySelector('h3 a');
      const href = a?.getAttribute('href') || '';
      const mst = (href.match(/^\/(\d{10}(?:-\d{3})?)-/) || [])[1] || (d.innerText.match(/Mã số thuế:\s*([\d-]{10,14})/) || [])[1] || '';
      const txt = (d.textContent || '').replace(/\s+/g, ' ').trim();
      const addr = txt.replace(/^.*?Người đại diện:\s*[^,]*?(?=\s(?:Số|Lô|Thửa|Nhà|Đường|KCN|Khu|Ấp|Tổ|\d))/i, '').replace(/^.*?Mã số thuế:\s*[\d-]+\s*/, '').trim();
      return { name: (a?.textContent || '').trim(), mst, addr, href: href ? `https://masothue.com${href}` : '' };
    }).filter((r) => r.name && r.mst);
  }
  let mstPause = 0;
  const mstSt = { phase: 'idle', name: '', at: 0, last: '' }; // tiến trình tra masothue – hiện ở cuối panel phải
  let mstTabAlive = false;
  let mstBusy = false;
  async function mstTick() {
    if (mstBusy || Date.now() < mstPause || !cache) return;
    const c = Object.values(cache).find((x) => x?.name && !isRealEstate(x) && !x.mst && !x.mstTry && !x.mstSkip && /c[oô]ng ty|cty|company|co\.,? ?ltd|tnhh|cổ phần|jsc|corp/i.test(x.name));
    if (!c) {
      mstSt.phase = 'done';
      return;
    }
    mstBusy = true;
    mstSt.phase = 'search';
    mstSt.name = c.name;
    mstSt.at = Date.now();
    try {
      const q = c.name.replace(/\s*[-–|(].*$/, '').trim() || c.name;
      let list = null;
      // 1) thử gọi thẳng qua background; masothue (Cloudflare) chặn → chuyển hẳn sang "tab tra MST" (kv mstJobs)
      if (localStorage.getItem('dgMstMode') !== 'tab') {
        const r = await call({ type: 'http', url: `https://masothue.com/Search/?q=${encodeURIComponent(q)}&type=auto&force-search=1` }).catch(() => null);
        if (r?.ok && !/Attention Required|Just a moment/i.test(r.text.slice(0, 3000))) {
          list = mstParse(r.text);
          if (!list.length) {
            const d = new DOMParser().parseFromString(r.text, 'text/html');
            const nm = d.querySelector('table.table-taxinfo thead th, h1')?.textContent.trim() || '';
            const mm = (d.querySelector('td[itemprop="taxID"]')?.textContent || '').trim();
            const ad = (d.querySelector('td[itemprop="address"]')?.textContent || '').trim();
            if (nm && mm) list.push({ name: nm.replace(/^Mã số thuế\s*[\d-]+\s*-\s*/i, ''), mst: mm, addr: ad, href: '' });
          }
        } else localStorage.setItem('dgMstMode', 'tab');
      }
      if (!list) {
        // 2) tab tra MST: cần 1 tab masothue.com mở bằng đường dẫn #dgmst (khung 📍 có nút mở)
        const alive = await kvGet('mstAlive').catch(() => ({}));
        mstTabAlive = Date.now() - (alive?.at || 0) < 20e3;
        if (!mstTabAlive) {
          mstSt.phase = 'notab';
          return;
        }
        mstSt.phase = 'tab';
        const jid = `${Date.now().toString(36)}-${c.id.slice(-6)}`;
        const old = await kvGet('mstJobs').catch(() => ({}));
        const keep = Object.fromEntries(Object.entries(old).filter(([, j]) => Date.now() - (j?.at || 0) < 6 * 3600e3).map(([k, j]) => [k, j]));
        await call({ type: 'kv.set', key: 'mstJobs', value: { ...keep, [jid]: { q, at: Date.now(), status: 'pending', place: c.id } } });
        for (let i = 0; i < 60; i++) {
          await sleep(1500);
          const j = (await kvGet('mstJobs').catch(() => ({})))[jid];
          if (j?.status === 'done') {
            list = j.list || [];
            break;
          }
          if (j?.status === 'working') mstSt.phase = 'tabwork';
          if (j?.status === 'blocked') {
            mstSt.phase = 'blocked';
            mstPause = Date.now() + 60e3;
            msg = '⚠️ masothue cần xác minh – mở tab masothue để tự xác minh.';
            draw();
            return;
          }
        }
        if (!list) return;
      }
      const ranked = list.map((x) => ({ ...x, score: mstScore(c, x) })).sort((a, b) => b.score - a.score);
      const best = ranked[0];
      // nhiều kết quả gần bằng điểm nhau (chênh < 0,1) mà không có bằng chứng địa chỉ → không chắc, bỏ qua
      const sure = best && best.score >= 0.75 && (!ranked[1] || best.score - ranked[1].score >= 0.1 || best.score >= 1.1);
      const patch = sure
        ? { ...c, legalName: best.name, mst: best.mst, legalAddr: best.addr, mstScore: best.score, mstUrl: best.href, mstAt: Date.now(), mstTry: Date.now() }
        : { ...c, mstTry: Date.now(), mstSkip: true, mstCands: ranked.slice(0, 3).map((x) => ({ name: x.name, mst: x.mst, score: x.score })) };
      cache[c.id] = patch;
      await kvMerge(KEY, { [c.id]: patch });
      localSave();
      mstSt.last = patch.mst ? `✅ ${c.name} → MST ${patch.mst}` : `➖ ${c.name}: không chắc chắn, bỏ qua`;
      mstSt.phase = 'wait';
      sideCalcKey = '';
    } catch {
      mstPause = Date.now() + 10 * 60e3;
    } finally {
      mstBusy = false;
    }
  }
  setInterval(() => mstTick().catch(() => {}), 15e3);
  function mstBarDraw() {
    if (!side.isConnected || sideMin) return (mstBar.style.display = 'none');
    mstBar.style.display = '';
    const all = Object.values(cache || {}).filter((x) => x?.name && !isRealEstate(x));
    const done = all.filter((x) => x.mst).length;
    const skip = all.filter((x) => !x.mst && (x.mstTry || x.mstSkip)).length;
    const left = all.filter((x) => !x.mst && !x.mstTry && !x.mstSkip && /c[oô]ng ty|cty|company|co\.,? ?ltd|tnhh|cổ phần|jsc|corp/i.test(x.name)).length;
    const pct = all.length ? Math.round(((done + skip) / Math.max(1, done + skip + left)) * 100) : 0;
    const sec = Math.round((Date.now() - mstSt.at) / 1000);
    const ph = Date.now() < mstPause && mstSt.phase !== 'blocked' ? `⏸ Tạm nghỉ (masothue lỗi / bận) – thử lại sau ${Math.ceil((mstPause - Date.now()) / 60e3)} phút`
      : { search: `🔎 Đang tra masothue: <b>${esc(mstSt.name)}</b> (${sec}s)`, tab: `⏳ Đã gửi tab masothue: <b>${esc(mstSt.name)}</b> – chờ tới lượt (${sec}s)`, tabwork: `🔎 Tab masothue đang tra: <b>${esc(mstSt.name)}</b> (${sec}s)`, blocked: '⚠️ masothue cần xác minh (Cloudflare) – mở tab masothue để tự xác minh', notab: `🧾 Chưa có tab tra MST – bấm <a href="https://masothue.com/#dgmst" target="_blank" rel="noopener" style="color:#6d28d9;font-weight:800">Mở tab tra MST</a>`, wait: '⏱ Chờ 15 giây rồi tra công ty kế tiếp…', done: '✅ Đã tra hết các công ty đang có', idle: '⏱ Chuẩn bị tra MST…' }[mstSt.phase] || '';
    mstBar.innerHTML = `<div style="display:flex;align-items:center;gap:6px"><b>🧾 MST</b><span style="flex:1;height:6px;background:#ede9fe;border-radius:4px;overflow:hidden"><span style="display:block;height:100%;width:${pct}%;background:#7c3aed"></span></span><span>${done} có · ${skip} không rõ · còn ${left}</span></div><div>${ph}</div>${mstSt.last ? `<div style="color:#64748b">${esc(mstSt.last)}</div>` : ''}<div style="color:#0f766e;border-top:1px dashed #e9d5ff;margin-top:3px;padding-top:3px">🏷 Ngành: ${all.filter((x) => x.ind).length}/${all.length} đã gắn${indSt.phase === 'run' ? ` · 🤖 AI đang gắn ${indSt.n} công ty…` : indSt.last ? ` · ${esc(indSt.last)}` : ''}</div><div style="color:#15803d">📦 Tiềm năng thùng: ${all.filter((x) => x.box).length}/${all.length} đã chấm · <b>${all.filter((x) => x.box === 'A').length} cao</b> · ${all.filter((x) => x.box === 'B').length} vừa${boxSt.phase === 'run' ? ` · 🤖 AI đang chấm ${boxSt.n} công ty…` : boxSt.last ? ` · ${esc(boxSt.last)}` : ''}</div><div style="color:#92400e">📐 Diện tích xưởng: ${all.filter((x) => x.area != null).length}/${all.length} đã đo · <b>${all.filter((x) => x.area >= 5000).length} xưởng ≥ 5.000 m²</b>${areaSt.phase === 'run' ? ` · 🗺 đang đo ${areaSt.n} công ty…` : areaSt.last ? ` · ${esc(areaSt.last)}` : ''}</div>`;
  }
  setInterval(mstBarDraw, 1000);

  // Icon MST cạnh tên: ✅ đã tìm đúng MST (xanh) · ❓ không rõ (xám, không tra lại) · ⏳ chưa tra
  const mstIcon = (c) => c.mst
    ? ` <span title="Đã tìm đúng MST ${esc(c.mst)} – ${esc(c.legalName || '')}" style="display:inline-block;padding:0 5px;border-radius:6px;background:#dcfce7;color:#15803d;font-size:10.5px;font-weight:900;white-space:nowrap">✅ MST</span>`
    : c.mstTry || c.mstSkip
      ? ` <span title="MST không rõ – masothue không có kết quả đủ chắc, không tra lại${(c.mstCands || []).length ? `\nGần nhất: ${esc(c.mstCands.map((x) => `${x.name} (${x.mst})`).join(' · '))}` : ''}" style="display:inline-block;padding:0 5px;border-radius:6px;background:#f1f5f9;color:#94a3b8;font-size:10.5px;font-weight:900;white-space:nowrap">❓ MST</span>`
      : ` <span title="Chưa tra MST – đang chờ lượt" style="color:#cbd5e1;font-size:10.5px">⏳</span>`;

  // 🏷 AI gắn nhãn ngành nghề: mỗi phút 1 lô ≤ 25 công ty chưa có nhãn → OpenAI (key ở ⚙️ Cài đặt)
  // chọn 1 ngành trong danh sách cố định theo tên / tên pháp lý / loại hình Google → c.ind (lưu kv, đồng bộ). Lỗi → nghỉ 10 phút.
  const INDS = ['Thực phẩm – đồ uống', 'Nông sản – chăn nuôi – thức ăn CN', 'Dệt may – may mặc', 'Giày da – túi xách', 'Gỗ – nội thất', 'Giấy – bao bì – in ấn', 'Nhựa – cao su', 'Hoá chất – sơn – mực', 'Dược – mỹ phẩm – y tế', 'Điện – điện tử', 'Cơ khí – kim loại – thép', 'Ô tô – xe máy – phụ tùng', 'Vật liệu xây dựng – gốm sứ – kính', 'Logistics – kho vận – vận tải', 'Thương mại – XNK', 'Thiết bị – máy móc công nghiệp', 'Đồ chơi – quà tặng – văn phòng phẩm', 'Năng lượng – môi trường', 'Dịch vụ – tư vấn – phần mềm', 'Khác'];
  const IND_COL = { 'Thực phẩm – đồ uống': '#ea580c', 'Nông sản – chăn nuôi – thức ăn CN': '#65a30d', 'Dệt may – may mặc': '#db2777', 'Giày da – túi xách': '#9a3412', 'Gỗ – nội thất': '#a16207', 'Giấy – bao bì – in ấn': '#0891b2', 'Nhựa – cao su': '#7c3aed', 'Hoá chất – sơn – mực': '#dc2626', 'Dược – mỹ phẩm – y tế': '#e11d48', 'Điện – điện tử': '#2563eb', 'Cơ khí – kim loại – thép': '#475569', 'Ô tô – xe máy – phụ tùng': '#334155', 'Vật liệu xây dựng – gốm sứ – kính': '#78716c', 'Logistics – kho vận – vận tải': '#0d9488', 'Thương mại – XNK': '#4f46e5', 'Thiết bị – máy móc công nghiệp': '#52525b', 'Đồ chơi – quà tặng – văn phòng phẩm': '#c026d3', 'Năng lượng – môi trường': '#16a34a', 'Dịch vụ – tư vấn – phần mềm': '#64748b', Khác: '#94a3b8' };
  const indTag = (c) => (c.ind ? ` <span title="Ngành (AI gắn nhãn)" style="display:inline-block;padding:0 6px;border-radius:6px;background:${IND_COL[c.ind] || '#94a3b8'}1a;border:1px solid ${IND_COL[c.ind] || '#94a3b8'}55;color:${IND_COL[c.ind] || '#64748b'};font-size:10.5px;font-weight:800;white-space:nowrap">🏷 ${esc(c.ind)}</span>` : '');
  let indPause = 0;
  let indBusy = false;
  const indSt = { phase: 'idle', n: 0, last: '' };
  async function indTick() {
    if (indBusy || Date.now() < indPause || !cache) return;
    const todo = Object.values(cache).filter((x) => x?.name && !isRealEstate(x) && !x.ind && !(x.indTry && Date.now() - x.indTry < 86400e3)).slice(0, 25);
    if (!todo.length) return (indSt.phase = 'done');
    indBusy = true;
    indSt.phase = 'run';
    indSt.n = todo.length;
    try {
      const lines = todo.map((c, i) => `${i + 1}. ${c.legalName || c.name}${c.legalName && c.legalName !== c.name ? ` (Google: ${c.name})` : ''}${c.cat ? ` | loại hình Google: ${c.cat}` : ''}`).join('\n');
      const text = await aiAsk({
        maxTokens: 2000,
        system: 'Bạn phân loại ngành nghề doanh nghiệp Việt Nam (khu công nghiệp miền Nam) cho đội bán hàng thùng carton. Chỉ trả JSON, không giải thích.',
        prompt: `Gắn đúng 1 ngành cho mỗi công ty, CHỈ chọn trong danh sách:\n${INDS.map((x) => `- ${x}`).join('\n')}\nĐoán theo tên công ty, tên pháp lý và loại hình Google; không chắc thì chọn "Khác".\nTrả về JSON mảng: [{"i":1,"nganh":"…"}, …]\n\nCông ty:\n${lines}`,
      });
      const arr = JSON.parse((text.match(/\[[\s\S]*\]/) || ['[]'])[0]);
      const patch = {};
      for (const [i, c] of todo.entries()) {
        const r = arr.find((x) => Number(x.i) === i + 1);
        const ind = INDS.includes(r?.nganh) ? r.nganh : '';
        const v = ind ? { ...c, ind, indAt: Date.now() } : { ...c, indTry: Date.now() };
        cache[c.id] = v;
        patch[c.id] = v;
      }
      await kvMerge(KEY, patch);
      localSave();
      indSt.last = `🏷 Đã gắn ngành ${Object.values(patch).filter((x) => x.ind).length}/${todo.length} công ty`;
      indSt.phase = 'wait';
      sideCalcKey = '';
      document.querySelectorAll('div[role="feed"] div[role="article"][data-dg-re="0"]').forEach((x) => x.removeAttribute('data-dg-re'));
    } catch (e) {
      indSt.phase = 'err';
      indSt.last = `⚠️ AI gắn ngành lỗi: ${String(e.message || e).slice(0, 80)} – thử lại sau 10 phút`;
      indPause = Date.now() + 10 * 60e3;
    } finally {
      indBusy = false;
    }
  }
  setTimeout(() => indTick().catch(() => {}), 20e3);
  setInterval(() => indTick().catch(() => {}), 60e3);

  // 📐 Diện tích nhà xưởng từ OpenStreetMap: mỗi 30 giây 1 lô ≤ 20 công ty chưa đo → 1 truy vấn Overpass (nhà quanh mỗi điểm 60 m)
  // → nhà CHỨA điểm công ty; không có thì nhà lớn nhất trong 40 m. Lưu c.area (m², mái xưởng) + areaTry; OSM chưa vẽ → area 0.
  // Gần đúng (chỉ là diện tích mái nhà OSM đã vẽ), dùng để lọc / sắp xưởng lớn trước.
  const AREA_HOSTS = ['https://maps.mail.ru/osm/tools/overpass/api/interpreter', ...KCN_HOSTS];
  const areaSt = { phase: '', n: 0, last: '' };
  let areaBusy = false;
  let areaPause = 0;
  const polyArea = (ring) => {
    const la0 = (ring[0][0] * Math.PI) / 180;
    const R = 6371000;
    const pts = ring.map(([la, ln]) => [((ln * Math.PI) / 180) * R * Math.cos(la0), ((la * Math.PI) / 180) * R]);
    let a = 0;
    for (let i = 0; i < pts.length - 1; i++) a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
    return Math.abs(a) / 2;
  };
  const metersTo = (la, ln, ring) => {
    const cy = ring.reduce((a, x) => a + x[0], 0) / ring.length;
    const cx = ring.reduce((a, x) => a + x[1], 0) / ring.length;
    return Math.hypot((cy - la) * 111320, (cx - ln) * 111320 * Math.cos((la * Math.PI) / 180));
  };
  async function areaTick() {
    if (areaBusy || Date.now() < areaPause || !cache) return;
    const todo = Object.values(cache).filter((x) => x?.lat && x.lng && !isRealEstate(x) && x.area == null && !(x.areaTry && Date.now() - x.areaTry < 7 * 86400e3)).slice(0, 20);
    if (!todo.length) return (areaSt.phase = 'done');
    areaBusy = true;
    areaSt.phase = 'run';
    areaSt.n = todo.length;
    try {
      const q = `[out:json][timeout:60];(${todo.map((c) => `way["building"](around:60,${c.lat},${c.lng});`).join('')});out geom;`;
      let j = null;
      for (const host of AREA_HOSTS) {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 70e3);
        const res = await fetch(host, { method: 'POST', body: `data=${encodeURIComponent(q)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: ac.signal }).catch(() => null);
        clearTimeout(to);
        if (res?.ok) j = await res.json().catch(() => null);
        if (j) break;
      }
      if (!j) {
        areaPause = Date.now() + 3 * 60e3;
        areaSt.phase = 'err';
        areaSt.last = '⚠️ Máy chủ OSM bận – thử lại sau 3 phút';
        return;
      }
      const bs = (j.elements || []).filter((e) => e.geometry?.length > 3).map((e) => ({ ring: e.geometry.map((g) => [g.lat, g.lon]) }));
      for (const b of bs) b.a = polyArea(b.ring);
      const patch = {};
      let got = 0;
      for (const c of todo) {
        const inside = bs.filter((b) => inRing(c.lat, c.lng, b.ring)).sort((a, b) => b.a - a.a)[0];
        const near = inside || bs.filter((b) => metersTo(c.lat, c.lng, b.ring) <= 40).sort((a, b) => b.a - a.a)[0];
        const area = near ? Math.round(near.a) : 0;
        if (area) got++;
        const v = { ...c, area, areaSrc: near ? (inside ? 'osm' : 'osm-near') : '', areaTry: Date.now() };
        cache[c.id] = v;
        patch[c.id] = v;
      }
      await kvMerge(KEY, patch);
      areaSt.phase = 'wait';
      areaSt.last = `📐 Đo được ${got}/${todo.length} công ty`;
      sideCalcKey = '';
    } catch {
      areaPause = Date.now() + 3 * 60e3;
    } finally {
      areaBusy = false;
    }
  }
  setTimeout(() => areaTick().catch(() => {}), 30e3);
  setInterval(() => areaTick().catch(() => {}), 30e3);
  const areaTag = (c) => (c.area > 0 ? ` <span title="Diện tích mái nhà xưởng (OpenStreetMap${c.areaSrc === 'osm-near' ? ', nhà gần nhất' : ''}) – gần đúng" style="display:inline-block;padding:0 6px;border-radius:6px;background:${c.area >= 5000 ? '#fef3c7' : '#f1f5f9'};border:1px solid ${c.area >= 5000 ? '#f59e0b' : '#e2e8f0'};color:${c.area >= 5000 ? '#92400e' : '#475569'};font-size:10.5px;font-weight:900;white-space:nowrap">📐 ${c.area.toLocaleString('vi-VN')} m²</span>` : '');

  // 📦 AI chấm khả năng dùng THÙNG CARTON / THÙNG OFFSET (in offset) số lượng lớn: A = cao · B = vừa · C = thấp (+ lý do ngắn)
  // mỗi phút 1 lô ≤ 25 công ty chưa chấm (chạy lệch 30 giây với gắn ngành) → c.box / c.boxWhy (lưu kv, đồng bộ). Lỗi → nghỉ 10 phút.
  const BOX_LB = { A: '📦 Thùng: cao', B: '📦 Thùng: vừa', C: '📦 Thùng: thấp' };
  const BOX_COL = { A: '#15803d', B: '#b45309', C: '#94a3b8' };
  const boxTag = (c) => (c.box && c.box !== 'C' ? ` <span title="AI đánh giá khả năng dùng thùng carton / thùng offset số lượng lớn${c.boxWhy ? `: ${esc(c.boxWhy)}` : ''}" style="display:inline-block;padding:0 6px;border-radius:6px;background:${BOX_COL[c.box]}1a;border:1px solid ${BOX_COL[c.box]}66;color:${BOX_COL[c.box]};font-size:10.5px;font-weight:900;white-space:nowrap">${BOX_LB[c.box]}</span>` : '');
  let boxPause = 0;
  let boxBusy = false;
  const boxSt = { phase: 'idle', n: 0, last: '' };
  async function boxTick() {
    if (boxBusy || Date.now() < boxPause || !cache || document.visibilityState !== 'visible') return;
    const todo = Object.values(cache).filter((x) => x?.name && !x.hidden && !isRealEstate(x) && !x.box && !(x.boxTry && Date.now() - x.boxTry < 86400e3)).slice(0, 25);
    if (!todo.length) return (boxSt.phase = 'done');
    boxBusy = true;
    boxSt.phase = 'run';
    boxSt.n = todo.length;
    try {
      const lines = todo.map((c, i) => `${i + 1}. ${c.legalName || c.name}${c.legalName && c.legalName !== c.name ? ` (Google: ${c.name})` : ''}${c.cat ? ` | loại hình Google: ${c.cat}` : ''}${c.ind ? ` | ngành: ${c.ind}` : ''}${c.kcn ? ` | ${c.kcn}` : ''}`).join('\n');
      const text = await aiAsk({
        maxTokens: 3000,
        system: 'Bạn là chuyên viên bán hàng của nhà máy sản xuất thùng carton sóng và thùng / hộp in offset tại Bình Dương. Đánh giá khách hàng tiềm năng. Chỉ trả JSON, không giải thích.',
        prompt: `Với mỗi công ty, đánh giá khả năng công ty CẦN MUA THÙNG CARTON (đóng gói, vận chuyển thành phẩm) hoặc THÙNG / HỘP IN OFFSET với SỐ LƯỢNG LỚN, thường xuyên:\n- "A" = cao: nhà máy sản xuất hàng hoá đóng thùng xuất / bán số lượng lớn (thực phẩm, đồ uống, bánh kẹo, nông sản chế biến, thức ăn chăn nuôi, dệt may, giày dép, túi xách, đồ gỗ – nội thất, điện tử, linh kiện, đồ gia dụng, nhựa gia dụng, mỹ phẩm, dược phẩm, hoá phẩm tiêu dùng, đồ chơi, văn phòng phẩm, phụ tùng, thiết bị nhỏ…), công ty FDI sản xuất trong KCN.\n- "B" = vừa: sản xuất nhưng hàng cồng kềnh / đóng gói khác (bao, pallet, cuộn, phuy…), sản xuất nhỏ, xưởng gia công, thương mại – phân phối hàng đóng thùng, kho vận.\n- "C" = thấp: dịch vụ, tư vấn, phần mềm, xây dựng, vận tải, vật liệu rời (cát đá, thép cuộn, hoá chất bồn), văn phòng đại diện, nhà hàng – bán lẻ nhỏ, hoặc không rõ.\nĐoán theo tên công ty, tên pháp lý, loại hình Google, ngành.\nTrả về JSON mảng: [{"i":1,"m":"A","ly":"lý do ≤ 12 chữ"}, …]\n\nCông ty:\n${lines}`,
      });
      const arr = JSON.parse((text.match(/\[[\s\S]*\]/) || ['[]'])[0]);
      const patch = {};
      for (const [i, c] of todo.entries()) {
        const r = arr.find((x) => Number(x.i) === i + 1);
        const m = ['A', 'B', 'C'].includes(String(r?.m || '').toUpperCase()) ? String(r.m).toUpperCase() : '';
        const v = m ? { ...c, box: m, boxWhy: String(r.ly || '').slice(0, 80), boxAt: Date.now() } : { ...c, boxTry: Date.now() };
        cache[c.id] = v;
        patch[c.id] = v;
      }
      await kvMerge(KEY, patch);
      localSave();
      const vals = Object.values(patch);
      boxSt.last = `📦 Đã chấm ${vals.filter((x) => x.box).length}/${todo.length} công ty (${vals.filter((x) => x.box === 'A').length} cao)`;
      boxSt.phase = 'wait';
      sideCalcKey = '';
    } catch (e) {
      boxSt.phase = 'err';
      boxSt.last = `⚠️ AI chấm thùng lỗi: ${String(e.message || e).slice(0, 80)} – thử lại sau 10 phút`;
      boxPause = Date.now() + 10 * 60e3;
    } finally {
      boxBusy = false;
    }
  }
  setTimeout(() => boxTick().catch(() => {}), 50e3);
  setInterval(() => boxTick().catch(() => {}), 60e3);

  // 🌏 Tên có từ KHÔNG phải tiếng Việt (thường là công ty FDI): bỏ các từ chung (công ty, TNHH, Việt Nam…), từ nào không dấu và
  // không đúng cấu trúc âm tiết tiếng Việt (phụ âm đầu + vần + âm cuối) → từ nước ngoài (vd. Win, Graphics, Stanley, Vina, Sehwa)
  const VN_SYL = /^(ngh|ch|gh|gi|kh|ng|nh|ph|qu|th|tr|[bcdghklmnpqrstvx])?(uye|uya|ieu|yeu|uoi|uou|oai|oay|uay|uya|ai|ao|au|ay|eo|eu|ia|ie|iu|oa|oe|oi|ua|ue|ui|uo|uy|ye|ya|a|e|i|o|u|y)(ch|ng|nh|c|m|n|p|t)?$/;
  const GENERIC = /\b(cong|ty|cty|tnhh|mtv|cp|co|phan|chi|nhanh|viet|nam|vietnam|vn|company|limited|ltd|jsc|corp|corporation|inc|group)\b/g;
  const foreignName = (c) => {
    const raw = String(c.legalName || c.name || '');
    const words = raw.replace(/\(.*?\)/g, ' ').split(/[^\p{L}0-9]+/u).filter((w) => w.length >= 3 && !/\d/.test(w));
    return words.some((w) => {
      if (/[^\x00-\x7F]/.test(w)) return false; // có dấu tiếng Việt → từ Việt
      const u = w.toLowerCase();
      if (GENERIC.test(` ${u} `)) return (GENERIC.lastIndex = 0), false;
      GENERIC.lastIndex = 0;
      return !VN_SYL.test(u);
    });
  };

  // 🖨 Bản in dùng chung scripts/shared/company-pdf.js (giống tab 📍 Công ty Maps trên CRM)
  function exportPdf(list, title, pre = null) {
    const rows = (list || []).filter((c) => c?.name && !isRealEstate(c)).map((c) => {
      const e = erpOf(c);
      return { name: dispName(c), mst: c.mst, ind: c.ind, addr: c.legalAddr || c.addr, phone: c.phone, kcn: c.kcn || kcnOf(c) || '', erp: e ? { id: e.id, code: e.code, staffName: e.staff?.name || '' } : null };
    });
    dgCompanyPdf({ title, rows, erpHost: ERP_HOST, pre });
  }

  // In TẤT CẢ công ty trên cloud: mở trước cửa sổ in (giữ thao tác bấm, không bị chặn pop-up), đồng bộ cloud (≤ 20 giây) rồi in
  async function exportAllPdf(btn) {
    const label = btn?.textContent;
    // mở cửa sổ NGAY lúc bấm (sau khi chờ đồng bộ, trình duyệt sẽ chặn pop-up)
    const w = window.open('', '_blank');
    if (!w) return alert('Trình duyệt chặn cửa sổ in – cho phép pop-up của google.com rồi bấm lại.');
    w.document.write('<p style="font:14px sans-serif;padding:20px">⏳ Đang đồng bộ cloud và dựng danh sách công ty…</p>');
    if (btn) btn.textContent = '⏳ Đang lấy dữ liệu cloud…';
    try {
      await Promise.race([call({ type: 'sync.all' }).catch(() => {}), sleep(20e3)]);
      cache = (await kvGet(KEY).catch(() => ({}))) || cache;
      erpAt = 0;
      await erpLoad().catch(() => {});
      exportPdf(Object.values(cache), 'Danh sách tất cả công ty (Google Maps – cloud)', w);
    } finally {
      if (btn) btn.textContent = label;
    }
  }

  // Tỉnh (theo ranh giới cũ – 7 tỉnh) của 1 KCN: ưu tiên chữ trong tên KCN, không có thì đoán theo toạ độ tâm KCN
  const PROV_ORDER = ['Bình Dương', 'TP.HCM', 'Đồng Nai', 'Long An', 'Bà Rịa – Vũng Tàu', 'Bình Phước', 'Tây Ninh', 'Khác'];
  const PROV_KW = [
    ['Bình Dương', /binh duong|vsip|my phuoc|bau bang|song than|dong an|tan uyen|ben cat|di an|thuan an|nam tan uyen|rach bap|kim huy|dai dang|viet huong|phu tan|ascendas|protrade|bac tan uyen|dat cuoc|an tay|tan dong hiep|binh an|mai trung|song than|viet nam - singapore/],
    ['TP.HCM', /ho chi minh|hcm|cu chi|cat lai|tan thuan|hiep phuoc|tan binh|tan tao|vinh loc|le minh xuan|linh trung|cong nghe cao|binh chieu|tay bac cu chi|dong nam cu chi|phong phu|da phuoc|an ha|cat lai/],
    ['Đồng Nai', /dong nai|bien hoa|nhon trach|long thanh|amata|loteco|ho nai|song may|tam phuoc|an phuoc|go dau|dinh quan|dau giay|xuan loc|long khanh|ong keo|bau xeo|tan phu|thanh phu|giang dien|long duc|loc an|tam phuoc|agtex|bien hoa/],
    ['Long An', /long an|duc hoa|ben luc|can giuoc|can duoc|tan duc|hai son|xuyen a|thuan dao|phuc long|vinh loc 2|tan kim|long hau|cau tram|nam thuan|dong nam a|thinh phat|an nhut tan|thai hoa|tan do|loi binh nhon|dong ha|nam ha|trung thanh phat|tan my chanh/],
    ['Bà Rịa – Vũng Tàu', /vung tau|ba ria|phu my|cai mep|chau duc|dat do|my xuan|long son|dong xuyen|tan thanh/],
    ['Bình Phước', /binh phuoc|dong xoai|chon thanh|becamex binh phuoc|minh hung|bac dong phu|nam dong phu|tan khai|hon quan|chon thanh/],
    ['Tây Ninh', /tay ninh|cha la|trang bang|phuoc dong|thanh thanh cong|chau thanh|go dau tay ninh|linh trung 3|hoa thanh/],
  ];
  const provUn = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  function provOf(name, lat, lng) {
    const u = provUn(name);
    for (const [p, re] of PROV_KW) if (re.test(u)) return p;
    if (lat == null || lng == null) return 'Khác';
    if (lat >= 11.35) return lng >= 106.6 ? 'Bình Phước' : 'Tây Ninh';
    if (lng < 106.47) return lat >= 10.98 ? 'Tây Ninh' : 'Long An';
    if (lng >= 106.85) return lat < 10.68 ? 'Bà Rịa – Vũng Tàu' : 'Đồng Nai';
    if (lat >= 11.15) return 'Bình Dương';
    if (lat >= 10.9 && lng >= 106.6) return 'Bình Dương';
    if (lat >= 10.88 && lng >= 106.7) return 'Bình Dương';
    return 'TP.HCM';
  }
  // tâm 1 KCN theo tên: đa giác đã tải → trung bình toạ độ các công ty thuộc KCN đó
  function kcnCenter(name, list) {
    for (const p of kcnData.values()) {
      if (p.name !== name) continue;
      const all = p.rings.flat();
      return [all.reduce((a, x) => a + x[0], 0) / all.length, all.reduce((a, x) => a + x[1], 0) / all.length];
    }
    const cs = list.filter((c) => c.lat && (c.kcn || kcnOf(c)) === name);
    return cs.length ? [cs.reduce((a, c) => a + c.lat, 0) / cs.length, cs.reduce((a, c) => a + c.lng, 0) / cs.length] : [null, null];
  }
  // 🖨 Hộp chọn điều kiện lọc trước khi in PDF
  function pdfDialog() {
    document.getElementById('dg-pdf-dlg')?.remove();
    const all = Object.values(cache || {}).filter((c) => c?.name && !isRealEstate(c));
    const kcns = [...new Set(all.map((c) => c.kcn || kcnOf(c)).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
    const inds = [...new Set(all.map((c) => c.ind).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
    const d = document.createElement('div');
    d.id = 'dg-pdf-dlg';
    d.setAttribute('style', 'position:fixed;inset:0;z-index:2147483200;background:rgba(15,23,42,.45);display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px;font:13px/1.45 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a');
    const row = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0';
    const lab = 'min-width:110px;font-weight:800;color:#334155';
    d.innerHTML = `<div style="background:#fff;border-radius:14px;box-shadow:0 20px 50px rgba(15,23,42,.35);width:min(620px,100%);max-height:86vh;overflow:auto;padding:14px 16px">
<div style="display:flex;align-items:center;margin-bottom:6px"><b style="font-size:16px;flex:1">🖨 In PDF – chọn điều kiện lọc</b><span data-x style="cursor:pointer;color:#64748b;font-weight:900;font-size:18px">✕</span></div>
<div style="${row}"><span style="${lab}">Phạm vi</span><label><input type="radio" name="sc" value="all" checked> Tất cả trên cloud (${all.length})</label><label><input type="radio" name="sc" value="view"> Khung bản đồ đang xem (${sideList.length})</label></div>
<div style="${row}"><span style="${lab}">Khu công nghiệp</span><select data-f="kcn" style="font:inherit;padding:3px 6px;border-radius:7px;border:1px solid #cbd5e1;max-width:360px"><option value="">Tất cả</option><option value="__in">Chỉ trong KCN</option><option value="__out">Chỉ ngoài KCN</option>${(() => {
      // KCN gom theo tỉnh (sắp theo thứ tự tỉnh, trong tỉnh theo tên)
      const byP = new Map();
      for (const k of kcns) {
        const [la, ln] = kcnCenter(k, all);
        const pv = provOf(k, la, ln);
        if (!byP.has(pv)) byP.set(pv, []);
        byP.get(pv).push(k);
      }
      return PROV_ORDER.filter((pv) => byP.has(pv)).map((pv) => `<optgroup label="📍 ${pv} (${byP.get(pv).length})">${byP.get(pv).sort((a, b) => a.localeCompare(b, 'vi')).map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('')}</optgroup>`).join('');
    })()}</select></div>
<div style="${row}"><span style="${lab}">ERP</span><label><input type="radio" name="erp" value="" checked> Tất cả</label><label><input type="radio" name="erp" value="in"> Chỉ đã có trong ERP</label><label><input type="radio" name="erp" value="out"> Chỉ CHƯA có trong ERP</label></div>
<div style="${row}"><span style="${lab}">Khác</span><label><input type="checkbox" data-f="frn"> 🌏 Chỉ tên nước ngoài</label><label><input type="checkbox" data-f="mst"> 🧾 Chỉ có MST</label><label><input type="checkbox" data-f="mob"> 📱 Chỉ có SĐT di động</label></div>
<div style="margin:8px 0 4px;font-weight:800;color:#334155">🏷 Ngành <span style="font-weight:500;color:#64748b">(bỏ chọn để loại)</span> <a href="#" data-all style="font-size:12px">chọn hết</a> · <a href="#" data-none style="font-size:12px">bỏ hết</a></div>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:2px 10px">${[...inds, ''].map((x) => `<label style="font-size:12.5px"><input type="checkbox" data-ind value="${esc(x)}" checked> ${x ? esc(x) : '<i style="color:#64748b">Chưa gắn ngành</i>'} <span style="color:#94a3b8">(${all.filter((c) => (c.ind || '') === x).length})</span></label>`).join('')}</div>
<div style="display:flex;align-items:center;gap:10px;margin-top:12px;border-top:1px solid #e2e8f0;padding-top:10px"><span data-n style="flex:1;color:#475569"></span><button data-go style="cursor:pointer;border:0;border-radius:9px;padding:8px 16px;font:inherit;font-weight:900;color:#fff;background:linear-gradient(90deg,#2563eb,#1d4ed8)">🖨 In PDF</button></div></div>`;
    document.body.append(d);
    const val = () => {
      const sc = d.querySelector('input[name="sc"]:checked').value;
      const kc = d.querySelector('[data-f="kcn"]').value;
      const erp = d.querySelector('input[name="erp"]:checked').value;
      const frn = d.querySelector('[data-f="frn"]').checked;
      const mst = d.querySelector('[data-f="mst"]').checked;
      const mob = d.querySelector('[data-f="mob"]').checked;
      const okInd = new Set([...d.querySelectorAll('[data-ind]:checked')].map((x) => x.value));
      const isMob = (p) => {
        let x = String(p || '').replace(/\D/g, '');
        if (x.startsWith('84')) x = `0${x.slice(2)}`;
        return /^0[35789]\d{8}$/.test(x);
      };
      const base = sc === 'view' ? sideList : Object.values(cache || {});
      const list = base.filter((c) => {
        if (!c?.name || isRealEstate(c)) return false;
        const k = c.kcn || kcnOf(c);
        if (kc === '__in' && !k) return false;
        if (kc === '__out' && k) return false;
        if (kc && !kc.startsWith('__') && k !== kc) return false;
        const e = !!erpOf(c);
        if (erp === 'in' && !e) return false;
        if (erp === 'out' && e) return false;
        if (frn && !foreignName(c)) return false;
        if (mst && !c.mst) return false;
        if (mob && !isMob(c.phone)) return false;
        return okInd.has(c.ind || '');
      });
      const parts = [sc === 'view' ? 'Khung bản đồ' : 'Tất cả', kc === '__in' ? 'Trong KCN' : kc === '__out' ? 'Ngoài KCN' : kc, erp === 'in' ? 'Đã có ERP' : erp === 'out' ? 'Chưa có ERP' : '', frn ? 'Tên nước ngoài' : '', mst ? 'Có MST' : '', mob ? 'Có di động' : '', okInd.size < inds.length + 1 ? `${okInd.size} ngành` : ''].filter(Boolean);
      return { list, sc, title: `Danh sách công ty – ${parts.join(' · ')}` };
    };
    const upd = () => (d.querySelector('[data-n]').textContent = `→ ${val().list.length} công ty sẽ được in`);
    upd();
    d.addEventListener('change', upd);
    d.addEventListener('click', async (e) => {
      if (e.target === d || e.target.closest('[data-x]')) return d.remove();
      if (e.target.closest('[data-all],[data-none]')) {
        e.preventDefault();
        const on = !!e.target.closest('[data-all]');
        d.querySelectorAll('[data-ind]').forEach((x) => (x.checked = on));
        return upd();
      }
      const go = e.target.closest('[data-go]');
      if (!go) return;
      const v0 = val();
      if (!v0.list.length) return alert('Không có công ty nào khớp điều kiện.');
      // mở cửa sổ in ngay lúc bấm (tránh chặn pop-up); "Tất cả" → đồng bộ cloud trước rồi lọc lại
      const w = window.open('', '_blank');
      if (!w) return alert('Trình duyệt chặn cửa sổ in – cho phép pop-up của google.com rồi bấm lại.');
      w.document.write('<p style="font:14px sans-serif;padding:20px">⏳ Đang đồng bộ cloud và dựng danh sách công ty…</p>');
      go.disabled = true;
      go.textContent = '⏳ Đang chuẩn bị…';
      if (v0.sc === 'all') {
        await Promise.race([call({ type: 'sync.all' }).catch(() => {}), sleep(20e3)]);
        cache = (await kvGet(KEY).catch(() => ({}))) || cache;
        erpAt = 0;
        await erpLoad().catch(() => {});
      }
      const v = val();
      d.remove();
      exportPdf(v.list, v.title, w);
    });
  }

  // 📋 Panel góc phải: công ty đã lưu nằm trong khung bản đồ đang xem, gom theo KCN. Zoom xa (< 13) → ẩn danh sách cho đỡ lag.
  const side = document.createElement('div');
  side.id = 'dg-maps-side';
  side.setAttribute('style', 'position:fixed;right:64px;top:120px;z-index:2147482500;width:340px;max-height:calc(100vh - 220px);display:flex;flex-direction:column;background:#fff;border-radius:14px;border:2px solid #2563eb;box-shadow:0 14px 36px rgba(15,23,42,.28);font:13px/1.4 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a;overflow:hidden');
  // thân panel (vẽ lại theo khung bản đồ) + thanh tiến trình tra MST (cập nhật riêng mỗi giây, không vẽ lại cả danh sách)
  const sideBody = document.createElement('div');
  sideBody.setAttribute('style', 'display:flex;flex-direction:column;min-height:0;flex:1');
  const mstBar = document.createElement('div');
  mstBar.setAttribute('style', 'padding:5px 10px;background:#faf5ff;border-top:1px solid #e9d5ff;font-size:11.5px;color:#5b21b6;line-height:1.35');
  side.append(sideBody, mstBar);
  let sideMin = localStorage.getItem('dgMapsSideMin') === '1';
  let sideGroup = localStorage.getItem('dgMapsSideGroup') || 'kcn'; // 'kcn' | 'ind'
  let indOnly = ''; // đang lọc 1 ngành
  let onlyForeign = localStorage.getItem('dgMapsForeign') === '1'; // 🌏 chỉ tên nước ngoài
  let boxOnly = localStorage.getItem('dgMapsBox') || ''; // 📦 '' = tất cả · 'A' = chỉ tiềm năng cao · 'AB' = cao + vừa
  let sideKey = '';
  side.addEventListener('click', (e) => {
    const t = e.target.closest('[data-s]');
    if (!t) return;
    if (t.dataset.s === 'min') {
      sideMin = !sideMin;
      localStorage.setItem('dgMapsSideMin', sideMin ? '1' : '0');
      sideKey = '';
      sideDraw();
    } else if (t.dataset.s === 'kcn') kcnListShow(t.dataset.k);
    else if (t.dataset.s === 'pdfdlg') pdfDialog();
    else if (t.dataset.s === 'frn') {
      onlyForeign = !onlyForeign;
      localStorage.setItem('dgMapsForeign', onlyForeign ? '1' : '0');
      sideKey = '';
      sideCalcKey = '';
      sideDraw();
    } else if (t.dataset.s === 'box') {
      boxOnly = boxOnly === '' ? 'A' : boxOnly === 'A' ? 'AB' : '';
      localStorage.setItem('dgMapsBox', boxOnly);
      sideKey = '';
      sideCalcKey = '';
      sideDraw();
    } else if (t.dataset.s === 'grp') {
      sideGroup = sideGroup === 'ind' ? 'kcn' : 'ind';
      indOnly = '';
      localStorage.setItem('dgMapsSideGroup', sideGroup);
      sideKey = '';
      sideCalcKey = '';
      sideDraw();
    } else if (t.dataset.s === 'ind') {
      indOnly = indOnly ? '' : t.dataset.k;
      sideKey = '';
      sideCalcKey = '';
      sideDraw();
    }
  });
  let sideCalcKey = '';
  let sideInView = -1;
  let sideList = []; // số công ty đã lưu trong khung đang xem (0 → tự quét ngầm)
  function sideDraw() {
    const v = mapView();
    // không đổi khung bản đồ, số công ty đã lưu, số KCN, dữ liệu ERP → bỏ qua (khỏi lọc lại hàng nghìn công ty mỗi 1,5 giây)
    const ck = `${location.href}|${Object.keys(cache || {}).length}|${Object.values(cache || {}).filter((x) => x?.ind).length}|${kcnData.size}|${erpIdx?.n || 0}|${sideMin}|${sideGroup}|${indOnly}|${onlyForeign}|${boxOnly}|${Object.values(cache || {}).filter((x) => x?.box).length}`;
    if (ck === sideCalcKey && side.isConnected) return;
    sideCalcKey = ck;
    if (!document.body) return;
    if (!side.isConnected) document.body.append(side);
    let nForeign = null;
    const head = (extra) => `<div style="padding:7px 10px;background:#eff6ff;border-bottom:1px solid #dbeafe;font-weight:900;color:#1e3a8a"><div style="display:flex;align-items:center;gap:6px;white-space:nowrap">🏢 Công ty trong khung bản đồ ${extra}<span data-s="min" title="${sideMin ? 'Mở' : 'Thu gọn'}" style="margin-left:auto;cursor:pointer;color:#64748b">${sideMin ? '▾' : '▴'}</span></div><div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:4px"><span data-s="frn" title="Chỉ hiện công ty có từ không phải tiếng Việt trong tên (thường là công ty FDI)" style="cursor:pointer;font-size:11px;font-weight:800;border:1px solid ${onlyForeign ? '#7c3aed' : '#cbd5e1'};background:${onlyForeign ? '#ede9fe' : '#fff'};color:${onlyForeign ? '#6d28d9' : '#475569'};border-radius:99px;padding:0 8px;white-space:nowrap">🌏 ${onlyForeign ? 'Chỉ tên nước ngoài' : 'Tên nước ngoài'}${typeof nForeign === 'number' ? ` ${nForeign}` : ''}</span><span data-s="box" title="AI lọc công ty có khả năng dùng thùng carton / thùng offset số lượng lớn – bấm đổi: tất cả → chỉ tiềm năng cao → cao + vừa" style="cursor:pointer;font-size:11px;font-weight:800;border:1px solid ${boxOnly ? '#16a34a' : '#cbd5e1'};background:${boxOnly ? '#dcfce7' : '#fff'};color:${boxOnly ? '#166534' : '#475569'};border-radius:99px;padding:0 8px;white-space:nowrap">📦 ${boxOnly === 'A' ? 'Thùng: chỉ cao' : boxOnly === 'AB' ? 'Thùng: cao + vừa' : 'Tiềm năng thùng'}</span><span data-s="grp" title="Đổi cách xem: theo KCN / theo ngành nghề (AI)" style="cursor:pointer;font-size:11px;font-weight:800;border:1px solid ${sideGroup === 'ind' ? '#0d9488' : '#cbd5e1'};background:${sideGroup === 'ind' ? '#ccfbf1' : '#fff'};color:${sideGroup === 'ind' ? '#0f766e' : '#475569'};border-radius:99px;padding:0 8px;white-space:nowrap">${sideGroup === 'ind' ? '🏷 Theo ngành' : '🏭 Theo KCN'}</span><span data-s="pdfdlg" title="In PDF – chọn điều kiện lọc trước khi in" style="cursor:pointer;font-size:11px;font-weight:800;border:1px solid #93c5fd;background:#eff6ff;color:#1d4ed8;border-radius:99px;padding:0 8px;white-space:nowrap">🖨 PDF</span></div></div>`;
    if (!v || v.z < 13) {
      const k = 'far';
      if (sideKey !== k) {
        sideKey = k;
        sideBody.innerHTML = head('') + (sideMin ? '' : '<div style="padding:10px;color:#64748b;font-size:12.5px">🔍 Zoom gần hơn để xem danh sách công ty (zoom xa ẩn cho đỡ lag).</div>');
      }
      return;
    }
    const [cx, cy] = proj(v.lat, v.lng, v.z);
    const [n, w] = unproj(cx - v.r.width / 2, cy - v.r.height / 2, v.z);
    const [s2, e] = unproj(cx + v.r.width / 2, cy + v.r.height / 2, v.z);
    const inView0 = Object.values(cache || {}).filter((c) => c?.lat && !isRealEstate(c) && c.lat <= n && c.lat >= s2 && c.lng >= w && c.lng <= e);
    sideInView = inView0.length;
    nForeign = inView0.filter(foreignName).length;
    const inView = (onlyForeign ? inView0.filter(foreignName) : inView0).filter((c) => !boxOnly || boxOnly.includes(c.box || '-'));
    sideList = inView;
    const groups = new Map();
    const byInd = sideGroup === 'ind';
    for (const c of inView) {
      if (byInd) {
        // 🏷 xem theo ngành nghề (AI gắn nhãn); bấm tiêu đề ngành → chỉ xem ngành đó
        const k = c.ind ? `i:${c.ind}` : '';
        if (indOnly && k !== indOnly) continue;
        if (!groups.has(k)) groups.set(k, { name: c.ind || 'Chưa gắn ngành', list: [] });
        groups.get(k).list.push(c);
        continue;
      }
      const hit = [...kcnData.entries()].find(([, p]) => inKcn(c.lat, c.lng, p));
      const k = hit ? hit[0] : '';
      if (!groups.has(k)) groups.set(k, { name: hit ? hit[1].name : 'Ngoài KCN', list: [] });
      groups.get(k).list.push(c);
    }
    const order = [...groups.entries()].sort((a, b) => (!a[0]) - (!b[0]) || b[1].list.length - a[1].list.length);
    const nErp = inView.filter((c) => erpOf(c)).length;
    const key = `${onlyForeign}|${boxOnly}|${sideGroup}|${indOnly}|${sideMin}|${inView.length}|${nErp}|${order.map(([k, g]) => k + g.list.length).join(',')}|${Math.round(v.lat * 1e3)},${Math.round(v.lng * 1e3)}`;
    if (key === sideKey) return;
    sideKey = key;
    let shown = 0;
    let stt = 0; // số thứ tự chạy suốt danh sách
    const body = order.map(([k, g]) => {
      const items = g.list.sort((a, b) => a.name.localeCompare(b.name, 'vi')).filter(() => shown++ < 250);
      if (!items.length) return '';
      const ic = IND_COL[g.name] || '#64748b';
      const gh = byInd
        ? `<div style="padding:5px 10px;background:${ic}14;font-weight:800;font-size:12px;color:${ic};border-top:1px solid #f1f5f9;cursor:pointer" data-s="ind" data-k="${esc(k)}" title="${indOnly ? 'Bấm để xem lại mọi ngành' : 'Bấm để chỉ xem ngành này'}">🏷 ${esc(g.name)} · ${g.list.length}${indOnly ? ' · ✕ bỏ lọc' : ''}</div>`
        : `<div style="padding:5px 10px;background:${k ? '#fff7ed' : '#f8fafc'};font-weight:800;font-size:12px;color:${k ? '#9a3412' : '#475569'};border-top:1px solid #f1f5f9;${k ? 'cursor:pointer' : ''}" ${k ? `data-s="kcn" data-k="${esc(k)}" title="Xem danh sách công ty trong KCN"` : ''}>${k ? '🏭' : '📍'} ${esc(g.name)} · ${g.list.length}</div>`;
      return `${gh}${items.map((c) => `<div style="padding:4px 10px 4px 16px;border-top:1px solid #f8fafc;${erpOf(c) ? 'background:#f0fdf4' : ''}"><span style="display:inline-block;min-width:22px;color:#94a3b8;font-size:11px;font-weight:800">${++stt}.</span><a href="${esc(c.href || c.url)}" data-go="${esc(c.id)}" style="text-decoration:none;color:#0f172a" title="${dispName(c) !== c.name ? `Tên trên Google Maps: ${esc(c.name)}` : ''}"><b style="font-size:12.5px">${esc(dispName(c))}</b></a>${rateTag(c)}${mstIcon(c)}${erpBadge(c)}${boxTag(c)}${areaTag(c)}${indTag(c)}<span data-hide="${esc(c.id)}" title="Ẩn công ty này – không hiện và không quét / tra MST lại nữa" style="float:right;cursor:pointer;color:#cbd5e1;font-weight:900;padding:0 4px">✕</span>${c.mst ? `<div style="font-size:11px"><a href="${esc(c.mstUrl || `https://masothue.com/Search/?q=${c.mst}`)}" target="_blank" rel="noopener" style="color:#7c3aed;font-weight:800;text-decoration:none">🧾 MST ${esc(c.mst)}</a></div>` : ''}<div style="font-size:11.5px;color:#64748b">${kmTag(c)}${esc(c.addr || c.cat || '')}${c.phone ? ` · ${phoneHtml(c.phone)}` : ''}</div></div>`).join('')}`;
    }).join('');
    const keepTop = side.querySelector('[data-scroll]')?.scrollTop || 0;
    sideBody.innerHTML = head(`<span style="background:#dbeafe;border-radius:99px;padding:0 8px">${inView.length}</span>${nErp ? `<span title="Đã có trong danh sách khách hàng ERP" style="background:#dcfce7;color:#166534;border-radius:99px;padding:0 8px">✅ ${nErp} ERP</span>` : ''}`) + (sideMin ? '' : `<div data-scroll style="overflow:auto">${body || '<div style="padding:10px;color:#64748b;font-size:12.5px">⏳ Chưa có công ty nào trong khung này – đang tự quét ngầm (dừng bản đồ vài giây, zoom gần)…</div>'}${shown > 250 ? '<div style="padding:6px 10px;font-size:11.5px;color:#94a3b8">… zoom gần hơn để xem hết</div>' : ''}</div>`);
    const sc = side.querySelector('[data-scroll]');
    if (sc && keepTop) sc.scrollTop = keepTop; // giữ chỗ đang xem trong danh sách
  }
  setInterval(() => {
    if (kcnSvg.style.visibility !== 'hidden') sideDraw();
  }, 1500);
  let lastUrl = '';
  async function tick() {
    if (!document.body) return;
    if (!box.isConnected) {
      document.body.append(box);
      draw();
    }
    // bảng chi tiết đang mở → lưu (mỗi lần đổi địa điểm)
    if (location.href !== lastUrl) {
      const d = readDetail();
      if (d) {
        lastUrl = location.href;
        const n = await save([d]).catch(() => 0);
        if (n) {
          const kk = kcnOf(d);
          const ee = erpOf(d);
          msg = `✅ Đã lưu: ${d.name} – ${d.addr}${kk ? ` · 🏭 ${kk}` : ''}${ee ? ` · ✅ Đã có trong ERP (${ee.code || ee.name})` : ' · chưa có trong ERP'}`;
          draw();
        }
      }
    }
    // vừa bấm "Quét công ty quanh đây" → chờ danh sách hiện rồi tự lưu
    if (sessionStorage.getItem('dgMapsAuto') && document.querySelector('div[role="feed"] div[role="article"]') && !busy) {
      sessionStorage.removeItem('dgMapsAuto');
      await sleep(1500);
      saveFeedAll();
    }
  }
  setInterval(() => tick().catch(() => {}), 1500);
  setInterval(() => !busy && box.isConnected && box.style.display !== 'none' && draw().catch(() => {}), 5000);
})();

// Chạy trong world USER_SCRIPT trên www.google.com/maps (chỉ đọc – không bấm lưu / đánh giá / sửa gì trên Google Maps).
// Đọc địa chỉ các công ty trên Google Maps → kv 'mapsPlaces' (đồng bộ cloud) để bảng Trợ lý ERP dùng (đối chiếu địa chỉ khách, giao hàng…):
//  • Mở 1 địa điểm (bảng chi tiết bên trái) → tự lưu: tên, loại hình, địa chỉ đầy đủ, SĐT, website, Plus code, toạ độ.
//  • Danh sách kết quả tìm kiếm (vd. tìm "công ty") → nút "⬇️ Lưu danh sách" tự cuộn hết danh sách và lưu từng công ty.
//  • Nút "🔍 Quét công ty quanh đây" → tìm "công ty" tại vùng bản đồ đang xem rồi tự lưu danh sách.
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
  const cleanPhone = (p) => String(p || '').replace(/^phone:tel:/, '').replace(/\s+/g, ' ').trim();
  const stripLabel = (t) => String(t || '').replace(/^[^:]{2,20}:\s*/, '').trim(); // "Address: …" / "Địa chỉ: …"

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
      out.push({ id: u.id, name, cat: parts[0] || '', addr: parts.slice(1).join(', '), phone: cleanPhone(phone), lat: u.lat, lng: u.lng, url: `https://www.google.com/maps/place/?q=place_id:${u.id}`, href: link.href.split('?')[0], full: false });
    }
    return out;
  }
  // Lưu: bản chi tiết (full) không bị bản danh sách (địa chỉ rút gọn) ghi đè
  let cache = null;
  async function save(list) {
    if (!list.length) return 0;
    cache = cache || (await kvGet(KEY).catch(() => ({}))) || {};
    const patch = {};
    for (const p0 of list) {
      const k = typeof kcnOf === 'function' ? kcnOf(p0) : '';
      const p = k ? { ...p0, kcn: k } : p0;
      const old = cache[p.id];
      const v = old?.full && !p.full ? { ...p, ...old, lat: old.lat ?? p.lat, lng: old.lng ?? p.lng, phone: old.phone || p.phone, seenAt: Date.now() } : { ...(old || {}), ...p, at: Date.now(), seenAt: Date.now() };
      if (JSON.stringify({ ...old, at: 0, seenAt: 0 }) === JSON.stringify({ ...v, at: 0, seenAt: 0 })) continue;
      patch[p.id] = v;
      cache[p.id] = v;
    }
    if (Object.keys(patch).length) await kvMerge(KEY, patch);
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
    cache = cache || (await kvGet(KEY).catch(() => ({}))) || {};
    const n = Object.keys(cache).length;
    const feedN = document.querySelectorAll('div[role="feed"] div[role="article"]').length;
    box.innerHTML = `<div style="display:flex;align-items:center;gap:6px;font-weight:900;color:#1e3a8a">📍 Trợ lý ERP · địa chỉ công ty <span style="margin-left:auto;background:#dbeafe;border-radius:99px;padding:0 8px">${n}</span><span data-m="min" title="Thu nhỏ" style="cursor:pointer;color:#94a3b8">–</span></div>
<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${feedN ? `<button data-m="feed" style="${btn}">⬇️ Lưu danh sách (${feedN}+)</button>` : ''}<button data-m="scan" style="${btn}">🔍 Quét công ty quanh đây</button><button data-m="auto" title="Tự quét khi dừng bản đồ (zoom gần) ở Long An, Bình Dương, TP.HCM, Đồng Nai, Vũng Tàu, Bình Phước, Tây Ninh" style="${btn};${autoScan ? 'background:#dcfce7;border-color:#86efac;color:#166534' : ''}">🤖 Tự quét 7 tỉnh: ${autoScan ? 'Bật' : 'Tắt'}</button><button data-m="csv" style="${btn}">📄 Xuất CSV</button><button data-m="kcn" style="${btn};${kcnOn ? 'background:#ffedd5;border-color:#fb923c;color:#9a3412' : ''}">🏭 Viền KCN: ${kcnOn ? 'Bật' : 'Tắt'}</button>${kcnOn ? `<button data-m="kdraw" style="${btn};background:#dcfce7;border-color:#86efac;color:#166534">✏️ Vẽ viền KCN</button>${Object.values(kcnCustom).some((x) => x && !x.deleted) ? `<button data-m="klist" style="${btn}">🗂 KCN tự vẽ (${Object.values(kcnCustom).filter((x) => x && !x.deleted).length})</button>` : ''}` : ''}</div>
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
      const c = location.href.match(/@(-?\d+\.\d+),(-?\d+\.\d+),(\d+(?:\.\d+)?)z/);
      sessionStorage.setItem('dgMapsAuto', '1');
      location.href = `https://www.google.com/maps/search/c%C3%B4ng+ty/${c ? `@${c[1]},${c[2]},${Math.max(13, Math.round(Number(c[3])))}z` : ''}`;
      return;
    }
    if (k === 'csv') {
      cache = (await kvGet(KEY).catch(() => ({}))) || {};
      const rows = Object.values(cache).filter((x) => x?.name);
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = '﻿' + [['Tên', 'Loại hình', 'Địa chỉ', 'SĐT', 'Website', 'Plus code', 'Vĩ độ', 'Kinh độ', 'Google Maps'].map(q).join(',')].concat(rows.map((x) => [x.name, x.cat, x.addr, x.phone, x.web, x.plus, x.lat, x.lng, x.href || x.url].map(q).join(','))).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = `dia-chi-cong-ty-google-maps-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
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
      for (const k of tiles) {
        kcnLoaded.add(k);
        try {
          localStorage.setItem(`dgKcn2:${k}`, JSON.stringify({ at: Date.now(), list: byTile[k] || [] }));
        } catch {}
      }
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
    return Object.values(cache).filter((c) => c?.lat && c.lat >= s1 && c.lat <= n1 && c.lng >= w1 && c.lng <= e1 && inKcn(c.lat, c.lng, p));
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
<div style="font-size:12px;color:#475569;margin-bottom:6px"><b>${list.length}</b> công ty đã lưu nằm trong KCN${list.length ? '' : ' – bấm “🔍 Quét công ty quanh đây” khi đang xem KCN để lưu thêm'}</div>
${list.map((c, i) => `<div style="padding:6px 0;border-top:1px solid #f1f5f9"><div><b>${i + 1}. <a href="${esc(c.href || c.url)}" style="color:#1d4ed8;text-decoration:none">${esc(c.name)}</a></b>${erpBadge(c)}${c.cat ? ` <span style="color:#64748b;font-size:11.5px">· ${esc(c.cat)}</span>` : ''}</div><div style="font-size:12px;color:#334155">${esc(c.addr || '')}${c.phone ? ` · 📞 ${esc(c.phone)}` : ''}</div></div>`).join('')}`;
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
  let kcnMoving = 0;
  const kcnHide = () => {
    kcnSvg.style.visibility = 'hidden';
    kcnMoving = Date.now();
  };
  addEventListener('wheel', kcnHide, { passive: true, capture: true });
  addEventListener('pointerdown', (e) => !e.target.closest?.('#dg-maps') && kcnHide(), true);
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
      kcnDraw();
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
  addEventListener('wheel', () => (userMoved = true), { passive: true, capture: true });
  addEventListener('pointerdown', (e) => !e.target.closest?.('#dg-maps,#dg-kcn-list') && (userMoved = true), true);
  const scanned = () => {
    try {
      return JSON.parse(localStorage.getItem('dgMapsScanned') || '{}');
    } catch {
      return {};
    }
  };
  async function autoScanTick() {
    if (!autoScan || busy || drawPts) return;
    if (location.href !== urlNow) {
      urlNow = location.href;
      urlAt = Date.now();
      return;
    }
    if (!userMoved || Date.now() - urlAt < 4000) return;
    const v = mapView();
    if (!v || v.z < 14 || !inRegion(v.lat, v.lng)) return;
    const cell = `${Math.round(v.lat / 0.03)},${Math.round(v.lng / 0.03)}`;
    const sc = scanned();
    if (sc[cell] && Date.now() - sc[cell] < 30 * 86400e3) return;
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

  // ✅ Đối chiếu khách hàng ERP (kv customersAll – đồng bộ từ trang Khách hàng): trùng SĐT (9 số cuối) hoặc trùng tên đã bỏ
  // "Công ty TNHH / Cổ phần / MTV…", dấu, ký tự đặc biệt (tên ≥ 6 ký tự) → đánh dấu "tồn tại trong ERP"
  const ERP_HOST = 'https://sale.tuantu.com.vn';
  const unacc = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const coKey = (t) => unacc(t)
    .replace(/\b(cong ty|cty|ct|tnhh|co phan|cp|mtv|mot thanh vien|hai thanh vien|trach nhiem huu han|san xuat|thuong mai|dich vu|xuat nhap khau|xnk|tm|dv|sx|viet nam|vn|company|co\.?|ltd\.?|limited|corp\.?|corporation|jsc|vietnam|inc\.?)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
  const phoneKey = (t) => String(t || '').replace(/\D/g, '').slice(-9);
  let erpIdx = null;
  let erpAt = 0;
  async function erpLoad() {
    if (erpIdx && Date.now() - erpAt < 5 * 60e3) return erpIdx;
    erpAt = Date.now();
    const all = (await kvGet('customersAll').catch(() => ({}))) || {};
    const byPhone = new Map();
    const byName = new Map();
    for (const c of Object.values(all)) {
      if (!c?.id) continue;
      for (const ph of [c.phone, c.deliveryPhone]) {
        const k = phoneKey(ph);
        if (k.length === 9) byPhone.set(k, c);
      }
      const nk = coKey(c.name);
      if (nk.length >= 6) byName.set(nk, c);
    }
    erpIdx = { byPhone, byName, n: Object.keys(all).length };
    sideKey = '';
    return erpIdx;
  }
  erpLoad().catch(() => {});
  setInterval(() => erpLoad().catch(() => {}), 60e3);
  const erpOf = (c) => {
    if (!erpIdx || !c) return null;
    const ph = phoneKey(c.phone);
    if (ph.length === 9 && erpIdx.byPhone.has(ph)) return erpIdx.byPhone.get(ph);
    const nk = coKey(c.name);
    return nk.length >= 6 ? erpIdx.byName.get(nk) || null : null;
  };
  const erpBadge = (c) => {
    const e = erpOf(c);
    return e ? ` <a href="${ERP_HOST}/khach-hang/view/${e.id}" target="_blank" rel="noopener" title="Tồn tại trong ERP: ${esc(e.name)}${e.staff?.name ? ` · NVKD ${esc(e.staff.name)}` : ''}${e.totalOrder ? ` · ${e.totalOrder} đơn` : ''}" style="display:inline-block;padding:0 6px;border-radius:6px;background:#dcfce7;border:1px solid #86efac;color:#166534;font-size:10.5px;font-weight:900;text-decoration:none;white-space:nowrap">✅ ERP${e.code ? ` · ${esc(e.code)}` : ''}</a>` : '';
  };

  // 📋 Panel góc phải: công ty đã lưu nằm trong khung bản đồ đang xem, gom theo KCN. Zoom xa (< 13) → ẩn danh sách cho đỡ lag.
  const side = document.createElement('div');
  side.id = 'dg-maps-side';
  side.setAttribute('style', 'position:fixed;right:64px;top:120px;z-index:2147482500;width:340px;max-height:calc(100vh - 220px);display:flex;flex-direction:column;background:#fff;border-radius:14px;border:2px solid #2563eb;box-shadow:0 14px 36px rgba(15,23,42,.28);font:13px/1.4 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a;overflow:hidden');
  let sideMin = localStorage.getItem('dgMapsSideMin') === '1';
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
  });
  function sideDraw() {
    const v = mapView();
    if (!document.body) return;
    if (!side.isConnected) document.body.append(side);
    const head = (extra) => `<div style="display:flex;align-items:center;gap:6px;padding:8px 10px;background:#eff6ff;border-bottom:1px solid #dbeafe;font-weight:900;color:#1e3a8a">🏢 Công ty trong khung bản đồ ${extra}<span data-s="min" title="${sideMin ? 'Mở' : 'Thu gọn'}" style="margin-left:auto;cursor:pointer;color:#64748b">${sideMin ? '▾' : '▴'}</span></div>`;
    if (!v || v.z < 13) {
      const k = 'far';
      if (sideKey !== k) {
        sideKey = k;
        side.innerHTML = head('') + (sideMin ? '' : '<div style="padding:10px;color:#64748b;font-size:12.5px">🔍 Zoom gần hơn để xem danh sách công ty (zoom xa ẩn cho đỡ lag).</div>');
      }
      return;
    }
    const [cx, cy] = proj(v.lat, v.lng, v.z);
    const [n, w] = unproj(cx - v.r.width / 2, cy - v.r.height / 2, v.z);
    const [s2, e] = unproj(cx + v.r.width / 2, cy + v.r.height / 2, v.z);
    const inView = Object.values(cache || {}).filter((c) => c?.lat && c.lat <= n && c.lat >= s2 && c.lng >= w && c.lng <= e);
    const groups = new Map();
    for (const c of inView) {
      const hit = [...kcnData.entries()].find(([, p]) => inKcn(c.lat, c.lng, p));
      const k = hit ? hit[0] : '';
      if (!groups.has(k)) groups.set(k, { name: hit ? hit[1].name : 'Ngoài KCN', list: [] });
      groups.get(k).list.push(c);
    }
    const order = [...groups.entries()].sort((a, b) => (!a[0]) - (!b[0]) || b[1].list.length - a[1].list.length);
    const nErp = inView.filter((c) => erpOf(c)).length;
    const key = `${sideMin}|${inView.length}|${nErp}|${order.map(([k, g]) => k + g.list.length).join(',')}|${Math.round(v.lat * 1e3)},${Math.round(v.lng * 1e3)}`;
    if (key === sideKey) return;
    sideKey = key;
    let shown = 0;
    const body = order.map(([k, g]) => {
      const items = g.list.sort((a, b) => a.name.localeCompare(b.name, 'vi')).filter(() => shown++ < 250);
      if (!items.length) return '';
      return `<div style="padding:5px 10px;background:${k ? '#fff7ed' : '#f8fafc'};font-weight:800;font-size:12px;color:${k ? '#9a3412' : '#475569'};border-top:1px solid #f1f5f9;${k ? 'cursor:pointer' : ''}" ${k ? `data-s="kcn" data-k="${esc(k)}" title="Xem danh sách công ty trong KCN"` : ''}>${k ? '🏭' : '📍'} ${esc(g.name)} · ${g.list.length}</div>${items.map((c) => `<div style="padding:4px 10px 4px 16px;border-top:1px solid #f8fafc;${erpOf(c) ? 'background:#f0fdf4' : ''}"><a href="${esc(c.href || c.url)}" style="text-decoration:none;color:#0f172a"><b style="font-size:12.5px">${esc(c.name)}</b></a>${erpBadge(c)}<div style="font-size:11.5px;color:#64748b">${esc(c.addr || c.cat || '')}${c.phone ? ` · ${esc(c.phone)}` : ''}</div></div>`).join('')}`;
    }).join('');
    side.innerHTML = head(`<span style="background:#dbeafe;border-radius:99px;padding:0 8px">${inView.length}</span>${nErp ? `<span title="Đã có trong danh sách khách hàng ERP" style="background:#dcfce7;color:#166534;border-radius:99px;padding:0 8px">✅ ${nErp} ERP</span>` : ''}`) + (sideMin ? '' : `<div style="overflow:auto">${body || '<div style="padding:10px;color:#64748b;font-size:12.5px">Chưa có công ty nào đã lưu trong khung này – bấm “🔍 Quét công ty quanh đây”.</div>'}${shown > 250 ? '<div style="padding:6px 10px;font-size:11.5px;color:#94a3b8">… zoom gần hơn để xem hết</div>' : ''}</div>`);
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

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
    for (const p of list) {
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
<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${feedN ? `<button data-m="feed" style="${btn}">⬇️ Lưu danh sách (${feedN}+)</button>` : ''}<button data-m="scan" style="${btn}">🔍 Quét công ty quanh đây</button><button data-m="csv" style="${btn}">📄 Xuất CSV</button><button data-m="kcn" style="${btn};${kcnOn ? 'background:#ffedd5;border-color:#fb923c;color:#9a3412' : ''}">🏭 Viền KCN: ${kcnOn ? 'Bật' : 'Tắt'}</button></div>
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
  const KCN_RE = 'Khu công nghiệp|Khu Công Nghiệp|KHU CÔNG NGHIỆP|KCN|Industrial Park|Industrial Zone|Cụm công nghiệp|CCN';
  const svgNS = 'http://www.w3.org/2000/svg';
  const kcnSvg = document.createElementNS(svgNS, 'svg');
  kcnSvg.id = 'dg-kcn';
  kcnSvg.setAttribute('style', 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:5;overflow:visible');
  let kcnData = new Map(); // id → { name, rings: [[ [lat,lng]… ]] }
  const tileKey = (s, w) => `${Math.floor(s * 4) / 4},${Math.floor(w * 4) / 4}`; // ô 0,25°
  const kcnLoaded = new Set();
  const kcnLoading = new Set();
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
  async function kcnFetch(v) {
    const [cx, cy] = proj(v.lat, v.lng, v.z);
    const [n, w] = unproj(cx - v.r.width / 2, cy - v.r.height / 2, v.z);
    const [s, e] = unproj(cx + v.r.width / 2, cy + v.r.height / 2, v.z);
    const tiles = [];
    for (let a = Math.floor(s * 4) / 4; a <= n; a += 0.25) for (let b = Math.floor(w * 4) / 4; b <= e; b += 0.25) tiles.push([a, b]);
    if (tiles.length > 12) return; // vùng quá rộng (zoom quá xa) → không tải
    for (const [a, b] of tiles) {
      const k = tileKey(a, b);
      if (kcnLoaded.has(k) || kcnLoading.has(k)) continue;
      let cached = null;
      try {
        cached = JSON.parse(localStorage.getItem(`dgKcn:${k}`) || 'null');
      } catch {}
      if (cached && Date.now() - cached.at < 7 * 86400e3) {
        for (const [id, p] of cached.list) kcnData.set(id, p);
        kcnLoaded.add(k);
        continue;
      }
      kcnLoading.add(k);
      const bb = `${a},${b},${(a + 0.25).toFixed(2)},${(b + 0.25).toFixed(2)}`;
      const q = `[out:json][timeout:25];(way["landuse"="industrial"]["name"~"${KCN_RE}",i](${bb});relation["landuse"="industrial"]["name"~"${KCN_RE}",i](${bb});way["industrial"="industrial_park"](${bb});relation["industrial"="industrial_park"](${bb}););out geom;`;
      try {
        const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: `data=${encodeURIComponent(q)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        if (!res.ok) throw new Error(`Overpass ${res.status}`);
        const j = await res.json();
        const list = [];
        for (const el of j.elements || []) {
          const name = el.tags?.name || el.tags?.['name:vi'] || '';
          let rings = [];
          if (el.type === 'way' && el.geometry) rings = [el.geometry.map((g) => [g.lat, g.lon])];
          else if (el.type === 'relation') rings = (el.members || []).filter((m) => m.role !== 'inner' && m.geometry).map((m) => m.geometry.map((g) => [g.lat, g.lon]));
          if (rings.length) list.push([`${el.type}/${el.id}`, { name, rings }]);
        }
        for (const [id, p] of list) kcnData.set(id, p);
        try {
          localStorage.setItem(`dgKcn:${k}`, JSON.stringify({ at: Date.now(), list }));
        } catch {}
        kcnLoaded.add(k);
      } catch {
        // lỗi mạng / quá tải → lần sau thử lại
      } finally {
        kcnLoading.delete(k);
      }
    }
    kcnDraw();
  }
  function kcnDraw() {
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
    for (const [, p] of kcnData) {
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
      html += `<path d="${paths}" fill="rgba(249,115,22,.14)" stroke="#ea580c" stroke-width="2.5" stroke-dasharray="7 4" stroke-linejoin="round"/>`;
      if (p.name && v.z >= 12) html += `<text x="${(lx / cnt).toFixed(1)}" y="${(ly / cnt).toFixed(1)}" text-anchor="middle" font-size="${v.z >= 14 ? 13 : 11}" font-weight="800" fill="#9a3412" stroke="#fff" stroke-width="3" paint-order="stroke" font-family="-apple-system,Segoe UI,Roboto,Arial,sans-serif">🏭 ${esc(p.name)}</text>`;
    }
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
          msg = `✅ Đã lưu: ${d.name} – ${d.addr}`;
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

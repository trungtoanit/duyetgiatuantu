// 📍 Bảng "Công ty Maps" trên trang Google Maps (chuyển từ tab của bảng Trợ lý ERP sang đây).
// Nút "📋 Danh sách công ty" (góc trên phải) mở bảng toàn màn hình: tìm / lọc (ERP, ngành, KCN, gần → xa), phân trang,
// xoá / khôi phục, kết nối ERP, chuẩn hoá MST, In PDF. Dữ liệu: kv mapsPlaces + customersAll (bản lưu máy IndexedDB, ⟳ tải lại từ cloud).
(() => {
  if (window.top !== window || window.__dgMapsTab) return;
  window.__dgMapsTab = true;
  const ERP = 'https://sale.tuantu.com.vn';
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
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const norm = (n) => (n || '').normalize('NFC').trim().toLowerCase();
  let meName = '';
  kvGet('me').then((me) => (meName = me?.name || '')).catch(() => {});

  // ---- khung toàn màn hình (shadow DOM riêng – không dính CSS Google) ----
  let root = null;
  let wrap = null;
  let open = false;
  const CSS = `:host{all:initial}*{box-sizing:border-box}
.ov{position:fixed;inset:0;z-index:2147483600;background:rgba(15,23,42,.45);display:flex;align-items:stretch;justify-content:center;padding:2vh 1.5vw;font:13px/1.45 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a}
.card{position:relative;background:#fff;border-radius:14px;box-shadow:0 20px 50px rgba(15,23,42,.35);width:100%;max-width:1600px;display:flex;flex-direction:column;overflow:hidden}
.top{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #e2e8f0;background:#eff6ff;font-weight:900;color:#1e3a8a;font-size:15px}
.x{margin-left:auto;cursor:pointer;border:0;background:none;font-size:20px;color:#64748b;font-weight:900}
.body{overflow:auto;padding:10px 14px;flex:1}
.muted{color:#64748b;font-size:12px}
.gt-edit{font:inherit}
a{color:#1d4ed8}
button{font:inherit}`;
  async function render() {
    if (!open || !root) return;
    const body = root.querySelector('.body');
    const keep = body?.scrollTop || 0;
    let html;
    try {
      html = await mapsTab();
    } catch (e) {
      html = `<div style="color:#b91c1c">⚠️ ${esc(e.message || e)}</div>`;
    }
    root.querySelector('.body').innerHTML = html;
    root.querySelector('.body').scrollTop = keep;
  }
  function show() {
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'dg-maps-tab';
      root = wrap.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CSS}</style><div class="ov"><div class="card"><div class="top">📍 Công ty Maps – danh sách công ty quét từ Google Maps<button class="x" data-close title="Đóng (Esc)">✕</button></div><div class="body"><div class="muted">⏳ Đang đọc dữ liệu trên máy…</div></div></div></div>`;
      root.querySelector('[data-close]').addEventListener('click', hide);
      root.querySelector('.ov').addEventListener('mousedown', (e) => e.target.classList?.contains('ov') && hide());
      // phím gõ trong bảng không lọt ra Google Maps (phím tắt của Maps)
      for (const t of ['keydown', 'keyup', 'keypress', 'wheel']) root.addEventListener(t, (e) => { if (t === 'keydown' && e.key === 'Escape') { if (mpUi.detail) { mpUi.detail = null; render(); } else if (!mpUi.link) hide(); } e.stopPropagation(); });
    }
    if (!wrap.isConnected) document.body.append(wrap);
    wrap.style.display = '';
    open = true;
    render();
  }
  function hide() {
    open = false;
    if (wrap) wrap.style.display = 'none';
  }
  // nút mở bảng (góc trên phải, cạnh ảnh đại diện Google)
  const fab = document.createElement('button');
  fab.id = 'dg-maps-tab-btn';
  fab.type = 'button';
  fab.textContent = '📋 Danh sách công ty';
  fab.title = 'Mở bảng Công ty Maps: tìm / lọc, xoá, kết nối ERP, chuẩn hoá MST, In PDF';
  fab.setAttribute('style', 'position:fixed;top:12px;right:120px;z-index:2147483000;cursor:pointer;border:2px solid #2563eb;background:#fff;color:#1d4ed8;border-radius:999px;padding:6px 14px;font:800 13px -apple-system,"Segoe UI",Roboto,Arial,sans-serif;box-shadow:0 6px 18px rgba(15,23,42,.25)');
  fab.addEventListener('click', () => (open ? hide() : show()));
  setInterval(() => document.body && !fab.isConnected && document.body.append(fab), 1500);
  if (/[?&#]dgMapsTab=1/.test(location.href)) setTimeout(show, 1500);

  // ---------- 📍 Tab "Công ty Maps": quản lý danh sách công ty quét từ Google Maps (kv mapsPlaces – đồng bộ cloud) ----------
  // Tìm / lọc, xoá (ẩn – Maps cũng ẩn, không quét lại) hoặc khôi phục, KẾT NỐI tay với khách hàng ERP (kv customersAll) / bỏ kết nối.
  // Kết nối tay lưu erpId (ưu tiên hơn so tên tự động), bỏ kết nối lưu erpNo – script Google Maps đọc cùng dữ liệu.
  const mpUi = { tel: '', amin: '', sort: 'name', q: '', erp: '', box: '', ind: '', show: 'on', page: 0, sel: new Set(), link: null, detail: null, lq: '', kcns: new Set(), kcnOpen: false, kq: '' }; // kcns: KCN đang lọc ('' = ngoài KCN)
  let mpData = null;
  const mpKey = (t) => String(t || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const mpUn = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  // 💾 Bản lưu trên máy (IndexedDB của trang CRM, dạng JSON): mở tab đọc từ máy cho nhanh; nút ⟳ Tải lại → đồng bộ cloud rồi lưu đè.
  // Xoá / khôi phục / kết nối ERP: ghi cloud (kvMerge) + ghi đè bản lưu máy, chạy ngầm.
  const mpIdb = () =>
    new Promise((ok, bad) => {
      const r = indexedDB.open('dgMapsTab', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => bad(r.error);
    });
  async function mpIdbGet(k) {
    const db = await mpIdb();
    return new Promise((ok) => {
      const q = db.transaction('kv').objectStore('kv').get(k);
      q.onsuccess = () => ok(q.result || null);
      q.onerror = () => ok(null);
    });
  }
  async function mpIdbSet(k, v) {
    const db = await mpIdb();
    return new Promise((ok, bad) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = () => ok();
      tx.onerror = () => bad(tx.error);
    });
  }
  let mpIdbT = 0;
  const mpIdbSave = () => {
    clearTimeout(mpIdbT);
    mpIdbT = setTimeout(() => mpData && mpIdbSet('data', { at: mpData.at, places: mpData.places, custs: mpData.custs }).catch(() => {}), 600);
  };
  function mpIndex(raw) {
    const byId = new Map();
    const byName = new Map();
    for (const c of raw.custs) {
      byId.set(String(c.id), c);
      const k = mpKey(c.name);
      if (k) byName.set(k, c);
    }
    mpData = { at: raw.at, places: raw.places || {}, custs: raw.custs, byId, byName };
    return mpData;
  }
  // 📐 script Google Maps vừa lưu diện tích đo tay → cập nhật bản lưu máy + bảng
  window.addEventListener('dg:areaSaved', async (e) => {
    const { id, place } = e.detail || {};
    if (!id || !place) return;
    await mpLoad().catch(() => null);
    if (!mpData) return;
    mpData.places[id] = place;
    mpIdbSave();
  });
  async function mpLoad(force = false) {
    if (mpData && !force) return mpData;
    if (!force) {
      const raw = await mpIdbGet('data').catch(() => null);
      // bản công ty mới nhất trên máy do script Google Maps giữ (dgMapsLocal – có ngành / 📦 tiềm năng thùng AI vừa chấm) → dùng bản đó
      const loc = await new Promise((ok) => {
        const r = indexedDB.open('dgMapsLocal', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onerror = () => ok(null);
        r.onsuccess = () => { try { const q = r.result.transaction('kv').objectStore('kv').get('places'); q.onsuccess = () => ok(q.result || null); q.onerror = () => ok(null); } catch { ok(null); } };
      });
      if (raw?.places) {
        if (loc?.places && (loc.at || 0) > (raw.at || 0)) raw.places = loc.places;
        return mpIndex(raw);
      }
    }
    // tải từ cloud: đồng bộ (≤ 20 giây) → đọc kho → lưu về máy
    if (force) await Promise.race([call({ type: 'sync.all' }).catch(() => {}), sleep(20e3)]);
    const [places, custs] = await Promise.all([kvGet('mapsPlaces'), kvGet('customersAll')]);
    const raw = {
      at: Date.now(),
      places: places || {},
      custs: Object.values(custs || {}).filter((c) => c?.id).map((c) => ({ id: c.id, name: c.name, code: c.code, phone: c.phone, address: c.address, staff: c.staff ? { name: c.staff.name } : null })),
    };
    await mpIdbSet('data', raw).catch(() => {});
    return mpIndex(raw);
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
  // Bộ lọc loại GIỐNG script Google Maps (scripts/maps/maps.js – isRealEstate): trả lý do bị loại, '' = giữ.
  // Sửa danh sách loại thì sửa cả 2 nơi.
  const MP_RE = /b[aấâ]t\s*đ[oộô]ng\s*s[aả]n|\bb[đd]s\b|đ[iị]a\s*[oố]c|real\s*estate|realt(y|or)|propert(y|ies)|\bland\b|nh[aà]\s*đ[aấ]t|môi giới nhà/i;
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
  function mpDropWhy(c) {
    if (c?.ind === 'Dịch vụ – tư vấn – phần mềm') return 'ngành dịch vụ – tư vấn – phần mềm';
    if (out7Why(c)) return out7Why(c);
    if (c?.name && !mpUn(c.name).replace(/\b(cong\s*ty|cty|tnhh|co\s*phan|cp|mtv|mot\s*thanh\s*vien|company|co|ltd|limited)\b/g, '').replace(/[^a-z0-9]/g, '')) return 'tên chỉ có “Công ty”';
    const t = `${c?.name || ''} | ${c?.legalName || ''} | ${c?.cat || ''}`.normalize('NFC');
    const u = mpUn(t);
    if (MP_RE.test(t) || /dia[\s.\-_]*oc|bat[\s.\-_]*dong[\s.\-_]*san|\bbds\b|real\s*estate/.test(u)) return 'bất động sản / địa ốc';
    if (/xay\s*lap|xay\s*dung|construction/.test(u)) return 'xây dựng / xây lắp';
    if (/phat\s*trien\s*nha/.test(u)) return 'phát triển nhà';
    if (/bao\s*ve\b|security/.test(u)) return 'bảo vệ';
    return '';
  }
  // SĐT: di động (03/05/07/08/09) có icon 📱, chữ xanh đậm; số bàn ☎ xám
  function mpPhone(p) {
    if (!p) return '';
    let d = String(p).replace(/\D/g, '');
    if (d.startsWith('84')) d = `0${d.slice(2)}`;
    return /^0[35789]\d{8}$/.test(d) ? `<a href="zalo://conversation?phone=84${d.slice(1)}" title="Di động – bấm để mở app Zalo trên máy (chat với ${d})" style="color:#15803d;font-weight:800;text-decoration:none">📱 ${esc(String(p).trim().replace(/^\+?84[\s.-]*/, '0'))} <span style="font-size:10.5px;color:#0068ff">Zalo ↗</span></a>` : `<span title="Số bàn" style="color:#64748b">☎ ${esc(String(p).trim().replace(/^\+?84[\s.-]*/, '0'))}</span>`;
  }
  const mpOff = (c) => !!c.hidden || !!mpDropWhy(c); // đã xoá tay hoặc bị bộ lọc loại
  // khách ERP của 1 công ty: bỏ kết nối → không; kết nối tay → theo id; còn lại tên giống 100% (không phân biệt hoa thường)
  const mpErp = (c) => (c.erpNo ? null : (c.erpId && mpData.byId.get(String(c.erpId))) || mpData.byName.get(mpKey(c.name)) || (c.legalName && mpData.byName.get(mpKey(c.legalName))) || null);
  function mpRows() {
    const q = mpUn(mpUi.q).trim();
    return Object.values(mpData.places).filter((c) => {
      if (!c?.name) return false;
      if (mpUi.show === 'on' ? mpOff(c) : !mpOff(c)) return false;
      const e = mpErp(c);
      if (mpUi.erp === 'in' && !e) return false;
      if (mpUi.erp === 'out' && e) return false;
      if (mpUi.box && !mpUi.box.includes(c.box || '-')) return false; // 📦 AI: khả năng dùng thùng carton / offset số lượng lớn
      if (mpUi.ind && (c.ind || '—') !== mpUi.ind) return false;
      if (mpUi.kcns.size && !mpUi.kcns.has(c.kcn || '')) return false;
      if (mpUi.amin && !((c.area || 0) >= Number(mpUi.amin))) return false;
      if (mpUi.tel) {
        // 📞 lọc SĐT: có SĐT / chỉ di động (03/05/07/08/09) / chỉ số bàn (02…)
        let d = String(c.phone || '').replace(/\D/g, '');
        if (d.startsWith('84')) d = `0${d.slice(2)}`;
        const mob = /^0[35789]\d{8}$/.test(d);
        if (mpUi.tel === 'any' && d.length < 8) return false;
        if (mpUi.tel === 'mob' && !mob) return false;
        if (mpUi.tel === 'tel' && (mob || d.length < 8)) return false;
        if (mpUi.tel === 'none' && d.length >= 8) return false;
      }
      if (q && !mpUn(`${c.name} ${c.legalName || ''} ${c.mst || ''} ${c.addr || ''} ${c.phone || ''} ${c.kcn || ''} ${e?.name || ''} ${e?.code || ''}`).includes(q)) return false;
      return true;
    }).sort((a, b) => (mpUi.sort === 'near' ? (mpDist(a) ?? 1e9) - (mpDist(b) ?? 1e9) : 0) || (mpUi.sort === 'area' ? (b.area || 0) - (a.area || 0) : 0) || (mpUi.sort === 'rate' ? (b.rateN || 0) - (a.rateN || 0) || (b.rate || 0) - (a.rate || 0) : 0) || (a.kcn || '~').localeCompare(b.kcn || '~', 'vi') || (a.legalName || a.name).localeCompare(b.legalName || b.name, 'vi'));
  }
  // 📍 Khoảng cách (km, đường chim bay) từ xưởng Tuấn Tú (48/13 KP Bình Phước B, An Phú): lấy toạ độ chính công ty Tuấn Tú
  // trong danh sách Google Maps; không có thì dùng toạ độ gần đúng
  let mpHome = null;
  function mpHomeAt() {
    if (mpHome) return mpHome;
    const me = Object.values(mpData?.places || {}).find((c) => c?.lat && /tu[aấ]n\s*t[uú]/i.test(`${c.name} ${c.legalName || ''}`) && /48\/13|b[iì]nh ph[uư][oớ]c b/i.test(`${c.addr || ''} ${c.legalAddr || ''}`));
    return (mpHome = me ? [me.lat, me.lng] : [10.9446, 106.7373]);
  }
  function mpDist(c) {
    if (!c?.lat || !c?.lng) return null;
    const [la, ln] = mpHomeAt();
    const r = Math.PI / 180;
    const x = Math.sin(((c.lat - la) * r) / 2) ** 2 + Math.cos(la * r) * Math.cos(c.lat * r) * Math.sin(((c.lng - ln) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(x));
  }
  // Lưu trang đang xem + ô tìm + bộ lọc của tab lên cloud (kv mapsTabUi, theo từng người) – F5 / máy khác mở lại đúng chỗ
  let mpUiLoaded = false;
  let mpUiT = 0;
  const mpPersist = () => {
    clearTimeout(mpUiT);
    mpUiT = setTimeout(() => {
      kvMerge('mapsTabUi', { [norm(meName || 'me')]: { q: mpUi.q, erp: mpUi.erp, box: mpUi.box, ind: mpUi.ind, show: mpUi.show, sort: mpUi.sort, amin: mpUi.amin, tel: mpUi.tel, page: mpUi.page, kcns: [...mpUi.kcns], at: Date.now() } }).catch(() => {});
    }, 800);
  };
  async function mapsTab() {
    if (!mpUiLoaded) {
      mpUiLoaded = true;
      const v = (await kvGet('mapsTabUi').catch(() => ({})))?.[norm(meName || 'me')];
      if (v) Object.assign(mpUi, { q: v.q || '', erp: v.erp || '', box: v.box || '', ind: v.ind || '', show: v.show || 'on', sort: v.sort || 'name', amin: v.amin || '', tel: v.tel || '', page: Number(v.page) || 0, kcns: new Set(Array.isArray(v.kcns) ? v.kcns : []) });
    }
    await mpLoad();
    if (root && !root.__mp) {
      root.__mp = 1;
      root.addEventListener('click', (e) => mpClick(e).catch((err) => alert(err.message || err)));
      root.addEventListener('input', mpInput);
      root.addEventListener('change', mpChange);
    }
    const rows = mpRows();
    const PER = 100;
    const pages = Math.max(1, Math.ceil(rows.length / PER));
    mpUi.page = Math.min(mpUi.page, pages - 1);
    const view = rows.slice(mpUi.page * PER, mpUi.page * PER + PER);
    const all = Object.values(mpData.places).filter((c) => c?.name);
    const nOn = all.filter((c) => !mpOff(c)).length;
    const inds = [...new Set(all.map((c) => c.ind || '—'))].sort((a, b) => a.localeCompare(b, 'vi'));
    const nErp = all.filter((c) => !mpOff(c) && mpErp(c)).length;
    const sel = 'font:inherit;font-size:12.5px;padding:3px 6px;border-radius:7px;border:1px solid #cbd5e1;background:#fff';
    const b = 'cursor:pointer;border:1px solid #cbd5e1;background:#fff;border-radius:7px;padding:2px 8px;font:inherit;font-size:12px;font-weight:700';
    const stt0 = mpUi.page * PER;
    const tr = view.map((c, i) => {
      const e = mpErp(c);
      const manual = !!c.erpId && !c.erpNo;
      return `<tr style="border-top:1px solid #f1f5f9;${e ? 'background:#f0fdf4' : ''}">
<td style="padding:4px 6px"><input type="checkbox" data-mp="sel" data-id="${esc(c.id)}" ${mpUi.sel.has(c.id) ? 'checked' : ''}></td>
<td style="padding:4px 6px;color:#94a3b8;text-align:right">${stt0 + i + 1}</td>
<td style="padding:4px 6px;max-width:300px"><b data-mp="detail" data-id="${esc(c.id)}" title="Xem chi tiết công ty" style="cursor:pointer;color:#1e3a8a;text-decoration:underline dotted #93c5fd">${esc((e?.name || c.legalName || c.name).toLocaleUpperCase('vi'))}</b>${c.rate ? ` <span title="Đánh giá Google Maps: ${c.rate} sao · ${c.rateN || 0} lượt" style="color:#b45309;font-size:11.5px;font-weight:800;white-space:nowrap">⭐ ${String(c.rate).replace('.', ',')}${c.rateN ? ` <span style="color:#94a3b8;font-weight:600">(${Number(c.rateN).toLocaleString('vi-VN')})</span>` : ''}</span>` : ''}${(e?.name || c.legalName) && (e?.name || c.legalName) !== c.name ? `<div style="font-size:11px;color:#64748b">Google: ${esc(c.name)}</div>` : ''}</td>
<td style="padding:4px 6px;white-space:nowrap">${c.mst ? `<a href="${esc(c.mstUrl || `https://masothue.com/Search/?q=${c.mst}`)}" target="_blank" rel="noopener" style="color:#7c3aed">${esc(c.mst)}</a>${c.mstManual ? ' <span title="MST nhập tay" style="font-size:10px;color:#7c3aed">✋</span>' : ''} <a href="#" data-mp="mst" data-id="${esc(c.id)}" title="Sửa MST / lấy lại tên chuẩn từ masothue" style="text-decoration:none;font-size:11px">✎</a>` : `<button data-mp="mst" data-id="${esc(c.id)}" title="Nhập MST (vd. tìm trên Google / masothue) → lấy tên + địa chỉ chuẩn từ masothue, lưu cloud" style="${b};border-color:#c4b5fd;color:#6d28d9;background:#f5f3ff">🧾 Chuẩn hoá MST</button>`}${mpMstMsg[c.id] ? `<div style="font-size:10.5px;color:#7c3aed;white-space:normal">${esc(mpMstMsg[c.id])}</div>` : ''}</td>
<td style="padding:4px 6px;font-size:12px">${esc(c.ind || '')}${c.box === 'A' || c.box === 'B' ? `<div title="${esc(c.boxWhy || '')}" style="font-size:11px;font-weight:800;color:${c.box === 'A' ? '#15803d' : '#b45309'}">📦 Thùng: ${c.box === 'A' ? 'cao' : 'vừa'}</div>` : ''}</td>
<td style="padding:4px 6px;white-space:nowrap">${mpAreaCell(c)}</td>
<td style="padding:4px 6px;font-size:12px;color:#9a3412">${esc(c.kcn || '')}</td>
<td style="padding:4px 6px;font-size:12px;max-width:260px;color:#475569">${mpDist(c) != null ? `<b style="color:#0369a1;white-space:nowrap" title="Khoảng cách đường chim bay từ xưởng Tuấn Tú">📍 ${mpDist(c).toFixed(1)} km</b> · ` : ''}${esc(c.legalAddr || c.addr || '')}</td>
<td style="padding:4px 6px;white-space:nowrap;font-size:12px">${e ? '<span style="color:#94a3b8">ẩn (khách ERP)</span>' : mpPhone(c.phone)}</td>
<td style="padding:4px 6px;white-space:nowrap">${e ? `<a href="${ERP}/khach-hang/view/${e.id}?dgNoPanel=1" target="_blank" rel="noopener" style="color:#15803d;font-weight:800">✅ ${esc(e.code || e.name)}</a>${e.staff?.name ? ` <span style="font-size:11px;color:#64748b">· ${esc(e.staff.name)}</span>` : ''}<div style="font-size:11px;color:#64748b">${manual ? '🔗 kết nối tay' : 'tự khớp tên'} · <a href="#" data-mp="unlink" data-id="${esc(c.id)}" style="color:#b91c1c">bỏ kết nối</a></div>` : `<button data-mp="link" data-id="${esc(c.id)}" style="${b};border-color:#86efac;color:#166534;background:#f0fdf4">🔗 Kết nối ERP</button>${c.erpNo ? '<div style="font-size:11px;color:#94a3b8">đã bỏ kết nối</div>' : ''}`}</td>
<td style="padding:4px 6px;white-space:nowrap"><a href="${esc(c.href || c.url)}" target="_blank" rel="noopener" title="Mở trên Google Maps" style="text-decoration:none">🗺</a> ${c.hidden ? `<button data-mp="restore" data-id="${esc(c.id)}" style="${b}">↩ Khôi phục</button>` : mpDropWhy(c) ? `<span style="font-size:11px;color:#94a3b8" title="Bị bộ lọc loại tự động (giống Google Maps)">🚫 ${esc(mpDropWhy(c))}</span>` : `<button data-mp="del" data-id="${esc(c.id)}" style="${b};color:#b91c1c;border-color:#fecaca">🗑 Xoá</button>`}</td></tr>`;
    }).join('');
    const linkBox = mpUi.link ? (() => {
      const c = mpData.places[mpUi.link];
      return `<div data-mp-modal style="position:fixed;inset:0;z-index:70;background:rgba(15,23,42,.4);display:flex;align-items:flex-start;justify-content:center;padding:8vh 16px">
<div style="background:#fff;border-radius:12px;box-shadow:0 18px 44px rgba(15,23,42,.35);width:min(560px,100%);padding:12px 14px">
<div style="display:flex;align-items:center;margin-bottom:6px"><b style="flex:1">🔗 Kết nối “${esc(c?.legalName || c?.name || '')}” với khách hàng ERP</b><span data-mp="lclose" style="cursor:pointer;color:#64748b;font-weight:900">✕</span></div>
<input class="gt-edit" data-mp-lq placeholder="Gõ tên / mã KH / SĐT khách hàng ERP…" value="${esc(mpUi.lq)}" style="width:100%;box-sizing:border-box;font:inherit;padding:6px 8px;border-radius:8px;border:1px solid #93c5fd">
<div data-mp-res style="margin-top:6px;max-height:50vh;overflow:auto">${mpLinkResults()}</div>
<div style="font-size:11.5px;color:#64748b;margin-top:6px">Dữ liệu khách ERP: ${mpData.custs.length.toLocaleString('vi-VN')} khách đã đồng bộ (thiếu thì đồng bộ ở trang Khách hàng).</div></div></div>`;
    })() : '';
    return `<div style="padding:10px 12px">
<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
<b style="font-size:15px">📍 Công ty từ Google Maps</b><span class="muted">${nOn.toLocaleString('vi-VN')} công ty · ✅ ${nErp} đã kết nối ERP · ${all.length - nOn} đã xoá / bị loại (BĐS, địa ốc, xây dựng, bảo vệ…)</span>
<span style="flex:1"></span><span class="muted" style="font-size:11.5px" title="Danh sách đọc từ bản lưu trên máy (JSON) cho nhanh – bấm Tải lại để lấy mới từ cloud">💾 lưu máy lúc ${new Date(mpData.at).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}</span><button data-mp="pdf" title="In PDF các công ty đang lọc (cùng định dạng với nút In PDF bên Google Maps)" style="${b};border-color:#93c5fd;background:#eff6ff;color:#1d4ed8">🖨 In PDF (${rows.length.toLocaleString('vi-VN')})</button><button data-mp="reload" style="${b}">⟳ Tải lại từ cloud</button></div>
<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px">
<input class="gt-edit" data-mp-q placeholder="🔍 Tìm tên, MST, địa chỉ, SĐT, KCN, mã KH…" value="${esc(mpUi.q)}" style="${sel};min-width:280px;flex:1">
<select data-mp-f="box" title="AI đánh giá khả năng dùng thùng carton / thùng offset số lượng lớn" style="${sel};${mpUi.box ? 'border-color:#16a34a;background:#dcfce7;color:#166534;font-weight:700' : ''}"><option value="">📦 Tiềm năng thùng: tất cả</option><option value="A" ${mpUi.box === 'A' ? 'selected' : ''}>📦 Chỉ tiềm năng cao (${all.filter((c) => !mpOff(c) && c.box === 'A').length})</option><option value="B" ${mpUi.box === 'B' ? 'selected' : ''}>📦 Chỉ tiềm năng vừa (${all.filter((c) => !mpOff(c) && c.box === 'B').length})</option><option value="AB" ${mpUi.box === 'AB' ? 'selected' : ''}>📦 Cao + vừa (${all.filter((c) => !mpOff(c) && (c.box === 'A' || c.box === 'B')).length})</option></select>
<select data-mp-f="erp" style="${sel}"><option value="">ERP: tất cả</option><option value="in" ${mpUi.erp === 'in' ? 'selected' : ''}>✅ Đã kết nối ERP</option><option value="out" ${mpUi.erp === 'out' ? 'selected' : ''}>Chưa kết nối ERP</option></select>
<select data-mp-f="ind" style="${sel};max-width:220px"><option value="">Ngành: tất cả</option>${inds.map((x) => `<option value="${esc(x)}" ${mpUi.ind === x ? 'selected' : ''}>${x === '—' ? 'Chưa gắn ngành' : esc(x)}</option>`).join('')}</select>
<span style="position:relative"><button data-mp="kcnbtn" style="${sel};cursor:pointer;font-weight:700;${mpUi.kcns.size ? 'border-color:#f59e0b;background:#fff7ed;color:#9a3412' : ''}">🏭 KCN: ${mpUi.kcns.size ? `${mpUi.kcns.size} đã chọn` : 'tất cả'} ▾</button>${mpUi.kcnOpen ? (() => {
      const cnt = new Map();
      for (const c of all) if (!mpOff(c)) cnt.set(c.kcn || '', (cnt.get(c.kcn || '') || 0) + 1);
      // tâm KCN = trung bình toạ độ các công ty thuộc KCN → đoán tỉnh; gom theo tỉnh, trong tỉnh xếp theo tên
      const sum = new Map();
      for (const c of all) {
        if (!c.kcn || !c.lat) continue;
        const v = sum.get(c.kcn) || [0, 0, 0];
        v[0] += c.lat;
        v[1] += c.lng;
        v[2]++;
        sum.set(c.kcn, v);
      }
      const pvOf = (k) => {
        const v = sum.get(k);
        return provOf(k, v ? v[0] / v[2] : null, v ? v[1] / v[2] : null);
      };
      const ks = [...cnt.keys()].filter((k) => k);
      const byP = new Map();
      for (const k of ks) {
        const pv = pvOf(k);
        if (!byP.has(pv)) byP.set(pv, []);
        byP.get(pv).push(k);
      }
      const kq = mpUn(mpUi.kq);
      const opt = (k, label) => (kq && !mpUn(label).includes(kq) ? '' : `<label style="display:flex;gap:6px;align-items:center;padding:3px 6px;border-radius:6px;cursor:pointer;font-size:12.5px;${mpUi.kcns.has(k) ? 'background:#fff7ed' : ''}"><input type="checkbox" data-mp-kcn="${esc(k)}" ${mpUi.kcns.has(k) ? 'checked' : ''}><span style="flex:1">${esc(label)}</span><span style="color:#94a3b8">${cnt.get(k) || 0}</span></label>`);
      return `<div data-mp-kpop style="position:absolute;left:0;top:calc(100% + 4px);z-index:40;width:380px;max-height:60vh;overflow:auto;background:#fff;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 12px 30px rgba(15,23,42,.22);padding:6px">
<input class="gt-edit" data-mp-kq placeholder="Tìm KCN…" value="${esc(mpUi.kq)}" style="${sel};width:100%;box-sizing:border-box;margin-bottom:4px">
<div style="display:flex;gap:6px;margin:2px 0 4px"><a href="#" data-mp="kall" style="font-size:12px">chọn hết</a><a href="#" data-mp="knone" style="font-size:12px">bỏ chọn (tất cả)</a><span style="flex:1"></span><a href="#" data-mp="kclose" style="font-size:12px;font-weight:800">Xong ✓</a></div>
${opt('', 'Ngoài KCN')}${PROV_ORDER.filter((pv) => byP.has(pv)).map((pv) => `<div style="margin:6px 0 2px;padding:2px 6px;font-size:11.5px;font-weight:900;color:#1e3a8a;background:#eff6ff;border-radius:6px">📍 ${pv} · ${byP.get(pv).length} KCN</div>${byP.get(pv).sort((a, c) => a.localeCompare(c, 'vi')).map((k) => opt(k, k)).join('')}`).join('')}</div>`;
    })() : ''}</span>
<select data-mp-f="sort" title="Sắp xếp" style="${sel}"><option value="name">↕ Theo KCN, tên</option><option value="near" ${mpUi.sort === 'near' ? 'selected' : ''}>📍 Gần → xa (từ Tuấn Tú)</option><option value="rate" ${mpUi.sort === 'rate' ? 'selected' : ''}>⭐ Nhiều đánh giá → ít</option><option value="area" ${mpUi.sort === 'area' ? 'selected' : ''}>📐 Xưởng lớn → nhỏ</option></select>
<select data-mp-f="tel" title="Lọc theo số điện thoại" style="${sel};${mpUi.tel ? 'border-color:#16a34a;background:#dcfce7;color:#166534;font-weight:700' : ''}"><option value="">📞 SĐT: tất cả</option><option value="any" ${mpUi.tel === 'any' ? 'selected' : ''}>📞 Có SĐT</option><option value="mob" ${mpUi.tel === 'mob' ? 'selected' : ''}>📱 Chỉ di động</option><option value="tel" ${mpUi.tel === 'tel' ? 'selected' : ''}>☎ Chỉ số bàn</option><option value="none" ${mpUi.tel === 'none' ? 'selected' : ''}>Không có SĐT</option></select>
<select data-mp-f="amin" title="Lọc theo diện tích mái nhà xưởng (OpenStreetMap, gần đúng)" style="${sel}"><option value="">📐 Diện tích: tất cả</option>${[[1000, '≥ 1.000 m²'], [3000, '≥ 3.000 m²'], [5000, '≥ 5.000 m²'], [10000, '≥ 10.000 m²'], [20000, '≥ 20.000 m²']].map(([v, t]) => `<option value="${v}" ${String(mpUi.amin) === String(v) ? 'selected' : ''}>📐 ${t}</option>`).join('')}</select>
<select data-mp-f="show" style="${sel}"><option value="on">Đang dùng</option><option value="off" ${mpUi.show === 'off' ? 'selected' : ''}>🗑 Đã xoá</option></select>
${mpUi.sel.size ? `<button data-mp="bulk" style="${b};color:#b91c1c;border-color:#fecaca">${mpUi.show === 'on' ? `🗑 Xoá ${mpUi.sel.size} đã chọn` : `↩ Khôi phục ${mpUi.sel.size} đã chọn`}</button>` : ''}
</div>
<div class="muted" style="margin-bottom:4px">${rows.length.toLocaleString('vi-VN')} công ty khớp · trang ${mpUi.page + 1}/${pages}</div>
<style>.mp-tb tbody tr{transition:background .12s}.mp-tb tbody tr:hover td{background:#e0f2fe!important}.mp-tb tbody tr:hover td:first-child{box-shadow:inset 3px 0 0 #0284c7}</style>
<div style="overflow:auto;border:1px solid #e2e8f0;border-radius:8px"><table class="mp-tb" style="width:100%;border-collapse:collapse;font-size:12.5px">
<thead><tr style="background:#f8fafc;text-align:left"><th style="padding:5px 6px"><input type="checkbox" data-mp="selall"></th><th style="padding:5px 6px">STT</th><th>Tên công ty</th><th>MST</th><th>Ngành</th><th title="Diện tích mái nhà xưởng – đo từ OpenStreetMap (gần đúng) hoặc nhập tay">Diện tích xưởng</th><th>KCN</th><th>Địa chỉ</th><th>SĐT</th><th>ERP</th><th></th></tr></thead>
<tbody>${tr || '<tr><td colspan="11" style="padding:14px;text-align:center;color:#94a3b8">Không có công ty nào.</td></tr>'}</tbody></table></div>
<div style="position:sticky;bottom:0;z-index:5;display:flex;gap:4px;justify-content:center;align-items:center;flex-wrap:wrap;margin-top:8px;padding:8px 0;background:rgba(255,255,255,.96);border-top:1px solid #e2e8f0;box-shadow:0 -6px 14px rgba(15,23,42,.06)">${(() => {
      // phân trang: « Đầu · ‹ Trước · các số trang quanh trang hiện tại · Sau › · Cuối » · ô chọn trang
      const cur = mpUi.page;
      const nums = [...new Set([0, cur - 2, cur - 1, cur, cur + 1, cur + 2, pages - 1])].filter((x) => x >= 0 && x < pages).sort((a, c) => a - c);
      const dis = 'opacity:.4;cursor:default';
      let out = `<button data-mp="first" ${cur === 0 ? 'disabled' : ''} style="${b};${cur === 0 ? dis : ''}">« Đầu</button><button data-mp="prev" ${cur === 0 ? 'disabled' : ''} style="${b};${cur === 0 ? dis : ''}">‹ Trước</button>`;
      let last = -1;
      for (const x of nums) {
        if (x - last > 1) out += '<span style="color:#94a3b8;padding:0 2px">…</span>';
        out += `<button data-mp="pg" data-p="${x}" style="${b};${x === cur ? 'background:#2563eb;border-color:#2563eb;color:#fff' : ''}">${x + 1}</button>`;
        last = x;
      }
      out += `<button data-mp="next" ${cur >= pages - 1 ? 'disabled' : ''} style="${b};${cur >= pages - 1 ? dis : ''}">Sau ›</button><button data-mp="last" ${cur >= pages - 1 ? 'disabled' : ''} style="${b};${cur >= pages - 1 ? dis : ''}">Cuối »</button>`;
      out += `<select data-mp-f="page" style="${sel};margin-left:6px">${Array.from({ length: pages }, (_, x) => `<option value="${x}" ${x === cur ? 'selected' : ''}>Trang ${x + 1}/${pages}</option>`).join('')}</select>`;
      return out;
    })()}</div>
${linkBox}${mpDetailBox()}</div>`;
  }
  // 📐 Ô diện tích xưởng: số m² (đo OSM / nhập tay), "chưa đo" (đang chờ lượt đo), "OSM chưa vẽ" (đo rồi mà không có nhà) – ✎ để nhập tay
  function mpAreaCell(c) {
    const ed = `${c.lat ? `<a href="#" data-mp="areadraw" data-id="${esc(c.id)}" title="Đo tay: mở ảnh vệ tinh tại công ty, bấm từng góc mái xưởng → tự tính m²" style="text-decoration:none;font-size:11px;font-weight:800;color:#b45309;margin-left:4px">✏️ Đo tay</a>` : ''} <a href="#" data-mp="area" data-id="${esc(c.id)}" title="Gõ số diện tích" style="text-decoration:none;font-size:11px">✎</a>`;
    if (c.area > 0) {
      const big = c.area >= 5000;
      const src = c.areaSrc === 'tay' ? '✋ nhập tay' : c.areaSrc === 'osm-near' ? 'OSM · nhà gần nhất' : 'OSM';
      return `<span title="Diện tích mái nhà xưởng – ${src} (gần đúng)" style="display:inline-block;padding:1px 8px;border-radius:7px;background:${big ? '#fef3c7' : '#f1f5f9'};border:1px solid ${big ? '#f59e0b' : '#e2e8f0'};color:${big ? '#92400e' : '#334155'};font-size:12.5px;font-weight:900">📐 ${c.area.toLocaleString('vi-VN')} m²</span> ${ed}<div style="font-size:10.5px;color:#94a3b8">${src}</div>`;
    }
    if (c.area === 0) return `<span style="font-size:11.5px;color:#94a3b8" title="Đã đo: OpenStreetMap chưa vẽ nhà xưởng ở vị trí này">OSM chưa vẽ</span> ${ed}`;
    return `<span style="font-size:11.5px;color:#94a3b8" title="Chờ lượt đo tự động từ OpenStreetMap (≤ 20 công ty / 30 giây khi đang mở Google Maps)">⏳ chưa đo</span> ${ed}`;
  }
  // Popup chi tiết công ty: thông tin pháp lý, liên hệ, KCN, diện tích, ERP + bản đồ vệ tinh + trang Google Maps (ảnh, đánh giá)
  function mpDetailBox() {
    const c = mpUi.detail && mpData.places[mpUi.detail];
    if (!c) return '';
    const e = mpErp(c);
    const name = (e?.name || c.legalName || c.name).toLocaleUpperCase('vi');
    const d = mpDist(c);
    const row = (k, v) => (v ? `<div style="display:grid;grid-template-columns:118px 1fr;gap:8px;padding:5px 0;border-top:1px solid #f1f5f9"><span style="color:#64748b;font-size:12px;font-weight:700">${k}</span><span style="font-size:13px">${v}</span></div>` : '');
    const sec = (t, body) => (body ? `<div style="margin-top:10px"><div style="font-size:11px;font-weight:900;letter-spacing:.06em;color:#1d4ed8;text-transform:uppercase;margin-bottom:2px">${t}</div>${body}</div>` : '');
    const stars = c.rate ? `<span style="color:#f59e0b;letter-spacing:1px">${'★'.repeat(Math.round(c.rate))}${'☆'.repeat(5 - Math.round(c.rate))}</span> <b>${String(c.rate).replace('.', ',')}</b> <span style="color:#64748b">· ${Number(c.rateN || 0).toLocaleString('vi-VN')} đánh giá</span>` : '<span style="color:#94a3b8">Chưa có đánh giá</span>';
    const box = c.box === 'A' ? '<b style="color:#15803d">cao</b>' : c.box === 'B' ? '<b style="color:#b45309">vừa</b>' : c.box ? 'thấp' : '';
    const ll = c.lat && c.lng ? `${c.lat},${c.lng}` : '';
    const gm = c.href || c.url;
    const sat = ll ? `https://www.google.com/maps?q=${ll}&t=k&z=17&hl=vi&output=embed` : '';
    return `<div data-mp-modal style="position:fixed;inset:0;z-index:60;background:rgba(15,23,42,.45);display:flex;align-items:flex-start;justify-content:center;padding:4vh 16px;overflow:auto">
<div style="background:#fff;border-radius:14px;box-shadow:0 18px 44px rgba(15,23,42,.35);width:min(1100px,100%);overflow:hidden">
<div style="display:flex;align-items:flex-start;gap:10px;padding:12px 16px;background:linear-gradient(90deg,#eff6ff,#f8fafc);border-bottom:1px solid #e2e8f0">
<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:900;color:#0f172a">${esc(name)}</div>
${c.legalName && c.name !== c.legalName ? `<div style="font-size:12px;color:#64748b">Tên trên Google: ${esc(c.name)}</div>` : ''}
<div style="font-size:12.5px;margin-top:3px">${stars}${c.ind ? ` · <span style="background:#ecfeff;color:#0e7490;border-radius:6px;padding:0 6px;font-weight:800">${esc(c.ind)}</span>` : ''}${c.cat ? ` · <span style="color:#64748b">${esc(c.cat)}</span>` : ''}</div></div>
<span data-mp="dclose" title="Đóng (Esc)" style="cursor:pointer;color:#64748b;font-weight:900;font-size:18px">✕</span></div>
<div style="display:grid;grid-template-columns:minmax(300px,380px) 1fr;gap:0">
<div style="padding:4px 16px 14px;border-right:1px solid #f1f5f9">
${sec('Pháp lý', row('Mã số thuế', c.mst ? `<a href="${esc(c.mstUrl || `https://masothue.com/Search/?q=${c.mst}`)}" target="_blank" rel="noopener" style="color:#7c3aed;font-weight:800">${esc(c.mst)}</a>` : '<span style="color:#94a3b8">chưa có</span>') + (c.mstInfo?.length ? c.mstInfo.filter(([k]) => !/^Mã số thuế$/i.test(k)).map(([k, v]) => row(esc(k), esc(v))).join('') : '') + (c.mstInfo?.length ? '' : row('Địa chỉ pháp lý', esc(c.legalAddr || ''))) + (c.mst ? `<div style="font-size:11px;color:#94a3b8;margin-top:3px">${c.mstInfo?.length ? `🧾 masothue · ${new Date(c.mstInfoAt || c.mstAt || Date.now()).toLocaleDateString('vi-VN')} · ` : ''}<a href="#" data-mp="mstinfo" data-id="${esc(c.id)}">${c.mstInfo?.length ? 'lấy lại' : '🧾 Lấy đủ thông tin từ masothue'}</a>${mpMstMsg[c.id] ? ` · ${esc(mpMstMsg[c.id])}` : ''}</div>` : ''))}
${sec('Vị trí', row('Khu công nghiệp', c.kcn ? `<b style="color:#9a3412">🏭 ${esc(c.kcn)}</b>` : '<span style="color:#94a3b8">ngoài KCN</span>') + row('Địa chỉ', esc(c.addr || '')) + row('Khoảng cách', d != null ? `<b style="color:#0369a1">📍 ${d.toFixed(1)} km</b> từ xưởng Tuấn Tú` : ''))}
${sec('Quy mô', row('Diện tích xưởng', mpAreaCell(c)) + row('Tiềm năng thùng', box ? `📦 ${box}${c.boxWhy ? `<div style="font-size:11.5px;color:#64748b">${esc(c.boxWhy)}</div>` : ''}` : ''))}
${sec('Liên hệ', row('Điện thoại', e ? '<span style="color:#94a3b8">ẩn (khách ERP)</span>' : mpPhone(c.phone)) + row('ERP', e ? `<a href="${ERP}/khach-hang/view/${e.id}?dgNoPanel=1" target="_blank" rel="noopener" style="color:#15803d;font-weight:800">✅ ${esc(e.code || e.name)}</a>${e.staff?.name ? ` · NVKD ${esc(e.staff.name)}` : ''}` : `<button data-mp="link" data-id="${esc(c.id)}" style="cursor:pointer;border:1px solid #86efac;color:#166534;background:#f0fdf4;border-radius:7px;padding:2px 8px;font-weight:700">🔗 Kết nối ERP</button>`))}
${sec('Hình ảnh', `<div data-mp-photos>${mpPhotosHtml(c)}</div>`)}
<div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">${gm ? `<a href="${esc(gm)}" target="_blank" rel="noopener" style="text-decoration:none;border:1px solid #bfdbfe;background:#eff6ff;border-radius:8px;padding:4px 10px;font-weight:800;font-size:12.5px">🗺 Mở trên Google Maps</a>` : ''}${ll ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${ll}" target="_blank" rel="noopener" style="text-decoration:none;border:1px solid #e2e8f0;border-radius:8px;padding:4px 10px;font-weight:800;font-size:12.5px">🚗 Chỉ đường</a>` : ''}</div>
</div>
<div style="position:relative;display:grid;grid-template-rows:1fr;min-height:560px;background:#f8fafc">
${sat ? `<iframe src="${esc(sat)}" title="Bản đồ vệ tinh" loading="lazy" style="width:100%;height:100%;min-height:560px;border:0"></iframe>` : '<div style="display:grid;place-items:center;color:#94a3b8">Chưa có toạ độ</div>'}
${gm ? `<iframe data-mp-place src="${esc(gm)}" title="Ảnh trên Google Maps (ẩn – chỉ để đọc ảnh)" aria-hidden="true" tabindex="-1" style="position:absolute;left:-10000px;top:0;width:1100px;height:800px;border:0;visibility:hidden;pointer-events:none"></iframe>` : ''}
</div></div></div></div>`;
  }
  // 📸 Ảnh công ty: đọc ảnh trong khung trang Google Maps của popup (cùng tên miền google.com nên đọc được), lưu đường dẫn ảnh lên cloud (c.photos)
  const MP_PHOTO_MAX = 12;
  // Ảnh Google: bỏ phần cỡ ảnh sau "=" để so trùng, lưu cỡ vừa xem (800px); chỉ lấy ảnh địa điểm, bỏ ảnh đại diện người đánh giá (/a/, /a-/)
  const mpPhotoBase = (u) => String(u || '').split('=')[0];
  const mpIsPhoto = (u) => /^https:\/\/lh\d\.googleusercontent\.com\/(gps-cs-s|gps-proxy|p)\//.test(u);
  function mpPhotosHtml(c) {
    const ps = c?.photos || [];
    if (!ps.length) return '<span style="color:#94a3b8;font-size:12px">Chưa có ảnh – để popup mở vài giây, ảnh trong khung Google Maps bên phải sẽ tự lưu lên cloud.</span>';
    return `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-top:4px">${ps.map((u) => `<a href="${esc(mpPhotoBase(u))}=w1600" target="_blank" rel="noopener" title="Mở ảnh lớn"><img src="${esc(u)}" loading="lazy" referrerpolicy="no-referrer" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:6px;border:1px solid #e2e8f0;display:block"></a>`).join('')}</div><div style="font-size:10.5px;color:#94a3b8;margin-top:3px">☁️ ${ps.length} ảnh đã lưu${c.photosAt ? ` · ${new Date(c.photosAt).toLocaleDateString('vi-VN')}` : ''}</div>`;
  }
  // Theo dõi khung Google Maps ~40 giây khi popup đang mở: gặp ảnh mới thì gộp vào ảnh đã lưu (tối đa 12) và lưu cloud
  async function mpWatchPhotos(id) {
    for (let i = 0; i < 27 && mpUi.detail === id && open; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const c = mpData.places[id];
      let doc = null;
      try { doc = root?.querySelector('[data-mp-place]')?.contentDocument; } catch {}
      if (!c || !doc?.body) continue;
      if ((c.photos || []).length >= MP_PHOTO_MAX) return;
      const urls = [];
      for (const img of doc.querySelectorAll('img')) urls.push(img.currentSrc || img.src);
      for (const el of doc.querySelectorAll('[style*="googleusercontent"]')) {
        const m = (el.getAttribute('style') || '').match(/url\(["']?([^"')]+)/);
        if (m) urls.push(m[1].replace(/&quot;/g, ''));
      }
      const have = new Set((c.photos || []).map(mpPhotoBase));
      const add = [];
      for (const u of urls) {
        if (!mpIsPhoto(u) || have.has(mpPhotoBase(u))) continue;
        have.add(mpPhotoBase(u));
        add.push(`${mpPhotoBase(u)}=w800-h600-k-no`);
      }
      if (!add.length) continue;
      const v = { ...c, photos: [...(c.photos || []), ...add].slice(0, MP_PHOTO_MAX), photosAt: Date.now() };
      await mpSave({ [id]: v }).catch(() => {});
      const box = root?.querySelector('[data-mp-photos]');
      if (box && mpUi.detail === id) box.innerHTML = mpPhotosHtml(v);
    }
  }
  function mpLinkResults() {
    const q = mpUn(mpUi.lq).trim();
    const qd = mpUi.lq.replace(/\D/g, '');
    if (!q) {
      // gợi ý theo tên công ty đang kết nối
      const c = mpData.places[mpUi.link];
      const words = mpUn(c?.legalName || c?.name).replace(/\b(cong ty|tnhh|co phan|mtv|viet nam|chi nhanh)\b/g, ' ').split(/\s+/).filter((w) => w.length > 2);
      if (!words.length) return '<div class="muted">Gõ để tìm khách hàng ERP.</div>';
      const sc = mpData.custs.map((x) => ({ x, s: words.filter((w) => mpUn(x.name).includes(w)).length })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s).slice(0, 8);
      return sc.length ? `<div class="muted" style="font-size:11.5px">Gợi ý theo tên:</div>${sc.map(({ x }) => mpLinkItem(x)).join('')}` : '<div class="muted">Không có gợi ý – gõ để tìm.</div>';
    }
    const list = mpData.custs.filter((x) => mpUn(`${x.name} ${x.code}`).includes(q) || (qd.length >= 6 && String(x.phone || '').replace(/\D/g, '').includes(qd))).slice(0, 12);
    return list.length ? list.map(mpLinkItem).join('') : '<div class="muted">Không tìm thấy khách hàng ERP.</div>';
  }
  const mpLinkItem = (x) => `<div data-mp="pick" data-cid="${esc(String(x.id))}" style="cursor:pointer;padding:6px 8px;border-radius:8px;border:1px solid #e2e8f0;margin-top:4px"><b>${esc(x.name)}</b> <span style="color:#15803d;font-weight:800">${esc(x.code || '')}</span><div style="font-size:11.5px;color:#64748b">${esc(x.address || '')}${x.staff?.name ? ` · NVKD ${esc(x.staff.name)}` : ''}</div></div>`;
  // 🧾 Chuẩn hoá MST tay: nhập MST → lưu ngay (cloud + máy, đánh dấu mstManual) → xếp việc cho tab tra MST (masothue.com/#dgmst)
  // lấy tên pháp lý + địa chỉ đăng ký, xong tự cập nhật. masothue chặn gọi ngầm nên phải qua tab đó (như Google Maps).
  const mpMstMsg = {};
  async function mpMstFix(id) {
    const c = mpData.places[id];
    if (!c) return;
    const nm = c.legalName || c.name;
    // bấm là mở thẳng tab Google tìm MST (không hỏi), chọn “📥 Lấy MST này” ở kết quả đúng
    let v = '';
    let pickName = '';
    {
      // mở Google: script trên trang kết quả gắn nút 📥 cạnh mỗi kết quả có MST → ghi kv mstPick; chờ ≤ 15 phút
      const at = Date.now();
      window.open(`https://www.google.com/search?q=${encodeURIComponent(`${nm} mã số thuế`)}`, '_blank'); // mở ngay lúc bấm (không bị chặn pop-up)
      await call({ type: 'kv.set', key: 'mstPick', value: { status: 'pending', id, name: nm, at } });
      mpMstMsg[id] = '🔎 Chọn “📥 Lấy MST này” ở trang Google…';
      render();
      for (let i = 0; i < 450 && !v; i++) {
        await sleep(2000);
        const pk = await kvGet('mstPick').catch(() => null);
        if (!pk || pk.at !== at) break; // đã bắt đầu tìm cho công ty khác
        if (pk.status === 'done' && pk.id === id) {
          v = String(pk.mst || '').replace(/[^\d-]/g, '');
          pickName = String(pk.pickName || '').trim();
        }
      }
      if (!v) {
        delete mpMstMsg[id];
        return render();
      }
    }
    if (!/^\d{10}(-\d{3})?$/.test(v)) return alert('MST phải là 10 số (chi nhánh: 10 số-3 số).');
    // tên chuẩn: lấy ngay tên trên kết quả Google đã chọn (nếu là tên công ty) – thay tên chuẩn cũ (có thể sai) của công ty này
    const okName = /^(CÔNG TY|CHI NHÁNH|DOANH NGHIỆP|HỢP TÁC XÃ|CTY)\b/i.test(pickName) ? pickName.toUpperCase() : '';
    const legal = okName ? { legalName: okName, legalAddr: '' } : { legalName: '', legalAddr: '' };
    await mpSave({ [id]: { ...c, ...legal, mst: v, mstUrl: `https://masothue.com/Search/?q=${v}`, mstManual: true, mstSkip: false, mstAt: Date.now(), mstBy: meName || '' } });
    await mpMstFetch(id, v, okName);
  }
  // Xếp việc cho tab tra MST (masothue.com/#dgmst): lấy tên chuẩn, địa chỉ + TOÀN BỘ bảng thông tin thuế (mstInfo) của đúng MST v
  async function mpMstFetch(id, v, okName = '') {
    mpMstMsg[id] = '⏳ Đang lấy thông tin từ masothue…';
    render();
    const alive = await kvGet('mstAlive').catch(() => ({}));
    if (Date.now() - (alive?.at || 0) > 20e3) {
      mpMstMsg[id] = 'Đã lưu MST. Mở tab masothue.com/#dgmst để tự lấy tên chuẩn.';
      window.open('https://masothue.com/#dgmst', '_blank');
    }
    const jid = `${Date.now().toString(36)}-m${String(id).slice(-6)}`;
    const old = await kvGet('mstJobs').catch(() => ({}));
    const keep = Object.fromEntries(Object.entries(old || {}).filter(([, j]) => Date.now() - (j?.at || 0) < 6 * 3600e3));
    await call({ type: 'kv.set', key: 'mstJobs', value: { ...keep, [jid]: { q: v, at: Date.now(), status: 'pending', place: id, manual: true } } });
    for (let i = 0; i < 80; i++) {
      await sleep(1500);
      const j = (await kvGet('mstJobs').catch(() => ({})))?.[jid];
      if (j?.status === 'blocked') {
        mpMstMsg[id] = '⚠️ masothue cần xác minh – mở tab masothue để tự xác minh.';
        return render();
      }
      if (j?.status !== 'done') continue;
      // chỉ nhận kết quả đúng MST đã chọn (không lấy đại kết quả đầu – dễ ra công ty khác)
      const r = (j.list || []).find((x) => String(x.mst).replace(/\D/g, '') === v.replace(/\D/g, ''));
      if (r) {
        const cur = mpData.places[id];
        await mpSave({ [id]: { ...cur, legalName: r.name, legalAddr: r.addr || cur.legalAddr, mstUrl: r.href || cur.mstUrl, ...(r.info?.length ? { mstInfo: r.info, mstInfoAt: Date.now() } : {}) } });
        mpMstMsg[id] = `✅ ${r.name}${r.info?.length ? ` · ${r.info.length} dòng thông tin thuế` : ''}`;
      } else mpMstMsg[id] = okName ? `✅ ${okName} (tên theo kết quả Google – masothue không có đúng MST này)` : 'masothue không có kết quả đúng MST này.';
      return render();
    }
  }
  async function mpSave(patch) {
    for (const [id, v] of Object.entries(patch)) mpData.places[id] = v;
    mpIdbSave();
    await kvMerge('mapsPlaces', patch);
  }
  async function mpClick(e) {
    const t = e.target.closest?.('[data-mp]');
    if (!t || !root.querySelector('[data-mp-q]')) return;
    const k = t.dataset.mp;
    const id = t.dataset.id;
    const c = id ? mpData.places[id] : null;
    if (k === 'sel') return t.checked ? mpUi.sel.add(id) : mpUi.sel.delete(id);
    e.preventDefault();
    if (k === 'selall') {
      const ids = [...root.querySelectorAll('[data-mp="sel"]')].map((x) => x.dataset.id);
      const on = !ids.every((x) => mpUi.sel.has(x));
      ids.forEach((x) => (on ? mpUi.sel.add(x) : mpUi.sel.delete(x)));
    } else if ((k === 'del' || k === 'restore') && c) {
      // ẩn dòng NGAY, lưu (đồng bộ cloud) chạy ngầm – không vẽ lại cả bảng (giữ chỗ đang cuộn)
      const v = k === 'del' ? { ...c, hidden: true, hiddenAt: Date.now() } : { ...c, hidden: false };
      mpData.places[id] = v;
      mpUi.sel.delete(id);
      const row = t.closest('tr');
      if (row) {
        row.style.transition = 'opacity .15s';
        row.style.opacity = '0';
        setTimeout(() => row.remove(), 150);
      }
      mpIdbSave();
      kvMerge('mapsPlaces', { [id]: v }).catch((err) => {
        mpData.places[id] = c;
        mpIdbSave();
        alert(`Không lưu được: ${err.message || err}`);
        render();
      });
      return;
    }
    else if (k === 'bulk') {
      const hide = mpUi.show === 'on';
      if (hide && !confirm(`Xoá ${mpUi.sel.size} công ty khỏi danh sách? (Google Maps cũng ẩn, không quét lại – khôi phục được ở “Đã xoá”)`)) return;
      await mpSave(Object.fromEntries([...mpUi.sel].filter((x) => mpData.places[x]).map((x) => [x, { ...mpData.places[x], hidden: hide, ...(hide ? { hiddenAt: Date.now() } : {}) }])));
      mpUi.sel.clear();
    } else if (k === 'link') {
      mpUi.link = id;
      mpUi.lq = '';
    } else if (k === 'lclose') mpUi.link = null;
    else if (k === 'detail') {
      mpUi.detail = id;
      setTimeout(() => mpWatchPhotos(id), 800);
    }
    else if (k === 'dclose') mpUi.detail = null;
    else if (k === 'mstinfo' && c?.mst) {
      mpMstFetch(id, c.mst);
      return;
    }
    else if (k === 'areadraw' && c?.lat) {
      // ✏️ đo tay trên ảnh vệ tinh (script Google Maps mở bản đồ tới công ty, bấm các góc mái → m²)
      window.dispatchEvent(new CustomEvent('dg:areaDraw', { detail: { id, name: c.legalName || c.name, lat: c.lat, lng: c.lng } }));
      return;
    }
    else if (k === 'area' && c) {
      const cur = c.area > 0 ? String(c.area) : '';
      const v = prompt(`Diện tích nhà xưởng của ${c.legalName || c.name} (m²):\n(để trống = xoá số nhập tay, cho đo lại từ OpenStreetMap)`, cur);
      if (v == null) return;
      const n = Math.round(Number(String(v).replace(/[^\d]/g, '')));
      await mpSave({ [id]: n > 0 ? { ...c, area: n, areaSrc: 'tay', areaTry: Date.now() } : { ...c, area: null, areaSrc: '', areaTry: 0 } });
    }
    else if (k === 'pick') {
      const pc = mpData.places[mpUi.link];
      if (pc) await mpSave({ [mpUi.link]: { ...pc, erpId: t.dataset.cid, erpNo: false, erpLinkAt: Date.now(), erpLinkBy: meName || '' } });
      mpUi.link = null;
    } else if (k === 'unlink' && c) {
      if (!confirm('Bỏ kết nối công ty này với khách hàng ERP?')) return;
      await mpSave({ [id]: { ...c, erpId: null, erpNo: true, erpLinkAt: Date.now(), erpLinkBy: meName || '' } });
    } else if (k === 'prev') mpUi.page = Math.max(0, mpUi.page - 1);
    else if (k === 'next') mpUi.page++;
    else if (k === 'kcnbtn') {
      mpUi.kcnOpen = !mpUi.kcnOpen;
      mpUi.kq = '';
    } else if (k === 'kclose') mpUi.kcnOpen = false;
    else if (k === 'knone') {
      mpUi.kcns.clear();
      mpUi.page = 0;
    } else if (k === 'kall') {
      [...root.querySelectorAll('[data-mp-kcn]')].forEach((x) => mpUi.kcns.add(x.dataset.mpKcn));
      mpUi.page = 0;
    } else if (k === 'first') mpUi.page = 0;
    else if (k === 'last') mpUi.page = 1e9; // mapsTab tự kẹp về trang cuối
    else if (k === 'pg') mpUi.page = Number(t.dataset.p) || 0;
    else if (k === 'mst') {
      mpMstFix(id).catch((err) => alert(err.message || err));
      return;
    }
    else if (k === 'pdf') {
      // cùng bản in với Google Maps (scripts/shared/company-pdf.js); in đúng danh sách đang lọc
      const f = [mpUi.box === 'A' ? 'Tiềm năng thùng cao' : mpUi.box === 'B' ? 'Tiềm năng thùng vừa' : mpUi.box === 'AB' ? 'Tiềm năng thùng cao + vừa' : '', mpUi.erp === 'in' ? 'Đã có ERP' : mpUi.erp === 'out' ? 'Chưa có ERP' : '', mpUi.ind && mpUi.ind !== '—' ? mpUi.ind : mpUi.ind ? 'Chưa gắn ngành' : '', mpUi.kcns.size ? `${mpUi.kcns.size} KCN` : '', mpUi.q ? `tìm “${mpUi.q}”` : '', mpUi.show === 'off' ? 'Đã xoá' : ''].filter(Boolean);
      dgCompanyPdf({
        title: `Danh sách công ty – ${f.length ? f.join(' · ') : 'Tất cả'}`,
        rows: mpRows().map((c) => {
          const e = mpErp(c);
          return { name: e?.name || c.legalName || c.name, mst: c.mst, ind: c.ind, addr: c.legalAddr || c.addr, phone: c.phone, kcn: c.kcn || '', erp: e ? { id: e.id, code: e.code, staffName: e.staff?.name || '' } : null };
        }),
        erpHost: ERP,
      });
      return;
    }
    else if (k === 'reload') {
      t.disabled = true;
      t.textContent = '⏳ Đang tải từ cloud…';
      await mpLoad(true);
    }
    else return;
    mpPersist();
    render();
  }
  let mpQT = 0;
  function mpInput(e) {
    if (e.target.matches?.('[data-mp-q]')) {
      mpUi.q = e.target.value;
      mpUi.page = 0;
      mpPersist();
      clearTimeout(mpQT);
      // gõ xong 0,4 giây mới lọc lại (vẽ lại cả bảng) – giữ con trỏ trong ô tìm
      mpQT = setTimeout(async () => {
        e.target.blur(); // đang gõ trong ô có lớp gt-edit thì bảng không vẽ lại → bỏ chọn ô rồi vẽ, xong đặt lại con trỏ
        await render();
        const inp = root.querySelector('[data-mp-q]');
        if (inp) {
          inp.focus();
          inp.setSelectionRange(inp.value.length, inp.value.length);
        }
      }, 400);
    } else if (e.target.matches?.('[data-mp-kq]')) {
      // lọc danh sách KCN trong bảng chọn (không vẽ lại cả bảng)
      mpUi.kq = e.target.value;
      const q = mpUn(mpUi.kq);
      root.querySelectorAll('[data-mp-kpop] label').forEach((l) => (l.style.display = !q || mpUn(l.textContent).includes(q) ? '' : 'none'));
    } else if (e.target.matches?.('[data-mp-lq]')) {
      mpUi.lq = e.target.value;
      const box = root.querySelector('[data-mp-res]');
      if (box) box.innerHTML = mpLinkResults();
    }
  }
  function mpChange(e) {
    if (e.target.dataset?.mpKcn != null) {
      const k = e.target.dataset.mpKcn;
      e.target.checked ? mpUi.kcns.add(k) : mpUi.kcns.delete(k);
      mpUi.page = 0;
      mpPersist();
      return render();
    }
    const f = e.target.dataset?.mpF;
    if (!f) return;
    if (f === 'page') {
      mpUi.page = Number(e.target.value) || 0;
      mpPersist();
      return render();
    }
    mpUi[f] = e.target.value;
    mpUi.page = 0;
    mpPersist();
    mpUi.sel.clear();
    render();
  }
})();

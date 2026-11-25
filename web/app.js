// 🌐 Trang web "Danh sách công ty" (GitHub Pages) – xem danh sách công ty quét từ Google Maps (kv mapsPlaces trên Supabase).
// Đăng nhập bằng tài khoản admin cấp (supabase/web-users.sql). Người xem: CHỈ XEM (tìm / lọc / sắp xếp / In PDF / bấm SĐT mở Zalo).
// Admin: thêm tab 👥 Tài khoản (tạo / đổi quyền / đặt lại mật khẩu / xoá).
// Bộ lọc loại (BĐS, ngoài 7 tỉnh…) giống scripts/maps/maps-tab.js – sửa 1 nơi thì sửa cả nơi kia.
(() => {
  const CFG = window.DG_WEB || {};
  const ERP = CFG.erpHost || 'https://sale.tuantu.com.vn';
  const app = document.getElementById('app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const un = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  const key = (t) => String(t || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const isPhone = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const loginToEmail = (s) => {
    const v = String(s || '').trim().toLowerCase();
    return v.includes('@') ? v : `${v}@tuantu.local`;
  };
  const showLogin = (e) => String(e || '').replace(/@tuantu\.local$/, '');

  if (!CFG.supabaseUrl || !CFG.supabaseKey || !window.supabase) {
    app.innerHTML = `<div class="wrap"><div class="card login"><h1>⚙️ Chưa cấu hình</h1><div class="muted">${!window.supabase ? 'Không tải được thư viện Supabase (kiểm tra mạng).' : 'Điền supabaseUrl + supabaseKey trong file <code>web/config.js</code> trên GitHub.'}</div></div></div>`;
    return;
  }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'dgWebAuth' } });

  const S = { user: null, role: null, tab: 'list', data: null, loading: '', err: '' };
  const UI = { sort: 'name', q: '', erp: '', box: '', ind: '', page: 0, kcns: new Set(), kcnOpen: false, kq: '' };
  try {
    const v = JSON.parse(localStorage.getItem('dgWebUi') || 'null');
    if (v) Object.assign(UI, { sort: v.sort || 'name', q: v.q || '', erp: v.erp || '', box: v.box || '', ind: v.ind || '', page: Number(v.page) || 0, kcns: new Set(v.kcns || []) });
  } catch {}
  const persist = () => {
    try { localStorage.setItem('dgWebUi', JSON.stringify({ ...UI, kcns: [...UI.kcns], kcnOpen: false })); } catch {}
  };

  // ---------- đăng nhập ----------
  function loginView(msg = '') {
    app.innerHTML = `<div class="wrap"><form class="card login" id="lf">
<h1>📍 Danh sách công ty</h1><div class="muted">Công ty Cổ phần Bao bì Giấy Tuấn Tú – tài khoản do admin cấp.</div>
<label>Tên đăng nhập / email<input name="u" autocomplete="username" required autofocus></label>
<label>Mật khẩu<input name="p" type="password" autocomplete="current-password" required></label>
<div style="margin-top:14px"><button class="btn pri" style="width:100%;padding:8px">Đăng nhập</button></div>
<div class="err" id="le">${esc(msg)}</div></form></div>`;
    document.getElementById('lf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const btn = f.querySelector('button');
      btn.disabled = true;
      btn.textContent = '⏳ Đang đăng nhập…';
      const { error } = await sb.auth.signInWithPassword({ email: loginToEmail(f.u.value), password: f.p.value });
      if (error) {
        btn.disabled = false;
        btn.textContent = 'Đăng nhập';
        document.getElementById('le').textContent = /invalid/i.test(error.message) ? 'Sai tên đăng nhập hoặc mật khẩu.' : error.message;
        return;
      }
      start();
    });
  }

  async function start() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return loginView();
    S.user = data.session.user;
    const { data: role, error } = await sb.rpc('dg_web_role');
    if (error) return loginView(`Lỗi kiểm tra quyền: ${error.message} (đã chạy supabase/web-users.sql chưa?)`);
    if (!role) {
      await sb.auth.signOut();
      return loginView('Tài khoản này chưa được cấp quyền xem. Liên hệ admin.');
    }
    S.role = role;
    render();
    loadData(false);
  }

  // ---------- dữ liệu: lưu IndexedDB trên máy, mỗi lần mở chỉ kéo phần thay đổi (updated_at) ----------
  const idb = () => new Promise((ok, bad) => {
    const r = indexedDB.open('dgWeb', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
  const idbGet = async (k) => {
    const db = await idb();
    return new Promise((ok) => {
      const q = db.transaction('kv').objectStore('kv').get(k);
      q.onsuccess = () => ok(q.result || null);
      q.onerror = () => ok(null);
    });
  };
  const idbSet = async (k, v) => {
    const db = await idb();
    return new Promise((ok) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = ok;
      tx.onerror = ok;
    });
  };
  async function pull(ns, cur) {
    const out = cur?.items || {};
    let cursor = cur?.cursor || '1970-01-01T00:00:00Z';
    for (let page = 0; page < 200; page++) {
      const { data, error } = await sb.from('dg_items').select('id,data,updated_at').eq('ns', ns).gt('updated_at', cursor).order('updated_at', { ascending: true }).limit(1000);
      if (error) throw new Error(error.message);
      for (const r of data) out[r.id] = r.data;
      if (data.length) cursor = data[data.length - 1].updated_at;
      S.loading = `⏳ Đang tải ${ns === 'mapsPlaces' ? 'công ty' : 'khách ERP'}… ${Object.keys(out).length.toLocaleString('vi-VN')}`;
      render();
      if (data.length < 1000) break;
    }
    return { items: out, cursor };
  }
  async function loadData(full) {
    S.err = '';
    try {
      const me = S.user.email;
      let cache = full ? null : await idbGet('data').catch(() => null);
      if (cache && cache.user !== me) cache = null;
      if (cache && !S.data) index(cache); // hiện ngay bản trên máy trong lúc kéo phần mới
      const places = await pull('mapsPlaces', cache?.places);
      const custs = await pull('customersAll', cache?.custs);
      const raw = { user: me, at: Date.now(), places, custs };
      await idbSet('data', raw).catch(() => {});
      index(raw);
    } catch (e) {
      S.err = e.message || String(e);
    }
    S.loading = '';
    render();
  }
  function index(raw) {
    const byId = new Map();
    const byName = new Map();
    for (const c of Object.values(raw.custs?.items || {})) {
      if (!c?.id) continue;
      byId.set(String(c.id), c);
      const k = key(c.name);
      if (k) byName.set(k, c);
    }
    S.data = { at: raw.at, places: raw.places?.items || {}, byId, byName };
    home = null;
  }

  // ---------- bộ lọc (giống scripts/maps/maps-tab.js) ----------
  const PROV_ORDER = ['Bình Dương', 'TP.HCM', 'Đồng Nai', 'Long An', 'Bà Rịa – Vũng Tàu', 'Bình Phước', 'Tây Ninh', 'Khác'];
  const PROV_KW = [
    ['Bình Dương', /binh duong|vsip|my phuoc|bau bang|song than|dong an|tan uyen|ben cat|di an|thuan an|nam tan uyen|rach bap|kim huy|dai dang|viet huong|phu tan|ascendas|protrade|bac tan uyen|dat cuoc|an tay|tan dong hiep|binh an|mai trung|viet nam - singapore/],
    ['TP.HCM', /ho chi minh|hcm|cu chi|cat lai|tan thuan|hiep phuoc|tan binh|tan tao|vinh loc|le minh xuan|linh trung|cong nghe cao|binh chieu|tay bac cu chi|dong nam cu chi|phong phu|da phuoc|an ha/],
    ['Đồng Nai', /dong nai|bien hoa|nhon trach|long thanh|amata|loteco|ho nai|song may|tam phuoc|an phuoc|go dau|dinh quan|dau giay|xuan loc|long khanh|ong keo|bau xeo|tan phu|thanh phu|giang dien|long duc|loc an|agtex/],
    ['Long An', /long an|duc hoa|ben luc|can giuoc|can duoc|tan duc|hai son|xuyen a|thuan dao|phuc long|vinh loc 2|tan kim|long hau|cau tram|nam thuan|dong nam a|thinh phat|an nhut tan|thai hoa|tan do|loi binh nhon|dong ha|nam ha|trung thanh phat|tan my chanh/],
    ['Bà Rịa – Vũng Tàu', /vung tau|ba ria|phu my|cai mep|chau duc|dat do|my xuan|long son|dong xuyen|tan thanh/],
    ['Bình Phước', /binh phuoc|dong xoai|chon thanh|becamex binh phuoc|minh hung|bac dong phu|nam dong phu|tan khai|hon quan/],
    ['Tây Ninh', /tay ninh|cha la|trang bang|phuoc dong|thanh thanh cong|chau thanh|go dau tay ninh|linh trung 3|hoa thanh/],
  ];
  function provOf(name, lat, lng) {
    const u = un(name);
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
  const RE_BDS = /b[aấâ]t\s*đ[oộô]ng\s*s[aả]n|\bb[đd]s\b|đ[iị]a\s*[oố]c|real\s*estate|realt(y|or)|propert(y|ies)|\bland\b|nh[aà]\s*đ[aấ]t|môi giới nhà/i;
  const OUT7_RE = /\b(tien giang|dong thap|ben tre|tra vinh|soc trang|hau giang|bac lieu|ca mau|lam dong|ninh thuan|dak lak|dak nong|my tho|go cong|cai lay|cai be|sa dec|cao lanh|phan thiet|bao loc|long giang|tan my chanh|(?:tinh|thanh pho|tp\.?) (?:vinh long|can tho|an giang|kien giang|binh thuan|khanh hoa|gia lai|kon tum|phu yen|binh dinh|quang ngai|quang nam|da nang|ha noi|hai phong|da lat))\b/;
  const out7Why = (c) => {
    const m = un(`${c?.addr || ''} | ${c?.legalAddr || ''} | ${c?.kcn || ''} | ${c?.name || ''} | ${c?.legalName || ''}`).match(OUT7_RE);
    if (m) return `ngoài 7 tỉnh (${m[1]})`;
    const la = Number(c?.lat);
    const ln = Number(c?.lng);
    if (la && ln && (la < 10.3 || la > 12.35 || ln < 105.8 || ln > 107.65 || (la < 10.42 && ln < 106.8))) return 'ngoài 7 tỉnh (toạ độ)';
    return '';
  };
  function dropWhy(c) {
    if (c?.ind === 'Dịch vụ – tư vấn – phần mềm') return 'dịch vụ';
    if (out7Why(c)) return out7Why(c);
    if (c?.name && !un(c.name).replace(/\b(cong\s*ty|cty|tnhh|co\s*phan|cp|mtv|mot\s*thanh\s*vien|company|co|ltd|limited)\b/g, '').replace(/[^a-z0-9]/g, '')) return 'tên rỗng';
    const t = `${c?.name || ''} | ${c?.legalName || ''} | ${c?.cat || ''}`.normalize('NFC');
    const u = un(t);
    if (RE_BDS.test(t) || /dia[\s.\-_]*oc|bat[\s.\-_]*dong[\s.\-_]*san|\bbds\b|real\s*estate/.test(u)) return 'bđs';
    if (/xay\s*lap|xay\s*dung|construction/.test(u)) return 'xây dựng';
    if (/phat\s*trien\s*nha/.test(u)) return 'phát triển nhà';
    if (/bao\s*ve\b|security/.test(u)) return 'bảo vệ';
    return '';
  }
  const off = (c) => !!c.hidden || !!dropWhy(c);
  const erpOf = (c) => (c.erpNo ? null : (c.erpId && S.data.byId.get(String(c.erpId))) || S.data.byName.get(key(c.name)) || (c.legalName && S.data.byName.get(key(c.legalName))) || null);
  let home = null;
  const homeAt = () => {
    if (home) return home;
    const me = Object.values(S.data?.places || {}).find((c) => c?.lat && /tu[aấ]n\s*t[uú]/i.test(`${c.name} ${c.legalName || ''}`) && /48\/13|b[iì]nh ph[uư][oớ]c b/i.test(`${c.addr || ''} ${c.legalAddr || ''}`));
    return (home = me ? [me.lat, me.lng] : [10.9446, 106.7373]);
  };
  function dist(c) {
    if (!c?.lat || !c?.lng) return null;
    const [la, ln] = homeAt();
    const r = Math.PI / 180;
    const x = Math.sin(((c.lat - la) * r) / 2) ** 2 + Math.cos(la * r) * Math.cos(c.lat * r) * Math.sin(((c.lng - ln) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(x));
  }
  function rows() {
    const q = un(UI.q).trim();
    return Object.values(S.data.places).filter((c) => {
      if (!c?.name || off(c)) return false;
      const e = erpOf(c);
      if (UI.erp === 'in' && !e) return false;
      if (UI.erp === 'out' && e) return false;
      if (UI.box && !UI.box.includes(c.box || '-')) return false;
      if (UI.ind && (c.ind || '—') !== UI.ind) return false;
      if (UI.kcns.size && !UI.kcns.has(c.kcn || '')) return false;
      if (q && !un(`${c.name} ${c.legalName || ''} ${c.mst || ''} ${c.addr || ''} ${c.legalAddr || ''} ${c.phone || ''} ${c.kcn || ''} ${c.ind || ''} ${e?.name || ''} ${e?.code || ''}`).includes(q)) return false;
      return true;
    }).sort((a, b) => (UI.sort === 'near' ? (dist(a) ?? 1e9) - (dist(b) ?? 1e9) : 0) || (UI.sort === 'rate' ? (b.rateN || 0) - (a.rateN || 0) || (b.rate || 0) - (a.rate || 0) : 0) || (a.kcn || '~').localeCompare(b.kcn || '~', 'vi') || (a.legalName || a.name).localeCompare(b.legalName || b.name, 'vi'));
  }
  // SĐT: di động → mở Zalo (máy tính: app Zalo PC qua zalo://, điện thoại: zalo.me); số bàn → gọi
  function phoneHtml(p) {
    if (!p) return '';
    let d = String(p).replace(/\D/g, '');
    if (d.startsWith('84')) d = `0${d.slice(2)}`;
    const show = esc(String(p).trim().replace(/^\+?84[\s.-]*/, '0'));
    if (/^0[35789]\d{8}$/.test(d)) {
      const href = isPhone ? `https://zalo.me/${d}` : `zalo://conversation?phone=84${d.slice(1)}`;
      return `<a href="${href}" ${isPhone ? 'target="_blank" rel="noopener"' : ''} title="Di động – mở Zalo chat với ${d}" style="color:#15803d;font-weight:800;text-decoration:none;white-space:nowrap">📱 ${show} <span style="font-size:10.5px;color:#0068ff">Zalo ↗</span></a>${isPhone ? ` <a href="tel:${d}" title="Gọi" style="text-decoration:none">📞</a>` : ''}`;
    }
    return `<a href="tel:${d}" title="Số bàn – bấm để gọi" style="color:#64748b;text-decoration:none;white-space:nowrap">☎ ${show}</a>`;
  }

  // ---------- giao diện ----------
  function shell(inner) {
    return `<div class="top"><b>📍 Danh sách công ty – Tuấn Tú</b>
${S.role === 'admin' ? `<button data-a="tab" data-t="list" class="${S.tab === 'list' ? 'on' : ''}">📋 Công ty</button><button data-a="tab" data-t="users" class="${S.tab === 'users' ? 'on' : ''}">👥 Tài khoản</button>` : ''}
<span class="sp"></span><span style="font-size:12px;opacity:.9">👤 ${esc(S.user.user_metadata?.name || showLogin(S.user.email))}${S.role === 'admin' ? ' · admin' : ''}</span>
<button data-a="pw">🔑 Đổi mật khẩu</button><button data-a="out">Đăng xuất</button></div><div class="wrap">${inner}</div>`;
  }
  function render() {
    if (!S.user) return;
    const ae = document.activeElement;
    const focusQ = ae?.matches?.('[data-q]') ? ae.selectionStart : null;
    if (S.tab === 'users' && S.role === 'admin') {
      app.innerHTML = shell(usersHtml());
      return;
    }
    app.innerHTML = shell(listHtml());
    if (focusQ != null) {
      const i = app.querySelector('[data-q]');
      if (i) {
        i.focus();
        i.setSelectionRange(focusQ, focusQ);
      }
    }
  }
  function listHtml() {
    if (!S.data) return `<div class="card">${S.err ? `<div class="err">⚠️ ${esc(S.err)}</div>` : `<div class="muted">${esc(S.loading || '⏳ Đang tải dữ liệu…')}</div>`}</div>`;
    const list = rows();
    const PER = 100;
    const pages = Math.max(1, Math.ceil(list.length / PER));
    UI.page = Math.min(UI.page, pages - 1);
    const view = list.slice(UI.page * PER, UI.page * PER + PER);
    const all = Object.values(S.data.places).filter((c) => c?.name && !off(c));
    const inds = [...new Set(all.map((c) => c.ind || '—'))].sort((a, b) => a.localeCompare(b, 'vi'));
    const nErp = all.filter((c) => erpOf(c)).length;
    const s0 = UI.page * PER;
    const tr = view.map((c, i) => {
      const e = erpOf(c);
      const nm = (e?.name || c.legalName || c.name).toLocaleUpperCase('vi');
      const d = dist(c);
      return `<tr style="${e ? 'background:#f0fdf4' : ''}">
<td style="color:#94a3b8;text-align:right">${s0 + i + 1}</td>
<td style="min-width:220px;max-width:340px"><b>${esc(nm)}</b>${c.rate ? ` <span title="Google Maps: ${c.rate} sao · ${c.rateN || 0} lượt" style="color:#b45309;font-size:11.5px;font-weight:800;white-space:nowrap">⭐ ${String(c.rate).replace('.', ',')}${c.rateN ? ` <span style="color:#94a3b8;font-weight:600">(${Number(c.rateN).toLocaleString('vi-VN')})</span>` : ''}</span>` : ''}${(e?.name || c.legalName) && (e?.name || c.legalName) !== c.name ? `<div class="muted" style="font-size:11px">Google: ${esc(c.name)}</div>` : ''}</td>
<td style="white-space:nowrap">${c.mst ? `<a href="${esc(c.mstUrl || `https://masothue.com/Search/?q=${c.mst}`)}" target="_blank" rel="noopener" style="color:#7c3aed">${esc(c.mst)}</a>` : ''}</td>
<td style="font-size:12px">${esc(c.ind || '')}${c.box === 'A' || c.box === 'B' ? `<div title="${esc(c.boxWhy || '')}" style="font-size:11px;font-weight:800;color:${c.box === 'A' ? '#15803d' : '#b45309'}">📦 Thùng: ${c.box === 'A' ? 'cao' : 'vừa'}</div>` : ''}</td>
<td style="font-size:12px;color:#9a3412">${esc(c.kcn || '')}</td>
<td style="font-size:12px;min-width:200px;max-width:320px;color:#475569">${d != null ? `<b style="color:#0369a1;white-space:nowrap" title="Đường chim bay từ xưởng Tuấn Tú">📍 ${d.toFixed(1)} km</b> · ` : ''}${esc(c.legalAddr || c.addr || '')}</td>
<td style="font-size:12px">${e ? '<span style="color:#94a3b8">ẩn (khách ERP)</span>' : phoneHtml(c.phone)}</td>
<td style="white-space:nowrap">${e ? `<a href="${ERP}/khach-hang/view/${esc(e.id)}" target="_blank" rel="noopener" style="color:#15803d;font-weight:800">✅ ${esc(e.code || e.name)}</a>${e.staff?.name ? `<div class="muted" style="font-size:11px">NVKD ${esc(e.staff.name)}</div>` : ''}` : '<span class="muted">chưa có</span>'}</td>
<td>${c.href || c.url ? `<a href="${esc(c.href || c.url)}" target="_blank" rel="noopener" title="Mở trên Google Maps" style="text-decoration:none">🗺</a>` : ''}</td></tr>`;
    }).join('');
    const kcnPop = UI.kcnOpen ? (() => {
      const cnt = new Map();
      const sum = new Map();
      for (const c of all) {
        cnt.set(c.kcn || '', (cnt.get(c.kcn || '') || 0) + 1);
        if (!c.kcn || !c.lat) continue;
        const v = sum.get(c.kcn) || [0, 0, 0];
        v[0] += c.lat;
        v[1] += c.lng;
        v[2]++;
        sum.set(c.kcn, v);
      }
      const byP = new Map();
      for (const k of [...cnt.keys()].filter(Boolean)) {
        const v = sum.get(k);
        const pv = provOf(k, v ? v[0] / v[2] : null, v ? v[1] / v[2] : null);
        if (!byP.has(pv)) byP.set(pv, []);
        byP.get(pv).push(k);
      }
      const opt = (k, label) => `<label style="${UI.kcns.has(k) ? 'background:#fff7ed' : ''}"><input type="checkbox" data-kcn="${esc(k)}" ${UI.kcns.has(k) ? 'checked' : ''}><span style="flex:1">${esc(label)}</span><span style="color:#94a3b8">${cnt.get(k) || 0}</span></label>`;
      return `<div class="pop" data-kpop><input class="f" data-kq placeholder="Tìm KCN…" value="${esc(UI.kq)}" style="width:100%;margin-bottom:4px">
<div style="display:flex;gap:8px;margin:2px 0 4px"><a href="#" data-a="kall" style="font-size:12px">chọn hết</a><a href="#" data-a="knone" style="font-size:12px">bỏ chọn (tất cả)</a><span style="flex:1"></span><a href="#" data-a="kclose" style="font-size:12px;font-weight:800">Xong ✓</a></div>
${opt('', 'Ngoài KCN')}${PROV_ORDER.filter((p) => byP.has(p)).map((p) => `<div style="margin:6px 0 2px;padding:2px 6px;font-size:11.5px;font-weight:900;color:#1e3a8a;background:#eff6ff;border-radius:6px">📍 ${p} · ${byP.get(p).length} KCN</div>${byP.get(p).sort((a, b) => a.localeCompare(b, 'vi')).map((k) => opt(k, k)).join('')}`).join('')}</div>`;
    })() : '';
    const cur = UI.page;
    const nums = [...new Set([0, cur - 2, cur - 1, cur, cur + 1, cur + 2, pages - 1])].filter((x) => x >= 0 && x < pages).sort((a, b) => a - b);
    let pg = `<button class="btn" data-a="pg" data-p="${cur - 1}" ${cur === 0 ? 'disabled' : ''}>‹ Trước</button>`;
    let last = -1;
    for (const x of nums) {
      if (x - last > 1) pg += '<span class="muted">…</span>';
      pg += `<button class="btn ${x === cur ? 'pri' : ''}" data-a="pg" data-p="${x}">${x + 1}</button>`;
      last = x;
    }
    pg += `<button class="btn" data-a="pg" data-p="${cur + 1}" ${cur >= pages - 1 ? 'disabled' : ''}>Sau ›</button>`;
    return `<div class="card">
<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
<span class="muted"><b style="color:#0f172a">${all.length.toLocaleString('vi-VN')}</b> công ty · ✅ ${nErp.toLocaleString('vi-VN')} đã có trong ERP</span><span style="flex:1"></span>
<span class="muted" style="font-size:11.5px">${S.loading ? esc(S.loading) : `cập nhật ${new Date(S.data.at).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}`}</span>
<button class="btn" data-a="pdf" style="border-color:#93c5fd;background:#eff6ff;color:#1d4ed8">🖨 In PDF (${list.length.toLocaleString('vi-VN')})</button>
<button class="btn" data-a="reload" ${S.loading ? 'disabled' : ''}>⟳ Tải lại</button></div>
${S.err ? `<div class="err">⚠️ ${esc(S.err)}</div>` : ''}
<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px">
<input class="f" data-q placeholder="🔍 Tìm tên, MST, địa chỉ, SĐT, KCN, mã KH…" value="${esc(UI.q)}" style="min-width:240px;flex:1">
<select class="f" data-f="box" style="${UI.box ? 'border-color:#16a34a;background:#dcfce7;color:#166534;font-weight:700' : ''}"><option value="">📦 Tiềm năng thùng: tất cả</option><option value="A" ${UI.box === 'A' ? 'selected' : ''}>📦 Chỉ cao (${all.filter((c) => c.box === 'A').length})</option><option value="AB" ${UI.box === 'AB' ? 'selected' : ''}>📦 Cao + vừa (${all.filter((c) => c.box === 'A' || c.box === 'B').length})</option></select>
<select class="f" data-f="erp"><option value="">ERP: tất cả</option><option value="in" ${UI.erp === 'in' ? 'selected' : ''}>✅ Đã có ERP</option><option value="out" ${UI.erp === 'out' ? 'selected' : ''}>Chưa có ERP</option></select>
<select class="f" data-f="ind" style="max-width:220px"><option value="">Ngành: tất cả</option>${inds.map((x) => `<option value="${esc(x)}" ${UI.ind === x ? 'selected' : ''}>${x === '—' ? 'Chưa gắn ngành' : esc(x)}</option>`).join('')}</select>
<span style="position:relative"><button class="f" data-a="kcn" style="cursor:pointer;font-weight:700;${UI.kcns.size ? 'border-color:#f59e0b;background:#fff7ed;color:#9a3412' : ''}">🏭 KCN: ${UI.kcns.size ? `${UI.kcns.size} đã chọn` : 'tất cả'} ▾</button>${kcnPop}</span>
<select class="f" data-f="sort"><option value="name">↕ Theo KCN, tên</option><option value="near" ${UI.sort === 'near' ? 'selected' : ''}>📍 Gần → xa</option><option value="rate" ${UI.sort === 'rate' ? 'selected' : ''}>⭐ Nhiều đánh giá</option></select>
</div>
<div class="muted" style="margin-bottom:4px">${list.length.toLocaleString('vi-VN')} công ty khớp · trang ${cur + 1}/${pages}</div>
<div class="tbl"><table><thead><tr><th>STT</th><th>Tên công ty</th><th>MST</th><th>Ngành</th><th>KCN</th><th>Địa chỉ</th><th>SĐT</th><th>ERP</th><th></th></tr></thead>
<tbody>${tr || '<tr><td colspan="9" style="padding:14px;text-align:center;color:#94a3b8">Không có công ty nào.</td></tr>'}</tbody></table></div>
<div class="pg">${pg}</div></div>`;
  }

  // ---------- 👥 quản lý tài khoản (admin) ----------
  let users = null;
  let usersErr = '';
  async function loadUsers() {
    const { data, error } = await sb.rpc('dg_web_list');
    usersErr = error ? error.message : '';
    users = data || [];
    render();
  }
  function usersHtml() {
    if (!users) {
      loadUsers();
      return '<div class="card muted">⏳ Đang tải danh sách tài khoản…</div>';
    }
    const fmt = (t) => (t ? new Date(t).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
    return `<div class="card" style="margin-bottom:12px"><b style="font-size:15px">➕ Tạo tài khoản</b>
<form id="uf" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px">
<label class="muted">Tên đăng nhập (hoặc email)<br><input class="f" name="u" required placeholder="vd. thanh.kd" style="width:200px"></label>
<label class="muted">Họ tên<br><input class="f" name="n" placeholder="vd. Nguyễn Văn Thành" style="width:200px"></label>
<label class="muted">Mật khẩu (≥ 6 ký tự)<br><input class="f" name="p" required minlength="6" style="width:160px" value="${esc(genPw())}"></label>
<label class="muted">Quyền<br><select class="f" name="r"><option value="viewer">👁 Chỉ xem</option><option value="admin">🛡 Admin (xem + quản lý tài khoản)</option></select></label>
<button class="btn pri" style="padding:5px 14px">Tạo</button></form>
<div class="muted" style="margin-top:6px">Gửi cho người dùng: link trang này + tên đăng nhập + mật khẩu. Họ có thể tự đổi mật khẩu sau khi đăng nhập (🔑).</div>
<div id="um" style="margin-top:6px;font-weight:700"></div></div>
<div class="card"><b style="font-size:15px">👥 Tài khoản (${users.length})</b>${usersErr ? `<div class="err">⚠️ ${esc(usersErr)}</div>` : ''}
<div class="tbl" style="margin-top:8px"><table><thead><tr><th>Tên đăng nhập</th><th>Họ tên</th><th>Quyền</th><th>Tạo lúc</th><th>Đăng nhập gần nhất</th><th></th></tr></thead><tbody>
${users.map((u) => `<tr><td><b>${esc(showLogin(u.email))}</b></td><td>${esc(u.name || '')}</td>
<td><select class="f" data-role="${esc(u.email)}" ${u.email === S.user.email ? 'disabled' : ''}><option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>👁 Chỉ xem</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>🛡 Admin</option></select></td>
<td class="muted">${fmt(u.created_at)}${u.created_by ? `<br>bởi ${esc(showLogin(u.created_by))}` : ''}</td><td class="muted">${fmt(u.last_sign_in_at)}</td>
<td style="white-space:nowrap"><button class="btn" data-a="upw" data-e="${esc(u.email)}">🔑 Đặt lại mật khẩu</button> ${u.email === S.user.email ? '<span class="muted">(bạn)</span>' : `<button class="btn red" data-a="udel" data-e="${esc(u.email)}">🗑 Xoá</button>`}</td></tr>`).join('')}
</tbody></table></div></div>`;
  }
  function genPw() {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789';
    const r = crypto.getRandomValues(new Uint32Array(8));
    return Array.from(r, (x) => a[x % a.length]).join('');
  }

  // ---------- sự kiện ----------
  app.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-a]');
    if (!t) {
      if (UI.kcnOpen && !e.target.closest('[data-kpop]')) {
        UI.kcnOpen = false;
        render();
      }
      return;
    }
    const a = t.dataset.a;
    e.preventDefault();
    if (a === 'out') {
      await sb.auth.signOut();
      S.user = null;
      S.data = null;
      users = null;
      return loginView();
    }
    if (a === 'pw') {
      const p = prompt('Mật khẩu mới (≥ 6 ký tự):');
      if (!p) return;
      const { error } = await sb.auth.updateUser({ password: p });
      return alert(error ? `Không đổi được: ${error.message}` : '✅ Đã đổi mật khẩu.');
    }
    if (a === 'tab') {
      S.tab = t.dataset.t;
      if (S.tab === 'users') users = null;
      return render();
    }
    if (a === 'reload') return loadData(true);
    if (a === 'pg') UI.page = Math.max(0, Number(t.dataset.p) || 0);
    else if (a === 'kcn') {
      UI.kcnOpen = !UI.kcnOpen;
      UI.kq = '';
    } else if (a === 'kclose') UI.kcnOpen = false;
    else if (a === 'knone') {
      UI.kcns.clear();
      UI.page = 0;
    } else if (a === 'kall') {
      app.querySelectorAll('[data-kcn]').forEach((x) => x.closest('label').style.display !== 'none' && UI.kcns.add(x.dataset.kcn));
      UI.page = 0;
    } else if (a === 'pdf') {
      if (typeof dgCompanyPdf !== 'function') return alert('Chưa tải được phần In PDF – tải lại trang.');
      const f = [UI.box === 'A' ? 'Tiềm năng thùng cao' : UI.box === 'AB' ? 'Tiềm năng thùng cao + vừa' : '', UI.erp === 'in' ? 'Đã có ERP' : UI.erp === 'out' ? 'Chưa có ERP' : '', UI.ind && UI.ind !== '—' ? UI.ind : UI.ind ? 'Chưa gắn ngành' : '', UI.kcns.size ? `${UI.kcns.size} KCN` : '', UI.q ? `tìm “${UI.q}”` : ''].filter(Boolean);
      dgCompanyPdf({
        title: `Danh sách công ty – ${f.length ? f.join(' · ') : 'Tất cả'}`,
        rows: rows().map((c) => {
          const er = erpOf(c);
          return { name: er?.name || c.legalName || c.name, mst: c.mst, ind: c.ind, addr: c.legalAddr || c.addr, phone: c.phone, kcn: c.kcn || '', erp: er ? { id: er.id, code: er.code, staffName: er.staff?.name || '' } : null };
        }),
        erpHost: ERP,
      });
      return;
    } else if (a === 'upw') {
      const p = prompt(`Mật khẩu mới cho ${showLogin(t.dataset.e)} (≥ 6 ký tự):`, genPw());
      if (!p) return;
      const { error } = await sb.rpc('dg_web_set_password', { p_email: t.dataset.e, p_password: p });
      return alert(error ? `Lỗi: ${error.message}` : `✅ Đã đặt mật khẩu mới cho ${showLogin(t.dataset.e)}: ${p}`);
    } else if (a === 'udel') {
      if (!confirm(`Xoá tài khoản ${showLogin(t.dataset.e)}? Người này sẽ không đăng nhập được nữa.`)) return;
      const { error } = await sb.rpc('dg_web_remove', { p_email: t.dataset.e });
      if (error) alert(`Lỗi: ${error.message}`);
      return loadUsers();
    } else return;
    persist();
    render();
  });
  app.addEventListener('submit', async (e) => {
    if (e.target.id !== 'uf') return;
    e.preventDefault();
    const f = e.target;
    const m = document.getElementById('um');
    m.style.color = '#0f172a';
    m.textContent = '⏳ Đang tạo…';
    const pw = f.p.value;
    const { data, error } = await sb.rpc('dg_web_add', { p_login: f.u.value, p_password: pw, p_role: f.r.value, p_name: f.n.value.trim() || null });
    if (error) {
      m.style.color = '#b91c1c';
      m.textContent = `⚠️ ${error.message}`;
      return;
    }
    await loadUsers();
    const m2 = document.getElementById('um');
    m2.style.color = '#15803d';
    m2.textContent = `✅ Đã tạo – tên đăng nhập: ${showLogin(data)} · mật khẩu: ${pw}`;
  });
  let qT = 0;
  app.addEventListener('input', (e) => {
    if (e.target.matches('[data-q]')) {
      UI.q = e.target.value;
      UI.page = 0;
      clearTimeout(qT);
      qT = setTimeout(() => {
        persist();
        render();
      }, 300);
    } else if (e.target.matches('[data-kq]')) {
      UI.kq = e.target.value;
      const q = un(UI.kq);
      app.querySelectorAll('[data-kpop] label').forEach((l) => (l.style.display = !q || un(l.textContent).includes(q) ? '' : 'none'));
    }
  });
  app.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset.kcn != null) {
      el.checked ? UI.kcns.add(el.dataset.kcn) : UI.kcns.delete(el.dataset.kcn);
      UI.page = 0;
    } else if (el.dataset.f) {
      UI[el.dataset.f] = el.value;
      UI.page = 0;
    } else if (el.dataset.role) {
      const u = users?.find((x) => x.email === el.dataset.role);
      const { error } = await sb.rpc('dg_web_update', { p_email: el.dataset.role, p_role: el.value, p_name: u?.name || null });
      if (error) alert(`Lỗi: ${error.message}`);
      return loadUsers();
    } else return;
    persist();
    render();
  });
  sb.auth.onAuthStateChange((ev) => {
    if (ev === 'SIGNED_OUT' && S.user) {
      S.user = null;
      loginView('Phiên đăng nhập đã hết – đăng nhập lại.');
    }
  });
  start();
})();

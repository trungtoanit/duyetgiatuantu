// 🌐 Trang web "Danh sách công ty" (GitHub Pages /web/) – chạy NGUYÊN bảng 📋 Danh sách công ty của extension
// (scripts/maps/maps-tab.js) ngoài Google Maps: trang này giả lập phần "extension" (chrome.runtime.sendMessage)
// → đọc / ghi dữ liệu Supabase (dg_items) bằng tài khoản admin cấp. Bảng bên Google Maps thêm tính năng gì thì web có ngay.
// Đăng nhập + 👥 Tài khoản (admin) ở thanh trên cùng. Quyền: viewer chỉ xem · editor xem + sửa · admin + quản lý tài khoản.
(() => {
  const CFG = window.DG_WEB || {};
  const app = document.getElementById('app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const loginToEmail = (s) => {
    const v = String(s || '').trim().toLowerCase();
    return v.includes('@') ? v : `${v}@tuantu.local`;
  };
  const showLogin = (e) => String(e || '').replace(/@tuantu\.local$/, '');
  const ROLE_TXT = { viewer: '👁 Chỉ xem', editor: '✏️ Xem + sửa', admin: '🛡 Admin' };

  if (!CFG.supabaseUrl || !CFG.supabaseKey || !window.supabase) {
    app.innerHTML = `<div class="wrap"><div class="card login"><h1>⚙️ Chưa cấu hình</h1><div class="muted">${!window.supabase ? 'Không tải được thư viện Supabase (kiểm tra mạng).' : 'Điền supabaseUrl + supabaseKey trong file <code>web/config.js</code> trên GitHub.'}</div></div></div>`;
    return;
  }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'dgWebAuth' } });
  const S = { user: null, role: null, tab: 'list', view: 'all' };
  try { S.view = localStorage.getItem('dgWeb:view') || 'all'; } catch {}
  const canEdit = () => S.role === 'admin' || S.role === 'editor';
  const who = () => S.name || S.user?.user_metadata?.name || showLogin(S.user?.email);
  // 🕘 ghi nhật ký thao tác trình duyệt (thay đổi dữ liệu thì máy chủ tự ghi)
  const logAdd = (action, id = null, name = null, detail = null) => sb.rpc('dg_web_log_add', { p_action: action, p_target_id: id, p_target_name: name, p_detail: detail }).then(() => {}, () => {});
  const isPage = (v) => v === 'history' || v === 'log'; // trang riêng (ẩn bảng công ty)

  // ---------- đăng nhập ----------
  function loginView(msg = '') {
    document.getElementById('dg-maps-tab')?.style.setProperty('display', 'none');
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
      await start();
      logAdd('đăng nhập');
    });
  }
  async function start() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return loginView();
    S.user = data.session.user;
    const { data: role, error } = await sb.rpc('dg_web_role');
    if (error) return loginView(`Lỗi kiểm tra quyền: ${error.message}`);
    if (!role) {
      await sb.auth.signOut();
      return loginView('Tài khoản này chưa được cấp quyền xem. Liên hệ admin.');
    }
    S.role = role;
    if (role === 'admin') count60();
    else if (S.view === 'log') S.view = 'all';
    if (role === 'admin') sb.rpc('dg_web_list').then(({ data }) => { users = data || users; render(); }, () => {});
    const meInfo = (await sb.rpc('dg_web_me')).data || {};
    S.tenant = meInfo.tenant || (await sb.rpc('dg_web_tenant')).data || 'tuantu';
    S.name = meInfo.name || '';
    render();
    mountMapsTab();
  }

  // ---------- dữ liệu Supabase: lưu IndexedDB trên máy, mỗi lần chỉ kéo phần thay đổi (updated_at) ----------
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
  const store = {}; // ns → { items, cursor }
  const pulling = {};
  function pull(ns) {
    if (!pulling[ns]) pulling[ns] = doPull(ns).finally(() => delete pulling[ns]);
    return pulling[ns];
  }
  async function doPull(ns) {
    const k = `${ns}:${S.user.email}`;
    if (!store[ns]) store[ns] = (await idbGet(k).catch(() => null)) || { items: {}, cursor: '1970-01-01T00:00:00Z' };
    const st = store[ns];
    for (let page = 0; page < 200; page++) {
      const { data, error } = await sb.from('dg_items').select('id,data,updated_at').eq('ns', ns).gt('updated_at', st.cursor).order('updated_at', { ascending: true }).limit(1000);
      if (error) throw new Error(error.message);
      for (const r of data) st.items[r.id] = r.data;
      if (data.length) st.cursor = data[data.length - 1].updated_at;
      status(`⏳ Đang tải ${ns === 'mapsPlaces' ? 'công ty' : 'khách ERP'}… ${Object.keys(st.items).length.toLocaleString('vi-VN')}`);
      if (data.length < 1000) break;
    }
    status('');
    if (ns === 'mapsPlaces' && S.tab === 'list') {
      const side = document.querySelector('nav.side');
      if (side) side.outerHTML = sideHtml();
      setTimeout(decorate, 50);
    }
    idbSet(k, st).catch(() => {});
    return st.items;
  }
  let saveT = 0;
  async function savePlaces(patch) {
    if (!canEdit()) throw new Error('Tài khoản của bạn chỉ có quyền xem – không sửa được.');
    const rows = Object.entries(patch).filter(([, v]) => v != null).map(([id, data]) => ({ tenant: S.tenant, ns: 'mapsPlaces', id: String(id), data }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb.from('dg_items').upsert(rows.slice(i, i + 200), { onConflict: 'tenant,ns,id' }); // khoá chính (tenant, ns, id)
      if (error) throw new Error(`Không lưu được: ${error.message}`);
    }
    if (store.mapsPlaces) {
      Object.assign(store.mapsPlaces.items, patch);
      clearTimeout(saveT);
      saveT = setTimeout(() => idbSet(`mapsPlaces:${S.user.email}`, store.mapsPlaces).catch(() => {}), 1000);
    }
  }
  const lsGet = (k) => {
    try { return JSON.parse(localStorage.getItem(`dgWeb:${k}`) || 'null'); } catch { return null; }
  };
  const lsSet = (k, v) => {
    try { localStorage.setItem(`dgWeb:${k}`, JSON.stringify(v)); } catch {}
  };

  // ---------- giả lập extension cho maps-tab.js ----------
  // 🧾 Chuẩn hoá MST: trên web không có script chọn kết quả Google / tab masothue của extension
  // → mở Google như cũ rồi hỏi MST (+ tên chuẩn) bằng ô nhập, trả về đúng dạng extension trả.
  const mst = { pick: null, jobs: {} };
  function mstAsk(v) {
    setTimeout(() => {
      const m = (prompt(`🧾 MST của “${v.name}”\n(xem trên trang Google vừa mở – 10 số, chi nhánh: 10 số-3 số):`) || '').replace(/[^\d-]/g, '');
      if (!m) {
        mst.pick = { ...v, status: 'cancel', at: -1 };
        return;
      }
      const nm = prompt('Tên chuẩn của công ty (theo masothue / kết quả Google) – để trống nếu chưa biết:') || '';
      mst.pick = { ...v, status: 'done', mst: m, pickName: nm.trim() };
    }, 600);
  }
  const services = {
    'kv.get': async ({ key }) => {
      if (key === 'mapsPlaces') return viewOf(await pull(key));
      if (key === 'customersAll') return pull(key);
      if (key === 'me') return { name: who() };
      if (key === 'mstPick') return mst.pick;
      if (key === 'mstJobs') return mst.jobs;
      if (key === 'mstAlive') return { at: Date.now() };
      const v = lsGet(key) || {};
      // 📍 trang web: bảng mặc định sắp Gần → xa (1 lần cho mỗi người; đổi lại trong ô sắp xếp thì giữ lựa chọn đó)
      if (key === 'mapsTabUi') {
        const k = who().normalize('NFC').trim().toLowerCase() || 'me';
        if (!lsGet(`nearDefault:${k}`)) {
          v[k] = { ...(v[k] || {}), sort: 'near', page: 0 };
          lsSet(key, v);
          lsSet(`nearDefault:${k}`, 1);
        }
      }
      return v;
    },
    'kv.merge': async ({ key, patch }) => {
      if (key === 'mapsPlaces') return savePlaces(patch);
      if (key === 'customersAll') throw new Error('Trang web không sửa khách ERP.');
      lsSet(key, { ...(lsGet(key) || {}), ...patch });
    },
    'kv.set': async ({ key, value }) => {
      if (key === 'mstPick') {
        mst.pick = value;
        if (value?.status === 'pending') mstAsk(value);
        return;
      }
      if (key === 'mstJobs') {
        // không có tab masothue → trả ngay kết quả theo tên vừa nhập (nếu có)
        for (const [jid, j] of Object.entries(value || {})) {
          if (j?.status !== 'pending') continue;
          const nm = mst.pick?.status === 'done' && String(mst.pick.mst).replace(/\D/g, '') === String(j.q).replace(/\D/g, '') ? mst.pick.pickName : '';
          value[jid] = { ...j, status: 'done', list: nm ? [{ mst: j.q, name: nm.toUpperCase(), addr: '' }] : [] };
        }
        mst.jobs = value;
        return;
      }
      lsSet(key, value);
    },
    'sync.all': async () => {
      await Promise.all([pull('mapsPlaces'), pull('customersAll')]);
      return true;
    },
    // gọi HTTP (quét SĐT trên website công ty): trình duyệt chặn CORS phần lớn trang → coi như không đọc được
    http: async ({ url, method = 'GET', headers = {}, body }) => {
      try {
        const r = await fetch(url, { method, headers, body });
        return { status: r.status, ok: r.ok, text: await r.text() };
      } catch {
        return { status: 0, ok: false, text: '' };
      }
    },
  };
  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    lastError: null,
    sendMessage(msg, cb) {
      const f = services[msg?.type];
      Promise.resolve(f ? f(msg) : Promise.reject(new Error(`Trang web chưa hỗ trợ: ${msg?.type}`)))
        .then((result) => cb?.({ result }))
        .catch((e) => cb?.({ error: String(e.message || e) }));
    },
  };

  // ---------- 📞 Telesale: mỗi người nhận khách để gọi (c.tele = { by, byName, at, calls: [{ at, by, byName, note }] }) ----------
  // Thanh trái: Tất cả / Khách của tôi / Khách chưa gọi → trang web đưa cho bảng đúng phần công ty đó (bảng vẫn lọc / tìm như thường).
  const me = () => S.user?.email || '';
  const endToday = () => new Date(new Date().setHours(23, 59, 59, 999)).getTime();
  const VIEWS = [
    ['all', '📋 Tất cả', () => true],
    ['mine', '👤 Khách của tôi', (c) => c?.tele?.by === me()],
    ['uncalled', '📞 Khách chưa gọi', (c) => !c?.tele?.calls?.length && (!c?.tele?.by || c.tele.by === me())],
    ['callback', '⏰ Cần gọi lại', (c) => c?.tele?.by === me() && c.tele.next && c.tele.next <= endToday()],
  ];
  // Kết quả mỗi lần gọi
  const RESULTS = [
    ['noans', '📵 Không nghe máy', '#64748b'],
    ['busy', '⛔ Thuê bao / sai số', '#94a3b8'],
    ['callback', '⏰ Hẹn gọi lại', '#b45309'],
    ['interest', '👍 Quan tâm', '#15803d'],
    ['quote', '📄 Gửi báo giá', '#1d4ed8'],
    ['sample', '📦 Gửi mẫu / khảo sát', '#7c3aed'],
    ['win', '🎉 Chốt đơn', '#16a34a'],
    ['noneed', '👎 Không có nhu cầu', '#b91c1c'],
    ['hassup', '🏭 Đã có nhà cung cấp', '#9a3412'],
    ['other', '📝 Khác', '#475569'],
  ];
  const resOf = (k) => RESULTS.find((x) => x[0] === k) || null;
  const resTag = (k) => {
    const x = resOf(k);
    return x ? `<span style="display:inline-block;padding:0 6px;border-radius:6px;border:1px solid ${x[2]}55;background:${x[2]}14;color:${x[2]};font-weight:800;white-space:nowrap">${x[1]}</span>` : '';
  };
  function viewOf(items) {
    if (S.view.startsWith('by:')) {
      const em = S.view.slice(3);
      return Object.fromEntries(Object.entries(items).filter(([, c]) => c?.tele?.by === em));
    }
    const f = VIEWS.find((v) => v[0] === S.view)?.[2];
    if (!f || S.view === 'all') return items;
    return Object.fromEntries(Object.entries(items).filter(([, c]) => f(c)));
  }
  const fmtT = (t) => (t ? new Date(t).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '');
  // ⏱ thời gian đã qua: vừa xong · 5 phút trước · 2 giờ trước · hôm qua 14:30 · 3 ngày trước · 12/11 (rê chuột xem giờ đầy đủ; tự cập nhật mỗi phút)
  function agoText(t) {
    const ms = typeof t === 'number' ? t : Date.parse(t);
    if (!ms) return '';
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'vừa xong';
    if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
    const d0 = new Date().setHours(0, 0, 0, 0);
    const hm = new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    if (ms >= d0) return `${Math.floor(s / 3600)} giờ trước`;
    if (ms >= d0 - 864e5) return `hôm qua ${hm}`;
    const days = Math.ceil((d0 - ms) / 864e5);
    if (days <= 7) return `${days} ngày trước`;
    return new Date(ms).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }) + ` ${hm}`;
  }
  const ago = (t) => {
    const ms = typeof t === 'number' ? t : Date.parse(t);
    return ms ? `<span data-ago="${ms}" title="${esc(new Date(ms).toLocaleString('vi-VN'))}">${agoText(ms)}</span>` : '';
  };
  setInterval(() => {
    const roots = [document, document.getElementById('dg-maps-tab')?.shadowRoot].filter(Boolean);
    for (const rt of roots) for (const el of rt.querySelectorAll('[data-ago]')) el.textContent = agoText(Number(el.dataset.ago));
  }, 60e3);
  function teleHtml(c) {
    const t = c?.tele || {};
    const mine = t.by && t.by === me();
    const ed = !!S.role; // telesale: mọi tài khoản
    const b = 'cursor:pointer;border:1px solid #cbd5e1;background:#fff;border-radius:7px;padding:1px 7px;font:inherit;font-size:11.5px;font-weight:800;margin:2px 4px 0 0';
    const calls = t.calls || [];
    const last = calls[calls.length - 1];
    let h = '';
    if (!t.by) h += ed ? `<button data-tele="claim" data-id="${esc(c.id)}" style="${b};border-color:#93c5fd;background:#eff6ff;color:#1d4ed8">📞 Nhận gọi</button>` : '<span style="color:#94a3b8">chưa ai nhận</span>';
    else if (mine) h += `<span style="display:inline-block;padding:0 6px;border-radius:6px;background:#dbeafe;color:#1e40af;font-weight:900">👤 Khách của tôi</span> ${ed ? `<button data-tele="call" data-id="${esc(c.id)}" style="${b};border-color:#86efac;background:#f0fdf4;color:#166534">☎ Ghi cuộc gọi</button><button data-tele="drop" data-id="${esc(c.id)}" style="${b};color:#64748b">↩ Trả khách</button>` : ''}`;
    else h += `<span style="display:inline-block;padding:0 6px;border-radius:6px;background:#f1f5f9;color:#475569;font-weight:800">👤 ${esc(t.byName || showLogin(t.by))} đang gọi</span>${S.role === 'admin' ? ` <button data-tele="drop" data-id="${esc(c.id)}" style="${b};color:#b91c1c;border-color:#fecaca">↩ Thu hồi</button>` : ''}`;
    if (last) h += `<div data-tele="call" data-id="${esc(c.id)}" style="cursor:pointer;color:#475569;margin-top:2px" title="Xem lịch sử cuộc gọi">📜 ${calls.length} lần gọi · ${ago(last.at)} ${resTag(last.res)}${last.note ? ` <span style="color:#64748b">${esc(last.note.slice(0, 60))}</span>` : ''}${t.next && t.by ? ` <b style="color:${t.next <= endToday() ? '#b91c1c' : '#b45309'}">⏰ ${esc(fmtT(t.next))}</b>` : ''}</div>`;
    return `<div data-tele-box="${esc(c.id)}" style="margin-top:3px;font-size:11.5px;line-height:1.5">${h}</div>`;
  }
  // gắn ô telesale vào cột tên mỗi dòng của bảng (bảng vẽ lại thì gắn lại)
  let decoT = 0;
  function decorate(force = false) {
    const root = document.getElementById('dg-maps-tab')?.shadowRoot;
    const items = store.mapsPlaces?.items;
    if (!root || !items) return;
    // 📞 mục Telesale trong khung chi tiết công ty (cột trái, trước mục Hình ảnh)
    const dm = root.querySelector('[data-mp-modal] [data-mp="reviews"][data-id]');
    if (dm) {
      const id = dm.dataset.id;
      const old = root.querySelector('[data-cb-scope]');
      if (force || !old || old.dataset.cbScope !== id) {
        if (CB.id !== id) {
          CB.id = id;
          CB.res = '';
          CB.form = {};
          CB.msg = '';
        }
        const html = callPanelHtml(id);
        if (old) old.outerHTML = html;
        else {
          const ph = root.querySelector('[data-mp-modal] [data-mp-photos]')?.parentElement;
          if (ph) ph.insertAdjacentHTML('beforebegin', html);
        }
      }
    }
    for (const el of root.querySelectorAll('tr b[data-mp="detail"][data-id]')) {
      const td = el.closest('td');
      const c = items[el.dataset.id];
      if (!td || !c) continue;
      const html = teleHtml(c);
      const old = td.querySelector('[data-tele-box]');
      if (old?.outerHTML === html) continue;
      if (old) old.outerHTML = html;
      else td.insertAdjacentHTML('beforeend', html);
    }
  }
  function watchTable() {
    const host = document.getElementById('dg-maps-tab');
    const root = host?.shadowRoot;
    if (!root || root.__tele) return;
    root.__tele = 1;
    new MutationObserver(() => {
      clearTimeout(decoT);
      decoT = setTimeout(decorate, 30);
    }).observe(root, { childList: true, subtree: true });
    root.addEventListener('click', teleClick, true);
    root.addEventListener('input', cbInput, true);
    decorate();
  }
  // 📞 nhận / trả / ghi cuộc gọi: qua hàm dg_web_tele trên máy chủ (mọi tài khoản dùng được, kiểm tra người nhận trước)
  async function teleRpc(id, action, call = null) {
    const { data, error } = await sb.rpc('dg_web_tele', { p_id: String(id), p_action: action, p_name: who(), p_call: call });
    if (error) throw new Error(error.message);
    const items = store.mapsPlaces.items;
    // bảng đang giữ đúng object trong kho → cập nhật tại chỗ (bảng lưu lần sau không ghi đè mất phần telesale)
    if (items[id]) Object.assign(items[id], { tele: data?.tele });
    else items[id] = data;
    return data;
  }
  async function teleAct(k, id) {
    if (k === 'call') return openCall(id);
    const t = store.mapsPlaces.items[id]?.tele || {};
    if (k === 'drop' && !confirm(t.by === me() ? 'Trả khách này (người khác nhận gọi được)?' : `Thu hồi khách của ${t.byName || showLogin(t.by)}?`)) return;
    try {
      await teleRpc(id, k);
    } finally {
      if (CB.id === id) redrawCall();
      decorate();
      render();
    }
  }
  function setView(v) {
    const was = S.view;
    S.view = v;
    try { localStorage.setItem('dgWeb:view', v); } catch {}
    render();
    if (isPage(v)) {
      if (v === 'log') loadLog();
      return hideMaps();
    }
    mountMapsTab();
    // bảo bảng tải lại (đọc lại phần công ty của mục vừa chọn)
    if (was !== v) document.getElementById('dg-maps-tab')?.shadowRoot?.querySelector('[data-mp="reload"]')?.click();
  }

  // ---------- ☎ Telesale trong khung chi tiết công ty (bấm tên / ☎ Ghi cuộc gọi): nhận khách, ghi kết quả từng lần gọi, lịch sử ----------
  // Trang 📜 Lịch sử cuộc gọi (bảng công ty đang ẩn) thì mở cùng nội dung trong 1 khung riêng.
  const CB = { id: null, res: '', form: {}, box: false };
  function phonesOf(c) {
    const out = [];
    const add = (p) => {
      let d = String(p || '').replace(/\D/g, '');
      if (d.startsWith('84')) d = `0${d.slice(2)}`;
      if (d && !out.includes(d)) out.push(d);
    };
    add(c.phone);
    (c.webPhones || []).forEach((x) => add(x.p));
    return out;
  }
  const phoneLink = (d) => /^0[35789]\d{8}$/.test(d)
    ? `<a href="tel:${d}" style="font-weight:900;color:#15803d;text-decoration:none">📱 ${d}</a> <a href="${/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? `https://zalo.me/${d}" target="_blank` : `zalo://conversation?phone=84${d.slice(1)}`}" style="font-size:11px;color:#0068ff;font-weight:800">Zalo ↗</a>`
    : `<a href="tel:${d}" style="font-weight:800;color:#475569;text-decoration:none">☎ ${d}</a>`;
  // mở khung chi tiết của bảng (có mục 📞 Telesale) – bảng đang ẩn thì mở khung riêng
  function openCall(id, fresh) {
    const items = store.mapsPlaces.items;
    if (fresh && items[id]) Object.assign(items[id], { tele: fresh.tele });
    if (CB.id !== id) {
      CB.res = '';
      CB.form = {};
    }
    CB.id = id;
    const root = document.getElementById('dg-maps-tab')?.shadowRoot;
    const nameEl = !isPage(S.view) && root?.querySelector(`b[data-mp="detail"][data-id="${CSS.escape(id)}"]`);
    if (nameEl) {
      CB.box = false;
      nameEl.click();
      setTimeout(() => decorate(true), 80);
      return;
    }
    CB.box = true;
    drawBox();
  }
  const fieldStyle = 'font:inherit;font-size:12.5px;padding:5px 7px;border-radius:7px;border:1px solid #cbd5e1;background:#fff;width:100%;box-sizing:border-box';
  function callPanelHtml(id) {
    const c = store.mapsPlaces?.items[id];
    if (!c) return '';
    const t = c.tele || {};
    const calls = [...(t.calls || [])].reverse();
    const other = t.by && t.by !== me();
    const can = !!S.role && (!other || S.role === 'admin');
    const btn = 'cursor:pointer;border:1px solid #cbd5e1;background:#fff;border-radius:7px;padding:2px 8px;font:inherit;font-size:12px;font-weight:800';
    const f = CB.id === id ? CB.form : {};
    const res = CB.id === id ? CB.res : '';
    return `<div data-cb-scope="${esc(id)}" style="margin-top:12px;padding:10px;border:2px solid #bfdbfe;border-radius:10px;background:#f8fbff">
<div style="font-size:11px;font-weight:900;letter-spacing:.06em;color:#1d4ed8;text-transform:uppercase;margin-bottom:4px">📞 Telesale</div>
<div style="font-size:12.5px;margin-bottom:6px">${t.by ? `👤 ${other ? `<b>${esc(t.byName || showLogin(t.by))}</b> đang gọi khách này` : '<b style="color:#1e40af">Khách của tôi</b>'} <span style="color:#64748b">(nhận ${ago(t.at)})</span>` : '<span style="color:#64748b">Chưa ai nhận</span>'}
${!t.by && S.role ? ` <button data-tele="claim" data-id="${esc(id)}" style="${btn};border-color:#93c5fd;background:#eff6ff;color:#1d4ed8">📞 Nhận gọi</button>` : ''}${t.by && (t.by === me() || S.role === 'admin') ? ` <button data-tele="drop" data-id="${esc(id)}" style="${btn};color:#64748b">↩ ${t.by === me() ? 'Trả khách' : 'Thu hồi'}</button>` : ''}
${t.next && t.by ? `<div style="margin-top:3px;font-weight:800;color:${t.next <= endToday() ? '#b91c1c' : '#b45309'}">⏰ Hẹn gọi lại: ${esc(fmtT(t.next))}</div>` : ''}</div>
${can ? `<div style="font-weight:800;font-size:12.5px;margin-bottom:4px">Kết quả lần gọi này</div>
<div style="display:flex;flex-wrap:wrap;gap:5px">${RESULTS.map(([k, l, col]) => `<button data-cb="res" data-r="${k}" style="${btn};${res === k ? `background:${col};border-color:${col};color:#fff` : `color:${col};border-color:${col}66`}">${l}</button>`).join('')}</div>
<label style="display:block;margin-top:6px;font-size:12px;color:#64748b">Người nghe máy<input data-cbf="who" value="${esc(f.who || '')}" placeholder="vd. chị Lan – thu mua" style="${fieldStyle}"></label>
<label style="display:block;margin-top:6px;font-size:12px;color:#64748b">⏰ Hẹn gọi lại lúc${res === 'callback' ? ' <b style="color:#b91c1c">*</b>' : ''}<input data-cbf="next" type="datetime-local" value="${esc(f.next || '')}" style="${fieldStyle}"></label>
<label style="display:block;margin-top:6px;font-size:12px;color:#64748b">Ghi chú<textarea data-cbf="note" rows="3" placeholder="Nội dung trao đổi: nhu cầu thùng, số lượng, giá, hẹn gửi mẫu…" style="${fieldStyle}">${esc(f.note || '')}</textarea></label>
<div style="margin-top:6px;display:flex;gap:8px;align-items:center"><button data-cb="save" style="${btn};background:#2563eb;border-color:#2563eb;color:#fff;padding:5px 14px">💾 Lưu cuộc gọi</button><span data-cb-msg style="font-size:12px;color:#b91c1c">${esc(CB.id === id ? CB.msg || '' : '')}</span></div>
${!t.by ? '<div style="font-size:11px;color:#94a3b8;margin-top:3px">Lưu cuộc gọi là tự nhận khách này.</div>' : ''}` : `<div style="font-size:12px;color:#94a3b8">${other ? 'Khách của người khác – chỉ xem lịch sử.' : 'Tài khoản chỉ xem – không ghi cuộc gọi được.'}</div>`}
<div style="font-weight:900;font-size:12.5px;margin:10px 0 4px">📜 Lịch sử cuộc gọi (${calls.length})</div>
${calls.length ? calls.map((x) => `<div style="padding:5px 0;border-top:1px solid #e2e8f0;font-size:12px"><div><b>${ago(x.at)}</b> · ${esc(x.byName || showLogin(x.by))} ${resTag(x.res)}</div>${x.contact ? `<div style="color:#475569">👤 ${esc(x.contact)}</div>` : ''}${x.note ? `<div style="white-space:pre-wrap">${esc(x.note)}</div>` : ''}${x.next ? `<div style="color:#b45309">⏰ hẹn ${esc(fmtT(x.next))}</div>` : ''}</div>`).join('') : '<div style="font-size:12px;color:#94a3b8">Chưa gọi lần nào.</div>'}
</div>`;
  }
  // khung riêng (trang 📜 Lịch sử cuộc gọi)
  function drawBox() {
    let box = document.getElementById('dg-call');
    if (!CB.box || !CB.id) return box?.remove();
    const c = store.mapsPlaces.items[CB.id];
    if (!c) return;
    if (!box) {
      box = document.createElement('div');
      box.id = 'dg-call';
      document.body.append(box);
      box.addEventListener('click', (e) => {
        if (e.target.closest('[data-cbclose]')) {
          e.preventDefault();
          CB.box = false;
          CB.id = null;
          return drawBox();
        }
        teleClick(e);
      });
      box.addEventListener('input', cbInput);
    }
    box.innerHTML = `<div class="cb-bg" data-cbclose></div><div class="cb card">
<div style="display:flex;gap:8px;align-items:flex-start"><div style="flex:1"><b style="font-size:16px;color:#1e3a8a">${esc((c.legalName || c.name || '').toLocaleUpperCase('vi'))}</b>
<div class="muted">${esc(c.legalAddr || c.addr || '')}${c.kcn ? ` · 🏭 ${esc(c.kcn)}` : ''}${c.ind ? ` · ${esc(c.ind)}` : ''}</div>
<div style="margin-top:6px;display:flex;gap:12px;flex-wrap:wrap">${phonesOf(c).map(phoneLink).join('') || '<span class="muted">Chưa có SĐT</span>'}</div></div>
<a href="#" data-cbclose style="font-size:20px;text-decoration:none;color:#64748b;font-weight:900">✕</a></div>${callPanelHtml(CB.id)}</div>`;
  }
  // vẽ lại mục Telesale ở nơi đang mở (khung chi tiết của bảng hoặc khung riêng)
  function redrawCall() {
    if (CB.box) return drawBox();
    decorate(true);
  }
  function cbInput(e) {
    const k = e.target.dataset?.cbf;
    if (!k) return;
    const id = e.target.closest('[data-cb-scope]')?.dataset.cbScope;
    if (CB.id !== id) {
      CB.id = id;
      CB.res = '';
      CB.form = {};
    }
    CB.form[k] = e.target.value;
  }
  // bấm trong mục Telesale / ô telesale ở dòng bảng
  const seen = {};
  function teleClick(e) {
    // 🕘 nhật ký: xem chi tiết công ty (1 lần / 10 phút / công ty), in PDF, tải lại dữ liệu
    const mp = e.target.closest?.('[data-mp]');
    if (mp) {
      const k = mp.dataset.mp;
      const c = mp.dataset.id && store.mapsPlaces?.items[mp.dataset.id];
      if (k === 'detail' && c && Date.now() - (seen[c.id] || 0) > 6e5) {
        seen[c.id] = Date.now();
        logAdd('xem công ty', String(c.id), c.legalName || c.name);
      } else if (k === 'pdf') logAdd('in PDF', null, null, { title: (mp.textContent || '').trim() });
      else if (k === 'reload' && e.isTrusted) logAdd('tải lại dữ liệu');
    }
    const t = e.target.closest?.('[data-tele],[data-cb]');
    if (!t) return false;
    e.preventDefault();
    e.stopPropagation();
    if (t.dataset.tele) {
      teleAct(t.dataset.tele, t.dataset.id).catch((err) => alert(err.message || err));
      return true;
    }
    const id = t.closest('[data-cb-scope]')?.dataset.cbScope;
    if (!id) return true;
    if (CB.id !== id) {
      CB.id = id;
      CB.form = {};
    }
    if (t.dataset.cb === 'res') {
      CB.res = t.dataset.r;
      CB.msg = '';
      redrawCall();
    } else if (t.dataset.cb === 'save') saveCall(id, t);
    return true;
  }
  async function saveCall(id, btn) {
    const f = CB.form;
    const next = f.next ? new Date(f.next).getTime() : null;
    CB.msg = !CB.res ? '⚠️ Chọn kết quả cuộc gọi.' : CB.res === 'callback' && !next ? '⚠️ Chọn ngày giờ hẹn gọi lại.' : '';
    if (CB.msg) return redrawCall();
    btn.disabled = true;
    btn.textContent = '⏳ Đang lưu…';
    try {
      await teleRpc(id, 'call', { res: CB.res, contact: (f.who || '').trim(), note: (f.note || '').trim(), next });
      CB.res = '';
      CB.form = {};
      CB.msg = '';
      redrawCall();
      decorate();
      render();
    } catch (err) {
      CB.msg = `⚠️ ${err.message || err}`;
      redrawCall();
    }
  }

  // ---------- 📜 trang Lịch sử cuộc gọi (tất cả công ty) ----------
  const HS = { who: '', res: '', days: '7', q: '' };
  function historyHtml() {
    if (!store.mapsPlaces) return '<div class="card muted">⏳ Đang tải dữ liệu…</div>';
    const all = [];
    for (const c of Object.values(store.mapsPlaces.items)) for (const x of c?.tele?.calls || []) all.push({ c, x });
    const names = [...new Set(all.map((r) => r.x.byName || showLogin(r.x.by)))].sort((a, b) => a.localeCompare(b, 'vi'));
    const from = HS.days ? Date.now() - Number(HS.days) * 864e5 : 0;
    const un = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
    const q = un(HS.q);
    const rows = all.filter((r) => r.x.at >= from && (!HS.who || (HS.who === '__me' ? r.x.by === me() : (r.x.byName || showLogin(r.x.by)) === HS.who)) && (!HS.res || r.x.res === HS.res) && (!q || un(`${r.c.legalName || ''} ${r.c.name} ${r.x.note || ''} ${r.x.contact || ''}`).includes(q))).sort((a, b) => b.x.at - a.x.at);
    const cnt = {};
    for (const r of rows) cnt[r.x.res || ''] = (cnt[r.x.res || ''] || 0) + 1;
    return `<div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px"><b style="font-size:15px">📜 Lịch sử cuộc gọi</b><span class="muted">${rows.length.toLocaleString('vi-VN')} cuộc gọi</span><span style="flex:1"></span>
<input class="f" data-h="q" placeholder="🔍 Tìm công ty, ghi chú…" value="${esc(HS.q)}" style="min-width:200px">
<select class="f" data-h="days"><option value="1" ${HS.days === '1' ? 'selected' : ''}>Hôm nay</option><option value="7" ${HS.days === '7' ? 'selected' : ''}>7 ngày</option><option value="30" ${HS.days === '30' ? 'selected' : ''}>30 ngày</option><option value="" ${!HS.days ? 'selected' : ''}>Tất cả</option></select>
<select class="f" data-h="who"><option value="">Người gọi: tất cả</option><option value="__me" ${HS.who === '__me' ? 'selected' : ''}>Tôi</option>${names.map((n) => `<option ${HS.who === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
<select class="f" data-h="res"><option value="">Kết quả: tất cả</option>${RESULTS.map(([k, l]) => `<option value="${k}" ${HS.res === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${RESULTS.filter(([k]) => cnt[k]).map(([k]) => `${resTag(k)} <b>${cnt[k]}</b>`).join(' &nbsp; ')}</div>
<div class="tbl"><table><thead><tr><th>Thời gian</th><th>Người gọi</th><th>Công ty</th><th>Kết quả</th><th>Người nghe</th><th>Ghi chú</th><th>Hẹn lại</th></tr></thead><tbody>
${rows.slice(0, 500).map(({ c, x }) => `<tr><td style="white-space:nowrap">${ago(x.at)}</td><td>${esc(x.byName || showLogin(x.by))}</td><td><a href="#" data-a="hopen" data-id="${esc(c.id)}" style="font-weight:800">${esc((c.legalName || c.name).toLocaleUpperCase('vi'))}</a></td><td>${resTag(x.res)}</td><td>${esc(x.contact || '')}</td><td style="white-space:pre-wrap;max-width:420px">${esc(x.note || '')}</td><td style="white-space:nowrap">${x.next ? `⏰ ${esc(fmtT(x.next))}` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted" style="text-align:center;padding:14px">Chưa có cuộc gọi nào.</td></tr>'}
</tbody></table></div>${rows.length > 500 ? '<div class="muted">Hiện 500 cuộc gọi mới nhất – lọc thêm để xem cũ hơn.</div>' : ''}</div>`;
  }

  // hiện bảng thành trang danh sách (không phải popup): bỏ nền mờ, viền thẻ, thanh tiêu đề ✕ của bảng.
  // Gắn ngay lúc bảng tạo shadow DOM (adoptedStyleSheets không bị innerHTML của bảng xoá) → không chớp popup.
  const pageCss = new CSSStyleSheet();
  pageCss.replaceSync('.ov{position:absolute!important;inset:0!important;background:#f1f5f9!important;padding:0!important}.card{max-width:none!important;border-radius:0!important;box-shadow:none!important}.card>.top{display:none!important}');
  const attach0 = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) {
    const r = attach0.call(this, o);
    if (this.id === 'dg-maps-tab') r.adoptedStyleSheets = [...r.adoptedStyleSheets, pageCss];
    return r;
  };

  // nạp bảng của extension (đúng phiên bản scripts trên GitHub) rồi mở luôn
  let mapsLoaded = false;
  async function mountMapsTab() {
    if (S.tab !== 'list') return;
    if (isPage(S.view)) {
      pull('mapsPlaces').then(render).catch(() => {});
      if (S.view === 'log') loadLog();
      return hideMaps();
    }
    if (mapsLoaded) return showMaps();
    mapsLoaded = true;
    try { indexedDB.deleteDatabase('dgMapsTab'); } catch {} // bản lưu riêng của bảng → luôn đọc qua kho Supabase ở trên (có kéo phần mới)
    let v = Date.now();
    try { v = (await (await fetch('../scripts/manifest.json', { cache: 'no-store' })).json()).version || v; } catch {}
    await new Promise((ok) => {
      const s = document.createElement('script');
      s.src = `../scripts/maps/maps-tab.js?v=${encodeURIComponent(v)}`;
      s.onload = ok;
      s.onerror = () => {
        status('⚠️ Không tải được bảng công ty – tải lại trang.');
        ok();
      };
      document.body.append(s);
    });
    showMaps();
  }
  function showMaps(tries = 0) {
    const host = document.getElementById('dg-maps-tab');
    if (host) {
      host.style.display = '';
      watchTable();
      return;
    }
    // bảng chưa mở lần nào → bấm nút mở của bảng (nút này ẩn trên web; script gắn nút sau ≤ 1,5 giây)
    const b = document.getElementById('dg-maps-tab-btn');
    if (b) {
      b.click();
      return setTimeout(watchTable, 300);
    }
    if (tries < 30) setTimeout(() => showMaps(tries + 1), 200);
  }
  function hideMaps() {
    document.getElementById('dg-maps-tab')?.style.setProperty('display', 'none');
  }
  function status(t) {
    const el = document.getElementById('dg-status');
    if (el) el.textContent = t;
  }

  // ---------- thanh trên cùng + 👥 tài khoản ----------
  function render() {
    if (!S.user) return;
    app.innerHTML = `<div class="top"><b>📍 Danh sách công ty – Tuấn Tú</b>
<button data-a="tab" data-t="list" class="${S.tab === 'list' ? 'on' : ''}">📋 Công ty</button>${S.role === 'admin' ? `<button data-a="tab" data-t="users" class="${S.tab === 'users' ? 'on' : ''}">👥 Tài khoản</button>` : ''}
<span id="dg-status" style="font-size:12px;opacity:.85"></span><span class="sp"></span><span style="font-size:12px;opacity:.9">👤 ${esc(who())} · ${ROLE_TXT[S.role] || S.role}</span>
<button data-a="pw">🔑 Đổi mật khẩu</button><button data-a="out">Đăng xuất</button></div>
${S.tab === 'list' ? sideHtml() : ''}<div class="wrap${S.tab === 'list' ? ' wl' : ''}">${S.tab === 'list' && S.view === 'history' ? historyHtml() : S.tab === 'list' && S.view === 'log' ? logHtml() : S.tab === 'users' && S.role === 'admin' ? usersHtml() : '<div class="card muted" style="text-align:center;padding:30px">Bảng công ty đã đóng. <button class="btn pri" data-a="tab" data-t="list">📋 Mở danh sách công ty</button></div>'}</div>`;
  }
  function sideHtml() {
    const items = store.mapsPlaces?.items || {};
    const all = Object.values(items);
    return `<nav class="side">${VIEWS.map(([k, label, f]) => `<a href="#" data-a="view" data-v="${k}" class="${S.view === k ? 'on' : ''}">${label}<span>${store.mapsPlaces ? all.filter(f).length.toLocaleString('vi-VN') : ''}</span></a>`).join('')}
<a href="#" data-a="view" data-v="history" class="${S.view === 'history' ? 'on' : ''}">📜 Lịch sử cuộc gọi<span>${all.reduce((n, c) => n + (c?.tele?.calls?.length || 0), 0) || ''}</span></a>
${S.role === 'admin' ? `<a href="#" data-a="view" data-v="log" class="${S.view === 'log' ? 'on' : ''}" title="Số thao tác trong 60 phút gần nhất">🕘 Nhật ký<span>${LG.n60 != null ? `${LG.n60.toLocaleString('vi-VN')} / 60′` : ''}</span></a>` : ''}
${S.role === 'admin' ? staffHtml(all) : ''}
<div class="muted" style="padding:10px 12px;font-size:11.5px;line-height:1.5">📞 Bấm <b>Nhận gọi</b> ở dòng công ty để nhận khách telesale. Gọi xong bấm <b>☎ Ghi cuộc gọi</b>.</div></nav>`;
  }
  // 👥 (admin) mỗi nhân viên: khách đang giữ, gọi hôm nay, nhận mới hôm nay, quá hẹn – so với NGÀY LÀM VIỆC liền trước (bỏ Chủ nhật).
  // Bấm thẻ → bảng chỉ hiện khách của người đó.
  const DOW = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  function prevWorkday(t) {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    do d.setDate(d.getDate() - 1); while (d.getDay() === 0); // bỏ Chủ nhật
    return d.getTime();
  }
  const delta = (a, b) => {
    const d = a - b;
    if (!d) return '<span style="color:#94a3b8;font-weight:700">=</span>';
    return `<span style="color:${d > 0 ? '#16a34a' : '#dc2626'};font-weight:900">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;
  };
  function staffHtml(all) {
    if (!store.mapsPlaces) return '';
    const day0 = new Date().setHours(0, 0, 0, 0);
    const p0 = prevWorkday(day0);
    const p1 = p0 + 864e5;
    const pLabel = `${DOW[new Date(p0).getDay()]} ${new Date(p0).getDate()}/${new Date(p0).getMonth() + 1}`;
    const st = new Map();
    const get = (em, nm) => {
      if (!em) return { n: 0, today: 0, prev: 0, newT: 0, newP: 0, late: 0 };
      if (!st.has(em)) st.set(em, { em, nm: nm || showLogin(em), n: 0, today: 0, prev: 0, newT: 0, newP: 0, late: 0 });
      const o = st.get(em);
      if (nm && o.nm === showLogin(em)) o.nm = nm;
      return o;
    };
    for (const u of users || []) get(u.email, u.name);
    for (const c of all) {
      const t = c?.tele;
      if (!t) continue;
      if (t.by) {
        const o = get(t.by, t.byName);
        o.n++;
        if (t.next && t.next <= endToday()) o.late++;
        if (t.at >= day0) o.newT++;
        else if (t.at >= p0 && t.at < p1) o.newP++;
      }
      for (const x of t.calls || []) {
        const o = get(x.by, x.byName);
        if (x.at >= day0) o.today++;
        else if (x.at >= p0 && x.at < p1) o.prev++;
      }
    }
    const list = [...st.values()].sort((a, b) => b.today - a.today || b.n - a.n || a.nm.localeCompare(b.nm, 'vi'));
    const sum = list.reduce((s, o) => ({ n: s.n + o.n, today: s.today + o.today, prev: s.prev + o.prev, late: s.late + o.late }), { n: 0, today: 0, prev: 0, late: 0 });
    const COLORS = ['#2563eb', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#db2777', '#65a30d', '#ca8a04'];
    const ini = (nm) => (String(nm).trim().split(/\s+/).pop() || '?').charAt(0).toUpperCase();
    const card = (o, i) => {
      const on = S.view === `by:${o.em}`;
      return `<a href="#" data-a="view" data-v="by:${esc(o.em)}" class="stf${on ? ' on' : ''}" title="Bấm để xem các khách ${esc(o.nm)} đang giữ">
<div class="stf-h"><span class="stf-av" style="background:${COLORS[i % COLORS.length]}">${esc(ini(o.nm))}</span><span class="stf-nm">${esc(o.nm)}</span>${o.late ? `<span class="stf-late" title="Khách quá hẹn gọi lại">⏰${o.late}</span>` : ''}</div>
<div class="stf-g"><div><b>${o.n}</b><small>khách</small></div><div><b>${o.today}</b> ${delta(o.today, o.prev)}<small>gọi h.nay</small></div><div><b>${o.newT}</b> ${delta(o.newT, o.newP)}<small>nhận mới</small></div></div></a>`;
    };
    return `<div class="stf-box"><div class="stf-t">👥 Nhân viên</div>
<div class="stf-sum">📞 Hôm nay <b>${sum.today}</b> cuộc ${delta(sum.today, sum.prev)} <span>so với ${pLabel} (${sum.prev})</span><br>👤 Đang giữ <b>${sum.n}</b> khách${sum.late ? ` · <b style="color:#dc2626">⏰ ${sum.late} quá hẹn</b>` : ''}</div>
${list.map(card).join('') || '<div class="muted" style="padding:4px">Chưa có nhân viên.</div>'}</div>`;
  }
  // ---------- 🕘 Nhật ký hoạt động ----------
  const LG = { days: '1', who: '', action: '', rows: null, err: '', n60: null };
  // (admin) đếm thao tác trong 60 phút gần nhất – cập nhật mỗi phút
  async function count60() {
    if (S.role !== 'admin' || !S.user) return;
    const { data } = await sb.rpc('dg_web_log_list', { p_from: new Date(Date.now() - 36e5).toISOString(), p_email: null, p_action: null, p_limit: 2000 });
    if (!data) return;
    LG.n60 = data.length;
    const el = document.querySelector('nav.side a[data-v="log"] span');
    if (el) el.textContent = `${LG.n60.toLocaleString('vi-VN')} / 60′`;
  }
  setInterval(count60, 60e3);
  async function loadLog() {
    LG.rows = null;
    render();
    const from = LG.days ? new Date(Date.now() - Number(LG.days) * 864e5).toISOString() : null;
    const { data, error } = await sb.rpc('dg_web_log_list', { p_from: from, p_email: LG.who || null, p_action: LG.action || null, p_limit: 2000 });
    LG.err = error ? error.message : '';
    LG.rows = data || [];
    count60();
    render();
  }
  const LOG_ACTIONS = ['đăng nhập', 'đăng xuất', 'xem công ty', 'nhận khách', 'trả khách', 'thu hồi khách', 'ghi cuộc gọi', 'xoá công ty', 'khôi phục công ty', 'kết nối ERP', 'bỏ kết nối ERP', 'nhập MST', 'sửa diện tích', 'sửa công ty', 'in PDF', 'tải lại dữ liệu', 'tạo tài khoản', 'đổi quyền', 'đổi tên hiển thị', 'đặt lại mật khẩu', 'đổi mật khẩu', 'xoá tài khoản'];
  function logDetail(r) {
    const d = r.detail || {};
    if (r.action === 'ghi cuộc gọi') return `${resTag(d.res)}${d.contact ? ` 👤 ${esc(d.contact)}` : ''}${d.note ? ` · ${esc(d.note)}` : ''}${d.next ? ` · ⏰ ${esc(fmtT(d.next))}` : ''}`;
    if (r.action === 'thu hồi khách') return `của ${esc(d.cua || '')}`;
    if (r.action === 'nhập MST') return `${esc(d.cu || '—')} → <b>${esc(d.mst || '')}</b>`;
    if (r.action === 'sửa diện tích') return `${esc(d.cu ?? '—')} → <b>${esc(d.area ?? '')}</b> m²`;
    if (r.action === 'đổi quyền') return `${esc(ROLE_TXT[d.cu] || d.cu || '')} → <b>${esc(ROLE_TXT[d.moi] || d.moi || '')}</b>`;
    if (r.action === 'đổi tên hiển thị') return `${esc(d.cu || '—')} → <b>${esc(d.moi || '')}</b>`;
    if (r.action === 'sửa công ty') return `<span class="muted">${esc((d.fields || []).join(', '))}</span>`;
    if (r.action === 'tạo tài khoản') return esc(ROLE_TXT[d.role] || d.role || '');
    if (r.action === 'in PDF') return esc(d.title || '');
    return '';
  }
  function logHtml() {
    const sel = (k, opts) => `<select class="f" data-lg="${k}">${opts}</select>`;
    const rows = LG.rows;
    return `<div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px"><b style="font-size:15px">🕘 Nhật ký hoạt động</b>${LG.n60 != null ? `<span class="muted">· ${LG.n60} thao tác trong 60 phút gần nhất</span>` : ''}<span class="muted">${rows ? `${rows.length.toLocaleString('vi-VN')} thao tác` : '⏳ Đang tải…'}</span><span style="flex:1"></span>
${sel('days', [['1', 'Hôm nay'], ['7', '7 ngày'], ['30', '30 ngày'], ['', 'Tất cả']].map(([v, l]) => `<option value="${v}" ${LG.days === v ? 'selected' : ''}>${l}</option>`).join(''))}
${S.role === 'admin' ? sel('who', `<option value="">Người: tất cả</option>${(users || []).map((u) => `<option value="${esc(u.email)}" ${LG.who === u.email ? 'selected' : ''}>${esc(u.name || showLogin(u.email))}</option>`).join('')}`) : ''}
${sel('action', `<option value="">Thao tác: tất cả</option>${LOG_ACTIONS.map((a) => `<option ${LG.action === a ? 'selected' : ''}>${a}</option>`).join('')}`)}
<button class="btn" data-a="logreload">⟳</button></div>${LG.err ? `<div class="err">⚠️ ${esc(LG.err)}</div>` : ''}
<div class="tbl"><table><thead><tr><th>Thời gian</th><th>Người</th><th>Thao tác</th><th>Đối tượng</th><th>Chi tiết</th></tr></thead><tbody>
${(rows || []).map((r) => `<tr><td style="white-space:nowrap">${ago(r.at)}</td><td>${esc(r.name || showLogin(r.email))}</td><td style="white-space:nowrap;font-weight:800">${esc(r.action)}</td><td>${r.target_id && store.mapsPlaces?.items[r.target_id] ? `<a href="#" data-a="hopen" data-id="${esc(r.target_id)}" style="font-weight:700">${esc((r.target_name || '').toLocaleUpperCase('vi'))}</a>` : esc(r.target_name || (r.target_id ? showLogin(r.target_id) : ''))}</td><td>${logDetail(r)}</td></tr>`).join('') || (rows ? '<tr><td colspan="5" class="muted" style="text-align:center;padding:14px">Chưa có thao tác nào.</td></tr>' : '')}
</tbody></table></div></div>`;
  }
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
<label class="muted">Quyền<br><select class="f" name="r"><option value="editor">✏️ Xem + sửa (xoá, kết nối ERP, MST…)</option><option value="viewer">👁 Chỉ xem</option><option value="admin">🛡 Admin (sửa + quản lý tài khoản)</option></select></label>
<button class="btn pri" style="padding:5px 14px">Tạo</button></form>
<div class="muted" style="margin-top:6px">Gửi cho người dùng: link trang này + tên đăng nhập + mật khẩu. Họ có thể tự đổi mật khẩu sau khi đăng nhập (🔑).</div>
<div id="um" style="margin-top:6px;font-weight:700"></div></div>
<div class="card"><b style="font-size:15px">👥 Tài khoản (${users.length})</b>${usersErr ? `<div class="err">⚠️ ${esc(usersErr)}</div>` : ''}
<div class="tbl" style="margin-top:8px"><table><thead><tr><th>Tên đăng nhập</th><th>Họ tên</th><th>Quyền</th><th>Tạo lúc</th><th>Đăng nhập gần nhất</th><th></th></tr></thead><tbody>
${users.map((u) => `<tr><td><b>${esc(showLogin(u.email))}</b></td><td><input class="f" data-uname="${esc(u.email)}" value="${esc(u.name || '')}" placeholder="Nhập họ tên…" title="Tên hiển thị (người gọi, người nhận khách…) – sửa xong bấm ra ngoài / Enter là lưu" style="width:220px"></td>
<td><select class="f" data-role="${esc(u.email)}" ${u.email === S.user.email ? 'disabled' : ''}>${Object.entries(ROLE_TXT).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
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
    if (!t) return;
    e.preventDefault();
    const a = t.dataset.a;
    if (a === 'out') {
      await logAdd('đăng xuất');
      await sb.auth.signOut();
      S.user = null;
      users = null;
      return loginView();
    }
    if (a === 'pw') {
      const p = prompt('Mật khẩu mới (≥ 6 ký tự):');
      if (!p) return;
      const { error } = await sb.auth.updateUser({ password: p });
      if (!error) logAdd('đổi mật khẩu');
      return alert(error ? `Không đổi được: ${error.message}` : '✅ Đã đổi mật khẩu.');
    }
    if (a === 'tab') {
      S.tab = t.dataset.t;
      if (S.tab === 'users') {
        users = null;
        hideMaps();
      }
      render();
      if (S.tab === 'list') mountMapsTab();
      return;
    }
    if (a === 'view') return setView(t.dataset.v);
    if (a === 'logreload') return loadLog();
    if (a === 'hopen') return openCall(t.dataset.id);
    if (a === 'upw') {
      const p = prompt(`Mật khẩu mới cho ${showLogin(t.dataset.e)} (≥ 6 ký tự):`, genPw());
      if (!p) return;
      const { error } = await sb.rpc('dg_web_set_password', { p_email: t.dataset.e, p_password: p });
      return alert(error ? `Lỗi: ${error.message}` : `✅ Đã đặt mật khẩu mới cho ${showLogin(t.dataset.e)}: ${p}`);
    }
    if (a === 'udel') {
      if (!confirm(`Xoá tài khoản ${showLogin(t.dataset.e)}? Người này sẽ không đăng nhập được nữa.`)) return;
      const { error } = await sb.rpc('dg_web_remove', { p_email: t.dataset.e });
      if (error) alert(`Lỗi: ${error.message}`);
      return loadUsers();
    }
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
  app.addEventListener('input', (e) => {
    if (e.target.dataset.h !== 'q') return;
    HS.q = e.target.value;
    clearTimeout(HS.t);
    HS.t = setTimeout(() => {
      const pos = e.target.selectionStart;
      render();
      const i = app.querySelector('[data-h="q"]');
      i?.focus();
      i?.setSelectionRange(pos, pos);
    }, 300);
  });
  app.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset?.uname) e.target.blur();
  });
  app.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset.uname) {
      const u = users?.find((x) => x.email === el.dataset.uname);
      el.disabled = true;
      const { error } = await sb.rpc('dg_web_update', { p_email: el.dataset.uname, p_role: u?.role || 'viewer', p_name: el.value.trim() });
      if (error) alert(`Lỗi: ${error.message}`);
      if (el.dataset.uname === S.user.email) S.name = el.value.trim();
      return loadUsers();
    }
    if (el.dataset.lg) {
      LG[el.dataset.lg] = el.value;
      return loadLog();
    }
    if (el.dataset.h && el.dataset.h !== 'q') {
      HS[el.dataset.h] = el.value;
      return render();
    }
    if (!el.dataset.role) return;
    const u = users?.find((x) => x.email === el.dataset.role);
    const { error } = await sb.rpc('dg_web_update', { p_email: el.dataset.role, p_role: el.value, p_name: u?.name || null });
    if (error) alert(`Lỗi: ${error.message}`);
    loadUsers();
  });
  sb.auth.onAuthStateChange((ev) => {
    if (ev === 'SIGNED_OUT' && S.user) {
      S.user = null;
      loginView('Phiên đăng nhập đã hết – đăng nhập lại.');
    }
  });
  start();
})();

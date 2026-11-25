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
  const who = () => S.user?.user_metadata?.name || showLogin(S.user?.email);

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
      start();
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
    const rows = Object.entries(patch).filter(([, v]) => v != null).map(([id, data]) => ({ ns: 'mapsPlaces', id: String(id), data }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb.from('dg_items').upsert(rows.slice(i, i + 200), { onConflict: 'ns,id' });
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
      return lsGet(key) || {};
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
  const VIEWS = [
    ['all', '📋 Tất cả', () => true],
    ['mine', '👤 Khách của tôi', (c) => c?.tele?.by === me()],
    ['uncalled', '📞 Khách chưa gọi', (c) => !c?.tele?.calls?.length && (!c?.tele?.by || c.tele.by === me())],
  ];
  function viewOf(items) {
    const f = VIEWS.find((v) => v[0] === S.view)?.[2];
    if (!f || S.view === 'all') return items;
    return Object.fromEntries(Object.entries(items).filter(([, c]) => f(c)));
  }
  const fmtT = (t) => (t ? new Date(t).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '');
  function teleHtml(c) {
    const t = c?.tele || {};
    const mine = t.by && t.by === me();
    const ed = canEdit();
    const b = 'cursor:pointer;border:1px solid #cbd5e1;background:#fff;border-radius:7px;padding:1px 7px;font:inherit;font-size:11.5px;font-weight:800;margin:2px 4px 0 0';
    const calls = t.calls || [];
    const last = calls[calls.length - 1];
    let h = '';
    if (!t.by) h += ed ? `<button data-tele="claim" data-id="${esc(c.id)}" style="${b};border-color:#93c5fd;background:#eff6ff;color:#1d4ed8">📞 Nhận gọi</button>` : '<span style="color:#94a3b8">chưa ai nhận</span>';
    else if (mine) h += `<span style="display:inline-block;padding:0 6px;border-radius:6px;background:#dbeafe;color:#1e40af;font-weight:900">👤 Khách của tôi</span> ${ed ? `<button data-tele="call" data-id="${esc(c.id)}" style="${b};border-color:#86efac;background:#f0fdf4;color:#166534">☎ Ghi cuộc gọi</button><button data-tele="drop" data-id="${esc(c.id)}" style="${b};color:#64748b">↩ Trả khách</button>` : ''}`;
    else h += `<span style="display:inline-block;padding:0 6px;border-radius:6px;background:#f1f5f9;color:#475569;font-weight:800">👤 ${esc(t.byName || showLogin(t.by))} đang gọi</span>${S.role === 'admin' ? ` <button data-tele="drop" data-id="${esc(c.id)}" style="${b};color:#b91c1c;border-color:#fecaca">↩ Thu hồi</button>` : ''}`;
    if (last) h += `<div style="color:#475569;margin-top:2px" title="${esc(calls.map((x) => `${fmtT(x.at)} · ${x.byName || ''}: ${x.note || ''}`).join('\n'))}">📞 ${calls.length} lần · ${esc(fmtT(last.at))}${last.note ? ` · ${esc(last.note)}` : ''}</div>`;
    return `<div data-tele-box="${esc(c.id)}" style="margin-top:3px;font-size:11.5px;line-height:1.5">${h}</div>`;
  }
  // gắn ô telesale vào cột tên mỗi dòng của bảng (bảng vẽ lại thì gắn lại)
  let decoT = 0;
  function decorate() {
    const root = document.getElementById('dg-maps-tab')?.shadowRoot;
    const items = store.mapsPlaces?.items;
    if (!root || !items) return;
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
    root.addEventListener('click', (e) => {
      const t = e.target.closest?.('[data-tele]');
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      teleAct(t.dataset.tele, t.dataset.id).catch((err) => alert(err.message || err));
    });
    decorate();
  }
  async function teleAct(k, id) {
    const items = store.mapsPlaces.items;
    // đọc bản mới nhất trên máy chủ (người khác có thể vừa nhận khách này)
    const { data, error } = await sb.from('dg_items').select('data').eq('ns', 'mapsPlaces').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    const c = data?.data || items[id];
    if (!c) return;
    const t = c.tele || {};
    let tele = null;
    if (k === 'claim') {
      if (t.by && t.by !== me()) {
        Object.assign(items[id] || {}, { tele: t });
        decorate();
        throw new Error(`${t.byName || showLogin(t.by)} đã nhận khách này rồi.`);
      }
      tele = { ...t, by: me(), byName: who(), at: Date.now() };
    } else if (k === 'call') {
      const note = prompt(`☎ Kết quả cuộc gọi “${c.legalName || c.name}”:\n(vd. không nghe máy · hẹn gọi lại · gửi báo giá · không có nhu cầu…)`);
      if (note === null) return;
      tele = { ...t, by: t.by || me(), byName: t.byName || who(), calls: [...(t.calls || []), { at: Date.now(), by: me(), byName: who(), note: note.trim() }] };
    } else if (k === 'drop') {
      if (!confirm(t.by === me() ? 'Trả khách này (người khác nhận gọi được)?' : `Thu hồi khách của ${t.byName || showLogin(t.by)}?`)) return;
      tele = { ...t, by: null, byName: null, droppedAt: Date.now(), droppedBy: who() };
    } else return;
    const v = { ...c, tele };
    await savePlaces({ [id]: v });
    // bảng đang giữ đúng object trong kho → cập nhật tại chỗ để bảng / lần lưu sau của bảng không ghi đè mất
    if (items[id] && items[id] !== v) Object.assign(items[id], { tele });
    decorate();
    render();
  }
  function setView(v) {
    S.view = v;
    try { localStorage.setItem('dgWeb:view', v); } catch {}
    render();
    // bảo bảng tải lại (đọc lại phần công ty của mục vừa chọn)
    document.getElementById('dg-maps-tab')?.shadowRoot?.querySelector('[data-mp="reload"]')?.click();
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
${S.tab === 'list' ? sideHtml() : ''}<div class="wrap">${S.tab === 'users' && S.role === 'admin' ? usersHtml() : '<div class="card muted" style="text-align:center;padding:30px">Bảng công ty đã đóng. <button class="btn pri" data-a="tab" data-t="list">📋 Mở danh sách công ty</button></div>'}</div>`;
  }
  function sideHtml() {
    const items = store.mapsPlaces?.items || {};
    const all = Object.values(items);
    return `<nav class="side">${VIEWS.map(([k, label, f]) => `<a href="#" data-a="view" data-v="${k}" class="${S.view === k ? 'on' : ''}">${label}<span>${store.mapsPlaces ? all.filter(f).length.toLocaleString('vi-VN') : ''}</span></a>`).join('')}
<div class="muted" style="padding:10px 12px;font-size:11.5px;line-height:1.5">📞 Bấm <b>Nhận gọi</b> ở dòng công ty để nhận khách telesale. Gọi xong bấm <b>☎ Ghi cuộc gọi</b>.</div></nav>`;
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
${users.map((u) => `<tr><td><b>${esc(showLogin(u.email))}</b></td><td>${esc(u.name || '')}</td>
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
      await sb.auth.signOut();
      S.user = null;
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
      if (S.tab === 'users') {
        users = null;
        hideMaps();
      }
      render();
      if (S.tab === 'list') mountMapsTab();
      return;
    }
    if (a === 'view') return setView(t.dataset.v);
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
  app.addEventListener('change', async (e) => {
    const el = e.target;
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

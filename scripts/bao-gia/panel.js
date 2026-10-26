// Chạy trong world USER_SCRIPT (tách biệt với JS của trang).
// Nhận dữ liệu từ hook.js, lưu vào extension, hiển thị bảng đánh giá NVKD
// và nhờ Claude nhận xét dựa trên phần bình luận của báo giá.
(() => {
  if (window.__dgPanel) return;
  window.__dgPanel = true;

  // ---------- Kết nối với background của extension ----------
  const NEED_RELOAD =
    'Extension trên máy này chưa được cập nhật. Vào chrome://extensions, bấm nút tải lại (↻) của "Duyệt giá Tuấn Tú", rồi tải lại trang này.';
  // ---------- Nhiều domain: cùng phần mềm CRM, mỗi domain dữ liệu riêng ----------
  // Tuấn Tú giữ tên dữ liệu cũ; domain khác thêm tiền tố (vd. "dd.quotes") để không lẫn báo giá / khách giữa 2 CRM.
  const SITES = {
    tuantu: { key: 'tuantu', prefix: '', name: 'Tuấn Tú', org: 'CÔNG TY CỔ PHẦN BAO BÌ GIẤY TUẤN TÚ', watermark: 'TUAN TU PACKAGING', teamGroup: 'Sale Nội Bộ - Tuấn Tú', bossSign: true, excluded: ['Trần Đình Hùng', 'Nguyễn Trí Thức', 'Nguyễn Thăng Khôi', 'Đại Dương'] },
    daiduong: { key: 'daiduong', prefix: 'dd.', name: 'Đại Dương', org: 'CÔNG TY TNHH SẢN XUẤT XNK ĐẠI DƯƠNG', watermark: 'BAO BI DAI DUONG', teamGroup: '', bossSign: false, excluded: ['Tuấn Tú', 'Nguyễn Trí Thức'] },
  };
  const SITE = /(^|\.)baobidaiduong\.com$/i.test(location.hostname) ? SITES.daiduong : SITES.tuantu;
  const API_BASE = `${location.protocol}//${location.hostname}:8080`; // máy chủ API của CRM (cùng tên miền, cổng 8080)
  // Dữ liệu dùng chung mọi domain (việc gửi Zalo, máy, file cài đặt) → không thêm tiền tố
  const SHARED_NS = new Set(['zaloJobs', 'zaloAlive', 'zaloDebug', 'zaloNames', 'zaloSent', 'machine', 'files', 'badge', 'popupCards']);
  const siteNs = (k) => (SITE.prefix && k && !SHARED_NS.has(k) && !String(k).startsWith(SITE.prefix) ? SITE.prefix + k : k);
  const call = (msg0) => {
    const msg = { ...msg0 };
    if (/^kv\.(get|set|merge)$/.test(msg.type) && msg.key) msg.key = siteNs(msg.key);
    if (msg.type === 'remote.push' && msg.ns) msg.ns = siteNs(msg.ns);
    return rawCall(msg);
  };
  const rawCall = (msg) =>
    new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return reject(new Error(NEED_RELOAD));
      chrome.runtime.sendMessage(msg, (r) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else if (r?.error) reject(new Error(r.error));
        else if (r === undefined) reject(new Error(NEED_RELOAD)); // background cũ không trả lời
        else resolve(r.result);
      });
    });
  const kvGet = async (key) => (await call({ type: 'kv.get', key })) || {};
  const kvMerge = (key, patch) => call({ type: 'kv.merge', key, patch });

  // ---------- Tiện ích ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtTime = (sec) =>
    sec
      ? new Date(sec * 1000).toLocaleString('vi-VN', {
          timeZone: 'Asia/Ho_Chi_Minh',
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
  const money = (n) => (n ? `${Number(n).toLocaleString('vi-VN')}đ` : '');
  // Trang báo giá (/bao-gia/update/ID) hoặc trang cơ hội (/co-hoi/update/ID) – cùng ID
  const currentQuoteId = () => Number(location.pathname.match(/\/(?:co-hoi|bao-gia)\/update\/(\d+)/)?.[1]) || null;
  const definedOnly = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

  function mergeThreads(oldT = [], newT = []) {
    const m = new Map(oldT.map((t) => [t.id, t]));
    for (const t of newT) m.set(t.id, t);
    return [...m.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  // NVKD phụ trách: lấy từ báo giá, nếu thiếu thì lấy người tạo bình luận đầu tiên
  // (bỏ qua chính quản lý – người dùng extension – vì quản lý không phải NVKD)
  let meName = 'Nguyễn Trung Toán';
  const staffOf = (q, c) =>
    q?.staff?.name || c?.threads?.map((t) => t.staff?.name).find((n) => n && n !== meName) || '';

  // Tình trạng báo giá theo CRM
  // NVKD không theo dõi: báo giá của họ không vào danh sách hỏi lại, không thu thập ngầm, không tự gợi ý
  const EXCLUDED_STAFF = SITE.excluded;
  const norm = (n) => (n || '').normalize('NFC').trim().toLowerCase();
  // Khớp đúng tên, hoặc tên tài khoản kết thúc bằng tên đó (vd. tài khoản "… Đại Dương")
  const isExcluded = (name) => !!name && EXCLUDED_STAFF.some((x) => norm(x) === norm(name) || norm(name).endsWith(` ${norm(x)}`));

  const STATUS = {
    DRAFF: 'Bản thảo',
    PENDING_PRICE: 'Chờ xin giá',
    CONFIRMED: 'Đã xác nhận',
    SEND_2_CUSOMTER: 'Đã gửi',
    NEGOTIATE: 'Chờ lên đơn',
    APPROVE: 'Duyệt lên đơn',
    SUCCESS: 'Thành công',
    REJECT: 'Thất bại',
  };
  const statusLabel = (s) => STATUS[s] || s || '?';
  const CLOSED = new Set(['APPROVE', 'SUCCESS', 'REJECT']); // đã chốt, không cần hỏi lại
  const FOLLOW_UP_HOURS = 12;
  const MAX_FOLLOW_UP_DAYS = 30; // bình luận cũ hơn coi như báo giá đã nguội, không nhắc

  // Tài khoản quản lý (người dùng extension) – lấy từ CRM, mặc định là Nguyễn Trung Toán
  const MY_NAME_FALLBACK = 'Nguyễn Trung Toán';
  const myName = (me) => me?.name || MY_NAME_FALLBACK;

  // Gom các bình luận thật của quản lý để Claude học văn phong.
  // Ưu tiên những câu nói với cùng NVKD (để xưng hô cho đúng), sau đó là các câu gần nhất.
  function styleExamples(quotes, comments, me, nvkd, limit = 40) {
    const name = myName(me);
    const all = [];
    for (const c of Object.values(comments)) {
      const staff = staffOf(quotes[c.id], c);
      const walk = (t, parent) => {
        const text = (t.text || '').trim();
        if (t.staff?.name === name && text.length >= 3) {
          all.push({ text, at: t.createdAt, staff, parent: parent && { name: parent.staff?.name, text: (parent.text || '').trim() } });
        }
        (t.children || []).forEach((ch) => walk(ch, t));
      };
      (c.threads || []).forEach((t) => walk(t, null));
    }
    all.sort((a, b) => b.at - a.at);
    const same = all.filter((e) => nvkd && (e.staff === nvkd || e.parent?.name === nvkd)).slice(0, 15);
    const rest = all.filter((e) => !same.includes(e)).slice(0, limit - same.length);
    return { total: all.length, list: [...same, ...rest] };
  }

  function styleBlock(examples, name) {
    if (!examples.list.length) return '';
    const cut = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t);
    const lines = examples.list.map((e) =>
      e.parent?.text
        ? `- Trả lời ${e.parent.name || '?'} ("${cut(e.parent.text.replace(/\s+/g, ' '), 120)}"):\n  ${name}: "${e.text}"`
        : `- (báo giá của ${e.staff || '?'}) ${name}: "${e.text}"`,
    );
    return `VĂN PHONG CỦA ${name.toUpperCase()} – các bình luận THẬT đã viết trên CRM (học cách xưng hô với từng người, độ dài câu, từ ngữ, viết tắt, dấu câu, mức độ thân mật):\n${lines.join('\n')}`;
  }

  // Bình luận mới nhất (kể cả trả lời) của một báo giá
  function lastComment(c) {
    let last = null;
    const walk = (t) => {
      if (!last || t.createdAt > last.createdAt) last = t;
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    return last;
  }
  const hoursSince = (sec) => (Date.now() / 1000 - sec) / 3600;

  // Chế độ hỏi theo dõi của một báo giá:
  //  - 'hoiNhanh': chưa chốt, bình luận cuối đã quá 12 giờ (trong vòng 30 ngày) → hỏi giá ok chưa
  //  - 'chaoLai' : Thất bại, hoặc chưa chốt mà im lặng quá 30 ngày → chào lại khách, hỏi dự án khác
  // Chỉ tính báo giá đã biết tình trạng (CRM tải kèm bình luận cũ của báo giá khác cùng khách).
  // Đã lên đơn: CRM ghi dòng hệ thống "... lên đơn hàng ..." / "Mã đơn hàng Misa: ..."
  function hasOrder(q, c) {
    if (q?.hasOrder) return true;
    let found = false;
    const walk = (t) => {
      if (/lên đơn hàng|mã đơn hàng misa/i.test(t.text || '')) found = true;
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    return found;
  }

  function followMode(q, c) {
    const last = lastComment(c);
    if (!last || !q?.quoteStatus || hasOrder(q, c)) return null;
    if (q.quoteStatus === 'REJECT') return 'chaoLai';
    if (CLOSED.has(q.quoteStatus)) return null;
    const h = hoursSince(last.createdAt);
    if (h > MAX_FOLLOW_UP_DAYS * 24) return 'chaoLai';
    if (h >= FOLLOW_UP_HOURS) return 'hoiNhanh';
    return null;
  }

  function listByMode(quotes, comments, mode) {
    return Object.values(comments)
      .map((c) => ({ q: quotes[c.id], c, last: lastComment(c) }))
      .filter(({ q, c }) => followMode(q, c) === mode && !isExcluded(staffOf(q, c)))
      .sort((a, b) => (mode === 'chaoLai' ? b.last.createdAt - a.last.createdAt : a.last.createdAt - b.last.createdAt));
  }

  // Khoảng thời gian kiểu nói tự nhiên: "13 giờ", "26 ngày", "3 tháng"
  const humanDuration = (hours) => {
    if (hours < 24) return `${Math.max(1, Math.floor(hours))} giờ`;
    const d = hours / 24;
    if (d < 60) return `${Math.floor(d)} ngày`;
    return `${Math.round(d / 30)} tháng`;
  };

  // Danh sách "Cần chào lại" bỏ những khách đang có báo giá trong danh sách "Quá 12 giờ"
  // (khách đó đang được hỏi theo báo giá khác rồi)
  const custKey = (q) => (q?.customer?.id ? `id:${q.customer.id}` : q?.customer?.code ? `code:${q.customer.code}` : null);
  function staleList(quotes, comments, overdue = listByMode(quotes, comments, 'hoiNhanh')) {
    const active = new Set(overdue.map(({ q }) => custKey(q)).filter(Boolean));
    return listByMode(quotes, comments, 'chaoLai').filter(({ q }) => !active.has(custKey(q)));
  }

  // ---- Báo giá khả thi: chấm điểm khả năng chốt đơn từ các tín hiệu trong bình luận + dữ liệu CRM ----
  function feasibility(q, c, ordersMap) {
    const reasons = [];
    let score = 0;
    const add = (n, why) => {
      score += n;
      if (why) reasons.push(why);
    };
    if (bossOkInfo(q, c)) add(40, 'sếp cho lấy đơn');
    if (promiseInfo(q, c)) add(35, 'hứa lên đơn');
    if (targetPriceInfo(c)) add(30, 'khách cho giá');
    if (q.isReprint) add(25, 'tái bản');
    const os = orderSummary(ordersMap?.[q.customer?.id]);
    if (os?.year) add(os.year >= 5 ? 25 : 20, `khách quen (${os.year} đơn/12 tháng)`);
    const last = lastComment(c);
    const h = last ? hoursSince(last.createdAt) : null;
    if (h != null) h <= 7 * 24 ? add(15, 'mới trao đổi') : h <= 30 * 24 ? add(5) : add(-20, 'im lặng lâu');
    if (noPrice(q)) add(-10, 'chưa cho giá');
    else if (q.amount) add(10 + Math.min(10, Math.round(Math.log10(Math.max(1, q.amount / 1e6)) * 5)));
    if (highPriceInfo(c)) add(-15, 'chê giá cao');
    if (noDepositInfo(c)) add(-10, 'chưa cọc');
    if (cancelInfo(c)) add(-1000, 'khách hủy đơn');
    return { score, reasons };
  }
  // Bình luận có "hủy đơn / huỷ đơn (rồi)" → khách đã hủy, không gợi ý chốt nữa
  const CANCEL_RE = /(?<![\p{L}])h(ủy|uỷ|ủ|uy)\s*(cái\s*)?đơn/iu;
  function cancelInfo(c) {
    let hit = null;
    const walk = (t) => {
      if (CANCEL_RE.test((t.text || '').normalize('NFC')) && (!hit || t.createdAt > hit.createdAt)) hit = t;
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    return hit;
  }
  // Sắp xếp y như danh sách Báo giá trên ERP (vị trí ghi lại khi ERP tải danh sách); chưa có vị trí → cuối.
  // Có thể chuyển sang xếp theo điểm (lưu trong localStorage).
  const sortMode = () => {
    try {
      return localStorage.getItem('dgSort') || 'erp';
    } catch {
      return 'erp';
    }
  };
  const rankOf = (q) => (Number.isFinite(q?.erpRank) ? q.erpRank : 1e9);
  // ERP xếp danh sách Báo giá theo thời gian cập nhật mới nhất (updatedAt giảm dần) → xếp theo đúng trường đó,
  // không phụ thuộc vị trí ghi lại lúc thu thập (vị trí cũ bị lệch khi báo giá khác vừa được sửa)
  const tsOf = (v) => (v ? (v > 1e11 ? v / 1000 : v) : 0);
  const sortByErp = (a, b) =>
    sortMode() === 'erp' ? tsOf(b.q?.updatedAt) - tsOf(a.q?.updatedAt) || rankOf(a.q) - rankOf(b.q) : 0;

  function feasibleList(quotes, comments, ordersMap) {
    return Object.values(quotes)
      .filter(
        (q) =>
          q.id && q.quoteStatus && !CLOSED.has(q.quoteStatus) && !q.hasOrder && !hasOrder(q, comments[q.id]) && !/^\s*SO\s*\d+/i.test(q.name || '') &&
          !(q.customer?.id && ordersMap?.[q.customer.id]?.orders?.some((o) => o.quote === q.code)) &&
          !isExcluded(staffOf(q, comments[q.id])) && q.createdAt && hoursSince(q.createdAt) <= 90 * 24,
      )
      .map((q) => {
        const c = comments[q.id] || { id: q.id, code: q.code, threads: [] };
        return { q, c, last: lastComment(c), f: feasibility(q, c, ordersMap) };
      })
      .filter((x) => x.f.score >= 30)
      .sort((a, b) => b.f.score - a.f.score || (b.q.amount || 0) - (a.q.amount || 0))
      .sort(sortByErp);
  }

  // Báo giá chưa có bình luận nào (bộ thu thập đã mở xem mà không thấy luồng nào), chưa chốt, tạo đã hơn 1 ngày
  function noCommentList(quotes, comments, collected) {
    return Object.values(quotes)
      .filter(
        (q) =>
          q.id && collected[q.id] && !comments[q.id]?.threads?.length && q.quoteStatus && !CLOSED.has(q.quoteStatus) &&
          !q.hasOrder && !isExcluded(q.staff?.name) && q.createdAt && hoursSince(q.createdAt) >= 24,
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((q) => ({ q, c: { id: q.id, code: q.code, threads: [] }, last: null }));
  }

  const ago = (sec) => {
    const h = hoursSince(sec);
    if (h < 1) return h * 60 < 1 ? 'vừa xong' : `${Math.floor(h * 60)} phút trước`;
    return h >= 48 ? `${Math.floor(h / 24)} ngày trước` : `${Math.floor(h)} giờ trước`;
  };

  // ---------- Ghi nhận dữ liệu từ hook.js ----------
  let chain = Promise.resolve();
  document.addEventListener('dg:data', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch {
      return;
    }
    chain = chain.then(() => save(msg)).catch((err) => console.warn('[DG]', err));
  });

  // Phiên đăng nhập của người dùng hiện tại (hook.js báo theo mã trả về của API). Đăng xuất → ẩn dữ liệu, dừng quét.
  let loggedOut = /^\/login\b/.test(location.pathname);
  kvGet('auth')
    .then((a) => {
      // trạng thái "đăng xuất" lưu lại chỉ tin trong 5 phút (cũ hơn → chờ API của trang báo lại, tránh kẹt "Cần đăng nhập")
      if (a?.ok === false && Date.now() - a.at < 5 * 60e3) loggedOut = true;
      if (a?.ok === true && !/^\/login\b/.test(location.pathname)) loggedOut = false;
      render();
    })
    .catch(() => {});

  const OFF_VER = 5; // 4: đọc lại đủ dòng (thử lại khi thiếu) // 3: đọc thêm tổng Nguyên liệu + nhận bảng chiết giá 0đ // tăng khi đổi cách lưu bảng chiết giá Offset → các báo giá sẽ được đọc lại
  // Đọc lại khi: chưa có / đổi cách lưu / giá trị báo giá đổi so với lúc đọc chiết giá (sửa đơn giá rồi Cập nhật)
  const offsetStale = (m, q) =>
    !Object.keys(m?.products || {}).length ||
    m?.offVer !== OFF_VER ||
    (!!q?.amount && (!m?.amountAt || Math.abs(m.amountAt - q.amount) / q.amount > 0.005));
  async function save({ kind, data }) {
    if (kind === 'debtUrl') {
      const k = String(data.url).replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '').slice(0, 150) || 'x';
      await kvMerge('debtMeta', { [`url:${k}`]: { url: data.url, keys: data.keys, at: Date.now() } });
      return;
    }
    if (kind === 'debtRows') {
      // Công nợ (kv 'debt2'): cust:<id> = 1 khách (tổng nợ, quá hạn, chưa đến hạn…), list:<overdue|upcoming> = danh sách hiện tại,
      // inv:<id> = hoá đơn của khách, ov:<số ngày> = thu / dự kiến theo ngày
      const url = String(data.url || '');
      const now = Date.now();
      const patch = {};
      if (/\/debt\/customers\?/.test(url)) {
        const type = /overdueOnly=true/.test(url) ? 'overdue' : /notDueOnly=true/.test(url) ? 'upcoming' : 'all';
        const cur = await kvGet('debt2');
        for (const r of data.rows) if (r.customerId != null) patch[`cust:${r.customerId}`] = { ...(cur[`cust:${r.customerId}`] || {}), ...r, [`in_${type}`]: now, at: now };
        patch[`list:${type}`] = { ids: data.rows.map((r) => r.customerId).filter((x) => x != null), at: now };
      } else if (/\/debt\/customers\/(\d+)/.test(url)) {
        patch[`inv:${url.match(/\/debt\/customers\/(\d+)/)[1]}`] = { items: data.rows, at: now };
      } else if (/\/debt\/overview/.test(url)) {
        patch[`ov:${url.match(/days=(\d+)/)?.[1] || 'x'}`] = { rows: data.rows, at: now };
      } else return;
      await kvMerge('debt2', patch);
      return render();
    }
    if (kind === 'auth') {
      const was = loggedOut;
      loggedOut = !data.ok || /^\/login\b/.test(location.pathname);
      // khung ẩn (bộ thu thập) gặp 401 không có nghĩa trang chính bị đăng xuất → chỉ trang chính ghi trạng thái chung
      if (IS_TOP || data.ok) await call({ type: 'kv.set', key: 'auth', value: data }).catch(() => {});
      return was !== loggedOut || loggedOut ? render() : undefined;
    }
    if (kind === 'staffSigns') {
      // chỉ lưu đường dẫn ảnh (đồng bộ); ảnh dạng data (signImgs) do công cụ tools/sync_signs.py tải về vì máy chủ ảnh chặn CORS
      const cur = await kvGet('staffSigns');
      const patch = {};
      for (const s of data) if (cur[s.name]?.sign !== s.sign) patch[s.name] = { ...s, at: Date.now() };
      if (Object.keys(patch).length) await kvMerge('staffSigns', patch);
      return;
    }
    if (kind === 'me') {
      await call({ type: 'kv.set', key: 'me', value: data });
    } else if (kind === 'quotes') {
      const patch = {};
      const cur = await kvGet('quotes');
      for (const q of data) {
        const next = definedOnly(q);
        const old = cur[q.id];
        // Giữ NVKD phụ trách khách (cột Sale) nếu dữ liệu mới không có (vd. tab chạy bản cũ)
        if (old?.staffKey && old.staffKey !== 'staff' && (!next.staffKey || next.staffKey === 'staff')) {
          next.staff = old.staff;
          next.staffKey = old.staffKey;
        }
        // Giữ dấu "chưa có giá giấy tấm" (đọc từ trang chi tiết, danh sách không có)
        if (old?.noSheetAt) Object.assign(next, { noSheet: old.noSheet, noSheetN: old.noSheetN, noSheetAt: old.noSheetAt });
        // Đã lên đơn (thấy ở trang chi tiết) thì giữ – danh sách có thể không có trường mã đơn Misa
        if (old?.hasOrder && old.orderCode) Object.assign(next, { hasOrder: true, orderCode: old.orderCode });
        patch[q.id] = next;
      }
      await kvMerge('quotes', patch);
    } else if (kind === 'quote') {
      const cur = await kvGet('quotes');
      const old = cur[data.id] || {};
      const next = definedOnly(data);
      // Trang chi tiết có thể thiếu người phụ trách khách → giữ NVKD (cột Sale) đã có từ danh sách
      if (next.staffKey === 'staff' && old.staffKey && old.staffKey !== 'staff') {
        next.staff = old.staff;
        next.staffKey = old.staffKey;
      }
      if (old.hasOrder && old.orderCode) Object.assign(next, { hasOrder: true, orderCode: old.orderCode });
      await kvMerge('quotes', { [data.id]: { ...old, ...next } });
    } else if (kind === 'margin') {
      const all = await kvGet('margins');
      const cur = all[data.code] || { products: {} };
      // Khoá theo quy cách + SL + giá: 2 mã cùng quy cách (khác số lượng) không ghi đè nhau.
      // Bản lưu cũ (khoá chỉ theo quy cách, offVer < 2) → bỏ, đọc lại từ đầu.
      if (cur.offVer !== OFF_VER) Object.assign(cur, { products: {}, offVer: OFF_VER }); // giữ cur.order (thứ tự sản phẩm)
      const spec = data.spec || 'sản phẩm';
      // Cùng quy cách + SL đọc lại (vd. đổi giá / về 0đ) → thay bản cũ, không giữ song song giá cũ
      for (const [k, v] of Object.entries(cur.products)) if (v.spec === spec && String(v.qty) === String(data.qty)) delete cur.products[k]; // gồm cả bản thử (draft)
      cur.products[[spec, data.qty, data.price].filter(Boolean).join(' | ')] = {
        spec, pct: data.pct, noPrice: !!data.noPrice, nvlUnit: data.nvlUnit ?? null, nvlTotal: data.nvlTotal ?? null, costUnit: data.costUnit ?? null,
        price: data.price, qty: data.qty, reprint: data.reprint, at: data.at,
      };
      cur.at = data.at;
      await kvMerge('margins', { [data.code]: cur });
    } else if (kind === 'ordersAll') {
      // Trang Đơn hàng Misa: gộp đơn vào lịch sử từng khách (không đổi tổng số đơn / thời điểm đọc trang khách)
      const cur = await kvGet('orders');
      const patch = {};
      // Đơn đã có trong lịch sử của khách CRM (mã số) → dùng đúng khách đó, không tạo khách trùng
      const ownerOf = new Map();
      for (const [cid, od] of Object.entries(cur)) if (/^\d+$/.test(cid)) for (const o of od?.orders || []) ownerOf.set(o.id, cid);
      for (const g of data) {
        const known = g.orders.map((o) => ownerOf.get(o.id)).find(Boolean);
        if (known) g.customerId = known;
        else if (!/^\d+$/.test(String(g.customerId))) g.customerId = `misa:${g.customerId}`;
        const old = patch[g.customerId] || cur[g.customerId] || { customerId: g.customerId, orders: [], at: 0 };
        const byId = new Map((old.orders || []).map((o) => [o.id, o]));
        let changed = false;
        for (const o of g.orders) {
          const prev = byId.get(o.id);
          if (!prev || prev.total !== o.total || prev.status !== o.status) changed = true;
          byId.set(o.id, { ...prev, ...o });
        }
        const customer = { ...(old.customer || {}), ...Object.fromEntries(Object.entries(g.customer || {}).filter(([, v]) => v)) };
        if (!changed && JSON.stringify(customer) === JSON.stringify(old.customer || {})) continue;
        patch[g.customerId] = { ...old, customer, orders: [...byId.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 600) };
      }
      if (!Object.keys(patch).length) return; // không có gì mới → không vẽ lại bảng
      await kvMerge('orders', patch);
    } else if (kind === 'orders') {
      // Gộp theo mã đơn với các trang đã đọc trước (trang 2, 3… của lịch sử mua hàng), mới nhất trước
      const old = (await kvGet('orders'))[data.customerId];
      const byId = new Map((old?.orders || []).map((o) => [o.id, o]));
      for (const o of data.orders || []) byId.set(o.id, o);
      const all = [...byId.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 600);
      await kvMerge('orders', { [data.customerId]: { ...old, ...data, orders: all, at: Math.floor(Date.now() / 1000) } });
    } else if (kind === 'notifs') {
      // Thông báo là của từng tài khoản CRM → khoá theo người đang đăng nhập
      const me = await kvGet('me');
      const who = me?.id ?? meName;
      const cur = await kvGet('notifs');
      const marks = await kvGet('notifRead'); // dấu đã đọc từ mọi máy (chỉ thêm, không bao giờ xoá)
      const patch = {};
      for (const n of data) {
        const key = `${who}:${n.id}`;
        const old = cur[key] || {};
        const readHere = old.readLocal || !!marks[key];
        // Không đổi gì thì không ghi (tránh đẩy bản "chưa đọc" đè lên máy khác)
        if (old.id && old.read === (readHere ? true : n.read) && old.text === n.text) continue;
        // Đã bấm đọc trong bảng (ở máy này hay máy khác) thì giữ là đã đọc dù CRM vẫn báo chưa đọc
        patch[key] = { ...old, ...n, read: readHere ? true : n.read, readLocal: readHere || undefined, at: toSec(n.at), owner: who, ownerName: me?.name || meName, seenAt: Math.floor(Date.now() / 1000) };
      }
      if (Object.keys(patch).length) await kvMerge('notifs', patch);
    } else if (kind === 'notifReadDone') {
      const me = await kvGet('me');
      const key = `${me?.id ?? meName}:${data.id}`;
      const n = (await kvGet('notifs'))[key];
      if (n) await kvMerge('notifs', { [key]: { ...n, crmRead: !!data.ok, crmStatus: data.status, crmAt: Math.floor(Date.now() / 1000) } });
    } else if (kind === 'handovers') {
      await saveHandovers(data);
    } else if (kind === 'comments') {
      const cur = await kvGet('comments');
      const patch = {};
      for (const c of data) {
        patch[c.id] = { id: c.id, code: c.code, customerId: c.customerId ?? cur[c.id]?.customerId, threads: mergeThreads(cur[c.id]?.threads, c.threads) };
      }
      await kvMerge('comments', patch);
    }
    render();
  }

  // ---------- Bàn giao khách hàng ----------
  // Thông báo "A đã bàn giao khách hàng X cho nhân viên B" → soạn sẵn 1 bình luận MỚI (không trả lời luồng cũ)
  // trên báo giá gần nhất của khách X; quản lý xem lại rồi tự bấm gửi.
  const HANDOVER_RE = /(\S.*?)\s+đã bàn giao khách hàng\s+(.+?)\s+cho nhân viên\s+(.+?)\s*$/;
  const HANDOVER_DAYS = 14; // bỏ qua thông báo cũ hơn
  const normName = (t) => String(t || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  const toSec = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : v;
    if (/^\d+$/.test(v)) return toSec(Number(v));
    const vn = String(v).match(/(\d{1,2}):(\d{2}),?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/) || String(v).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
    if (vn) {
      const [h, mi, d, mo, y] = vn[0].includes(',') || /^\d{1,2}:/.test(vn[0]) ? vn.slice(1) : [vn[4], vn[5], vn[1], vn[2], vn[3]];
      return Math.floor(new Date(+y, +mo - 1, +d, +h, +mi).getTime() / 1000);
    }
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  };

  function parseHandover(text, at) {
    const m = String(text || '').normalize('NFC').replace(/\s+/g, ' ').trim().match(HANDOVER_RE);
    if (!m) return null;
    const by = m[1].replace(/^Bàn giao khách hàng\s*/i, '').trim();
    const customer = m[2].trim();
    const to = m[3].trim();
    const sec = toSec(at);
    // Cùng 1 thông báo có thể đến từ API và từ giao diện → khoá theo khách + người nhận + phút
    const key = `${normName(customer)}|${normName(to)}|${sec ? Math.floor(sec / 60) : 'x'}`;
    return { key, by, customer, to, at: sec };
  }

  async function saveHandovers(list) {
    const cur = await kvGet('handovers');
    const patch = {};
    const now = Date.now() / 1000;
    for (const x of list) {
      const h = parseHandover(x.text, x.at);
      if (!h || (h.at && now - h.at > HANDOVER_DAYS * 86400)) continue;
      // Đã có bản cùng khách + người nhận (vd. bản đọc từ giao diện chưa có giờ) → không thêm trùng
      const dup = Object.values(cur).find((o) => normName(o.customer) === normName(h.customer) && normName(o.to) === normName(h.to) && (!o.at || !h.at || Math.abs(o.at - h.at) < 120));
      if (dup || cur[h.key]) continue;
      patch[h.key] = { ...h, seenAt: Math.floor(now) };
    }
    if (Object.keys(patch).length) await kvMerge('handovers', patch);
  }

  // Thông báo hiện trong menu chuông (phòng khi CRM đẩy qua socket chứ không qua API)
  function watchHandoverDom() {
    const scan = (el) => {
      const out = [];
      for (const n of [el, ...el.querySelectorAll('*')]) {
        const t = n.textContent || '';
        if (t.length > 400 || !t.includes('đã bàn giao khách hàng')) continue;
        if ([...n.children].some((c) => (c.textContent || '').includes('đã bàn giao khách hàng'))) continue; // lấy phần tử nhỏ nhất
        const box = n.parentElement?.parentElement || n.parentElement;
        const tm = (box?.textContent || '').match(/(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        const at = tm ? new Date(+tm[5], +tm[4] - 1, +tm[3], +tm[1], +tm[2]).getTime() : null;
        out.push({ text: t, at });
      }
      return out;
    };
    new MutationObserver((muts) => {
      const found = [];
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1 && (n.textContent || '').includes('đã bàn giao khách hàng')) found.push(...scan(n));
      if (found.length) chain = chain.then(() => saveHandovers(found)).then(render).catch((err) => console.warn('[DG]', err));
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // Báo giá gần nhất của khách + NVKD cũ (người phụ trách gần nhất khác người nhận)
  function handoverTarget(h, quotes) {
    const mine = Object.values(quotes)
      .filter((q) => q.id && normName(q.customer?.name) === normName(h.customer))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const from = mine.find((q) => q.staff?.name && normName(q.staff.name) !== normName(h.to))?.staff.name || '';
    return { q: mine[0] || null, from };
  }
  const handoverText = (h, from) =>
    from ? `Bàn giao khách hàng ${h.customer} từ nhân viên ${from} qua nhân viên ${h.to}` : `Bàn giao khách hàng ${h.customer} cho nhân viên ${h.to}`;

  // ---------- Claude ----------
  const SYSTEM = `Bạn là trưởng phòng kinh doanh của ${SITE.name}, công ty sản xuất bao bì giấy carton (thùng 3 lớp, 5 lớp, offset, flexo...).
Bạn đọc phần bình luận nội bộ trong báo giá trên CRM – nơi nhân viên kinh doanh (NVKD) trao đổi với cấp trên/bộ phận tính giá – và đánh giá NVKD phụ trách.

Tiêu chí (chấm 1–5 mỗi tiêu chí):
1. Thông tin xin giá đầy đủ: số lượng, quy cách, số lớp/định lượng, in hay không, địa chỉ giao, VAT/hình thức xuất hóa đơn, thời hạn.
2. Tốc độ phản hồi và bám đuổi (dựa vào mốc thời gian giữa các bình luận).
3. Hiểu khách hàng, phát hiện sớm yếu tố ảnh hưởng giá (VAT 0% khu chế xuất, vận chuyển, mẫu của khách...).
4. Giao tiếp rõ ràng, chuyên nghiệp.
5. Hướng tới chốt đơn: có bước tiếp theo, cập nhật tình trạng báo giá.

Yêu cầu:
- Chỉ dựa trên dữ liệu được cung cấp; thiếu dữ liệu thì nói rõ là thiếu, không suy diễn.
- Dòng đầu tiên đúng định dạng: "ĐIỂM: x/10".
- Sau đó: bảng điểm 5 tiêu chí (mỗi dòng "Tên tiêu chí: x/5 – lý do ngắn"), "Điểm mạnh", "Cần cải thiện", "Gợi ý hành động" (cụ thể, làm được ngay).
- Viết tiếng Việt, ngắn gọn, văn bản thuần (không dùng bảng markdown).`;

  function threadText(q, c) {
    const lines = [`Báo giá ${q?.code || c?.code || ''} – "${q?.name || ''}"`];
    if (q) {
      lines.push(
        `Khách hàng: ${q.customer?.name || '?'} | Số tiền: ${money(q.amount) || '?'} | Tình trạng báo giá: ${statusLabel(q.quoteStatus)} | Tạo lúc: ${fmtTime(q.createdAt)}`,
      );
    }
    lines.push(`NVKD phụ trách: ${staffOf(q, c) || '?'}`);
    if (q?.customer?.id && renderCtx.orders?.[q.customer.id]) lines.push(ordersText(renderCtx.orders[q.customer.id]));
    lines.push('Bình luận (theo thời gian):');
    const walk = (t, depth) => {
      const file = t.file ? ' [có ảnh/file đính kèm]' : '';
      lines.push(`${'  '.repeat(depth)}${depth ? '↳ ' : '- '}[${fmtTime(t.createdAt)}] ${t.staff?.name || '?'}: ${t.text.trim()}${file}`);
      [...(t.children || [])].sort((a, b) => a.createdAt - b.createdAt).forEach((ch) => walk(ch, depth + 1));
    };
    (c?.threads || []).forEach((t) => walk(t, 0));
    if (!c?.threads?.length) lines.push('(chưa có bình luận nào được ghi lại)');
    return lines.join('\n');
  }

  const parseScore = (text) => {
    const m = text.match(/ĐIỂM[^0-9]*(\d+(?:[.,]\d+)?)\s*\/\s*10/i);
    return m ? Number(m[1].replace(',', '.')) : null;
  };

  async function runEval(evalKey, prompt, meta) {
    setBusy(evalKey, true);
    try {
      const text = await call({ type: 'claude', system: SYSTEM, prompt });
      await kvMerge('evals', { [evalKey]: { ...meta, text, score: parseScore(text), at: Date.now() } });
    } catch (e) {
      state.error = e.message;
    } finally {
      setBusy(evalKey, false);
      render();
    }
  }

  async function evaluateQuote(id) {
    const [quotes, comments] = await Promise.all([kvGet('quotes'), kvGet('comments')]);
    renderCtx.orders = await kvGet('orders');
    const q = quotes[id];
    const c = comments[id];
    const staff = staffOf(q, c);
    const prompt = `Đánh giá NVKD "${staff || 'phụ trách'}" qua báo giá sau.\n\n${threadText(q, c)}`;
    await runEval(`q:${id}`, prompt, { staff, code: q?.code || c?.code });
  }

  // ---------- Bộ câu hỏi nhân viên trong báo giá ----------
  // ===== BỘ CÂU HỎI NHÂN VIÊN TRONG BÁO GIÁ =====
  // Muốn nạp thêm câu hỏi: thêm 1 dòng vào đúng nhóm rồi push lên git.
  const BO_CAU_HOI = {
    // Luôn cân nhắc hỏi ở gợi ý bình thường (không gộp vào hỏi nhanh / chào lại / tình huống đặc biệt)
    luonHoi: ['"Em tới công ty khách hàng xem quy mô chưa em?" (giữ cách nói này, chỉ đổi xưng hô cho đúng)'],
    // Hỏi theo giai đoạn của báo giá
    theoGiaiDoan: [
      'Chưa đủ thông tin để tính giá: còn thiếu gì (số lượng, quy cách, số lớp/định lượng, in hay không, địa chỉ giao, VAT/hóa đơn, ngày cần hàng)?',
      'Đã có giá nhưng chưa gửi khách: đã gửi báo giá cho khách chưa, khi nào gửi?',
      'Đã gửi giá: khách phản hồi thế nào – giá ok chưa, chê cao thì giá mục tiêu bao nhiêu, đang so với bên nào?',
      'Khách đồng ý: khi nào lên đơn, cọc/thanh toán thế nào, ngày giao, đã duyệt mẫu/maket chưa?',
      'Khách chê/chưa chốt: "Nếu giá vẫn chưa tới, khách tăng số lượng được không để anh tính lại cho sát?" (giữ nguyên ý và cách nói này, chỉ đổi xưng hô cho đúng)',
    ],
    // Chế độ hỏi nhanh: đã quá 12 giờ từ bình luận cuối mà báo giá chưa chốt
    // Giữ đúng cách nói, vd: "8 ngày chưa có phản hồi, báo cáo lại nhé chị. Giá cả đạt chưa chị?"
    hoiNhanh: ['"Giá cả đạt chưa?" (giữ nguyên cách nói này, chỉ thêm xưng hô ở cuối; không thêm "khách đồng ý chốt chưa")'],
    // Đơn tái bản (sản phẩm đã có mã SP): CHỈ hỏi câu này
    taiBan: '"Khách xuống đơn tái bản chưa em?" (giữ nguyên cách nói, chỉ đổi xưng hô cho đúng)',
    // Câu kết ở gợi ý bình thường (thay cho kiểu hẹn giờ "phản hồi trước 11h")
    ketThuc: 'Làm việc với khách xong báo cáo lại cho anh.',
    // Chế độ chào lại: báo giá Thất bại hoặc im lặng quá 30 ngày
    chaoLai: ['"Báo cáo lại khách hàng này nhé/nha {xưng hô}" hoặc "Báo cáo lại khách hàng này {xưng hô} nhé/nha" (đúng 1 câu này, chọn 1 trong 4 cách)'],
    // Tình huống đặc biệt nhận ra từ nội dung bình luận – ưu tiên hơn các chế độ trên
    tinhHuong: [
      {
        khi: 'bình luận CUỐI CÙNG là quản lý bàn giao khách ("Bàn giao khách hàng … từ nhân viên … qua nhân viên …") và NVKD mới chưa phản hồi gì',
        hoi: '"Em liên hệ khách này được chưa, báo cáo lại cho anh" (giữ cách nói này, chỉ đổi xưng hô cho đúng)',
      },
      {
        khi: 'NVKD đã báo khách hẹn đặt sau / để sau / đợi (vd. "khách xem báo giá trước, đợi hàng bớt kho đặt hàng sau", "khách hẹn tuần sau báo lại")',
        hoi: 'Kết quả của báo giá này sao rồi?',
      },
      {
        khi: 'bình luận CUỐI CÙNG của luồng là quản lý đã cho giá / duyệt giá (vd. "A cho em giá đã bao gồm khuôn + bản in", "E cho chị giá nhé", "E duyệt giá nhé chị"; hoặc bình luận của quản lý KÈM HÌNH ẢNH – thường là hình bảng giá màu đỏ = đã cho giá) và sau đó NVKD chưa phản hồi gì – hỏi NVKD đã báo giá cho khách chưa, khách phản hồi giá cao / thấp thế nào',
        // Nhiều phiên bản mềm mại – mỗi lần gợi ý chọn ngẫu nhiên 1 câu
        hoi: [
          'Giá anh gửi khách thấy sao rồi em, có ổn không?',
          'Báo giá này khách phản hồi sao rồi em? Có vướng chỗ nào không để anh hỗ trợ.',
          'Em ơi khách xem giá chưa, thấy ok không em?',
          'Giá này khách có ý vấn đề gì không em?',
          'Khách nhận giá rồi thấy thế nào em, có hợp không?',
          'Em hỏi thăm khách giúp anh giá này ổn chưa nhé, khách cần gì thêm không?',
        ],
      },
      {
        khi: 'luồng có nhắc khách cần mẫu / phải có mẫu / chạy mẫu (vd. "Quy trình của bên này làm hàng phải có mẫu Sếp ạ", "Thùng này có chạy mẫu không") mà chưa thấy xác nhận đã có mẫu',
        hoi: 'Nếu chưa có mẫu thì đàm phán làm mẫu cho khách.',
      },
      {
        khi: 'NVKD báo khách đã đặt chỗ khác / đặt bên khác rồi (vd. "khách báo đơn này gấp cần 3 ngày giao nên họ đặt qua chỗ khác rồi Sếp")',
        hoi: 'Xin giá khách làm bên kia là bao nhiêu để lần sau chào lại.',
      },
      {
        khi: 'NVKD đã báo khách hứa / đồng ý lên đơn (vd. "nếu ok thì lên đơn luôn", "tuần sau khách đặt hàng", "Sếp lên đơn giúp em") mà báo giá vẫn CHƯA có đơn hàng',
        hoi: 'Khách hứa lên đơn mà sao chưa lên vậy em, lý do gì em?',
      },
      {
        khi: 'NVKD báo đã xin giá mong muốn mà khách KHÔNG cho giá / không phản hồi giá mong muốn (vd. "em có xin giá nhưng khách không có phản hồi ạ")',
        hoi: 'Để anh cho giá mới nhé em.',
      },
      {
        khi: 'NVKD báo khách chê giá cao / giá bên mình cao mà CHƯA nói khách mong muốn giá bao nhiêu',
        hoi: 'Xin giá khách mong muốn đi em.',
      },
    ],
  };
  const tinhHuongText = (items = BO_CAU_HOI.tinhHuong) =>
    items
      .map((t) =>
        Array.isArray(t.hoi)
          ? `- Khi ${t.khi}:\n  → hỏi theo MỘT trong các phiên bản sau (dùng đúng số phiên bản đề bài chỉ định, chỉ đổi xưng hô cho đúng):\n${t.hoi.map((h, i) => `     ${i + 1}. ${h}`).join('\n')}`
          : `- Khi ${t.khi}:\n  → hỏi: ${t.hoi}`,
      )
      .join('\n');
  const maxVariants = (items = BO_CAU_HOI.tinhHuong) => Math.max(1, ...items.map((t) => (Array.isArray(t.hoi) ? t.hoi.length : 1)));

  // Bộ câu hỏi = BO_CAU_HOI (viết tay trong code) + các câu TỰ HỌC từ bình luận thật của quản lý (kv 'learned')
  const learnedOn = (learned, nhom) => Object.values(learned || {}).filter((x) => !x.off && x.nhom === nhom);
  const bank = (learned) => ({
    tinhHuong: [...BO_CAU_HOI.tinhHuong, ...learnedOn(learned, 'tinhHuong').map((x) => ({ khi: x.khi, hoi: x.hoi }))],
    theoGiaiDoan: [...BO_CAU_HOI.theoGiaiDoan, ...learnedOn(learned, 'theoGiaiDoan').map((x) => x.hoi)],
  });

  const list = (arr) => arr.map((q) => `- ${q}`).join('\n');

  const suggestSystem = (learned) => {
    const b = bank(learned);
    return `Bạn giúp quản lý kinh doanh của ${SITE.name} (bao bì giấy carton) viết MỘT bình luận để đăng vào phần bình luận của báo giá trên CRM, hỏi nhân viên kinh doanh (NVKD) về bước tiếp theo.

BỘ CÂU HỎI NHÂN VIÊN

ĐƠN TÁI BẢN – ưu tiên cao nhất. Nếu đề bài ghi "ĐƠN TÁI BẢN" thì CHỈ viết đúng 1 câu: ${BO_CAU_HOI.taiBan}. Có thể mở đầu bằng "<thời gian> chưa có phản hồi, báo cáo lại nhé" nếu im lặng từ 3 ngày trở lên. Không hỏi gì khác, bỏ qua mọi chế độ và tình huống bên dưới.

TÌNH HUỐNG ĐẶC BIỆT – kiểm tra TRƯỚC TIÊN (sau đơn tái bản). Nếu bình luận gần nhất của NVKD khớp một tình huống dưới đây thì chỉ viết 1 câu ngắn hỏi đúng câu của tình huống đó – KHÔNG gộp thêm câu nào khác (kể cả câu tới công ty khách xem quy mô), bỏ qua chế độ hỏi nhanh/chào lại:
${tinhHuongText(b.tinhHuong)}

Câu luôn cân nhắc hỏi – chỉ dùng ở gợi ý bình thường; KHÔNG dùng ở chế độ hỏi nhanh, chào lại và tình huống đặc biệt (bỏ qua nếu luồng bình luận đã có câu trả lời):
${list(BO_CAU_HOI.luonHoi)}

Câu hỏi theo giai đoạn (chọn những câu hợp với tình hình thực tế của luồng bình luận):
${list(b.theoGiaiDoan)}

Nếu đề bài ghi "CHẾ ĐỘ HỎI NHANH" (đã quá 12 giờ từ bình luận cuối mà báo giá chưa chốt): CHỈ viết 1 câu ngắn theo ý sau, KHÔNG gộp thêm câu nào khác (kể cả câu tới công ty khách xem quy mô), không nhắc lại nội dung báo giá, không đánh số, không hẹn giờ:
${list(BO_CAU_HOI.hoiNhanh)}

Nếu đề bài ghi "CHẾ ĐỘ CHÀO LẠI" (báo giá đã thất bại hoặc im lặng quá ${MAX_FOLLOW_UP_DAYS} ngày): CHỈ viết đúng 1 câu ngắn sau, không mở đầu bằng thời gian im lặng, không gộp thêm câu nào khác:
${list(BO_CAU_HOI.chaoLai)}

Quy tắc:
- Bạn viết THAY quản lý, như chính quản lý tự gõ. Đọc kỹ phần "VĂN PHONG" (các bình luận thật của quản lý) và bắt chước sát: cách xưng hô với từng NVKD (ví dụ quản lý xưng "em" và gọi NVKD nữ lớn tuổi hơn là "chị" thì làm y như vậy), độ dài câu, từ hay dùng, viết tắt, dấu câu, mức độ thân mật. Ưu tiên ví dụ nói với đúng NVKD này.
- Tuyệt đối không viết giọng văn mẫu, công sở hay "AI". Không mở đầu bằng lời chào dài, không cảm ơn, không ký tên. Nếu quản lý hay viết ngắn gọn thì viết ngắn gọn.
- Chỉ đánh số câu hỏi nếu thật cần (từ 3 ý trở lên); 1–2 ý thì viết liền tự nhiên như nhắn tin.
- Khi nhắc khoảng thời gian NVKD im lặng, nói đúng kiểu: "<khoảng thời gian> chưa có phản hồi, báo cáo lại nhé" (vd. "2 tuần chưa có phản hồi, báo cáo lại nhé"), dùng đúng khoảng thời gian đề bài đưa. KHÔNG viết "chưa có cập nhật". Ở chế độ hỏi nhanh, nếu im lặng từ 3 ngày trở lên thì mở đầu bằng câu này rồi mới hỏi (vẫn ngắn gọn). Chế độ chào lại thì KHÔNG mở đầu bằng câu này.
- Không hỏi lại những điều đã được trả lời trong luồng (vd. luồng đã nói đã tới công ty khách / đã gặp khách thì không hỏi lại). Tối đa 3 ý hỏi.
- Ở gợi ý bình thường (không phải hỏi nhanh / chào lại / tình huống đặc biệt): kết thúc bằng câu "${BO_CAU_HOI.ketThuc}" (chỉ đổi xưng hô cho đúng). KHÔNG hẹn giờ cụ thể kiểu "phản hồi trước 11h hôm nay".
- Nếu chưa có ví dụ văn phong: viết ngắn, thân mật, kiểu nhắn tin nội bộ.
- Chỉ trả về đúng nội dung bình luận, không giải thích, không dùng markdown.`;
  };

  async function suggestComment(id) {
    const key = `c:${id}`;
    setBusy(key, true);
    try {
      const [quotes, comments, me, learned] = await Promise.all([kvGet('quotes'), kvGet('comments'), kvGet('me'), kvGet('learned')]);
      quickLearn = await kvGet('quickLearn');
      renderCtx.orders = await kvGet('orders');
      meName = myName(me);
      const q = quotes[id];
      const c = comments[id];
      const last = lastComment(c);
      const hours = last ? hoursSince(last.createdAt) : null;
      const mode = followMode(q, c);
      const overdue = mode === 'hoiNhanh';
      const examples = styleExamples(quotes, comments, me, staffOf(q, c));
      const context = [
        `Quản lý đăng bình luận (chính là người dùng): ${myName(me)}`,
        `NVKD phụ trách: ${staffOf(q, c) || '(không rõ)'}`,
        `Thời điểm hiện tại: ${fmtTime(Date.now() / 1000)}`,
        last
          ? `Bình luận cuối: ${humanDuration(hours)} trước, của ${last.staff?.name || '?'}. Khoảng thời gian im lặng: ${humanDuration(hours)}.`
          : 'Chưa có bình luận nào.',
        `Nếu khớp tình huống có nhiều phiên bản câu hỏi: dùng phiên bản số ${1 + Math.floor(Math.random() * maxVariants(bank(learned).tinhHuong))} (nếu tình huống có ít phiên bản hơn thì lấy phiên bản cuối).`,
        noPrice(q)
          ? 'BÁO GIÁ ĐANG 0đ: quản lý CHƯA cho giá. KHÔNG hỏi NVKD "giá đạt chưa / khách phản hồi giá"; nếu cần thì chỉ hỏi NVKD còn thiếu thông tin gì để quản lý tính giá.'
          : '',
        q?.isReprint ? 'ĐƠN TÁI BẢN: sản phẩm của báo giá đã có mã SP (tái bản) – chỉ hỏi khách xuống đơn tái bản chưa.' : '',
        monthlyAsk(q, c)
          ? 'KHÁCH CŨ, THÁNG NÀY CHƯA CÓ BÁO GIÁ MỚI: chỉ hỏi đúng 1 câu "Tháng này khách hàng này sao chưa nhập vậy <xưng hô>?" (ưu tiên hơn mọi chế độ khác).'
          : '',
        mode && !q?.isReprint && offsetGap(q, c)
          ? 'KHÁCH CHƯA CÓ BÁO GIÁ OFFSET và đã lâu không có báo giá mới: chỉ hỏi đúng 1 câu "Khách hàng này có dùng offset không <xưng hô>?" (ưu tiên hơn chế độ hỏi nhanh / chào lại).'
          : '',
        mode === 'hoiNhanh'
          ? `CHẾ ĐỘ HỎI NHANH: đã quá ${FOLLOW_UP_HOURS} giờ từ bình luận cuối mà báo giá chưa chốt – chỉ 1 câu ngắn theo các ý hỏi nhanh (trừ khi khớp TÌNH HUỐNG ĐẶC BIỆT).`
          : '',
        mode === 'chaoLai'
          ? `CHẾ ĐỘ CHÀO LẠI: báo giá ${q?.quoteStatus === 'REJECT' ? 'đã thất bại' : `im lặng đã ${Math.floor(hours / 24)} ngày`} – chỉ 1 câu "Báo cáo lại khách hàng này nhé" (trừ khi khớp TÌNH HUỐNG ĐẶC BIỆT).`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      const text = await call({
        type: 'claude',
        system: suggestSystem(learned),
        prompt: [styleBlock(examples, myName(me)), editExamples(staffOf(q, c)), context, threadText(q, c)].filter(Boolean).join('\n\n'),
        maxTokens: 4000,
      });
      await kvMerge('suggests', { [id]: { text: text.trim(), orig: text.trim(), at: Date.now(), overdue, mode, styleFrom: examples.list.length } });
    } catch (e) {
      state.error = e.message;
    } finally {
      setBusy(key, false);
    }
  }

  // ---------- Tự học bộ câu hỏi từ bình luận thật của quản lý ----------
  // Gom các bình luận quản lý gửi NVKD (kèm câu NVKD mà quản lý đang trả lời) chưa học, nhờ Claude rút ra
  // câu hỏi / tình huống LẶP LẠI ĐƯỢC mà bộ câu hỏi chưa có, rồi nạp vào kv 'learned' (đồng bộ mọi máy).
  const LEARN = { minNew: 5, maxPerRun: 60, everyHours: 12 };

  function managerComments(quotes, comments, seen) {
    const name = meName;
    const out = [];
    for (const c of Object.values(comments)) {
      const q = quotes[c.id];
      const walk = (t, parent) => {
        const text = (t.text || '').trim();
        if (t.staff?.name === name && text.length >= 8 && !seen[t.id]) {
          out.push({ id: t.id, at: t.createdAt, text, code: q?.code || c.code, staff: staffOf(q, c), status: statusLabel(q?.quoteStatus),
            parent: parent && parent.staff?.name !== name ? { name: parent.staff?.name, text: (parent.text || '').trim() } : null });
        }
        (t.children || []).forEach((ch) => walk(ch, t));
      };
      (c.threads || []).forEach((t) => walk(t, null));
    }
    return out.sort((a, b) => b.at - a.at);
  }

  const LEARN_SYSTEM = `Bạn giúp quản lý kinh doanh của ${SITE.name} (bao bì giấy carton) xây dựng BỘ CÂU HỎI dùng để hỏi nhân viên kinh doanh (NVKD) trong phần bình luận báo giá trên CRM.
Bạn được cho: bộ câu hỏi hiện có, và các bình luận THẬT mà quản lý đã viết cho NVKD (kèm câu của NVKD mà quản lý đang trả lời, nếu có).
Nhiệm vụ: rút ra những câu hỏi / chỉ đạo của quản lý mà LẶP LẠI ĐƯỢC cho các báo giá khác và bộ câu hỏi CHƯA có ý tương tự.

Bỏ qua:
- câu chỉ đúng cho 1 báo giá (giá cụ thể, mã sản phẩm, số lượng, quy cách, tên khách);
- câu cho giá / duyệt giá / trả lời kỹ thuật / giao việc nội bộ không phải câu hỏi NVKD;
- câu đã có ý tương tự trong bộ câu hỏi hoặc trong danh sách "đã loại".

Với mỗi câu rút ra:
- "nhom": "tinhHuong" nếu câu hỏi là phản ứng với một điều NVKD vừa nói (mô tả điều đó trong "khi", kèm ví dụ ngắn trích từ câu NVKD); "theoGiaiDoan" nếu là câu hỏi chung theo giai đoạn báo giá.
- "hoi": giữ ĐÚNG cách nói của quản lý (từ ngữ, độ dài, xưng hô "anh"/"em"), chỉ bỏ tên riêng, số liệu, mã.
- "vd": trích nguyên văn bình luận gốc của quản lý.
Tối đa 5 câu. Không có gì mới thì trả về [].
Chỉ trả về JSON array, không giải thích, không markdown. Mẫu: [{"nhom":"tinhHuong","khi":"...","hoi":"...","vd":"..."}]`;

  function bankText(learned) {
    const b = bank(learned);
    const off = Object.values(learned || {}).filter((x) => x.off).map((x) => `- ${x.hoi}`);
    return [
      'TÌNH HUỐNG ĐẶC BIỆT:',
      ...b.tinhHuong.map((t) => `- Khi ${t.khi} → ${Array.isArray(t.hoi) ? t.hoi.join(' / ') : t.hoi}`),
      'THEO GIAI ĐOẠN:',
      ...b.theoGiaiDoan.map((t) => `- ${t}`),
      'LUÔN HỎI / HỎI NHANH / CHÀO LẠI / TÁI BẢN:',
      ...[...BO_CAU_HOI.luonHoi, ...BO_CAU_HOI.hoiNhanh, ...BO_CAU_HOI.chaoLai, BO_CAU_HOI.taiBan].map((t) => `- ${t}`),
      off.length ? `ĐÃ LOẠI (quản lý đã xoá, không đề xuất lại):\n${off.join('\n')}` : '',
    ].filter(Boolean).join('\n');
  }

  let learning = false;
  async function learnQuestions(force = false) {
    if (learning) return 0;
    const lastAt = Number(await call({ type: 'kv.get', key: 'learnAt' })) || 0;
    if (!force && Date.now() - lastAt < LEARN.everyHours * 3600 * 1000) return 0;
    learning = true;
    state.busy.add('learn');
    try {
      const [quotes, comments, me, learned, seen] = await Promise.all([kvGet('quotes'), kvGet('comments'), kvGet('me'), kvGet('learned'), kvGet('learnSeen')]);
      meName = myName(me);
      const fresh = managerComments(quotes, comments, seen).slice(0, LEARN.maxPerRun);
      if (fresh.length < (force ? 1 : LEARN.minNew)) return 0;
      const cut = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t);
      const lines = fresh.map((x) =>
        `- [${x.code} · NVKD ${x.staff || '?'} · ${x.status}]${x.parent?.text ? ` ${x.parent.name || 'NVKD'}: "${cut(x.parent.text.replace(/\s+/g, ' '), 200)}" →` : ''} Quản lý: "${cut(x.text.replace(/\s+/g, ' '), 300)}"`,
      );
      const out = await call({
        type: 'claude',
        system: LEARN_SYSTEM,
        prompt: `BỘ CÂU HỎI HIỆN CÓ\n${bankText(learned)}\n\nBÌNH LUẬN THẬT CỦA QUẢN LÝ (${meName})\n${lines.join('\n')}`,
        maxTokens: 4000,
      });
      let items = [];
      try {
        items = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1) || '[]');
      } catch {
        items = [];
      }
      const now = Date.now();
      const patch = {};
      items
        .filter((x) => x && x.hoi && ['tinhHuong', 'theoGiaiDoan'].includes(x.nhom) && (x.nhom !== 'tinhHuong' || x.khi))
        .slice(0, 5)
        .forEach((x, i) => {
          patch[`L${now}-${i}`] = { nhom: x.nhom, khi: x.khi || '', hoi: String(x.hoi).trim(), vd: x.vd || '', at: now };
        });
      if (Object.keys(patch).length) await kvMerge('learned', patch);
      await kvMerge('learnSeen', Object.fromEntries(fresh.map((x) => [x.id, Math.floor(now / 1000)])));
      await call({ type: 'kv.set', key: 'learnAt', value: now });
      return Object.keys(patch).length;
    } finally {
      learning = false;
      state.busy.delete('learn');
    }
  }

  function learnedBox(learned) {
    const all = Object.entries(learned || {}).filter(([, x]) => !x.off).sort((a, b) => b[1].at - a[1].at);
    const items = all
      .map(([k, x]) => `<div class="box"><div>${x.nhom === 'tinhHuong' ? `<span class="muted">Khi ${esc(x.khi)}</span><br>→ ` : '<span class="muted">Theo giai đoạn</span><br>→ '}<b>${esc(x.hoi)}</b></div>
        ${x.vd ? `<div class="muted">Học từ: "${esc(x.vd)}" · ${new Date(x.at).toLocaleDateString('vi-VN')}</div>` : ''}
        <div class="btns"><button class="act" data-act="learn-off" data-key="${esc(k)}">Xoá khỏi bộ câu hỏi</button></div></div>`)
      .join('');
    const busy = state.busy.has('learn');
    return `<details class="learnbox"${state.learnOpen ? ' open' : ''}><summary><b>📚 Bộ câu hỏi tự học (${all.length})</b> <span class="muted">– học từ bình luận thật của bạn, dùng khi soạn gợi ý</span></summary>
      <div class="btns"><button class="act" data-act="learn-now" ${busy ? 'disabled' : ''}>${busy ? 'Đang học…' : '📚 Học ngay từ bình luận mới'}</button>
      ${state.learnMsg ? `<span class="muted">${esc(state.learnMsg)}</span>` : ''}</div>
      ${items || '<div class="muted">Chưa có câu nào. Extension tự học mỗi 12 giờ khi có từ 5 bình luận mới của bạn.</div>'}</details>`;
  }

  // Ô nhập bình luận của CRM: textarea nằm cùng khối với nút "Bình luận"
  function findCommentBox() {
    const btn = [...document.querySelectorAll('button.ant-btn-primary')].find((b) => b.innerText.trim() === 'Bình luận');
    let p = btn;
    while (p && !p.querySelector('textarea:not(#privateNote)')) p = p.parentElement;
    return p?.querySelector('textarea:not(#privateNote)') || null;
  }

  // Câu hỏi gợi ý trên thẻ bên phải → điền sẵn vào ô bình luận của CRM (chỉ khi ô đang trống; xoá đi thì không điền lại)
  const autoFilled = {};
  let autoBusy = false;
  // Điền vào ô TRẢ LỜI của luồng báo giá đang mở (luồng có nhãn đúng mã báo giá); chưa có luồng thì ô bình luận mới
  async function autofillComment() {
    if (!IS_TOP || autoBusy) return;
    const qid = currentQuoteId();
    const qc = qid && quickCtx[qid];
    if (!qc?.text) return;
    const key = `${qid}|${qc.text}`;
    if (autoFilled[qid] === key || autoFilled[`${qid}:tried`]) return; // mỗi lần mở báo giá chỉ điền 1 lần
    // Người dùng đang gõ trong bất kỳ ô bình luận / trả lời nào → không đụng vào
    const typing = [...document.querySelectorAll('textarea')].some((t) => !t.closest('#dg-root') && (document.activeElement === t || t.value.trim()));
    if (typing && !autoFilled[`${qid}:last`]) return;
    if (document.activeElement?.tagName === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    const code = renderCtx.quotes?.[qid]?.code;
    // Báo giá đã có luồng bình luận → BẮT BUỘC trả lời vào luồng (bấm "Trả lời"); chưa hiện luồng thì chờ lượt sau
    const hasThread = !!renderCtx.comments?.[qid]?.threads?.some((t) => !/đã tạo báo giá/i.test(t.text || ''));
    autoBusy = true;
    try {
      let ta = code ? await openReplyBox(code) : null;
      if (!ta && hasThread) {
        autoFilled[`${qid}:wait`] = (autoFilled[`${qid}:wait`] || 0) + 1;
        if (autoFilled[`${qid}:wait`] < 20) return; // thử lại ~30 giây
      }
      autoFilled[`${qid}:tried`] = true;
      ta = ta || findCommentBox();
      if (!ta) return;
      // (bấm "Trả lời" làm CRM tự đặt con trỏ vào ô – vẫn điền, miễn ô còn trống)
      const last = autoFilled[`${qid}:last`] || '';
      if (ta.value.trim() && ta.value.trim() !== last) return; // người dùng đang gõ nội dung khác
      // ô bình luận mới ở trên cùng đã điền từ bản trước → xoá đi (giờ điền vào luồng của báo giá)
      const top = findCommentBox();
      if (top && top !== ta && last && top.value.trim() === last) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(top, '');
        top.dispatchEvent(new Event('input', { bubbles: true }));
      }
      autoFilled[qid] = key;
      autoFilled[`${qid}:last`] = qc.text;
      await sleep(150);
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, qc.text);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
      autoBusy = false;
    }
  }
  setInterval(() => autofillComment().catch(() => {}), 1500);
  // Chỉ điền nội dung, KHÔNG tự bấm gửi – người dùng xem lại rồi tự bấm "Bình luận".
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Trang báo giá hiện cả luồng bình luận của các báo giá khác cùng khách.
  // Luồng của báo giá đang mở có nhãn mã (ant-tag) màu xanh = đúng mã báo giá.
  // Tìm luồng mới nhất của báo giá này, bấm "Trả lời" rồi trả về ô trả lời.
  async function openReplyBox(code) {
    if (!code) return null;
    const roots = [...document.querySelectorAll('.ant-comment')].filter((c) => !c.parentElement.closest('.ant-comment-nested'));
    for (const c of roots) {
      const content = c.querySelector(':scope > .ant-comment-inner > .ant-comment-content');
      if (!content || ![...content.querySelectorAll('.ant-tag')].some((t) => t.textContent.trim() === code)) continue;
      const actions = content.querySelector(':scope > ul.ant-comment-actions');
      const reply = actions && [...actions.querySelectorAll('*')].reverse().find((x) => x.textContent.trim() === 'Trả lời');
      if (!reply) continue; // vd. dòng hệ thống "đã tạo báo giá" không có nút Trả lời
      // Ô trả lời đã mở sẵn (ở bất kỳ đâu trong luồng) → dùng luôn, KHÔNG bấm "Trả lời" lần nữa (bấm lại sẽ đóng ô, mất chữ)
      const findTa = () => c.querySelector('.ant-comment-nested textarea') || c.querySelector(':scope textarea');
      let ta = findTa();
      if (!ta) {
        reply.click();
        for (let i = 0; i < 30 && !(ta = findTa()); i++) await sleep(100);
      }
      if (ta) return ta;
    }
    return null;
  }

  // Báo giá đã có bình luận: trả lời vào luồng của báo giá; chưa có thì dùng ô bình luận mới.
  // Điền nội dung vào ô trả lời của luồng báo giá (hoặc ô bình luận mới) rồi BẤM GỬI luôn.
  // Trả về true khi CRM đã nhận (ô nhập được xoá trống sau khi gửi).
  // fresh = true: luôn đăng bình luận mới, không trả lời vào luồng cũ
  async function sendComment(text, code, fresh = false) {
    if (!text.trim()) throw new Error('Nội dung bình luận đang trống.');
    const ta = (!fresh && (await openReplyBox(code))) || findCommentBox();
    if (!ta) throw new Error('Không tìm thấy ô bình luận trên trang này.');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Nút gửi nằm cùng khối với ô nhập: "Trả lời" (ô trả lời) hoặc "Bình luận" (ô bình luận mới)
    let box = ta.parentElement;
    let btn = null;
    while (box && !btn) {
      btn = [...box.querySelectorAll('button')].find((b) => ['Trả lời', 'Bình luận'].includes(b.innerText.trim()));
      box = box.parentElement;
    }
    if (!btn) throw new Error('Không tìm thấy nút gửi bình luận.');
    for (let i = 0; i < 20 && btn.disabled; i++) await sleep(100);
    if (btn.disabled) throw new Error('Nút gửi của CRM chưa bấm được.');
    btn.click();
    for (let i = 0; i < 80; i++) {
      await sleep(150);
      if (!ta.isConnected || ta.value === '') return true;
    }
    throw new Error('CRM chưa xác nhận đã gửi – kiểm tra lại phần bình luận.');
  }

  // ---------- Thu thập ngầm + tự phân tích ----------
  // Mở lần lượt từng báo giá trong 1 iframe ẩn (name="dg-collector"); chính app CRM tải dữ liệu,
  // hook.js trong iframe ghi lại bình luận và CHẶN lệnh /read + mọi lệnh ghi (chỉ đọc).
  const IS_TOP = window.top === window;
  const COLLECT = { listPages: 10, fullPerRun: 50, perRun: 30, gapMs: 4000, waitMs: 20000, refreshHours: 6, maxAgeDays: 60, everyMin: 30, autoSuggest: 10 };
  const collect = { running: false, done: 0, total: 0, current: '', suggested: 0, lastRun: 0 };
  const TAB_ID = Math.random().toString(36).slice(2);

  // auto: thu thập ngầm; autoOpen: tự mở bảng khi vào trang báo giá
  const getSettings = async () => ({ auto: true, autoOpen: false, ...(await kvGet('settings')) });

  function pickQueue(quotes, comments, collected, full = false) {
    const now = Date.now() / 1000;
    const isOpenQuote = (q) => !CLOSED.has(q.quoteStatus) && !hasOrder(q, comments[q.id]);
    return Object.values(quotes)
      .filter((q) => q.id && (full || (q.createdAt && now - q.createdAt < COLLECT.maxAgeDays * 86400)) && !isExcluded(q.staff?.name))
      .filter((q) => !collected[q.id] || (isOpenQuote(q) && now - collected[q.id] > COLLECT.refreshHours * 3600))
      .sort(
        (a, b) =>
          !!collected[a.id] - !!collected[b.id] || // chưa thu thập lần nào trước
          (a.isRead === false ? 0 : 1) - (b.isRead === false ? 0 : 1) || // chưa đọc trước
          b.createdAt - a.createdAt,
      )
      .slice(0, full ? COLLECT.fullPerRun : COLLECT.perRun);
  }

  // Trang khách hàng → tab đơn hàng chỉ tải 50 đơn/trang: bấm sang trang 2, 3… tới khi đủ 6 tháng (hoặc hết đơn)
  async function readMoreOrders(f, cid) {
    const sixMonths = Date.now() / 1000 - 190 * 86400;
    for (let page = 2; page <= 12; page++) {
      const od = (await kvGet('orders'))[cid];
      const list = od?.orders || [];
      const oldest = list.length ? Math.min(...list.map((o) => (o.at > 1e11 ? o.at / 1000 : o.at) || Infinity)) : 0;
      if (!od || list.length >= (od.total || 0) || oldest < sixMonths) return;
      const doc = f.contentDocument;
      const li = doc?.querySelector(`.ant-pagination-item-${page}`);
      if (!li) return;
      li.click();
      const t0 = Date.now();
      let ok = false;
      while (Date.now() - t0 < 15000) {
        await sleep(400);
        try {
          ok = f.contentWindow.performance.getEntriesByType('resource').some((e) => /\/misaOrder\?/.test(e.name) && new RegExp(`[?&]page=${page}\\b`).test(e.name));
        } catch {}
        if (ok) break;
      }
      if (!ok) return;
      await sleep(1500); // chờ panel.js trong khung lưu xong
    }
  }

  async function loadInFrame(id, url = `/co-hoi/update/${id}`, readyRe = /\/fileAttach\?/, onReady = null) {
    const f = document.createElement('iframe');
    f.name = 'dg-collector';
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:900px;visibility:hidden;pointer-events:none';
    f.src = url;
    document.documentElement.append(f);
    const start = Date.now();
    try {
      while (Date.now() - start < COLLECT.waitMs) {
        await sleep(500);
        let done = false;
        try {
          done = f.contentWindow.performance.getEntriesByType('resource').some((e) => readyRe.test(e.name));
        } catch {}
        if (done) {
          await sleep(2500); // chờ panel.js trong iframe lưu xong
          if (onReady) await onReady(f).catch(() => {});
          break;
        }
      }
    } finally {
      f.remove();
    }
  }

  // Đọc N trang đầu của danh sách Báo giá (cùng bộ lọc người dùng đang dùng) trong iframe ẩn:
  // bấm lần lượt trang 2..N; hook.js trong iframe ghi lại từng trang. Khôi phục bộ lọc/trang của người dùng sau đó.
  // Trạng thái thu thập → lưu cho popup của extension hiển thị
  const progress = () => {
    call({ type: 'kv.set', key: 'collectStatus', value: { ...collect, at: Date.now() } }).catch(() => {});
    render();
  };

  async function collectListPages(maxPages = COLLECT.listPages) {
    let saved = null;
    try {
      saved = localStorage.getItem('quote.query');
    } catch {}
    const f = document.createElement('iframe');
    f.name = 'dg-collector';
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1400px;height:900px;visibility:hidden;pointer-events:none';
    f.src = '/bao-gia';
    document.documentElement.append(f);
    const loaded = (page) => {
      try {
        return f.contentWindow.performance
          .getEntriesByType('resource')
          .some((e) => /\/opportunity\?/.test(e.name) && /[?&]type=2\b/.test(e.name) && new RegExp(`[?&]page=${page}&`).test(e.name));
      } catch {
        return false;
      }
    };
    const waitFor = async (cond, ms) => {
      const t = Date.now();
      while (Date.now() - t < ms) {
        if (cond()) return true;
        await sleep(300);
      }
      return false;
    };
    try {
      collect.current = 'danh sách trang 1';
      progress();
      if (!(await waitFor(() => loaded(1), 25000))) return;
      await sleep(1500);
      for (let page = 2; page <= maxPages; page++) {
        collect.current = `danh sách trang ${page}`;
        progress();
        const li = await waitFor(() => f.contentDocument?.querySelector(`.ant-pagination-item-${page}`), 5000);
        if (!li) break;
        f.contentDocument.querySelector(`.ant-pagination-item-${page}`).click();
        if (!(await waitFor(() => loaded(page), 20000))) break;
        await sleep(1500); // chờ panel.js trong iframe lưu xong
      }
    } finally {
      f.remove();
      try {
        if (saved != null) localStorage.setItem('quote.query', saved);
      } catch {}
    }
  }

  // Đọc trang Đơn hàng Misa (/misa-order/list) trong khung ẩn: trang 1, 2, 3… tới khi gặp đơn cũ hơn ~6 tháng (hoặc hết trang)
  async function collectMisaOrders(maxPages = 40) {
    const f = document.createElement('iframe');
    f.name = 'dg-collector';
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1400px;height:900px;visibility:hidden;pointer-events:none';
    f.src = '/misa-order/list';
    document.documentElement.append(f);
    const loaded = (page) => {
      try {
        return f.contentWindow.performance
          .getEntriesByType('resource')
          .some((e) => /\/misaOrder\?/.test(e.name) && !/customerId=/.test(e.name) && (page === 1 || new RegExp(`[?&]page=${page}\\b`).test(e.name)));
      } catch {
        return false;
      }
    };
    const waitFor = async (cond, ms) => {
      const t = Date.now();
      while (Date.now() - t < ms) {
        if (cond()) return true;
        await sleep(300);
      }
      return false;
    };
    try {
      collect.current = 'đơn hàng Misa trang 1';
      progress();
      if (!(await waitFor(() => loaded(1), 25000))) return;
      await sleep(1500);
      const sixMonths = Date.now() / 1000 - 190 * 86400;
      for (let page = 2; page <= maxPages; page++) {
        // Các trang sau là đơn cũ hơn; đã qua mốc 6 tháng thì dừng
        const rows = [...(f.contentDocument?.querySelectorAll('.ant-table-row') || [])];
        const lastTxt = rows.at(-1)?.textContent || '';
        const dm = lastTxt.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (dm && new Date(+dm[3], +dm[2] - 1, +dm[1]).getTime() / 1000 < sixMonths) break;
        collect.current = `đơn hàng Misa trang ${page}`;
        progress();
        const li = await waitFor(() => f.contentDocument?.querySelector(`.ant-pagination-item-${page}`), 5000);
        if (!li) break;
        f.contentDocument.querySelector(`.ant-pagination-item-${page}`).click();
        if (!(await waitFor(() => loaded(page), 20000))) break;
        await sleep(1500);
      }
    } finally {
      f.remove();
    }
  }

  // Đọc trang Công nợ trong khung ẩn: tab tổng quan, "Quá hạn", "Sắp đến hạn" – mỗi tab đọc hết các trang
  async function collectDebts() {
    const f = document.createElement('iframe');
    f.name = 'dg-collector';
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1400px;height:900px;visibility:hidden;pointer-events:none';
    f.src = '/cong-no?t=overview';
    document.documentElement.append(f);
    const nApi = () => {
      try {
        return f.contentWindow.performance.getEntriesByType('resource').filter((e) => /:8080\/v1\/admin\//.test(e.name)).length;
      } catch {
        return 0;
      }
    };
    const settle = async (ms = 15000) => {
      const t = Date.now();
      let last = nApi();
      let still = Date.now();
      while (Date.now() - t < ms) {
        await sleep(400);
        const n = nApi();
        if (n !== last) {
          last = n;
          still = Date.now();
        } else if (Date.now() - still > 1800 && n > 0) return true;
      }
      return false;
    };
    const readPages = async () => {
      for (let page = 2; page <= 60; page++) {
        const li = f.contentDocument?.querySelector(`.ant-pagination-item-${page}`);
        if (!li) break;
        li.click();
        await settle(12000);
      }
    };
    try {
      collect.current = 'công nợ';
      progress();
      await settle(25000);
      await readPages();
      for (const label of ['Quá hạn', 'Sắp đến hạn']) {
        const el = [...(f.contentDocument?.querySelectorAll('.ant-tabs-tab, [role=tab], button, a') || [])].find((x) => new RegExp(label, 'i').test(x.textContent || ''));
        if (!el) continue;
        collect.current = `công nợ – ${label}`;
        progress();
        el.click();
        await settle(15000);
        await readPages();
      }
    } finally {
      f.remove();
    }
  }

  // Báo giá Offset: trong khung ẩn, bấm số lượng từng sản phẩm → mở "Tính giá offset" → Ctrl+Shift+G.
  // hook.js trong khung đọc bảng chiết giá (iframe#printWindow) và gửi "Đang bán (X%)" về để lưu. Lệnh in bị chặn.
  // Bảng sản phẩm của báo giá: cột STT có loại ("1 Flexo", "3 Offset", "2 Khác"), "Kết cấu giấy" có mã NCC
  // trước dấu "_" (PNTP_T140/… → PNTP), "Tổng tiền" là thành tiền sau VAT của dòng.
  // → kindTotals { flexo, offset, other, flexoSup[], offsetSup[] } lưu vào margins[mã BG] (đồng bộ).
  function readKindTotals(doc) {
    const t = [...doc.querySelectorAll('.ant-table')].find((x) => {
      const hs = [...x.querySelectorAll('thead th')].map((th) => th.innerText.trim());
      return hs.includes('Tổng tiền') && hs.includes('Số lượng');
    });
    if (!t) return null;
    const hs = [...t.querySelectorAll('thead th')].map((th) => th.innerText.trim());
    const iStt = hs.indexOf('STT');
    const iKc = hs.indexOf('Kết cấu giấy');
    const iTot = hs.lastIndexOf('Tổng tiền');
    const out = { flexo: 0, offset: 0, other: 0, flexoSup: [], offsetSup: [] };
    let n = 0;
    for (const tr of t.querySelectorAll('.ant-table-tbody tr')) {
      if (tr.classList.contains('ant-table-measure-row') || tr.cells.length <= iTot) continue;
      const kind = /offset/i.test(tr.cells[iStt]?.innerText || '') ? 'offset' : /flexo/i.test(tr.cells[iStt]?.innerText || '') ? 'flexo' : 'other';
      const total = Number(String(tr.cells[iTot]?.innerText || '').replace(/[^\d]/g, '')) || 0;
      out[kind] += total;
      n++;
      const sup = iKc >= 0 && (tr.cells[iKc]?.innerText || '').match(/\|\s*([A-Z0-9]+)_/)?.[1];
      if (sup && kind !== 'other' && !out[`${kind}Sup`].includes(sup)) out[`${kind}Sup`].push(sup);
    }
    return n ? out : null;
  }
  async function saveKindTotals(doc, code) {
    const kt = code && readKindTotals(doc);
    if (!kt) return;
    const cur = (await kvGet('margins'))[code] || { products: {} };
    const same = JSON.stringify({ ...cur.kindTotals, at: 0 }) === JSON.stringify({ ...kt, at: 0 });
    if (!same) await kvMerge('margins', { [code]: { ...cur, kindTotals: { ...kt, at: Math.floor(Date.now() / 1000) } } });
  }

  async function readOffsetMargins(f, code) {
    const doc = f.contentDocument;
    if (!doc) return;
    const visModals = () => [...doc.querySelectorAll('.ant-modal-wrap')].filter((m) => getComputedStyle(m).display !== 'none');
    const closeModals = async () => {
      for (let i = 0; i < 4 && visModals().length; i++) {
        doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
        visModals().forEach((m) => m.querySelector('.ant-modal-close')?.click());
        await sleep(400);
      }
    };
    // Cột "Số lượng" của bảng sản phẩm
    const table = [...doc.querySelectorAll('.ant-table')].find((t) => [...t.querySelectorAll('th')].some((th) => th.innerText.trim() === 'Số lượng'));
    if (!table) return;
    const idx = [...table.querySelectorAll('thead th')].findIndex((th) => th.innerText.trim() === 'Số lượng');
    const rows = [...table.querySelectorAll('.ant-table-tbody tr')].filter((tr) => !tr.classList.contains('ant-table-measure-row') && tr.cells.length > idx);
    // Ghi thứ tự sản phẩm trên báo giá (để bảng Giải thích xếp đúng thứ tự)
    if (code) {
      const order = rows.map((tr) => tr.innerText.replace(/\s+/g, ' ').slice(0, 400));
      const all = await kvGet('margins');
      if (all[code]) await kvMerge('margins', { [code]: { ...all[code], order } });
      else await kvMerge('margins', { [code]: { products: {}, offVer: OFF_VER, order } });
    }
    for (const [ri, tr] of rows.slice(0, 10).entries()) {
      setStep(`Đang mở bảng chiết giá Offset (sản phẩm ${ri + 1}/${Math.min(rows.length, 10)})…`);
      const btn = tr.cells[idx]?.querySelector('button');
      if (!btn) continue;
      // Đọc xong phải thấy đúng dòng này (quy cách + SL) được lưu; chưa thấy thì thử lại (tối đa 3 lần, chờ lâu dần)
      const rowTxt = tr.innerText.replace(/\s+/g, ' ');
      const saved = async (t0) => {
        if (!code) return true;
        const prods = Object.values((await kvGet('margins'))[code]?.products || {});
        return prods.some((x) => (x.at || 0) * 1000 >= t0 - 1500 && offRowFor([rowTxt], x.spec, x.qty));
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        const t0 = Date.now();
        btn.click();
        let modal = null;
        for (let i = 0; i < 24 && !modal; i++) {
          await sleep(250);
          modal = visModals().find((m) => /Tính giá offset/i.test(m.innerText));
        }
        let ok = false;
        if (modal) {
          await sleep(400 + attempt * 600); // chờ hộp tính giá tải xong số liệu
          doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true, bubbles: true }));
          for (let i = 0; i < 12 + attempt * 6 && !(ok = await saved(t0)); i++) await sleep(400); // hook.js đọc bảng chiết giá
        }
        await closeModals();
        if (ok || !code) break;
        setStep(`Đọc lại chiết giá sản phẩm ${ri + 1} (lần ${attempt + 2})…`);
        await sleep(600);
      }
    }
    // Ghi giá trị báo giá lúc đọc chiết giá → giá trị đổi (sửa đơn giá) thì tự đọc lại
    if (code) {
      await sleep(800);
      const qq = Object.values(await kvGet('quotes')).find((x) => x?.code === code);
      const all = await kvGet('margins');
      if (qq?.amount && all[code]) await kvMerge('margins', { [code]: { ...all[code], amountAt: qq.amount } });
    }
  }

  // Báo giá Flexo: trong khung ẩn mở "Lên PO → Giấy tấm", bấm lần lượt từng mã nhà cung cấp,
  // đọc "Tổng thanh toán". Tỉ lệ giấy tấm = tổng PO / tổng giá trị báo giá. Không lưu PO (khung chặn lệnh ghi).
  // Bước đang làm khi tính % (hiện trên thẻ bên phải)
  let marginStep = '';
  const setStep = (t) => {
    marginStep = t;
    if (IS_TOP) render();
  };

  // Đổi giá trị này để tính lại % Flexo của mọi báo giá đã lưu (khi sửa cách đọc PO)
  const FLEXO_MODE = 'sum-v2';
  // Còn nhà cung cấp chưa đọc được thì 1 giờ sau tự tính lại
  // Tổng báo giá đổi (sửa giá / số lượng) so với lúc tính → tính lại
  const flexoAmountChanged = (fx, q) => {
    if (!fx || !q?.amount) return false;
    const was = fx.amountAt ?? fx.quoteTotal;
    return !!was && Math.abs(was - q.amount) / q.amount > 0.005;
  };
  // Báo giá tính Flexo trước khi có kiểm tra giá giấy tấm 0đ/m2 → mở lại 1 lần để kiểm tra
  const SHEET_SINCE = 1792344732;
  const flexoStale = (fx, q) =>
    !fx || fx.mode !== FLEXO_MODE || (fx.missing?.length > 0 && Date.now() / 1000 - fx.at > 3600) || flexoAmountChanged(fx, q) ||
    (!!q && q.noSheetAt == null && (fx.at || 0) < SHEET_SINCE) ||
    // đã lên đơn (thường đã có PO thật) mà số cũ là PO nháp → tính lại theo PO thật (24 giờ / lần)
    (!!q && (q.hasOrder || q.orderCode) && !fx.fromPo && Date.now() / 1000 - (fx.poCheckAt || 0) > 86400);

  // ---------- 💲 Set giá nhanh cho báo giá Flexo ----------
  // Bình luận NVKD xin giá ("Sếp cho em xin báo giá đơn này") → nút "💲 Set giá" cạnh "Trả lời".
  // Chọn % bán → ngay trên trang: Lên PO → Giấy tấm → từng nhà cung cấp: kéo % Deal, bấm "Set deal cho BG"
  // → đóng PO → bấm "Cập nhật" lưu báo giá → F5. Chỉ chạy khi quản lý bấm xác nhận.
  const PRICE_ASK_RE = /xin\s*(lại\s*)?(báo\s*|đơn\s*)?giá|cho\s*(em|chị|anh|e|c)\s*(xin\s*)?(lại\s*)?(đơn\s*)?giá/i;
  const visModalsTop = () => [...document.querySelectorAll('.ant-modal-wrap')].filter((m) => getComputedStyle(m).display !== 'none');
  const waitFor = async (fn, ms = 8000, gap = 200) => {
    for (let t = 0; t < ms; t += gap) {
      const v = fn();
      if (v) return v;
      await sleep(gap);
    }
    return null;
  };

  // Mục "LS thay đổi deal" trong modal Tạo PO:
  // "10:03, 22/10/2026: Nguyễn Trung Toán thay đổi deal từ 25% thành 25% LT | LẬP THẮNG - #BG26936 (5.000 thùng…) - Giá trị 22.107.600đ"
  const DEAL_LINE_RE = /^(\d{1,2}:\d{2}),\s*(\d{1,2}\/\d{1,2}\/\d{4}):\s*(.+?)\s+thay đổi deal từ\s*([\d.,]+)%\s*thành\s*([\d.,]+)%\s*(\S+)\s*\|\s*(.+?)\s+-\s+#(BG\d+)\s*(?:\((.*)\))?\s*-\s*Giá trị\s*([\d.]+)\s*đ/i;
  function scrapeDealHist(modal) {
    const txt = modal?.innerText || '';
    const i = txt.search(/LS thay đổi deal/i);
    if (i < 0) return null;
    const lines = txt.slice(i).split('\n').map((l) => l.trim()).filter(Boolean);
    const out = [];
    for (const l of lines) {
      const m = l.match(DEAL_LINE_RE);
      if (!m) continue;
      out.push({ time: m[1], date: m[2], by: m[3], from: Number(m[4].replace(',', '.')), to: Number(m[5].replace(',', '.')), sup: m[6], supName: m[7].trim(), code: m[8].toUpperCase(), name: (m[9] || '').trim(), value: Number(m[10].replace(/\./g, '')) });
    }
    return out;
  }
  async function saveDealHist(modal, code) {
    const list = code && scrapeDealHist(modal);
    if (!list) return null;
    await kvMerge('dealHist', { [code]: { at: Date.now(), list } }).catch(() => {});
    return list;
  }
  // Mở "Lên PO → Giấy tấm" trong 1 document (trang hoặc khung ẩn) → trả về modal "Tạo PO cho báo giá"
  async function openPoGiayTam(doc) {
    const vis = () => [...doc.querySelectorAll('.ant-modal-wrap')].filter((m) => getComputedStyle(m).display !== 'none');
    const poBtn = [...doc.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Lên PO');
    if (!poBtn) throw new Error('Không thấy nút "Lên PO" trên trang.');
    for (const t of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) poBtn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
    const item = await waitFor(() => [...doc.querySelectorAll('.ant-dropdown .ant-dropdown-menu-item')].find((li) => li.innerText.trim() === 'Giấy tấm'), 4000);
    if (!item) throw new Error('Không thấy mục "Giấy tấm" trong Lên PO.');
    (item.querySelector('.ant-dropdown-menu-title-content > span') || item).click();
    const modal = await waitFor(() => vis().find((m) => /Tạo PO cho báo giá/.test(m.innerText)), 10000);
    if (!modal) throw new Error('Không mở được "Tạo PO cho báo giá".');
    await sleep(1500);
    return modal;
  }
  // Lịch sử deal của 1 báo giá: chưa có / cũ hơn 1 giờ → mở PO trong khung ẩn (chỉ đọc) để lấy
  // Mở PO giấy tấm trong khung ẩn (chỉ đọc): đọc tổng PO từng nhà cung cấp (margins.flexo) + lịch sử deal
  async function fetchDealHist(q) {
    await loadInFrame(q.id, undefined, undefined, async (f) => {
      await readFlexoCost(f, q);
    });
    renderCtx.margins = await kvGet('margins');
    return (await kvGet('dealHist'))[q.code]?.list || null;
  }
  // Giấy tấm Flexo của 1 báo giá: tổng PO (chỉ NCC giấy của dòng Flexo) + thu về; dùng được cả khi BG còn 0đ
  function flexoPaper(q) {
    const fi = flexoInfo(q);
    if (fi) return { paper: fi.best.total, code: fi.best.code, base: fi.base, diff: fi.diff, rest: fi.rest };
    const fx = renderCtx.margins?.[q?.code]?.flexo;
    if (!fx?.suppliers?.length) return null;
    const fxSup = kindTotalsOf(q)?.flexoSup?.length ? kindTotalsOf(q).flexoSup : q?.kindSup?.flexo || [];
    const own = fxSup.length ? fx.suppliers.filter((x) => fxSup.includes(x.code)) : [];
    const sups = own.length ? own : fx.suppliers;
    const paper = sups.reduce((a, x) => a + (x.total || 0), 0);
    return { paper, code: sups.map((x) => x.code).join(' + '), base: 0, diff: -paper, rest: null };
  }

  // Kéo thanh "% Deal" (antd Slider) tới đúng giá trị: phím mũi tên trên tay kéo, không ăn thì bấm thẳng vào thanh
  // PO vừa đổi nhà cung cấp có thể vẽ lại cả hộp → luôn tìm lại hộp "Tạo PO" và tay kéo mới nhất, chờ tới khi có
  const poModalNow = (doc = document) =>
    [...doc.querySelectorAll('.ant-modal-wrap')].filter((m) => m.isConnected && getComputedStyle(m).display !== 'none').find((m) => /Tạo PO cho báo giá/.test(m.innerText));
  const dealHandle = (modal) => {
    const m = modal?.isConnected && modal.querySelector('.ant-slider-handle') ? modal : poModalNow(modal?.ownerDocument || document);
    const doc = modal?.ownerDocument || document;
    return m?.querySelector('.ant-slider-handle') || doc.querySelector('.ant-modal-wrap .ant-slider-handle, .ant-modal-root .ant-slider-handle') || null;
  };
  async function setDealSlider(modal, pct) {
    let handle = await waitFor(() => dealHandle(modal), 15000, 250);
    if (!handle) {
      const doc = modal?.ownerDocument || document;
      throw new Error(`Không thấy thanh kéo "% Deal" trong PO (hộp PO: ${doc.querySelectorAll('.ant-modal-wrap').length}, thanh kéo trên trang: ${doc.querySelectorAll('.ant-slider-handle, [role=slider]').length}, ${modal?.isConnected ? 'hộp còn' : 'hộp đã mất'}).`);
    }
    await sleep(300);
    handle = dealHandle(modal) || handle;
    const val = () => {
      if (!handle.isConnected) handle = dealHandle(modal) || handle;
      return Number(handle.getAttribute('aria-valuenow'));
    };
    const key = (k) => handle.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, keyCode: k === 'ArrowRight' ? 39 : 37, which: k === 'ArrowRight' ? 39 : 37, bubbles: true, cancelable: true }));
    // đã đúng % sẵn (giữ từ nhà cung cấp trước) → lùi 1 rồi tiến 1 để CRM ghi nhận giá trị cho nhà đang chọn
    if (val() === pct) {
      key(pct > 0 ? 'ArrowLeft' : 'ArrowRight');
      await sleep(80);
    }
    for (let i = 0; i < 120 && val() !== pct; i++) {
      const before = val();
      key(before < pct ? 'ArrowRight' : 'ArrowLeft');
      await sleep(40);
      if (val() === before) break; // phím không có tác dụng → bấm vào thanh
      if ((before < pct && val() > pct) || (before > pct && val() < pct)) break; // bước nhảy lớn, đã vượt
    }
    if (val() !== pct) {
      const slider = handle.closest('.ant-slider');
      const min = Number(handle.getAttribute('aria-valuemin') || 0);
      const max = Number(handle.getAttribute('aria-valuemax') || 100);
      const r = slider.getBoundingClientRect();
      const x = r.left + (r.width * (pct - min)) / (max - min);
      const y = r.top + r.height / 2;
      for (const t of ['mousedown', 'mouseup', 'click']) slider.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      await sleep(200);
    }
    if (Math.abs(val() - pct) > 1) throw new Error(`Không kéo được % Deal tới ${pct}% (đang ${val()}%).`);
  }

  // Hộp xác nhận nhỏ (Popconfirm / Modal.confirm) sau khi bấm nút → bấm đồng ý
  async function confirmIfAsked() {
    await sleep(400);
    const pop = [...document.querySelectorAll('.ant-popover:not(.ant-popover-hidden) .ant-popover-buttons, .ant-popconfirm-buttons, .ant-modal-confirm-btns')]
      .find((x) => x.offsetParent);
    const ok = pop && [...pop.querySelectorAll('button')].find((b) => /^(OK|Đồng ý|Có|Xác nhận|Yes)$/i.test(b.innerText.trim()) || b.classList.contains('ant-btn-primary'));
    if (ok) {
      ok.click();
      await sleep(600);
    }
  }

  // Cột "Giá deal" của bảng Hàng hóa: số dòng còn 0 (set deal chưa ăn) / tổng số dòng
  function dealZeroRows() {
    const t = [...document.querySelectorAll('.ant-table')].find((x) => !x.closest('.ant-modal-wrap') && [...x.querySelectorAll('thead th')].some((th) => /^Giá deal/i.test(th.innerText.trim())));
    if (!t) return null;
    const hs = [...t.querySelectorAll('thead th')];
    const iD = hs.findIndex((th) => /^Giá deal/i.test(th.innerText.trim()));
    let zero = 0;
    let n = 0;
    for (const tr of t.querySelectorAll('.ant-table-tbody tr')) {
      if (tr.classList.contains('ant-table-measure-row') || !tr.innerText.trim()) continue;
      const c = tr.cells[iD];
      if (!c) continue;
      const v = Number((c.innerText.replace(/\d+(?:[.,]\d+)?\s*%/g, '').match(/[\d.,]+/) || ['0'])[0].replace(/[.,]/g, '')) || 0;
      n++;
      if (!v) zero++;
    }
    return n ? { zero, n } : null;
  }
  async function runSetPrice(q, pct, step, rowPct = {}) {
    // Set deal xong mà cột "Giá deal" vẫn 0 → set lại (tối đa 3 lượt) rồi mới lưu
    let done = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      done = await setDealOnce(q, pct, (t) => step(attempt > 1 ? `Lượt ${attempt}: ${t}` : t));
      step('Đóng PO, kiểm tra Giá deal…');
      (poModalNow() || document).querySelector('.ant-modal-close')?.click();
      await sleep(1500);
      let z = dealZeroRows();
      // dự phòng: "Tổng tiền 0 đ" dưới bảng Hàng hóa cũng là chưa ăn giá
      const tot = (document.body.innerText.match(/Tổng tiền\s*:?\s*([\d.,]+)\s*đ/) || [])[1];
      if ((!z || !z.zero) && tot != null && !Number(tot.replace(/[.,]/g, ''))) z = { zero: z?.n || 1, n: z?.n || 1 };
      if (!z || !z.zero) break;
      if (attempt === 3) throw new Error(`Đã set deal 3 lượt nhưng Giá deal vẫn 0 ở ${z.zero}/${z.n} dòng – kiểm tra PO giấy tấm rồi thử lại.`);
      step(`Giá deal vẫn 0 ở ${z.zero}/${z.n} dòng – set lại…`);
      await sleep(800);
    }
    await afterSetDeal(q, pct, step, rowPct, done);
  }
  async function setDealOnce(q, pct, step) {
    step('Mở Lên PO → Giấy tấm…');
    const modal = await openPoGiayTam(document);
    saveDealHist(modal, q.code);
    const chips = [];
    for (const b of modal.querySelectorAll('button.ant-btn')) {
      const t = b.innerText.trim();
      if (/^[A-Z][A-Z0-9_.&-]{1,12}$/.test(t) && t !== 'OUT' && !chips.some((c) => c.code === t)) chips.push({ code: t, btn: b });
    }
    const readTotal = () => Number(((poModalNow() || modal).innerText.match(/Tổng thanh toán:\s*([\d.]+)/) || [])[1]?.replace(/\./g, '') || 0);
    const done = [];
    for (const [i, ch] of (chips.length ? chips : [null]).entries()) {
      if (ch) {
        // "Set deal cho BG" của nhà trước có thể đã đóng hộp PO → mở lại để set tiếp nhà sau
        if (i > 0 && !poModalNow()) {
          step(`Nhà cung cấp ${ch.code} (${i + 1}/${chips.length}): mở lại Lên PO → Giấy tấm…`);
          await openPoGiayTam(document);
        }
        step(`Nhà cung cấp ${ch.code} (${i + 1}/${chips.length}): chọn…`);
        const chBtn = await waitFor(() => [...(poModalNow() || modal).querySelectorAll('button.ant-btn')].find((b) => b.isConnected && b.innerText.trim() === ch.code), 8000, 200);
        if (!chBtn) throw new Error(`Không thấy nút nhà cung cấp ${ch.code} trong PO (đã set: ${done.join(', ') || 'chưa'}).`);
        chBtn.click();
        // chờ PO của nhà này tải xong: "Tổng thanh toán" đứng yên 3 lần đọc
        let last = -1;
        let same = 0;
        for (let k = 0; k < 50 && same < 2; k++) {
          await sleep(400);
          const t = readTotal();
          same = t && t === last ? same + 1 : 0;
          last = t;
        }
      }
      step(`${ch ? `Nhà cung cấp ${ch.code}: ` : ''}kéo % Deal = ${pct}%…`);
      await setDealSlider(modal, pct);
      const setBtn = [...(poModalNow() || modal).querySelectorAll('button')].find((b) => /Set deal cho BG/i.test(b.innerText));
      if (!setBtn) throw new Error('Không thấy nút "Set deal cho BG".');
      step(`${ch ? `Nhà cung cấp ${ch.code}: ` : ''}bấm "Set deal cho BG"…`);
      setBtn.click();
      await confirmIfAsked();
      await sleep(1500);
      done.push(ch?.code || 'NCC');
    }
    return done;
  }
  async function afterSetDeal(q, pct, step, rowPct, done) {
    step('Lưu báo giá…');
    // % riêng từng dòng: giá sau khi set deal (đang = giấy tấm ÷ (1 − pct)) → giấy tấm ÷ (1 − % dòng)
    const custom = Object.entries(rowPct).filter(([, v]) => v != null && v !== pct);
    if (custom.length) {
      await sleep(700);
      const rows = flexoRowsForDialog();
      for (const [i, v] of custom) {
        const r = rows.find((x) => x.i === Number(i));
        if (!r?.cur) continue;
        step(`Dòng ${r.i + 1}: đặt riêng ${v}%…`);
        await setCellPrice(r.cell, Math.ceil((r.cur * (1 - pct / 100)) / (1 - v / 100)));
        await sleep(300);
      }
    }
    const saveBtn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Cập nhật');
    if (!saveBtn) throw new Error('Đã set deal nhưng không thấy nút "Cập nhật" để lưu báo giá – hãy tự bấm Cập nhật.');
    saveBtn.click();
    await confirmIfAsked();
    const ok = await waitFor(() => document.querySelector('.ant-message-success, .ant-notification-notice-success'), 10000, 250);
    try {
      localStorage.setItem('dgDealPct', String(pct));
    } catch {}
    step(ok ? `✅ Đã set ${pct}% cho ${done.join(', ')} và lưu báo giá – đang tải lại trang…` : 'Đã bấm Cập nhật – đang tải lại trang…');
    await sleep(1200);
    location.reload();
  }

  // Hộp chọn % (trong shadow root của bảng)
  // ---------- 💲 Set giá cho báo giá OFFSET ----------
  // Mỗi dòng sản phẩm: mở "Tính giá offset" (bấm ô Số lượng) → Ctrl+Shift+G → bảng chiết giá; lấy giá vốn ở bảng "Giá bán"
  // (ô cuối hàng tiêu đề, vd. 5.018đ). Giá mới = giá vốn ÷ (1 − % muốn bán). Điền vào "Giá thực bán" từng dòng rồi Cập nhật.
  function pageProductTable() {
    return [...document.querySelectorAll('.ant-table')].find((t) => [...t.querySelectorAll('thead th')].some((th) => /^Giá thực bán/i.test(th.innerText.trim())));
  }
  function offsetRowsForDialog(q) {
    const t = pageProductTable();
    if (!t) return [];
    const heads = [...t.querySelectorAll('thead th')];
    const pIdx = heads.findIndex((th) => /^Giá thực bán/i.test(th.innerText.trim()));
    const rows = [...t.querySelectorAll('.ant-table-tbody tr')].filter((tr) => !tr.classList.contains('ant-table-measure-row') && tr.innerText.trim());
    const prods = offEntries(renderCtx.margins?.[q.code], q.code).map(([, x]) => x);
    const used = new Set();
    return rows.map((tr, i) => {
      const txt = tr.innerText.replace(/\s+/g, ' ');
      const x = prods.find((p) => !used.has(p) && offRowFor([txt], p.spec, p.qty));
      if (x) used.add(x);
      const cell = tr.cells[pIdx];
      const cur = Number(String(cell?.querySelector('input')?.value || cell?.innerText || '').replace(/[^\d]/g, '')) || 0;
      return { i, tr, cell, x, cur, offset: /offset/i.test(txt) || !!x, name: (txt.match(/(Thùng|Hộp|Túi|Tem|Tờ)[^\d]{0,60}[\d]+D\s*x\s*\d+R\s*x\s*\d+C[^,]*/i) || [x?.spec || `Dòng ${i + 1}`])[0] };
    }).filter((r) => r.offset);
  }
  // Các dòng Flexo (không phải Offset) trong bảng Hàng hóa: tên + ô Giá thực bán + giá hiện tại
  function flexoRowsForDialog() {
    const t = pageProductTable();
    if (!t) return [];
    const heads = [...t.querySelectorAll('thead th')];
    const pIdx = heads.findIndex((th) => /^Giá thực bán/i.test(th.innerText.trim()));
    const qIdx = heads.findIndex((th) => /^Số lượng$/i.test(th.innerText.trim()));
    const tIdx = heads.findIndex((th) => /^Mã SP$/i.test(th.innerText.trim()));
    return [...t.querySelectorAll('.ant-table-tbody tr')]
      .filter((tr) => !tr.classList.contains('ant-table-measure-row') && tr.innerText.trim())
      .map((tr, i) => {
        const txt = tr.innerText.replace(/\s+/g, ' ');
        const cell = tr.cells[pIdx];
        const qty = qIdx >= 0 ? Number(String(tr.cells[qIdx]?.querySelector('input')?.value || tr.cells[qIdx]?.innerText || '').replace(/[^\d]/g, '')) || 0 : 0;
        const cur = Number(String(cell?.querySelector('input')?.value || cell?.innerText || '').replace(/[^\d]/g, '')) || 0;
        const name = (txt.match(/(Thùng|Hộp|Túi|Tem|Tờ|Vách|Giấy)[^\d]{0,60}[\d]+D\s*x\s*\d+R\s*x\s*\d+C/i) || [txt.slice(0, 60)])[0];
        const tp = ((tIdx >= 0 ? tr.cells[tIdx]?.innerText : txt) || '').match(/TP\d{3,}/)?.[0] || '';
        return { i, tr, cell, cur, qty, tp, name, offset: /offset/i.test(txt) };
      })
      .filter((r) => !r.offset && r.cell);
  }
  async function setCellPrice(cell, value) {
    let input = cell.querySelector('input');
    if (!input) {
      const target = [...cell.querySelectorAll('div, span')].find((e) => e.childElementCount === 0 && /\d/.test(e.textContent) && !e.closest('.dg-nudge')) || cell;
      for (const t of ['mousedown', 'mouseup', 'click', 'dblclick']) target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
      input = await waitFor(() => cell.querySelector('input'), 1500, 100);
    }
    if (!input) throw new Error('Không mở được ô "Giá thực bán" để điền giá.');
    const raw = String(input.value || '');
    const text = /[.,]/.test(raw) ? Math.round(value).toLocaleString('vi-VN') : String(Math.round(value));
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  }
  function openOffsetPriceDialog(q) {
    root.querySelector('.pdlg')?.remove();
    const pct0 = Number(lsGet('dgOffPct')) || 35;
    const box = document.createElement('div');
    box.className = 'pdlg';
    box.innerHTML = `<div class="pdlg-wrap"><div class="pdlg-card" style="width:min(720px,94vw)">
      <div class="pdlg-h">💲 Set giá ${esc(q.code)} <span class="muted">– Offset</span><button class="x" data-p="close">×</button></div>
      <div class="pdlg-q">Bán bao nhiêu %?</div>
      <div class="pdlg-v"><b>${pct0}%</b></div>
      <input type="range" min="5" max="60" step="1" value="${pct0}">
      <div class="pdlg-chips">${[25, 30, 32, 35, 38, 40, 42, 45, 50].map((v) => `<button class="act" data-v="${v}">${v}%</button>`).join('')}</div>
      <div class="pdlg-sum"></div>
      <div class="muted pdlg-note">Giá mới = NVL 1 thùng (dòng Tổng bảng "Nguyên liệu" của chiết giá) ÷ (1 − %) – giống hàng "Mốc NVL". Bấm Set giá: điền "Giá thực bán" từng dòng Offset, lưu báo giá rồi tải lại trang.</div>
      <div class="pdlg-step"></div>
      <div class="pdlg-btns"><button class="act" data-p="read">↻ Đọc lại chiết giá</button><button class="act" data-p="close">Huỷ</button><button class="act primary" data-p="go">✅ Set giá ${pct0}%</button></div>
    </div></div>`;
    root.append(box);
    const range = box.querySelector('input');
    const sumEl = box.querySelector('.pdlg-sum');
    let reading = false;
    const render2 = () => {
      const pct = Number(range.value);
      const rows = offsetRowsForDialog(q);
      if (!rows.length) return (sumEl.innerHTML = '<div class="muted">Không thấy dòng sản phẩm Offset trong bảng Hàng hóa.</div>');
      sumEl.innerHTML = `<table class="osp"><tr><th>Sản phẩm</th><th class="num">SL</th><th class="num">NVL 1 thùng</th><th class="num">Giá hiện tại</th><th class="num">Giá mới (${pct}%)</th></tr>${rows
        .map((r) => {
          const cost = r.x?.nvlUnit; // NVL 1 thùng (dòng Tổng bảng Nguyên liệu, vd. 1.078đ)
          const np = cost ? Math.ceil(cost / (1 - pct / 100)) : null;
          return `<tr><td>${esc(r.name)}</td><td class="num">${esc(r.x?.qty || '')}</td><td class="num">${cost ? money(cost) : reading ? '<span class="spinner"></span>' : '<span class="warnx">chưa đọc</span>'}</td><td class="num">${r.cur ? money(r.cur) : '0đ'}</td><td class="num"><b class="pos">${np ? money(np) : '–'}</b></td></tr>`;
        })
        .join('')}</table>`;
    };
    const sync = () => {
      box.querySelector('.pdlg-v b').textContent = `${range.value}%`;
      box.querySelector('[data-p="go"]').textContent = `✅ Set giá ${range.value}%`;
      render2();
    };
    let lastV = range.value;
    const poll = setInterval(() => {
      if (!box.isConnected) return clearInterval(poll);
      if (range.value !== lastV) {
        lastV = range.value;
        sync();
      }
    }, 120);
    const readNow = async () => {
      reading = true;
      render2();
      try {
        await loadInFrame(q.id, undefined, undefined, async (f) => readOffsetMargins(f, q.code));
        renderCtx.margins = await kvGet('margins');
      } finally {
        reading = false;
        render2();
      }
    };
    render2();
    // Chưa có giá vốn dòng nào → tự đọc chiết giá (khung ẩn, không bật hộp thoại in)
    if (offsetRowsForDialog(q).some((r) => !r.x?.nvlUnit)) readNow().catch(() => {});
    box.addEventListener('click', async (e) => {
      const v = e.target.closest('[data-v]')?.dataset.v;
      if (v) {
        range.value = v;
        return sync();
      }
      const act = e.target.closest('[data-p]')?.dataset.p;
      if (act === 'close') return box.remove();
      if (act === 'read') return readNow().catch(() => {});
      if (act !== 'go') return;
      const pct = Number(range.value);
      const stepEl = box.querySelector('.pdlg-step');
      const step = (t) => (stepEl.innerHTML = `<span class="spinner"></span> ${esc(t)}`);
      const rows = offsetRowsForDialog(q);
      const miss = rows.filter((r) => !r.x?.nvlUnit);
      if (miss.length) return (stepEl.innerHTML = `<span class="warnx">⚠️ Chưa có NVL 1 thùng của ${miss.length} dòng – bấm "↻ Đọc lại chiết giá".</span>`);
      box.querySelectorAll('button, input').forEach((x) => (x.disabled = true));
      try {
        for (const r of rows) {
          step(`Điền giá dòng ${r.i + 1}…`);
          await setCellPrice(r.cell, Math.ceil(r.x.nvlUnit / (1 - pct / 100)));
          await sleep(300);
        }
        try {
          localStorage.setItem('dgOffPct', String(pct));
        } catch {}
        step('Lưu báo giá…');
        const saveBtn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Cập nhật');
        if (!saveBtn) throw new Error('Đã điền giá nhưng không thấy nút "Cập nhật" – hãy tự bấm Cập nhật.');
        saveBtn.click();
        await confirmIfAsked();
        const ok = await waitFor(() => document.querySelector('.ant-message-success, .ant-notification-notice-success'), 10000, 250);
        step(ok ? `✅ Đã set ${pct}% cho ${rows.length} dòng Offset và lưu – đang tải lại trang…` : 'Đã bấm Cập nhật – đang tải lại trang…');
        await sleep(1200);
        location.reload();
      } catch (err) {
        stepEl.innerHTML = `<span class="warnx">⚠️ ${esc(err.message)}</span>`;
        box.querySelectorAll('button, input').forEach((x) => (x.disabled = false));
      }
    });
  }

  function openPriceDialog(q) {
    // Báo giá chỉ có Offset → hộp Set giá theo chiết giá Offset
    const kinds = q?.kinds || (q?.offset ? ['offset'] : []);
    if (kinds.includes('offset') && !kinds.includes('flexo')) return openOffsetPriceDialog(q);
    root.querySelector('.pdlg')?.remove();
    const pct0 = Number(lsGet('dgDealPct')) || 25;
    const box = document.createElement('div');
    box.className = 'pdlg';
    box.innerHTML = `<div class="pdlg-wrap"><div class="pdlg-hist"><div class="ph-h">📜 Lịch sử thay đổi deal</div><div class="ph-body muted">Đang tải…</div></div><div class="pdlg-card">
      <div class="pdlg-h">💲 Set giá ${esc(q.code)} <span class="muted">– Flexo</span><button class="x" data-p="close">×</button></div>
      <div class="pdlg-q">Bán bao nhiêu %?</div>
      <div class="pdlg-v"><b>${pct0}%</b></div>
      <input type="range" min="5" max="50" step="1" value="${pct0}">
      <div class="pdlg-chips">${[20, 22, 23, 25, 27, 28, 30, 32, 35].map((v) => `<button class="act" data-v="${v}">${v}%</button>`).join('')}</div>
      <div class="pdlg-sum"></div>
      <div class="pdlg-rows"></div>
      <div class="muted pdlg-note">Sẽ mở Lên PO → Giấy tấm, kéo % Deal cho từng nhà cung cấp, bấm "Set deal cho BG", lưu báo giá rồi tải lại trang.</div>
      <div class="pdlg-step"></div>
      <div class="pdlg-btns"><button class="act" data-p="close">Huỷ</button><button class="act primary" data-p="go">✅ Set giá ${pct0}%</button></div>
    </div></div>`;
    root.append(box);
    const range = box.querySelector('input');
    // Tổng mua giấy tấm / tổng thu về / chênh lệch (theo PO đã đọc) + ước tính theo % đang chọn
    const sumEl = box.querySelector('.pdlg-sum');
    let poLoading = true;
    const renderSum = () => {
      const fx = flexoPaper(q);
      if (!fx)
        return (sumEl.innerHTML = poLoading
          ? '<div class="muted"><span class="spinner"></span> Đang mở PO ẩn để đọc tổng giấy tấm…</div>'
          : '<div class="muted">Không đọc được giấy tấm (PO) của báo giá này.</div>');
      const pct = Number(range.value);
      const estBase = fx.paper / (1 - pct / 100);
      // 3 ô theo % đang chọn (có % riêng từng dòng thì renderTot ghi đè bằng tổng từng dòng); đổi số → nháy
      if (!sumEl.querySelector('.ps-grid'))
        sumEl.innerHTML = `<div class="ps-grid">
          <div class="ps-t" data-k="p"><span>Mua giấy tấm</span><b></b><small></small></div>
          <div class="ps-t" data-k="r"><span>Thu về (theo % chọn)</span><b></b><small></small></div>
          <div class="ps-t" data-k="d"><span>Chênh lệch</span><b></b><small></small></div>
        </div><div class="ps-est"></div>`;
      setTiles(fx.paper, estBase, `hiện tại ${fx.base ? trM(fx.base) : '0đ'}`, fx.code);
      sumEl.querySelector('.ps-est').innerHTML = `<span class="muted">Hiện tại: thu về ${fx.base ? trM(fx.base) : '0đ'}, chênh lệch ${fx.diff < 0 ? '−' : '+'}${trM(Math.abs(fx.diff))}${fx.rest != null ? ` (${fx.rest}%)` : ''} · ước tính = giấy tấm ÷ (1 − %)</span>`;
      renderTot?.();
    };
    // Ghi 3 ô + hiệu ứng khi số đổi
    const setTiles = (paper, rev, revNote, code) => {
      const diff = rev - paper;
      const put = (k, txt, small, cls) => {
        const t = sumEl.querySelector(`.ps-t[data-k="${k}"]`);
        if (!t) return;
        if (cls != null) t.className = `ps-t ${cls}`;
        const b = t.querySelector('b');
        if (b.textContent !== txt) {
          b.textContent = txt;
          t.classList.remove('bump');
          void t.offsetWidth;
          t.classList.add('bump');
        }
        t.querySelector('small').textContent = small;
      };
      put('p', trM(paper), code || '');
      put('r', trM(rev), revNote || '');
      put('d', `${diff < 0 ? '−' : '+'}${trM(Math.abs(diff))}`, rev ? `${((diff / rev) * 100).toFixed(1)}%` : '', diff < 0 ? 'neg' : 'pos');
    };
    // % riêng cho từng dòng Flexo (để trống = theo % chung)
    const rowPct = {};
    const rowsEl = box.querySelector('.pdlg-rows');
    const renderRows = () => {
      const rows = flexoRowsForDialog();
      if (rows.length < 2) return (rowsEl.innerHTML = '');
      const pct = Number(range.value);
      rowsEl.innerHTML = `<div class="pr-h">🎯 % riêng từng dòng <span class="muted">(để trống = theo ${pct}%)</span></div>${rows
        .map((r) => {
          const v = rowPct[r.i];
          return `<div class="pr-row${v != null && v !== pct ? ' own' : ''}"><span class="pr-no">${r.i + 1}</span><span class="pr-name" title="${esc(r.name)}">${esc(r.name)}</span>
            <span class="pr-cur">${r.cur ? money(r.cur) : '0đ'}</span>
            <span class="pr-ctl"><button class="act" data-rd="${r.i}" data-d="-1">−</button><input data-ri="${r.i}" inputmode="numeric" placeholder="${pct}" value="${v ?? ''}"><b>%</b><button class="act" data-rd="${r.i}" data-d="1">+</button></span><div class="pr-line" data-rl="${r.i}"></div></div>`;
        })
        .join('')}<div class="pr-tot"></div>`;
      renderTot();
    };
    // Tổng theo % từng dòng: giấy tấm chia cho từng dòng theo tỷ lệ thành tiền hiện tại → thành tiền mới = giấy tấm dòng ÷ (1 − % dòng)
    // Từng dòng: giấy tấm của dòng (theo Mã TP trong PO; chưa có thì chia theo tỷ lệ thành tiền ≈) → thành tiền = giấy tấm ÷ (1 − % dòng)
    var renderTot = () => {
      const el = rowsEl.querySelector('.pr-tot');
      const fx = flexoPaper(q);
      const byTp = renderCtx.margins?.[q.code]?.flexo?.byTp || {};
      const rows = flexoRowsForDialog();
      if (!el) return;
      if (!fx?.paper || !rows.length) return (el.innerHTML = '<span class="muted">Chưa có tổng giấy tấm (PO) để tính.</span>');
      const pct = Number(range.value);
      const known = rows.reduce((t, r) => t + (byTp[r.tp] || 0), 0);
      const restRows = rows.filter((r) => !byTp[r.tp]);
      const restCur = restRows.reduce((t, r) => t + r.cur * (r.qty || 0), 0);
      const restPaper = Math.max(0, fx.paper - known);
      const knownCur = rows.filter((r) => byTp[r.tp]).reduce((t, r) => t + r.cur * (r.qty || 0), 0);
      const knownRatio = knownCur ? known / knownCur : (fx.paper / (rows.reduce((t, r) => t + r.cur * (r.qty || 0), 0) || 1));
      let rev = 0;
      let paperSum = 0;
      for (const r of rows) {
        const exact = !!byTp[r.tp];
        const line0 = rowsEl.querySelector(`[data-rl="${r.i}"]`);
        // dòng không có trong PO (hoặc phần giấy còn lại = 0) → ước tính theo tỷ lệ giấy tấm / thành tiền của các dòng đã khớp PO
        const paper = exact
          ? byTp[r.tp]
          : restPaper > 0
            ? restCur ? (restPaper * r.cur * (r.qty || 0)) / restCur : restPaper / (restRows.length || 1)
            : r.cur * (r.qty || 0) * knownRatio;
        const p = rowPct[r.i] ?? pct;
        const tt = paper / (1 - p / 100);
        const d = tt - paper;
        rev += tt;
        paperSum += paper;
        const line = rowsEl.querySelector(`[data-rl="${r.i}"]`);
        if (line)
          line.innerHTML = `<span title="${exact ? `Giấy tấm theo PO (${esc(r.tp)})` : `Ước tính: PO không có dòng mã ${esc(r.tp || '?')} → tính theo tỷ lệ giấy tấm / thành tiền của các dòng khác`}">GT ${exact ? '' : '≈'}<b>${trM(paper)}</b></span><span>TT <b>${trM(tt)}</b>${r.qty ? ` <i>(${money(Math.ceil(tt / r.qty))}/c)</i>` : ''}</span><span class="${d < 0 ? 'neg' : 'pos'}">CL <b>${d < 0 ? '−' : '+'}${trM(Math.abs(d))}</b></span>`;
      }
      const diff = rev - paperSum;
      setTiles(paperSum, rev, `cộng từng dòng · hiện tại ${fx.base ? trM(fx.base) : '0đ'}`, fx.code);
      el.innerHTML = `<div class="ps-grid"><div class="ps-t"><span>Tổng mua giấy tấm</span><b>${trM(paperSum)}</b><small>${esc(fx.code)}</small></div>
        <div class="ps-t"><span>Tổng thành tiền</span><b>${trM(rev)}</b><small>cộng từng dòng</small></div>
        <div class="ps-t ${diff < 0 ? 'neg' : 'pos'}"><span>Chênh lệch</span><b>${diff < 0 ? '−' : '+'}${trM(Math.abs(diff))}</b><small>${rev ? `${((diff / rev) * 100).toFixed(1)}%` : ''}</small></div></div>`;
    };
    rowsEl.addEventListener('input', (e) => {
      const i = e.target.dataset?.ri;
      if (i == null) return;
      const n = parseFloat(String(e.target.value).replace(',', '.'));
      if (Number.isFinite(n) && n > 0 && n < 90) rowPct[i] = n;
      else delete rowPct[i];
      e.target.closest('.pr-row').classList.toggle('own', rowPct[i] != null && rowPct[i] !== Number(range.value));
      syncGo();
      renderTot();
    });
    const syncGo = () => {
      const own = Object.values(rowPct).filter((v) => v !== Number(range.value)).length;
      box.querySelector('[data-p="go"]').textContent = `✅ Set giá ${range.value}%${own ? ` (+${own} dòng riêng)` : ''}`;
    };
    const sync = () => {
      box.querySelector('.pdlg-v b').textContent = `${range.value}%`;
      syncGo();
      renderSum();
      renderRows();
    };
    renderSum();
    renderRows();
    // Tính lại khi kéo: nghe nhiều sự kiện + dò giá trị định kỳ (bộ gõ / trang có thể chặn sự kiện "input")
    let lastV = range.value;
    const onMove = () => {
      if (range.value === lastV) return;
      lastV = range.value;
      sync();
    };
    for (const ev of ['input', 'change', 'pointermove', 'pointerup', 'mousemove', 'mouseup', 'keyup', 'touchmove']) range.addEventListener(ev, onMove);
    const poll = setInterval(() => (box.isConnected ? onMove() : clearInterval(poll)), 120);
    // Lịch sử deal (cột trái): bấm % ở 1 dòng → dùng mức đó
    const histBody = box.querySelector('.ph-body');
    const showHist = (list, note = '') => {
      if (!list?.length) return (histBody.innerHTML = `<span class="muted">${note || 'Chưa có lịch sử thay đổi deal.'}</span>`);
      histBody.innerHTML = `${note ? `<div class="muted ph-note">${esc(note)}</div>` : ''}${list
        .slice(0, 30)
        .map((x) => `<div class="ph-row${x.code === q.code ? ' me' : ''}">
          <div class="ph-top"><span class="ph-date">${esc(x.time)} ${esc(x.date)}</span><span class="ph-sup" title="${esc(x.supName)}">${esc(x.sup)}</span>
            <button class="ph-pct" data-v="${x.to}" title="Dùng mức ${x.to}%">${x.from}% → <b>${x.to}%</b></button></div>
          <div class="ph-bg"><b>#${esc(x.code)}</b> ${esc(x.name)} · <b>${money(x.value)}</b></div></div>`)
        .join('')}`;
    };
    kvGet('dealHist').then(async (all) => {
      const cached = all[q.code];
      if (cached) showHist(cached.list, `Lúc ${new Date(cached.at).toLocaleString('vi-VN')}`);
      const needPo = !flexoPaper(q) || !renderCtx.margins?.[q.code]?.flexo?.byTp || !Object.keys(renderCtx.margins[q.code].flexo.byTp).length;
      if (!needPo) {
        poLoading = false;
        renderSum();
      }
      if (!cached || Date.now() - cached.at > 3600e3 || needPo) {
        if (!cached) histBody.innerHTML = '<span class="spinner"></span> Đang mở PO ẩn để đọc lịch sử…';
        try {
          const list = await fetchDealHist(q);
          if (list) showHist(list, 'Vừa cập nhật');
          else if (!cached) showHist(null, 'Không đọc được lịch sử deal.');
        } catch (err) {
          if (!cached) showHist(null, `Không đọc được: ${err.message}`);
        }
        poLoading = false;
        renderSum();
      }
    });
    box.addEventListener('click', async (e) => {
      const rd = e.target.closest('[data-rd]');
      if (rd) {
        const i = rd.dataset.rd;
        rowPct[i] = Math.max(1, Math.min(80, (rowPct[i] ?? Number(range.value)) + Number(rd.dataset.d)));
        renderRows();
        return syncGo();
      }
      const v = e.target.closest('[data-v]')?.dataset.v;
      if (v) {
        range.value = v;
        return sync();
      }
      const act = e.target.closest('[data-p]')?.dataset.p;
      if (act === 'close') return box.remove();
      if (act !== 'go') return;
      const pct = Number(range.value);
      box.querySelectorAll('button, input').forEach((x) => (x.disabled = true));
      const stepEl = box.querySelector('.pdlg-step');
      const step = (t) => (stepEl.innerHTML = `<span class="spinner"></span> ${esc(t)}`);
      try {
        await runSetPrice(q, pct, step, { ...rowPct });
      } catch (err) {
        stepEl.innerHTML = `<span class="warnx">⚠️ ${esc(err.message)}</span>`;
        box.querySelectorAll('button, input').forEach((x) => (x.disabled = false));
      }
    });
  }

  // ---------- 🖨 In báo giá → chụp hình → dán vào ô bình luận ----------
  // Bấm nút "In" của CRM (hook.js chặn hộp thoại in), đợi iframe#printWindow có "BẢNG BÁO GIÁ",
  // dựng lại thành ảnh PNG (SVG foreignObject), che SĐT khách bằng dấu *, rồi dán vào ô bình luận như Ctrl+V.
  const PHONE_RE = /(\+?84|0)[\d.\s-]{8,13}\d/g;
  function blurCustomerPhones(root0) {
    const walker = root0.ownerDocument.createTreeWalker(root0, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!PHONE_RE.test(n.nodeValue)) continue;
      PHONE_RE.lastIndex = 0;
      // chỉ dòng SĐT của khách ("SDT:" / "SĐT:"), không làm mờ "Điện thoại: … (Mr Thịnh)" của công ty
      const line = (n.parentElement?.closest('p, div, td, tr, li') || n.parentElement)?.textContent || '';
      if (/S[ĐD]T\s*:/i.test(line) && !/Điện thoại/i.test(line)) hits.push(n);
    }
    for (const n of hits) {
      const doc = n.ownerDocument;
      const frag = doc.createDocumentFragment();
      let last = 0;
      n.nodeValue.replace(PHONE_RE, (m, _a, i) => {
        frag.append(doc.createTextNode(n.nodeValue.slice(last, i)));
        // che bằng dấu sao ở giữa: giữ 3 số đầu + 3 số cuối (0374164311 → 037****311)
        const d = m.replace(/\D/g, '');
        frag.append(doc.createTextNode(d.length > 6 ? `${d.slice(0, 3)}${'*'.repeat(d.length - 6)}${d.slice(-3)}` : '*'.repeat(d.length)));
        last = i + m.length;
        return m;
      });
      frag.append(doc.createTextNode(n.nodeValue.slice(last)));
      n.replaceWith(frag);
    }
    return hits.length;
  }
  // Chữ ký dưới "Trưởng bộ phận (Ký và ghi rõ họ tên)": đặt nổi trong khoảng trống ký tên, không đẩy lệch bố cục
  // Chữ ký "mực thật", mỗi lần in khác nhau ±3%: xoay, co giãn, nghiêng, lệch nhẹ; tô lại màu mực xanh bút bi,
  // độ đậm nhạt không đều + viền loang nhẹ như mực thấm giấy
  async function inkSignature(src) {
    const img = new Image();
    img.src = src;
    await img.decode();
    const r = (a) => (Math.random() * 2 - 1) * a; // ngẫu nhiên trong ±a
    // ảnh chữ ký lớn (chụp điện thoại vài nghìn px) → thu về cao ≤ 160px trước khi xử lý, tránh treo khi chụp báo giá
    const K = Math.min(1, 160 / (img.height || 160));
    const iw = img.width * K;
    const ih = img.height * K;
    const S = 2; // vẽ gấp đôi cho nét mịn
    const pad = 0.12; // chừa lề cho phần xoay / nghiêng
    const w = Math.round(iw * (1 + 2 * pad) * S);
    const h = Math.round(ih * (1 + 2 * pad) * S);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.translate(w / 2 + r(3 * S), h / 2 + r(2 * S));
    ctx.rotate((r(3) * Math.PI) / 180); // xoay ±3°
    ctx.transform(1, r(0.02), r(0.03), 1, 0, 0); // nghiêng nhẹ
    ctx.scale(S * (1 + r(0.03)), S * (1 + r(0.03))); // co giãn ±3%
    ctx.filter = 'blur(0.35px)'; // mực thấm giấy
    ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
    ctx.filter = 'none';
    // tô lại màu mực + đậm nhạt không đều
    const ink = [22 + r(8), 42 + r(10), 128 + r(16)]; // xanh mực bút bi
    const d = ctx.getImageData(0, 0, w, h);
    const px = d.data;
    let seed = Math.random() * 1000;
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      if (!a) continue;
      // ảnh gốc nền trắng: độ mực = độ tối của điểm (nền trắng → trong suốt)
      const lum = (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) / 255;
      const strength = Math.max(0, Math.min(1, (0.97 - lum) / 0.6));
      if (strength <= 0) {
        px[i + 3] = 0;
        continue;
      }
      seed = (seed * 9301 + 49297) % 233280; // nhiễu nhanh
      const n = seed / 233280;
      const dens = 0.8 + 0.2 * n; // đậm nhạt theo điểm như mực bút bi
      px[i] = ink[0] * (0.9 + 0.2 * n);
      px[i + 1] = ink[1] * (0.9 + 0.2 * n);
      px[i + 2] = ink[2] * (0.92 + 0.12 * n);
      px[i + 3] = Math.min(255, a * Math.pow(strength, 0.8) * dens * 1.1);
    }
    ctx.putImageData(d, 0, 0);
    return { src: c.toDataURL('image/png'), height: Math.round((h / S) * (64 / ih)) };
  }

  // Lấy ngầm chữ ký NVKD: 1 lần / ngày mở trang Nhân sự trong khung ẩn, gõ tên từng NVKD vào ô tìm → hook.js đọc signImage
  async function collectStaffSigns() {
    if (!IS_TOP || !MY_ADMIN || !renderCtx.quotes) return;
    if (Date.now() - Number(lsGet('dgStaffSignAt') || 0) < 24 * 3600e3) return;
    lsSet('dgStaffSignAt', String(Date.now()));
    const names = [...new Set(Object.values(renderCtx.quotes).map((q) => q?.staff?.name).filter(Boolean))].slice(0, 30);
    if (!names.length) return;
    const f = document.createElement('iframe');
    f.name = 'dg-collector';
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1400px;height:900px;visibility:hidden;pointer-events:none';
    f.src = '/nhan-su?t=nhan-su';
    document.documentElement.append(f);
    try {
      let inp = null;
      for (let i = 0; i < 40 && !inp; i++) {
        await sleep(500);
        inp = [...(f.contentDocument?.querySelectorAll('input') || [])].find((x) => /tìm|search/i.test(x.placeholder || ''));
      }
      if (!inp) return;
      await sleep(1500);
      for (const n of names) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, n);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        await sleep(3000);
      }
    } finally {
      f.remove();
    }
  }
  setTimeout(() => collectStaffSigns().catch(() => {}), 90e3);
  // Chữ ký NVKD dưới "Người biên soạn": tên NVKD in trên báo giá có trong kho chữ ký (signImgs) → chèn ảnh
  async function addSaleSignature(root0) {
    const imgs = await kvGet('signImgs').catch(() => ({}));
    const nf = (x) => String(x || '').normalize('NFC').replace(/\s+/g, ' ').toLowerCase();
    const text = nf(root0.textContent);
    // tên NVKD in trên báo giá; không thấy thì lấy NVKD của báo giá đang mở
    const q = renderCtx.quotes?.[currentQuoteId()];
    const staff = nf(q ? staffOf(q, renderCtx.comments?.[q.id]) : '');
    const pick = (ks) => ks.filter((n) => text.includes(nf(n))).sort((a, b) => b.length - a.length)[0] || ks.find((n) => staff && nf(n) === staff);
    let keys = Object.keys(imgs || {}).filter((n) => imgs[n]?.img);
    let name = pick(keys);
    // chưa có ảnh trong kho nhưng đã có đường dẫn chữ ký (trang Nhân sự) → tải qua background (extension ≥ 1.7.2), lưu signImgs
    if (!name) {
      const signs = await kvGet('staffSigns').catch(() => ({}));
      const sn = pick(Object.keys(signs || {}).filter((n) => signs[n]?.sign));
      if (sn) {
        try {
          const img = await Promise.race([rawCall({ type: 'http.dataUrl', url: signs[sn].sign }), sleep(6000).then(() => null)]);
          if (/^data:image\//.test(img || '')) {
            await kvMerge('signImgs', { [sn]: { url: signs[sn].sign, img, at: Date.now() } });
            imgs[sn] = { img };
            keys = [...keys, sn];
            name = sn;
          }
        } catch (e) {
          console.warn('[DG] chữ ký NVKD: tải ảnh lỗi', sn, e.message);
        }
      } else if (MY_ADMIN) lsSet('dgStaffSignAt', '0'); // chưa có đường dẫn → lần tới đọc lại trang Nhân sự
    }
    if (!name) {
      console.warn('[DG] chữ ký NVKD: không thấy', { có: keys, staff });
      return false;
    }
    return addSignature(root0, imgs[name].img, /^Người biên soạn$/i);
  }
  async function addSignature(root0, sig0 = globalThis.DG_SIGNATURE, labelRe = /^Trưởng bộ phận$/i) {
    let sig = sig0;
    if (!sig) return false;
    let sigH = 64;
    try {
      const ink = await inkSignature(sig);
      sig = ink.src;
      sigH = ink.height; // giữ cỡ nét như bản gốc (64px) dù canvas có lề
    } catch {}
    const label = [...root0.querySelectorAll('*')].find((e) => e.childElementCount === 0 && labelRe.test(e.textContent.trim()));
    if (!label) return false;
    // khối của cột ký: ô bảng chứa nhãn, hoặc thẻ cha chứa cả "(Ký và ghi rõ họ tên)"
    let col = label.closest('td, th');
    if (!col) {
      col = label.parentElement;
      while (col && col !== root0 && !/Ký và ghi rõ/i.test(col.textContent)) col = col.parentElement;
      col = col && col !== root0 ? col : label.parentElement;
    }
    const doc = root0.ownerDocument;
    const img = doc.createElement('img');
    img.setAttribute('src', sig);
    img.setAttribute('style', `position:absolute;left:50%;top:100%;transform:translateX(-50%);height:${sigH}px;width:auto;margin-top:-6px;pointer-events:none;`);
    const pos = (col.getAttribute('style') || '');
    col.setAttribute('style', `${pos};position:relative;`);
    col.append(img);
    return true;
  }
  // Khung xác nhận duyệt giá dưới "Trưởng Phòng": người duyệt, đơn vị, ngày giờ.
  // Chỉ là xác nhận nội bộ – KHÔNG giả dạng chữ ký số (không có dấu "chữ ký hợp lệ" / chứng thư).
  const APPROVE_ORG = SITE.org;
  function addApproval(root0, signed = true) {
    const label = [...root0.querySelectorAll('*')].find((e) => e.childElementCount === 0 && /^Trưởng Phòng$/i.test(e.textContent.trim()));
    if (!label) return false;
    label.textContent = 'Ban lãnh đạo'; // chức danh ở cột duyệt
    const doc = root0.ownerDocument;
    const now = new Date();
    const when = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
    // Đại Dương: khung kiểu "con dấu" nền xanh lá + dấu tick lớn mờ (bố cục giống mẫu ô ký của hoá đơn),
    // nhưng chỉ ghi là ĐÃ DUYỆT GIÁ – không ghi "ký điện tử / Signed digitally" vì đây không phải chữ ký số có chứng thư
    if (SITE.key === 'daiduong') {
      const day = now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' });
      const st = doc.createElement('div');
      st.setAttribute('style', 'display:inline-block;margin-top:2px;border:1px solid #1e293b;padding:2px;background:#fff;text-align:center;max-width:240px;font-family:Arial,Helvetica,sans-serif;line-height:1.2;');
      st.innerHTML = `<div style="font-size:10px;font-weight:700;color:#1e2f86;margin:1px 0 2px">Người duyệt giá <i style="font-weight:400">(Approver)</i></div>
        <div style="position:relative;background:#dff3d0;padding:3px 5px;color:#1e2f86;overflow:hidden">
          <svg viewBox="0 0 100 80" style="position:absolute;left:50%;top:50%;width:46px;height:37px;transform:translate(-50%,-50%);opacity:.45" aria-hidden="true"><path d="M8 44 L36 70 L92 10" fill="none" stroke="#3fae2a" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <div style="position:relative;font-size:9.5px;font-weight:700">Đã duyệt giá bởi <i style="font-weight:400">(Approved by)</i></div>
          <div style="position:relative;font-size:9px;font-weight:700;white-space:nowrap">${esc(APPROVE_ORG)}</div>
          <div style="position:relative;font-size:8.5px">${signed ? `${esc(meName)} · ` : ''}Ngày: ${esc(day)}</div></div>`;
      // đặt vào khoảng trống ký tên dưới "Trưởng bộ phận (Ký và ghi rõ họ tên)" (thay chữ ký); không có thì dưới "Ban lãnh đạo"
      const tb = [...root0.querySelectorAll('*')].find((e) => e.childElementCount === 0 && /^Trưởng bộ phận$/i.test(e.textContent.trim()));
      let col = tb && (tb.closest('td, th') || tb.parentElement);
      if (tb && !tb.closest('td, th')) {
        let c = tb.parentElement;
        while (c && c !== root0 && !/Ký và ghi rõ/i.test(c.textContent)) c = c.parentElement;
        if (c && c !== root0) col = c;
      }
      if (col) {
        st.style.position = 'absolute';
        st.style.left = '50%';
        st.style.top = '100%';
        st.style.transform = 'translateX(-50%)';
        // Đo trên trang in gốc (đã dàn trang): khoảng trống giữa cột ký tên và chữ "Ban lãnh đạo" + chiều cao khung
        // → đặt khung đúng giữa khoảng trống, canh giữa theo chữ "Ban lãnh đạo"
        let mt = 22;
        let left = '50%';
        try {
          const pd = state.printDoc;
          const leaf = (re) => [...pd.querySelectorAll('*')].find((e) => e.childElementCount === 0 && re.test(e.textContent.trim()));
          const tb0 = leaf(/^Trưởng bộ phận$/i);
          let col0 = tb0 && (tb0.closest('td, th') || tb0.parentElement);
          if (tb0 && !tb0.closest('td, th')) {
            let c = tb0.parentElement;
            while (c && c !== pd.body && !/Ký và ghi rõ/i.test(c.textContent)) c = c.parentElement;
            if (c && c !== pd.body) col0 = c;
          }
          const ban0 = leaf(/^(Trưởng Phòng|Ban lãnh đạo)$/i);
          if (col0 && ban0) {
            const cr = col0.getBoundingClientRect();
            const br = ban0.getBoundingClientRect();
            const probe = st.cloneNode(true);
            probe.style.cssText += ';position:absolute;visibility:hidden;left:0;top:0;';
            pd.body.append(probe);
            const h = probe.getBoundingClientRect().height;
            probe.remove();
            const gap = br.top - cr.bottom;
            if (gap > 0 && h > 0) mt = Math.max(2, Math.round((gap - h) / 2));
            const dx = br.left + br.width / 2 - (cr.left + cr.width / 2);
            if (cr.width > 0) left = `${50 + (dx / cr.width) * 100}%`;
          }
        } catch {}
        st.style.left = left;
        st.style.marginTop = `${mt}px`;
        st.style.whiteSpace = 'normal';
        st.style.width = 'auto';
        col.setAttribute('style', `${col.getAttribute('style') || ''};position:relative;`);
        col.append(st);
        return true;
      }
      const wrap0 = doc.createElement('div');
      wrap0.setAttribute('style', 'text-align:center;');
      wrap0.append(st);
      (label.closest('td, th') || label.parentElement).append(wrap0);
      return true;
    }
    const box = doc.createElement('div');
    box.setAttribute('style', 'display:inline-block;margin-top:4px;padding:4px 8px;border:1px solid #94a3b8;border-radius:4px;font-size:10px;line-height:1.35;text-align:left;color:#334155;background:#f8fafc;white-space:normal;max-width:230px;');
    const line = (t, b = false) => {
      const d = doc.createElement('div');
      if (b) d.setAttribute('style', 'font-weight:700;color:#0f172a;');
      d.textContent = t;
      return d;
    };
    // dòng tiêu đề có tick xanh "đã duyệt" (xác nhận duyệt giá nội bộ, không phải dấu xác thực chữ ký số)
    const head = doc.createElement('div');
    head.setAttribute('style', 'display:flex;align-items:center;gap:4px;font-weight:700;color:#15803d;');
    const tick = doc.createElement('span');
    tick.setAttribute('style', 'display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#16a34a;color:#fff;font-size:10px;line-height:1;');
    tick.textContent = '✓';
    head.append(tick, doc.createTextNode('Đã duyệt giá'));
    box.setAttribute('style', box.getAttribute('style').replace('border:1px solid #94a3b8', 'border:1px solid #86efac').replace('background:#f8fafc', 'background:#f0fdf4'));
    // Không ký tên → không ghi tên người duyệt, chỉ ghi "Người phê duyệt: Giám đốc"
    box.append(head, line(signed ? `Người duyệt: ${meName}` : 'Người phê duyệt: Giám đốc'), line(`Đơn vị: ${APPROVE_ORG}`), line(`Ngày duyệt: ${when}`));
    const wrap = doc.createElement('div');
    wrap.setAttribute('style', 'text-align:center;');
    wrap.append(box);
    (label.closest('td, th') || label.parentElement).append(wrap);
    return true;
  }
  const blobToDataUrl = (b) => new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(b);
  });
  // Ảnh khổ A4 đứng: 794 × 1123 px (96 dpi), lề như trang in; nội dung dài hơn 1 trang thì ảnh cao thêm
  // Ảnh khổ A4 đứng, zoom 80%: nội dung dàn trên bề ngang A4 ÷ 0,8 rồi thu 80% (vừa khổ A4 như khi in "Scale 80%").
  // Vẽ lên khung rộng dư, dò điểm ảnh để tìm đúng vùng có nội dung (không phụ thuộc số đo bố cục) rồi cắt sát,
  // chừa lề mỏng đều hai bên; giữ tỉ lệ A4 (cao ≥ rộng × 1,414).
  const A4 = { w: 794, ratio: 1.4142, m: 16, zoom: 0.8 };
  // Vùng có nội dung (điểm ảnh không trắng) của 1 canvas
  function inkBox(ctx, w, h) {
    const d = ctx.getImageData(0, 0, w, h).data;
    let l = w, t = h, r = -1, b = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = (y * w + x) * 4;
        if (d[k + 3] > 10 && (d[k] < 240 || d[k + 1] < 240 || d[k + 2] < 240)) {
          if (x < l) l = x;
          if (x > r) r = x;
          if (y < t) t = y;
          if (y > b) b = y;
        }
      }
    }
    return r < 0 ? null : { l, t, r: r + 1, b: b + 1 };
  }
  // Watermark chéo "TUAN TU PACKAGING" lặp khắp ảnh báo giá (mờ, không che chữ)
  function drawWatermark(ctx, w, h) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const fs = Math.round(w / 16);
    ctx.font = `900 ${fs}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle = 'rgba(220, 38, 38, 0.03)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 6);
    const text = SITE.watermark;
    const stepX = ctx.measureText(text).width + fs * 2;
    const stepY = fs * 4;
    const R = Math.hypot(w, h);
    for (let y = -R; y <= R; y += stepY)
      for (let x = -R + ((Math.round(y / stepY) % 2) * stepX) / 2; x <= R; x += stepX) ctx.fillText(text, x, y);
    ctx.restore();
  }
  async function docToPng(doc, scale = 2) {
    const body = doc.body;
    // Báo giá chỉ 1 dòng sản phẩm → chụp 90%; nhiều dòng → thu 80% cho vừa trang
    const prodRows = [...doc.querySelectorAll('table')]
      .filter((t) => /SẢN PHẨM/i.test(t.innerText) && /THÀNH TIỀN/i.test(t.innerText))
      .flatMap((t) => [...t.rows].filter((r) => /^\s*\d+\s*$/.test(r.cells[0]?.innerText || '')));
    const zoom = prodRows.length <= 1 ? 0.9 : A4.zoom; // 1 dòng: 90% (100% chữ quá to, xuống dòng nhiều)
    const layoutW = Math.round(A4.w / zoom); // bề ngang dàn trang trước khi thu
    const clone = body.cloneNode(true);
    clone.querySelectorAll('script, link, iframe').forEach((x) => x.remove());
    const blurred = blurCustomerPhones(clone);
    // Mẫu báo giá Đại Dương: dòng "Số: BG…/n" đặt nổi (absolute) theo khổ in → khi chụp bị đè lên đường kẻ / mất
    // → bỏ chỗ cũ, chèn lại 1 dòng canh phải ngay trên tiêu đề "BẢNG BÁO GIÁ"
    {
      const num = [...clone.querySelectorAll('*')].find((e) => /^Số:\s*BG\d+/i.test((e.textContent || '').trim()) && (e.textContent || '').length < 40 && ![...e.children].some((c) => /^Số:/i.test((c.textContent || '').trim())));
      const title = [...clone.querySelectorAll('*')].find((e) => !e.children.length && /^BẢNG BÁO GIÁ$/i.test((e.textContent || '').trim()));
      if (num && title) {
        // tiêu đề giữa + "Số: …" bên phải trên CÙNG 1 hàng, cách đường kẻ đều (cân đối)
        const t = num.textContent.trim();
        num.remove();
        const d = clone.ownerDocument;
        const row = d.createElement('div');
        row.setAttribute('style', 'position:relative;display:flex;align-items:center;justify-content:center;margin:14px 0 10px;min-height:34px;');
        const tt = d.createElement('div');
        tt.setAttribute('style', 'font-size:30px;font-weight:800;letter-spacing:.5px;');
        tt.textContent = title.textContent.trim();
        const nn = d.createElement('div');
        nn.setAttribute('style', 'position:absolute;right:0;top:50%;transform:translateY(-50%);font-size:16px;font-weight:700;white-space:nowrap;');
        nn.textContent = t;
        row.append(tt, nn);
        // thay cả khối tiêu đề (thẻ chứa chữ BẢNG BÁO GIÁ, giữ chỗ trong bố cục)
        let host = title;
        // chỉ leo lên thẻ cha khi thẻ đó chỉ chứa đúng chữ tiêu đề (tránh xoá nhầm nội dung khác)
        while (host.parentElement && host.parentElement !== clone && (host.parentElement.textContent || '').trim() === title.textContent.trim()) host = host.parentElement;
        host.replaceWith(row);
      }
    }
    // Đại Dương: cột Đơn giá thêm "đ" + canh phải; khu tổng (Tổng tiền / Thuế / Tổng tiền thanh toán) in đậm
    if (SITE.key === 'daiduong') {
      for (const t of clone.querySelectorAll('table')) {
        const head = [...t.rows].find((r) => /Đơn giá/i.test(r.innerText || r.textContent));
        if (!head) continue;
        const hi = [...head.cells].findIndex((c) => /^Đơn giá$/i.test(c.textContent.trim()));
        if (hi >= 0) head.cells[hi].style.textAlign = 'right';
        for (const r of t.rows) {
          const txt = (r.textContent || '').trim();
          if (/^(Tổng tiền|Thuế giá trị gia tăng|Tổng tiền thanh toán)/i.test(txt.replace(/^\s+/, '')) || /Tổng tiền|Thuế giá trị gia tăng/i.test([...r.cells].slice(0, -1).map((c) => c.textContent).join(' '))) {
            for (const c of r.cells) {
              c.style.fontWeight = '700';
              c.style.background = '#f1f5f9';
            }
            continue;
          }
          if (r === head || hi < 0) continue;
          const c = r.cells[hi];
          if (!c || r.cells.length !== head.cells.length) continue;
          const v = c.textContent.trim();
          if (/^[\d.,]+$/.test(v)) c.textContent = `${v} đ`;
          c.style.textAlign = 'right';
        }
      }
    }
    if (signOn() && SITE.bossSign) await addSignature(clone);
    // chữ ký NVKD (Người biên soạn) – tối đa 8s, quá thì chụp không có chữ ký (không để kẹt "Đang chụp…")
    await Promise.race([addSaleSignature(clone).catch(() => {}), sleep(8000)]);
    state.printDoc = doc; // trang in gốc (đã dàn trang) – để đo vị trí khung duyệt
    addApproval(clone, signOn());
    // ảnh (logo…) → data URL để canvas không bị "bẩn"
    for (const img of clone.querySelectorAll('img')) {
      try {
        const src = img.getAttribute('src');
        if (src && !src.startsWith('data:')) img.setAttribute('src', await blobToDataUrl(await (await fetch(new URL(src, doc.baseURI))).blob()));
      } catch {
        img.remove();
      }
    }
    const css = [...doc.styleSheets]
      .map((ss) => {
        try {
          // rule trong @media print áp luôn (ảnh chụp ở chế độ màn hình nên phải "mở" khối print ra)
          return [...ss.cssRules]
            .map((r) => (r.media && /print/i.test(r.media.mediaText || '') ? [...r.cssRules].map((x) => x.cssText).join('\n') : r.cssText))
            .join('\n');
        } catch {
          return '';
        }
      })
      .join('\n');
    const bcs = getComputedStyle(body);
    const inner = document.createElement('div');
    inner.setAttribute('style', `${body.getAttribute('style') || ''};font-family:${bcs.fontFamily};font-size:${bcs.fontSize};color:${bcs.color};width:${layoutW}px;margin:0;padding:${bcs.marginTop} ${bcs.marginRight} ${bcs.marginBottom} ${bcs.marginLeft};background:#fff;box-sizing:border-box;`);
    if (body.className) inner.setAttribute('class', body.className);
    const st = document.createElement('style');
    st.textContent = `${css}\n@page{margin:0} body{margin:0}`;
    inner.append(st, ...clone.childNodes);
    const wrap = document.createElement('div');
    wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    wrap.setAttribute('style', `zoom:${zoom};background:#fff;display:inline-block;`);
    wrap.append(inner);
    // khung vẽ rộng / cao dư để không cắt mất gì
    const drawW = Math.ceil(layoutW * 1.6);
    const drawH = Math.min(9000, Math.ceil(Math.max(1600, (body.scrollHeight || 1200) * 1.6 + 600)));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${drawW}" height="${drawH}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(wrap)}</foreignObject></svg>`;
    const img = new Image();
    // data: URL (không dùng blob:) – Chrome không "làm bẩn" canvas với SVG foreignObject dạng data URL
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    // 1) vẽ tỉ lệ 1:1 để dò vùng có nội dung
    const probe = document.createElement('canvas');
    probe.width = drawW;
    probe.height = drawH;
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    pctx.fillStyle = '#fff';
    pctx.fillRect(0, 0, drawW, drawH);
    pctx.drawImage(img, 0, 0);
    const ink = inkBox(pctx, drawW, drawH) || { l: 0, t: 0, r: A4.w, b: Math.round(A4.w * A4.ratio) };
    // 2) cắt sát + lề mỏng đều, tỉ lệ A4 đứng
    const cut = { x: Math.max(0, ink.l - A4.m), y: Math.max(0, ink.t - A4.m) };
    cut.w = ink.r + A4.m - cut.x;
    cut.h = Math.max(Math.round(cut.w * A4.ratio), ink.b + A4.m - cut.y);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cut.w * scale);
    canvas.height = Math.round(cut.h * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, -cut.x, -cut.y);
    drawWatermark(ctx, canvas.width, canvas.height);
    const png = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    return { png, blurred };
  }

  // Dán ảnh vào ô bình luận mới như Ctrl+V (CRM tự tải ảnh lên); đồng thời chép ảnh vào clipboard
  async function pasteImageToComment(png, name, getBox = async () => findCommentBox()) {
    const ta = await getBox();
    if (!ta) throw new Error('Không thấy ô bình luận.');
    ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
    ta.focus();
    const file = new File([png], name, { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    } catch {}
  }

  // Câu mẫu đi kèm ảnh báo giá (chọn ngẫu nhiên, đổi xưng hô theo NVKD)
  // Mặc định của bộ "Câu kèm ảnh báo giá" (sửa được trong tab 💬 Bộ câu hỏi). "Anh" = sếp tự xưng, {p} = cách gọi NVKD
  const PRICE_GIVE = [
    'Anh cho {p} giá nhé',
    'Anh duyệt giá này nhé {p}',
    'Anh tính giá này {p} báo khách nhé',
    'Anh duyệt giá này nha {p}',
    'Anh tính giá này {p} nhé',
  ];
  function priceGiveText(q) {
    const p = addressFor(staffOf(q, renderCtx.comments?.[q?.id]), renderCtx.comments, renderCtx.quotes) || 'em';
    const list = typeof qbank === 'function' ? qbank('priceGive') : PRICE_GIVE;
    // fillP tự đổi xưng hô: gọi NVKD là "chị / anh" thì sếp xưng "em" (vd. "Em tính giá này chị báo khách nhé")
    return fillP(list[Math.floor(Math.random() * list.length)], p);
  }
  const setTextarea = (ta, text) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };

  async function printQuoteToComment(btn, getBox) {
    const q = renderCtx.quotes?.[currentQuoteId()];
    const label = btn.textContent;
    const show = (t) => (btn.textContent = t);
    try {
      const inBtn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'In');
      if (!inBtn) throw new Error('Không thấy nút "In" của CRM.');
      const f0 = document.getElementById('printWindow');
      const before = f0?.contentDocument?.body?.innerHTML || '';
      document.dispatchEvent(new CustomEvent('dg:printCapture')); // hook.js chặn hộp thoại in
      show('⏳ Đang in…');
      inBtn.click();
      // CRM có thể mở hộp chọn mẫu in → bấm nút "In" trong hộp đó
      await sleep(700);
      const dlg = visModalsTop().find((m) => [...m.querySelectorAll('button')].some((b) => /^In$/.test(b.innerText.trim())));
      if (dlg) [...dlg.querySelectorAll('button')].find((b) => /^In$/.test(b.innerText.trim())).click();
      const doc = await waitFor(() => {
        const d = document.getElementById('printWindow')?.contentDocument;
        const html = d?.body?.innerHTML || '';
        return html && html !== before && /BẢNG BÁO GIÁ/i.test(d.body.innerText) ? d : null;
      }, 15000, 300);
      if (!doc) throw new Error('CRM chưa dựng bảng báo giá để in (không thấy "BẢNG BÁO GIÁ").');
      await sleep(800); // chờ ảnh / font trong khung in
      show('📸 Đang chụp…');
      const { png, blurred } = await Promise.race([docToPng(doc), sleep(45000).then(() => Promise.reject(new Error('Chụp báo giá quá lâu (45s) – thử lại.')))]);
      show('📋 Đang dán…');
      await pasteImageToComment(png, `bao-gia-${q?.code || currentQuoteId()}.png`, getBox);
      // kèm câu mẫu nếu ô đang trống
      const ta = await (getBox || (async () => findCommentBox()))();
      if (ta && !ta.value.trim()) setTextarea(ta, priceGiveText(q));
      show(blurred ? '✅ Đã dán (đã che SĐT)' : '✅ Đã dán – không thấy SĐT để che');
    } catch (e) {
      show(`⚠️ ${e.message}`);
    }
    setTimeout(() => show(label), 5000);
  }

  const signOn = () => lsGet('dgSignOn') !== '0'; // mặc định có ký tên
  // ---------- ±1% giá thực bán (bảng sản phẩm của báo giá) ----------
  // Mỗi dòng: nút −1% / +1% dưới ô "Giá thực bán" → điền giá mới như gõ tay (CRM tự tính lại thành tiền).
  // Không tự lưu: quản lý xem lại rồi bấm "Cập nhật".
  function nudgePrice(input, pct) {
    const raw = String(input.value || '');
    const n = Number(raw.replace(/[^\d]/g, ''));
    if (!n) return;
    const next = Math.max(0, Math.round(n * (1 + pct / 100)));
    const text = /[.,]/.test(raw) ? next.toLocaleString('vi-VN') : String(next);
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur(); // InputNumber của antd chốt giá trị khi rời ô
  }
  // Ô có thể chỉ là chữ cho tới khi bấm vào (ô sửa nhanh) → bấm vào ô để mở ô nhập rồi mới điền
  async function nudgeCell(cell, pct) {
    let input = cell.querySelector('input');
    if (!input) {
      const target = [...cell.querySelectorAll('div, span')].find((e) => e.childElementCount === 0 && /\d/.test(e.textContent) && !e.closest('.dg-nudge')) || cell;
      for (const t of ['mousedown', 'mouseup', 'click', 'dblclick']) target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
      input = await waitFor(() => cell.querySelector('input'), 1500, 100);
    }
    if (input) nudgePrice(input, pct);
  }
  // Nút −1% / +1% ở tiêu đề cột "Giá thực bán": áp dụng cho TẤT CẢ các dòng của báo giá (lần lượt từng dòng)
  let nudging = false;
  async function nudgeAll(t, idx, pct, btns) {
    if (nudging) return;
    nudging = true;
    btns.forEach((b) => (b.disabled = true));
    try {
      const rows = [...t.querySelectorAll('.ant-table-tbody tr')].filter((tr) => !tr.classList.contains('ant-table-measure-row'));
      for (const tr of rows) {
        const cell = tr.cells[idx];
        if (!cell || !/\d/.test(cell.innerText + (cell.querySelector('input')?.value || ''))) continue;
        await nudgeCell(cell, pct);
        await sleep(150);
      }
    } finally {
      nudging = false;
      btns.forEach((b) => (b.disabled = false));
    }
  }
  function injectPriceNudges() {
    if (!IS_TOP || !currentQuoteId()) return;
    for (const t of document.querySelectorAll('.ant-table')) {
      const heads = [...t.querySelectorAll('thead th')];
      const idx = heads.findIndex((th) => /^Giá thực bán/i.test(th.innerText.trim()));
      if (idx < 0) continue;
      const th = heads[idx];
      if (th.querySelector('.dg-nudge-head')) continue;
      const box = document.createElement('span');
      box.className = 'dg-nudge-head';
      // nằm riêng 1 hàng dưới chữ "Giá thực bán", các nút không bị bẻ chữ
      box.setAttribute('style', 'display:flex;flex-wrap:wrap;justify-content:center;gap:3px;margin-top:3px;');
      if (!document.getElementById('dg-nudge-css')) {
        const st = document.createElement('style');
        st.id = 'dg-nudge-css';
        st.textContent = `.dg-nudge-head button{all:unset;box-sizing:border-box!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;white-space:nowrap!important;height:20px!important;min-width:0!important;width:auto!important;padding:0 7px!important;border-radius:999px!important;border:1px solid!important;font-size:11px!important;font-weight:800!important;line-height:1!important;cursor:pointer!important;writing-mode:horizontal-tb!important;word-break:keep-all!important;transition:filter .15s,transform .1s}
.dg-nudge-head button:hover{filter:brightness(.95)}.dg-nudge-head button:active{transform:scale(.94)}
.dg-nudge-head button:disabled{opacity:.5!important;cursor:wait!important}
.dg-nudge-head .m{background:#fee2e2!important;color:#b91c1c!important;border-color:#fecaca!important}
.dg-nudge-head .p{background:#dcfce7!important;color:#15803d!important;border-color:#bbf7d0!important}
.dg-nudge-head .d{background:#eff6ff!important;color:#1d4ed8!important;border-color:#bfdbfe!important}
.dg-nudge-head .g{background:#fffbeb!important;color:#b45309!important;border-color:#fde68a!important}`;
        document.head.append(st);
      }
      const btns = [];
      for (const [label, pct, bg] of [['−1%', -1, '#fee2e2;color:#b91c1c;border-color:#fecaca'], ['+1%', 1, '#dcfce7;color:#15803d;border-color:#bbf7d0']]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = `${pct > 0 ? 'Tăng' : 'Giảm'} 1% giá thực bán của TẤT CẢ các dòng (chưa lưu – bấm Cập nhật để lưu)`;
        b.className = pct > 0 ? 'p' : 'm';
        // không để bấm nút làm bảng sắp xếp theo cột
        for (const ev of ['mousedown', 'mouseup', 'pointerdown']) b.addEventListener(ev, (e) => e.stopPropagation());
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          nudgeAll(t, idx, pct, btns);
        });
        btns.push(b);
        box.append(b);
      }
      // ＋đ: cộng thêm 1 số tiền (nghìn đồng) vào giá thực bán của tất cả các dòng
      const plus = document.createElement('button');
      plus.type = 'button';
      plus.textContent = '＋đ';
      plus.title = 'Cộng thêm số tiền vào giá thực bán của TẤT CẢ các dòng (chưa lưu – bấm Cập nhật để lưu)';
      plus.className = 'd';
      for (const ev of ['mousedown', 'mouseup', 'pointerdown']) plus.addEventListener(ev, (e) => e.stopPropagation());
      plus.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openAddAmount(t, idx, [...btns, plus]);
      });
      box.append(plus);
      // ⟲ Giá gần nhất: lấy cột "Giá gần nhất" của từng dòng điền vào "Giá thực bán" (dòng giá gần nhất = 0 thì bỏ qua)
      const last = document.createElement('button');
      last.type = 'button';
      last.textContent = '⟲ Gần nhất';
      last.title = 'Áp "Giá gần nhất" vào giá thực bán của các dòng (dòng chưa có giá gần nhất giữ nguyên) – chưa lưu, bấm Cập nhật để lưu';
      last.className = 'g';
      for (const ev of ['mousedown', 'mouseup', 'pointerdown']) last.addEventListener(ev, (e) => e.stopPropagation());
      last.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (nudging) return;
        const lIdx = [...t.querySelectorAll('thead th')].findIndex((x) => /^Giá gần nhất/i.test(x.innerText.trim()));
        if (lIdx < 0) return alert('Không thấy cột "Giá gần nhất".');
        nudging = true;
        const all = [...btns, plus, last];
        all.forEach((b) => (b.disabled = true));
        let n = 0;
        try {
          for (const tr of [...t.querySelectorAll('.ant-table-tbody tr')].filter((x) => !x.classList.contains('ant-table-measure-row'))) {
            const v = Number(String(tr.cells[lIdx]?.innerText || '').replace(/[^\d]/g, '')) || 0;
            const cell = tr.cells[idx];
            if (!v || !cell) continue;
            await setCellPrice(cell, v);
            n++;
            await sleep(150);
          }
        } finally {
          nudging = false;
          all.forEach((b) => (b.disabled = false));
        }
        last.textContent = `✓ ${n} dòng`;
        setTimeout(() => (last.textContent = '⟲ Gần nhất'), 2500);
      });
      box.append(last);
      th.append(box);
    }
  }
  // Hộp nhập số tiền cộng thêm (âm = trừ bớt) → áp cho mọi dòng
  function openAddAmount(t, idx, btns) {
    document.getElementById('dg-addamt')?.remove();
    const m = document.createElement('div');
    m.id = 'dg-addamt';
    m.innerHTML = `<div style="position:fixed;inset:0;z-index:2147483646;background:rgba(15,23,42,.35);display:flex;align-items:center;justify-content:center;font-family:inherit">
      <div style="background:#fff;border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.25);padding:18px 20px;width:340px">
        <div style="font-weight:800;font-size:15px;margin-bottom:10px">＋ Cộng thêm vào Giá thực bán</div>
        <div style="display:flex;align-items:center;gap:6px"><input class="amt" inputmode="numeric" placeholder="vd. 200" style="flex:1;height:36px;border:1px solid #cbd5e1;border-radius:8px;padding:0 10px;font-size:15px;font-weight:700;text-align:right"><b>đ</b></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">${[100, 200, 300, 500, 1000, -100, -200, -500].map((v) => `<button data-v="${v}" style="cursor:pointer;border:1px solid ${v > 0 ? '#bbf7d0' : '#fecaca'};background:${v > 0 ? '#f0fdf4' : '#fef2f2'};color:${v > 0 ? '#15803d' : '#b91c1c'};border-radius:999px;padding:2px 10px;font-weight:700;font-size:12px">${v > 0 ? '+' : ''}${v.toLocaleString('vi-VN')}</button>`).join('')}</div>
        <div style="font-size:12px;color:#64748b;margin-bottom:12px">Áp cho tất cả các dòng của báo giá (số âm = trừ bớt). Chưa lưu – xem lại rồi bấm "Cập nhật".</div>
        <div style="display:flex;justify-content:flex-end;gap:8px"><button data-a="x" style="cursor:pointer;border:1px solid #e2e8f0;background:#fff;border-radius:8px;padding:6px 14px">Huỷ</button><button data-a="ok" style="cursor:pointer;border:0;background:#2563eb;color:#fff;border-radius:8px;padding:6px 16px;font-weight:700">Áp dụng</button></div>
      </div></div>`;
    document.body.append(m);
    const inp = m.querySelector('.amt');
    inp.focus();
    const close = () => m.remove();
    const apply = async () => {
      const raw = inp.value.trim();
      const amt = (raw.startsWith('-') ? -1 : 1) * (Number(raw.replace(/[^\d]/g, '')) || 0);
      if (!amt) return inp.focus();
      close();
      if (nudging) return;
      nudging = true;
      btns.forEach((b) => (b.disabled = true));
      try {
        const rows = [...t.querySelectorAll('.ant-table-tbody tr')].filter((tr) => !tr.classList.contains('ant-table-measure-row'));
        for (const tr of rows) {
          const cell = tr.cells[idx];
          if (!cell) continue;
          const cur = Number(String(cell.querySelector('input')?.value || cell.innerText).replace(/[^\d]/g, '')) || 0;
          if (!cur) continue;
          await setCellPrice(cell, Math.max(0, cur + amt));
          await sleep(150);
        }
      } finally {
        nudging = false;
        btns.forEach((b) => (b.disabled = false));
      }
    };
    m.addEventListener('click', (e) => {
      const v = e.target.closest('[data-v]')?.dataset.v;
      if (v) {
        inp.value = v;
        return inp.focus();
      }
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'x' || e.target === m.firstElementChild) close();
      if (a === 'ok') apply();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') apply();
      if (e.key === 'Escape') close();
    });
  }
  if (IS_TOP) setInterval(() => injectPriceNudges(), 2000);

  // ---------- 🔄 Load lại giá giấy mới (dòng có ⚠️ giấy cũ ở cột "Kết cấu giấy") ----------
  // Mỗi dòng có ⚠️: bấm số lượng → hộp "Tính giá carton" → "Đồng bộ giá carton mới" → Lưu → dòng kế.
  function productTable() {
    for (const t of document.querySelectorAll('.ant-table')) {
      const hs = [...t.querySelectorAll('thead th')].map((th) => th.innerText.trim());
      const iQty = hs.indexOf('Số lượng');
      const iKc = hs.findIndex((h) => /^Kết cấu giấy/i.test(h));
      if (iQty >= 0 && iKc >= 0) return { t, iQty, iKc };
    }
    return null;
  }
  // Ô "Kết cấu giấy" của 1 dòng: ô có dạng "1253 | PNTP_…" (không dựa vào vị trí cột – bảng có cột cố định)
  const paperCell = (tr, iKc) =>
    [...tr.cells].find((td) => /\d+\s*\|\s*[A-Z0-9]+_/.test(td.innerText || '')) || tr.cells[iKc];
  // Giấy cũ: ô có dấu ⚠ (chữ) hoặc bất kỳ biểu tượng nào (hình / SVG / icon) – ô giấy mới chỉ có chữ + thanh
  const isOldPaper = (cell) =>
    !!cell && (/⚠/.test(cell.innerText || '') || !!cell.querySelector('svg, img, .anticon, [role="img"], i[class*="icon"], [class*="warning"], [class*="Warning"]'));
  async function reloadPaper(btn) {
    const pt = productTable();
    if (!pt) return (btn.textContent = '⚠️ Không thấy bảng hàng hóa');
    const rows = [...pt.t.querySelectorAll('.ant-table-tbody tr')].filter((tr) => !tr.classList.contains('ant-table-measure-row') && isOldPaper(paperCell(tr, pt.iKc)));
    if (!rows.length) {
      btn.textContent = '✓ Không có giấy cũ';
      return setTimeout(() => (btn.textContent = '🔄 Load lại giá giấy mới'), 3000);
    }
    let ok = 0;
    let skip = 0;
    for (const [i, tr] of rows.entries()) {
      btn.textContent = `⏳ Dòng ${i + 1}/${rows.length}: mở…`;
      // ô số lượng: ô có con số dạng 5.000 màu xanh (nút / link) – tìm theo nội dung nếu lệch cột
      const qCell = tr.cells[pt.iQty]?.querySelector('button, a') ? tr.cells[pt.iQty] : [...tr.cells].find((td) => td.querySelector('button, a') && /^\s*[\d.]+\s*$/.test(td.innerText || ''));
      const qb = qCell?.querySelector('button, a') || tr.cells[pt.iQty]?.querySelector('span');
      if (!qb) {
        skip++;
        continue;
      }
      qb.click();
      const modal = await waitFor(() => visModalsTop().find((m) => /Tính giá carton/i.test(m.innerText)), 6000, 200);
      if (!modal) {
        skip++;
        continue;
      }
      await sleep(800);
      const sync = await waitFor(() => [...modal.querySelectorAll('button')].find((b) => /Đồng bộ giá carton mới/i.test(b.innerText)), 2500, 200);
      if (!sync) {
        // giá đã mới → đóng, không lưu
        ([...modal.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Đóng') || modal.querySelector('.ant-modal-close'))?.click();
        skip++;
        await waitFor(() => !modal.isConnected || getComputedStyle(modal).display === 'none', 4000, 200);
        continue;
      }
      btn.textContent = `⏳ Dòng ${i + 1}/${rows.length}: đồng bộ giá…`;
      sync.click();
      await sleep(1500);
      // Tên đang là "Hộp carton…" → đặt Số lượng thùng về 0 rồi trả lại số cũ để CRM tự đặt lại tên đúng
      {
        const title = modal.querySelector('.ant-modal-title')?.textContent || '';
        if (/Tính giá carton:\s*Hộp carton/i.test(title)) {
          const lbl = [...modal.querySelectorAll('label, span, div')].find((e) => !e.children.length && /^Số lượng thùng$/i.test(e.textContent.trim()));
          const inp = (lbl?.closest('.ant-form-item') || lbl?.parentElement?.parentElement)?.querySelector('input');
          const setV = (v) => {
            inp.focus();
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, v);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            inp.blur();
          };
          const old = inp ? String(inp.value).replace(/[^\d]/g, '') : '';
          if (inp && Number(old) > 0) {
            btn.textContent = `⏳ Dòng ${i + 1}/${rows.length}: đổi tên (SL 0 → ${Number(old).toLocaleString('vi-VN')})…`;
            setV('0');
            await sleep(900);
            setV(old);
            await waitFor(() => !/Tính giá carton:\s*Hộp carton/i.test(modal.querySelector('.ant-modal-title')?.textContent || ''), 3000, 150);
            await sleep(600);
          }
        }
      }
      // "Ghi chú khách hàng" còn trống → bấm "Tự động" để CRM tự điền trước khi lưu
      {
        const lbl = [...modal.querySelectorAll('label, span, div')].find((e) => !e.children.length && /^Ghi chú khách hàng$/i.test(e.textContent.trim()));
        const item = lbl?.closest('.ant-form-item') || lbl?.parentElement?.parentElement;
        const ta = item?.querySelector('textarea') || lbl?.closest('div')?.parentElement?.querySelector('textarea');
        const auto = (item || modal) && [...(item || modal).querySelectorAll('button')].find((b) => b.innerText.trim() === 'Tự động');
        if (ta && !ta.value.trim() && auto) {
          btn.textContent = `⏳ Dòng ${i + 1}/${rows.length}: ghi chú tự động…`;
          auto.click();
          await waitFor(() => ta.value.trim(), 3000, 150);
          await sleep(300);
        }
      }
      const save = [...modal.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Lưu');
      if (!save) {
        skip++;
        continue;
      }
      btn.textContent = `⏳ Dòng ${i + 1}/${rows.length}: lưu…`;
      save.click();
      const closed = await waitFor(() => !modal.isConnected || getComputedStyle(modal).display === 'none', 8000, 200);
      if (closed) ok++;
      else skip++;
      await sleep(600);
    }
    btn.textContent = `✅ Đã cập nhật giấy ${ok}/${rows.length} dòng${skip ? ` (bỏ qua ${skip})` : ''}`;
    setTimeout(() => (btn.textContent = '🔄 Load lại giá giấy mới'), 6000);
  }
  function injectPaperReload() {
    if (!IS_TOP || !currentQuoteId() || document.querySelector('.dg-paper-reload')) return;
    const off = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Offset' && b.closest('.ant-btn, button'));
    if (!off) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ant-btn dg-paper-reload';
    b.textContent = '🔄 Load lại giá giấy mới';
    b.title = 'Dòng có ⚠️ (giấy cũ chưa cập nhật): bấm số lượng → Đồng bộ giá carton mới → Lưu, lần lượt từng dòng';
    b.setAttribute('style', 'margin-left:8px;height:32px;padding:0 14px;border-radius:6px;font-weight:700;cursor:pointer;color:#fff;border:0;background:linear-gradient(90deg,#f59e0b,#ea580c);');
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (b.dataset.busy) return;
      b.dataset.busy = '1';
      try {
        await reloadPaper(b);
      } catch (err) {
        b.textContent = `⚠️ ${err.message}`;
      } finally {
        delete b.dataset.busy;
      }
    });
    off.after(b);
  }
  if (IS_TOP) setInterval(() => injectPaperReload(), 2000);

  // Hộp "Tính giá carton" của CRM: trang trí lại (thẻ cho từng phần Quy cách / In / Khác, ô nhập bo tròn, bảng giá, cảnh báo, đơn giá nổi bật)
  const CC_CSS = `
.dg-cc .ant-modal-content{border-radius:16px!important;overflow:hidden;padding:0!important;box-shadow:0 24px 60px rgba(15,23,42,.28)!important}
.dg-cc .ant-modal-header{margin:0!important;padding:14px 56px 12px 20px!important;background:linear-gradient(90deg,#eff6ff,#f5f3ff)!important;border-bottom:1px solid #e0e7ff!important}
.dg-cc .ant-modal-title{font-size:14px!important;font-weight:600!important;color:#475569!important;line-height:1.45!important}
.dg-cc .ant-modal-title b,.dg-cc .ant-modal-title strong,.dg-cc .ant-modal-title span{color:#1e3a8a!important}
.dg-cc .ant-modal-close{top:12px!important}
.dg-cc .ant-modal-body{background:#f1f5f9!important;padding:14px 16px 6px!important;max-height:calc(100vh - 190px);overflow-y:auto}
.dg-cc .dg-cc-sec{background:#fff!important;border:1px solid #e2e8f0!important;border-radius:14px!important;padding:12px 14px 6px!important;margin:0 0 12px!important;box-shadow:0 1px 3px rgba(15,23,42,.05)!important;box-sizing:border-box}
.dg-cc .dg-cc-h{display:flex!important;align-items:center;gap:8px;font-size:15px!important;font-weight:800!important;color:#0f172a!important;margin:0 0 10px!important;padding-bottom:8px;border-bottom:1px dashed #e2e8f0}
.dg-cc .dg-cc-h::before{content:attr(data-ic);display:inline-grid;place-items:center;width:28px;height:28px;border-radius:9px;background:var(--cc,#eef2ff);font-size:15px}
.dg-cc label,.dg-cc .ant-form-item-label>label{font-size:12px!important;font-weight:600!important;color:#64748b!important}
.dg-cc .ant-form-item{margin-bottom:10px!important}
.dg-cc .ant-input,.dg-cc .ant-input-number,.dg-cc .ant-select-selector,.dg-cc .ant-picker,.dg-cc textarea{border-radius:9px!important;border-color:#dbe3ee!important;transition:border-color .15s,box-shadow .15s}
.dg-cc .ant-input:hover,.dg-cc .ant-select:hover .ant-select-selector,.dg-cc textarea:hover{border-color:#93c5fd!important}
.dg-cc .ant-input:focus,.dg-cc .ant-input-focused,.dg-cc .ant-select-focused .ant-select-selector,.dg-cc textarea:focus{border-color:#3b82f6!important;box-shadow:0 0 0 3px rgba(59,130,246,.15)!important}
.dg-cc .ant-input[disabled],.dg-cc .ant-input-disabled,.dg-cc .ant-select-disabled .ant-select-selector{background:#f8fafc!important;color:#334155!important}
.dg-cc input:not([type=checkbox]):not([type=radio]){font-weight:600}
.dg-cc .ant-checkbox-inner{border-radius:5px!important}
.dg-cc .dg-cc-info{display:flex!important;flex-wrap:wrap;gap:4px 14px;background:linear-gradient(90deg,#f0f9ff,#eef2ff)!important;border:1px solid #dbeafe;border-radius:10px;padding:7px 12px!important;margin:4px 0 8px!important;font-size:12.5px!important;color:#1e3a8a!important;line-height:1.6!important}
.dg-cc .dg-cc-img{max-height:150px!important;width:auto!important;object-fit:contain;filter:drop-shadow(0 6px 10px rgba(15,23,42,.12))}
.dg-cc .dg-cc-pt{border:1px solid #e2e8f0!important;border-radius:12px!important;overflow:hidden;border-collapse:separate!important;border-spacing:0!important;background:#fff}
.dg-cc .dg-cc-pt th,.dg-cc .dg-cc-pt thead td{background:#f8fafc!important;color:#64748b!important;font-size:11.5px!important;font-weight:700!important;text-transform:uppercase;letter-spacing:.3px;padding:6px 14px!important;border-bottom:1px solid #e2e8f0!important}
.dg-cc .dg-cc-pt td{padding:7px 14px!important;font-size:15px!important;font-weight:800!important;color:#0f172a;font-variant-numeric:tabular-nums}
.dg-cc .dg-cc-warn{display:inline-flex!important;align-items:center;flex-wrap:wrap;gap:8px;background:#fef2f2!important;border:1px solid #fecaca;border-left:4px solid #ef4444;border-radius:10px;padding:7px 10px!important;margin:6px 0!important;font-size:12.5px!important;font-weight:600;color:#b91c1c!important}
.dg-cc .dg-cc-warn .ant-btn,.dg-cc .dg-cc-warn button{border-radius:999px!important;height:28px!important;font-size:12.5px!important;font-weight:700!important;box-shadow:0 2px 8px rgba(37,99,235,.3)!important}
.dg-cc .ant-modal-footer{margin:0!important;padding:10px 16px!important;background:#fff!important;border-top:1px solid #e2e8f0!important;display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dg-cc .ant-modal-footer .ant-btn{border-radius:10px!important;height:36px!important;font-weight:700!important;padding:0 16px!important}
.dg-cc .ant-modal-footer .ant-btn-primary{box-shadow:0 4px 12px rgba(37,99,235,.28)!important}
.dg-cc .dg-cc-price{display:inline-flex!important;align-items:baseline;gap:6px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:5px 12px;font-size:13px!important;color:#475569!important;margin-right:6px}
.dg-cc .dg-cc-price *{font-size:20px!important;font-weight:900!important}
`;
  const OF_CSS = `
.dg-of .ant-modal-header{padding:12px 56px 10px 20px!important}
.dg-of .ant-modal-body{padding:12px 14px!important;max-height:calc(100vh - 150px)}
.dg-of .dg-of-card{background:#fff!important;border:1px solid #e2e8f0!important;border-radius:14px!important;box-shadow:0 1px 3px rgba(15,23,42,.05)!important;transition:box-shadow .15s,border-color .15s,opacity .15s}
.dg-of .dg-of-card:hover{border-color:#c7d2fe!important;box-shadow:0 6px 18px rgba(15,23,42,.08)!important}
.dg-of .dg-of-card.dg-off{opacity:.5;filter:grayscale(.5)}
.dg-of .dg-of-card.dg-off:hover{opacity:1;filter:none}
.dg-of .dg-of-h{text-decoration:none!important;font-weight:800!important;color:#0f172a!important;font-size:14px!important;display:inline-flex!important;align-items:center;gap:6px}
.dg-of .dg-of-h::before{content:attr(data-ic);display:inline-grid;place-items:center;width:24px;height:24px;border-radius:8px;background:var(--cc,#eef2ff);font-size:13px;flex:none}
.dg-of label{font-size:11.5px!important}
.dg-of .ant-btn:not(.ant-btn-primary):not(.ant-btn-link){border-radius:999px!important;font-weight:700!important}
.dg-of .ant-btn-primary{border-radius:9px!important;font-weight:700!important}
.dg-of table{border-collapse:separate!important;border-spacing:0!important;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}
.dg-of table th{background:#f8fafc!important;color:#64748b!important;font-size:11.5px!important;font-weight:700!important}
.dg-of table td{font-variant-numeric:tabular-nums;font-weight:600}
.dg-of .dg-of-total{background:linear-gradient(90deg,#ecfdf5,#eff6ff)!important;border-color:#a7f3d0!important;display:flex!important;flex-wrap:wrap;align-items:center;gap:6px 28px;padding:12px 16px!important}
.dg-of .dg-of-total *{font-size:15px!important;margin:0!important}
.dg-of .dg-of-total b,.dg-of .dg-of-total strong{font-size:20px!important;color:#047857!important}
`;
  const CC_SEC = { 'Quy cách': ['📐', '#e0f2fe'], In: ['🖨️', '#fce7f3'], Khác: ['⚙️', '#fef3c7'] };
  function styleCartonModal() {
    for (const m of document.querySelectorAll('.ant-modal')) {
      const title = m.querySelector('.ant-modal-title');
      if (!title || !/^\s*Tính giá (carton|offset)/i.test(title.textContent)) continue;
      if (!document.getElementById('dg-cc-css')) {
        const st = document.createElement('style');
        st.id = 'dg-cc-css';
        st.textContent = CC_CSS + OF_CSS;
        document.head.append(st);
      }
      m.classList.add('dg-cc');
      const body = m.querySelector('.ant-modal-body');
      if (!body) continue;
      if (/offset/i.test(title.textContent)) {
        m.classList.add('dg-of');
        styleOffsetBody(body);
        continue;
      }
      // Tiêu đề từng phần (chữ to, đúng tên) → bọc phần đó thành 1 thẻ
      const heads = [...body.querySelectorAll('*')].filter((e) => !e.children.length && CC_SEC[e.textContent.trim()] && parseFloat(getComputedStyle(e).fontSize) >= 15);
      for (const h of heads) {
        if (h.classList.contains('dg-cc-h')) continue;
        const [ic, bg] = CC_SEC[h.textContent.trim()];
        h.classList.add('dg-cc-h');
        h.dataset.ic = ic;
        h.style.setProperty('--cc', bg);
        let sec = h;
        while (sec.parentElement && sec.parentElement !== body && !heads.some((o) => o !== h && sec.parentElement.contains(o))) sec = sec.parentElement;
        if (sec !== h) sec.classList.add('dg-cc-sec');
      }
      // Dòng thông số (Diện tích / Thể tích / NVL …)
      for (const e of body.querySelectorAll('div, p, span')) {
        if (e.classList.contains('dg-cc-info') || e.closest('.dg-cc-info')) continue;
        const t = e.textContent;
        if (/Diện tích:/.test(t) && /NVL:/.test(t) && t.length < 200 && ![...e.children].some((c) => /Diện tích:/.test(c.textContent) && /NVL:/.test(c.textContent))) e.classList.add('dg-cc-info');
      }
      // Ảnh minh hoạ thùng nhỏ lại
      body.querySelectorAll('img').forEach((im) => im.naturalWidth > 200 && !im.closest('.ant-select, [class*="ban-in"]') && im.getBoundingClientRect().width > 160 && im.classList.add('dg-cc-img'));
      // Bảng giá Hộp trơn / In KTS / In Flexo
      body.querySelectorAll('table').forEach((tb) => /Hộp trơn|In KTS|In Flexo/i.test(tb.textContent) && tb.classList.add('dg-cc-pt'));
      // Cảnh báo giá vốn
      for (const e of body.querySelectorAll('div, span, p')) {
        if (e.closest('.dg-cc-warn')) continue;
        if (/^Giá vốn hiện tại cao hơn/i.test(e.textContent.trim()) && e.textContent.length < 220) {
          const wrap = e.parentElement && /Đồng bộ/i.test(e.parentElement.textContent) && e.parentElement.textContent.length < 260 ? e.parentElement : e;
          wrap.classList.add('dg-cc-warn');
        }
      }
      // Đơn giá 1 thùng ở chân hộp
      const foot = m.querySelector('.ant-modal-footer');
      if (foot)
        for (const e of foot.querySelectorAll('div, span')) {
          if (/^Đơn giá 1 thùng/i.test(e.textContent.trim()) && e.textContent.length < 60 && ![...e.children].some((c) => /^Đơn giá 1 thùng/i.test(c.textContent.trim()))) e.classList.add('dg-cc-price');
        }
    }
  }
  // Hộp "Tính giá offset": các khung có viền sẵn → thẻ trắng bo góc, tiêu đề có biểu tượng, khung đang tắt thì làm mờ
  const OF_IC = [
    [/^Thông tin sản phẩm/i, '📦', '#e0f2fe'], [/^Phối giấy/i, '🧻', '#fef3c7'], [/^Ghi chú/i, '📝', '#f1f5f9'], [/^Tính giá theo bài in/i, '🖨️', '#fce7f3'],
    [/^Kẽm/i, '🧩', '#ede9fe'], [/^Tính giá theo sản phẩm/i, '🏷️', '#dcfce7'], [/^Tem/i, '🔖', '#fef9c3'], [/^Bồi/i, '🧱', '#ffedd5'], [/^Cán/i, '✨', '#e0e7ff'],
    [/^Bế chìm/i, '🔲', '#f1f5f9'], [/^Bế/i, '✂️', '#fee2e2'], [/^Gia công sau in/i, '🛠️', '#e2e8f0'], [/^Gia công túi/i, '🛍️', '#fae8ff'], [/^Dán cửa sổ/i, '🪟', '#e0f2fe'],
    [/^Ép kim/i, '⭐', '#fef3c7'], [/^UV/i, '💧', '#cffafe'], [/^Đóng gói/i, '📦', '#ffedd5'], [/^Tính theo các khung/i, '📊', '#dcfce7'],
  ];
  const OF_SKIP = '.ant-input, .ant-input-affix-wrapper, .ant-input-number, .ant-select, .ant-select-selector, .ant-checkbox-wrapper, .ant-checkbox, .ant-checkbox-inner, .ant-btn, button, textarea, table, td, th, tr, .ant-picker, img, .ant-image, .ant-upload';
  function styleOffsetBody(body) {
    const n = body.getElementsByTagName('*').length;
    if (body._dgN === n) return markOffsetOff(body);
    body._dgN = n;
    for (const e of body.querySelectorAll('div')) {
      if (e.classList.contains('dg-of-card') || e.matches(OF_SKIP) || e.closest('.ant-select, .ant-input-affix-wrapper, .ant-input-number, .ant-picker, table')) continue;
      const cs = getComputedStyle(e);
      if (!(parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== 'none' && parseFloat(cs.borderLeftWidth) >= 1)) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 120 || r.height < 40 || !e.querySelector('input, .ant-select, textarea, table, button')) continue;
      if (e.parentElement?.closest('.dg-of-card')) continue; // chỉ khung ngoài cùng
      e.classList.add('dg-of-card');
      // tiêu đề khung: chữ đầu tiên, to hoặc gạch chân
      const h = [...e.querySelectorAll('*')].find((x) => {
        if (x.children.length && !(x.children.length === 1 && x.firstChild?.nodeType === 3)) return false;
        const t = x.textContent.trim();
        if (t.length < 2 || t.length > 45 || x.closest('label.ant-checkbox-wrapper, .ant-select, .ant-btn')) return false;
        const xs = getComputedStyle(x);
        return parseFloat(xs.fontSize) >= 15 || /underline/.test(xs.textDecorationLine);
      });
      if (h && !h.classList.contains('dg-of-h')) {
        const ic = OF_IC.find(([re]) => re.test(h.textContent.trim()));
        h.classList.add('dg-of-h');
        h.dataset.ic = ic ? ic[1] : '▪️';
        h.style.setProperty('--cc', ic ? ic[2] : '#f1f5f9');
      }
      if (/Tổng giá:/.test(e.textContent) && /Tổng tiền:/.test(e.textContent) && e.textContent.length < 120) e.classList.add('dg-of-total');
    }
    markOffsetOff(body);
  }
  // Khung tuỳ chọn đang tắt (mọi ô đều khoá) → mờ đi cho dễ nhìn phần đang dùng
  function markOffsetOff(body) {
    body.querySelectorAll('.dg-of-card').forEach((c) => {
      const f = [...c.querySelectorAll('input:not([type=checkbox]), .ant-select')];
      const off = f.length > 0 && f.every((x) => x.disabled || x.classList.contains('ant-select-disabled'));
      c.classList.toggle('dg-off', off && !/Thông tin|Phối giấy|Tính giá theo bài/i.test(c.textContent.slice(0, 40)));
    });
  }
  if (IS_TOP) setInterval(styleCartonModal, 700);

  // Nút "🖨 In báo giá" cạnh tiêu đề "Bình luận" trên trang báo giá
  function injectPrintButton() {
    if (!IS_TOP || !currentQuoteId() || document.querySelector('.dg-printq')) return;
    // Tiêu đề "Bình luận" phía trên ô nhập (không phải tab, không phải nút gửi) – CRM dùng thẻ nào cũng nhận
    const box = findCommentBox();
    const cands = [...document.querySelectorAll('body *')].filter(
      (e) => e.childElementCount === 0 && e.textContent.trim() === 'Bình luận' && !e.closest('.ant-tabs-tab, .ant-tabs-nav, button, .ant-btn, .ant-comment, #dg-root') && e.getClientRects().length,
    );
    // gần ô nhập bình luận nhất (nằm phía trên ô nhập)
    const h = box
      ? cands.filter((e) => e.getBoundingClientRect().top <= box.getBoundingClientRect().top).sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]
      : cands[0];
    if (!h && !box) return;
    const b = document.createElement('span');
    b.className = 'dg-printq';
    b.textContent = '🖨 In báo giá → dán vào bình luận';
    b.title = 'In báo giá (không mở hộp thoại in), chụp thành ảnh, che SĐT khách rồi dán vào ô bình luận';
    b.setAttribute('style', 'display:inline-block;margin-left:12px;vertical-align:middle;cursor:pointer;font-size:13px;font-weight:700;color:#fff;background:linear-gradient(90deg,#2563eb,#7c3aed);border-radius:999px;padding:3px 12px');
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!b.textContent.startsWith('⏳') && !b.textContent.startsWith('📸')) printQuoteToComment(b);
    });
    // Nút bật / tắt ký tên trên ảnh báo giá (nhớ trên máy)
    const sg = document.createElement('span');
    sg.className = 'dg-signtg';
    const paintSg = () => {
      const on = signOn();
      sg.textContent = on ? '✍️ Ký tên: Bật' : '✍️ Ký tên: Tắt';
      sg.title = on ? 'Ảnh báo giá có chữ ký + "Người duyệt: <tên>". Bấm để tắt.' : 'Ảnh báo giá không có chữ ký, ô duyệt ghi "Người phê duyệt: Giám đốc". Bấm để bật.';
      sg.setAttribute('style', `display:inline-block;margin-left:8px;vertical-align:middle;cursor:pointer;font-size:12.5px;font-weight:700;border-radius:999px;padding:3px 11px;border:1px solid ${on ? '#86efac' : '#cbd5e1'};color:${on ? '#15803d' : '#64748b'};background:${on ? '#f0fdf4' : '#f8fafc'}`);
    };
    paintSg();
    sg.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      lsSet('dgSignOn', signOn() ? '0' : '1');
      paintSg();
    });
    if (h) h.append(b, sg);
    else {
      // không thấy tiêu đề → đặt nút ngay trên ô nhập bình luận
      const holder = document.createElement('div');
      holder.setAttribute('style', 'margin:0 0 6px');
      holder.append(b, sg);
      const anchor = box.closest('.ant-comment, .ant-form-item, .ant-row') || box.parentElement;
      anchor.parentElement.insertBefore(holder, anchor);
    }
  }
  if (IS_TOP) setInterval(() => injectPrintButton(), 2000);

  // ---------- Trang chi tiết báo giá: trang trí lại nhóm nút "Tình trạng báo giá" ----------
  const ST_LOOK = {
    'Bản thảo': ['📝', '#64748b'],
    'Chờ xin giá': ['⏳', '#16a34a'],
    'Đã xác nhận': ['👍', '#ea580c'],
    'Đã gửi': ['📤', '#64748b'],
    'Chờ lên đơn': ['🕒', '#0891b2'],
    'Duyệt lên đơn': ['✅', '#d97706'],
    'Thành công': ['🏆', '#2563eb'],
    'Thất bại': ['❌', '#dc2626'],
  };
  function styleQuoteStatus() {
    if (!IS_TOP || !currentQuoteId()) return;
    document.querySelectorAll('.dg-sti').forEach((e) => e.remove()); // bỏ biểu tượng chèn kiểu cũ
    const lbl = [...document.querySelectorAll('label, span, div')].find((e) => e.childElementCount === 0 && e.textContent.trim() === 'Tình trạng báo giá' && !e.closest('#dg-root'));
    if (!lbl) return;
    let scope = lbl.parentElement;
    for (let k = 0; k < 5 && scope && ![...scope.querySelectorAll('*')].some((e) => e.childElementCount === 0 && e.textContent.trim() === 'Thất bại'); k++) scope = scope.parentElement;
    if (!scope) return;
    // Chữ của từng nút (phần tử lá có đúng tên tình trạng)
    const leaves = [...scope.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && ST_LOOK[e.textContent.replace(/[✓✔]/g, '').trim()]);
    if (leaves.length < 4) return;
    // Khung chung nhỏ nhất chứa tất cả nút; mỗi nút = con trực tiếp của khung đó
    let box = leaves[0].parentElement;
    while (box && !leaves.every((l) => box.contains(l))) box = box.parentElement;
    if (!box) return;
    if (!document.getElementById('dg-st-css3')) {
      document.getElementById('dg-st-css')?.remove();
      document.getElementById('dg-st-css2')?.remove();
      const st = document.createElement('style');
      st.id = 'dg-st-css3';
      st.textContent = `[data-dg-stbox]{display:flex !important;flex-wrap:wrap !important;gap:5px !important;margin-top:4px}
[data-dg-st]{position:static !important;display:inline-flex !important;align-items:center;gap:4px;width:auto !important;min-width:0 !important;height:24px !important;padding:0 9px !important;margin:0 !important;border-radius:6px !important;font-size:12px !important;font-weight:600 !important;border:1px solid color-mix(in srgb,var(--c) 45%,#fff) !important;color:var(--c) !important;background:#fff !important;cursor:pointer;transition:background .12s;white-space:nowrap;line-height:1 !important;opacity:1 !important;box-sizing:border-box}
[data-dg-st] *{color:inherit !important;background:transparent !important;border:0 !important;padding:0 !important;margin:0 !important;font-weight:inherit !important;font-size:inherit !important}
[data-dg-st] .anticon{display:none !important}
[data-dg-st]:hover{background:color-mix(in srgb,var(--c) 10%,#fff) !important}
[data-dg-st][data-on="1"]{background:var(--c) !important;border-color:var(--c) !important;color:#fff !important;font-weight:700 !important}
[data-dg-st][data-on="1"]::before{content:'✓';font-weight:900}`;
      document.head.append(st);
    }
    box.setAttribute('data-dg-stbox', '1');
    for (const l of leaves) {
      let b = l;
      while (b.parentElement && b.parentElement !== box) b = b.parentElement;
      const t = l.textContent.replace(/[✓✔]/g, '').trim();
      const [ic, col] = ST_LOOK[t];
      const on = /✓|✔/.test(b.textContent) || !!b.querySelector('.anticon, [class*="checked"], [class*="active"]') || /checked|active|selected/.test(String(b.className));
      b.setAttribute('data-dg-st', t);
      b.removeAttribute('data-dg-ic');
      void ic;
      b.style.setProperty('--c', col);
      b.dataset.on = on ? '1' : '0';
    }
  }
  // Trang chi tiết báo giá: chuẩn hoá giao diện (ô nhập, nút, nhãn, khoảng cách, bo góc) cho hài hoà
  function detailPageCss() {
    const on = IS_TOP && !!currentQuoteId();
    document.documentElement.toggleAttribute('data-dg-detail', on);
    if (!on || document.getElementById('dg-detail-css4')) return;
    ['dg-detail-css', 'dg-detail-css2', 'dg-detail-css3'].forEach((id) => document.getElementById(id)?.remove());
    const st = document.createElement('style');
    st.id = 'dg-detail-css4';
    const R = 'html[data-dg-detail]';
    // Gọn: ô nhập thấp, khoảng cách nhỏ, nhãn sát ô – trang ngắn lại
    st.textContent = `
${R} .ant-form-item{margin-bottom:8px !important}
${R} .ant-form-item-label{padding-bottom:2px !important;line-height:1.3 !important}
${R} .ant-form-item-label > label, ${R} .ant-form-item-label label{font-size:12px !important;font-weight:600 !important;color:#475569 !important;height:auto !important}
${R} .ant-input, ${R} .ant-input-affix-wrapper, ${R} .ant-picker, ${R} .ant-input-number{border-radius:6px !important;border-color:#e2e8f0 !important;font-size:13px !important}
${R} .ant-input:not(textarea), ${R} .ant-input-affix-wrapper, ${R} .ant-picker, ${R} .ant-input-number{height:30px !important;padding-top:2px !important;padding-bottom:2px !important}
${R} .ant-input-affix-wrapper > .ant-input{height:auto !important}
${R} .ant-select-single:not(.ant-select-customize-input) .ant-select-selector{height:30px !important;border-radius:6px !important;border-color:#e2e8f0 !important;font-size:13px !important}
${R} .ant-select-single .ant-select-selector .ant-select-selection-item, ${R} .ant-select-single .ant-select-selector .ant-select-selection-placeholder{line-height:28px !important}
${R} .ant-select-single .ant-select-selection-search-input{height:28px !important}
${R} .ant-input:focus, ${R} .ant-input-focused, ${R} .ant-input-affix-wrapper-focused, ${R} .ant-picker-focused, ${R} .ant-select-focused .ant-select-selector{border-color:#3b82f6 !important;box-shadow:0 0 0 2px rgba(59,130,246,.15) !important}
${R} .ant-btn{border-radius:6px !important;font-weight:600 !important;box-shadow:none !important}
${R} .ant-btn:not(.ant-btn-sm){height:30px !important;padding:0 12px !important}
${R} .ant-btn-primary:not([disabled]){background:#2563eb !important;border-color:#2563eb !important;color:#fff !important}
${R} .ant-btn-primary:not([disabled]) *{color:#fff !important}
${R} .ant-btn-primary:not([disabled]):hover{background:#1d4ed8 !important}
${R} .ant-btn[disabled], ${R} .ant-btn[disabled]:hover{background:#f1f5f9 !important;border-color:#e2e8f0 !important;color:#94a3b8 !important;cursor:not-allowed}
${R} .ant-btn[disabled] *{color:#94a3b8 !important}
${R} .ant-alert{border-radius:8px !important;padding:6px 12px !important;margin-bottom:8px !important}
${R} .ant-tabs-nav{margin-bottom:8px !important}
${R} .ant-tabs-tab{padding:6px 0 !important;font-weight:600 !important}
${R} .ant-divider{margin:8px 0 !important}
${R} .ant-row{row-gap:0 !important}
${R} textarea.ant-input{border-radius:8px !important}
${R} .ant-table-body{max-height:none !important;overflow-y:visible !important}
${R} .ant-table-thead > tr > th, ${R} .ant-table-tbody > tr > td{padding:4px 6px !important;font-size:12px !important;line-height:1.35 !important}
${R} .ant-table-thead > tr > th{font-weight:700 !important;color:#475569 !important;background:#f8fafc !important}
${R} .ant-table-tbody > tr > td .ant-input, ${R} .ant-table-tbody > tr > td .ant-input-number, ${R} .ant-table-tbody > tr > td .ant-select-selector{height:26px !important;font-size:12px !important}`;
    document.head.append(st);
  }
  if (IS_TOP) setInterval(() => {
    try {
      detailPageCss();
      styleQuoteStatus();
    } catch {}
  }, 1500);

  // ---------- Bấm ảnh trong bình luận → xem ảnh dạng modal (phóng to, kéo, xoay, tải, chuyển ảnh) ----------
  const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/i;
  function pageImages() {
    return [...document.querySelectorAll('img')].filter((im) => {
      if (im.closest('#dg-root, #dg-lb, [data-dg-hot]')) return false;
      const r = im.getBoundingClientRect();
      // bỏ avatar / icon: ảnh nhỏ, ảnh tròn, ảnh trong khung avatar
      if (r.width < 40 || r.height < 16) return false;
      if (im.closest('.ant-avatar, [class*="avatar"], [class*="Avatar"]') || getComputedStyle(im).borderRadius === '50%') return false;
      const href = im.closest('a')?.href || '';
      return IMG_EXT.test(im.currentSrc || im.src) || IMG_EXT.test(href) || /vultrobjects|\/uploads?\//i.test(im.src);
    });
  }
  function openLightbox(start, only) {
    const list = only || pageImages();
    let i = Math.max(0, list.indexOf(start));
    const srcOf = (im) => {
      const href = im.closest('a')?.href || '';
      return IMG_EXT.test(href) ? href : im.currentSrc || im.src;
    };
    document.getElementById('dg-lb')?.remove();
    const lb = document.createElement('div');
    lb.id = 'dg-lb';
    lb.innerHTML = `<style>
      #dg-lb{position:fixed;inset:0;z-index:2147483646;background:rgba(15,23,42,.92);display:flex;flex-direction:column;animation:dgLbIn .18s ease;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
      @keyframes dgLbIn{from{opacity:0}to{opacity:1}}
      #dg-lb .lb-top{display:flex;align-items:center;gap:8px;padding:10px 16px;color:#e2e8f0;font-size:13px}
      #dg-lb .lb-top b{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #dg-lb button,#dg-lb a.btn{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff;border-radius:8px;height:34px;min-width:34px;padding:0 10px;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
      #dg-lb button:hover,#dg-lb a.btn:hover{background:rgba(255,255,255,.2)}
      #dg-lb .lb-stage{flex:1;position:relative;overflow:hidden;cursor:grab}
      #dg-lb .lb-stage.drag{cursor:grabbing}
      #dg-lb .lb-img{position:absolute;left:50%;top:50%;max-width:none;transform-origin:center;box-shadow:0 20px 60px rgba(0,0,0,.5);background:#fff;user-select:none;-webkit-user-drag:none;transition:transform .12s ease}
      #dg-lb .lb-nav{position:absolute;top:50%;transform:translateY(-50%);width:46px;height:46px;border-radius:50%;font-size:22px}
      #dg-lb .lb-prev{left:16px} #dg-lb .lb-next{right:16px}
      #dg-lb .lb-pct{min-width:54px;text-align:center}
    </style>
    <div class="lb-top"><b class="lb-name"></b><span class="lb-cnt"></span>
      <button data-a="out" title="Thu nhỏ (−)">－</button><span class="lb-pct"></span><button data-a="in" title="Phóng to (+)">＋</button>
      <button data-a="fit" title="Vừa màn hình (0)">⤢ Vừa</button><button data-a="one" title="Kích thước thật (1)">1:1</button>
      <button data-a="rot" title="Xoay (R)">⟳</button><a class="btn lb-open" target="_blank" rel="noopener" title="Mở ảnh ở tab mới">↗</a><a class="btn lb-dl" title="Tải ảnh">⬇</a>
      <button data-a="close" title="Đóng (Esc)">✕</button></div>
    <div class="lb-stage"><img class="lb-img" alt=""><button class="lb-nav lb-prev" data-a="prev" title="Ảnh trước (←)">‹</button><button class="lb-nav lb-next" data-a="next" title="Ảnh sau (→)">›</button></div>`;
    document.body.append(lb);
    const img = lb.querySelector('.lb-img');
    const stage = lb.querySelector('.lb-stage');
    let z = 1, x = 0, y = 0, rot = 0, fitZ = 1;
    const apply = () => {
      img.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) rotate(${rot}deg) scale(${z})`;
      lb.querySelector('.lb-pct').textContent = `${Math.round(z * 100)}%`;
    };
    const fit = () => {
      const sw = stage.clientWidth - 40, sh = stage.clientHeight - 40;
      const iw = rot % 180 ? img.naturalHeight : img.naturalWidth, ih = rot % 180 ? img.naturalWidth : img.naturalHeight;
      fitZ = Math.min(1, sw / (iw || 1), sh / (ih || 1));
      z = fitZ; x = 0; y = 0;
      apply();
    };
    const show = () => {
      const im = list[i];
      const src = srcOf(im);
      img.style.transition = 'none';
      img.onload = () => {
        fit();
        requestAnimationFrame(() => (img.style.transition = ''));
      };
      img.src = src;
      const name = decodeURIComponent((src.split('/').pop() || '').split('?')[0]);
      lb.querySelector('.lb-name').textContent = name;
      lb.querySelector('.lb-cnt').textContent = list.length > 1 ? `${i + 1} / ${list.length}` : '';
      lb.querySelector('.lb-open').href = src;
      const dl = lb.querySelector('.lb-dl');
      dl.href = src;
      dl.setAttribute('download', name || 'anh.png');
      lb.querySelectorAll('.lb-nav').forEach((b) => (b.style.display = list.length > 1 ? '' : 'none'));
    };
    const zoomAt = (nz, cx = 0, cy = 0) => {
      nz = Math.max(0.1, Math.min(8, nz));
      x = cx - ((cx - x) * nz) / z;
      y = cy - ((cy - y) * nz) / z;
      z = nz;
      apply();
    };
    const close = () => {
      lb.remove();
      document.removeEventListener('keydown', onKey, true);
    };
    const act = (a) => {
      if (a === 'close') close();
      else if (a === 'in') zoomAt(z * 1.25);
      else if (a === 'out') zoomAt(z / 1.25);
      else if (a === 'fit') fit();
      else if (a === 'one') { z = 1; x = 0; y = 0; apply(); }
      else if (a === 'rot') { rot = (rot + 90) % 360; fit(); }
      else if (a === 'prev') { i = (i - 1 + list.length) % list.length; rot = 0; show(); }
      else if (a === 'next') { i = (i + 1) % list.length; rot = 0; show(); }
    };
    lb.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (b) return act(b.dataset.a);
      if (e.target === stage) close(); // bấm nền tối → đóng
    });
    const onKey = (e) => {
      const k = { Escape: 'close', ArrowLeft: 'prev', ArrowRight: 'next', '+': 'in', '=': 'in', '-': 'out', '0': 'fit', '1': 'one', r: 'rot', R: 'rot' }[e.key];
      if (k) {
        e.preventDefault();
        e.stopPropagation();
        act(k);
      }
    };
    document.addEventListener('keydown', onKey, true);
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomAt(z * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    }, { passive: false });
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-a]')) return;
      drag = { sx: e.clientX, sy: e.clientY, x, y, moved: false };
      stage.classList.add('drag');
      img.style.transition = 'none';
    });
    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      x = drag.x + e.clientX - drag.sx;
      y = drag.y + e.clientY - drag.sy;
      drag.moved = true;
      apply();
    });
    window.addEventListener('pointerup', () => {
      if (!drag) return;
      stage.classList.remove('drag');
      img.style.transition = '';
      drag = null;
    });
    img.addEventListener('dblclick', () => (z > fitZ * 1.05 ? fit() : zoomAt(Math.max(1, fitZ * 2.5))));
    show();
  }
  if (IS_TOP)
    document.addEventListener(
      'click',
      (e) => {
        if (e.metaKey || e.ctrlKey || e.button) return;
        let im = e.target.closest?.('img');
        // Bấm chữ tên ảnh (vd. "image.png") → mở ảnh tương ứng
        const a = e.target.closest?.('a[href]');
        if (!im && a && (IMG_EXT.test(a.getAttribute('href') || '') || IMG_EXT.test(a.textContent.trim()))) {
          const imgs = pageImages();
          im = a.querySelector('img') || imgs.find((x) => x.closest('a') === a) || imgs.find((x) => a.parentElement?.contains(x));
          if (!im && IMG_EXT.test(a.href)) {
            e.preventDefault();
            e.stopPropagation();
            const tmp = document.createElement('img');
            tmp.src = a.href;
            return openLightbox(tmp, [tmp]);
          }
        }
        if (!im || !pageImages().includes(im)) return;
        e.preventDefault();
        e.stopPropagation();
        openLightbox(im);
      },
      true,
    );

  // ---------- Trang danh sách Báo giá của CRM: thêm cột "Nhãn" (Flexo/Offset, 🔥 Ưu tiên, Khách cho giá…) trước "Tên cơ hội" ----------
  function crmTagCss() {
    if (document.getElementById('dg-tagcol-css') || !root) return;
    const ok = /^\s*(\.it-main\s+)?\.(knd|nosheet|ctr|bok|tgt|hip|crd|prm|smp|nodep|byr|dl-hotbadge)([.:][\w-]+)*\s*$/;
    let css = '';
    for (const st of root.querySelectorAll('style')) {
      for (const r of st.sheet?.cssRules || []) {
        if (r.type === 7) css += r.cssText + '\n'; // @keyframes
        else if (r.selectorText && r.selectorText.split(',').every((x) => ok.test(x)))
          css += `${r.selectorText.split(',').map((x) => `[data-dg-tagcol] ${x.trim().replace(/^\.it-main\s+/, '')}`).join(',')}{${r.style.cssText}}\n`;
      }
    }
    const el = document.createElement('style');
    el.id = 'dg-tagcol-css';
    el.textContent = css + 'th[data-dg-tagcol],td[data-dg-tagcol]{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:280px !important;max-width:280px !important;min-width:180px} [data-dg-tagcol] span{margin:1px 3px 1px 0 !important;font-size:11px !important;padding:0 7px !important;display:inline-block}';
    document.head.append(el);
  }
  // Bộ lọc nhãn trên trang danh sách CRM (lọc các dòng đang hiện của trang)
  const CRM_F = [
    ['prio', '🔥', 'Ưu tiên', '#ea580c', (q, c) => renderCtx.hotSet?.has(q.id) && !CLOSED.has(q.quoteStatus) && !hasOrderFull(q, c) && !cancelInfo(c)],
    ['flexo', '🟦', 'Flexo', '#2563eb', (q) => (q.kinds || []).includes('flexo')],
    ['offset', '🟪', 'Offset', '#9333ea', (q) => (q.kinds || (q.offset ? ['offset'] : [])).includes('offset')],
    ['bossok', '✅', 'Lấy đơn', '#16a34a', (q, c) => bossOkInfo(q, c)],
    ['tgt', '💲', 'Khách cho giá', '#059669', (q, c) => targetPriceInfo(c)],
    ['buyer', '🤝', 'Thu mua %', '#a21caf', (q, c) => buyerInfo(q, c)],
    ['promise', '🤝', 'Hứa lên đơn', '#d97706', (q, c) => promiseInfo(q, c)],
    ['contract', '📝', 'Hợp đồng', '#0284c7', (q, c) => contractInfo(c)],
    ['sample', '✂️', 'Cắt mẫu', '#db2777', (q, c) => sampleInfo(c)],
    ['high', '💸', 'Giá cao', '#ea580c', (q, c) => highPriceInfo(c)],
    ['credit', '🧾', 'Xin công nợ', '#0d9488', (q, c) => creditInfo(c)],
    ['nodep', '🚫', 'Chưa cọc', '#dc2626', (q, c) => noDepositInfo(c)],
    ['nosheet', '😡', 'Chưa có giá GT', '#dc2626', (q) => q.noSheet],
    ['zero', '⚠️', 'Chưa cho giá', '#dc2626', (q) => noPrice(q)],
  ];
  // Mức chênh lệch (màu giống cột Chênh lệch); BG 0đ → không xếp mức
  const DIFF_LV = [
    ['neg', '🔻 Âm', '#b91c1c'], ['lt5', '< 5tr', '#7e22ce'], ['lt10', '5–10tr', '#c2410c'], ['lt30', '10–30tr', '#2563eb'],
    ['lt50', '30–50tr', '#1e3a8a'], ['ge50', '≥ 50tr', '#15803d'], ['none', '⏳ Chưa tính', '#94a3b8'],
  ];
  function diffLevel(q) {
    if (!(Number(q?.amount) > 0)) return null;
    const v = q.noSheet ? null : diffVal(q);
    if (v == null) return 'none';
    return v < 0 ? 'neg' : v < 5e6 ? 'lt5' : v < 10e6 ? 'lt10' : v < 30e6 ? 'lt30' : v < 50e6 ? 'lt50' : 'ge50';
  }
  function crmFilterBar(wrap, counts, total, staffN = {}, dCounts = {}) {
    const selD = lsGet('dgCrmD') || '';
    const sel = lsGet('dgCrmF') || '';
    const selS = lsGet('dgCrmS') || '';
    let bar = document.getElementById('dg-crmf');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'dg-crmf';
      bar.setAttribute('style', 'display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin:8px 0;padding:6px 8px;font-size:12px;position:relative;z-index:20;background:#f5f7fb;will-change:transform;border-bottom:1px solid #e2e8f0;box-shadow:0 2px 6px rgba(15,23,42,.06)');
      const st0 = document.createElement('style');
      st0.textContent = '#dg-crmf .ava{border-radius:50%;object-fit:cover;flex:none;display:inline-flex;align-items:center;justify-content:center;background:#e0e7ff;color:#4338ca;font-size:10px;font-weight:800}';
      bar.append(st0);
      bar.addEventListener('click', (e) => {
        const dl = e.target.closest('[data-dl]');
        if (dl) {
          lsSet('dgCrmD', lsGet('dgCrmD') === dl.dataset.dl ? '' : dl.dataset.dl);
          return crmListTags();
        }
        const st = e.target.closest('[data-s]');
        if (st) {
          lsSet('dgCrmS', lsGet('dgCrmS') === st.dataset.s ? '' : st.dataset.s);
          return crmListTags();
        }
        const b = e.target.closest('[data-f]');
        if (!b) return;
        lsSet('dgCrmF', lsGet('dgCrmF') === b.dataset.f ? '' : b.dataset.f);
        crmListTags();
      });
      (wrap.closest('.ant-table-wrapper') || wrap).before(bar);
    }
    const html = `<b style="color:#475569;flex:0 0 100px;width:100px">🏷️ Lọc nhãn:</b>${CRM_F.filter(([k]) => counts[k] || sel === k)
      .map(([k, ic, label, col]) => `<span data-f="${k}" style="cursor:pointer;border-radius:999px;padding:2px 10px;font-weight:700;border:1px solid ${col}55;${sel === k ? `background:${col};color:#fff` : `background:${col}12;color:${col}`}">${ic} ${label} <b>${counts[k] || 0}</b></span>`)
      .join('')}${sel ? '<span data-f="" style="cursor:pointer;color:#64748b;text-decoration:underline;margin-left:6px">✕ Bỏ lọc</span>' : ''}<span style="color:#94a3b8;margin-left:auto">lọc trong ${total} dòng của trang này</span>
      <div style="flex-basis:100%;display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:2px"><b style="color:#475569;flex:0 0 100px;width:100px">👤 NVKD:</b>${Object.entries(staffN)
        .sort((a, b) => b[1] - a[1])
        .map(([n, k]) => `<span data-s="${esc(n)}" title="${esc(n)}" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:1px 10px 1px 2px;font-weight:700;border:1px solid ${selS === n ? '#1e293b' : '#e2e8f0'};${selS === n ? 'background:#1e293b;color:#fff' : 'background:#fff;color:#334155'}">${avatarHtml(n, 18)}${esc(shortName(n))} <b style="opacity:.7">${k}</b></span>`)
        .join('')}${selS ? '<span data-s="" style="cursor:pointer;color:#64748b;text-decoration:underline;margin-left:6px">✕ Bỏ lọc NVKD</span>' : ''}</div>
      <div style="flex-basis:100%;display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:2px"><b style="color:#475569;flex:0 0 100px;width:100px">📈 Chênh lệch:</b>${DIFF_LV.filter(([k]) => dCounts[k] || selD === k)
        .map(([k, label, col]) => `<span data-dl="${k}" style="cursor:pointer;border-radius:999px;padding:2px 10px;font-weight:800;border:1px solid ${col}55;${selD === k ? `background:${col};color:#fff` : `background:${col}14;color:${col}`}">${label} <b style="opacity:.75">${dCounts[k] || 0}</b></span>`)
        .join('')}${selD ? '<span data-dl="" style="cursor:pointer;color:#64748b;text-decoration:underline;margin-left:6px">✕ Bỏ lọc chênh lệch</span>' : ''}</div>`;
    if (bar.dataset.h !== html) {
      bar.dataset.h = html;
      bar.innerHTML = `<style>#dg-crmf .ava{border-radius:50%;object-fit:cover;flex:none;display:inline-flex;align-items:center;justify-content:center;background:#e0e7ff;color:#4338ca;font-size:10px;font-weight:800}</style>${html}`;
    }
  }
  // Hàng ô lọc của CRM: ẩn cả hàng; ô "Tìm kiếm" + "Chỉ lấy của Tuấn Tú" làm lại cạnh thanh phân trang
  // (ô của mình gõ → chuyển sang ô gốc của CRM, nên CRM vẫn tự tìm như cũ)
  function crmCompactFilters() {
    const lbl = [...document.querySelectorAll('label, span, div')].find((e) => e.childElementCount === 0 && e.textContent.trim() === 'Số lớp' && !e.closest('#dg-root, .ant-table'));
    if (!lbl) return;
    let row = lbl;
    while (row && !(row.innerText || '').includes('Mở hàng loạt')) row = row.parentElement;
    if (!row) return;
    const srcInput = [...row.querySelectorAll('input')].find((x) => /tìm kiếm/i.test(x.placeholder || ''));
    const srcCheck = row.querySelector('input[type="checkbox"]');
    row.style.setProperty('display', 'none', 'important');
    const pag = [...document.querySelectorAll('.ant-pagination')].find((p) => !p.closest('#dg-root') && p.getClientRects().length);
    if (!pag) return;
    // Bỏ khoảng trống còn lại: các khung bọc chỉ chứa hàng ô lọc (giờ rỗng) cũng ẩn; khung rỗng nằm giữa tabs và phân trang cũng ẩn
    let el = row;
    while (el.parentElement && !el.parentElement.contains(pag) && !(el.parentElement.innerText || '').trim()) {
      el = el.parentElement;
      el.style.setProperty('display', 'none', 'important');
    }
    for (const sib of el.parentElement ? [...el.parentElement.children] : []) {
      if (sib === el || sib.contains(pag) || sib.querySelector('input, button, .ant-tabs')) continue;
      if (!(sib.innerText || '').trim() && sib.getBoundingClientRect().height > 0 && sib.getBoundingClientRect().top > row.parentElement.getBoundingClientRect().top - 200)
        sib.style.setProperty('display', 'none', 'important');
    }
    if (el.parentElement) {
      el.parentElement.style.setProperty('row-gap', '0', 'important');
      el.parentElement.style.setProperty('gap', '0', 'important');
    }
    let bar = document.getElementById('dg-crmsearch');
    if (!bar) {
      bar = document.createElement('li'); // nằm trong thanh phân trang (cùng hàng, bên phải "Page")
      bar.id = 'dg-crmsearch';
      bar.setAttribute('style', 'display:inline-flex;align-items:center;gap:14px;margin-left:16px;vertical-align:middle;list-style:none');
      bar.innerHTML = `<span style="position:relative;display:inline-flex;align-items:center"><input type="search" placeholder="🔍 Tìm kiếm báo giá…" style="width:240px;height:32px;border:1px solid #d9d9d9;border-radius:6px;padding:0 10px;font:inherit;font-size:14px;outline:none"></span>
        <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:14px;white-space:nowrap"><input type="checkbox" style="width:16px;height:16px;cursor:pointer"> Chỉ lấy của ${esc(SITE.name)}</label>`;
      pag.append(bar);
      const inp = bar.querySelector('input[type="search"]');
      const chk = bar.querySelector('input[type="checkbox"]');
      const push = (enter) => {
        const src = document.getElementById('dg-crmsearch')?._src;
        if (!src) return;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(src, inp.value);
        src.dispatchEvent(new Event('input', { bubbles: true }));
        src.dispatchEvent(new Event('change', { bubbles: true }));
        if (enter) {
          for (const t of ['keydown', 'keypress', 'keyup']) src.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          src.closest('.ant-input-affix-wrapper, .ant-input-search, .ant-input-group-wrapper')?.querySelector('.anticon-search, .ant-input-search-button, .ant-input-suffix')?.click();
        }
      };
      let tm;
      inp.addEventListener('input', () => {
        clearTimeout(tm);
        tm = setTimeout(() => push(true), 500);
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          clearTimeout(tm);
          push(true);
        }
      });
      chk.addEventListener('change', () => {
        const src = document.getElementById('dg-crmsearch')?._chk;
        if (src && src.checked !== chk.checked) src.click();
      });
    }
    if (bar.parentElement !== pag) pag.append(bar);
    bar._src = srcInput;
    bar._chk = srcCheck;
    const myChk = bar.querySelector('input[type="checkbox"]');
    if (srcCheck && myChk.checked !== srcCheck.checked) myChk.checked = srcCheck.checked;
    const myInp = bar.querySelector('input[type="search"]');
    if (srcInput && document.activeElement !== myInp && myInp.value !== srcInput.value) myInp.value = srcInput.value;
  }
  // Ảnh đại diện NVKD (dùng ngoài bảng của extension – style viết thẳng)
  const avaInline = (name, size = 22) => {
    const url = avatarUrl(avatars[name]);
    const ini = (name || '?').split(/\s+/).slice(-1)[0].slice(0, 1).toUpperCase();
    const base = `width:${size}px;height:${size}px;border-radius:50%;flex:none;`;
    return url
      ? `<img src="${esc(url)}" alt="" style="${base}object-fit:cover">`
      : `<span style="${base}display:inline-flex;align-items:center;justify-content:center;background:#e0e7ff;color:#4338ca;font-size:11px;font-weight:800">${esc(ini)}</span>`;
  };
  // Giữ thanh lọc + tiêu đề bảng cố định khi cuộn (dịch bằng transform – chạy được cả khi trang cuộn trong khung riêng)
  let stickRaf = 0;
  function crmStick() {
    stickRaf = 0;
    const bar = document.getElementById('dg-crmf');
    if (!bar || !bar.isConnected) return;
    const wrap = bar.nextElementSibling?.querySelector?.('.ant-table') || document.querySelector('.ant-table');
    const thead = wrap?.querySelector('thead');
    const tbody = wrap?.querySelector('tbody');
    const cur = (el) => Number(el.dataset.dgTy || 0);
    const set = (el, y) => {
      el.dataset.dgTy = y;
      el.style.transform = y ? `translateY(${y}px)` : '';
    };
    const barTop = bar.getBoundingClientRect().top - cur(bar);
    const barH = bar.offsetHeight;
    const bottom = (tbody || wrap || bar).getBoundingClientRect().bottom;
    const by = Math.max(0, Math.min(-barTop, bottom - cur(bar) - barH - 60 - barTop));
    set(bar, Math.round(by));
    if (thead) {
      const ths = [...thead.querySelectorAll('th')];
      const th0 = ths[0];
      if (th0) {
        const hTop = th0.getBoundingClientRect().top - cur(th0);
        const hy = Math.max(0, Math.min(barH - hTop + (by ? 0 : barTop < 0 ? 0 : 0), bottom - 40 - hTop));
        const y = barTop < 0 ? Math.round(hy) : 0;
        for (const th of ths) {
          set(th, y);
          th.style.position = 'relative';
          th.style.zIndex = y ? '19' : '';
          if (y && !th.style.background) th.style.background = '#fafafa';
        }
      }
    }
  }
  const stickReq = () => {
    if (!stickRaf) stickRaf = requestAnimationFrame(crmStick);
  };
  if (IS_TOP) {
    window.addEventListener('scroll', stickReq, true);
    window.addEventListener('resize', stickReq);
  }
  // ---------- Trang "Danh sách đơn" của CRM: đọc các đơn (mã DH, giờ lên đơn, BG, Tổng tiền) → kv dayOrders ----------
  function scrapeDayOrders(doc) {
    if (![...doc.querySelectorAll('h1, h2, h3, h4, div, span')].some((e) => !e.children.length && /^Danh sách đơn$/i.test(e.textContent.trim()))) return null;
    const t = [...doc.querySelectorAll('.ant-table')].find((x) => {
      const hs = [...x.querySelectorAll('thead th')].map((th) => th.innerText.trim());
      return hs.includes('Tổng tiền') && hs.includes('Báo giá');
    });
    if (!t) return null;
    const hs = [...t.querySelectorAll('thead th')].map((th) => th.innerText.trim());
    const ti = hs.indexOf('Tổng tiền');
    const out = {};
    for (const tr of t.querySelectorAll('tbody tr')) {
      const txt = tr.innerText || '';
      const dh = txt.match(/DH\d{5,}/)?.[0];
      const tm = txt.match(/(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (!dh || !tm || tr.cells.length < hs.length) continue; // chỉ hàng đầu của mỗi đơn (đủ ô)
      const at = Date.UTC(+tm[5], +tm[4] - 1, +tm[3], +tm[1], +tm[2]) - 7 * 3600e3;
      const total = Number(String(tr.cells[ti]?.innerText || '').replace(/[^\d]/g, '')) || 0;
      const qid = Number([...tr.querySelectorAll('a[href]')].map((a) => a.getAttribute('href').match(/\/(?:bao-gia|co-hoi)\/(?:update|view)\/(\d+)/)?.[1]).find(Boolean)) || null;
      out[dh] = { dh, at, bg: txt.match(/BG\d{3,}/)?.[0] || '', qid, total, cancel: /Hủy|Huỷ/.test(tr.cells[0]?.innerText || '') };
    }
    return Object.keys(out).length ? out : null;
  }
  let dayOrdersSig = '';
  async function saveDayOrders(doc, path) {
    const got = scrapeDayOrders(doc);
    if (!got) return false;
    const sig = JSON.stringify(got);
    if (sig === dayOrdersSig) return true;
    dayOrdersSig = sig;
    const keepFrom = Date.now() - 62 * 86400e3; // giữ 2 tháng để xem lại các ngày trước
    const old = await kvGet('dayOrders');
    const patch = { ...Object.fromEntries(Object.entries(got).filter(([, o]) => o.at >= keepFrom)), _src: { path, at: Date.now() } };
    for (const [k2, o] of Object.entries(old)) if (k2 !== '_src' && !(o?.at >= keepFrom)) patch[k2] = null;
    await kvMerge('dayOrders', patch).catch(() => {});
    return true;
  }
  // Đang mở trang Danh sách đơn → lưu ngay (mỗi 5 giây)
  setInterval(() => {
    if (IS_TOP) saveDayOrders(document, location.pathname).catch(() => {});
  }, 5000);
  // Luồng riêng: 5 phút / lần mở ngầm /misa-order/list (tab "Mới" + "Hoàn thành", đọc tới khi qua ngày đang xem, tối đa 6 trang/tab)
  // Chỉ 1 tab CRM chạy (khoá localStorage)
  let dayOrdersBusy = false;
  const loadDayState = async () => {
    const all = await kvGet('dayOrders');
    state.dayOrders = Object.fromEntries(Object.entries(all).filter(([k2, o]) => k2 !== '_src' && o));
    return all;
  };
  const tabLock = (key, ms) => {
    const v = JSON.parse(lsGet(key) || 'null');
    if (v && v.tab !== TAB_ID && Date.now() - v.at < ms) return false;
    lsSet(key, JSON.stringify({ tab: TAB_ID, at: Date.now() }));
    return true;
  };
  async function refreshDayOrders(force = false) {
    if (!IS_TOP || dayOrdersBusy || !MY_ADMIN) return;
    const all = await loadDayState();
    if (!force && Date.now() - (all._src?.at || 0) < 5 * 60e3) return;
    if (!tabLock('dgDayOrdLock', 90e3)) return;
    dayOrdersBusy = true;
    const f = document.createElement('iframe');
    f.name = 'dg-collector';
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1400px;height:900px;visibility:hidden;pointer-events:none';
    f.src = '/misa-order/list';
    document.documentElement.append(f);
    const doc = () => f.contentDocument;
    const firstDh = () => (doc()?.querySelector('.ant-table-tbody')?.innerText.match(/DH\d{5,}/) || [])[0] || '';
    const waitChange = async (prev) => {
      for (let i = 0; i < 40; i++) {
        await sleep(400);
        const d = firstDh();
        if (d && d !== prev) return true;
      }
      return false;
    };
    const got = {};
    try {
      for (let i = 0; i < 60 && !scrapeDayOrders(doc() || document.createElement('div')); i++) await sleep(500);
      const [d0] = kpiDayRange();
      const dv = new Date(d0 + 7 * 3600e3);
      const mStart = Date.UTC(dv.getUTCFullYear(), dv.getUTCMonth(), 1) - 7 * 3600e3; // đọc đủ cả tháng (ô chênh lệch tháng)
      const stopAt = Math.min(d0, mStart, Date.now() - 86400e3) - 3600e3;
      for (const tabName of ['Mới', 'Hoàn thành']) {
        const tab = [...(doc()?.querySelectorAll('.ant-tabs-tab') || [])].find((t) => t.innerText.replace(/\d+/g, '').trim() === tabName);
        if (tab && !tab.classList.contains('ant-tabs-tab-active')) {
          const prev = firstDh();
          (tab.querySelector('.ant-tabs-tab-btn') || tab).click();
          await waitChange(prev);
          await sleep(800);
        }
        for (let page = 1; page <= 12; page++) {
          if (page > 1) {
            const li = doc()?.querySelector(`.ant-pagination-item-${page}`);
            if (!li) break;
            const prev = firstDh();
            li.click();
            if (!(await waitChange(prev))) break;
            await sleep(600);
          }
          const rows = scrapeDayOrders(doc()) || {};
          Object.assign(got, rows);
          const oldest = Math.min(...Object.values(rows).map((o) => o.at));
          if (!Number.isFinite(oldest) || oldest < stopAt) break;
        }
      }
      if (Object.keys(got).length) {
        const keepFrom = Date.now() - 62 * 86400e3;
        const patch = { ...Object.fromEntries(Object.entries(got).filter(([, o]) => o.at >= keepFrom)), _src: { path: '/misa-order/list', at: Date.now() } };
        for (const [k2, o] of Object.entries(all)) if (k2 !== '_src' && o && !(o.at >= keepFrom)) patch[k2] = null;
        await kvMerge('dayOrders', patch).catch(() => {});
      }
    } finally {
      f.remove();
      dayOrdersBusy = false;
    }
    await loadDayState();
  }
  setTimeout(() => refreshDayOrders().catch(() => {}), 5000);
  setInterval(() => refreshDayOrders().catch(() => {}), 60000);
  // Đơn (ngày đang xem) chưa có chênh lệch → mở ngầm báo giá để tính (mỗi lượt tối đa 2 báo giá, 1 báo giá thử lại sau 3 giờ)
  let dayDiffBusy = false;
  async function fillDayDiffs() {
    if (!IS_TOP || dayDiffBusy || dayOrdersBusy || (collect.running && !state.diffFocus) || !MY_ADMIN || (!state.dayOrders && !state.misaNeed?.length && !state.listNeed?.length)) return;
    const [d0, d1] = kpiDayRange();
    const tried = JSON.parse(lsGet('dgDayDiffTry') || '{}');
    const byCode = renderCtx.byCode || {};
    const need = [...(state.misaNeed || []), ...(state.listNeed || []), ...Object.values(state.dayOrders || {})]
      .filter((o, i, arr) => o?.bg && !o.cancel && Date.now() - (tried[o.bg] || 0) > 3 * 3600e3 && arr.findIndex((x) => x?.bg === o.bg) === i)
      .filter((o) => {
        const q = byCode[o.bg];
        return q ? diffVal(q) == null && !q.noSheet && !(q.amount === 0 && q.kinds?.length) : !!o.qid;
      })
      // ngày đang xem trước, rồi đơn mới nhất
      .sort((a, b) => !!state.diffFocus?.has(b.bg) - !!state.diffFocus?.has(a.bg) || (b.at > 1e12) - (a.at > 1e12) || (b.at >= d0 && b.at < d1) - (a.at >= d0 && a.at < d1) || b.at - a.at)
      .slice(0, 3);
    if (need.length && !tabLock('dgDayDiffLock', 120e3)) return;
    if (!need.length) return;
    dayDiffBusy = true;
    try {
      for (const [ni, o] of need.entries()) {
        state.diffReading = { bg: o.bg, step: 'mở báo giá', left: need.length - ni - 1 };
        try { misaListDiff(); } catch {}
        tried[o.bg] = Date.now();
        lsSet('dgDayDiffTry', JSON.stringify(tried));
        let q = byCode[o.bg];
        // chưa có báo giá trong dữ liệu → mở trang chi tiết 1 lần để lấy (loại Flexo/Offset, số tiền)
        if (!q && o.qid) {
          await loadInFrame(o.qid);
          q = (await kvGet('quotes'))[o.qid];
          if (!q) continue;
        }
        const k = q.kinds || (q.offset ? ['offset'] : []);
        const mg = (await kvGet('margins'))[q.code] || {};
        // đã tới đây là chưa ra chênh lệch → đọc lại dù số cũ chưa "quá hạn"
        const needOff = k.includes('offset') && (offsetStale(mg, q) || diffVal(q) == null);
        const needFx = k.includes('flexo') && q.amount && (flexoStale(mg.flexo, q) || diffVal(q) == null);
        if (!needOff && !needFx && !k.length) {
          // chưa biết loại → mở lại để đọc tổng theo loại rồi thử tính cả hai
          await loadInFrame(q.id, undefined, undefined, async (f) => {
            await readOffsetMargins(f, q.code).catch(() => {});
            await readFlexoCost(f, q).catch(() => {});
          });
        } else if (needOff || needFx) {
          state.diffReading.step = [needOff && 'đọc chiết giá Offset', needFx && 'đọc PO giấy tấm Flexo'].filter(Boolean).join(' + ');
          await loadInFrame(q.id, undefined, undefined, async (f) => {
            if (needOff) await readOffsetMargins(f, q.code);
            if (needFx) await readFlexoCost(f, q);
          });
        }
        // cập nhật ngay ô của báo giá vừa đọc
        renderCtx.margins = await kvGet('margins');
        renderCtx.quotes = await kvGet('quotes');
      }
      renderCtx.margins = await kvGet('margins');
      renderCtx.quotes = await kvGet('quotes');
    } finally {
      dayDiffBusy = false;
      state.diffReading = null;
      try { misaListDiff(); } catch {}
    }
  }
  setInterval(() => fillDayDiffs().catch(() => {}), 20000);
  // Ngày đang xem ở 3 ô số liệu: 0 = hôm nay, 1 = hôm qua…
  const kpiDayRange = () => {
    const vn = new Date(Date.now() + 7 * 3600e3);
    const d0 = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - 7 * 3600e3 - (state.kpiDay || 0) * 86400e3;
    return [d0, d0 + 86400e3];
  };
  // Bấm ⏳ ở ô số liệu: danh sách đơn chưa có chênh lệch (ngày / tháng đang xem) + đọc ngầm tính tiếp liên tục khi hộp đang mở
  function missDiffList(scope) {
    const [d0, d1] = kpiDayRange();
    const dv = new Date(d0 + 7 * 3600e3);
    const from = scope === 'month' ? Date.UTC(dv.getUTCFullYear(), dv.getUTCMonth(), 1) - 7 * 3600e3 : d0;
    const byCode = renderCtx.byCode || {};
    return Object.values(state.dayOrders || {})
      .filter((o) => o?.at >= from && o.at < d1 && !o.cancel)
      .map((o) => ({ ...o, q: o.bg ? byCode[o.bg] : null }))
      .filter((o) => !(o.q && !o.q.noSheet && diffVal(o.q) != null))
      .filter((o) => !(o.q && !(Number(o.q.amount) > 0))) // BG 0đ (chưa cho giá) → bỏ qua
      .sort((a, b) => b.at - a.at);
  }
  function openMissDiff(scope) {
    document.getElementById('dg-miss')?.remove();
    const tried = () => JSON.parse(lsGet('dgDayDiffTry') || '{}');
    // mở hộp = tính lại ngay các đơn này (bỏ thời gian chờ 3 giờ), ưu tiên trước
    const t0 = tried();
    const first = missDiffList(scope);
    for (const o of first) if (o.bg) delete t0[o.bg];
    lsSet('dgDayDiffTry', JSON.stringify(t0));
    state.diffFocus = new Set(first.map((o) => o.bg).filter(Boolean));
    lsSet('dgDayDiffLock', JSON.stringify({ tab: TAB_ID, at: Date.now() })); // tab đang mở hộp nhận việc đọc
    const box = document.createElement('div');
    box.id = 'dg-miss';
    box.setAttribute('style', 'position:fixed;inset:0;z-index:2147483646;background:rgba(15,23,42,.35);display:grid;place-items:center;font-family:inherit');
    box.innerHTML = `<div style="width:min(760px,94vw);max-height:84vh;display:flex;flex-direction:column;background:#fff;border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.35);overflow:hidden">
      <div style="display:flex;align-items:center;gap:8px;padding:12px 16px;background:linear-gradient(90deg,#fff7ed,#fef3c7);border-bottom:1px solid #fde68a">
        <b style="font-size:15px">⏳ Đơn chưa tính chênh lệch – ${scope === 'month' ? 'cả tháng' : 'ngày đang xem'}</b><span data-st style="font-size:12px;color:#92400e"></span>
        <button data-x style="margin-left:auto;all:unset;cursor:pointer;font-size:20px;color:#64748b;padding:0 6px">×</button></div>
      <div data-l style="overflow:auto;padding:8px 12px"></div>
      <div style="padding:8px 16px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b">Hộp đang mở: đọc ngầm liên tục từng báo giá (ưu tiên các đơn này). Đóng hộp vẫn tiếp tục chậm hơn ở chế độ nền.</div></div>`;
    document.body.append(box);
    const close = () => {
      clearInterval(tm);
      state.diffFocus = null;
      box.remove();
    };
    box.addEventListener('click', (e) => {
      if (e.target === box || e.target.closest('[data-x]')) close();
    });
    const why = (o) => {
      if (state.diffReading?.bg === o.bg) return `<span style="color:#2563eb;font-weight:700"><i class="dg-spin"></i> đang đọc · ${esc(state.diffReading.step || '')}</span>`;
      if (!o.bg) return '<span style="color:#94a3b8">đơn không gắn báo giá</span>';
      if (o.q?.noSheet) return '<span style="color:#b91c1c">😡 chưa có giá giấy tấm</span>';
      if (o.q && o.q.amount === 0) return '<span style="color:#94a3b8">BG 0đ – chưa cho giá</span>';
      if (!o.q && !o.qid) return '<span style="color:#94a3b8">chưa có mã báo giá để mở</span>';
      const t = tried()[o.bg];
      return t ? `<span style="color:#c2410c">đã thử ${new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} – chưa ra số</span>` : '<span style="color:#d97706">⏳ chờ đọc</span>';
    };
    const draw = () => {
      if (!document.getElementById('dg-spin-css')) {
        const st = document.createElement('style');
        st.id = 'dg-spin-css';
        st.textContent = '@keyframes dgSpin{to{transform:rotate(360deg)}}.dg-spin{display:inline-block;width:12px;height:12px;border:2px solid #bfdbfe;border-top-color:#2563eb;border-radius:50%;animation:dgSpin .8s linear infinite;vertical-align:-2px}';
        document.head.append(st);
      }
      const list = missDiffList(scope);
      const rev = list.reduce((t, o) => t + (o.total || 0), 0);
      const fmt = (v) => (v >= 1e9 ? `${(v / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ` : trM(v));
      box.querySelector('[data-st]').innerHTML = list.length
        ? `<span style="display:inline-flex;gap:6px;margin-left:6px"><span style="background:#fff;border:1px solid #fcd34d;border-radius:999px;padding:1px 10px;font-weight:800;color:#b45309">📄 ${list.length} đơn chưa tính</span><span style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:999px;padding:1px 10px;font-weight:800;color:#047857" title="${esc(money(rev))}">💰 ${fmt(rev)}</span></span>`
        : '✅ đã tính xong';
      box.querySelector('[data-l]').innerHTML = list.length
        ? `<table style="width:100%;border-collapse:collapse;font-size:12.5px">${list
            .map((o) => {
              const id = o.q?.id || o.qid;
              return `<tr style="border-bottom:1px solid #f1f5f9${state.diffReading?.bg === o.bg ? ';background:#eff6ff' : ''}"><td style="padding:5px 6px;white-space:nowrap;color:#64748b">${new Date(o.at + 7 * 3600e3).toLocaleString('vi-VN', { timeZone: 'UTC', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                <td style="padding:5px 6px;font-weight:700">${esc(o.dh || '')}</td>
                <td style="padding:5px 6px">${id && o.bg ? `<a href="/bao-gia/update/${id}" target="_blank" style="font-weight:800;color:#1d4ed8">${esc(o.bg)}</a>` : esc(o.bg || '–')}</td>
                <td style="padding:5px 6px;text-align:right;font-weight:700;color:#047857;white-space:nowrap">${money(o.total || 0)}</td>
                <td style="padding:5px 6px">${why(o)}</td></tr>`;
            })
            .join('')}</table>`
        : '<div style="padding:20px;text-align:center;color:#15803d;font-weight:700">✅ Mọi đơn đã có chênh lệch</div>';
    };
    draw();
    const tm = setInterval(() => {
      if (!box.isConnected) return clearInterval(tm);
      fillDayDiffs().catch(() => {});
      draw();
    }, 2000);
  }
  // 3 ô số liệu cạnh hàng tab trạng thái: Số đơn · Doanh thu · Tổng chênh lệch (theo các dòng đang hiện)
  // Doanh số tháng đúng như biểu đồ "Doanh số tháng này" của CRM: API dashboard/saleByDate (Σ totalSale theo ngày).
  // Chỉ đọc, dùng phiên đăng nhập sẵn có của trang; lưu tạm 5 phút.
  const crmSale = {};
  function crmSaleSum(from, to) {
    const key = `${from}|${to}`;
    const c = crmSale[key];
    if (c && Date.now() - c.at < 5 * 60e3) return c.total;
    if (!c?.busy) {
      crmSale[key] = { ...(c || {}), busy: true, at: c?.at || 0 };
      (async () => {
        try {
          const tok = JSON.parse(localStorage.getItem('UserStore') || '{}').token;
          const ver = (document.body.innerText.match(/v(\d+\.\d+\.\d+)/) || [])[1];
          if (!tok || !ver) throw new Error('no auth');
          const r = await fetch(`${API_BASE}/v1/admin/dashboard/saleByDate?fromDate=${from}&toDate=${to}`, { headers: { token: tok, version: ver, 'X-Client-Version': ver } });
          const j = await r.json();
          const arr = Array.isArray(j?.data) ? j.data : [];
          if (!r.ok || !arr.length && j?.status === false) throw new Error('api');
          crmSale[key] = { total: arr.reduce((a, x) => a + (Number(x.totalSale) || 0), 0), at: Date.now() };
        } catch {
          crmSale[key] = { ...(crmSale[key] || {}), busy: false, at: Date.now() - 4 * 60e3 }; // thử lại sau ~1 phút
        }
      })();
    }
    return c?.total ?? null;
  }

  const DIFF_GOAL_MONTH = 4.5e9; // mục tiêu chênh lệch mỗi tháng
  function crmKpiTiles(wrap, k) {
    const nav = [...document.querySelectorAll('.ant-tabs-nav')].find((x) => /Tất cả/.test(x.innerText) && /Thành công|Chờ xin giá/.test(x.innerText));
    if (!nav) return;
    let box = nav.querySelector(':scope > [data-dg-kpi]');
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('data-dg-kpi', '1');
      box.setAttribute('style', 'display:flex;flex-wrap:nowrap;gap:6px;align-items:center;margin-left:12px;flex:none;white-space:nowrap');
      nav.append(box);
      box.addEventListener('click', (e) => {
        const ms = e.target.closest('[data-dg-miss]');
        if (ms) {
          e.preventDefault();
          e.stopPropagation();
          return openMissDiff(ms.dataset.dgMiss);
        }
        const b = e.target.closest('[data-dg-kd]');
        if (!b || b.disabled) return;
        e.preventDefault();
        e.stopPropagation();
        const d = Number(b.dataset.dgKd);
        state.kpiDay = d === 0 ? 0 : Math.max(0, Math.min(60, (state.kpiDay || 0) + d));
        crmKpiTiles(null, {});
        // ngày cũ chưa có đơn nào trong dữ liệu → đọc thêm trang Danh sách đơn tới ngày đó
        const [a0, a1] = kpiDayRange();
        if (!Object.values(state.dayOrders || {}).some((o) => o.at >= a0 && o.at < a1)) refreshDayOrders(true).then(() => crmKpiTiles(null, {})).catch(() => {});
        fillDayDiffs().catch(() => {});
      });
    }
    // Đơn lên HÔM NAY (giờ VN): theo trang "Danh sách đơn" của CRM (đọc ngầm, lưu kv dayOrders)
    const [vn0, vn1] = kpiDayRange();
    const byCode = renderCtx.byCode || {};
    const list = Object.values(state.dayOrders || {})
      .filter((o) => o?.at >= vn0 && o.at < vn1 && !o.cancel)
      .map((o) => ({ ...o, q: o.bg ? byCode[o.bg] : null }));
    k = { n: list.length, sum: list.reduce((t, x) => t + (x.total || 0), 0), dsum: 0, dn: 0 };
    // Chênh lệch theo DOANH THU THỰC của đơn: tỷ lệ chênh lệch của báo giá × tổng tiền đơn
    // (1 báo giá lên nhiều đơn / đơn lấy 1 phần → không cộng trùng cả báo giá)
    const orderDiff = (o, q) => {
      const v = q && !q.noSheet ? diffVal(q) : null;
      if (v == null) return null;
      const amt = Number(q.amount) || 0;
      return amt > 0 && o.total > 0 ? (v * o.total) / amt : v;
    };
    for (const x of list) {
      const v = orderDiff(x, x.q);
      if (v != null) {
        k.dsum += v;
        k.dn++;
      }
    }
    // Tháng của ngày đang xem: tổng chênh lệch các đơn từ ngày 1 tới hết ngày đang xem
    const mvn = new Date(vn0 + 7 * 3600e3);
    const m0 = Date.UTC(mvn.getUTCFullYear(), mvn.getUTCMonth(), 1) - 7 * 3600e3;
    const mList = Object.values(state.dayOrders || {}).filter((o) => o?.at >= m0 && o.at < vn1 && !o.cancel);
    let mSum = 0;
    let mDn = 0;
    let mRev = 0;
    for (const o of mList) {
      mRev += o.total || 0;
      const q = o.bg ? byCode[o.bg] : null;
      const v = orderDiff(o, q);
      if (v != null) {
        mSum += v;
        mDn++;
      }
    }
    const mMiss = mList.filter((o) => !(o.bg && byCode[o.bg] && !(Number(byCode[o.bg].amount) > 0))).length - mDn;
    const names = list.map((x) => `${x.dh || ''}${x.bg ? ` · ${x.bg}` : ''} · ${money(x.total || 0)}`).join('\n');
    const big = (v) => (Math.abs(v) >= 1e9 ? `${(v / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ` : trM(v));
    const tile = (ic, lab, val, fg, bg, bd, tip) =>
      `<div title="${esc(tip)}" style="display:grid;gap:0;min-width:90px;padding:4px 10px;border-radius:12px;background:${bg};border:1.5px solid ${bd};box-shadow:0 2px 8px rgba(15,23,42,.06);line-height:1.25">
        <span style="font-size:11px;font-weight:700;color:#64748b;white-space:nowrap">${ic} ${lab}</span><b style="font-size:18px;font-weight:900;color:${fg};white-space:nowrap;font-variant-numeric:tabular-nums">${val}</b></div>`;
    const kd = state.kpiDay || 0;
    const dLab = kd === 0 ? 'Hôm nay' : kd === 1 ? 'Hôm qua' : new Date(vn0 + 7 * 3600e3).toLocaleDateString('vi-VN', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' });
    const nb = (dir, dis, t) => `<button data-dg-kd="${dir}" ${dis ? 'disabled' : ''} title="${t}" style="all:unset;cursor:${dis ? 'default' : 'pointer'};display:grid;place-items:center;width:28px;height:28px;border-radius:999px;border:1px solid #cbd5e1;background:#fff;color:${dis ? '#cbd5e1' : '#334155'};font-weight:900;font-size:15px">${dir > 0 ? '‹' : '›'}</button>`;
    const zero = (x) => x.q && !(Number(x.q.amount) > 0); // BG 0đ → không tính, không đếm
    const missing = list.filter((x) => !zero(x)).length - k.dn;
    const html =
      `<div style="display:flex;align-items:center;gap:6px">${nb(1, kd >= 60, 'Ngày trước')}<div style="display:grid;text-align:center;min-width:78px;line-height:1.2"><b style="font-size:13px;color:#0f172a">${esc(dLab)}</b>${kd ? `<a data-dg-kd="0" style="font-size:11px;color:#2563eb;cursor:pointer">↩ hôm nay</a>` : '<span style="font-size:11px;color:#94a3b8">ngày lên đơn</span>'}</div>${nb(-1, kd <= 0, 'Ngày sau')}</div>` +
      tile('📄', kd === 0 ? 'Đơn hôm nay' : 'Số đơn', (k.n || 0).toLocaleString('vi-VN'), '#1d4ed8', '#eff6ff', '#bfdbfe', `Số đơn hàng lên hôm nay${names ? `:\n${names}` : ''}`) +
      tile('💰', 'Doanh thu', big(k.sum || 0), '#047857', '#ecfdf5', '#a7f3d0', `Doanh thu các đơn lên hôm nay (cột Tổng tiền – Danh sách đơn): ${money(k.sum || 0)}`) +
      // Tổng chênh lệch ngày + còn thiếu so với mục tiêu ngày (4,5 tỷ chênh lệch/tháng ÷ số ngày công của tháng, trừ Chủ nhật)
      (() => {
        const y = mvn.getUTCFullYear();
        const mo = mvn.getUTCMonth();
        const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
        let wd = 0;
        for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, mo, d)).getUTCDay() !== 0) wd++;
        const goal = DIFF_GOAL_MONTH / (wd || 1);
        const gap = goal - (k.dsum || 0);
        const neg = k.dsum < 0;
        const lab = `Tổng chênh lệch${missing > 0 ? ` <span data-dg-miss="day" style="color:#d97706;cursor:pointer;text-decoration:underline dotted" title="Bấm để xem các đơn chưa tính chênh lệch và tính tiếp">⏳${missing}</span>` : ''}`;
        const tip = `Tổng chênh lệch của ${k.dn || 0}/${k.n || 0} đơn ${kd === 0 ? 'hôm nay' : 'ngày đang xem'} đã tính được (Flexo: BG − giấy tấm · Offset: BG − NVL): ${money(Math.round(k.dsum || 0))}\nMục tiêu ngày = ${money(DIFF_GOAL_MONTH)} ÷ ${wd} ngày công T${mo + 1} (trừ Chủ nhật) = ${money(Math.round(goal))}\n${gap > 0 ? `Còn thiếu ${money(Math.round(gap))}` : `Đã vượt ${money(Math.round(-gap))}`}`;
        return `<div title="${esc(tip)}" style="display:grid;gap:0;min-width:90px;padding:4px 10px;border-radius:12px;background:${neg ? '#fef2f2' : '#f5f3ff'};border:1.5px solid ${neg ? '#fecaca' : '#ddd6fe'};box-shadow:0 2px 8px rgba(15,23,42,.06);line-height:1.25">
          <span style="font-size:11px;font-weight:700;color:#64748b;white-space:nowrap">📈 ${lab}</span>
          <b style="font-size:18px;font-weight:900;color:${neg ? '#b91c1c' : '#7c3aed'};white-space:nowrap;font-variant-numeric:tabular-nums">${k.dn ? `${neg ? '−' : ''}${big(Math.abs(k.dsum))}` : '–'}</b>
          <span style="font-size:11px;font-weight:700;white-space:nowrap;color:${gap > 0 ? '#b45309' : '#047857'}">${gap > 0 ? `→ còn thiếu ${big(gap)}` : `✓ vượt ${big(-gap)}`} <span style="color:#94a3b8;font-weight:600">(mục tiêu ${big(goal)}/ngày)</span></span></div>`;
      })() +
      // Chênh lệch tháng + dự báo cả tháng theo ngày công (gộp 1 ô, giống ô Doanh thu tháng)
      (() => {
        const y = mvn.getUTCFullYear();
        const mo = mvn.getUTCMonth();
        const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
        let total = 0;
        let done = 0;
        for (let d = 1; d <= dim; d++) {
          if (new Date(Date.UTC(y, mo, d)).getUTCDay() === 0) continue;
          total++;
          if (d <= mvn.getUTCDate()) done++;
        }
        const fc = done && mDn ? (mSum / done) * total : null;
        const neg = mSum < 0;
        const tip = `Chênh lệch tháng ${mo + 1}/${y} (tới ${kd === 0 ? 'hôm nay' : 'ngày đang xem'}): ${money(Math.round(mSum))} – ${mDn}/${mList.length} đơn đã tính được\nDự báo cả tháng = ${money(Math.round(mSum))} ÷ ${done} ngày công đã qua × ${total} ngày công (trừ Chủ nhật)${fc != null ? ` = ${money(Math.round(fc))}` : ''}`;
        return `<div title="${esc(tip)}" style="display:grid;gap:0;min-width:90px;padding:4px 10px;border-radius:12px;background:${neg ? '#fef2f2' : '#fdf2f8'};border:1.5px solid ${neg ? '#fecaca' : '#fbcfe8'};box-shadow:0 2px 8px rgba(15,23,42,.06);line-height:1.25">
          <span style="font-size:11px;font-weight:700;color:#64748b;white-space:nowrap">🗓️ Chênh lệch T${mo + 1}${mMiss > 0 ? ` <span data-dg-miss="month" style="color:#d97706;cursor:pointer;text-decoration:underline dotted" title="Bấm để xem các đơn chưa tính chênh lệch và tính tiếp">⏳${mMiss}</span>` : ''}</span>
          <b style="font-size:18px;font-weight:900;color:${neg ? '#b91c1c' : '#be185d'};white-space:nowrap;font-variant-numeric:tabular-nums">${mDn ? `${neg ? '−' : ''}${big(Math.abs(mSum))}` : '–'}</b>
          <span style="font-size:10.5px;font-weight:700;color:#0e7490;white-space:nowrap">→ dự báo ${fc != null ? `${fc < 0 ? '−' : ''}${big(Math.abs(fc))}` : '–'} <span style="color:#94a3b8;font-weight:600">(${done}/${total} ngày công)</span></span></div>`;
      })() +
      // Doanh thu tháng (tới ngày đang xem) + dự kiến cả tháng theo ngày công (trừ Chủ nhật)
      (() => {
        const y = mvn.getUTCFullYear();
        const mo = mvn.getUTCMonth();
        const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
        let total = 0;
        let done = 0;
        for (let d = 1; d <= dim; d++) {
          if (new Date(Date.UTC(y, mo, d)).getUTCDay() === 0) continue;
          total++;
          if (d <= mvn.getUTCDate()) done++;
        }
        // số của CRM (biểu đồ Doanh số tháng này); chưa lấy được thì tạm dùng Σ Tổng tiền các đơn đọc được
        const ymd = (d) => `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const crm = crmSaleSum(ymd(1), ymd(mvn.getUTCDate()));
        const rev = crm ?? mRev;
        const fc = done ? (rev / done) * total : 0;
        return `<div title="${esc(`Doanh thu tháng ${mo + 1}: ${money(rev)} ${crm != null ? '(theo CRM – biểu đồ Doanh số tháng này)' : `(tạm tính từ ${mList.length} đơn đọc được – đang lấy số của CRM)`}, tới ${kd === 0 ? 'hôm nay' : 'ngày đang xem'}\nDự kiến cả tháng = ${money(rev)} ÷ ${done} ngày công đã qua × ${total} ngày công (trừ Chủ nhật) = ${money(Math.round(fc))}`)}" style="display:grid;gap:0;min-width:90px;padding:4px 10px;border-radius:12px;background:#f0fdf4;border:1.5px solid #86efac;box-shadow:0 2px 8px rgba(15,23,42,.06);line-height:1.25">
          <span style="font-size:11px;font-weight:700;color:#64748b;white-space:nowrap">💵 Doanh thu T${mo + 1}</span><b style="font-size:18px;font-weight:900;color:#15803d;white-space:nowrap;font-variant-numeric:tabular-nums">${big(rev)}${crm == null ? '<span style="font-size:11px;color:#94a3b8"> ≈</span>' : ''}</b>
          <span style="font-size:10.5px;font-weight:700;color:#0e7490;white-space:nowrap">→ dự kiến ${big(fc)} <span style="color:#94a3b8;font-weight:600">(${done}/${total} ngày công)</span></span></div>`;
      })() +
      // Dự báo cả tháng: chênh lệch hiện tại ÷ ngày làm việc đã qua × ngày làm việc của tháng (trừ Chủ nhật)
      (() => {
        const y = mvn.getUTCFullYear();
        const mo = mvn.getUTCMonth();
        const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
        const isWork = (d) => new Date(Date.UTC(y, mo, d)).getUTCDay() !== 0;
        let total = 0;
        let done = 0;
        for (let d = 1; d <= dim; d++) {
          if (!isWork(d)) continue;
          total++;
          if (d <= mvn.getUTCDate()) done++;
        }
        return ''; // đã gộp vào ô Chênh lệch tháng
        // eslint-disable-next-line no-unreachable
        const fc = (mSum / done) * total;
        return tile('🔮', `Dự báo T${mo + 1}`, `${fc < 0 ? '−' : ''}${big(Math.abs(fc))}`, fc < 0 ? '#b91c1c' : '#0e7490', fc < 0 ? '#fef2f2' : '#ecfeff', fc < 0 ? '#fecaca' : '#a5f3fc',
          `Dự báo chênh lệch tháng ${mo + 1}: ${money(Math.round(mSum))} ÷ ${done} ngày làm việc đã qua × ${total} ngày làm việc trong tháng (trừ Chủ nhật) = ${money(Math.round(fc))}`);
      })();
    if (box.dataset.h !== html) {
      box.dataset.h = html;
      box.innerHTML = html;
    }
  }
  // Viên "chênh lệch" màu theo mức: <5tr tím · <10tr cam · <30tr xanh dương · <50tr xanh đậm · còn lại xanh lá · âm đỏ
  // Chênh lệch từ 30 tr nhấp nháy – tiền càng lớn nháy càng nhanh / sáng / phồng mạnh (CSS chèn vào trang CRM)
  function blinkCss() {
    if (document.getElementById('dg-diff-blink')) return;
    const st = document.createElement('style');
    st.id = 'dg-diff-blink';
    st.textContent = `
      @keyframes dgBlink1 { 0%,100% { box-shadow: 0 0 0 0 rgba(37,99,235,0); transform: scale(1); filter: brightness(1); } 50% { box-shadow: 0 0 10px 3px rgba(37,99,235,.85); transform: scale(1.08); filter: brightness(1.35) saturate(1.3); } }
      @keyframes dgBlink2 { 0%,100% { box-shadow: 0 0 0 0 rgba(22,163,74,0); transform: scale(1); filter: brightness(1); } 50% { box-shadow: 0 0 14px 4px rgba(22,163,74,.95); transform: scale(1.12); filter: brightness(1.45) saturate(1.4); } }
      @keyframes dgBlink3 { 0%,100% { box-shadow: 0 0 0 0 rgba(234,88,12,0); transform: scale(1); filter: brightness(1); } 50% { box-shadow: 0 0 18px 6px rgba(234,88,12,1); transform: scale(1.18); filter: brightness(1.6) saturate(1.6); } }
      @keyframes dgBlink4 { 0%,100% { box-shadow: 0 0 0 0 rgba(220,38,38,0); transform: scale(1); filter: brightness(1); } 25% { box-shadow: 0 0 22px 8px rgba(220,38,38,1); transform: scale(1.24); filter: brightness(1.8) saturate(1.8); } 50% { box-shadow: 0 0 4px 1px rgba(220,38,38,.6); transform: scale(1.04); filter: brightness(1.1); } 75% { box-shadow: 0 0 22px 8px rgba(250,204,21,1); transform: scale(1.24); filter: brightness(1.8) saturate(1.8); } }
      .dg-blink1, .dg-blink2, .dg-blink3, .dg-blink4 { position: relative; z-index: 1; }
      .dg-blink1 { animation: dgBlink1 1.1s ease-in-out infinite; }
      .dg-blink2 { animation: dgBlink2 .8s ease-in-out infinite; }
      .dg-blink3 { animation: dgBlink3 .55s ease-in-out infinite; }
      .dg-blink4 { animation: dgBlink4 .45s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce) { .dg-blink1, .dg-blink2, .dg-blink3, .dg-blink4 { animation: none; } }`;
    document.head.append(st);
  }
  const blinkLevel = (v) => (v >= 200e6 ? 4 : v >= 100e6 ? 3 : v >= 50e6 ? 2 : v >= 30e6 ? 1 : 0);

  // Nhãn NEW xanh dương, nhấp nháy (nổi rõ cả khi dòng CRM đang mờ vì đã đọc)
  function newCss() {
    if (document.getElementById('dg-new-css')) return;
    const st = document.createElement('style');
    st.id = 'dg-new-css';
    st.textContent = `
      @keyframes dgNewPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(37,99,235,.65); transform: scale(1); } 50% { box-shadow: 0 0 0 5px rgba(37,99,235,0); transform: scale(1.08); } }
      @keyframes dgNewShine { 0% { background-position: 0% 50%; } 100% { background-position: 200% 50%; } }
      .dg-new { display:inline-block; margin-right:5px; vertical-align:middle; padding:0 6px; border-radius:999px; font-size:9.5px; font-weight:900; letter-spacing:.5px; line-height:15px;
        color:#fff; background: linear-gradient(90deg,#1d4ed8,#3b82f6,#06b6d4,#1d4ed8); background-size:200% 100%; opacity:1 !important; filter:none !important;
        animation: dgNewPulse 1.2s ease-in-out infinite, dgNewShine 2s linear infinite; }
      @media (prefers-reduced-motion: reduce) { .dg-new { animation: none; } }`;
    document.head.append(st);
  }
  // Danh sách Báo giá của CRM: báo giá tạo trong 7 ngày → badge 🆕 ở cột "Ngày tạo"
  function injectNewBadges() {
    if (!IS_TOP || !renderCtx.quotes) return;
    const byCode = renderCtx.byCode && renderCtx.byCodeSrc === renderCtx.quotes ? renderCtx.byCode : (renderCtx.byCode = Object.fromEntries(Object.values(renderCtx.quotes).map((q) => [q.code, q])));
    renderCtx.byCodeSrc = renderCtx.quotes;
    for (const t of document.querySelectorAll('.ant-table')) {
      if (t.closest('#dg-root')) continue;
      const hs = [...t.querySelectorAll('thead th')].filter((th) => !th.hasAttribute('data-dg-diffcol')).map((th) => th.innerText.trim());
      const iDate = hs.indexOf('Ngày tạo');
      if (iDate < 0 || !hs.some((h) => /Mã báo giá/i.test(h))) continue;
      for (const tr of t.querySelectorAll('.ant-table-tbody tr')) {
        if (tr.classList.contains('ant-table-measure-row')) continue;
        const own = [...tr.cells].filter((c) => !c.hasAttribute('data-dg-diffcol'));
        const cell = own[iDate];
        if (!cell) continue;
        const code = (tr.innerText.match(/BG\d{3,}/) || [])[0];
        const q = code && byCode[code];
        const fresh = !!q?.createdAt && hoursSince(q.createdAt) < 7 * 24;
        const badge = cell.querySelector('.dg-new');
        if (fresh && !badge) {
          newCss();
          cell.style.whiteSpace = 'nowrap'; // nhãn NEW + "6 ngày trước" trên cùng 1 dòng
          const b = document.createElement('span');
          b.className = 'dg-new';
          b.textContent = 'NEW';
          b.title = 'Báo giá mới tạo trong 7 ngày gần nhất';
          cell.prepend(b);
        } else if (!fresh && badge) badge.remove();
      }
    }
  }
  if (IS_TOP) setInterval(() => injectNewBadges(), 2000);

  // Danh sách Báo giá của CRM: báo giá chưa có bình luận nào (bộ thu thập đã xem, không thấy luồng nào) → icon 💬 nhấp nháy
  // cuối ô "Tên cơ hội", bấm để mở báo giá và bình luận giải quyết
  function noCmtCss() {
    if (document.getElementById('dg-nocmt-css')) return;
    const st = document.createElement('style');
    st.id = 'dg-nocmt-css';
    st.textContent = `.dg-nocmt{display:inline-flex;align-items:center;gap:3px;margin-left:8px;padding:1px 8px 1px 6px;border-radius:999px;background:linear-gradient(135deg,#f97316,#ef4444);color:#fff;font-size:10.5px;font-weight:800;cursor:pointer;vertical-align:middle;white-space:nowrap;animation:dgNoCmt 1.2s ease-in-out infinite;box-shadow:0 0 0 0 rgba(239,68,68,.6)}
.dg-nocmt:hover{animation-play-state:paused;filter:brightness(1.1)}
.dg-nocmt i{font-style:normal;display:inline-block;animation:dgNoCmtWig 1.2s ease-in-out infinite}
@keyframes dgNoCmt{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.55);transform:scale(1)}50%{box-shadow:0 0 0 6px rgba(239,68,68,0);transform:scale(1.08)}}
@keyframes dgNoCmtWig{0%,60%,100%{transform:rotate(0)}70%{transform:rotate(-14deg)}80%{transform:rotate(12deg)}90%{transform:rotate(-6deg)}}`;
    document.head.append(st);
  }
  const SYS_CMT_RE = /đã tạo báo giá #?BG\d+|^Mã đơn hàng Misa:|lên đơn hàng với giá trị/i;
  function injectNoComment() {
    if (!IS_TOP || !renderCtx.quotes) return;
    const byCode = renderCtx.byCode || {};
    const skip = (c) => c.hasAttribute('data-dg-diffcol') || c.hasAttribute('data-dg-tagcol');
    for (const t of document.querySelectorAll('.ant-table')) {
      if (t.closest('#dg-root')) continue;
      const hs = [...t.querySelectorAll('thead th')].filter((th) => !skip(th)).map((th) => th.innerText.trim());
      const iName = hs.indexOf('Tên cơ hội');
      if (iName < 0 || !hs.some((h) => /Mã báo giá/i.test(h))) continue;
      for (const tr of t.querySelectorAll('.ant-table-tbody tr')) {
        if (tr.classList.contains('ant-table-measure-row')) continue;
        const cell = [...tr.cells].filter((c) => !skip(c))[iName];
        if (!cell) continue;
        const code = (tr.innerText.match(/BG\d{3,}/) || [])[0];
        const q = code && byCode[code];
        // chỉ có dòng tự động của CRM ("… đã tạo báo giá #BG… giá trị …", "Mã đơn hàng Misa: …") cũng tính là chưa bình luận
        const real = (renderCtx.comments?.[q?.id]?.threads || []).filter((t) => (t.children?.length || 0) > 0 || !SYS_CMT_RE.test(String(t.text || '').trim()));
        const none = !!q?.id && !!renderCtx.collected?.[q.id] && !real.length && !CLOSED.has(q.quoteStatus) && !q.hasOrder;
        let b = cell.querySelector('.dg-nocmt');
        if (!none) {
          b?.remove();
          continue;
        }
        if (b) continue;
        noCmtCss();
        b = document.createElement('span');
        b.className = 'dg-nocmt';
        b.innerHTML = '<i>💬</i> Chưa bình luận';
        b.title = `${q.code} chưa có bình luận nào – bấm để mở báo giá và bình luận giải quyết`;
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const url = `/co-hoi/update/${q.id}`;
          if (e.ctrlKey || e.metaKey) window.open(url, '_blank');
          else location.href = url;
        });
        cell.append(b);
      }
    }
  }
  if (IS_TOP) setInterval(() => injectNoComment(), 2000);

  // Danh sách Báo giá của CRM: cột "Khách hàng" – khách xuất hiện từ 2 lần trong danh sách đang xem → số lần cạnh mã khách
  function injectCustCounts() {
    if (!IS_TOP) return;
    for (const t of document.querySelectorAll('.ant-table')) {
      if (t.closest('#dg-root')) continue;
      const hs = [...t.querySelectorAll('thead th')].filter((th) => !th.hasAttribute('data-dg-diffcol')).map((th) => th.innerText.trim());
      const iCust = hs.indexOf('Khách hàng');
      if (iCust < 0 || !hs.some((h) => /Mã báo giá/i.test(h))) continue;
      const cells = [];
      // ô khách = ô chứa mã khách đã gắn ([data-dg-kh]); không đoán theo thứ tự cột (dễ lệch vì cột Nhãn / Chênh lệch chèn thêm)
      t.querySelectorAll('.dg-custn').forEach((b) => !b.closest('td')?.querySelector('[data-dg-kh]') && b.remove());
      for (const tr of t.querySelectorAll('.ant-table-tbody tr')) {
        if (tr.classList.contains('ant-table-measure-row') || tr.style.display === 'none') continue;
        const kh = tr.querySelector('[data-dg-kh]');
        const cell = kh?.closest('td');
        if (!cell) continue;
        const name = (kh.textContent || '').trim().toUpperCase();
        if (name) cells.push({ cell, name, kh });
      }
      // Cột "Nhân viên tạo": rút gọn tên như trong extension (shortName), rê chuột xem tên đầy đủ
      const iStaff = hs.indexOf('Nhân viên tạo');
      if (iStaff >= 0) {
        for (const tr of t.querySelectorAll('.ant-table-tbody tr')) {
          const cell = [...tr.cells].filter((c) => !c.hasAttribute('data-dg-diffcol'))[iStaff];
          if (!cell) continue;
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          const texts = [];
          for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement?.closest('.dg-staffava')) texts.push(n);
          for (const n of texts) {
            const full = n.nodeValue.trim();
            if (!full || full === n.parentElement?.dataset.dgShort) continue; // đã rút gọn
            const sh = shortName(full);
            if (n.parentElement === cell) {
              // chữ nằm thẳng trong ô → bọc vào span để gắn avatar
              const w = document.createElement('span');
              n.before(w);
              w.append(n);
            }
            if (sh !== full) n.nodeValue = sh;
            n.parentElement.dataset.dgShort = sh;
            n.parentElement.dataset.dgFull = full;
            n.parentElement.title = full;
          }
          // Avatar nhân viên trước tên (cập nhật khi có ảnh sau)
          const el = cell.querySelector('[data-dg-full]');
          if (el) {
            const full = el.dataset.dgFull;
            const want = avatarHtml(full, 20);
            let av = cell.querySelector('.dg-staffava');
            if (!av) {
              av = document.createElement('span');
              av.className = 'dg-staffava';
              av.setAttribute('style', 'display:inline-flex;vertical-align:middle;margin-right:6px');
              el.before(av);
              const box = el.parentElement;
              if (box && box !== cell) box.style.whiteSpace = 'nowrap';
              else cell.style.whiteSpace = 'nowrap';
            }
            if (av.dataset.html !== want) {
              av.dataset.html = want;
              av.innerHTML = want.replace('class="ava', 'style="border-radius:50%;object-fit:cover;display:inline-flex;align-items:center;justify-content:center;background:#dbe4ff;color:#1d4ed8;font-size:10px;font-weight:800;width:20px;height:20px" class="ava').replace(/ style="width:20px;height:20px"/, '');
            }
          }
        }
      }
      const count = {};
      for (const x of cells) count[x.name] = (count[x.name] || 0) + 1;
      for (const { cell, name, kh } of cells) {
        const n = count[name];
        let b = cell.querySelector('.dg-custn');
        if (n < 2) {
          b?.remove();
          continue;
        }
        if (!b) {
          b = document.createElement('span');
          b.className = 'dg-custn';
          b.setAttribute('style', 'display:inline-grid;place-items:center;min-width:18px;height:18px;margin-left:6px;padding:0 5px;border-radius:999px;background:#ea580c;color:#fff;font-size:10.5px;font-weight:800;vertical-align:middle;');
          kh.after(b);
        }
        if (b.textContent !== String(n)) b.textContent = String(n);
        b.title = `Khách này xuất hiện ${n} lần trong danh sách đang xem`;
      }
    }
  }
  if (IS_TOP) setInterval(() => injectCustCounts(), 2000);

  function diffPill(q, wait = false) {
    const v = q ? diffVal(q) : null;
    if (q?.noSheet) return '<span style="color:#b91c1c;font-weight:800" title="Có dòng giá giấy tấm 0đ/m2">😡</span>';
    if (v != null) {
      const [fg, bg] = v < 0 ? ['#b91c1c', '#fee2e2'] : v < 5e6 ? ['#7e22ce', '#f3e8ff'] : v < 10e6 ? ['#c2410c', '#ffedd5'] : v < 30e6 ? ['#2563eb', '#dbeafe'] : v < 50e6 ? ['#1e3a8a', '#c7d2fe'] : ['#15803d', '#dcfce7'];
      const lv = blinkLevel(v);
      if (lv) blinkCss();
      return `<span${lv ? ` class="dg-blink${lv}"` : ''} style="display:inline-block;font-weight:800;color:${fg};background:${bg};border-radius:999px;padding:0 8px;white-space:nowrap;font-variant-numeric:tabular-nums">${v < 0 ? '−' : ''}${trM(Math.abs(v))}</span>`;
    }
    if (q && q.amount === 0 && q.kinds?.length) return '<span style="color:#94a3b8" title="Báo giá chưa cho giá (0đ) – chưa tính được chênh lệch">–</span>';
    if (wait || (q && (q.kinds?.length || q.offset))) return '<span style="color:#d97706" title="Đang đọc ngầm báo giá để tính chênh lệch">⏳</span>';
    return '';
  }
  // Trang Danh sách đơn (/misa-order/list): thêm cột "Chênh lệch" sau "Tổng tiền" (ô gộp theo số dòng sản phẩm của đơn)
  function misaListDiff() {
    if (!IS_TOP || !/^\/misa-order\/list/.test(location.pathname) || !renderCtx.quotes) return;
    const byCode = renderCtx.byCode && renderCtx.byCodeSrc === renderCtx.quotes ? renderCtx.byCode : (renderCtx.byCode = Object.fromEntries(Object.values(renderCtx.quotes).map((q) => [q.code, q])));
    renderCtx.byCodeSrc = renderCtx.quotes;
    const need = [];
    for (const wrap of document.querySelectorAll('.ant-table')) {
      const ths = [...wrap.querySelectorAll('thead th')].filter((th) => !th.hasAttribute('data-dg-diffcol'));
      const ti = ths.findIndex((th) => th.innerText.trim().startsWith('Tổng tiền'));
      if (ti < 0 || !ths.some((th) => th.innerText.trim() === 'Báo giá')) continue;
      let dth = wrap.querySelector('th[data-dg-diffcol]');
      if (!dth) {
        dth = document.createElement('th');
        dth.className = ths[ti].className;
        dth.setAttribute('data-dg-diffcol', '1');
        dth.style.textAlign = 'right';
        dth.innerHTML = 'Chênh lệch<div data-dg-dsum style="font-size:11px;font-weight:800;border-radius:6px;padding:0 6px;margin-top:2px;display:inline-block;white-space:nowrap"></div>';
        ths[ti].after(dth);
        for (const cg of wrap.querySelectorAll('colgroup')) {
          const cols = cg.querySelectorAll('col:not([data-dg-diffcol])');
          const col = document.createElement('col');
          col.setAttribute('data-dg-diffcol', '1');
          col.style.width = '100px';
          cols[ti] ? cols[ti].after(col) : cg.append(col);
        }
      }
      // hàng đầu của mỗi đơn có đủ ô (hàng phụ – dòng sản phẩm thứ 2… – thiếu các ô gộp); tiêu đề có thể dư ô thanh cuộn
      const trs = [...wrap.querySelectorAll('tbody tr')].filter((tr) => !tr.classList.contains('ant-table-measure-row') && !tr.classList.contains('ant-table-placeholder'));
      const nFull = Math.max(0, ...trs.map((tr) => [...tr.cells].filter((c) => !c.hasAttribute('data-dg-diffcol')).length));
      if (!document.getElementById('dg-spin-css')) {
        const st = document.createElement('style');
        st.id = 'dg-spin-css';
        st.textContent = '@keyframes dgSpin{to{transform:rotate(360deg)}}.dg-spin{display:inline-block;width:12px;height:12px;border:2px solid #bfdbfe;border-top-color:#2563eb;border-radius:50%;animation:dgSpin .8s linear infinite;vertical-align:-2px}';
        document.head.append(st);
      }
      let sum = 0;
      let n = 0;
      for (const tr of trs) {
        const own = [...tr.cells].filter((c) => !c.hasAttribute('data-dg-diffcol'));
        if (own.length < nFull) continue; // hàng phụ của cùng đơn
        let td = tr.querySelector(':scope > td[data-dg-diffcol]');
        if (!td) {
          td = document.createElement('td');
          td.className = own[ti].className;
          td.setAttribute('data-dg-diffcol', '1');
          td.style.textAlign = 'right';
          own[ti].after(td);
        }
        if (own[ti].rowSpan > 1 && td.rowSpan !== own[ti].rowSpan) td.rowSpan = own[ti].rowSpan;
        const bg = (tr.innerText.match(/BG\d{3,}/) || [])[0];
        const q = bg && byCode[bg];
        const v0 = q && !q.noSheet ? diffVal(q) : null;
        const reading = bg && state.diffReading?.bg === bg;
        const h = reading
          ? `<span style="display:inline-flex;align-items:center;gap:4px;color:#2563eb;font-weight:700;font-size:11px;white-space:nowrap" title="Đang đọc ngầm ${esc(bg)} để tính chênh lệch – ${esc(state.diffReading.step || '')}"><i class="dg-spin"></i>đang đọc</span>`
          : bg ? diffPill(q, v0 == null) : '';
        // chưa có chênh lệch → đưa vào hàng đợi đọc ngầm
        if (bg && v0 == null && !q?.noSheet && !(q?.amount === 0 && q?.kinds?.length)) {
          const qid = q?.id || Number([...tr.querySelectorAll('a[href]')].map((a) => a.getAttribute('href').match(/\/(?:bao-gia|co-hoi)\/(?:update|view)\/(\d+)/)?.[1]).find(Boolean)) || null;
          need.push({ bg, qid, at: Date.now() + 1e12 }); // ưu tiên hơn đơn trong ngày
        }
        if (td.dataset.h !== h) {
          td.dataset.h = h;
          td.innerHTML = h;
        }
        if (v0 != null) {
          sum += v0;
          n++;
        }
      }
      let st2 = dth.querySelector('[data-dg-dread]');
      if (!st2) {
        st2 = document.createElement('div');
        st2.setAttribute('data-dg-dread', '1');
        st2.setAttribute('style', 'font-size:10.5px;font-weight:700;color:#2563eb;white-space:nowrap;margin-top:2px');
        dth.append(st2);
      }
      const rd = state.diffReading;
      const rh = rd ? `<i class="dg-spin"></i> ${esc(rd.bg)}${rd.left ? ` · còn ${rd.left}` : ''}` : need.length ? `⏳ chờ đọc ${need.length}` : '';
      if (st2.dataset.h !== rh) {
        st2.dataset.h = rh;
        st2.innerHTML = rh;
        st2.title = rd ? `Đang đọc ngầm ${rd.bg}: ${rd.step || ''}` : '';
      }
      const ds = dth.querySelector('[data-dg-dsum]');
      const t = n ? `Σ ${Math.abs(sum) >= 1e9 ? `${(sum / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ` : trM(sum)}` : '';
      if (ds && ds.textContent !== t) {
        ds.textContent = t;
        ds.style.color = sum < 0 ? '#b91c1c' : '#047857';
        ds.style.background = t ? (sum < 0 ? '#fee2e2' : '#dcfce7') : 'none';
        ds.title = `Tổng chênh lệch ${n} đơn trên trang (đã tính được)`;
      }
    }
    state.misaNeed = need;
  }
  if (IS_TOP) setInterval(() => {
    try {
      misaListDiff();
    } catch {}
  }, 1500);
  function crmListTags() {
    if (!IS_TOP || !root || !/^\/bao-gia\/?$/.test(location.pathname) || !renderCtx.quotes) return;
    try {
      crmCompactFilters();
    } catch {}
    crmTagCss();
    const byCode = renderCtx.byCode && renderCtx.byCodeSrc === renderCtx.quotes ? renderCtx.byCode : (renderCtx.byCode = Object.fromEntries(Object.values(renderCtx.quotes).map((q) => [q.code, q])));
    renderCtx.byCodeSrc = renderCtx.quotes;
    for (const wrap of document.querySelectorAll('.ant-table')) {
      const head = [...wrap.querySelectorAll('thead th')];
      const idx = head.findIndex((th) => th.innerText.trim() === 'Tên cơ hội');
      if (idx < 0) continue;
      if (!wrap.querySelector('th[data-dg-tagcol]')) {
        const th = document.createElement('th');
        th.className = head[idx].className;
        th.setAttribute('data-dg-tagcol', '1');
        th.textContent = 'Nhãn';
        head[idx].before(th);
        for (const cg of wrap.querySelectorAll('colgroup')) {
          const cols = cg.querySelectorAll('col');
          const col = document.createElement('col');
          col.setAttribute('data-dg-tagcol', '1');
          col.style.width = '280px';
          (cols[idx] || cols[cols.length - 1])?.before(col);
        }
      }
      const pos = [...wrap.querySelectorAll('thead th')].findIndex((th) => th.hasAttribute('data-dg-tagcol'));
      const khIdx = [...wrap.querySelectorAll('thead th')].filter((th) => !th.hasAttribute('data-dg-tagcol')).findIndex((th) => th.innerText.trim() === 'Khách hàng');
      const sel = lsGet('dgCrmF') || '';
      const selF = CRM_F.find((f) => f[0] === sel)?.[4];
      const counts = {};
      const staffN = {};
      const dCounts = {};
      const selS = lsGet('dgCrmS') || '';
      const selD = lsGet('dgCrmD') || '';
      let total = 0;
      for (const tr of wrap.querySelectorAll('tbody tr')) {
        if (tr.classList.contains('ant-table-measure-row') || tr.classList.contains('ant-table-placeholder')) continue;
        const code = (tr.innerText.match(/BG\d{3,}/) || [])[0];
        let td = tr.querySelector(':scope > td[data-dg-tagcol]');
        if (!td) {
          td = document.createElement('td');
          td.className = tr.cells[0]?.className || '';
          td.setAttribute('data-dg-tagcol', '1');
          const ref = [...tr.cells].filter((c) => !c.hasAttribute('data-dg-tagcol'))[pos];
          ref ? ref.before(td) : tr.append(td);
        }
        const q = code && byCode[code];
        const c = q && renderCtx.comments?.[q.id];
        const hot = q && renderCtx.hotSet?.has(q.id) && !CLOSED.has(q.quoteStatus) && !hasOrderFull(q, c) && !cancelInfo(c);
        const html = q ? `${hot ? '<span class="dl-hotbadge sm">🔥 Ưu tiên</span>' : ''}${kindTag(q)}${noSheetTag(q)}${bossOkTag(q, c)}${targetTag(c)}${buyerTag(q, c)}${highPriceTag(c)}${creditTag(c)}${promiseTag(q, c)}${contractTag(c)}${sampleTag(q, c)}${noDepositTag(c)}` : '';
        if (td.dataset.k !== `${code}|${html.length}`) {
          td.dataset.k = `${code}|${html.length}`;
          // 1 dòng, dài quá thì "…"; rê chuột vào ô thấy đủ các nhãn
          td.innerHTML = html.replace(/\stitle="[^"]*"/g, '');
          const tpl = document.createElement('div');
          tpl.innerHTML = html;
          td.title = [...tpl.children].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
        }
        // Cột "Khách hàng": chỉ hiện mã khách, rê chuột thấy tên đầy đủ
        if (khIdx >= 0 && q?.customer?.code) {
          const cell = [...tr.cells].filter((x) => !x.hasAttribute('data-dg-tagcol'))[khIdx];
          if (cell) {
            const full = q.customer.name || '';
            const leaf = [...cell.querySelectorAll('*')].find((e) => !e.hasAttribute('data-dg-kh') && e.childElementCount === 0 && e.textContent.trim() && full && e.textContent.trim() === full.trim());
            if (leaf) leaf.style.display = 'none';
            let sp = cell.querySelector('[data-dg-kh]');
            if (!sp) {
              sp = document.createElement('span');
              sp.setAttribute('data-dg-kh', '1');
              sp.setAttribute('style', 'font-weight:700;color:#b45309;background:#fff7ed;border:1px solid #fed7aa;border-radius:4px;padding:0 6px;font-size:12px;cursor:help;white-space:nowrap');
              (leaf || cell.firstChild)?.before ? (leaf || cell.firstElementChild || cell).before(sp) : cell.prepend(sp);
            }
            if (sp.textContent !== q.customer.code) sp.textContent = q.customer.code;
            sp.title = full;
            // Đậm / mờ theo dòng đã đọc / chưa đọc của CRM (dòng chưa đọc in đậm)
            const ref = [...tr.cells].find((x) => !x.hasAttribute('data-dg-tagcol') && x !== cell && (x.innerText || '').trim());
            const unread = ref ? Number(getComputedStyle(ref.querySelector('a, span, div') || ref).fontWeight) >= 600 : q.isRead === false;
            const want = unread ? '1' : '0';
            if (sp.dataset.u !== want) {
              sp.dataset.u = want;
              sp.style.opacity = unread ? '1' : '0.55';
              sp.style.fontWeight = unread ? '800' : '500';
            }
          }
        }
        total++;
        let match = !selF;
        if (q)
          for (const [k, , , , fn] of CRM_F) {
            let v = false;
            try {
              v = !!fn(q, c);
            } catch {}
            if (v) counts[k] = (counts[k] || 0) + 1;
            if (k === sel && v) match = true;
          }
        const who = q ? staffOf(q, c) : '';
        if (who && !isExcluded(who)) staffN[who] = (staffN[who] || 0) + 1;
        if (selS && who !== selS) match = false;
        // Lọc theo mức chênh lệch (cùng màu với cột Chênh lệch)
        const lv = q ? diffLevel(q) : null;
        if (match && lv) dCounts[lv] = (dCounts[lv] || 0) + 1;
        if (selD && lv !== selD) match = false;
        tr.style.display = match ? '' : 'none';
      }
      crmFilterBar(wrap, counts, total, staffN, dCounts);
      stickReq();
      // Cột "Số tiền" in đậm
      {
        const ths = [...wrap.querySelectorAll('thead th')];
        const si = ths.findIndex((th) => /^Số tiền/.test(th.innerText.trim()));
        if (si >= 0) {
          let sum = 0;
          let n = 0;
          for (const tr of wrap.querySelectorAll('tbody tr')) {
            const cell = tr.cells[si];
            if (!cell || tr.classList.contains('ant-table-measure-row')) continue;
            cell.style.fontWeight = '800';
            // Số tiền 0 → nhãn "⚠️ Chưa cho giá" giống extension
            const raw = [...cell.childNodes].filter((n) => !(n.nodeType === 1 && n.hasAttribute('data-dg-np'))).map((n) => n.textContent).join('');
            const zero = !(Number(String(raw).replace(/[^\d]/g, '')) || 0) && /BG\d{3,}/.test(tr.innerText);
            let np = cell.querySelector('[data-dg-np]');
            if (zero && !np) {
              np = document.createElement('span');
              np.setAttribute('data-dg-np', '1');
              np.innerHTML = '<i class="dg-hurry">⏰</i> Chưa cho giá';
              if (!document.getElementById('dg-np-css')) {
                const st = document.createElement('style');
                st.id = 'dg-np-css';
                st.textContent = `[data-dg-np]{animation:dgNpPulse 1.4s ease-in-out infinite}
[data-dg-np] .dg-hurry{font-style:normal;display:inline-block;animation:dgHurry 1s ease-in-out infinite;transform-origin:50% 60%}
@keyframes dgHurry{0%,100%{transform:rotate(0)}10%{transform:rotate(-18deg)}20%{transform:rotate(16deg)}30%{transform:rotate(-12deg)}40%{transform:rotate(8deg)}50%{transform:rotate(0)}}
@keyframes dgNpPulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.45)}50%{box-shadow:0 0 0 5px rgba(239,68,68,0)}}`;
                document.head.append(st);
              }
              np.setAttribute('style', 'display:inline-block;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:999px;padding:0 8px;font-size:11.5px;font-weight:800;white-space:nowrap');
              cell.prepend(np);
            }
            if (np) np.style.display = zero ? 'inline-block' : 'none';
            for (const n of cell.children) if (!n.hasAttribute('data-dg-np')) n.style.display = zero ? 'none' : '';
            if (zero) {
              for (const n of cell.childNodes) if (n.nodeType === 3 && n.textContent.trim()) n.textContent = '';
            }
            if (tr.style.display === 'none') continue;
            const v = Number(String(raw).replace(/[^\d]/g, '')) || 0;
            sum += v;
            n++;
          }
          // Tổng tiền các dòng đang hiện (theo bộ lọc) ngay trên tiêu đề cột
          let sp = ths[si].querySelector('[data-dg-sum]');
          if (!sp) {
            sp = document.createElement('div');
            sp.setAttribute('data-dg-sum', '1');
            sp.setAttribute('style', 'font-size:12px;font-weight:800;color:#047857;background:#dcfce7;border-radius:6px;padding:0 6px;margin-top:2px;display:inline-block;white-space:nowrap');
            ths[si].append(sp);
          }
          const txt = `Σ ${moneyShortG(sum) || '0đ'}`;
          if (sp.textContent !== txt) sp.textContent = txt;
          sp.title = `Tổng ${n} báo giá đang hiện: ${money(sum)}`;
          state.crmKpi = { n, sum };
        }
      }
      // Cột "Chênh lệch" (giống extension) ngay sau "Số tiền": Flexo = BG − giấy tấm · Offset = BG − NVL; màu theo mức
      {
        const ths = [...wrap.querySelectorAll('thead th')];
        const si = ths.findIndex((th) => /^Số tiền/.test(th.innerText.trim()));
        if (si >= 0) {
          let dth = wrap.querySelector('th[data-dg-diffcol]');
          if (!dth) {
            dth = document.createElement('th');
            dth.className = ths[si].className;
            dth.setAttribute('data-dg-diffcol', '1');
            dth.style.textAlign = 'right';
            dth.innerHTML = 'Chênh lệch<div data-dg-dsum style="font-size:12px;font-weight:800;border-radius:6px;padding:0 6px;margin-top:2px;display:inline-block;white-space:nowrap"></div>';
            ths[si].after(dth);
            for (const cg of wrap.querySelectorAll('colgroup')) {
              const cols = cg.querySelectorAll('col:not([data-dg-diffcol])');
              const col = document.createElement('col');
              col.setAttribute('data-dg-diffcol', '1');
              col.style.width = '110px';
              cols[si] ? cols[si].after(col) : cg.append(col);
            }
          }
          let dsum = 0;
          let dn = 0;
          const listNeed = [];
          for (const tr of wrap.querySelectorAll('tbody tr')) {
            if (tr.classList.contains('ant-table-measure-row') || tr.classList.contains('ant-table-placeholder')) continue;
            let td = tr.querySelector(':scope > td[data-dg-diffcol]');
            if (!td) {
              td = document.createElement('td');
              td.className = tr.cells[si]?.className || '';
              td.setAttribute('data-dg-diffcol', '1');
              td.style.textAlign = 'right';
              tr.cells[si] ? tr.cells[si].after(td) : tr.append(td);
            }
            const code = (tr.innerText.match(/BG\d{3,}/) || [])[0];
            const q = code && byCode[code];
            const v = q ? diffVal(q) : null;
            const reading = !!q && state.diffReading?.bg === code;
            const h = reading
              ? `<span style="display:inline-flex;align-items:center;gap:4px;color:#2563eb;font-weight:700;font-size:11px;white-space:nowrap" title="Đang đọc ngầm ${esc(code)} – ${esc(state.diffReading.step || '')}"><i class="dg-spin"></i>đang đọc</span>`
              : diffPill(q);
            // chưa có chênh lệch (đã cho giá) → hàng đợi đọc ngầm
            if (q && v == null && !q.noSheet && Number(q.amount) > 0 && tr.style.display !== 'none') listNeed.push({ bg: code, qid: q.id, at: Date.now() + 1e12 });
            if (v != null && !q.noSheet && tr.style.display !== 'none') {
              dsum += v;
              dn++;
            }
            if (td.dataset.h !== h) {
              td.dataset.h = h;
              td.innerHTML = h;
            }
          }
          state.listNeed = listNeed;
          if (!document.getElementById('dg-spin-css')) {
            const st = document.createElement('style');
            st.id = 'dg-spin-css';
            st.textContent = '@keyframes dgSpin{to{transform:rotate(360deg)}}.dg-spin{display:inline-block;width:12px;height:12px;border:2px solid #bfdbfe;border-top-color:#2563eb;border-radius:50%;animation:dgSpin .8s linear infinite;vertical-align:-2px}';
            document.head.append(st);
          }
          const ds = dth.querySelector('[data-dg-dsum]');
          const t = `Σ ${dn ? (Math.abs(dsum) >= 1e9 ? `${(dsum / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ` : trM(dsum)) : '–'}`;
          if (ds && ds.textContent !== t) {
            ds.textContent = t;
            ds.style.color = dsum < 0 ? '#b91c1c' : '#047857';
            ds.style.background = dsum < 0 ? '#fee2e2' : '#dcfce7';
          }
          if (ds) ds.title = `Tổng chênh lệch ${dn} báo giá đang hiện (đã tính được)`;
          crmKpiTiles(wrap, { ...(state.crmKpi || {}), dsum, dn });
        }
      }
      // Cột "Sale": tên gọn (3 chữ → chữ cuối, 4 chữ trở lên → 2 chữ cuối), rê chuột thấy tên đầy đủ
      {
        const ths = [...wrap.querySelectorAll('thead th')];
        const si = ths.findIndex((th) => /^(Sale|NVKD)$/i.test(th.innerText.trim()));
        if (si >= 0)
          for (const tr of wrap.querySelectorAll('tbody tr')) {
            const cell = tr.cells[si];
            if (!cell) continue;
            for (const leaf of cell.querySelectorAll('*')) {
              if (leaf.childElementCount || leaf.hasAttribute('data-dg-sn')) continue;
              const full = leaf.textContent.trim();
              const w = full.split(/\s+/);
              if (w.length < 3 || /\d/.test(full)) continue;
              leaf.style.display = 'none';
              let sp = leaf.previousElementSibling?.hasAttribute?.('data-dg-sn') ? leaf.previousElementSibling : null;
              if (!sp) {
                sp = document.createElement('span');
                sp.setAttribute('data-dg-sn', '1');
                leaf.before(sp);
              }
              const short = w.slice(w.length >= 4 ? -2 : -1).join(' ');
              const h = `${avaInline(full)}${esc(short)}`;
              if (sp.dataset.h !== h) {
                sp.dataset.h = h;
                sp.innerHTML = h;
                sp.style.cssText = 'display:inline-flex;align-items:center;gap:6px;white-space:nowrap';
              }
              sp.title = full;
            }
            // ô chỉ có chữ (không bọc thẻ)
            if (!cell.querySelector('*') && cell.textContent.trim().split(/\s+/).length >= 2) {
              const full = cell.textContent.trim();
              const w = full.split(/\s+/);
              cell.title = full;
              cell.innerHTML = `<span data-dg-sn="1" style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap">${avaInline(full)}${esc(w.length >= 3 ? w.slice(w.length >= 4 ? -2 : -1).join(' ') : full)}</span>`;
            }
          }
      }
      // Ẩn cột "Giai đoạn cơ hội", "Nguồn khách"
      const allTh = [...wrap.querySelectorAll('thead th')];
      for (const gi of allTh.map((th, i) => (/^(Giai đoạn cơ hội|Nguồn khách|Ngày kỳ vọng|Tình trạng báo giá)$/.test(th.innerText.trim()) ? i : -1)).filter((i) => i >= 0)) {
        allTh[gi].style.display = 'none';
        for (const tr of wrap.querySelectorAll('tbody tr')) if (tr.cells[gi]) tr.cells[gi].style.display = 'none';
        for (const cg of wrap.querySelectorAll('colgroup')) {
          const col = cg.querySelectorAll('col')[gi];
          if (col) col.style.width = '0px';
        }
      }
    }
  }
  if (IS_TOP) setInterval(() => {
    try {
      crmListTags();
    } catch (e) {
      console.warn('[DG] tagcol', e);
    }
  }, 1500);

  // 📣 Nhắc cả đội: gom deal gợi ý chốt đơn theo NVKD (chỉ mã khách) → việc gửi Zalo vào nhóm "Sale Nội Bộ - Tuấn Tú"
  const TEAM_GROUP = SITE.teamGroup; // trống → domain chưa có nhóm Zalo: ẩn nút Nhắc cả đội
  // Tin nhắn mẫu của sếp (câu mở đầu tin nhắc cả đội): kv 'teamTpl' (đồng bộ) = { list:[…], mode:'rotate'|'fixed', pick }
  const TEAM_TPL_DEFAULT = ['Khách của ai xem xét thúc khách kéo đơn về, khách nào gặp khó khăn thì gặp anh:'];
  function teamTplList() {
    const l = (state.teamTpl?.list || []).map((x) => String(x || '').trim()).filter(Boolean);
    return l.length ? l : TEAM_TPL_DEFAULT;
  }
  // Mỗi ca 1 câu (xoay vòng theo ca) – cùng 1 ca gửi lại vẫn ra cùng câu; chế độ cố định → luôn câu đã chọn
  function teamHead() {
    const l = teamTplList();
    if (state.teamTpl?.mode === 'fixed') return l[Math.min(l.length - 1, Number(state.teamTpl.pick) || 0)];
    const slot = teamSlot() || new Date().toISOString().slice(0, 10);
    let h = 0;
    for (const ch of slot) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return l[h % l.length];
  }
  async function openTeamTpl() {
    state.teamTpl = (await kvGet('teamTpl')).main || state.teamTpl || {};
    document.getElementById('dg-team-tpl')?.remove();
    const box = document.createElement('div');
    box.id = 'dg-team-tpl';
    box.setAttribute('style', 'position:fixed;inset:0;z-index:2147483646;background:rgba(15,23,42,.4);display:grid;place-items:center;font-family:inherit');
    const list = teamTplList().slice();
    const mode = state.teamTpl?.mode === 'fixed' ? 'fixed' : 'rotate';
    let pick = Number(state.teamTpl?.pick) || 0;
    let bulk = false; // ✍️ soạn hàng loạt: mỗi dòng 1 câu
    const draw = () => {
      box.innerHTML = `<div style="width:min(1280px,96vw);height:min(92vh,980px);display:flex;flex-direction:column;background:#fff;border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.35);overflow:hidden">
        <div style="padding:12px 18px;background:linear-gradient(90deg,#0068ff,#7c3aed);color:#fff;display:flex;align-items:center;gap:10px;flex:none"><b style="font-size:16px">💬 Tin nhắn mẫu của sếp – Nhắc cả đội</b>
          <span style="opacity:.85;font-size:12px">${list.length} câu</span><button data-t="x" style="margin-left:auto;all:unset;cursor:pointer;font-size:22px">×</button></div>
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:8px 18px;border-bottom:1px solid #e2e8f0;font-size:13px;flex:none">
          <label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="radio" name="tm" value="rotate" ${mode === 'rotate' ? 'checked' : ''}> 🔄 Xoay vòng – mỗi ca 1 câu</label>
          <label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="radio" name="tm" value="fixed" ${mode === 'fixed' ? 'checked' : ''}> 📌 Luôn dùng câu đã chọn</label>
          <button data-t="bulk" style="margin-left:auto;border:1px solid #c7d2fe;background:${bulk ? '#4f46e5;color:#fff' : '#eef2ff;color:#3730a3'};border-radius:999px;padding:4px 12px;cursor:pointer;font:inherit;font-weight:700">${bulk ? '✅ Xong, về dạng danh sách' : '✍️ Soạn hàng loạt (mỗi dòng 1 câu)'}</button></div>
        <div style="flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:0">
          <div style="min-height:0;overflow:auto;padding:10px 14px;border-right:1px solid #e2e8f0">
            ${bulk
              ? `<textarea data-bulk style="width:100%;height:100%;min-height:400px;box-sizing:border-box;font:inherit;font-size:13px;line-height:1.7;border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;resize:none">${esc(list.join('\n'))}</textarea>`
              : `<div style="display:grid;gap:3px">${list
                  .map((t, i) => `<div style="display:grid;grid-template-columns:26px 18px minmax(0,1fr) 26px;gap:4px;align-items:center">
                    <span style="color:#94a3b8;font-size:11px;font-weight:800;text-align:right">${i + 1}</span>
                    <input type="radio" name="tp" value="${i}" ${i === pick ? 'checked' : ''} title="Câu dùng khi chọn 'Luôn dùng câu đã chọn'" style="margin:0">
                    <input data-i="${i}" value="${esc(t)}" placeholder="Nhập câu…" style="font:inherit;font-size:13px;border:1px solid #e2e8f0;border-radius:6px;padding:4px 8px;height:28px;box-sizing:border-box;min-width:0">
                    <button data-t="del" data-i="${i}" title="Xoá câu này" style="all:unset;cursor:pointer;color:#b91c1c;font-size:13px;text-align:center">🗑</button></div>`)
                  .join('')}</div>
                <button data-t="add" style="margin-top:8px;border:1px dashed #94a3b8;background:#f8fafc;border-radius:8px;padding:4px 12px;cursor:pointer;font:inherit">＋ Thêm câu</button>`}
          </div>
          <div style="min-height:0;display:flex;flex-direction:column;padding:10px 14px;gap:6px;background:#f8fafc">
            <b style="font-size:13px">📱 Tin sẽ gửi vào nhóm Zalo “${esc(TEAM_GROUP)}” (ca này):</b>
            <div style="flex:1;min-height:0;overflow:auto;background:#e5efff;border-radius:12px;padding:10px">
              <div data-pv style="background:#fff;border-radius:10px;padding:10px 12px;box-shadow:0 1px 2px rgba(0,0,0,.08);font-size:13px;line-height:1.5;color:#111"></div></div>
          </div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:10px 18px;border-top:1px solid #e2e8f0;flex:none">
          <span style="color:#64748b;font-size:12px;margin-right:auto">Câu mở đầu tin nhắn; phía dưới là danh sách khách theo từng NVKD.</span>
          <button data-t="x" style="border:1px solid #e2e8f0;background:#fff;border-radius:8px;padding:7px 16px;cursor:pointer;font:inherit">Huỷ</button>
          <button data-t="save" style="border:0;background:linear-gradient(90deg,#0068ff,#7c3aed);color:#fff;border-radius:8px;padding:7px 18px;cursor:pointer;font:inherit;font-weight:800">💾 Lưu</button></div></div>`;
      preview();
    };
    const read = () => {
      const bt = box.querySelector('textarea[data-bulk]');
      if (bt) {
        const ls = bt.value.split('\n').map((x) => x.trim()).filter(Boolean);
        list.splice(0, list.length, ...(ls.length ? ls : [TEAM_TPL_DEFAULT[0]]));
      } else box.querySelectorAll('input[data-i]').forEach((ta) => (list[Number(ta.dataset.i)] = ta.value));
      pick = Math.min(list.length - 1, Number(box.querySelector('input[name="tp"]:checked')?.value ?? pick) || 0);
      return { list: list.map((x) => x.trim()).filter(Boolean), mode: box.querySelector('input[name="tm"]:checked')?.value || 'rotate', pick };
    };
    const preview = () => {
      const keep = state.teamTpl;
      state.teamTpl = read();
      const pv = box.querySelector('[data-pv]');
      if (pv) {
        // giống hệt tin gửi: câu mở đầu + mỗi NVKD 1 dòng (tên xanh đậm, mã khách in đậm), cách 1 dòng
        if ((state.teamItems || []).length) pv.innerHTML = buildTeamMsg().html;
        else pv.innerHTML = `<div>${esc(teamHead())}</div><div style="color:#94a3b8;margin-top:6px">(chưa có danh sách Gợi ý chốt đơn trên trang này – mở trang Báo giá để xem đủ tin)</div>`;
      }
      state.teamTpl = keep;
    };
    // Enter trong 1 dòng → thêm dòng mới ngay bên dưới (soạn nhanh)
    box.addEventListener('keydown', (e) => {
      const inp = e.target.closest?.('input[data-i]');
      if (!inp || e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      read();
      const i = Number(inp.dataset.i) + 1;
      list.splice(i, 0, '');
      draw();
      const nx = box.querySelector(`input[data-i="${i}"]`);
      nx?.focus();
      nx?.scrollIntoView({ block: 'nearest' });
    });
    box.addEventListener('input', preview);
    box.addEventListener('change', preview);
    box.addEventListener('click', async (e) => {
      if (e.target === box) return box.remove();
      const b = e.target.closest('[data-t]');
      if (!b) return;
      if (b.dataset.t === 'x') return box.remove();
      if (b.dataset.t === 'bulk') {
        read();
        bulk = !bulk;
        draw();
        return;
      }
      if (b.dataset.t === 'add') {
        read();
        list.push('');
        draw();
        const ins = box.querySelectorAll('input[data-i]');
        ins[ins.length - 1]?.focus();
        ins[ins.length - 1]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (b.dataset.t === 'del') {
        read();
        list.splice(Number(b.dataset.i), 1);
        if (!list.length) list.push(TEAM_TPL_DEFAULT[0]);
        pick = Math.min(pick, list.length - 1);
        draw();
        return;
      }
      if (b.dataset.t === 'save') {
        const v = { ...read(), at: Date.now(), by: meName };
        state.teamTpl = v;
        await kvMerge('teamTpl', { main: v });
        box.remove();
      }
    });
    draw();
    document.body.append(box);
  }
  if (IS_TOP) kvGet('teamTpl').then((t) => (state.teamTpl = t.main || null)).catch(() => {});
  function buildTeamMsg() {
    const items = state.teamItems || [];
    // Mỗi khách 1 lần (cộng giá trị các báo giá gợi ý của khách đó), gom theo NVKD
    const byCust = new Map();
    for (const { q } of items) {
      const who = staffOf(q, renderCtx.comments?.[q.id]) || 'Chưa rõ NVKD';
      if (isExcluded(who)) continue;
      // mã khách cũng rút gọn (vd. "DƯỢC PHẨM MEDBOLIDE" → "MEDBOLIDE")
      const code = shortCompany(q.customer?.code || '') || shortCompany(q.customer?.name || '') || q.code;
      const key = custKey(q) || code;
      const cur = byCust.get(key) || { who, code, amt: 0 };
      cur.amt += Number(q.amount) || 0;
      byCust.set(key, cur);
    }
    const by = new Map();
    for (const c of byCust.values()) {
      if (!by.has(c.who)) by.set(c.who, []);
      by.get(c.who).push(c);
    }
    const groups = [...by].map(([who, cs]) => [who, cs.sort((a, b) => b.amt - a.amt)]).sort((a, b) => b[1].reduce((t, c) => t + c.amt, 0) - a[1].reduce((t, c) => t + c.amt, 0));
    const val = (a) => (a ? `${Math.max(1, Math.round(a / 1e6)).toLocaleString('vi-VN')}tr` : 'chưa cho giá'); // vd. 87tr
    const head = teamHead();
    // Dạng danh sách: tên NVKD (số khách): rồi mỗi khách 1 dòng "• MÃ KHÁCH (xxtr)"; mỗi NVKD cách 1 dòng trống
    // Tổng tiền có thể có đơn: từng NVKD + toàn đội
    const sumTxt = (v) => (v >= 1e9 ? `${(Math.round(v / 1e7) / 100).toLocaleString('vi-VN')} tỷ` : `${Math.round(v / 1e6).toLocaleString('vi-VN')}tr`);
    const gSum = (cs) => cs.reduce((t, c) => t + (c.amt || 0), 0);
    const allSum = groups.reduce((t, [, cs]) => t + gSum(cs), 0);
    const totalLine = `Tổng có thể có đơn: ${sumTxt(allSum)}`;
    const text = [`${head}\n${totalLine}`, ...groups.map(([who, cs]) => [`${shortName(who)} (${cs.length}) – có thể có đơn ${sumTxt(gSum(cs))}:`, ...cs.map((c) => `• ${c.code} (${val(c.amt)})`)].join('\n'))].join('\n\n');
    const html = `<div>${esc(head)}</div><div>${esc('Tổng có thể có đơn: ')}<b><span style="color:#047857"><font color="#047857">${esc(sumTxt(allSum))}</font></span></b></div><div><br></div>${groups.map(([who, cs]) => `<div><b><span style="color:#1d4ed8"><font color="#1d4ed8">${esc(shortName(who))}</font></span></b> (${cs.length}) – có thể có đơn <b><span style="color:#047857"><font color="#047857">${esc(sumTxt(gSum(cs)))}</font></span></b>:</div>${cs.map((c) => `<div>• <b>${esc(c.code)}</b> (${esc(val(c.amt))})</div>`).join('')}`).join('<div><br></div>')}`;
    return { text, html, n: byCust.size, groups, head, val };
  }
  // Ảnh tin nhắc cả đội (vẽ thẳng canvas): mỗi NVKD 1 thẻ – tên, số khách, tổng tiền, các khách (mã + tiền)
  async function drawTeamImage() {
    const { groups, val } = buildTeamMsg();
    const W = 760, P = 20, S = 3; // khổ dọc vừa màn điện thoại, độ nét x3 (Zalo hiện rõ)
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = (w, px) => `${w} ${px}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
    // đo chiều cao trước
    const lay = [];
    let y = 16; // chỉ các thẻ NVKD (không tiêu đề)
    for (const [who, cs] of groups) {
      ctx.font = font(700, 24);
      let x = P + 24, rows = 1;
      const chips = cs.map((cu) => {
        const t1 = cu.code, t2 = ` ${val(cu.amt)}`;
        ctx.font = font(800, 24);
        const w1 = ctx.measureText(t1).width;
        ctx.font = font(700, 22);
        const w = w1 + ctx.measureText(t2).width + 32;
        if (x + w > W - P - 24) {
          x = P + 24;
          rows++;
        }
        const r = { t1, t2, x, row: rows - 1, w, w1, zero: !cu.amt };
        x += w + 10;
        return r;
      });
      const h = 78 + rows * 52 + 16;
      lay.push({ who, cs, chips, y, h });
      y += h + 14;
    }
    const H = y + 4;
    c.width = W * S;
    c.height = H * S;
    ctx.scale(S, S);
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(0, 0, W, H);
    const rr = (x, yy, w, h, r) => {
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, yy, w, h, r) : ctx.rect(x, yy, w, h);
    };
    for (const L of lay) {
      ctx.fillStyle = '#fff';
      rr(P, L.y, W - P * 2, L.h, 16);
      ctx.fill();
      ctx.fillStyle = '#1d4ed8';
      rr(P, L.y, 8, L.h, 4);
      ctx.fill();
      const tot = L.cs.reduce((t, cu) => t + cu.amt, 0);
      ctx.fillStyle = '#1d4ed8';
      ctx.font = font(800, 32);
      ctx.fillText(shortName(L.who), P + 24, L.y + 48);
      const nw = ctx.measureText(shortName(L.who)).width;
      ctx.fillStyle = '#64748b';
      ctx.font = font(600, 22);
      ctx.fillText(`${L.cs.length} khách`, P + 24 + nw + 14, L.y + 48);
      ctx.fillStyle = '#047857';
      ctx.font = font(800, 28);
      const tt = `Σ ${val(tot)}`;
      ctx.fillText(tt, W - P - 24 - ctx.measureText(tt).width, L.y + 48);
      for (const ch of L.chips) {
        const cy = L.y + 72 + ch.row * 52;
        ctx.fillStyle = ch.zero ? '#fef2f2' : '#eff6ff';
        rr(ch.x, cy, ch.w, 42, 21);
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = ch.zero ? '#fecaca' : '#bfdbfe';
        ctx.stroke();
        ctx.fillStyle = '#0f172a';
        ctx.font = font(800, 24);
        ctx.fillText(ch.t1, ch.x + 16, cy + 30);
        ctx.fillStyle = ch.zero ? '#b91c1c' : '#047857';
        ctx.font = font(700, 22);
        ctx.fillText(ch.t2, ch.x + 16 + ch.w1, cy + 30);
      }
    }
    return c.toDataURL('image/png');
  }
  // Ca nhắc: sáng (trước 12h) / chiều (từ 12h), thứ 2 → thứ 7 (giờ VN)
  const TEAM_AM = 9; // ca sáng nhắc từ 9:00
  const TEAM_PM = 14; // ca chiều nhắc từ 14:00
  function teamSlot() {
    const vn = new Date(Date.now() + 7 * 3600e3);
    const dow = vn.getUTCDay(); // 0 = CN
    const hm = vn.getUTCHours() * 60 + vn.getUTCMinutes();
    if (dow === 0 || hm < TEAM_AM * 60) return null; // chưa tới 9:00 → chưa vào ca
    return `${vn.toISOString().slice(0, 10)}-${hm < TEAM_PM * 60 ? 'sang' : 'chieu'}`;
  }
  // Mốc ca nhắc tiếp theo (giờ VN): trước 9:00 → 9:00, trước 14:00 → 14:00, sau đó → 9:00 ngày làm việc kế tiếp (bỏ CN)
  function teamNextAt() {
    const now = Date.now();
    const vn = new Date(now + 7 * 3600e3);
    let d = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - 7 * 3600e3;
    if (vn.getUTCDay() !== 0) for (const h of [TEAM_AM, TEAM_PM]) if (d + h * 3600e3 > now) return d + h * 3600e3;
    d += 24 * 3600e3;
    if (new Date(d + 7 * 3600e3).getUTCDay() === 0) d += 24 * 3600e3;
    return d + TEAM_AM * 3600e3;
  }
  const fmtCd = (ms) => {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
  };
  // Đồng hồ đếm ngược cạnh nút 📣 (cập nhật mỗi giây)
  let teamPolling = false;
  setInterval(async () => {
    // Đang có tin nhắc vừa bấm → hiện kết quả gửi Zalo ngay trong ô đồng hồ (giữ 10 phút)
    const tj = state.teamJob;
    if (tj && Date.now() - tj.at < 10 * 60e3) {
      if (!teamPolling && !['sent', 'error'].includes(tj.status)) {
        teamPolling = true;
        try {
          const j = (await kvGet('zaloJobs'))[tj.id];
          if (j) Object.assign(tj, { status: j.status, error: j.error, doneAt: j.doneAt });
        } catch {} finally {
          teamPolling = false;
        }
      }
      const hm = (t) => new Date(t || Date.now()).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
      const [cls, lab, val, tip] =
        tj.status === 'sent' ? ['ok', '✅ Đã gửi', hm(tj.doneAt), 'Đã gửi tin nhắc vào nhóm Zalo'] :
        tj.status === 'error' ? ['err', '❌ Lỗi', (tj.error || '').slice(0, 40), tj.error || ''] :
        tj.status === 'sending' ? ['run', '📨 Đang gửi', '…', 'Tab Zalo đang dán & gửi tin'] :
        Date.now() - tj.at > 60e3 ? ['err', '⚠️ Zalo chưa nhận', '', 'Tab Zalo chưa nhận việc – mở/F5 tab chat.zalo.me'] : ['run', '⏳ Chờ Zalo', '…', 'Đang chờ tab Zalo nhận việc'];
      document.querySelectorAll('[data-dg-cd]').forEach((e) => {
        e.className = `dgh-cd res ${cls}`;
        e.title = tip;
        e.innerHTML = `${lab} <b>${esc(val)}</b>`;
      });
      return;
    }
    document.querySelectorAll('[data-dg-cd]').forEach((e) => {
      if (e.classList.contains('res')) {
        e.className = 'dgh-cd';
        e.innerHTML = '⏳ ca tới <b></b>';
      }
      let left = Number(e.dataset.dgCd) - Date.now();
      if (left <= 0) {
        // tới giờ ca mới → chuyển sang đếm ca kế tiếp + hiện hộp nhắc (nếu ca này chưa gửi)
        e.dataset.dgCd = teamNextAt();
        left = Number(e.dataset.dgCd) - Date.now();
        if (MY_ADMIN) teamRemindPopup().catch?.(() => {});
      }
      e.querySelector('b').textContent = fmtCd(left);
      e.classList.toggle('soon', left < 15 * 60e3);
    });
  }, 1000);
  async function teamRemind(btn, asImage = false) {
    if (!(state.teamItems || []).length) return;
    // chuyển sang tab Zalo ngay lúc bấm: có tab "dg-zalo" thì đưa lên trước, chưa có thì mở mới
    try {
      const w = window.open('', 'dg-zalo');
      let blank = false;
      try {
        blank = !w || w.location.href === 'about:blank';
      } catch {
        blank = false; // đã là trang Zalo (khác nguồn)
      }
      // luôn tải lại tab Zalo để chạy bản script mới nhất (job vẫn chờ trong hàng đợi)
      if (w) w.location.href = 'https://chat.zalo.me/';
      w?.focus();
    } catch {}
    const { text, html } = buildTeamMsg();
    const image = asImage ? await drawTeamImage() : null;
    const names = await kvGet('zaloNames');
    const old = await kvGet('zaloJobs');
    const keep = Object.fromEntries(Object.entries(old).filter(([, j]) => Date.now() - (j?.at || 0) < 86400e3));
    const jobId = `${Date.now()}-team`;
    state.teamJob = { id: jobId, at: Date.now() };
    keep[jobId] = { draft: false, slot: teamSlot() || '', n: buildTeamMsg().n, to: TEAM_GROUP, zaloName: names[norm(TEAM_GROUP)]?.name || TEAM_GROUP, text, html, image, caption: image ? buildTeamMsg().head.replace(/:\s*$/, '') : '', status: 'pending', at: Date.now(), team: true };
    await call({ type: 'kv.set', key: 'zaloJobs', value: keep });
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
    const slot = teamSlot();
    if (slot) kvMerge('teamRemind', { [slot]: { at: Date.now(), by: meName } }).catch(() => {});
    document.getElementById('dg-team-modal')?.remove();
    if (btn) btn.textContent = '✅ Đã soạn – mở Zalo';
    if (btn) setTimeout(() => (btn.textContent = '📣 Nhắc cả đội'), 4000);
  }
  // Tự hiện hộp "Nhắc cả đội" (quản trị): thứ 2–7, sáng 1 lần + chiều 1 lần; ca đó đã gửi (ở bất kỳ máy nào) thì thôi
  async function teamRemindPopup(force = false) {
    if (!IS_TOP || !MY_ADMIN || !TEAM_GROUP || !(state.teamItems || []).length || document.getElementById('dg-team-modal')) return;
    const slot = teamSlot() || 'cn';
    if (!force) {
      if (slot === 'cn' || lsGet(`dgTeamShown-${slot}`)) return;
      if ((await kvGet('teamRemind'))[slot]) return;
      lsSet(`dgTeamShown-${slot}`, '1');
    }
    const { html, n } = buildTeamMsg();
    state.teamLast = (await kvGet('teamRemind')).last || null;
    const m = document.createElement('div');
    m.id = 'dg-team-modal';
    m.innerHTML = `<div style="position:fixed;inset:0;z-index:2147483646;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;animation:dgLbIn .2s ease">
      <div style="background:#fff;border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.35);width:min(760px,94vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden;font-size:14px">
        <div style="padding:16px 20px;background:linear-gradient(90deg,#0068ff,#7c3aed);color:#fff;display:flex;align-items:center;gap:10px"><span style="font-size:26px">📣</span><div><b style="font-size:17px">Nhắc cả đội kéo đơn về${slot === 'cn' ? '' : ` – ca ${slot.endsWith('sang') ? 'sáng' : 'chiều'}`}</b><div style="opacity:.85;font-size:12px">${n} khách đang trong Gợi ý chốt đơn · gửi vào nhóm Zalo “${esc(TEAM_GROUP)}”${(() => { const l = state.teamLast; return l?.at ? ` · lần gửi gần nhất: ${new Date(l.at).toLocaleString('vi-VN')}` : ''; })()}</div></div></div>
        <div style="padding:14px 20px;overflow:auto;background:#f1f5f9;display:grid;gap:10px">
          <div style="color:#334155;font-weight:600">${esc(buildTeamMsg().head)}</div>
          ${buildTeamMsg().groups.map(([who, cs]) => {
            const v = buildTeamMsg().val;
            const tot = cs.reduce((t, c) => t + c.amt, 0);
            return `<div style="background:#fff;border-radius:12px;border-left:5px solid #1d4ed8;padding:10px 14px;box-shadow:0 1px 3px rgba(15,23,42,.06)">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><b style="color:#1d4ed8;font-size:16px">${esc(shortName(who))}</b><span style="color:#64748b;font-size:12px">${cs.length} khách</span><b style="margin-left:auto;color:#047857">Σ ${esc(v(tot))}</b></div>
              <div style="display:flex;flex-wrap:wrap;gap:6px">${cs.map((c) => `<span style="border-radius:999px;padding:2px 10px;font-size:13px;background:${c.amt ? '#eff6ff' : '#fef2f2'};border:1px solid ${c.amt ? '#bfdbfe' : '#fecaca'}"><b>${esc(c.code)}</b> <span style="color:${c.amt ? '#047857' : '#b91c1c'};font-weight:600">${esc(v(c.amt))}</span></span>`).join('')}</div></div>`;
          }).join('')}
        </div>
        <div style="padding:12px 20px;display:flex;justify-content:flex-end;gap:8px;border-top:1px solid #e2e8f0">
          <button data-a="later" style="cursor:pointer;border:1px solid #e2e8f0;background:#fff;border-radius:8px;padding:8px 16px;font-weight:600">Để sau</button>
          <button data-a="sendimg" style="cursor:pointer;border:1px solid #c7d2fe;background:#eef2ff;color:#3730a3;border-radius:8px;padding:8px 16px;font-weight:800">🖼️ Gửi dạng hình</button>
          <button data-a="send" style="cursor:pointer;border:0;background:linear-gradient(90deg,#0068ff,#7c3aed);color:#fff;border-radius:8px;padding:8px 20px;font-weight:800">📣 Gửi dạng chữ</button></div>
      </div></div>`;
    document.body.append(m);
    m.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'later' || e.target === m.firstElementChild) m.remove();
      if (a === 'send') teamRemind(null);
      if (a === 'sendimg') teamRemind(null, true);
    });
  }
  if (IS_TOP) setInterval(() => teamRemindPopup().catch(() => {}), 20000);
  // ---------- Băng vàng đầu trang CRM ("1. CÔNG TY … (xxđ) 2. …") → thay bằng danh sách 🔥 Gợi ý chốt đơn ----------
  // Ẩn nội dung gốc của CRM và chèn danh sách deal ưu tiên (bấm để mở báo giá). NVKD chỉ thấy deal của mình.
  let topHotHtml = '';
  async function topHotBanner() {
    if (!IS_TOP || !root) return;
    let host = document.querySelector('[data-dg-hotbar]');
    if (!host) {
      const re = /^\s*1\.\s+\S[\s\S]*\(\s*[\d.,]+\s*đ\s*\)[\s\S]*\b2\.\s/;
      const cands = [...document.querySelectorAll('body *')].filter((e) => {
        if (e.closest('#dg-root, [data-dg-hot]')) return false;
        const r = e.getBoundingClientRect();
        return r.top < 260 && r.height > 0 && re.test(e.innerText || '');
      });
      // phần tử nhỏ nhất chứa đủ danh sách
      host = cands.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length || b.querySelectorAll('*').length - a.querySelectorAll('*').length)[0];
      if (!host) return;
      host.setAttribute('data-dg-hotbar', '1');
    }
    const [hot, done, pin] = await Promise.all([kvGet('aiHot'), kvGet('aiHotDone'), kvGet('hotPinned')]);
    const quotes = renderCtx.quotes || (await kvGet('quotes'));
    // gộp báo giá quản lý tự thêm (📌, giữ tới khi lên đơn) vào kết quả AI
    const aiItems = hot.latest?.items || [];
    const aiIds = new Set(aiItems.map((x) => x.id));
    const pinned = Object.entries(pin || {}).filter(([, v]) => v && !v.off).map(([id]) => Number(id));
    const pinSet = new Set(pinned);
    const all = [...aiItems.map((x) => ({ ...x, pinned: pinSet.has(x.id) })), ...pinned.filter((id) => !aiIds.has(id)).map((id) => ({ id, pinned: true }))];
    const items = all
      .map((x) => ({ x, q: quotes[x.id] }))
      .filter(({ x, q }) => q && (x.pinned || !done[x.id]) && !CLOSED.has(q.quoteStatus) && !q.hasOrder && !hasOrderFull(q, renderCtx.comments?.[x.id]) && !cancelInfo(renderCtx.comments?.[x.id]))
      .filter(({ q }) => MY_ADMIN || norm(staffOf(q, renderCtx.comments?.[q.id])) === norm(meName));
    if (!items.length) return; // chưa có dữ liệu → giữ nguyên băng của CRM
    // Gọn, đẹp: mỗi deal 1 thẻ nhỏ (số · mã BG · tên khách rút gọn · số tiền), cuộn khi nhiều
    state.teamItems = items;
    // Ca này chưa gửi nhắc cả đội → nút to + rung lắc
    const slotNow = teamSlot();
    const urge = MY_ADMIN && slotNow && !(await kvGet('teamRemind'))[slotNow];
    const hotSum = items.reduce((t, { q }) => t + (Number(q.amount) || 0), 0);
    const html = `<div class="dgh-t">🔥 Gợi ý chốt đơn <b>${items.length}</b><span class="dgh-sum" title="Tổng giá trị các báo giá trong Gợi ý chốt đơn">Σ ${moneyShortG(hotSum)}</span>${MY_ADMIN && TEAM_GROUP ? `<button class="dgh-team${urge ? ' urge' : ''}" data-dg-team title="${urge ? 'Ca này CHƯA nhắc cả đội – ' : ''}Soạn tin nhắc cả đội (mỗi NVKD: mã khách cần kéo đơn) → mở Zalo Web, nhóm ${esc(TEAM_GROUP)}, dán tin">📣 Nhắc cả đội${urge ? ' – chưa gửi!' : ''}</button><button class="dgh-tpl" data-dg-team-tpl title="Cài đặt tin nhắn mẫu của sếp (câu mở đầu tin nhắc cả đội)">⚙️</button><span class="dgh-cd${urge ? ' urge' : ''}" data-dg-cd="${teamNextAt()}" title="${urge ? 'Thời gian còn lại của ca này để nhắc cả đội' : 'Đã nhắc ca này – đếm ngược tới ca nhắc tiếp theo'}">${urge ? '⏰ hết ca' : '⏳ ca tới'} <b>${fmtCd(teamNextAt() - Date.now())}</b></span>` : ''}</div><div class="dgh-l">${items
      .map(({ x, q }, i) => `<a href="/bao-gia/update/${q.id}" data-dg-hotlink class="dgh-i" title="${esc(`${q.customer?.name || ''} · ${q.name || ''}`)}"><i>${x.pinned ? '📌' : i + 1}</i><b>${esc(q.code)}</b><span>${esc(shortCompany(q.customer?.name || q.customer?.code || ''))}</span><em>${q.amount ? moneyShortG(q.amount) : '0đ'}</em></a>`)
      .join('')}</div>`;
    let box = host.parentElement.querySelector(':scope > [data-dg-hot]');
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('data-dg-hot', '1');
      // Chiếm đúng chỗ băng cũ (cùng bề rộng / co giãn), tự trang trí
      const cs = getComputedStyle(host);
      const w = host.getBoundingClientRect().width;
      box.setAttribute('style', `flex:${cs.flex};width:${w ? `${Math.round(w)}px` : 'auto'};max-width:100%;margin:${cs.margin};align-self:stretch;min-width:0;box-sizing:border-box`);
      host.after(box);
      if (!document.getElementById('dgh-css')) {
        const st = document.createElement('style');
        st.id = 'dgh-css';
        st.textContent = `[data-dg-hot]{background:linear-gradient(135deg,#fffbeb,#fff7ed);border:1px solid #fcd34d;border-radius:10px;padding:5px 8px;font-family:inherit;display:flex;flex-direction:column;gap:3px;overflow:hidden}
[data-dg-hot] .dgh-t{font-size:10px;font-weight:800;color:#c2410c;text-transform:uppercase;letter-spacing:.3px}
[data-dg-hot] .dgh-t b{background:#ea580c;color:#fff;border-radius:999px;padding:0 6px;margin-left:3px}
[data-dg-hot] .dgh-t{display:flex;align-items:center;gap:6px}
[data-dg-hot] .dgh-team{margin-left:auto;border:0;cursor:pointer;font:inherit;font-size:10px;font-weight:800;text-transform:none;letter-spacing:0;color:#fff;background:linear-gradient(90deg,#0068ff,#7c3aed);border-radius:999px;padding:1px 10px}
[data-dg-hot] .dgh-team:hover{filter:brightness(1.1)}
[data-dg-hot] .dgh-tpl{border:1px solid #c7d2fe;background:#fff;border-radius:999px;cursor:pointer;font-size:10px;padding:0 6px;line-height:16px;margin-left:-2px}
[data-dg-hot] .dgh-tpl:hover{background:#eef2ff}
[data-dg-hot] .dgh-sum{font-size:11px;font-weight:900;text-transform:none;letter-spacing:0;color:#047857;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:999px;padding:0 8px;font-variant-numeric:tabular-nums}
[data-dg-hot] .dgh-cd{font-size:10px;font-weight:700;text-transform:none;letter-spacing:0;color:#475569;background:#fff;border:1px solid #e2e8f0;border-radius:999px;padding:1px 8px;white-space:nowrap;font-variant-numeric:tabular-nums}
[data-dg-hot] .dgh-cd b{background:none!important;color:#1d4ed8!important;padding:0!important;margin:0!important}
[data-dg-hot] .dgh-cd.urge{color:#b91c1c;border-color:#fecaca;background:#fef2f2}
[data-dg-hot] .dgh-cd.urge b{color:#dc2626!important}
[data-dg-hot] .dgh-cd.ok{color:#15803d;border-color:#86efac;background:#f0fdf4}
[data-dg-hot] .dgh-cd.ok b{color:#15803d!important}
[data-dg-hot] .dgh-cd.err{color:#b91c1c;border-color:#fecaca;background:#fef2f2;max-width:320px;overflow:hidden;text-overflow:ellipsis}
[data-dg-hot] .dgh-cd.err b{color:#b91c1c!important;font-weight:600}
[data-dg-hot] .dgh-cd.run{color:#1d4ed8;border-color:#bfdbfe;background:#eff6ff;animation:dgUrgeGlow 1.2s ease-in-out infinite}
[data-dg-hot] .dgh-cd.soon{animation:dgUrgeGlow 1.2s ease-in-out infinite}
[data-dg-hot] .dgh-team.urge{font-size:13px;padding:4px 16px;background:linear-gradient(90deg,#ef4444,#f97316);box-shadow:0 0 0 0 rgba(239,68,68,.6);animation:dgUrgeShake .9s ease-in-out infinite, dgUrgeGlow 1.2s ease-in-out infinite}
@keyframes dgUrgeShake{0%,100%{transform:translate(0,0) rotate(0)}10%{transform:translate(-3px,1px) rotate(-6deg)}20%{transform:translate(3px,-1px) rotate(6deg)}30%{transform:translate(-3px,1px) rotate(-6deg)}40%{transform:translate(3px,-1px) rotate(6deg)}50%{transform:translate(-2px,0) rotate(-4deg)}60%{transform:translate(2px,0) rotate(4deg)}70%,100%{transform:none}}
@keyframes dgUrgeGlow{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.55)}50%{box-shadow:0 0 0 8px rgba(239,68,68,0)}}
[data-dg-hot] .dgh-l{display:flex;flex-wrap:wrap;gap:3px 5px;max-height:62px;overflow-y:auto}
[data-dg-hot] .dgh-i{display:inline-flex;align-items:center;gap:3px;font-size:10px;line-height:16px;padding:0 6px 0 2px;border-radius:999px;background:#fff;border:1px solid #fde68a;color:#334155;text-decoration:none;white-space:nowrap;max-width:260px}
[data-dg-hot] .dgh-i:hover{border-color:#f97316;box-shadow:0 1px 4px rgba(249,115,22,.25)}
[data-dg-hot] .dgh-i i{font-style:normal;font-size:9px;font-weight:800;color:#fff;background:#f97316;border-radius:999px;min-width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center}
[data-dg-hot] .dgh-i b{color:#1d4ed8;font-weight:800}
[data-dg-hot] .dgh-i span{overflow:hidden;text-overflow:ellipsis;color:#475569}
[data-dg-hot] .dgh-i em{font-style:normal;font-weight:800;color:#047857}
[data-dg-hot] .dgh-i u{text-decoration:none;font-weight:800;color:#c2410c}`;
        document.head.append(st);
      }
    }
    // Ẩn luôn khung nhắc bên phải ("Toán ơi! Hãy kết nối…") → băng gợi ý trải dài cả 2 bên
    if (!box.dataset.wide) {
      const hr = host.getBoundingClientRect();
      const right = [...document.querySelectorAll('body *')]
        .filter((e) => {
          if (e.closest('#dg-root, [data-dg-hot]') || e.contains(host) || e.contains(box)) return false;
          const r = e.getBoundingClientRect();
          return r.top < 260 && r.height > 20 && r.left >= hr.right - 2 && /ơi!\s*Hãy/i.test(e.innerText || '');
        })
        .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)
        .find((e) => e.getBoundingClientRect().width < window.innerWidth * 0.6);
      if (right) {
        const rr = right.getBoundingClientRect();
        box.style.width = `${Math.round(rr.right - hr.left)}px`;
        right.setAttribute('data-dg-hidden', '1');
        box.dataset.wide = '1';
      }
    }
    document.querySelectorAll('[data-dg-hidden]').forEach((e) => (e.style.display = 'none'));
    host.style.display = 'none';
    if (html !== topHotHtml || !box.innerHTML) {
      topHotHtml = html;
      box.innerHTML = html;
    }
  }
  if (IS_TOP) {
    setInterval(() => topHotBanner().catch(() => {}), 4000);
    document.addEventListener('click', (e) => {
      const tb = e.target.closest?.('[data-dg-team]');
      if (tb) {
        e.preventDefault();
        e.stopPropagation();
        return teamRemind(tb); // bấm nút → chuyển thẳng sang Zalo, gửi dạng chữ (có định dạng), không hiện hộp
      }
      if (e.target.closest?.('[data-dg-team-tpl]')) {
        e.preventDefault();
        e.stopPropagation();
        return openTeamTpl();
      }
      const a = e.target.closest?.('a[data-dg-hotlink]');
      if (!a || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      location.assign(a.getAttribute('href'));
    });
  }

  // ---------- 🔥 Thêm báo giá đang mở vào "Gợi ý chốt đơn" ----------
  function lightStyle() {
    if (document.getElementById('dg-light-style')) return;
    const st = document.createElement('style');
    st.id = 'dg-light-style';
    st.textContent = `
      @keyframes dgHotShimmer { 0% { background-position: 0% 50%; } 100% { background-position: 200% 50%; } }
      @keyframes dgHotGlow { 0%, 100% { box-shadow: 0 0 0 0 rgba(249,115,22,.55); transform: scale(1); } 50% { box-shadow: 0 0 0 7px rgba(249,115,22,0); transform: scale(1.04); } }
      @keyframes dgHotFlame { 0%, 100% { transform: rotate(-8deg) scale(1); } 50% { transform: rotate(8deg) scale(1.18); } }
      .dg-hotpin { display:inline-flex; align-items:center; gap:5px; margin-left:8px; vertical-align:middle; cursor:pointer; font-size:12.5px; font-weight:800; border-radius:999px; padding:3px 12px; color:#fff;
        background: linear-gradient(90deg,#f97316,#ef4444,#f59e0b,#f97316); background-size: 200% 100%; animation: dgHotShimmer 2.2s linear infinite, dgHotGlow 1.6s ease-in-out infinite; transition: filter .15s; }
      .dg-hotpin:hover { filter: brightness(1.08); animation-play-state: paused; }
      .dg-hotpin .fl { display:inline-block; animation: dgHotFlame .9s ease-in-out infinite; }
      .dg-hotpin.on { animation: none; background: #fff7ed; color: #c2410c; border: 1px solid #fdba74; cursor: default; }
      .dg-hotpin.on .fl { animation: none; }
      .dg-hotpin.busy { opacity: .7; cursor: wait; }
      @media (prefers-reduced-motion: reduce) { .dg-hotpin, .dg-hotpin .fl { animation: none; } }`;
    document.head.append(st);
  }
  function hotHas(qid) {
    const pin = renderCtx.hotPinned?.[qid];
    if (pin && !pin.off) return 'pin';
    return (renderCtx.aiHot?.items || []).some((x) => x.id === qid) ? 'ai' : null;
  }
  function injectHotPin(qid, q) {
    const anchor = document.querySelector('.dg-signtg') || document.querySelector('.dg-setprice-head') || document.querySelector('.dg-printq');
    if (!anchor) return;
    lightStyle();
    let b = document.querySelector('.dg-hotpin');
    const paint = () => {
      const has = hotHas(qid);
      if (b.dataset.st === String(has)) return; // không vẽ lại → hiệu ứng không bị khởi động lại
      b.dataset.st = String(has);
      b.classList.toggle('on', !!has);
      b.innerHTML = has ? `✓ Đã có trong gợi ý chốt đơn${has === 'pin' ? ' 📌' : ''}` : '<span class="fl">🔥</span> Thêm vào gợi ý chốt đơn';
      b.title = has
        ? has === 'pin' ? 'Đã thêm tay – giữ trong Gợi ý chốt đơn tới khi lên đơn' : 'AI đã chọn báo giá này trong Gợi ý chốt đơn'
        : 'Thêm báo giá này vào tab "Gợi ý chốt đơn" – giữ tới khi lên đơn, AI phân tích lại vẫn giữ';
    };
    if (!b) {
      b = document.createElement('span');
      b.className = 'dg-hotpin';
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (hotHas(qid) || b.classList.contains('busy')) return;
        b.classList.add('busy');
        try {
          const cur = renderCtx.quotes?.[qid] || q;
          await kvMerge('hotPinned', { [qid]: { code: cur.code, at: Date.now(), by: meName } });
          renderCtx.hotPinned = await kvGet('hotPinned');
        } finally {
          b.classList.remove('busy');
          paint();
        }
      });
      anchor.after(b);
    }
    paint();
  }

  // Gắn nút "💲 Set giá" vào bình luận xin giá (luồng của báo giá Flexo đang mở)
  function injectPriceButtons() {
    if (!IS_TOP || !root) return;
    const qid = currentQuoteId();
    if (!qid) return;
    // Mã báo giá: từ dữ liệu đã ghi nhận, chưa có thì lấy từ tiêu đề trang ("#BG26937 - …")
    const q = renderCtx.quotes?.[qid] || { id: qid, code: document.title.match(/#(BG\d+)/)?.[1] };
    if (!q.code) return;
    // 💲 Set giá chỉ cho báo giá Flexo chưa chốt; 🖨 In báo giá → dán cho mọi báo giá
    // Luôn hiện nút Set giá (loại hàng / tình trạng ghi nhận có thể chưa đúng); không có PO giấy tấm thì hộp Set giá tự báo
    const canSet = true;
    // dữ liệu báo giá có thể tải sau → cập nhật ẩn/hiện nút Set giá đã gắn
    document.querySelectorAll('.dg-setprice').forEach((sp) => (sp.parentElement.style.display = canSet ? '' : 'none'));
    // 💲 Set giá cạnh tiêu đề "Bình luận" (sau nút In báo giá)
    const head = document.querySelector('.dg-printq');
    if (head && !head.parentElement.querySelector('.dg-setprice-head')) {
      const b = document.createElement('span');
      b.className = 'dg-setprice-head';
      b.textContent = '💲 Set giá';
      b.title = 'Set giá cho báo giá Flexo: chọn % → Lên PO giấy tấm, kéo % Deal từng nhà cung cấp, lưu báo giá';
      b.setAttribute('style', 'display:inline-block;margin-left:8px;vertical-align:middle;cursor:pointer;font-size:13px;font-weight:700;color:#fff;background:linear-gradient(90deg,#16a34a,#059669);border-radius:999px;padding:3px 12px');
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPriceDialog(renderCtx.quotes?.[qid] || q);
      });
      head.after(b);
    }
    document.querySelectorAll('.dg-setprice-head').forEach((b) => (b.style.display = canSet ? 'inline-block' : 'none'));
    injectHotPin(qid, q);
    for (const one of document.querySelectorAll('.ant-comment')) {
      const content = one.querySelector(':scope > .ant-comment-inner > .ant-comment-content');
      if (!content) continue;
      const text = content.querySelector('.ant-comment-content-detail')?.innerText || '';
      const author = content.querySelector('.ant-comment-content-author-name')?.innerText.trim() || '';
      // Câu xin giá của NVKD (không tính câu "E cho chị giá nhé" của chính quản lý) → có thêm nút Set giá
      const isAsk = PRICE_ASK_RE.test(text) && !(author && author.startsWith(meName));
      const isRoot = !one.parentElement?.closest('.ant-comment');
      // Dòng thông báo hệ thống ("… đã tạo báo giá #BG… giá trị …", "… lên đơn hàng với giá trị …") → không gắn nút
      if (/đã tạo báo giá\s*#?BG\d+|lên đơn hàng với giá trị/i.test(text)) continue;
      // Nút In báo giá → dán: mọi bình luận gốc của báo giá đang mở + mọi câu xin giá
      if (!isAsk && !isRoot) continue;
      // chỉ luồng có nhãn mã của báo giá đang mở
      let top = one;
      while (top.parentElement?.closest('.ant-comment')) top = top.parentElement.closest('.ant-comment');
      const topContent = top.querySelector(':scope > .ant-comment-inner > .ant-comment-content');
      if (![...(topContent?.querySelectorAll('.ant-tag') || [])].some((t) => t.textContent.trim() === q.code)) continue;
      // Câu trả lời trong luồng không có hàng "Trả lời" riêng → gắn nút vào hàng "Trả lời" của bình luận gốc
      const ownActions = content.querySelector(':scope > ul.ant-comment-actions');
      const cm = ownActions ? one : top;
      const actions = ownActions || topContent?.querySelector(':scope > ul.ant-comment-actions');
      if (!actions || actions.querySelector('.dg-printq-reply')) continue;
      const li = document.createElement('li');
      if (!canSet) li.style.display = 'none';
      li.innerHTML = '<span class="dg-setprice" style="cursor:pointer;color:#fff;background:linear-gradient(90deg,#16a34a,#059669);border-radius:999px;padding:1px 10px;font-weight:700;font-size:12px;margin-left:8px">💲 Set giá</span>';
      li.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPriceDialog(renderCtx.quotes?.[qid] || q);
      });
      actions.append(li);
      // 🖨 In báo giá → dán ảnh vào ô "Trả lời" của chính bình luận này (tự mở ô trả lời nếu chưa mở)
      const li2 = document.createElement('li');
      const pb = document.createElement('span');
      pb.className = 'dg-printq-reply';
      pb.textContent = '🖨 In báo giá → dán';
      pb.title = 'In báo giá, chụp ảnh (che SĐT khách) rồi dán vào ô trả lời của bình luận này';
      pb.setAttribute('style', 'cursor:pointer;color:#fff;background:linear-gradient(90deg,#2563eb,#7c3aed);border-radius:999px;padding:1px 10px;font-weight:700;font-size:12px;margin-left:8px');
      const replyBox = async () => {
        let ta = cm.querySelector(':scope .ant-comment-nested textarea, :scope > .ant-comment-inner textarea');
        if (!ta) {
          const reply = [...actions.querySelectorAll('*')].reverse().find((x) => x.textContent.trim() === 'Trả lời');
          reply?.click();
          ta = await waitFor(() => cm.querySelector('textarea'), 3000, 100);
        }
        return ta || findCommentBox();
      };
      pb.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!/^[⏳📸📋]/u.test(pb.textContent)) printQuoteToComment(pb, replyBox);
      });
      li2.append(pb);
      actions.append(li2);
    }
  }
  if (IS_TOP) setInterval(() => injectPriceButtons(), 2000);

  // Dòng hàng trong 1 PO (giấy tấm): Mã TP → "Thành tiền", quy đổi theo "Tổng thanh toán" của PO → giấy tấm từng sản phẩm
  function readPoLines(modal, total) {
    const t = [...modal.querySelectorAll('table')].find((x) => [...x.querySelectorAll('th')].some((th) => th.innerText.trim() === 'Mã TP'));
    if (!t) return {};
    const hs = [...t.querySelectorAll('thead th')].map((th) => th.innerText.trim());
    const ti = hs.indexOf('Mã TP');
    const ai = hs.indexOf('Thành tiền');
    if (ti < 0 || ai < 0) return {};
    const raw = {};
    for (const tr of t.querySelectorAll('tbody tr')) {
      const tp = (tr.cells[ti]?.innerText.match(/TP\d{3,}/) || [])[0];
      const amt = Number(String(tr.cells[ai]?.innerText || '').split('\n')[0].replace(/[^\d]/g, '')) || 0;
      if (tp && amt) raw[tp] = (raw[tp] || 0) + amt;
    }
    const sum = Object.values(raw).reduce((a, v) => a + v, 0);
    if (!sum) return {};
    const k = total ? total / sum : 1;
    return Object.fromEntries(Object.entries(raw).map(([tp, v]) => [tp, Math.round(v * k)]));
  }
  const addTp = (acc, lines) => {
    for (const [tp, v] of Object.entries(lines || {})) acc[tp] = (acc[tp] || 0) + v;
    return acc;
  };
  async function readRealPos(doc, q, vis) {
    const lbl = [...doc.querySelectorAll('label, span, div')].find((e) => !e.children.length && /^DS PO:?$/.test(e.textContent.trim()));
    const box = lbl?.parentElement;
    const btns = box ? [...box.querySelectorAll('button')].filter((b) => /PO\d+/i.test(b.innerText)) : [];
    if (!btns.length) {
      // chưa có PO thật → đánh dấu đã kiểm (khỏi mở lại liên tục)
      const all0 = await kvGet('margins');
      if (all0[q.code]?.flexo) await kvMerge('margins', { [q.code]: { ...all0[q.code], flexo: { ...all0[q.code].flexo, poCheckAt: Math.floor(Date.now() / 1000) } } }).catch(() => {});
      return false;
    }
    const suppliers = [];
    const byTp = {};
    for (const [i, b] of btns.entries()) {
      const po = b.innerText.trim();
      setStep(`Đọc PO thật ${po} (${i + 1}/${btns.length})…`);
      b.click();
      const modal = await waitFor(() => vis().find((m) => /Cập nhật PO/.test(m.innerText)), 10000, 250);
      if (!modal) continue;
      const read = () => Number((modal.innerText.match(/Tổng thanh toán:\s*([\d.]+)/) || [])[1]?.replace(/\./g, '') || 0);
      let last = -1;
      let same = 0;
      let total = 0;
      for (let k = 0; k < 40 && same < 2; k++) {
        await sleep(400);
        total = read();
        same = total && total === last ? same + 1 : 0;
        last = total;
      }
      const sel = modal.querySelector('.ant-select-selection-item')?.innerText || '';
      const code = sel.split('|')[0].trim() || po.split('_')[0];
      if (total) {
        addTp(byTp, readPoLines(modal, total));
        const ex = suppliers.find((x) => x.code === code);
        if (ex) {
          ex.total += total;
          ex.po += `, ${po}`;
        } else suppliers.push({ code, name: sel.split('|').slice(1).join('|').trim() || sel, total, po });
      }
      modal.querySelector('.ant-modal-close')?.click();
      await waitFor(() => !vis().includes(modal), 4000, 200);
      await sleep(300);
    }
    if (!suppliers.length) return false;
    let pageTotal = 0;
    const tl = [...doc.querySelectorAll('label, div, span')].find((e) => e.children.length === 0 && /^Số tiền thanh toán:?$/.test(e.innerText.trim()));
    const inp = tl?.closest('.ant-form-item, .ant-row, div')?.parentElement?.querySelector('input');
    if (inp) pageTotal = Number(String(inp.value).replace(/[^\d]/g, '')) || 0;
    const all = await kvGet('margins');
    const cur = all[q.code] || { products: {} };
    cur.flexo = { suppliers, byTp, missing: [], quoteTotal: pageTotal || q.amount || 0, amountAt: q.amount || 0, mode: FLEXO_MODE, fromPo: true, at: Math.floor(Date.now() / 1000), poCheckAt: Math.floor(Date.now() / 1000) };
    await kvMerge('margins', { [q.code]: cur });
    return true;
  }
  async function readFlexoCost(f, q) {
    const doc = f.contentDocument;
    if (!doc) return;
    await saveKindTotals(doc, q?.code).catch(() => {});
    const vis = () => [...doc.querySelectorAll('.ant-modal-wrap')].filter((m) => getComputedStyle(m).display !== 'none');
    // Đã có PO thật ("DS PO: LT_PO15171 …") → ưu tiên đọc "Tổng thanh toán" của từng PO (số chính xác), không dùng PO nháp
    if (await readRealPos(doc, q, vis)) return;
    const poBtn = [...doc.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Lên PO');
    if (!poBtn) return;
    setStep('Đang mở Lên PO → Giấy tấm…');
    for (const t of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) poBtn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
    let item = null;
    for (let i = 0; i < 15 && !item; i++) {
      await sleep(200);
      item = [...doc.querySelectorAll('.ant-dropdown .ant-dropdown-menu-item')].find((li) => li.innerText.trim() === 'Giấy tấm');
    }
    if (!item) return;
    (item.querySelector('.ant-dropdown-menu-title-content > span') || item).click();
    let modal = null;
    for (let i = 0; i < 25 && !modal; i++) {
      await sleep(250);
      modal = vis().find((m) => /Tạo PO cho báo giá/.test(m.innerText));
    }
    if (!modal) return;
    await sleep(1200);
    saveDealHist(modal, q?.code);
    const readTotal = () => Number((modal.innerText.match(/Tổng thanh toán:\s*([\d.]+)/) || [])[1]?.replace(/\./g, '') || 0);
    const chips = [];
    for (const b of modal.querySelectorAll('button.ant-btn')) {
      const t = b.innerText.trim();
      if (/^[A-Z][A-Z0-9_.&-]{1,12}$/.test(t) && t !== 'OUT' && !chips.some((c) => c.code === t)) chips.push({ code: t, btn: b });
    }
    const selName = () => modal.querySelector('.ant-select-selection-item')?.innerText || '';
    // Bấm mã nhà cung cấp rồi chờ PO của nhà đó tải xong: tên trong ô chọn đã đổi và "Tổng thanh toán"
    // đứng yên qua 3 lần đọc. PO có thể tải chậm (vd. YFY ~10 giây) nên chờ tối đa 20 giây.
    const readOne = async (ch) => {
      const prevName = selName();
      const prev = readTotal();
      ch.btn.click();
      let last = 0;
      let same = 0;
      for (let i = 0; i < 50; i++) {
        await sleep(400);
        const t = readTotal();
        const ready = t && (selName() !== prevName || i >= 12) && (t !== prev || i >= 12);
        if (!ready) continue;
        same = t === last ? same + 1 : 0;
        last = t;
        if (same >= 2) return t;
      }
      return 0;
    };
    const list = chips.slice(0, 8);
    const suppliers = [];
    const byTpD = {};
    let missing = [];
    for (const [ci, ch] of list.entries()) {
      setStep(`Đang đọc nhà cung cấp ${ch.code} (${ci + 1}/${list.length})…`);
      const total = await readOne(ch);
      if (total) {
        suppliers.push({ code: ch.code, name: selName(), total });
        addTp(byTpD, readPoLines(modal, total));
      }
      else missing.push(ch);
    }
    // Đọc lại nhà cung cấp bị lỡ (PO tải quá chậm) – thiếu 1 nhà là % sai hẳn
    for (const ch of [...missing]) {
      setStep(`Đọc lại nhà cung cấp ${ch.code}…`);
      const total = await readOne(ch);
      if (!total) continue;
      suppliers.push({ code: ch.code, name: selName(), total });
      addTp(byTpD, readPoLines(modal, total));
      missing = missing.filter((x) => x !== ch);
    }
    vis().forEach((m) => m.querySelector('.ant-modal-close')?.click());
    if (!suppliers.length) return;
    suppliers.sort((a, b) => list.findIndex((c) => c.code === a.code) - list.findIndex((c) => c.code === b.code));
    // Giá trị báo giá: ưu tiên ô "Số tiền thanh toán" trên trang
    let pageTotal = 0;
    const lbl = [...doc.querySelectorAll('label, div, span')].find((e) => e.children.length === 0 && /^Số tiền thanh toán:?$/.test(e.innerText.trim()));
    const inp = lbl?.closest('.ant-form-item, .ant-row, div')?.parentElement?.querySelector('input');
    if (inp) pageTotal = Number(String(inp.value).replace(/[^\d]/g, '')) || 0;
    const all = await kvGet('margins');
    const cur = all[q.code] || { products: {} };
    cur.flexo = {
      suppliers,
      byTp: byTpD,
      missing: missing.map((c) => c.code),
      quoteTotal: pageTotal || q.amount || 0,
      amountAt: q.amount || 0, // tổng báo giá lúc tính – đổi thì tính lại
      mode: FLEXO_MODE,
      at: Math.floor(Date.now() / 1000),
      poCheckAt: Math.floor(Date.now() / 1000), // đã kiểm: chưa có PO thật
    };
    await kvMerge('margins', { [q.code]: cur });
  }

  // ---------- Chỉ 1 MÁY quét (khoá chung đồng bộ qua máy chủ: kv 'scanLock') ----------
  // Máy đang quét ghi nhịp tim mỗi ~1 phút; máy khác thấy nhịp tim < 3 phút thì không quét.
  // Máy quét tắt / ngừng quá 3 phút → máy khác tự nhận việc.
  let MACHINE_ID = null;
  const machineId = async () => {
    if (MACHINE_ID) return MACHINE_ID;
    const m = await kvGet('machine').catch(() => ({}));
    MACHINE_ID = m.id || Math.random().toString(36).slice(2) + Date.now().toString(36);
    if (!m.id) await call({ type: 'kv.set', key: 'machine', value: { id: MACHINE_ID } }).catch(() => {});
    return MACHINE_ID;
  };
  const SCAN_STALE = 180000;
  async function otherMachineScanning() {
    const l = (await kvGet('scanLock').catch(() => ({}))).main;
    return !!(l?.machine && l.machine !== (await machineId()) && Date.now() - l.beat < SCAN_STALE);
  }
  let scanBeatAt = 0;
  async function scanBeat(force = false) {
    if (!force && Date.now() - scanBeatAt < 60000) return;
    scanBeatAt = Date.now();
    await kvMerge('scanLock', { main: { machine: await machineId(), beat: Date.now(), who: meName } }).catch(() => {});
  }

  async function takeLock() {
    if (loggedOut || !MY_ACCESS) return false; // đang đăng xuất / chưa được cấp quyền → không quét
    if (await otherMachineScanning()) return false; // máy khác đang quét
    const lock = await kvGet('collectLock');
    if (lock?.tab && lock.tab !== TAB_ID && Date.now() - lock.at < 90000) return false; // tab khác đang chạy
    await call({ type: 'kv.set', key: 'collectLock', value: { tab: TAB_ID, at: Date.now() } });
    scanBeat(true);
    return true;
  }

  let lastListRun = 0;
  async function runCollector(force = false) {
    if (!IS_TOP || collect.running) return;
    if (!force && !(await getSettings()).auto) return;
    if (!(await takeLock())) return;
    collect.running = true;
    collect.done = 0;
    collect.suggested = 0;
    const full = (await kvGet('fullCollect'))?.on === true;
    collect.full = full;
    try {
      // Thu thập toàn bộ: đọc hết các trang danh sách ở lượt đầu, các lượt sau chỉ đọc bình luận
      const fc = full ? await kvGet('fullCollect') : null;
      // Đọc 10 trang danh sách tối đa 30 phút/lần (lượt cập nhật nhanh 2 phút đã đọc 3 trang đầu)
      if (!full && Date.now() - lastListRun > 30 * 60000) {
        lastListRun = Date.now();
        await collectListPages();
        // Đơn hàng Misa: 5 trang mới nhất mỗi 30 phút; đọc sâu tới 6 tháng 1 lần / ngày
        const deep = Date.now() - Number(lsGet('dgMisaDeep') || 0) > 24 * 3600e3;
        await collectMisaOrders(deep ? 40 : 5).catch(() => {});
        await collectDebts().catch(() => {});
        if (deep) lsSet('dgMisaDeep', String(Date.now()));
      }
      else if (!fc.listDone) {
        await collectListPages(999);
        await call({ type: 'kv.set', key: 'fullCollect', value: { ...fc, listDone: Date.now() } });
      }
      const [quotes, comments, collected] = await Promise.all([kvGet('quotes'), kvGet('comments'), kvGet('collected')]);
      const queue = pickQueue(quotes, comments, collected, full);
      collect.remaining = full ? Object.values(quotes).filter((q) => q.id && !collected[q.id] && !isExcluded(q.staff?.name)).length : 0;
      collect.total = queue.length;
      progress();
      for (const q of queue) {
        if (!force && !(await getSettings()).auto) break;
        collect.current = q.code;
        progress();
        const mg = (await kvGet('margins'))[q.code];
        const needOffset = q.offset && offsetStale(mg, q);
        const needFlexo = (q.kinds || []).includes('flexo') && q.amount && flexoStale(mg?.flexo, q);
        await loadInFrame(q.id, undefined, undefined, needOffset || needFlexo
          ? async (f) => {
              if (needOffset) await readOffsetMargins(f, q.code);
              if (needFlexo) await readFlexoCost(f, q);
            }
          : null);
        await kvMerge('collected', { [q.id]: Math.floor(Date.now() / 1000) });
        // Lịch sử mua hàng của khách: tối đa 1 lần / ngày / khách
        const cid = q.customer?.id;
        if (cid) {
          const od = (await kvGet('orders'))[cid];
          // Thiếu đơn (mới đọc trang 1 trong khi khách có nhiều đơn trong 6 tháng) → đọc lại để lấy thêm trang
          const oldestAt = Math.min(...(od?.orders || []).map((o) => (o.at > 1e11 ? o.at / 1000 : o.at) || Infinity));
          const partial = od && (od.total || 0) > (od.orders?.length || 0) && oldestAt > Date.now() / 1000 - 190 * 86400 && hoursSince(od.at) > 1;
          if (!od || hoursSince(od.at) > 24 || partial) {
            collect.current = `${q.code} · lịch sử mua hàng`;
            progress();
            await loadInFrame(null, `/khach-hang/view/${cid}?t=order`, /\/misaOrder\?.*customerId=/, (f) => readMoreOrders(f, cid));
          }
        }
        await call({ type: 'kv.set', key: 'collectLock', value: { tab: TAB_ID, at: Date.now() } });
        collect.done++;
        if (full) collect.remaining = Math.max(0, collect.remaining - 1);
        await sleep(COLLECT.gapMs);
      }
      // Tính % (Flexo/Offset) cho các báo giá khả thi điểm cao còn thiếu số – tối đa 10 / lượt
      {
        const [q3, c3, o3, m3] = await Promise.all([kvGet('quotes'), kvGet('comments'), kvGet('orders'), kvGet('margins')]);
        renderCtx.margins = m3;
        const missing = feasibleList(q3, c3, o3)
          .filter(({ q }) => {
            const k = q.kinds || (q.offset ? ['offset'] : []);
            const mg = m3[q.code] || {};
            return (k.includes('offset') && offsetStale(mg, q)) || (k.includes('flexo') && q.amount && flexoStale(mg.flexo, q));
          })
          .slice(0, 10);
        for (const { q } of missing) {
          if (!force && !(await getSettings()).auto) break;
          collect.current = `${q.code} · tính %`;
          progress();
          const k = q.kinds || (q.offset ? ['offset'] : []);
          await loadInFrame(q.id, undefined, undefined, async (f) => {
            if (k.includes('offset')) await readOffsetMargins(f, q.code);
            if (k.includes('flexo') && q.amount) await readFlexoCost(f, q);
          });
          await sleep(COLLECT.gapMs);
        }
        // Kiểm tra lại tình trạng: báo giá đang hiện trong danh sách mà lâu chưa mở lại trang chi tiết
        // (danh sách ERP chỉ đọc vài trang đầu → báo giá cũ đã Thành công / có đơn vẫn nằm lại). Mở ngầm trang chi tiết
        // để cập nhật tình trạng + mã đơn Misa; mỗi lượt tối đa 8 báo giá, mỗi báo giá 3 ngày kiểm 1 lần.
        const chk = await kvGet('quoteCheck');
        const recheck = feasibleList(q3, c3, o3)
          .map(({ q }) => q)
          .filter((q) => q?.id && !CLOSED.has(q.quoteStatus) && !q.hasOrder && Date.now() - (chk[q.id] || 0) > 3 * 86400e3)
          .sort((a, b) => (chk[a.id] || 0) - (chk[b.id] || 0) || (a.createdAt || 0) - (b.createdAt || 0))
          .slice(0, 8);
        for (const q of recheck) {
          if (!force && !(await getSettings()).auto) break;
          collect.current = `${q.code} · kiểm tình trạng`;
          progress();
          await loadInFrame(q.id);
          await kvMerge('quoteCheck', { [q.id]: Date.now() });
          await sleep(COLLECT.gapMs);
        }
      }
      // Hết báo giá chưa thu thập → kết thúc chế độ toàn bộ
      if (full && !queue.length) {
        await call({ type: 'kv.set', key: 'fullCollect', value: { ...(await kvGet('fullCollect')), on: false, doneAt: Date.now() } });
        collect.full = false;
      }
      // Tự phân tích: soạn gợi ý cho các báo giá cần hỏi lại mà chưa có gợi ý mới hơn bình luận cuối
      // (bỏ qua khi đang thu thập toàn bộ để không tốn phí Claude mỗi lượt)
      if (full) return;
      collect.current = 'phân tích';
      progress();
      const [q2, c2, sg] = await Promise.all([kvGet('quotes'), kvGet('comments'), kvGet('suggests')]);
      const need = [...listByMode(q2, c2, 'hoiNhanh'), ...staleList(q2, c2)]
        // Báo giá Thất bại: không tự soạn (không hiện trong bảng, đỡ tốn phí Claude)
        .filter(({ q, c, last }) => q?.quoteStatus !== 'REJECT' && (!sg[c.id] || sg[c.id].at / 1000 < last.createdAt))
        .slice(0, COLLECT.autoSuggest);
      for (const { c } of need) {
        await suggestComment(c.id);
        collect.suggested++;
      }
      collect.current = 'tự học bộ câu hỏi';
      progress();
      await learnQuestions().catch((err) => console.warn('[DG] learn', err));
    } catch (e) {
      state.error = e.message;
    } finally {
      collect.running = false;
      collect.current = '';
      collect.lastRun = Date.now();
      await call({ type: 'kv.set', key: 'collectLock', value: null }).catch(() => {});
      progress();
    }
  }

  // Cập nhật gần realtime theo ERP: mỗi 3 phút đọc lại 3 trang đầu danh sách Báo giá (trạng thái mới nhất),
  // và mở lại vài báo giá khả thi đã lâu chưa kiểm tra để bắt báo giá vừa lên đơn / chốt / thất bại.
  const QUICK = { everyMin: 2, pages: 3, recheck: 4, recheckMin: 45 };
  let quickLast = 0;
  async function quickRefresh() {
    if (!IS_TOP || collect.running || document.hidden) return;
    if (!(await getSettings()).auto) return;
    if ((await kvGet('fullCollect'))?.on) return;
    if (!(await takeLock())) return;
    collect.running = true;
    quickLast = Date.now();
    try {
      await collectListPages(QUICK.pages);
      // Công nợ: đọc lại tối đa 30 phút / lần
      if (Date.now() - Number(lsGet('dgDebtAt') || 0) > 30 * 60e3) {
        lsSet('dgDebtAt', String(Date.now()));
        await collectDebts().catch(() => {});
      }
      const [quotes, comments, collected, orders] = await Promise.all(['quotes', 'comments', 'collected', 'orders'].map((k) => kvGet(k)));
      const now = Date.now() / 1000;
      const stale = feasibleList(quotes, comments, orders)
        .filter(({ q }) => !collected[q.id] || now - collected[q.id] > QUICK.recheckMin * 60)
        .sort((a, b) => (collected[a.q.id] || 0) - (collected[b.q.id] || 0))
        .slice(0, QUICK.recheck);
      for (const { q } of stale) {
        collect.current = `${q.code} · kiểm tra trạng thái`;
        progress();
        await loadInFrame(q.id);
        await kvMerge('collected', { [q.id]: Math.floor(Date.now() / 1000) });
        await sleep(1500);
      }
    } catch (e) {
      console.warn('[DG] quickRefresh', e);
    } finally {
      collect.running = false;
      collect.current = '';
      await call({ type: 'kv.set', key: 'collectLock', value: null }).catch(() => {});
      progress();
    }
  }

  if (IS_TOP) {
    setInterval(() => quickRefresh(), QUICK.everyMin * 60 * 1000);
    setTimeout(() => quickRefresh(), 8000); // vừa mở trang → cập nhật ngay
    // Quay lại tab / mở bảng mà đã hơn 1 phút chưa cập nhật → cập nhật ngay
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - quickLast > 60000) quickRefresh();
    });
    setTimeout(() => runCollector(), 90000); // sau lượt cập nhật nhanh đầu tiên
    setInterval(() => runCollector(), COLLECT.everyMin * 60 * 1000);
    // Nút "Chạy ngay" trong popup extension ghi kv collectNow = thời điểm bấm
    let handledNow = Date.now();
    let lastFullRun = 0;
    let lastAutoCheck = Date.now();
    setInterval(async () => {
      if (collect.running) return;
      const t = await call({ type: 'kv.get', key: 'collectNow' }).catch(() => null);
      if (typeof t === 'number' && t > handledNow) {
        handledNow = t;
        return runCollector(true);
      }
      // Chế độ thu thập toàn bộ (bật trong popup): chạy liên tục, nghỉ 1 phút giữa các lượt
      const fc = await call({ type: 'kv.get', key: 'fullCollect' }).catch(() => null);
      if (fc?.on && Date.now() - lastFullRun > 60000 && Date.now() - collect.lastRun > 60000) {
        lastFullRun = Date.now();
        return runCollector(true);
      }
      // Thu thập ngầm đang bật: còn báo giá chưa đọc / cần đọc lại → tự chạy tiếp, nghỉ 2 phút giữa các lượt (không cần bấm "Chạy ngay")
      if (!fc?.on && Date.now() - collect.lastRun > 120000 && Date.now() - lastAutoCheck > 120000) {
        lastAutoCheck = Date.now();
        if (!(await getSettings()).auto) return;
        const [quotes, comments, collected] = await Promise.all([kvGet('quotes'), kvGet('comments'), kvGet('collected')]);
        if (pickQueue(quotes, comments, collected).length) runCollector();
      }
    }, 3000);
  }

  // ---------- Giao diện ----------
  const state = { busy: new Set(), error: null, handoverDraft: {}, filter: (() => { try { return localStorage.getItem('dgFilter') || ''; } catch { return ''; } })() };
  let host, root;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
    .fab { position: fixed; left: 16px; bottom: 16px; z-index: 2147483646; border: 0; border-radius: 999px;
      padding: 10px 16px; background: #1d4ed8; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.25); display: inline-flex; align-items: center; gap: 8px; }
    .fab-badge { background: #ef4444; color: #fff; border-radius: 999px; padding: 2px 9px; font-weight: 800; font-size: 13px;
      box-shadow: 0 0 0 2px rgba(255,255,255,.85); }
    .fab.alert { animation: dgbounce 2.6s ease-in-out infinite; background: linear-gradient(135deg, #1d4ed8, #7c3aed); }
    .fab.alert::before { content: ''; position: absolute; inset: 0; border-radius: 999px; pointer-events: none;
      box-shadow: 0 0 0 0 rgba(239,68,68,.6); animation: dgring 1.8s ease-out infinite; }
    .fab.alert .fab-badge { animation: dgbadge 1.8s ease-in-out infinite; }
    @keyframes dgring { 0% { box-shadow: 0 0 0 0 rgba(239,68,68,.55); } 100% { box-shadow: 0 0 0 16px rgba(239,68,68,0); } }
    @keyframes dgbounce { 0%, 70%, 100% { transform: translateY(0); } 76% { transform: translateY(-7px); } 82% { transform: translateY(0); }
      88% { transform: translateY(-3px); } 94% { transform: translateY(0); } }
    @keyframes dgbadge { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.15); } }
    .panel { position: fixed; left: 16px; top: 12px; bottom: 60px; z-index: 2147483647; width: min(1760px, calc(100vw - 32px));
      max-height: none; overflow: auto; background: #fff; color: #1f2328; border-radius: 12px; font-size: 14px;
      box-shadow: 0 10px 40px rgba(0,0,0,.3); padding: 18px 22px; }
    .panel[hidden] { display: none; }
    .panel.full { left: 0; top: 0; bottom: 0; width: 100vw !important; border-radius: 0; }
    .grip { position: fixed; top: 12px; bottom: 60px; width: 12px; z-index: 2147483647; cursor: ew-resize; display: flex; align-items: center; justify-content: center; }
    .grip[hidden] { display: none; }
    .grip::after { content: ''; width: 4px; height: 56px; border-radius: 99px; background: #cbd5e1; transition: background .15s, height .15s; }
    .grip:hover::after, .grip.on::after { background: #6366f1; height: 96px; }
    .hbtns { display: flex; align-items: center; gap: 4px; }
    .x.fs { font-size: 16px; }
    .x.fs.urge { color: #fff; background: #f97316; border-radius: 8px; width: 30px; height: 28px; animation: ctaGlow 1.4s ease-in-out infinite; }
    .fulltip { display: inline-flex; align-items: center; gap: 8px; margin-right: 8px; padding: 5px 6px 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 700;
      color: #9a3412; background: linear-gradient(90deg, #fff7ed, #ffedd5); border: 1.5px solid #fdba74; animation: ftIn .5s ease both, ftNudge 2.4s ease-in-out 1s infinite; }
    .ft-ic { font-size: 15px; color: #ea580c; display: inline-block; animation: ftZoom 1.2s ease-in-out infinite; }
    .ft-ok { font: inherit; font-size: 12px; font-weight: 900; color: #fff; border: 0; border-radius: 999px; padding: 4px 12px; cursor: pointer;
      background: linear-gradient(135deg, #f97316, #ea580c); box-shadow: 0 3px 10px rgba(234,88,12,.35); }
    .ft-ok:hover { filter: brightness(1.08); }
    @keyframes ftIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: none; } }
    @keyframes ftNudge { 0%, 85%, 100% { transform: translateX(0); } 90% { transform: translateX(-4px); } 95% { transform: translateX(3px); } }
    @keyframes ftZoom { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.35); } }
    h2 { font-size: 15px; margin: 0 0 4px; }
    h3 { font-size: 13px; margin: 14px 0 6px; }
    .muted { color: #656d76; font-size: 12px; }
    .err { color: #cf222e; margin: 8px 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 5px 4px; border-bottom: 1px solid #eaeef2; vertical-align: middle; }
    th { font-size: 12px; color: #656d76; font-weight: 600; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    button.act { border: 1px solid #d0d7de; background: #f6f8fa; border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 12px; }
    button.act:disabled { opacity: .5; cursor: wait; }
    button.link { border: 0; background: none; color: #1d4ed8; cursor: pointer; padding: 0; font-size: 13px; }
    .score { font-weight: 700; }
    .good { color: #1a7f37; } .mid { color: #9a6700; } .bad { color: #cf222e; }
    .result { white-space: pre-wrap; background: #f6f8fa; border-radius: 8px; padding: 10px; margin-top: 8px; line-height: 1.5; }
    .box { border: 1px solid #d0d7de; border-radius: 8px; padding: 10px; }
    .unread a { color: #1d4ed8; text-decoration: none; display: block; padding: 5px 0; border-bottom: 1px solid #eaeef2; }
    .unread a.item, .unread .item-head { display: grid; grid-template-columns: 34px 84px 74px minmax(0, .45fr) 130px minmax(0, 1.55fr) 104px 74px 136px 120px 52px; align-items: center;
      gap: 10px; padding: 6px 4px; border-radius: 6px; font-size: 13px; }
    .unread .item-head { position: sticky; top: -18px; z-index: 2; background: #f1f5f9; border-radius: 8px; margin-bottom: 4px;
      font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .04em; }
    .unread .item-head > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .unread .item-head .it-amt { font-size: 14px; text-transform: none; letter-spacing: 0; color: #047857; background: #dcfce7; border-radius: 6px; padding: 2px 6px; }
    .unread a.item:hover { background: #f5f8ff; }
    .unread a.item > * { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .it-code { font-weight: 800; font-size: 14px; }
    /* Cột mã khách hàng riêng: thẳng hàng giữa các dòng */
    .kh-occ { font-style: normal; display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; margin-left: 4px; padding: 0 4px; border-radius: 999px; background: #64748b; color: #fff; font-size: 10px; font-weight: 800; vertical-align: middle; }
    .it-cust { display: flex; align-items: center; min-width: 0; } .it-cust .kh-occ { flex: none; }
    .it-cust .kh { margin-left: 0; font-size: 11px; padding: 0 7px; max-width: 100%; min-width: 0; flex: 0 1 auto; display: inline-block; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
    .it-no { text-align: right; color: #94a3b8; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .it-main .kh, .it-main .knd, .it-main .tgt, .it-main .hip, .it-main .crd, .it-main .prm, .it-main .smp, .it-main .ctr, .it-main .nodep
      { margin-left: 0; margin-right: 4px; font-size: 11px; padding: 0 7px; }
    .it-name { color: #1e3a8a; }
    .it-who { display: flex; align-items: center; gap: 6px; color: #334155; }
    .it-who span { overflow: hidden; text-overflow: ellipsis; }
    .it-ago { color: #64748b; font-size: 12px; text-align: right; }
    .it-amt { text-align: right; font-weight: 800; color: #047857; font-variant-numeric: tabular-nums; }
    .it-amt .noprice { margin-left: 0; font-size: 11px; padding: 0 6px; }
    .it-date { color: #64748b; font-size: 12px; font-variant-numeric: tabular-nums; }
    .it-date.new { color: #0f766e; font-weight: 700; }
    .it-pct { display: flex; justify-content: flex-end; gap: 4px; font-size: 12px; font-variant-numeric: tabular-nums; }
    .pc { width: 50px; flex: none; text-align: center; border-radius: 6px; padding: 2px 0; font-weight: 800; border-left: 3px solid transparent; }
    .pc.f { background: #eff6ff; border-left-color: #3b82f6; }
    .pc.o { background: #faf5ff; border-left-color: #a855f7; }
    .pc.good { color: #047857; } .pc.bad { color: #b91c1c; }
    .pc.wait { color: #94a3b8; font-weight: 600; }
    .pc.warn { color: #b45309; font-size: 10px; }
    .item-head .pc.dl.sum { color: #6d28d9; background: #ede9fe; font-size: 13px; text-transform: none; letter-spacing: 0; }
    .pc.dl.angry { color: #b91c1c; background: #fee2e2; border-left-color: #ef4444; font-size: 11px; animation: dgAngry 1.6s ease-in-out infinite; }
    @keyframes dgAngry { 0%, 100% { transform: none; } 10%, 30% { transform: rotate(-3deg); } 20%, 40% { transform: rotate(3deg); } 50% { transform: none; } }
    .pc.dl { width: 104px; padding: 2px 6px; text-align: right; white-space: nowrap; }
    .it-fea { text-align: right; font-weight: 800; color: #1d4ed8; }
    .it-fea .fea { display: inline-block; padding: 1px 7px; border-radius: 999px; font-weight: 800; }
    .item-main { flex: 1; min-width: 0; }
    .item-amt { flex: none; min-width: 150px; text-align: right; font-size: 16px; font-weight: 800; color: #047857;
      font-variant-numeric: tabular-nums; white-space: nowrap; }
    .item-amt .noprice { margin-left: 0; }
    .unread a:last-child { border-bottom: 0; }
    textarea.suggest-edit { width: 100%; min-height: 110px; border: 1px solid #c8d6f5; border-radius: 8px; padding: 10px;
      background: #eef4ff; font: inherit; line-height: 1.5; resize: vertical; margin-top: 8px; color: inherit; }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    /* Đầu bảng: thông tin bên trái, "Bình luận mới nhất" bên phải */
    .headrow { display: flex; gap: 16px; align-items: flex-start; }
    .headinfo { flex: 1 1 auto; min-width: 0; }
    .nbox { flex: 0 1 560px; min-width: 280px; border: 1px solid #dbe4f0; border-radius: 10px; padding: 6px 8px; background: #fbfdff; }
    .nbox-h { font-weight: 700; font-size: 12px; color: #334155; margin-bottom: 2px; }
    .nbadge { background: #ef4444; color: #fff; border-radius: 999px; padding: 0 7px; font-size: 11px; margin-left: 4px; }
    .nitem { display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-radius: 6px; font-size: 12px; color: #64748b; text-decoration: none; }
    a.nitem:hover { background: #eef4ff; }
    .nitem .ntext { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nitem .nago { flex: none; font-size: 11px; color: #94a3b8; }
    .nitem .ndot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: transparent; }
    .nitem.unread-n { color: #0f172a; font-weight: 700; background: #f0f6ff; }
    .nitem.unread-n .ndot { background: #2563eb; }
    @media (max-width: 900px) { .headrow { flex-direction: column; } .nbox { width: 100%; } }
    .warn { background: #fff8c5; border: 1px solid #d4a72c; border-radius: 6px; padding: 6px 8px; margin-top: 8px; }
    .btns { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px; }
    .label { margin-top: 10px; font-weight: 600; }
    .suggest { background: #eef4ff; }
    button.act.primary { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
    .collector { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; }
    .who { display: inline-flex; align-items: center; gap: 6px; vertical-align: middle; }
    .ava { border-radius: 50%; object-fit: cover; flex: none; display: inline-flex; align-items: center; justify-content: center; }
    .ava.ini { background: #dbe4ff; color: #1d4ed8; font-size: 11px; font-weight: 700; width: 22px; height: 22px; }
    .loading { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
      background: rgba(15, 23, 42, .28); backdrop-filter: blur(3px); opacity: 0; }
    .loading.show { animation: dgfade .25s ease-out forwards; }
    .loading[hidden] { display: none; }
    .lcard { position: relative; overflow: hidden; width: min(460px, calc(100vw - 48px)); background: #fff; border-radius: 18px;
      padding: 26px 28px 22px; box-shadow: 0 24px 60px rgba(15,23,42,.28), 0 0 0 1px rgba(29,78,216,.08); color: #1f2328;
      transform: translateY(14px) scale(.94); opacity: 0; }
    .loading.show .lcard { animation: dgpop .38s cubic-bezier(.2,.9,.3,1.25) .05s forwards; }
    .lbar { position: absolute; left: 0; right: 0; top: 0; height: 4px; background: #e0e7ff; overflow: hidden; }
    .lbar span { position: absolute; top: 0; bottom: 0; width: 40%; border-radius: 4px;
      background: linear-gradient(90deg, #60a5fa, #1d4ed8, #7c3aed); animation: dgbar 1.1s ease-in-out infinite; }
    .ltop { display: flex; align-items: center; gap: 8px; }
    .llabel { font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #64748b; }
    .lcode { margin: 6px 0 4px; font-size: 44px; line-height: 1.05; font-weight: 800; letter-spacing: -.01em;
      background: linear-gradient(90deg, #1d4ed8, #7c3aed, #1d4ed8); background-size: 200% 100%;
      -webkit-background-clip: text; background-clip: text; color: transparent; animation: dgshine 2.4s linear infinite; }
    .lname { font-size: 17px; font-weight: 600; line-height: 1.35; color: #0f172a; margin-bottom: 10px; }
    .lcust { display: flex; align-items: center; gap: 14px; margin-top: 4px; padding: 14px 16px; border-radius: 14px;
      background: linear-gradient(135deg, #fff7ed, #fffbeb); border: 1px solid #fed7aa; border-left: 5px solid #f97316;
      box-shadow: 0 4px 14px rgba(249,115,22,.12); }
    .licon { flex: none; width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
      font-size: 24px; background: #fff; box-shadow: 0 2px 8px rgba(249,115,22,.18); }
    .lcust-body { min-width: 0; flex: 1; }
    .lcust-label { font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #c2410c;
      display: flex; align-items: center; gap: 4px; }
    .lcust-name { font-size: 20px; line-height: 1.3; font-weight: 800; color: #7c2d12; margin-top: 2px; word-break: break-word; }
    .lstaff { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; color: #475569; }
    .lstatus { margin-left: auto; background: #eef2ff; color: #4338ca; border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 600; }
    .spinner { width: 16px; height: 16px; border: 2.5px solid #dbe4ff; border-top-color: #1d4ed8; border-radius: 50%;
      animation: dgspin .8s linear infinite; }
    @keyframes dgfade { to { opacity: 1; } }
    @keyframes dgpop { to { transform: none; opacity: 1; } }
    @keyframes dgbar { 0% { left: -40%; } 100% { left: 100%; } }
    @keyframes dgshine { to { background-position: 200% 0; } }
    @keyframes dgspin { to { transform: rotate(360deg); } }
    .kh { display: inline-block; background: #fff1e6; color: #b45309; border: 1px solid #fcd9b6; border-radius: 4px;
      padding: 0 6px; font-size: 12px; font-weight: 600; margin-left: 4px; vertical-align: 1px; }
    button.act.hero { position: relative; overflow: hidden; border: 0; color: #fff; font-size: 15px; font-weight: 700;
      padding: 10px 18px; border-radius: 10px; background: linear-gradient(135deg, #2563eb, #7c3aed); background-size: 160% 160%;
      box-shadow: 0 6px 18px rgba(79,70,229,.35); animation: dgglow 2.2s ease-in-out infinite, dggrad 4s ease infinite;
      transition: transform .15s ease, box-shadow .15s ease; display: inline-flex; align-items: center; gap: 8px; }
    button.act.hero::after { content: ''; position: absolute; top: 0; left: -60%; width: 40%; height: 100%;
      background: linear-gradient(100deg, transparent, rgba(255,255,255,.45), transparent); transform: skewX(-20deg);
      animation: dgsweep 2.8s ease-in-out infinite; }
    button.act.hero:hover:not(:disabled) { transform: translateY(-2px) scale(1.03); box-shadow: 0 10px 26px rgba(79,70,229,.45); }
    button.act.hero:active:not(:disabled) { transform: scale(.98); }
    button.act.hero:disabled { opacity: .85; cursor: wait; animation: dggrad 1.5s ease infinite; }
    .spinner.light { border-color: rgba(255,255,255,.35); border-top-color: #fff; }
    @keyframes dgglow { 0%,100% { box-shadow: 0 6px 18px rgba(79,70,229,.35), 0 0 0 0 rgba(124,58,237,.45); }
      50% { box-shadow: 0 6px 18px rgba(79,70,229,.35), 0 0 0 8px rgba(124,58,237,0); } }
    @keyframes dggrad { 0%,100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
    @keyframes dgsweep { 0% { left: -60%; } 60%,100% { left: 130%; } }
    .rev { margin-left: 8px; background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; border-radius: 999px;
      padding: 2px 10px; font-size: 13px; font-weight: 800; vertical-align: 1px; }
    .amt { margin-left: 6px; color: #047857; font-weight: 700; font-size: 13px; }
    .noprice { margin-left: 6px; background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; border-radius: 999px;
      padding: 1px 9px; font-size: 12px; font-weight: 800; animation: dgbadge 1.8s ease-in-out infinite; display: inline-block; }
    .warn.danger { background: #fef2f2; border-color: #f87171; color: #991b1b; font-weight: 600; }
    .sent { color: #047857; font-weight: 700; }
    .warn.quick { display: grid; gap: 6px; }
    .quick-why { font-weight: 600; }
    .learned-tag { display: inline-block; margin-left: 4px; font-size: 11px; font-weight: 700; color: #7c3aed; background: #f3e8ff; border-radius: 999px; padding: 0 8px; }
    .quick-row { display: flex; align-items: center; gap: 12px; }
    .quick-text { flex: 1; font: inherit; font-size: 16px; font-weight: 700; color: #1f2328; background: #fff; border-radius: 8px;
      padding: 8px 12px; border: 1px dashed #d4a72c; resize: vertical; min-height: 110px; max-height: 50vh; line-height: 1.4; }
    /* Thẻ bên phải hẹp: ô câu hỏi chiếm hết chiều ngang, nút gửi xuống dưới */
    .side .quick-row { flex-direction: column; align-items: stretch; gap: 8px; }
    .side .quick-row .act { align-self: flex-end; }
    .quick-text:focus { outline: 2px solid #fcd34d; border-style: solid; }
    .tgt { margin-left: 6px; display: inline-block; background: #ecfdf5; color: #047857; border: 1px solid #6ee7b7; border-radius: 999px;
      padding: 1px 9px; font-size: 12px; font-weight: 800; vertical-align: 1px; }
    button.chipbtn { cursor: pointer; font: inherit; font-size: 13px; }
    .sec-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 18px 0 8px; }
    .sec-head h3 { margin: 0; font-size: 16px; display: flex; align-items: center; gap: 8px; }
    .sec-head .cnt { background: #1d4ed8; color: #fff; border-radius: 999px; padding: 1px 10px; font-size: 13px; }
    .sec-right { display: flex; align-items: center; gap: 8px; }
    .search { display: flex; align-items: center; gap: 6px; border: 1px solid #cbd5e1; border-radius: 999px; padding: 4px 12px; background: #fff;
      width: 300px; transition: border-color .15s, box-shadow .15s; }
    .search:focus-within { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,.15); }
    .search input { border: 0; outline: 0; font: inherit; font-size: 13px; width: 100%; background: transparent; color: #0f172a; }
    .sec-right .rev { margin: 0; font-size: 15px; padding: 4px 12px; }
    .sortbtn2 { font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; border: 1px solid #cbd5e1; background: #fff; color: #334155;
      border-radius: 999px; padding: 4px 12px; }
    .sortbtn2:hover { border-color: #6366f1; color: #4338ca; }
    .fbar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; background: #f8fafc; border: 1px solid #eef2f7;
      border-radius: 10px; padding: 6px 10px; margin-bottom: 6px; }
    .fgroup { display: flex; align-items: center; gap: 6px; }
    .fname { font-size: 9px; font-weight: 800; color: #a3aec2; text-transform: uppercase; letter-spacing: .08em; white-space: nowrap; }
    .fchips { display: flex; flex-wrap: wrap; gap: 4px; }
    .fchip { --c: #475569; --bg: #f1f5f9; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; font: inherit; font-size: 12px;
      font-weight: 600; line-height: 1.2; color: #334155; background: #fff; border: 1px solid #e5e9f0; border-radius: 999px; padding: 1px 2px 1px 8px;
      transition: border-color .15s, box-shadow .15s; }
    .fchip .fi { font-size: 11px; }
    .fchip b { min-width: 18px; text-align: center; font-size: 11px; color: var(--c); background: var(--bg); border-radius: 999px; padding: 0 5px; }
    .fchip:hover { border-color: var(--c); box-shadow: 0 1px 4px rgba(15,23,42,.08); }
    .fchip.on { background: var(--c); border-color: var(--c); color: #fff; }
    .fchip.on b { background: rgba(255,255,255,.25); color: #fff; }
    .fchip.blue { --c: #1d4ed8; --bg: #dbeafe; } .fchip.slate { --c: #475569; --bg: #e2e8f0; } .fchip.red { --c: #dc2626; --bg: #fee2e2; }
    .fchip.amber { --c: #b45309; --bg: #fef3c7; } .fchip.sky { --c: #0369a1; --bg: #e0f2fe; } .fchip.pink { --c: #be185d; --bg: #fce7f3; }
    .fchip.green { --c: #15803d; --bg: #dcfce7; } .fchip.orange { --c: #c2410c; --bg: #ffedd5; } .fchip.teal { --c: #0f766e; --bg: #ccfbf1; } .fchip.violet { --c: #7e22ce; --bg: #f3e8ff; }
    .fchip.staff { --c: #0f766e; --bg: #ccfbf1; padding-left: 4px; }
    .fchip.staff .ava { width: 16px !important; height: 16px !important; font-size: 8px; }
    .loginreq { margin: 30px auto; max-width: 460px; text-align: center; padding: 30px 24px; border: 1px solid #e2e8f0; border-radius: 16px;
      background: linear-gradient(180deg, #f8fafc, #fff); }
    .lr-icon { font-size: 42px; } .lr-title { font-size: 18px; font-weight: 800; margin-top: 8px; color: #0f172a; }
    .lr-sub { margin-top: 6px; color: #64748b; font-size: 13px; }
    .lr-btn { display: inline-block; margin-top: 16px; padding: 9px 22px; border-radius: 10px; color: #fff; font-weight: 800; text-decoration: none;
      background: linear-gradient(135deg, #2563eb, #7c3aed); }
    .bigtabs { display: flex; gap: 6px; margin: 6px 0 12px; border-bottom: 2px solid #e2e8f0; }
    .bigtab { font: inherit; font-size: 15px; font-weight: 800; color: #64748b; background: none; border: 0; border-bottom: 3px solid transparent;
      margin-bottom: -2px; padding: 8px 16px; cursor: pointer; border-radius: 8px 8px 0 0; }
    .bigtab b { font-size: 12px; background: #e2e8f0; color: #475569; border-radius: 999px; padding: 1px 8px; margin-left: 4px; }
    .bigtab:hover { color: #1e293b; background: #f8fafc; }
    .bigtab.on { color: #4338ca; border-bottom-color: #6366f1; }
    .bigtab.on b { background: #6366f1; color: #fff; }
    .bigtab.hot.has b { background: #ea580c; color: #fff; animation: dgpulse 1.6s ease-in-out infinite; }
    .bigtab.hot.on { color: #c2410c; border-bottom-color: #f97316; }
    .ctab { margin-top: 10px; border: 1px solid #e2e8f0; border-radius: 14px; overflow: hidden; }
    .ct-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 18px; color: #fff;
      background: linear-gradient(135deg, #4f46e5, #7c3aed); }
    .ct-title { font-size: 18px; font-weight: 800; } .ct-sub { font-size: 13px; opacity: .85; margin-top: 2px; }
    .ct-tools { display: flex; align-items: center; gap: 8px; }
    .ct-tools .search { background: rgba(255,255,255,.95); }
    .ct-btn { font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; border: 1px solid rgba(255,255,255,.6); background: transparent; color: #fff;
      border-radius: 10px; padding: 6px 12px; }
    .ct-btn small { font-weight: 600; opacity: .8; font-size: 11px; }
    .ct-btn b { background: rgba(255,255,255,.25); border-radius: 999px; padding: 0 7px; margin-left: 4px; }
    .ct-btn.on { background: #fbbf24; border-color: #fbbf24; color: #1f2937; }
    .ctab .fbar { margin: 8px 12px; }
    .ct-wrap { overflow: auto; }
    table.ct { width: 100%; border-collapse: collapse; font-size: 13px; }
    table.ct th { position: sticky; top: 0; background: #f8fafc; color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
      text-align: left; padding: 10px; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
    table.ct td { padding: 9px 10px; border-bottom: 1px solid #f1f5f9; white-space: nowrap; }
    table.ct tr:hover td { background: #f8faff; }
    table.ct .num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; }
    .ct-sum td { background: #eef2ff; font-weight: 800; color: #3730a3; }
    .ct-no { color: #94a3b8; width: 34px; }
    .ct-name a { color: #1d4ed8; font-weight: 800; text-decoration: none; text-transform: uppercase; }
    .ct-name a:hover { text-decoration: underline; }
    .ct-name .kh { margin-left: 6px; font-size: 10px; }
    .kh.none { background: #f1f5f9; color: #94a3b8; border-color: #e2e8f0; text-decoration: line-through; text-decoration-color: #94a3b8; }
    .ct-name { max-width: 360px; overflow: hidden; text-overflow: ellipsis; }
    .ct-chg { display: inline-block; margin-left: 6px; font-size: 11px; font-weight: 800; }
    .ct-chg.up { color: #16a34a; } .ct-chg.down { color: #dc2626; }
    td.ct-cur .ct-chg { display: block; margin-left: 0; }
    td.ct-cur.up { color: #16a34a; } td.ct-cur.down { color: #dc2626; } td.ct-cur.zero { color: #dc2626; }
    .ct-none { font-size: 11px; font-weight: 700; color: #dc2626; }
    .ct-dash { color: #cbd5e1; }
    .ct-grp { font-size: 11px; font-weight: 800; border-radius: 999px; padding: 1px 8px; background: #64748b; color: #fff; }
    .ct-grp.hot { background: #ef4444; }
    .ct-who { display: inline-flex; align-items: center; gap: 6px; color: #334155; vertical-align: middle; }
    .ct-total { color: #047857; }
    .ct-btn:disabled { opacity: .8; cursor: wait; }
    .ct-hide { margin-left: 8px; font: inherit; font-size: 11px; font-weight: 700; color: #94a3b8; background: none; border: 1px solid #e2e8f0;
      border-radius: 999px; padding: 0 8px; cursor: pointer; opacity: 0; transition: opacity .15s; }
    table.ct tr:hover .ct-hide { opacity: 1; }
    .ct-hide:hover { color: #dc2626; border-color: #fecaca; }
    .ct-bg { background: rgba(255,255,255,.2); border-radius: 999px; padding: 0 8px; }
    .wk-row { cursor: pointer; }
    /* Bố cục gọn cho vừa 1 màn hình (không phải cuộn) – chỉ tab Báo cáo tuần, không áp cho màn hình riêng NVKD */
    .wk:not(.sc) .ct-head { padding: 8px 16px; } .wk:not(.sc) .ct-title { font-size: 16px; }
    .wk:not(.sc) .board { margin: 6px 12px 8px; gap: 14px; }
    .wk:not(.sc) .bweek { gap: 6px; } .wk:not(.sc) .bw-title { font-size: 12px; }
    .wk:not(.sc) .pd { width: 112px; } .wk:not(.sc) .pd .ava { width: 34px !important; height: 34px !important; }
    .wk:not(.sc) .pd1 .ava { width: 44px !important; height: 44px !important; }
    .wk:not(.sc) .pd-crown { font-size: 18px; margin-bottom: -4px; }
    .wk:not(.sc) .pd-name { font-size: 12px; margin-top: 2px; } .wk:not(.sc) .pd-amt { font-size: 15px; } .wk:not(.sc) .pd1 .pd-amt { font-size: 18px; }
    .wk:not(.sc) .pd-sub { font-size: 10px; } .wk:not(.sc) .pd-step { margin-top: 3px; padding-top: 4px; font-size: 18px; }
    .wk:not(.sc) .pd1 .pd-step { height: 54px; } .wk:not(.sc) .pd2 .pd-step { height: 40px; } .wk:not(.sc) .pd3 .pd-step { height: 30px; }
    .wk:not(.sc) .lbs { gap: 4px; } .wk:not(.sc) .lb { padding: 4px 10px; font-size: 12px; } .wk:not(.sc) .lb-rank { font-size: 13px; }
    .wk:not(.sc) .mcard { padding: 10px 14px; } .wk:not(.sc) .mc-head { margin-bottom: 4px; gap: 8px; }
    .wk:not(.sc) .mc-trophy { font-size: 28px; } .wk:not(.sc) .mc-title { font-size: 16px; } .wk:not(.sc) .mc-sub { font-size: 11px; }
    .wk:not(.sc) .mc-row { padding: 4px 8px; margin-top: 4px; gap: 8px; } .wk:not(.sc) .mc-row .ava { width: 22px !important; height: 22px !important; }
    .wk:not(.sc) .mc-row.mc1 { padding: 6px 8px; } .wk:not(.sc) .mc-row.mc1 .ava { width: 30px !important; height: 30px !important; }
    .wk:not(.sc) .mc-row.mc1 .mc-amt { font-size: 17px; } .wk:not(.sc) .mc-row.mc1 .mc-rank { font-size: 20px; } .wk:not(.sc) .mc-rank { font-size: 14px; }
    .wk:not(.sc) .mc-amt { font-size: 13px; } .wk:not(.sc) .mc-amt small { display: inline; margin-left: 4px; }
    .wk:not(.sc) .wk-me, .wk:not(.sc) .cheer { margin: 8px 12px 0; padding: 8px 14px; } .wk:not(.sc) .wk-me-rank, .wk:not(.sc) .ch-ic { font-size: 26px; }
    .wk:not(.sc) table.ct td { padding: 4px 8px; } .wk:not(.sc) table.ct th { padding: 6px 8px; }
    .wk:not(.sc) .wk-row .ava { width: 20px !important; height: 20px !important; } .wk:not(.sc) .wk-bar { margin-top: 3px; height: 4px; }
    .wk:not(.sc) .wk-row.top1 b { font-size: 14px; } .wk:not(.sc) .wk-medal { font-size: 15px; } .wk:not(.sc) .wk-row.top1 .wk-medal { font-size: 20px; }
    .wk:not(.sc) .rp-cell { grid-template-columns: auto minmax(60px, 1fr); align-items: center; gap: 2px 8px; }
    .wk:not(.sc) .rp-cell .rps { grid-row: span 2; font-size: 11px; padding: 1px 8px; } .wk:not(.sc) .rp-pbar { height: 6px; } .wk:not(.sc) .rp-pn { font-size: 10px; }
    .wk:not(.sc) .ct-note { padding: 4px 12px; font-size: 11px; }
    /* Cột "Báo cáo tuần": nổi bật nhất bảng – nhãn trạng thái, thanh tiến độ chạy, chấm đỏ nhấp nháy khi đang làm */
    th.wk-rp-h { color: #ea580c; font-size: 12px; background: #fff7ed; }
    td.wk-rp { min-width: 190px; background: linear-gradient(90deg, #fff7ed, #fffbeb); border-left: 2px solid #fed7aa; border-right: 2px solid #fed7aa; }
    .wk-row.top1 td.wk-rp { background: linear-gradient(90deg, #fff7ed, #fef3c7); }
    .wk-rp-sum { font-size: 11px; font-weight: 800; color: #9a3412; white-space: nowrap; }
    .rp-cell { display: grid; gap: 4px; }
    .rps { display: inline-flex; align-items: center; gap: 6px; justify-self: start; font-size: 12px; font-weight: 900; border-radius: 999px; padding: 2px 10px; }
    .rps.done { color: #fff; background: linear-gradient(90deg, #16a34a, #22c55e, #16a34a); background-size: 200% 100%; animation: wkGrad 2.5s linear infinite;
      box-shadow: 0 2px 10px rgba(22,163,74,.35); }
    .rps.live { color: #fff; background: linear-gradient(90deg, #ef4444, #f97316); animation: ctaGlow 1.6s ease-in-out infinite; }
    .rps.live i { width: 8px; height: 8px; border-radius: 50%; background: #fff; animation: rpBlink 1s ease-in-out infinite; }
    @keyframes rpBlink { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .3; transform: scale(.6); } }
    .rps.mid { color: #92400e; background: #fef3c7; border: 1px solid #fcd34d; }
    /* Chưa báo cáo: nhãn đỏ, đồng hồ báo thức rung lắc + nhãn nhấp nháy để thúc giục */
    .rps.none { color: #fff; background: linear-gradient(90deg, #dc2626, #ef4444); border: 0; animation: rpUrge 1.2s ease-in-out infinite; }
    .rp-alarm { display: inline-block; font-size: 14px; animation: rpRing .6s ease-in-out infinite; transform-origin: 50% 10%; }
    @keyframes rpRing { 0%, 100% { transform: rotate(0); } 20% { transform: rotate(-18deg); } 40% { transform: rotate(16deg); } 60% { transform: rotate(-10deg); } 80% { transform: rotate(8deg); } }
    @keyframes rpUrge { 0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,.55); } 60% { box-shadow: 0 0 0 7px rgba(239,68,68,0); } }
    .rp-pbar { height: 8px; border-radius: 99px; background: #fde7cf; overflow: hidden; }
    .rp-pbar i { display: block; height: 100%; width: var(--w); border-radius: 99px; background: linear-gradient(90deg, #f59e0b, #f97316);
      background-size: 200% 100%; animation: wkGrad 2s linear infinite; }
    .wk.anim .rp-pbar i { animation: wkBar 1.1s cubic-bezier(.2,.8,.2,1) both, wkGrad 2s linear infinite; }
    .rp-pbar.done i { background: linear-gradient(90deg, #22c55e, #16a34a); }
    .rp-pbar.live i { background: linear-gradient(90deg, #f97316, #ef4444, #f97316); background-size: 200% 100%; }
    .rp-pn { font-size: 11px; font-weight: 700; color: #9a3412; }
    .pd, .lb { cursor: pointer; }
    .sc-head { gap: 16px; }
    .sc-back { font: inherit; font-size: 13px; font-weight: 800; color: #fff; background: rgba(255,255,255,.18); border: 1px solid rgba(255,255,255,.5);
      border-radius: 10px; padding: 7px 12px; cursor: pointer; }
    .sc-back:hover { background: rgba(255,255,255,.3); }
    .sc-head .ct-who { flex: 1; gap: 12px; color: #fff; } .sc-head .ct-who .ava { border: 2px solid #fff; }
    .sc-head .ct-title { color: #fff; } .sc-head .ct-sub { color: rgba(255,255,255,.9); }
    .rp-start { font: inherit; font-weight: 800; font-size: 13px; color: #fff; border: 0; border-radius: 10px; padding: 8px 14px; cursor: pointer;
      background: linear-gradient(135deg, #f59e0b, #ea580c); box-shadow: 0 4px 14px rgba(234,88,12,.35); }
    .rp-start:hover { filter: brightness(1.08); } .rp-start.big { font-size: 15px; padding: 10px 20px; }
    .rp-startrow { margin: 12px; }
    .rp-prog { height: 6px; background: #e0e7ff; } .rp-prog i { display: block; height: 100%; background: linear-gradient(90deg, #f59e0b, #22c55e); transition: width .4s; }
    .rp-card { margin: 14px 12px; padding: 18px 20px; border: 1px solid #e2e8f0; border-radius: 16px; background: #fff; }
    .rp-card.anim { animation: wkIn .35s ease both; }
    .rp-step { font-size: 12px; font-weight: 800; color: #6366f1; text-transform: uppercase; letter-spacing: .06em; }
    .rp-name { font-size: 22px; font-weight: 900; margin-top: 2px; display: flex; align-items: center; gap: 10px; }
    .rp-name .sc-link { font-size: 22px; }
    .rp-meta { color: #475569; margin-top: 4px; }
    .rp-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 18px; margin-top: 14px; }
    .rp-sec { font-weight: 800; margin: 12px 0 6px; color: #334155; }
    .rp-spark { display: flex; align-items: flex-end; gap: 8px; height: 110px; }
    .rp-mcol { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; }
    .rp-mbar { width: 70%; border-radius: 6px 6px 2px 2px; background: linear-gradient(180deg, #818cf8, #4f46e5); }
    .rp-mcol:last-child .rp-mbar { background: linear-gradient(180deg, #34d399, #059669); }
    .rp-mv { font-size: 10px; font-weight: 700; color: #047857; margin-top: 3px; white-space: nowrap; } .rp-ml { font-size: 10px; color: #94a3b8; }
    .rp-q { padding: 6px 0; border-bottom: 1px dashed #e2e8f0; font-size: 13px; } .rp-q a { color: #1d4ed8; text-decoration: none; }
    .rp-qa { float: right; font-weight: 800; color: #047857; } .rp-ql { font-size: 12px; color: #475569; margin-top: 2px; }
    /* Nút "Bắt đầu làm báo cáo": nút nổi bật nhất – to, viền trắng, nền cam chuyển động, ánh sáng quét, quầng sáng nhịp */
    .rp-start.cta { position: relative; overflow: hidden; display: inline-flex; flex-direction: column; align-items: flex-start; gap: 2px;
      font-size: 18px; font-weight: 900; padding: 12px 26px 10px; border-radius: 16px; border: 3px solid #fff; letter-spacing: .01em;
      background: linear-gradient(120deg, #f97316, #f59e0b, #ef4444, #f97316); background-size: 300% 100%;
      animation: ctaGrad 4s ease infinite, ctaGlow 1.8s ease-in-out infinite; text-shadow: 0 1px 2px rgba(0,0,0,.25); }
    .rp-start.cta::after { content: ''; position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(110deg, transparent 30%, rgba(255,255,255,.55) 50%, transparent 70%); background-size: 250% 100%; animation: wkShine 2.4s ease-in-out infinite; }
    .rp-start.cta:hover { transform: translateY(-2px) scale(1.04); filter: brightness(1.08); }
    .cta-sub { font-size: 11px; font-weight: 700; opacity: .95; text-shadow: none; }
    @keyframes ctaGrad { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
    @keyframes ctaGlow { 0%, 100% { box-shadow: 0 6px 20px rgba(234,88,12,.45), 0 0 0 0 rgba(251,146,60,.6); } 50% { box-shadow: 0 8px 28px rgba(234,88,12,.6), 0 0 0 10px rgba(251,146,60,0); } }
    @media (prefers-reduced-motion: reduce) { .rp-start.cta, .rp-start.cta::after { animation: none; } }
    .rp-start.locked { background: #cbd5e1; box-shadow: none; color: #475569; }
    .rp-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 12px 0; max-height: 120px; overflow: auto; }
    .rp-chip { font: inherit; font-size: 12px; font-weight: 700; border-radius: 999px; padding: 3px 10px; cursor: pointer; border: 1.5px solid; max-width: 220px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rp-chip.ok { background: #f1f5f9; color: #94a3b8; border-color: #cbd5e1; text-decoration: line-through; text-decoration-color: rgba(148,163,184,.6); }
    .rp-chip.no { background: #fee2e2; color: #991b1b; border-color: #f87171; }
    .rp-chip.cur { box-shadow: 0 0 0 3px rgba(99,102,241,.45); transform: scale(1.05); }
    .rp-st { border-radius: 999px; padding: 1px 8px; font-size: 11px; } .rp-st.won { background: #dcfce7; color: #166534; } .rp-st.open { background: #fef3c7; color: #92400e; }
    .rp-morebtn { font: inherit; font-size: 12px; font-weight: 800; color: #4f46e5; background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 999px;
      padding: 3px 12px; margin: 6px 0 2px; cursor: pointer; }
    .rp-morebtn:hover { background: #e0e7ff; }
    .rp-q.won b { color: #166534; } .rp-more { font-size: 12px; padding: 4px 0; }
    .rp-text { width: 100%; border: 1.5px solid #c7d2fe; border-radius: 12px; padding: 10px 12px; font: inherit; font-size: 14px; line-height: 1.5; resize: vertical; }
    .rp-text:focus { outline: 3px solid rgba(99,102,241,.2); border-color: #6366f1; }
    .rp-nav { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; }
    .rp-done { margin: 16px 12px; padding: 18px; text-align: center; border-radius: 16px; background: linear-gradient(135deg, #f0fdf4, #dcfce7); border: 1.5px solid #86efac; }
    .rp-done-t { font-size: 20px; font-weight: 900; color: #166534; } .rp-done-b { margin-top: 10px; display: flex; gap: 10px; justify-content: center; align-items: center; }
    .rp-cmt { white-space: pre-wrap; max-width: 520px; }
    .cheer { position: relative; overflow: hidden; display: flex; align-items: center; gap: 14px; margin: 14px 12px 0; padding: 14px 18px;
      border-radius: 16px; font-size: 13px; color: #334155; }
    .cheer b { font-size: 16px; color: #0f172a; } .cheer div div { margin-top: 3px; } .cheer div div b { font-size: 13px; }
    .ch-ic { font-size: 38px; flex: none; }
    .cheer.top1 { background: linear-gradient(135deg, #fffbeb, #fde68a); border: 2px solid #f59e0b; box-shadow: 0 8px 24px rgba(245,158,11,.3); }
    .cheer.top1 .ch-ic { animation: mcTrophy 2s ease-in-out infinite; }
    .cheer.top { background: linear-gradient(135deg, #eef2ff, #e0e7ff); border: 1.5px solid #a5b4fc; }
    .cheer.top .ch-ic { animation: wkMedal 1.6s ease-in-out infinite; }
    .cheer.mid { background: linear-gradient(135deg, #f0fdf4, #dcfce7); border: 1.5px solid #86efac; }
    .cheer.mid .ch-ic { animation: wkCheer 1.2s ease-in-out infinite; display: inline-block; }
    .cheer.low { background: linear-gradient(135deg, #fff7ed, #ffedd5); border: 1.5px solid #fdba74; }
    .cheer.low .ch-ic { display: inline-block; animation: wkCheer 1s ease-in-out infinite; }
    .ch-conf { position: absolute; inset: 0; pointer-events: none; }
    .ch-conf i { position: absolute; top: -20px; font-style: normal; font-size: 14px; animation: chFall 3.2s linear infinite; opacity: .85; }
    @keyframes chFall { 0% { transform: translateY(0) rotate(0); opacity: 0; } 10% { opacity: .9; } 100% { transform: translateY(120px) rotate(300deg); opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .ch-conf { display: none; } }
    .sc-kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin: 14px 12px 0; }
    .sc-kpi { display: flex; gap: 10px; align-items: center; padding: 12px 14px; border-radius: 14px; border: 1px solid #e2e8f0; background: #fff; }
    .wk.anim .sc-kpi { animation: wkIn .5s ease both; }
    .sc-ki { font-size: 26px; } .sc-kl { font-size: 11px; color: #64748b; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    .sc-kv { font-size: 22px; font-weight: 900; color: #0f172a; } .sc-ks { font-size: 11px; color: #94a3b8; }
    .sc-kpi.warn { background: #fffbeb; border-color: #fde68a; } .sc-kpi.down { background: #fef2f2; border-color: #fecaca; } .sc-kpi.up { background: #f0fdf4; border-color: #bbf7d0; }
    .sc-kpi.down .sc-kv { color: #dc2626; } .sc-kpi.up .sc-kv { color: #16a34a; }
    .sc-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0 12px 10px; align-items: start; }
    .sc-box { border: 1px solid #e2e8f0; border-radius: 14px; padding: 10px 12px; background: #fff; }
    .sc-box.down { border-color: #fecaca; } .sc-box.up { border-color: #bbf7d0; }
    .sc-bh { font-weight: 800; margin-bottom: 6px; } .sc-bh b { font-size: 12px; background: #f59e0b; color: #fff; border-radius: 999px; padding: 0 8px; }
    /* 3 cột thẳng hàng: tên khách | % / số BG (cố định) | số tiền (cố định, căn phải) */
    .sc-li { display: grid; grid-template-columns: minmax(0, 1fr) 76px 96px; gap: 10px; align-items: center; padding: 7px 2px; border-bottom: 1px dashed #eef2f7; font-size: 13px; }
    .sc-li > :nth-child(2) { justify-self: end; } .sc-li > :nth-child(3) { justify-self: end; }
    .sc-lh { font-size: 10px; font-weight: 800; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; padding-top: 0; border-bottom: 1px solid #e2e8f0; }
    .sc-pct { font-weight: 800; font-size: 12px; border-radius: 999px; padding: 1px 8px; font-variant-numeric: tabular-nums; }
    .sc-pct.down { color: #dc2626; background: #fee2e2; } .sc-pct.up { color: #16a34a; background: #dcfce7; }
    .sc-li:last-child { border-bottom: 0; }
    .sc-link { color: #1d4ed8; font-weight: 700; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sc-link:hover { text-decoration: underline; }
    .sc-n { font-size: 11px; font-weight: 800; color: #b45309; background: #fef3c7; border-radius: 999px; padding: 0 7px; }
    .sc-amt { font-weight: 800; color: #047857; font-variant-numeric: tabular-nums; text-align: right; } .sc-amt small { font-weight: 600; color: #94a3b8; }
    .sc-empty { padding: 6px 0; font-size: 12px; }
    .sc-medal { font-size: 34px; font-weight: 900; animation: wkMedal 1.8s ease-in-out infinite; }
    .wk.anim.sc .ct-head { animation: wkIn .4s ease both; }
    .sc .ov { margin-top: 14px; } .sc .ov-barwrap { width: 46%; }
    .sc-wk { font-size: 11px; font-weight: 800; color: #4f46e5; background: #eef2ff; border-radius: 999px; padding: 1px 8px; }
    .pd:hover .pd-step { filter: brightness(1.08); } .lb:hover { border-color: #a5b4fc; }
    .ov-hint { margin: 0 12px 10px; padding: 10px 14px; border: 1px dashed #c7d2fe; border-radius: 12px; color: #4f46e5; font-size: 13px; background: #f8faff; }
    .ov { margin: 0 12px 14px; padding: 14px 16px; border: 1px solid #c7d2fe; border-radius: 14px; background: linear-gradient(180deg, #f8faff, #fff); }
    .ov-head { display: flex; flex-wrap: wrap; align-items: center; gap: 18px; }
    .ov-head b { font-size: 15px; }
    .ov-kpi { font-size: 12px; color: #64748b; } .ov-kpi b { display: block; font-size: 15px; color: #0f172a; }
    .ov-chart { position: relative; display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 12px; }
    .ov-line { position: absolute; left: 0; right: 0; top: 34px; width: 100%; height: 160px; pointer-events: none; overflow: visible; }
    .ov-line polyline { fill: none; stroke: #f59e0b; stroke-width: 2.5; stroke-dasharray: 6 4; vector-effect: non-scaling-stroke; }
    .ov-col { display: flex; flex-direction: column; align-items: center; }
    .wk.anim .ov-col { animation: wkIn .5s ease both; }
    .ov-val { font-weight: 900; font-size: 15px; color: #047857; height: 34px; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; }
    .ov-val .ct-chg { margin: 0; }
    .ov-barwrap { display: flex; align-items: flex-end; width: 56%; }
    .ov-bar { position: relative; width: 100%; height: var(--h); border-radius: 10px 10px 4px 4px; background: linear-gradient(180deg, #818cf8, #4f46e5);
      transform-origin: bottom; }
    .wk.anim .ov-bar { animation: ovUp .9s cubic-bezier(.2,.9,.3,1.2) both; }
    @keyframes ovUp { from { transform: scaleY(0); } to { transform: scaleY(1); } }
    .ov-col.now .ov-bar { background: linear-gradient(180deg, #34d399, #059669); }
    .ov-col.best .ov-bar { background: linear-gradient(180deg, #fcd34d, #f59e0b); box-shadow: 0 6px 16px rgba(245,158,11,.4); }
    .ov-star { position: absolute; top: -22px; left: 50%; transform: translateX(-50%); font-size: 18px; animation: wkMedal 1.6s ease-in-out infinite; }
    .ov-wk { margin-top: 8px; font-weight: 800; font-size: 13px; color: #334155; } .ov-col.now .ov-wk { color: #059669; }
    .ov-date { font-size: 11px; color: #94a3b8; }
    .board { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; align-items: start; margin: 4px 12px 14px; }
    .bweek { display: flex; flex-direction: column; gap: 12px; }
    .bw-title { font-weight: 900; color: #4338ca; font-size: 14px; }
    /* Bảng vàng tháng: nền sáng màu ngà, viền & chữ vàng kim, cúp lấp lánh */
    .mcard { position: relative; overflow: hidden; border-radius: 18px; padding: 16px 18px; color: #78350f;
      background: linear-gradient(135deg, #fffdf5 0%, #fef3c7 55%, #fde68a 100%); border: 1.5px solid #f59e0b;
      box-shadow: 0 10px 28px rgba(245,158,11,.22), inset 0 0 0 4px rgba(255,255,255,.6); }
    .mcard::before { content: ''; position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(115deg, transparent 35%, rgba(255,255,255,.7) 50%, transparent 65%); background-size: 250% 100%; animation: wkShine 4s ease-in-out infinite; }
    .mcard::after { content: ''; position: absolute; right: -40px; top: -40px; width: 160px; height: 160px; border-radius: 50%; pointer-events: none;
      background: radial-gradient(circle, rgba(251,191,36,.35), transparent 70%); }
    .mc-head { position: relative; display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .mc-trophy { font-size: 40px; filter: drop-shadow(0 4px 10px rgba(217,119,6,.45)); animation: mcTrophy 2.4s ease-in-out infinite; }
    @keyframes mcTrophy { 0%, 100% { transform: rotate(-6deg) scale(1); } 50% { transform: rotate(6deg) scale(1.12); } }
    .mc-title { font-size: 20px; font-weight: 900; letter-spacing: .02em;
      background: linear-gradient(90deg, #92400e, #d97706, #b45309, #d97706); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
      animation: wkGrad 3s linear infinite; }
    .mc-sub { font-size: 12px; color: #a16207; }
    .mc-row { position: relative; display: grid; grid-template-columns: 34px auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 10px;
      border-radius: 12px; margin-top: 6px; cursor: pointer; background: rgba(255,255,255,.75); border: 1px solid #fde68a; }
    .wk.anim .mc-row { animation: wkIn .55s ease both; }
    .mc-row:hover { background: #fff; border-color: #f59e0b; }
    .mc-rank { font-size: 18px; font-weight: 900; text-align: center; color: #b45309; }
    .mc-name { font-weight: 800; color: #451a03; overflow: hidden; }
    .mc-bar { display: block; height: 5px; margin-top: 4px; border-radius: 99px; background: #fef3c7; overflow: hidden; }
    .mc-bar i { display: block; height: 100%; width: var(--w); border-radius: 99px; background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .mc-amt { text-align: right; font-weight: 900; color: #b45309; font-variant-numeric: tabular-nums; }
    .mc-amt small { display: block; font-size: 10px; font-weight: 600; color: #a16207; }
    .mc-row.mc1 { padding: 12px; background: linear-gradient(90deg, #fff, #fffbeb); border: 2px solid #f59e0b; box-shadow: 0 6px 18px rgba(245,158,11,.3); }
    .mc-row.mc1 .mc-rank { font-size: 26px; animation: wkCrown 1.6s ease-in-out infinite; }
    .mc-row.mc1 .mc-name { font-size: 16px; } .mc-row.mc1 .mc-amt { font-size: 21px; color: #92400e; }
    .mc-row.mc1 .ava { border: 2px solid #f59e0b; box-shadow: 0 0 0 3px rgba(251,191,36,.35), 0 4px 12px rgba(245,158,11,.5); }
    .mc-champ { margin-left: 8px; font-size: 10px; font-weight: 900; color: #fff; border-radius: 999px; padding: 1px 8px; vertical-align: 2px;
      background: linear-gradient(90deg, #d97706, #f59e0b, #d97706); background-size: 200% 100%; animation: wkGrad 2s linear infinite; }
    .mc-row.mc2 { border-color: #cbd5e1; } .mc-row.mc3 { border-color: #fdba74; }
    .mc-row.me { outline: 2px solid #818cf8; }
    .podium { display: flex; align-items: flex-end; justify-content: center; gap: 10px; }
    .pd { position: relative; width: 130px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 2px; }
    .wk.anim .pd { animation: pdRise .8s cubic-bezier(.2,1.3,.4,1) both; }
    @keyframes pdRise { from { opacity: 0; transform: translateY(40px) scale(.9); } to { opacity: 1; transform: none; } }
    .pd .ava { box-shadow: 0 4px 12px rgba(15,23,42,.18); border: 3px solid #fff; }
    .pd1 .ava { border-color: #fbbf24; box-shadow: 0 0 0 4px rgba(251,191,36,.35), 0 6px 18px rgba(245,158,11,.45); }
    .pd-crown { font-size: 26px; animation: wkCrown 1.4s ease-in-out infinite; margin-bottom: -6px; }
    .pd-name { font-weight: 800; font-size: 14px; color: #0f172a; margin-top: 4px; max-width: 128px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pd-amt { font-weight: 900; font-size: 18px; color: #047857; font-variant-numeric: tabular-nums; }
    .pd1 .pd-amt { font-size: 22px; color: #b45309; }
    .pd-sub { font-size: 11px; color: #64748b; }
    .pd-step { width: 100%; margin-top: 6px; border-radius: 12px 12px 4px 4px; display: flex; align-items: flex-start; justify-content: center;
      padding-top: 8px; font-size: 26px; color: #fff; }
    .pd1 .pd-step { height: 92px; background: linear-gradient(180deg, #fbbf24, #f59e0b); box-shadow: 0 8px 20px rgba(245,158,11,.35); }
    .pd2 .pd-step { height: 66px; background: linear-gradient(180deg, #e2e8f0, #94a3b8); }
    .pd3 .pd-step { height: 48px; background: linear-gradient(180deg, #fed7aa, #c2410c); }
    .pd1 .pd-step span { animation: wkMedal 1.6s ease-in-out infinite; display: inline-block; }
    .pd.me .pd-name { color: #4f46e5; }
    .lbs { display: grid; gap: 6px; }
    .lb { display: grid; grid-template-columns: 40px 24px minmax(0, 1fr) auto auto; gap: 8px; align-items: center; padding: 8px 12px;
      border: 1px solid #e2e8f0; border-radius: 12px; background: #fff; }
    .wk.anim .lb { animation: wkIn .5s ease both; }
    .lb.me { border-color: #a5b4fc; background: #eef2ff; }
    .lb.last { border-color: #fdba74; background: #fff7ed; }
    .lb-rank { font-weight: 900; color: #94a3b8; font-size: 16px; }
    .lb-name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lb-amt { font-weight: 800; color: #047857; font-variant-numeric: tabular-nums; }
    .lb-gap { font-size: 11px; color: #94a3b8; white-space: nowrap; }
    .wk.anim .wk-row { animation: wkIn .5s cubic-bezier(.2,.8,.2,1) both; }
    @keyframes wkIn { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
    .wk-rank { font-size: 18px; font-weight: 900; color: #94a3b8; width: 46px; text-align: center; }
    .wk-medal { display: inline-block; }
    .wk-row.top1 .wk-medal { font-size: 26px; animation: wkMedal 1.6s ease-in-out infinite; filter: drop-shadow(0 2px 6px rgba(245,158,11,.6)); }
    /* Người số 1: vương miện nhún nhảy, chữ to, dải sáng vàng quét ngang dòng, viền vàng phát sáng */
    .wk-row.top1 td { position: relative; }
    .wk-row.top1 b { font-size: 16px; color: #92400e; }
    .wk-row.top1 { box-shadow: inset 4px 0 0 #f59e0b; }
    .wk-row.top1 td:nth-child(2) { background: linear-gradient(110deg, #fffbeb 30%, #fef3c7 50%, #fffbeb 70%); background-size: 250% 100%;
      animation: wkShine 2.8s ease-in-out infinite; }
    @keyframes wkShine { 0% { background-position: 150% 0; } 60%, 100% { background-position: -100% 0; } }
    .wk-crown { display: inline-block; margin-right: -4px; font-size: 18px; transform-origin: 50% 100%; animation: wkCrown 1.4s ease-in-out infinite; }
    @keyframes wkCrown { 0%, 100% { transform: translateY(0) rotate(-12deg); } 50% { transform: translateY(-5px) rotate(8deg); } }
    .wk-champ { margin-left: 8px; font-size: 11px; font-weight: 800; color: #fff; border-radius: 999px; padding: 2px 9px;
      background: linear-gradient(90deg, #f59e0b, #f97316, #f59e0b); background-size: 200% 100%; animation: wkGrad 2s linear infinite; }
    @keyframes wkGrad { to { background-position: 200% 0; } }
    .wk.anim .wk-row.top1 { animation: wkWin .9s cubic-bezier(.2,1.4,.4,1) both; }
    @keyframes wkWin { 0% { opacity: 0; transform: scale(.85) translateY(20px); } 60% { opacity: 1; transform: scale(1.03); } 100% { transform: none; } }
    /* Người cuối bảng: nhãn "Cố lên" nảy nhẹ, thanh doanh số nhấp nháy cam để động viên */
    .wk-cheer { margin-left: 8px; font-size: 11px; font-weight: 800; color: #c2410c; background: #ffedd5; border: 1px solid #fdba74;
      border-radius: 999px; padding: 1px 9px; display: inline-block; animation: wkCheer 1.2s ease-in-out infinite; }
    @keyframes wkCheer { 0%, 100% { transform: translateY(0) scale(1); } 30% { transform: translateY(-3px) scale(1.08); } 60% { transform: translateY(0) scale(.97); } }
    .wk-row.last .wk-bar { background: #fff7ed; }
    .wk-row.last .wk-bar span { background: linear-gradient(90deg, #fb923c, #f97316); animation: wkPush 1.4s ease-in-out infinite; }
    .wk.anim .wk-row.last .wk-bar span { animation: wkBar 1s cubic-bezier(.2,.8,.2,1) forwards, wkPush 1.4s ease-in-out 1s infinite; }
    @keyframes wkPush { 0%, 100% { filter: brightness(1); box-shadow: none; } 50% { filter: brightness(1.2); box-shadow: 0 0 8px rgba(249,115,22,.8); } }
    @keyframes wkMedal { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.25) rotate(-6deg); } }
    .wk-row.top1 td { background: linear-gradient(90deg, #fffbeb, #fff 60%); }
    .wk-bar { height: 5px; margin-top: 5px; border-radius: 99px; background: #eef2ff; overflow: hidden; max-width: 260px; }
    .wk-bar span { display: block; height: 100%; width: var(--w); border-radius: 99px; background: linear-gradient(90deg, #6366f1, #22c55e); }
    .wk.anim .wk-bar span { width: 0; animation: wkBar 1s cubic-bezier(.2,.8,.2,1) forwards; }
    .wk-row.top1 .wk-bar span { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    @keyframes wkBar { to { width: var(--w); } }
    .wk-row.me td { background: #eef2ff; }
    .wk-row.me { box-shadow: inset 4px 0 0 #6366f1; }
    .wk-you { margin-left: 6px; font-size: 10px; font-weight: 800; color: #fff; background: #6366f1; border-radius: 999px; padding: 1px 7px;
      animation: dgpulse 1.6s ease-in-out infinite; }
    .wk-me { display: flex; align-items: center; gap: 14px; margin: 12px; padding: 14px 18px; border-radius: 14px; color: #1e1b4b;
      background: linear-gradient(135deg, #eef2ff, #fdf4ff); border: 1px solid #c7d2fe; }
    .wk.anim .wk-me { animation: wkIn .6s ease both; }
    .wk-me.none { background: #f8fafc; border-color: #e2e8f0; }
    .wk-me-rank { font-size: 34px; font-weight: 900; min-width: 54px; text-align: center; animation: wkMedal 2s ease-in-out infinite; }
    .wk-me-t { font-size: 16px; font-weight: 700; } .wk-me-t b { color: #4f46e5; font-size: 18px; }
    .wk-me-s { font-size: 13px; color: #475569; margin-top: 2px; }
    @media (prefers-reduced-motion: reduce) { .wk *, .wk { animation: none !important; } .wk-bar span { width: var(--w); } }
    .wk-row.open td { background: #eef2ff; }
    th.wk-today, td.wk-today { background: #fffbeb; }
    .wk-total { color: #047857; }
    .wk-detail > td { background: #f8fafc; padding: 6px 10px 12px; }
    table.wk-orders { width: 100%; border-collapse: collapse; font-size: 12px; }
    table.wk-orders td { padding: 4px 8px; border-bottom: 1px dashed #e2e8f0; }
    table.wk-orders a { color: #1d4ed8; font-weight: 700; text-decoration: none; }
    .ct-note { padding: 8px 14px; font-size: 12px; }
    .fclear { align-self: center; margin-left: auto; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; border: 0; background: #0f172a;
      color: #fff; border-radius: 999px; padding: 4px 12px; display: inline-flex; align-items: center; gap: 5px;
      animation: dgClearPulse 1.8s ease-out infinite; transition: background .2s, transform .15s; }
    .fclear .fx { display: inline-block; transition: transform .25s ease; }
    .fclear:hover { background: #dc2626; transform: scale(1.06); animation-play-state: paused; }
    .fclear:hover .fx { transform: rotate(90deg); }
    .fclear:active { transform: scale(.94); }
    /* Vòng sáng lan ra theo nhịp – nhắc đang lọc, bấm để xem lại toàn bộ */
    @keyframes dgClearPulse { 0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, .55); } 70% { box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); } 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); } }
    @media (prefers-reduced-motion: reduce) { .fclear { animation: none; } }
    button.chipbtn.on { outline: 2px solid currentColor; outline-offset: 1px; }
    .nodep { margin-left: 6px; display: inline-block; background: #fdf2f8; color: #be185d; border: 1px solid #fbcfe8; border-radius: 999px;
      padding: 1px 9px; font-size: 12px; font-weight: 800; vertical-align: 1px; }
    .orders { margin-top: 8px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
    .orders summary { cursor: pointer; }
    .orders table { margin-top: 6px; font-size: 12px; }
    .hip { margin-left: 6px; display: inline-block; background: #fff7ed; color: #c2410c; border: 1px solid #fed7aa; border-radius: 999px;
      padding: 1px 9px; font-size: 12px; font-weight: 800; vertical-align: 1px; }
    .mgn { margin-left: 6px; display: inline-block; background: #f5f3ff; color: #6d28d9; border: 1px solid #ddd6fe; border-radius: 999px;
      padding: 1px 9px; font-size: 12px; font-weight: 800; vertical-align: 1px; }
    .mgn.low { background: #fef2f2; color: #b91c1c; border-color: #fecaca; }
    .crd { margin-left: 6px; display: inline-block; background: #ecfeff; color: #0e7490; border: 1px solid #a5f3fc; border-radius: 999px;
      padding: 1px 9px; font-size: 12px; font-weight: 800; vertical-align: 1px; }
    .knd { margin-left: 6px; display: inline-block; border-radius: 999px; padding: 1px 9px; font-size: 12px; font-weight: 800; vertical-align: 1px; border: 1px solid; }
    .knd.flexo { background: #eff6ff; color: #1e40af; border-color: #bfdbfe; }
    .knd.offset { background: #faf5ff; color: #7e22ce; border-color: #e9d5ff; }
    .knd.both { background: linear-gradient(90deg, #eff6ff, #faf5ff); color: #5b21b6; border-color: #c4b5fd; }
    .prm { margin-left: 6px; display: inline-block; background: #fefce8; color: #a16207; border: 1px solid #fde68a; border-radius: 999px;
      padding: 1px 9px; font-size: 12px; font-weight: 800; vertical-align: 1px; }
    .fea { margin-top: 4px; font-size: 13px; font-weight: 800; color: #1d4ed8; }
    .fea span { display: block; font-size: 11px; font-weight: 600; color: #64748b; white-space: normal; max-width: 220px; margin-left: auto; }
    .smp { margin-left: 6px; display: inline-block; background: #fdf4ff; color: #a21caf; border: 1px solid #f5d0fe; border-radius: 999px;
      padding: 1px 9px; font-size: 12px; font-weight: 800; vertical-align: 1px; }
    .smp.ok { background: #f0fdf4; color: #15803d; border-color: #bbf7d0; }
    .bok { margin-left: 6px; display: inline-block; background: #dcfce7; color: #166534; border: 1px solid #86efac; border-radius: 999px; padding: 0 9px;
      font-size: 12px; font-weight: 800; vertical-align: 1px; }
    .fchip.green { --c: #16a34a; --bg: #dcfce7; }
    .byr { margin-left: 6px; display: inline-block; background: #fdf4ff; color: #a21caf; border: 1px solid #f0abfc; border-radius: 999px; padding: 0 9px; font-size: 12px; font-weight: 800; vertical-align: 1px; white-space: nowrap; }
    .it-main .byr { margin-left: 0; margin-right: 4px; font-size: 11px; padding: 0 7px; }
    .bok.reo { background: #e0f2fe; color: #075985; border-color: #7dd3fc; }
    .it-main .bok { margin-left: 0; margin-right: 4px; font-size: 11px; padding: 0 7px; }
    .nosheet { margin-left: 6px; display: inline-block; background: #fef2f2; color: #b91c1c; border: 1px solid #fca5a5; border-radius: 999px; padding: 0 9px;
      font-size: 12px; font-weight: 800; vertical-align: 1px; white-space: nowrap; }
    .it-main .nosheet { margin-left: 0; margin-right: 4px; font-size: 11px; padding: 0 7px; }
    .ctr { margin-left: 6px; display: inline-block; background: #f0f9ff; color: #0369a1; border: 1px solid #bae6fd; border-radius: 999px;
      padding: 1px 9px; font-size: 12px; font-weight: 800; vertical-align: 1px; }
    .mgnbox { margin-top: 8px; background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 8px; padding: 8px 10px; font-size: 14px; }
    .mgnbox summary { cursor: pointer; }
    .mgnbox .link { color: #1d4ed8; font-size: 12px; text-decoration: underline; margin-left: 6px; }
    .mgnbox .expl { margin-top: 6px; font-size: 13px; color: #334155; }
    .mgnbox table { margin-top: 6px; font-size: 12px; }
    .side { position: fixed; right: 16px; top: 130px; z-index: 2147483645; width: 440px; max-height: calc(100vh - 160px); overflow: auto;
      background: #fff; border: 1px solid #e9d5ff; border-radius: 14px; box-shadow: 0 10px 30px rgba(15,23,42,.18); padding: 12px 14px;
      font-size: 13px; color: #1f2328; }
    .side[hidden] { display: none; }
    .side { transition: width .2s ease; }
    .side:has(details[open]) { width: min(600px, calc(100vw - 32px)); }
    .ho { margin: 4px 0 10px; }
    .ho-n { background: #0ea5e9; color: #fff; border-radius: 999px; padding: 0 8px; font-size: 12px; font-weight: 800; }
    .ho-card { border: 1px solid #bae6fd; background: linear-gradient(180deg, #f0f9ff, #fff); border-radius: 12px; padding: 10px 12px; margin-top: 8px; }
    .ho-card.here { border-color: #0284c7; box-shadow: 0 0 0 3px rgba(14,165,233,.15); }
    .ho-cust { font-weight: 800; font-size: 13px; color: #0f172a; line-height: 1.3; }
    .ho-flow { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
    .ho-from { background: #f1f5f9; color: #64748b; border-radius: 999px; padding: 1px 10px; font-size: 12px; text-decoration: line-through; text-decoration-color: #cbd5e1; }
    .ho-arrow { color: #0284c7; font-weight: 900; }
    .ho-to { background: #e0f2fe; color: #0369a1; border-radius: 999px; padding: 1px 10px; font-size: 12px; font-weight: 800; }
    .ho-meta { margin-top: 4px; font-size: 11px; color: #64748b; }
    .ho-text { width: 100%; margin-top: 8px; border: 1px solid #bae6fd; border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 13px;
      line-height: 1.45; background: #fff; resize: vertical; color: inherit; }
    .ho-text:focus { outline: 2px solid #7dd3fc; border-color: #0ea5e9; }
    .ho-btns { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
    .ho-send, .ho-open { flex: 1; text-align: center; border: 0; border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 13px; font-weight: 700;
      cursor: pointer; color: #fff; background: linear-gradient(135deg, #0284c7, #2563eb); text-decoration: none; }
    .ho-open { background: #fff; color: #0369a1; border: 1px solid #7dd3fc; }
    .ho-send:disabled { opacity: .7; cursor: wait; }
    .ho-skip { border: 1px solid #e2e8f0; background: #fff; color: #64748b; border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 12px; cursor: pointer; }
    .ho-skip:hover { color: #b91c1c; border-color: #fecaca; }
    .side-sec { font-size: 10px; font-weight: 800; color: #94a3b8; text-transform: uppercase; letter-spacing: .08em; margin: 6px 0 2px; }
    /* 🔥 Có thể chốt liền (AI) */
    .hotbox { margin: 12px 0 6px; border: 1px solid #fed7aa; background: linear-gradient(180deg, #fff7ed, #fff); border-radius: 12px; padding: 10px 12px; }
    .hot-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .hot-head h3 { margin: 0; }
    .hot-btn { white-space: nowrap; }
    .hot-diff { margin-left: 8px; font-size: 14px; font-weight: 800; color: #6d28d9; background: #ede9fe; border: 1px solid #ddd6fe; border-radius: 999px; padding: 2px 10px; vertical-align: 1px; }
    .hot-dv { font-size: 12px; font-weight: 800; color: #6d28d9; white-space: nowrap; } .hot-dv.neg { color: #b91c1c; }
    .zl-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 6px 0 2px; font-size: 12px; }
    .zl-bar > b { color: #0068ff; }
    .zl-item { display: inline-flex; gap: 3px; }
    .zl-btn { border: 1px solid #93c5fd; background: #eff6ff; color: #1d4ed8; border-radius: 999px; padding: 2px 10px; font-weight: 700; font-size: 12px; cursor: pointer; }
    .zl-btn i { font-style: normal; background: #1d4ed8; color: #fff; border-radius: 999px; padding: 0 6px; margin-left: 3px; font-size: 10px; }
    .zl-btn:hover { background: #0068ff; color: #fff; }
    .zl-btn.sent { background: #dcfce7; border-color: #86efac; color: #15803d; } .zl-btn.sent i { background: #15803d; }
    .zl-btn.err { background: #fee2e2; border-color: #fca5a5; color: #b91c1c; } .zl-btn.err i { background: #b91c1c; }
    .zl-btn.run { background: #fef9c3; border-color: #fde047; color: #a16207; }
    .zl-btn.all { background: #0068ff; border-color: #0068ff; color: #fff; }
    .zl-draft { border: 1px solid #fcd34d; background: #fffbeb; color: #92400e; border-radius: 999px; padding: 2px 10px; font-weight: 700; font-size: 12px; cursor: pointer; }
    .zl-draft:not(.on) { border-color: #f87171; background: #fef2f2; color: #b91c1c; }
    .zl-fix { border: 1px dashed #fca5a5; background: #fff; color: #b91c1c; border-radius: 999px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
    .qe { border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background: #fff; }
    .qe-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 10px; background: linear-gradient(180deg, #f8fafc, #f1f5f9); border-bottom: 1px solid #e2e8f0; position: sticky; top: 0; z-index: 1; }
    .qe-bl { font-size: 12px; font-weight: 800; color: #475569; }
    .qe-add { border: 1px solid #c7d2fe; background: #eef2ff; color: #3730a3; border-radius: 999px; padding: 3px 10px; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
    .qe-add:hover { background: #6366f1; color: #fff; border-color: #6366f1; }
    .qe-tip { margin-left: auto; font-size: 11px; color: #94a3b8; }
    /* Gọn: mỗi câu 1 dòng mỏng, 2 cột khi màn rộng; xem trước chỉ hiện khi đang sửa câu đó; nút xoá hiện khi rê chuột */
    .qe-rows { display: grid; grid-template-columns: repeat(auto-fill, minmax(max(420px, 45%), 1fr)); column-gap: 14px; padding: 4px 6px; }
    .qe-row { display: grid; grid-template-columns: 20px minmax(0, 1fr) 20px; gap: 6px; align-items: center; padding: 1px 4px; border-bottom: 1px dashed #f1f5f9; }
    .qe-row:hover { background: #fafaff; }
    .qe-no { width: 18px; height: 18px; border-radius: 50%; background: #eef2ff; color: #6366f1; font-size: 10px; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; }
    .qe-cell { min-width: 0; display: grid; }
    .qe-line { min-height: 20px; padding: 2px 6px; border: 1px solid transparent; border-radius: 6px; font-size: 13px; line-height: 1.55; outline: none; white-space: pre-wrap; cursor: text; }
    .qe-line:hover { border-color: #e2e8f0; background: #fff; } .qe-line:focus { border-color: #818cf8; background: #fff; box-shadow: 0 0 0 2px rgba(99,102,241,.15); }
    .qe-line:empty::before { content: 'Gõ câu hỏi…'; color: #cbd5e1; }
    .qe-prev { display: none; font-size: 11px; color: #94a3b8; padding: 1px 7px 3px; } .qe-prev::before { content: '👀 '; }
    .qe-row:focus-within .qe-prev { display: block; }
    .qv { display: inline-flex; align-items: center; gap: 2px; margin: 0 1px; padding: 0 6px; border-radius: 999px; font-size: 11px; font-weight: 800; cursor: pointer; user-select: none; vertical-align: 1px; line-height: 17px; }
    .qv-s { background: #dcfce7; color: #15803d; border: 1px solid #86efac; }
    .qv-p { background: #dbeafe; color: #1d4ed8; border: 1px solid #93c5fd; } .qv-d { background: #fef3c7; color: #b45309; border: 1px solid #fcd34d; }
    .qv:hover { filter: brightness(.95); box-shadow: 0 1px 4px rgba(0,0,0,.12); }
    .qe-del { border: 0; background: none; color: #cbd5e1; font-size: 12px; cursor: pointer; border-radius: 6px; opacity: 0; padding: 0; } .qe-row:hover .qe-del { opacity: 1; } .qe-del:hover { color: #dc2626; background: #fee2e2; }
    .qe-new { width: 100%; border: 0; border-top: 1px dashed #e2e8f0; background: #fff; color: #6366f1; font: inherit; font-weight: 700; font-size: 12px; padding: 6px; cursor: pointer; } .qe-new:hover { background: #eef2ff; }
    .qe-dirty { color: #d97706; font-size: 12px; font-weight: 800; } .qe-dirty.ok { color: #15803d; }
    .qr { border: 1px solid #e0e7ff; background: #fbfbff; border-radius: 12px; padding: 10px 12px; display: grid; gap: 8px; }
    .qr-h { display: flex; align-items: center; gap: 10px; } .qr-h b { color: #3730a3; }
    .qr-ps { margin-left: auto; display: flex; align-items: center; gap: 4px; font-size: 12px; color: #64748b; }
    .qr-p { border: 1px solid #c7d2fe; background: #fff; color: #4338ca; border-radius: 999px; padding: 1px 10px; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
    .qr-p.on { background: #6366f1; color: #fff; border-color: #6366f1; }
    .qr-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr); gap: 12px; }
    .qr-chat { display: grid; gap: 6px; max-height: 360px; overflow: auto; padding: 8px; background: #e2e8f0; border-radius: 10px; }
    .qr-b { display: flex; gap: 6px; justify-content: flex-end; }
    .qr-msg { background: #dbeafe; color: #0f172a; border-radius: 12px 12px 2px 12px; padding: 5px 10px; font-size: 12.5px; max-width: 90%; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    .qr-ava { order: 2; font-size: 16px; }
    .qr-live { display: grid; gap: 4px; max-height: 360px; overflow: auto; }
    .qr-row { display: grid; grid-template-columns: auto auto auto minmax(0, 1fr); gap: 4px 8px; align-items: center; text-decoration: none; color: inherit; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 5px 8px; font-size: 12px; }
    .qr-row:hover { border-color: #818cf8; }
    .qr-row b { color: #1d4ed8; } .qr-row .kh { margin: 0; font-size: 10px; }
    .qr-who { display: inline-flex; align-items: center; gap: 4px; color: #475569; }
    .qr-why { color: #94a3b8; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .qr-q { grid-column: 1 / -1; color: #3730a3; font-style: italic; }
    .qa-ov { font-weight: 800; color: #0f172a; } .qa-ov.on { background: linear-gradient(90deg, #fee2e2, #fff7ed) !important; color: #9a3412 !important; box-shadow: inset 3px 0 0 #f97316 !important; }
    .qa-sep { font-size: 10px; font-weight: 800; color: #94a3b8; text-transform: uppercase; letter-spacing: .5px; padding: 8px 8px 2px; border-top: 1px solid #f1f5f9; margin-top: 4px; }
    .qo-kpi { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .qo-k { border-radius: 12px; padding: 8px 12px; display: grid; }
    .qo-kr { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; } .qo-kr em { font-style: normal; font-size: 18px; font-weight: 800; } .qo-k b { font-size: 26px; line-height: 1.1; } .qo-k span { font-size: 12px; font-weight: 700; }
    .qo-k.hi { background: #fef2f2; color: #b91c1c; } .qo-k.mid { background: #fff7ed; color: #c2410c; } .qo-k.lo { background: #f0fdf4; color: #15803d; }
    .qo-sts, .qo-bks { display: flex; flex-wrap: wrap; gap: 5px; }
    .qo-st { display: inline-flex; align-items: center; gap: 4px; border: 1px solid #e2e8f0; background: #fff; border-radius: 999px; padding: 2px 10px 2px 4px; font: inherit; font-size: 12px; cursor: pointer; }
    .qo-st b { color: #64748b; } .qo-st.on { background: #1e293b; color: #fff; border-color: #1e293b; } .qo-st.on b { color: #e2e8f0; }
    .qo-bk { font-size: 11px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 999px; padding: 1px 8px; color: #475569; } .qo-bk b { color: #4338ca; }
    .qo-list { display: grid; gap: 4px; }
    .qo-row { display: grid; grid-template-columns: 26px 78px minmax(0, 1fr) auto; gap: 8px; align-items: center; text-decoration: none; color: inherit; background: #fff; border: 1px solid #e2e8f0; border-left: 4px solid #e2e8f0; border-radius: 8px; padding: 5px 10px; }
    .qo-row.hi { border-left-color: #ef4444; } .qo-row.mid { border-left-color: #f97316; } .qo-row.lo { border-left-color: #22c55e; }
    .qo-row:hover { box-shadow: 0 2px 10px rgba(15,23,42,.08); border-color: #c7d2fe; }
    .qo-no { color: #94a3b8; font-weight: 800; text-align: right; font-size: 12px; }
    .qo-lv { font-size: 11px; font-weight: 800; border-radius: 999px; padding: 1px 8px; text-align: center; white-space: nowrap; }
    .qo-lv.hi { background: #fee2e2; color: #b91c1c; } .qo-lv.mid { background: #ffedd5; color: #c2410c; } .qo-lv.lo { background: #dcfce7; color: #15803d; }
    .qo-main { display: grid; gap: 1px; min-width: 0; }
    .qo-top { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12.5px; } .qo-top b { color: #1d4ed8; } .qo-top .kh { margin: 0; font-size: 10px; }
    .qo-bank { font-size: 11px; font-weight: 700; color: #4338ca; white-space: nowrap; }
    .qo-why { font-size: 11px; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .qo-q { font-size: 12.5px; color: #3730a3; font-style: italic; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .qo-side { display: grid; justify-items: end; gap: 1px; } .qo-amt { font-weight: 800; color: #047857; font-size: 12.5px; }
    .qo-who { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: #64748b; }
    .qo-sync { font-size: 11px; font-weight: 600; color: #64748b; margin-left: 8px; }
    .qo-loading { padding: 30px; text-align: center; color: #64748b; font-size: 13px; }
    .qo-more { border: 1px dashed #c7d2fe; background: #f8faff; color: #4338ca; border-radius: 8px; padding: 8px; font: inherit; font-weight: 700; font-size: 12.5px; cursor: pointer; } .qo-more:hover { background: #eef2ff; }
    .qo-bno { font-style: normal; font-size: 10px; font-weight: 900; color: #fff; background: #6366f1; border-radius: 999px; padding: 0 6px; margin-right: 4px; }
    .qo-qr { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .qo-edit { flex: none; border: 1px solid #e2e8f0; background: #fff; color: #475569; border-radius: 999px; padding: 0 8px; font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; opacity: 0; transition: opacity .15s; }
    .qo-row:hover .qo-edit { opacity: 1; } .qo-edit:hover { background: #6366f1; color: #fff; border-color: #6366f1; }
    .qe-flash { animation: qeFlash 2.4s ease; }
    @keyframes qeFlash { 0%, 60% { background: #fef08a; box-shadow: 0 0 0 2px #facc15; } 100% { background: transparent; box-shadow: none; } }
    .qa-wrap { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 12px; align-items: start; }
    .qa-menu { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; overflow: hidden; gap: 2px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 6px; position: sticky; top: 0; }
    .qa-mi { display: flex !important; width: 100% !important; min-width: 0; box-sizing: border-box; overflow: hidden; align-items: center; gap: 8px; border: 0; background: none; text-align: left; padding: 7px 8px; border-radius: 8px; font: inherit; font-size: 13px; color: #334155; cursor: pointer; }
    .qa-mi:hover { background: #f5f3ff; }
    .qa-mi.on { background: linear-gradient(90deg, #ede9fe, #f5f3ff); color: #4c1d95; font-weight: 700; box-shadow: inset 3px 0 0 #7c3aed; }
    .qa-mt { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .qa-mi .qb-no, .qa-mc, .qa-dot { flex: none; }
    .qa-mc { font-size: 11px; color: #64748b; background: #f1f5f9; border-radius: 999px; padding: 0 7px; }
    .qa-dot { font-size: 11px; }
    .qa-pane { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px 16px; display: grid; gap: 10px; }
    .qa-ph { display: flex; align-items: center; gap: 10px; } .qa-ph h3 { margin: 0; font-size: 17px; }
    .qa-pic { font-size: 26px; } .qb-no.big { width: 28px; height: 28px; font-size: 13px; }
    .qa-lbl { font-size: 12px; font-weight: 800; color: #475569; }
    .qa-pane .qb-ex { gap: 4px; } .qa-pane .qb-ex em { font-style: normal; display: inline-flex; width: 18px; height: 18px; border-radius: 50%; background: #e0e7ff; color: #4338ca; font-size: 10px; font-weight: 900; align-items: center; justify-content: center; margin-right: 6px; }
    .qb-tab { margin-top: 10px; }
    .qb-intro { background: #f5f3ff; border: 1px solid #ddd6fe; border-radius: 10px; padding: 10px 14px; font-size: 13px; color: #4c1d95; margin-bottom: 10px; }
    .qb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 10px; }
    .qb-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 10px 12px; display: grid; gap: 6px; }
    .qb-h { display: flex; align-items: center; gap: 6px; font-size: 14px; }
    .qb-no { width: 22px; height: 22px; border-radius: 50%; background: #6366f1; color: #fff; font-size: 11px; font-weight: 900; display: inline-flex; align-items: center; justify-content: center; flex: none; }
    .qb-n { margin-left: auto; font-size: 11px; color: #64748b; }
    .qb-ed { font-size: 11px; font-weight: 700; color: #b45309; background: #fef3c7; border-radius: 999px; padding: 0 8px; }
    .qb-def { font-size: 11px; color: #64748b; background: #f1f5f9; border-radius: 999px; padding: 0 8px; }
    .qb-when { font-size: 12px; color: #334155; background: #f8fafc; border-left: 3px solid #a5b4fc; padding: 4px 8px; border-radius: 4px; }
    .qb-edit { width: 100%; box-sizing: border-box; font: inherit; font-size: 12.5px; border: 1px solid #cbd5e1; border-radius: 8px; padding: 6px 8px; resize: vertical; }
    .qb-btns { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11px; }
    .qb-ex { font-size: 12px; color: #475569; display: grid; gap: 2px; }
    .bigtab.qa.on { color: #6d28d9; }
    .quick-src { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; color: #6b7280; margin-bottom: 4px; } .quick-src b { color: #4338ca; }
    .quick-fix { border: 1px solid #c7d2fe; background: #eef2ff; color: #3730a3; border-radius: 999px; padding: 0 9px; font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; }
    .quick-fix:hover { background: #6366f1; color: #fff; border-color: #6366f1; }
    .nvl-u { display: block; font-size: 10.5px; color: #94a3b8; font-weight: 400; } .nvl-sum td { background: #fff7ed; }
    .osim { width: 78px; border: 1px dashed #a78bfa; background: #fff; border-radius: 6px; padding: 2px 6px; font: inherit; font-weight: 700; text-align: right; color: #4c1d95; }
    .osim:focus { outline: none; border-style: solid; box-shadow: 0 0 0 2px rgba(139,92,246,.2); } .osim.chg { background: #fef3c7; border-color: #f59e0b; color: #92400e; }
    .osim-rw { --lc: #7c3aed; } .osim-rw.lv-green { --lc: #059669; } .osim-rw.lv-blue { --lc: #2563eb; } .osim-rw.lv-orange { --lc: #ea580c; } .osim-rw.lv-red { --lc: #dc2626; }
    .osim-rw .osim-range { accent-color: var(--lc) !important; }
    .osim-rw .osim-bub { background: var(--lc) !important; } .osim-rw .osim-bub::after { border-top-color: var(--lc) !important; }
    .osim-rw.lv-red .osim-bub { animation: bubRed .7s ease-in-out infinite; } .osim-rw.lv-orange .osim-bub { animation: bubOrange 1.2s ease-in-out infinite; } .osim-rw.lv-blue .osim-bub { animation: bubBlue 2s ease-in-out infinite; }
    @keyframes bubRed { 0%, 100% { transform: translateX(-50%) scale(1); filter: none; } 50% { transform: translateX(-50%) scale(1.15); filter: brightness(1.3); } }
    @keyframes bubOrange { 0%, 100% { filter: none; } 50% { filter: brightness(1.25); } }
    @keyframes bubBlue { 0%, 100% { opacity: 1; } 50% { opacity: .75; } }
    .osim-rw { position: relative; flex: 1; display: flex; padding-top: 22px; }
    .osim-rw .osim-range { flex: 1; }
    .osim-bub { position: absolute; top: 0; transform: translateX(-50%); background: #7c3aed; color: #fff; font-size: 11px; font-weight: 900; padding: 1px 7px; border-radius: 6px; white-space: nowrap; pointer-events: none; }
    .osim-bub::after { content: ''; position: absolute; left: 50%; bottom: -4px; transform: translateX(-50%); border: 4px solid transparent; border-top-color: #7c3aed; border-bottom: 0; }
    .osim-sl { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-weight: 700; color: #4c1d95; }
    .osim-range { flex: 1; accent-color: #7c3aed; } .osim-rv { min-width: 120px; text-align: right; color: #7c2d12; }
    .osim-hint { font-size: 11.5px; color: #6d28d9; background: #f5f3ff; } .osim-reset { border: 1px solid #c4b5fd; background: #fff; color: #6d28d9; border-radius: 999px; padding: 0 8px; font: inherit; font-size: 11px; cursor: pointer; }
    .osim-diff { font-size: 17px; font-weight: 900; } .osim-diff.neg { color: #b91c1c; }
    .osim-dpct { font-size: 17px; font-weight: 900; color: #047857; padding: 2px 8px; border-radius: 8px; display: inline-block; }
    .osim-dpct.lv-green { color: #047857; }
    .mt-v .osim-top.osim-dpct { font-size: 30px; padding: 2px 10px; margin-left: -10px; }
    .osim-dpct.lv-blue { color: #1d4ed8; animation: dpBlue 2s ease-in-out infinite; }
    .osim-dpct.lv-orange { color: #c2410c; animation: dpOrange 1.2s ease-in-out infinite; }
    .osim-dpct.lv-red { color: #fff; animation: dpRed .7s ease-in-out infinite; }
    @keyframes dpBlue { 0%, 100% { background: transparent; } 50% { background: #dbeafe; } }
    @keyframes dpOrange { 0%, 100% { background: #fff7ed; } 50% { background: #fdba74; } }
    @keyframes dpRed { 0%, 100% { background: #dc2626; } 50% { background: #fca5a5; color: #7f1d1d; } }
    .osp { width: 100%; border-collapse: collapse; font-size: 12.5px; margin: 6px 0; } .osp th, .osp td { padding: 4px 6px; border-bottom: 1px solid #f1f5f9; text-align: left; } .osp .num { text-align: right; white-space: nowrap; } .osp th { color: #64748b; font-weight: 700; }
    .learn-hint { font-size: 12px; color: #6b21a8; margin-top: 4px; }
    .learn-use { border: 1px dashed #c4b5fd; background: #faf5ff; color: #6b21a8; border-radius: 8px; padding: 1px 8px; font: inherit; font-style: italic; cursor: pointer; text-align: left; }
    .learn-use:hover { background: #ede9fe; }
    .hot-btns { display: flex; gap: 8px; align-items: center; flex: none; }
    .hot-copy { white-space: nowrap; font-weight: 700; }
    .hot-list { display: grid; gap: 6px; margin-top: 8px; }
    .hot-toggle { width: 26px; height: 26px; margin-right: 6px; border-radius: 8px; border: 1px solid #fed7aa; background: #fff; color: #c2410c;
      font-size: 13px; cursor: pointer; vertical-align: middle; }
    .hot-toggle:hover { background: #ffedd5; }
    .hot-count { background: #ea580c; color: #fff; border-radius: 999px; padding: 0 9px; font-size: 13px; margin-left: 4px; }
    .hotbox.collapsed { padding-top: 8px; padding-bottom: 8px; }
    /* Thu gọn mà còn đơn chốt được → lửa bập bùng, số đếm phát sáng, viền chạy nhẹ để gây chú ý */
    .hotbox.collapsed.has-data { animation: dghotglow 2.4s ease-in-out infinite; }
    .hotbox.collapsed.has-data .hot-fire { display: inline-block; animation: dgflame 1.1s ease-in-out infinite; transform-origin: 50% 90%; }
    .hotbox.collapsed.has-data .hot-count { animation: dgpulse 1.6s ease-in-out infinite; }
    .hotbox.collapsed.has-data .hot-toggle { animation: dgnudge 1.6s ease-in-out infinite; }
    .hot-hint { margin-left: 8px; font-size: 12px; font-weight: 600; color: #c2410c; opacity: .8; }
    @keyframes dgflame { 0%, 100% { transform: scale(1) rotate(-4deg); } 50% { transform: scale(1.25) rotate(5deg); } }
    @keyframes dgpulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(234,88,12,.55); } 60% { box-shadow: 0 0 0 8px rgba(234,88,12,0); } }
    @keyframes dgnudge { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(3px); } }
    @keyframes dghotglow { 0%, 100% { border-color: #fed7aa; box-shadow: 0 0 0 0 rgba(251,146,60,0); }
      50% { border-color: #fb923c; box-shadow: 0 0 18px 0 rgba(251,146,60,.35); } }
    @media (prefers-reduced-motion: reduce) { .hotbox.collapsed.has-data, .hotbox.collapsed.has-data * { animation: none !important; } }
    .hot-sum { margin-left: 8px; font-size: 14px; font-weight: 900; color: #047857; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 999px; padding: 1px 10px; }
    .dl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(460px, 1fr)); gap: 12px; margin: 12px; }
    .dl-card { border: 1px solid #e2e8f0; border-radius: 14px; padding: 12px 14px; background: #fff; display: grid; gap: 6px; }
    .dl.anim .dl-card { animation: wkIn .4s ease both; }
    .dl-card:hover { border-color: #c7d2fe; box-shadow: 0 4px 14px rgba(79,70,229,.08); }
    .dl-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .dl-code { font-weight: 900; color: #1d4ed8; text-decoration: none; } .dl-code:hover { text-decoration: underline; }
    .dl-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #334155; font-weight: 600; }
    .dl-amt { font-weight: 900; color: #047857; white-space: nowrap; }
    .dl-meta { font-size: 12px; color: #64748b; }
    .dl-stage { font-size: 11px; font-weight: 800; border-radius: 999px; padding: 1px 9px; white-space: nowrap; }
    .dl-stage.hot { background: #dcfce7; color: #166534; } .dl-stage.warm { background: #fef3c7; color: #92400e; }
    .dl-stage.cold { background: #f1f5f9; color: #64748b; } .dl-stage.new { background: #e0e7ff; color: #3730a3; }
    .dl-health { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; font-size: 12px; color: #64748b; }
    .dl-hbar { height: 7px; border-radius: 99px; background: #f1f5f9; overflow: hidden; }
    .dl-hbar i { display: block; height: 100%; width: var(--w); border-radius: 99px; animation: wkBar .9s cubic-bezier(.2,.8,.2,1) both; }
    .dl-hbar.good i { background: linear-gradient(90deg, #22c55e, #16a34a); } .dl-hbar.mid i { background: linear-gradient(90deg, #fbbf24, #f59e0b); }
    .dl-hbar.bad i { background: linear-gradient(90deg, #f87171, #dc2626); }
    .dl-health b.good { color: #16a34a; } .dl-health b.mid { color: #d97706; } .dl-health b.bad { color: #dc2626; }
    .dl-say { font-size: 12.5px; color: #1e3a8a; background: #eff6ff; border-left: 3px solid #3b82f6; border-radius: 6px; padding: 6px 10px; }
    .dl-risk { font-size: 12px; color: #9a3412; }
    .dl-none { font-size: 12px; }
    .dl .ct-head { gap: 12px; flex-wrap: wrap; } .dl .ct-head .rp-start.cta { flex: none; }
    .dl-hot { margin: 12px; padding: 12px 14px; border-radius: 16px; border: 2px solid #fb923c; background: linear-gradient(135deg, #fff7ed, #ffedd5);
      box-shadow: 0 6px 20px rgba(249,115,22,.18); animation: dghotglow 2.4s ease-in-out infinite; }
    .dl-hot-h { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 15px; color: #9a3412; margin-bottom: 8px; }
    .dl-fire { font-size: 24px; display: inline-block; animation: dgflame 1.1s ease-in-out infinite; transform-origin: 50% 90%; }
    .dl-hot-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(460px, 1fr)); gap: 8px; }
    .dl-hot-item, .dl-big-item { cursor: pointer; }
    .dl-hot-item { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto auto; gap: 8px; align-items: center; background: #fff; border: 1px solid #fed7aa;
      border-radius: 12px; padding: 8px 12px; }
    .dl-hot-body { grid-column: 1 / -1; font-size: 12.5px; color: #7c2d12; }
    .dl-big { margin: 12px; padding: 12px 14px; border-radius: 16px; border: 2px solid #818cf8; background: linear-gradient(135deg, #eef2ff, #f5f3ff); }
    .dl-big-h { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 15px; color: #3730a3; }
    .dl-bic { font-size: 22px; display: inline-block; animation: wkMedal 2s ease-in-out infinite; }
    .dl-big-tip-unused { margin: 6px 0 10px; font-size: 13px; color: #312e81; background: #fff; border: 1px dashed #a5b4fc; border-radius: 10px; padding: 7px 12px; }
    .dl-big-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(440px, 1fr)); gap: 8px; }
    .dl-big-item { display: grid; gap: 4px; background: #fff; border: 1px solid #c7d2fe; border-radius: 12px; padding: 9px 12px; }
    .dl-amt.big { font-size: 15px; color: #3730a3; }
    .dl-cta { font-size: 13px; font-weight: 700; color: #3730a3; background: #eef2ff; border-left: 3px solid #6366f1; border-radius: 6px; padding: 6px 10px; line-height: 1.45; }
    .dl-acts { display: flex; flex-wrap: wrap; gap: 5px; }
    .dl-act { font-size: 11.5px; font-weight: 800; color: #3730a3; background: #e0e7ff; border-radius: 999px; padding: 2px 10px; }
    .dl-boss { font-size: 12.5px; color: #3730a3; background: #eef2ff; border-left: 3px solid #6366f1; border-radius: 6px; padding: 5px 10px; }
    .dl-listwrap { margin: 12px; }
    .bigtab.set { margin-left: auto; }
    /* ===== Tab Công nợ ===== */
    .sx-tile.t-red { background: linear-gradient(135deg, #ef4444, #b91c1c); }
    .sx-hic.red { background: #fee2e2; }
    .db-wrap { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 14px; margin: 12px; align-items: start; }
    .db-two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; margin: 12px; align-items: start; }
    .db-chart { display: flex; align-items: flex-end; gap: 3px; height: 150px; padding-top: 6px; }
    .db-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; min-width: 0; }
    .db-col span { font-size: 9px; color: #94a3b8; margin-top: 3px; white-space: nowrap; }
    .db-bars { flex: 1; width: 100%; display: flex; align-items: flex-end; justify-content: center; gap: 1px; }
    .db-bars i { display: block; width: 45%; border-radius: 3px 3px 0 0; min-height: 1px; }
    .db-bars i.c { background: linear-gradient(180deg, #34d399, #059669); } .db-bars i.e { background: #c7d2fe; }
    .db-leg { display: flex; gap: 14px; font-size: 12px; color: #64748b; } .db-leg i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
    .db-leg i.c { background: #10b981; } .db-leg i.e { background: #c7d2fe; }
    .db-staffs { display: grid; gap: 6px; }
    .db-staff { font: inherit; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; text-align: left; border: 1px solid #e2e8f0;
      border-radius: 12px; padding: 7px 10px; background: #fff; cursor: pointer; }
    .db-staff:hover { border-color: #a5b4fc; } .db-staff.on { border-color: #6366f1; background: #eef2ff; }
    .db-staff b { display: block; font-size: 13px; } .db-staff small { font-size: 11px; color: #64748b; }
    .db-staff em { font-style: normal; font-size: 12px; font-weight: 800; color: #b91c1c; background: #fee2e2; border-radius: 999px; padding: 1px 9px; white-space: nowrap; }
    .db-staff em.ok { color: #166534; background: #dcfce7; }
    .db-sub { font-size: 11px; } .db-red { color: #b91c1c !important; } .db-green { color: #166534 !important; }
    .db-days { font-size: 12px; font-weight: 900; border-radius: 999px; padding: 1px 9px; color: #fff; white-space: nowrap; }
    .db-days.red { background: #dc2626; animation: rpUrge 1.4s ease-in-out infinite; } .db-days.orange { background: #f97316; } .db-days.amber { background: #f59e0b; }
    .db-due { font-size: 12px; font-weight: 800; color: #0369a1; background: #e0f2fe; border-radius: 999px; padding: 1px 9px; white-space: nowrap; }
    .db-due.soon { color: #fff; background: #f97316; }
    .db-blue { background: #0284c7 !important; }
    .debt table.ct td { vertical-align: middle; padding: 5px 8px; font-size: 12.5px; }
    .debt table.ct th { padding: 6px 8px; }
    .debt table.ct { table-layout: fixed; }
    .db-cust { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .db-cust b { font-weight: 800; } .db-cust .kh { margin-left: 6px; font-size: 10px; }
    .debt .ct-who .ava { width: 16px !important; height: 16px !important; }
    .debt .db-days, .debt .db-due { font-size: 11px; padding: 0 8px; }
    .sx-h b .hot-count { color: #fff; font-size: 12px; margin-left: 4px; }
    .db-hbtns { display: flex; gap: 8px; align-items: center; }
    /* NVKD chỉ xem công nợ của mình → ẩn cột NVKD */
    .debt.mine table.ct col:nth-child(3) { width: 0 !important; } .debt.mine table.ct th:nth-child(3), .debt.mine table.ct td:nth-child(3) { display: none; }
    /* ===== Tab Cài đặt ===== */
    .sx .ct-head { align-items: center; }
    .sx-live { display: inline-flex; align-items: center; gap: 8px; font-weight: 800; font-size: 13px; background: rgba(255,255,255,.18); border-radius: 999px; padding: 5px 14px; }
    .sx-live i { width: 9px; height: 9px; border-radius: 50%; background: #4ade80; animation: sxPing 1.8s infinite; }
    .sx-live.err i { background: #f87171; }
    @keyframes sxPing { 0% { box-shadow: 0 0 0 0 rgba(74,222,128,.7); } 70% { box-shadow: 0 0 0 8px rgba(74,222,128,0); } 100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); } }
    .sx-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 14px 12px 4px; }
    .sx-tile { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 16px; color: #fff; position: relative; overflow: hidden;
      box-shadow: 0 8px 20px rgba(15,23,42,.10); }
    .sx-tile::after { content: ''; position: absolute; right: -30px; top: -30px; width: 110px; height: 110px; border-radius: 50%; background: rgba(255,255,255,.12); }
    .sx-tile.t-day { background: linear-gradient(135deg, #6366f1, #8b5cf6); } .sx-tile.t-bal { background: linear-gradient(135deg, #059669, #10b981); }
    .sx-tile.t-read { background: linear-gradient(135deg, #0ea5e9, #2563eb); } .sx-tile.t-sync { background: linear-gradient(135deg, #14b8a6, #0d9488); }
    .sx-tile.t-ver { background: linear-gradient(135deg, #f59e0b, #ea580c); }
    .sx-ic { font-size: 26px; width: 46px; height: 46px; border-radius: 14px; background: rgba(255,255,255,.2); display: flex; align-items: center; justify-content: center; flex: none; }
    .sx-tv { display: grid; min-width: 0; } .sx-tv span { font-size: 12px; opacity: .9; } .sx-tv b { font-size: 22px; font-weight: 900; line-height: 1.2; }
    .sx-tv b em { font-style: normal; font-size: 14px; opacity: .8; } .sx-tv small { font-size: 11px; opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sx-tv b.bad { color: #fecaca; }
    .sx-ring { --p: 0; flex: none; width: 50px; height: 50px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
      background: conic-gradient(#fff calc(var(--p) * 1%), rgba(255,255,255,.25) 0); }
    .sx-ring span { width: 38px; height: 38px; border-radius: 50%; background: #059669; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 900; }
    .sx-cols { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 14px; margin: 12px; align-items: start; }
    .sx-stack { display: grid; gap: 14px; }
    .sx-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 18px; padding: 16px 18px; display: grid; gap: 12px; box-shadow: 0 4px 14px rgba(15,23,42,.04); }
    .sx-h { display: flex; align-items: center; gap: 12px; } .sx-h b { display: block; font-size: 15px; color: #0f172a; } .sx-h span { font-size: 12px; color: #64748b; }
    .sx-hic { width: 38px; height: 38px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 19px; flex: none; }
    .sx-hic.violet { background: #ede9fe; } .sx-hic.sky { background: #e0f2fe; } .sx-hic.green { background: #dcfce7; }
    .sx-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 14px; background: #f8fafc; }
    .sx-ric { font-size: 20px; } .sx-rt { flex: 1; display: grid; } .sx-rt b { font-size: 14px; } .sx-rt span { font-size: 12px; color: #64748b; }
    .sx-job { border: 1px solid #e2e8f0; border-radius: 14px; padding: 10px 12px; display: grid; gap: 7px; font-size: 13px; }
    .sx-job.run { border-color: #a5b4fc; background: linear-gradient(180deg, #eef2ff, #fff); } .sx-job.full { border-color: #fdba74; background: linear-gradient(180deg, #fff7ed, #fff); }
    .sx-jt { display: flex; align-items: center; justify-content: space-between; gap: 10px; } .sx-jt > span { flex: 1; }
    .sx-bar { height: 8px; border-radius: 99px; background: #e2e8f0; overflow: hidden; }
    .sx-bar i { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, #6366f1, #22c55e, #6366f1); background-size: 200% 100%; animation: wkGrad 2s linear infinite; transition: width .5s; }
    .sx-bt { font-size: 11px; color: #64748b; font-weight: 700; }
    .sx-btn { font: inherit; font-size: 12px; font-weight: 800; border-radius: 10px; padding: 6px 12px; cursor: pointer; border: 1px solid #c7d2fe; background: #fff; color: #4338ca; white-space: nowrap; }
    .sx-btn:hover { background: #eef2ff; } .sx-btn.go { color: #fff; border: 0; background: linear-gradient(135deg, #f97316, #ea580c); }
    .sx-btn.stop { color: #b91c1c; border-color: #fecaca; background: #fff5f5; }
    .sx-kv { display: flex; justify-content: space-between; align-items: center; padding: 6px 2px; font-size: 13px; border-bottom: 1px dashed #eef2f7; }
    .sx-kv:last-child { border-bottom: 0; } .sx-kv span { color: #64748b; } .sx-kv b.good { color: #047857; }
    .sx-ver { background: linear-gradient(135deg, #f59e0b, #ea580c); color: #fff; border-radius: 999px; padding: 1px 10px; font-size: 12px; }
    .sx-sync { display: flex; align-items: center; gap: 10px; font-size: 14px; }
    .sx-dot { width: 12px; height: 12px; border-radius: 50%; background: #cbd5e1; } .sx-dot.on { background: #22c55e; animation: sxPing 1.8s infinite; }
    .sx-tl { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; } .sx-tl div { background: #f8fafc; border-radius: 12px; padding: 8px 12px; display: grid; }
    .sx-tl span { font-size: 12px; color: #64748b; } .sx-tl b { font-size: 15px; }
    .sx-note { display: flex; align-items: center; gap: 10px; font-size: 12px; color: #64748b; background: #f8fafc; border-radius: 12px; padding: 8px 12px; }
    .sx-zip { margin: 0 12px 14px; }
    .zp-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; padding: 12px 14px; border-radius: 14px;
      background: linear-gradient(135deg, #eef2ff, #fdf4ff); border: 1px solid #c7d2fe; }
    .zp-file { display: flex; align-items: center; gap: 12px; } .zp-ic { font-size: 30px; }
    .zp-file b { display: block; font-size: 15px; } .zp-file span { font-size: 12px; color: #64748b; }
    .zp-steps { margin: 0; padding-left: 20px; display: grid; gap: 4px; font-size: 13px; color: #334155; }
    .zp-warn { font-size: 12px; font-weight: 700; color: #9a3412; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 10px; padding: 6px 10px; }
    .sx-perm { margin: 0 12px 12px; } .sx-perm .st-card { border-radius: 18px; }
    .st-card.pm { grid-column: 1 / -1; }
    table.pm-t td { vertical-align: middle; } table.pm-t tr.off td { opacity: .55; }
    .pm-seen { font-size: 11px; margin-top: 2px; }
    .pm-subtabs { display: flex; gap: 6px; border-bottom: 2px solid #e2e8f0; }
    .pm-sub { font: inherit; font-size: 13px; font-weight: 800; color: #64748b; background: none; border: 0; border-bottom: 3px solid transparent; margin-bottom: -2px;
      padding: 6px 12px; cursor: pointer; }
    .pm-sub b { font-size: 11px; background: #e2e8f0; color: #475569; border-radius: 999px; padding: 0 7px; margin-left: 4px; }
    .pm-sub.on { color: #166534; border-bottom-color: #22c55e; } .pm-sub.on b { background: #22c55e; color: #fff; }
    .pm-sub.off.on { color: #b45309; border-bottom-color: #f59e0b; } .pm-sub.off.on b { background: #f59e0b; }
    .pm-role { font: inherit; font-size: 12px; font-weight: 800; border-radius: 999px; padding: 3px 12px; cursor: pointer; border: 1px solid #cbd5e1; background: #fff; }
    .pm-role.admin { color: #92400e; background: #fef3c7; border-color: #fcd34d; } .pm-role.sale { color: #1e40af; background: #eff6ff; border-color: #bfdbfe; }
    .pm-fixed { font-size: 12px; font-weight: 700; color: #64748b; }
    .pm-tabs { display: flex; flex-wrap: wrap; gap: 5px; }
    .pm-tab { font: inherit; font-size: 12px; font-weight: 700; border-radius: 999px; padding: 2px 10px; cursor: pointer; border: 1px solid #e2e8f0; background: #f8fafc; color: #94a3b8; }
    .pm-tab.on { background: #4f46e5; border-color: #4f46e5; color: #fff; } .pm-tab:disabled { cursor: default; opacity: .8; }
    .st-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 14px; margin: 14px 12px; align-items: start; }
    .st-card { border: 1px solid #e2e8f0; border-radius: 14px; padding: 14px 16px; background: #fff; display: grid; gap: 10px; }
    .st-card h4 { margin: 0; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: #64748b; }
    .st-two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .st-stat { background: #f8fafc; border-radius: 10px; padding: 8px 12px; } .st-stat span { display: block; font-size: 12px; color: #64748b; } .st-stat b { font-size: 22px; }
    .st-row { display: flex; justify-content: space-between; gap: 10px; align-items: center; font-size: 13px; } .st-row span { color: #64748b; }
    .st-row b.good, .st-card b.good { color: #047857; } .st-row b.bad { color: #b91c1c; }
    .st-bar { height: 6px; border-radius: 99px; background: #e2e8f0; overflow: hidden; } .st-bar i { display: block; height: 100%; background: linear-gradient(90deg, #10b981, #059669); }
    .st-box { display: flex; align-items: center; gap: 10px; background: #f8fafc; border-radius: 10px; padding: 8px 10px; font-size: 13px; } .st-box span { flex: 1; }
    .st-sw { display: flex; align-items: center; gap: 12px; cursor: pointer; font-size: 13px; } .st-sw > span { flex: 1; }
    .st-tg { position: relative; flex: none; width: 42px; height: 24px; border-radius: 99px; border: 0; background: #cbd5e1; cursor: pointer; transition: background .2s; }
    .st-tg i { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .2s; }
    .st-tg.on { background: linear-gradient(135deg, #2563eb, #7c3aed); } .st-tg.on i { transform: translateX(18px); }
    /* Tab Phân tích deal đã lọc theo 1 NVKD → ẩn cột NVKD (cột thứ 7) */
    .dl-list a.item, .dl-list .item-head { grid-template-columns: 34px 84px 74px minmax(0, .45fr) 130px minmax(0, 1.75fr) 74px 136px 120px 52px; }
    .dl-list a.item > :nth-child(7), .dl-list .item-head > :nth-child(7) { display: none; }
    .it-main .dl-hotbadge.sm { font-size: 10px; padding: 0 7px; margin-right: 4px; animation: none; }
    .dl-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: -2px 0 6px 44px; padding: 5px 10px; font-size: 12px; color: #334155;
      background: #f8faff; border-left: 3px solid #a5b4fc; border-radius: 6px; }
    .dl-sub .hot-miss { margin: 0; } .dl-sub .hot-miss i { font-size: 11px; padding: 0 7px; }
    .dl-hmini { font-weight: 900; border-radius: 999px; padding: 0 8px; } .dl-hmini.good { color: #166534; background: #dcfce7; }
    .dl-hmini.mid { color: #92400e; background: #fef3c7; } .dl-hmini.bad { color: #991b1b; background: #fee2e2; }
    .dl-step1 { color: #7c2d12; font-weight: 700; } .dl-boss1 { color: #3730a3; font-weight: 700; }
    .dl-say1 { color: #1e3a8a; max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dl-card.hot { border: 2px solid #fb923c; background: linear-gradient(180deg, #fff7ed, #fff 40%); }
    .dl-hotbadge { font-size: 11px; font-weight: 900; color: #fff; background: linear-gradient(90deg, #f97316, #ef4444); border-radius: 999px; padding: 1px 8px;
      white-space: nowrap; animation: ctaGlow 1.6s ease-in-out infinite; } .dl .ct-head .ct-who { flex: 1; color: #fff; } .dl .ct-title { color: #fff; }
    .hot-miss { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 4px; font-size: 12px; }
    .hot-miss b { color: #b91c1c; font-weight: 800; margin-right: 2px; }
    .hot-miss i { font-style: normal; font-weight: 700; color: #b91c1c; background: #fee2e2; border: 1px solid #fecaca; border-radius: 999px; padding: 1px 9px; }
    .hot-steps { display: grid; gap: 3px; margin-top: 5px; font-size: 12.5px; }
    .hot-steps b { color: #c2410c; font-weight: 800; }
    .hot-step { display: flex; align-items: flex-start; gap: 7px; color: #7c2d12; font-weight: 600; }
    .hot-step em { flex: none; font-style: normal; width: 18px; height: 18px; border-radius: 50%; background: #f97316; color: #fff; font-size: 11px; font-weight: 900;
      display: inline-flex; align-items: center; justify-content: center; margin-top: 1px; }
    .hot-done { width: 30px; height: 30px; border-radius: 50%; border: 2px solid #cbd5e1; background: #fff; color: #94a3b8; font-size: 15px;
      font-weight: 900; cursor: pointer; transition: all .15s; }
    .hot-done:hover { border-color: #16a34a; background: #16a34a; color: #fff; transform: scale(1.08); }
    a.hot-item.hot-gone { opacity: 0; transform: translateX(30px); transition: all .25s ease; }
    .zl-one { border: 1px solid #93c5fd; background: #eff6ff; border-radius: 999px; width: 30px; height: 26px; cursor: pointer; font-size: 13px; }
    .zl-one:hover:not(:disabled) { background: #0068ff; }
    .zl-one:disabled { cursor: not-allowed; }
    .zl-one.done { background: #dcfce7; border-color: #86efac; }
    .zl-one.wait { background: #f1f5f9; border-color: #cbd5e1; opacity: .8; }
    .zl-btn:disabled { cursor: not-allowed; }
    .zl-btn.wait { background: #f1f5f9; border-color: #cbd5e1; color: #64748b; } .zl-btn.wait i { background: #94a3b8; }
    a.hot-item:has(.zl-one) { grid-template-columns: 26px 22px minmax(0, 1fr) 30px auto !important; }
    a.hot-item { display: grid; grid-template-columns: 26px 22px minmax(0, 1fr) auto; gap: 8px; align-items: center; text-decoration: none; color: inherit;
      background: #fff; border: 1px solid #ffedd5; border-radius: 8px; padding: 4px 10px; }
    .hot-list { gap: 4px !important; }
    a.hot-item .hot-done { width: 24px; height: 24px; font-size: 12px; border-width: 1.5px; }
    .hot-main { gap: 1px !important; }
    .hot-why { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11.5px !important; }
    .hot-line { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 11.5px; }
    .hot-mini { display: flex; gap: 4px; flex: none; }
    .hot-mini i { font-style: normal; font-weight: 700; color: #b91c1c; background: #fee2e2; border: 1px solid #fecaca; border-radius: 999px; padding: 0 7px; font-size: 11px; white-space: nowrap; }
    .hot-flow { color: #7c2d12; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .hot-flow em { font-style: normal; display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 50%;
      background: #f97316; color: #fff; font-size: 10px; font-weight: 900; margin-right: 3px; vertical-align: 1px; }
    .hot-arr { color: #fdba74; font-weight: 900; margin: 0 6px; }
    .hot-r1, .hot-r2 { display: flex; align-items: center; gap: 8px; justify-content: flex-end; white-space: nowrap; }
    .hot-side .hot-pct { font-size: 14px; padding: 0 8px; }
    a.hot-item:hover { border-color: #fb923c; box-shadow: 0 2px 10px rgba(251,146,60,.18); }
    .hot-no { font-weight: 800; color: #ea580c; text-align: center; font-size: 15px; }
    .hot-main { display: grid; gap: 3px; min-width: 0; }
    .hot-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .hot-top b { color: #1d4ed8; font-size: 14px; }
    .hot-top .kh { margin: 0; font-size: 11px; }
    .hot-name { color: #0f172a; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hot-why { font-size: 12px; color: #334155; }
    .hot-next { font-size: 12px; color: #9a3412; font-weight: 600; }
    .hot-side { display: grid; justify-items: end; gap: 2px; }
    .hot-pct { font-size: 18px; font-weight: 800; border-radius: 999px; padding: 0 10px; }
    .hot-pct.good { color: #15803d; background: #dcfce7; } .hot-pct.mid { color: #a16207; background: #fef9c3; } .hot-pct.bad { color: #b91c1c; background: #fee2e2; }
    .hot-amt { font-weight: 800; color: #047857; font-size: 13px; }
    .hot-who { font-size: 11px; color: #64748b; }
    /* 💲 Set giá */
    .pdlg { position: fixed; inset: 0; z-index: 2147483647; background: rgba(15,23,42,.35); display: grid; place-items: center; }
    .pdlg-wrap { display: flex; gap: 12px; align-items: flex-start; max-width: calc(100vw - 32px); max-height: calc(100vh - 40px); }
    .pdlg-hist { width: min(560px, calc(100vw - 440px)); max-height: calc(100vh - 40px); background: #fff; border-radius: 14px; padding: 12px 14px; box-shadow: 0 20px 50px rgba(15,23,42,.35); overflow: auto; font-size: 12px; }
    .ph-h { font-weight: 800; font-size: 14px; margin-bottom: 8px; }
    .ph-note { margin-bottom: 6px; }
    .ph-row { border: 1px solid #eef2f7; border-radius: 8px; padding: 6px 8px; margin-bottom: 6px; }
    .ph-row.me { border-color: #86efac; background: #f0fdf4; }
    .ph-top { display: flex; align-items: center; gap: 8px; }
    .ph-date { color: #64748b; font-variant-numeric: tabular-nums; }
    .ph-sup { font-weight: 700; color: #1d4ed8; }
    .ph-pct { margin-left: auto; border: 1px solid #bbf7d0; background: #f0fdf4; color: #166534; border-radius: 999px; padding: 0 8px; cursor: pointer; font: inherit; }
    .ph-pct:hover { background: #16a34a; color: #fff; }
    .ph-bg { margin-top: 2px; color: #334155; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @media (max-width: 900px) { .pdlg-wrap { flex-direction: column-reverse; overflow: auto; } .pdlg-hist { width: auto; } }
    .pdlg-card { flex: none; width: min(380px, calc(100vw - 32px)); background: #fff; border-radius: 14px; padding: 14px 16px; box-shadow: 0 20px 50px rgba(15,23,42,.35); display: grid; gap: 10px; align-content: start; align-self: flex-start; font-size: 13px; color: #1f2328; }
    .pdlg-h { display: flex; align-items: center; gap: 6px; font-weight: 800; font-size: 15px; }
    .pdlg-h .x { margin-left: auto; }
    .pdlg-q { font-weight: 600; }
    .pdlg-v b { font-size: 34px; font-weight: 800; color: #15803d; }
    .pdlg input[type=range] { width: 100%; accent-color: #16a34a; }
    .pdlg-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .pdlg-chips .act, .pdlg-btns .act { height: auto; padding: 4px 12px; }
    .pdlg-note { font-size: 12px; }
    .ps-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .ps-t { border: 1px solid #e2e8f0; border-radius: 10px; padding: 6px 8px; display: grid; gap: 1px; background: #f8fafc; }
    .ps-t span { font-size: 11px; color: #64748b; font-weight: 600; }
    .ps-t b { font-size: 16px; font-weight: 800; color: #0f172a; }
    .ps-t small { font-size: 11px; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ps-t.pos { border-color: #bbf7d0; background: #f0fdf4; } .ps-t.pos b { color: #15803d; }
    .ps-t.neg { border-color: #fecaca; background: #fef2f2; } .ps-t.neg b { color: #b91c1c; }
    .ps-est { margin-top: 6px; font-size: 12px; }
    .ps-t.bump { animation: psBump .55s ease-out; }
    .ps-t.bump b { animation: psFlash .7s ease-out; }
    @keyframes psBump { 0% { transform: scale(1); } 30% { transform: scale(1.05); box-shadow: 0 0 0 4px rgba(34,197,94,.25); } 100% { transform: scale(1); box-shadow: none; } }
    @keyframes psFlash { 0% { color: #2563eb; } 100% { } }
    .pdlg-rows:empty { display: none; }
    .bigtab.gap { background: linear-gradient(90deg,#fdf2f8,#eff6ff); }
    .gp { display: grid; gap: 8px; }
    .gp-h { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; font-size: 15px; }
    .gp-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .gp-chip { border: 1px solid #e2e8f0; background: #fff; border-radius: 999px; padding: 3px 12px; font: inherit; font-size: 12.5px; cursor: pointer; color: var(--c); }
    .gp-chip.on { background: var(--c); color: #fff; border-color: var(--c); }
    .gp-list { display: grid; gap: 3px; }
    .gp-row { display: grid; grid-template-columns: 30px 30px minmax(0,1fr) 90px 90px 96px; gap: 8px; align-items: center; padding: 5px 10px; border: 1px solid #eef2f7; border-radius: 8px; background: #fff; text-decoration: none; color: inherit; font-size: 12.5px; }
    .gp-row:hover { border-color: #c7d2fe; box-shadow: 0 2px 8px rgba(15,23,42,.06); }
    .gp-no { color: #94a3b8; font-weight: 800; text-align: right; }
    .gp-site { font-size: 10.5px; font-weight: 900; border-radius: 6px; text-align: center; padding: 1px 0; color: #fff; }
    .gp-site.tuantu { background: #dc2626; } .gp-site.daiduong { background: #2563eb; }
    .gp-main { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .gp-main b { color: #1d4ed8; } .gp-cust { font-weight: 700; color: #b45309; margin: 0 6px; } .gp-name { color: #64748b; }
    .gp-staff { color: #475569; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .gp-amt { text-align: right; font-weight: 800; color: #047857; font-variant-numeric: tabular-nums; }
    .gp-diff { text-align: right; }
    .gp-row.unread { font-weight: 700; background: #fffbeb; border-color: #fde68a; }
    .gp-row.unread .gp-main b::before { content: '●'; color: #ef4444; margin-right: 4px; }
    .gp-row.read { opacity: .6; } .gp-row.read:hover { opacity: 1; }
    .pr-line { grid-column: 2 / -1; display: flex; gap: 10px; font-size: 11px; color: #64748b; font-variant-numeric: tabular-nums; }
    .pr-line b { color: #0f172a; } .pr-line i { font-style: normal; color: #94a3b8; } .pr-line .pos b { color: #15803d; } .pr-line .neg b { color: #b91c1c; }
    .pr-tot { display: none; } /* trùng với 3 ô phía trên → ẩn (vẫn dùng để tính từng dòng) */
    .pdlg-wrap:has(.pdlg-rows:not(:empty)) { width: calc(100vw - 32px); }
    .pdlg-card:has(.pdlg-rows:not(:empty)) { flex: 1 1 auto; width: auto; min-width: 0; font-size: 14px; }
    .pdlg-card:has(.pdlg-rows:not(:empty)) .pdlg-rows { max-height: min(56vh, 620px); }
    .pdlg-card:has(.pdlg-rows:not(:empty)) .pr-row { font-size: 13px; padding: 5px 8px; }
    .pdlg-card:has(.pdlg-rows:not(:empty)) .pr-line { font-size: 12px; gap: 16px; }
    .pdlg-wrap:has(.pdlg-rows:not(:empty)) .pdlg-hist { flex: none; width: min(380px, 28vw); }
    .pdlg-rows { display: grid; gap: 4px; border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px; background: #f8fafc; max-height: 240px; overflow: auto; }
    .pr-h { font-weight: 800; font-size: 12px; margin-bottom: 2px; }
    .pr-row { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto auto; gap: 6px; align-items: center; background: #fff; border: 1px solid #eef2f7; border-radius: 8px; padding: 3px 6px; font-size: 12px; }
    .pr-row.own { border-color: #86efac; background: #f0fdf4; }
    .pr-no { color: #94a3b8; font-weight: 800; text-align: right; }
    .pr-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pr-cur { color: #64748b; font-variant-numeric: tabular-nums; }
    .pr-ctl { display: inline-flex; align-items: center; gap: 2px; }
    .pr-ctl .act { height: 22px; width: 22px; padding: 0; display: grid; place-items: center; border-radius: 6px; font-weight: 800; }
    .pr-ctl input { width: 38px; height: 22px; border: 1px solid #cbd5e1; border-radius: 6px; text-align: center; font: inherit; font-weight: 800; color: #15803d; padding: 0; }
    .pr-ctl b { color: #64748b; font-size: 11px; }
    .ps-est .pos { color: #15803d; }
    .pdlg-step { min-height: 18px; font-size: 12px; color: #4338ca; }
    .pdlg-btns { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
    .side-q { margin-top: 10px; padding-top: 10px; border-top: 1px solid #eef2f7; font-size: 13px; display: grid; gap: 10px; }
    .side-q > * { margin: 0 !important; }
    /* Thông tin báo giá ở đầu thẻ */
    .side-info { padding: 2px 0 10px; border-bottom: 1px solid #eef2f7; margin-bottom: 4px; }
    .si-name { font-size: 15px; font-weight: 700; color: #0f172a; line-height: 1.35; }
    .si-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; margin-top: 6px; font-size: 12px; color: #64748b; }
    .si-meta b { color: #334155; font-weight: 600; }
    .si-meta .dot { color: #cbd5e1; }
    .si-amt { margin-left: auto; font-weight: 800; font-size: 13px; color: #047857; }
    .si-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .si-tags > * { margin: 0 !important; font-size: 11px; }
    .side-h .kh { font-size: 11px; }
    .st-pill { font-size: 11px; font-weight: 600; color: #475569; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 999px; padding: 1px 8px; }
    /* Lợi nhuận: các ô số cạnh nhau */
    .mtiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-top: 4px; }
    .mtile { border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 10px; background: #fbfdff; }
    .mtile.flexo { border-color: #bfdbfe; background: #f5f9ff; }
    .mtile.offset { border-color: #e9d5ff; background: #fbf7ff; }
    .mt-l { font-size: 11px; font-weight: 700; color: #475569; }
    .mt-v { margin-top: 2px; min-height: 30px; display: flex; align-items: center; }
    .mt-v b { font-size: 24px; font-weight: 800; line-height: 1.1; }
    .mt-v b.good { color: #047857; } .mt-v b.bad { color: #b91c1c; }
    .mt-s { font-size: 11px; color: #64748b; }
    .mt-nvl { margin-top: 6px; font-size: 12px; color: #475569; }
    .mt-nvl b { color: #b45309; }
    tr.osteps td { font-size: 12px; }
    tr.osteps.warn-row td { color: #b45309; }
    .mt-diff { margin-top: 6px; padding: 6px 8px; border-radius: 8px; background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; }
    .mt-diff span { display: block; font-size: 10px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; opacity: .8; }
    .mt-diff b { display: block; font-size: 22px; font-weight: 800; line-height: 1.15; }
    .mt-diff.off { background: #f5f3ff; border-color: #ddd6fe; color: #5b21b6; }
    .mt-diff.neg { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
    .side-actions { display: grid !important; grid-template-columns: 1fr auto; gap: 8px; }
    .side-actions .act { justify-content: center; }
    .side-q .btns { flex-wrap: wrap; }
    .side-q .act.hero { font-size: 14px; padding: 8px 14px; }
    .side-q textarea { font-size: 13px; }
    .side table td, .side table th { white-space: normal; }
    .warnx { color: #b45309; font-weight: 700; font-size: 12px; }
    .pos { color: #047857; }
    .side-h { font-weight: 800; font-size: 14px; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; cursor: move; user-select: none; touch-action: none; }
    .side .side-grip { color: #94a3b8; font-size: 14px; }
    .side-btn.recalc-btn { margin-left: auto; width: auto; padding: 0 8px; font-weight: 700; color: #4338ca; }
    .side-btn.recalc-btn + .side-btn { margin-left: 4px; }
    .side-btn { margin-left: auto; border: 1px solid #e2e8f0; background: #f8fafc; border-radius: 6px; width: 24px; height: 22px; cursor: pointer; font-size: 12px; line-height: 1; }
    /* Nút thu gọn / mở thẻ: to, có chữ, dễ bấm */
    .side-btn.side-tg { width: auto; height: 32px; padding: 0 12px; border-radius: 999px; font-size: 13px; font-weight: 800; color: #4338ca; background: #eef2ff; border-color: #c7d2fe; white-space: nowrap; flex: none; }
    .side-btn.side-tg:hover { background: #6366f1; color: #fff; border-color: #6366f1; }
    .side.collapsed .side-btn.side-tg { height: 30px; background: #6366f1; color: #fff; border-color: #6366f1; }
    .side.collapsed { width: auto; padding: 8px 10px; }
    .side.collapsed .side-h { margin-bottom: 0; }
    /* Thẻ thu gọn: thật nổi bật – nền gradient, viền màu chạy, vòng sáng lan ra, lắc nhẹ mỗi vài giây */
    .side.collapsed { border: 3px solid transparent !important; border-radius: 16px !important; padding: 10px 14px !important;
      background: linear-gradient(135deg, #eef2ff, #fdf2f8 50%, #fff7ed) padding-box, linear-gradient(120deg, #6366f1, #ec4899, #f59e0b, #10b981, #6366f1) border-box !important;
      background-size: 100% 100%, 300% 300% !important;
      animation: dgSideBorder 2.5s linear infinite, dgSideGlow 1.4s ease-in-out infinite, dgSideWiggle 5s ease-in-out infinite !important; }
    .side.collapsed .side-h { font-size: 16px; }
    .side.collapsed:hover { animation-play-state: paused !important; transform: scale(1.06); }
    @keyframes dgSideBorder { 0% { background-position: 0 0, 0% 50%; } 100% { background-position: 0 0, 300% 50%; } }
    @keyframes dgSideGlow {
      0%, 100% { box-shadow: 0 8px 22px rgba(99,102,241,.35), 0 0 0 0 rgba(236,72,153,.55), 0 0 18px rgba(236,72,153,.35); }
      50% { box-shadow: 0 12px 34px rgba(99,102,241,.55), 0 0 0 14px rgba(236,72,153,0), 0 0 34px rgba(236,72,153,.6); } }
    @keyframes dgSideWiggle { 0%, 84%, 100% { transform: none; } 86% { transform: rotate(-4deg) scale(1.08); } 88% { transform: rotate(4deg) scale(1.08); }
      90% { transform: rotate(-3deg) scale(1.05); } 92% { transform: rotate(2deg); } 94% { transform: none; } }
    .side-mini { font-weight: 700; font-size: 13px; margin-left: 6px; }
    .side-mini b.good { color: #047857; } .side-mini b.bad { color: #b91c1c; }
    .calc { display: inline-flex; align-items: center; gap: 8px; }
    .calc-bar { position: relative; width: 90px; height: 6px; border-radius: 99px; background: #e0e7ff; overflow: hidden; }
    .calc-bar i { position: absolute; top: 0; bottom: 0; width: 40%; border-radius: 99px; background: linear-gradient(90deg, #60a5fa, #7c3aed); animation: dgbar 1.1s ease-in-out infinite; }
    .calc-step { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; color: #4338ca; background: #eef2ff; border-radius: 8px; padding: 6px 8px; }
    .calc-btn { width: auto; padding: 0 8px; margin-left: 6px; }
    .side.dragging { opacity: .85; box-shadow: 0 16px 40px rgba(15,23,42,.3); }
    .side-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
    .side-row b { font-size: 22px; font-weight: 800; }
    .side-row b.good { color: #047857; } .side-row b.bad { color: #b91c1c; }
    .side-d { margin-top: 6px; padding: 6px 8px; font-size: 12px; }
    .side-d summary { font-size: 12px; }
    .amt-pct { margin-top: 3px; font-size: 15px; font-weight: 700; color: #334155; }
    .amt-pct b.good { color: #047857; } .amt-pct b.bad { color: #b91c1c; }
    .amt-pct .muted { font-size: 11px; font-weight: 500; }
    .ncm { margin-left: 6px; display: inline-block; background: #f8fafc; color: #475569; border: 1px solid #cbd5e1; border-radius: 999px;
      padding: 1px 9px; font-size: 12px; font-weight: 800; vertical-align: 1px; }
    .cov { display: flex; align-items: center; gap: 10px; margin-top: 6px; font-size: 12px; color: #334155; }
    .cov-bar { flex: 0 0 220px; height: 8px; border-radius: 99px; background: #e2e8f0; overflow: hidden; }
    .cov-bar span { display: block; height: 100%; background: linear-gradient(90deg, #22c55e, #16a34a); border-radius: 99px; }
    a.item.q-unread .it-name, a.item.q-unread .it-who { font-weight: 700; }
    a.item.q-unread .it-code { font-weight: 900; }
    a.item.q-read .it-code, a.item.q-read .it-main, a.item.q-read .it-name, a.item.q-read .it-who { opacity: .78; }
    a.item.q-read .it-code { font-weight: 600; }
    .sortbtn { margin-left: 8px; font-size: 12px; }
    .x { border: 0; background: none; font-size: 18px; cursor: pointer; color: #656d76; }
  `;

  // Giữ vị trí cuộn của bảng qua F5 / mở lại. Danh sách được vẽ dần (dữ liệu tải sau),
  // nên cứ sau mỗi lần vẽ lại thử cuộn tới vị trí cũ cho tới khi đủ dài, hoặc người dùng tự cuộn.
  let scrollWanted = null;
  function restoreScroll() {
    if (scrollWanted == null || !isOpen()) return;
    const p = root.querySelector('.panel');
    p.scrollTop = scrollWanted;
    if (p.scrollHeight - p.clientHeight >= scrollWanted) scrollWanted = null;
  }
  let scrollTimer;
  function wantScroll() {
    scrollWanted = Number(lsGet('dgPanelScroll')) || null;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => (scrollWanted = null), 15000);
  }
  function wireScroll(p) {
    wantScroll();
    const stop = () => (scrollWanted = null);
    for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) p.addEventListener(ev, stop, { passive: true });
    let t;
    p.addEventListener('scroll', () => {
      if (scrollWanted != null) return; // đang khôi phục – không ghi đè bằng vị trí tạm
      clearTimeout(t);
      t = setTimeout(() => lsSet('dgPanelScroll', String(Math.round(p.scrollTop))), 200);
    });
  }

  function setPanelOpen(open) {
    root.querySelector('.panel').hidden = !open;
    try {
      localStorage.setItem('dgPanelOpen', open ? '1' : '0');
    } catch {}
    layoutPanel();
  }

  // Toàn màn hình (dgPanelFull) và độ rộng kéo tay (dgPanelW) – giữ qua F5
  const PANEL_LEFT = 16;
  function layoutPanel() {
    const p = root?.querySelector('.panel');
    const g = root?.querySelector('.grip');
    if (!p || !g) return;
    const full = lsGet('dgPanelFull') === '1';
    p.classList.toggle('full', full);
    const maxW = window.innerWidth - PANEL_LEFT * 2;
    const w = Math.min(maxW, Math.max(520, Number(lsGet('dgPanelW')) || Math.min(1760, maxW)));
    p.style.width = full ? '' : `${w}px`;
    g.hidden = p.hidden || full;
    g.style.left = `${PANEL_LEFT + w - 6}px`;
  }
  function wireGrip(g) {
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      g.classList.add('on');
      const move = (ev) => {
        const w = Math.round(Math.min(window.innerWidth - PANEL_LEFT * 2, Math.max(520, ev.clientX - PANEL_LEFT)));
        try {
          localStorage.setItem('dgPanelW', String(w));
        } catch {}
        layoutPanel();
      };
      const up = () => {
        g.classList.remove('on');
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', up);
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
    });
    g.addEventListener('dblclick', () => {
      try {
        localStorage.removeItem('dgPanelW'); // bấm đúp: về độ rộng mặc định
      } catch {}
      layoutPanel();
    });
    window.addEventListener('resize', layoutPanel);
  }

  // Lựa chọn giao diện (xếp, lọc, bung/thu gọn, toàn màn hình, độ rộng…) lưu thêm vào kho của extension:
  // CRM có lúc xoá localStorage → F5 bị mất; khi mở trang sẽ khôi phục lại từ kho.
  const UI_KEYS = ['dgDebtStaff', 'dgDealStaff', 'dgReport', 'dgWeekOff', 'dgWeekOpen', 'dgShowHiddenCust', 'dgTab', 'dgCustNoCur', 'dgStaff', 'dgHotCollapsed', 'dgSort', 'dgFilter', 'dgPanelOpen', 'dgPanelW', 'dgPanelFull', 'dgSidePos', 'dgSideCollapsed'];
  const uiSnapshot = () => JSON.stringify(Object.fromEntries(UI_KEYS.map((k) => [k, lsGet(k)])));
  let uiSaved = null;
  async function restoreUiPrefs() {
    const saved = await kvGet('uiPrefs').catch(() => ({}));
    const before = uiSnapshot();
    for (const k of UI_KEYS) if (saved[k] != null && lsGet(k) == null) lsSet(k, saved[k]);
    uiSaved = uiSnapshot();
    if (uiSaved !== before) {
      state.filter = lsGet('dgFilter') || '';
      if (lsGet('dgPanelOpen') === '1') root.querySelector('.panel').hidden = false;
      layoutPanel();
      render();
    }
    setInterval(() => {
      const now = uiSnapshot();
      if (now === uiSaved) return;
      uiSaved = now;
      kvMerge('uiPrefs', JSON.parse(now)).catch(() => {});
    }, 1500);
  }

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'dg-root';
    document.documentElement.append(host);
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><button class="fab">📊 Trợ lý ERP</button><div class="panel" hidden></div><div class="grip" hidden title="Kéo để dãn / thu hẹp · bấm đúp để về mặc định"></div><div class="side" hidden></div>`;
    wireGrip(root.querySelector('.grip'));
    root.querySelector('.fab').onclick = () => {
      const open = root.querySelector('.panel').hidden;
      setPanelOpen(open);
      if (open) {
        wantScroll();
        render();
      }
    };
    wireScroll(root.querySelector('.panel'));
    if (IS_TOP) watchHandoverDom();
    // Giữ trạng thái bung / thu gọn của bảng qua F5
    if (lsGet('dgPanelOpen') === '1') {
      root.querySelector('.panel').hidden = false;
      render();
    }
    layoutPanel();
    restoreUiPrefs();
    root.querySelector('.panel').addEventListener('click', onClick);
    // Trình soạn bộ câu hỏi: giữ con trỏ khi bấm nút chèn biến; cập nhật xem trước khi gõ; Enter = thêm câu
    const pnl = root.querySelector('.panel');
    pnl.addEventListener('mousedown', (e) => {
      if (e.target.closest('.qe-add, .qv')) e.preventDefault();
    });
    pnl.addEventListener('input', (e) => {
      const line = e.target.closest?.('.qe-line');
      if (line) qePreview(line);
    });
    pnl.addEventListener('keyup', qeRemember);
    pnl.addEventListener('mouseup', qeRemember);
    pnl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.closest?.('.qe-line')) {
        e.preventDefault();
        e.target.closest('.qe')?.querySelector('.qe-new')?.click();
      }
    });
    wireSide(root.querySelector('.side'));
    root.addEventListener('input', (e) => e.target.matches?.('textarea.quick-text') && fitText(e.target));
    // Ô câu hỏi trong thẻ bên phải: lưu nháp (bảng lớn đã có bộ lưu riêng)
    let sideDraftTimer;
    root.querySelector('.side').addEventListener('input', (e) => {
      const qe = e.target.closest('textarea.quick-edit');
      if (!qe) return;
      clearTimeout(sideDraftTimer);
      sideDraftTimer = setTimeout(() => {
        const id = Number(qe.dataset.id);
        kvMerge('quickDraft', { [id]: { base: quickCtx[id]?.base, text: qe.value } });
      }, 400);
    });
    // Phòng khi khung ẩn vẫn lấy mất focus: đang gõ trong ô của bảng/thẻ mà focus nhảy vào khung ẩn → trả lại
    let typingIn = null;
    root.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'TEXTAREA') typingIn = { ta: e.target, at: Date.now() };
    }, true);
    root.addEventListener('focusout', (e) => {
      const ta = e.target;
      if (ta.tagName !== 'TEXTAREA' || !typingIn || typingIn.ta !== ta || Date.now() - typingIn.at > 5000) return;
      const { selectionStart, selectionEnd } = ta;
      setTimeout(() => {
        if (document.activeElement?.tagName === 'IFRAME' && document.activeElement.name === 'dg-collector' && ta.isConnected) {
          ta.focus();
          ta.setSelectionRange(selectionStart, selectionEnd);
        }
      }, 0);
    });
    resumeLoading();
    maybeAutoOpen();
    let saveTimer;
    root.querySelector('.side').addEventListener('click', onClick);
    root.querySelector('.side').addEventListener(
      'toggle',
      (e) => {
        if (e.target.matches?.('details.side-d')) lsSet('dgExplOpen', e.target.open ? '1' : '0');
      },
      true,
    );
    // Thử giá Offset trong bảng Giải thích
    root.querySelector('.side').addEventListener('input', (e) => {
      const rg = e.target.closest?.('input.osim-range');
      if (rg) {
        // Kéo tỷ lệ NVL / đơn giá → giá 1 thùng mỗi sản phẩm = NVL 1 thùng ÷ tỷ lệ (làm tròn lên 5đ)
        const r = 1 - Number(rg.value) / 100; // thanh kéo là % bán → tỷ lệ NVL / đơn giá
        const tb = rg.closest('table');
        state.offSim = state.offSim || {};
        const sv = { ...(state.offSim[rg.dataset.code] || {}) };
        for (const ip of tb.querySelectorAll('input.osim')) {
          const unit = Number(ip.dataset.nvl) / Number(ip.dataset.qty);
          const price = Math.ceil(unit / r / 5) * 5;
          ip.value = price.toLocaleString('vi-VN');
          if (price === Number(ip.dataset.orig)) delete sv[ip.dataset.key];
          else sv[ip.dataset.key] = price;
        }
        state.offSim[rg.dataset.code] = sv;
        osimCalc(tb);
        return;
      }
      const inp = e.target.closest?.('input.osim');
      if (!inp) return;
      const code = inp.dataset.code;
      state.offSim = state.offSim || {};
      const v = numOf(inp.value);
      state.offSim[code] = { ...(state.offSim[code] || {}), [inp.dataset.key]: v };
      if (v === Number(inp.dataset.orig)) delete state.offSim[code][inp.dataset.key];
      osimCalc(inp.closest('table'));
    });
    root.querySelector('.side').addEventListener('focusout', (e) => {
      const inp = e.target.closest?.('input.osim');
      if (inp && numOf(inp.value)) inp.value = numOf(inp.value).toLocaleString('vi-VN');
    });
    let searchTimer;
    let rpTimer;
    const onInput = (e) => {
      const rp = e.target.closest('textarea.rp-text');
      if (rp) {
        clearTimeout(rpTimer);
        rpTimer = setTimeout(async () => {
          const key = rp.dataset.key;
          const cur = (await kvGet('reports'))[key] || { items: {} };
          cur.items = { ...(cur.items || {}), [rp.dataset.cid]: { comment: rp.value, at: Date.now(), by: meName } };
          await kvMerge('reports', { [key]: cur });
        }, 500);
        return;
      }
      const se = e.target.closest('input.dg-search');
      if (se) {
        state.search = se.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(async () => {
          await render();
          // Vẽ lại xong → đặt lại con trỏ vào ô tìm
          const el = root.querySelector('input.dg-search');
          if (el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        }, 250);
        return;
      }
      const qe = e.target.closest('textarea.quick-edit');
      if (qe) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          const id = Number(qe.dataset.id);
          kvMerge('quickDraft', { [id]: { base: quickCtx[id]?.base, text: qe.value } });
        }, 400);
        return;
      }
      const he = e.target.closest('textarea.handover-edit');
      if (he) {
        state.handoverDraft[he.dataset.key] = he.value;
        return;
      }
      const ta = e.target.closest('textarea.suggest-edit');
      if (!ta) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const id = Number(ta.dataset.id);
        const cur = (await kvGet('suggests'))[id] || {};
        await kvMerge('suggests', { [id]: { ...cur, text: ta.value } });
      }, 500);
    };
    root.querySelector('.panel').addEventListener('input', onInput);
    root.querySelector('.side').addEventListener('input', onInput);
    render();
  }

  // Hiệu ứng chờ khi mở báo giá từ bảng
  // Thẻ "Đang mở báo giá": số báo giá to nhất, tên cơ hội, khách hàng, NVKD + hiệu ứng
  function showLoading(code, q) {
    if (/^\/login\b/.test(location.pathname)) return;
    let el = root.querySelector('.loading');
    if (!el) {
      el = document.createElement('div');
      el.className = 'loading';
      root.append(el);
    }
    const staff = q?.staff?.name;
    el.innerHTML = `
      <div class="lcard">
        <div class="lbar"><span></span></div>
        <div class="ltop"><span class="spinner"></span><span class="llabel">Đang mở báo giá</span></div>
        <div class="lcode">${esc(code || 'Báo giá')}</div>
        ${q?.name ? `<div class="lname">${esc(q.name)}</div>` : ''}
        ${q?.customer?.name || q?.customer?.code
          ? `<div class="lcust"><span class="licon">🏢</span><div class="lcust-body"><div class="lcust-label">Khách hàng${custTag(q)}</div><div class="lcust-name" title="${esc(q.customer.name || '')}">${esc(shortCompany(q.customer.name) || q.customer.code)}</div></div></div>`
          : ''}
        ${staff ? `<div class="lstaff">${avatarHtml(staff, 22)}<span>${esc(staff)}</span>${q?.quoteStatus ? `<span class="lstatus">${esc(statusLabel(q.quoteStatus))}</span>` : ''}</div>` : ''}
      </div>`;
    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth; // chạy lại hiệu ứng
    el.classList.add('show');
  }
  const hideLoading = () => {
    const el = root?.querySelector('.loading');
    if (el) el.hidden = true;
  };

  // Trang vừa được tải hẳn từ link trong bảng → hiện tiếp thẻ "Đang mở báo giá" tới khi app hiện báo giá
  function resumeLoading() {
    let nav = null;
    try {
      nav = JSON.parse(sessionStorage.getItem('dgNav') || 'null');
      sessionStorage.removeItem('dgNav');
    } catch {}
    if (!nav || Date.now() - nav.at > 30000 || location.pathname !== nav.href) return;
    if (nav.q?.staff?.avatar) avatars[nav.q.staff.name] = nav.q.staff.avatar;
    showLoading(nav.code, nav.q);
    const t0 = Date.now();
    const timer = setInterval(() => {
      if ((nav.code && document.title.includes(nav.code)) || Date.now() - t0 > 20000) {
        clearInterval(timer);
        hideLoading();
      }
    }, 150);
  }

  const isOpen = () => root && !root.querySelector('.panel').hidden;

  function setBusy(key, on) {
    on ? state.busy.add(key) : state.busy.delete(key);
    if (on) state.error = null;
    render();
  }

  // Avatar NVKD: ảnh trên server CRM (cổng 8080), không có thì hiện chữ cái đầu
  const avatarUrl = (a) => (!a ? '' : /^https?:/.test(a) ? a : `${API_BASE}/${a.replace(/^\/+/, '')}`);
  const avatarIndex = (quotes) => {
    const m = {};
    for (const q of Object.values(quotes)) if (q.staff?.name && q.staff.avatar) m[q.staff.name] = q.staff.avatar;
    return m;
  };
  let avatars = {};
  const avatarHtml = (name, size = 22) => {
    const url = avatarUrl(avatars[name]);
    const initials = (name || '?').split(/\s+/).slice(-1)[0].slice(0, 1).toUpperCase();
    return url
      ? `<img class="ava" src="${esc(url)}" alt="" style="width:${size}px;height:${size}px" data-ini="${esc(initials)}">`
      : `<span class="ava ini" style="width:${size}px;height:${size}px">${esc(initials)}</span>`;
  };

  // Nhãn mã khách hàng (vd. "NPT VH"), di chuột để xem tên đầy đủ
  // Nhận diện bình luận "khách cho giá" / "làm được không" (khách đưa giá mục tiêu, hỏi bên mình làm được không)
  // Gồm: "làm (giá này) được không", "là được giá này không", "deal", "khách cho/báo/trả giá…", "giá mục tiêu"
  const TARGET_PRICE_RE =
    /(làm|lam|là|la)\s*((giá|gia)\s*(này|nay|đó|do|vậy|vay)\s*)?(được|duoc|đc|dc)\s*((giá|gia)\s*(này|nay|đó|do)\s*)?(không|khong|ko|k)\b|\bdeal\b|(khách|kh|khach)\s*(hàng\s*)?(cho|báo|bao|đưa|dua|chào|chao|muốn|muon|chốt|chot|trả|tra)\s*(giá|gia)(?![\p{L}])|giá\s*(mục tiêu|khách mong muốn|mong muốn|khách muốn|target)|target\s*price/iu;
  function targetPriceInfo(c) {
    let hit = null;
    const walk = (t) => {
      const txt = t.text || '';
      if (t.staff?.name !== meName && TARGET_PRICE_RE.test(txt)) {
        if (!hit || t.createdAt > hit.createdAt) hit = t;
      }
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    if (!hit) return null;
    // Mức giá nếu có: "3.500đ", "3500 đ/thùng", "3,5k", "3.500/thùng"
    const m = hit.text.match(/(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?\s*k\b|\d{3,})\s*(đ|vnđ|vnd|\/\s*(thùng|hộp|cái|tấm))?/i);
    return { at: hit.createdAt, by: hit.staff?.name, text: hit.text, price: m ? m[0].trim() : '' };
  }
  const targetTag = (c) => {
    const t = targetPriceInfo(c);
    return t
      ? ` <span class="tgt" title="${esc(`${t.by || ''}: ${t.text}`.slice(0, 300))}">💲 Khách cho giá${t.price ? ` ${esc(t.price)}` : ''}</span>`
      : '';
  };

  // Nhận diện "giá cao / chưa được giá" (khách chê giá, bên khác rẻ hơn…) – chỉ xét lời NVKD
  const HIGH_PRICE_RE =
    /(giá|gia)\s*(bên\s*)?(mình|minh|em|mình\s*báo)?\s*(hơi\s*|còn\s*|quá\s*|khá\s*|rất\s*)?(cao|đắt|mắc)|chê\s*(giá\s*)?(cao|đắt|mắc)|(cao|đắt|mắc)\s*(quá|hơn)|chưa\s*(được|đc|dc|tới|đạt|tốt)\s*(giá|gia)(?![\p{L}])|(giá|gia)\s*(vẫn\s*)?chưa\s*(được|đc|dc|tới|đạt|tốt)|(rẻ|re)\s*hơn|bên\s*kia\s*(rẻ|re)|(khách|chị|anh|bên\s*đó|bên\s*kia|họ|sếp\s*bên\s*đó)\s*(báo|nói|kêu|chê|thấy|phản\s*hồi)\s*(là\s*)?(giá\s*)?(hơi\s*|quá\s*|còn\s*)?(cao|đắt|mắc)|(giá|gia)\s*(chưa|không|ko|k)\s*(cạnh\s*tranh|hợp\s*lý|ổn)/iu;
  function highPriceInfo(c) {
    let hit = null;
    const walk = (t) => {
      if (t.staff?.name !== meName && HIGH_PRICE_RE.test(t.text || '') && (!hit || t.createdAt > hit.createdAt)) hit = t;
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    return hit ? { at: hit.createdAt, by: hit.staff?.name, text: hit.text } : null;
  }
  const highPriceTag = (c) => {
    const t = highPriceInfo(c);
    return t ? ` <span class="hip" title="${esc(`${t.by || ''}: ${t.text}`.slice(0, 300))}">💸 Giá cao</span>` : '';
  };

  // Loại hàng của báo giá: Flexo / Offset / cả hai
  const kindOf = (q) => {
    const k = q?.kinds || (q?.offset ? ['offset'] : []);
    return k.includes('offset') && k.includes('flexo') ? 'both' : k.includes('offset') ? 'offset' : k.includes('flexo') ? 'flexo' : null;
  };
  const KIND_LABEL = { flexo: '🟦 Flexo', offset: '🟪 Offset', both: '🟦🟪 Flexo + Offset' };
  const kindTag = (q) => {
    const k = kindOf(q);
    return k ? ` <span class="knd ${k}">${KIND_LABEL[k]}</span>` : '';
  };

  // "Đang bán (X%)" từ bảng chiết giá Offset (Ctrl+Shift+G) – thấp nhất trong các sản phẩm của báo giá
  // Flexo: tỉ lệ giấy tấm (nhà cung cấp rẻ nhất) trên tổng giá trị báo giá; phần còn lại = 100% − tỉ lệ đó
  // Số tiền dạng triệu: 1.234.567 → "1,23 tr"
  const trM = (v) => `${(v / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tr`;
  // Báo giá vừa Flexo vừa Offset: chỉ lấy phần thành tiền của loại đang tính (tỉ trọng từ các dòng sản phẩm)
  // Phần tiền của 1 loại hàng: ưu tiên "Tổng tiền" các dòng loại đó đọc từ bảng sản phẩm (kindTotals),
  // không có thì chia theo tỉ trọng thành tiền (kindShare) – chỉ khi báo giá có từ 2 loại / có dòng khác
  const kindTotalsOf = (q) => renderCtx.margins?.[q?.code]?.kindTotals;
  const kindPart = (q, kind, total) => {
    const kt = kindTotalsOf(q);
    if (kt?.[kind] && (kt.flexo && kt.offset || kt.other)) return kt[kind];
    return total && q?.kindShare?.[kind] ? total * q.kindShare[kind] : total;
  };
  const flexoInfo = (q) => {
    const fx = q?.code && renderCtx.margins?.[q.code]?.flexo;
    // Tổng báo giá vừa đổi → dùng tổng mới ngay trong lúc chờ đọc lại PO
    const base = kindPart(q, 'flexo', flexoAmountChanged(fx, q) ? q.amount : fx?.quoteTotal || q?.amount);
    if (!fx?.suppliers?.length || !base) return null;
    // Mỗi nhà cung cấp lo giấy tấm cho các sản phẩm khác nhau → chi phí giấy tấm = TỔNG PO của các nhà cung cấp.
    // Chỉ lấy NCC giấy của sản phẩm Flexo (cột Kết cấu giấy); NCC giấy của sản phẩm Offset (vd. VS) không tính vào Flexo.
    const fxSup = kindTotalsOf(q)?.flexoSup?.length ? kindTotalsOf(q).flexoSup : q?.kindSup?.flexo || [];
    const own = fxSup.length ? fx.suppliers.filter((s) => fxSup.includes(s.code)) : [];
    const sups = own.length ? own : fx.suppliers;
    const skipped = own.length ? fx.suppliers.filter((s) => !fxSup.includes(s.code)) : [];
    const sum = sups.reduce((a, s) => a + (s.total || 0), 0);
    const best = { code: sups.map((s) => s.code).join(' + '), total: sum };
    const cost = Math.round((sum / base) * 1000) / 10;
    // PO giấy tấm lớn hơn cả giá trị báo giá (thường do số lượng tấm tối thiểu / MOQ) → không tính %
    const missing = fx.missing || [];
    const diff = base - sum; // chênh lệch tổng đơn – giấy tấm (âm = giấy tấm vượt báo giá)
    if (cost > 100) return { best, cost, rest: null, invalid: true, base, diff, suppliers: sups, skipped, missing, at: fx.at };
    return { best, cost, rest: Math.round((100 - cost) * 10) / 10, base, diff, suppliers: sups, skipped, missing, at: fx.at };
  };
  const marginOf = (q) => {
    // % thấp nhất giữa Flexo (còn lại sau giấy tấm) và Offset (1 − NVL sau VAT ÷ BG) – cùng cách tính với thẻ
    const { flexo, offset } = marginParts(q);
    const vals = [];
    if (offset != null) vals.push(offset);
    if (flexo && flexo.rest != null) vals.push(flexo.rest);
    return vals.length ? Math.min(...vals) : null;
  };
  const marginTag = (q) => {
    const pct = marginOf(q);
    if (pct == null) return '';
    const items = Object.entries(renderCtx.margins[q.code].products || {}).map(([spec, x]) => `${spec}: ${x.pct}%${x.price ? ` (${x.price})` : ''}`);
    const fx = flexoInfo(q);
    if (fx && !fx.invalid) items.push(`Flexo – giấy tấm ${fx.cost}% (${fx.best.code}), còn ${fx.rest}%`);
    return ` <span class="mgn ${pct < 30 ? 'low' : ''}" title="${esc(items.join('\n'))}">📈 ${pct}%</span>`;
  };

  // Nhận diện bình luận xin công nợ (thanh toán sau, gối đầu, CN 30 ngày…) – chỉ xét lời NVKD
  const CREDIT_RE =
    /công\s*nợ|cong\s*no(?![\p{L}])|\bcn\s*\d+\s*(ngày|ngay|n)\b|nợ\s*\d+\s*(ngày|ngay)|thanh\s*toán\s*(sau|chậm|trả\s*chậm)|trả\s*sau|gối\s*đầu|goi\s*dau|net\s*\d+/iu;
  function creditInfo(c) {
    let hit = null;
    const walk = (t) => {
      if (t.staff?.name !== meName && CREDIT_RE.test(t.text || '') && (!hit || t.createdAt > hit.createdAt)) hit = t;
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    if (!hit) return null;
    return { at: hit.createdAt, by: hit.staff?.name, text: hit.text, days: (hit.text.match(/(\d{1,3})\s*(ngày|ngay)/i) || [])[1] || '' };
  }
  const creditTag = (c) => {
    const t = creditInfo(c);
    return t ? ` <span class="crd" title="${esc(`${t.by || ''}: ${t.text}`.slice(0, 300))}">🧾 Xin công nợ${t.days ? ` ${t.days} ngày` : ''}</span>` : '';
  };

  // Khách hứa lên đơn ("nếu ok thì lên đơn luôn", "tuần sau đặt hàng", "khách sẽ chốt đơn"…) mà báo giá chưa có đơn
  const PROMISE_RE =
    /(lên|len|đặt|dat|chốt|chot|xuống|xuong|ra)\s*(đơn|don)(?![\p{L}])|hứa\s*(lên|đặt|chốt|lấy)|(sẽ|se)\s*(lên|đặt|chốt|lấy)\s*(đơn|hàng)|(thứ\s*\d|tuần\s*sau|ngày\s*mai|mai)[^.!?]{0,50}(lên|đặt|chốt|lấy)\s*(đơn|hàng)|(khách|kh)\s*(hàng\s*)?(đã\s*)?(báo\s*|bảo\s*|nói\s*)?(ok|oke|okie|okela|okay|đồng\s*ý|chịu|chốt)\s*(hết|rồi|r|giá|luôn|đơn)(?![\p{L}])/iu;
  function promiseInfo(q, c) {
    if (q?.hasOrder || hasOrder(q, c) || CLOSED.has(q?.quoteStatus)) return null;
    let hit = null;
    const walk = (t) => {
      if (t.staff?.name !== meName && PROMISE_RE.test(t.text || '') && (!hit || t.createdAt > hit.createdAt)) hit = t;
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    return hit ? { at: hit.createdAt, by: hit.staff?.name, text: hit.text } : null;
  }
  const promiseTag = (q, c) => {
    const t = promiseInfo(q, c);
    return t ? ` <span class="prm" title="${esc(`${t.by || ''}: ${t.text}`.slice(0, 300))}">🤝 Hứa lên đơn</span>` : '';
  };

  // Cắt mẫu / làm mẫu / chạy mẫu / gửi mẫu… (mọi người trong luồng) + đã thành đơn hàng chưa
  const SAMPLE_RE = /(cắt|cat|làm|chạy|chay|gửi|gui|lấy|lay|in|đi|bế)\s*(thử\s*|thu\s*|lại\s*)?(mẫu|mau)(?![\p{L}])|(mẫu|mau)\s*(cắt|cat|thử|thu)(?![\p{L}])|sample/iu;
  function sampleInfo(c) {
    let hit = null;
    const walk = (t) => {
      if (SAMPLE_RE.test(t.text || '') && (!hit || t.createdAt > hit.createdAt)) hit = t;
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    return hit ? { at: hit.createdAt, by: hit.staff?.name, text: hit.text } : null;
  }
  // Báo giá đã thành đơn: có đơn Misa / dòng "lên đơn hàng" / đơn trong lịch sử mua hàng trỏ về báo giá này
  const isOrdered = (q, c) => CLOSED.has(q?.quoteStatus) || /^\s*SO\s*\d+/i.test(q?.name || '') || hasOrderFull(q, c);
  const hasOrderFull = (q, c) =>
    !!(q?.hasOrder || hasOrder(q, c) || (q?.customer?.id && renderCtx.orders?.[q.customer.id]?.orders?.some((o) => o.quote === q.code)));
  const sampleTag = (q, c) => {
    const t = sampleInfo(c);
    if (!t) return '';
    const ordered = hasOrderFull(q, c);
    return ` <span class="smp ${ordered ? 'ok' : ''}" title="${esc(`${t.by || ''}: ${t.text}`.slice(0, 300))}">✂️ Cắt mẫu${ordered ? ' → có đơn' : ''}</span>`;
  };

  // Khách đang làm hợp đồng
  const CONTRACT_RE = /hợp\s*đồng|hop\s*dong(?![\p{L}])|(làm|lam|ký|ky|gửi|gui|soạn|duyệt)\s*(HĐ|hđ)(?![\p{L}])|\bHĐ\s*(nguyên tắc|mua bán|khung)/iu;
  function contractInfo(c) {
    let hit = null;
    const walk = (t) => {
      if (CONTRACT_RE.test(t.text || '') && (!hit || t.createdAt > hit.createdAt)) hit = t;
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    return hit ? { at: hit.createdAt, by: hit.staff?.name, text: hit.text } : null;
  }
  // Sếp đã cho lấy đơn / chốt đơn trong bình luận (và chưa có đơn) → nhãn "✅ Lấy đơn"
  const bossOkInfo = (q, c) => (!q || hasOrderFull(q, c) ? null : bossOrderInfo(c));
  const bossOkTag = (q, c) => {
    const t = bossOkInfo(q, c);
    if (!t) return '';
    const keep = KEEP_PRICE_RE.test(t.text || '');
    return ` <span class="bok${keep ? ' reo' : ''}" title="${esc(`${t.staff?.name || ''}: ${t.text}`.slice(0, 300))} · ${ago(t.createdAt)}">${keep ? '🔁 Tái đơn' : '✅ Lấy đơn'}</span>`;
  };
  // Có sản phẩm giá giấy tấm 0đ/m2 → chưa có giá giấy tấm (Flexo chưa chính xác)
  const noSheetTag = (q) => (q?.noSheet ? ` <span class="nosheet" title="Có ${q.noSheetN || ''} dòng sản phẩm giá giấy tấm 0đ/m2 – cần cập nhật giá giấy tấm">😡 Chưa có giá giấy tấm</span>` : '');
  const contractTag = (c) => {
    const t = contractInfo(c);
    return t ? ` <span class="ctr" title="${esc(`${t.by || ''}: ${t.text}`.slice(0, 300))}">📝 Hợp đồng</span>` : '';
  };

  // Nhận diện khách chưa / không chịu cọc
  const NO_DEPOSIT_RE = /(chưa|chua|không|khong|ko|k|hông|chẳng)\s*(chịu\s*|muốn\s*|đồng ý\s*|dong y\s*)?(đặt\s*|dat\s*)?(cọc|coc)\b|(cọc|coc)\s*(chưa|không|khong|ko)\b/i;
  function noDepositInfo(c) {
    let hit = null;
    const walk = (t) => {
      // chỉ xét lời NVKD báo lại (câu hỏi "cọc chưa em?" của quản lý không tính)
      if (t.staff?.name !== meName && NO_DEPOSIT_RE.test(t.text || '') && (!hit || t.createdAt > hit.createdAt)) hit = t;
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    return hit ? { at: hit.createdAt, by: hit.staff?.name, text: hit.text } : null;
  }
  const noDepositTag = (c) => {
    const t = noDepositInfo(c);
    return t ? ` <span class="nodep" title="${esc(`${t.by || ''}: ${t.text}`.slice(0, 300))}">🚫 Chưa cọc</span>` : '';
  };

  // Lịch sử mua hàng của khách (từ trang khách hàng → đơn hàng)
  function orderSummary(od) {
    if (!od?.orders) return null;
    const list = [...od.orders].sort((a, b) => b.at - a.at);
    const total = list.reduce((a, o) => a + orderAfterVat(o), 0); // sau VAT
    const year = list.filter((o) => hoursSince(o.at) <= 365 * 24);
    return { count: od.total ?? list.length, total, year: year.length, yearTotal: year.reduce((a, o) => a + orderAfterVat(o), 0), last: list[0], list };
  }
  function ordersText(od) {
    const s = orderSummary(od);
    if (!s) return 'Lịch sử mua hàng: chưa có dữ liệu.';
    if (!s.count) return 'Lịch sử mua hàng: khách CHƯA từng mua đơn nào.';
    const lines = s.list.slice(0, 10).map((o) => `- ${o.code} ${fmtTime(o.at)} (báo giá ${o.quote || '?'}, ${o.status || ''})${o.total ? ` ${money(o.total)}` : ''}: ${o.lines.map((l) => `${l.name || l.product} x${l.qty}`).join('; ').slice(0, 200)}`);
    return `Lịch sử mua hàng: ${s.count} đơn${s.total ? `, tổng ${money(s.total)}` : ''}; 12 tháng gần đây ${s.year} đơn${s.yearTotal ? ` (${money(s.yearTotal)})` : ''}.\n${lines.join('\n')}`;
  }

  // Báo giá 0đ = quản lý chưa cho giá
  const noPrice = (q) => q != null && q.amount != null && Number(q.amount) === 0;
  const noPriceTag = (q) => (noPrice(q) ? ' <span class="noprice">⚠️ Chưa cho giá</span>' : '');

  // Khách chưa từng lên đơn (đã có dữ liệu lịch sử mua hàng, 0 đơn) → mã khách xám tro, gạch ngang
  const custNoOrder = (q) => {
    const od = q?.customer?.id && renderCtx.orders?.[q.customer.id];
    return !!od && orderSummary(od)?.count === 0;
  };
  const custTag = (q) => {
    if (!q?.customer?.code) return '';
    const none = custNoOrder(q);
    return ` <span class="kh${none ? ' none' : ''}" title="${esc(q.customer.name || '')}${none ? ' · khách chưa lên đơn nào' : ''}">${esc(q.customer.code)}</span>`;
  };

  // Xưng hô với NVKD: đoán từ các bình luận cũ của quản lý gửi chính NVKD đó (chị / anh / em)
  function addressFor(staff, comments, quotes) {
    if (!staff) return 'em';
    // Quản lý hay tự xưng ở đầu câu ("A cho em…", "E cho chị…") và gọi NVKD ở phía sau,
    // nên lấy đại từ (chị/anh/em) xuất hiện CUỐI CÙNG trong mỗi bình luận làm cách gọi NVKD.
    const votes = { chị: 0, anh: 0, em: 0 };
    for (const c of Object.values(comments)) {
      if (staffOf(quotes[c.id], c) !== staff) continue;
      const walk = (t) => {
        if (t.staff?.name === meName) {
          const words = (t.text || '').toLowerCase().match(/[\p{L}]+/gu) || [];
          const last = [...words].reverse().find((w) => w in votes);
          if (last) votes[last]++;
        }
        (t.children || []).forEach(walk);
      };
      (c.threads || []).forEach(walk);
    }
    const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    return best[1] > 0 ? best[0] : 'em';
  }

  // 50 cách hỏi "giá cả đạt chưa" cho tự nhiên ({p} = xưng hô NVKD, {P} = viết hoa) + 10 câu mở đầu khi im lặng lâu
  const PRICE_ASK = [
      "Giá cả đạt chưa {p}?",
      "Giá này khách thấy đạt chưa {p}?",
      "Giá ok với khách chưa {p}?",
      "Khách chịu giá này chưa {p}?",
      "Giá mình báo khách thấy sao rồi {p}?",
      "Khách phản hồi giá thế nào rồi {p}?",
      "Báo giá này khách ưng giá chưa {p}?",
      "Giá có vừa ý khách không {p}?",
      "Khách duyệt giá chưa {p}?",
      "Giá đã chốt được với khách chưa {p}?",
      "Mức giá này khách đồng ý chưa {p}?",
      "Khách xem giá xong nói sao {p}?",
      "Giá này có cạnh tranh được không {p}, khách nói gì?",
      "Khách có ý vướng về giá không {p}?",
      "Giá ổn chưa {p}, báo cáo lại deal này",
      "{P} ơi giá này khách ok chưa?",
      "{P} ơi khách phản hồi giá chưa?",
      "{P} check lại giúp anh, giá này khách đạt chưa?",
      "Giá anh duyệt khách thấy được không {p}?",
      "Khách có chịu mức giá này không {p}?",
      "Khách phản hồi báo giá chưa {p}",
      "Khách có cần mình điều chỉnh giá không {p}?",
      "Giá đã hợp với khách chưa {p}?",
      "Khách có chốt theo giá này không {p}?",
      "Đơn này giá đạt chưa {p}?",
      "Đơn này khách phản hồi giá sao rồi {p}?",
      "Giá này đi được chưa {p}?",
      "Khách gật giá chưa {p}?",
      "Giá có vướng gì không {p}?",
      "Khách thấy giá cao hay ổn {p}?",
      "Giá báo khách rồi, khách nói gì {p}?",
      "{P} cập nhật giúp anh tình hình giá với khách nhé.",
      "Giá đạt chưa {p}, có cần anh tính lại không?",
      "Khách ok giá thì mình lên đơn luôn nhé {p}, khách nói sao rồi?",
      "Báo giá này tình hình sao rồi {p}, giá đạt không?",
      "Khách đã trả lời về giá chưa {p}?",
      "Giá mình đưa có làm khách hài lòng không {p}?",
      "Khách có nhận giá này không {p}?",
      "Giá này khách thấy hợp lý chưa {p}?",
      "Có tin gì từ khách về giá chưa {p}?",
      "Khách đã xem báo giá chưa {p}, thấy giá sao?",
      "Giá này khách có kêu gì không {p}?",
      "Giá ổn rồi thì chốt đơn luôn nhé {p}, khách nói sao?",
      "{P} hỏi lại khách giúp anh giá đạt chưa nhé.",
      "Giá này với khách được không {p}?",
      "Khách bên này chịu giá chưa {p}?",
      "Giá cả khách thấy sao rồi {p}, có cần hỗ trợ gì không?",
      "Khách duyệt báo giá chưa {p}?",
      "Giá có đúng kỳ vọng của khách không {p}?",
      "Khách phản hồi gì về giá chưa {p}, báo anh biết nhé."
  ];
  const SILENT_LEAD = [
      "{d} chưa có phản hồi, báo cáo lại nhé {p}. ",
      "{d} rồi chưa thấy cập nhật, báo cáo lại nhé {p}. ",
      "Đã {d} chưa có tin, cập nhật giúp anh nhé {p}. ",
      "{d} im lặng rồi {p}, báo cáo lại nhé. ",
      "{d} chưa có phản hồi gì, {p} báo lại giúp anh. ",
      "Đơn này {d} chưa có phản hồi, báo cáo lại nhé {p}. ",
      "{d} rồi {p} ơi, báo cáo lại nhé. ",
      "Đã {d} chưa thấy báo cáo, {p} cập nhật nhé. ",
      "{d} chưa có thông tin mới, báo cáo lại nhé {p}. ",
      "{d} chưa nghe phản hồi, {p} báo cáo lại giúp anh. "
  ];
  // Sếp bảo lấy / chốt đơn mà chưa lên đơn
  // "Giữ giá cũ" (đơn tái bản giữ nguyên giá) cũng là sếp cho lấy đơn → nhãn "🔁 Tái đơn"
  const KEEP_PRICE_RE = /giữ\s*(nguyên\s*)?giá\s*(cũ|như cũ)?/iu;
  const BOSS_ORDER_RE = /(lấy|chốt|lên|làm)\s*(cái\s*)?đơn\s*(này|đi|luôn|nha|nhé|em)|(nhập|đồng ý|ok)\s*(giá\s*)?(lấy|chốt)\s*đơn|giữ\s*(nguyên\s*)?giá\s*(cũ|như cũ)/iu;
  function bossOrderInfo(c) {
    let hit = null;
    const walk = (t) => {
      if (norm(t.staff?.name) === norm(meName) && BOSS_ORDER_RE.test(t.text || '') && (!hit || t.createdAt > hit.createdAt)) hit = t;
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    return hit;
  }
  const BOSS_ORDER_ASK = [
    'Sao khách chưa lên đơn vậy {p}, vướng gì báo anh nhé.',
    'Đơn này anh chốt rồi, sao khách chưa lên đơn {p}?',
    '{P} ơi, đơn này chốt rồi mà sao chưa thấy lên đơn, khách vướng gì vậy?',
    'Khách chưa lên đơn hả {p}, lý do gì vậy?',
  ];

  // Sếp cho giá: bình luận CUỐI CÙNG là của sếp, kèm hình (bảng giá đỏ) hoặc câu "cho em giá / duyệt giá"
  const BOSS_PRICE_RE = /(cho|gửi|duyệt|chốt)\s*(em|chị|anh|e|c|a)?\s*giá|giá\s*(như|trong)\s*(hình|ảnh|file)/iu;
  const IMG_RE = /\.(png|jpe?g|webp|heic|gif)$/i;
  // Lấy bình luận cho giá MỚI NHẤT của sếp; trong CÙNG LUỒNG đó sau đó chưa ai (NVKD) trả lời → vẫn coi là chờ phản hồi giá
  // (luồng khác có bình luận mới hơn cũng không tính là đã phản hồi giá)
  function bossPriceInfo(c) {
    const isImg = (t) => !!t.file && (IMG_RE.test(t.file) || !/\.(pdf|xlsx?|docx?|zip|rar|ai|cdr)$/i.test(t.file));
    let best = null;
    for (const root of c?.threads || []) {
      const all = [];
      const walk = (t) => {
        all.push(t);
        (t.children || []).forEach(walk);
      };
      walk(root);
      for (const t of all) {
        if (norm(t.staff?.name) !== norm(meName)) continue;
        const img = isImg(t);
        if (!img && !BOSS_PRICE_RE.test(t.text || '')) continue;
        const replied = all.some((x) => x.createdAt > t.createdAt && norm(x.staff?.name) !== norm(meName));
        const later = all.some((x) => x.createdAt > t.createdAt); // sếp đã viết thêm trong luồng → câu hỏi khác lo
        if (!replied && !later && (!best || t.createdAt > best.createdAt)) best = { ...t, img };
      }
    }
    return best;
  }
  const BOSS_PRICE_ASK = [
    'Giá anh gửi rồi, {p} báo khách chưa? Khách phản hồi giá cao hay thấp thế nào {p}?',
    '{P} báo giá cho khách chưa, khách thấy giá cao hay thấp vậy {p}?',
    'Khách nhận giá rồi phản hồi sao {p}, giá cao hay thấp so với bên khác?',
    'Giá này {p} gửi khách chưa? Khách chê cao hay ok rồi {p}?',
  ];

  // Báo giá chưa có Flexo / Offset (mới kết nối khách) – hỏi tình hình kết nối
  const CONNECT_ASK = [
    'Báo cáo lại anh khách hàng này nhé {p}.',
    'Kết nối được khách hàng này chưa {p}?',
    '{P} có tìm được thông tin khách hàng khác không?',
    'Tìm được trực tiếp thu mua chưa {p}?',
    'Có được báo giá thử cho khách này chưa {p}?',
    'Khách này đang lấy hàng bên nào {p}?',
    'Tình hình khách này sao rồi {p}, có cơ hội báo giá không?',
  ];
  // Đề xuất thử cho thu mua 1% (khi chưa thấy nhắc % cho thu mua)
  const BUYER_PCT_ASK = [
    'Thử đề xuất cho thu mua 1% xem phản ứng thế nào {p}?',
    '{P} thử chào thu mua hoa hồng 1% xem bên đó phản ứng sao nhé.',
    'Khách chưa chốt thì {p} thử gợi ý cho thu mua 1% xem sao?',
    'Thu mua bên này đã có % chưa {p}? Nếu chưa thử đề xuất 1% xem phản ứng thế nào.',
  ];
  // Bình luận / tên cơ hội đã nhắc % hoa hồng cho thu mua chưa
  const BUYER_PCT_RE = /hoa\s*hồng|(^|[^\p{L}])hh\s*\d|chi\s*(hh|hoa|\d+\s*%)|%\s*(cho\s*)?(thu\s*mua|tm|người\s*mua|mua\s*hàng)|(thu\s*mua|người\s*mua)\s*\d+(?:[.,]\d+)?\s*%|chiết\s*khấu|ck\s*\d/iu;
  // % / tiền cho thu mua đọc từ tên cơ hội + bình luận: "hh 2%", "hoa hồng 2%", "chi 500đ", "thu mua 1%", "ck 3%"
  const BUYER_VAL_RE = /(?:hoa\s*hồng|(?<![\p{L}])hh|chi(?:\s*(?:hh|hoa\s*hồng))?|cho\s*thu\s*mua|thu\s*mua|(?<![\p{L}])tm|chiết\s*khấu|(?<![\p{L}])ck)(?:\s*(?:thu\s*mua|tm))?(?:\s*cho\s*(?:khách(?:\s*hàng)?|(?<![\p{L}])kh(?![\p{L}])|bên\s*(?:khách|mua)))?\s*[:=(]?\s*(\d+(?:[.,]\d+)?)\s*(%|đ|k|ngàn|nghìn|vnđ)/iu;
  const BUYER_VAL_RE2 = /(\d+(?:[.,]\d+)?)\s*(%|đ|k)\s*(?:\/\s*[\p{L}]+\s*)?(?:cho\s*)?(?:thu\s*mua|người\s*mua|(?<![\p{L}])tm(?![\p{L}])|khách(?:\s*hàng)?(?![\p{L}]))/iu;
  function buyerHit(q, c) {
    const pick = (text) => {
      const m = String(text || '').match(BUYER_VAL_RE) || String(text || '').match(BUYER_VAL_RE2);
      if (!m) return null;
      const unit = /k|ngàn|nghìn/i.test(m[2]) ? '.000đ' : m[2] === '%' ? '%' : 'đ';
      return `${m[1].replace('.', ',')}${unit}`.replace(',000.000đ', '.000đ');
    };
    let best = null;
    const walk = (t) => {
      const v = pick(t.text);
      if (v && (!best || t.createdAt > best.at)) best = { val: v, at: t.createdAt, by: t.staff?.name, text: t.text, code: q?.code };
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    if (!best) {
      const v = pick(q?.name);
      if (v) best = { val: v, at: q?.createdAt || 0, by: '', text: q?.name, code: q?.code };
    }
    return best;
  }
  // Theo từng khách: % thu mua mới nhất ghi nhận ở bất kỳ báo giá nào của khách
  const buyerByCust = { q: null, c: null, map: new Map() };
  function custBuyer(q) {
    if (buyerByCust.q !== renderCtx.quotes || buyerByCust.c !== renderCtx.comments) {
      buyerByCust.q = renderCtx.quotes;
      buyerByCust.c = renderCtx.comments;
      buyerByCust.map = new Map();
      for (const x of Object.values(renderCtx.quotes || {})) {
        const k = custKey(x);
        if (!k) continue;
        const h = buyerHit(x, renderCtx.comments?.[x.id]);
        if (h && (!buyerByCust.map.get(k) || h.at > buyerByCust.map.get(k).at)) buyerByCust.map.set(k, h);
      }
    }
    return buyerByCust.map.get(custKey(q)) || null;
  }
  const buyerInfo = (q, c) => buyerHit(q, c) || custBuyer(q);
  const buyerTag = (q, c) => {
    const h = buyerInfo(q, c);
    if (!h) return '';
    const other = h.code && h.code !== q?.code;
    return ` <span class="byr" title="${esc(`${other ? `Từ ${h.code} cùng khách · ` : ''}${h.by ? `${h.by}: ` : ''}${h.text || ''}`.slice(0, 300))}">🤝 Thu mua ${esc(h.val)}${other ? ' *' : ''}</span>`;
  };
  function buyerPctInfo(q, c) {
    if (buyerInfo(q, c)) return true;
    if (BUYER_PCT_RE.test(q?.name || '')) return true;
    let hit = false;
    const walk = (t) => {
      if (BUYER_PCT_RE.test(t.text || '')) hit = true;
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    return hit;
  }
  // Hỏi thăm 1 deal qua Zalo
  // Số phút còn phải chờ trước khi soạn tin mới cho 1 NVKD (mỗi người 1 tin / 30 phút; tin đang chờ gửi cũng tính)
  const ZALO_GAP = 30 * 60e3;
  function zaloWaitMin(who, sent = {}, jobs = []) {
    const k = norm(who);
    const last = Math.max(
      0,
      ...Object.values(sent).filter((x) => norm(x?.to) === k).map((x) => x.at || 0),
      ...jobs.filter((j) => norm(j?.to) === k && (j.status === 'pending' || j.status === 'sending') && Date.now() - j.at < 10 * 60e3).map(() => Date.now())
    );
    const left = last + ZALO_GAP - Date.now();
    return left > 0 ? Math.ceil(left / 60e3) : 0;
  }
  const ZALO_ASK = ['Deal này thế nào rồi {p}?', 'Báo giá này sao rồi {p}?', 'Khách ok chưa {p}?', 'Lấy được deal này không {p}?'];
  // Khách lâu chưa xuống đơn (lần cuối lên đơn đã quá 30 ngày)
  const LONG_NO_ORDER = [
    'Vì sao khách hàng này lâu chưa xuống đơn hàng vậy {p}?',
    'Khách này đâu rồi {p}, lâu anh chưa thấy có đơn hàng vậy?',
    'Chào lại khách hàng này xem {p}, lâu quá chưa có đơn.',
    'Xem tình hình đơn hàng của khách hàng này sao {p}?',
  ];

  // Chào lại: các cách nói của cùng 1 câu "Báo cáo lại khách hàng này"
  const REPORT_BACK = [
    'Báo cáo lại khách hàng này nhé {p}.',
    'Báo cáo lại khách hàng này nha {p}.',
    'Báo cáo lại khách hàng này {p} nhé.',
    'Báo cáo lại khách hàng này {p} nha.',
  ];
  // ---------- Bộ câu hỏi (tab 💬 Bộ câu hỏi): câu mặc định ở đây, quản trị sửa được → lưu kv 'qbank' (đồng bộ mọi máy) ----------
  // Thứ tự = thứ tự ưu tiên khi chọn câu hỏi nhanh cho 1 báo giá (điều kiện nào khớp trước thì dùng bộ đó)
  const QBANKS = [
    { id: 'monthly', icon: '📅', title: 'Khách cũ tháng này chưa nhập', when: 'Khách cũ (đã từng có đơn), từ ngày 10 của tháng mà tháng này chưa có báo giá / đơn mới.', def: ['Tháng này khách hàng này sao chưa nhập vậy {p}?'] },
    { id: 'handover', icon: '🔁', title: 'Đã bàn giao khách, NVKD chưa phản hồi', when: 'Có bình luận "Bàn giao khách hàng …" cho NVKD mới, quá 12 giờ chưa thấy NVKD đó phản hồi.', def: ['{P} liên hệ khách này được chưa, báo cáo lại cho anh'] },
    { id: 'longNoOrder', icon: '📦', title: 'Khách lâu chưa xuống đơn', when: 'Hoạt động gần nhất của khách (mọi báo giá cùng khách) là thông báo lên đơn hàng đã quá 30 ngày.', def: LONG_NO_ORDER },
    { id: 'noComment', icon: '📭', title: 'Báo giá chưa có bình luận', when: 'Báo giá tạo hơn 24 giờ, đã đọc mà không có bình luận nào.', def: ['Báo giá này chưa có thông tin gì, tình hình khách sao rồi {p}?'] },
    { id: 'bossOrder', icon: '✅', title: 'Sếp cho lấy đơn mà chưa lên đơn', when: 'Sếp bình luận "lấy / chốt / lên đơn này", "đồng ý lấy đơn", "giữ giá cũ" … quá 12 giờ báo giá vẫn chưa có đơn.', def: BOSS_ORDER_ASK },
    { id: 'promise', icon: '🤝', title: 'Khách hứa lên đơn nhưng chưa lên', when: 'NVKD báo khách hứa / đồng ý lên đơn, quá 1 ngày chưa có đơn. Quá 3 ngày thì thêm câu mở đầu của bộ 12 ("x ngày chưa có phản hồi…") phía trước.', def: ['Khách hứa lên đơn mà sao chưa lên vậy {p}, lý do gì {p}?'] },
    { id: 'bossPrice', icon: '💰', title: 'Sếp đã cho giá, NVKD chưa phản hồi', when: 'Bình luận cho giá mới nhất của sếp (kèm hình bảng giá, hoặc "cho em giá / duyệt giá") mà trong cùng luồng chưa ai trả lời, quá 12 giờ.', def: BOSS_PRICE_ASK },
    { id: 'connect', icon: '🔌', title: 'Báo giá chưa có Flexo / Offset (kết nối khách)', when: 'Bảng sản phẩm chưa có dòng Flexo hay Offset nào, báo giá tạo hơn 24 giờ (hỏi cả khi báo giá 0đ).', def: CONNECT_ASK },
    { id: 'reprint', icon: '🔁', title: 'Đơn tái bản', when: 'Sản phẩm đã có mã (tái bản), báo giá đã có giá, chưa có đơn.', def: ['Khách xuống đơn tái bản chưa {p}?'] },
    { id: 'offsetGap', icon: '🟪', title: 'Khách chưa dùng Offset', when: 'Khách chưa từng có báo giá Offset, báo giá gần nhất đã quá 30 ngày, sếp chưa hỏi về offset trong luồng.', def: ['Khách hàng này có dùng offset không {p}?'] },
    { id: 'buyerPct', icon: '🤝', title: 'Thử cho thu mua 1%', when: `Báo giá đã có giá, quá ${FOLLOW_UP_HOURS} giờ chưa chốt, trong bình luận / tên cơ hội chưa nhắc % hoa hồng cho thu mua (hh, hoa hồng, chi %, % thu mua…) → đề xuất NVKD thử cho thu mua 1% xem phản ứng.`, def: BUYER_PCT_ASK },
    { id: 'priceAsk', icon: '⏰', title: 'Quá 12 giờ chưa chốt', when: `Bình luận cuối đã quá ${FOLLOW_UP_HOURS} giờ (dưới ${MAX_FOLLOW_UP_DAYS} ngày), báo giá đã có giá, chưa chốt / chưa có đơn.`, def: PRICE_ASK },
    { id: 'silentLead', icon: '🔕', title: 'Câu mở đầu khi im lặng lâu', when: 'Ghép phía trước câu hỏi của bộ 6 (khách hứa lên đơn), 7 (sếp đã cho giá), 9 (tái bản), 11 (quá 12 giờ chưa chốt) khi đã hơn 3 ngày chưa có phản hồi – vd. "35 ngày chưa có phản hồi, báo cáo lại nhé em." {d} = khoảng thời gian.', def: SILENT_LEAD },
    { id: 'reportBack', icon: '💤', title: 'Im lặng quá lâu / báo giá thất bại', when: `Bình luận cuối đã quá ${MAX_FOLLOW_UP_DAYS} ngày, hoặc báo giá Thất bại → chào lại khách.`, def: REPORT_BACK },
    { id: 'priceGive', icon: '🖨️', title: 'Câu kèm ảnh báo giá (In báo giá → dán)', when: 'Bấm "🖨️ In báo giá → dán vào bình luận": câu viết kèm ảnh bảng báo giá (chọn ngẫu nhiên 1 câu). Không thuộc thứ tự ưu tiên câu hỏi.', def: PRICE_GIVE },
    { id: 'zalo', icon: '💬', title: 'Hỏi NVKD qua Zalo (tab Gợi ý chốt đơn)', when: 'Bấm 💬 ở 1 deal trong tab 🔥 Gợi ý chốt đơn – câu hỏi thăm đặt trước dòng deal (mỗi deal 1 lần, mỗi NVKD 1 tin / 30 phút).', def: ZALO_ASK },
  ];
  let QB = {}; // bản đã sửa (kv 'qbank')
  const qbank = (id) => {
    const o = QB[id]?.lines?.map((x) => String(x).trim()).filter(Boolean);
    return o?.length ? o : QBANKS.find((b) => b.id === id)?.def || [''];
  };

  // Chọn cố định theo báo giá (không đổi mỗi lần vẽ lại); bấm "Gửi lại" thì đổi câu khác
  const pickFor = (arr, id, salt = 0) => arr[(Math.abs(Number(id) * 2654435761 + salt * 40503) >>> 0) % arr.length];
  // Sếp tự xưng trong câu mẫu là "anh"; gọi NVKD là "chị" / "anh" (người lớn hơn) thì sếp xưng "em"
  const selfAdj = (t, p) =>
    p === 'chị' || p === 'anh' ? t.replace(/(^|[^\p{L}{])anh(?![\p{L}}])/gu, '$1em').replace(/(^|[^\p{L}{])Anh(?![\p{L}}])/gu, '$1Em') : t;
  // Biến dính liền chữ (vd. "chưa{p}") → thêm khoảng trắng cho tự nhiên
  const varSpace = (t) => String(t).replace(/(\p{L})\{([pPdsS])\}/gu, '$1 {$2}').replace(/\{([pPdsS])\}(\p{L})/gu, '{$1} $2');
  const fillP = (t, p, d = '') => selfAdj(varSpace(t), p).replaceAll('{p}', p).replaceAll('{P}', p.charAt(0).toUpperCase() + p.slice(1)).replaceAll('{d}', d);
  // "anh" trong mẫu là quản lý tự xưng; nếu NVKD được gọi là "anh" thì quản lý xưng "em"
  const selfFix = (t) => t; // xưng hô của sếp đã xử lý trong fillP (selfAdj)

  // Câu hỏi nhanh viết sẵn (không cần Claude) theo tình trạng báo giá
  // Bình luận mới nhất trong mọi báo giá cùng khách; trả về nếu đó là dòng "… lên đơn hàng …" / "Mã đơn hàng Misa"
  const ORDER_NOTE_RE = /lên đơn hàng|mã đơn hàng misa/i;
  // Chỉ mục theo khách (dựng lại khi dữ liệu đổi): bình luận mới nhất mọi báo giá cùng khách, báo giá mới nhất của khách,
  // khách có báo giá Offset chưa – để duyệt cả nghìn báo giá không phải quét lại toàn bộ cho từng báo giá
  const custIdx = { q: null, c: null, last: new Map(), newest: new Map(), offset: new Map() };
  function ensureCustIdx() {
    if (custIdx.q === renderCtx.quotes && custIdx.c === renderCtx.comments) return custIdx;
    custIdx.q = renderCtx.quotes;
    custIdx.c = renderCtx.comments;
    custIdx.last = new Map();
    custIdx.newest = new Map();
    custIdx.offset = new Map();
    for (const x of Object.values(renderCtx.quotes || {})) {
      const k = custKey(x);
      if (!k) continue;
      custIdx.newest.set(k, Math.max(custIdx.newest.get(k) || 0, x.createdAt || 0));
      if ((x.kinds || (x.offset ? ['offset'] : [])).includes('offset')) custIdx.offset.set(k, true);
    }
    for (const c2 of Object.values(renderCtx.comments || {})) {
      const cid = c2.customerId || renderCtx.quotes?.[c2.id]?.customer?.id;
      if (!cid) continue;
      let latest = custIdx.last.get(cid) || null;
      const walk = (t) => {
        if (t.createdAt && (!latest || t.createdAt > latest.createdAt)) latest = t;
        (t.children || []).forEach(walk);
      };
      (c2.threads || []).forEach(walk);
      if (latest) custIdx.last.set(cid, latest);
    }
    return custIdx;
  }
  function lastCustomerOrderNote(q) {
    const cid = q?.customer?.id;
    if (!cid) return null;
    const lt = ensureCustIdx().last.get(cid);
    if (lt !== undefined) return lt && ORDER_NOTE_RE.test(lt.text || '') ? lt : null;
    let latest = null;
    const walk = (t) => {
      if (t.createdAt && (!latest || t.createdAt > latest.createdAt)) latest = t;
      (t.children || []).forEach(walk);
    };
    for (const c2 of Object.values(renderCtx.comments || {})) {
      if (c2.id !== q.id && c2.customerId !== cid && renderCtx.quotes?.[c2.id]?.customer?.id !== cid) continue;
      (c2.threads || []).forEach(walk);
    }
    return latest && ORDER_NOTE_RE.test(latest.text || '') ? latest : null;
  }
  // Mọi báo giá của cùng khách: chưa có báo giá Offset nào + báo giá gần nhất đã quá 30 ngày
  // + quản lý chưa hỏi về offset trong luồng này → nên hỏi khách có dùng offset không
  function offsetGap(q, c) {
    const key = custKey(q);
    if (!key) return false;
    const ix = ensureCustIdx();
    if (ix.offset.get(key)) return false;
    const newest = ix.newest.get(key) || 0;
    if (!newest || hoursSince(newest) < 30 * 24) return false;
    let asked = false;
    const walk = (t) => {
      if (t.staff?.name === meName && /offset/i.test(t.text || '')) asked = true;
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    return !asked;
  }

  // Bình luận cuối của luồng là "Bàn giao khách hàng … qua nhân viên …" (quản lý) và NVKD mới chưa trả lời
  const HANDOVER_CMT = /^\s*Bàn giao khách hàng\s+.+\s+(qua|cho)\s+nhân viên\s+/i;
  function handoverPending(c) {
    const last = lastComment(c);
    return last && HANDOVER_CMT.test(last.text || '') ? last : null;
  }

  // Khách cũ (≥ 2 đơn / 12 tháng) mà tháng này (từ ngày 10) chưa có báo giá mới nào → hỏi sao tháng này chưa nhập
  const MONTH_ASK_DAY = 10;
  function monthStartVN() {
    const vn = new Date(Date.now() + 7 * 3600e3);
    return { day: vn.getUTCDate(), start: Math.floor((Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), 1) - 7 * 3600e3) / 1000) };
  }
  function monthlyAsk(q, c) {
    const { day, start } = monthStartVN();
    if (day < MONTH_ASK_DAY || !q?.customer?.id) return false;
    const os = orderSummary(renderCtx.orders?.[q.customer.id]);
    if (!os || os.year < 2) return false; // chưa phải khách cũ
    if (os.list.some((o) => o.at >= start)) return false; // tháng này đã có đơn
    if ((ensureCustIdx().newest.get(custKey(q)) || 0) >= start) return false; // tháng này đã có báo giá
    let asked = false;
    const walk = (t) => {
      if (t.staff?.name === meName && t.createdAt >= start && /tháng này/i.test(t.text || '')) asked = true;
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    return !asked;
  }

  // Câu mở đầu khi im lặng lâu (bộ 12, có {d} = khoảng thời gian) – dùng chung cho các bộ 6, 7, 9, 11
  const silentLead = (q, hours, p, salt = qSalt(q)) => {
    if (!(hours >= 72)) return '';
    const t = fillP(pickFor(qbank('silentLead'), q.id, salt + 7), p, humanDuration(hours)).trim();
    return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)} ` : '';
  };
  // Câu hỏi đang hiện là câu số mấy trong bộ (và đoạn mở đầu thuộc câu mấy của bộ 12)
  function qaLineOf(bankId, text, p, d = '') {
    const norm2 = (x) => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const T = norm2(text);
    const main = qbank(bankId).findIndex((t) => {
      const f = norm2(fillP(t, p, d));
      return f && T.includes(f);
    });
    const lead = qbank('silentLead').findIndex((t) => {
      const f = fillP(t, p, '\u0000').toLowerCase().replace(/\s+/g, ' ').split('\u0000');
      return f.every((part) => !part || T.includes(part.trim())) && f.join('').trim().length > 4 && T.startsWith(f[0].trim());
    });
    return { main, lead };
  }
  const qSalt = (q) => (renderCtx.quickSent?.[q.id] ? Math.floor(renderCtx.quickSent[q.id].at / 1000) : 0);
  function quickQuestion(q, c, mode, p) {
    if (q && monthlyAsk(q, c)) {
      return { bank: 'monthly', icon: '📅', why: 'Khách cũ, tháng này chưa có báo giá mới', text: selfFix(fillP(pickFor(qbank('monthly'), q.id, qSalt(q)), p), p) };
    }
    if (!q || CLOSED.has(q.quoteStatus) || hasOrder(q, c)) return null;
    // Vừa bàn giao khách cho NVKD mới, quá 12 giờ chưa thấy phản hồi → hỏi đã liên hệ khách chưa
    const ho = handoverPending(c);
    if (ho && hoursSince(ho.createdAt) >= 12) {
      return { bank: 'handover', icon: '🔁', why: `Đã bàn giao khách ${humanDuration(hoursSince(ho.createdAt))} trước, NVKD chưa phản hồi`, text: selfFix(fillP(pickFor(qbank('handover'), q.id, qSalt(q)), p), p) };
    }
    // Hoạt động gần nhất của khách (mọi báo giá cùng khách) là thông báo lên đơn hàng đã lâu → hỏi vì sao lâu chưa xuống đơn
    const lo = lastCustomerOrderNote(q);
    if (lo && hoursSince(lo.createdAt) >= 30 * 24) {
      const salt = renderCtx.quickSent[q.id] ? Math.floor(renderCtx.quickSent[q.id].at / 1000) : 0;
      return { bank: 'longNoOrder', icon: '📦', why: `Lần cuối khách lên đơn ${humanDuration(hoursSince(lo.createdAt))} trước`, text: selfFix(fillP(pickFor(qbank('longNoOrder'), q.id, salt), p), p) };
    }
    // Chưa có bình luận nào (đã mở xem/ thu thập mà không thấy) → hỏi NVKD vì sao chưa có thông tin
    const noComments = !c?.threads?.length && (renderCtx.collected[q.id] || currentQuoteId() === q.id);
    if (noComments && q.createdAt && hoursSince(q.createdAt) >= 24) {
      return { bank: 'noComment', icon: '📭', why: 'Chưa có bình luận nào', text: selfFix(fillP(pickFor(qbank('noComment'), q.id, qSalt(q)), p), p) };
    }
    // Sếp đã bảo "lấy đơn này / chốt đơn này / lên đơn đi" mà quá 12 giờ vẫn chưa có đơn → hỏi sao khách chưa lên đơn
    const bo = bossOrderInfo(c);
    if (bo && hoursSince(bo.createdAt) >= FOLLOW_UP_HOURS) {
      const salt = renderCtx.quickSent[q.id] ? Math.floor(renderCtx.quickSent[q.id].at / 1000) : 0;
      return {
        bank: 'bossOrder',
        icon: '📦',
        why: `Sếp đã chốt lấy đơn ${humanDuration(hoursSince(bo.createdAt))} trước mà chưa lên đơn`,
        text: selfFix(fillP(pickFor(qbank('bossOrder'), q.id, salt), p), p),
      };
    }
    // Khách hứa lên đơn mà quá 1 ngày vẫn chưa lên
    const pr = promiseInfo(q, c);
    if (pr && hoursSince(pr.at) >= 24) {
      const lead0 = silentLead(q, hoursSince(pr.at), p);
      return { bank: 'promise', icon: '🤝', why: 'Khách hứa lên đơn nhưng chưa lên', text: lead0 + selfFix(fillP(pickFor(qbank('promise'), q.id, qSalt(q)), p), p) };
    }
    // Sếp đã cho giá (hình bảng giá đỏ / "cho em giá") là bình luận cuối, quá 12 giờ NVKD chưa phản hồi → hỏi khách phản hồi giá
    const bp = bossPriceInfo(c);
    if (bp && hoursSince(bp.createdAt) >= FOLLOW_UP_HOURS) {
      const salt = renderCtx.quickSent[q.id] ? Math.floor(renderCtx.quickSent[q.id].at / 1000) : 0;
      const hb = hoursSince(bp.createdAt);
      const lead3 = silentLead(q, hb, p);
      return {
        bank: 'bossPrice',
        icon: '💰',
        why: `Sếp đã cho giá${bp.img ? ' (hình)' : ''} ${humanDuration(hb)} trước, NVKD chưa phản hồi`,
        text: selfFix(lead3 + fillP(pickFor(qbank('bossPrice'), q.id, salt), p), p),
      };
    }
    // Báo giá chưa có sản phẩm Flexo / Offset nào (mới là kết nối / chào khách) → hỏi tình hình kết nối khách
    const noKind = Array.isArray(q.kinds) && !q.kinds.length && !q.offset;
    if (noKind && q.createdAt && hoursSince(q.createdAt) >= 24) {
      const salt = renderCtx.quickSent[q.id] ? Math.floor(renderCtx.quickSent[q.id].at / 1000) : 0;
      return { bank: 'connect', icon: '🔌', why: 'Báo giá chưa có sản phẩm Flexo / Offset (đang kết nối khách)', text: selfFix(fillP(pickFor(qbank('connect'), q.id, salt), p), p) };
    }
    if (noPrice(q)) return null;
    const last = lastComment(c);
    const h = last ? hoursSince(last.createdAt) : 0;
    const lead = silentLead(q, h, p);
    if (q.isReprint) return { bank: 'reprint', icon: '🔁', why: 'Đơn tái bản', text: lead + selfFix(fillP(pickFor(qbank('reprint'), q.id, qSalt(q)), p), p) };
    // Khách chưa từng có báo giá Offset và đã lâu không có báo giá mới → hỏi khách có dùng offset không
    if (mode && offsetGap(q, c)) return { bank: 'offsetGap', icon: '🟪', why: 'Khách chưa có báo giá Offset, lâu chưa báo giá mới', text: selfFix(fillP(pickFor(qbank('offsetGap'), q.id, qSalt(q)), p), p) };
    // Báo giá đang treo mà trong bình luận chưa nhắc % (hoa hồng) cho thu mua → đề xuất thử cho thu mua 1%
    if (mode === 'hoiNhanh' && !buyerPctInfo(q, c)) {
      return { bank: 'buyerPct', icon: '🤝', why: 'Chưa thấy % cho thu mua – thử đề xuất 1%', text: lead + selfFix(fillP(pickFor(qbank('buyerPct'), q.id, qSalt(q)), p), p) };
    }
    if (mode === 'hoiNhanh') {
      const salt = renderCtx.quickSent[q.id] ? Math.floor(renderCtx.quickSent[q.id].at / 1000) : 0;
      const lead2 = silentLead(q, h, p, salt);
      const text = lead2 + fillP(pickFor(qbank('priceAsk'), q.id, salt), p);
      return { bank: 'priceAsk', icon: '⏰', why: `Quá ${FOLLOW_UP_HOURS} giờ chưa chốt`, text: selfFix(text.charAt(0).toUpperCase() + text.slice(1), p) };
    }
    if (mode === 'chaoLai')
      return {
        bank: 'reportBack',
        icon: '💤',
        why: q.quoteStatus === 'REJECT' ? 'Báo giá thất bại' : `Im lặng quá ${MAX_FOLLOW_UP_DAYS} ngày`,
        text: fillP(pickFor(qbank('reportBack'), q.id, renderCtx.quickSent[q.id] ? Math.floor(renderCtx.quickSent[q.id].at / 1000) : 0), p),
      };
    return null;
  }

  let quickCtx = {}; // id → câu hỏi nhanh đang hiển thị (dùng khi bấm gửi)
  // ---------- Học từ mỗi lần gửi bình luận ----------
  // Mỗi lần bấm "Bình luận ngay" / "Gửi bình luận": lưu câu gợi ý gốc + câu thật sự gửi (kv 'quickLearn', đồng bộ).
  //  - Câu hỏi viết sẵn: cùng mẫu câu (bỏ xưng hô, mốc thời gian) mà lần trước quản lý đã sửa → lần sau gợi ý luôn theo câu đã sửa.
  //  - Gợi ý của Claude: đưa các lần sửa gần nhất vào đề bài làm ví dụ.
  let quickLearn = {};
  const DUR_RE = /\d+\s*(phút|giờ|ngày|tuần|tháng|năm)/g;
  const PRONOUNS = ['chị', 'anh', 'em'];
  // Mẫu câu: mốc thời gian → {t}, xưng hô với NVKD → {p}
  const toPattern = (text, p) => {
    let t = String(text || '').trim().replace(DUR_RE, '{t}');
    if (p) t = t.replace(new RegExp(`(^|[^\\p{L}])${p}(?![\\p{L}])`, 'giu'), '$1{p}');
    return t;
  };
  async function recordSend({ kind, base, sent, p, why, staff, code }) {
    if (!sent) return;
    await kvMerge('quickLearn', {
      [`${Date.now()}-${code || ''}`]: { kind, base: base || '', sent, p: p || '', why: why || '', staff: staff || '', code: code || '', edited: !!base && base.trim() !== sent.trim(), at: Date.now(), by: meName },
    }).catch(() => {});
  }
  // Câu gợi ý viết sẵn → nếu cùng mẫu câu đã từng bị sửa thì dùng câu đã sửa (lần sửa gần nhất)
  // Mềm mại: 1 lần sửa chỉ là 1 tình huống riêng → KHÔNG tự thay, chỉ gợi ý "lần trước anh viết…" để bấm dùng.
  // Chỉ tự dùng khi cùng 1 cách sửa lặp lại từ 2 lần trở lên và câu không nhắc chi tiết riêng của deal khác (Flexo/Offset sai loại, mã BG, con số).
  function applyLearned(base, p, q) {
    const pat = toPattern(base, p);
    const edits = Object.values(quickLearn)
      .filter((x) => x.kind === 'quick' && x.edited && toPattern(x.base, x.p) === pat)
      .sort((a, b) => b.at - a.at);
    if (!edits.length) return null;
    const durs = String(base).match(DUR_RE) || [];
    const fill = (x) => {
      let i = 0;
      const out = toPattern(x.sent, x.p)
        .replace(/\{t\}/g, () => durs[Math.min(i++, durs.length - 1)] || '')
        .replace(/\{p\}/g, p || 'em');
      return out.includes('{t}') ? null : out;
    };
    const kinds = q?.kinds || (q?.offset ? ['offset'] : []);
    const specific = (t) =>
      /BG\d{3,}|\d[\d.,]{2,}/i.test(t) || (/offset/i.test(t) && !kinds.includes('offset')) || (/flexo/i.test(t) && !kinds.includes('flexo'));
    // Đếm số lần sửa ra cùng một câu
    const counts = {};
    for (const x of edits) {
      const k = toPattern(x.sent, x.p);
      counts[k] = (counts[k] || 0) + 1;
    }
    const top = edits.map((x) => ({ x, n: counts[toPattern(x.sent, x.p)] })).sort((a, b) => b.n - a.n || b.x.at - a.x.at)[0];
    const text = fill(top.x);
    if (!text) return null;
    return { text, auto: top.n >= 2 && !specific(text), n: top.n };
  }
  // Ví dụ cho Claude: các lần quản lý sửa gợi ý trước khi gửi (ưu tiên cùng NVKD)
  function editExamples(staff, limit = 15) {
    const all = Object.values(quickLearn).filter((x) => x.edited).sort((a, b) => b.at - a.at);
    const same = all.filter((x) => staff && x.staff === staff).slice(0, 8);
    const list = [...same, ...all.filter((x) => !same.includes(x))].slice(0, limit);
    if (!list.length) return '';
    return `CÁC LẦN QUẢN LÝ SỬA GỢI Ý TRƯỚC KHI GỬI (học theo: quản lý thích cách viết ở vế "đã gửi"):\n${list
      .map((x) => `- [${x.why || x.kind} · ${x.staff || '?'}] gợi ý: "${x.base.replace(/\s+/g, ' ').slice(0, 200)}"\n  → đã gửi: "${x.sent.replace(/\s+/g, ' ').slice(0, 200)}"`)
      .join('\n')}`;
  }

  const quickBox = (q, c, mode) => {
    const p = addressFor(staffOf(q, c), renderCtx.comments, renderCtx.quotes);
    const qq = quickQuestion(q, c, mode, p);
    if (!qq) return '';
    const id = q.id;
    const draft = renderCtx.quickDraft[id];
    const lr = applyLearned(qq.text, p, q);
    const learned = lr?.auto ? lr.text : null;
    const hint = lr && !lr.auto && lr.text !== qq.text ? lr.text : null; // chỉ gợi ý, anh bấm mới dùng
    const text = draft?.base === qq.text ? draft.text : learned || qq.text; // giữ bản đã sửa nếu câu gốc chưa đổi
    quickCtx[id] = { base: qq.text, text, p, why: qq.why, learned: !!learned };
    const sent = renderCtx.quickSent[id];
    const key = `quick:${id}`;
    return `<div class="warn quick">
      ${MY_ADMIN && qq.bank ? (() => {
        const bno = QBANKS.findIndex((k) => k.id === qq.bank) + 1;
        const li = qaLineOf(qq.bank, qq.text, p);
        const lno = QBANKS.findIndex((k) => k.id === 'silentLead') + 1;
        return `<div class="quick-src">Câu này từ <b>Bộ ${bno}${li.main >= 0 ? ` · câu ${li.main + 1}` : ''}</b>
          <button class="quick-fix" data-act="qa-edit" data-bank="${qq.bank}" data-idx="${li.main}" title="Câu chưa hợp lý? Mở bộ câu số ${bno} để sửa (áp dụng mọi máy)">✏️ Sửa câu</button>
          ${li.lead >= 0 ? `<button class="quick-fix" data-act="qa-edit" data-bank="silentLead" data-idx="${li.lead}" title="Sửa đoạn mở đầu (bộ ${lno})">✏️ Sửa đoạn mở đầu (Bộ ${lno})</button>` : ''}</div>`;
      })() : ''}
      <div class="quick-why">${qq.icon} ${esc(qq.why)} – câu hỏi gợi ý <span class="muted">(sửa được trước khi gửi)</span>:${learned ? ` <span class="learned-tag" title="Anh đã ${lr.n} lần sửa câu gợi ý cùng tình huống thành câu này">✨ theo cách anh hay viết</span>` : ''}</div>
      <div class="quick-row"><textarea class="quick-text quick-edit" data-id="${id}" rows="4">${esc(text)}</textarea>
        <button class="act primary" data-act="quick-send" data-id="${id}" ${state.busy.has(key) ? 'disabled' : ''}>
          ${state.busy.has(key) ? '<span class="spinner light"></span> Đang gửi…' : sent ? '📨 Gửi lại' : '📨 Bình luận ngay'}</button></div>
      ${hint ? `<div class="learn-hint">💡 Lần trước tình huống tương tự anh viết: <button class="learn-use" data-act="quick-use" data-id="${id}" data-text="${esc(hint)}" title="Bấm để dùng câu này">“${esc(hint)}”</button></div>` : ''}
      ${sent ? `<div class="sent">✅ Đã bình luận lúc ${new Date(sent.at).toLocaleTimeString('vi-VN')}</div>` : ''}
    </div>`;
  };
  // Mở báo giá mà chưa có / cũ lịch sử mua hàng → tự đọc trang khách hàng trong khung ẩn
  const ordersFetching = new Set();
  const ordersTried = {}; // cid → lần thử gần nhất (tránh tải lại liên tục khi không lấy được)
  // Tab Khách hàng: hàng đợi đọc ngầm lại lịch sử mua hàng (đủ các trang trong 6 tháng)
  const custRefetch = { queue: [], total: 0, done: 0, current: null, running: false };
  // Tiến trình lưu trong localStorage (dgCustRun) → F5 chạy tiếp đúng chỗ, giữ số x/y; chỉ 1 tab chạy (nhịp tim 30 giây)
  const RUN_KEY = 'dgCustRun';
  const loadRun = () => {
    try {
      return JSON.parse(lsGet(RUN_KEY) || 'null');
    } catch {
      return null;
    }
  };
  const saveRun = () =>
    lsSet(RUN_KEY, custRefetch.running || custRefetch.queue.length
      ? JSON.stringify({ queue: [custRefetch.current, ...custRefetch.queue].filter((x) => x != null), done: custRefetch.done, total: custRefetch.total, tab: TAB_ID, beat: Date.now() })
      : null);
  async function refetchCustomers(cids) {
    if (loggedOut) return;
    if (!custRefetch.running && (await otherMachineScanning())) return; // máy khác đang quét
    const run = loadRun();
    // Tab khác đang chạy → để tab đó làm, ở đây chỉ hiện tiến trình
    if (run && run.tab !== TAB_ID && Date.now() - run.beat < 30000) return;
    // Lần chạy dở (F5 / đóng tab) trong 6 giờ → tiếp tục, giữ số đã xong
    if (!custRefetch.running && run?.queue?.length && Date.now() - run.beat < 6 * 3600e3) {
      custRefetch.queue = run.queue.map(String);
      custRefetch.done = run.done || 0;
    }
    for (const c of cids.map(String)) if (!custRefetch.queue.includes(c) && String(custRefetch.current) !== c) custRefetch.queue.push(c);
    custRefetch.total = custRefetch.done + custRefetch.queue.length + (custRefetch.current ? 1 : 0);
    saveRun();
    if (custRefetch.running) return render();
    custRefetch.running = true;
    const beat = setInterval(saveRun, 10000);
    try {
      while (custRefetch.queue.length) {
        custRefetch.current = custRefetch.queue.shift();
        saveRun();
        render();
        while (ordersFetching.size) await sleep(500); // chờ lượt đọc khác xong
        await fetchOrdersNow(custRefetch.current, true).catch(() => {});
        custRefetch.done++;
        saveRun();
        await sleep(800);
      }
    } finally {
      clearInterval(beat);
      custRefetch.running = false;
      custRefetch.current = null;
      custRefetch.done = custRefetch.total = 0;
      saveRun();
      render();
    }
  }
  // Tải trang mà còn lượt chạy dở → tự chạy tiếp (không cần mở tab Khách hàng)
  if (IS_TOP)
    setInterval(() => {
      if (custRefetch.running) return;
      const run = loadRun();
      if (run?.queue?.length && Date.now() - run.beat < 6 * 3600e3 && (run.tab === TAB_ID || Date.now() - run.beat > 30000)) refetchCustomers([]);
    }, 15000);
  // Đang quét (thu thập ngầm / cập nhật nhanh / đơn hàng khách) → giữ nhịp tim khoá chung
  if (IS_TOP) setInterval(() => (collect.running || custRefetch.running) && scanBeat(), 20000);

  async function fetchOrdersNow(cid, force = false) {
    if (ordersFetching.has(cid) || ordersFetching.size || (!force && Date.now() - (ordersTried[cid] || 0) < 10 * 60 * 1000)) return;
    ordersTried[cid] = Date.now();
    ordersFetching.add(cid);
    try {
      await loadInFrame(null, `/khach-hang/view/${cid}?t=order`, /\/misaOrder\?.*customerId=/, (f) => readMoreOrders(f, cid));
    } finally {
      ordersFetching.delete(cid);
      render();
    }
  }

  // Khối "Đơn hàng này bao nhiêu %": Offset (chiết giá) + Flexo (giấy tấm / tổng BG); bấm "Giải thích" xem chi tiết
  const marginFetching = new Set();
  const marginTried = {};
  async function fetchMarginNow(q, force = false) {
    if (marginFetching.size || (!force && Date.now() - (marginTried[q.id] || 0) < 10 * 60 * 1000)) return;
    marginTried[q.id] = Date.now();
    marginFetching.add(q.id);
    setStep('Đang mở báo giá trong khung ẩn…');
    try {
      await loadInFrame(q.id, undefined, undefined, async (f) => {
        if (q.offset) await readOffsetMargins(f, q.code);
        if ((q.kinds || []).includes('flexo') && q.amount) await readFlexoCost(f, q);
      });
    } finally {
      marginFetching.delete(q.id);
      marginStep = '';
      render();
    }
  }
  // Tóm tắt riêng từng loại: Flexo (còn lại sau giấy tấm) và Offset (đang bán %, thấp nhất trong các sản phẩm)
  // Sản phẩm Offset theo đúng thứ tự trên báo giá: khớp quy cách + SL với dòng sản phẩm đã ghi; chưa có thì theo lúc đọc
  // So khớp 1 dòng sản phẩm trên trang với quy cách + SL (dùng chung)
  const offNz = (x) => String(x || '').toLowerCase().replace(/[×✕*]/g, 'x').replace(/\s+/g, '');
  const offNums = (t) => String(t).replace(/(\d)\.(?=\d{3}\b)/g, '$1').match(/\d+/g) || [];
  function offRowFor(rows, spec, qty) {
    const sp = offNz(spec);
    const q = String(qty || '').replace(/[^\d]/g, '');
    const has = (t) => {
      if (!sp) return false;
      if (offNz(t).includes(sp)) return true;
      const sn = sp.match(/\d+/g) || [];
      const rn = offNums(t);
      return sn.length >= 2 && rn.some((_, k) => sn.every((v, j) => rn[k + j] === v));
    };
    return rows.find((t) => has(t) && (!q || offNums(t).includes(q))) || null;
  }
  // Dòng sản phẩm của báo giá đang mở (đọc thẳng bảng sản phẩm trên trang) – ưu tiên hơn thứ tự đã lưu
  function pageProductRows() {
    if (!IS_TOP || !currentQuoteId()) return null;
    const table = [...document.querySelectorAll('.ant-table')].find((t) => [...t.querySelectorAll('th')].some((th) => th.innerText.trim() === 'Số lượng'));
    if (!table) return null;
    const rows = [...table.querySelectorAll('.ant-table-tbody tr')].filter((tr) => !tr.classList.contains('ant-table-measure-row') && tr.innerText.trim());
    return rows.length ? rows.map((tr) => tr.innerText.replace(/\s+/g, ' ').slice(0, 400)) : null;
  }
  function offEntries(m, code) {
    // Mỗi quy cách + SL chỉ giữ bản đọc mới nhất (giá trong chiết giá có thể khác "Giá thực bán" – vẫn là cùng 1 dòng)
    const latest = new Map();
    for (const e of Object.entries(m?.products || {})) {
      const k = `${String(e[1].spec || '').replace(/\s+/g, '')}|${String(e[1].qty || '').replace(/[^\d]/g, '')}`;
      if (!latest.has(k) || (e[1].at || 0) > (latest.get(k)[1].at || 0)) latest.set(k, e);
    }
    const list = [...latest.values()];
    const live = code && renderCtx.quotes?.[currentQuoteId()]?.code === code ? pageProductRows() : null;
    const order = live || m?.order || [];
    if (live && code && state.ordDbg !== code) {
      state.ordDbg = code;
      call({ type: 'remote.push', ns: 'dbg', patch: { [`order-${code}`]: { at: Date.now(), live, specs: list.map(([, x]) => [x.spec, x.qty]) } } }).catch(() => {});
    }
    // Chuẩn hoá: bỏ khoảng trắng, "×"/"X" → "x"; số lượng so theo từng số trong dòng (bỏ dấu chấm nghìn)
    const nz = (x) => String(x || '').toLowerCase().replace(/[×✕*]/g, 'x').replace(/\s+/g, '');
    const nums = (t) => (String(t).replace(/(\d)\.(?=\d{3}\b)/g, '$1').match(/\d+/g) || []);
    const used = new Set();
    // Quy cách có thể nằm ở các ô riêng (245 | 155 | 37) → so theo dãy số liên tiếp
    const hasSpec = (t, spec) => {
      if (!spec) return false;
      if (nz(t).includes(spec)) return true;
      const sn = spec.match(/\d+/g) || [];
      const rn = nums(t);
      return sn.length >= 2 && rn.some((_, k) => sn.every((v, j) => rn[k + j] === v));
    };
    const pos = ([, x]) => {
      const spec = nz(x.spec);
      const qty = String(x.qty || '').replace(/[^\d]/g, '');
      let i = order.findIndex((t, k) => !used.has(k) && hasSpec(t, spec) && (!qty || nums(t).includes(qty)));
      if (i < 0) i = order.findIndex((t, k) => !used.has(k) && hasSpec(t, spec));
      if (i >= 0) used.add(i);
      return i >= 0 ? i : 999;
    };
    // Tính vị trí theo thứ tự ổn định (khớp đúng SL trước)
    const withPos = list.map((e) => [e, 999]);
    for (const w of withPos) if (String(w[0][1].qty || '')) w[1] = pos(w[0]);
    return withPos.sort((a, b) => a[1] - b[1] || (a[0][1].at || 0) - (b[0][1].at || 0)).map((w) => w[0]);
  }
  // Số % nổi trên đầu nút kéo
  function osimBubble(rg, val) {
    const bub = rg?.parentElement?.querySelector('.osim-bub');
    if (!bub) return;
    const v = val ?? Number(rg.value);
    const t = (Number(rg.value) - Number(rg.min)) / (Number(rg.max) - Number(rg.min));
    bub.textContent = `${Math.round(v * 10) / 10}%`;
    bub.style.left = `calc(${t * 100}% + ${(0.5 - t) * 18}px)`; // bù độ rộng nút kéo (~18px)
  }
  // Tính lại bảng khi thử giá (chạy trực tiếp trên DOM, không vẽ lại thẻ)
  function osimCalc(tb) {
    if (!tb) return;
    // k = giá trị BG ÷ tổng bảng chiết giá (≈ 1 + VAT) → quy mọi số về giá trị BG; % = 1 − NVL ÷ thành tiền (cùng 1 công thức với thanh kéo)
    const k = Number(tb.dataset.k) || 1;
    let sumTT = 0;
    let nvlSum = 0;
    for (const tr of tb.querySelectorAll('tr.osim-r')) {
      const inp = tr.querySelector('input.osim');
      if (!inp) {
        sumTT += Number(tr.dataset.tt) || 0;
        nvlSum += Number(tr.dataset.nvl) || 0;
        continue;
      }
      const price = numOf(inp.value);
      const tt = price * Number(inp.dataset.qty);
      sumTT += tt;
      nvlSum += Number(inp.dataset.nvl) || 0;
      tr.querySelector('.osim-tt').textContent = tt ? money(tt) : '–';
      const pc = tr.querySelector('.osim-pct');
      const pct = tt ? Math.round((1 - Number(inp.dataset.nvl) / tt) * 1000) / 10 : null;
      pc.textContent = pct != null ? `${pct}%` : '–';
      pc.className = `osim-pct ${pct != null ? pctCls(pct) : ''}`;
      inp.classList.toggle('chg', price !== Number(inp.dataset.orig));
    }
    const bg = sumTT * k;
    const diff = (sumTT - nvlSum) * k;
    const set = (sel, v) => tb.querySelectorAll(sel).forEach((e) => (e.textContent = v));
    set('.osim-sumtt', money(Math.round(sumTT)));
    set('.osim-bg', money(Math.round(bg)));
    set('.osim-diff', `${diff < 0 ? '−' : ''}${trM(Math.abs(diff))}`);
    tb.querySelectorAll('.osim-diff').forEach((e) => e.classList.toggle('neg', diff < 0));
    const dp = sumTT ? Math.round((1 - nvlSum / sumTT) * 1000) / 10 : null;
    set('.osim-dpct', dp != null ? `${dp}%` : '–');
    // Màu theo mức: ≤20% đỏ chớp mạnh · ≤30% cam chớp · ≤35% xanh dương chớp nhẹ · còn lại xanh lá
    const lv = dp == null ? '' : dp <= 20 ? 'lv-red' : dp <= 30 ? 'lv-orange' : dp <= 35 ? 'lv-blue' : 'lv-green';
    tb.querySelectorAll('.osim-dpct').forEach((e) => (e.className = `osim-dpct ${lv}`));
    // Ô Offset lớn phía trên thẻ: cùng số %, cùng màu / hiệu ứng, cùng số chênh lệch
    const side = tb.closest('.side');
    const top = side?.querySelector('.osim-top');
    if (top && dp != null) {
      top.textContent = `${dp}%`;
      top.className = `osim-top osim-dpct ${lv}`;
    }
    const topDiff = side?.querySelector('.osim-topdiff');
    if (topDiff) topDiff.textContent = `${diff < 0 ? '−' : '+'}${trM(Math.abs(diff))}`;
    // Tỷ lệ NVL / đơn giá hiện tại (trước VAT)
    let nv = 0;
    let pv = 0;
    for (const ip of tb.querySelectorAll('input.osim')) {
      nv += Number(ip.dataset.nvl);
      pv += numOf(ip.value) * Number(ip.dataset.qty);
    }
    const sell = dp;
    const ratio = sell != null ? Math.round((100 - sell) * 10) / 10 : null;
    set('.osim-rv', ratio != null ? `bán ${sell}% · NVL ${ratio}%` : '');
    const rg = tb.querySelector('input.osim-range');
    if (rg && sell != null && root.activeElement !== rg && !rg.matches(':active')) rg.value = sell;
    osimBubble(rg, sell);
    // Thanh kéo + số nổi cùng màu / hiệu ứng với ô % (đỏ / cam / xanh dương / xanh lá)
    const rw = rg?.closest('.osim-rw');
    if (rw) rw.className = `osim-rw ${lv}`;
  }
  function marginParts(q) {
    const m = renderCtx.margins?.[q?.code] || {};
    const offs = offEntries(m, q?.code).map(([, x]) => x);
    const priced = offs.filter((x) => x.pct != null && !x.noPrice);
    // % Offset = (1 − NVL sau VAT ÷ giá trị BG phần Offset) × 100 – khớp với số NVL / chênh lệch hiện trên thẻ.
    // Chưa tính được NVL thì lấy "đang bán %" thấp nhất trong các sản phẩm.
    let offset = priced.length ? Math.min(...priced.map((x) => x.pct)) : null;
    if (priced.length) {
      const od = offsetDiff(q);
      if (od?.base > 0 && od.nvlPost >= 0) offset = Math.round((1 - od.nvlPost / od.base) * 1000) / 10;
    }
    return {
      flexo: flexoInfo(q),
      offset,
      offNoPrice: offs.length > 0 && !priced.length, // bảng chiết giá đang 0đ (chưa cho giá)
      offs: offEntries(m, q?.code),
    };
  }
  // Chênh lệch Offset (tiền lời trên NVL) = giá trị báo giá × đang bán %.
  // Báo giá nhiều sản phẩm: % chung = trung bình "đang bán %" theo tỉ trọng (giá 1 thùng × SL) đọc từ bảng chiết giá.
  // Không lấy thẳng giá × SL của bảng chiết giá làm tổng: SL ở đó có thể khác đơn vị / chỉ là 1 phần đơn
  // (vd. BG26883: 10.900đ × 405 = 4,4 tr trong khi báo giá 47,4 tr).
  const numOf = (t) => Number(String(t || '').replace(/[^\d]/g, '')) || 0;
  function offsetDiff(q) {
    const prods = offEntries(renderCtx.margins?.[q?.code], q?.code).map(([, x]) => x).filter((x) => x.pct != null && !x.noPrice);
    if (!prods.length) return null;
    // Có tổng Nguyên liệu đọc thẳng từ bảng chiết giá → dùng số thật
    if (prods.every((x) => x.nvlTotal > 0)) {
      const sheetNvl = prods.reduce((a, x) => a + x.nvlTotal, 0);
      const sheetVal = prods.reduce((a, x) => a + numOf(x.price) * numOf(x.qty), 0);
      const amount = kindPart(q, 'offset', q?.amount);
      const rows = prods.map((x) => ({ pct: x.pct, price: numOf(x.price), qty: numOf(x.qty), val: numOf(x.price) * numOf(x.qty), nvlUnit: x.nvlUnit, nvl: x.nvlTotal }));
      const pct = sheetVal ? (1 - sheetNvl / sheetVal) * 100 : Math.min(...prods.map((x) => x.pct));
      if (!amount) return { diff: sheetVal - sheetNvl, exact: true, sheet: true, rows, pct, nvlPre: sheetNvl, nvlPost: sheetNvl, vat: null, base: sheetVal };
      const ratio = sheetVal ? amount / sheetVal : null;
      const vat = ratio == null ? null : [0, 5, 8, 10].find((v) => Math.abs(ratio - (1 + v / 100)) <= 0.015) ?? null;
      // SL trên bảng chiết giá khác đơn (không khớp VAT) → quy NVL theo tỉ lệ NVL ÷ giá của bảng
      const nvlPost = vat != null ? sheetNvl * (1 + vat / 100) : sheetVal ? amount * (sheetNvl / sheetVal) : sheetNvl;
      return { diff: amount - nvlPost, exact: vat != null, sheet: true, rows, pct, nvlPre: sheetNvl, nvlPost, vat, base: amount, part: amount !== q.amount };
    }
    // Mỗi sản phẩm: NVL 1 thùng = giá 1 thùng × (1 − đang bán %) (vì đang bán % = 1 − NVL ÷ giá)
    const rows = prods.map((x) => {
      const price = numOf(x.price);
      const qty = numOf(x.qty);
      return { pct: x.pct, price, qty, val: price * qty, nvlUnit: price * (1 - x.pct / 100), nvl: price * qty * (1 - x.pct / 100) };
    });
    const sumVal = rows.reduce((a, r) => a + r.val, 0); // tổng giá trước VAT theo bảng chiết giá
    const weighted = rows.every((r) => r.val > 0) && sumVal > 0;
    const pct = weighted ? rows.reduce((a, r) => a + r.val * r.pct, 0) / sumVal : Math.min(...rows.map((r) => r.pct));
    const amount = kindPart(q, 'offset', q?.amount);
    if (!amount) {
      if (!weighted) return null;
      const nvlPre = rows.reduce((a, r) => a + r.nvl, 0);
      return { diff: sumVal - nvlPre, exact: false, rows, pct, nvlPre, nvlPost: nvlPre, vat: null, base: sumVal };
    }
    // VAT: tỉ lệ giá trị BG ÷ tổng bảng chiết giá gần đúng 1 / 1,05 / 1,08 / 1,1 → báo giá đã gồm VAT đó
    const ratio = weighted ? amount / sumVal : null;
    const vat = ratio == null ? null : [0, 5, 8, 10].find((v) => Math.abs(ratio - (1 + v / 100)) <= 0.015) ?? null;
    const exact = vat != null;
    // NVL sau VAT: tính đúng từ bảng chiết giá khi khớp; không khớp thì ước theo tỉ lệ đang bán % trên giá trị BG
    const nvlPre = exact ? rows.reduce((a, r) => a + r.nvl, 0) : null;
    const nvlPost = exact ? nvlPre * (1 + vat / 100) : amount * (1 - pct / 100);
    return { diff: amount - nvlPost, exact, rows, pct, nvlPre, nvlPost, vat, base: amount, part: amount !== q.amount };
  }
  // Các bước tính chênh lệch Offset (bảng Giải thích): NVL 1 thùng → NVL trước VAT → NVL sau VAT → BG − NVL
  function offsetSteps(q, od, nvlCol = false) {
    const r = (label, val, note = '', cls = '', nvl = '') =>
      `<tr class="osteps${cls ? ` ${cls}` : ''}"><td>${label}</td><td></td><td>${nvlCol ? '' : val}</td>${nvlCol ? `<td class="num">${nvl}</td><td class="num">${val}</td>` : ''}<td class="num">${note}</td></tr>`;
    const pctTxt = `${Math.round(od.pct * 10) / 10}%`;
    const out = [];
    if (od.sheet) {
      out.push(nvlCol
        ? r('<b>Tổng</b> (bảng chiết giá, trước VAT)', `<b class="osim-sumtt">${money(Math.round(od.rows.reduce((a, x) => a + (x.val || 0), 0)))}</b>`, '', 'nvl-sum', `<b>${money(Math.round(od.nvlPre))}</b>`)
        : r('Tổng Nguyên liệu (đọc thẳng bảng chiết giá)', money(Math.round(od.nvlPre)), od.rows.map((x) => (x.nvlUnit ? `${money(x.nvlUnit)}/thùng` : '')).filter(Boolean).join(' · ')));
      // Có cột Nguyên liệu → số NVL nằm đúng cột đó
      const nv = (label, v, note, cls = '') => (nvlCol ? r(label, '', note, cls, v) : r(label, v, note, cls));
      // Dòng sau VAT: NVL sau VAT (cột Nguyên liệu) + giá trị BG đã gồm VAT (cột Thành tiền) trên cùng 1 dòng
      if (od.vat && nvlCol) out.push(r(`<b>Sau VAT (${od.vat}%)</b> – NVL · ${od.part ? 'phần Offset' : 'giá trị BG'}`, `<b class="osim-bg">${money(Math.round(od.base))}</b>`, '', 'nvl-sum', `<b>${money(Math.round(od.nvlPost))}</b>`));
      else if (od.vat) out.push(nv(`NVL sau VAT (${od.vat}%)`, `<b>${money(Math.round(od.nvlPost))}</b>`, `× ${1 + od.vat / 100}`));
      else if (!nvlCol && Math.round(od.nvlPost) !== Math.round(od.nvlPre)) out.push(nv('NVL quy theo giá trị BG (SL bảng chiết giá khác đơn)', `<b>≈${money(Math.round(od.nvlPost))}</b>`, 'theo tỉ lệ', 'warn-row'));
    } else if (od.exact) {
      for (const x of od.rows) out.push(r(`NVL 1 thùng = ${money(x.price)} × (1 − ${x.pct}%)`, money(Math.round(x.nvlUnit)), `× ${x.qty.toLocaleString('vi-VN')}`));
      out.push(r('NVL trước VAT', money(Math.round(od.nvlPre))));
      out.push(r(`NVL sau VAT (${od.vat}%)`, `<b>${money(Math.round(od.nvlPost))}</b>`, `× ${1 + od.vat / 100}`));
    } else {
      out.push(r(`NVL sau VAT ≈ BG × (1 − ${pctTxt})`, `<b>≈${money(Math.round(od.nvlPost))}</b>`, 'ước tính', 'warn-row'));
    }
    if (!(od.sheet && od.vat && nvlCol)) out.push(r(`${od.part ? 'Thành tiền phần Offset' : 'Giá trị BG'}${od.vat ? ` (đã gồm VAT ${od.vat}%)` : ''}`, money(Math.round(od.base))));
    const diffHtml = `<b class="pos osim-diff">${od.exact ? '' : '≈'}${trM(od.diff)}</b>`;
    // Có cột Nguyên liệu → số chênh lệch nằm ở cột Nguyên liệu (lệch trái 1 ô so với Thành tiền)
    out.push(nvlCol ? r('<b>Chênh lệch Offset = BG − NVL sau VAT</b>', '', `<span class="osim-dpct">${pctTxt}</span>`, '', diffHtml) : r('<b>Chênh lệch Offset = BG − NVL sau VAT</b>', diffHtml, pctTxt));
    if (!od.exact) out.push(`<tr><td colspan="${nvlCol ? 6 : 4}" class="muted">Tổng trên bảng chiết giá (giá × SL) không khớp giá trị BG theo mức VAT 0/5/8/10% → ước tính theo đang bán %.</td></tr>`);
    return out.join('');
  }
  // Dòng % ở cột phải danh sách: 🟦 Flexo X% · 🟪 Offset Y%
  const pctLine = (q) => {
    const kinds = q?.kinds || (q?.offset ? ['offset'] : []);
    if (!kinds.length) return '';
    const { flexo, offset } = marginParts(q);
    const segs = [];
    if (kinds.includes('flexo'))
      segs.push(flexo ? (flexo.invalid ? '🟦 <span class="warnx">PO&gt;BG</span>' : `🟦 <b class="${pctCls(flexo.rest)}">${flexo.rest}%</b>`) : '🟦 <span class="muted">–</span>');
    if (kinds.includes('offset')) segs.push(offset != null ? `🟪 <b class="${pctCls(offset)}">${offset}%</b>` : '🟪 <span class="muted">–</span>');
    const none = !flexo && offset == null;
    return `<div class="amt-pct" title="Flexo: % còn lại sau giấy tấm · Offset: đang bán %">${segs.join(' · ')}${none ? ' <span class="muted">% đang chờ tính</span>' : ''}</div>`;
  };
  // Ô % gọn trong danh sách 1 dòng
  // ---------- Xuất Excel (.xlsx) ----------
  // Tự đóng gói file .xlsx (zip không nén) – không cần thư viện ngoài.
  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (u8) => {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  function zipStore(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
      const nameB = enc.encode(name);
      const data = enc.encode(text);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // tên file UTF-8
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameB.length, true);
      parts.push(new Uint8Array(local.buffer), nameB, data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, nameB.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), nameB);
      offset += 30 + nameB.length + data.length;
    }
    const cenSize = central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, Object.keys(files).length, true);
    end.setUint16(10, Object.keys(files).length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  const xmlEsc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  // rows: mảng các dòng; ô là số → kiểu số, còn lại là chữ. Dòng đầu là tiêu đề (in đậm, cố định khi cuộn).
  function buildXlsx(rows, widths = [], sheetName = 'Báo giá', filterRows = rows.length) {
    const col = (i) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26));
    const sheetRows = rows
      .map((r, ri) => `<row r="${ri + 1}">${r
        .map((v, ci) => {
          const ref = `${col(ci)}${ri + 1}`;
          const st = ri === 0 ? ' s="1"' : '';
          if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${ri ? 2 : 1}"><v>${v}</v></c>`;
          if (v && typeof v === 'object' && v.f) return `<c r="${ref}" s="${v.bold ? 3 : 2}"><f>${xmlEsc(v.f)}</f>${Number.isFinite(v.v) ? `<v>${v.v}</v>` : ''}</c>`;
          if (v && typeof v === 'object' && v.bold) return `<c r="${ref}" t="inlineStr" s="1"><is><t xml:space="preserve">${xmlEsc(v.t)}</t></is></c>`;
          if (v == null || v === '') return '';
          return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
        })
        .join('')}</row>`)
      .join('');
    const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const last = `${col(Math.max(0, (rows[0] || []).length - 1))}${filterRows}`;
    return zipStore({
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
      '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
      'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
      'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${sheetRows}</sheetData>${filterRows > 1 ? `<autoFilter ref="A1:${last}"/>` : ''}</worksheet>`,
    });
  }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const htmlText = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

  const pctCls = (v) => (v == null ? '' : v < 30 ? 'bad' : 'good');
  // Cột "Chênh lệch": Flexo = tổng BG − tổng PO giấy tấm; chỉ Offset = ước tính BG × đang bán %
  // Số chênh lệch dạng số (để cộng tổng): Flexo = BG − giấy tấm; Offset = Σ giá × SL × đang bán %
  const diffVal = (q) => {
    const kinds = q?.kinds || (q?.offset ? ['offset'] : []);
    if (!kinds.length) return null;
    const { flexo, offset } = marginParts(q);
    if (q?.noSheet) return null;
    if (kinds.includes('flexo')) return flexo ? flexo.diff : null;
    return offset == null ? null : offsetDiff(q)?.diff ?? null;
  };
  // Ô tổng chênh lệch trên tiêu đề bảng (theo bộ lọc đang hiện)
  const diffHead = (rows) => {
    const vals = rows.map(({ q }) => diffVal(q)).filter((v) => v != null);
    const sum = vals.reduce((a, v) => a + v, 0);
    const txt = Math.abs(sum) >= 1e9 ? `${(sum / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ` : trM(sum);
    return `<span class="it-pct"><span class="pc dl sum" title="Tổng chênh lệch của ${vals.length}/${rows.length} báo giá đã tính được: ${money(Math.round(sum))}&#10;Flexo: BG − giấy tấm · Offset: Σ giá × SL × đang bán %">Σ ${vals.length ? txt : '–'}</span></span>`;
  };
  const diffCell = (q) => {
    const kinds = q?.kinds || (q?.offset ? ['offset'] : []);
    if (!kinds.length) return '';
    const { flexo, offset } = marginParts(q);
    // Có dòng giấy tấm 0đ/m2 → chưa tính được chênh lệch: báo động ngay trên hàng
    if (q?.noSheet) return `<span class="pc dl angry" title="Có ${q.noSheetN || ''} dòng sản phẩm giá giấy tấm 0đ/m2 – chưa có giá giấy tấm">😡 Chưa có giá GT</span>`;
    if (kinds.includes('flexo')) {
      if (!flexo) return '<span class="pc dl wait" title="Flexo: đang chờ tính">…</span>';
      return `<span class="pc dl f ${flexo.diff < 0 ? 'bad' : 'good'}" title="Flexo: BG ${money(flexo.base)} − giấy tấm ${money(flexo.best.total)}${flexo.rest != null ? ` · còn ${flexo.rest}%` : ' · PO > BG'}">${flexo.diff < 0 ? '−' : ''}${trM(Math.abs(flexo.diff))}</span>`;
    }
    const od = offset == null ? null : offsetDiff(q);
    if (!od) return '<span class="pc dl wait" title="Offset: đang chờ tính">…</span>';
    return `<span class="pc dl o ${pctCls(offset)}" title="Offset: chênh lệch = ${od.part ? 'phần Offset' : 'BG'} ${money(Math.round(od.base))} − NVL sau VAT${od.vat ? ` ${od.vat}%` : ''} ${money(Math.round(od.nvlPost))}${od.exact ? '' : ' (ước tính theo đang bán %)'}">${od.exact ? '' : '≈'}${trM(od.diff)}</span>`;
  };

  const lsGet = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const lsSet = (k, v) => {
    try {
      v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {}
  };
  // Áp vị trí đã lưu cho thẻ (giữ trong màn hình)
  // Ô câu hỏi gợi ý tự cao theo nội dung (không phải cuộn bên trong)
  const fitText = (ta) => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(110, ta.scrollHeight + 4)}px`;
  };
  const fitAll = (el) => el?.querySelectorAll('textarea.quick-text').forEach(fitText);

  function placeSide(el) {
    requestAnimationFrame(() => fitAll(el));
    let pos = null;
    try {
      pos = JSON.parse(lsGet('dgSidePos') || 'null');
    } catch {}
    if (!pos) {
      el.style.left = el.style.top = '';
      el.style.right = '16px';
      el.style.top = '130px';
      return;
    }
    const w = el.offsetWidth || 280;
    const h = el.offsetHeight || 60;
    el.style.right = 'auto';
    el.style.left = `${Math.max(0, Math.min(window.innerWidth - w, pos.left))}px`;
    el.style.top = `${Math.max(0, Math.min(window.innerHeight - Math.min(h, 60), pos.top))}px`;
  }
  function wireSide(el) {
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      const h = e.target.closest('.side-h');
      if (!h || e.target.closest('button')) return;
      const r = el.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      lsSet('dgSidePos', JSON.stringify({ left: e.clientX - drag.dx, top: e.clientY - drag.dy }));
      placeSide(el);
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      el.classList.remove('dragging');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.side-h') || e.target.closest('button')) return;
      lsSet('dgSidePos', null);
      placeSide(el);
    });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-side="calc"]')) {
        const q = renderCtx.quotes?.[currentQuoteId()];
        if (q) fetchMarginNow(q, true);
        return;
      }
      // ↻ Tính lại giá: xoá số liệu đã lưu (chiết giá Offset, PO giấy tấm Flexo, tổng theo loại) rồi đọc lại ngay
      if (e.target.closest('[data-side="recalc"]')) {
        const q = renderCtx.quotes?.[currentQuoteId()];
        if (!q?.code || marginFetching.has(q.id)) return;
        (async () => {
          const cur = (await kvGet('margins'))[q.code] || {};
          await kvMerge('margins', { [q.code]: { ...cur, products: {}, flexo: null, kindTotals: null, offVer: null, at: Math.floor(Date.now() / 1000) } });
          renderCtx.margins = await kvGet('margins');
          ktAt = 0; // đọc lại bảng sản phẩm của trang
          watchKindTotals(q);
          await fetchMarginNow(q, true);
          render();
        })().catch((err) => console.warn('[DG] recalc', err));
        return;
      }
      if (e.target.closest('[data-side="toggle"]')) {
        lsSet('dgSideCollapsed', lsGet('dgSideCollapsed') === '1' ? '0' : '1');
        render();
      }
    });
    window.addEventListener('resize', () => placeSide(el));
  }

  // Ô "đang tính" có hiệu ứng / nút tính lại khi chưa có số
  const waitHtml = (busy) =>
    busy
      ? `<span class="calc"><span class="spinner"></span><span class="calc-bar"><i></i></span><span class="muted">đang tính…</span></span>`
      : `<span class="muted">chưa có</span><button class="side-btn calc-btn" data-side="calc" title="Tính lại ngay">↻ Tính ngay</button>`;

  // Đang xem báo giá: đọc bảng sản phẩm (tổng tiền + NCC giấy theo loại), tối đa 1 lần / 20 giây
  let ktAt = 0;
  function watchKindTotals(q) {
    if (!IS_TOP || !q?.code || Date.now() - ktAt < 20000) return;
    ktAt = Date.now();
    saveKindTotals(document, q.code).catch(() => {});
  }

  // Đang xem báo giá: trang có "Mã đơn hàng Misa: …" hoặc tình trạng đang chọn là đã chốt → ghi nhận ngay
  // (dữ liệu API / đồng bộ có thể chậm hoặc cũ)
  const STATUS_BY_LABEL = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k]));
  let odAt = 0;
  function watchOrderDom(q) {
    if (!IS_TOP || !q?.id || Date.now() - odAt < 15000) return;
    odAt = Date.now();
    const misa = [...document.querySelectorAll('span, div, b, strong')].some((e) => e.children.length === 0 && /^Mã đơn hàng Misa:?$/i.test(e.textContent.trim()));
    const checked = [...document.querySelectorAll('.ant-tag-checkable-checked, .ant-tag-checkable.ant-tag-checkable-checked')]
      .map((t) => STATUS_BY_LABEL[t.textContent.replace(/^[^\p{L}]+/u, '').trim()])
      .find(Boolean);
    const patch = {};
    if (misa && !q.hasOrder) patch.hasOrder = true;
    if (checked && checked !== q.quoteStatus && CLOSED.has(checked)) patch.quoteStatus = checked;
    if (Object.keys(patch).length) kvMerge('quotes', { [q.id]: { ...q, ...patch, updatedAt: Math.max(q.updatedAt || 0, Math.floor(Date.now() / 1000)) } }).catch(() => {});
  }

  function renderSide(q, qid = q?.id, body = '', ho = '', hoN = 0) {
    watchKindTotals(q);
    watchOrderDom(q);
    const el = root?.querySelector('.side');
    if (!el) return;
    // Đang gõ trong ô câu hỏi / gợi ý / bàn giao của thẻ → không vẽ lại để khỏi mất chữ
    const ae = root.activeElement;
    if (ae && el.contains(ae) && (ae.tagName === 'TEXTAREA' || ae.classList?.contains('osim'))) return;
    if (!qid) {
      // Không ở trang báo giá: thẻ chỉ hiện khi có bàn giao khách hàng cần xử lý
      if (!ho) {
        el.hidden = true;
        return;
      }
      const col = lsGet('dgSideCollapsed') === '1';
      el.hidden = false;
      el.classList.toggle('collapsed', col);
      setSideHtml(el, `<div class="side-h" title="Kéo để di chuyển · bấm đúp để về vị trí mặc định"><span class="side-grip">⠿</span>🔁 Bàn giao khách hàng <span class="ho-n">${hoN}</span>
        <button class="side-btn side-tg" data-side="toggle" title="${col ? 'Mở rộng thẻ' : 'Thu gọn thẻ'}">${col ? '▾ Mở' : '▴ Thu gọn'}</button></div>${col ? '' : ho}`);
      placeSide(el);
      return;
    }
    const kinds = q?.kinds || (q?.offset ? ['offset'] : []);
    const { flexo, offset } = marginParts(q);
    const busy = !!q && marginFetching.has(q.id);
    const oldFx = !!q && renderCtx.margins?.[q.code]?.flexo && flexoStale(renderCtx.margins[q.code].flexo, q);
    if (IS_TOP && q && ((kinds.includes('offset') && (offset == null || offsetStale(renderCtx.margins?.[q.code], q))) || (kinds.includes('flexo') && q.amount && (!flexo || oldFx)))) setTimeout(() => fetchMarginNow(q), 0);
    // Nhớ trạng thái bung / gập của khung Giải thích qua F5
    const open = el.querySelector('details.side-d')?.open ?? lsGet('dgExplOpen') === '1';
    const collapsed = lsGet('dgSideCollapsed') === '1';
    el.hidden = false;
    el.classList.toggle('collapsed', collapsed);
    const mini = [
      kinds.includes('flexo') ? `🟦 ${flexo ? (flexo.invalid ? '⚠️' : `<b class="${pctCls(flexo.rest)}">${flexo.rest}%</b>`) : '–'}` : '',
      kinds.includes('offset') ? `🟪 ${offset != null ? `<b class="${pctCls(offset)}">${offset}%</b>` : '–'}` : '',
    ].filter(Boolean).join(' · ');
    const header = `<div class="side-h" title="Kéo để di chuyển · bấm đúp để về vị trí mặc định"><span class="side-grip">⠿</span>📊 ${esc(q?.code || `#${qid}`)}${collapsed ? '' : `${custTag(q)}${q?.quoteStatus ? `<span class="st-pill">${esc(statusLabel(q.quoteStatus))}</span>` : ''}`}${busy ? ' <span class="spinner"></span>' : ''}
      ${collapsed ? `<span class="side-mini">${mini}</span>${hoN ? ` <span class="ho-n" title="Bàn giao khách hàng cần xử lý">🔁 ${hoN}</span>` : ''}` : ''}${collapsed ? '' : `<button class="side-btn recalc-btn" data-side="recalc" title="Tính lại giá: đọc lại bảng chiết giá / PO giấy tấm">${busy ? '<span class="spinner"></span>' : '↻'}</button>`}<button class="side-btn side-tg" data-side="toggle" title="${collapsed ? 'Mở rộng thẻ' : 'Thu gọn thẻ'}">${collapsed ? '▾ Mở' : '▴ Thu gọn'}</button></div>`;
    if (collapsed) {
      setSideHtml(el, header);
      placeSide(el);
      return;
    }
    const [info, rest] = body.includes('<!--dg-split-->') ? body.split('<!--dg-split-->') : ['', body];
    const tile = (cls, label, main, sub) => `<div class="mtile ${cls}"><div class="mt-l">${label}</div><div class="mt-v">${main}</div>${sub ? `<div class="mt-s">${sub}</div>` : ''}</div>`;
    setSideHtml(el, `${header}
      ${ho}
      ${info}
      ${kinds.length ? '<div class="side-sec">📊 Lợi nhuận đơn hàng</div><div class="mtiles">' : ''}
      ${kinds.includes('flexo') ? tile('flexo', '🟦 Flexo', flexo ? (flexo.invalid ? `<span class="warnx">⚠️ PO giấy tấm > giá trị BG</span>` : `<b class="${pctCls(flexo.rest)}">${flexo.rest}%</b>`) : waitHtml(busy), flexo ? `${flexo.invalid ? `giấy tấm ${trM(flexo.best.total)} · BG ${trM(flexo.base)}` : `giấy tấm ${flexo.cost}%`}<div class="mt-diff ${flexo.diff < 0 ? 'neg' : ''}"><span>Chênh lệch BG − giấy tấm</span><b>${flexo.diff < 0 ? '−' : '+'}${trM(Math.abs(flexo.diff))}</b></div>` : '') : ''}
      ${kinds.includes('offset') ? tile('offset', '🟪 Offset', offset != null ? `<b class="osim-top ${pctCls(offset)}">${offset}%</b>` : marginParts(q).offNoPrice ? '<span class="warnx">⚠️ Chưa cho giá (bảng chiết giá 0đ)</span>' : waitHtml(busy), offset != null ? `đang bán${(() => { const od = offsetDiff(q); return od ? `<div class="mt-nvl">NVL sau VAT${od.vat ? ` ${od.vat}%` : ''}: <b>${od.exact ? '' : '≈'}${trM(od.nvlPost)}</b> · ${od.part ? 'phần Offset' : 'BG'} ${trM(od.base)}</div><div class="mt-diff off"><span>Chênh lệch (BG − NVL sau VAT)${od.exact ? '' : ' · ước tính'}</span><b class="osim-topdiff">${od.exact ? '+' : '≈'}${trM(od.diff)}</b></div>` : ''; })()}` : '') : ''}
      ${kinds.length ? '</div>' : ''}
      ${flexo?.missing?.length ? `<div class="warnx">⚠️ Chưa đọc được PO giấy tấm của ${esc(flexo.missing.join(', '))} – % Flexo đang thiếu, sẽ tự tính lại.</div>` : ''}
      ${busy && marginStep ? `<div class="calc-step"><span class="spinner"></span>${esc(marginStep)}</div>` : ''}
      ${kinds.length ? marginBox(q, true).replace('<details class="mgnbox">', `<details class="mgnbox side-d"${open ? ' open' : ''}>`) : ''}
      ${rest}`);
    // Đang thử giá → tính lại dòng Tổng / Sau VAT / Chênh lệch theo giá thử
    el.querySelectorAll('table.osim-t').forEach((tb) => osimCalc(tb));
    placeSide(el);
  }

  const marginBox = (q, compact = false) => {
    if (!q?.code) return '';
    const kinds = q.kinds || (q.offset ? ['offset'] : []);
    if (!kinds.length) return '';
    const m = renderCtx.margins?.[q.code] || {};
    const offs = offEntries(m, q?.code);
    const fx = flexoInfo(q);
    const needOff = kinds.includes('offset') && offsetStale(m, q);
    const needFx = kinds.includes('flexo') && q.amount && (!fx || flexoStale(m.flexo, q));
    if (IS_TOP && (needOff || needFx)) setTimeout(() => fetchMarginNow(q), 0);
    const pct = marginOf(q);
    const busy = marginFetching.has(q.id);
    const parts = marginParts(q);
    const segs = [];
    if (kinds.includes('flexo')) segs.push(`🟦 Flexo ${parts.flexo ? (parts.flexo.invalid ? '<span class="warnx">⚠️ PO > giá trị BG</span>' : `<b class="${pctCls(parts.flexo.rest)}">${parts.flexo.rest}%</b>`) : `<span class="muted">${busy ? 'đang tính…' : '–'}</span>`}`);
    if (kinds.includes('offset')) segs.push(`🟪 Offset ${parts.offset != null ? `<b class="${pctCls(parts.offset)}">${parts.offset}%</b>` : `<span class="muted">${busy ? 'đang tính…' : '–'}</span>`}`);
    const head = compact ? '' : `📊 Đơn hàng này: ${segs.join(' · ')}`;
    const od = offs.length ? offsetDiff(q) : null;
    // Có tổng Nguyên liệu từng sản phẩm (đọc thẳng bảng chiết giá) → thêm cột "Nguyên liệu"
    const nvlCol = offs.some(([, x]) => x.nvlTotal > 0);
    // Thử giá: ô "Giá" sửa được (chỉ tính thử trên thẻ, không lưu vào báo giá) → tính lại %, thành tiền, chênh lệch
    const sim = nvlCol && od?.sheet;
    const simV = state.offSim?.[q.code] || {};
    const offRows = offs.map(([key, x]) => {
      const qty = numOf(x.qty);
      const p0 = numOf(x.price);
      const canSim = sim && x.nvlTotal > 0 && qty && p0;
      const pv = canSim ? simV[key] ?? p0 : p0;
      const tt = pv * qty;
      const pct = canSim ? Math.round((1 - x.nvlTotal / tt) * 1000) / 10 : x.pct;
      const priceTd = canSim
        ? `<td><input class="osim${pv !== p0 ? ' chg' : ''}" inputmode="numeric" data-code="${esc(q.code)}" data-key="${esc(key)}" data-qty="${qty}" data-nvl="${x.nvlTotal}" data-orig="${p0}" value="${pv.toLocaleString('vi-VN')}" title="Sửa giá 1 thùng để thử – giá gốc ${money(p0)}"></td>`
        : `<td>${esc(x.price || '')}</td>`;
      return `<tr class="osim-r"${canSim ? '' : ` data-tt="${p0 * qty}" data-nvl="${x.nvlTotal || 0}"`}><td>Offset · ${esc(x.spec || key)}</td><td>${esc(x.qty || '')}</td>${priceTd}${nvlCol ? `<td class="num">${x.nvlTotal ? `${money(Math.round(x.nvlTotal))}${x.nvlUnit ? `<small class="nvl-u">${money(x.nvlUnit)}/thùng</small>` : ''}` : '–'}</td>` : ''}${nvlCol ? `<td class="num"><span class="osim-tt">${tt ? money(tt) : '–'}</span></td>` : ''}<td class="num"><b class="osim-pct ${pct != null ? pctCls(pct) : ''}">${pct ?? '–'}${pct != null ? '%' : ''}</b></td></tr>`;
    }).join('') +
      (od ? offsetSteps(q, od, nvlCol) : '');
    const fxRows = fx
      ? fx.suppliers.map((s) => `<tr><td>Flexo · giấy tấm ${esc(s.code)}</td><td>${esc(s.name.split('|').pop().trim().slice(0, 40))}</td><td>${money(s.total)}</td><td class="num">${Math.round((s.total / fx.base) * 1000) / 10}%</td></tr>`).join('') +
        (fx.skipped || []).map((s) => `<tr class="muted"><td>PO ${esc(s.code)} – giấy cho sản phẩm Offset, không tính vào Flexo</td><td>${esc(s.name.split('|').pop().trim().slice(0, 40))}</td><td><s>${money(s.total)}</s></td><td></td></tr>`).join('') +
        `<tr><td><b>Tổng giấy tấm</b></td><td></td><td><b>${money(fx.best.total)}</b></td><td class="num"><b>${fx.cost}%</b></td></tr>` +
        `<tr><td><b>Chênh lệch (BG − giấy tấm)</b></td><td></td><td><b class="${fx.diff < 0 ? 'warnx' : 'pos'}">${fx.diff < 0 ? '−' : ''}${trM(Math.abs(fx.diff))}</b></td><td class="num">${fx.rest != null ? `${fx.rest}%` : ''}</td></tr>`
      : '';
    return `<details class="mgnbox"><summary>${head}${busy ? ' <span class="spinner"></span>' : ''} <span class="link">Giải thích</span></summary>
      ${offRows ? `<div class="expl"><b>Offset</b> – lấy từ bảng chiết giá (Ctrl+Shift+G): <i>Đang bán % = 1 − NVL 1 thùng ÷ giá 1 thùng</i>.</div>` : ''}
      ${fx ? `<div class="expl"><b>Flexo</b> – Lên PO → Giấy tấm, chọn từng nhà cung cấp: <i>tỉ lệ giấy tấm = (tổng PO của tất cả nhà cung cấp) ÷ ${q?.kindShare ? 'thành tiền phần Flexo' : 'tổng giá trị báo giá'} (${money(Math.round(fx.base))})</i>. ${fx.invalid
        ? `<span class="warnx">⚠️ Tổng PO giấy tấm (${money(fx.best.total)}) lớn hơn giá trị báo giá (${money(fx.base)}) <b>${trM(-fx.diff)}</b> – thường do số lượng tấm tối thiểu (MOQ) của nhà cung cấp hoặc đơn nhỏ; không tính % cho trường hợp này, cần xem tay.</span>`
        : `Tổng giấy tấm ${esc(fx.best.code)} = ${money(fx.best.total)} chiếm <b>${fx.cost}%</b> → còn lại <b>${fx.rest}%</b> (chênh lệch <b>${trM(fx.diff)}</b>).`}
        ${fx.missing.length ? `<span class="warnx">⚠️ Chưa đọc được PO của ${esc(fx.missing.join(', '))} (tải quá chậm) – tổng giấy tấm đang thiếu nhà này.</span>` : ''}</div>` : ''}
      ${offRows || fxRows ? `<table${sim ? ` class="osim-t" data-code="${esc(q.code)}" data-k="${(() => { const sv = od.rows.reduce((a, x) => a + (x.val || 0), 0); return sv ? od.base / sv : 1; })()}"` : ''}><tr><th>Hạng mục</th><th>SL / NCC</th><th>Giá / Tổng PO</th>${nvlCol ? '<th class="num">Nguyên liệu</th><th class="num">Thành tiền</th>' : ''}<th class="num">%</th></tr>${offRows}${sim ? `<tr><td colspan="6" class="osim-hint"><div class="osim-sl">🎚️ % bán (kéo phải = bán cao hơn): <span class="osim-rw"><span class="osim-bub"></span><input type="range" class="osim-range" data-code="${esc(q.code)}" min="5" max="70" step="0.5" value="${(() => {
        const rows = offs.map(([k, x]) => ({ n: x.nvlTotal, p: (simV[k] ?? numOf(x.price)) * numOf(x.qty) })).filter((r) => r.n && r.p);
        const a = rows.reduce((t, r) => t + r.n, 0);
        const b2 = rows.reduce((t, r) => t + r.p, 0);
        return b2 ? Math.round((1 - a / b2) * 200) / 2 : 40; // % bán = 1 − NVL ÷ đơn giá
      })()}"></span><b class="osim-rv"></b></div>✏️ Kéo thanh hoặc sửa ô <b>Giá</b> để thử giá mới – % và chênh lệch tự tính lại (chỉ thử trên thẻ, <b>không lưu</b> vào báo giá)${Object.keys(simV).length ? ` · <button class="osim-reset" data-act="osim-reset" data-code="${esc(q.code)}">↺ Về giá gốc</button>` : ''}</td></tr>` : ''}${nvlCol ? fxRows.replace(/(<td[^>]*>(?:(?!<td)[\s\S])*?<\/td><\/tr>)/g, '<td></td><td></td>$1') : fxRows}</table>` : (busy ? `<div class="calc-step"><span class="spinner"></span>${esc(marginStep || 'Đang tính…')}</div>` : '<div class="muted">Chưa có dữ liệu – bấm "↻ Tính ngay" để tính.</div>')}
      ${pct != null ? `<div class="muted">Flexo: % còn lại = 100% − tổng giấy tấm (mọi nhà cung cấp) / giá trị báo giá – đỏ khi dưới 30%. Offset: % = (1 − NVL sau VAT ÷ giá trị BG) × 100.</div>` : ''}
    </details>`;
  };

  // Khối "Lịch sử mua hàng" của khách trong báo giá đang mở
  const ordersBox = (q) => {
    const cid = q?.customer?.id;
    if (!cid) return '';
    const od = renderCtx.orders[cid];
    if (IS_TOP && (!od || hoursSince(od.at) > 24)) setTimeout(() => fetchOrdersNow(cid), 0);
    if (!od && ordersFetching.has(cid)) return `<div class="orders muted">🛒 Đang tải lịch sử mua hàng của khách…</div>`;
    const s = orderSummary(renderCtx.orders[cid]);
    if (!s) return `<div class="orders muted">🛒 Lịch sử mua hàng: chưa có dữ liệu – sẽ tự thu thập (hoặc bấm nút "Mua hàng" của CRM).</div>`;
    if (!s.count) return `<div class="orders">🛒 <b>Khách chưa từng mua đơn nào</b></div>`;
    const rows = s.list.slice(0, 8).map((o) => `<tr><td>${esc(o.code)}</td><td>${fmtTime(o.at)}</td><td>${esc(o.quote || '')}</td>
      <td>${esc(o.lines.map((l) => `${l.name || l.product} ×${l.qty}`).join('; ').slice(0, 90))}</td><td class="num">${o.total ? money(o.total) : ''}</td></tr>`).join('');
    return `<details class="orders"><summary>🛒 Đã mua <b>${s.count} đơn</b>${s.total ? ` · tổng <b>${money(s.total)}</b>` : ''} · 12 tháng: ${s.year} đơn${s.last ? ` · gần nhất ${ago(s.last.at)} (${esc(s.last.code)})` : ''}</summary>
      <table><tr><th>Đơn</th><th>Ngày</th><th>Báo giá</th><th>Sản phẩm</th><th class="num">Tiền</th></tr>${rows}</table></details>`;
  };

  let renderCtx = { comments: {}, quotes: {}, collected: {}, orders: {}, margins: {}, quickSent: {}, quickDraft: {} };

  const scoreCls = (s) => (s == null ? '' : s >= 8 ? 'good' : s >= 6 ? 'mid' : 'bad');
  const scoreHtml = (ev) => (ev?.score != null ? `<span class="score ${scoreCls(ev.score)}">${ev.score}/10</span>` : '');

  // Chưa được cấp quyền dùng extension
  function renderNoAccess() {
    const side = root.querySelector('.side');
    if (side) side.hidden = true;
    const fab = root.querySelector('.fab');
    if (fab) {
      fab.innerHTML = '🔒 Chưa được cấp quyền';
      fab.classList.remove('alert');
    }
    const html = `<div class="row"><h2>Đánh giá nhân viên kinh doanh</h2><span class="hbtns"><button class="x" data-act="close">×</button></span></div>
      <div class="loginreq"><div class="lr-icon">🔒</div><div class="lr-title">Tài khoản chưa được cấp quyền</div>
        <div class="lr-sub">Tài khoản <b>${esc(meName)}</b> chưa được quản trị cấp quyền sử dụng extension. Vui lòng liên hệ quản trị.</div></div>`;
    const el = root.querySelector('.panel');
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  // Hết phiên đăng nhập: không hiện dữ liệu, chỉ hiện yêu cầu đăng nhập
  function renderLoggedOut() {
    const side = root.querySelector('.side');
    if (side) side.hidden = true;
    const fab = root.querySelector('.fab');
    if (fab) {
      fab.innerHTML = '🔒 Cần đăng nhập';
      fab.classList.remove('alert');
    }
    root.querySelector('.panel').innerHTML = `
      <div class="row"><h2>Đánh giá nhân viên kinh doanh</h2><span class="hbtns"><button class="x" data-act="close">×</button></span></div>
      <div class="loginreq"><div class="lr-icon">🔒</div><div class="lr-title">Phiên đăng nhập CRM đã hết</div>
        <div class="lr-sub">Dữ liệu chỉ hiện khi đang đăng nhập bằng tài khoản của anh/chị. Vui lòng đăng nhập lại.</div>
        ${/^\/login\b/.test(location.pathname) ? '' : `<a class="lr-btn" href="/login?redirect=${encodeURIComponent(location.pathname)}">Đăng nhập</a>`}</div>`;
  }

  async function render() {
    if (!root) return;
    if (loggedOut && IS_TOP) return renderLoggedOut();
    try {
      await renderInner();
      fitAll(root.querySelector('.panel'));
      restoreScroll();
    } catch (e) {
      console.warn('[DG]', e);
      if (isOpen()) {
        root.querySelector('.panel').innerHTML = `
          <div class="row"><h2>Đánh giá nhân viên kinh doanh</h2><span class="hbtns">${fullTip()}<button class="x fs${needFull() ? ' urge' : ''}" data-act="full" title="${lsGet('dgPanelFull') === '1' ? 'Thu nhỏ lại' : 'Toàn màn hình'}">${lsGet('dgPanelFull') === '1' ? '🗗' : '⛶'}</button><button class="x" data-act="close">×</button></span></div>
          <div class="err">${esc(e.message || e)}</div>`;
      }
    }
  }

  // ---------- Tab "Khách hàng 6 tháng": doanh số theo tháng từ lịch sử mua hàng đã thu thập (kv 'orders') ----------
  // Doanh thu sau VAT: dùng tổng sau VAT của đơn nếu ERP có; không thì tiền hàng × (1 + VAT 8%)
  // (đối chiếu DH0012095: 33.752.800 × 1,08 = 36.453.024 – đúng cột "Thành tiền" trên ERP)
  const VAT_RATE = 0.08;
  const orderAfterVat = (o) => Number(o.totalVat) || Math.round((Number(o.total) || 0) * (1 + VAT_RATE));

  // ---------- Tab "Báo cáo tuần": doanh số (sau VAT) theo NVKD từ thứ 2 đến thứ 7 ----------
  // Đơn hàng lấy từ lịch sử mua hàng đã thu thập (kv 'orders'); NVKD = người phụ trách khách (cột Sale của ERP).
  // Quản trị xem báo cáo của tất cả; NVKD chỉ xem của chính mình
  const ADMIN_NAMES = ['Nguyễn Trung Toán'];
  const IS_OWNER = () => !!state.meReal && norm(state.meReal) === norm('Nguyễn Trung Toán');
  // ---------- 📈 Chênh lệch 2 hệ thống (Tuấn Tú + Đại Dương), chỉ Nguyễn Trung Toán ----------
  // Đọc dữ liệu cả 2 domain (Tuấn Tú: tên gốc, Đại Dương: tiền tố dd.), tính chênh lệch theo margins của từng domain.
  async function gapRows() {
    if (state.gapCache && Date.now() - state.gapCache.at < 60e3) return state.gapCache.rows;
    const sites = [
      { s: SITES.tuantu, host: 'https://sale.tuantu.com.vn', min: 10e6 }, // Tuấn Tú: chênh lệch từ 10 tr
      { s: SITES.daiduong, host: 'https://quanly.baobidaiduong.com', min: 10e6 }, // Đại Dương: từ 10 tr
    ];
    const rows = [];
    const keep = renderCtx.margins;
    try {
      for (const { s: st, host, min } of sites) {
        const [qs, mg] = await Promise.all([rawCall({ type: 'kv.get', key: `${st.prefix}quotes` }), rawCall({ type: 'kv.get', key: `${st.prefix}margins` })]);
        renderCtx.margins = mg || {};
        for (const q of Object.values(qs || {})) {
          if (!q?.code || !(Number(q.amount) > 0) || q.noSheet || CLOSED.has(q.quoteStatus) || q.hasOrder) continue;
          // NVKD bị loại của từng hệ thống (vd. Nguyễn Trí Thức) → ẩn
          const sn = q.staff?.name || '';
          if (sn && st.excluded.some((x) => norm(x) === norm(sn) || norm(sn).endsWith(` ${norm(x)}`))) continue;
          let v = null;
          try {
            v = diffVal(q);
          } catch {}
          if (v == null || v < min) continue;
          rows.push({ site: st, host, q, v });
        }
      }
    } finally {
      renderCtx.margins = keep;
    }
    rows.sort((a, b) => b.v - a.v);
    state.gapCache = { at: Date.now(), rows };
    return rows;
  }
  // Popup + số trên biểu tượng extension (chỉ máy của Nguyễn Trung Toán): danh sách chênh lệch 2 hệ thống + số chưa đọc
  // Thứ tự như danh sách Báo giá của CRM: vị trí trên ERP (erpRank, đọc trong 2 ngày gần đây; CRM xếp theo hoạt động mới nhất,
  // không theo ngày tạo) – 2 hệ thống xen kẽ theo vị trí; báo giá chưa có vị trí mới thì xếp sau, theo ngày tạo
  const gapRank = (q) => (q.erpRank != null && Date.now() / 1000 - (q.erpRankAt || 0) < 2 * 86400 ? q.erpRank : Infinity);
  const gapOrder = (a, b) => {
    const ra = gapRank(a.q);
    const rb = gapRank(b.q);
    if (ra !== rb) return ra === Infinity ? 1 : rb === Infinity ? -1 : ra - rb;
    return (b.q.createdAt || 0) - (a.q.createdAt || 0);
  };
  // Chép nhanh danh sách khách Đại Dương (theo NVKD) để làm việc với sếp bên đó
  // Chép nhanh danh sách khách (theo NVKD) – cùng kiểu tin nhắc cả đội trên Zalo:
  // dòng tổng, rồi mỗi NVKD: "Tên (số khách) – có thể có đơn X – chênh lệch Y:" và mỗi khách 1 dòng "• MÃ KHÁCH (giá trị · CL …)"
  function gapCopyData(rows, key = 'daiduong') {
    // mỗi khách chỉ 1 dòng: gộp các báo giá cùng khách (cộng giá trị + chênh lệch)
    const byCust = new Map();
    for (const r of rows.filter((x) => x.site.key === key)) {
      const ck = r.q.customer?.id || r.q.customer?.code || r.q.customer?.name || r.q.code;
      const cur = byCust.get(ck);
      if (cur) {
        cur.v += r.v;
        cur.q = { ...cur.q, amount: (Number(cur.q.amount) || 0) + (Number(r.q.amount) || 0) };
        cur.n++;
      } else byCust.set(ck, { ...r, q: { ...r.q }, n: 1 });
    }
    const list = [...byCust.values()].sort((a, b) => (Number(b.q.amount) || 0) - (Number(a.q.amount) || 0));
    const by = new Map();
    for (const r of list) {
      const who = shortName(r.q.staff?.name || '') || 'Chưa rõ NVKD';
      if (!by.has(who)) by.set(who, []);
      by.get(who).push(r);
    }
    const sumTxt = (v) => (Math.abs(v) >= 1e9 ? `${(Math.round(v / 1e7) / 100).toLocaleString('vi-VN')} tỷ` : `${Math.round(v / 1e6).toLocaleString('vi-VN')}tr`);
    const amt = (r) => Number(r.q.amount) || 0;
    const tot = list.reduce((t, r) => t + amt(r), 0);
    const totD = list.reduce((t, r) => t + r.v, 0);
    const head = `Danh sách khách ${key === 'daiduong' ? 'Đại Dương' : 'Tuấn Tú'} cần kéo đơn (chênh lệch ≥ 10tr): ${list.length} khách`;
    const totalLine = `Tổng có thể có đơn: ${sumTxt(tot)} · chênh lệch ${sumTxt(totD)}`;
    const groups = [...by].sort((a, b) => b[1].reduce((t, r) => t + amt(r), 0) - a[1].reduce((t, r) => t + amt(r), 0));
    const gLine = (who, rs) => `${who} (${rs.length}) – có thể có đơn ${sumTxt(rs.reduce((t, r) => t + amt(r), 0))}:`;
    const item = (r) => `${shortCompany(r.q.customer?.code || r.q.customer?.name || '')}`;
    const tail = (r) => `(${sumTxt(amt(r))})`; // giống tin nhắc cả đội: mã khách (giá trị)
    const text = [`${head}\n${totalLine}`, ...groups.map(([who, rs]) => [gLine(who, rs), ...rs.map((r) => `• ${item(r)} ${tail(r)}`)].join('\n'))].join('\n\n');
    const B = (t, c) => `<b><span style="color:${c}"><font color="${c}">${esc(t)}</font></span></b>`;
    const html = `<div>${esc(head)}</div><div>Tổng có thể có đơn: ${B(sumTxt(tot), '#047857')} · chênh lệch ${B(sumTxt(totD), '#047857')}</div><div><br></div>${groups
      .map(([who, rs]) => `<div>${B(who, '#1d4ed8')} (${rs.length}) – có thể có đơn ${B(sumTxt(rs.reduce((t, r) => t + amt(r), 0)), '#047857')}:</div>${rs.map((r) => `<div>• <b>${esc(item(r))}</b> ${esc(tail(r))}</div>`).join('')}`)
      .join('<div><br></div>')}`;
    return { text, html };
  }
  const gapCopyText = (rows, key) => gapCopyData(rows, key).text;
  const GAP_RANGES = [
    { k: 'r10', t: '10–30tr', c: '#2563eb', bg: '#eff6ff', min: 10e6, max: 30e6 },
    { k: 'r30', t: '30–50tr', c: '#1e3a8a', bg: '#eef2ff', min: 30e6, max: 50e6 },
    { k: 'r50', t: '50–100tr', c: '#15803d', bg: '#f0fdf4', min: 50e6, max: 100e6 },
    { k: 'r100', t: '≥ 100tr', c: '#b45309', bg: '#fffbeb', min: 100e6, max: Infinity },
  ];
  const gapRange = (v) => GAP_RANGES.find((b) => v >= b.min && v < b.max)?.k || 'r0';
  async function gapToPopup() {
    if (!IS_TOP) return;
    if (!state.meReal) state.meReal = (await kvGet('me'))?.name || ''; // bảng chưa mở vẫn biết tài khoản
    if (!IS_OWNER()) return;
    const all = await gapRows();
    const byDiff = lsGet('dgGapSort') === 'diff';
    const rows = all.slice().sort((a, b) => (byDiff ? b.v - a.v : gapOrder(a, b)));
    const unread = rows.filter((r) => r.q.isRead === false).length;
    const big = (v) => (Math.abs(v) >= 1e9 ? `${(v / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ` : trM(v));
    const sumOf = (k) => rows.filter((r) => r.site.key === k).reduce((t, r) => t + r.v, 0);
    const card = {
      title: '📈 Chênh lệch 2 hệ thống',
      actions: [
        (({ text, html }) => ({ label: '📋 Copy danh sách khách Đại Dương', copy: text, copyHtml: html, color: '#2563eb' }))(gapCopyData(rows, 'daiduong')),
        (({ text, html }) => ({ label: '📋 Copy Tuấn Tú', copy: text, copyHtml: html, color: '#dc2626' }))(gapCopyData(rows, 'tuantu')),
      ],
      width: 800, // popup rộng tối đa (extension ≥ 1.4.0)
      sub: `Tuấn Tú ≥ 10 tr · Đại Dương ≥ 10 tr · ${byDiff ? 'theo chênh lệch' : 'như danh sách báo giá'} · cập nhật ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`,
      chips: [
        { text: `● Chưa đọc ${unread}`, color: '#b91c1c', filter: 'unread' },
        { text: `Tất cả ${rows.length}`, color: '#334155', filter: '' },
        { text: `🟥 Tuấn Tú · Σ chênh lệch ${big(sumOf('tuantu'))}`, color: '#dc2626', filter: 'tuantu' },
        { text: `🟦 Đại Dương · Σ chênh lệch ${big(sumOf('daiduong'))}`, color: '#2563eb', filter: 'daiduong' },
        // khoảng chênh lệch (lọc riêng, kết hợp được với chip trên – extension ≥ 1.7.4)
        ...GAP_RANGES.map((b) => ({ g: 'range', text: `${b.t} ${rows.filter((r) => gapRange(r.v) === b.k).length}`, color: b.c, bg: b.bg, filter: b.k })),
      ],
      groups: { range: '📈 Chênh lệch:' },
      rows: rows.map((r) => ({ // hiện đủ mọi báo giá đủ điều kiện, không giới hạn
        tag: r.site.key === 'tuantu' ? 'TT' : 'ĐD',
        tagColor: r.site.key === 'tuantu' ? '#dc2626' : '#2563eb',
        title: `${r.q.code} ${shortCompany(r.q.customer?.code || r.q.customer?.name || '')}`,
        sub: `${shortName(r.q.staff?.name || '')} · ${r.q.name || ''}`,
        right: `${r.v < 0 ? '−' : ''}${trM(Math.abs(r.v))}`,
        ...(([rightColor, rightBg]) => ({ rightColor, rightBg }))(diffColors(r.v)),
        unread: r.q.isRead === false ? true : r.q.isRead === true ? false : undefined,
        f: [r.site.key, ...(r.q.isRead === false ? ['unread'] : []), gapRange(r.v)], // cho chip lọc trong popup
        url: `${r.host}/bao-gia/update/${r.q.id}`,
      })),
      at: Date.now(),
    };
    // Số trên biểu tượng: ghi lại mỗi lượt (kèm thời điểm → background luôn nhận thay đổi và vẽ lại, kể cả sau khi tải lại extension)
    await call({ type: 'kv.set', key: 'badge', value: { text: unread ? String(unread) : '', color: '#dc2626', anim: unread ? 'pulse' : '', title: `${unread} báo giá chênh lệch lớn chưa đọc (Tuấn Tú + Đại Dương)`, at: Date.now() } });
    const sig = JSON.stringify([card.chips, card.rows, card.actions]); // kể cả nội dung nút chép (đổi định dạng → ghi lại)
    if (sig === state.gapPopupSig) return;
    state.gapPopupSig = sig;
    await kvMerge('popupCards', { gap: card });
  }
  setTimeout(() => gapToPopup().catch(() => {}), 8e3);
  setInterval(() => gapToPopup().catch(() => {}), 60e3);
  async function gapTab() {
    const all = await gapRows();
    const f = lsGet('dgGapSite') || '';
    const byDiff = lsGet('dgGapSort') === 'diff';
    // Mặc định: như thứ tự danh sách Báo giá của CRM (mới tạo trước; cùng hệ thống thì theo vị trí trên ERP)
    const rows = (f === 'unread' ? all.filter((r) => r.q.isRead === false) : f ? all.filter((r) => r.site.key === f) : all.slice()).sort((a, b) =>
      byDiff ? b.v - a.v : gapOrder(a, b),
    );
    const sum = (list) => list.reduce((t, r) => t + r.v, 0);
    const big = (v) => (Math.abs(v) >= 1e9 ? `${(v / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ` : trM(v));
    const chip = (k, label, list, col) =>
      `<button class="gp-chip${f === k ? ' on' : ''}" data-act="gap-site" data-site="${k}" style="--c:${col}">${label} <b>${list.length}</b> · Σ chênh lệch ${big(sum(list))}</button>`;
    const tt = all.filter((r) => r.site.key === 'tuantu');
    const dd = all.filter((r) => r.site.key === 'daiduong');
    const unread = all.filter((r) => r.q.isRead === false).length;
    return `<div class="gp">
      <div class="gp-h"><b>📈 Báo giá có chênh lệch – Tuấn Tú + Đại Dương</b><span class="muted">Tuấn Tú ≥ 10 tr · Đại Dương ≥ 10 tr · chỉ báo giá chưa chốt / chưa lên đơn</span>
        <button class="gp-chip" data-act="gap-copy" data-site="daiduong" style="--c:#2563eb;margin-left:auto">📋 Copy khách Đại Dương</button>
        <button class="gp-chip" data-act="gap-sort" style="--c:#475569">↕ ${byDiff ? 'Theo chênh lệch' : 'Như danh sách báo giá'}</button></div>
      <div class="gp-chips"><button class="gp-chip${f === 'unread' ? ' on' : ''}" data-act="gap-site" data-site="unread" style="--c:#b91c1c">● Chưa đọc <b>${unread}</b></button>${chip('', 'Tất cả', all, '#334155')}${chip('tuantu', '🟥 Tuấn Tú', tt, '#dc2626')}${chip('daiduong', '🟦 Đại Dương', dd, '#2563eb')}</div>
      <div class="gp-list">${rows
        .slice(0, 300)
        .map((r, i) => {
          const q = r.q;
          const staff = q.staff?.name || '';
          const rd = q.isRead === false ? ' unread' : q.isRead === true ? ' read' : '';
          return `<a class="gp-row${rd}" title="${q.isRead === false ? 'Chưa đọc' : q.isRead === true ? 'Đã đọc' : ''}" href="${r.host}/bao-gia/update/${q.id}" target="_blank" rel="noopener">
            <span class="gp-no">${i + 1}</span><span class="gp-site ${r.site.key}">${r.site.key === 'tuantu' ? 'TT' : 'ĐD'}</span>
            <span class="gp-main"><b>${esc(q.code)}</b> <span class="gp-cust">${esc(shortCompany(q.customer?.code || q.customer?.name || ''))}</span><span class="gp-name">${esc(q.name || '')}</span></span>
            <span class="gp-staff">${esc(shortName(staff))}</span>
            <span class="gp-amt">${moneyShortG(Number(q.amount))}</span>
            <span class="gp-diff">${diffPillV(r.v)}</span></a>`;
        })
        .join('') || '<div class="muted">Chưa có báo giá nào tính được chênh lệch.</div>'}</div>
      ${rows.length > 300 ? `<div class="muted">… và ${rows.length - 300} báo giá nhỏ hơn</div>` : ''}</div>`;
  }
  // Màu theo mức chênh lệch (quy định chung): <5tr tím · <10tr cam · <30tr xanh dương · <50tr xanh đậm · ≥50tr xanh lá · âm đỏ
  const diffColors = (v) => (v < 0 ? ['#b91c1c', '#fee2e2'] : v < 5e6 ? ['#7e22ce', '#f3e8ff'] : v < 10e6 ? ['#c2410c', '#ffedd5'] : v < 30e6 ? ['#2563eb', '#dbeafe'] : v < 50e6 ? ['#1e3a8a', '#c7d2fe'] : ['#15803d', '#dcfce7']);
  const diffPillV = (v) => {
    const [fg, bg] = diffColors(v);
    return `<span style="display:inline-block;font-weight:800;color:${fg};background:${bg};border-radius:999px;padding:0 8px;white-space:nowrap;font-variant-numeric:tabular-nums">${v < 0 ? '−' : ''}${trM(Math.abs(v))}</span>`;
  };
  // ---------- Phân quyền (kv 'perms', đồng bộ): ai được dùng extension, vào được tab nào ----------
  // perms = { enforced: bool, users: { <tên chuẩn hoá>: { name, enabled, role: 'admin'|'sale', tabs: [...] } } }
  const TABS = [['quotes', '🎯 Báo giá'], ['hot', '🔥 Gợi ý chốt đơn'], ['deal', '🧠 Phân tích deal'], ['cust', '👥 Khách hàng'], ['week', '📅 Báo cáo tuần'], ['debt', '💰 Công nợ'], ['qa', '💬 Bộ câu hỏi'], ['set', '⚙️ Cài đặt']];
  // Ngoài các tab: quyền xem thẻ báo giá bên phải (lợi nhuận, câu hỏi gợi ý, đánh giá NVKD, bàn giao)
  const PERM_ITEMS = [...TABS, ['side', '📌 Thẻ báo giá (bên phải)']];
  const SALE_TABS = ['hot', 'deal', 'week']; // mặc định cho NVKD khi mới cấp quyền
  let PERMS = {};
  let MY_ACCESS = true;
  let MY_ADMIN = false; // quản trị (cập nhật mỗi lần vẽ bảng)
  const builtinAdmin = (me) =>
    me?.isAdmin === true ||
    me?.username === 'admin' ||
    /admin|quản trị|giám đốc|director|ceo|quản lý/i.test(me?.role || '') ||
    ADMIN_NAMES.some((n) => norm(n) === norm(me?.name || meName));
  function userPerm(me) {
    const name = me?.name || meName;
    const u = PERMS.users?.[norm(name)];
    const all = PERM_ITEMS.map((t) => t[0]);
    if (builtinAdmin(me) || u?.role === 'admin') return { access: true, admin: true, tabs: all, side: true };
    if (!PERMS.enforced) return { access: true, admin: false, tabs: all, side: true }; // chưa bật phân quyền → như cũ
    if (!u?.enabled) return { access: false, admin: false, tabs: [], side: false };
    const tabs = (u.tabs?.length ? u.tabs : SALE_TABS).filter((t) => PERM_ITEMS.some((x) => x[0] === t));
    return { access: true, admin: false, tabs, side: tabs.includes('side') };
  }

  const isAdminUser = (me) =>
    PERMS.users?.[norm(me?.name || meName)]?.role === 'admin' ||
    me?.isAdmin === true ||
    me?.username === 'admin' ||
    /admin|quản trị|giám đốc|director|ceo|quản lý/i.test(me?.role || '') ||
    ADMIN_NAMES.some((n) => norm(n) === norm(me?.name || meName));

  // Doanh số (sau VAT) của 1 NVKD trong khoảng [start, end) – dùng cho tổng quan 4 tuần
  function staffSales(staff, info, orders, start, end) {
    let total = 0;
    let n = 0;
    for (const [cid, od] of Object.entries(orders || {})) {
      if (norm(info[cid]?.staff) !== norm(staff)) continue;
      for (const o of od?.orders || []) {
        const at = o.at > 1e11 ? o.at / 1000 : o.at;
        if (!at || at < start || at >= end) continue;
        total += orderAfterVat(o);
        n++;
      }
    }
    return { total, n };
  }

  // Tổng quan 4 tuần gần nhất của 1 NVKD: mỗi tuần 1 cột mốc doanh thu (T2 → T7), nối bằng đường xu hướng
  function staffOverview(staff, info, orders, now, dd) {
    const thisMon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const weeks = [3, 2, 1, 0].map((k) => {
      const m = new Date(thisMon.getFullYear(), thisMon.getMonth(), thisMon.getDate() - k * 7);
      const sat = new Date(m.getFullYear(), m.getMonth(), m.getDate() + 5);
      return { m, sat, k, ...staffSales(staff, info, orders, m.getTime() / 1000, m.getTime() / 1000 + 6 * 86400) };
    });
    const max = Math.max(...weeks.map((w) => w.total), 1);
    const best = weeks.reduce((a, w) => (w.total > a.total ? w : a), weeks[0]);
    const avg = weeks.reduce((a, w) => a + w.total, 0) / 4;
    const H = 150;
    const pts = weeks.map((w, i) => `${i * 100 + 50},${H - Math.round((w.total / max) * (H - 20)) + 4}`).join(' ');
    const cols = weeks
      .map((w, i) => {
        const prev = weeks[i - 1];
        const chg = prev && prev.total ? Math.round(((w.total - prev.total) / prev.total) * 100) : null;
        const h = Math.max(4, Math.round((w.total / max) * (H - 20)));
        return `<div class="ov-col${w.k === 0 ? ' now' : ''}${w === best && w.total ? ' best' : ''}" style="animation-delay:${i * 120}ms">
          <div class="ov-val">${w.total ? moneyShortG(w.total) : '—'}${chg != null ? `<span class="ct-chg ${chg >= 0 ? 'up' : 'down'}">${chg >= 0 ? '↑' : '↓'}${Math.abs(chg)}%</span>` : ''}</div>
          <div class="ov-barwrap" style="height:${H}px"><div class="ov-bar" style="--h:${h}px; animation-delay:${200 + i * 120}ms">${w === best && w.total ? '<span class="ov-star">⭐</span>' : ''}</div></div>
          <div class="ov-wk">${w.k === 0 ? 'Tuần này' : `${w.k} tuần trước`}</div><div class="ov-date">${dd(w.m)}–${dd(w.sat)} · ${w.n} đơn</div></div>`;
      })
      .join('');
    return `<div class="ov"><div class="ov-head"><span class="ct-who">${avatarHtml(staff, 34)}<b>${esc(staff)}</b></span>
        <span class="ov-kpi">Tổng 4 tuần <b>${moneyShortG(weeks.reduce((a, w) => a + w.total, 0))}</b></span>
        <span class="ov-kpi">Trung bình/tuần <b>${moneyShortG(avg)}</b></span>
        <span class="ov-kpi">Tuần tốt nhất <b>${best.total ? `${dd(best.m)} · ${moneyShortG(best.total)}` : '—'}</b></span></div>
      <div class="ov-chart"><svg class="ov-line" viewBox="0 0 400 ${H + 10}" preserveAspectRatio="none"><polyline points="${pts}" /></svg>${cols}</div></div>`;
  }

  // ---------- Làm báo cáo tuần: duyệt từng khách hàng của NVKD, viết bình luận, Next, xong thì In ----------
  // Lưu kv 'reports' (đồng bộ giữa các máy): khoá "<nvkd>|<thứ 2 của tuần>" → { items: { cid: { comment, at } }, doneAt }
  const reportKey = (staff, now) => {
    const m = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)); // thứ 2 của tuần chứa ngày 'now'
    return `${norm(staff)}|${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${String(m.getDate()).padStart(2, '0')}`;
  };
  function reportCustomers(staff, info, orders) {
    const quotes = renderCtx.quotes || {};
    const comments = renderCtx.comments || {};
    const mine = (n) => norm(n) === norm(staff);
    const { months, rows } = custRows(quotes, orders);
    const byCid = {};
    for (const r of rows.filter((x) => mine(x.staff))) byCid[r.cid] = { cid: r.cid, name: r.name, m: r.m, trend: r.trend, total: r.total, pending: [] };
    for (const q of Object.values(quotes)) {
      if (!q?.id || !mine(q.staff?.name) || !q.customer?.id || !q.quoteStatus || CLOSED.has(q.quoteStatus) || hasOrderFull(q, comments[q.id])) continue;
      if (!q.createdAt || hoursSince(q.createdAt) > 90 * 24) continue;
      const g = (byCid[q.customer.id] ||= { cid: q.customer.id, name: q.customer.name, m: [0, 0, 0, 0, 0, 0], trend: null, total: 0, pending: [] });
      g.pending.push(q);
    }
    // Thêm mọi khách NVKD phụ trách có báo giá trong 6 tháng (kể cả đã chốt / thất bại, chưa có đơn)
    for (const q of Object.values(quotes)) {
      if (!q?.customer?.id || !mine(q.staff?.name) || !q.createdAt || hoursSince(q.createdAt) > 183 * 24) continue;
      byCid[q.customer.id] ||= { cid: q.customer.id, name: q.customer.name, m: [0, 0, 0, 0, 0, 0], trend: null, total: 0, pending: [] };
    }
    const list = Object.values(byCid).filter((g) => !isHiddenCust(g, renderCtx.custHidden));
    list.forEach((g) => (g.pendingAmount = g.pending.reduce((a, q) => a + (Number(q.amount) || 0), 0)));
    list.sort((a, b) => b.pendingAmount + b.total - (a.pendingAmount + a.total));
    return { months, list };
  }
  function reportScreen(staff, info, orders, now, dd) {
    const key = reportKey(staff, now);
    const rep = (renderCtx.reports || {})[key] || { items: {} };
    const { months, list } = reportCustomers(staff, info, orders);
    const total = list.length;
    const idx = Math.max(0, Math.min(state.report.idx || 0, total));
    const doneN = list.filter((g) => rep.items?.[g.cid]?.comment?.trim()).length;
    state.rpList = list.map((g) => String(g.cid)); // để nút Hoàn tất kiểm tra đủ 100%
    state.rpKey = key;
    // Chỉ vào màn hình tổng kết khi đã báo cáo đủ 100% khách
    if ((state.report.idx || 0) >= total && doneN < total) state.report.idx = Math.max(0, list.findIndex((g) => !rep.items?.[g.cid]?.comment?.trim()));
    const head = `<div class="ct-head sc-head"><button class="sc-back" data-act="report-exit" title="Thoát, phần đã viết vẫn được lưu">← Thoát</button>
      <span class="ct-who">${avatarHtml(staff, 40)}<span><div class="ct-title">📝 Báo cáo tuần · ${esc(staff)}</div>
      <div class="ct-sub">Tuần ${key.split('|')[1].split('-').reverse().slice(0, 2).join('/')} · đã viết ${doneN}/${total} khách</div></span></span></div>
      <div class="rp-prog"><i style="width:${total ? Math.round((Math.min(idx, total) / total) * 100) : 100}%"></i></div>`;
    // Xong hết → màn hình tổng kết + In
    if (idx >= total) {
      const rowsHtml = list
        .map((g, i) => `<tr><td>${i + 1}</td><td><b>${esc(shortCompany(g.name))}</b></td><td class="num">${g.m[5] ? money(g.m[5]) : '—'}</td>
          <td class="num">${g.trend != null ? `<span class="ct-chg ${g.trend >= 0 ? 'up' : 'down'}">${g.trend >= 0 ? '↑' : '↓'}${Math.abs(g.trend)}%</span>` : ''}</td>
          <td class="num">${g.pending.length ? `${g.pending.length} BG · ${moneyShortG(g.pendingAmount)}` : '—'}</td>
          <td class="rp-cmt">${esc(rep.items?.[g.cid]?.comment || '') || '<span class="muted">(chưa viết)</span>'}</td>
          <td><button class="act" data-act="report-goto" data-i="${i}">Sửa</button></td></tr>`)
        .join('');
      return `<div class="ctab wk rp">${head}
        <div class="rp-done"><div class="rp-done-t">🎉 Đã duyệt xong ${total} khách hàng</div>
          <div class="rp-done-b"><button class="rp-start big" data-act="report-print">🖨 In danh sách báo cáo</button>
          <button class="act" data-act="report-goto" data-i="0">↺ Xem lại từ đầu</button></div></div>
        <div class="ct-wrap"><table class="ct"><thead><tr><th>#</th><th>Khách hàng</th><th class="num">Tháng ${months[5].label}</th><th class="num">Xu hướng</th><th class="num">Tồn đọng</th><th>Bình luận báo cáo</th><th></th></tr></thead>
        <tbody>${rowsHtml || '<tr><td colspan="7" class="muted">Không có khách hàng nào.</td></tr>'}</tbody></table></div></div>`;
    }
    // Danh sách nút từng khách: xám tro = đã có bình luận báo cáo, đỏ = chưa; ✓ đã chốt (có đơn 6 tháng) / ⏳ chưa chốt
    const chips = `<div class="rp-chips">${list
      .map((x, i) => {
        const done = !!rep.items?.[x.cid]?.comment?.trim();
        const won = x.total > 0;
        return `<button class="rp-chip ${done ? 'ok' : 'no'}${i === idx ? ' cur' : ''}" data-act="report-goto" data-i="${i}" title="${esc(x.name)} – ${done ? 'đã báo cáo' : 'chưa báo cáo'} · ${won ? 'đã chốt (có đơn)' : 'chưa chốt'}">${won ? '✓' : '⏳'} ${esc(shortCompany(x.name))}</button>`;
      })
      .join('')}</div>`;
    const g = list[idx];
    // Hiệu ứng chỉ khi đổi sang khách khác (bảng tự vẽ lại khi có dữ liệu mới – không được nhấp nháy như F5)
    const cardAnim = state.rpAnimKey !== `${key}:${g.cid}`;
    state.rpAnimKey = `${key}:${g.cid}`;
    const od = (orders || {})[g.cid];
    const sixAgo = Date.now() / 1000 - 183 * 86400;
    const won = (od?.orders || [])
      .filter((o) => (o.at > 1e11 ? o.at / 1000 : o.at) >= sixAgo)
      .sort((a, b) => b.at - a.at);
    const wonHtml = won.length
      ? won
          .slice(0, 6)
          .map((o) => `<div class="rp-q won"><b>${esc(o.code || '')}</b> ${o.quote ? `<span class="muted">· ${esc(o.quote)}</span>` : ''} <span class="muted">· ${ago(o.at)} · ${esc(o.status || '')}</span><span class="rp-qa">${money(orderAfterVat(o))}</span></div>`)
          .join('') + (won.length > 6 ? `<div class="muted rp-more">… và ${won.length - 6} đơn khác</div>` : '')
      : '<div class="muted">Chưa có đơn nào trong 6 tháng</div>';
    const lastOrder = od?.orders?.length ? [...od.orders].sort((a, b) => b.at - a.at)[0] : null;
    const maxM = Math.max(...g.m, 1);
    const spark = g.m
      .map((v, k) => `<div class="rp-mcol"><div class="rp-mbar" style="height:${Math.max(3, Math.round((v / maxM) * 70))}px" title="${money(v)}"></div><div class="rp-mv">${v ? moneyShortG(v) : '—'}</div><div class="rp-ml">${months[k].label.slice(0, 2)}</div></div>`)
      .join('');
    // Báo giá tồn đọng: hiện 4 cái lớn nhất, còn lại bấm "Xem thêm"
    const PEND_SHOW = 4;
    const pendOpen = String(state.rpPendOpen) === String(g.cid);
    const pendSorted = g.pending.sort((a, b) => (b.amount || 0) - (a.amount || 0));
    const pend = (pendOpen ? pendSorted : pendSorted.slice(0, PEND_SHOW))
      .map((q) => {
        const last = lastComment(renderCtx.comments?.[q.id]);
        return `<div class="rp-q"><a href="/bao-gia/update/${q.id}" target="_blank" rel="noopener"><b>${esc(q.code)}</b></a> ${esc(q.name || '')}
          <span class="rp-qa">${noPrice(q) ? '⚠️ Chưa cho giá' : money(q.amount || 0)}</span>
          ${last ? `<div class="rp-ql">💬 ${esc(last.staff?.name || '')}: ${esc((last.text || '').slice(0, 160))} <span class="muted">· ${ago(last.createdAt)}</span></div>` : '<div class="rp-ql muted">Chưa có bình luận</div>'}</div>`;
      })
      .join('') +
      (pendSorted.length > PEND_SHOW
        ? `<button class="rp-morebtn" data-act="rp-pend-more" data-cid="${g.cid}">${pendOpen ? '▲ Thu gọn' : `▼ Xem thêm ${pendSorted.length - PEND_SHOW} báo giá (${moneyShortG(pendSorted.slice(PEND_SHOW).reduce((a, q) => a + (Number(q.amount) || 0), 0))})`}</button>`
        : '');
    return `<div class="ctab wk rp">${head}
      ${chips}
      <div class="rp-card${cardAnim ? ' anim' : ''}">
        <div class="rp-step">Khách ${idx + 1}/${total} · <span class="rp-st ${g.total > 0 ? 'won' : 'open'}">${g.total > 0 ? '✓ Đã chốt được (có đơn 6 tháng)' : '⏳ Chưa chốt được'}</span></div>
        <div class="rp-name"><a class="sc-link" href="/khach-hang/view/${g.cid}?t=order" target="_blank" rel="noopener" title="${esc(g.name)}">${esc(shortCompany(g.name))}</a>
          ${g.trend != null ? `<span class="ct-chg ${g.trend >= 0 ? 'up' : 'down'}">${g.trend >= 0 ? '↑' : '↓'}${Math.abs(g.trend)}%</span>` : ''}</div>
        <div class="rp-meta">Doanh thu 6 tháng ${moneyShortG(g.total)}${lastOrder ? ` · đơn gần nhất ${esc(lastOrder.code)} ${ago(lastOrder.at)}` : ' · chưa có đơn trong dữ liệu'}${g.pending.length ? ` · <b>${g.pending.length} báo giá tồn đọng${g.pendingAmount ? ` (${moneyShortG(g.pendingAmount)})` : ' (chưa cho giá)'}</b>` : ''}</div>
        <div class="rp-grid"><div><div class="rp-sec">📊 Doanh thu 6 tháng (sau VAT)</div><div class="rp-spark">${spark}</div></div>
          <div><div class="rp-sec">⏳ Chưa chốt – báo giá tồn đọng (${g.pending.length})</div>${pend || '<div class="muted">Không có báo giá tồn đọng</div>'}
            <div class="rp-sec">✅ Đã chốt – đơn hàng 6 tháng (${won.length})</div>${wonHtml}</div></div>
        <div class="rp-sec">✍️ Bình luận báo cáo về khách hàng này</div>
        <textarea class="rp-text" data-key="${esc(key)}" data-cid="${g.cid}" rows="4" placeholder="Tình hình khách, kế hoạch tuần tới, khó khăn cần hỗ trợ…">${esc(rep.items?.[g.cid]?.comment || '')}</textarea>
        <div class="rp-nav"><button class="act" data-act="report-goto" data-i="${idx - 1}" ${idx === 0 ? 'disabled' : ''}>← Trước</button>
          <span class="muted">Tự lưu khi gõ · đồng bộ các máy</span>
          ${idx + 1 >= total
            ? `<button class="rp-start${doneN + (rep.items?.[g.cid]?.comment?.trim() ? 0 : 1) < total ? ' locked' : ''}" data-act="report-finish" title="Chỉ hoàn tất khi đã viết báo cáo cho 100% khách">✓ Hoàn tất (${doneN}/${total})</button>`
            : `<button class="rp-start" data-act="report-goto" data-i="${idx + 1}">Next →</button>`}</div>
      </div></div>`;
  }
  function printReport(staff) {
    const now = new Date();
    const key = reportKey(staff, now);
    const rep = (renderCtx.reports || {})[key] || { items: {} };
    const { months, list } = reportCustomers(staff, {}, renderCtx.orders);
    const rows = list
      .map((g, i) => `<tr><td>${i + 1}</td><td><b>${esc(g.name)}</b></td><td class="n">${money(g.m[5])}</td><td class="n">${money(g.m[4])}</td>
        <td class="n">${g.trend != null ? `${g.trend >= 0 ? '+' : ''}${g.trend}%` : ''}</td><td class="n">${g.pending.length ? `${g.pending.length} BG · ${money(g.pendingAmount)}` : ''}</td>
        <td>${esc(rep.items?.[g.cid]?.comment || '')}</td></tr>`)
      .join('');
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Báo cáo tuần – ${esc(staff)}</title><style>
      body{font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;margin:24px} h1{font-size:20px;margin:0} .s{color:#555;margin:4px 0 14px}
      table{width:100%;border-collapse:collapse} th,td{border:1px solid #ccc;padding:6px 8px;vertical-align:top} th{background:#f1f5f9;text-align:left}
      .n{text-align:right;white-space:nowrap} @media print{body{margin:10mm}}</style></head><body>
      <h1>Báo cáo tuần – ${esc(staff)}</h1><div class="s">Tuần bắt đầu ${key.split('|')[1].split('-').reverse().join('/')} · ${list.length} khách hàng · in lúc ${now.toLocaleString('vi-VN')}</div>
      <table><thead><tr><th>#</th><th>Khách hàng</th><th>Tháng ${months[5].label}</th><th>Tháng ${months[4].label}</th><th>Xu hướng</th><th>Báo giá tồn đọng</th><th>Bình luận báo cáo</th></tr></thead>
      <tbody>${rows}</tbody></table><script>setTimeout(()=>print(),300)<\/script></body></html>`);
    w.document.close();
  }

  // Lời chúc mừng (top cao) / động viên (hạng thấp) theo hạng tuần
  function cheerHtml(staff, allRows) {
    const rank = allRows.findIndex((r) => norm(r.staff) === norm(staff));
    const name = shortName(staff) || 'bạn';
    const n = allRows.length;
    const gapUp = rank > 0 ? allRows[rank - 1].total - allRows[rank].total + 1 : 0;
    const confetti = (k) =>
      `<span class="ch-conf">${[...Array(k)].map((_, i) => `<i style="left:${(i * 97) % 100}%;animation-delay:${(i % 7) * 0.25}s">${['🎉', '✨', '🎊', '⭐'][i % 4]}</i>`).join('')}</span>`;
    if (rank < 0)
      return `<div class="cheer low"><span class="ch-ic">🚀</span><div><b>${esc(name)} ơi, tuần này mình chưa có đơn nào!</b>
        <div>Mỗi tuần là một cơ hội mới – chốt đơn đầu tiên là có mặt trên bảng xếp hạng ngay. Cố lên nhé! 💪</div></div></div>`;
    if (rank === 0)
      return `<div class="cheer top1">${confetti(14)}<span class="ch-ic">🏆</span><div><b>Chúc mừng ${esc(name)}! Đang DẪN ĐẦU tuần này 🎉</b>
        <div>Doanh số ${money(allRows[0].total)}${allRows[1] ? ` – bỏ xa hạng 2 tới ${moneyShortG(allRows[0].total - allRows[1].total)}` : ''}. Giữ vững phong độ nhé!</div></div></div>`;
    if (rank <= 2)
      return `<div class="cheer top">${confetti(8)}<span class="ch-ic">${rank === 1 ? '🥈' : '🥉'}</span><div><b>Tuyệt vời ${esc(name)}! Đang đứng TOP ${rank + 1} tuần này 👏</b>
        <div>Chỉ còn thiếu <b>${money(gapUp)}</b> nữa là vượt ${esc(shortName(allRows[rank - 1].staff))} lên hạng ${rank}. Bứt tốc thôi!</div></div></div>`;
    if (rank === n - 1)
      return `<div class="cheer low"><span class="ch-ic">💪</span><div><b>${esc(name)} cố lên! Tuần này mình đang ở cuối bảng</b>
        <div>Chỉ cần thêm <b>${money(gapUp)}</b> là vượt lên hạng ${rank}. Gọi lại các báo giá đang chờ – một đơn là đổi vị trí ngay! 🔥</div></div></div>`;
    return `<div class="cheer mid"><span class="ch-ic">🔥</span><div><b>${esc(name)} đang hạng ${rank + 1}/${n} – cố thêm chút nữa!</b>
      <div>Thêm <b>${money(gapUp)}</b> là lên hạng ${rank}. Top 3 đang ở rất gần, tăng tốc nhé! 🚀</div></div></div>`;
  }

  // Màn hình riêng của 1 NVKD (quản trị bấm từ bảng xếp hạng): hạng tuần này, 4 cột mốc tuần, danh sách đơn 4 tuần
  function staffScreen(staff, info, orders, now, dd, allRows) {
    const rank = allRows.findIndex((r) => norm(r.staff) === norm(staff));
    const quotes = renderCtx.quotes || {};
    const comments = renderCtx.comments || {};
    const mine = (n) => norm(n) === norm(staff);
    // Khách hàng NVKD đang phụ trách (theo cột Sale của ERP, lấy từ báo giá)
    const custs = new Set(Object.entries(info).filter(([, v]) => mine(v.staff)).map(([cid]) => cid));
    // Báo giá chưa chốt (chưa lên đơn, chưa chốt/thất bại) trong 90 ngày → tồn đọng, gom theo khách
    const open = Object.values(quotes).filter(
      (q) => q?.id && mine(q.staff?.name) && q.quoteStatus && !CLOSED.has(q.quoteStatus) && !hasOrderFull(q, comments[q.id]) && q.createdAt && hoursSince(q.createdAt) <= 90 * 24,
    );
    const byCust = {};
    for (const q of open) {
      const k = q.customer?.id || `q${q.id}`;
      const g = (byCust[k] ||= { cid: q.customer?.id, name: q.customer?.name || q.name || q.code, n: 0, amount: 0, codes: [] });
      g.n++;
      g.amount += Number(q.amount) || 0;
      g.codes.push(q);
    }
    const pending = Object.values(byCust).sort((a, b) => b.amount - a.amount);
    const openAmount = open.reduce((a, q) => a + (Number(q.amount) || 0), 0);
    // Xu hướng doanh số khách (TB 3 tháng gần nhất so với 2 tháng đầu trong 6 tháng)
    const trendRows = custRows(quotes, orders).rows.filter((r) => mine(r.staff) && r.trend != null);
    const down = trendRows.filter((r) => r.trend < 0).sort((a, b) => a.trend - b.trend).slice(0, 8);
    const up = trendRows.filter((r) => r.trend > 0).sort((a, b) => b.trend - a.trend).slice(0, 8);
    const custLink = (cid, name) =>
      cid && /^\d+$/.test(String(cid)) ? `<a class="sc-link" href="/khach-hang/view/${cid}?t=order" target="_blank" rel="noopener" title="${esc(name)}">${esc(shortCompany(name))}</a>` : esc(shortCompany(name));
    const kpi = (icon, label, val, sub = '', cls = '') => `<div class="sc-kpi ${cls}"><div class="sc-ki">${icon}</div><div><div class="sc-kl">${label}</div><div class="sc-kv">${val}</div>${sub ? `<div class="sc-ks">${sub}</div>` : ''}</div></div>`;
    const trendList = (list, cls) =>
      list.length
        ? `<div class="sc-li sc-lh"><span>Khách hàng</span><span>Xu hướng</span><span>3 tháng gần nhất</span></div>` +
          list.map((r) => `<div class="sc-li">${custLink(r.cid, r.name)}<span class="sc-pct ${cls}">${r.trend >= 0 ? '↑' : '↓'}${Math.abs(r.trend).toLocaleString('vi-VN')}%</span><span class="sc-amt">${moneyShortG(r.m[4] + r.m[3] + r.m[2])}</span></div>`).join('')
        : '<div class="muted sc-empty">Không có</div>';
    const pendingHtml = pending.length
      ? `<div class="sc-li sc-lh"><span>Khách hàng</span><span>Số BG</span><span>Giá trị</span></div>` + pending
          .slice(0, 12)
          .map((g) => `<div class="sc-li">${custLink(g.cid, g.name)}<span class="sc-n" title="${esc(g.codes.map((q) => q.code).join(', '))}">${g.n} BG</span><span class="sc-amt">${g.amount ? moneyShortG(g.amount) : '0đ'}</span></div>`)
          .join('') + (pending.length > 12 ? `<div class="muted sc-empty">… và ${pending.length - 12} khách khác</div>` : '')
      : '<div class="muted sc-empty">Không có báo giá tồn đọng</div>';
    const anim = state.weekAnimKey !== `sc:${staff}`; // hiệu ứng chỉ khi vừa mở màn hình
    state.weekAnimKey = `sc:${staff}`;
    return `<div class="ctab wk sc${anim ? ' anim' : ''}">
      <div class="ct-head sc-head"><button class="sc-back" data-act="week-open" data-staff="${esc(staff)}" title="Quay lại bảng xếp hạng">← Bảng xếp hạng</button>
        <span class="ct-who">${avatarHtml(staff, 44)}<span><div class="ct-title">${esc(staff)}</div>
        <div class="ct-sub">${rank >= 0 ? `Hạng ${rank + 1}/${allRows.length} tuần này · ${money(allRows[rank].total)} · ${allRows[rank].n} đơn` : 'Chưa có doanh số tuần này'}</div></span></span>
        <button class="rp-start cta" data-act="report-start" data-staff="${esc(staff)}">📝 Bắt đầu làm báo cáo<span class="cta-sub">Duyệt từng khách & viết báo cáo tuần</span></button>
        <span class="sc-medal">${rank === 0 ? '🥇' : rank === 1 ? '🥈' : rank === 2 ? '🥉' : rank >= 0 ? `#${rank + 1}` : '🏁'}</span></div>
      ${cheerHtml(staff, allRows)}
      <div class="sc-kpis">
        ${kpi('👥', 'Khách hàng phụ trách', custs.size, `${trendRows.length} khách có đơn trong 6 tháng`)}
        ${kpi('📝', 'Báo giá chưa chốt', open.length, `${pending.length} khách · trong 90 ngày`, 'warn')}
        ${kpi('💼', 'Giá trị tồn đọng', moneyShortG(openAmount), 'tổng tiền báo giá chưa chốt', 'warn')}
        ${kpi('📉', 'Khách giảm doanh số', trendRows.filter((r) => r.trend < 0).length, '', 'down')}
        ${kpi('📈', 'Khách tăng doanh số', trendRows.filter((r) => r.trend > 0).length, '', 'up')}
      </div>
      ${staffOverview(staff, info, orders, now, dd)}
      <div class="sc-grid">
        <div class="sc-box"><div class="sc-bh">📝 Báo giá tồn đọng theo khách <b>${open.length}</b></div>${pendingHtml}</div>
        <div class="sc-box down"><div class="sc-bh">📉 Khách đang giảm doanh số</div>${trendList(down, 'down')}</div>
        <div class="sc-box up"><div class="sc-bh">📈 Khách đang tăng doanh số</div>${trendList(up, 'up')}</div>
      </div>
      <div class="muted ct-note">Xu hướng: trung bình 3 tháng gần nhất so với 2 tháng đầu (6 tháng, doanh thu sau VAT). Tồn đọng: báo giá 90 ngày gần nhất chưa chốt, chưa lên đơn.</div>
    </div>`;
  }

  function weekTab(quotes, orders, me) {
    // Màn hình đang xem (tuần đã chọn, NVKD đang mở) giữ qua F5
    if (state.weekOff === undefined) state.weekOff = Number(lsGet('dgWeekOff')) || 0;
    if (state.weekOpen === undefined) state.weekOpen = lsGet('dgWeekOpen') || null;
    const now = new Date();
    const admin = isAdminUser(me);
    // Chỉ các tuần thuộc tháng này: từ tuần chứa ngày 1 tới tuần hiện tại
    const monOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const firstMon = monOf(new Date(now.getFullYear(), now.getMonth(), 1));
    const minOff = -Math.round((monOf(now) - firstMon) / (7 * 86400e3));
    const off = Math.max(minOff, Math.min(0, state.weekOff || 0));
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) + off * 7);
    const days = [...Array(6)].map((_, i) => new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i));
    const start = mon.getTime() / 1000;
    const end = start + 6 * 86400; // hết thứ 7
    const dd = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    const info = {};
    for (const q of Object.values(quotes)) {
      const c = q?.customer;
      if (!c?.id) continue;
      const cur = info[c.id];
      if (!cur || (q.createdAt || 0) > cur.at) info[c.id] = { name: c.name, staff: q.staff?.name, at: q.createdAt || 0 };
    }
    // Khách chưa có báo giá trong dữ liệu → lấy tên / NVKD phụ trách từ trang Đơn hàng Misa
    for (const [cid, od] of Object.entries(orders || {})) if (!info[cid]?.staff && od?.customer?.staff) info[cid] = { ...od.customer, at: 0 };
    const by = {};
    for (const [cid, od] of Object.entries(orders || {})) {
      for (const o of od?.orders || []) {
        const at = o.at > 1e11 ? o.at / 1000 : o.at;
        if (!at || at < start || at >= end) continue;
        const staff = info[cid]?.staff;
        if (!staff || isExcluded(staff)) continue; // khách chưa biết NVKD phụ trách → không tính
        const v = orderAfterVat(o);
        const r = (by[staff] ||= { staff, d: [0, 0, 0, 0, 0, 0], n: 0, list: [] });
        const i = Math.floor((at - start) / 86400);
        r.d[i] += v;
        r.n++;
        r.list.push({ ...o, at, cust: info[cid]?.name || `Khách #${cid}`, cid, v });
      }
    }
    const allRows = Object.values(by).map((r) => ({ ...r, total: r.d.reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total);
    // Tiến độ báo cáo tuần của từng NVKD: số khách đã viết / tổng khách, đang làm (sửa trong 5 phút), đã hoàn tất
    const rpCache = {};
    const reportInfo = (staff) => {
      if (rpCache[staff]) return rpCache[staff];
      const rep = (renderCtx.reports || {})[reportKey(staff, mon)] || { items: {} };
      const total = reportCustomers(staff, info, orders).list.length;
      const its = Object.values(rep.items || {}).filter((x) => x?.comment?.trim());
      const last = its.reduce((a, x) => Math.max(a, x.at || 0), 0);
      const lastBy = its.find((x) => x.at === last)?.by;
      return (rpCache[staff] = { total, n: Math.min(its.length, total || its.length), done: !!rep.doneAt, doneAt: rep.doneAt, live: last && Date.now() - last < 5 * 60e3, last, lastBy });
    };
    const reportStatus = (staff) => {
      const x = reportInfo(staff);
      const pct = x.total ? Math.round((x.n / x.total) * 100) : 0;
      const label = x.done
        ? `<span class="rps done">✅ Đã hoàn tất</span>`
        : x.live
          ? `<span class="rps live"><i></i>Đang làm${x.lastBy && norm(x.lastBy) !== norm(staff) ? ` · ${esc(shortName(x.lastBy))}` : ''}</span>`
          : x.n
            ? `<span class="rps mid">✍️ Làm dở · ${ago(Math.floor(x.last / 1000))}</span>`
            : `<span class="rps none" title="Chưa viết báo cáo tuần – nhắc làm ngay"><b class="rp-alarm">⏰</b>Chưa báo cáo · Nhanh lên!</span>`;
      return `<div class="rp-cell">${label}<div class="rp-pbar ${x.done ? 'done' : x.live ? 'live' : ''}"><i style="--w:${x.done ? 100 : pct}%"></i></div><div class="rp-pn">${x.n}/${x.total} khách · ${x.done ? 100 : pct}%</div></div>`;
    };
    // Quản trị bấm vào 1 NVKD → màn hình riêng của NVKD đó
    // Đang làm báo cáo (quản trị: cho NVKD đang mở; NVKD: cho chính mình)
    if (state.report === undefined) {
      try {
        state.report = JSON.parse(lsGet('dgReport') || 'null');
      } catch {
        state.report = null;
      }
    }
    if (state.report && (admin || norm(state.report.staff) === norm(meName))) return reportScreen(state.report.staff, info, orders, now, dd);
    if (admin && state.weekOpen) return staffScreen(state.weekOpen, info, orders, now, dd, allRows);
    // NVKD (không phải quản trị) chỉ thấy dòng của mình
    const rows = admin ? allRows : allRows.filter((r) => norm(r.staff) === norm(meName));
    const sum = [0, 0, 0, 0, 0, 0];
    rows.forEach((r) => r.d.forEach((v, i) => (sum[i] += v)));
    const grand = sum.reduce((a, b) => a + b, 0);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const DAY = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    // Hạng của người đang đăng nhập (so tên tài khoản CRM với NVKD)
    const max = rows[0]?.total || 1;
    const meIdx = rows.findIndex((r) => norm(r.staff) === norm(meName));
    const meRank = allRows.findIndex((r) => norm(r.staff) === norm(meName));
    const medal = (i) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`);
    const meBox =
      meRank >= 0
        ? `<div class="wk-me"><div class="wk-me-rank">${medal(meRank)}</div><div><div class="wk-me-t">${esc(shortName(meName))} đang đứng <b>hạng ${meRank + 1}/${allRows.length}</b> tuần này</div>
            <div class="wk-me-s">Doanh số ${money(allRows[meRank].total)} · ${allRows[meRank].n} đơn${meRank > 0 ? ` · cần thêm <b>${money(allRows[meRank - 1].total - allRows[meRank].total + 1)}</b> để lên hạng ${meRank}${admin ? ` (vượt ${esc(shortName(allRows[meRank - 1].staff))})` : ''}` : ' · đang dẫn đầu 🎉'}</div></div></div>`
        : admin
          ? ''
          : `<div class="wk-me none"><div class="wk-me-rank">🏁</div><div><div class="wk-me-t">${esc(shortName(meName) || 'Bạn')} chưa có doanh số trong tuần này</div>
            <div class="wk-me-s">Cố gắng chốt đơn đầu tiên của tuần nhé!</div></div></div>`;
    // Bảng xếp hạng: bục 3 người đầu (2 – 1 – 3) + các hạng còn lại, kèm doanh thu tuần
    const podium = [1, 0, 2]
      .filter((i) => rows[i])
      .map((i) => {
        const r = rows[i];
        return `<div class="pd pd${i + 1}${i === meIdx ? ' me' : ''}" data-act="week-open" data-staff="${esc(r.staff)}" title="Xem tổng quan 4 tuần" style="animation-delay:${[200, 0, 400][[1, 0, 2].indexOf(i)]}ms">
          ${i === 0 ? '<div class="pd-crown">👑</div>' : ''}${avatarHtml(r.staff, i === 0 ? 56 : 44)}
          <div class="pd-name" title="${esc(r.staff)}">${esc(shortName(r.staff))}${i === meIdx ? ' <span class="wk-you">Bạn</span>' : ''}</div>
          <div class="pd-amt">${moneyShortG(r.total)}</div><div class="pd-sub">${r.n} đơn</div>
          <div class="pd-step"><span>${medal(i)}</span></div></div>`;
      })
      .join('');
    const others = rows
      .slice(3)
      .map((r, k) => {
        const i = k + 3;
        const last = i === rows.length - 1;
        return `<div class="lb${i === meIdx ? ' me' : ''}${last ? ' last' : ''}" data-act="week-open" data-staff="${esc(r.staff)}" title="Xem tổng quan 4 tuần" style="animation-delay:${600 + k * 80}ms"><span class="lb-rank">#${i + 1}</span>${avatarHtml(r.staff, 22)}
          <span class="lb-name" title="${esc(r.staff)}">${esc(shortName(r.staff))}${i === meIdx ? ' <span class="wk-you">Bạn</span>' : ''}${last ? ' <span class="wk-cheer">💪 Cố lên!</span>' : ''}</span>
          <span class="lb-amt">${money(r.total)}</span><span class="lb-gap">${rows[i - 1] ? `kém #${i} ${moneyShortG(rows[i - 1].total - r.total)}` : ''}</span></div>`;
      })
      .join('');
    // Bảng vàng THÁNG (từ ngày 1 tới hôm nay) – đặt bên phải, trang trọng hơn bảng tuần
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000;
    const mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() / 1000;
    const mBy = {};
    for (const [cid, od] of Object.entries(orders || {})) {
      const st = info[cid]?.staff;
      if (!st || isExcluded(st)) continue;
      for (const o of od?.orders || []) {
        const at = o.at > 1e11 ? o.at / 1000 : o.at;
        if (!at || at < mStart || at >= mEnd) continue;
        const r = (mBy[st] ||= { staff: st, total: 0, n: 0 });
        r.total += orderAfterVat(o);
        r.n++;
      }
    }
    const mRows = Object.values(mBy).sort((a, b) => b.total - a.total);
    const mMax = mRows[0]?.total || 1;
    const mTotal = mRows.reduce((a, r) => a + r.total, 0);
    const monthCard = mRows.length
      ? `<div class="mcard"><div class="mc-head"><span class="mc-trophy">🏆</span><div><div class="mc-title">Bảng vàng tháng ${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}</div>
          <div class="mc-sub">Từ 01/${String(now.getMonth() + 1).padStart(2, '0')} tới hôm nay · ${moneyShortG(mTotal)} · ${mRows.reduce((a, r) => a + r.n, 0)} đơn</div></div></div>
        ${mRows
          .map(
            (r, i) => `<div class="mc-row mc${Math.min(i + 1, 4)}${norm(r.staff) === norm(meName) ? ' me' : ''}" data-act="week-open" data-staff="${esc(r.staff)}" title="Xem tổng quan ${esc(r.staff)}" style="animation-delay:${300 + i * 90}ms">
          <span class="mc-rank">${i === 0 ? '👑' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</span>${avatarHtml(r.staff, i === 0 ? 40 : 28)}
          <span class="mc-name">${esc(i === 0 ? r.staff : shortName(r.staff))}${i === 0 ? '<span class="mc-champ">Quán quân tháng</span>' : ''}
            <span class="mc-bar"><i style="--w:${Math.max(3, Math.round((r.total / mMax) * 100))}%"></i></span></span>
          <span class="mc-amt">${moneyShortG(r.total)}<small>${r.n} đơn</small></span></div>`,
          )
          .join('')}</div>`
      : '';
    const board = admin && rows.length
      ? `<div class="board"><div class="bweek"><div class="bw-title">📅 Tuần này</div><div class="podium">${podium}</div>${others ? `<div class="lbs">${others}</div>` : ''}</div>${monthCard}</div>`
      : '';
    const body = rows
      .map((r, i) => {
        const open = state.weekOpen === r.staff;
        const detail = open
          ? `<tr class="wk-detail"><td></td><td colspan="10"><table class="wk-orders">${r.list
              .sort((a, b) => a.at - b.at)
              .map((o) => `<tr><td>${DAY[Math.floor((o.at - start) / 86400)]} ${dd(new Date(o.at * 1000))}</td><td><a href="/khach-hang/view/${o.cid}?t=order" target="_blank" rel="noopener">${esc(o.code || '')}</a></td>
                <td title="${esc(o.cust)}">${esc(shortCompany(o.cust))}</td><td>${esc(o.quote || '')}</td><td class="num">${money(o.v)}</td></tr>`)
              .join('')}</table></td></tr>`
          : '';
        const last = rows.length > 1 && i === rows.length - 1;
        return `<tr class="wk-row${open ? ' open' : ''}${i === meIdx ? ' me' : ''}${i < 3 ? ` top top${i + 1}` : ''}${last ? ' last' : ''}" data-act="week-open" data-staff="${esc(r.staff)}" title="Bấm để xem các đơn trong tuần" style="animation-delay:${i * 70}ms">
          <td class="wk-rank"><span class="wk-medal">${medal(i)}</span></td><td><span class="ct-who">${i === 0 ? '<span class="wk-crown">👑</span>' : ''}${avatarHtml(r.staff, i === 0 ? 30 : 22)}<b>${esc(r.staff)}</b>${i === meIdx ? '<span class="wk-you">Bạn</span>' : ''}${i === 0 ? '<span class="wk-champ">Dẫn đầu tuần ✨</span>' : ''}${last ? '<span class="wk-cheer">💪 Cố lên!</span>' : ''}</span>
            <div class="wk-bar"><span style="--w:${Math.max(3, Math.round((r.total / max) * 100))}%; animation-delay:${200 + i * 70}ms"></span></div></td>
          <td class="wk-rp">${reportStatus(r.staff)}</td>
          ${r.d.map((v, k) => `<td class="num${days[k].getTime() === today ? ' wk-today' : ''}">${v ? money(v) : '<span class="ct-dash">—</span>'}</td>`).join('')}
          <td class="num wk-total">${money(r.total)}</td><td class="num">${r.n}</td></tr>${detail}`;
      })
      .join('');
    // Hiệu ứng chỉ chạy khi mở tab / đổi tuần (bảng vẽ lại liên tục khi có dữ liệu mới)
    const anim = state.weekAnimKey !== String(off);
    state.weekAnimKey = String(off);
    return `<div class="ctab wk${anim ? ' anim' : ''}">
      <div class="ct-head"><div><div class="ct-title">📅 Báo cáo tuần</div>
        <div class="ct-sub">Thứ 2 ${dd(days[0])} → Thứ 7 ${dd(days[5])}/${days[5].getFullYear()} · ${rows.reduce((a, r) => a + r.n, 0)} đơn · tổng ${moneyShortG(grand)} (sau VAT)${admin ? ' · 👆 bấm 1 NVKD để xem riêng' : ''}</div></div>
        <div class="ct-tools">${[...Array(-minOff + 1)]
          .map((_, k) => {
            const o = minOff + k;
            const m = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) + o * 7);
            const sat = new Date(m.getFullYear(), m.getMonth(), m.getDate() + 5);
            return `<button class="ct-btn${o === off ? ' on' : ''}" data-act="week-set" data-off="${o}" title="Thứ 2 ${dd(m)} → Thứ 7 ${dd(sat)}">Tuần ${k + 1}<small> ${dd(m)}–${dd(sat)}</small></button>`;
          })
          .join('')}</div></div>
      ${meBox}
      ${admin ? '' : `${cheerHtml(meName, allRows)}<div class="rp-startrow"><button class="rp-start cta" data-act="report-start" data-staff="${esc(meName)}">📝 Bắt đầu làm báo cáo tuần<span class="cta-sub">Duyệt từng khách & viết báo cáo</span></button></div>`}
      ${board}
      ${(() => {
        return admin ? '' : staffOverview(meName, info, orders, now, dd);
      })()}
      <div class="ct-wrap"><table class="ct">
        <thead><tr><th>Hạng</th><th>NVKD</th><th class="wk-rp-h">📝 Báo cáo tuần</th>${days.map((d, k) => `<th class="num${d.getTime() === today ? ' wk-today' : ''}">${DAY[k]} ${dd(d)}</th>`).join('')}<th class="num">Tổng tuần</th><th class="num">Số đơn</th></tr>
          <tr class="ct-sum"><td></td><td>Σ ${rows.length} NVKD</td><td>${(() => {
            const st = rows.map((r) => reportInfo(r.staff));
            return `<span class="wk-rp-sum">✅ ${st.filter((x) => x.done).length} xong · ✍️ ${st.filter((x) => !x.done && x.n).length} đang làm · ⏰ ${st.filter((x) => !x.n).length} chưa báo cáo</span>`;
          })()}</td>${sum.map((v) => `<td class="num">${v ? moneyShortG(v) : '—'}</td>`).join('')}<td class="num">${moneyShortG(grand)}</td><td class="num">${rows.reduce((a, r) => a + r.n, 0)}</td></tr></thead>
        <tbody>${body || '<tr><td colspan="11" class="muted">Tuần này chưa có đơn hàng nào trong dữ liệu đã thu thập.</td></tr>'}</tbody></table></div>
      <div class="muted ct-note">Doanh số sau VAT theo ngày lên đơn, tính cho NVKD phụ trách khách. Số liệu từ lịch sử mua hàng extension đã thu thập (tự cập nhật ngầm) – bấm 1 dòng để xem từng đơn.</div>
    </div>`;
  }

  function custRows(quotes, orders) {
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ y: d.getFullYear(), m: d.getMonth(), label: `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` });
    }
    const idx = (sec) => {
      const d = new Date((sec > 1e11 ? sec : sec * 1000));
      return months.findIndex((x) => x.y === d.getFullYear() && x.m === d.getMonth());
    };
    // Tên / mã / NVKD phụ trách của khách lấy từ báo giá gần nhất
    const info = {};
    for (const q of Object.values(quotes)) {
      const c = q?.customer;
      if (!c?.id) continue;
      const cur = info[c.id];
      if (!cur || (q.createdAt || 0) > cur.at) info[c.id] = { name: c.name, code: c.code, staff: q.staff?.name, at: q.createdAt || 0 };
    }
    // Khách chưa có báo giá trong dữ liệu → lấy tên / NVKD phụ trách từ trang Đơn hàng Misa
    for (const [cid, od] of Object.entries(orders || {})) if (!info[cid]?.staff && od?.customer?.staff) info[cid] = { ...od.customer, at: 0 };
    const rows = [];
    for (const [cid, od] of Object.entries(orders || {})) {
      // Khách chỉ có trên Misa (chưa khớp mã khách CRM): vẫn tính, tên = mã khách
      const m = [0, 0, 0, 0, 0, 0];
      for (const o of od?.orders || []) {
        const i = o.at ? idx(o.at) : -1;
        if (i >= 0) m[i] += orderAfterVat(o);
      }
      const total = m.reduce((a, b) => a + b, 0);
      if (!total) continue;
      const ci = info[cid] || (od?.customer ? { name: od.customer.name || cid.replace(/^misa:/, ''), code: od.customer.code, staff: od.customer.staff } : {});
      if (isExcluded(ci.staff)) continue; // khách của NVKD không theo dõi
      // Xu hướng: trung bình 3 tháng gần nhất (không tính tháng này) so với trung bình 2 tháng đầu
      const last3 = m[2] + m[3] + m[4];
      const first2 = m[0] + m[1];
      rows.push({
        cid, name: ci.name || `Khách #${cid}`, code: ci.code || '', staff: ci.staff || '', m, total,
        active: m.filter(Boolean).length,
        trend: first2 ? Math.round(((last3 / 3 - first2 / 2) / (first2 / 2)) * 100) : null,
      });
    }
    rows.sort((a, b) => b.total - a.total);
    return { months, rows };
  }

  // Tên công ty gọn: bỏ các chữ loại hình / ngành nghề ở đầu
  // "CÔNG TY TNHH SẢN XUẤT THƯƠNG MẠI PHONG TÍN" → "PHONG TÍN", "CÔNG TY CỔ PHẦN S&S GLOVE" → "S&S GLOVE"
  const CO_WORDS = ['doanh nghiệp tư nhân', 'dntn', 'tổng công ty', 'chi nhánh', 'hộ kinh doanh', 'hkd', 'công ty', 'cty', 'liên doanh', 'tnhh', 'cổ phần', 'cp', 'mtv', 'một thành viên', 'sản xuất', 'sx', 'thương mại', 'tm',
    'dịch vụ', 'dv', 'xuất nhập khẩu', 'xnk', 'đầu tư', 'và', '&', '-', ','];
  // Các chữ bỏ ở BẤT KỲ vị trí nào trong tên (cụm dài đứng trước cụm ngắn)
  const CO_ANY = new RegExp(['doanh nghiệp tư nhân', 'dntn', 'may mặc', 'dược phẩm', 'công nghệ môi trường', 'thời trang quốc tế', 'phụ kiện ô tô', 'phụ kiện ôtô', 'phụ kiện oto', 'hộ kinh doanh', 'chi nhánh', 'trách nhiệm hữu hạn', 'sản xuất', 'phân phối', 'kinh doanh', 'bao bì giấy', 'bao bì', 'và nước giải khát', 'nước giải khát', 'và nước uống tinh khiết đóng chai', 'nước uống tinh khiết đóng chai', 'và nước uống đóng chai', 'nước uống đóng chai', 'nước uống tinh khiết', 'công nghiệp'].join('|'), 'giu');
  const shortCompany = (name) => {
    // Bỏ các chữ trong CO_ANY ở bất kỳ đâu trong tên (vd. "ABC - CHI NHÁNH BÌNH DƯƠNG" → "ABC - BÌNH DƯƠNG")
    let t = String(name || '').normalize('NFC').replace(CO_ANY, ' ').replace(/\s+/g, ' ').replace(/\s*-\s*-\s*/g, ' - ').trim().replace(/^[-,\s]+|[-,\s]+$/g, '');
    for (let changed = true; changed; ) {
      changed = false;
      // Viết tắt ghép: TM-SX, TM-DV-SX, SX-TM…
      const ab = t.match(/^(?:tm|sx|dv|xnk)(?:\s*[-&,]\s*(?:tm|sx|dv|xnk))+\s+/iu);
      if (ab) {
        t = t.slice(ab[0].length).trim();
        changed = true;
      }
      for (const w of CO_WORDS) {
        if (t.toLowerCase().startsWith(w + ' ') || t.toLowerCase() === w) {
          t = t.slice(w.length).trim();
          changed = true;
        }
      }
    }
    return String(t || name || '').toLocaleUpperCase('vi'); // tên công ty luôn viết hoa toàn bộ
  };

  // Mở tab Khách hàng → tự đọc ngầm lại đơn hàng của khách đã cũ (> 12 giờ) hoặc còn thiếu trang, mỗi khách tối đa 1 lần / phiên
  const custAutoQueued = new Set();
  function autoRefreshCustomers(rows) {
    const od = renderCtx.orders || {};
    const now = Date.now() / 1000;
    const need = rows
      .map((r) => r.cid)
      .filter((cid) => {
        if (custAutoQueued.has(String(cid))) return false;
        const o = od[cid];
        if (!o) return true;
        const oldest = Math.min(...(o.orders || []).map((x) => (x.at > 1e11 ? x.at / 1000 : x.at) || Infinity));
        const partial = (o.total || 0) > (o.orders?.length || 0) && oldest > now - 190 * 86400;
        return partial || now - (o.at || 0) > 12 * 3600;
      });
    if (!need.length) return;
    need.forEach((c) => custAutoQueued.add(String(c)));
    setTimeout(() => refetchCustomers(need), 0);
  }

  // Khách ẩn khỏi tab Khách hàng: danh sách cố định + khách bấm "Ẩn" (kv 'custHidden', đồng bộ giữa các máy)
  const HIDDEN_CUSTOMERS = ['CÔNG TY TNHH SẢN XUẤT HẢI ÂU', 'CÔNG TY TNHH SẢN XUẤT XNK ĐẠI DƯƠNG', 'CÔNG TY CỔ PHẦN BAO BÌ GIẤY TƯỜNG LONG'];
  const isHiddenCust = (r, hidden) => !!hidden?.[r.cid] || HIDDEN_CUSTOMERS.some((n) => normName(n) === normName(r.name));

  function custTab({ months, rows: allRows }) {
    const hidden = renderCtx.custHidden || {};
    const showHidden = lsGet('dgShowHiddenCust') === '1';
    const hiddenRows = allRows.filter((r) => isHiddenCust(r, hidden));
    const rows = showHidden ? hiddenRows : allRows.filter((r) => !isHiddenCust(r, hidden));
    if (IS_TOP) autoRefreshCustomers(rows);
    const fold = (t) => (t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
    const needle = fold(state.search).trim();
    const staffSel = lsGet('dgStaff') || '';
    const noCur = lsGet('dgCustNoCur') === '1';
    const list = rows.filter(
      (r) => (!needle || fold(`${r.name} ${r.code}`).includes(needle)) && (!staffSel || r.staff === staffSel) && (!noCur || !r.m[5]),
    );
    const sum = [0, 0, 0, 0, 0, 0];
    list.forEach((r) => r.m.forEach((v, i) => (sum[i] += v)));
    const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
    const arrow = (p) => (p == null ? '' : `<span class="ct-chg ${p >= 0 ? 'up' : 'down'}">${p >= 0 ? '↑' : '↓'}${Math.abs(p).toLocaleString('vi-VN')}%</span>`);
    const noCurN = rows.filter((r) => !r.m[5] && (!staffSel || r.staff === staffSel)).length;
    const staffs = {};
    rows.forEach((r) => r.staff && (staffs[r.staff] = (staffs[r.staff] || 0) + 1));
    const staffChips = Object.entries(staffs)
      .sort((a, b) => b[1] - a[1])
      .map(([n, k]) => `<button class="fchip staff${staffSel === n ? ' on' : ''}" data-act="staff" data-staff="${esc(n)}" title="${esc(n)}">${avatarHtml(n, 16)}${esc(shortName(n))}<b>${k}</b></button>`)
      .join('');
    const body = list
      .map((r, i) => {
        const cells = r.m
          .map((v, k) => {
            if (k < 5) return `<td class="num">${v ? money(v) : '<span class="ct-dash">—</span>'}</td>`;
            const p = pct(v, r.m[4]);
            return `<td class="num ct-cur ${v ? (p != null && p < 0 ? 'down' : 'up') : 'zero'}">${v ? money(v) : '<span class="ct-none">chưa lên đơn</span>'}${arrow(r.m[4] ? (v ? p : -100) : null)}</td>`;
          })
          .join('');
        return `<tr><td class="ct-no">${i + 1}</td>
          <td class="ct-name"><a href="${/^\d+$/.test(r.cid) ? `/khach-hang/view/${r.cid}?t=order` : '/misa-order/list'}" target="_blank" rel="noopener" title="${esc(r.name)}">${esc(shortCompany(r.name))}</a>${arrow(r.trend)}${
            HIDDEN_CUSTOMERS.some((n) => normName(n) === normName(r.name))
              ? ''
              : `<button class="ct-hide" data-act="cust-hide" data-cid="${r.cid}" data-name="${esc(r.name)}" title="${showHidden ? 'Hiện lại khách này' : 'Ẩn khách này khỏi danh sách (mọi máy)'}">${showHidden ? '↩ Hiện lại' : '✕ Ẩn'}</button>`}</td>
          <td><span class="ct-grp ${r.active >= 4 ? 'hot' : ''}">${r.active >= 4 ? 'Ưu tiên' : 'Thường'}</span></td>
          <td title="${esc(r.staff)}">${r.staff ? `<span class="ct-who">${avatarHtml(r.staff, 18)}${esc(shortName(r.staff))}</span>` : ''}</td>
          ${cells}</tr>`;
      })
      .join('');
    return `<div class="ctab">
      <div class="ct-head"><div><div class="ct-title">👥 Danh sách khách hàng</div><div class="ct-sub">Khoảng thời gian: ${months[0].label} → ${months[5].label} · ${list.length} khách · tổng ${moneyShortG(sum.reduce((a, b) => a + b, 0))}${(() => {
        const run = custRefetch.running ? custRefetch : loadRun();
        return run?.total ? ` · <span class="ct-bg">đang tự cập nhật đơn hàng ${run.done}/${run.total}</span>` : '';
      })()}</div></div>
        <div class="ct-tools"><label class="search"><span>🔍</span><input class="dg-search" type="search" placeholder="Tìm tên / mã khách…" value="${esc(state.search || '')}"></label>
          <button class="ct-btn${showHidden ? ' on' : ''}" data-act="cust-showhidden" title="Xem / hiện lại các khách đã ẩn">Ẩn KH <b>${hiddenRows.length}</b></button>
          <button class="ct-btn${noCur ? ' on' : ''}" data-act="cust-nocur" title="Khách đã mua trong 6 tháng nhưng tháng này chưa có đơn">Chưa lên đơn tháng này <b>${noCurN}</b></button></div></div>
      ${staffChips ? `<div class="fbar"><div class="fgroup"><span class="fname">Nhân viên</span><div class="fchips">${staffChips}</div></div>${staffSel ? '<button class="fclear" data-act="filter-clear">✕ Bỏ lọc</button>' : ''}</div>` : ''}
      <div class="ct-wrap"><table class="ct">
        <thead><tr><th>STT</th><th>Tên khách hàng</th><th>Nhóm</th><th>NVKD</th>${months.map((x, i) => `<th class="num${i === 5 ? ' ct-cur' : ''}">${x.label}</th>`).join('')}</tr>
          <tr class="ct-sum"><td></td><td>Σ ${list.length} khách</td><td></td><td></td>${sum.map((v) => `<td class="num">${v ? moneyShortG(v) : '—'}</td>`).join('')}</tr></thead>
        <tbody>${body || '<tr><td colspan="10" class="muted">Chưa có dữ liệu mua hàng – extension tự đọc lịch sử mua hàng khi mở báo giá / thu thập ngầm.</td></tr>'}</tbody></table></div>
      <div class="muted ct-note">Số liệu từ lịch sử mua hàng extension đã thu thập (${rows.length} khách có đơn trong 6 tháng). Tháng ${months[5].label}: so với tháng trước; cạnh tên: trung bình 3 tháng gần nhất so với 2 tháng đầu.</div>
    </div>`;
  }
  const moneyShortG = (n) => {
    const f = (v) => v.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return n >= 1e9 ? `${f(n / 1e9)} tỷ` : n >= 1e6 ? `${f(n / 1e6)} tr` : money(n);
  };

  // Tên gọn: 3 chữ → chữ cuối (Phan Văn Thịnh → Thịnh); 4 chữ trở lên → 2 chữ cuối (Lê Thị Đông Anh → Đông Anh)
  const shortName = (n) => {
    const w = (n || '').trim().split(/\s+/).filter(Boolean);
    return w.length >= 4 ? w.slice(-2).join(' ') : w.length === 3 ? w[2] : w.join(' ');
  };

  // Mỗi đơn chỉ thuộc 1 khách: trang Đơn hàng Misa có thể ghi khách theo mã khác (vd. "TUANTU-THINH") → bỏ bản trùng,
  // ưu tiên khách có mã số của CRM (đọc từ trang khách hàng)
  function dedupOrders(orders, quotes = {}) {
    const crm = (k) => /^\d+$/.test(String(k));
    // Nhóm đơn từ trang Misa được ghi theo MÃ KHÁCH (vd. "CHÁNH PHẨM") → gộp vào khách CRM có cùng mã; không có thì theo mã báo giá
    const codeToCid = {};
    const bgToCid = {};
    for (const q of Object.values(quotes || {})) {
      const c = q?.customer;
      if (!c?.id) continue;
      if (c.code) codeToCid[norm(c.code)] = String(c.id);
      if (q.code) bgToCid[q.code] = String(c.id);
    }
    const merged = {};
    for (const [cid, od] of Object.entries(orders || {})) merged[cid] = { ...od, orders: [...(od?.orders || [])] };
    for (const [cid, od] of Object.entries(orders || {})) {
      if (crm(cid)) continue;
      const code = cid.replace(/^misa:/, '');
      const keep = [];
      for (const o of od?.orders || []) {
        const target = codeToCid[norm(code)] || bgToCid[o.quote];
        if (target) {
          const t = (merged[target] ||= { customerId: Number(target), orders: [], at: 0 });
          t.orders.push(o);
          if (!t.customer?.staff && od.customer?.staff) t.customer = { ...(t.customer || {}), ...od.customer };
        } else keep.push(o);
      }
      merged[cid] = { ...merged[cid], orders: keep, customer: { name: code, code, ...(od?.customer || {}) } };
    }
    orders = merged;
    const owner = new Map();
    for (const [cid, od] of Object.entries(orders || {}))
      for (const o of od?.orders || []) {
        const cur = owner.get(o.id);
        if (cur === undefined || (!crm(cur) && crm(cid))) owner.set(o.id, cid);
      }
    const out = {};
    for (const [cid, od] of Object.entries(orders || {})) {
      // Mỗi đơn 1 lần: đúng khách sở hữu, và không lặp trong cùng khách (đơn đã có + đơn gộp từ trang Misa)
      const seen = new Set();
      const list = (od?.orders || []).filter((o) => owner.get(o.id) === cid && !seen.has(o.id) && seen.add(o.id));
      if (list.length || crm(cid)) out[cid] = { ...od, orders: list };
    }
    return out;
  }

  // Tab Báo cáo tuần mà bảng chưa toàn màn hình → luôn nhắc bung to (bấm "Đồng ý" là bật toàn màn hình ngay)
  const needFull = () => lsGet('dgTab') === 'week' && lsGet('dgPanelFull') !== '1';
  const fullTip = () =>
    needFull()
      ? `<span class="fulltip"><span class="ft-ic">⛶</span>Báo cáo hiển thị đầy đủ nhất ở chế độ toàn màn hình<button class="ft-ok" data-act="full">Đồng ý – mở toàn màn hình</button></span>`
      : '';

  let lastPanelHtml = '';
  let lastSideHtml = '';
  const setSideHtml = (el, html) => {
    if (html === lastSideHtml && el.innerHTML) return; // không đổi → không vẽ lại
    lastSideHtml = html;
    el.innerHTML = html;
  };
  async function renderInner() {
    const meObj = await kvGet('me');
    meName = myName(meObj);
    state.meReal = meObj?.name || ''; // tên tài khoản CRM thật (không dùng tên mặc định)
    PERMS = (await kvGet('perms')) || {};
    QB = (await kvGet('qbank')) || {};
    const perm = userPerm(meObj);
    MY_ACCESS = perm.access;
    MY_ADMIN = perm.admin;
    // Ghi nhận người đã mở extension (để quản trị thấy và cấp quyền) – mỗi phiên 1 lần
    if (meObj?.name && !state.seenSaved) {
      state.seenSaved = true;
      kvMerge('seenUsers', { [norm(meObj.name)]: { name: meObj.name, at: Date.now() } }).catch(() => {});
    }
    if (!perm.access && IS_TOP) return renderNoAccess();
    const [quotes, comments, evals, suggests, collected, settings] = await Promise.all([
      kvGet('quotes'),
      kvGet('comments'),
      kvGet('evals'),
      kvGet('suggests'),
      kvGet('collected'),
      getSettings(),
    ]);
    // Các danh sách trong bảng không hiện báo giá Thất bại
    const live = Object.fromEntries(Object.entries(quotes).filter(([, q]) => q?.quoteStatus !== 'REJECT'));
    const liveComments = Object.fromEntries(Object.entries(comments).filter(([id]) => quotes[id]?.quoteStatus !== 'REJECT'));
    const overdue = listByMode(live, liveComments, 'hoiNhanh');
    const stale = staleList(live, liveComments, overdue);
    const silent = noCommentList(live, liveComments, collected);
    // Tất cả báo giá CHƯA ĐỌC trên CRM (dòng in đậm) – hiện đủ 100%
    const unreadAll = Object.values(live)
      // Bỏ báo giá đã chốt / đã lên đơn (tình trạng Duyệt lên đơn, Thành công; có đơn Misa; tên là mã đơn "SO1234")
      .filter((q) => q.isRead === false && !isExcluded(staffOf(q, comments[q.id])) && !isOrdered(q, comments[q.id]))
      .map((q) => {
        const c = comments[q.id] || { id: q.id, code: q.code, threads: [] };
        return { q, c, last: lastComment(c) };
      })
      .sort((a, b) => (b.q.createdAt || 0) - (a.q.createdAt || 0))
      .sort(sortByErp);
    // Mọi báo giá có cắt mẫu (kể cả đã chốt) – để xem tỉ lệ cắt mẫu thành đơn
    const samples = Object.values(liveComments)
      .filter((c) => sampleInfo(c) && !isExcluded(staffOf(quotes[c.id], c)))
      .map((c) => ({ q: quotes[c.id] || { id: c.id, code: c.code }, c, last: lastComment(c) }))
      .sort((a, b) => (b.last?.createdAt || 0) - (a.last?.createdAt || 0));
    const samplesOrdered = samples.filter(({ q, c }) => hasOrderFull(q, c)).length;
    const fab = root.querySelector('.fab');
    const feasible = feasibleList(live, liveComments, await kvGet('orders'));
    const alertCount = feasible.length;
    // Bàn giao: cùng khách + người nhận đã gửi / bỏ qua ở bất kỳ máy nào (bản ghi có thể khác khoá) → coi là xong
    const hoAll = Object.values(await kvGet('handovers'));
    const hoDone = new Set(hoAll.filter((h) => h.sentAt || h.skippedAt).map((h) => `${normName(h.customer)}|${normName(h.to)}`));
    // Đã có bình luận "Bàn giao khách hàng <tên khách> …" trên CRM (gửi từ máy khác hoặc gõ tay) → coi là xong và ghi lại (đồng bộ)
    const hoTexts = [];
    const hoWalk = (t) => {
      if (/bàn giao khách hàng/i.test(t.text || '')) hoTexts.push({ text: normName(t.text), at: t.createdAt });
      (t.children || []).forEach(hoWalk);
    };
    Object.values(comments).forEach((c) => (c.threads || []).forEach(hoWalk));
    const hoSeen = (h) => {
      const cust = normName(h.customer);
      const to = normName(h.to);
      const at = h.at ? (h.at > 1e11 ? h.at / 1000 : h.at) : 0;
      return hoTexts.some((x) => x.text.includes(cust) && (!to || x.text.includes(to)) && (!at || !x.at || x.at >= at - 3600));
    };
    const autoDone = {};
    const handovers = hoAll
      .filter((h) => !h.sentAt && !h.skippedAt && !hoDone.has(`${normName(h.customer)}|${normName(h.to)}`))
      .filter((h) => {
        if (!hoSeen(h)) return true;
        autoDone[h.key] = { ...h, sentAt: Date.now(), sentText: '(đã có bình luận bàn giao trên CRM)' };
        return false;
      })
      .sort((a, b) => (b.at || b.seenAt) - (a.at || a.seenAt));
    if (Object.keys(autoDone).length) kvMerge('handovers', autoDone).catch(() => {});
    fab.innerHTML = `📊 Trợ lý ERP${alertCount ? ` <span class="fab-badge">🎯 ${alertCount}</span>` : ''}${handovers.length ? ` <span class="fab-badge">🔁 ${handovers.length}</span>` : ''}`;
    // Bảng đang thu gọn mà có báo giá cần hỏi lại → nút nổi nhấp nháy, nảy nhẹ để gây chú ý
    fab.classList.toggle('alert', alertCount > 0 && !isOpen());
    // Thẻ cố định bên phải trang báo giá: báo giá đang mở (câu hỏi gợi ý, % Flexo/Offset, mua hàng, đánh giá)
    avatars = avatarIndex(quotes);
    quickLearn = await kvGet('quickLearn');
    renderCtx = { hotPinned: await kvGet('hotPinned'), aiHot: (await kvGet('aiHot')).latest, comments, quotes, collected, orders: dedupOrders(await kvGet('orders'), quotes), margins: await kvGet('margins'), quickSent: await kvGet('quickSent'), quickDraft: await kvGet('quickDraft') };
    {
      const hd = await kvGet('aiHotDone');
      const pin = renderCtx.hotPinned || {};
      renderCtx.hotSet = new Set([...(renderCtx.aiHot?.items || []).filter((x) => !hd[x.id]).map((x) => x.id), ...Object.keys(pin).filter((id) => pin[id] && !pin[id].off && !hd[id]).map(Number)]);
    }
    const all = Object.values(quotes);
    const btn = (act, key, label, busyLabel, attrs = '') =>
      `<button class="act" data-act="${act}" ${attrs} ${state.busy.has(key) ? 'disabled' : ''}>${state.busy.has(key) ? busyLabel : label}</button>`;

    const qid = currentQuoteId();
    let current = '';
    if (qid) {
      const q = quotes[qid];
      const c = comments[qid];
      const ev = evals[`q:${qid}`];
      const sg = suggests[qid];
      const last = lastComment(c);
      const mode = followMode(q, c);
      const tags = `${kindTag(q)}${noSheetTag(q)}${bossOkTag(q, c)}${targetTag(c)}${buyerTag(q, c)}${highPriceTag(c)}${creditTag(c)}${promiseTag(q, c)}${contractTag(c)}${sampleTag(q, c)}${noDepositTag(c)}`;
      current = `
        <div class="side-info">
          <div class="si-name">${esc(q?.name || '')}</div>
          <div class="si-meta">${avatarHtml(staffOf(q, c), 22)}<b>${esc(staffOf(q, c) || '?')}</b>
            <span class="dot">·</span>💬 ${c?.threads?.length || 0} luồng${last ? `<span class="dot">·</span>BL cuối ${ago(last.createdAt)}` : ''}
            ${q?.amount ? `<span class="si-amt">${money(q.amount)}</span>` : ''}</div>
          ${tags.trim() ? `<div class="si-tags">${tags}</div>` : ''}
        </div><!--dg-split-->
        <div class="side-q">
          ${noPrice(q) ? `<div class="warn danger">⚠️ Báo giá đang 0đ – chưa cho giá. Cần cho giá trước khi hỏi NVKD.</div>` : ''}
          ${quickBox(q, c, mode)}
          ${ordersBox(q)}
          <div class="btns side-actions">
            <button class="act hero" data-act="suggest" data-id="${qid}" ${state.busy.has(`c:${qid}`) ? 'disabled' : ''}>
              ${state.busy.has(`c:${qid}`) ? '<span class="spinner light"></span> Đang soạn câu hỏi…' : '💬 Gợi ý câu hỏi cho NVKD'}</button>
            ${btn('eval-quote', `q:${qid}`, '🤖 Đánh giá NVKD', 'Đang đánh giá…', `data-id="${qid}"`)}
          </div>
          ${sg ? `<div class="label">Bình luận gợi ý <span class="muted">(${new Date(sg.at).toLocaleString('vi-VN')}${sg.styleFrom ? ` · học văn phong từ ${sg.styleFrom} bình luận của bạn` : ''})</span></div>
            <textarea class="suggest-edit" data-id="${qid}">${esc(sg.text)}</textarea>
            <div class="btns"><button class="act primary" data-act="insert" data-id="${qid}" ${state.busy.has(`send:${qid}`) ? 'disabled' : ''}>
                ${state.busy.has(`send:${qid}`) ? '<span class="spinner light"></span> Đang gửi…' : sg.sentAt ? '📨 Gửi lại' : '📨 Gửi bình luận'}</button>
              <button class="act" data-act="copy" data-id="${qid}">Copy</button>
              ${sg.sentAt
                ? `<span class="sent">✅ Đã gửi lúc ${new Date(sg.sentAt).toLocaleTimeString('vi-VN')}</span>`
                : '<span class="muted">Bấm là gửi luôn (trả lời vào luồng của báo giá này nếu có).</span>'}</div>` : ''}
          ${ev ? `<div class="row label"><span>Đánh giá NVKD <span class="muted">(${new Date(ev.at).toLocaleString('vi-VN')})</span></span>${scoreHtml(ev)}</div><div class="result">${esc(ev.text)}</div>` : ''}
        </div>`;
    }

    if (perm.side) renderSide(quotes[qid], qid, current, handoverBox(handovers, quotes), handovers.length);
    else renderSide(null, null); // không có quyền xem thẻ báo giá → ẩn thẻ
    if (!isOpen()) return;
    const editing = root.activeElement?.classList;
    if (editing?.contains('handover-edit') || editing?.contains('rp-text') || editing?.contains('qb-edit') || (state.qbDirty && lsGet('dgTab') === 'qa')) return; // đang sửa – không vẽ lại

    const cut = (t, n) => (t && t.length > n ? t.slice(0, n) + '…' : t || '');
    // Tổng doanh thu (số tiền báo giá) của một danh sách
    // Bấm nhãn trên tiêu đề để lọc danh sách: 'tgt' = khách cho giá, 'zero' = chưa cho giá
    // Deal đang nằm trong 🔥 Gợi ý chốt đơn (dùng cho nhãn "🔥 Ưu tiên" và bộ lọc "Ưu tiên")
    {
      const hl = (await kvGet('aiHot')).latest;
      const hd = await kvGet('aiHotDone');
      const pin = await kvGet('hotPinned'); // báo giá thêm tay vào gợi ý chốt đơn (📌)
      renderCtx.hotSet = new Set([...(hl?.items || []).filter((x) => !hd[x.id]).map((x) => x.id), ...Object.keys(pin || {}).filter((id) => pin[id] && !pin[id].off && !hd[id]).map(Number)]);
    }
    const FILTERS = {
      prio: ({ q, c }) => !!q && renderCtx.hotSet.has(q.id) && !CLOSED.has(q.quoteStatus) && !hasOrderFull(q, c) && !cancelInfo(c),
      tgt: ({ c }) => targetPriceInfo(c),
      zero: ({ q }) => noPrice(q),
      nodep: ({ c }) => noDepositInfo(c),
      high: ({ c }) => highPriceInfo(c),
      credit: ({ c }) => creditInfo(c),
      promise: ({ q, c }) => promiseInfo(q, c),
      sample: ({ c }) => sampleInfo(c),
      contract: ({ c }) => contractInfo(c),
      bossok: ({ q, c }) => bossOkInfo(q, c),
      buyer: ({ q, c }) => !!buyerInfo(q, c),
      nosheet: ({ q }) => !!q?.noSheet,
      nocmt: ({ c }) => !c?.threads?.length,
      unread: ({ q }) => q?.isRead === false,
      feaUnread: ({ q, f }) => !!f && q?.isRead === false, // vừa khả thi (có 🎯) vừa chưa đọc
      sampleOrder: ({ q, c }) => sampleInfo(c) && hasOrderFull(q, c),
      sampleNo: ({ q, c }) => sampleInfo(c) && !hasOrderFull(q, c),
      lowm: ({ q }) => (marginOf(q) ?? 100) < 30,
      flexo: ({ q }) => kindOf(q) === 'flexo',
      offset: ({ q }) => kindOf(q) === 'offset',
      both: ({ q }) => kindOf(q) === 'both',
    };
    // Tìm theo tên cơ hội / mã KH / tên khách / mã BG – không phân biệt dấu, hoa thường
    const fold = (t) => (t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
    const needle = fold(state.search).trim();
    const searchHit = ({ q, c }) =>
      !needle || fold(`${q?.name || ''} ${q?.customer?.code || ''} ${q?.customer?.name || ''} ${q?.code || c?.code || ''}`).includes(needle);
    // Lọc theo NVKD (độc lập với các nhãn lọc khác, giữ qua F5: dgStaff)
    const staffSel = lsGet('dgStaff') || '';
    const staffHit = ({ q, c }) => !staffSel || staffOf(q, c) === staffSel;
    const applyFilter = (items) => (FILTERS[state.filter] ? items.filter(FILTERS[state.filter]) : items).filter(searchHit).filter(staffHit);
    const filterChip = (f, cls, label) =>
      ` <button class="${cls} chipbtn${state.filter === f ? ' on' : ''}" data-act="filter" data-f="${f}" title="Bấm để lọc / bỏ lọc">${label}</button>`;
    // Thanh lọc: chia nhóm (Trạng thái · Tín hiệu khách · Lợi nhuận & loại hàng); chip đang chọn tô đậm màu nhóm
    const fchip = (f, tone, icon, label, n) =>
      `<button class="fchip ${tone}${state.filter === f ? ' on' : ''}" data-act="filter" data-f="${f}" title="Bấm để lọc / bỏ lọc">` +
      `<span class="fi">${icon}</span>${label}<b>${n}</b></button>`;
    const totalBadge = (items, both = false) => {
      const shown = applyFilter(items);
      const pick = both ? shown.filter(FILTERS.feaUnread) : shown;
      const total = pick.reduce((a, { q }) => a + (Number(q?.amount) || 0), 0);
      const tip = both
        ? `${money(total)} · ${pick.length} báo giá vừa khả thi (có 🎯) vừa chưa đọc${state.filter ? ' (trong bộ lọc đang chọn)' : ''}`
        : `${money(total)} · ${state.filter ? `${shown.length} báo giá đang lọc` : `${items.length} báo giá`}`;
      return total
        ? `<span class="rev" title="${esc(tip)}">💰 ${moneyShort(total)}${both ? ` <small>· ${pick.length} khả thi & chưa đọc</small>` : state.filter ? ` <small>· ${shown.length} đang lọc</small>` : ''}</span>`
        : '';
    };
    const filterBar = (items) => {
      const cnt = (fn) => items.filter(fn).length;
      const kinds = { flexo: 0, offset: 0, both: 0 };
      items.forEach(({ q }) => { const k = kindOf(q); if (k) kinds[k]++; });
      const groups = [
        ['Trạng thái', [
          ['unread', 'blue', '📬', 'Chưa đọc', cnt(FILTERS.unread)],
          ['feaUnread', 'green', '🎯', 'Khả thi & chưa đọc', cnt(FILTERS.feaUnread)],
          ['nocmt', 'slate', '📭', 'Chưa có bình luận', cnt(FILTERS.nocmt)],
          ['zero', 'red', '⚠️', 'Chưa cho giá', cnt(FILTERS.zero)],
          ['prio', 'orange', '🔥', 'Ưu tiên', cnt(FILTERS.prio)],
        ]],
        ['Tín hiệu khách', [
          ['tgt', 'green', '💲', 'Khách cho giá', cnt(FILTERS.tgt)],
          ['buyer', 'violet', '🤝', 'Thu mua %', cnt(FILTERS.buyer)],
          ['promise', 'amber', '🤝', 'Hứa lên đơn', cnt(FILTERS.promise)],
          ['bossok', 'green', '✅', 'Lấy đơn', cnt(FILTERS.bossok)],
          ['contract', 'sky', '📝', 'Hợp đồng', cnt(FILTERS.contract)],
          ['sample', 'pink', '✂️', 'Cắt mẫu', cnt(FILTERS.sample)],
          ['high', 'orange', '💸', 'Giá cao', cnt(FILTERS.high)],
          ['credit', 'teal', '🧾', 'Xin công nợ', cnt(FILTERS.credit)],
          ['nodep', 'red', '🚫', 'Chưa cọc', cnt(FILTERS.nodep)],
        ]],
        ['Lợi nhuận & loại', [
          ['lowm', 'red', '📈', 'Bán dưới 30%', cnt(FILTERS.lowm)],
          ['nosheet', 'red', '😡', 'Chưa có giá giấy tấm', cnt(FILTERS.nosheet)],
          ['flexo', 'blue', '🟦', 'Flexo', kinds.flexo],
          ['offset', 'violet', '🟪', 'Offset', kinds.offset],
          ['both', 'violet', '🟦🟪', 'Flexo + Offset', kinds.both],
        ]],
      ];
      // Nhóm NHÂN VIÊN: mỗi NVKD 1 chip (ảnh + tên gọn + số báo giá), nhiều báo giá đứng trước
      const byStaff = {};
      items.forEach(({ q, c }) => { const n = staffOf(q, c); if (n) byStaff[n] = (byStaff[n] || 0) + 1; });
      const staffChips = Object.entries(byStaff)
        .sort((a, b) => b[1] - a[1])
        .map(([n, k]) => `<button class="fchip staff${staffSel === n ? ' on' : ''}" data-act="staff" data-staff="${esc(n)}" title="${esc(n)} – bấm để lọc / bỏ lọc">${avatarHtml(n, 16)}${esc(shortName(n))}<b>${k}</b></button>`)
        .join('');
      return `<div class="fbar">${groups
        .map(([name, chips]) => {
          const html = chips.filter((c) => c[4] || state.filter === c[0]).map((c) => fchip(...c)).join('');
          return html ? `<div class="fgroup"><span class="fname">${name}</span><div class="fchips">${html}</div></div>` : '';
        })
        .join('')}${staffChips ? `<div class="fgroup"><span class="fname">Nhân viên</span><div class="fchips">${staffChips}</div></div>` : ''}${state.filter || staffSel ? '<button class="fclear" data-act="filter-clear"><span class="fx">✕</span> Bỏ lọc</button>' : ''}</div>`;
    };
    // (giữ tên cũ cho các chỗ khác)
    const revenueHtml = (items) => totalBadge(items) + filterBar(items);
    // Mỗi báo giá 1 dòng: mã | KH, loại, nhãn, tên | NVKD | bình luận cuối | tiền | % | điểm
    // Màu điểm khả thi: dưới 30 xám, 30 → cam, càng cao càng xanh lá (đậm nhất từ 110 điểm)
    const feaStyle = (score) => {
      if (score < 30) return 'color:#94a3b8;background:#f1f5f9';
      const t = Math.min(1, (score - 30) / 80);
      const hue = Math.round(30 + t * 112); // 30 = cam, 142 = xanh lá
      return `color:hsl(${hue},75%,${Math.round(40 - t * 12)}%);background:hsl(${hue},80%,${Math.round(95 - t * 6)}%)`;
    };
    // Báo giá đang nằm trong "🔥 Gợi ý chốt đơn" (chưa ✓, chưa chốt / chưa có đơn) → nhãn "🔥 Ưu tiên" ở mọi bảng
    const hotLatest = (await kvGet('aiHot')).latest;
    const hotDoneAll = await kvGet('aiHotDone');
    renderCtx.hotSet = new Set((hotLatest?.items || []).filter((x) => !hotDoneAll[x.id]).map((x) => x.id));
    const HOT_BADGE = '<span class="dl-hotbadge sm" title="Ưu tiên chốt (từ tab Gợi ý chốt đơn)">🔥 Ưu tiên</span>';
    // Đếm số lần khách xuất hiện từ trên xuống (lần 2, 3… hiện số bên cạnh mã khách)
    const withOcc = (rows) => {
      const seen = new Map();
      return rows.map((x) => {
        const k = custKey(x.q);
        if (!k) return x;
        const n = (seen.get(k) || 0) + 1;
        seen.set(k, n);
        return { ...x, occ: n };
      });
    };
    const itemHtml = ({ q, c, last, f, badge, occ = 0 }, i) => {
      if (badge === undefined) badge = q && renderCtx.hotSet.has(q.id) && !CLOSED.has(q.quoteStatus) && !hasOrderFull(q, c) ? HOT_BADGE : '';
      const staff = staffOf(q, c);
      const tip = [q?.customer?.name, q?.name, statusLabel(q?.quoteStatus),
        last ? `Bình luận cuối ${ago(last.createdAt)} (${last.staff?.name || '?'})` : `Chưa có bình luận · tạo ${q?.createdAt ? ago(q.createdAt) : '?'}`,
        suggests[c.id]?.sentAt ? 'Đã gửi gợi ý' : suggests[c.id] ? 'Đã có gợi ý' : ''].filter(Boolean).join('\n');
      return `<a class="item ${q?.isRead === false ? 'q-unread' : q?.isRead === true ? 'q-read' : ''}" href="/bao-gia/update/${c.id}" data-nav data-code="${esc(q?.code || c.code)}" title="${esc(tip)}">
      <span class="it-no">${i + 1}</span>
      ${dateCell(q?.createdAt)}
      <span class="it-code">${esc(q?.code || c.code)}</span>
      <span class="it-main">${badge}${kindTag(q)}${noSheetTag(q)}${bossOkTag(q, c)}${targetTag(c)}${buyerTag(q, c)}${highPriceTag(c)}${creditTag(c)}${promiseTag(q, c)}${contractTag(c)}${sampleTag(q, c)}${noDepositTag(c)}</span>
      <span class="it-cust">${custTag(q).trim()}${occ > 1 ? `<i class="kh-occ" title="Khách này xuất hiện lần thứ ${occ} trong bảng (đã có báo giá phía trên)">${occ}</i>` : ''}</span>
      <span class="it-name" title="${esc(q?.name || '')}">${esc(q?.name || '')}</span>
      <span class="it-who" title="${esc(staff || '')}">${avatarHtml(staff, 20)}<span>${esc(shortName(staff) || '?')}</span></span>
      <span class="it-ago">${last ? `💬 ${ago(last.createdAt)}` : '📭 chưa BL'}${suggests[c.id]?.sentAt ? ' ✅' : ''}</span>
      <span class="it-amt">${noPrice(q) ? noPriceTag(q) : q?.amount ? money(q.amount) : ''}</span>
      <span class="it-pct">${diffCell(q)}</span>
      <span class="it-fea"${f ? ` title="${esc(f.reasons.join(', '))}"` : ''}>${f ? `<b class="fea" style="${feaStyle(f.score)}">🎯${f.score}</b>` : ''}</span></a>`;
    };
    // Dòng tiêu đề cột (dính trên đầu khi cuộn) + tổng tiền ngay trên cột Số tiền
    // 20.315.464.107đ → "20,32 tỷ"; dưới 1 tỷ → "845,20 triệu"
    const moneyShort = (n) => {
      const f = (v) => v.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return n >= 1e9 ? `${f(n / 1e9)} tỷ` : n >= 1e6 ? `${f(n / 1e6)} triệu` : money(n);
    };
    // Ngày tạo báo giá: dưới 7 ngày ghi "x giờ/ngày trước" (xanh), còn lại dd/mm/yyyy
    const dmy = (sec) => new Date(sec * 1000).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' });
    const dateCell = (sec) => {
      if (!sec) return '<span class="it-date"></span>';
      const fresh = hoursSince(sec) < 7 * 24;
      return `<span class="it-date${fresh ? ' new' : ''}" title="Tạo lúc ${esc(fmtTime(sec))} ${esc(dmy(sec).slice(-4))}">${fresh ? `🆕 ${ago(sec)}` : dmy(sec)}</span>`;
    };
    const listRows = (items, forExport = false) => {
      const rows = applyFilter(items);
      // Nút Xuất Excel xuất đúng bảng chính đang hiện (đã lọc / tìm / xếp) – không lấy các bảng phụ bên dưới
      if (forExport) state.exportRows = rows;
      if (!rows.length) return '<span class="muted">Không có báo giá phù hợp bộ lọc</span>';
      const total = rows.reduce((a, { q }) => a + (Number(q?.amount) || 0), 0);
      const sumTip = `Tổng ${rows.length} báo giá đang hiện: ${money(total)}`;
      return `<div class="item-head"><span class="it-no">#</span><span class="it-date">Ngày tạo</span><span>Mã BG</span><span>Nhãn</span><span>Khách</span><span>Tên cơ hội</span><span>NVKD</span>
        <span class="it-ago">BL cuối</span><span class="it-amt" title="${esc(sumTip)}">Σ ${moneyShort(total)}</span>${diffHead(rows)}<span class="it-fea">Điểm</span></div>` +
        withOcc(rows).map(itemHtml).join('');
    };
    // Bảng giống tab Báo giá nhưng không áp bộ lọc / tìm kiếm của tab đó; 'after' chèn thêm dòng phụ dưới mỗi báo giá
    renderCtx.plainRows = (rows, after = () => '') => {
      if (!rows.length) return '<span class="muted">Không có báo giá đang mở.</span>';
      const total = rows.reduce((a, { q }) => a + (Number(q?.amount) || 0), 0);
      return `<div class="item-head"><span class="it-no">#</span><span class="it-date">Ngày tạo</span><span>Mã BG</span><span>Nhãn</span><span>Khách</span><span>Tên cơ hội</span><span>NVKD</span>
        <span class="it-ago">BL cuối</span><span class="it-amt" title="Tổng ${rows.length} báo giá: ${money(total)}">Σ ${moneyShort(total)}</span>${diffHead(rows)}<span class="it-fea">Điểm</span></div>` +
        withOcc(rows).map((x, i) => itemHtml(x, i) + after(x)).join('');
    };
    // Gộp "Báo giá khả thi" + "Chưa đọc" vào 1 bảng: báo giá chưa đọc mà không khả thi nối thêm vào (không có điểm)
    const feasibleIds = new Set(feasible.map(({ q }) => q.id));
    const merged = [...feasible, ...unreadAll.filter(({ q }) => !feasibleIds.has(q.id)).map((x) => ({ ...x, f: null }))].sort(sortByErp);
    const unreadN = merged.filter(({ q }) => q?.isRead === false).length;
    state.exportRows = []; // bảng chính trống thì không xuất danh sách cũ
    const overdueBox = `
      <div class="sec-head"><h3>🎯 Báo giá khả thi & chưa đọc <span class="cnt">${merged.length}</span></h3>
        <div class="sec-right"><label class="search"><span>🔍</span><input class="dg-search" type="search" placeholder="Tìm tên cơ hội, mã KH…" value="${esc(state.search || '')}"></label>${totalBadge(merged)}
        <button class="sortbtn2" data-act="sort" title="Đổi cách sắp xếp">↕ ${sortMode() === 'erp' ? 'Như ERP' : 'Theo điểm'}</button>
        <button class="sortbtn2" data-act="export-xlsx" title="Tải danh sách đang hiện (theo bộ lọc / tìm kiếm) ra file Excel">⬇️ Xuất Excel</button></div></div>
      ${filterBar(merged)}
      <div class="hint muted">Báo giá chưa chốt có điểm khả năng chốt đơn (🎯) + mọi báo giá chưa đọc (in đậm) trên CRM. Bấm “📬 chưa đọc” để chỉ xem báo giá chưa đọc.</div>
      ${merged.length
        ? `<div class="box unread">${listRows(merged, true)}</div>`
        : '<div class="muted">Chưa có báo giá nào đủ tín hiệu khả thi hoặc chưa đọc.</div>'}`; // ✂️ Cắt mẫu / 📭 Chưa có bình luận: đã ẩn bảng riêng (vẫn lọc được bằng nút trên thanh lọc)


    const searchFocused = root.activeElement?.classList?.contains('dg-search');
    // Phần tổng quan + Bình luận mới nhất thuộc tab Báo giá
    const headHtml = `
      <div class="headrow"><div class="muted headinfo">Dựa trên ${all.length} báo giá: ${all.filter((x) => comments[x.id]?.threads?.length).length} có bình luận, <b>${all.filter((x) => collected[x.id] && !comments[x.id]?.threads?.length).length} chưa có bình luận</b> (đã mở xem), ${all.filter((x) => !collected[x.id] && !comments[x.id]?.threads?.length).length} chưa đọc tới.
      ${(() => {
        const done = all.filter((x) => collected[x.id] || comments[x.id]?.threads?.length).length;
        const pctDone = all.length ? Math.round((done / all.length) * 100) : 0;
        return `<div class="cov"><div class="cov-bar"><span style="width:${pctDone}%"></span></div><span>Extension đã đọc <b>${pctDone}%</b> (${done}/${all.length})${pctDone < 100 ? ' – bấm <b>📦 Thu thập toàn bộ</b> trong popup để đọc 100%' : ' ✅'}</span></div>`;
      })()}
      Bật/tắt thu thập ngầm, tự mở bảng và xem chi phí Claude trong popup của extension.</div>
      ${await (async () => {
        const [ns, me, marks] = [await kvGet('notifs'), await kvGet('me'), await kvGet('notifRead')];
        // Dấu đã đọc đồng bộ từ máy khác
        for (const k of Object.keys(marks)) if (ns[k] && ns[k].read === false) ns[k] = { ...ns[k], read: true, readLocal: true };
        // Báo giá của bình luận đã được mở (ở máy này hay máy khác – dữ liệu báo giá đồng bộ) sau thời điểm bình luận → coi là đã đọc
        const byCode = {};
        for (const q of Object.values(quotes)) if (q?.code) byCode[q.code] = q;
        for (const [k, n] of Object.entries(ns)) {
          if (n?.read !== false) continue;
          const q = byCode[(n.text || '').match(/#?(BG\d+)/)?.[1]];
          const seenAt = Math.max(q?.readAt || 0, q?.isRead === true ? q.erpRankAt || 0 : 0);
          if (q?.isRead === true && seenAt && seenAt >= (n.at || 0)) ns[k] = { ...n, read: true };
        }
        syncPendingReads(ns, me?.id ?? meName);
        return notifBox(ns, quotes, me);
      })()}</div>`;
    const panelHtml = `
      <div class="row"><h2>Đánh giá nhân viên kinh doanh</h2><span class="hbtns">${fullTip()}<button class="x fs${needFull() ? ' urge' : ''}" data-act="full" title="${lsGet('dgPanelFull') === '1' ? 'Thu nhỏ lại' : 'Toàn màn hình'}">${lsGet('dgPanelFull') === '1' ? '🗗' : '⛶'}</button><button class="x" data-act="close">×</button></span></div>
      ${state.error ? `<div class="err">Lỗi: ${esc(state.error)}</div>` : ''}
      ${await (async () => {
        // 3 tab lớn: Báo giá | Khách hàng 6 tháng | Báo cáo tuần (nhớ qua F5: dgTab)
        const allowed = perm.tabs.filter((t) => TABS.some((x) => x[0] === t));
        if (IS_OWNER()) allowed.push('gap'); // tab riêng của Nguyễn Trung Toán
        let tab = ['cust', 'week', 'hot', 'deal', 'set', 'debt', 'qa', 'gap'].includes(lsGet('dgTab')) ? lsGet('dgTab') : 'quotes';
        if (!allowed.includes(tab)) tab = allowed[0];
        const hotData = (await kvGet('aiHot')).latest;
        const hotDone = await kvGet('aiHotDone');
        const hotN = (hotData?.items || []).filter((x) => quotes[x.id] && !CLOSED.has(quotes[x.id].quoteStatus) && !hasOrderFull(quotes[x.id], renderCtx.comments?.[x.id]) && !hotDone[x.id] && !cancelInfo(renderCtx.comments?.[x.id])).length;
        renderCtx.custHidden = Object.fromEntries(Object.entries(await kvGet('custHidden')).filter(([, v]) => v && !v.off));
        const cust = custRows(quotes, renderCtx.orders);
        const barRaw = `<div class="bigtabs">
          <button class="bigtab${tab === 'quotes' ? ' on' : ''}" data-act="tab" data-tab="quotes">🎯 Báo giá <b>${merged.length}</b></button>
          <button class="bigtab hot${tab === 'hot' ? ' on' : ''}${hotN ? ' has' : ''}" data-act="tab" data-tab="hot">🔥 Gợi ý chốt đơn <b>${hotN}</b></button>
          <button class="bigtab${tab === 'deal' ? ' on' : ''}" data-act="tab" data-tab="deal">🧠 Phân tích deal</button>
          <button class="bigtab${tab === 'cust' ? ' on' : ''}" data-act="tab" data-tab="cust">👥 Khách hàng <b>${cust.rows.filter((r) => !isHiddenCust(r, renderCtx.custHidden)).length}</b></button>
          <button class="bigtab${tab === 'week' ? ' on' : ''}" data-act="tab" data-tab="week">📅 Báo cáo tuần</button>
          <button class="bigtab${tab === 'debt' ? ' on' : ''}" data-act="tab" data-tab="debt">💰 Công nợ</button>
          <button class="bigtab qa${tab === 'qa' ? ' on' : ''}" data-act="tab" data-tab="qa">💬 Bộ câu hỏi</button>
          <button class="bigtab gap${tab === 'gap' ? ' on' : ''}" data-act="tab" data-tab="gap">📈 Chênh lệch 2 hệ thống</button>
          <button class="bigtab set${tab === 'set' ? ' on' : ''}" data-act="tab" data-tab="set">⚙️ Cài đặt</button></div>`;
        // Chỉ hiện các tab được phân quyền
        const bar = barRaw.replace(/<button class="bigtab[^"]*" data-act="tab" data-tab="(\w+)">[\s\S]*?<\/button>/g, (m, t) => (allowed.includes(t) ? m : ''));
        if (!tab) return '<div class="muted" style="margin:16px">Chưa được cấp màn hình nào.</div>';
        if (tab === 'hot') {
          [renderCtx.zaloJobs, renderCtx.zaloNames, renderCtx.zaloAlive, renderCtx.zaloSent] = await Promise.all([kvGet('zaloJobs'), kvGet('zaloNames'), kvGet('zaloAlive'), kvGet('zaloSent')]);
          return bar + hotBox(hotData, quotes, hotDone, true);
        }
        if (tab === 'debt') return bar + debtTab(await kvGet('debt2'), perm);
        if (tab === 'qa') {
          await qaHydrate();
          return bar + qaTab(perm.admin);
        }
        if (tab === 'set') return bar + (await settingsTab(quotes, await kvGet('me')));
        if (tab === 'gap') return bar + (await gapTab());
        if (tab === 'deal') return bar + dealTab(quotes, await kvGet('me'), await kvGet('dealAi'), hotData, hotDone);
        if (tab === 'week') {
          renderCtx.reports = await kvGet('reports');
          return bar + weekTab(quotes, renderCtx.orders, await kvGet('me'));
        }
        return tab === 'cust'
          ? bar + custTab(cust)
          : bar + headHtml + overdueBox + learnedBox(await kvGet('learned'));
      })()}
    `;
    // Chỉ vẽ lại khi nội dung thật sự thay đổi (bảng tự cập nhật liên tục – không để nhấp nháy / mất vị trí)
    const panelEl = root.querySelector('.panel');
    if (panelHtml !== lastPanelHtml || !panelEl.innerHTML) {
      lastPanelHtml = panelHtml;
      panelEl.innerHTML = panelHtml;
    }
    if (searchFocused) {
      const el = root.querySelector('input.dg-search');
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
    // Ảnh lỗi → chữ cái đầu
    root.querySelectorAll('img.ava').forEach((img) =>
      img.addEventListener('error', () => {
        const span = document.createElement('span');
        span.className = 'ava ini';
        span.style.cssText = img.style.cssText;
        span.textContent = img.dataset.ini || '?';
        img.replaceWith(span);
      }),
    );
  }

  // Bình luận mới nhất từ chuông thông báo của CRM (đã đọc / chưa đọc theo CRM); bấm để mở báo giá
  function notifBox(notifs, quotes, me) {
    const who = me?.id ?? meName;
    const byCode = {};
    for (const q of Object.values(quotes)) if (q?.code) byCode[q.code] = q;
    const items = Object.values(notifs || {})
      // Bỏ bình luận của chính mình ("Nguyễn Trung Toán vừa bình luận vào…")
      .filter((n) => n.owner === who && /bình luận vào khách hàng/i.test(n.text || "") && !n.text.startsWith(`${myName(me)} vừa bình luận`))
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, 8)
      // Đã đọc hết → chỉ giữ 2 bình luận mới nhất cho gọn
      .filter((n, i, arr) => i < 2 || arr.some((x) => x.read === false));
    if (!items.length) return `<div class="nbox"><div class="nbox-h">💬 Bình luận mới nhất</div><div class="muted">Bấm chuông thông báo của CRM một lần để extension ghi lại.</div></div>`;
    const unread = items.filter((n) => n.read === false).length;
    const rows = items.map((n) => {
      const nkey = `${n.owner}:${n.id}`;
      const code = n.text.match(/#?(BG\d+)/)?.[1];
      const q = code && byCode[code];
      // Mã BG trùng id báo giá (BG26686 → /bao-gia/update/26686)
      const href = q ? `/bao-gia/update/${q.id}` : code ? `/bao-gia/update/${code.slice(2)}` : n.link ? String(n.link).replace(/^https?:\/\/[^/]+/, '') : n.oppId ? `/bao-gia/update/${n.oppId}` : '';
      const cls = `nitem ${n.read === false ? 'unread-n' : ''}`;
      const body = `<span class="ndot"></span><span class="ntext">${esc(n.text)}</span><span class="nago">${n.at ? ago(n.at) : ''}</span>`;
      return href
        ? `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener" data-nkey="${esc(nkey)}" title="${esc(n.text)}">${body}</a>`
        : `<div class="${cls}" data-nkey="${esc(nkey)}" title="${esc(n.text)}">${body}</div>`;
    });
    return `<div class="nbox"><div class="nbox-h">💬 Bình luận mới nhất${unread ? ` <span class="nbadge">${unread} chưa đọc</span>` : ''}</div>${rows.join('')}</div>`;
  }

  // ---------- 🔥 AI chọn báo giá chốt được liền ----------
  // Lấy tối đa 40 báo giá khả thi điểm cao nhất, gửi luồng bình luận (rút gọn) cho Claude,
  // Thẻ "Gói cài đặt extension" (chỉ quản trị): tải file zip trên máy chủ để gửi riêng cho nhân viên
  let zipRepulled = false;
  async function zipCard() {
    const f = (await kvGet('files'))['extension-zip'];
    // Máy chưa có file (đã kéo qua mốc trước khi file được đưa lên) → lùi mốc đồng bộ 3 ngày rồi kéo lại 1 lần
    if (!f?.b64 && !zipRepulled) {
      zipRepulled = true;
      (async () => {
        const back = new Date(Date.now() - 3 * 86400e3).toISOString();
        const { syncCursor } = await call({ type: 'store.get', keys: ['syncCursor'] });
        if (!syncCursor || syncCursor > back) await call({ type: 'store.set', values: { syncCursor: back } });
        await call({ type: 'remote.pull' });
        lastPanelHtml = '';
        render();
      })().catch((e) => console.warn('[DG] zip pull', e));
    }
    return `<div class="sx-zip"><div class="sx-card"><div class="sx-h"><span class="sx-hic violet">📦</span><div><b>Gói cài đặt extension cho nhân viên</b><span>Tải file zip rồi gửi riêng cho nhân viên (Zalo / email nội bộ)</span></div></div>
      ${f?.b64
        ? `<div class="zp-row"><div class="zp-file"><span class="zp-ic">🗜️</span><div><b>${esc(f.name)}</b><span>${Math.round((f.size || 0) / 1024)} KB · cập nhật ${ago(Math.floor((f.at || 0) / 1000))}${f.version ? ` · bản ${esc(f.version)}` : ''}</span></div></div>
            <button class="rp-start cta" data-act="zip-download">⬇️ Tải file zip<span class="cta-sub">để gửi cho nhân viên</span></button></div>`
        : `<div class="muted">${zipRepulled ? '<span class="spinner"></span> Đang tải file từ máy chủ…' : 'Chưa có file trên máy chủ.'}</div>`}
      <ol class="zp-steps"><li>Giải nén file zip vào 1 thư mục cố định (đừng xoá sau khi cài).</li>
        <li>Mở <code>chrome://extensions</code> → bật <b>Developer mode</b> → <b>Load unpacked</b> → chọn thư mục vừa giải nén.</li>
        <li>Bấm <b>Chi tiết</b> của extension → bật <b>Allow User Scripts</b>, rồi tải lại trang CRM.</li>
        <li>Từ đó extension tự cập nhật, không cần cài lại.</li></ol>
      <div class="zp-warn">🔐 File có chứa mật khẩu nhóm – chỉ gửi riêng cho nhân viên trong công ty, không đăng lên mạng.</div></div></div>`;
  }

  // Thẻ Phân quyền (chỉ quản trị): bật/tắt phân quyền, mỗi người: được dùng, vai trò, các màn hình được vào
  async function permsCard(quotes) {
    const seen = await kvGet('seenUsers');
    const names = new Map();
    const add = (n) => n && !isExcluded(n) && !names.has(norm(n)) && names.set(norm(n), n);
    Object.values(seen || {}).forEach((x) => add(x?.name));
    Object.values(quotes).forEach((q) => add(q?.staff?.name));
    Object.values(PERMS.users || {}).forEach((u) => add(u?.name));
    ADMIN_NAMES.forEach(add);
    const people = [...names.values()].sort((a, b) => a.localeCompare(b, 'vi'));
    const isOn = (n) => {
      const k = norm(n);
      const u = PERMS.users?.[k] || {};
      return ADMIN_NAMES.some((x) => norm(x) === k) || u.role === 'admin' || !!u.enabled;
    };
    const onList = people.filter(isOn);
    const offList = people.filter((n) => !isOn(n));
    const sub = lsGet('dgPermTab') === 'off' ? 'off' : 'on';
    const rows = (sub === 'on' ? onList : offList)
      .map((n) => {
        const k = norm(n);
        const u = PERMS.users?.[k] || {};
        const fixedAdmin = ADMIN_NAMES.some((x) => norm(x) === k);
        const role = fixedAdmin ? 'admin' : u.role || 'sale';
        const enabled = fixedAdmin || role === 'admin' || !!u.enabled;
        const tabs = role === 'admin' ? PERM_ITEMS.map((t) => t[0]) : u.tabs?.length ? u.tabs : SALE_TABS;
        const seenAt = seen?.[k]?.at;
        return `<tr class="${enabled ? '' : 'off'}"><td><span class="ct-who">${avatarHtml(n, 22)}<b>${esc(n)}</b></span><div class="muted pm-seen">${seenAt ? `mở extension ${ago(Math.floor(seenAt / 1000))}` : 'chưa mở extension'}</div></td>
          <td>${fixedAdmin ? '<span class="pm-fixed">Quản trị (mặc định)</span>' : `<button class="pm-role ${role}" data-act="perm-role" data-key="${esc(k)}" data-name="${esc(n)}">${role === 'admin' ? '👑 Quản trị' : '💼 NVKD'}</button>`}</td>
          <td>${fixedAdmin || role === 'admin' ? '<span class="pm-fixed">Luôn được dùng</span>' : `<button class="st-tg${enabled ? ' on' : ''}" data-act="perm-enable" data-key="${esc(k)}" data-name="${esc(n)}"><i></i></button>`}</td>
          <td class="pm-tabs">${PERM_ITEMS.map(([t, label]) => `<button class="pm-tab${tabs.includes(t) ? ' on' : ''}" ${role === 'admin' ? 'disabled' : `data-act="perm-tab" data-key="${esc(k)}" data-name="${esc(n)}" data-tab="${t}"`}>${label}</button>`).join('')}</td></tr>`;
      })
      .join('');
    return `<div class="st-card pm"><h4>👥 Phân quyền sử dụng extension</h4>
      <label class="st-sw"><span><b>Bật phân quyền</b><br><span class="muted">${PERMS.enforced ? 'Đang bật: chỉ người được cấp mới dùng được, và chỉ vào các màn hình được chọn.' : 'Đang tắt: mọi người dùng CRM đều dùng được extension với đầy đủ màn hình.'}</span></span>
        <button class="st-tg${PERMS.enforced ? ' on' : ''}" data-act="perm-enforce"><i></i></button></label>
      <div class="pm-subtabs"><button class="pm-sub${sub === 'on' ? ' on' : ''}" data-act="perm-sub" data-sub="on">✅ Đã phân quyền <b>${onList.length}</b></button>
        <button class="pm-sub off${sub === 'off' ? ' on' : ''}" data-act="perm-sub" data-sub="off">⏳ Chưa được phân quyền <b>${offList.length}</b></button></div>
      <div class="ct-wrap"><table class="ct pm-t"><thead><tr><th>Người dùng</th><th>Vai trò</th><th>Được dùng</th><th>Màn hình được vào</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="muted">${sub === 'on' ? 'Chưa cấp quyền cho ai.' : 'Mọi người đều đã được phân quyền.'}</td></tr>`}</tbody></table></div>
      <div class="muted">Danh sách gồm mọi NVKD trong dữ liệu báo giá và những người đã mở extension. Quyền đồng bộ giữa các máy, có hiệu lực ngay.</div></div>`;
  }

  // ---------- Tab "💬 Bộ câu hỏi": các bộ câu hỏi nhanh, điều kiện dùng, thứ tự ưu tiên; quản trị sửa được (kv 'qbank') ----------
  // Biến trong câu: hiện thành nút (chip), bấm để đổi loại
  const QVARS = {
    p: { icon: '👤', label: 'em / chị / anh', title: 'Cách gọi NVKD (tự theo từng người)' },
    P: { icon: '👤', label: 'Em / Chị / Anh', title: 'Cách gọi NVKD – viết hoa (đầu câu)' },
    s: { icon: '🧑‍💼', label: 'anh / em (sếp)', title: 'Sếp tự xưng – gọi NVKD là "em" thì "anh", gọi "chị / anh" thì "em"' },
    S: { icon: '🧑‍💼', label: 'Anh / Em (sếp)', title: 'Sếp tự xưng – viết hoa (đầu câu)' },
    d: { icon: '⏱', label: 'khoảng thời gian', title: 'Bao lâu chưa có phản hồi (vd. 5 ngày)' },
  };
  const qVars = (id) => (id === 'silentLead' ? ['p', 'P', 's', 'S', 'd'] : ['p', 'P', 's', 'S']);
  const qChip = (v) => `<span class="qv qv-${v === 'd' ? 'd' : v === 's' || v === 'S' ? 's' : 'p'}" contenteditable="false" data-act="qv-chip" data-v="${v}" title="${esc(QVARS[v]?.title || '')} – bấm để đổi">${QVARS[v]?.icon || ''} ${esc(QVARS[v]?.label || v)}</span>`;
  // Câu lưu: {p}/{P}/{d} và chữ "anh / Anh" (sếp tự xưng, tự đổi theo NVKD) → hiện thành nút
  const qToHtml = (t) =>
    esc(t)
      .replace(/(^|[^\p{L}{])(anh|Anh)(?![\p{L}}])/gu, (m, pre, w) => `${pre}{${w === 'Anh' ? 'S' : 's'}}`)
      .replace(/\{([pPdsS])\}/g, (m, v) => qChip(v));
  const qeRow = (t, k) => `<div class="qe-row"><span class="qe-no">${k + 1}</span><div class="qe-cell"><div class="qe-line qb-edit" contenteditable="true" spellcheck="false">${qToHtml(t)}</div>
      <div class="qe-prev">${esc(fillP(t, state.qaP || 'em', '5 ngày'))}</div></div><button class="qe-del" data-act="qb-row-del" title="Xoá câu này">✕</button></div>`;
  // Ô câu → chuỗi có {p} / {P} / {d}
  const qSerialize = (el) => {
    let out = '';
    const walk = (n) => {
      if (n.nodeType === 3) out += n.textContent;
      else if (n.dataset?.v) out += n.dataset.v === 's' ? 'anh' : n.dataset.v === 'S' ? 'Anh' : `{${n.dataset.v}}`;
      else if (n.tagName === 'BR') out += ' ';
      else n.childNodes.forEach(walk);
    };
    el.childNodes.forEach(walk);
    return varSpace(out).replace(/\s+/g, ' ').trim();
  };
  const qeRenumber = (box) => box?.querySelectorAll('.qe-row').forEach((r, k) => (r.querySelector('.qe-no').textContent = k + 1));
  // Gõ tới đâu tự lưu tới đó (chờ 0,8 giây sau lần gõ cuối) – lưu cả bộ, áp dụng mọi máy
  let qeTimer = null;
  const qeDirty = (box) => {
    state.qbDirty = true;
    const d = box?.closest('.qa-pane')?.querySelector('.qe-dirty');
    if (d) {
      d.hidden = false;
      d.className = 'qe-dirty';
      d.textContent = '● đang lưu…';
    }
    clearTimeout(qeTimer);
    qeTimer = setTimeout(() => qeAutosave(box), 800);
  };
  async function qeAutosave(box) {
    if (!box?.isConnected) return;
    const id = box.dataset.id;
    const lines = [...box.querySelectorAll('.qe-line')].map(qSerialize).filter(Boolean);
    if (!lines.length) return; // không lưu bộ rỗng (muốn về câu gốc thì bấm "Về mặc định")
    await kvMerge('qbank', { [id]: { lines, at: Date.now(), by: meName } });
    QB = { ...QB, [id]: { lines, at: Date.now(), by: meName } };
    state.qbDirty = false;
    state.qaScan = null;
    const d = box.closest('.qa-pane')?.querySelector('.qe-dirty');
    if (d) {
      d.className = 'qe-dirty ok';
      d.textContent = `✓ Đã tự lưu lúc ${new Date().toLocaleTimeString('vi-VN')} – áp dụng mọi máy`;
    }
  }
  let qeLast = null; // ô câu + vị trí con trỏ gần nhất (để chèn biến)
  const qeSel = () => (root.getSelection ? root.getSelection() : getSelection());
  function qeRemember() {
    const sel = qeSel();
    const line = root.activeElement?.closest?.('.qe-line');
    if (line && sel?.rangeCount) qeLast = { line, range: sel.getRangeAt(0).cloneRange() };
  }
  function qePreview(line) {
    const prev = line.closest('.qe-row')?.querySelector('.qe-prev');
    if (prev) prev.textContent = fillP(qSerialize(line), state.qaP || 'em', '5 ngày');
    qeDirty(line.closest('.qe'));
  }
  function qeInsert(v) {
    const all = root.querySelectorAll('.qe-line');
    let line = qeLast?.line?.isConnected ? qeLast.line : all[all.length - 1];
    if (!line) return;
    const tpl = document.createElement('template');
    tpl.innerHTML = qChip(v);
    const chip = tpl.content.firstChild;
    const space = document.createTextNode(' ');
    let range = qeLast?.line === line ? qeLast.range : null;
    if (!range || !line.contains(range.startContainer)) {
      range = document.createRange();
      range.selectNodeContents(line);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(space);
    range.insertNode(chip);
    range.setStartAfter(space);
    range.collapse(true);
    line.focus();
    const sel = qeSel();
    try {
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
    qeLast = { line, range: range.cloneRange() };
    qePreview(line);
  }

  // Duyệt mọi báo giá: báo giá nào đang cần hỏi NVKD, bằng bộ câu nào, câu gì + điểm ưu tiên (tính lại tối đa 2 phút / lần)
  const QA_WEIGHT = { buyerPct: 48, bossOrder: 100, promise: 90, bossPrice: 85, handover: 80, monthly: 60, longNoOrder: 55, priceAsk: 50, reprint: 50, noComment: 35, connect: 30, offsetGap: 25, reportBack: 20 };
  const QA_GAP = 4 * 3600e3; // 1 báo giá không xuất hiện lại trong 4 giờ sau khi đã hỏi
  // Mở tab lần đầu: lấy kết quả đã lưu trên máy để hiện ngay (đánh dấu cũ → vẫn tính lại ngầm)
  async function qaHydrate() {
    if (state.qaScan || state.qaHydrated) return;
    state.qaHydrated = true;
    try {
      const cache = await kvGet('qaScanCache');
      const qs = renderCtx.quotes || {};
      const cm = renderCtx.comments || {};
      const list = (cache?.list || [])
        .filter((x) => qs[x.id])
        .map((x) => ({ ...x, q: qs[x.id], c: cm[x.id] || { id: x.id, threads: [] } }));
      if (list.length) state.qaScan = { at: 0, list, cachedAt: cache.at }; // at = 0 → coi là cũ, tự làm mới
    } catch {}
  }
  // Chạy ngầm từng đợt (không đứng màn hình): trả về kết quả cũ / null trong lúc đang tính, tính xong tự vẽ lại
  function qaScanAll() {
    const fresh = state.qaScan && Date.now() - state.qaScan.at < 120e3;
    if (!fresh && !state.qaScanning) qaScanRun();
    return state.qaScan?.list || null;
  }
  async function qaScanRun() {
    state.qaScanning = true;
    try {
    const qs = renderCtx.quotes || {};
    const cm = renderCtx.comments || {};
    const list = [];
    const all = Object.values(qs);
    state.qaScanProg = { done: 0, total: all.length };
    let n = 0;
    for (const q of all) {
      if (++n % 120 === 0) {
        state.qaScanProg = { done: n, total: all.length };
        await new Promise((r) => setTimeout(r, 0)); // nhường cho giao diện
      }
      if (!q?.id) continue;
      const c = cm[q.id] || { id: q.id, threads: [] };
      const staff = staffOf(q, c);
      if (!staff || isExcluded(staff)) continue;
      let r = null;
      try {
        r = quickQuestion(q, c, followMode(q, c), addressFor(staff, cm, qs));
      } catch {}
      if (!r?.bank) continue;
      // Điểm ưu tiên: loại tình huống + giá trị báo giá + khả năng chốt + đang trong Gợi ý chốt đơn − vừa hỏi gần đây
      const amt = Number(q.amount) || 0;
      let score = QA_WEIGHT[r.bank] || 20;
      score += Math.min(40, Math.round(Math.log10(1 + amt / 1e6) * 15));
      let f = null;
      try {
        f = feasibility(q, c, renderCtx.orders);
      } catch {}
      score += Math.min(25, Math.max(0, Math.round((f?.score || 0) / 4)));
      if (renderCtx.hotSet?.has(q.id)) score += 40;
      // Đã hỏi trong 4 giờ qua (bấm Bình luận ngay, hoặc sếp tự bình luận trên CRM) → không đưa vào lại
      const sent = renderCtx.quickSent?.[q.id];
      let bossAt = 0;
      const walk = (t) => {
        if (norm(t.staff?.name) === norm(meName) && t.createdAt > bossAt) bossAt = t.createdAt;
        (t.children || []).forEach(walk);
      };
      (c.threads || []).forEach(walk);
      const lastAsk = Math.max(sent?.at || 0, bossAt * 1000);
      const recent = Date.now() - lastAsk < QA_GAP;
      // Câu số mấy trong bộ (để bấm "Sửa câu" nhảy đúng câu)
      const pp = addressFor(staff, cm, qs);
      const lineIdx = qbank(r.bank).findIndex((t) => {
        const f2 = fillP(t, pp, '');
        return f2 && r.text.includes(f2.replace(/\s+$/, ''));
      });
      list.push({ q, c, staff, r, score, amt, recent, lineIdx });
    }
    state.qaScan = { at: Date.now(), list };
    // Lưu bản gọn trên máy (lần sau mở tab hiện ngay, rồi tính lại ngầm)
    call({
      type: 'kv.set',
      key: 'qaScanCache',
      value: { at: Date.now(), list: list.map((x) => ({ id: x.q.id, staff: x.staff, r: { bank: x.r.bank, why: x.r.why, text: x.r.text }, score: x.score, amt: x.amt, recent: x.recent, lineIdx: x.lineIdx })) },
    }).catch(() => {});
    } finally {
      state.qaScanning = false;
    }
    lastPanelHtml = '';
    if (lsGet('dgTab') === 'qa') render();
  }
  const qaLevel = (sc) => (sc >= 140 ? ['hi', '🔴 Cao'] : sc >= 95 ? ['mid', '🟠 Vừa'] : ['lo', '🟢 Thấp']);
  // Tab con "Tổng quan": việc cần bình luận cho NVKD, xếp ưu tiên từ cao xuống thấp
  function qaOverview() {
    // Mỗi báo giá chỉ 1 dòng (trùng mã thì giữ dòng điểm cao nhất)
    const seen = new Set();
    const scanned = qaScanAll();
    if (!scanned) return `<div class="qa-pane qo"><div class="qo-loading"><span class="spinner"></span> Đang rà ${state.qaScanProg?.total || ''} báo giá để chọn việc cần bình luận… ${state.qaScanProg?.done || 0}/${state.qaScanProg?.total || 0}</div></div>`;
    const all = scanned
      .filter((x) => !x.recent)
      .sort((a, b) => b.score - a.score)
      .filter((x) => {
        const k = x.q.code || x.q.id;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    const staffF = state.qaStaff || '';
    const rows = staffF ? all.filter((x) => x.staff === staffF) : all;
    const byStaff = {};
    all.forEach((x) => (byStaff[x.staff] = (byStaff[x.staff] || 0) + 1));
    const lv = { hi: 0, mid: 0, lo: 0 };
    const lvAmt = { hi: 0, mid: 0, lo: 0 }; // tổng giá trị báo giá mỗi nhóm
    rows.forEach((x) => {
      const k = qaLevel(x.score)[0];
      lv[k]++;
      lvAmt[k] += x.amt || 0;
    });
    const byBank = {};
    rows.forEach((x) => (byBank[x.r.bank] = (byBank[x.r.bank] || 0) + 1));
    const bankChips = QBANKS.filter((b) => byBank[b.id]).map((b) => `<span class="qo-bk" title="${esc(b.when)}">${b.icon} ${esc(b.title)} <b>${byBank[b.id]}</b></span>`).join('');
    const staffChips = [['', 'Tất cả', all.length], ...Object.entries(byStaff).sort((a, b) => b[1] - a[1]).map(([n, k]) => [n, shortName(n), k])]
      .map(([n, label, k]) => `<button class="qo-st${n === staffF ? ' on' : ''}" data-act="qa-staff" data-staff="${esc(n)}">${n ? avatarHtml(n, 16) : ''}${esc(label)} <b>${k}</b></button>`)
      .join('');
    const show = state.qaShow || 40;
    const list = rows
      .slice(0, show)
      .map((x, i) => {
        const [cls, lab] = qaLevel(x.score);
        const b = QBANKS.find((k) => k.id === x.r.bank);
        const bno = QBANKS.indexOf(b) + 1;
        return `<a class="qo-row ${cls}" href="/bao-gia/update/${x.q.id}" data-nav data-code="${esc(x.q.code)}">
          <span class="qo-no">${i + 1}</span><span class="qo-lv ${cls}" title="Điểm ưu tiên ${x.score}">${lab}</span>
          <span class="qo-main"><span class="qo-top"><b>${esc(x.q.code)}</b>${custTag(x.q)}<span class="qo-bank" title="Bộ câu số ${bno}${x.lineIdx >= 0 ? ` · câu ${x.lineIdx + 1}` : ''}"><i class="qo-bno">Bộ ${bno}${x.lineIdx >= 0 ? `·câu ${x.lineIdx + 1}` : ''}</i>${b?.icon || ''} ${esc(b?.title || '')}</span><span class="qo-why">${esc(x.r.why)}</span></span>
            <span class="qo-qr"><span class="qo-q" title="${esc(x.r.text)}">💬 “${esc(x.r.text)}”</span><button class="qo-edit" data-act="qa-edit" data-bank="${x.r.bank}" data-idx="${x.lineIdx}" title="Câu này chưa hợp lý? Sửa ngay trong bộ câu số ${bno}">✏️ Sửa câu</button></span></span>
          <span class="qo-side"><span class="qo-amt">${x.amt ? moneyShortG(x.amt) : '<span class="muted">0đ</span>'}</span><span class="qo-who">${avatarHtml(x.staff, 18)}${esc(shortName(x.staff))}</span></span></a>`;
      })
      .join('');
    return `<div class="qa-pane qo">
        <div class="qa-ph"><span class="qa-pic">📊</span><div><h3>Tổng quan – cần bình luận cho NVKD ${state.qaScanning ? `<span class="qo-sync"><span class="spinner"></span> đang làm mới…</span>` : ''}</h3>
          <span class="muted">${rows.length} báo giá cần hỏi · xếp theo điểm ưu tiên (tình huống + giá trị báo giá + khả năng chốt + đang trong 🔥 Gợi ý chốt đơn) · báo giá đã hỏi thì ẩn 4 giờ rồi mới hiện lại</span></div></div>
        <div class="qo-kpi">${[['hi', '🔴 Ưu tiên cao'], ['mid', '🟠 Ưu tiên vừa'], ['lo', '🟢 Ưu tiên thấp']]
          .map(([k, label]) => `<div class="qo-k ${k}"><div class="qo-kr"><b>${lv[k]}</b><em title="Tổng giá trị ${lv[k]} báo giá: ${money(lvAmt[k])}">💰 ${moneyShortG(lvAmt[k]) || '0đ'}</em></div><span>${label} · báo giá</span></div>`)
          .join('')}</div>
        <div class="qo-sts">${staffChips}</div>
        <div class="qo-bks">${bankChips}</div>
        <div class="qo-list">${list || '<div class="muted">Không có báo giá nào cần hỏi.</div>'}</div>
        ${rows.length > show ? `<button class="qo-more" data-act="qa-more">Xem thêm 40 · còn ${rows.length - show} báo giá ưu tiên thấp hơn</button>` : ''}
        <div class="muted">Bấm 1 dòng để mở báo giá – thẻ bên phải có sẵn câu hỏi, sửa nếu cần rồi bấm 📨 Bình luận ngay.</div></div>`;
  }

  // Review: câu hỏi hiện thế nào với từng cách gọi + các báo giá ĐANG khớp điều kiện bộ này (câu đúng như thẻ bên phải sẽ gợi ý)
  function qaReview(sel) {
    const P = ['em', 'chị', 'anh'].includes(state.qaP) ? state.qaP : 'em';
    const lines = qbank(sel.id);
    const chat = lines
      .map((t) => `<div class="qr-b"><span class="qr-ava">👨‍💼</span><div class="qr-msg">${esc(selfFix(fillP(t, P, '5 ngày'), P))}</div></div>`)
      .join('');
    const live = sel.id === 'zalo' || sel.id === 'silentLead' || sel.id === 'priceGive' ? [] : (qaScanAll() || []).filter((x) => x.r.bank === sel.id).sort((a, b) => b.score - a.score);
    const liveHtml = sel.id === 'zalo' || sel.id === 'priceGive'
      ? `<div class="muted">${sel.id === 'zalo' ? 'Bộ này dùng ở tab 🔥 Gợi ý chốt đơn (nút 💬 từng deal).' : 'Bộ này dùng khi bấm 🖨️ In báo giá → dán vào bình luận.'}</div>`
      : sel.id === 'silentLead'
        ? '<div class="muted">Bộ này ghép phía trước câu hỏi của bộ 6, 7, 9, 11 khi đã hơn 3 ngày chưa có phản hồi (vd. &quot;35 ngày chưa có phản hồi, báo cáo lại nhé em.&quot;).</div>'
        : live.length
          ? `<div class="qr-live">${live.slice(0, 15).map(({ q, staff, r }) => `<a class="qr-row" href="/bao-gia/update/${q.id}" data-nav data-code="${esc(q.code)}">
              <b>${esc(q.code)}</b>${custTag(q)}<span class="qr-who">${avatarHtml(staff, 18)}${esc(shortName(staff))}</span><span class="qr-why">${esc(r.why)}</span><span class="qr-q">“${esc(r.text)}”</span></a>`).join('')}</div>
            ${live.length > 15 ? `<div class="muted">… và ${live.length - 15} báo giá khác</div>` : ''}`
          : state.qaScan
            ? '<div class="muted">Hiện chưa có báo giá nào khớp điều kiện này (hoặc đã bị điều kiện ưu tiên cao hơn lấy trước).</div>'
            : '<div class="muted"><span class="spinner"></span> Đang rà các báo giá…</div>';
    return `<div class="qr"><div class="qr-h"><b>🔍 Review bộ câu hỏi</b>
        <span class="qr-ps">Gọi NVKD là:${['em', 'chị', 'anh'].map((x) => `<button class="qr-p${x === P ? ' on' : ''}" data-act="qa-p" data-p="${x}">${x}</button>`).join('')}</span></div>
      <div class="qr-cols"><div><div class="qa-lbl">💬 Tin nhắn sẽ hiện (${lines.length} câu)</div><div class="qr-chat">${chat}</div></div>
        <div><div class="qa-lbl">📋 Báo giá đang khớp điều kiện (${sel.id === 'zalo' || sel.id === 'silentLead' || sel.id === 'priceGive' ? '–' : live.length})</div>${liveHtml}</div></div></div>`;
  }

  function qaTab(admin) {
    const ex = (t) => esc(fillP(t, 'em', '5 ngày'));
    const ov = !lsGet('dgQaSel') || lsGet('dgQaSel') === 'overview';
    const sel = QBANKS.find((b) => b.id === lsGet('dgQaSel')) || QBANKS[0];
    const isEd = (b) => !!QB[b.id]?.lines?.filter(Boolean).length;
    // Menu con bên trái: mỗi bộ câu hỏi 1 dòng (theo thứ tự ưu tiên)
    const menu = `<button class="qa-mi qa-ov${ov ? ' on' : ''}" data-act="qa-sel" data-id="overview"><span class="qa-mt">📊 Tổng quan – cần bình luận</span><span class="qa-mc">${state.qaScan ? state.qaScan.list.filter((x) => !x.recent).length : '…'}</span></button><div class="qa-sep">Bộ câu hỏi (thứ tự ưu tiên)</div>` + QBANKS.map((b, i) => `<button class="qa-mi${!ov && b.id === sel.id ? ' on' : ''}" data-act="qa-sel" data-id="${b.id}" title="${esc(b.when)}">
        <span class="qb-no">${i + 1}</span><span class="qa-mt">${b.icon} ${esc(b.title)}</span><span class="qa-mc">${qbank(b.id).length}</span>${isEd(b) ? '<span class="qa-dot" title="Đã sửa">✏️</span>' : ''}</button>`).join('');
    const o = QB[sel.id];
    const lines = qbank(sel.id);
    const idx = QBANKS.indexOf(sel) + 1;
    const pane = `<div class="qa-pane">
        <div class="qa-ph"><span class="qb-no big">${idx}</span><span class="qa-pic">${sel.icon}</span><div><h3>${esc(sel.title)}</h3>
          <span class="muted">Ưu tiên ${idx}/${QBANKS.length} · ${lines.length} câu · ${isEd(sel) ? `✏️ sửa bởi ${esc(o.by || '')} lúc ${new Date(o.at || 0).toLocaleString('vi-VN')}` : 'câu mặc định'}</span></div></div>
        <div class="qb-when"><b>📌 Khi nào dùng:</b> ${esc(sel.when)}</div>
        ${admin
          ? `<div class="qa-lbl">✏️ Các câu trong bộ <span class="muted">(${lines.length} câu · đang sửa câu nào thì hiện xem trước 👀 của câu đó)</span></div>
            <div class="qe" data-id="${sel.id}">
              <div class="qe-bar"><span class="qe-bl">Chèn biến:</span>${qVars(sel.id).map((v) => `<button class="qe-add" data-act="qv-add" data-v="${v}" title="${esc(QVARS[v].title)} – chèn vào vị trí con trỏ">${QVARS[v].icon} ${esc(QVARS[v].label)}</button>`).join('')}
                <span class="qe-tip">Bấm vào câu để sửa · bấm biến để đổi loại · Enter = thêm câu</span></div>
              <div class="qe-rows">${lines.map((t, k) => qeRow(t, k)).join('')}</div>
              <button class="qe-new" data-act="qb-row-add">＋ Thêm câu</button>
            </div>
            <div class="qb-btns"><span class="qe-dirty ok">💾 Tự lưu khi sửa – áp dụng mọi máy</span>${isEd(sel) ? `<button class="act" data-act="qb-reset" data-id="${sel.id}">↺ Về mặc định</button>` : ''}</div>`
          : ''}
        ${qaReview(sel)}
        ${admin ? '' : `<div class="qa-lbl">👀 Các câu (gọi NVKD là "em")</div><div class="qb-ex">${lines.map((t, k) => `<div><em>${k + 1}</em>${ex(t)}</div>`).join('')}</div>`}</div>`;
    return `<div class="qb-tab"><div class="qb-intro">💬 Thẻ bên phải trang báo giá xét các điều kiện <b>theo thứ tự 1 → ${QBANKS.length}</b>, khớp điều kiện nào trước thì dùng bộ câu đó; mỗi báo giá lấy 1 câu cố định, bấm <b>Gửi lại</b> thì đổi câu khác.</div>
      <div class="qa-wrap"><div class="qa-menu">${menu}</div>${ov ? qaOverview() : pane}</div></div>`;
  }

  // ---------- Tab "⚙️ Cài đặt": các thông số của extension (giống popup) ngay trên bảng ----------
  async function settingsTab(quotes, me) {
    const admin = isAdminUser(me);
    const [st, settingsRaw, cs, fc, collected] = await Promise.all([
      call({ type: 'status.get' }).catch(() => null),
      kvGet('settings'),
      kvGet('collectStatus'),
      kvGet('fullCollect'),
      kvGet('collected'),
    ]);
    const settings = { auto: true, autoOpen: false, ...settingsRaw };
    const agoMs = (ms) => (ms ? ago(Math.floor(ms / 1000)) : '–');
    const usd = (n) => `$${(n || 0).toFixed(2)}`;
    const sw = (key, on, title, sub) =>
      `<label class="st-sw"><span><b>${title}</b><br><span class="muted">${sub}</span></span><button class="st-tg${on ? ' on' : ''}" data-act="set-toggle" data-key="${key}"><i></i></button></label>`;
    const nQuotes = Object.keys(quotes).length;
    const nRead = Object.keys(collected || {}).length;
    let cTxt = `Đã thu thập ${nRead} báo giá`;
    if (cs?.running && Date.now() - cs.at < 120000)
      cTxt = /^danh sách|đơn hàng Misa/.test(cs.current || '') ? `Đang đọc ${esc(cs.current)}…` : `Đang đọc ${esc(cs.current || '')} (${cs.done}/${cs.total})…`;
    else if (cs?.lastRun) cTxt += ` · lần cuối ${agoMs(cs.lastRun)}: ${cs.done} báo giá`;
    const fTxt = fc?.on
      ? `Đang thu thập toàn bộ: ${fc.listDone ? `đã đọc danh sách (${nQuotes} báo giá)` : 'đang đọc các trang danh sách…'}${cs?.full && cs.remaining != null ? ` · còn ${cs.remaining} báo giá chưa đọc bình luận` : ''}`
      : fc?.doneAt
        ? `Đã thu thập toàn bộ xong lúc ${new Date(fc.doneAt).toLocaleString('vi-VN')} (${nQuotes} báo giá)`
        : 'Đọc tất cả báo giá + bình luận và đẩy lên máy chủ (chạy liên tục tới khi xong)';
    const sp = st?.spend;
    const pct = sp?.remaining != null && sp?.balance ? Math.max(0, Math.min(100, (sp.remaining / sp.balance) * 100)) : 0;
    const ss = st?.syncStatus || {};
    const scan = (await kvGet('scanLock')).main;
    const collectPct = nQuotes ? Math.round((nRead / nQuotes) * 100) : 0;
    const running = cs?.running && Date.now() - cs.at < 120000;
    const runPct = running && cs.total ? Math.round((cs.done / cs.total) * 100) : 0;
    const tile = (cls, ic, label, val, sub = '') =>
      `<div class="sx-tile ${cls}"><div class="sx-ic">${ic}</div><div class="sx-tv"><span>${label}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div></div>`;
    const swRow = (key, on, ic, title, sub) =>
      `<div class="sx-row"><div class="sx-ric">${ic}</div><div class="sx-rt"><b>${title}</b><span>${sub}</span></div><button class="st-tg${on ? ' on' : ''}" data-act="set-toggle" data-key="${key}"><i></i></button></div>`;
    const kv = (label, val, cls = '') => `<div class="sx-kv"><span>${label}</span><b class="${cls}">${val}</b></div>`;
    return `<div class="ctab wk stt sx">
      <div class="ct-head"><div><div class="ct-title">⚙️ Cài đặt & trạng thái</div><div class="ct-sub">Duyệt giá Tuấn Tú · phiên bản ${esc(st?.version || '?')}</div></div>
        <span class="sx-live${st?.status?.error ? ' err' : ''}"><i></i>${st?.status?.error ? 'Có lỗi' : 'Đang chạy'}</span></div>
      <div class="sx-tiles">
        ${admin && sp ? tile('t-day', '💳', 'Chi phí Claude hôm nay', usd(sp.today), `tháng này ${usd(sp.month)}`) : ''}
        ${admin && sp ? `<div class="sx-tile t-bal"><div class="sx-ring" style="--p:${pct}"><span>${Math.round(pct)}%</span></div><div class="sx-tv"><span>Số dư Anthropic còn lại</span><b class="${sp.remaining != null && sp.remaining < 5 ? 'bad' : ''}">${sp.remaining != null ? usd(sp.remaining) : 'chưa nhập'}</b><small>ước tính</small></div></div>` : ''}
        ${tile('t-read', '📚', 'Báo giá đã đọc', `${nRead.toLocaleString('vi-VN')}<em>/${nQuotes.toLocaleString('vi-VN')}</em>`, `${collectPct}% dữ liệu`)}
        ${tile('t-sync', '☁️', 'Đồng bộ', st?.syncEnabled ? 'Tự động' : 'Chưa bật', st ? `kéo về ${agoMs(ss.lastPull)}` : '')}
        ${tile('t-ver', '📦', 'Phiên bản script', esc(st?.version || '?'), st ? `commit ${esc((st.sha || '').slice(0, 7))} · tự cập nhật ~10 giây` : '')}
      </div>
      <div class="sx-cols">
        <div class="sx-card"><div class="sx-h"><span class="sx-hic violet">🔄</span><div><b>Tính năng trên CRM</b><span>Thu thập dữ liệu & tiện ích hiển thị</span></div></div>
          ${swRow('auto', settings.auto, '🛰️', 'Thu thập ngầm & tự phân tích', 'Tự đọc bình luận báo giá (không đánh dấu đã đọc), soạn gợi ý – chạy liên tục khi mở CRM')}
          <div class="sx-job${running ? ' run' : ''}"><div class="sx-jt"><span>${running ? '<span class="spinner"></span>' : '✅'} ${cTxt}</span><button class="sx-btn" data-act="set-collect-now">▶ Chạy ngay</button></div>
            ${running ? `<div class="sx-bar"><i style="width:${runPct}%"></i></div>` : ''}</div>
          <div class="sx-job${fc?.on ? ' run full' : ''}"><div class="sx-jt"><span>📦 ${fTxt}</span><button class="sx-btn ${fc?.on ? 'stop' : 'go'}" data-act="set-full">${fc?.on ? '⏹ Dừng' : '📦 Thu thập toàn bộ'}</button></div>
            <div class="sx-bar"><i style="width:${collectPct}%"></i></div><div class="sx-bt">${nRead.toLocaleString('vi-VN')} / ${nQuotes.toLocaleString('vi-VN')} báo giá · ${collectPct}%</div></div>
          ${swRow('autoOpen', settings.autoOpen, '🪟', 'Tự mở bảng khi vào báo giá', 'Vào trang báo giá là bảng đánh giá tự bung ra')}
          ${kv('🖥️ Máy đang quét ngầm', scan?.machine ? `${esc(scan.who || 'máy khác')} · ${agoMs(scan.beat)}` : '–')}</div>
        <div class="sx-stack">
          <div class="sx-card"><div class="sx-h"><span class="sx-hic sky">☁️</span><div><b>Đồng bộ giữa các máy</b><span>Supabase · tự chạy ngầm</span></div></div>
            ${st ? `<div class="sx-sync"><div class="sx-dot ${st.syncEnabled ? 'on' : ''}"></div><b>${st.syncEnabled ? 'Đang tự đồng bộ ngầm' : 'Chưa bật đồng bộ'}</b></div>
              <div class="sx-tl"><div><span>⬇️ Kéo về</span><b>${agoMs(ss.lastPull)}</b></div><div><span>⬆️ Đẩy lên</span><b>${agoMs(ss.lastPush)}</b></div></div>
              ${ss.error ? `<div class="err">Lỗi đồng bộ: ${esc(ss.error)}</div>` : ''}
              <div class="sx-note">Không cần bấm – dữ liệu tự đồng bộ. Chỉ dùng khi muốn đẩy lại toàn bộ.<button class="sx-btn" data-act="set-sync" ${state.busy.has('syncAll') ? 'disabled' : ''}>${state.busy.has('syncAll') ? 'Đang đồng bộ…' : '↻ Đồng bộ lại'}</button></div>`
              : '<div class="muted">Cần cài bản extension mới để xem.</div>'}</div>
          <div class="sx-card"><div class="sx-h"><span class="sx-hic green">📦</span><div><b>Phiên bản script</b><span>Tải từ GitHub, tự cập nhật</span></div></div>
            ${st ? `${kv('Phiên bản', `<span class="sx-ver">${esc(st.version)}</span>`)}${kv('Commit', `<code>${esc((st.sha || '').slice(0, 7))}</code>`)}${kv('Kiểm tra lần cuối', agoMs(st.status?.lastCheck))}${kv('Tự cập nhật', '~10 giây/lần', 'good')}
              ${st.status?.error ? `<div class="err">Lỗi: ${esc(st.status.error)}</div>` : ''}` : '<div class="muted">Cần cài bản extension mới để xem.</div>'}</div>
        </div>
      </div>
      ${admin ? await zipCard() : ''}
      ${admin ? `<div class="sx-perm">${await permsCard(quotes)}</div>` : ''}
      <div class="muted ct-note">🔐 Khoá API, Supabase, mật khẩu nhóm và số dư Anthropic nhập trong popup của extension (biểu tượng trên thanh Chrome).</div></div>`;
  }

  // ---------- Tab "💰 Công nợ": tổng quan công nợ từ trang /cong-no (quá hạn, sắp đến hạn, đã thu 30 ngày) ----------
  function debtTab(db, perm) {
    db = db || {};
    // Bỏ khách của NVKD không theo dõi (Đại Dương, Nguyễn Thăng Khôi, Trần Đình Hùng…)
    const list = (t) => (db[`list:${t}`]?.ids || []).map((id) => db[`cust:${id}`]).filter((r) => r && !isExcluded(r.staffName));
    let overdue = list('overdue');
    let upcoming = list('upcoming');
    // NVKD (không phải quản trị) chỉ xem công nợ khách của mình; quản trị lọc theo NVKD
    const staffSel = perm.admin ? lsGet('dgDebtStaff') || '' : meName;
    const mine = (r) => !staffSel || norm(r.staffName) === norm(staffSel);
    const allCust = new Map();
    [...overdue, ...upcoming].forEach((r) => allCust.set(r.customerId, r));
    const staffs = {};
    allCust.forEach((r) => {
      const k = r.staffName || 'Chưa rõ';
      (staffs[k] ||= { name: k, total: 0, over: 0, n: 0, nOver: 0 });
      staffs[k].total += r.totalDebt || 0;
      staffs[k].over += r.overdueAmount || 0;
      staffs[k].n++;
      if ((r.overdueAmount || 0) > 0) staffs[k].nOver++;
    });
    overdue = overdue.filter(mine).sort((a, b) => (b.overdueAmount || 0) - (a.overdueAmount || 0) || (b.maxDaysOverdue || 0) - (a.maxDaysOverdue || 0));
    upcoming = upcoming.filter(mine).sort((a, b) => (a.minDaysUntilDue ?? 999) - (b.minDaysUntilDue ?? 999));
    const custs = [...allCust.values()].filter(mine);
    const sum = (arr, k) => arr.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const totalDebt = sum(custs, 'totalDebt');
    const overAmt = sum(custs, 'overdueAmount');
    const notDue = sum(custs, 'notDueAmount');
    const soon7 = upcoming.filter((r) => (r.minDaysUntilDue ?? 99) <= 7);
    const ov = (db['ov:30']?.rows || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const collected30 = ov.reduce((a, r) => a + (Number(r.collected) || 0), 0);
    const expected30 = ov.reduce((a, r) => a + (Number(r.expected) || 0), 0);
    const updated = Math.max(db['list:overdue']?.at || 0, db['list:upcoming']?.at || 0, db['ov:30']?.at || 0);
    if (!updated)
      return `<div class="ctab wk debt"><div class="ct-head"><div><div class="ct-title">💰 Công nợ</div><div class="ct-sub">Chưa có dữ liệu – mở trang Công nợ của CRM (hoặc chờ thu thập ngầm) để extension đọc.</div></div></div></div>`;
    const dayCls = (d) => (d > 30 ? 'red' : d > 7 ? 'orange' : 'amber');
    const tile = (cls, ic, label, val, sub) => `<div class="sx-tile ${cls}"><div class="sx-ic">${ic}</div><div class="sx-tv"><span>${label}</span><b>${val}</b><small>${sub}</small></div></div>`;
    const maxBar = Math.max(...ov.map((r) => Math.max(Number(r.collected) || 0, Number(r.expected) || 0)), 1);
    const chart = ov.length
      ? `<div class="db-chart">${ov
          .map((r) => {
            const c = Number(r.collected) || 0;
            const e = Number(r.expected) || 0;
            const d = String(r.date || '').slice(5).split('-').reverse().join('/');
            return `<div class="db-col" title="${esc(d)} · đã thu ${money(c)}${e ? ` · dự kiến ${money(e)}` : ''}"><div class="db-bars"><i class="e" style="height:${Math.round((e / maxBar) * 100)}%"></i><i class="c" style="height:${Math.round((c / maxBar) * 100)}%"></i></div><span>${d}</span></div>`;
          })
          .join('')}</div><div class="db-leg"><span><i class="c"></i>Đã thu</span><span><i class="e"></i>Dự kiến thu</span></div>`
      : '<div class="muted">Chưa có số liệu thu theo ngày.</div>';
    // Gọn 1 dòng: tên khách + mã KH (hạn mức ngày nợ xem khi rê chuột); không hiện SĐT
    const custCell = (r) => `<td class="db-cust" title="${esc(r.customerName || '')}${r.customerCode ? ` (${esc(r.customerCode)})` : ''} · hạn mức ${r.allowDebtDay ?? '?'} ngày"><b>${esc(shortCompany(r.customerName || ''))}</b></td>`;
    const whoCell = (r) => `<td><span class="ct-who">${avatarHtml(r.staffName, 18)}${esc(shortName(r.staffName || ''))}</span></td>`;
    const DB_COLS = '<colgroup><col style="width:30px"><col><col style="width:84px"><col style="width:112px"><col style="width:112px"><col style="width:84px"></colgroup>';
    const overRows = overdue
      .map((r, i) => `<tr><td class="ct-no">${i + 1}</td>${custCell(r)}${whoCell(r)}<td class="num">${money(r.totalDebt)}</td><td class="num db-red">${money(r.overdueAmount)}</td>
        <td class="num"><span class="db-days ${dayCls(r.maxDaysOverdue || 0)}">${r.maxDaysOverdue || 0} ngày</span></td></tr>`)
      .join('');
    const upRows = upcoming
      .map((r, i) => `<tr><td class="ct-no">${i + 1}</td>${custCell(r)}${whoCell(r)}<td class="num">${money(r.totalDebt)}</td><td class="num db-green">${money(r.notDueAmount)}</td>
        <td class="num"><span class="db-due ${(r.minDaysUntilDue ?? 99) <= 7 ? 'soon' : ''}">còn ${r.minDaysUntilDue ?? '?'} ngày</span></td></tr>`)
      .join('');
    const staffRows = Object.values(staffs)
      .sort((a, b) => b.over - a.over || b.total - a.total)
      .map((x) => `<button class="db-staff${staffSel === x.name ? ' on' : ''}" ${perm.admin ? `data-act="debt-staff" data-staff="${esc(x.name)}"` : 'disabled'}>${avatarHtml(x.name, 22)}<span><b>${esc(shortName(x.name))}</b><small>${x.n} khách · nợ ${moneyShortG(x.total)}</small></span>${x.over ? `<em>quá hạn ${moneyShortG(x.over)}</em>` : '<em class="ok">✓ không quá hạn</em>'}</button>`)
      .join('');
    return `<div class="ctab wk debt${perm.admin ? '' : ' mine'}">
      <div class="ct-head"><div><div class="ct-title">💰 Báo cáo tổng quan công nợ${staffSel ? ` · ${esc(staffSel)}` : ''}</div>
        <div class="ct-sub">${custs.length} khách đang nợ · cập nhật ${ago(Math.floor(updated / 1000))} từ trang Công nợ của CRM</div></div>
        <span class="db-hbtns">${perm.admin && staffSel ? '<button class="sx-btn" data-act="debt-staff" data-staff="">✕ Xem tất cả NVKD</button>' : ''}
          <button class="rp-start" data-act="debt-print">🖨 In công nợ</button></span></div>
      <div class="sx-tiles">
        ${tile('t-read', '💼', 'Tổng công nợ', moneyShortG(totalDebt), `${custs.length} khách hàng`)}
        ${tile('t-red', '⏰', 'Quá hạn', moneyShortG(overAmt), `${overdue.length} khách · lâu nhất ${Math.max(0, ...overdue.map((r) => r.maxDaysOverdue || 0))} ngày`)}
        ${tile('t-ver', '📆', 'Đến hạn trong 7 ngày', moneyShortG(sum(soon7, 'notDueAmount')), `${soon7.length} khách`)}
        ${tile('t-sync', '🧾', 'Chưa đến hạn', moneyShortG(notDue), `${upcoming.length} khách`)}
        ${perm.admin ? tile('t-bal', '✅', 'Đã thu 30 ngày', moneyShortG(collected30), expected30 ? `dự kiến ${moneyShortG(expected30)}` : 'theo ngày') : ''}
      </div>
      ${perm.admin ? `<div class="db-wrap"><div class="sx-card"><div class="sx-h"><span class="sx-hic green">📈</span><div><b>Thu tiền 30 ngày</b><span>Đã thu và dự kiến thu theo ngày</span></div></div>${chart}</div>
        <div class="sx-card"><div class="sx-h"><span class="sx-hic violet">👥</span><div><b>Công nợ theo NVKD</b><span>Bấm để lọc</span></div></div><div class="db-staffs">${staffRows}</div></div></div>` : ''}
      <div class="db-two">
        <div class="sx-card db-over"><div class="sx-h"><span class="sx-hic red">⏰</span><div><b>Quá hạn <span class="hot-count">${overdue.length}</span></b><span>Xếp theo số tiền quá hạn – cần thu ngay</span></div></div>
          <div class="ct-wrap"><table class="ct">${DB_COLS}<thead><tr><th>#</th><th>Khách hàng</th><th>NVKD</th><th class="num">Tổng nợ</th><th class="num">Quá hạn</th><th class="num">Trễ</th></tr>
            ${overdue.length ? `<tr class="ct-sum"><td></td><td>Σ ${overdue.length} khách</td><td></td><td class="num">${money(sum(overdue, 'totalDebt'))}</td><td class="num db-red">${money(sum(overdue, 'overdueAmount'))}</td><td></td></tr>` : ''}</thead>
          <tbody>${overRows || '<tr><td colspan="6" class="muted">🎉 Không có khách quá hạn.</td></tr>'}</tbody></table></div></div>
        <div class="sx-card"><div class="sx-h"><span class="sx-hic sky">📆</span><div><b>Sắp đến hạn <span class="hot-count db-blue">${upcoming.length}</span></b><span>Xếp theo ngày đến hạn gần nhất – nhắc khách chuẩn bị</span></div></div>
          <div class="ct-wrap"><table class="ct">${DB_COLS}<thead><tr><th>#</th><th>Khách hàng</th><th>NVKD</th><th class="num">Tổng nợ</th><th class="num">Chưa đến hạn</th><th class="num">Đến hạn</th></tr>
            ${upcoming.length ? `<tr class="ct-sum"><td></td><td>Σ ${upcoming.length} khách</td><td></td><td class="num">${money(sum(upcoming, 'totalDebt'))}</td><td class="num db-green">${money(sum(upcoming, 'notDueAmount'))}</td><td></td></tr>` : ''}</thead>
          <tbody>${upRows || '<tr><td colspan="6" class="muted">Không có khoản sắp đến hạn.</td></tr>'}</tbody></table></div></div>
      </div></div>`;
  }

  // In công nợ: mỗi khách có tổng công nợ + quá hạn, nhóm theo từng NVKD (theo bộ lọc NVKD đang chọn; NVKD chỉ in của mình)
  function printDebts(db, perm) {
    db = db || {};
    const staffSel = perm.admin ? lsGet('dgDebtStaff') || '' : meName;
    const all = new Map();
    for (const t of ['overdue', 'upcoming']) (db[`list:${t}`]?.ids || []).forEach((id) => db[`cust:${id}`] && all.set(id, db[`cust:${id}`]));
    const custs = [...all.values()].filter((r) => !isExcluded(r.staffName) && (!staffSel || norm(r.staffName) === norm(staffSel)));
    if (!custs.length) {
      state.error = 'Chưa có dữ liệu công nợ để in.';
      return render();
    }
    const groups = {};
    custs.forEach((r) => (groups[r.staffName || 'Chưa rõ NVKD'] ||= []).push(r));
    const n = (v) => (Number(v) || 0).toLocaleString('vi-VN');
    const sum = (arr, k) => arr.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    // Cùng 1 bộ độ rộng cột cho mọi bảng → các cột thẳng hàng giữa các NVKD
    const DEBT_COLS = '<colgroup>' + [3, 10, 35, 10, 10, 6, 10, 8, 8].map((w) => `<col style="width:${w}%">`).join('') + '</colgroup>';
    const sections = Object.entries(groups)
      .sort((a, b) => sum(b[1], 'overdueAmount') - sum(a[1], 'overdueAmount') || sum(b[1], 'totalDebt') - sum(a[1], 'totalDebt'))
      .map(([staff, rows]) => {
        rows.sort((a, b) => (b.overdueAmount || 0) - (a.overdueAmount || 0) || (b.totalDebt || 0) - (a.totalDebt || 0));
        const body = rows
          .map((r, i) => `<tr><td class="c">${i + 1}</td><td>${esc(r.customerCode || '')}</td><td>${esc(shortCompany(r.customerName || ''))}</td>
            <td class="n">${n(r.totalDebt)}</td><td class="n ${r.overdueAmount ? 'od' : ''}">${r.overdueAmount ? n(r.overdueAmount) : '–'}</td>
            <td class="c">${r.maxDaysOverdue ? `${r.maxDaysOverdue} ngày` : ''}</td><td class="n nd">${r.notDueAmount ? n(r.notDueAmount) : '–'}</td>
            <td class="c">${r.minDaysUntilDue != null && r.notDueAmount ? `còn ${r.minDaysUntilDue} ngày` : ''}</td><td class="c">${r.allowDebtDay ?? ''}</td></tr>`)
          .join('');
        return `<h2>${esc(staff)} <small>${rows.length} khách · tổng nợ ${n(sum(rows, 'totalDebt'))}đ · quá hạn ${n(sum(rows, 'overdueAmount'))}đ</small></h2>
          <table>${DEBT_COLS}<thead><tr><th>#</th><th>Mã KH</th><th>Khách hàng</th><th>Tổng công nợ</th><th>Quá hạn</th><th>Trễ</th><th>Chưa đến hạn</th><th>Đến hạn</th><th>Hạn mức (ngày)</th></tr></thead>
          <tbody>${body}</tbody><tfoot><tr><td colspan="3">Cộng ${esc(staff)}</td><td class="n">${n(sum(rows, 'totalDebt'))}</td><td class="n od">${n(sum(rows, 'overdueAmount'))}</td><td></td><td class="n nd">${n(sum(rows, 'notDueAmount'))}</td><td colspan="2"></td></tr></tfoot></table>`;
      })
      .join('');
    const w = window.open('', '_blank');
    if (!w) return;
    const now = new Date();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Công nợ khách hàng${staffSel ? ` – ${esc(staffSel)}` : ''}</title><style>
      body{font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;margin:20px} h1{font-size:18px;margin:0} .s{color:#555;margin:4px 0 12px}
      h2{font-size:14px;margin:18px 0 6px;padding:6px 8px;background:#eef2ff;border-left:4px solid #4f46e5} h2 small{font-weight:500;color:#444;margin-left:6px}
      table{width:100%;border-collapse:collapse;margin-bottom:6px;table-layout:fixed} td{overflow-wrap:anywhere} th,td{border:1px solid #ccc;padding:4px 6px} th{background:#f1f5f9;text-align:left;white-space:nowrap}
      .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums} .c{text-align:center;white-space:nowrap} .od{color:#b91c1c;font-weight:700} .nd{color:#166534;font-weight:700}
      tfoot td{font-weight:800;background:#f8fafc} .tot{margin-top:14px;font-size:14px;font-weight:800} h2{break-after:avoid} tr{break-inside:avoid}
      @media print{body{margin:8mm}}</style></head><body>
      <h1>Báo cáo công nợ khách hàng${staffSel ? ` – ${esc(staffSel)}` : ''}</h1>
      <div class="s">${custs.length} khách đang nợ · in lúc ${now.toLocaleString('vi-VN')} · nguồn: trang Công nợ CRM</div>
      ${sections}
      <script>setTimeout(()=>print(),300)<\/script></body></html>`);
    w.document.close();
  }

  // ---------- Tab "Phân tích deal": AI đọc từng báo giá đang mở của 1 NVKD, gợi ý bước kế tiếp cho NVKD ----------
  // Lưu kv 'dealAi' (đồng bộ): khoá = tên NVKD (chuẩn hoá) → { at, items: [{ id, code, stage, health, missing, steps, say, risk }] }
  const DEAL_MAX = 25;
  const DEAL_SYSTEM = `Bạn là trưởng phòng kinh doanh của ${SITE.name} (bao bì giấy carton, in flexo / offset), đang KÈM CẶP 1 nhân viên kinh doanh (NVKD).
Đọc từng báo giá đang mở của NVKD (thông tin + luồng bình luận nội bộ giữa NVKD và quản lý) và với MỖI báo giá đưa ra:
- giai đoạn hiện tại của deal, - độ "khoẻ" của deal (khả năng chốt 0–100), - còn thiếu gì để chốt,
- 2–3 bước kế tiếp NVKD cần làm theo thứ tự (cụ thể, làm được ngay trong 1–2 ngày), - 1 câu NVKD có thể nhắn / nói với khách, - rủi ro lớn nhất (nếu có).
Giai đoạn chọn 1 trong: "Mới báo giá", "Chờ khách phản hồi", "Đàm phán giá", "Làm mẫu / duyệt maket", "Chờ cọc / hợp đồng", "Sắp lên đơn", "Nguội – cần chào lại".
THÔNG TIN NỘI BỘ (chỉ để bạn nắm, KHÔNG được nhắc lại nguyên văn hay mô tả tính cách sếp trong câu trả lời): sếp dễ tính, sẵn sàng đi gặp khách
trực tiếp cùng NVKD, và khi sếp đi cùng thì có thể hỗ trợ thêm về giá và công nợ.
→ Với deal LỚN (từ khoảng 100 triệu) hoặc đang vướng giá / công nợ / khách phân vân: lồng khéo vào các bước kế tiếp những HÀNH ĐỘNG cụ thể với sếp,
  ví dụ "Hẹn khách gặp trực tiếp thứ 5, rủ sếp đi cùng", "Báo sếp mức giá khách mong muốn để chốt phương án", "Đề xuất công nợ 30 ngày với sếp trước buổi gặp".
  Viết như lời nhắc việc tự nhiên, không giải thích lý do vì sao sếp hỗ trợ.
→ KHÁCH CŨ (đã lên đơn tổng hơn 50 triệu): KHÔNG gợi ý đi thăm xưởng / hẹn gặp khách cùng sếp nữa; chỉ gợi ý phối hợp với sếp về giá, điều kiện thanh toán để chốt nhanh.
Chỉ dựa trên dữ liệu được cung cấp, không bịa số liệu. Viết tiếng Việt tự nhiên, ngắn gọn, xưng hô với khách lịch sự (anh/chị).
Trả về DUY NHẤT một JSON array, mỗi phần tử:
{"code":"BGxxxxx","giai_doan":"...","suc_khoe":0-100,"con_thieu":["2–6 chữ mỗi mục"],"buoc_tiep":["bước 1","bước 2"],"cau_noi":"1 câu nhắn khách","rui_ro":"1 câu hoặc rỗng",
 "nho_sep":"1 câu cụ thể NVKD cần làm với sếp (book lịch sếp gặp khách / xin hỗ trợ giá / xin công nợ) – để rỗng nếu deal nhỏ và không vướng gì"}
Không markdown, không giải thích ngoài JSON.`;

  function dealList(staff, quotes, comments) {
    return Object.values(quotes)
      .filter((q) => q?.id && norm(q.staff?.name) === norm(staff) && q.quoteStatus && !CLOSED.has(q.quoteStatus) && !hasOrderFull(q, comments[q.id]))
      .filter((q) => q.createdAt && hoursSince(q.createdAt) <= 90 * 24)
      .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));
  }

  async function analyzeDeals(staff) {
    const key = `deal:${norm(staff)}`;
    if (state.busy.has(key)) return;
    setBusy(key, true);
    try {
      const [quotes, comments, orders] = await Promise.all([kvGet('quotes'), kvGet('comments'), kvGet('orders')]);
      const deals = dealList(staff, quotes, comments).slice(0, DEAL_MAX);
      if (!deals.length) throw new Error(`${staff} chưa có báo giá nào đang mở trong 90 ngày.`);
      const blocks = deals.map((q) => {
        const c = comments[q.id];
        const os = orderSummary(orders?.[q.customer?.id]);
        return [
          `### ${q.code} – "${q.name || ''}"`,
          `Khách: ${q.customer?.name || '?'} | Số tiền: ${noPrice(q) ? 'CHƯA CÓ GIÁ' : money(q.amount)} | Tình trạng CRM: ${statusLabel(q.quoteStatus)} | Tạo: ${fmtTime(q.createdAt)}${q.isReprint ? ' | Tái bản' : ''}${os ? ` | Khách đã mua ${os.count} đơn, tổng ${money(os.total)} (12 tháng: ${os.year} đơn)${os.total > 50e6 ? ' | KHÁCH CŨ' : ''}` : ' | Khách mới'}`,
          'Bình luận gần nhất:',
          compactThread(q, c),
        ].join('\n');
      });
      const out = await call({
        type: 'claude',
        system: DEAL_SYSTEM,
        prompt: `NVKD: ${staff}\nThời điểm hiện tại: ${fmtTime(Date.now() / 1000)}\n\n${blocks.join('\n\n')}`,
        maxTokens: 12000,
      });
      let items = [];
      try {
        items = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
      } catch {
        throw new Error('Claude trả về không đúng định dạng – bấm phân tích lại.');
      }
      const byCode = Object.fromEntries(deals.map((q) => [q.code, q]));
      items = items.filter((x) => x && byCode[x.code]).map((x) => ({
        id: byCode[x.code].id,
        code: x.code,
        stage: String(x.giai_doan || ''),
        health: Math.max(0, Math.min(100, Number(x.suc_khoe) || 0)),
        missing: (Array.isArray(x.con_thieu) ? x.con_thieu : []).map(String).filter(Boolean).slice(0, 6),
        steps: (Array.isArray(x.buoc_tiep) ? x.buoc_tiep : []).map(String).filter(Boolean).slice(0, 4),
        say: String(x.cau_noi || ''),
        risk: String(x.rui_ro || ''),
        boss: String(x.nho_sep || ''),
      }));
      await kvMerge('dealAi', { [norm(staff)]: { at: Date.now(), staff, items } });
    } catch (e) {
      state.error = e.message;
    } finally {
      setBusy(key, false);
    }
  }

  function dealTab(quotes, me, dealAi, hotData = null, hotDone = {}) {
    const admin = isAdminUser(me);
    const comments = renderCtx.comments || {};
    // Danh sách NVKD có deal đang mở (quản trị chọn; NVKD chỉ xem của mình)
    const counts = {};
    for (const q of Object.values(quotes)) {
      const st = q?.staff?.name;
      if (!st || isExcluded(st) || !q.quoteStatus || CLOSED.has(q.quoteStatus) || hasOrderFull(q, comments[q.id]) || !q.createdAt || hoursSince(q.createdAt) > 90 * 24) continue;
      counts[st] = (counts[st] || 0) + 1;
    }
    const staffs = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n]) => n);
    let staff = admin ? lsGet('dgDealStaff') || staffs[0] : meName;
    if (admin && !counts[staff]) staff = staffs[0];
    if (!staff) return '<div class="muted" style="margin:16px">Chưa có báo giá đang mở nào.</div>';
    const deals = dealList(staff, quotes, comments);
    const ai = (dealAi || {})[norm(staff)];
    const aiBy = Object.fromEntries((ai?.items || []).map((x) => [x.id, x]));
    const busy = state.busy.has(`deal:${norm(staff)}`);
    // Deal của NVKD này đang nằm trong "🔥 Gợi ý chốt đơn" → đưa lên đầu để ưu tiên chốt
    const hotBy = Object.fromEntries(
      (hotData?.items || [])
        .filter((x) => quotes[x.id] && norm(quotes[x.id].staff?.name) === norm(staff) && !hotDone[x.id] && !CLOSED.has(quotes[x.id].quoteStatus) && !hasOrderFull(quotes[x.id], comments[x.id]))
        .map((x) => [x.id, x]),
    );
    const hotList = Object.values(hotBy).sort((a, b) => b.pct - a.pct);
    // Deal lớn → gợi ý NVKD làm việc trực tiếp với sếp (sếp dễ tính, đi gặp khách được, hỗ trợ giá / công nợ khi đi cùng)
    const BIG = 100e6;
    // 1 câu kêu gọi hành động rõ ràng cho mỗi deal lớn (đổi câu theo deal, không nói thẳng "đặc tính của sếp")
    const CTA = [
      (k) => `Hẹn ${k} một buổi gặp trực tiếp trong tuần này và rủ sếp đi cùng để chốt luôn giá và điều kiện thanh toán.`,
      (k) => `Báo sếp mức giá ${k} mong muốn, rồi book lịch cùng sếp gặp khách để kéo đơn về.`,
      (k) => `Đặt lịch thăm xưởng ${k} cùng sếp, trao đổi trực tiếp giá và công nợ để khách yên tâm lên đơn.`,
    ];
    // Khách cũ đã lên đơn tổng hơn 50 triệu → không rủ sếp đi thăm xưởng / gặp khách nữa, chỉ phối hợp giá & điều kiện để chốt nhanh
    const OLD_CTA = [
      (k) => `${k} là khách quen – báo sếp mức giá khách mong muốn để có phương án tốt nhất, chốt nhanh đơn này.`,
      (k) => `Gọi ${k} xác nhận số lượng và ngày giao, cần hỗ trợ giá hoặc điều kiện thanh toán thì báo sếp duyệt ngay.`,
      (k) => `Khách quen ${k}: chốt lại giá cũ / giá ưu đãi với sếp rồi nhắn khách lên đơn luôn trong tuần.`,
    ];
    const boughtTotal = (q) => {
      const od = renderCtx.orders?.[q.customer?.id];
      return (od?.orders || []).reduce((a, o) => a + orderAfterVat(o), 0);
    };
    const isOldBig = (q) => boughtTotal(q) > 50e6;
    const bigCta = (q) =>
      (isOldBig(q) ? OLD_CTA : CTA)[Math.abs(Number(q.id) || 0) % CTA.length](shortCompany(q.customer?.name || '') || 'khách');
    const big = deals.filter((q) => (Number(q.amount) || 0) >= BIG).slice(0, 8);
    const bigBox = big.length
      ? `<div class="dl-big"><div class="dl-big-h"><span class="dl-bic">💼</span><b>Các deal có thể làm việc trực tiếp với sếp</b><span class="hot-count">${big.length}</span>
          <span class="hot-sum">💰 ${moneyShortG(big.reduce((a, q) => a + (Number(q.amount) || 0), 0))}</span></div>
        <div class="dl-big-list">${big
          .map((q) => {
            const a = aiBy[q.id];
            const last = lastComment(comments[q.id]);
            return `<div class="dl-big-item"><div class="dl-top"><a class="dl-code" href="/bao-gia/update/${q.id}" data-nav data-code="${esc(q.code)}">${esc(q.code)}</a>${custTag(q)}
                <span class="dl-name" title="${esc(q.name || '')}">${esc(q.name || '')}</span><span class="dl-amt big">${money(q.amount)}</span></div>
              <div class="dl-meta">${esc(shortCompany(q.customer?.name || ''))}${last ? ` · BL cuối ${ago(last.createdAt)}` : ' · chưa có bình luận'}${a?.stage ? ` · ${esc(a.stage)}` : ''}</div>
              <div class="dl-cta">👉 ${esc((!isOldBig(q) && a?.boss) || bigCta(q))}</div></div>`;
          })
          .join('')}</div></div>`
      : '';
    const hotBox2 = hotList.length
      ? `<div class="dl-hot"><div class="dl-hot-h"><span class="dl-fire">🔥</span><b>Ưu tiên chốt đơn ngay</b><span class="hot-count">${hotList.length}</span>
          <span class="hot-sum">💰 ${moneyShortG(hotList.reduce((a, x) => a + (Number(quotes[x.id]?.amount) || 0), 0))}</span>
          <span class="muted">– AI chọn từ tab Gợi ý chốt đơn, tập trung chốt các deal này trước</span></div>
        <div class="dl-hot-list">${hotList
          .map((x) => {
            const q = quotes[x.id];
            return `<div class="dl-hot-item"><a class="dl-code" href="/bao-gia/update/${q.id}" data-nav data-code="${esc(q.code)}">${esc(q.code)}</a>${custTag(q)}
              <span class="dl-name" title="${esc(q.name || '')}">${esc(q.name || '')}</span><span class="hot-pct ${x.pct >= 75 ? 'good' : x.pct >= 50 ? 'mid' : 'bad'}">${x.pct != null ? `${x.pct}%` : '📌'}</span>
              <span class="dl-amt">${q.amount ? money(q.amount) : ''}</span>
              <div class="dl-hot-body">💡 ${esc(x.why)}${x.missing?.length ? `<div class="hot-miss"><b>🧩 Còn thiếu:</b>${x.missing.map((m) => `<i>${esc(m)}</i>`).join('')}</div>` : ''}
                ${x.steps?.length ? `<div class="hot-steps">${x.steps.map((st, k) => `<span class="hot-step"><em>${k + 1}</em>${esc(st)}</span>`).join('')}</div>` : `<div class="hot-next">👉 ${esc(x.next)}</div>`}</div></div>`;
          })
          .join('')}</div></div>`
      : '';
    const pick = admin
      ? `<div class="fbar"><div class="fgroup"><span class="fname">Nhân viên</span><div class="fchips">${staffs
          .map((n) => `<button class="fchip staff${n === staff ? ' on' : ''}" data-act="deal-staff" data-staff="${esc(n)}">${avatarHtml(n, 16)}${esc(shortName(n))}<b>${counts[n]}</b></button>`)
          .join('')}</div></div></div>`
      : '';
    const stageCls = (st) => (/sắp lên đơn|cọc|hợp đồng/i.test(st) ? 'hot' : /mẫu|maket|đàm phán/i.test(st) ? 'warm' : /nguội/i.test(st) ? 'cold' : 'new');
    const hCls = (h) => (h >= 70 ? 'good' : h >= 40 ? 'mid' : 'bad');
    // Danh sách giống tab Báo giá; deal đã phân tích có thêm 1 dòng phụ (giai đoạn, sức khoẻ, còn thiếu, bước tiếp, làm việc với sếp)
    const rowsData = deals
      .map((q) => {
        const c = comments[q.id] || { id: q.id, code: q.code, threads: [] };
        return { q, c, last: lastComment(c), f: feasibility(q, c, renderCtx.orders), a: aiBy[q.id], badge: hotBy[q.id] ? '<span class="dl-hotbadge sm" title="Ưu tiên chốt (từ tab Gợi ý chốt đơn)">🔥 Ưu tiên</span>' : '' };
      })
      .sort((x, y) => !!hotBy[y.q.id] - !!hotBy[x.q.id] || (y.a?.health ?? -1) - (x.a?.health ?? -1) || (Number(y.q.amount) || 0) - (Number(x.q.amount) || 0));
    const sub = ({ q, a }) => {
      // Nhãn "🔥 Ưu tiên" nằm ngay trong dòng (cột Nhãn) – không thêm dòng phụ riêng
      if (!a) return '';
      return `<div class="dl-sub"><span class="dl-stage ${stageCls(a.stage)}">${esc(a.stage)}</span>
        <span class="dl-hmini ${hCls(a.health)}" title="Sức khoẻ deal">❤ ${a.health}%</span>
        ${a.missing.length ? `<span class="hot-miss">${a.missing.map((m) => `<i>${esc(m)}</i>`).join('')}</span>` : ''}
        ${a.steps.length ? `<span class="dl-step1">👉 ${esc(a.steps[0])}${a.steps.length > 1 ? ` <span class="muted">(+${a.steps.length - 1} bước)</span>` : ''}</span>` : ''}
        ${a.boss ? `<span class="dl-boss1">🤝 ${esc(a.boss)}</span>` : ''}
        ${a.say ? `<span class="dl-say1" title="${esc(a.say)}">💬 “${esc(a.say)}”</span>` : ''}</div>`;
    };
    const cards = `<div class="box unread dl-list">${renderCtx.plainRows(rowsData, sub)}</div>`;
    const dlAnim = state.dealAnimKey !== `${staff}:${ai?.at || 0}`; // hiệu ứng chỉ khi đổi NVKD / có kết quả mới
    state.dealAnimKey = `${staff}:${ai?.at || 0}`;
    return `<div class="ctab wk dl${dlAnim ? ' anim' : ''}">
      <div class="ct-head"><span class="ct-who">${avatarHtml(staff, 36)}<span><div class="ct-title">🧠 Phân tích deal · ${esc(staff)}</div>
        <div class="ct-sub">${deals.length} báo giá đang mở (90 ngày) · ${moneyShortG(deals.reduce((a, q) => a + (Number(q.amount) || 0), 0))}${ai ? ` · AI phân tích lúc ${new Date(ai.at).toLocaleString('vi-VN')}` : ' · chưa phân tích'}</div></span></span>
        <button class="rp-start cta" data-act="deal-run" data-staff="${esc(staff)}" ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner light"></span> AI đang đọc các deal…' : `🧠 ${ai ? 'Phân tích lại' : 'Phân tích deal'}`}<span class="cta-sub">AI đọc ${Math.min(deals.length, DEAL_MAX)} báo giá lớn nhất · gợi ý bước kế tiếp</span></button></div>
      ${pick}
      ${hotBox2}
      ${bigBox}
      <div class="dl-listwrap">${cards}</div></div>`;
  }

  // Claude trả về tối đa 10 báo giá có thể chốt NGAY + lý do + việc cần làm. Lưu kv 'aiHot' (đồng bộ).
  const HOT = { candidates: 80, show: 30 };
  const HOT_SYSTEM = `Bạn là trưởng phòng kinh doanh của ${SITE.name} (bao bì giấy carton). Quản lý có quá nhiều báo giá, cần biết báo giá nào CHỐT ĐƯỢC NGAY để tập trung.
Đọc từng báo giá (thông tin + luồng bình luận nội bộ giữa NVKD và quản lý) và chọn tối đa ${HOT.show} báo giá có khả năng chốt đơn cao nhất TRONG VÀI NGÀY TỚI.
Tín hiệu chốt mạnh: khách đã ok giá / đồng ý / hứa lên đơn / hẹn ngày đặt; khách cho giá mục tiêu và mình đã đáp ứng; chỉ còn vướng thủ tục (cọc, hợp đồng, duyệt mẫu, maket); khách quen, tái bản; mới trao đổi gần đây.
Tín hiệu yếu: khách chê giá cao chưa xử lý, im lặng lâu, khách đặt chỗ khác, chưa có giá, chỉ hỏi tham khảo.
Chỉ dựa trên dữ liệu được cung cấp, không bịa.
Trả về DUY NHẤT một JSON array, xếp từ khả năng cao xuống thấp, mỗi phần tử:
{"code":"BGxxxxx","kha_nang":0-100,"ly_do":"1 câu ngắn, nêu tín hiệu cụ thể trong bình luận",
 "con_thieu":["các điều kiện CÒN THIẾU để chốt, mỗi mục 2–6 chữ, vd: Khách chưa ok giá / Chưa có mẫu / Chưa duyệt maket / Chưa cọc / Chưa ký hợp đồng / Chưa có giá / Chưa xác nhận số lượng / Chưa hẹn ngày giao"],
 "buoc_tiep":["2–3 bước kế tiếp theo thứ tự, mỗi bước 1 câu ngắn ghi rõ AI làm (NVKD / sếp) và làm gì"],
 "viec_can_lam":"bước quan trọng nhất cần làm ngay (trùng bước 1)"}
Viết tiếng Việt, ngắn gọn. Không markdown, không giải thích ngoài JSON.`;

  function compactThread(q, c) {
    const all = [];
    const walk = (t) => {
      all.push(t);
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    const lines = all
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-8)
      .map((t) => `  [${fmtTime(t.createdAt)}] ${t.staff?.name || '?'}: ${(t.text || '').replace(/\s+/g, ' ').trim().slice(0, 300)}${t.file ? ' [ảnh/file]' : ''}`);
    return lines.length ? lines.join('\n') : '  (chưa có bình luận)';
  }

  async function analyzeHot() {
    if (state.busy.has('hot')) return;
    setBusy('hot', true);
    try {
      const [quotes, comments, orders] = await Promise.all([kvGet('quotes'), kvGet('comments'), kvGet('orders')]);
      const live = Object.fromEntries(Object.entries(quotes).filter(([, q]) => q?.quoteStatus !== 'REJECT'));
      const done = await kvGet('aiHotDone');
      let cands = feasibleList(live, comments, orders)
        .filter(({ q }) => !(done[q.id] && Date.now() - done[q.id].at < 7 * 86400e3)) // đã xử lý trong 7 ngày → không đưa vào lại
        .sort((a, b) => b.f.score - a.f.score)
        .slice(0, HOT.candidates);
      // Báo giá quản lý tự thêm vào gợi ý chốt đơn: luôn đưa cho AI xét (chưa lên đơn)
      const pin = await kvGet('hotPinned');
      const have = new Set(cands.map(({ q }) => q.id));
      const extra = Object.entries(pin)
        .filter(([id, v]) => v && !v.off && quotes[id] && !have.has(Number(id)) && !hasOrderFull(quotes[id], comments[id]) && !CLOSED.has(quotes[id].quoteStatus))
        .map(([id]) => {
          const q = quotes[id];
          const c = comments[id] || { id: q.id, code: q.code, threads: [] };
          return { q, c, last: lastComment(c), f: feasibility(q, c, orders) };
        });
      cands = [...extra, ...cands];
      const pinCodes = new Set(Object.entries(pin).filter(([id, v]) => v && !v.off && quotes[id]).map(([id]) => quotes[id].code));
      if (!cands.length) throw new Error('Chưa có báo giá khả thi nào để phân tích.');
      const blocks = cands.map(({ q, c, f }) => {
        const os = orderSummary(orders?.[q.customer?.id]);
        return [
          `### ${q.code} – "${q.name || ''}"${pinCodes.has(q.code) ? ' [📌 QUẢN LÝ CHỌN – bắt buộc có trong kết quả]' : ''}`,
          `Khách: ${q.customer?.name || '?'} | NVKD: ${staffOf(q, c) || '?'} | Số tiền: ${money(q.amount) || '?'} | Tình trạng: ${statusLabel(q.quoteStatus)} | Tạo: ${fmtTime(q.createdAt)}`,
          `Điểm khả thi (tự chấm): ${f.score} – ${f.reasons.join(', ') || '-'}${os ? ` | Khách đã mua ${os.count} đơn (12 tháng: ${os.year})` : ''}`,
          'Bình luận gần nhất:',
          compactThread(q, c),
        ].join('\n');
      });
      const out = await call({
        type: 'claude',
        system: HOT_SYSTEM,
        prompt: `Thời điểm hiện tại: ${fmtTime(Date.now() / 1000)}\n\n${blocks.join('\n\n')}`,
        maxTokens: 24000,
      });
      let items = [];
      try {
        items = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
      } catch {
        throw new Error('Claude trả về không đúng định dạng – bấm phân tích lại.');
      }
      const byCode = Object.fromEntries(cands.map(({ q }) => [q.code, q]));
      items = items.filter((x) => x && byCode[x.code]).slice(0, HOT.show).map((x) => ({
        id: byCode[x.code].id,
        code: x.code,
        pct: Math.max(0, Math.min(100, Number(x.kha_nang) || 0)),
        why: String(x.ly_do || ''),
        next: String(x.viec_can_lam || ''),
        missing: (Array.isArray(x.con_thieu) ? x.con_thieu : []).map(String).filter(Boolean).slice(0, 6),
        steps: (Array.isArray(x.buoc_tiep) ? x.buoc_tiep : []).map(String).filter(Boolean).slice(0, 4),
      }));
      await kvMerge('aiHot', { latest: { at: Date.now(), items, from: cands.length, show: HOT.show } });
      state.hotOpen = true;
    } catch (e) {
      state.error = e.message;
    } finally {
      setBusy('hot', false);
    }
  }

  // Tự phân tích mỗi sáng: từ 7h (giờ VN), nếu kết quả mới nhất có trước 7h hôm nay thì chạy 1 lần.
  // Kết quả đồng bộ giữa các máy nên máy nào mở CRM trước sẽ chạy; khoá ngắn để 2 tab không chạy cùng lúc.
  const HOT_MORNING_HOUR = 7;
  const HOT_MIN = 5;
  function morningStart() {
    const vn = new Date(Date.now() + 7 * 3600e3); // giờ VN dạng UTC
    const start = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), HOT_MORNING_HOUR) - 7 * 3600e3;
    return Date.now() >= start ? start : null; // chưa tới 7h sáng thì chưa chạy
  }
  async function maybeMorningHot() {
    const start = morningStart();
    if (!start || state.busy.has('hot') || !(await getSettings()).auto) return;
    const hot = (await kvGet('aiHot')).latest;
    // Còn dưới 5 deal chưa xử lý → tự phân tích lại (tối đa 30 phút/lần, chỉ máy đang quét chạy)
    let low = false;
    if (hot?.at >= start) {
      const [quotes, comments, done] = await Promise.all([kvGet('quotes'), kvGet('comments'), kvGet('aiHotDone')]);
      const left = (hot.items || []).filter((x) => quotes[x.id] && !CLOSED.has(quotes[x.id].quoteStatus) && !hasOrderFull(quotes[x.id], comments[x.id]) && !done[x.id]).length;
      // Kết quả cũ phân tích với số deal khác (vd. 10 → 30) cũng chạy lại
      low = (left < HOT_MIN || hot.show !== HOT.show) && Date.now() - hot.at > 30 * 60e3 && !(await otherMachineScanning());
      if (!low) return;
    }
    const lock = await kvGet('hotLock');
    if (lock?.at && Date.now() - lock.at < 10 * 60e3 && lock.tab !== TAB_ID) return;
    await call({ type: 'kv.set', key: 'hotLock', value: { tab: TAB_ID, at: Date.now() } });
    await analyzeHot();
    render();
  }
  if (IS_TOP) {
    setTimeout(() => maybeMorningHot().catch((e) => console.warn('[DG] hot', e)), 45000); // đợi dữ liệu tải xong
    setInterval(() => maybeMorningHot().catch((e) => console.warn('[DG] hot', e)), 5 * 60e3);
  }

  // ---------- Giá giấy tấm 0đ/m2 trên trang chi tiết báo giá → nhãn "Chưa có giá giấy tấm" ----------
  // Đọc ô "x/m2" dưới cột Ngày update của bảng sản phẩm (cả trang đang mở lẫn khung thu thập ngầm).
  let sheetSaved = '';
  async function scanSheetPrice() {
    const qid = currentQuoteId();
    if (!qid) return;
    // chỉ trong bảng Hàng hóa (bình luận cũ có thể chứa "0/m2" → không tính)
    const tbl = pageProductTable();
    if (!tbl) return;
    const cells = [...tbl.querySelectorAll('tbody span, tbody div, tbody td')].filter((e) => !e.children.length && /\/\s*m2$/i.test(e.textContent.trim()));
    if (!cells.length) return; // bảng sản phẩm chưa tải
    const zero = cells.filter((e) => /^0\s*(đ|vnđ|vnd)?\s*\/\s*m2$/i.test(e.textContent.trim().replace(/\s+/g, ' '))).length;
    const key = `${qid}:${zero}`;
    if (key === sheetSaved) return;
    const old = (await kvGet('quotes'))[qid];
    sheetSaved = key;
    if (!old || (!!old.noSheet === zero > 0 && old.noSheetN === zero)) return;
    await kvMerge('quotes', { [qid]: { ...old, noSheet: zero > 0, noSheetN: zero, noSheetAt: Math.floor(Date.now() / 1000) } });
  }
  setInterval(() => scanSheetPrice().catch(() => {}), 1500);

  // Trang chi tiết có dòng "Mã đơn hàng Misa: 12526 | … - DH0012113" → báo giá đã lên đơn (ẩn khỏi danh sách)
  let orderSaved = '';
  async function scanMisaOrder() {
    const qid = currentQuoteId();
    if (!qid || orderSaved === String(qid)) return;
    const lbl = [...document.querySelectorAll('span, div, b, strong, label')].find((e) => /^Mã đơn hàng Misa:?$/i.test(e.textContent.trim()));
    if (!lbl) return;
    const line = (lbl.parentElement?.textContent || '').replace(/\s+/g, ' ');
    const code = line.match(/DH\d{4,}/)?.[0] || line.match(/Misa:?\s*(\d{3,})/i)?.[1];
    if (!code) return;
    orderSaved = String(qid);
    const old = (await kvGet('quotes'))[qid];
    if (!old || (old.hasOrder && old.orderCode === code)) return;
    await kvMerge('quotes', { [qid]: { ...old, hasOrder: true, orderCode: code, orderSeenAt: Math.floor(Date.now() / 1000) } });
    if (IS_TOP) render();
  }
  setInterval(() => scanMisaOrder().catch(() => {}), 1500);

  // ---------- Thanh kéo "% Deal" trên trang báo giá: nhắc đơn hàng đang yếu, chỉ kéo tối đa 20–25% ----------
  const DEAL_PCT_MAX = 25;
  function dealSliderHint() {
    if (!IS_TOP || !currentQuoteId()) return;
    if (!MY_ADMIN) return document.getElementById('dg-deal-hint')?.remove(); // chỉ quản trị thấy
    const lbl = [...document.querySelectorAll('label, span, div')].find((e) => !e.children.length && /^%\s*Deal$/i.test(e.textContent.trim()));
    const row = lbl?.closest('.ant-row, .ant-form-item') || lbl?.parentElement;
    const slider = row?.querySelector('.ant-slider') || lbl?.parentElement?.parentElement?.querySelector('.ant-slider');
    if (!slider) return;
    const v = Number(slider.querySelector('.ant-slider-handle')?.getAttribute('aria-valuenow'));
    let box = document.getElementById('dg-deal-hint');
    if (!box || !row.contains(box)) {
      box?.remove();
      box = document.createElement('div');
      box.id = 'dg-deal-hint';
      (row || slider.parentElement).append(box);
    }
    const over = Number.isFinite(v) && v > DEAL_PCT_MAX;
    const html = over
      ? `⛔ <b>Đang kéo ${v}%</b> – đơn hàng đang yếu, chỉ kéo tối đa <b>20–${DEAL_PCT_MAX}%</b>. Kéo lại về ≤ ${DEAL_PCT_MAX}% nhé.`
      : `⚠️ Đơn hàng đang yếu – chỉ kéo <b>% Deal</b> tối đa <b>20–${DEAL_PCT_MAX}%</b>${Number.isFinite(v) ? ` (đang ${v}%)` : ''}.`;
    if (box.innerHTML !== html) box.innerHTML = html;
    box.style.cssText = `margin:6px 0 4px;padding:6px 12px;border-radius:8px;font-size:13px;font-weight:600;width:max-content;max-width:100%;${over
      ? 'background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;animation:dgDealShake .5s ease-in-out 2'
      : 'background:#fff7ed;color:#9a3412;border:1px solid #fed7aa'}`;
    if (!document.getElementById('dg-deal-css')) {
      const st = document.createElement('style');
      st.id = 'dg-deal-css';
      st.textContent = '@keyframes dgDealShake{0%,100%{transform:none}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}';
      document.head.append(st);
    }
  }
  setInterval(() => {
    try {
      dealSliderHint();
    } catch {}
  }, 500);

  function hotBox(hot, quotes, done = {}, inTab = false) {
    const busy = state.busy.has('hot');
    // Dòng đã bấm ✓ hoàn thành (ở bất kỳ máy nào – kv 'aiHotDone' đồng bộ) thì ẩn
    // Ẩn: đã chốt / thất bại, đã lên đơn (CRM ghi "lên đơn hàng", mã đơn Misa, hoặc có trong lịch sử mua hàng của khách), đã bấm ✓
    // Báo giá quản lý tự thêm (kv 'hotPinned', đồng bộ): luôn có trong danh sách tới khi lên đơn; AI không chọn thì vẫn hiện (📌)
    const pinned = Object.entries(renderCtx.hotPinned || {}).filter(([, v]) => v && !v.off).map(([id, v]) => ({ id: Number(id), code: v.code }));
    const pinIds = new Set(pinned.map((p) => p.id));
    const aiIds = new Set((hot?.items || []).map((x) => x.id));
    const merged = [
      ...(hot?.items || []).map((x) => (pinIds.has(x.id) ? { ...x, pinned: true } : x)),
      ...pinned
        .filter((p) => !aiIds.has(p.id))
        .map((p) => ({ id: p.id, code: p.code, pct: null, why: '📌 Quản lý thêm vào gợi ý chốt đơn – AI đánh giá ở lần phân tích sau', next: 'Theo dõi sát và kéo đơn về', missing: [], steps: [], pinned: true })),
    ];
    const items = merged.filter(
      (x) => quotes[x.id] && !CLOSED.has(quotes[x.id].quoteStatus) && !hasOrderFull(quotes[x.id], renderCtx.comments?.[x.id]) && (x.pinned || !done[x.id]) && !cancelInfo(renderCtx.comments?.[x.id]),
    );
    const doneN = (hot?.items || []).filter((x) => done[x.id]).length;
    const hotSum = items.reduce((a, x) => a + (Number(quotes[x.id]?.amount) || 0), 0); // tổng tiền các báo giá đang gợi ý
    // Tổng chênh lệch (Flexo: BG − giấy tấm · Offset: Σ giá × SL × đang bán %) của các deal đã tính được
    const diffs = items.map((x) => diffVal(quotes[x.id])).filter((v) => v != null);
    const noSheetN = items.filter((x) => quotes[x.id]?.noSheet).length;
    const diffSum = diffs.reduce((a, v) => a + v, 0);
    const diffTag = diffs.length
      ? `<span class="hot-diff" title="Tổng chênh lệch của ${diffs.length}/${items.length} deal đã tính được: ${money(Math.round(diffSum))}${noSheetN ? ` · không cộng ${noSheetN} deal chưa có giá giấy tấm` : ''}">📈 Chênh lệch ${Math.abs(diffSum) >= 1e9 ? `${(diffSum / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ` : trM(diffSum)}</span>`
      : '';
    // Tin nhắn tóm tắt gửi nhóm: gom theo NVKD (thứ tự theo deal xếp hạng cao nhất của mỗi người)
    const byStaff = new Map();
    for (const x of items) {
      const q = quotes[x.id];
      const who = staffOf(q, renderCtx.comments?.[x.id]) || 'Chưa rõ NVKD';
      if (!byStaff.has(who)) byStaff.set(who, []);
      byStaff.get(who).push({ id: q.id, code: q.code, cust: q.customer?.code || '', rest: ` ${(q.name || '').replace(/\s+/g, ' ').trim()} = `, val: q.amount ? money(q.amount) : 'chưa cho giá' });
    }
    const head = 'Các bạn xem lại các deal này và kéo đơn về';
    const groups = [...byStaff];
    state.hotCopy = items.length ? [head, ...groups.map(([who, ls]) => `\n${who}\n${ls.map((l) => `. ${l.code}${l.cust ? ` (${l.cust})` : ''}${l.rest}${l.val}`).join('\n')}`)].join('\n') : '';
    // Bản có định dạng (dán vào Telegram / Zalo / email): số báo giá in đậm
    state.hotCopyHtml = items.length
      ? `<div>${esc(head)}</div>${groups.map(([who, ls]) => `<div><br></div><div><b>${esc(who)}</b></div>${ls.map((l) => `<div>. <b>${esc(l.code)}</b>${l.cust ? ` (<b>${esc(l.cust)}</b>)` : ''}${esc(l.rest)}<b style="color:#15803d"><font color="#15803d">${esc(l.val)}</font></b></div>`).join('')}`).join('')}`
      : '';
    // Hỏi NVKD qua Zalo: MỖI TIN 1 DEAL – câu hỏi thăm + dòng deal
    state.hotZalo = {}; // who → [{ id, text, html }]
    for (const [who, ls] of groups) {
      if (who === 'Chưa rõ NVKD') continue;
      const p = addressFor(who, renderCtx.comments, quotes);
      state.hotZalo[who] = ls.map((l) => {
        const sent = Object.values(renderCtx.zaloJobs || {}).filter((j) => j?.qid === l.id).length;
        const ask = selfFix(fillP(pickFor(qbank('zalo'), l.id, sent), p), p);
        const line = `. ${l.code}${l.cust ? ` (${l.cust})` : ''}${l.rest}${l.val}`;
        return {
          id: l.id,
          code: l.code,
          text: `${ask}\n${line}`,
          html: `<div>${esc(ask)}</div><div>. <b>${esc(l.code)}</b>${l.cust ? ` (<b>${esc(l.cust)}</b>)` : ''}${esc(l.rest)}<b><span style="color:#15803d;font-weight:bold">${esc(l.val)}</span></b></div>`,
        };
      });
    }
    const zJobs = Object.values(renderCtx.zaloJobs || {});
    const zLast = (f) => zJobs.filter(f).sort((a, b) => b.at - a.at)[0];
    const zState = (who) => zLast((j) => j?.to === who);
    const zDeal = (id) => zLast((j) => j?.qid === id);
    const zSent = renderCtx.zaloSent || {};
    // Mỗi NVKD: 1 tin / 30 phút (tính cả tin đang chờ gửi) → còn bao nhiêu phút mới được soạn tin mới
    const zWait = (who) => zaloWaitMin(who, zSent, zJobs);
    const zaloBar = inTab && groups.length
      ? `<div class="zl-bar"><b>💬 Hỏi NVKD qua Zalo:</b>${groups
          .filter(([who]) => state.hotZalo[who])
          .map(([who, ls]) => {
            const j = zState(who);
            const left = ls.filter((l) => !zSent[l.id]).length; // deal chưa hỏi
            const wait = zWait(who);
            const st = wait ? ' wait' : !left ? ' sent' : j?.status === 'error' ? ' err' : '';
            const tip = wait ? `Đã nhắn ${who} – chờ ${wait} phút nữa mới soạn tin mới (mỗi người 1 tin / 30 phút)`
              : !left ? `Đã hỏi hết ${ls.length} deal của ${who}`
              : j?.status === 'error' ? `Lỗi lần trước: ${j.error} – bấm để thử lại`
              : `Mở Zalo, tìm "${renderCtx.zaloNames?.[norm(who)]?.name || who}" và hỏi 1 deal chưa hỏi (còn ${left}/${ls.length})`;
            const icon = wait ? '⏱' : !left ? '✅' : j?.status === 'error' ? '⚠️' : '📨';
            return `<span class="zl-item"><button class="zl-btn${st}" data-act="zalo-send" data-who="${esc(who)}" title="${esc(tip)}" ${wait || !left ? 'disabled' : ''}>${icon} ${esc(shortName(who))} <i>${wait ? `${wait}′` : `${left}/${ls.length}`}</i></button>${j?.status === 'error' ? `<button class="zl-fix" data-act="zalo-name" data-who="${esc(who)}" title="Đặt tên Zalo của ${esc(who)} (tên hiển thị trong danh bạ Zalo)">✏️ Tên Zalo</button>` : ''}</span>`;
          })
          .join('')}<button class="zl-btn all" data-act="zalo-send" data-who="*" title="Mỗi NVKD (không trong 30 phút chờ) được hỏi 1 deal chưa hỏi">📨 Gửi mỗi người 1 deal</button>
          <button class="zl-draft${lsGet('dgZaloDraft') !== '0' ? ' on' : ''}" data-act="zalo-draft" title="Bật: chỉ soạn sẵn tin trong ô chat Zalo, anh tự bấm gửi · Tắt: tự bấm gửi luôn">${lsGet('dgZaloDraft') !== '0' ? '📝 Chỉ soạn, chưa gửi' : '🚀 Tự gửi luôn'}</button>
          <span class="muted">Mỗi deal chỉ hỏi 1 lần · mỗi NVKD 1 tin / 30 phút. Bấm 💬 ở từng dòng để chọn deal muốn hỏi.</span></div>`
      : '';
    const copyBtn = items.length ? `<button class="act hot-copy" data-act="hot-copy" title="Copy tin nhắn tóm tắt (gom theo nhân viên) để dán vào nhóm Zalo">📋 Copy tin nhắn</button>` : '';
    const btn = `<button class="act hero hot-btn" data-act="hot-run" ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner light"></span> AI đang đọc các báo giá…' : hot ? '🔄 Phân tích lại' : '🔥 AI chọn đơn chốt được liền'}</button>`;
    const rows = items
      .map((x, i) => {
        const q = quotes[x.id];
        const cls = x.pct >= 75 ? 'good' : x.pct >= 50 ? 'mid' : 'bad';
        return `<a class="hot-item" href="/bao-gia/update/${x.id}" data-nav data-code="${esc(x.code)}">
          <button class="hot-done" data-act="hot-done" data-id="${x.id}" title="Đánh dấu đã xử lý xong – ẩn khỏi danh sách trên mọi máy">✓</button>
          <span class="hot-no">${i + 1}</span>
          <span class="hot-main"><span class="hot-top"><b>${esc(x.code)}</b>${custTag(q)}<span class="hot-name">${esc(q.name || '')}</span></span>
            <span class="hot-why" title="${esc(x.why)}">💡 ${esc(x.why)}</span>
            <span class="hot-line">${x.missing?.length ? `<span class="hot-mini">${x.missing.map((m) => `<i>${esc(m)}</i>`).join('')}</span>` : ''}${x.steps?.length
              ? `<span class="hot-flow" title="${esc(x.steps.map((st, k) => `${k + 1}. ${st}`).join('\n'))}">👉 ${x.steps.map((st, k) => `<em>${k + 1}</em>${esc(st)}`).join('<span class="hot-arr">›</span>')}</span>`
              : `<span class="hot-flow">👉 ${esc(x.next)}</span>`}</span></span>
          ${inTab ? (() => {
            const who = staffOf(q, renderCtx.comments?.[x.id]);
            const j = zDeal(x.id);
            const sent = zSent[x.id];
            const wait = who ? zWait(who) : 0;
            const run = j && (j.status === 'pending' || j.status === 'sending');
            const ic = sent ? (sent.drafted ? '📝' : '✅') : run ? '⏳' : wait ? '⏱' : j?.status === 'error' ? '⚠️' : '💬';
            const tip = sent ? `${sent.drafted ? 'Đã soạn sẵn trong Zalo' : 'Đã hỏi qua Zalo'} lúc ${new Date(sent.at).toLocaleString('vi-VN')} – mỗi deal chỉ hỏi 1 lần`
              : run ? 'Đang gửi…' : wait ? `Đã nhắn ${who} – chờ ${wait} phút nữa (mỗi người 1 tin / 30 phút)`
              : j?.status === 'error' ? `Lỗi: ${j.error} – bấm để thử lại` : `Hỏi ${who || 'NVKD'} deal này qua Zalo`;
            return who ? `<button class="zl-one${sent ? ' done' : wait ? ' wait' : ''}" data-act="zalo-send" data-who="${esc(who)}" data-qid="${x.id}" title="${esc(tip)}" ${sent || run || wait ? 'disabled' : ''}>${ic}</button>` : '';
          })() : ''}
          <span class="hot-side"><span class="hot-r1"><span class="hot-pct ${cls}">${x.pct != null ? `${x.pct}%` : '📌'}</span><span class="hot-amt">${q.amount ? money(q.amount) : ''}</span></span><span class="hot-r2">${(() => { const v = diffVal(q); return v != null ? `<span class="hot-dv${v < 0 ? ' neg' : ''}" title="Chênh lệch">📈 ${v < 0 ? '−' : ''}${trM(Math.abs(v))}</span>` : q.noSheet ? '<span class="hot-dv neg">😡 Chưa có giá GT</span>' : ''; })()}<span class="hot-who">${esc(shortName(staffOf(q, renderCtx.comments[q.id])) || '')}</span></span></span></a>`;
      })
      .join('');
    const collapsed = !inTab && lsGet('dgHotCollapsed') === '1';
    const toggle = inTab ? '' : `<button class="hot-toggle" data-act="hot-toggle" title="${collapsed ? 'Mở rộng' : 'Thu gọn'}">${collapsed ? '▸' : '▾'}</button>`;
    if (collapsed)
      return `<div class="hotbox collapsed${items.length ? ' has-data' : ''}"><div class="hot-head"><h3>${toggle}<span class="hot-fire">🔥</span> Có thể chốt liền <span class="hot-count">${items.length}</span>${hotSum ? `<span class="hot-sum" title="Tổng giá trị các báo giá có thể chốt liền">💰 ${moneyShortG(hotSum)}</span>` : ''}${diffTag}${items.length ? '<span class="hot-hint">bấm ▸ để xem</span>' : ''}</h3>${btn}</div></div>`;
    return `<div class="hotbox">
      <div class="hot-head"><h3>${toggle}🔥 Có thể chốt liền <span class="hot-count">${items.length}</span>${hotSum ? `<span class="hot-sum" title="Tổng giá trị các báo giá có thể chốt liền">💰 ${moneyShortG(hotSum)}</span>` : ''}${diffTag} <span class="muted">– AI đọc ${hot?.from || HOT.candidates} báo giá khả thi điểm cao nhất, chọn ra tối đa ${HOT.show} đơn nên ưu tiên</span></h3><span class="hot-btns">${copyBtn}${btn}</span></div>
      ${hot ? `<div class="muted">Phân tích lúc ${new Date(hot.at).toLocaleString('vi-VN')}${doneN ? ` · ✓ đã xong ${doneN} đơn` : ''} · tự phân tích lại mỗi sáng từ ${HOT_MORNING_HOUR}h</div>` : `<div class="muted">Tự phân tích mỗi sáng từ ${HOT_MORNING_HOUR}h khi mở CRM, hoặc bấm nút để chạy ngay (mỗi lần 1 lượt gọi Claude).</div>`}
      ${zaloBar}
      ${rows ? `<div class="hot-list">${rows}</div>` : hot ? '<div class="muted">AI chưa thấy báo giá nào chốt được ngay.</div>' : ''}
    </div>`;
  }

  // Thẻ bàn giao (hiện trong thẻ bên phải). Báo giá đang mở là nơi gửi → đưa lên đầu, nút gửi ngay.
  function handoverBox(list, quotes) {
    if (!list.length) return '';
    const rows = list
      .map((h) => ({ h, ...handoverTarget(h, quotes) }))
      .sort((a, b) => (b.q && currentQuoteId() === b.q.id) - (a.q && currentQuoteId() === a.q.id));
    const items = rows.map(({ h, q, from }) => {
      const key = esc(h.key);
      const text = state.handoverDraft[h.key] ?? handoverText(h, from);
      const here = q && currentQuoteId() === q.id;
      const busy = state.busy.has(`handover:${h.key}`);
      const skip = `<button class="ho-skip" data-act="handover-skip" data-key="${key}" title="Không gửi, ẩn bàn giao này trên mọi máy">Bỏ qua</button>`;
      const head = `<div class="ho-cust" title="${esc(h.customer)}">${esc(shortCompany(h.customer))}</div>
        <div class="ho-flow"><span class="ho-from">${esc(from || '?')}</span><span class="ho-arrow">→</span><span class="ho-to">${esc(h.to)}</span></div>
        <div class="ho-meta">${esc(h.by)} bàn giao${h.at ? ` · ${fmtTime(h.at)}` : ''}${q ? ` · báo giá gần nhất <b>${esc(q.code)}</b>` : ''}</div>`;
      if (!q) return `<div class="ho-card">${head}<div class="ho-meta warnx">Chưa thấy báo giá nào của khách này – mở trang Báo giá để extension ghi nhận.</div><div class="ho-btns">${skip}</div></div>`;
      return `<div class="ho-card${here ? ' here' : ''}">${head}
        <textarea class="handover-edit ho-text" data-key="${key}" rows="3">${esc(text)}</textarea>
        <div class="ho-btns">${here
          ? `<button class="ho-send" data-act="handover-send" data-key="${key}" data-code="${esc(q.code)}" ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner light"></span> Đang gửi…' : `📨 Gửi vào ${esc(q.code)}`}</button>`
          : `<a class="ho-open" data-nav data-keep href="/co-hoi/update/${q.id}" data-code="${esc(q.code)}">↗ Mở ${esc(q.code)} để gửi</a>`}
          ${skip}</div></div>`;
    });
    return `<div class="ho"><div class="side-sec">🔁 Bàn giao khách hàng · ${list.length}</div>${items.join('')}</div>`;
  }

  // Bấm 1 bình luận trong "Bình luận mới nhất" → đánh dấu đã đọc (lưu kho, đồng bộ)
  const pushReadToCrm = (id) => document.dispatchEvent(new CustomEvent('dg:notifRead', { detail: String(id) })); // hook.js gửi lệnh của CRM
  async function markNotifRead(key) {
    const n = (await kvGet('notifs'))[key];
    if (!n) return;
    if (!n.crmRead) pushReadToCrm(n.id);
    if (n.readLocal) return;
    const at = Math.floor(Date.now() / 1000);
    await kvMerge('notifRead', { [key]: { at } });
    await kvMerge('notifs', { [key]: { ...n, read: true, readLocal: true, readAt: at } });
  }
  // Đã đọc trong bảng nhưng chưa lên CRM (vd. trước khi extension học được lệnh) → gửi bù, mỗi dòng tối đa 1 lần / 10 phút
  const crmTried = {};
  function syncPendingReads(notifs, who) {
    if (!lsGet('dgNotifReadTpl')) return;
    Object.values(notifs || {})
      .filter((n) => n.owner === who && n.readLocal && !n.crmRead && Date.now() - (crmTried[n.id] || 0) > 600000)
      .slice(0, 10)
      .forEach((n) => {
        crmTried[n.id] = Date.now();
        pushReadToCrm(n.id);
      });
  }

  function exportList() {
    const rows = state.exportRows || [];
    if (!rows.length) {
      state.error = 'Danh sách đang trống – không có gì để xuất.';
      return render();
    }
    const head = ['#', 'Ngày tạo', 'Mã BG', 'Nhãn', 'Mã KH', 'Tên khách hàng', 'Tên cơ hội', 'NVKD', 'Tình trạng', 'Đã đọc', 'Bình luận cuối', 'Người BL cuối', 'Số tiền', 'Flexo %', 'Giấy tấm %', 'Offset %', 'Điểm', 'Lý do điểm', 'Link'];
    const data = rows.map(({ q, c, last, f }, i) => {
      const { flexo, offset } = marginParts(q);
      return [
        i + 1,
        q?.createdAt ? new Date(q.createdAt * 1000).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }) : '',
        q?.code || c?.code || '',
        htmlText(`${kindTag(q)} ${noSheetTag(q)} ${bossOkTag(q, c)} ${targetTag(c)} ${buyerTag(q, c)} ${highPriceTag(c)} ${creditTag(c)} ${promiseTag(q, c)} ${contractTag(c)} ${sampleTag(q, c)} ${noDepositTag(c)}`),
        q?.customer?.code || '',
        q?.customer?.name || '',
        q?.name || '',
        staffOf(q, c) || '',
        statusLabel(q?.quoteStatus),
        q?.isRead === false ? 'Chưa đọc' : q?.isRead === true ? 'Đã đọc' : '',
        last ? fmtTime(last.createdAt) : 'Chưa có bình luận',
        last?.staff?.name || '',
        noPrice(q) ? 'Chưa cho giá' : Number(q?.amount) || '',
        flexo ? (flexo.invalid ? 'PO>BG' : flexo.rest) : '',
        flexo ? flexo.cost : '',
        offset ?? '',
        f ? f.score : '',
        f ? f.reasons.join(', ') : '',
        `${location.origin}/bao-gia/update/${c?.id ?? q?.id}`,
      ];
    });
    const widths = [5, 12, 10, 30, 14, 36, 50, 22, 14, 10, 14, 22, 16, 9, 10, 9, 7, 40, 42];
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    // Dòng tổng: SUBTOTAL(9, …) – lọc trong Excel thì tổng tự tính lại theo dòng đang hiện
    const ai = head.indexOf('Số tiền');
    const colL = String.fromCharCode(65 + ai);
    const total = rows.reduce((a, { q }) => a + (Number(q?.amount) || 0), 0);
    const sumRow = head.map((_, i) => (i === ai - 1 ? { t: `Tổng ${rows.length} báo giá`, bold: true } : i === ai ? { f: `SUBTOTAL(9,${colL}2:${colL}${rows.length + 1})`, v: total, bold: true } : ''));
    downloadBlob(buildXlsx([head, ...data, sumRow], widths, 'Báo giá', rows.length + 1), `bao-gia-kha-thi-${stamp}.xlsx`);
  }

  async function onClick(e) {
    // Tab Khách hàng: bấm tên khách → mở trang khách ở tab mới (trình duyệt tự mở) và thu gọn bảng
    if (e.target.closest('.ct-name a, .sc-link')) {
      setPanelOpen(false);
      return render();
    }
    // ✓ Hoàn thành 1 dòng "Có thể chốt liền" (nút nằm trong link → chặn chuyển trang)
    const hd = e.target.closest('[data-act="hot-done"]');
    if (hd) {
      e.preventDefault();
      e.stopPropagation();
      hd.closest('.hot-item')?.classList.add('hot-gone');
      await kvMerge('aiHotDone', { [hd.dataset.id]: { at: Date.now(), by: meName } });
      return setTimeout(render, 250);
    }
    // Bình luận mới nhất: trình duyệt tự mở báo giá ở tab mới (target=_blank), trang này đánh dấu đã đọc
    const nk = e.target.closest('[data-nkey]')?.dataset.nkey;
    if (nk) {
      // Báo giá mở ở tab mới (target=_blank) → thu gọn bảng ở tab này
      if (e.target.closest('a[data-nkey]')) setPanelOpen(false);
      return void markNotifRead(nk).then(render).catch((err) => console.warn('[DG]', err));
    }
    // Giữ trạng thái mở/đóng của mục "Bộ câu hỏi tự học" qua các lần vẽ lại
    const sum = e.target.closest('details.learnbox > summary');
    if (sum) state.learnOpen = !sum.parentElement.open;
    // Link trong bảng: chuyển trang ngay trong ứng dụng CRM (không tải lại cả trang)
    // Tab Phân tích deal: bấm vào cả thẻ deal → mở báo giá đó (như bấm mã BG), tắt bảng
    const dlCard = !e.target.closest('a, button, textarea, input') && e.target.closest('.dl-big-item, .dl-hot-item');
    if (dlCard) {
      const link = dlCard.querySelector('a.dl-code[data-nav]');
      if (link) return link.click();
    }
    const a = e.target.closest('a[data-nav]');
    if (a && !e.target.closest('button') && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const href = a.getAttribute('href');
      const code = a.dataset.code;
      if (!('keep' in a.dataset)) setPanelOpen(false); // tạm ẩn bảng để xem báo giá; bấm nút nổi để mở lại
      const navQuote = (await kvGet('quotes'))[Number(href.match(/(\d+)$/)?.[1])];
      showLoading(code, navQuote);
      // Tải hẳn trang: ghi tạm để trang mới hiện tiếp thẻ "Đang mở báo giá" cho tới khi app hiện xong
      const fullLoad = () => {
        try {
          sessionStorage.setItem('dgNav', JSON.stringify({ href, code, q: navQuote || null, at: Date.now() }));
        } catch {}
        location.assign(href);
      };
      // Từ trang chi tiết báo giá sang báo giá khác: app CRM giữ dữ liệu cũ → phải tải hẳn trang mới
      if (/^\/(co-hoi|bao-gia)\/update\//.test(location.pathname)) return fullLoad();
      document.dispatchEvent(new CustomEvent('dg:navigate', { detail: href })); // hook.js chuyển trang trong app
      const arrived = () => location.pathname === href && (!code || document.title.includes(code));
      const started = Date.now();
      const timer = setInterval(() => {
        if (arrived() || /^\/login\b/.test(location.pathname)) {
          // Tới nơi, hoặc bị đẩy về trang đăng nhập (hết phiên) → tắt thẻ chờ, không tải lại
          clearInterval(timer);
          hideLoading();
        } else if (Date.now() - started > 3500) {
          // App không chuyển được, hoặc chuyển URL nhưng vẫn hiện báo giá cũ → tải hẳn trang báo giá đó
          clearInterval(timer);
          fullLoad();
        } else if (Date.now() - started > 15000) {
          clearInterval(timer);
          hideLoading();
        }
      }, 150);
      return render();
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const id = Number(b.dataset.id);
    if (act === 'full') {
      try {
        localStorage.setItem('dgPanelFull', lsGet('dgPanelFull') === '1' ? '0' : '1');
      } catch {}
      layoutPanel();
      render();
    }
    else if (act === 'close') {
      setPanelOpen(false);
      render();
    }
    else if (act === 'gap-copy') {
      gapRows().then(async (rows) => {
        try {
          // chép kèm định dạng (đậm, màu) – dán vào Zalo giữ đúng kiểu tin nhắc cả đội
          const { text, html } = gapCopyData(rows, b.dataset.site || 'daiduong');
          try {
            await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
          } catch {
            await navigator.clipboard.writeText(text);
          }
          b.textContent = '✅ Đã chép';
        } catch {
          b.textContent = '⚠️ Không chép được';
        }
        setTimeout(() => render(), 1500);
      });
    }
    else if (act === 'gap-sort') {
      lsSet('dgGapSort', lsGet('dgGapSort') === 'diff' ? null : 'diff');
      render();
    }
    else if (act === 'gap-site') {
      lsSet('dgGapSite', b.dataset.site || null);
      render();
    }
    else if (act === 'tab') {
      lsSet('dgTab', b.dataset.tab);
      state.dealAnimKey = null;
      state.weekAnimKey = null;
      render();
    }
    else if (act === 'report-start') {
      state.report = { staff: b.dataset.staff, idx: 0 };
      lsSet('dgReport', JSON.stringify(state.report));
      render();
    }
    else if (act === 'report-goto') {
      state.report = { ...state.report, idx: Math.max(0, Number(b.dataset.i) || 0) };
      lsSet('dgReport', JSON.stringify(state.report));
      await render();
      root.querySelector('.panel')?.scrollTo?.({ top: 0 });
    }
    else if (act === 'report-finish') {
      // Lưu ngay ô đang gõ, rồi kiểm tra đủ 100% khách đã có bình luận báo cáo
      const ta = root.querySelector('textarea.rp-text');
      const all = await kvGet('reports');
      const cur = all[state.rpKey] || { items: {} };
      if (ta) cur.items = { ...(cur.items || {}), [ta.dataset.cid]: { comment: ta.value, at: Date.now(), by: meName } };
      const missing = (state.rpList || []).filter((cid) => !cur.items?.[cid]?.comment?.trim());
      if (missing.length) {
        await kvMerge('reports', { [state.rpKey]: cur });
        state.report = { ...state.report, idx: (state.rpList || []).indexOf(missing[0]) };
        lsSet('dgReport', JSON.stringify(state.report));
        state.error = `Còn ${missing.length} khách chưa có bình luận báo cáo (nút đỏ) – phải báo cáo đủ 100% mới hoàn tất được.`;
        await render();
        setTimeout(() => {
          state.error = null;
        }, 8000);
        return;
      }
      cur.doneAt = Date.now();
      await kvMerge('reports', { [state.rpKey]: cur });
      state.error = null;
      state.report = { ...state.report, idx: (state.rpList || []).length };
      lsSet('dgReport', JSON.stringify(state.report));
      render();
    }
    else if (act === 'rp-pend-more') {
      state.rpPendOpen = String(state.rpPendOpen) === b.dataset.cid ? null : b.dataset.cid;
      render();
    }
    else if (act === 'report-exit') {
      state.report = null;
      lsSet('dgReport', null);
      render();
    }
    else if (act === 'report-print') {
      printReport(state.report?.staff || meName);
    }
    else if (act === 'perm-enforce' || act === 'perm-role' || act === 'perm-enable' || act === 'perm-tab') {
      const cur = (await kvGet('perms')) || {};
      const users = { ...(cur.users || {}) };
      if (act === 'perm-enforce') {
        await kvMerge('perms', { enforced: !cur.enforced });
      } else {
        const k = b.dataset.key;
        const u = { name: b.dataset.name, role: 'sale', enabled: false, tabs: [...SALE_TABS], ...(users[k] || {}) };
        if (act === 'perm-role') u.role = u.role === 'admin' ? 'sale' : 'admin';
        if (act === 'perm-enable') u.enabled = !u.enabled;
        if (act === 'perm-tab') {
          const set = new Set(u.tabs?.length ? u.tabs : SALE_TABS);
          set.has(b.dataset.tab) ? set.delete(b.dataset.tab) : set.add(b.dataset.tab);
          u.tabs = PERM_ITEMS.map((t) => t[0]).filter((t) => set.has(t));
        }
        users[k] = { ...u, at: Date.now(), by: meName };
        await kvMerge('perms', { users });
      }
      render();
    }
    else if (act === 'debt-print') {
      printDebts(await kvGet('debt2'), userPerm(await kvGet('me')));
    }
    else if (act === 'debt-staff') {
      lsSet('dgDebtStaff', b.dataset.staff || null);
      render();
    }
    else if (act === 'zip-download') {
      const f = (await kvGet('files'))['extension-zip'];
      if (!f?.b64) return;
      const bin = atob(f.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name || 'DuyetGia-extension.zip';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    else if (act === 'perm-sub') {
      lsSet('dgPermTab', b.dataset.sub);
      render();
    }
    else if (act === 'set-toggle') {
      const cur = { auto: true, autoOpen: false, ...(await kvGet('settings')) };
      cur[b.dataset.key] = !cur[b.dataset.key];
      await call({ type: 'kv.set', key: 'settings', value: cur });
      render();
    }
    else if (act === 'set-collect-now') {
      await call({ type: 'kv.set', key: 'collectNow', value: Date.now() });
      b.textContent = 'Đã yêu cầu…';
    }
    else if (act === 'set-full') {
      const cur = (await kvGet('fullCollect')) || {};
      await call({ type: 'kv.set', key: 'fullCollect', value: cur.on ? { ...cur, on: false } : { on: true, startedAt: Date.now() } });
      render();
    }
    else if (act === 'set-sync') {
      setBusy('syncAll', true);
      try {
        await call({ type: 'sync.all' });
      } catch (err) {
        state.error = err.message;
      } finally {
        setBusy('syncAll', false);
      }
    }
    else if (act === 'deal-staff') {
      lsSet('dgDealStaff', b.dataset.staff);
      render();
    }
    else if (act === 'deal-run') {
      analyzeDeals(b.dataset.staff).then(render);
      render();
    }
    else if (act === 'week-set') {
      state.weekOff = Number(b.dataset.off) || 0;
      lsSet('dgWeekOff', String(state.weekOff));
      render();
    }
    else if (act === 'week-open') {
      state.weekOpen = state.weekOpen === b.dataset.staff ? null : b.dataset.staff;
      lsSet('dgWeekOpen', state.weekOpen);
      state.weekAnimKey = null; // chạy hiệu ứng cột mốc 4 tuần
      render();
    }
    else if (act === 'cust-hide') {
      const cur = (await kvGet('custHidden'))[b.dataset.cid];
      // Không ghi null (máy chủ không nhận) → đánh dấu off khi hiện lại
      await kvMerge('custHidden', { [b.dataset.cid]: cur && !cur.off ? { ...cur, off: true, at: Date.now() } : { name: b.dataset.name, at: Date.now(), by: meName } });
      render();
    }
    else if (act === 'cust-showhidden') {
      lsSet('dgShowHiddenCust', lsGet('dgShowHiddenCust') === '1' ? null : '1');
      render();
    }
    else if (act === 'cust-nocur') {
      lsSet('dgCustNoCur', lsGet('dgCustNoCur') === '1' ? null : '1');
      render();
    }
    else if (act === 'hot-toggle') {
      lsSet('dgHotCollapsed', lsGet('dgHotCollapsed') === '1' ? '0' : '1');
      render();
    }
    else if (act === 'sort') {
      try {
        localStorage.setItem('dgSort', sortMode() === 'erp' ? 'score' : 'erp');
      } catch {}
      render();
    } else if (act === 'staff') {
      lsSet('dgStaff', lsGet('dgStaff') === b.dataset.staff ? null : b.dataset.staff);
      render();
    } else if (act === 'filter-clear') {
      state.filter = '';
      lsSet('dgFilter', '');
      lsSet('dgStaff', null);
      render();
    } else if (act === 'filter') {
      state.filter = state.filter === b.dataset.f ? '' : b.dataset.f;
      try {
        localStorage.setItem('dgFilter', state.filter); // giữ bộ lọc sau khi F5
      } catch {}
      render();
    } else if (act === 'eval-quote') evaluateQuote(id);
    else if (act === 'quick-send') {
      const key = `quick:${id}`;
      if (state.busy.has(key) || !quickCtx[id]) return;
      const text = (root.querySelector(`textarea.quick-edit[data-id="${id}"]`)?.value ?? quickCtx[id].text).trim();
      setBusy(key, true);
      try {
        const qx = (await kvGet('quotes'))[id];
        const code = qx?.code || document.title.match(/#(BG\d+)/)?.[1];
        await sendComment(text, code);
        await kvMerge('quickSent', { [id]: { text, at: Date.now() } });
        recordSend({ kind: 'quick', base: quickCtx[id].base, sent: text, p: quickCtx[id].p, why: quickCtx[id].why, staff: staffOf(qx, renderCtx.comments[id]), code });
      } catch (err) {
        state.error = err.message;
      } finally {
        setBusy(key, false);
      }
    }
    else if (act === 'handover-send' || act === 'handover-skip') {
      const k = b.dataset.key;
      const h = (await kvGet('handovers'))[k];
      if (!h) return;
      if (act === 'handover-skip') {
        await kvMerge('handovers', { [k]: { ...h, skippedAt: Date.now() } });
        return render();
      }
      const busyKey = `handover:${k}`;
      if (state.busy.has(busyKey)) return;
      const text = ([...root.querySelectorAll('textarea.handover-edit')].find((t) => t.dataset.key === k)?.value || '').trim();
      setBusy(busyKey, true);
      try {
        await sendComment(text, b.dataset.code, true);
        await kvMerge('handovers', { [k]: { ...h, sentAt: Date.now(), sentText: text, quote: b.dataset.code } });
        delete state.handoverDraft[k];
      } catch (err) {
        state.error = err.message;
      } finally {
        setBusy(busyKey, false);
      }
    }
    else if (act === 'learn-now') {
      state.learnMsg = '';
      render();
      try {
        const n = await learnQuestions(true);
        state.learnMsg = n ? `Đã nạp thêm ${n} câu.` : 'Không có câu hỏi mới.';
      } catch (err) {
        state.error = err.message;
      }
      render();
    } else if (act === 'learn-off') {
      const k = b.dataset.key;
      const x = (await kvGet('learned'))[k];
      if (x) await kvMerge('learned', { [k]: { ...x, off: true, offAt: Date.now() } });
      render();
    }
    else if (act === 'export-xlsx') exportList();
    else if (act === 'hot-run') analyzeHot();
    else if (act === 'zalo-send') {
      // Mở tab Zalo ngay lúc bấm (trình duyệt chặn cửa sổ mở sau khi chờ) – đã có tab Zalo đang chạy thì thôi
      const zal = renderCtx.zaloAlive;
      if (!zal?.at || Date.now() - zal.at > 15000) window.open('https://chat.zalo.me/', 'dg-zalo');
      e.preventDefault();
      e.stopPropagation();
      const who = b.dataset.who;
      const qid = Number(b.dataset.qid) || null;
      const list = who === '*' ? Object.keys(state.hotZalo || {}) : [who];
      const [names, sentAll, old] = await Promise.all([kvGet('zaloNames'), kvGet('zaloSent'), kvGet('zaloJobs')]);
      const patch = {};
      let i = 0;
      // Mỗi deal chỉ hỏi 1 lần; mỗi NVKD 1 tin / 30 phút → mỗi người chỉ lấy 1 deal chưa hỏi
      for (const w of list) {
        if (zaloWaitMin(w, sentAll, Object.values(old))) continue;
        const m = (state.hotZalo?.[w] || []).find((x) => !sentAll[x.id] && (!qid || x.id === qid));
        if (!m) continue;
        patch[`${Date.now()}-${i}`] = { draft: lsGet('dgZaloDraft') !== '0', to: w, qid: m.id, code: m.code, zaloName: names[norm(w)]?.name || '', text: m.text, html: m.html, status: 'pending', at: Date.now() + i };
        i++;
      }
      if (!Object.keys(patch).length) {
        state.error = 'Không có tin nào được soạn: deal đã hỏi rồi, hoặc NVKD vừa được nhắn trong 30 phút.';
        return render();
      }
      // Dọn việc cũ hơn 1 ngày
      const keep = Object.fromEntries(Object.entries(old).filter(([, j]) => Date.now() - (j?.at || 0) < 86400e3));
      await call({ type: 'kv.set', key: 'zaloJobs', value: { ...keep, ...patch } });
      // Vẽ lại vài lần để thấy trạng thái gửi
      for (let k = 0; k < 40; k++) setTimeout(render, 1500 * (k + 1));
      render();
    }
    else if (act === 'qa-edit') {
      // Nhảy tới bộ câu và tô sáng đúng câu đang dùng để sửa tại chỗ
      e.preventDefault();
      e.stopPropagation();
      if (state.qbDirty) await qeAutosave(root.querySelector('.qe'));
      lsSet('dgQaSel', b.dataset.bank);
      // Bấm từ thẻ bên phải: mở bảng ở tab Bộ câu hỏi
      lsSet('dgTab', 'qa');
      if (!isOpen()) setPanelOpen(true);
      const idx = Number(b.dataset.idx);
      lastPanelHtml = '';
      await render();
      setTimeout(() => {
        const rows = root.querySelectorAll('.qe-row');
        const row = rows[idx >= 0 ? idx : 0];
        if (!row) return;
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.add('qe-flash');
        const line = row.querySelector('.qe-line');
        line?.focus();
        try {
          const rg = document.createRange();
          rg.selectNodeContents(line);
          rg.collapse(false);
          const sl = qeSel();
          sl.removeAllRanges();
          sl.addRange(rg);
        } catch {}
        setTimeout(() => row.classList.remove('qe-flash'), 2500);
      }, 120);
    }
    else if (act === 'osim-reset') {
      if (state.offSim) delete state.offSim[b.dataset.code];
      lastSideHtml = '';
      render();
    }
    else if (act === 'qa-more') {
      state.qaShow = (state.qaShow || 40) + 40;
      render();
    }
    else if (act === 'qa-staff') {
      state.qaShow = 40;
      state.qaStaff = b.dataset.staff || '';
      render();
    }
    else if (act === 'qa-p') {
      if (state.qbDirty) return; // đang sửa – không vẽ lại
      state.qaP = b.dataset.p;
      render();
    }
    else if (act === 'qv-add') {
      qeInsert(b.dataset.v);
    }
    else if (act === 'qv-chip') {
      // Bấm biến trong câu → đổi loại (p → P → d → p)
      const line = b.closest('.qe-line');
      const vars = qVars(b.closest('.qe')?.dataset.id);
      const nv = vars[(vars.indexOf(b.dataset.v) + 1) % vars.length];
      const tpl = document.createElement('template');
      tpl.innerHTML = qChip(nv);
      b.replaceWith(tpl.content.firstChild);
      if (line) qePreview(line);
    }
    else if (act === 'qb-row-del') {
      const box = b.closest('.qe');
      b.closest('.qe-row')?.remove();
      qeRenumber(box);
      qeDirty(box);
    }
    else if (act === 'qb-row-add') {
      const rows = b.closest('.qe')?.querySelector('.qe-rows');
      if (rows) {
        const tpl = document.createElement('template');
        tpl.innerHTML = qeRow('', rows.children.length);
        rows.append(tpl.content.firstChild);
        rows.lastElementChild.querySelector('.qe-line').focus();
        qeDirty(b.closest('.qe'));
      }
    }
    else if (act === 'qa-sel') {
      if (state.qbDirty) await qeAutosave(root.querySelector('.qe'));
      lsSet('dgQaSel', b.dataset.id);
      render();
    }
    else if (act === 'quick-use') {
      const ta = b.closest('.quick')?.querySelector('.quick-edit');
      if (ta) {
        ta.value = b.dataset.text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
      }
    }
    else if (act === 'qb-save' || act === 'qb-reset') {
      const id = b.dataset.id;
      const lines = act === 'qb-reset' ? [] : [...root.querySelectorAll(`.qe[data-id="${id}"] .qe-line`)].map(qSerialize).filter(Boolean);
      state.qbDirty = false;
      await kvMerge('qbank', { [id]: { lines, at: Date.now(), by: meName } });
      state.qaScan = null; // câu đã đổi → tính lại Review / Tổng quan
      b.textContent = '✅ Đã lưu';
      root.activeElement?.blur?.();
      lastPanelHtml = '';
      setTimeout(render, 600);
    }
    else if (act === 'zalo-draft') {
      lsSet('dgZaloDraft', lsGet('dgZaloDraft') !== '0' ? '0' : '1');
      render();
    }
    else if (act === 'zalo-name') {
      const who = b.dataset.who;
      const names = await kvGet('zaloNames');
      const v = prompt(`Tên Zalo của ${who} (đúng như hiện trong danh bạ / tìm kiếm Zalo):`, names[norm(who)]?.name || who);
      if (v == null) return;
      await kvMerge('zaloNames', { [norm(who)]: { name: v.trim(), staff: who, at: Date.now(), by: meName } });
      render();
    }
    else if (act === 'hot-copy') {
      try {
        try {
          await navigator.clipboard.write([new ClipboardItem({
            'text/plain': new Blob([state.hotCopy || ''], { type: 'text/plain' }),
            'text/html': new Blob([state.hotCopyHtml || ''], { type: 'text/html' }),
          })]);
        } catch {
          await navigator.clipboard.writeText(state.hotCopy || '');
        }
        b.textContent = '✅ Đã copy';
      } catch {
        prompt('Copy tin nhắn:', state.hotCopy || '');
      }
      setTimeout(() => (b.textContent = '📋 Copy tin nhắn'), 2500);
    }
    else if (act === 'suggest') suggestComment(id);
    else if (act === 'insert' || act === 'copy') {
      // Lấy nội dung đang hiển thị (người dùng có thể đã sửa tay)
      const text = root.querySelector(`textarea.suggest-edit[data-id="${id}"]`)?.value ?? ((await kvGet('suggests'))[id]?.text || '');
      const code = (await kvGet('quotes'))[id]?.code || document.title.match(/#(BG\d+)/)?.[1];
      if (act === 'insert') {
        if (state.busy.has(`send:${id}`)) return;
        setBusy(`send:${id}`, true);
        try {
          await sendComment(text, code);
          const cur = (await kvGet('suggests'))[id] || {};
          await kvMerge('suggests', { [id]: { ...cur, text, sentAt: Date.now() } });
          recordSend({ kind: 'ai', base: cur.orig || '', sent: text, why: cur.mode || 'gợi ý Claude', staff: staffOf((await kvGet('quotes'))[id], renderCtx.comments[id]), code });
        } catch (err) {
          state.error = err.message;
        } finally {
          setBusy(`send:${id}`, false);
        }
      }
      else {
        await navigator.clipboard.writeText(text);
        b.textContent = 'Đã copy';
      }
    }
  }

  // Cập nhật số báo giá quá 12 giờ trên nút nổi theo thời gian
  setInterval(render, 60 * 1000); // cũng để hiện dữ liệu vừa đồng bộ từ máy khác

  // ERP là SPA: theo dõi đổi trang để cập nhật mục "Báo giá đang mở"
  // Vào trang báo giá + bật "Tự mở bảng" → mở bảng
  async function maybeAutoOpen() {
    if (!root || !currentQuoteId()) return;
    if (!(await getSettings().catch(() => ({}))).autoOpen) return;
    root.querySelector('.panel').hidden = false;
    layoutPanel();
    render();
  }

  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      render();
      maybeAutoOpen();
    }
  }, 1000);

  // ---------- Tự cập nhật script ----------
  // Mỗi 10 giây hỏi background phiên bản hiện tại (background đồng thời kiểm tra GitHub). Có bản mới →
  // báo trên nút nổi rồi tự tải lại trang khi an toàn (không đang gõ chữ, không đang gửi bình luận).
  let bootSha = null;
  let reloadAt = 0;
  async function checkScriptVersion() {
    const v = await call({ type: 'version.get' }).catch(() => null);
    if (!v?.sha) return;
    if (!bootSha) bootSha = v.sha;
    if (v.sha === bootSha) return;
    const ae = root?.activeElement || document.activeElement;
    const typing = ae && /^(TEXTAREA|INPUT)$/.test(ae.tagName) && (ae.value || '').trim();
    if (typing || state.busy.size || custRefetch?.running) return; // đợi lúc rảnh
    if (!reloadAt) {
      reloadAt = Date.now() + 4000;
      const fab = root?.querySelector('.fab');
      if (fab) fab.innerHTML = `🔄 Có bản mới ${esc(v.version || '')} – tự tải lại…`;
      return;
    }
    if (Date.now() >= reloadAt) location.reload();
  }
  if (IS_TOP) setInterval(() => checkScriptVersion().catch(() => {}), 10000);

  // ---------- Trang đăng nhập ----------
  // Bị đăng xuất → CRM chuyển về /login: ẩn thẻ "Đang mở báo giá" và tự bấm "Đăng nhập" khi Chrome đã điền sẵn tài khoản.
  // Chỉ bấm khi cả 2 ô đã có giá trị; tối đa 1 lần / 2 phút để không bấm lặp (vd. sai mật khẩu → khoá tài khoản).
  const isLogin = () => /^\/login\b/.test(location.pathname);
  let credTried = false;
  function autoLogin() {
    if (!IS_TOP || !isLogin()) return;
    hideLoading();
    try {
      sessionStorage.removeItem('dgNav');
    } catch {}
    let last = 0;
    try {
      last = Number(sessionStorage.getItem('dgAutoLogin') || 0);
    } catch {}
    if (Date.now() - last < 120000) return;
    const btn = [...document.querySelectorAll('button')].find((b) => /đăng nhập/i.test(b.textContent || '') && !b.disabled);
    const user = document.querySelector('input:not([type=password]):not([type=hidden]):not([type=checkbox])');
    const pass = document.querySelector('input[type=password]');
    if (!btn || !user || !pass) return;
    if (!user.value || !pass.value) {
      // Chrome giấu mật khẩu tự điền tới khi người dùng chạm trang → lấy tài khoản đã lưu qua API đăng nhập của Chrome
      // (Credential Management). Mật khẩu chỉ điền vào ô của chính trang này, không lưu / gửi đi đâu khác.
      if (!credTried) {
        credTried = true;
        document.dispatchEvent(new CustomEvent('dg:credFill')); // hook.js (thế giới của trang) gọi API của Chrome
      }
      return;
    }
    if (document.querySelector('.ant-form-item-explain-error, .ant-message-error, .ant-notification-notice-error')) return; // đang báo lỗi → để người dùng xử lý
    try {
      sessionStorage.setItem('dgAutoLogin', String(Date.now()));
    } catch {}
    btn.click();
  }
  if (IS_TOP) setInterval(autoLogin, 700);

  // Trong iframe thu thập ngầm chỉ ghi dữ liệu, không hiện giao diện
  if (IS_TOP) {
    if (document.documentElement) mount();
    else document.addEventListener('DOMContentLoaded', mount);
  }
})();

// Chạy trong world USER_SCRIPT (tách biệt với JS của trang).
// Nhận dữ liệu từ hook.js, lưu vào extension, hiển thị bảng đánh giá NVKD
// và nhờ Claude nhận xét dựa trên phần bình luận của báo giá.
(() => {
  if (window.__dgPanel) return;
  window.__dgPanel = true;

  // ---------- Kết nối với background của extension ----------
  const NEED_RELOAD =
    'Extension trên máy này chưa được cập nhật. Vào chrome://extensions, bấm nút tải lại (↻) của "Duyệt giá Tuấn Tú", rồi tải lại trang này.';
  const call = (msg) =>
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
  const EXCLUDED_STAFF = ['Trần Đình Hùng', 'Nguyễn Trí Thức', 'Nguyễn Thăng Khôi'];
  const norm = (n) => (n || '').normalize('NFC').trim().toLowerCase();
  const isExcluded = (name) => EXCLUDED_STAFF.some((x) => norm(x) === norm(name));

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
    return { score, reasons };
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
          q.id && q.quoteStatus && !CLOSED.has(q.quoteStatus) && !q.hasOrder && !hasOrder(q, comments[q.id]) &&
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

  async function save({ kind, data }) {
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
      await kvMerge('quotes', { [data.id]: { ...old, ...next } });
    } else if (kind === 'margin') {
      const all = await kvGet('margins');
      const cur = all[data.code] || { products: {} };
      cur.products[data.spec || 'sản phẩm'] = { pct: data.pct, price: data.price, qty: data.qty, reprint: data.reprint, at: data.at };
      cur.at = data.at;
      await kvMerge('margins', { [data.code]: cur });
    } else if (kind === 'orders') {
      await kvMerge('orders', { [data.customerId]: { ...data, at: Math.floor(Date.now() / 1000) } });
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
  const SYSTEM = `Bạn là trưởng phòng kinh doanh của Tuấn Tú, công ty sản xuất bao bì giấy carton (thùng 3 lớp, 5 lớp, offset, flexo...).
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
        khi: 'NVKD đã báo khách hẹn đặt sau / để sau / đợi (vd. "khách xem báo giá trước, đợi hàng bớt kho đặt hàng sau", "khách hẹn tuần sau báo lại")',
        hoi: 'Kết quả của báo giá này sao rồi?',
      },
      {
        khi: 'bình luận CUỐI CÙNG của luồng là quản lý đã cho giá / duyệt giá (vd. "A cho em giá đã bao gồm khuôn + bản in", "E cho chị giá nhé", "E duyệt giá nhé chị") và sau đó NVKD chưa phản hồi gì',
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
    return `Bạn giúp quản lý kinh doanh của Tuấn Tú (bao bì giấy carton) viết MỘT bình luận để đăng vào phần bình luận của báo giá trên CRM, hỏi nhân viên kinh doanh (NVKD) về bước tiếp theo.

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
        prompt: [styleBlock(examples, myName(me)), context, threadText(q, c)].filter(Boolean).join('\n\n'),
        maxTokens: 4000,
      });
      await kvMerge('suggests', { [id]: { text: text.trim(), at: Date.now(), overdue, mode, styleFrom: examples.list.length } });
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

  const LEARN_SYSTEM = `Bạn giúp quản lý kinh doanh của Tuấn Tú (bao bì giấy carton) xây dựng BỘ CÂU HỎI dùng để hỏi nhân viên kinh doanh (NVKD) trong phần bình luận báo giá trên CRM.
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
      let ta = c.querySelector('.ant-comment-nested textarea');
      if (!ta) {
        reply.click();
        for (let i = 0; i < 30 && !(ta = c.querySelector('.ant-comment-nested textarea')); i++) await sleep(100);
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

  // Báo giá Offset: trong khung ẩn, bấm số lượng từng sản phẩm → mở "Tính giá offset" → Ctrl+Shift+G.
  // hook.js trong khung đọc bảng chiết giá (iframe#printWindow) và gửi "Đang bán (X%)" về để lưu. Lệnh in bị chặn.
  async function readOffsetMargins(f) {
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
    for (const [ri, tr] of rows.slice(0, 10).entries()) {
      setStep(`Đang mở bảng chiết giá Offset (sản phẩm ${ri + 1}/${Math.min(rows.length, 10)})…`);
      const btn = tr.cells[idx]?.querySelector('button');
      if (!btn) continue;
      btn.click();
      let modal = null;
      for (let i = 0; i < 20 && !modal; i++) {
        await sleep(250);
        modal = visModals().find((m) => /Tính giá offset/i.test(m.innerText));
      }
      if (modal) {
        doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true, bubbles: true }));
        await sleep(2500); // hook.js đọc bảng chiết giá
      }
      await closeModals();
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
  const flexoStale = (fx) =>
    !fx || fx.mode !== FLEXO_MODE || (fx.missing?.length > 0 && Date.now() / 1000 - fx.at > 3600);

  async function readFlexoCost(f, q) {
    const doc = f.contentDocument;
    if (!doc) return;
    const vis = () => [...doc.querySelectorAll('.ant-modal-wrap')].filter((m) => getComputedStyle(m).display !== 'none');
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
    let missing = [];
    for (const [ci, ch] of list.entries()) {
      setStep(`Đang đọc nhà cung cấp ${ch.code} (${ci + 1}/${list.length})…`);
      const total = await readOne(ch);
      if (total) suppliers.push({ code: ch.code, name: selName(), total });
      else missing.push(ch);
    }
    // Đọc lại nhà cung cấp bị lỡ (PO tải quá chậm) – thiếu 1 nhà là % sai hẳn
    for (const ch of [...missing]) {
      setStep(`Đọc lại nhà cung cấp ${ch.code}…`);
      const total = await readOne(ch);
      if (!total) continue;
      suppliers.push({ code: ch.code, name: selName(), total });
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
      missing: missing.map((c) => c.code),
      quoteTotal: pageTotal || q.amount || 0,
      mode: FLEXO_MODE,
      at: Math.floor(Date.now() / 1000),
    };
    await kvMerge('margins', { [q.code]: cur });
  }

  async function takeLock() {
    const lock = await kvGet('collectLock');
    if (lock?.tab && lock.tab !== TAB_ID && Date.now() - lock.at < 90000) return false; // tab khác đang chạy
    await call({ type: 'kv.set', key: 'collectLock', value: { tab: TAB_ID, at: Date.now() } });
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
        const needOffset = q.offset && !Object.keys(mg?.products || {}).length;
        const needFlexo = (q.kinds || []).includes('flexo') && q.amount && flexoStale(mg?.flexo);
        await loadInFrame(q.id, undefined, undefined, needOffset || needFlexo
          ? async (f) => {
              if (needOffset) await readOffsetMargins(f);
              if (needFlexo) await readFlexoCost(f, q);
            }
          : null);
        await kvMerge('collected', { [q.id]: Math.floor(Date.now() / 1000) });
        // Lịch sử mua hàng của khách: tối đa 1 lần / ngày / khách
        const cid = q.customer?.id;
        if (cid) {
          const od = (await kvGet('orders'))[cid];
          if (!od || hoursSince(od.at) > 24) {
            collect.current = `${q.code} · lịch sử mua hàng`;
            progress();
            await loadInFrame(null, `/khach-hang/view/${cid}?t=order`, /\/misaOrder\?.*customerId=/);
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
            return (k.includes('offset') && !Object.keys(mg.products || {}).length) || (k.includes('flexo') && q.amount && flexoStale(mg.flexo));
          })
          .slice(0, 10);
        for (const { q } of missing) {
          if (!force && !(await getSettings()).auto) break;
          collect.current = `${q.code} · tính %`;
          progress();
          const k = q.kinds || (q.offset ? ['offset'] : []);
          await loadInFrame(q.id, undefined, undefined, async (f) => {
            if (k.includes('offset')) await readOffsetMargins(f);
            if (k.includes('flexo') && q.amount) await readFlexoCost(f, q);
          });
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
    .unread a.item, .unread .item-head { display: grid; grid-template-columns: 34px 74px minmax(0, .45fr) 130px minmax(0, 1.55fr) 104px 74px 136px 120px 52px; align-items: center;
      gap: 10px; padding: 6px 4px; border-radius: 6px; font-size: 13px; }
    .unread .item-head { position: sticky; top: -18px; z-index: 2; background: #f1f5f9; border-radius: 8px; margin-bottom: 4px;
      font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .04em; }
    .unread .item-head > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .unread .item-head .it-amt { font-size: 14px; text-transform: none; letter-spacing: 0; color: #047857; background: #dcfce7; border-radius: 6px; padding: 2px 6px; }
    .unread a.item:hover { background: #f5f8ff; }
    .unread a.item > * { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .it-code { font-weight: 800; font-size: 14px; }
    /* Cột mã khách hàng riêng: thẳng hàng giữa các dòng */
    .it-cust .kh { margin-left: 0; font-size: 11px; padding: 0 7px; max-width: 100%; display: inline-block; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
    .it-no { text-align: right; color: #94a3b8; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .it-main .kh, .it-main .knd, .it-main .tgt, .it-main .hip, .it-main .crd, .it-main .prm, .it-main .smp, .it-main .ctr, .it-main .nodep
      { margin-left: 0; margin-right: 4px; font-size: 11px; padding: 0 7px; }
    .it-name { color: #1e3a8a; }
    .it-who { display: flex; align-items: center; gap: 6px; color: #334155; }
    .it-who span { overflow: hidden; text-overflow: ellipsis; }
    .it-ago { color: #64748b; font-size: 12px; text-align: right; }
    .it-amt { text-align: right; font-weight: 800; color: #047857; font-variant-numeric: tabular-nums; }
    .it-amt .noprice { margin-left: 0; font-size: 11px; padding: 0 6px; }
    .it-pct { display: flex; justify-content: flex-end; gap: 4px; font-size: 12px; font-variant-numeric: tabular-nums; }
    .pc { width: 50px; flex: none; text-align: center; border-radius: 6px; padding: 2px 0; font-weight: 800; border-left: 3px solid transparent; }
    .pc.f { background: #eff6ff; border-left-color: #3b82f6; }
    .pc.o { background: #faf5ff; border-left-color: #a855f7; }
    .pc.good { color: #047857; } .pc.bad { color: #b91c1c; }
    .pc.wait { color: #94a3b8; font-weight: 600; }
    .pc.warn { color: #b45309; font-size: 10px; }
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
    .quick-row { display: flex; align-items: center; gap: 12px; }
    .quick-text { flex: 1; font: inherit; font-size: 16px; font-weight: 700; color: #1f2328; background: #fff; border-radius: 8px;
      padding: 8px 12px; border: 1px dashed #d4a72c; resize: vertical; min-height: 110px; max-height: 50vh; line-height: 1.4; }
    /* Thẻ bên phải hẹp: ô câu hỏi chiếm hết chiều ngang, nút gửi xuống dưới */
    .side .quick-row { flex-direction: column; align-items: stretch; gap: 8px; }
    .side .quick-row .act { align-self: flex-end; }
    .quick-text:focus { outline: 2px solid #fcd34d; border-style: solid; }
    .tgt { margin-left: 6px; display: inline-block; background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; border-radius: 999px;
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
    .fclear { align-self: center; margin-left: auto; font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; border: 0; background: #0f172a;
      color: #fff; border-radius: 999px; padding: 2px 10px; }
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
    .hot-done { width: 30px; height: 30px; border-radius: 50%; border: 2px solid #cbd5e1; background: #fff; color: #94a3b8; font-size: 15px;
      font-weight: 900; cursor: pointer; transition: all .15s; }
    .hot-done:hover { border-color: #16a34a; background: #16a34a; color: #fff; transform: scale(1.08); }
    a.hot-item.hot-gone { opacity: 0; transform: translateX(30px); transition: all .25s ease; }
    a.hot-item { display: grid; grid-template-columns: 34px 26px minmax(0, 1fr) 170px; gap: 10px; align-items: center; text-decoration: none; color: inherit;
      background: #fff; border: 1px solid #ffedd5; border-radius: 10px; padding: 8px 10px; }
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
    .side-actions { display: grid !important; grid-template-columns: 1fr auto; gap: 8px; }
    .side-actions .act { justify-content: center; }
    .side-q .btns { flex-wrap: wrap; }
    .side-q .act.hero { font-size: 14px; padding: 8px 14px; }
    .side-q textarea { font-size: 13px; }
    .side table td, .side table th { white-space: normal; }
    .warnx { color: #b45309; font-weight: 700; font-size: 12px; }
    .side-h { font-weight: 800; font-size: 14px; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; cursor: move; user-select: none; touch-action: none; }
    .side .side-grip { color: #94a3b8; font-size: 14px; }
    .side-btn { margin-left: auto; border: 1px solid #e2e8f0; background: #f8fafc; border-radius: 6px; width: 24px; height: 22px; cursor: pointer; font-size: 12px; line-height: 1; }
    .side.collapsed { width: auto; padding: 8px 10px; }
    .side.collapsed .side-h { margin-bottom: 0; }
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
  const UI_KEYS = ['dgStaff', 'dgHotCollapsed', 'dgSort', 'dgFilter', 'dgPanelOpen', 'dgPanelW', 'dgPanelFull', 'dgSidePos', 'dgSideCollapsed'];
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
    root.innerHTML = `<style>${CSS}</style><button class="fab">📊 Đánh giá NVKD</button><div class="panel" hidden></div><div class="grip" hidden title="Kéo để dãn / thu hẹp · bấm đúp để về mặc định"></div><div class="side" hidden></div>`;
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
    let searchTimer;
    const onInput = (e) => {
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
          ? `<div class="lcust"><span class="licon">🏢</span><div class="lcust-body"><div class="lcust-label">Khách hàng${custTag(q)}</div><div class="lcust-name">${esc(q.customer.name || q.customer.code)}</div></div></div>`
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
  const avatarUrl = (a) => (!a ? '' : /^https?:/.test(a) ? a : `https://sale.tuantu.com.vn:8080/${a.replace(/^\/+/, '')}`);
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
    /(giá|gia)\s*(bên\s*)?(mình|minh|em|mình\s*báo)?\s*(hơi\s*|còn\s*|quá\s*|khá\s*|rất\s*)?(cao|đắt|mắc)|chê\s*(giá\s*)?(cao|đắt|mắc)|(cao|đắt|mắc)\s*(quá|hơn)|chưa\s*(được|đc|dc|tới|đạt|tốt)\s*(giá|gia)(?![\p{L}])|(giá|gia)\s*(vẫn\s*)?chưa\s*(được|đc|dc|tới|đạt|tốt)|(rẻ|re)\s*hơn|bên\s*kia\s*(rẻ|re)/iu;
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
  const flexoInfo = (q) => {
    const fx = q?.code && renderCtx.margins?.[q.code]?.flexo;
    const base = fx?.quoteTotal || q?.amount;
    if (!fx?.suppliers?.length || !base) return null;
    // Mỗi nhà cung cấp lo giấy tấm cho các sản phẩm khác nhau → chi phí giấy tấm = TỔNG PO của các nhà cung cấp
    const sum = fx.suppliers.reduce((a, s) => a + (s.total || 0), 0);
    const best = { code: fx.suppliers.map((s) => s.code).join(' + '), total: sum };
    const cost = Math.round((sum / base) * 1000) / 10;
    // PO giấy tấm lớn hơn cả giá trị báo giá (thường do số lượng tấm tối thiểu / MOQ) → không tính %
    const missing = fx.missing || [];
    if (cost > 100) return { best, cost, rest: null, invalid: true, base, suppliers: fx.suppliers, missing, at: fx.at };
    return { best, cost, rest: Math.round((100 - cost) * 10) / 10, base, suppliers: fx.suppliers, missing, at: fx.at };
  };
  const marginOf = (q) => {
    const m = q?.code && renderCtx.margins?.[q.code];
    const list = m ? Object.values(m.products || {}) : [];
    const vals = list.map((x) => x.pct);
    const fx = flexoInfo(q);
    if (fx && fx.rest != null) vals.push(fx.rest);
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
    const total = list.reduce((a, o) => a + (o.total || 0), 0);
    const year = list.filter((o) => hoursSince(o.at) <= 365 * 24);
    return { count: od.total ?? list.length, total, year: year.length, yearTotal: year.reduce((a, o) => a + (o.total || 0), 0), last: list[0], list };
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

  const custTag = (q) =>
    q?.customer?.code ? ` <span class="kh" title="${esc(q.customer.name || '')}">${esc(q.customer.code)}</span>` : '';

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
  // Chào lại: các cách nói của cùng 1 câu "Báo cáo lại khách hàng này"
  const REPORT_BACK = [
    'Báo cáo lại khách hàng này nhé {p}.',
    'Báo cáo lại khách hàng này nha {p}.',
    'Báo cáo lại khách hàng này {p} nhé.',
    'Báo cáo lại khách hàng này {p} nha.',
  ];
  // Chọn cố định theo báo giá (không đổi mỗi lần vẽ lại); bấm "Gửi lại" thì đổi câu khác
  const pickFor = (arr, id, salt = 0) => arr[(Math.abs(Number(id) * 2654435761 + salt * 40503) >>> 0) % arr.length];
  const fillP = (t, p, d = '') => t.replaceAll('{p}', p).replaceAll('{P}', p.charAt(0).toUpperCase() + p.slice(1)).replaceAll('{d}', d);
  // "anh" trong mẫu là quản lý tự xưng; nếu NVKD được gọi là "anh" thì quản lý xưng "em"
  const selfFix = (t, p) => (p === 'anh' ? t.replace(/\b(giúp|với|cho|báo|tính lại|duyệt|hỗ trợ) anh\b/g, '$1 em').replace(/Giá anh duyệt/g, 'Giá em duyệt') : t);

  // Câu hỏi nhanh viết sẵn (không cần Claude) theo tình trạng báo giá
  // Bình luận mới nhất trong mọi báo giá cùng khách; trả về nếu đó là dòng "… lên đơn hàng …" / "Mã đơn hàng Misa"
  const ORDER_NOTE_RE = /lên đơn hàng|mã đơn hàng misa/i;
  function lastCustomerOrderNote(q) {
    const cid = q?.customer?.id;
    if (!cid) return null;
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
    const mine = Object.values(renderCtx.quotes || {}).filter((x) => custKey(x) === key);
    if (!mine.length || mine.some((x) => (x.kinds || (x.offset ? ['offset'] : [])).includes('offset'))) return false;
    const newest = Math.max(...mine.map((x) => x.createdAt || 0));
    if (!newest || hoursSince(newest) < 30 * 24) return false;
    let asked = false;
    const walk = (t) => {
      if (t.staff?.name === meName && /offset/i.test(t.text || '')) asked = true;
      (t.children || []).forEach(walk);
    };
    (c?.threads || []).forEach(walk);
    return !asked;
  }

  function quickQuestion(q, c, mode, p) {
    if (!q || CLOSED.has(q.quoteStatus) || hasOrder(q, c)) return null;
    // Hoạt động gần nhất của khách (mọi báo giá cùng khách) là thông báo lên đơn hàng đã lâu → hỏi vì sao lâu chưa xuống đơn
    const lo = lastCustomerOrderNote(q);
    if (lo && hoursSince(lo.createdAt) >= 30 * 24) {
      return { icon: '📦', why: `Lần cuối khách lên đơn ${humanDuration(hoursSince(lo.createdAt))} trước`, text: `Vì sao khách hàng này lâu chưa xuống đơn hàng vậy ${p}?` };
    }
    // Chưa có bình luận nào (đã mở xem/ thu thập mà không thấy) → hỏi NVKD vì sao chưa có thông tin
    const noComments = !c?.threads?.length && (renderCtx.collected[q.id] || currentQuoteId() === q.id);
    if (noComments && q.createdAt && hoursSince(q.createdAt) >= 24) {
      return { icon: '📭', why: 'Chưa có bình luận nào', text: `Báo giá này chưa có thông tin gì, tình hình khách sao rồi ${p}?` };
    }
    // Khách hứa lên đơn mà quá 1 ngày vẫn chưa lên
    const pr = promiseInfo(q, c);
    if (pr && hoursSince(pr.at) >= 24) {
      const lead0 = hoursSince(pr.at) >= 72 ? `${humanDuration(hoursSince(pr.at))} chưa có phản hồi, báo cáo lại nhé ${p}. ` : '';
      return { icon: '🤝', why: 'Khách hứa lên đơn nhưng chưa lên', text: `${lead0}Khách hứa lên đơn mà sao chưa lên vậy ${p}, lý do gì ${p}?` };
    }
    if (noPrice(q)) return null;
    const last = lastComment(c);
    const h = last ? hoursSince(last.createdAt) : 0;
    const lead = h >= 72 ? `${humanDuration(h)} chưa có phản hồi, báo cáo lại nhé ${p}. ` : '';
    if (q.isReprint) return { icon: '🔁', why: 'Đơn tái bản', text: `${lead}Khách xuống đơn tái bản chưa ${p}?` };
    // Khách chưa từng có báo giá Offset và đã lâu không có báo giá mới → hỏi khách có dùng offset không
    if (mode && offsetGap(q, c)) return { icon: '🟪', why: 'Khách chưa có báo giá Offset, lâu chưa báo giá mới', text: `Khách hàng này có dùng offset không ${p}?` };
    if (mode === 'hoiNhanh') {
      const salt = renderCtx.quickSent[q.id] ? Math.floor(renderCtx.quickSent[q.id].at / 1000) : 0;
      const lead2 = h >= 72 ? fillP(pickFor(SILENT_LEAD, q.id, salt + 7), p, humanDuration(h)) : '';
      const text = lead2 + fillP(pickFor(PRICE_ASK, q.id, salt), p);
      return { icon: '⏰', why: `Quá ${FOLLOW_UP_HOURS} giờ chưa chốt`, text: selfFix(text.charAt(0).toUpperCase() + text.slice(1), p) };
    }
    if (mode === 'chaoLai')
      return {
        icon: '💤',
        why: q.quoteStatus === 'REJECT' ? 'Báo giá thất bại' : `Im lặng quá ${MAX_FOLLOW_UP_DAYS} ngày`,
        text: fillP(pickFor(REPORT_BACK, q.id, renderCtx.quickSent[q.id] ? Math.floor(renderCtx.quickSent[q.id].at / 1000) : 0), p),
      };
    return null;
  }

  let quickCtx = {}; // id → câu hỏi nhanh đang hiển thị (dùng khi bấm gửi)
  const quickBox = (q, c, mode) => {
    const p = addressFor(staffOf(q, c), renderCtx.comments, renderCtx.quotes);
    const qq = quickQuestion(q, c, mode, p);
    if (!qq) return '';
    const id = q.id;
    const draft = renderCtx.quickDraft[id];
    const text = draft?.base === qq.text ? draft.text : qq.text; // giữ bản đã sửa nếu câu gốc chưa đổi
    quickCtx[id] = { base: qq.text, text };
    const sent = renderCtx.quickSent[id];
    const key = `quick:${id}`;
    return `<div class="warn quick">
      <div class="quick-why">${qq.icon} ${esc(qq.why)} – câu hỏi gợi ý <span class="muted">(sửa được trước khi gửi)</span>:</div>
      <div class="quick-row"><textarea class="quick-text quick-edit" data-id="${id}" rows="4">${esc(text)}</textarea>
        <button class="act primary" data-act="quick-send" data-id="${id}" ${state.busy.has(key) ? 'disabled' : ''}>
          ${state.busy.has(key) ? '<span class="spinner light"></span> Đang gửi…' : sent ? '📨 Gửi lại' : '📨 Bình luận ngay'}</button></div>
      ${sent ? `<div class="sent">✅ Đã bình luận lúc ${new Date(sent.at).toLocaleTimeString('vi-VN')}</div>` : ''}
    </div>`;
  };
  // Mở báo giá mà chưa có / cũ lịch sử mua hàng → tự đọc trang khách hàng trong khung ẩn
  const ordersFetching = new Set();
  const ordersTried = {}; // cid → lần thử gần nhất (tránh tải lại liên tục khi không lấy được)
  async function fetchOrdersNow(cid) {
    if (ordersFetching.has(cid) || ordersFetching.size || Date.now() - (ordersTried[cid] || 0) < 10 * 60 * 1000) return;
    ordersTried[cid] = Date.now();
    ordersFetching.add(cid);
    try {
      await loadInFrame(null, `/khach-hang/view/${cid}?t=order`, /\/misaOrder\?.*customerId=/);
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
        if (q.offset) await readOffsetMargins(f);
        if ((q.kinds || []).includes('flexo') && q.amount) await readFlexoCost(f, q);
      });
    } finally {
      marginFetching.delete(q.id);
      marginStep = '';
      render();
    }
  }
  // Tóm tắt riêng từng loại: Flexo (còn lại sau giấy tấm) và Offset (đang bán %, thấp nhất trong các sản phẩm)
  function marginParts(q) {
    const m = renderCtx.margins?.[q?.code] || {};
    const offs = Object.values(m.products || {});
    return {
      flexo: flexoInfo(q),
      offset: offs.length ? Math.min(...offs.map((x) => x.pct)) : null,
      offs: Object.entries(m.products || {}),
    };
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

  const pctCell = (q) => {
    const kinds = q?.kinds || (q?.offset ? ['offset'] : []);
    if (!kinds.length) return '';
    const { flexo, offset } = marginParts(q);
    // 2 ô cố định: Flexo (trái) · Offset (phải) – không có loại đó thì để ô trống cho thẳng cột
    const fmt = (v) => `${Math.round(v)}%`;
    const fx = !kinds.includes('flexo')
      ? '<span class="pc"></span>'
      : flexo
        ? flexo.invalid
          ? '<span class="pc f warn" title="Tổng PO giấy tấm lớn hơn giá trị báo giá">PO&gt;BG</span>'
          : `<span class="pc f ${pctCls(flexo.rest)}" title="Flexo: còn ${flexo.rest}% sau giấy tấm">${fmt(flexo.rest)}</span>`
        : '<span class="pc f wait" title="Flexo: đang chờ tính">…</span>';
    const of = !kinds.includes('offset')
      ? '<span class="pc"></span>'
      : offset != null
        ? `<span class="pc o ${pctCls(offset)}" title="Offset: đang bán ${offset}%">${fmt(offset)}</span>`
        : '<span class="pc o wait" title="Offset: đang chờ tính">…</span>';
    return fx + of;
  };
  const pctCls = (v) => (v == null ? '' : v < 30 ? 'bad' : 'good');

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

  function renderSide(q, qid = q?.id, body = '', ho = '', hoN = 0) {
    const el = root?.querySelector('.side');
    if (!el) return;
    // Đang gõ trong ô câu hỏi / gợi ý / bàn giao của thẻ → không vẽ lại để khỏi mất chữ
    const ae = root.activeElement;
    if (ae && el.contains(ae) && ae.tagName === 'TEXTAREA') return;
    if (!qid) {
      // Không ở trang báo giá: thẻ chỉ hiện khi có bàn giao khách hàng cần xử lý
      if (!ho) {
        el.hidden = true;
        return;
      }
      const col = lsGet('dgSideCollapsed') === '1';
      el.hidden = false;
      el.classList.toggle('collapsed', col);
      el.innerHTML = `<div class="side-h" title="Kéo để di chuyển · bấm đúp để về vị trí mặc định"><span class="side-grip">⠿</span>🔁 Bàn giao khách hàng <span class="ho-n">${hoN}</span>
        <button class="side-btn" data-side="toggle" title="${col ? 'Mở rộng' : 'Thu gọn'}">${col ? '▸' : '▾'}</button></div>${col ? '' : ho}`;
      placeSide(el);
      return;
    }
    const kinds = q?.kinds || (q?.offset ? ['offset'] : []);
    const { flexo, offset } = marginParts(q);
    const busy = !!q && marginFetching.has(q.id);
    const oldFx = !!q && renderCtx.margins?.[q.code]?.flexo && flexoStale(renderCtx.margins[q.code].flexo);
    if (IS_TOP && q && ((kinds.includes('offset') && offset == null) || (kinds.includes('flexo') && q.amount && (!flexo || oldFx)))) setTimeout(() => fetchMarginNow(q), 0);
    const open = el.querySelector('details')?.open;
    const collapsed = lsGet('dgSideCollapsed') === '1';
    el.hidden = false;
    el.classList.toggle('collapsed', collapsed);
    const mini = [
      kinds.includes('flexo') ? `🟦 ${flexo ? (flexo.invalid ? '⚠️' : `<b class="${pctCls(flexo.rest)}">${flexo.rest}%</b>`) : '–'}` : '',
      kinds.includes('offset') ? `🟪 ${offset != null ? `<b class="${pctCls(offset)}">${offset}%</b>` : '–'}` : '',
    ].filter(Boolean).join(' · ');
    const header = `<div class="side-h" title="Kéo để di chuyển · bấm đúp để về vị trí mặc định"><span class="side-grip">⠿</span>📊 ${esc(q?.code || `#${qid}`)}${collapsed ? '' : `${custTag(q)}${q?.quoteStatus ? `<span class="st-pill">${esc(statusLabel(q.quoteStatus))}</span>` : ''}`}${busy ? ' <span class="spinner"></span>' : ''}
      ${collapsed ? `<span class="side-mini">${mini}</span>${hoN ? ` <span class="ho-n" title="Bàn giao khách hàng cần xử lý">🔁 ${hoN}</span>` : ''}` : ''}<button class="side-btn" data-side="toggle" title="${collapsed ? 'Mở rộng' : 'Thu gọn'}">${collapsed ? '▸' : '▾'}</button></div>`;
    if (collapsed) {
      el.innerHTML = header;
      placeSide(el);
      return;
    }
    const [info, rest] = body.includes('<!--dg-split-->') ? body.split('<!--dg-split-->') : ['', body];
    const tile = (cls, label, main, sub) => `<div class="mtile ${cls}"><div class="mt-l">${label}</div><div class="mt-v">${main}</div>${sub ? `<div class="mt-s">${sub}</div>` : ''}</div>`;
    el.innerHTML = `${header}
      ${ho}
      ${info}
      ${kinds.length ? '<div class="side-sec">📊 Lợi nhuận đơn hàng</div><div class="mtiles">' : ''}
      ${kinds.includes('flexo') ? tile('flexo', '🟦 Flexo', flexo ? (flexo.invalid ? '<span class="warnx">⚠️ PO giấy tấm > giá trị BG</span>' : `<b class="${pctCls(flexo.rest)}">${flexo.rest}%</b>`) : waitHtml(busy), flexo && !flexo.invalid ? `giấy tấm ${flexo.cost}%` : '') : ''}
      ${kinds.includes('offset') ? tile('offset', '🟪 Offset', offset != null ? `<b class="${pctCls(offset)}">${offset}%</b>` : waitHtml(busy), offset != null ? 'đang bán' : '') : ''}
      ${kinds.length ? '</div>' : ''}
      ${flexo?.missing?.length ? `<div class="warnx">⚠️ Chưa đọc được PO giấy tấm của ${esc(flexo.missing.join(', '))} – % Flexo đang thiếu, sẽ tự tính lại.</div>` : ''}
      ${busy && marginStep ? `<div class="calc-step"><span class="spinner"></span>${esc(marginStep)}</div>` : ''}
      ${kinds.length ? marginBox(q, true).replace('<details class="mgnbox">', `<details class="mgnbox side-d"${open ? ' open' : ''}>`) : ''}
      ${rest}`;
    placeSide(el);
  }

  const marginBox = (q, compact = false) => {
    if (!q?.code) return '';
    const kinds = q.kinds || (q.offset ? ['offset'] : []);
    if (!kinds.length) return '';
    const m = renderCtx.margins?.[q.code] || {};
    const offs = Object.entries(m.products || {});
    const fx = flexoInfo(q);
    const needOff = kinds.includes('offset') && !offs.length;
    const needFx = kinds.includes('flexo') && q.amount && (!fx || flexoStale(m.flexo));
    if (IS_TOP && (needOff || needFx)) setTimeout(() => fetchMarginNow(q), 0);
    const pct = marginOf(q);
    const busy = marginFetching.has(q.id);
    const parts = marginParts(q);
    const segs = [];
    if (kinds.includes('flexo')) segs.push(`🟦 Flexo ${parts.flexo ? (parts.flexo.invalid ? '<span class="warnx">⚠️ PO > giá trị BG</span>' : `<b class="${pctCls(parts.flexo.rest)}">${parts.flexo.rest}%</b>`) : `<span class="muted">${busy ? 'đang tính…' : '–'}</span>`}`);
    if (kinds.includes('offset')) segs.push(`🟪 Offset ${parts.offset != null ? `<b class="${pctCls(parts.offset)}">${parts.offset}%</b>` : `<span class="muted">${busy ? 'đang tính…' : '–'}</span>`}`);
    const head = compact ? '' : `📊 Đơn hàng này: ${segs.join(' · ')}`;
    const offRows = offs.map(([spec, x]) => `<tr><td>Offset · ${esc(spec)}</td><td>${esc(x.qty || '')}</td><td>${esc(x.price || '')}</td><td class="num"><b>${x.pct}%</b></td></tr>`).join('');
    const fxRows = fx
      ? fx.suppliers.map((s) => `<tr><td>Flexo · giấy tấm ${esc(s.code)}</td><td>${esc(s.name.split('|').pop().trim().slice(0, 40))}</td><td>${money(s.total)}</td><td class="num">${Math.round((s.total / fx.base) * 1000) / 10}%</td></tr>`).join('') +
        `<tr><td><b>Tổng giấy tấm</b></td><td></td><td><b>${money(fx.best.total)}</b></td><td class="num"><b>${fx.cost}%</b></td></tr>`
      : '';
    return `<details class="mgnbox"><summary>${head}${busy ? ' <span class="spinner"></span>' : ''} <span class="link">Giải thích</span></summary>
      ${offRows ? `<div class="expl"><b>Offset</b> – lấy từ bảng chiết giá (Ctrl+Shift+G): <i>Đang bán % = 1 − NVL 1 thùng ÷ giá 1 thùng</i>.</div>` : ''}
      ${fx ? `<div class="expl"><b>Flexo</b> – Lên PO → Giấy tấm, chọn từng nhà cung cấp: <i>tỉ lệ giấy tấm = (tổng PO của tất cả nhà cung cấp) ÷ tổng giá trị báo giá (${money(fx.base)})</i>. ${fx.invalid
        ? `<span class="warnx">⚠️ Tổng PO giấy tấm (${money(fx.best.total)}) lớn hơn giá trị báo giá – thường do số lượng tấm tối thiểu (MOQ) của nhà cung cấp hoặc đơn nhỏ; không tính % cho trường hợp này, cần xem tay.</span>`
        : `Tổng giấy tấm ${esc(fx.best.code)} = ${money(fx.best.total)} chiếm <b>${fx.cost}%</b> → còn lại <b>${fx.rest}%</b>.`}
        ${fx.missing.length ? `<span class="warnx">⚠️ Chưa đọc được PO của ${esc(fx.missing.join(', '))} (tải quá chậm) – tổng giấy tấm đang thiếu nhà này.</span>` : ''}</div>` : ''}
      ${offRows || fxRows ? `<table><tr><th>Hạng mục</th><th>SL / NCC</th><th>Giá / Tổng PO</th><th class="num">%</th></tr>${offRows}${fxRows}</table>` : (busy ? `<div class="calc-step"><span class="spinner"></span>${esc(marginStep || 'Đang tính…')}</div>` : '<div class="muted">Chưa có dữ liệu – bấm "↻ Tính ngay" để tính.</div>')}
      ${pct != null ? `<div class="muted">Flexo: % còn lại = 100% − tổng giấy tấm (mọi nhà cung cấp) / giá trị báo giá – đỏ khi dưới 30%. Offset: "Đang bán %" thấp nhất trong các sản phẩm.</div>` : ''}
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

  async function render() {
    if (!root) return;
    try {
      await renderInner();
      fitAll(root.querySelector('.panel'));
      restoreScroll();
    } catch (e) {
      console.warn('[DG]', e);
      if (isOpen()) {
        root.querySelector('.panel').innerHTML = `
          <div class="row"><h2>Đánh giá nhân viên kinh doanh</h2><span class="hbtns"><button class="x fs" data-act="full" title="${lsGet('dgPanelFull') === '1' ? 'Thu nhỏ lại' : 'Toàn màn hình'}">${lsGet('dgPanelFull') === '1' ? '🗗' : '⛶'}</button><button class="x" data-act="close">×</button></span></div>
          <div class="err">${esc(e.message || e)}</div>`;
      }
    }
  }

  // Tên gọn: 3 chữ → chữ cuối (Phan Văn Thịnh → Thịnh); 4 chữ trở lên → 2 chữ cuối (Lê Thị Đông Anh → Đông Anh)
  const shortName = (n) => {
    const w = (n || '').trim().split(/\s+/).filter(Boolean);
    return w.length >= 4 ? w.slice(-2).join(' ') : w.length === 3 ? w[2] : w.join(' ');
  };

  async function renderInner() {
    meName = myName(await kvGet('me'));
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
      .filter((q) => q.isRead === false && !isExcluded(staffOf(q, comments[q.id])))
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
    const handovers = hoAll
      .filter((h) => !h.sentAt && !h.skippedAt && !hoDone.has(`${normName(h.customer)}|${normName(h.to)}`))
      .sort((a, b) => (b.at || b.seenAt) - (a.at || a.seenAt));
    fab.innerHTML = `📊 Đánh giá NVKD${alertCount ? ` <span class="fab-badge">🎯 ${alertCount}</span>` : ''}${handovers.length ? ` <span class="fab-badge">🔁 ${handovers.length}</span>` : ''}`;
    // Bảng đang thu gọn mà có báo giá cần hỏi lại → nút nổi nhấp nháy, nảy nhẹ để gây chú ý
    fab.classList.toggle('alert', alertCount > 0 && !isOpen());
    // Thẻ cố định bên phải trang báo giá: báo giá đang mở (câu hỏi gợi ý, % Flexo/Offset, mua hàng, đánh giá)
    avatars = avatarIndex(quotes);
    renderCtx = { comments, quotes, collected, orders: await kvGet('orders'), margins: await kvGet('margins'), quickSent: await kvGet('quickSent'), quickDraft: await kvGet('quickDraft') };
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
      const tags = `${kindTag(q)}${targetTag(c)}${highPriceTag(c)}${creditTag(c)}${promiseTag(q, c)}${contractTag(c)}${sampleTag(q, c)}${noDepositTag(c)}`;
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

    renderSide(quotes[qid], qid, current, handoverBox(handovers, quotes), handovers.length);
    if (!isOpen()) return;
    const editing = root.activeElement?.classList;
    if (editing?.contains('handover-edit')) return; // đang sửa – không vẽ lại

    const cut = (t, n) => (t && t.length > n ? t.slice(0, n) + '…' : t || '');
    // Tổng doanh thu (số tiền báo giá) của một danh sách
    // Bấm nhãn trên tiêu đề để lọc danh sách: 'tgt' = khách cho giá, 'zero' = chưa cho giá
    const FILTERS = {
      tgt: ({ c }) => targetPriceInfo(c),
      zero: ({ q }) => noPrice(q),
      nodep: ({ c }) => noDepositInfo(c),
      high: ({ c }) => highPriceInfo(c),
      credit: ({ c }) => creditInfo(c),
      promise: ({ q, c }) => promiseInfo(q, c),
      sample: ({ c }) => sampleInfo(c),
      contract: ({ c }) => contractInfo(c),
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
        ]],
        ['Tín hiệu khách', [
          ['tgt', 'blue', '💲', 'Khách cho giá', cnt(FILTERS.tgt)],
          ['promise', 'amber', '🤝', 'Hứa lên đơn', cnt(FILTERS.promise)],
          ['contract', 'sky', '📝', 'Hợp đồng', cnt(FILTERS.contract)],
          ['sample', 'pink', '✂️', 'Cắt mẫu', cnt(FILTERS.sample)],
          ['high', 'orange', '💸', 'Giá cao', cnt(FILTERS.high)],
          ['credit', 'teal', '🧾', 'Xin công nợ', cnt(FILTERS.credit)],
          ['nodep', 'red', '🚫', 'Chưa cọc', cnt(FILTERS.nodep)],
        ]],
        ['Lợi nhuận & loại', [
          ['lowm', 'red', '📈', 'Bán dưới 30%', cnt(FILTERS.lowm)],
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
        .join('')}${staffChips ? `<div class="fgroup"><span class="fname">Nhân viên</span><div class="fchips">${staffChips}</div></div>` : ''}${state.filter || staffSel ? '<button class="fclear" data-act="filter-clear">✕ Bỏ lọc</button>' : ''}</div>`;
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
    const itemHtml = ({ q, c, last, f }, i) => {
      const staff = staffOf(q, c);
      const tip = [q?.customer?.name, q?.name, statusLabel(q?.quoteStatus),
        last ? `Bình luận cuối ${ago(last.createdAt)} (${last.staff?.name || '?'})` : `Chưa có bình luận · tạo ${q?.createdAt ? ago(q.createdAt) : '?'}`,
        suggests[c.id]?.sentAt ? 'Đã gửi gợi ý' : suggests[c.id] ? 'Đã có gợi ý' : ''].filter(Boolean).join('\n');
      return `<a class="item ${q?.isRead === false ? 'q-unread' : q?.isRead === true ? 'q-read' : ''}" href="/bao-gia/update/${c.id}" data-nav data-code="${esc(q?.code || c.code)}" title="${esc(tip)}">
      <span class="it-no">${i + 1}</span>
      <span class="it-code">${esc(q?.code || c.code)}</span>
      <span class="it-main">${kindTag(q)}${targetTag(c)}${highPriceTag(c)}${creditTag(c)}${promiseTag(q, c)}${contractTag(c)}${sampleTag(q, c)}${noDepositTag(c)}</span>
      <span class="it-cust">${custTag(q).trim()}</span>
      <span class="it-name" title="${esc(q?.name || '')}">${esc(q?.name || '')}</span>
      <span class="it-who" title="${esc(staff || '')}">${avatarHtml(staff, 20)}<span>${esc(shortName(staff) || '?')}</span></span>
      <span class="it-ago">${last ? `💬 ${ago(last.createdAt)}` : '📭 chưa BL'}${suggests[c.id]?.sentAt ? ' ✅' : ''}</span>
      <span class="it-amt">${noPrice(q) ? noPriceTag(q) : q?.amount ? money(q.amount) : ''}</span>
      <span class="it-pct">${pctCell(q)}</span>
      <span class="it-fea"${f ? ` title="${esc(f.reasons.join(', '))}"` : ''}>${f ? `<b class="fea" style="${feaStyle(f.score)}">🎯${f.score}</b>` : ''}</span></a>`;
    };
    // Dòng tiêu đề cột (dính trên đầu khi cuộn) + tổng tiền ngay trên cột Số tiền
    // 20.315.464.107đ → "20,32 tỷ"; dưới 1 tỷ → "845,20 triệu"
    const moneyShort = (n) => {
      const f = (v) => v.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return n >= 1e9 ? `${f(n / 1e9)} tỷ` : n >= 1e6 ? `${f(n / 1e6)} triệu` : money(n);
    };
    const listRows = (items, forExport = false) => {
      const rows = applyFilter(items);
      // Nút Xuất Excel xuất đúng bảng chính đang hiện (đã lọc / tìm / xếp) – không lấy các bảng phụ bên dưới
      if (forExport) state.exportRows = rows;
      if (!rows.length) return '<span class="muted">Không có báo giá phù hợp bộ lọc</span>';
      const total = rows.reduce((a, { q }) => a + (Number(q?.amount) || 0), 0);
      const sumTip = `Tổng ${rows.length} báo giá đang hiện: ${money(total)}`;
      return `<div class="item-head"><span class="it-no">#</span><span>Mã BG</span><span>Nhãn</span><span>Khách</span><span>Tên cơ hội</span><span>NVKD</span>
        <span class="it-ago">BL cuối</span><span class="it-amt" title="${esc(sumTip)}">Σ ${moneyShort(total)}</span><span class="it-pct"><span class="pc">Flexo</span><span class="pc">Offset</span></span><span class="it-fea">Điểm</span></div>` +
        rows.map(itemHtml).join('');
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
        : '<div class="muted">Chưa có báo giá nào đủ tín hiệu khả thi hoặc chưa đọc.</div>'}
      ${samples.length
        ? `<h3>✂️ Cắt mẫu (${samples.length})${filterChip('sampleOrder', 'smp ok', `→ ${samplesOrdered} có đơn (${Math.round((samplesOrdered / samples.length) * 100)}%)`)}${filterChip('sampleNo', 'smp', `${samples.length - samplesOrdered} chưa có đơn`)}${state.filter ? ' <button class="act chipbtn" data-act="filter" data-f="">✕ Bỏ lọc</button>' : ''}</h3>
          <div class="box unread">${listRows(samples)}</div>`
        : ''}
      ${silent.length
        ? `<div class="sec-head"><h3>📭 Chưa có bình luận <span class="cnt">${silent.length}</span></h3><div class="sec-right">${totalBadge(silent)}</div></div><div class="hint muted">Báo giá đã mở xem mà NVKD chưa trao đổi gì – nên hỏi vì sao chưa có thông tin.</div><div class="box unread">${listRows(silent)}</div>`
        : ''}`;


    const searchFocused = root.activeElement?.classList?.contains('dg-search');
    root.querySelector('.panel').innerHTML = `
      <div class="row"><h2>Đánh giá nhân viên kinh doanh</h2><span class="hbtns"><button class="x fs" data-act="full" title="${lsGet('dgPanelFull') === '1' ? 'Thu nhỏ lại' : 'Toàn màn hình'}">${lsGet('dgPanelFull') === '1' ? '🗗' : '⛶'}</button><button class="x" data-act="close">×</button></span></div>
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
        syncPendingReads(ns, me?.id ?? meName);
        return notifBox(ns, quotes, me);
      })()}</div>
      ${state.error ? `<div class="err">Lỗi: ${esc(state.error)}</div>` : ''}
      ${hotBox((await kvGet('aiHot')).latest, quotes, await kvGet('aiHotDone'))}
      ${overdueBox}
      ${learnedBox(await kvGet('learned'))}
    `;
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
  // Claude trả về tối đa 10 báo giá có thể chốt NGAY + lý do + việc cần làm. Lưu kv 'aiHot' (đồng bộ).
  const HOT = { candidates: 40, show: 10 };
  const HOT_SYSTEM = `Bạn là trưởng phòng kinh doanh của Tuấn Tú (bao bì giấy carton). Quản lý có quá nhiều báo giá, cần biết báo giá nào CHỐT ĐƯỢC NGAY để tập trung.
Đọc từng báo giá (thông tin + luồng bình luận nội bộ giữa NVKD và quản lý) và chọn tối đa ${HOT.show} báo giá có khả năng chốt đơn cao nhất TRONG VÀI NGÀY TỚI.
Tín hiệu chốt mạnh: khách đã ok giá / đồng ý / hứa lên đơn / hẹn ngày đặt; khách cho giá mục tiêu và mình đã đáp ứng; chỉ còn vướng thủ tục (cọc, hợp đồng, duyệt mẫu, maket); khách quen, tái bản; mới trao đổi gần đây.
Tín hiệu yếu: khách chê giá cao chưa xử lý, im lặng lâu, khách đặt chỗ khác, chưa có giá, chỉ hỏi tham khảo.
Chỉ dựa trên dữ liệu được cung cấp, không bịa.
Trả về DUY NHẤT một JSON array, xếp từ khả năng cao xuống thấp, mỗi phần tử:
{"code":"BGxxxxx","kha_nang":0-100,"ly_do":"1 câu ngắn, nêu tín hiệu cụ thể trong bình luận","viec_can_lam":"1 việc cụ thể quản lý/NVKD cần làm ngay để chốt"}
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
      const cands = feasibleList(live, comments, orders)
        .filter(({ q }) => !(done[q.id] && Date.now() - done[q.id].at < 7 * 86400e3)) // đã xử lý trong 7 ngày → không đưa vào lại
        .sort((a, b) => b.f.score - a.f.score)
        .slice(0, HOT.candidates);
      if (!cands.length) throw new Error('Chưa có báo giá khả thi nào để phân tích.');
      const blocks = cands.map(({ q, c, f }) => {
        const os = orderSummary(orders?.[q.customer?.id]);
        return [
          `### ${q.code} – "${q.name || ''}"`,
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
        maxTokens: 6000,
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
      }));
      await kvMerge('aiHot', { latest: { at: Date.now(), items, from: cands.length } });
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
  function morningStart() {
    const vn = new Date(Date.now() + 7 * 3600e3); // giờ VN dạng UTC
    const start = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), HOT_MORNING_HOUR) - 7 * 3600e3;
    return Date.now() >= start ? start : null; // chưa tới 7h sáng thì chưa chạy
  }
  async function maybeMorningHot() {
    const start = morningStart();
    if (!start || state.busy.has('hot') || !(await getSettings()).auto) return;
    const hot = (await kvGet('aiHot')).latest;
    if (hot?.at >= start) return;
    const lock = await kvGet('hotLock');
    if (lock?.at && Date.now() - lock.at < 10 * 60e3 && lock.tab !== TAB_ID) return;
    await call({ type: 'kv.set', key: 'hotLock', value: { tab: TAB_ID, at: Date.now() } });
    await analyzeHot();
    render();
  }
  if (IS_TOP) {
    setTimeout(() => maybeMorningHot().catch((e) => console.warn('[DG] hot', e)), 45000); // đợi dữ liệu tải xong
    setInterval(() => maybeMorningHot().catch((e) => console.warn('[DG] hot', e)), 10 * 60e3);
  }

  function hotBox(hot, quotes, done = {}) {
    const busy = state.busy.has('hot');
    // Dòng đã bấm ✓ hoàn thành (ở bất kỳ máy nào – kv 'aiHotDone' đồng bộ) thì ẩn
    // Ẩn: đã chốt / thất bại, đã lên đơn (CRM ghi "lên đơn hàng", mã đơn Misa, hoặc có trong lịch sử mua hàng của khách), đã bấm ✓
    const items = (hot?.items || []).filter(
      (x) => quotes[x.id] && !CLOSED.has(quotes[x.id].quoteStatus) && !hasOrderFull(quotes[x.id], renderCtx.comments?.[x.id]) && !done[x.id],
    );
    const doneN = (hot?.items || []).filter((x) => done[x.id]).length;
    const btn = `<button class="act hero hot-btn" data-act="hot-run" ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner light"></span> AI đang đọc các báo giá…' : hot ? '🔄 Phân tích lại' : '🔥 AI chọn đơn chốt được liền'}</button>`;
    const rows = items
      .map((x, i) => {
        const q = quotes[x.id];
        const cls = x.pct >= 75 ? 'good' : x.pct >= 50 ? 'mid' : 'bad';
        return `<a class="hot-item" href="/bao-gia/update/${x.id}" data-nav data-code="${esc(x.code)}">
          <button class="hot-done" data-act="hot-done" data-id="${x.id}" title="Đánh dấu đã xử lý xong – ẩn khỏi danh sách trên mọi máy">✓</button>
          <span class="hot-no">${i + 1}</span>
          <span class="hot-main"><span class="hot-top"><b>${esc(x.code)}</b>${custTag(q)}<span class="hot-name">${esc(q.name || '')}</span></span>
            <span class="hot-why">💡 ${esc(x.why)}</span>
            <span class="hot-next">👉 ${esc(x.next)}</span></span>
          <span class="hot-side"><span class="hot-pct ${cls}">${x.pct}%</span><span class="hot-amt">${q.amount ? money(q.amount) : ''}</span><span class="hot-who">${esc(shortName(staffOf(q, renderCtx.comments[q.id])) || '')}</span></span></a>`;
      })
      .join('');
    const collapsed = lsGet('dgHotCollapsed') === '1';
    const toggle = `<button class="hot-toggle" data-act="hot-toggle" title="${collapsed ? 'Mở rộng' : 'Thu gọn'}">${collapsed ? '▸' : '▾'}</button>`;
    if (collapsed)
      return `<div class="hotbox collapsed${items.length ? ' has-data' : ''}"><div class="hot-head"><h3>${toggle}<span class="hot-fire">🔥</span> Có thể chốt liền <span class="hot-count">${items.length}</span>${items.length ? '<span class="hot-hint">bấm ▸ để xem</span>' : ''}</h3>${btn}</div></div>`;
    return `<div class="hotbox">
      <div class="hot-head"><h3>${toggle}🔥 Có thể chốt liền <span class="hot-count">${items.length}</span> <span class="muted">– AI đọc ${hot?.from || HOT.candidates} báo giá khả thi điểm cao nhất, chọn ra tối đa ${HOT.show} đơn nên ưu tiên</span></h3>${btn}</div>
      ${hot ? `<div class="muted">Phân tích lúc ${new Date(hot.at).toLocaleString('vi-VN')}${doneN ? ` · ✓ đã xong ${doneN} đơn` : ''} · tự phân tích lại mỗi sáng từ ${HOT_MORNING_HOUR}h</div>` : `<div class="muted">Tự phân tích mỗi sáng từ ${HOT_MORNING_HOUR}h khi mở CRM, hoặc bấm nút để chạy ngay (mỗi lần 1 lượt gọi Claude).</div>`}
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
      const head = `<div class="ho-cust" title="${esc(h.customer)}">${esc(h.customer)}</div>
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
    const head = ['#', 'Mã BG', 'Nhãn', 'Mã KH', 'Tên khách hàng', 'Tên cơ hội', 'NVKD', 'Tình trạng', 'Đã đọc', 'Bình luận cuối', 'Người BL cuối', 'Số tiền', 'Flexo %', 'Giấy tấm %', 'Offset %', 'Điểm', 'Lý do điểm', 'Link'];
    const data = rows.map(({ q, c, last, f }, i) => {
      const { flexo, offset } = marginParts(q);
      return [
        i + 1,
        q?.code || c?.code || '',
        htmlText(`${kindTag(q)} ${targetTag(c)} ${highPriceTag(c)} ${creditTag(c)} ${promiseTag(q, c)} ${contractTag(c)} ${sampleTag(q, c)} ${noDepositTag(c)}`),
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
    const widths = [5, 10, 30, 14, 36, 50, 22, 14, 10, 14, 22, 16, 9, 10, 9, 7, 40, 42];
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
    const a = e.target.closest('a[data-nav]');
    if (a && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
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
        if (arrived()) {
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
        await sendComment(text, (await kvGet('quotes'))[id]?.code || document.title.match(/#(BG\d+)/)?.[1]);
        await kvMerge('quickSent', { [id]: { text, at: Date.now() } });
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

  // Trong iframe thu thập ngầm chỉ ghi dữ liệu, không hiện giao diện
  if (IS_TOP) {
    if (document.documentElement) mount();
    else document.addEventListener('DOMContentLoaded', mount);
  }
})();

// Chạy trong world MAIN, trước khi app ERP khởi động.
// Chỉ "nghe" các phản hồi API mà chính trang ERP tải về (không tự gọi API),
// rút gọn rồi chuyển sang panel.js qua sự kiện DOM "dg:data".
(() => {
  if (window.__dgHooked) return;
  window.__dgHooked = true;
  const COLLECTOR_FRAME = window.name === 'dg-collector';

  // CRM vừa cập nhật bản mới mà trình duyệt còn giữ trang HTML cũ trong cache → file main.*.js cũ
  // bị 404 → trang trắng. Khi gặp, làm mới cache rồi tải lại trang (tối đa 1 lần / phút).
  window.addEventListener(
    'error',
    (e) => {
      const t = e.target;
      if (!t || t.tagName !== 'SCRIPT' || !/\/static\/js\/main\.[^/]+\.js/.test(t.src)) return;
      try {
        const last = Number(sessionStorage.getItem('dgStaleReload') || 0);
        if (Date.now() - last < 60000) return;
        sessionStorage.setItem('dgStaleReload', String(Date.now()));
      } catch {
        return;
      }
      fetch(location.href, { cache: 'reload' }).finally(() => location.reload());
    },
    true,
  );

  // ---- Chiết giá (Ctrl+Shift+G): CRM vẽ bảng vào iframe#printWindow rồi gọi in ----
  // Đọc "Đang bán (X%)" + giá + số lượng + quy cách và gửi cho panel.js lưu lại.
  // Trong khung thu thập ngầm: chặn lệnh in để không bật hộp thoại.
  if (COLLECTOR_FRAME) window.print = () => {};
  // Khung ẩn không được giật focus của trang chính (đang gõ bình luận thì phím chạy vào khung ẩn → mất chữ)
  if (COLLECTOR_FRAME) {
    HTMLElement.prototype.focus = function () {};
    window.focus = () => {};
    document.addEventListener('focusin', (e) => e.target?.blur?.(), true);
  }
  // In báo giá để chụp hình (panel.js phát "dg:printCapture"): chặn hộp thoại in trong 25 giây.
  // CRM vẽ báo giá vào iframe#printWindow rồi gọi iframe.contentWindow.print() → bọc getter contentWindow
  // để vá print() của khung trước khi CRM kịp gọi; window.print của trang cũng được chặn.
  let captureUntil = 0;
  const muted = () => Date.now() < captureUntil;
  const mute = (w) => {
    try {
      if (w && !w.__dgMuted) {
        const orig = w.print;
        w.print = function () {
          if (muted()) return;
          return orig.apply(this, arguments);
        };
        w.__dgMuted = true;
      }
    } catch {}
  };
  if (!COLLECTOR_FRAME) {
    mute(window);
    const cw = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    if (cw?.get) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        configurable: true,
        enumerable: cw.enumerable,
        get() {
          const w = cw.get.call(this);
          if (muted()) mute(w);
          return w;
        },
      });
    }
    document.addEventListener('dg:printCapture', () => {
      captureUntil = Date.now() + 25000;
      const f = document.getElementById('printWindow');
      if (f) mute(f.contentWindow);
    });
  }
  let lastChiet = '';
  function readChiet(f) {
    try {
      if (COLLECTOR_FRAME && f.contentWindow) f.contentWindow.print = () => {};
      const t = f.contentDocument?.body?.innerText || '';
      // "Đang bán (57%)" hoặc – khi trùng 1 mốc – "30% (Đang bán)"
      const pct = t.match(/Đang bán\s*\((-?\d+(?:[.,]\d+)?)%\)/) || t.match(/(-?\d+(?:[.,]\d+)?)%\s*\(\s*Đang bán\s*\)/);
      const noPrice = !pct && /Đang bán\s*\(-?Infinity%\)/i.test(t); // báo giá chưa cho giá (giá 1 thùng 0đ)
      const code = t.match(/CHIẾT GIÁ\s*#?(BG\d+)/i);
      if ((!pct && !noPrice) || !code || t === lastChiet) return;
      lastChiet = t;
      // Giá ở cột "Đang bán": lấy hàng "Giá 1 thùng" theo đúng vị trí cột
      let price = null;
      const tables = [...f.contentDocument.querySelectorAll('table')];
      for (const tb of tables) {
        const rows = [...tb.rows];
        const head = rows.find((r) => /Đang bán/.test(r.innerText));
        const row = rows.find((r) => /Giá 1/.test(r.innerText));
        if (head && row) {
          const idx = [...head.cells].findIndex((c) => /Đang bán/.test(c.innerText));
          price = row.cells[idx]?.innerText.trim() || null;
          break;
        }
      }
      // Bảng "Nguyên liệu": dòng Tổng → cột "1 thùng" (NVL 1 thùng) và "Thành tiền" (tổng NVL)
      const vn = (x) => {
        const m = String(x || '').replace(/[^\d,.-]/g, '');
        return m ? Number(m.replace(/\./g, '').replace(',', '.')) || 0 : 0;
      };
      let nvlUnit = null;
      let nvlTotal = null;
      for (const tb of tables) {
        const prev = tb.previousElementSibling?.innerText || tb.parentElement?.previousElementSibling?.innerText || '';
        const rows = [...tb.rows];
        const head = rows.find((r) => /Thành tiền/.test(r.innerText) && /Hạng mục/.test(r.innerText));
        const sum = rows.find((r) => /^\s*Tổng/.test(r.cells[0]?.innerText || ''));
        if (!head || !sum) continue;
        if (!/Nguyên liệu/i.test(prev) && !rows.some((r) => /Giấy mặt|Giấy sóng/i.test(r.innerText))) continue;
        // Dòng Tổng gộp ô đầu → lấy từ cuối: [..., 1 thùng, Thành tiền, Tỷ trọng]
        const cells = [...sum.cells].map((c) => c.innerText.trim());
        const money = cells.filter((x) => /đ\s*$/.test(x));
        if (money.length >= 2) {
          nvlUnit = vn(money[money.length - 2]);
          nvlTotal = vn(money[money.length - 1]);
        }
        break;
      }
      // Bảng "Giá bán": ô cuối hàng tiêu đề (vd. "5.018đ") = giá vốn 1 đơn vị → giá bán = giá vốn ÷ (1 − % muốn bán)
      let costUnit = null;
      for (const tb of tables) {
        const prev = (tb.previousElementSibling?.innerText || tb.parentElement?.previousElementSibling?.innerText || '').trim();
        const head = tb.rows[0];
        if (!head) continue;
        const ht = head.innerText;
        if (!/Giá bán/i.test(prev) && !(/Hạng mục/.test(ht) && /Đơn giá/.test(ht) && [...tb.rows].some((r) => /Giá trước VAT/i.test(r.innerText)))) continue;
        const lastCell = head.cells[head.cells.length - 1]?.innerText.trim() || '';
        if (/\d/.test(lastCell)) costUnit = vn(lastCell);
        break;
      }
      const val = (re) => (t.match(re)?.[1] || '').trim();
      emit('margin', {
        costUnit,
        code: code[1].toUpperCase(),
        pct: pct ? Number(pct[1].replace(',', '.')) : null,
        noPrice,
        nvlUnit,
        nvlTotal,
        price,
        spec: val(/Quy cách:\s*([^\n]+)/),
        qty: val(/Số lượng đặt:\s*([^\n]+)/),
        reprint: val(/Tái bản:\s*([^\n]+)/),
        at: Math.floor(Date.now() / 1000),
      });
    } catch {}
  }
  new MutationObserver(() => {
    const f = document.getElementById('printWindow');
    if (f && !f.__dgWatch) {
      f.__dgWatch = true;
      f.addEventListener('load', () => setTimeout(() => readChiet(f), 300));
      const tick = setInterval(() => (f.isConnected ? readChiet(f) : clearInterval(tick)), 700);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // panel.js (world tách biệt) nhờ chuyển trang trong app CRM: phải chạy ở world MAIN thì router mới nhận
  document.addEventListener('dg:navigate', (e) => {
    const path = String(e.detail || '');
    if (!path.startsWith('/')) return;
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  });

  // Trang đăng nhập: Chrome giấu mật khẩu tự điền tới khi người dùng chạm trang → lấy tài khoản đã lưu qua
  // API đăng nhập của Chrome (Credential Management) rồi điền vào chính form này. Không lưu / gửi đi nơi khác.
  document.addEventListener('dg:credFill', async () => {
    if (!/^\/login\b/.test(location.pathname) || !navigator.credentials?.get || typeof PasswordCredential === 'undefined') return;
    let cred = null;
    try {
      cred = await navigator.credentials.get({ password: true, mediation: 'silent' }); // tự động, không hỏi
      if (!cred) cred = await navigator.credentials.get({ password: true, mediation: 'optional' }); // hộp chọn tài khoản – bấm 1 lần
    } catch {}
    if (!cred?.password) return;
    const user = document.querySelector('input:not([type=password]):not([type=hidden]):not([type=checkbox])');
    const pass = document.querySelector('input[type=password]');
    if (!user || !pass) return;
    // Ô do React quản lý → gán qua setter gốc + phát sự kiện để app nhận giá trị
    const setVal = (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal(user, cred.id);
    setVal(pass, cred.password);
  });

  const API = /:8080\/v1\/admin\//;
  const emit = (kind, data) =>
    document.dispatchEvent(new CustomEvent('dg:data', { detail: JSON.stringify({ kind, data }) }));

  const person = (s) => (s ? { id: s.id, name: s.name, avatar: s.avatar || undefined } : undefined);
  // Cột "Sale" trên ERP là NVKD được gán cho khách hàng (không phải người tạo báo giá).
  // Tìm trường người phụ trách: ưu tiên trường tên có sale/seller/assign/charge… ở báo giá, rồi ở khách hàng; cuối cùng mới tới staff (người tạo).
  const isPerson = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.name === 'string' && (v.id != null || v.avatar || v.email || v.phone);
  const SALE_KEY = /sale|seller|assign|charge|incharge|manager|owner|care|follow/i;
  const peopleOf = (o) => {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) if (isPerson(v)) out[k] = v.name;
    for (const [k, v] of Object.entries(o?.customer || {})) if (isPerson(v)) out[`customer.${k}`] = v.name;
    return out;
  };
  const saleOf = (o) => {
    for (const [k, v] of Object.entries(o || {})) if (k !== 'staff' && SALE_KEY.test(k) && isPerson(v)) return { v, k };
    const c = o?.customer || {};
    for (const [k, v] of Object.entries(c)) if (SALE_KEY.test(k) && isPerson(v)) return { v, k: `customer.${k}` };
    for (const k of ['staff', 'user']) if (isPerson(c[k])) return { v: c[k], k: `customer.${k}` };
    return null;
  };
  // Thành tiền 1 dòng sản phẩm: ưu tiên tổng của dòng, không có thì giá × số lượng
  const lineTotal = (p) => {
    const n = (v) => (v == null || v === '' ? NaN : Number(v));
    const t = [p.totalPrice, p.totalAmount, p.amount, p.total].map(n).find((v) => Number.isFinite(v) && v > 0);
    if (t) return t;
    const price = [p.price, p.unitPrice, p.salePrice].map(n).find((v) => Number.isFinite(v) && v > 0);
    const qty = [p.quantity, p.qty, p.amountProduct].map(n).find((v) => Number.isFinite(v) && v > 0);
    return price && qty ? price * qty : 0;
  };
  const kindOfProduct = (p) => (/OFFSET/i.test(p.productType || '') ? 'offset' : /CARTON|FLEXO/i.test(p.productType || '') ? 'flexo' : 'other');
  // Tỉ trọng thành tiền theo loại. Mẫu số gồm cả dòng "Khác" (chi phí bản in…) để phần Flexo / Offset không bị cộng lẫn.
  function kindShareOf(products) {
    if (!Array.isArray(products) || !products.length) return undefined;
    const sum = { flexo: 0, offset: 0, other: 0 };
    for (const p of products) sum[kindOfProduct(p)] += lineTotal(p);
    const all = sum.flexo + sum.offset + sum.other;
    if (!all || (!(sum.flexo && sum.offset) && !sum.other)) return undefined; // chỉ 1 loại, không có dòng khác → khỏi chia
    return { flexo: sum.flexo / all, offset: sum.offset / all, other: sum.other / all };
  }
  // NCC giấy của từng loại: mã trước "_" trong kết cấu giấy (PNTP_T140/X120… → PNTP, VS_*/X90… → VS), tìm trong mọi chuỗi của dòng
  function kindSupOf(products) {
    if (!Array.isArray(products) || !products.length) return undefined;
    const out = { flexo: [], offset: [] };
    const strings = (o, depth = 0) =>
      !o || typeof o !== 'object' || depth > 2 ? [] : Object.values(o).flatMap((v) => (typeof v === 'string' ? [v] : strings(v, depth + 1)));
    for (const p of products) {
      const k = kindOfProduct(p);
      if (k === 'other') continue;
      for (const t of strings(p)) {
        const m = t.match(/(?:^|[\s|])([A-Z][A-Z0-9]{1,7})_[A-Z*]{1,2}\d*\//);
        if (m && !out[k].includes(m[1])) out[k].push(m[1]);
      }
    }
    return out.flexo.length || out.offset.length ? out : undefined;
  }
  const slimQuote = (o) => ({
    id: o.id,
    code: o.code,
    name: o.name,
    isRead: o.isRead,
    quoteStatus: o.quoteStatus,
    status: o.status,
    amount: o.totalPrice ?? o.amount,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    // Đã lên đơn hàng Misa (tình trạng báo giá có thể vẫn để Bản thảo)
    hasOrder: !!(o.misaOrderCode || o.misaOrder || o.misaOrders?.length),
    // Đơn tái bản: sản phẩm đã có mã SP (republishType = REPUBLISH)
    isReprint: Array.isArray(o.opportunityProducts) ? o.opportunityProducts.some((p) => p.republishType === 'REPUBLISH') : undefined,
    offset: Array.isArray(o.opportunityProducts) ? o.opportunityProducts.some((p) => /OFFSET/i.test(p.productType || '')) : undefined,
    // Loại hàng: offset (CARTON_OFFSET…) / flexo (thùng carton thường, flexo)
    kinds: Array.isArray(o.opportunityProducts)
      ? [...new Set(o.opportunityProducts.map((p) => (/OFFSET/i.test(p.productType || '') ? 'offset' : /CARTON|FLEXO/i.test(p.productType || '') ? 'flexo' : null)).filter(Boolean))]
      : undefined,
    // Tỉ trọng thành tiền theo loại hàng (báo giá vừa Flexo vừa Offset): % Flexo / Offset tính trên phần tiền của loại đó
    kindShare: kindShareOf(o.opportunityProducts),
    kindSup: kindSupOf(o.opportunityProducts),
    // NVKD = người phụ trách khách (cột Sale của ERP); creator = người tạo báo giá
    staff: person(saleOf(o)?.v || o.staff),
    creator: person(o.staff),
    staffKey: saleOf(o)?.k || 'staff',
    people: peopleOf(o),
    customer: o.customer ? { id: o.customer.id, code: o.customer.code || undefined, name: o.customer.name } : undefined,
  });
  const slimComment = (f) => ({
    id: f.id,
    createdAt: f.createdAt,
    text: f.description || '',
    file: f.url ? f.name || 'file' : '',
    staff: person(f.staff),
    children: (f.children || []).map(slimComment),
  });

  // Danh sách thông báo (chuông): dò mảng thông báo trong dữ liệu (không phụ thuộc tên trường),
  // rút gọn mỗi thông báo: nội dung, thời gian, đã đọc/chưa đọc, link / mã báo giá.
  const strip = (t) => String(t || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const pick = (o, keys) => {
    for (const k of keys) if (o?.[k] != null && o[k] !== '') return o[k];
    return undefined;
  };
  function slimNotif(o) {
    const strs = Object.entries(o).filter(([, v]) => typeof v === 'string');
    const text = strip(pick(o, ['content', 'description', 'body', 'message', 'text', 'msg']) ?? strs.map(([, v]) => v).sort((a, b) => b.length - a.length)[0]);
    if (!text) return null;
    // Cờ đã đọc: isRead / read / seen / isSeen / readAt / status 'READ'...
    let read;
    for (const [k, v] of Object.entries(o)) {
      if (/^(is_?)?(read|seen|viewed)$/i.test(k)) read = !!v;
      else if (/^(read|seen)_?at$/i.test(k)) read = v != null && v !== '';
      else if (/^(is_?)?unread$/i.test(k)) read = !v;
    }
    if (read === undefined && typeof o.status === 'string' && /read|seen|unread|new/i.test(o.status)) read = /^(read|seen)$/i.test(o.status);
    const data = o.data && typeof o.data === 'object' ? o.data : {};
    return {
      id: o.id ?? o._id,
      title: strip(pick(o, ['title', 'name', 'subject', 'type'])),
      text,
      read,
      at: pick(o, ['createdAt', 'created_at', 'createdDate', 'created', 'sentAt', 'time', 'date', 'updatedAt']),
      link: pick(o, ['link', 'url', 'path', 'href']) ?? pick(data, ['link', 'url', 'path']),
      oppId: pick(o, ['opportunityId', 'objectId', 'refId']) ?? o.opportunity?.id ?? pick(data, ['opportunityId', 'id']),
    };
  }
  const notifIds = new Set();
  function emitNotifs(d) {
    let best = null;
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 4) return;
      if (Array.isArray(o)) {
        const objs = o.filter((x) => x && typeof x === 'object' && !Array.isArray(x) && (x.id ?? x._id) != null);
        if (objs.length && (!best || objs.length > best.length)) best = objs;
        return;
      }
      Object.values(o).forEach((v) => walk(v, depth + 1));
    };
    walk(d, 0);
    const list = (best || []).map(slimNotif).filter((n) => n && n.id != null);
    list.forEach((n) => notifIds.add(String(n.id)));
    if (list.length) emit('notifs', list);
  }

  // Rút gọn 1 đơn hàng Misa (dùng chung cho trang khách hàng và trang danh sách đơn hàng)
  const mapOrder = (o) => {
        const lines = (o.misaOrderDetails || []).map((x) => {
          const op = x.opportunityProduct || {};
          const price = x.price || op.price || 0;
          return {
            product: x.productionCode || x.productId || '',
            name: x.description || op.name || '',
            qty: x.quantity || 0,
            delivered: x.deliveredQuantity || 0,
            price,
            total: x.totalPrice || (price && x.quantity ? price * x.quantity : op.totalPrice || 0),
          };
        });
        // Các trường tiền của đơn (để tìm đúng "tổng sau VAT"): mọi số ở cấp đơn có tên chứa total/amount/vat/tax/pay/money
        const amounts = {};
        for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && /total|amount|vat|tax|pay|money|price/i.test(k)) amounts[k] = v;
        const l0 = (o.misaOrderDetails || [])[0] || {};
        for (const [k, v] of Object.entries(l0)) if (typeof v === 'number' && /vat|tax/i.test(k)) amounts[`line.${k}`] = v;
        const lineVat = (o.misaOrderDetails || []).reduce((a, x) => a + (Number(x.vatAmount ?? x.taxAmount ?? x.amountVat ?? 0) || 0), 0);
        const preVat = lines.reduce((a, l) => a + (l.total || 0), 0);
        // Tổng sau VAT: trường tổng thanh toán của đơn nếu có, không thì tiền hàng + VAT từng dòng
        const totalVat =
          o.totalPayment ?? o.totalAmountWithVat ?? o.totalWithVat ?? o.totalAfterVat ?? (lineVat ? preVat + lineVat : undefined);
        return {
          id: o.id,
          code: o.code,
          amounts,
          totalVat: typeof totalVat === 'number' ? totalVat : undefined,
          at: o.orderedAt || o.createdAt,
          status: o.status,
          deliveryDate: (o.deliveryDate || '').slice(0, 10),
          quote: o.opportunity?.code || '',
          total: lines.reduce((a, l) => a + (l.total || 0), 0),
          lines,
        };
      };

  // Trang Công nợ (/cong-no): chưa rõ cấu trúc → lấy mảng bản ghi lớn nhất trong dữ liệu trả về, rút gọn từng bản ghi
  const slimAny = (o) => {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) {
      if (v == null) continue;
      if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
      else if (typeof v === 'string') out[k] = v.length > 200 ? v.slice(0, 200) : v;
      else if (typeof v === 'object' && !Array.isArray(v)) {
        const sub = {};
        for (const kk of ['id', 'code', 'name', 'fullName', 'shortName', 'phone']) if (v[kk] != null) sub[kk] = v[kk];
        for (const kk of ['staff', 'sale', 'user', 'customer']) if (v[kk]?.name) sub[kk] = v[kk].name;
        if (Object.keys(sub).length) out[k] = sub;
      } else if (Array.isArray(v)) out[`${k}#`] = v.length;
    }
    return out;
  };
  const biggestArray = (d) => {
    let best = null;
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 3) return;
      if (Array.isArray(o)) {
        if (o.length && typeof o[0] === 'object' && (!best || o.length > best.length)) best = o;
        return;
      }
      Object.values(o).forEach((v) => walk(v, depth + 1));
    };
    walk(d, 0);
    return best;
  };
  function handleDebt(url, json) {
    const d = json?.data ?? json;
    const arr = biggestArray(d);
    if (!arr) return;
    let path = url;
    try {
      const u = new URL(url, location.href);
      path = u.pathname + u.search;
    } catch {}
    emit('debtRows', { url: path, page: location.pathname + location.search, total: d?.total ?? d?.count ?? undefined, rows: arr.slice(0, 500).map(slimAny) });
  }

  // Trang Công nợ: bắt MỌI phản hồi JSON (không chỉ API :8080/v1/admin) + ghi lại danh sách API để chẩn đoán
  function debtAny(url, body) {
    if (!/^\/cong-no\b/.test(location.pathname) || /\.(js|css|png|jpe?g|svg|woff2?)(\?|$)/i.test(url || '')) return;
    let json = body;
    if (typeof body === 'string') {
      try {
        json = JSON.parse(body);
      } catch {
        return;
      }
    }
    if (!json || typeof json !== 'object') return;
    emit('debtUrl', { url: String(url).slice(0, 300), keys: Object.keys(json.data ?? json).slice(0, 20) });
    handleDebt(url, json);
  }

  function handle(url, text) {
    if (/^\/cong-no\b/.test(location.pathname)) debtAny(url, text);
    if (!API.test(url)) return;
    let d;
    try {
      d = JSON.parse(text)?.data;
    } catch {
      return;
    }
    if (!d) return;

    // Người đang đăng nhập (để gợi ý bình luận xưng hô cho đúng)
    if (/\/auth\/profile\b/.test(url)) {
      const name = d.name || d.staff?.name;
      // Kèm thông tin quyền để phân biệt quản trị / NVKD (báo cáo tuần: NVKD chỉ xem của mình)
      const roleOf = (r) => (typeof r === 'string' ? r : r?.name || r?.code || r?.title || '');
      const role = [roleOf(d.role), d.roleName, ...(Array.isArray(d.roles) ? d.roles.map(roleOf) : []), roleOf(d.position), roleOf(d.staff?.role)]
        .filter(Boolean)
        .join(', ');
      if (name) emit('me', { id: d.id, name, username: d.username || d.userName || d.account || '', role, isAdmin: d.isAdmin ?? d.admin ?? undefined });
      return;
    }
    // Thông báo (chuông): tìm các câu "X đã bàn giao khách hàng Y cho nhân viên Z" ở bất kỳ đâu trong dữ liệu
    if (/noti/i.test(url)) {
      const found = [];
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach(walk);
        for (const v of Object.values(o)) {
          if (typeof v === 'string' && v.includes('đã bàn giao khách hàng')) {
            found.push({ text: v.replace(/<[^>]*>/g, ' '), at: o.createdAt ?? o.created_at ?? o.time });
          } else walk(v);
        }
      };
      walk(d);
      if (found.length) emit('handovers', found);
      emitNotifs(d);
      return;
    }
    // Danh sách báo giá (trang /bao-gia)
    if (/\/opportunity\?/.test(url) && /[?&]type=2\b/.test(url) && Array.isArray(d.opportunities)) {
      // Vị trí trên danh sách ERP (để sắp xếp y như ERP)
      const page = Number(url.match(/[?&]page=(\d+)/)?.[1] || 1);
      const limit = Number(url.match(/[?&]limit=(\d+)/)?.[1] || d.opportunities.length || 100);
      const at = Math.floor(Date.now() / 1000);
      emit('quotes', d.opportunities.map((o, i) => ({ ...slimQuote(o), erpRank: (page - 1) * limit + i, erpRankAt: at })));
      return;
    }
    // Chi tiết 1 báo giá – mở trang chi tiết thì ERP tự đánh dấu đã đọc
    if (/\/opportunity\/\d+\?isCheckPermission/.test(url) && d.id) {
      const q = slimQuote(d);
      // Người dùng mở trang chi tiết → CRM đánh dấu đã đọc (khung thu thập ngầm thì không: đã chặn lệnh /read)
      if (!COLLECTOR_FRAME) {
        q.isRead = true;
        q.readAt = Math.floor(Date.now() / 1000);
      } else delete q.isRead;
      emit('quote', q);
      return;
    }
    // Lịch sử mua hàng của khách (trang khách hàng → tab đơn hàng)
    if (/\/misaOrder\?/.test(url) && /[?&]customerId=\d+/.test(url) && Array.isArray(d.misaOrders)) {
      const customerId = Number(url.match(/[?&]customerId=(\d+)/)[1]);
      const orders = d.misaOrders.map(mapOrder);
      emit('orders', { customerId, total: d.total ?? orders.length, orders });
      return;
    }
    // Trang Đơn hàng Misa (/misa-order/list): đơn của mọi khách → gom theo khách, kèm tên khách và NVKD phụ trách
    if (/\/misaOrder\?/.test(url) && Array.isArray(d.misaOrders)) {
      const byCust = {};
      for (const o of d.misaOrders) {
        const c = o.customer || o.opportunity?.customer || {};
        const cid = c.id ?? o.customerId ?? o.opportunity?.customerId;
        if (!cid) continue;
        const sale = c.staff || c.sale || o.staff || o.opportunity?.staff;
        const cname = c.name || c.fullName || c.companyName || c.customerName || c.misaCustomer?.name || o.customerName || o.misaCustomer?.name || undefined;
        (byCust[cid] ||= { customerId: cid, customer: { name: cname, code: c.code || c.shortName || undefined, staff: sale?.name || undefined }, orders: [] }).orders.push(mapOrder(o));
      }
      const list = Object.values(byCust);
      if (list.length) emit('ordersAll', list);
      return;
    }
    // Bình luận: ERP lưu dưới dạng fileAttach (bình luận gốc + children là trả lời)
    if (/\/fileAttach\?/.test(url) && Array.isArray(d.fileAttaches)) {
      const byOpp = {};
      for (const f of d.fileAttaches) {
        const o = f.opportunity;
        if (!o?.id) continue;
        // Khách của báo giá (để gom bình luận mọi báo giá cùng khách)
        const cust = o.customer?.id ?? o.customerId ?? f.customer?.id ?? f.customerId ?? Number(url.match(/[?&]customerId=(\d+)/)?.[1]) ?? undefined;
        (byOpp[o.id] ||= { id: o.id, code: o.code, customerId: cust || undefined, threads: [] }).threads.push(slimComment(f));
      }
      const list = Object.values(byOpp);
      if (list.length) emit('comments', list);
    }
  }

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  // Khung thu thập ngầm (iframe name="dg-collector", do panel.js tạo): CHỈ ĐỌC.
  // Chặn mọi lệnh ghi và lệnh đánh dấu đã đọc, để báo giá chưa đọc vẫn in đậm và không có gì bị sửa.
  const COLLECTOR = COLLECTOR_FRAME;
  const blocked = (method, url) =>
    COLLECTOR && (String(method || 'GET').toUpperCase() !== 'GET' || /\/opportunity\/\d+\/read\b/.test(String(url)));

  // ---- Đồng bộ "đã đọc" thông báo lên CRM ----
  // Không đoán API: khi người dùng bấm 1 thông báo trong chuông, CRM gửi 1 lệnh (PUT/POST…) có id thông báo.
  // Ghi lại mẫu lệnh đó (id → {id}) vào localStorage; header đăng nhập lấy từ chính các request của trang
  // (chỉ giữ trong bộ nhớ). Bảng 📊 phát sự kiện "dg:notifRead" → gửi lại đúng lệnh đó với id mới.
  const TPL_KEY = 'dgNotifReadTpl';
  let lastHeaders = null;
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    (this.__dgH ||= {})[k] = v;
    return setHeader.apply(this, arguments);
  };
  function learnReadTpl(method, url, body) {
    if (COLLECTOR || /^GET$/i.test(method) || !/noti/i.test(url) || !API.test(url)) return;
    const b = typeof body === 'string' ? body : '';
    const path = url.split('?');
    for (const id of notifIds) {
      // id phải là 1 đoạn đường dẫn / giá trị query (/123/, ?id=123) hoặc 1 giá trị trong JSON ([123], "id":123, "123")
      const inUrl = new RegExp(`([/=])${id}(?=[/&?#]|$)`, 'g');
      const inBody = new RegExp(`([\\[:,\\s"])${id}(?=[\\]},\\s"])`, 'g');
      if (!inUrl.test(path[0] + (path[1] ? '?' + path[1] : '')) && !(b && new RegExp(inBody.source).test(b))) continue;
      try {
        localStorage.setItem(TPL_KEY, JSON.stringify({ method: method.toUpperCase(), url: url.replace(inUrl, '$1{id}'), body: b ? b.replace(inBody, '$1{id}') : '', at: Date.now() }));
      } catch {}
      return;
    }
  }
  document.addEventListener('dg:notifRead', (e) => {
    let tpl;
    try {
      tpl = JSON.parse(localStorage.getItem(TPL_KEY) || 'null');
    } catch {}
    const id = String(e.detail || '');
    if (!tpl || !id || COLLECTOR) return;
    const x = new XMLHttpRequest();
    x.open(tpl.method, tpl.url.replaceAll('{id}', id));
    for (const [k, v] of Object.entries(lastHeaders || {})) {
      try {
        x.setRequestHeader(k, v);
      } catch {}
    }
    x.addEventListener('loadend', () => emit('notifReadDone', { id, ok: x.status >= 200 && x.status < 300, status: x.status }));
    x.send(tpl.body ? tpl.body.replaceAll('{id}', id) : null);
  });

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dgUrl = String(url);
    this.__dgMethod = String(method || 'GET');
    this.__dgBlocked = blocked(method, url);
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__dgBlocked) return; // không gửi
    this.addEventListener('load', () => {
      try {
        authSignal(this.status, this.responseURL || this.__dgUrl);
        if (this.status >= 200 && this.status < 300 && API.test(this.__dgUrl)) {
          if (this.__dgH) lastHeaders = this.__dgH; // header đăng nhập hiện tại của trang
          learnReadTpl(this.__dgMethod, this.__dgUrl, body);
        }
        if (this.status === 200 && (this.responseType === '' || this.responseType === 'text')) {
          handle(this.responseURL || this.__dgUrl, this.responseText);
        } else if (this.status === 200 && this.responseType === 'json' && /^\/cong-no\b/.test(location.pathname)) {
          debtAny(this.responseURL || this.__dgUrl, this.response);
        }
      } catch (e) {
        console.warn('[DG hook]', e);
      }
    });
    return send.apply(this, arguments);
  };

  // Phiên đăng nhập: API trả 401 → đã bị đăng xuất; trả 2xx → đang đăng nhập. Báo cho bảng 📊 để ẩn / hiện dữ liệu.
  let authOk = null;
  const authSignal = (status, url) => {
    if (!API.test(url || '')) return;
    const ok = status === 401 ? false : status >= 200 && status < 300 ? true : null;
    if (ok == null || ok === authOk) return;
    authOk = ok;
    emit('auth', { ok, at: Date.now() });
  };
  if (/^\/login\b/.test(location.pathname) && !COLLECTOR_FRAME) setTimeout(() => emit('auth', { ok: false, at: Date.now() }), 0);

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url0 = typeof input === 'string' ? input : input?.url;
    if (blocked(init?.method || input?.method, url0)) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input.url;
      authSignal(res.status, url);
      if (res.ok && API.test(url) && init?.headers) lastHeaders = Object.fromEntries(new Headers(init.headers));
      if (res.ok) learnReadTpl(init?.method || input?.method || 'GET', url, init?.body);
      if (API.test(url) && res.ok) res.clone().text().then((t) => handle(url, t)).catch(() => {});
      else if (res.ok && /^\/cong-no\b/.test(location.pathname)) res.clone().text().then((t) => debtAny(url, t)).catch(() => {});
    } catch {}
    return res;
  };
})();

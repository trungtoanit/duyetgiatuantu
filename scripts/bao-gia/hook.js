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
  let lastChiet = '';
  function readChiet(f) {
    try {
      if (COLLECTOR_FRAME && f.contentWindow) f.contentWindow.print = () => {};
      const t = f.contentDocument?.body?.innerText || '';
      const pct = t.match(/Đang bán\s*\((\d+(?:[.,]\d+)?)%\)/);
      const code = t.match(/CHIẾT GIÁ\s*#?(BG\d+)/i);
      if (!pct || !code || t === lastChiet) return;
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
      const val = (re) => (t.match(re)?.[1] || '').trim();
      emit('margin', {
        code: code[1].toUpperCase(),
        pct: Number(pct[1].replace(',', '.')),
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

  const API = /:8080\/v1\/admin\//;
  const emit = (kind, data) =>
    document.dispatchEvent(new CustomEvent('dg:data', { detail: JSON.stringify({ kind, data }) }));

  const person = (s) => (s ? { id: s.id, name: s.name, avatar: s.avatar || undefined } : undefined);
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
    staff: person(o.staff),
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

  function handle(url, text) {
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
      if (name) emit('me', { id: d.id, name });
      return;
    }
    // Danh sách báo giá (trang /bao-gia)
    if (/\/opportunity\?/.test(url) && /[?&]type=2\b/.test(url) && Array.isArray(d.opportunities)) {
      emit('quotes', d.opportunities.map(slimQuote));
      return;
    }
    // Chi tiết 1 báo giá – mở trang chi tiết thì ERP tự đánh dấu đã đọc
    if (/\/opportunity\/\d+\?isCheckPermission/.test(url) && d.id) {
      const q = slimQuote(d);
      q.isRead = true;
      emit('quote', q);
      return;
    }
    // Lịch sử mua hàng của khách (trang khách hàng → tab đơn hàng)
    if (/\/misaOrder\?/.test(url) && /[?&]customerId=\d+/.test(url) && Array.isArray(d.misaOrders)) {
      const customerId = Number(url.match(/[?&]customerId=(\d+)/)[1]);
      const orders = d.misaOrders.map((o) => {
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
        return {
          id: o.id,
          code: o.code,
          at: o.orderedAt || o.createdAt,
          status: o.status,
          deliveryDate: (o.deliveryDate || '').slice(0, 10),
          quote: o.opportunity?.code || '',
          total: lines.reduce((a, l) => a + (l.total || 0), 0),
          lines,
        };
      });
      emit('orders', { customerId, total: d.total ?? orders.length, orders });
      return;
    }
    // Bình luận: ERP lưu dưới dạng fileAttach (bình luận gốc + children là trả lời)
    if (/\/fileAttach\?/.test(url) && Array.isArray(d.fileAttaches)) {
      const byOpp = {};
      for (const f of d.fileAttaches) {
        const o = f.opportunity;
        if (!o?.id) continue;
        (byOpp[o.id] ||= { id: o.id, code: o.code, threads: [] }).threads.push(slimComment(f));
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

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dgUrl = String(url);
    this.__dgBlocked = blocked(method, url);
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__dgBlocked) return; // không gửi
    this.addEventListener('load', () => {
      try {
        if (this.status === 200 && (this.responseType === '' || this.responseType === 'text')) {
          handle(this.responseURL || this.__dgUrl, this.responseText);
        }
      } catch (e) {
        console.warn('[DG hook]', e);
      }
    });
    return send.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url0 = typeof input === 'string' ? input : input?.url;
    if (blocked(init?.method || input?.method, url0)) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input.url;
      if (API.test(url) && res.ok) res.clone().text().then((t) => handle(url, t)).catch(() => {});
    } catch {}
    return res;
  };
})();

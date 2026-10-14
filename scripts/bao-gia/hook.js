// Chạy trong world MAIN, trước khi app ERP khởi động.
// Chỉ "nghe" các phản hồi API mà chính trang ERP tải về (không tự gọi API),
// rút gọn rồi chuyển sang panel.js qua sự kiện DOM "dg:data".
(() => {
  if (window.__dgHooked) return;
  window.__dgHooked = true;

  const API = /:8080\/v1\/admin\//;
  const emit = (kind, data) =>
    document.dispatchEvent(new CustomEvent('dg:data', { detail: JSON.stringify({ kind, data }) }));

  const person = (s) => (s ? { id: s.id, name: s.name } : undefined);
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
    staff: person(o.staff),
    customer: o.customer ? { id: o.customer.id, name: o.customer.name } : undefined,
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
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dgUrl = String(url);
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
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
  window.fetch = async function (input) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input.url;
      if (API.test(url) && res.ok) res.clone().text().then((t) => handle(url, t)).catch(() => {});
    } catch {}
    return res;
  };
})();

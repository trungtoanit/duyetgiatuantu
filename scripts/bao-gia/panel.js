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

  // Khoảng thời gian kiểu nói tự nhiên: "13 giờ", "5 ngày", "2 tuần", "3 tháng"
  const humanDuration = (hours) => {
    if (hours < 24) return `${Math.max(1, Math.floor(hours))} giờ`;
    const d = hours / 24;
    if (d < 14) return `${Math.floor(d)} ngày`;
    if (d < 60) return `${Math.round(d / 7)} tuần`;
    return `${Math.round(d / 30)} tháng`;
  };

  // Danh sách "Cần chào lại" bỏ những khách đang có báo giá trong danh sách "Quá 12 giờ"
  // (khách đó đang được hỏi theo báo giá khác rồi)
  const custKey = (q) => (q?.customer?.id ? `id:${q.customer.id}` : q?.customer?.code ? `code:${q.customer.code}` : null);
  function staleList(quotes, comments, overdue = listByMode(quotes, comments, 'hoiNhanh')) {
    const active = new Set(overdue.map(({ q }) => custKey(q)).filter(Boolean));
    return listByMode(quotes, comments, 'chaoLai').filter(({ q }) => !active.has(custKey(q)));
  }

  const ago = (sec) => {
    const h = hoursSince(sec);
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
      for (const q of data) patch[q.id] = definedOnly(q);
      await kvMerge('quotes', patch);
    } else if (kind === 'quote') {
      const cur = await kvGet('quotes');
      await kvMerge('quotes', { [data.id]: { ...cur[data.id], ...definedOnly(data) } });
    } else if (kind === 'comments') {
      const cur = await kvGet('comments');
      const patch = {};
      for (const c of data) {
        patch[c.id] = { id: c.id, code: c.code, threads: mergeThreads(cur[c.id]?.threads, c.threads) };
      }
      await kvMerge('comments', patch);
    }
    render();
  }

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
    lines.push(`NVKD phụ trách: ${staffOf(q, c) || '?'}`, 'Bình luận (theo thời gian):');
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
    // Luôn cân nhắc hỏi ở gợi ý bình thường và chế độ chào lại (không gộp vào hỏi nhanh / tình huống đặc biệt)
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
    chaoLai: ['Chào lại khách hàng này chưa? Khách còn các dự án thùng khác không?'],
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
          'Giá này khách có ý kiến gì không em? Cần anh điều chỉnh gì thì báo anh nhé.',
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
    ],
  };
  const tinhHuongText = () =>
    BO_CAU_HOI.tinhHuong
      .map((t) =>
        Array.isArray(t.hoi)
          ? `- Khi ${t.khi}:\n  → hỏi theo MỘT trong các phiên bản sau (dùng đúng số phiên bản đề bài chỉ định, chỉ đổi xưng hô cho đúng):\n${t.hoi.map((h, i) => `     ${i + 1}. ${h}`).join('\n')}`
          : `- Khi ${t.khi}:\n  → hỏi: ${t.hoi}`,
      )
      .join('\n');
  const maxVariants = () => Math.max(1, ...BO_CAU_HOI.tinhHuong.map((t) => (Array.isArray(t.hoi) ? t.hoi.length : 1)));

  const list = (arr) => arr.map((q) => `- ${q}`).join('\n');

  const SUGGEST_SYSTEM = `Bạn giúp quản lý kinh doanh của Tuấn Tú (bao bì giấy carton) viết MỘT bình luận để đăng vào phần bình luận của báo giá trên CRM, hỏi nhân viên kinh doanh (NVKD) về bước tiếp theo.

BỘ CÂU HỎI NHÂN VIÊN

ĐƠN TÁI BẢN – ưu tiên cao nhất. Nếu đề bài ghi "ĐƠN TÁI BẢN" thì CHỈ viết đúng 1 câu: ${BO_CAU_HOI.taiBan}. Có thể mở đầu bằng "<thời gian> chưa có phản hồi, báo cáo lại nhé" nếu im lặng từ 3 ngày trở lên. Không hỏi gì khác, bỏ qua mọi chế độ và tình huống bên dưới.

TÌNH HUỐNG ĐẶC BIỆT – kiểm tra TRƯỚC TIÊN (sau đơn tái bản). Nếu bình luận gần nhất của NVKD khớp một tình huống dưới đây thì chỉ viết 1 câu ngắn hỏi đúng câu của tình huống đó – KHÔNG gộp thêm câu nào khác (kể cả câu tới công ty khách xem quy mô), bỏ qua chế độ hỏi nhanh/chào lại:
${tinhHuongText()}

Câu luôn cân nhắc hỏi – dùng ở gợi ý bình thường và chế độ chào lại; KHÔNG dùng ở chế độ hỏi nhanh và tình huống đặc biệt (bỏ qua nếu luồng bình luận đã có câu trả lời):
${list(BO_CAU_HOI.luonHoi)}

Câu hỏi theo giai đoạn (chọn những câu hợp với tình hình thực tế của luồng bình luận):
${list(BO_CAU_HOI.theoGiaiDoan)}

Nếu đề bài ghi "CHẾ ĐỘ HỎI NHANH" (đã quá 12 giờ từ bình luận cuối mà báo giá chưa chốt): CHỈ viết 1 câu ngắn theo ý sau, KHÔNG gộp thêm câu nào khác (kể cả câu tới công ty khách xem quy mô), không nhắc lại nội dung báo giá, không đánh số, không hẹn giờ:
${list(BO_CAU_HOI.hoiNhanh)}

Nếu đề bài ghi "CHẾ ĐỘ CHÀO LẠI" (báo giá đã thất bại hoặc im lặng quá ${MAX_FOLLOW_UP_DAYS} ngày): viết 1–2 câu ngắn nhắc NVKD chào lại khách theo các ý sau, không gộp thêm câu nào khác. Có thể nhắc 1 chi tiết từ luồng nếu giúp NVKD có cớ chào lại (vd. phương án mới đã chốt trong luồng), nhưng không hỏi lại chuyện giá cũ, không đánh số:
${list([...BO_CAU_HOI.chaoLai, ...BO_CAU_HOI.luonHoi])}

Quy tắc:
- Bạn viết THAY quản lý, như chính quản lý tự gõ. Đọc kỹ phần "VĂN PHONG" (các bình luận thật của quản lý) và bắt chước sát: cách xưng hô với từng NVKD (ví dụ quản lý xưng "em" và gọi NVKD nữ lớn tuổi hơn là "chị" thì làm y như vậy), độ dài câu, từ hay dùng, viết tắt, dấu câu, mức độ thân mật. Ưu tiên ví dụ nói với đúng NVKD này.
- Tuyệt đối không viết giọng văn mẫu, công sở hay "AI". Không mở đầu bằng lời chào dài, không cảm ơn, không ký tên. Nếu quản lý hay viết ngắn gọn thì viết ngắn gọn.
- Chỉ đánh số câu hỏi nếu thật cần (từ 3 ý trở lên); 1–2 ý thì viết liền tự nhiên như nhắn tin.
- Khi nhắc khoảng thời gian NVKD im lặng, nói đúng kiểu: "<khoảng thời gian> chưa có phản hồi, báo cáo lại nhé" (vd. "2 tuần chưa có phản hồi, báo cáo lại nhé"), dùng đúng khoảng thời gian đề bài đưa. KHÔNG viết "chưa có cập nhật". Ở chế độ hỏi nhanh / chào lại, nếu im lặng từ 3 ngày trở lên thì mở đầu bằng câu này rồi mới hỏi (vẫn ngắn gọn).
- Không hỏi lại những điều đã được trả lời trong luồng (vd. luồng đã nói đã tới công ty khách / đã gặp khách thì không hỏi lại). Tối đa 3 ý hỏi.
- Ở gợi ý bình thường (không phải hỏi nhanh / chào lại / tình huống đặc biệt): kết thúc bằng câu "${BO_CAU_HOI.ketThuc}" (chỉ đổi xưng hô cho đúng). KHÔNG hẹn giờ cụ thể kiểu "phản hồi trước 11h hôm nay".
- Nếu chưa có ví dụ văn phong: viết ngắn, thân mật, kiểu nhắn tin nội bộ.
- Chỉ trả về đúng nội dung bình luận, không giải thích, không dùng markdown.`;

  async function suggestComment(id) {
    const key = `c:${id}`;
    setBusy(key, true);
    try {
      const [quotes, comments, me] = await Promise.all([kvGet('quotes'), kvGet('comments'), kvGet('me')]);
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
        `Nếu khớp tình huống có nhiều phiên bản câu hỏi: dùng phiên bản số ${1 + Math.floor(Math.random() * maxVariants())} (nếu tình huống có ít phiên bản hơn thì lấy phiên bản cuối).`,
        noPrice(q)
          ? 'BÁO GIÁ ĐANG 0đ: quản lý CHƯA cho giá. KHÔNG hỏi NVKD "giá đạt chưa / khách phản hồi giá"; nếu cần thì chỉ hỏi NVKD còn thiếu thông tin gì để quản lý tính giá.'
          : '',
        q?.isReprint ? 'ĐƠN TÁI BẢN: sản phẩm của báo giá đã có mã SP (tái bản) – chỉ hỏi khách xuống đơn tái bản chưa.' : '',
        mode === 'hoiNhanh'
          ? `CHẾ ĐỘ HỎI NHANH: đã quá ${FOLLOW_UP_HOURS} giờ từ bình luận cuối mà báo giá chưa chốt – chỉ 1 câu ngắn theo các ý hỏi nhanh (trừ khi khớp TÌNH HUỐNG ĐẶC BIỆT).`
          : '',
        mode === 'chaoLai'
          ? `CHẾ ĐỘ CHÀO LẠI: báo giá ${q?.quoteStatus === 'REJECT' ? 'đã thất bại' : `im lặng đã ${Math.floor(hours / 24)} ngày`} – nhắc NVKD chào lại khách, hỏi khách còn dự án thùng khác không (trừ khi khớp TÌNH HUỐNG ĐẶC BIỆT).`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      const text = await call({
        type: 'claude',
        system: SUGGEST_SYSTEM,
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
  async function sendComment(text, code) {
    if (!text.trim()) throw new Error('Nội dung bình luận đang trống.');
    const ta = (await openReplyBox(code)) || findCommentBox();
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
  const COLLECT = { listPages: 5, perRun: 30, gapMs: 4000, waitMs: 20000, refreshHours: 6, maxAgeDays: 60, everyMin: 30, autoSuggest: 10 };
  const collect = { running: false, done: 0, total: 0, current: '', suggested: 0, lastRun: 0 };
  const TAB_ID = Math.random().toString(36).slice(2);

  // auto: thu thập ngầm; autoOpen: tự mở bảng khi vào trang báo giá
  const getSettings = async () => ({ auto: true, autoOpen: false, ...(await kvGet('settings')) });

  function pickQueue(quotes, comments, collected) {
    const now = Date.now() / 1000;
    const isOpenQuote = (q) => !CLOSED.has(q.quoteStatus) && !hasOrder(q, comments[q.id]);
    return Object.values(quotes)
      .filter((q) => q.id && q.createdAt && now - q.createdAt < COLLECT.maxAgeDays * 86400 && !isExcluded(q.staff?.name))
      .filter((q) => !collected[q.id] || (isOpenQuote(q) && now - collected[q.id] > COLLECT.refreshHours * 3600))
      .sort(
        (a, b) =>
          !!collected[a.id] - !!collected[b.id] || // chưa thu thập lần nào trước
          (a.isRead === false ? 0 : 1) - (b.isRead === false ? 0 : 1) || // chưa đọc trước
          b.createdAt - a.createdAt,
      )
      .slice(0, COLLECT.perRun);
  }

  async function loadInFrame(id) {
    const f = document.createElement('iframe');
    f.name = 'dg-collector';
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:900px;visibility:hidden;pointer-events:none';
    f.src = `/co-hoi/update/${id}`;
    document.documentElement.append(f);
    const start = Date.now();
    try {
      while (Date.now() - start < COLLECT.waitMs) {
        await sleep(500);
        let done = false;
        try {
          done = f.contentWindow.performance.getEntriesByType('resource').some((e) => /\/fileAttach\?/.test(e.name));
        } catch {}
        if (done) {
          await sleep(2500); // chờ panel.js trong iframe lưu xong
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

  async function collectListPages() {
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
      for (let page = 2; page <= COLLECT.listPages; page++) {
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

  async function takeLock() {
    const lock = await kvGet('collectLock');
    if (lock?.tab && lock.tab !== TAB_ID && Date.now() - lock.at < 90000) return false; // tab khác đang chạy
    await call({ type: 'kv.set', key: 'collectLock', value: { tab: TAB_ID, at: Date.now() } });
    return true;
  }

  async function runCollector(force = false) {
    if (!IS_TOP || collect.running) return;
    if (!force && !(await getSettings()).auto) return;
    if (!(await takeLock())) return;
    collect.running = true;
    collect.done = 0;
    collect.suggested = 0;
    try {
      await collectListPages();
      const [quotes, comments, collected] = await Promise.all([kvGet('quotes'), kvGet('comments'), kvGet('collected')]);
      const queue = pickQueue(quotes, comments, collected);
      collect.total = queue.length;
      progress();
      for (const q of queue) {
        if (!force && !(await getSettings()).auto) break;
        collect.current = q.code;
        progress();
        await loadInFrame(q.id);
        await kvMerge('collected', { [q.id]: Math.floor(Date.now() / 1000) });
        await call({ type: 'kv.set', key: 'collectLock', value: { tab: TAB_ID, at: Date.now() } });
        collect.done++;
        await sleep(COLLECT.gapMs);
      }
      // Tự phân tích: soạn gợi ý cho các báo giá cần hỏi lại mà chưa có gợi ý mới hơn bình luận cuối
      collect.current = 'phân tích';
      progress();
      const [q2, c2, sg] = await Promise.all([kvGet('quotes'), kvGet('comments'), kvGet('suggests')]);
      const need = [...listByMode(q2, c2, 'hoiNhanh'), ...staleList(q2, c2)]
        .filter(({ c, last }) => !sg[c.id] || sg[c.id].at / 1000 < last.createdAt)
        .slice(0, COLLECT.autoSuggest);
      for (const { c } of need) {
        await suggestComment(c.id);
        collect.suggested++;
      }
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

  if (IS_TOP) {
    setTimeout(() => runCollector(), 15000);
    setInterval(() => runCollector(), COLLECT.everyMin * 60 * 1000);
    // Nút "Chạy ngay" trong popup extension ghi kv collectNow = thời điểm bấm
    let handledNow = Date.now();
    setInterval(async () => {
      const t = await call({ type: 'kv.get', key: 'collectNow' }).catch(() => null);
      if (typeof t === 'number' && t > handledNow && !collect.running) {
        handledNow = t;
        runCollector(true);
      }
    }, 3000);
  }

  // ---------- Giao diện ----------
  const state = { busy: new Set(), error: null };
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
    .panel { position: fixed; left: 16px; bottom: 64px; z-index: 2147483647; width: min(860px, calc(100vw - 32px));
      max-height: calc(100vh - 88px); overflow: auto; background: #fff; color: #1f2328; border-radius: 12px; font-size: 14px;
      box-shadow: 0 10px 40px rgba(0,0,0,.3); padding: 18px 22px; }
    .panel[hidden] { display: none; }
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
    .unread a.item { display: flex; align-items: center; gap: 16px; padding: 8px 0; }
    .item-main { flex: 1; min-width: 0; }
    .item-amt { flex: none; min-width: 150px; text-align: right; font-size: 16px; font-weight: 800; color: #047857;
      font-variant-numeric: tabular-nums; white-space: nowrap; }
    .item-amt .noprice { margin-left: 0; }
    .unread a:last-child { border-bottom: 0; }
    textarea.suggest-edit { width: 100%; min-height: 110px; border: 1px solid #c8d6f5; border-radius: 8px; padding: 10px;
      background: #eef4ff; font: inherit; line-height: 1.5; resize: vertical; margin-top: 8px; color: inherit; }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
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
    .x { border: 0; background: none; font-size: 18px; cursor: pointer; color: #656d76; }
  `;

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'dg-root';
    document.documentElement.append(host);
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><button class="fab">📊 Đánh giá NVKD</button><div class="panel" hidden></div>`;
    root.querySelector('.fab').onclick = () => {
      const p = root.querySelector('.panel');
      p.hidden = !p.hidden;
      if (!p.hidden) render();
    };
    root.querySelector('.panel').addEventListener('click', onClick);
    resumeLoading();
    maybeAutoOpen();
    let saveTimer;
    root.querySelector('.panel').addEventListener('input', (e) => {
      const ta = e.target.closest('textarea.suggest-edit');
      if (!ta) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const id = Number(ta.dataset.id);
        const cur = (await kvGet('suggests'))[id] || {};
        await kvMerge('suggests', { [id]: { ...cur, text: ta.value } });
      }, 500);
    });
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
  // Báo giá 0đ = quản lý chưa cho giá
  const noPrice = (q) => q != null && q.amount != null && Number(q.amount) === 0;
  const noPriceTag = (q) => (noPrice(q) ? ' <span class="noprice">⚠️ Chưa cho giá</span>' : '');

  const custTag = (q) =>
    q?.customer?.code ? ` <span class="kh" title="${esc(q.customer.name || '')}">${esc(q.customer.code)}</span>` : '';

  const scoreCls = (s) => (s == null ? '' : s >= 8 ? 'good' : s >= 6 ? 'mid' : 'bad');
  const scoreHtml = (ev) => (ev?.score != null ? `<span class="score ${scoreCls(ev.score)}">${ev.score}/10</span>` : '');

  async function render() {
    if (!root) return;
    try {
      await renderInner();
    } catch (e) {
      console.warn('[DG]', e);
      if (isOpen()) {
        root.querySelector('.panel').innerHTML = `
          <div class="row"><h2>Đánh giá nhân viên kinh doanh</h2><button class="x" data-act="close">×</button></div>
          <div class="err">${esc(e.message || e)}</div>`;
      }
    }
  }

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
    const overdue = listByMode(quotes, comments, 'hoiNhanh');
    const stale = staleList(quotes, comments, overdue);
    const fab = root.querySelector('.fab');
    const alertCount = overdue.length;
    fab.innerHTML = `📊 Đánh giá NVKD${alertCount ? ` <span class="fab-badge">⏰ ${alertCount}</span>` : ''}`;
    // Bảng đang thu gọn mà có báo giá cần hỏi lại → nút nổi nhấp nháy, nảy nhẹ để gây chú ý
    fab.classList.toggle('alert', alertCount > 0 && !isOpen());
    if (!isOpen()) return;
    if (root.activeElement?.classList?.contains('suggest-edit')) return; // đang sửa gợi ý – không vẽ lại
    avatars = avatarIndex(quotes);
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
      current = `
        <h3>Báo giá đang mở</h3>
        <div class="box">
          <div><b>${esc(q?.code || c?.code || '#' + qid)}</b>${custTag(q)} – ${esc(q?.name || '')}<br>
            <span class="muted who">${avatarHtml(staffOf(q, c), 20)}NVKD: ${esc(staffOf(q, c) || '?')} · ${esc(statusLabel(q?.quoteStatus))} · ${c?.threads?.length || 0} luồng bình luận
            ${last ? ` · bình luận cuối ${ago(last.createdAt)}` : ''}</span></div>
          ${noPrice(q) ? `<div class="warn danger">⚠️ Báo giá đang 0đ – chưa cho giá. Cần cho giá trước khi hỏi NVKD.</div>` : ''}
          ${q?.isReprint && !CLOSED.has(q?.quoteStatus) && !hasOrder(q, c) ? `<div class="warn">🔁 Đơn tái bản – chỉ cần hỏi NVKD khách xuống đơn tái bản chưa.</div>` : ''}
          ${mode === 'hoiNhanh' && !q?.isReprint ? `<div class="warn">⏰ Đã quá ${FOLLOW_UP_HOURS} giờ từ bình luận cuối mà báo giá chưa chốt – nên hỏi NVKD giá cả đạt chưa.</div>` : ''}
          ${mode === 'chaoLai' ? `<div class="warn">💤 Báo giá ${q?.quoteStatus === 'REJECT' ? 'đã thất bại' : `im lặng quá ${MAX_FOLLOW_UP_DAYS} ngày`} – nên nhắc NVKD chào lại khách, hỏi khách còn dự án thùng khác không.</div>` : ''}
          <div class="btns">
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

    const cut = (t, n) => (t && t.length > n ? t.slice(0, n) + '…' : t || '');
    // Tổng doanh thu (số tiền báo giá) của một danh sách
    const revenueHtml = (items) => {
      const total = items.reduce((a, { q }) => a + (Number(q?.amount) || 0), 0);
      const zero = items.filter(({ q }) => noPrice(q)).length;
      return (total ? ` <span class="rev">💰 ${money(total)}</span>` : '') + (zero ? ` <span class="noprice">⚠️ ${zero} chưa cho giá</span>` : '');
    };
    const itemHtml = ({ q, c, last }) => `<a class="item" href="/bao-gia/update/${c.id}" data-nav data-code="${esc(q?.code || c.code)}">
      <div class="item-main"><b>${esc(q?.code || c.code)}</b>${custTag(q)}${q?.name ? ` – ${esc(cut(q.name, 70))}` : ''}<br><span class="who">${avatarHtml(staffOf(q, c))}${esc(staffOf(q, c) || '?')}</span> · ${esc(statusLabel(q?.quoteStatus))}
        <span class="muted">– bình luận cuối ${ago(last.createdAt)} (${esc(last.staff?.name || '?')})${suggests[c.id]?.sentAt ? ' · ✅ đã gửi' : suggests[c.id] ? ' · đã có gợi ý' : ''}</span></div>
      <div class="item-amt">${noPrice(q) ? noPriceTag(q) : q?.amount ? money(q.amount) : ''}</div></a>`;
    const overdueBox = `
      <h3>⏰ Quá ${FOLLOW_UP_HOURS} giờ chưa cập nhật (${overdue.length})${revenueHtml(overdue)}</h3>
      ${overdue.length
        ? `<div class="box unread">${overdue
            .map(itemHtml)
            .join('')}</div>`
        : '<div class="muted">Không có báo giá nào (trong số báo giá đã ghi lại bình luận).</div>'}
      ${stale.length
        ? `<h3>💤 Cần chào lại khách (${stale.length})${revenueHtml(stale)}</h3><div class="box unread">${stale.slice(0, 20).map(itemHtml).join('')}</div>`
        : ''}`;


    root.querySelector('.panel').innerHTML = `
      <div class="row"><h2>Đánh giá nhân viên kinh doanh</h2><button class="x" data-act="close">×</button></div>
      <div class="muted">Dựa trên ${all.length} báo giá và ${Object.keys(comments).length} báo giá có bình luận mà extension đã ghi lại khi bạn xem CRM.
      Bật/tắt thu thập ngầm, tự mở bảng và xem chi phí Claude trong popup của extension.</div>
      ${state.error ? `<div class="err">Lỗi: ${esc(state.error)}</div>` : ''}
      ${current}
      ${overdueBox}
    `;
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

  async function onClick(e) {
    // Link trong bảng: chuyển trang ngay trong ứng dụng CRM (không tải lại cả trang)
    const a = e.target.closest('a[data-nav]');
    if (a && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const href = a.getAttribute('href');
      const code = a.dataset.code;
      root.querySelector('.panel').hidden = true; // tạm ẩn bảng để xem báo giá; bấm nút nổi để mở lại
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
    if (act === 'close') {
      root.querySelector('.panel').hidden = true;
      render();
    }
    else if (act === 'eval-quote') evaluateQuote(id);
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
  setInterval(render, 5 * 60 * 1000);

  // ERP là SPA: theo dõi đổi trang để cập nhật mục "Báo giá đang mở"
  // Vào trang báo giá + bật "Tự mở bảng" → mở bảng
  async function maybeAutoOpen() {
    if (!root || !currentQuoteId()) return;
    if (!(await getSettings().catch(() => ({}))).autoOpen) return;
    root.querySelector('.panel').hidden = false;
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

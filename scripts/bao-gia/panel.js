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
  const currentQuoteId = () => Number(location.pathname.match(/\/co-hoi\/update\/(\d+)/)?.[1]) || null;
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
      .filter(({ q, c }) => followMode(q, c) === mode)
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
      state.shown = evalKey;
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

  async function evaluateStaff(name) {
    const [quotes, comments] = await Promise.all([kvGet('quotes'), kvGet('comments')]);
    const mine = Object.values(quotes).filter((q) => staffOf(q, comments[q.id]) === name);
    const withComments = mine
      .filter((q) => comments[q.id]?.threads?.length)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30);
    const byStatus = {};
    for (const q of mine) byStatus[statusLabel(q.quoteStatus)] = (byStatus[statusLabel(q.quoteStatus)] || 0) + 1;
    const stats = [
      `Tổng số báo giá đã ghi nhận: ${mine.length}`,
      `Chưa đọc (in đậm trên CRM): ${mine.filter((q) => q.isRead === false).length}`,
      `Theo tình trạng: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(', ')}`,
      `Số báo giá có bình luận được ghi lại: ${withComments.length}`,
    ].join('\n');
    const prompt = `Đánh giá tổng hợp NVKD "${name}" dựa trên các báo giá dưới đây. Nêu thêm các xu hướng lặp lại giữa nhiều báo giá.

THỐNG KÊ
${stats}

CHI TIẾT BÌNH LUẬN
${withComments.map((q) => threadText(q, comments[q.id])).join('\n\n---\n\n') || '(chưa có)'}`;
    await runEval(`s:${name}`, prompt, { staff: name });
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
    hoiNhanh: ['Giá cả ok chưa, khách đồng ý chốt chưa?'],
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
        hoi: 'Giá cả ok không? Khách phản hồi giá thế nào?',
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
    BO_CAU_HOI.tinhHuong.map((t) => `- Khi ${t.khi}:\n  → hỏi: ${t.hoi}`).join('\n');

  const list = (arr) => arr.map((q) => `- ${q}`).join('\n');

  const SUGGEST_SYSTEM = `Bạn giúp quản lý kinh doanh của Tuấn Tú (bao bì giấy carton) viết MỘT bình luận để đăng vào phần bình luận của báo giá trên CRM, hỏi nhân viên kinh doanh (NVKD) về bước tiếp theo.

BỘ CÂU HỎI NHÂN VIÊN

TÌNH HUỐNG ĐẶC BIỆT – kiểm tra TRƯỚC TIÊN. Nếu bình luận gần nhất của NVKD khớp một tình huống dưới đây thì chỉ viết 1 câu ngắn hỏi đúng câu của tình huống đó – KHÔNG gộp thêm câu nào khác (kể cả câu tới công ty khách xem quy mô), bỏ qua chế độ hỏi nhanh/chào lại:
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
  async function insertComment(text, code) {
    const ta = (await openReplyBox(code)) || findCommentBox();
    if (!ta) {
      state.error = 'Không tìm thấy ô bình luận trên trang này.';
      return render();
    }
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
    ta.focus();
  }

  // ---------- Thu thập ngầm + tự phân tích ----------
  // Mở lần lượt từng báo giá trong 1 iframe ẩn (name="dg-collector"); chính app CRM tải dữ liệu,
  // hook.js trong iframe ghi lại bình luận và CHẶN lệnh /read + mọi lệnh ghi (chỉ đọc).
  const IS_TOP = window.top === window;
  const COLLECT = { perRun: 30, gapMs: 4000, waitMs: 20000, refreshHours: 6, maxAgeDays: 60, everyMin: 30, autoSuggest: 10 };
  const collect = { running: false, done: 0, total: 0, current: '', suggested: 0, lastRun: 0 };
  const TAB_ID = Math.random().toString(36).slice(2);

  const getSettings = async () => ({ auto: true, ...(await kvGet('settings')) });

  function pickQueue(quotes, comments, collected) {
    const now = Date.now() / 1000;
    const isOpenQuote = (q) => !CLOSED.has(q.quoteStatus) && !hasOrder(q, comments[q.id]);
    return Object.values(quotes)
      .filter((q) => q.id && q.createdAt && now - q.createdAt < COLLECT.maxAgeDays * 86400)
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
      const [quotes, comments, collected] = await Promise.all([kvGet('quotes'), kvGet('comments'), kvGet('collected')]);
      const queue = pickQueue(quotes, comments, collected);
      collect.total = queue.length;
      render();
      for (const q of queue) {
        if (!force && !(await getSettings()).auto) break;
        collect.current = q.code;
        render();
        await loadInFrame(q.id);
        await kvMerge('collected', { [q.id]: Math.floor(Date.now() / 1000) });
        await call({ type: 'kv.set', key: 'collectLock', value: { tab: TAB_ID, at: Date.now() } });
        collect.done++;
        await sleep(COLLECT.gapMs);
      }
      // Tự phân tích: soạn gợi ý cho các báo giá cần hỏi lại mà chưa có gợi ý mới hơn bình luận cuối
      collect.current = 'phân tích';
      render();
      const [q2, c2, sg] = await Promise.all([kvGet('quotes'), kvGet('comments'), kvGet('suggests')]);
      const need = [...listByMode(q2, c2, 'hoiNhanh'), ...listByMode(q2, c2, 'chaoLai')]
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
      render();
    }
  }

  if (IS_TOP) {
    setTimeout(() => runCollector(), 15000);
    setInterval(() => runCollector(), COLLECT.everyMin * 60 * 1000);
  }

  // ---------- Giao diện ----------
  const state = { busy: new Set(), shown: null, error: null, unreadOf: null };
  let host, root;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
    .fab { position: fixed; left: 16px; bottom: 16px; z-index: 2147483646; border: 0; border-radius: 999px;
      padding: 10px 16px; background: #1d4ed8; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.25); }
    .panel { position: fixed; left: 16px; bottom: 64px; z-index: 2147483647; width: min(520px, calc(100vw - 32px));
      max-height: 78vh; overflow: auto; background: #fff; color: #1f2328; border-radius: 12px; font-size: 13px;
      box-shadow: 0 10px 40px rgba(0,0,0,.3); padding: 14px 16px; }
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
    const stale = listByMode(quotes, comments, 'chaoLai');
    root.querySelector('.fab').textContent = `📊 Đánh giá NVKD${overdue.length ? ` · ⏰ ${overdue.length}` : ''}`;
    if (!isOpen()) return;
    if (root.activeElement?.classList?.contains('suggest-edit')) return; // đang sửa gợi ý – không vẽ lại
    avatars = avatarIndex(quotes);
    const all = Object.values(quotes);

    // Gom theo NVKD
    const byStaff = {};
    for (const q of all) {
      const name = staffOf(q, comments[q.id]) || '(không rõ)';
      const s = (byStaff[name] ||= { name, total: 0, unread: [], commented: 0, evaluated: [] });
      s.total++;
      if (q.isRead === false) s.unread.push(q);
      if (comments[q.id]?.threads?.length) s.commented++;
      const ev = evals[`q:${q.id}`];
      if (ev?.score != null) s.evaluated.push(ev.score);
    }
    const staffRows = Object.values(byStaff).sort((a, b) => b.unread.length - a.unread.length || b.total - a.total);

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
          <div><b>${esc(q?.code || c?.code || '#' + qid)}</b> – ${esc(q?.name || '')}<br>
            <span class="muted who">${avatarHtml(staffOf(q, c), 20)}NVKD: ${esc(staffOf(q, c) || '?')} · ${esc(statusLabel(q?.quoteStatus))} · ${c?.threads?.length || 0} luồng bình luận
            ${last ? ` · bình luận cuối ${ago(last.createdAt)}` : ''}</span></div>
          ${mode === 'hoiNhanh' ? `<div class="warn">⏰ Đã quá ${FOLLOW_UP_HOURS} giờ từ bình luận cuối mà báo giá chưa chốt – nên hỏi NVKD giá cả đã ok chưa.</div>` : ''}
          ${mode === 'chaoLai' ? `<div class="warn">💤 Báo giá ${q?.quoteStatus === 'REJECT' ? 'đã thất bại' : `im lặng quá ${MAX_FOLLOW_UP_DAYS} ngày`} – nên nhắc NVKD chào lại khách, hỏi khách còn dự án thùng khác không.</div>` : ''}
          <div class="btns">
            ${btn('suggest', `c:${qid}`, '💬 Gợi ý câu hỏi cho NVKD', 'Đang soạn…', `data-id="${qid}"`)}
            ${btn('eval-quote', `q:${qid}`, '🤖 Đánh giá NVKD', 'Đang đánh giá…', `data-id="${qid}"`)}
          </div>
          ${sg ? `<div class="label">Bình luận gợi ý <span class="muted">(${new Date(sg.at).toLocaleString('vi-VN')}${sg.styleFrom ? ` · học văn phong từ ${sg.styleFrom} bình luận của bạn` : ''})</span></div>
            <textarea class="suggest-edit" data-id="${qid}">${esc(sg.text)}</textarea>
            <div class="btns"><button class="act primary" data-act="insert" data-id="${qid}">Chèn vào bình luận</button>
              <button class="act" data-act="copy" data-id="${qid}">Copy</button>
              <span class="muted">Tự mở "Trả lời" ở luồng của báo giá này (nếu có). Xem lại rồi tự bấm gửi.</span></div>` : ''}
          ${ev ? `<div class="row label"><span>Đánh giá NVKD <span class="muted">(${new Date(ev.at).toLocaleString('vi-VN')})</span></span>${scoreHtml(ev)}</div><div class="result">${esc(ev.text)}</div>` : ''}
        </div>`;
    }

    const cut = (t, n) => (t && t.length > n ? t.slice(0, n) + '…' : t || '');
    const itemHtml = ({ q, c, last }) => `<a href="/co-hoi/update/${c.id}" data-nav><b>${esc(q?.code || c.code)}</b>${q?.name ? ` – ${esc(cut(q.name, 70))}` : ''}<br><span class="who">${avatarHtml(staffOf(q, c))}${esc(staffOf(q, c) || '?')}</span> · ${esc(statusLabel(q?.quoteStatus))}
      <span class="muted">– bình luận cuối ${ago(last.createdAt)} (${esc(last.staff?.name || '?')})${suggests[c.id] ? ' · đã có gợi ý' : ''}</span></a>`;
    const overdueBox = `
      <h3>⏰ Quá ${FOLLOW_UP_HOURS} giờ chưa cập nhật (${overdue.length})</h3>
      ${overdue.length
        ? `<div class="box unread">${overdue
            .map(itemHtml)
            .join('')}</div>`
        : '<div class="muted">Không có báo giá nào (trong số báo giá đã ghi lại bình luận).</div>'}
      ${stale.length
        ? `<h3>💤 Cần chào lại khách (${stale.length})</h3><div class="box unread">${stale.slice(0, 20).map(itemHtml).join('')}</div>`
        : ''}`;

    const shown = state.shown?.startsWith('s:') ? evals[state.shown] : null;
    const unreadBox = state.unreadOf && byStaff[state.unreadOf]
      ? `<h3>Báo giá chưa đọc – ${esc(state.unreadOf)}</h3><div class="box unread">${
          byStaff[state.unreadOf].unread
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((q) => `<a href="/co-hoi/update/${q.id}" data-nav><b>${esc(q.code)}</b> · ${esc(q.name)} <span class="muted">(${fmtTime(q.createdAt)})</span></a>`)
            .join('') || '<span class="muted">Không có</span>'
        }</div>`
      : '';

    root.querySelector('.panel').innerHTML = `
      <div class="row"><h2>Đánh giá nhân viên kinh doanh</h2><button class="x" data-act="close">×</button></div>
      <div class="muted">Dựa trên ${all.length} báo giá và ${Object.keys(comments).length} báo giá có bình luận mà extension đã ghi lại khi bạn xem CRM.
      Mở trang Báo giá để cập nhật danh sách; bình luận được thu thập ngầm (không đánh dấu đã đọc).</div>
      <div class="collector">🔄 Thu thập ngầm & tự phân tích:
        <button class="act" data-act="toggle-auto">${settings.auto ? 'Đang bật' : 'Đang tắt'}</button>
        ${collect.running
          ? `<span class="muted">${collect.current === 'phân tích' ? `đang soạn gợi ý (${collect.suggested})…` : `đang đọc ${esc(collect.current)} (${collect.done}/${collect.total})…`}</span>`
          : `<button class="act" data-act="collect-now">Chạy ngay</button>
             <span class="muted">${collect.lastRun ? `lần cuối ${new Date(collect.lastRun).toLocaleTimeString('vi-VN')} · ${collect.done} báo giá, ${collect.suggested} gợi ý` : `tự chạy mỗi ${COLLECT.everyMin} phút`} · đã thu thập ${Object.keys(collected).length}</span>`}
      </div>
      ${state.error ? `<div class="err">Lỗi: ${esc(state.error)}</div>` : ''}
      ${current}
      ${overdueBox}
      <h3>Theo NVKD</h3>
      <table>
        <tr><th>NVKD</th><th class="num">Báo giá</th><th class="num">Chưa đọc</th><th class="num">Có BL</th><th class="num">Điểm TB</th><th></th></tr>
        ${staffRows
          .map((s) => {
            const key = `s:${s.name}`;
            const avg = s.evaluated.length ? Math.round((s.evaluated.reduce((a, b) => a + b, 0) / s.evaluated.length) * 10) / 10 : null;
            const sev = evals[key];
            return `<tr>
              <td><span class="who">${avatarHtml(s.name, 26)}${sev ? `<button class="link" data-act="show" data-key="${esc(key)}">${esc(s.name)}</button>` : esc(s.name)}</span></td>
              <td class="num">${s.total}</td>
              <td class="num">${s.unread.length ? `<button class="link" data-act="unread" data-staff="${esc(s.name)}"><b>${s.unread.length}</b></button>` : 0}</td>
              <td class="num">${s.commented}</td>
              <td class="num">${avg != null ? `<span class="score ${scoreCls(avg)}">${avg}</span>` : '–'}</td>
              <td><button class="act" data-act="eval-staff" data-staff="${esc(s.name)}" ${state.busy.has(key) || !s.commented ? 'disabled' : ''}>
                ${state.busy.has(key) ? 'Đang…' : '🤖 Tổng hợp'}</button></td>
            </tr>`;
          })
          .join('') || '<tr><td colspan="6" class="muted">Chưa có dữ liệu – hãy mở trang Báo giá.</td></tr>'}
      </table>
      ${unreadBox}
      ${shown ? `<h3>Đánh giá tổng hợp – ${esc(shown.staff)} ${scoreHtml(shown)}</h3><div class="muted">Lúc ${new Date(shown.at).toLocaleString('vi-VN')}</div><div class="result">${esc(shown.text)}</div>` : ''}
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
      history.pushState({}, '', a.getAttribute('href'));
      window.dispatchEvent(new PopStateEvent('popstate'));
      root.querySelector('.panel').hidden = true; // tạm ẩn bảng để xem báo giá; bấm nút nổi để mở lại
      return render();
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const id = Number(b.dataset.id);
    if (act === 'close') root.querySelector('.panel').hidden = true;
    else if (act === 'eval-quote') evaluateQuote(id);
    else if (act === 'suggest') suggestComment(id);
    else if (act === 'toggle-auto') {
      const cur = await getSettings();
      await call({ type: 'kv.set', key: 'settings', value: { ...cur, auto: !cur.auto } });
      if (!cur.auto) runCollector();
      render();
    } else if (act === 'collect-now') runCollector(true);
    else if (act === 'eval-staff') evaluateStaff(b.dataset.staff);
    else if (act === 'insert' || act === 'copy') {
      // Lấy nội dung đang hiển thị (người dùng có thể đã sửa tay)
      const text = root.querySelector(`textarea.suggest-edit[data-id="${id}"]`)?.value ?? ((await kvGet('suggests'))[id]?.text || '');
      const code = (await kvGet('quotes'))[id]?.code || document.title.match(/#(BG\d+)/)?.[1];
      if (act === 'insert') await insertComment(text, code);
      else {
        await navigator.clipboard.writeText(text);
        b.textContent = 'Đã copy';
      }
    } else if (act === 'show') {
      state.shown = b.dataset.key;
      render();
    } else if (act === 'unread') {
      state.unreadOf = state.unreadOf === b.dataset.staff ? null : b.dataset.staff;
      render();
    }
  }

  // Cập nhật số báo giá quá 12 giờ trên nút nổi theo thời gian
  setInterval(render, 5 * 60 * 1000);

  // ERP là SPA: theo dõi đổi trang để cập nhật mục "Báo giá đang mở"
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      render();
    }
  }, 1000);

  // Trong iframe thu thập ngầm chỉ ghi dữ liệu, không hiện giao diện
  if (IS_TOP) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }
})();

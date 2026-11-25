// Cấu hình trang web Danh sách công ty – điền 2 dòng dưới (lấy ở Supabase → Project Settings → API / API Keys).
// Hai giá trị này ĐƯỢC PHÉP công khai: không có tài khoản do admin cấp thì không đọc được dữ liệu gì
// (bảo vệ bằng Row Level Security – xem supabase/web-users.sql). TUYỆT ĐỐI không dán service_role / secret key / mật khẩu nhóm vào đây.
window.DG_WEB = {
  supabaseUrl: 'https://lahjrbnojqyhhcfgcqgx.supabase.co', // vd. https://abcdxyz.supabase.co
  supabaseKey: 'sb_publishable_ysUAiV6X69ibEcoHVv9kEg_6XtBpA6N', // publishable key (sb_publishable_…) hoặc anon key (eyJ…)
  erpHost: 'https://sale.tuantu.com.vn',
};

// Cấu hình mặc định. Có thể ghi đè trong popup (lưu vào chrome.storage.sync,
// nên sẽ đồng bộ giữa các máy đăng nhập cùng tài khoản Chrome).
export const DEFAULT_CONFIG = {
  owner: 'trungtoanit',
  repo: 'duyetgiatuantu',
  branch: 'main',
  dir: 'scripts', // thư mục chứa manifest.json và các file .js trong repo
  token: '', // chỉ cần khi repo là private (GitHub fine-grained token, quyền Contents: read)
  intervalMinutes: 1, // chu kỳ kiểm tra bản mới (phút)
  anthropicKey: '', // API key Claude, dùng cho tính năng đánh giá NVKD
  model: 'claude-opus-5-5',
  // Đồng bộ dữ liệu giữa các máy (Supabase) – nhập trong popup, KHÔNG ghi vào git
  supabaseUrl: '',
  supabaseKey: '',
  teamSecret: '',
};

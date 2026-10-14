-- Chạy 1 lần trong Supabase → SQL Editor.
-- Đổi 'DOI_MAT_KHAU_NHOM' thành mật khẩu nhóm của bạn (nhập đúng chuỗi này vào popup extension).

create table if not exists public.dg_items (
  ns text not null,              -- quotes | comments | suggests | evals | collected
  id text not null,              -- id báo giá
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (ns, id)
);
create index if not exists dg_items_updated_at on public.dg_items (updated_at);

-- Tự cập nhật thời điểm sửa (để các máy kéo phần mới)
create or replace function public.dg_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists dg_touch on public.dg_items;
create trigger dg_touch before insert or update on public.dg_items
  for each row execute function public.dg_touch();

-- Chỉ ai gửi đúng mật khẩu nhóm (header x-team-secret) mới đọc/ghi được
alter table public.dg_items enable row level security;
drop policy if exists dg_team on public.dg_items;
create policy dg_team on public.dg_items for all to anon
  using ((current_setting('request.headers', true)::json ->> 'x-team-secret') = 'DOI_MAT_KHAU_NHOM')
  with check ((current_setting('request.headers', true)::json ->> 'x-team-secret') = 'DOI_MAT_KHAU_NHOM');

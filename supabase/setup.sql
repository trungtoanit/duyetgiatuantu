-- Chạy 1 lần trong Supabase → SQL Editor → Run.
-- Script tự sinh MẬT KHẨU NHÓM ngẫu nhiên; dòng cuối in ra mật khẩu này để nhập vào popup extension.

create extension if not exists pgcrypto;

create table if not exists public.dg_items (
  ns text not null,              -- quotes | comments | suggests | evals | collected | quickSent
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

-- Mật khẩu nhóm: sinh ngẫu nhiên, lưu ở bảng riêng mà anon không đọc được
create table if not exists public.dg_secret (
  k int primary key default 1 check (k = 1),
  v text not null default encode(gen_random_bytes(18), 'hex')
);
insert into public.dg_secret default values on conflict do nothing;
alter table public.dg_secret enable row level security;
revoke all on public.dg_secret from anon, authenticated;

-- So header x-team-secret của request với mật khẩu nhóm (chạy với quyền chủ sở hữu)
create or replace function public.dg_team_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_setting('request.headers', true)::json ->> 'x-team-secret', '') = (select v from public.dg_secret where k = 1)
$$;
revoke all on function public.dg_team_ok() from public;
grant execute on function public.dg_team_ok() to anon, authenticated;

-- Chỉ ai gửi đúng mật khẩu nhóm mới đọc/ghi được dữ liệu
grant usage on schema public to anon;
grant select, insert, update on public.dg_items to anon;
alter table public.dg_items enable row level security;
drop policy if exists dg_team on public.dg_items;
create policy dg_team on public.dg_items for all to anon
  using (public.dg_team_ok())
  with check (public.dg_team_ok());

-- Mật khẩu nhóm để nhập vào popup extension (Cài đặt → Mật khẩu nhóm)
select v as "MAT_KHAU_NHOM" from public.dg_secret;

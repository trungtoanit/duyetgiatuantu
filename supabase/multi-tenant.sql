-- Tách dữ liệu theo DOMAIN (khách hàng dùng extension) trên cùng 1 Supabase.
-- Chạy 1 lần trong Supabase → SQL Editor → Run (sau setup.sql). Không cần cài lại extension:
-- extension vẫn gửi header x-team-secret như cũ; máy chủ tự gắn domain theo mật khẩu nhóm.
--
-- • Mỗi domain có MẬT KHẨU NHÓM riêng (bảng dg_tenant). Toàn bộ dữ liệu hiện có → domain 'tuantu'.
-- • Mỗi dòng dg_items có cột tenant; đọc/ghi chỉ thấy dữ liệu của domain mình.
-- • Thêm domain mới: insert into public.dg_tenant (tenant) values ('ten-domain') returning secret;
--   rồi nhập secret đó vào popup extension của máy thuộc domain mới.

begin;

-- 1) Bảng domain ↔ mật khẩu nhóm (anon không đọc được)
create table if not exists public.dg_tenant (
  tenant text primary key,
  secret text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now()
);
alter table public.dg_tenant enable row level security;
revoke all on public.dg_tenant from anon, authenticated;

-- Mật khẩu nhóm đang dùng → domain 'tuantu' (giữ nguyên, các máy không phải nhập lại)
insert into public.dg_tenant (tenant, secret)
select 'tuantu', v from public.dg_secret where k = 1
on conflict (tenant) do nothing;

-- 2) Domain của request hiện tại (theo header x-team-secret)
create or replace function public.dg_tenant() returns text
language sql stable security definer set search_path = public as $$
  select tenant from public.dg_tenant
  where secret = coalesce(current_setting('request.headers', true)::json ->> 'x-team-secret', '')
$$;
revoke all on function public.dg_tenant() from public;
grant execute on function public.dg_tenant() to anon, authenticated;

-- 3) Cột tenant: dữ liệu cũ = 'tuantu'; dòng mới tự lấy theo mật khẩu nhóm (client không tự đặt được)
alter table public.dg_items add column if not exists tenant text;
update public.dg_items set tenant = 'tuantu' where tenant is null;
alter table public.dg_items alter column tenant set not null;

create or replace function public.dg_touch() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at = now();
  if tg_op = 'UPDATE' then
    new.tenant = old.tenant; -- không đổi domain của dòng đã có
  else
    new.tenant = coalesce(public.dg_tenant(), new.tenant);
  end if;
  return new;
end $$;
drop trigger if exists dg_touch on public.dg_items;
create trigger dg_touch before insert or update on public.dg_items
  for each row execute function public.dg_touch();

-- 4) Khoá chính theo domain: cùng ns/id ở 2 domain là 2 dòng khác nhau
alter table public.dg_items drop constraint if exists dg_items_pkey;
alter table public.dg_items add primary key (tenant, ns, id);
create index if not exists dg_items_tenant_updated on public.dg_items (tenant, updated_at);

-- 5) Quyền: chỉ đọc/ghi dữ liệu domain của mình
drop policy if exists dg_team on public.dg_items;
drop policy if exists dg_tenant on public.dg_items;
create policy dg_tenant on public.dg_items for all to anon
  using (tenant = public.dg_tenant())
  with check (tenant = public.dg_tenant());

commit;

-- Kiểm tra: số dòng theo domain
select tenant, count(*) from public.dg_items group by tenant;

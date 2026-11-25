-- 🌐 Trang web "Danh sách công ty" (GitHub Pages: /web/) – tài khoản đăng nhập + quyền XEM dữ liệu.
-- Chạy 1 lần trong Supabase → SQL Editor → dán toàn bộ → Run. Chạy lại nhiều lần cũng không sao.
-- Sau đó tạo tài khoản admin đầu tiên bằng lệnh ở CUỐI file (sửa tên đăng nhập + mật khẩu rồi chạy riêng dòng đó).
--
-- Bảo mật:
--  • Chỉ người có tài khoản trong dg_web_users mới đọc được, và CHỈ đọc mapsPlaces + customersAll.
--  • Quyền: viewer = chỉ xem · editor = xem + sửa công ty Maps · admin = editor + quản lý tài khoản.
--  • Báo giá, đơn hàng… vẫn chỉ extension (mật khẩu nhóm) đọc được như cũ.
--  • Tài khoản do admin tạo trên trang web (không cần email thật – gõ tên đăng nhập là đủ).
--  • Nên TẮT tự đăng ký: Authentication → Sign In / Providers → tắt "Allow new users to sign up".

create extension if not exists pgcrypto with schema extensions;

-- Danh sách tài khoản được phép xem trang web
create table if not exists public.dg_web_users (
  email text primary key,              -- tên đăng nhập không có @ → lưu dạng ten@tuantu.local
  role text not null default 'viewer' check (role in ('viewer', 'editor', 'admin')),
  name text,
  created_at timestamptz not null default now(),
  created_by text
);
alter table public.dg_web_users enable row level security;
-- quyền ✏️ editor (xem + sửa) – thêm cho bảng tạo từ bản cũ
alter table public.dg_web_users drop constraint if exists dg_web_users_role_check;
alter table public.dg_web_users add constraint dg_web_users_role_check check (role in ('viewer', 'editor', 'admin'));
revoke all on public.dg_web_users from anon, authenticated;

-- Quyền của người đang đăng nhập: 'admin' | 'viewer' | null (không có quyền)
create or replace function public.dg_web_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.dg_web_users where email = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;
revoke all on function public.dg_web_role() from public;
grant execute on function public.dg_web_role() to authenticated;

-- Người đã đăng nhập + có trong danh sách → được XEM công ty Maps + khách ERP
grant usage on schema public to authenticated;
grant select on public.dg_items to authenticated;
drop policy if exists dg_web_read on public.dg_items;
create policy dg_web_read on public.dg_items for select to authenticated
  using (ns in ('mapsPlaces', 'customersAll') and public.dg_web_role() is not null);

-- ✏️ editor / admin: sửa công ty Maps (xoá / khôi phục, kết nối ERP, MST) – giống bảng 📋 trên Google Maps.
-- Chỉ ghi được loại mapsPlaces; không xoá hẳn dòng nào (xoá = đánh dấu hidden, khôi phục được).
grant insert, update on public.dg_items to authenticated;
drop policy if exists dg_web_ins on public.dg_items;
create policy dg_web_ins on public.dg_items for insert to authenticated
  with check (ns = 'mapsPlaces' and public.dg_web_role() in ('editor', 'admin'));
drop policy if exists dg_web_upd on public.dg_items;
create policy dg_web_upd on public.dg_items for update to authenticated
  using (ns = 'mapsPlaces' and public.dg_web_role() in ('editor', 'admin'))
  with check (ns = 'mapsPlaces' and public.dg_web_role() in ('editor', 'admin'));

-- ---- Tạo tài khoản (nội bộ – chỉ gọi từ SQL Editor hoặc qua hàm admin bên dưới) ----
create or replace function public.dg_web_create_internal(p_login text, p_password text, p_role text default 'viewer', p_name text default null, p_by text default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_email text := lower(trim(p_login));
  v_uid uuid;
begin
  if v_email = '' then raise exception 'Thiếu tên đăng nhập'; end if;
  if position('@' in v_email) = 0 then v_email := v_email || '@tuantu.local'; end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'Mật khẩu tối thiểu 6 ký tự'; end if;
  if p_role not in ('viewer', 'editor', 'admin') then raise exception 'Quyền không hợp lệ'; end if;
  select id into v_uid from auth.users where email = v_email;
  if v_uid is null then
    v_uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new)
    values ('00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated', v_email,
      crypt(p_password, gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', jsonb_build_object('name', coalesce(p_name, '')), now(), now(),
      '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_uid, v_uid::text,
      jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true), 'email', now(), now(), now());
  else
    -- đã có tài khoản Supabase với email này → đặt lại mật khẩu
    update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = v_uid;
  end if;
  insert into public.dg_web_users (email, role, name, created_by) values (v_email, p_role, p_name, p_by)
    on conflict (email) do update set role = excluded.role, name = coalesce(excluded.name, dg_web_users.name);
  return v_email;
end $$;
revoke all on function public.dg_web_create_internal(text, text, text, text, text) from public, anon, authenticated;

-- ---- Các hàm cho trang Quản lý tài khoản (chỉ admin gọi được) ----
create or replace function public.dg_web_need_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(public.dg_web_role(), '') <> 'admin' then raise exception 'Chỉ admin mới làm được việc này'; end if;
end $$;
revoke all on function public.dg_web_need_admin() from public, anon, authenticated;

create or replace function public.dg_web_list()
returns table (email text, role text, name text, created_at timestamptz, created_by text, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.dg_web_need_admin();
  return query select w.email, w.role, w.name, w.created_at, w.created_by, u.last_sign_in_at
    from public.dg_web_users w left join auth.users u on u.email = w.email order by w.created_at;
end $$;

create or replace function public.dg_web_add(p_login text, p_password text, p_role text default 'viewer', p_name text default null)
returns text language plpgsql security definer set search_path = public as $$
begin
  perform public.dg_web_need_admin();
  return public.dg_web_create_internal(p_login, p_password, p_role, p_name, auth.jwt() ->> 'email');
end $$;

create or replace function public.dg_web_set_password(p_email text, p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.dg_web_need_admin();
  if length(coalesce(p_password, '')) < 6 then raise exception 'Mật khẩu tối thiểu 6 ký tự'; end if;
  if not exists (select 1 from public.dg_web_users where email = lower(p_email)) then raise exception 'Không có tài khoản này'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where email = lower(p_email);
end $$;

create or replace function public.dg_web_update(p_email text, p_role text, p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.dg_web_need_admin();
  if p_role not in ('viewer', 'editor', 'admin') then raise exception 'Quyền không hợp lệ'; end if;
  if lower(p_email) = lower(auth.jwt() ->> 'email') and p_role <> 'admin' then raise exception 'Không tự bỏ quyền admin của chính mình'; end if;
  update public.dg_web_users set role = p_role, name = p_name where email = lower(p_email);
end $$;

create or replace function public.dg_web_remove(p_email text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.dg_web_need_admin();
  if lower(p_email) = lower(auth.jwt() ->> 'email') then raise exception 'Không tự xoá tài khoản của chính mình'; end if;
  delete from public.dg_web_users where email = lower(p_email);
  delete from auth.users where email = lower(p_email);
end $$;

do $$
declare f text;
begin
  foreach f in array array['dg_web_list()', 'dg_web_add(text,text,text,text)', 'dg_web_set_password(text,text)', 'dg_web_update(text,text,text)', 'dg_web_remove(text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ---- Nhiều công ty (tenant): bảng dg_items có cột tenant (khoá chính tenant, ns, id) ----
-- Mỗi tài khoản web thuộc 1 tenant (mặc định 'tuantu'); chỉ đọc / ghi dữ liệu đúng tenant đó.
alter table public.dg_web_users add column if not exists tenant text not null default 'tuantu';
create or replace function public.dg_web_tenant() returns text
language sql stable security definer set search_path = public as $$
  select tenant from public.dg_web_users where email = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;
revoke all on function public.dg_web_tenant() from public;
grant execute on function public.dg_web_tenant() to authenticated;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'dg_items' and column_name = 'tenant') then
    execute 'drop policy if exists dg_web_read on public.dg_items';
    execute $p$create policy dg_web_read on public.dg_items for select to authenticated
      using (ns in ('mapsPlaces', 'customersAll') and public.dg_web_role() is not null and tenant = public.dg_web_tenant())$p$;
    execute 'drop policy if exists dg_web_ins on public.dg_items';
    execute $p$create policy dg_web_ins on public.dg_items for insert to authenticated
      with check (ns = 'mapsPlaces' and public.dg_web_role() in ('editor', 'admin') and tenant = public.dg_web_tenant())$p$;
    execute 'drop policy if exists dg_web_upd on public.dg_items';
    execute $p$create policy dg_web_upd on public.dg_items for update to authenticated
      using (ns = 'mapsPlaces' and public.dg_web_role() in ('editor', 'admin') and tenant = public.dg_web_tenant())
      with check (ns = 'mapsPlaces' and public.dg_web_role() in ('editor', 'admin') and tenant = public.dg_web_tenant())$p$;
  end if;
end $$;
-- tài khoản admin tạo ra thuộc cùng tenant với admin; danh sách tài khoản chỉ hiện cùng tenant
create or replace function public.dg_web_add(p_login text, p_password text, p_role text default 'viewer', p_name text default null)
returns text language plpgsql security definer set search_path = public as $$
declare v text;
begin
  perform public.dg_web_need_admin();
  v := public.dg_web_create_internal(p_login, p_password, p_role, p_name, auth.jwt() ->> 'email');
  update public.dg_web_users set tenant = public.dg_web_tenant() where email = v;
  return v;
end $$;
create or replace function public.dg_web_list()
returns table (email text, role text, name text, created_at timestamptz, created_by text, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.dg_web_need_admin();
  return query select w.email, w.role, w.name, w.created_at, w.created_by, u.last_sign_in_at
    from public.dg_web_users w left join auth.users u on u.email = w.email
    where w.tenant = public.dg_web_tenant() order by w.created_at;
end $$;

-- ---- 📞 Telesale: MỌI tài khoản web (kể cả 👁 chỉ xem) nhận khách / ghi cuộc gọi – chỉ sửa phần data.tele của công ty ----
-- Kiểm tra trên máy chủ (khoá dòng): khách đã có người khác nhận thì không nhận / ghi được (trừ admin).
create or replace function public.dg_web_tele(p_id text, p_action text, p_name text default null, p_call jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.dg_web_role();
  v_ten text := public.dg_web_tenant();
  v_me text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_data jsonb;
  t jsonb;
  v_by text;
begin
  if v_role is null then raise exception 'Tài khoản chưa được cấp quyền'; end if;
  select data into v_data from public.dg_items where tenant = v_ten and ns = 'mapsPlaces' and id = p_id for update;
  if v_data is null then raise exception 'Không tìm thấy công ty'; end if;
  t := coalesce(v_data -> 'tele', '{}'::jsonb);
  v_by := nullif(t ->> 'by', '');
  if p_action = 'claim' then
    if v_by is not null and v_by <> v_me then raise exception '% đã nhận khách này rồi', coalesce(t ->> 'byName', v_by); end if;
    t := t || jsonb_build_object('by', v_me, 'byName', p_name, 'at', v_now);
  elsif p_action = 'drop' then
    if v_by is not null and v_by <> v_me and v_role <> 'admin' then raise exception 'Chỉ người nhận hoặc admin mới trả / thu hồi được'; end if;
    t := t || jsonb_build_object('by', null, 'byName', null, 'droppedAt', v_now, 'droppedBy', p_name);
  elsif p_action = 'call' then
    if v_by is not null and v_by <> v_me and v_role <> 'admin' then raise exception '% đã nhận khách này rồi', coalesce(t ->> 'byName', v_by); end if;
    if p_call is null or coalesce(p_call ->> 'res', '') = '' then raise exception 'Thiếu kết quả cuộc gọi'; end if;
    p_call := p_call || jsonb_build_object('at', v_now, 'by', v_me, 'byName', p_name);
    t := t || jsonb_build_object(
      'by', coalesce(v_by, v_me), 'byName', coalesce(t ->> 'byName', p_name), 'at', coalesce(t -> 'at', to_jsonb(v_now)),
      'calls', coalesce(t -> 'calls', '[]'::jsonb) || jsonb_build_array(p_call),
      'last', p_call -> 'res', 'lastAt', v_now, 'next', p_call -> 'next');
  else
    raise exception 'Thao tác không hợp lệ';
  end if;
  v_data := jsonb_set(v_data, '{tele}', t);
  update public.dg_items set data = v_data where tenant = v_ten and ns = 'mapsPlaces' and id = p_id;
  return v_data;
end $$;
revoke all on function public.dg_web_tele(text, text, text, jsonb) from public, anon;
grant execute on function public.dg_web_tele(text, text, text, jsonb) to authenticated;

-- ---- Tên hiển thị: admin sửa ở 👥 Tài khoản (dg_web_update) → trang web đọc qua dg_web_me ----
create or replace function public.dg_web_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('role', role, 'tenant', tenant, 'name', name) from public.dg_web_users
  where email = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;
revoke all on function public.dg_web_me() from public, anon;
grant execute on function public.dg_web_me() to authenticated;
create or replace function public.dg_web_update(p_email text, p_role text, p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.dg_web_need_admin();
  if p_role not in ('viewer', 'editor', 'admin') then raise exception 'Quyền không hợp lệ'; end if;
  if lower(p_email) = lower(auth.jwt() ->> 'email') and p_role <> 'admin' then raise exception 'Không tự bỏ quyền admin của chính mình'; end if;
  update public.dg_web_users set role = p_role, name = nullif(trim(p_name), '')
    where email = lower(p_email) and tenant = public.dg_web_tenant();
  update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('name', coalesce(trim(p_name), ''))
    where email = lower(p_email);
end $$;

-- ---- 🕘 Nhật ký hoạt động trang web (mọi thao tác của tài khoản web) ----
create table if not exists public.dg_web_log (
  id bigserial primary key,
  tenant text not null default 'tuantu',
  at timestamptz not null default now(),
  email text,
  name text,
  action text not null,
  target_id text,
  target_name text,
  detail jsonb
);
create index if not exists dg_web_log_at on public.dg_web_log (tenant, at desc);
alter table public.dg_web_log enable row level security;
revoke all on public.dg_web_log from anon, authenticated;

-- ghi 1 dòng nhật ký cho người đang đăng nhập (nội bộ – chỉ gọi từ hàm / trigger)
create or replace function public.dg_web_log_write(p_action text, p_target_id text default null, p_target_name text default null, p_detail jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if v_email = '' then return; end if;
  insert into public.dg_web_log (tenant, email, name, action, target_id, target_name, detail)
  select coalesce(w.tenant, 'tuantu'), v_email, w.name, p_action, p_target_id, p_target_name, p_detail
  from (select 1) x left join public.dg_web_users w on w.email = v_email;
end $$;
revoke all on function public.dg_web_log_write(text, text, text, jsonb) from public, anon, authenticated;

-- thao tác chỉ trình duyệt biết (đăng nhập, xem công ty, in PDF…) – chỉ nhận các loại cho phép
create or replace function public.dg_web_log_add(p_action text, p_target_id text default null, p_target_name text default null, p_detail jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.dg_web_role() is null then return; end if;
  if p_action not in ('đăng nhập', 'đăng xuất', 'xem công ty', 'in PDF', 'đổi mật khẩu', 'tải lại dữ liệu') then raise exception 'Loại nhật ký không hợp lệ'; end if;
  perform public.dg_web_log_write(p_action, p_target_id, left(p_target_name, 300), p_detail);
end $$;
revoke all on function public.dg_web_log_add(text, text, text, jsonb) from public, anon;
grant execute on function public.dg_web_log_add(text, text, text, jsonb) to authenticated;

-- thay đổi công ty từ trang web → ghi nhật ký (trên máy chủ, người dùng không sửa được). Extension (không đăng nhập web) bỏ qua.
create or replace function public.dg_web_items_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  o jsonb := coalesce(old.data, '{}'::jsonb);
  n jsonb := new.data;
  keys text[];
  ot jsonb := coalesce(o -> 'tele', '{}'::jsonb);
  nt jsonb := coalesce(n -> 'tele', '{}'::jsonb);
  nm text := coalesce(nullif(n ->> 'legalName', ''), n ->> 'name');
  lc jsonb;
begin
  if v_email = '' or new.ns <> 'mapsPlaces' then return new; end if;
  select array_agg(k) into keys from (
    select coalesce(a.key, b.key) k from jsonb_each(n) a full join jsonb_each(o) b on a.key = b.key
    where a.value is distinct from b.value) x
  where k not in ('route', 'photos', 'photosAt', 'web', 'webPhones', 'webPages', 'webScanAt', 'reviews', 'reviewsAt', 'aiReview', 'aiReviewAt');
  if keys is null then return new; end if;
  if 'tele' = any(keys) then
    if jsonb_array_length(coalesce(nt -> 'calls', '[]')) > jsonb_array_length(coalesce(ot -> 'calls', '[]')) then
      lc := nt -> 'calls' -> -1;
      perform public.dg_web_log_write('ghi cuộc gọi', new.id, nm, jsonb_build_object('res', lc -> 'res', 'note', lc -> 'note', 'contact', lc -> 'contact', 'next', lc -> 'next'));
    elsif coalesce(ot ->> 'by', '') = '' and coalesce(nt ->> 'by', '') <> '' then
      perform public.dg_web_log_write('nhận khách', new.id, nm, null);
    elsif coalesce(ot ->> 'by', '') <> '' and coalesce(nt ->> 'by', '') = '' then
      perform public.dg_web_log_write(case when ot ->> 'by' = v_email then 'trả khách' else 'thu hồi khách' end, new.id, nm, jsonb_build_object('cua', coalesce(ot ->> 'byName', ot ->> 'by')));
    end if;
    keys := array_remove(keys, 'tele');
  end if;
  if 'hidden' = any(keys) then
    perform public.dg_web_log_write(case when (n ->> 'hidden')::boolean then 'xoá công ty' else 'khôi phục công ty' end, new.id, nm, null);
    keys := array_remove(array_remove(array_remove(keys, 'hidden'), 'hiddenAt'), 'hiddenBy');
  end if;
  if 'erpId' = any(keys) or 'erpNo' = any(keys) then
    perform public.dg_web_log_write(case when coalesce((n ->> 'erpNo')::boolean, false) then 'bỏ kết nối ERP' else 'kết nối ERP' end, new.id, nm, jsonb_build_object('erpId', n -> 'erpId'));
    keys := array_remove(array_remove(array_remove(array_remove(keys, 'erpId'), 'erpNo'), 'erpLinkAt'), 'erpLinkBy');
  end if;
  if 'mst' = any(keys) then
    perform public.dg_web_log_write('nhập MST', new.id, nm, jsonb_build_object('mst', n -> 'mst', 'cu', o -> 'mst'));
    keys := array(select k from unnest(keys) k where k not like 'mst%' and k not in ('legalName', 'legalAddr'));
  end if;
  if 'area' = any(keys) then
    perform public.dg_web_log_write('sửa diện tích', new.id, nm, jsonb_build_object('area', n -> 'area', 'cu', o -> 'area'));
    keys := array(select k from unnest(keys) k where k not like 'area%');
  end if;
  if array_length(keys, 1) > 0 then
    perform public.dg_web_log_write('sửa công ty', new.id, nm, jsonb_build_object('fields', to_jsonb(keys)));
  end if;
  return new;
end $$;
drop trigger if exists dg_web_items_log on public.dg_items;
create trigger dg_web_items_log after update on public.dg_items for each row execute function public.dg_web_items_log();

-- xem nhật ký: CHỈ admin
create or replace function public.dg_web_log_list(p_from timestamptz default now() - interval '7 days', p_email text default null, p_action text default null, p_limit int default 500)
returns table (at timestamptz, email text, name text, action text, target_id text, target_name text, detail jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := public.dg_web_role();
  v_me text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if v_role is distinct from 'admin' then raise exception 'Chỉ admin mới xem được nhật ký'; end if;
  return query select l.at, l.email, l.name, l.action, l.target_id, l.target_name, l.detail from public.dg_web_log l
    where l.tenant = public.dg_web_tenant() and l.at >= coalesce(p_from, '1970-01-01')
      and (case when v_role = 'admin' then p_email is null or l.email = lower(p_email) else l.email = v_me end)
      and (p_action is null or l.action = p_action)
    order by l.at desc limit least(coalesce(p_limit, 500), 2000);
end $$;
revoke all on function public.dg_web_log_list(timestamptz, text, text, int) from public, anon;
grant execute on function public.dg_web_log_list(timestamptz, text, text, int) to authenticated;

-- nhật ký quản lý tài khoản: bọc các hàm admin
create or replace function public.dg_web_add(p_login text, p_password text, p_role text default 'viewer', p_name text default null)
returns text language plpgsql security definer set search_path = public as $$
declare v text;
begin
  perform public.dg_web_need_admin();
  v := public.dg_web_create_internal(p_login, p_password, p_role, p_name, auth.jwt() ->> 'email');
  update public.dg_web_users set tenant = public.dg_web_tenant() where email = v;
  perform public.dg_web_log_write('tạo tài khoản', v, p_name, jsonb_build_object('role', p_role));
  return v;
end $$;
create or replace function public.dg_web_set_password(p_email text, p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.dg_web_need_admin();
  if length(coalesce(p_password, '')) < 6 then raise exception 'Mật khẩu tối thiểu 6 ký tự'; end if;
  if not exists (select 1 from public.dg_web_users where email = lower(p_email)) then raise exception 'Không có tài khoản này'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where email = lower(p_email);
  perform public.dg_web_log_write('đặt lại mật khẩu', lower(p_email), null, null);
end $$;
create or replace function public.dg_web_update(p_email text, p_role text, p_name text)
returns void language plpgsql security definer set search_path = public as $$
declare o record;
begin
  perform public.dg_web_need_admin();
  if p_role not in ('viewer', 'editor', 'admin') then raise exception 'Quyền không hợp lệ'; end if;
  if lower(p_email) = lower(auth.jwt() ->> 'email') and p_role <> 'admin' then raise exception 'Không tự bỏ quyền admin của chính mình'; end if;
  select role, name into o from public.dg_web_users where email = lower(p_email) and tenant = public.dg_web_tenant();
  update public.dg_web_users set role = p_role, name = nullif(trim(p_name), '')
    where email = lower(p_email) and tenant = public.dg_web_tenant();
  update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('name', coalesce(trim(p_name), ''))
    where email = lower(p_email);
  if o.role is distinct from p_role then perform public.dg_web_log_write('đổi quyền', lower(p_email), p_name, jsonb_build_object('cu', o.role, 'moi', p_role)); end if;
  if coalesce(o.name, '') is distinct from coalesce(nullif(trim(p_name), ''), '') then perform public.dg_web_log_write('đổi tên hiển thị', lower(p_email), p_name, jsonb_build_object('cu', o.name, 'moi', p_name)); end if;
end $$;
create or replace function public.dg_web_remove(p_email text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.dg_web_need_admin();
  if lower(p_email) = lower(auth.jwt() ->> 'email') then raise exception 'Không tự xoá tài khoản của chính mình'; end if;
  perform public.dg_web_log_write('xoá tài khoản', lower(p_email), null, null);
  delete from public.dg_web_users where email = lower(p_email) and tenant = public.dg_web_tenant();
  delete from auth.users where email = lower(p_email) and not exists (select 1 from public.dg_web_users where email = lower(p_email));
end $$;

-- ================== TÀI KHOẢN ADMIN ĐẦU TIÊN ==================
-- Sửa 'admin' (tên đăng nhập) và 'DoiMatKhauNay' (mật khẩu ≥ 6 ký tự) rồi bôi đen riêng dòng dưới → Run.
-- select public.dg_web_create_internal('admin', 'DoiMatKhauNay', 'admin', 'Quản trị');

-- Chạy một lần trên dự án Supabase dành cho app Telesales.
-- Không chứa dữ liệu khách hàng, tài khoản mẫu hay mật khẩu.
begin;
create schema if not exists telesales_private;
revoke all on schema telesales_private from public;
grant usage on schema telesales_private to authenticated;

create table public.ts_profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  full_name text not null default '' check (length(full_name) <= 120),
  role text not null default 'staff' check (role in ('admin','staff')),
  active boolean not null default false,
  created_at timestamptz not null default now()
);
create table public.ts_customers (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  customer text not null check (length(customer) between 1 and 500),
  contact text not null default '',
  position text not null default '',
  phone text not null default '',
  email text not null default '',
  address text not null default '',
  province text not null default '',
  area text not null default '',
  origin text not null default '',
  original_note text not null default '',
  legacy_sales_person text not null default '',
  assigned_to uuid references public.ts_profiles(id) on delete restrict,
  status text not null default 'Chưa gọi',
  call_note text not null default '',
  next_call_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ts_status check (status in ('Chưa gọi','1. Không nghe máy','2. Thuê bao / Bận máy','3. Hẹn gọi lại','4. Nhầm người / Chuyển người khác','5. Đã kết nối Zalo / Gửi tài liệu','6. Khách quan tâm / Tiềm năng','7. Hẹn gặp nhà máy / Đã chốt dự án','8. Sai số / Nghỉ việc','9. Từ chối / Không có nhu cầu'))
);
create table public.ts_activities (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.ts_customers(id) on delete restrict,
  actor_id uuid default auth.uid() references public.ts_profiles(id) on delete restrict,
  actor_name text not null default '',
  event_type text not null check (event_type in ('call','note','assignment','legacy_import')),
  result text,
  note text not null default '' check (length(note) <= 10000),
  next_call_at timestamptz,
  attachment_path text,
  legacy_key text unique,
  legacy_time text,
  previous_assignee uuid references public.ts_profiles(id),
  new_assignee uuid references public.ts_profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create index ts_customers_assignee on public.ts_customers(assigned_to);
create index ts_customers_next_call on public.ts_customers(next_call_at) where next_call_at is not null;
create index ts_activities_customer_time on public.ts_activities(customer_id, created_at desc);
create index ts_activities_actor_time on public.ts_activities(actor_id, created_at desc);

-- Hàm tra quyền ở schema không công khai; không dùng user_metadata tự sửa được.
create function telesales_private.current_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.ts_profiles
  where id = (select auth.uid()) and active and (select auth.uid()) is not null;
$$;
create function telesales_private.can_access(p_customer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.ts_profiles p join public.ts_customers c on c.id = p_customer
    where p.id = (select auth.uid()) and p.active
      and (p.role = 'admin' or c.assigned_to = p.id)
  );
$$;
revoke all on function telesales_private.current_role() from public;
revoke all on function telesales_private.can_access(uuid) from public;
grant execute on function telesales_private.current_role() to authenticated;
grant execute on function telesales_private.can_access(uuid) to authenticated;

alter table public.ts_profiles enable row level security;
alter table public.ts_customers enable row level security;
alter table public.ts_activities enable row level security;
revoke all on public.ts_profiles, public.ts_customers, public.ts_activities from anon, authenticated;
grant select on public.ts_profiles, public.ts_customers, public.ts_activities to authenticated;
grant update(full_name,active) on public.ts_profiles to authenticated;
grant insert(legacy_id,customer,contact,position,phone,email,address,province,area,origin,original_note,legacy_sales_person,assigned_to)
  on public.ts_customers to authenticated;
grant update(assigned_to,customer,contact,position,phone,email,address,province,area,origin,original_note,legacy_sales_person)
  on public.ts_customers to authenticated;
grant insert(id,customer_id,event_type,result,note,next_call_at,attachment_path,legacy_key,legacy_time)
  on public.ts_activities to authenticated;
grant all on public.ts_profiles, public.ts_customers, public.ts_activities to service_role;

create policy ts_profiles_read on public.ts_profiles for select to authenticated
  using (id = (select auth.uid()) or (select telesales_private.current_role()) = 'admin');
-- Quản trị viên chỉ chỉnh tên/kích hoạt nhân viên. Đổi vai trò quản trị thực hiện trong Dashboard.
create policy ts_profiles_manage_staff on public.ts_profiles for update to authenticated
  using ((select telesales_private.current_role()) = 'admin' and role = 'staff')
  with check ((select telesales_private.current_role()) = 'admin' and role = 'staff');
create policy ts_customers_read on public.ts_customers for select to authenticated
  using ((select telesales_private.current_role()) = 'admin'
    or ((select telesales_private.current_role()) = 'staff' and assigned_to = (select auth.uid())));
create policy ts_customers_create on public.ts_customers for insert to authenticated
  with check ((select telesales_private.current_role()) = 'admin');
create policy ts_customers_assign on public.ts_customers for update to authenticated
  using ((select telesales_private.current_role()) = 'admin')
  with check ((select telesales_private.current_role()) = 'admin');
create policy ts_activities_read on public.ts_activities for select to authenticated
  using (telesales_private.can_access(customer_id));
create policy ts_activities_add on public.ts_activities for insert to authenticated
  with check (actor_id = (select auth.uid()) and telesales_private.can_access(customer_id)
    and (event_type in ('call','note')
      or (event_type = 'legacy_import' and (select telesales_private.current_role()) = 'admin')));

-- Chỉ cấp profile cho tài khoản được quản trị chọn. Không gắn trigger vào auth.users
-- và không tạo profile telesales cho user của ứng dụng khác trong dự án dùng chung.

-- Nhật ký bất biến. Trigger ghi tên người thao tác, giờ máy chủ và cập nhật trạng thái cùng giao dịch.
create function telesales_private.prepare_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.ts_profiles; c public.ts_customers;
begin
  if new.event_type = 'assignment' then
    -- Chỉ trigger chuyển khách mới được tạo sự kiện này.
    if pg_trigger_depth() < 2 then raise exception 'Không được tự tạo lịch sử giao khách'; end if;
    return new;
  end if;
  if auth.uid() is null then raise exception 'Cần đăng nhập'; end if;
  select * into p from public.ts_profiles where id = auth.uid() and active;
  select * into c from public.ts_customers where id = new.customer_id for update;
  if p.id is null or c.id is null or (p.role <> 'admin' and c.assigned_to is distinct from p.id) then
    raise exception 'Không có quyền cập nhật khách hàng này';
  end if;
  if new.event_type = 'legacy_import' and p.role <> 'admin' then raise exception 'Chỉ quản trị được nhập dữ liệu cũ'; end if;
  if new.event_type <> 'legacy_import' and (new.legacy_key is not null or new.legacy_time is not null) then
    raise exception 'Không được đặt thông tin nhập cũ cho cuộc gọi mới';
  end if;
  if new.attachment_path is not null and new.attachment_path not like new.customer_id::text || '/' || p.id::text || '/%' then
    raise exception 'Đường dẫn âm thanh không hợp lệ';
  end if;
  new.actor_id := p.id;
  new.actor_name := p.full_name;
  new.created_at := clock_timestamp();
  if new.result is not null and new.result not in ('Chưa gọi','1. Không nghe máy','2. Thuê bao / Bận máy','3. Hẹn gọi lại','4. Nhầm người / Chuyển người khác','5. Đã kết nối Zalo / Gửi tài liệu','6. Khách quan tâm / Tiềm năng','7. Hẹn gặp nhà máy / Đã chốt dự án','8. Sai số / Nghỉ việc','9. Từ chối / Không có nhu cầu') then
    raise exception 'Trạng thái không hợp lệ';
  end if;
  if new.event_type <> 'legacy_import' then
    new.result := coalesce(new.result,c.status);
  end if;
  return new;
end; $$;
create function telesales_private.apply_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.event_type in ('call','note') then
    update public.ts_customers set status = coalesce(new.result,status), call_note = new.note,
      next_call_at = new.next_call_at, updated_at = new.created_at, version = version + 1
    where id = new.customer_id;
  end if;
  -- Dữ liệu cũ chỉ thêm vào lịch sử, không ghi đè kết quả làm việc mới.
  return new;
end; $$;
revoke all on function telesales_private.prepare_activity() from public;
revoke all on function telesales_private.apply_activity() from public;
create trigger ts_activity_prepare before insert on public.ts_activities
  for each row execute function telesales_private.prepare_activity();
create trigger ts_activity_apply after insert on public.ts_activities
  for each row execute function telesales_private.apply_activity();

create function telesales_private.prepare_customer() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.assigned_to is not null and not exists(select 1 from public.ts_profiles where id=new.assigned_to and active) then
    raise exception 'Nhân viên chưa được kích hoạt';
  end if;
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end; $$;
revoke all on function telesales_private.prepare_customer() from public;
create trigger ts_customer_prepare before insert or update on public.ts_customers
  for each row execute function telesales_private.prepare_customer();

create function telesales_private.audit_assignment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare actor text;
begin
  if new.assigned_to is distinct from old.assigned_to then
    if new.assigned_to is not null and not exists(select 1 from public.ts_profiles where id=new.assigned_to and active) then
      raise exception 'Nhân viên chưa được kích hoạt';
    end if;
    select full_name into actor from public.ts_profiles where id = auth.uid();
    insert into public.ts_activities(customer_id,actor_id,actor_name,event_type,previous_assignee,new_assignee,note)
      values (new.id,auth.uid(),coalesce(actor,'Quản trị hệ thống'),'assignment',old.assigned_to,new.assigned_to,'Thay đổi người phụ trách');
  end if;
  return new;
end; $$;
revoke all on function telesales_private.audit_assignment() from public;
create trigger ts_assignment_audit after update of assigned_to on public.ts_customers
  for each row execute function telesales_private.audit_assignment();

-- RPC invoker: vẫn chịu mọi quyền RLS; ID cố định giúp gửi lại an toàn khi mất phản hồi mạng.
create function public.ts_log_activity(p_id uuid,p_customer_id uuid,p_event_type text,p_result text,p_note text,
  p_next_call_at timestamptz default null,p_attachment_path text default null,
  p_legacy_key text default null,p_legacy_time text default null) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare existing public.ts_activities;
begin
  select * into existing from public.ts_activities where id=p_id;
  if found then
    if existing.actor_id <> auth.uid() or existing.customer_id <> p_customer_id
      or existing.event_type <> p_event_type or existing.note <> p_note
      or existing.result is distinct from p_result or existing.next_call_at is distinct from p_next_call_at
      or existing.attachment_path is distinct from p_attachment_path then
      raise exception 'Mã nhật ký đã được sử dụng cho nội dung khác';
    end if;
    return p_id;
  end if;
  insert into public.ts_activities(id,customer_id,event_type,result,note,next_call_at,attachment_path,legacy_key,legacy_time)
    values (p_id,p_customer_id,p_event_type,p_result,p_note,p_next_call_at,p_attachment_path,p_legacy_key,p_legacy_time);
  return p_id;
end; $$;
revoke all on function public.ts_log_activity(uuid,uuid,text,text,text,timestamptz,text,text,text) from public, anon;
grant execute on function public.ts_log_activity(uuid,uuid,text,text,text,timestamptz,text,text,text) to authenticated;

-- Tổng hợp riêng: nhân viên vẫn đếm được việc mình đã làm sau khi chuyển khách,
-- nhưng không được đọc lại thông tin hoặc lịch sử chi tiết của khách đã chuyển.
create function telesales_private.employee_report(p_start timestamptz,p_end timestamptz)
returns table(employee_id uuid,full_name text,active boolean,assigned_count bigint,call_count bigint,note_count bigint,potential_count bigint,overdue_count bigint)
language sql stable security definer set search_path = '' as $$
  select p.id,p.full_name,p.active,
    (select count(*) from public.ts_customers c where c.assigned_to=p.id),
    (select count(*) from public.ts_activities a where a.actor_id=p.id and a.event_type='call' and a.created_at>=p_start and a.created_at<p_end),
    (select count(*) from public.ts_activities a where a.actor_id=p.id and a.event_type='note' and a.created_at>=p_start and a.created_at<p_end),
    (select count(*) from public.ts_customers c where c.assigned_to=p.id and c.status in ('6. Khách quan tâm / Tiềm năng','7. Hẹn gặp nhà máy / Đã chốt dự án')),
    (select count(*) from public.ts_customers c where c.assigned_to=p.id and c.next_call_at<now())
  from public.ts_profiles p where auth.uid() is not null and telesales_private.current_role() is not null
    and (telesales_private.current_role()='admin' or p.id=auth.uid()) order by p.full_name;
$$;
revoke all on function telesales_private.employee_report(timestamptz,timestamptz) from public,anon;
grant execute on function telesales_private.employee_report(timestamptz,timestamptz) to authenticated;
create function public.ts_employee_report(p_start timestamptz,p_end timestamptz)
returns table(employee_id uuid,full_name text,active boolean,assigned_count bigint,call_count bigint,note_count bigint,potential_count bigint,overdue_count bigint)
language sql stable security invoker set search_path = '' as $$
  select * from telesales_private.employee_report(p_start,p_end);
$$;
revoke all on function public.ts_employee_report(timestamptz,timestamptz) from public, anon;
grant execute on function public.ts_employee_report(timestamptz,timestamptz) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values ('telesales-audio','telesales-audio',false,26214400,
    array['audio/mpeg','audio/mp4','audio/wav','audio/x-wav','audio/webm','audio/ogg','audio/aac','audio/x-m4a'])
  on conflict(id) do nothing;
create policy ts_audio_read on storage.objects for select to authenticated using (
  bucket_id='telesales-audio' and exists (
    select 1 from public.ts_customers c where c.id::text=split_part(name,'/',1)
  )
);
create policy ts_audio_upload on storage.objects for insert to authenticated with check (
  bucket_id='telesales-audio' and split_part(name,'/',2)=(select auth.uid())::text
  and exists(select 1 from public.ts_customers c where c.id::text=split_part(name,'/',1))
);
-- Không cho sửa/xóa file từ trình duyệt; file đính kèm dùng đường dẫn riêng từng lần.
commit;

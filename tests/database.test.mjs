import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('Phân quyền, chuyển giao và nhật ký trên PostgreSQL',async t=>{
 const db=new PGlite();
 const admin='10000000-0000-4000-8000-000000000001',a='10000000-0000-4000-8000-000000000002',b='10000000-0000-4000-8000-000000000003';
 const customer='20000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
 const activity='30000000-0000-4000-8000-000000000001';
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;
 create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;
 grant usage on schema storage to authenticated;grant select,insert on storage.objects to authenticated;
 insert into auth.users(id) values('${admin}'),('${a}'),('${b}');`);
 await db.exec(await readFile(new URL('../supabase/schema.sql',import.meta.url),'utf8'));
 await db.exec(`insert into public.ts_profiles(id) values('${admin}'),('${a}'),('${b}');
 update public.ts_profiles set role='admin',active=true,full_name='Quản trị' where id='${admin}';
 update public.ts_profiles set active=true,full_name=case when id='${a}' then 'Nhân viên A' else 'Nhân viên B' end where id in ('${a}','${b}');
 insert into public.ts_customers(id,customer,assigned_to) values('${customer}','Công ty A','${a}'),('${other}','Công ty B','${b}');`);
 async function as(id,sql,args=[]){await db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.sub','${id}',false)`);return db.query(sql,args);}
 async function root(sql,args=[]){await db.exec('reset role');return db.query(sql,args);}
 async function fails(action,pattern=/permission|quyền|row-level|không được|not allowed|nhân viên/i){await assert.rejects(action,pattern);}
 const params=[activity,customer,'call','3. Hẹn gọi lại','Khách hẹn gọi lại',null,null,null,null];
 const rpc='select public.ts_log_activity($1,$2,$3,$4,$5,$6,$7,$8,$9)';
 await t.test('Không tự cấp profile telesales cho tài khoản của ứng dụng khác',async()=>{
  const external='10000000-0000-4000-8000-000000000099';
  await root('insert into auth.users(id) values($1)',[external]);
  assert.equal((await root('select count(*)::int n from ts_profiles where id=$1',[external])).rows[0].n,0);
  assert.equal((await as(external,'select count(*)::int n from ts_customers')).rows[0].n,0);
 });
 await t.test('Nhân viên chỉ thấy khách được giao và không lấy được lịch sử khách khác',async()=>{
  assert.equal((await as(a,'select count(*)::int n from ts_customers')).rows[0].n,1);
  assert.equal((await as(a,'select count(*)::int n from ts_customers where id=$1',[other])).rows[0].n,0);
  assert.equal((await as(a,'select count(*)::int n from ts_activities where customer_id=$1',[other])).rows[0].n,0);
 });
 await t.test('Không thể tự nâng quyền hoặc giao lại khách bằng API trực tiếp',async()=>{
  await fails(()=>as(a,`update ts_profiles set role='admin' where id=$1`,[a]));
  assert.equal((await as(a,'update ts_customers set assigned_to=$1 where id=$2 returning id',[b,customer])).rows.length,0);
  await fails(()=>as(a,`update ts_customers set status='Chưa gọi' where id=$1`,[customer]));
 });
 await t.test('Tạo một lần chăm sóc và snapshot được cập nhật trong cùng giao dịch',async()=>{
  await as(a,rpc,params);
  const row=(await as(a,'select status,call_note from ts_customers where id=$1',[customer])).rows[0];
  assert.equal(row.status,'3. Hẹn gọi lại');assert.equal(row.call_note,'Khách hẹn gọi lại');
  assert.equal((await as(a,'select actor_name from ts_activities where id=$1',[activity])).rows[0].actor_name,'Nhân viên A');
 });
 await t.test('Gửi lại cùng ID không tạo trùng; đổi nội dung với ID cũ bị từ chối',async()=>{
  await as(a,rpc,params);
  assert.equal((await as(a,'select count(*)::int n from ts_activities where id=$1',[activity])).rows[0].n,1);
  await fails(()=>as(a,rpc,[...params.slice(0,4),'Khác nội dung',...params.slice(5)]),/nội dung khác/);
 });
 await t.test('Không sửa, xóa lịch sử hoặc giả mạo người gọi/thời gian',async()=>{
  await fails(()=>as(a,'delete from ts_activities where id=$1',[activity]));
  await fails(()=>as(a,"update ts_activities set note='x' where id=$1",[activity]));
  await fails(()=>as(a,"insert into ts_activities(customer_id,event_type,actor_id,note) values($1,'call',$2,'x')",[customer,b]));
  await fails(()=>as(a,"insert into ts_activities(customer_id,event_type,created_at,note) values($1,'call','2000-01-01','x')",[customer]));
  await fails(()=>as(a,"insert into ts_activities(customer_id,event_type,note) values($1,'assignment','x')",[customer]));
 });
 await t.test('Không ghi nhận cuộc gọi vào khách của người khác',async()=>{
  await fails(()=>as(b,rpc,['30000000-0000-4000-8000-000000000002',customer,...params.slice(2)]));
 });
 await t.test('Nhập ghi chú cũ không thay thế kết quả hiện tại hoặc tăng số lần gọi',async()=>{
  await as(admin,rpc,['30000000-0000-4000-8000-000000000003',customer,'legacy_import','8. Sai số / Nghỉ việc','Ghi chú cũ',null,null,'legacy:test','1/1/2025']);
  assert.equal((await as(admin,'select status from ts_customers where id=$1',[customer])).rows[0].status,'3. Hẹn gọi lại');
  const report=await as(admin,"select * from ts_employee_report('2000-01-01','2100-01-01')");
  assert.equal(Number(report.rows.find(r=>r.employee_id===a).call_count),1);
  assert.equal((await as(a,"select * from ts_employee_report('2000-01-01','2100-01-01')")).rows.length,1);
 });
 await t.test('Chuyển khách thu hồi quyền cũ, giữ lịch sử cho người mới và có dấu vết giao khách',async()=>{
  await as(admin,'update ts_customers set assigned_to=$1 where id=$2',[b,customer]);
  assert.equal((await as(a,'select count(*)::int n from ts_activities where customer_id=$1',[customer])).rows[0].n,0);
  assert.equal((await as(b,'select count(*)::int n from ts_activities where customer_id=$1',[customer])).rows[0].n,3);
  assert.equal((await as(b,"select count(*)::int n from ts_activities where customer_id=$1 and event_type='assignment'",[customer])).rows[0].n,1);
  await fails(()=>as(a,rpc,['30000000-0000-4000-8000-000000000004',customer,...params.slice(2)]));
  const ownReport=await as(a,"select * from ts_employee_report('2000-01-01','2100-01-01')");
  assert.equal(ownReport.rows.length,1);assert.equal(ownReport.rows[0].employee_id,a);assert.equal(Number(ownReport.rows[0].call_count),1);
 });
 await t.test('Âm thanh chỉ đọc được theo quyền khách, không tải lên đường dẫn người khác',async()=>{
  await root('insert into storage.objects(bucket_id,name) values($1,$2)',['telesales-audio',`${customer}/${a}/old.mp3`]);
  assert.equal((await as(a,'select count(*)::int n from storage.objects')).rows[0].n,0);
  assert.equal((await as(b,'select count(*)::int n from storage.objects')).rows[0].n,1);
  await fails(()=>as(b,'insert into storage.objects(bucket_id,name) values($1,$2)',['telesales-audio',`${customer}/${a}/spoof.mp3`]));
  await as(b,'insert into storage.objects(bucket_id,name) values($1,$2)',['telesales-audio',`${customer}/${b}/valid.mp3`]);
 });
 await t.test('Khóa nhân viên vô hiệu quyền ngay cả khi session/JWT còn hiệu lực',async()=>{
  await as(admin,'update ts_profiles set active=false where id=$1',[b]);
  assert.equal((await as(b,'select count(*)::int n from ts_customers')).rows[0].n,0);
  assert.equal((await as(b,'select count(*)::int n from ts_activities')).rows[0].n,0);
  assert.equal((await as(b,'select count(*)::int n from storage.objects')).rows[0].n,0);
  await fails(()=>as(b,rpc,['30000000-0000-4000-8000-000000000005',customer,...params.slice(2)]));
 });
 await t.test('Truy cập chưa đăng nhập bị từ chối và không có endpoint definer công khai',async()=>{
  await db.exec("reset role;set role anon;select set_config('request.jwt.claim.sub','',false)");
  await fails(()=>db.query('select * from public.ts_customers'));
  const unsafe=await root("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef");
  assert.equal(unsafe.rows.length,0);
 });
 await db.close();
});

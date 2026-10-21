import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

// Dashboard secrets: ALLOWED_ORIGINS=https://pvhdtg-dev.github.io
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY do Supabase cấp cho Edge Function.
const allowed = new Set((Deno.env.get('ALLOWED_ORIGINS') || 'https://pvhdtg-dev.github.io').split(',').map(s=>s.trim()));
Deno.serve(async req => {
  const origin=req.headers.get('origin') || '';
  const headers={
    'Content-Type':'application/json',
    'Access-Control-Allow-Origin':allowed.has(origin)?origin:'null',
    'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods':'POST, OPTIONS',
    'Cache-Control':'no-store', 'Vary':'Origin'
  };
  const reply=(status:number,body:object)=>new Response(JSON.stringify(body),{status,headers});
  if(!allowed.has(origin)) return reply(403,{error:'Nguồn truy cập không được phép.'});
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(req.method!=='POST')return reply(405,{error:'Chỉ hỗ trợ POST.'});
  const url=Deno.env.get('SUPABASE_URL');
  const secret=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if(!url || !secret)return reply(503,{error:'Chưa hoàn tất cấu hình dịch vụ cấp tài khoản.'});
  const server=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
  const token=req.headers.get('Authorization')?.replace(/^Bearer\s+/i,'');
  if(!token)return reply(401,{error:'Cần đăng nhập.'});
  const {data:{user},error:authError}=await server.auth.getUser(token);
  if(authError || !user)return reply(401,{error:'Phiên đăng nhập không hợp lệ.'});
  const {data:profile,error:profileError}=await server.from('ts_profiles').select('role,active').eq('id',user.id).single();
  if(profileError || profile?.role!=='admin' || !profile.active)return reply(403,{error:'Chỉ quản trị viên đang hoạt động được tạo nhân viên.'});
  let body;
  try {const raw=await req.text();if(raw.length>6000)return reply(413,{error:'Yêu cầu quá lớn.'});body=JSON.parse(raw);}
  catch{return reply(400,{error:'Dữ liệu không hợp lệ.'});}
  const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
  const password=typeof body.password==='string'?body.password:'';
  const name=typeof body.full_name==='string'?body.full_name.trim():'';
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254 || password.length<12 || password.length>256 || !name || name.length>120)
    return reply(400,{error:'Kiểm tra họ tên, email và mật khẩu (12–256 ký tự).'});
  // Không gửi email, không tạo vai trò theo dữ liệu client; tất cả tài khoản mới là staff.
  const {data:created,error:createError}=await server.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{full_name:name}});
  if(createError || !created.user)return reply(400,{error:'Chưa tạo được tài khoản. Email có thể đã tồn tại hoặc mật khẩu chưa đáp ứng yêu cầu hệ thống.'});
  const {error:activateError}=await server.from('ts_profiles').insert({id:created.user.id,full_name:name,role:'staff',active:true}).select('id').single();
  if(activateError)return reply(503,{error:'Tài khoản đã được tạo nhưng chưa kích hoạt. Quản trị viên cần kiểm tra danh sách nhân viên trước khi tạo lại.'});
  return reply(201,{user_id:created.user.id,full_name:name});
});

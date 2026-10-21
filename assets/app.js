import {STATUSES,parseLegacyContacts,normalizeLogs,legacyLogKey,reportBounds,csvCell} from './migration.js';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fold = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replaceAll('đ','d').replaceAll('Đ','D').toLowerCase();
const formatTime = value => value ? new Date(value).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',hour12:false}) : 'Chưa có';
const dateVN = value => new Date(new Date(value).getTime()+7*3600000).toISOString().slice(0,10);
const localDateTime = value => value ? new Date(new Date(value).getTime()+7*3600000).toISOString().slice(0,16) : '';
const isPotential = c => /^6\.|^7\./.test(c.status);
const isDue = c => c.next_call_at && new Date(c.next_call_at).getTime() <= Date.now();
const state = {profile:null,customers:[],profiles:[],selected:new Set(),page:0,view:'customers',current:null,history:[],reports:[],generation:0,busy:false,refreshing:false,draft:null};
let client;
let toastTimer;
let audioUrl;
const config = window.TELESALES_CONFIG || {};
const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.supabaseUrl || '') && (/^sb_publishable_/.test(config.publishableKey || '') || /^eyJ/.test(config.publishableKey || ''));
const options = (values,first='') => (first ? `<option value="">${escape(first)}</option>` : '') + values.map(v=>`<option value="${escape(v.value ?? v)}">${escape(v.label ?? v)}</option>`).join('');
const admin = () => state.profile?.role === 'admin';
function toast(message) { const box=$('#toast'); ($('dialog[open]') || document.body).append(box); box.textContent=message; box.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>box.hidden=true,6000); }
function errorText(err) {
  if (/Invalid login credentials/i.test(err?.message || '')) return 'Email hoặc mật khẩu không đúng.';
  if (/fetch|network|Failed to send/i.test(err?.message || '')) return 'Không kết nối được hệ thống. Kiểm tra mạng và thử lại.';
  if (err?.code === '42501') return 'Tài khoản không có quyền thực hiện thao tác này. Hãy cập nhật dữ liệu.';
  if (err?.code === '23505') return 'Dữ liệu này đã tồn tại. Hãy cập nhật danh sách trước khi thử lại.';
  return err?.message || 'Không thể hoàn tất thao tác.';
}
async function run(form,action) {
  if (form.dataset.busy === 'yes') return;
  form.dataset.busy='yes';
  const controls=[...form.querySelectorAll('button,input,select,textarea')];
  const disabled=controls.map(c=>c.disabled);
  const data=new FormData(form);
  controls.forEach(c=>c.disabled=true);
  try { await action(data); } catch(err) { toast(errorText(err)); }
  finally { controls.forEach((c,i)=>c.disabled=disabled[i]); delete form.dataset.busy; }
}
function clearAudio() {
  const audio=$('#audio-player'); audio.pause(); audio.removeAttribute('src'); audio.load(); audio.hidden=true;
  if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl=null;
}
function clearData() {
  state.generation++; state.profile=null; state.customers=[]; state.profiles=[]; state.history=[]; state.reports=[];
  state.refreshing=false;
  state.selected.clear(); state.current=null; state.draft=null; state.page=0;
  clearAudio(); $$('dialog[open]').forEach(d=>d.close());
  $('#activity-form').reset(); $('#create-user-form').reset();
  $('#new-customer-form').reset(); $('#import-contacts-form').reset(); $('#import-logs-form').reset();
  $('#search').value=''; $('#filter-status').value=''; $('#filter-due').checked=false;
  $('#filter-province').innerHTML=options([],'Tất cả tỉnh / thành');
  $('#filter-assignee').innerHTML=options([],'Tất cả nhân viên');
  $('#bulk-assignee').innerHTML=options([],'Chọn người phụ trách');
  $('#detail-name').textContent=''; $('#account-name').textContent=''; $('#account-role').textContent='';
  $('#activity-message').textContent=''; $('#migration-result').textContent=''; $('#migration-result').hidden=true;
  $('#toast').hidden=true; document.body.append($('#toast'));
  $('#customer-list').replaceChildren(); $('#history-list').replaceChildren(); $('#report-rows').replaceChildren(); $('#team-list').replaceChildren(); $('#detail-contact').replaceChildren();
  $('#workspace').hidden=true; $('#login-screen').hidden=false;
}
async function logout(message='Đã đăng xuất trên thiết bị này.') {
  clearData();
  try { await client.auth.signOut({scope:'local'}); } catch {}
  sessionStorage.removeItem('telesales-team-auth');
  if (message) $('#login-error').textContent=message;
}
async function allRows(table,columns='*') {
  const output=[];
  for(let start=0;;start+=1000) {
    const {data,error}=await client.from(table).select(columns).order('id').range(start,start+999);
    if(error) throw error;
    output.push(...data);
    if(data.length<1000) return output;
  }
}
async function bootstrap(session) {
  if (!session) { clearData(); return; }
  if (state.profile?.id === session.user.id) return;
  clearData(); const generation=state.generation;
  try {
    const {data:profile,error}=await client.from('ts_profiles').select('*').eq('id',session.user.id).single();
    if(generation!==state.generation) return;
    if(error?.code==='PGRST116') return logout('Tài khoản chưa được cấp quyền Telesales. Vui lòng liên hệ quản trị viên.');
    if(error) throw error;
    if(!profile.active) return logout('Tài khoản chưa được kích hoạt hoặc đã bị tạm khóa. Vui lòng liên hệ quản trị viên.');
    state.profile=profile;
    localStorage.removeItem('telesales_saved_pwd');
    $('#login-error').textContent=''; $('#login-form').reset();
    $('#account-name').textContent=profile.full_name || session.user.email;
    $('#account-role').textContent=admin() ? 'QUẢN TRỊ' : 'NHÂN VIÊN';
    $$('.admin-only').forEach(e=>e.hidden=!admin());
    $('#login-screen').hidden=true; $('#workspace').hidden=false;
    setView('customers'); await refresh();
  } catch(err) { if(generation===state.generation) { clearData(); $('#login-error').textContent=errorText(err); } }
}
async function refresh() {
  if(!state.profile || state.refreshing) return;
  state.refreshing=true; const generation=state.generation;
  try {
    const {data:profile,error}=await client.from('ts_profiles').select('*').eq('id',state.profile.id).single();
    if(generation!==state.generation) return;
    if(error) throw error;
    if(!profile?.active) { await logout('Tài khoản đã bị tạm khóa.'); return; }
    if(profile.role !== state.profile.role) { await logout('Quyền tài khoản đã thay đổi. Vui lòng đăng nhập lại.'); return; }
    const [customers,profiles]=await Promise.all([allRows('ts_customers'),allRows('ts_profiles')]);
    if(generation!==state.generation) return;
    state.customers=customers; state.profiles=profiles; state.profile=profile;
    const ids=new Set(customers.map(c=>c.id));
    state.selected=new Set([...state.selected].filter(id=>ids.has(id)));
    if(state.current && !ids.has(state.current.id)) {
      $('#customer-dialog').close(); state.current=null; state.history=[]; $('#history-list').replaceChildren(); $('#activity-form').reset(); clearAudio();
      toast('Khách đã được chuyển hoặc quyền truy cập đã thay đổi.');
    }
    $('#sync-banner').hidden=true; $('#connection-label').textContent='Đã kết nối · cập nhật mỗi 15s';
    $('#last-sync').textContent='Lần đồng bộ: '+formatTime(new Date());
    renderFilters(); renderCustomers(); renderTeam();
    if(state.view==='reports') await loadReport();
    if(state.current && $('#customer-dialog').open && !state.busy) await loadHistory();
  } catch(err) {
    if(generation!==state.generation) return;
    // Không giữ danh bạ hiển thị khi chưa kiểm tra lại được quyền.
    state.customers=[]; state.profiles=[]; state.history=[]; state.selected.clear(); state.current=null;
    $('#customer-dialog').close(); $('#history-list').replaceChildren(); $('#detail-contact').replaceChildren(); clearAudio();
    renderCustomers(); $('#team-list').replaceChildren(); $('#report-rows').replaceChildren();
    $('#sync-banner').textContent='Chưa kiểm tra được dữ liệu và quyền truy cập. '+errorText(err); $('#sync-banner').hidden=false;
    $('#connection-label').textContent='Chưa đồng bộ';
  } finally { if(generation===state.generation) state.refreshing=false; }
}
function renderFilters() {
  const province=$('#filter-province').value,assignee=$('#filter-assignee').value,bulk=$('#bulk-assignee').value;
  $('#filter-province').innerHTML=options([...new Set(state.customers.map(c=>c.province).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'vi')),'Tất cả tỉnh / thành');
  $('#filter-province').value=province;
  const people=state.profiles.map(p=>({value:p.id,label:p.full_name+(p.active ? '' : ' (tạm khóa)')}));
  $('#filter-assignee').innerHTML=options([{value:'unassigned',label:'Chưa phân công'},...people],'Tất cả nhân viên'); $('#filter-assignee').value=assignee;
  $('#bulk-assignee').innerHTML=options([{value:'unassigned',label:'Thu hồi về danh sách chưa giao'},...people.filter(p=>state.profiles.find(x=>x.id===p.value)?.active)],'Chọn người phụ trách'); $('#bulk-assignee').value=bulk;
}
function filteredCustomers() {
  const query=fold($('#search').value),province=$('#filter-province').value,status=$('#filter-status').value,assignee=$('#filter-assignee').value;
  return state.customers.filter(c=>(!query || fold([c.customer,c.contact,c.phone,c.email,c.area].join(' ')).includes(query))
    && (!province || c.province===province) && (!status || c.status===status)
    && (!admin() || !assignee || (assignee==='unassigned' ? !c.assigned_to : c.assigned_to===assignee))
    && (!$('#filter-due').checked || isDue(c)));
}
function renderCustomers() {
  $('#nav-count').textContent=state.customers.length;
  $('#metric-total').textContent=state.customers.length;
  $('#metric-new').textContent=state.customers.filter(c=>c.status==='Chưa gọi').length;
  $('#metric-potential').textContent=state.customers.filter(isPotential).length;
  $('#metric-due').textContent=state.customers.filter(isDue).length;
  const filtered=filteredCustomers(),size=12,pages=Math.max(1,Math.ceil(filtered.length/size));
  state.page=Math.max(0,Math.min(state.page,pages-1));
  const current=filtered.slice(state.page*size,(state.page+1)*size);
  $('#customer-summary').textContent=`${filtered.length} khách phù hợp · ${admin() ? 'Quản lý toàn bộ và phân công nhân viên' : 'Khách được giao cho bạn'}`;
  $('#customer-list').innerHTML=current.length ? current.map(c=> {
    const assignee=state.profiles.find(p=>p.id===c.assigned_to)?.full_name || (c.assigned_to ? 'Người phụ trách trước' : 'Chưa phân công');
    const phone=String(c.phone).replace(/[^\d+]/g,'');
    return `<article class="customer-card"><div class="card-top">${admin()?`<label class="check"><input type="checkbox" data-select="${escape(c.id)}" aria-label="Chọn ${escape(c.customer)}" ${state.selected.has(c.id)?'checked':''}></label>`:''}<div><h3>${escape(c.customer)}</h3><span class="card-code">#${escape(c.legacy_id || c.id.slice(0,8))}</span></div><span class="status ${isPotential(c)?'potential':''}">${escape(c.status)}</span></div><div class="card-person"><div><strong>${escape(c.contact || 'Chưa có người liên hệ')}</strong><small>${escape(c.position || c.email || 'Thông tin liên hệ')}</small></div>${phone?`<a href="tel:${escape(phone)}">${escape(c.phone)}</a>`:''}</div><div class="card-meta"><span>${escape([c.area,c.province].filter(Boolean).join(' · ') || 'Chưa có khu vực')}</span><span>${escape(assignee)}</span></div><div class="card-note">${escape(c.call_note || 'Chưa có ghi chú chăm sóc mới.')}</div><div class="card-bottom"><span class="${isDue(c)?'error':''}">${c.next_call_at?'Hẹn: '+escape(formatTime(c.next_call_at)):'Chưa có lịch gọi lại'}</span><button data-open="${escape(c.id)}">Chăm sóc & lịch sử →</button></div></article>`;
  }).join('') : '<div class="empty">Chưa có khách hàng trong danh sách này.<br>Quản trị viên có thể nhập danh bạ và giao khách cho nhân viên.</div>';
  $('#page-label').textContent=`Trang ${state.page+1} / ${pages}`;
  $('#previous-page').disabled=state.page===0; $('#next-page').disabled=state.page>=pages-1;
  $('#selection-count').textContent=state.selected.size+' khách đã chọn';
  $('#select-all').checked=current.length>0 && current.every(c=>state.selected.has(c.id));
  $('#select-all').indeterminate=current.some(c=>state.selected.has(c.id))&&!$('#select-all').checked;
}
function setView(view) {
  if(['team','migration'].includes(view) && !admin()) return;
  state.view=view;
  $$('.view').forEach(e=>e.hidden=e.id!==view+'-view');
  $$('.nav-item').forEach(e=>e.classList.toggle('selected',e.dataset.view===view));
  $('#view-title').textContent={customers:'Khách hàng',reports:'Báo cáo nhân viên',team:'Nhân viên',migration:'Chuyển dữ liệu cũ'}[view];
  $('#view-eyebrow').textContent=admin()?'KHÔNG GIAN QUẢN TRỊ':'KHÔNG GIAN NHÂN VIÊN';
  if(view==='reports') loadReport().catch(e=>toast(errorText(e)));
}
async function openCustomer(id) {
  const current=state.customers.find(c=>c.id===id); if(!current) return;
  state.current=current; state.history=[]; state.draft=null;
  clearAudio(); $('#activity-form').reset(); $('#activity-message').textContent='';
  $('#detail-name').textContent=current.customer;
  $('#detail-contact').innerHTML=`<div class="detail-grid"><div><span class="muted">NGƯỜI LIÊN HỆ</span><br>${escape(current.contact || 'Chưa có')} · ${escape(current.position)}</div><div><span class="muted">ĐIỆN THOẠI / EMAIL</span><br>${escape(current.phone)}<br>${escape(current.email)}</div><div class="wide"><span class="muted">ĐỊA CHỈ</span><br>${escape([current.address,current.area,current.province].filter(Boolean).join(' · '))}</div>${current.original_note?`<div class="wide"><span class="muted">GHI CHÚ GỐC</span><br>${escape(current.original_note)}</div>`:''}</div>`;
  $('#activity-status').value=current.status;
  $('#activity-form').elements.next_call_at.value=localDateTime(current.next_call_at);
  $('#customer-dialog').showModal(); await loadHistory();
}
async function loadHistory(more=false) {
  if(!state.current) return;
  const id=state.current.id,generation=state.generation,start=more?state.history.length:0;
  const {data,error}=await client.from('ts_activities').select('*').eq('customer_id',id).order('created_at',{ascending:false}).order('id').range(start,start+49);
  if(error) throw error;
  if(generation!==state.generation || state.current?.id!==id) return;
  state.history=more?[...state.history,...data]:data;
  $('#history-count').textContent=state.history.length+' bản ghi đã tải'; $('#more-history').hidden=data.length<50;
  $('#history-list').innerHTML=state.history.length ? state.history.map(a=>`<article class="timeline-item"><time>${escape(formatTime(a.created_at))}</time> · <strong>${escape(a.actor_name || 'Quản trị hệ thống')}</strong><div class="muted">${escape({call:'Cuộc gọi',note:'Ghi chú / chăm sóc khác',assignment:'Thay đổi người phụ trách',legacy_import:'Nhập dữ liệu cũ'}[a.event_type])}${a.result?' · '+escape(a.result):''}</div><p>${escape(a.note)}</p>${a.event_type==='assignment'?`<div class="muted">${escape(state.profiles.find(p=>p.id===a.previous_assignee)?.full_name || (a.previous_assignee?'Nhân viên trước':'Chưa phân công'))} → ${escape(state.profiles.find(p=>p.id===a.new_assignee)?.full_name || (a.new_assignee?'Người được giao':'Chưa phân công'))}</div>`:''}${a.legacy_time?`<div class="muted">Thời gian gốc (chưa xác minh): ${escape(a.legacy_time)}</div>`:''}${a.next_call_at?`<div class="muted">Hẹn: ${escape(formatTime(a.next_call_at))}</div>`:''}${a.attachment_path?`<button class="secondary" data-audio="${escape(a.id)}">▶ Nghe âm thanh</button>`:''}</article>`).join('') : '<p class="muted">Chưa có lịch sử. Lần chăm sóc đầu tiên sẽ được lưu tại đây.</p>';
}
async function uploadAudio(file,draft) {
  if(!file || !file.size) return null;
  if(file.size>25*1024*1024) throw new Error('File âm thanh vượt quá 25 MB.');
  const accepted=['audio/mpeg','audio/mp4','audio/wav','audio/x-wav','audio/webm','audio/ogg','audio/aac','audio/x-m4a'];
  const ext=file.name.split('.').pop().toLowerCase();
  const types={mp3:'audio/mpeg',m4a:'audio/mp4',mp4:'audio/mp4',wav:'audio/wav',webm:'audio/webm',ogg:'audio/ogg',aac:'audio/aac'};
  const contentType=accepted.includes(file.type)?file.type:types[ext];
  if(!contentType) throw new Error('Chỉ nhận file âm thanh MP3, M4A, WAV, WebM, OGG hoặc AAC.');
  const path=draft.path || `${state.current.id}/${state.profile.id}/${draft.id}.${Object.hasOwn(types,ext)?ext:'audio'}`;
  draft.path=path;
  if(draft.uploaded) return path;
  const {error}=await client.storage.from('telesales-audio').upload(path,file,{contentType,upsert:false});
  if(error && String(error.statusCode)!=='409') throw error;
  draft.uploaded=true; return path;
}
async function saveActivity(data) {
  if(!state.current || !state.profile) return;
  const cId=state.current.id,generation=state.generation;
  state.busy=true;
  try {
    const note=String(data.get('note') || '').trim();
    if(!note) throw new Error('Vui lòng nhập nội dung chăm sóc.');
    const next=data.get('next_call_at')?new Date(data.get('next_call_at')+':00+07:00').toISOString():null;
    const file=data.get('audio');
    const fingerprint=JSON.stringify([cId,data.get('event_type'),data.get('result'),note,next,file?.name,file?.size,file?.lastModified]);
    if(state.draft?.fingerprint!==fingerprint) state.draft={id:crypto.randomUUID(),fingerprint};
    const path=await uploadAudio(file,state.draft);
    if(generation!==state.generation) return;
    $('#activity-message').textContent='Đang lưu và chờ hệ thống xác nhận…';
    const {error}=await client.rpc('ts_log_activity',{p_id:state.draft.id,p_customer_id:cId,p_event_type:data.get('event_type'),p_result:data.get('result'),p_note:note,p_next_call_at:next,p_attachment_path:path});
    if(error) throw error;
    if(generation!==state.generation) return;
    state.draft=null; $('#activity-form').elements.note.value=''; $('#activity-form').elements.audio.value='';
    $('#activity-message').textContent='Đã lưu lên hệ thống.';
    toast('Đã lưu lần chăm sóc.'); await refresh();
    await loadHistory();
  } catch(err) { $('#activity-message').textContent='Chưa xác nhận lưu. '+errorText(err)+' Giữ nguyên nội dung và thử lại để tránh ghi trùng.'; throw err; }
  finally { state.busy=false; }
}
async function assignSelected() {
  if(!admin() || !state.selected.size) return toast('Hãy chọn khách cần giao.');
  const value=$('#bulk-assignee').value; if(!value) return toast('Hãy chọn người phụ trách.');
  const ids=[...state.selected],generation=state.generation; const button=$('#assign'); button.disabled=true;
  try {
    for(let i=0;i<ids.length;i+=100) {
      if(generation!==state.generation) return;
      const {error}=await client.from('ts_customers').update({assigned_to:value==='unassigned'?null:value}).in('id',ids.slice(i,i+100));
      if(error) throw error;
    }
    if(generation!==state.generation) return;
    state.selected.clear(); toast('Đã cập nhật người phụ trách cho '+ids.length+' khách.'); await refresh();
  } catch(err) { toast(errorText(err)); await refresh(); } finally { button.disabled=false; }
}
async function loadReport() {
  if(!state.profile) return;
  const generation=state.generation;
  const bounds=reportBounds($('#report-start').value,$('#report-end').value);
  const {data,error}=await client.rpc('ts_employee_report',{p_start:bounds.start,p_end:bounds.end});
  if(error) throw error;
  if(generation!==state.generation) return;
  state.reports=data;
  $('#report-rows').innerHTML=data.length?data.map(r=>`<tr><td>${escape(r.full_name || 'Chưa đặt tên')}${r.active?'':' (tạm khóa)'}</td><td>${r.assigned_count}</td><td>${r.call_count}</td><td>${r.note_count}</td><td>${r.potential_count}</td><td>${r.overdue_count}</td></tr>`).join(''):'<tr><td colspan="6">Chưa có dữ liệu báo cáo.</td></tr>';
}
function renderTeam() {
  if(!admin()) return;
  $('#team-list').innerHTML=state.profiles.map(p=>`<div class="team-row"><span class="team-avatar">${escape((p.full_name || '?').slice(0,1).toUpperCase())}</span><div><strong>${escape(p.full_name || 'Chưa đặt tên')}</strong><small>${p.role==='admin'?'Quản trị':'Nhân viên'} · ${p.active?'Đang hoạt động':'Tạm khóa / chưa kích hoạt'}</small></div>${p.role==='staff'?`<button data-toggle-user="${escape(p.id)}" class="secondary">${p.active?'Tạm khóa':'Kích hoạt'}</button>`:''}</div>`).join('');
}
async function createUser(data) {
  if(!admin()) return;
  const {data:response,error}=await client.functions.invoke(config.functionsName || 'telesales-users',{body:{email:String(data.get('email')).trim(),password:data.get('password'),full_name:String(data.get('full_name')).trim()}});
  if(error) {
    let message='Chưa tạo được tài khoản. Quản trị viên cần kiểm tra dịch vụ cấp tài khoản.';
    try { const detail=await error.context.json(); message=detail.error || message; } catch {}
    throw new Error(message);
  }
  if(!response?.user_id) throw new Error(response?.error || 'Hệ thống chưa xác nhận tạo tài khoản.');
  $('#create-user-form').reset(); toast('Đã tạo tài khoản nhân viên. Anh có thể giao khách ngay.'); await refresh();
}
async function importContacts() {
  if(!admin()) return;
  const generation=state.generation;
  const file=$('#contacts-file').files[0]; if(!file) return;
  if(file.size>35*1024*1024) throw new Error('File vượt quá 35 MB.');
  const rows=await parseLegacyContacts(await file.text(),$('#legacy-password').value);
  if(generation!==state.generation) return;
  $('#legacy-password').value='';
  let inserted=0; const ids=new Set(state.customers.map(c=>c.legacy_id));
  const fresh=rows.filter(r=>!ids.has(r.legacy_id));
  for(let i=0;i<fresh.length;i+=100) {
    if(generation!==state.generation) return;
    const {error}=await client.from('ts_customers').insert(fresh.slice(i,i+100));
    if(error) throw new Error(`Đã nhập ${inserted} khách. `+errorText(error)+' Có thể nhập lại file; ID đã có sẽ được bỏ qua sau khi cập nhật.');
    inserted+=fresh.slice(i,i+100).length;
    showMigration(`Đang nhập: ${inserted}/${fresh.length} khách…`);
  }
  showMigration(`Đã nhập ${inserted} khách; bỏ qua ${rows.length-fresh.length} ID đã tồn tại. Danh bạ mới đang ở mục Chưa phân công.`);
  await refresh();
}
function showMigration(message) { $('#migration-result').textContent=message; $('#migration-result').hidden=false; }
async function importLogs(content) {
  if(!admin()) return;
  const generation=state.generation;
  const rows=normalizeLogs(JSON.parse(content));
  const map=new Map(state.customers.map(c=>[c.legacy_id,c.id]));
  let saved=0,skipped=0,unknown=0,audio=0;
  for(const row of rows) {
    if(generation!==state.generation) return;
    if(!map.has(row.legacy_id)) {unknown++;continue;}
    if(row.has_audio) audio++;
    const key=await legacyLogKey(row);
    const {data:existing,error:lookupError}=await client.from('ts_activities').select('id').eq('legacy_key',key).limit(1);
    if(lookupError) throw lookupError;
    if(existing.length) {skipped++;continue;}
    const {error}=await client.rpc('ts_log_activity',{p_id:crypto.randomUUID(),p_customer_id:map.get(row.legacy_id),p_event_type:'legacy_import',p_result:row.result,p_note:row.note || '(Không có ghi chú)',p_legacy_key:key,p_legacy_time:row.legacy_time || null});
    if(error) throw new Error(`Đã nhập ${saved} ghi chú. `+errorText(error));
    saved++; if(saved%20===0) showMigration(`Đã nhập ${saved} ghi chú…`);
  }
  showMigration(`Đã nhập ${saved} ghi chú; bỏ qua ${skipped} bản trùng; ${unknown} ID chưa có trong danh bạ. ${audio} bản có tham chiếu âm thanh cần đính kèm riêng. Nội dung cũ không ghi đè trạng thái hiện tại.`);
  await refresh();
}

$('#filter-status').innerHTML=options(STATUSES,'Tất cả trạng thái'); $('#activity-status').innerHTML=options(STATUSES);
const today=dateVN(new Date()); $('#report-start').value=today.slice(0,7)+'-01'; $('#report-end').value=today;
$$('[data-view]').forEach(e=>e.addEventListener('click',()=>setView(e.dataset.view)));
$$('[data-close]').forEach(e=>e.addEventListener('click',()=>$('#'+e.dataset.close).close()));
['#search','#filter-province','#filter-status','#filter-assignee','#filter-due'].forEach(selector=>$(selector).addEventListener(selector==='#search'?'input':'change',()=>{state.page=0;renderCustomers();}));
$('#customer-list').addEventListener('click',e=>{const b=e.target.closest('[data-open]'); if(b) openCustomer(b.dataset.open).catch(err=>toast(errorText(err)));});
$('#customer-list').addEventListener('change',e=>{const id=e.target.dataset.select;if(id){e.target.checked?state.selected.add(id):state.selected.delete(id);renderCustomers();}});
$('#select-all').addEventListener('change',e=>{filteredCustomers().slice(state.page*12,(state.page+1)*12).forEach(c=>e.target.checked?state.selected.add(c.id):state.selected.delete(c.id));renderCustomers();});
$('#previous-page').addEventListener('click',()=>{state.page--;renderCustomers();}); $('#next-page').addEventListener('click',()=>{state.page++;renderCustomers();});
$('#assign').addEventListener('click',assignSelected); $('#refresh').addEventListener('click',refresh);
$('#activity-form').addEventListener('submit',e=>{e.preventDefault();run(e.currentTarget,saveActivity);});
$('#customer-dialog').addEventListener('close',clearAudio);
$('#more-history').addEventListener('click',()=>loadHistory(true).catch(e=>toast(errorText(e))));
$('#history-list').addEventListener('click',async e=>{
  const button=e.target.closest('[data-audio]'); if(!button) return;
  const entry=state.history.find(a=>a.id===button.dataset.audio); if(!entry) return;
  const generation=state.generation,customerId=state.current?.id;
  button.disabled=true;
  try {
    const {data,error}=await client.storage.from('telesales-audio').download(entry.attachment_path);
    if(error) throw error;
    if(generation!==state.generation || customerId!==state.current?.id || !$('#customer-dialog').open) return;
    clearAudio(); audioUrl=URL.createObjectURL(data); $('#audio-player').src=audioUrl; $('#audio-player').hidden=false; await $('#audio-player').play();
  } catch(err) {toast(errorText(err));} finally {button.disabled=false;}
});
$('#report-form').addEventListener('submit',e=>{e.preventDefault();run(e.currentTarget,loadReport);});
$('#export-report').addEventListener('click',()=>{
  if(!admin()) return;
  const rows=[['Nhân viên','Khách được giao hiện tại','Lần gọi trong kỳ','Ghi chú trong kỳ','Tiềm năng hiện tại','Quá hạn hiện tại'],...state.reports.map(r=>[r.full_name,r.assigned_count,r.call_count,r.note_count,r.potential_count,r.overdue_count])];
  const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=`Telesales-bao-cao-${$('#report-start').value}-${$('#report-end').value}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('#team-list').addEventListener('click',async e=>{
  const b=e.target.closest('[data-toggle-user]');if(!b || !admin())return;
  const profile=state.profiles.find(p=>p.id===b.dataset.toggleUser);if(!profile || profile.role!=='staff')return;
  b.disabled=true;
  try {const {error}=await client.from('ts_profiles').update({active:!profile.active}).eq('id',profile.id);if(error)throw error;await refresh();toast(profile.active?'Đã tạm khóa. Khách vẫn được giữ để anh quyết định chuyển giao.':'Đã kích hoạt tài khoản.');}
  catch(err){toast(errorText(err));}finally{b.disabled=false;}
});
$('#create-user-form').addEventListener('submit',e=>{e.preventDefault();run(e.currentTarget,createUser);});
$('#new-customer').addEventListener('click',()=>{if(admin())$('#new-customer-dialog').showModal();});
$('#new-customer-form').addEventListener('submit',e=>{e.preventDefault();run(e.currentTarget,async data=>{
  if(!admin())return;
  const row=Object.fromEntries([...data].map(([k,v])=>[k,String(v).trim()]));
  const {error}=await client.from('ts_customers').insert(row);if(error)throw error;
  $('#new-customer-dialog').close();$('#new-customer-form').reset();await refresh();toast('Đã thêm khách vào danh sách chưa phân công.');
});});
$('#import-contacts-form').addEventListener('submit',e=>{e.preventDefault();run(e.currentTarget,importContacts);});
$('#import-logs-form').addEventListener('submit',e=>{e.preventDefault();run(e.currentTarget,async()=>{const file=$('#logs-file').files[0];if(file.size>35*1024*1024)throw new Error('File quá lớn.');await importLogs(await file.text());});});
$('#import-local').addEventListener('click',()=>run($('#import-logs-form'),async()=>{const content=localStorage.getItem('telesales_user_logs');if(!content)throw new Error('Không có ghi chú cũ trên trình duyệt này. Hãy dùng file JSON sao lưu.');await importLogs(content);}));
window.addEventListener('offline',()=>{ $('#sync-banner').textContent='Đang mất mạng. Chỉ thông báo “Đã lưu” sau khi hệ thống xác nhận.';$('#sync-banner').hidden=false; });
window.addEventListener('online',refresh);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
setInterval(()=>{if(!document.hidden && !state.busy && !$$('form').some(f=>f.dataset.busy==='yes'))refresh();},15000);
if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).catch(()=>{});
if(!configured || !window.supabase?.createClient) {
  $('#setup-notice').hidden=false; $('#login-submit').disabled=true;
} else {
  client=window.supabase.createClient(config.supabaseUrl,config.publishableKey,{auth:{storage:window.sessionStorage,storageKey:'telesales-team-auth',persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  client.auth.onAuthStateChange((_event,session)=>{setTimeout(()=>bootstrap(session),0);});
  $('#login-form').addEventListener('submit',async e=>{
    e.preventDefault();const form=e.currentTarget;$('#login-error').textContent='';
    await run(form,async data=>{const {error}=await client.auth.signInWithPassword({email:String(data.get('email')).trim(),password:data.get('password')});if(error){$('#login-error').textContent=errorText(error);throw error;}});
  });
  $('#logout').addEventListener('click',()=>logout());
}

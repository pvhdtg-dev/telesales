import {STATUSES, parseLegacyContacts, normalizeLogs, legacyLogKey, reportBounds, csvCell} from './migration.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fold = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replaceAll('đ', 'd').replaceAll('Đ', 'D').toLowerCase();
const formatTime = value => value ? new Date(value).toLocaleString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh', hour12: false}) : 'Chưa có';
const dateVN = value => new Date(new Date(value).getTime() + 7 * 3600000).toISOString().slice(0, 10);

const STATUS_CONFIG = {
  "Chưa gọi": { label: "Chưa gọi", color: "bg-slate-100 text-slate-700 border-slate-300", badgeColor: "bg-slate-500" },
  "1. Không nghe máy": { label: "1. Không nghe máy", color: "bg-amber-50 text-amber-800 border-amber-300", badgeColor: "bg-amber-500" },
  "2. Thuê bao / Bận máy": { label: "2. Thuê bao / Bận", color: "bg-orange-50 text-orange-800 border-orange-300", badgeColor: "bg-orange-500" },
  "3. Hẹn gọi lại": { label: "3. Hẹn gọi lại", color: "bg-yellow-50 text-yellow-900 border-yellow-300", badgeColor: "bg-yellow-500" },
  "4. Nhầm người / Chuyển người khác": { label: "4. Chuyển người khác", color: "bg-blue-50 text-blue-800 border-blue-300", badgeColor: "bg-blue-500" },
  "5. Đã kết nối Zalo / Gửi tài liệu": { label: "5. Gửi Zalo/Catalog", color: "bg-cyan-50 text-cyan-800 border-cyan-300", badgeColor: "bg-cyan-500" },
  "6. Khách quan tâm / Tiềm năng": { label: "6. Tiềm năng cao", color: "bg-emerald-50 text-emerald-800 border-emerald-300", badgeColor: "bg-emerald-500" },
  "7. Hẹn gặp nhà máy / Đã chốt dự án": { label: "7. Hẹn gặp / Chốt DA", color: "bg-teal-50 text-teal-900 border-teal-300", badgeColor: "bg-teal-600" },
  "8. Sai số / Nghỉ việc": { label: "8. Sai số / Nghỉ việc", color: "bg-rose-50 text-rose-800 border-rose-300", badgeColor: "bg-rose-500" },
  "9. Từ chối / Không có nhu cầu": { label: "9. Từ chối", color: "bg-gray-100 text-gray-700 border-gray-300", badgeColor: "bg-gray-500" }
};

const state = {
  profile: null,
  customers: [],
  profiles: [],
  selected: new Set(),
  page: 0,
  pageSize: 20,
  activeProvince: 'ALL',
  activeArea: 'ALL',
  activeFilter: 'ALL',
  activeSearchQuery: '',
  activeSort: 'id_asc',
  activeAssigneeFilter: '',
  generation: 0,
  refreshing: false,
  currentRecordingContactId: null,
  activeAudioUrl: null
};

let client;
let toastTimer;
const config = window.TELESALES_CONFIG || {};
const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.supabaseUrl || '') && (/^sb_publishable_/.test(config.publishableKey || '') || /^eyJ/.test(config.publishableKey || ''));

const admin = () => state.profile?.role === 'admin';

function toast(message, type = 'info') {
  const box = $('#toast');
  if (!box) return;
  box.textContent = message;
  box.className = `fixed bottom-5 right-5 z-50 px-4 py-2.5 rounded-2xl shadow-xl text-xs font-semibold text-white backdrop-blur-sm transition-all transform duration-200 show ${
    type === 'error' ? 'bg-rose-900/95 border border-rose-700' :
    type === 'success' ? 'bg-emerald-900/95 border border-emerald-700' :
    'bg-slate-900/95 border border-slate-700'
  }`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.className = box.className.replace('show', '') + ' translate-y-10 opacity-0 pointer-events-none';
  }, 4000);
}

function errorText(err) {
  if (/Invalid login credentials/i.test(err?.message || '')) return 'Email hoặc mật khẩu không đúng.';
  if (/fetch|network|Failed to send/i.test(err?.message || '')) return 'Không kết nối được hệ thống. Kiểm tra mạng và thử lại.';
  if (err?.code === '42501') return 'Tài khoản không có quyền thực hiện thao tác này.';
  if (err?.code === '23505') return 'Dữ liệu này đã tồn tại trên hệ thống.';
  return err?.message || 'Không thể hoàn tất thao tác.';
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    toast(`Đã sao chép SĐT: ${text}`, 'success');
  }).catch(() => {
    toast('Không thể sao chép SĐT', 'error');
  });
}

// ========================================================
// AUTHENTICATION & BOOTSTRAP
// ========================================================
async function logout(message = 'Đã đăng xuất khỏi hệ thống.') {
  state.generation++;
  state.profile = null;
  state.customers = [];
  state.profiles = [];
  state.selected.clear();
  try { await client.auth.signOut({scope: 'local'}); } catch {}
  sessionStorage.removeItem('telesales-team-auth');
  $('#mainApp')?.classList.add('hidden');
  $('#loginScreen')?.classList.remove('hidden');
  if (message && $('#loginErrorText')) {
    $('#loginErrorText').textContent = message;
    $('#loginError')?.classList.remove('hidden');
  }
}

async function allRows(table, columns = '*') {
  const output = [];
  for (let start = 0;; start += 1000) {
    const {data, error} = await client.from(table).select(columns).order('id').range(start, start + 999);
    if (error) throw error;
    output.push(...data);
    if (data.length < 1000) return output;
  }
}

async function bootstrap(session) {
  if (!session) {
    $('#mainApp')?.classList.add('hidden');
    $('#loginScreen')?.classList.remove('hidden');
    return;
  }
  if (state.profile?.id === session.user.id) return;
  state.generation++;
  const gen = state.generation;

  try {
    const {data: profile, error} = await client.from('ts_profiles').select('*').eq('id', session.user.id).single();
    if (gen !== state.generation) return;
    if (error?.code === 'PGRST116') return logout('Tài khoản chưa được cấp quyền Telesales. Vui lòng liên hệ quản trị viên.');
    if (error) throw error;
    if (!profile.active) return logout('Tài khoản chưa được kích hoạt hoặc đã bị tạm khóa.');

    state.profile = profile;
    $('#loginError')?.classList.add('hidden');
    $('#loginForm')?.reset();
    if ($('#accountName')) $('#accountName').textContent = profile.full_name || session.user.email;
    if ($('#accountRole')) $('#accountRole').textContent = admin() ? 'QUẢN TRỊ' : 'NHÂN VIÊN';
    $$('.admin-only').forEach(e => e.classList.toggle('hidden', !admin()));

    $('#loginScreen')?.classList.add('hidden');
    $('#mainApp')?.classList.remove('hidden');

    await refresh();
  } catch (err) {
    if (gen === state.generation) {
      if ($('#loginErrorText')) $('#loginErrorText').textContent = errorText(err);
      $('#loginError')?.classList.remove('hidden');
    }
  }
}

async function refresh() {
  if (!state.profile || state.refreshing) return;
  state.refreshing = true;
  const gen = state.generation;

  try {
    const [customers, profiles] = await Promise.all([
      allRows('ts_customers'),
      admin() ? allRows('ts_profiles', 'id,full_name,role,active') : Promise.resolve([])
    ]);

    if (gen !== state.generation) return;

    state.customers = customers;
    state.profiles = profiles;

    updateAdminStaffDropdowns();
    updateStatusCounts();
    buildAreaTree();
    renderContactCards();
    if (admin()) renderStaffList();
  } catch (err) {
    toast(errorText(err), 'error');
  } finally {
    state.refreshing = false;
  }
}

// ========================================================
// AREA HIERARCHY TREE
// ========================================================
function buildAreaTree() {
  const container = $('#areaTreeContainer');
  if (!container) return;
  container.innerHTML = '';

  const tree = {};
  state.customers.forEach(c => {
    const prov = c.province || 'Khác';
    const ar = c.area || 'Khác';
    if (!tree[prov]) tree[prov] = { total: 0, areas: {} };
    tree[prov].total++;
    tree[prov].areas[ar] = (tree[prov].areas[ar] || 0) + 1;
  });

  const sortedProvinces = Object.entries(tree).sort((a, b) => b[1].total - a[1].total);

  for (const [prov, pData] of sortedProvinces) {
    const provEl = document.createElement('div');
    provEl.className = 'rounded-xl border border-slate-100 overflow-hidden bg-slate-50/50 mb-1';

    const isProvActive = (state.activeProvince === prov && state.activeArea === 'ALL');

    provEl.innerHTML = `
      <button 
        data-prov="${escape(prov)}" 
        class="w-full px-3 py-2 text-left font-bold flex items-center justify-between transition ${isProvActive ? 'bg-blue-600 text-white' : 'text-slate-800 hover:bg-slate-100'}"
      >
        <div class="flex items-center gap-1.5 truncate text-xs">
          <i class="fa-solid fa-chevron-right text-[10px] ${isProvActive ? 'text-white' : 'text-slate-400'}"></i>
          <span class="truncate">${escape(prov)}</span>
        </div>
        <span class="text-[10.5px] px-2 py-0.5 rounded-full font-semibold ${isProvActive ? 'bg-blue-700 text-white' : 'bg-slate-200/80 text-slate-700'}">
          ${pData.total}
        </span>
      </button>
      
      <div class="p-1 space-y-0.5 border-t border-slate-100 bg-white">
        ${Object.entries(pData.areas).sort((a,b) => b[1] - a[1]).map(([ar, count]) => {
          const isArActive = (state.activeProvince === prov && state.activeArea === ar);
          return `
            <button 
              data-prov="${escape(prov)}" data-area="${escape(ar)}" 
              class="w-full px-2.5 py-1.5 rounded-lg text-left text-[11.5px] flex items-center justify-between transition ${isArActive ? 'bg-blue-50 text-blue-700 font-bold border border-blue-200' : 'text-slate-600 hover:bg-slate-50'}"
            >
              <span class="truncate pr-1">${escape(ar)}</span>
              <span class="text-[10px] text-slate-400 font-medium">${count}</span>
            </button>
          `;
        }).join('')}
      </div>
    `;

    container.appendChild(provEl);
  }
}

function resetAreaFilter() {
  state.activeProvince = 'ALL';
  state.activeArea = 'ALL';
  state.page = 0;
  if ($('#activeAreaLabel')) $('#activeAreaLabel').textContent = 'Tất cả khu vực';
  buildAreaTree();
  renderContactCards();
}

// ========================================================
// STATUS COUNTS & PROGRESS
// ========================================================
function updateStatusCounts() {
  const counts = {
    ALL: state.customers.length,
    'Chưa gọi': 0,
    'Hẹn gọi lại': 0,
    'Tiềm năng': 0,
    'Đã gặp': 0,
    'Sai số': 0
  };

  let totalCalled = 0;

  state.customers.forEach(c => {
    const st = c.status || 'Chưa gọi';
    if (st === 'Chưa gọi') {
      counts['Chưa gọi']++;
    } else {
      totalCalled++;
      if (st.includes('Hẹn gọi lại')) counts['Hẹn gọi lại']++;
      else if (st.includes('Tiềm năng') || st.includes('Zalo')) counts['Tiềm năng']++;
      else if (st.includes('Đã gặp') || st.includes('chốt')) counts['Đã gặp']++;
      else if (st.includes('Sai số') || st.includes('Nghỉ việc')) counts['Sai số']++;
    }
  });

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  setText('count-all', counts.ALL);
  setText('count-chua-goi', counts['Chưa gọi']);
  setText('count-hen-goi-lai', counts['Hẹn gọi lại']);
  setText('count-tiem-nang', counts['Tiềm năng']);
  setText('count-da-gap', counts['Đã gặp']);
  setText('count-sai-so', counts['Sai số']);

  setText('totalContactsBadge', state.customers.length);
  const pct = state.customers.length ? Math.round((totalCalled / state.customers.length) * 100) : 0;
  setText('calledProgressBadge', `Đã gọi: ${totalCalled}/${state.customers.length} (${pct}%)`);
}

function updateAdminStaffDropdowns() {
  if (!admin()) return;
  const staffOptions = state.profiles.filter(p => p.role === 'staff');
  
  const filterHtml = '<option value="">Tất cả nhân viên</option><option value="unassigned">-- Chưa phân công --</option>' +
    staffOptions.map(s => `<option value="${escape(s.id)}">${escape(s.full_name || 'Nhân viên')} ${s.active ? '' : '(Khóa)'}</option>`).join('');
  $('#filterAssignee').innerHTML = filterHtml;
  $('#filterAssignee').value = state.activeAssigneeFilter;

  const bulkHtml = '<option value="">-- Giao cho nhân viên --</option><option value="unassign">-- Thu hồi phân công --</option>' +
    staffOptions.filter(s => s.active).map(s => `<option value="${escape(s.id)}">${escape(s.full_name || 'Nhân viên')}</option>`).join('');
  $('#bulkAssigneeSelect').innerHTML = bulkHtml;
}

// ========================================================
// FILTER & RENDER CONTACT CARDS
// ========================================================
function filteredCustomers() {
  return state.customers.filter(c => {
    // 1. Area filter
    if (state.activeProvince !== 'ALL' && (c.province || 'Khác') !== state.activeProvince) return false;
    if (state.activeArea !== 'ALL' && (c.area || 'Khác') !== state.activeArea) return false;

    // 2. Status category filter
    if (state.activeFilter === 'Chưa gọi' && c.status !== 'Chưa gọi') return false;
    if (state.activeFilter === 'Hẹn gọi lại' && !c.status.includes('Hẹn gọi lại')) return false;
    if (state.activeFilter === 'Tiềm năng' && !(c.status.includes('Tiềm năng') || c.status.includes('Zalo'))) return false;
    if (state.activeFilter === 'Đã gặp' && !(c.status.includes('Đã gặp') || c.status.includes('chốt'))) return false;
    if (state.activeFilter === 'Sai số' && !(c.status.includes('Sai số') || c.status.includes('Nghỉ việc'))) return false;

    // 3. Assignee filter (Admin)
    if (admin() && state.activeAssigneeFilter) {
      if (state.activeAssigneeFilter === 'unassigned') {
        if (c.assigned_to) return false;
      } else if (c.assigned_to !== state.activeAssigneeFilter) {
        return false;
      }
    }

    // 4. Search query
    if (state.activeSearchQuery) {
      const q = fold(state.activeSearchQuery);
      const corpus = fold(`${c.customer} ${c.contact} ${c.position} ${c.phone} ${c.email} ${c.address} ${c.area} ${c.province} ${c.legacy_sales_person} ${c.original_note} ${c.call_note} ${c.legacy_id}`);
      if (!corpus.includes(q)) return false;
    }

    return true;
  });
}

function renderContactCards() {
  const container = $('#contactsContainer');
  const emptyEl = $('#emptyState');
  const countLabel = $('#renderedCountLabel');
  const paginationBar = $('#paginationBar');

  const filtered = filteredCustomers();

  // Sorting
  filtered.sort((a, b) => {
    if (state.activeSort === 'id_asc') return (parseInt(a.legacy_id) || 0) - (parseInt(b.legacy_id) || 0);
    if (state.activeSort === 'company_asc') return (a.customer || '').localeCompare(b.customer || '', 'vi');
    if (state.activeSort === 'contact_asc') return (a.contact || '').localeCompare(b.contact || '', 'vi');
    if (state.activeSort === 'status_asc') return (a.status || '').localeCompare(b.status || '', 'vi');
    if (state.activeSort === 'updated_desc') return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
    return 0;
  });

  if (countLabel) countLabel.textContent = `Hiển thị ${filtered.length} liên hệ`;

  if (filtered.length === 0) {
    if (container) container.innerHTML = '';
    emptyEl?.classList.remove('hidden');
    paginationBar?.classList.add('hidden');
    return;
  }

  emptyEl?.classList.add('hidden');
  paginationBar?.classList.remove('hidden');

  // Pagination slice
  const totalPages = Math.ceil(filtered.length / state.pageSize) || 1;
  if (state.page >= totalPages) state.page = totalPages - 1;
  if (state.page < 0) state.page = 0;

  if ($('#pageLabel')) $('#pageLabel').textContent = `Trang ${state.page + 1} / ${totalPages}`;
  if ($('#prevPageBtn')) $('#prevPageBtn').disabled = state.page === 0;
  if ($('#nextPageBtn')) $('#nextPageBtn').disabled = state.page >= totalPages - 1;

  const currentSlice = filtered.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);

  // Profile lookup
  const profileMap = new Map(state.profiles.map(p => [p.id, p.full_name]));

  // Build Cards HTML
  container.innerHTML = currentSlice.map(c => {
    const statusCfg = STATUS_CONFIG[c.status] || STATUS_CONFIG["Chưa gọi"];
    const hasAudio = !!c.call_note?.includes('audio:') || false;
    const cleanPhone = (c.phone || '').replace(/[^0-9+]/g, '');
    const isChecked = state.selected.has(c.id);

    const assigneeName = c.assigned_to ? (profileMap.get(c.assigned_to) || 'Nhân viên') : (c.legacy_sales_person ? `Cũ: ${c.legacy_sales_person}` : 'Chưa giao');

    return `
      <div class="bg-white rounded-2xl p-4 shadow-sm border border-slate-200 hover:border-blue-400 hover:shadow-md transition flex flex-col justify-between gap-3 relative">
        
        <!-- Card Header: Company & Badges -->
        <div>
          <div class="flex items-start justify-between gap-2">
            <div class="flex-1">
              <div class="flex items-center gap-1.5 flex-wrap">
                ${admin() ? `
                  <input type="checkbox" data-select-card="${escape(c.id)}" ${isChecked ? 'checked' : ''} class="rounded border-slate-300 text-blue-600 focus:ring-0 mr-0.5">
                ` : ''}
                <span class="text-[10px] font-bold px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200">
                  #${escape(c.legacy_id || c.id.slice(0,6))}
                </span>
                ${admin() ? `
                  <select data-assign-single="${escape(c.id)}" class="text-[10px] font-semibold bg-slate-100 hover:bg-white border border-slate-300 rounded-md px-1.5 py-0.5 text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500">
                    <option value="">-- Chưa giao --</option>
                    ${state.profiles.filter(p => p.role === 'staff' && p.active).map(s => `
                      <option value="${escape(s.id)}" ${c.assigned_to === s.id ? 'selected' : ''}>${escape(s.full_name || 'Nhân viên')}</option>
                    `).join('')}
                  </select>
                ` : `
                  <span class="text-[10px] font-medium px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200">
                    <i class="fa-solid fa-user-tag text-[9px] text-slate-400"></i> ${escape(assigneeName)}
                  </span>
                `}
                ${c.origin ? `<span class="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200">${escape(c.origin)}</span>` : ''}
              </div>
              <h3 class="font-bold text-slate-900 text-sm mt-1.5 leading-snug tracking-tight">
                ${escape(c.customer)}
              </h3>
            </div>
          </div>

          <!-- Contact Person Box (PROMINENT) -->
          <div class="mt-2.5 p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <div class="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center text-xs flex-shrink-0 font-bold shadow-sm">
                <i class="fa-solid fa-user-tie"></i>
              </div>
              <div class="truncate">
                <div class="text-xs font-bold text-slate-900 truncate flex items-center gap-1.5">
                  <span>${escape(c.contact || 'Người liên hệ')}</span>
                  ${c.position ? `<span class="text-[10px] font-semibold text-blue-600 bg-blue-50 px-1.5 py-0.2 rounded border border-blue-200/60">${escape(c.position)}</span>` : ''}
                </div>
                <div class="text-[11px] font-bold text-slate-700 font-mono flex items-center gap-1 mt-0.5">
                  <i class="fa-solid fa-phone text-[9px] text-slate-400"></i>
                  <span>${escape(c.phone || 'Chưa có SĐT')}</span>
                </div>
              </div>
            </div>

            ${c.phone ? `
              <button 
                data-copy-phone="${escape(c.phone)}" 
                title="Sao chép SĐT"
                class="p-1.5 rounded-lg bg-white hover:bg-slate-100 text-slate-500 border border-slate-200 text-xs transition"
              >
                <i class="fa-solid fa-copy"></i>
              </button>
            ` : ''}
          </div>

          <!-- Address & KCN -->
          <div class="mt-2 text-slate-500 text-[11px] flex items-start gap-1.5 leading-relaxed">
            <i class="fa-solid fa-location-dot text-rose-500 mt-0.5 text-[10px] flex-shrink-0"></i>
            <span class="text-slate-600 font-medium">${escape(c.address || c.area || c.province || 'Chưa có địa chỉ')}</span>
          </div>

          ${c.original_note ? `
            <div class="mt-1.5 text-[10.5px] text-slate-500 bg-amber-50/60 border border-amber-200/60 rounded-lg p-2 leading-relaxed">
              <b class="text-amber-800 font-semibold">Ghi chú gốc:</b> ${escape(c.original_note)}
            </div>
          ` : ''}
        </div>

        <!-- Card Bottom: Action Buttons & Status Tracking -->
        <div class="pt-2.5 border-t border-slate-100 space-y-2.5">
          
          <!-- 1-Touch Action Buttons: Dial & Zalo -->
          <div class="grid grid-cols-2 gap-2">
            <a 
              href="tel:${escape(cleanPhone)}" 
              data-quick-call="${escape(c.id)}" 
              class="py-2.5 px-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs shadow-md shadow-emerald-500/20 flex items-center justify-center gap-2 transition active:scale-[0.98]"
            >
              <i class="fa-solid fa-phone-volume text-xs animate-pulse"></i>
              <span>Gọi Ngay</span>
            </a>

            <a 
              href="https://zalo.me/${escape(cleanPhone)}" 
              target="_blank"
              data-quick-zalo="${escape(c.id)}" 
              class="py-2.5 px-3 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white font-bold text-xs shadow-md shadow-blue-500/20 flex items-center justify-center gap-2 transition active:scale-[0.98]"
            >
              <i class="fa-solid fa-comment-dots text-xs"></i>
              <span>Nhắn Zalo</span>
            </a>
          </div>

          <!-- Status Dropdown Selector -->
          <div>
            <label class="block text-[10.5px] font-bold text-slate-500 mb-1">Trạng thái cuộc gọi:</label>
            <select 
              data-status-select="${escape(c.id)}" 
              class="w-full text-xs font-semibold rounded-xl p-2 border ${statusCfg.color} focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
            >
              ${STATUSES.map(stKey => `
                <option value="${escape(stKey)}" ${c.status === stKey ? 'selected' : ''}>${escape(stKey)}</option>
              `).join('')}
            </select>
          </div>

          <!-- Call Log & Note Textarea -->
          <div>
            <textarea 
              placeholder="Ghi chú kết quả cuộc gọi, lịch hẹn, nhu cầu khách..." 
              data-note-blur="${escape(c.id)}"
              class="w-full text-xs p-2 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition resize-none custom-scrollbar"
              rows="2"
            >${escape(c.call_note || '')}</textarea>
            
            <div class="flex items-center justify-between text-[10px] text-slate-400 mt-1">
              <span>${c.updated_at ? `Cập nhật: ${formatTime(c.updated_at)}` : 'Chưa có cập nhật'}</span>
              
              <div class="flex items-center gap-1.5">
                <button data-history-customer="${escape(c.id)}" class="text-blue-600 hover:underline font-semibold flex items-center gap-1">
                  <i class="fa-solid fa-clock-rotate-left text-[9px]"></i> Lịch sử
                </button>
                <button data-upload-audio="${escape(c.id)}" class="text-slate-500 hover:text-slate-800 flex items-center gap-1 bg-slate-100 px-2 py-0.5 rounded-md border border-slate-200">
                  <i class="fa-solid fa-microphone text-[9px] text-rose-500"></i>
                  <span>Ghi âm</span>
                </button>
              </div>
            </div>
          </div>

        </div>

      </div>
    `;
  }).join('');
}

// ========================================================
// PERSIST UPDATE TO SUPABASE
// ========================================================
async function persistContactUpdate(cId, status, callNote) {
  const c = state.customers.find(item => item.id === cId);
  if (!c) return;

  const noteChanged = (callNote !== undefined && callNote !== c.call_note);
  const statusChanged = (status !== undefined && status !== c.status);
  if (!noteChanged && !statusChanged) return;

  const newStatus = status !== undefined ? status : c.status;
  const newNote = callNote !== undefined ? callNote : (c.call_note || '');

  // Optimistic update in memory
  c.status = newStatus;
  c.call_note = newNote;
  c.updated_at = new Date().toISOString();

  updateStatusCounts();
  renderContactCards();

  try {
    // 1. Log activity in ts_activities
    const eventType = statusChanged ? 'call' : 'note';
    await client.rpc('ts_log_activity', {
      p_id: crypto.randomUUID(),
      p_customer_id: cId,
      p_event_type: eventType,
      p_result: newStatus,
      p_note: newNote || (statusChanged ? `Chuyển trạng thái sang: ${newStatus}` : '(Không có ghi chú)')
    });

    toast('Đã lưu kết quả lên hệ thống', 'success');
  } catch (err) {
    toast(errorText(err), 'error');
    await refresh();
  }
}

// ========================================================
// ACTIONS: CALL, ZALO, EXCEL, AUDIO
// ========================================================
function handleQuickCallClick(cId) {
  const c = state.customers.find(item => item.id === cId);
  if (c && c.status === "Chưa gọi") {
    persistContactUpdate(cId, "3. Hẹn gọi lại", c.call_note);
  } else if (c) {
    persistContactUpdate(cId, c.status, c.call_note);
  }
}

function handleZaloClick(cId) {
  const c = state.customers.find(item => item.id === cId);
  if (c && c.status === "Chưa gọi") {
    persistContactUpdate(cId, "5. Đã kết nối Zalo / Gửi tài liệu", c.call_note);
  }
}

function exportToExcel() {
  const headers = ["ID", "Tên Công Ty", "Người Liên Hệ", "Chức Vụ", "SĐT", "Email", "Địa Chỉ", "Khu Vực / KCN", "Tỉnh / Thành", "Origin", "Sales Phụ Trách", "Trạng Thái Cuộc Gọi", "Ghi Chú Cuộc Gọi", "Thời Gian Cập Nhật", "Ghi Chú Gốc"];
  
  const profileMap = new Map(state.profiles.map(p => [p.id, p.full_name]));

  const rows = state.customers.map(c => [
    csvCell(c.legacy_id || c.id),
    csvCell(c.customer),
    csvCell(c.contact),
    csvCell(c.position),
    csvCell(c.phone),
    csvCell(c.email),
    csvCell(c.address),
    csvCell(c.area),
    csvCell(c.province),
    csvCell(c.origin),
    csvCell(c.assigned_to ? (profileMap.get(c.assigned_to) || '') : c.legacy_sales_person),
    csvCell(c.status),
    csvCell(c.call_note),
    csvCell(formatTime(c.updated_at)),
    csvCell(c.original_note)
  ]);

  const csvContent = "\uFEFF" + [headers.join(","), ...rows.map(r => r.join(","))].join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `TELESALES_KCN_BAO_CAO_${new Date().toISOString().slice(0,10)}.csv`;
  link.click();
  toast("Đã xuất báo cáo CSV/Excel thành công!", "success");
}

// ========================================================
// STATS MODAL
// ========================================================
function openStatsModal() {
  const container = $('#statsContent');
  if (!container) return;

  const statusCounts = {};
  let calledTotal = 0;

  state.customers.forEach(c => {
    const st = c.status || 'Chưa gọi';
    statusCounts[st] = (statusCounts[st] || 0) + 1;
    if (st !== 'Chưa gọi') calledTotal++;
  });

  const total = state.customers.length;
  const pct = total ? Math.round((calledTotal / total) * 100) : 0;

  container.innerHTML = `
    <!-- Overall Progress -->
    <div class="p-4 rounded-2xl bg-blue-50/80 border border-blue-200">
      <div class="flex items-center justify-between mb-2">
        <span class="font-bold text-slate-700">Tiến độ cuộc gọi toàn bộ:</span>
        <span class="font-bold text-blue-700">${calledTotal} / ${total} (${pct}%)</span>
      </div>
      <div class="w-full bg-blue-200/60 rounded-full h-3 overflow-hidden">
        <div class="bg-blue-600 h-3 rounded-full transition-all" style="width: ${pct}%"></div>
      </div>
    </div>

    <!-- Status Breakdown -->
    <div class="space-y-2">
      <h4 class="font-bold text-slate-700 text-xs uppercase tracking-wider">Chi tiết theo trạng thái</h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        ${STATUSES.map(st => {
          const cfg = STATUS_CONFIG[st] || STATUS_CONFIG["Chưa gọi"];
          const count = statusCounts[st] || 0;
          const p = total ? Math.round((count / total) * 100) : 0;
          return `
            <div class="p-2.5 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between">
              <span class="font-semibold text-slate-700 truncate pr-1">${escape(st)}</span>
              <span class="font-bold px-2 py-0.5 rounded-md text-[11px] ${cfg.color}">
                ${count} (${p}%)
              </span>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  $('#statsModal').showModal();
}

// ========================================================
// HISTORY TIMELINE MODAL
// ========================================================
async function openHistoryModal(cId) {
  const c = state.customers.find(item => item.id === cId);
  if (!c) return;

  if ($('#historyCustomerName')) $('#historyCustomerName').textContent = c.customer;
  const container = $('#historyTimeline');
  container.innerHTML = '<p class="text-slate-400 py-4 text-center">Đang tải lịch sử chăm sóc...</p>';
  $('#historyModal').showModal();

  try {
    const {data, error} = await client.from('ts_activities').select('*').eq('customer_id', cId).order('created_at', {ascending: false});
    if (error) throw error;

    if (!data || data.length === 0) {
      container.innerHTML = '<p class="text-slate-400 py-4 text-center">Chưa có lịch sử chăm sóc nào cho khách hàng này.</p>';
      return;
    }

    container.innerHTML = data.map(act => {
      const typeLabel = act.event_type === 'call' ? 'Cuộc gọi' :
        act.event_type === 'note' ? 'Ghi chú' :
        act.event_type === 'assignment' ? 'Phân công' : 'Dữ liệu cũ';

      return `
        <div class="p-3 rounded-xl border border-slate-200 bg-slate-50 space-y-1">
          <div class="flex items-center justify-between text-[11px]">
            <span class="font-bold text-blue-700 flex items-center gap-1.5">
              <i class="fa-solid ${act.event_type === 'call' ? 'fa-phone' : 'fa-comment'} text-[10px]"></i>
              ${escape(typeLabel)} • ${escape(act.actor_name || 'Nhân viên')}
            </span>
            <span class="text-slate-400">${formatTime(act.created_at)}</span>
          </div>
          ${act.result ? `<div class="font-semibold text-slate-800 text-[11.5px]">Kết quả: <span class="text-blue-600">${escape(act.result)}</span></div>` : ''}
          <p class="text-slate-600 text-xs whitespace-pre-wrap">${escape(act.note || '')}</p>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `<p class="text-rose-500 py-4 text-center">${escape(errorText(err))}</p>`;
  }
}

// ========================================================
// STAFF MANAGEMENT MODAL (ADMIN)
// ========================================================
function renderStaffList() {
  const container = $('#staffListContainer');
  if (!container) return;

  const staff = state.profiles.filter(p => p.role === 'staff');
  if (staff.length === 0) {
    container.innerHTML = '<p class="text-slate-400 text-xs py-2">Chưa có nhân viên nào.</p>';
    return;
  }

  container.innerHTML = staff.map(s => `
    <div class="p-3 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between">
      <div>
        <div class="font-bold text-slate-800">${escape(s.full_name || 'Nhân viên')}</div>
        <div class="text-[11px] text-slate-500">${s.active ? '<span class="text-emerald-600 font-semibold">Đang hoạt động</span>' : '<span class="text-rose-500 font-semibold">Tạm khóa</span>'}</div>
      </div>
      <button 
        data-toggle-staff="${escape(s.id)}" 
        class="px-3 py-1 rounded-lg text-xs font-semibold border ${s.active ? 'bg-rose-50 text-rose-600 border-rose-200 hover:bg-rose-100' : 'bg-emerald-50 text-emerald-600 border-emerald-200 hover:bg-emerald-100'} transition"
      >
        ${s.active ? 'Tạm khóa' : 'Kích hoạt'}
      </button>
    </div>
  `).join('');
}

// ========================================================
// ATTACH EVENT LISTENERS
// ========================================================
function setupListeners() {
  // Password toggle
  $('#togglePasswordBtn')?.addEventListener('click', () => {
    const input = $('#loginPassword');
    const icon = $('#eyeIcon');
    if (input.type === 'password') {
      input.type = 'text';
      icon.className = 'fa-solid fa-eye text-xs';
    } else {
      input.type = 'password';
      icon.className = 'fa-solid fa-eye-slash text-xs';
    }
  });

  // Login Form
  $('#loginForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    $('#loginError').classList.add('hidden');
    const submitBtn = $('#loginSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-xs"></i> <span>Đang đăng nhập...</span>';

    try {
      const email = $('#loginEmail').value.trim();
      const password = $('#loginPassword').value;
      const {error} = await client.auth.signInWithPassword({email, password});
      if (error) throw error;
    } catch (err) {
      $('#loginErrorText').textContent = errorText(err);
      $('#loginError').classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket text-xs"></i> <span>Đăng Nhập Vào Hệ Thống</span>';
    }
  });

  // Logout
  $('#logoutBtn')?.addEventListener('click', () => logout());

  // Refresh
  $('#refreshBtn')?.addEventListener('click', () => refresh());

  // Search input
  $('#searchInput')?.addEventListener('input', e => {
    state.activeSearchQuery = e.target.value;
    $('#clearSearchBtn').classList.toggle('hidden', !state.activeSearchQuery);
    state.page = 0;
    renderContactCards();
  });

  $('#clearSearchBtn')?.addEventListener('click', () => {
    $('#searchInput').value = '';
    state.activeSearchQuery = '';
    $('#clearSearchBtn').classList.add('hidden');
    state.page = 0;
    renderContactCards();
  });

  // Sort change
  $('#sortBySelect')?.addEventListener('change', e => {
    state.activeSort = e.target.value;
    renderContactCards();
  });

  // Staff filter (Admin)
  $('#filterAssignee')?.addEventListener('change', e => {
    state.activeAssigneeFilter = e.target.value;
    state.page = 0;
    renderContactCards();
  });

  // Status Filter Pills
  $$('[data-status-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeFilter = btn.dataset.statusFilter;
      $$('[data-status-filter]').forEach(b => {
        if (b.dataset.statusFilter === state.activeFilter) {
          b.className = "px-3 py-1 rounded-lg text-xs font-semibold whitespace-nowrap bg-blue-600 text-white shadow-sm transition";
        } else {
          b.className = "px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap bg-slate-800 hover:bg-slate-700 text-slate-300 transition";
        }
      });
      state.page = 0;
      renderContactCards();
    });
  });

  // Area tree click delegation
  $('#areaTreeContainer')?.addEventListener('click', e => {
    const provBtn = e.target.closest('[data-prov]');
    if (!provBtn) return;
    const prov = provBtn.dataset.prov;
    const area = provBtn.dataset.area || 'ALL';

    state.activeProvince = prov;
    state.activeArea = area;
    state.page = 0;

    if ($('#activeAreaLabel')) $('#activeAreaLabel').textContent = area === 'ALL' ? prov : `${prov} > ${area}`;
    buildAreaTree();
    renderContactCards();
  });

  $('#resetAreaFilterBtn')?.addEventListener('click', resetAreaFilter);
  $('#resetFiltersBtn')?.addEventListener('click', () => {
    resetAreaFilter();
    $('#searchInput').value = '';
    state.activeSearchQuery = '';
    $('#clearSearchBtn').classList.add('hidden');
    state.activeFilter = 'ALL';
    state.activeAssigneeFilter = '';
    if ($('#filterAssignee')) $('#filterAssignee').value = '';
    $$('[data-status-filter]').forEach(b => {
      b.className = b.dataset.statusFilter === 'ALL' ?
        "px-3 py-1 rounded-lg text-xs font-semibold whitespace-nowrap bg-blue-600 text-white shadow-sm transition" :
        "px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap bg-slate-800 hover:bg-slate-700 text-slate-300 transition";
    });
    renderContactCards();
  });

  // Card Grid Delegations
  $('#contactsContainer')?.addEventListener('click', e => {
    // Copy phone
    const copyBtn = e.target.closest('[data-copy-phone]');
    if (copyBtn) {
      copyToClipboard(copyBtn.dataset.copyPhone);
      return;
    }

    // Quick call
    const callBtn = e.target.closest('[data-quick-call]');
    if (callBtn) {
      handleQuickCallClick(callBtn.dataset.quickCall);
      return;
    }

    // Quick Zalo
    const zaloBtn = e.target.closest('[data-quick-zalo]');
    if (zaloBtn) {
      handleZaloClick(zaloBtn.dataset.quickZalo);
      return;
    }

    // History modal
    const histBtn = e.target.closest('[data-history-customer]');
    if (histBtn) {
      openHistoryModal(histBtn.dataset.historyCustomer);
      return;
    }

    // Audio upload
    const audioBtn = e.target.closest('[data-upload-audio]');
    if (audioBtn) {
      state.currentRecordingContactId = audioBtn.dataset.uploadAudio;
      $('#nativeAudioFileInput').click();
      return;
    }
  });

  // Card select checkbox
  $('#contactsContainer')?.addEventListener('change', async e => {
    const chk = e.target.closest('[data-select-card]');
    if (chk) {
      const id = chk.dataset.selectCard;
      chk.checked ? state.selected.add(id) : state.selected.delete(id);
      if ($('#selectedCountBadge')) $('#selectedCountBadge').textContent = `${state.selected.size} khách đã chọn`;
    }

    // Status select change
    const stSelect = e.target.closest('[data-status-select]');
    if (stSelect) {
      persistContactUpdate(stSelect.dataset.statusSelect, stSelect.value);
    }

    // Single assign dropdown change (Admin)
    const assignSelect = e.target.closest('[data-assign-single]');
    if (assignSelect) {
      const cId = assignSelect.dataset.assignSingle;
      const staffId = assignSelect.value || null;
      try {
        const {error} = await client.from('ts_customers').update({assigned_to: staffId}).eq('id', cId);
        if (error) throw error;
        toast('Đã cập nhật người phụ trách!', 'success');
        await refresh();
      } catch (err) {
        toast(errorText(err), 'error');
      }
    }
  });

  // Card note blur
  $('#contactsContainer')?.addEventListener('focusout', e => {
    const txt = e.target.closest('[data-note-blur]');
    if (txt) {
      persistContactUpdate(txt.dataset.noteBlur, undefined, txt.value.trim());
    }
  });

  // Select all checkbox
  $('#selectAllCheckbox')?.addEventListener('change', e => {
    const currentSlice = filteredCustomers().slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);
    currentSlice.forEach(c => {
      e.target.checked ? state.selected.add(c.id) : state.selected.delete(c.id);
    });
    if ($('#selectedCountBadge')) $('#selectedCountBadge').textContent = `${state.selected.size} khách đã chọn`;
    renderContactCards();
  });

  // Bulk assign button
  $('#bulkAssignBtn')?.addEventListener('click', async () => {
    if (state.selected.size === 0) {
      toast('Vui lòng chọn ít nhất một khách hàng.', 'error');
      return;
    }
    const staffId = $('#bulkAssigneeSelect').value;
    if (!staffId) {
      toast('Vui lòng chọn nhân viên để giao khách.', 'error');
      return;
    }

    const assignedTo = staffId === 'unassign' ? null : staffId;
    const ids = [...state.selected];

    try {
      const {error} = await client.from('ts_customers').update({assigned_to: assignedTo}).in('id', ids);
      if (error) throw error;
      state.selected.clear();
      if ($('#selectedCountBadge')) $('#selectedCountBadge').textContent = '0 khách đã chọn';
      if ($('#selectAllCheckbox')) $('#selectAllCheckbox').checked = false;
      toast(`Đã cập nhật phụ trách cho ${ids.length} khách hàng!`, 'success');
      await refresh();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  // Pagination buttons
  $('#prevPageBtn')?.addEventListener('click', () => {
    state.page--;
    renderContactCards();
    window.scrollTo({top: 0, behavior: 'smooth'});
  });

  $('#nextPageBtn')?.addEventListener('click', () => {
    state.page++;
    renderContactCards();
    window.scrollTo({top: 0, behavior: 'smooth'});
  });

  // Header modal open buttons
  $('#exportExcelBtn')?.addEventListener('click', exportToExcel);
  $('#openStatsModalBtn')?.addEventListener('click', openStatsModal);
  $('#openMigrationModalBtn')?.addEventListener('click', () => $('#migrationModal').showModal());
  $('#openStaffModalBtn')?.addEventListener('click', () => { renderStaffList(); $('#staffModal').showModal(); });
  $('#openNewCustomerModalBtn')?.addEventListener('click', () => $('#newCustomerModal').showModal());
  $('#openReportsModalBtn')?.addEventListener('click', () => {
    const today = dateVN(new Date());
    $('#reportStartDate').value = today.slice(0, 7) + '-01';
    $('#reportEndDate').value = today;
    loadEmployeeReports();
    $('#reportsModal').showModal();
  });

  // Modal close buttons
  $$('[data-close-modal]').forEach(b => {
    b.addEventListener('click', () => $('#' + b.dataset.closeModal)?.close());
  });

  // Native audio file upload
  $('#nativeAudioFileInput')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    const cId = state.currentRecordingContactId;
    if (!file || !cId) return;

    try {
      toast('Đang tải file ghi âm lên Supabase...', 'info');
      const storagePath = `${cId}/${state.profile.id}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const {error: upErr} = await client.storage.from('telesales-audio').upload(storagePath, file);
      if (upErr) throw upErr;

      await client.rpc('ts_log_activity', {
        p_id: crypto.randomUUID(),
        p_customer_id: cId,
        p_event_type: 'note',
        p_note: `Đã đính kèm file ghi âm: ${file.name}`,
        p_attachment_path: storagePath
      });

      toast('Đã lưu file ghi âm thành công!', 'success');
      await refresh();
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      e.target.value = '';
    }
  });

  // New Customer Form
  $('#newCustomerForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const data = new FormData(e.target);
    const row = Object.fromEntries([...data].map(([k, v]) => [k, String(v).trim()]));

    try {
      const {error} = await client.from('ts_customers').insert(row);
      if (error) throw error;
      $('#newCustomerModal').close();
      $('#newCustomerForm').reset();
      toast('Đã thêm khách hàng mới thành công!', 'success');
      await refresh();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  // Create Staff Form
  $('#createStaffForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const data = new FormData(e.target);
    const email = String(data.get('email')).trim();
    const password = String(data.get('password'));
    const full_name = String(data.get('full_name')).trim();

    try {
      const {data: resp, error} = await client.functions.invoke(config.functionsName || 'telesales-users', {
        body: {email, password, full_name}
      });
      if (error) throw error;
      if (!resp?.user_id) throw new Error(resp?.error || 'Chưa xác nhận tạo tài khoản.');
      $('#createStaffForm').reset();
      toast('Đã tạo tài khoản nhân viên!', 'success');
      await refresh();
    } catch (err) {
      toast('Nếu chưa deploy Edge Function, hãy tạo user trong Authentication > Users trên Supabase Dashboard.', 'info');
    }
  });

  // Toggle staff active
  $('#staffListContainer')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-toggle-staff]');
    if (!btn || !admin()) return;
    const pId = btn.dataset.toggleStaff;
    const profile = state.profiles.find(p => p.id === pId);
    if (!profile) return;

    btn.disabled = true;
    try {
      const {error} = await client.from('ts_profiles').update({active: !profile.active}).eq('id', pId);
      if (error) throw error;
      toast(profile.active ? 'Đã tạm khóa tài khoản.' : 'Đã kích hoạt tài khoản!', 'success');
      await refresh();
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Import Contacts Form
  $('#importContactsForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const file = $('#contactsFileInput').files[0];
    const pwd = $('#legacyPasswordInput').value;
    if (!file) return;

    const notice = $('#migrationNotice');
    notice.classList.remove('hidden');
    notice.textContent = 'Đang giải mã và phân tích danh bạ...';

    try {
      const rows = await parseLegacyContacts(await file.text(), pwd);
      notice.textContent = `Đang nạp ${rows.length} khách hàng lên Supabase...`;

      const existingIds = new Set(state.customers.map(c => c.legacy_id));
      const fresh = rows.filter(r => !existingIds.has(r.legacy_id));

      let inserted = 0;
      for (let i = 0; i < fresh.length; i += 100) {
        const batch = fresh.slice(i, i + 100);
        const {error} = await client.from('ts_customers').insert(batch);
        if (error) throw error;
        inserted += batch.length;
        notice.textContent = `Đã nạp ${inserted} / ${fresh.length} khách...`;
      }

      notice.textContent = `Thành công! Đã nạp ${inserted} khách hàng mới; bỏ qua ${rows.length - fresh.length} khách đã có.`;
      toast('Đã nhập danh bạ thành công!', 'success');
      await refresh();
    } catch (err) {
      notice.textContent = `Lỗi: ${errorText(err)}`;
      toast(errorText(err), 'error');
    }
  });

  // Import Logs
  $('#importLocalLogsBtn')?.addEventListener('click', async () => {
    const content = localStorage.getItem('telesales_user_logs');
    if (!content) {
      toast('Không tìm thấy ghi chú cũ trên trình duyệt này.', 'info');
      return;
    }
    await importLogsJson(content);
  });

  $('#importLogsFileForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const file = $('#logsFileInput').files[0];
    if (!file) return;
    await importLogsJson(await file.text());
  });
}

async function importLogsJson(content) {
  const notice = $('#migrationNotice');
  notice.classList.remove('hidden');
  notice.textContent = 'Đang nhập lịch sử cuộc gọi...';

  try {
    const rows = normalizeLogs(JSON.parse(content));
    const map = new Map(state.customers.map(c => [c.legacy_id, c.id]));
    let saved = 0, skipped = 0;

    for (const row of rows) {
      if (!map.has(row.legacy_id)) continue;
      const key = await legacyLogKey(row);
      const {data: existing} = await client.from('ts_activities').select('id').eq('legacy_key', key).limit(1);
      if (existing?.length) { skipped++; continue; }

      await client.rpc('ts_log_activity', {
        p_id: crypto.randomUUID(),
        p_customer_id: map.get(row.legacy_id),
        p_event_type: 'legacy_import',
        p_result: row.result,
        p_note: row.note || '(Ghi chú cũ)',
        p_legacy_key: key,
        p_legacy_time: row.legacy_time || null
      });
      saved++;
      if (saved % 25 === 0) notice.textContent = `Đã nhập ${saved} ghi chú...`;
    }

    notice.textContent = `Hoàn tất! Đã nhập ${saved} ghi chú cũ; bỏ qua ${skipped} ghi chú trùng.`;
    toast(`Đã nhập ${saved} ghi chú cũ!`, 'success');
    await refresh();
  } catch (err) {
    notice.textContent = `Lỗi: ${errorText(err)}`;
    toast(errorText(err), 'error');
  }
}

async function loadEmployeeReports() {
  const container = $('#reportTableBody');
  container.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-slate-400">Đang tải báo cáo...</td></tr>';

  try {
    const bounds = reportBounds($('#reportStartDate').value, $('#reportEndDate').value);
    const {data, error} = await client.rpc('ts_employee_report', {p_start: bounds.start, p_end: bounds.end});
    if (error) throw error;

    if (!data || data.length === 0) {
      container.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-slate-400">Chưa có dữ liệu trong khoảng ngày này.</td></tr>';
      return;
    }

    container.innerHTML = data.map(r => `
      <tr class="hover:bg-slate-50">
        <td class="p-2.5 font-bold text-slate-800">${escape(r.full_name || 'Nhân viên')}${r.active ? '' : ' <span class="text-rose-500 font-normal text-[10px]">(Khóa)</span>'}</td>
        <td class="p-2.5 text-center font-semibold text-slate-700">${r.assigned_count}</td>
        <td class="p-2.5 text-center font-bold text-blue-600">${r.call_count}</td>
        <td class="p-2.5 text-center font-semibold text-slate-600">${r.note_count}</td>
        <td class="p-2.5 text-center font-bold text-emerald-600">${r.potential_count}</td>
        <td class="p-2.5 text-center font-bold text-rose-600">${r.overdue_count}</td>
      </tr>
    `).join('');
  } catch (err) {
    container.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-rose-500">${escape(errorText(err))}</td></tr>`;
  }
}

// Auto-refresh every 20s
setInterval(() => {
  if (!document.hidden && state.profile && !state.refreshing) {
    refresh();
  }
}, 20000);

// Initialize Client
if (!configured || !window.supabase?.createClient) {
  $('#setupNotice')?.classList.remove('hidden');
  if ($('#loginSubmitBtn')) $('#loginSubmitBtn').disabled = true;
} else {
  client = window.supabase.createClient(config.supabaseUrl, config.publishableKey, {
    auth: {
      storage: window.sessionStorage,
      storageKey: 'telesales-team-auth',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  });

  client.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => bootstrap(session), 0);
  });
}

setupListeners();

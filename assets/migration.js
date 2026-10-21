export const STATUSES = ['Chưa gọi','1. Không nghe máy','2. Thuê bao / Bận máy','3. Hẹn gọi lại','4. Nhầm người / Chuyển người khác','5. Đã kết nối Zalo / Gửi tài liệu','6. Khách quan tâm / Tiềm năng','7. Hẹn gặp nhà máy / Đã chốt dự án','8. Sai số / Nghỉ việc','9. Từ chối / Không có nhu cầu'];
const text = value => value == null ? '' : String(value).trim();
export function normalizeContacts(input) {
  if (!Array.isArray(input)) throw new Error('Danh bạ cần là một mảng JSON.');
  if (input.length > 50000) throw new Error('Mỗi lần nhập tối đa 50.000 khách.');
  const ids = new Set();
  return input.map((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`Dòng ${i + 1} không hợp lệ.`);
    const id = text(c.id ?? c.legacy_id);
    if (!id || ids.has(id)) throw new Error(`ID thiếu hoặc trùng ở dòng ${i + 1}.`);
    ids.add(id);
    const customer = text(c.customer);
    if (!customer || customer.length > 500) throw new Error(`Tên công ty không hợp lệ ở ID ${id}.`);
    const originalNote = [text(c.note ?? c.originalNote ?? c.original_note),
      c.callNote ? 'Ghi chú chăm sóc có sẵn: '+text(c.callNote) : '',
      c.status && c.status !== 'Chưa gọi' ? 'Trạng thái trong danh bạ cũ: '+text(c.status) : '',
      c.updatedAt ? 'Thời gian cập nhật gốc: '+text(c.updatedAt) : ''].filter(Boolean).join('\n');
    return {
      legacy_id: id, customer, contact: text(c.contact), position: text(c.role ?? c.position),
      phone: text(c.phone), email: text(c.email), address: text(c.address), province: text(c.province),
      area: text(c.area), origin: text(c.origin), original_note: originalNote,
      legacy_sales_person: text(c.salesPerson ?? c.legacy_sales_person)
    };
  });
}
export async function parseLegacyContacts(content, password = '') {
  if (content.trimStart().startsWith('[')) return normalizeContacts(JSON.parse(content));
  const match = content.match(/(?:const|let|var)\s+ENCRYPTED_PAYLOAD_B64\s*=\s*['"]([A-Za-z0-9+/=]+)['"]/);
  if (!match) throw new Error('Không tìm thấy danh bạ mã hóa trong file HTML. Hãy chọn HTML của app cũ hoặc mảng danh bạ JSON.');
  if (!password) throw new Error('Cần mật khẩu mở khóa danh bạ cũ.');
  try {
    const bytes = Uint8Array.from(atob(match[1]), c => c.charCodeAt(0));
    const keyMaterial = await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
    const key = await crypto.subtle.deriveKey({name:'PBKDF2',salt:bytes.slice(0,16),iterations:100000,hash:'SHA-256'},keyMaterial,{name:'AES-GCM',length:256},false,['decrypt']);
    const clear = await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(16,28)},key,bytes.slice(28));
    return normalizeContacts(JSON.parse(new TextDecoder().decode(clear)));
  } catch (err) {
    if (err.name === 'OperationError') throw new Error('Sai mật khẩu hoặc file danh bạ bị hỏng.');
    throw err;
  }
}
export function normalizeLogs(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('File cần là JSON sao lưu ghi chú của app cũ.');
  return Object.entries(input).map(([id,value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Ghi chú ID ${id} không hợp lệ.`);
    const status = text(value.status);
    const note = text(value.callNote);
    if (note.length > 10000) throw new Error(`Ghi chú ID ${id} quá dài (tối đa 10.000 ký tự).`);
    return {legacy_id:id,result:STATUSES.includes(status) ? status : null,note,
      legacy_time:text(value.updatedAt),has_audio:!!value.audioBlobId};
  });
}
export async function legacyLogKey(row) {
  const payload = JSON.stringify([row.legacy_id,row.result,row.note,row.legacy_time]);
  const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload));
  return 'legacy:' + Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export function reportBounds(start,end) {
  const valid = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
  if (!valid(start) || !valid(end) || start > end) throw new Error('Khoảng ngày không hợp lệ.');
  const from = new Date(`${start}T00:00:00+07:00`);
  const to = new Date(new Date(`${end}T00:00:00+07:00`).getTime()+86400000);
  return {start:from.toISOString(),end:to.toISOString()};
}
export function csvCell(value) {
  let s = String(value ?? '');
  // Chặn công thức từ dữ liệu khách hàng khi mở CSV trong Excel.
  if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
  return '"'+s.replaceAll('"','""')+'"';
}

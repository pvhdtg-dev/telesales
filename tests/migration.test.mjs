import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeContacts,parseLegacyContacts,normalizeLogs,legacyLogKey,reportBounds,csvCell} from '../assets/migration.js';
test('Nhập danh bạ không tự cấp quyền theo tên sales, giữ ID ổn định',()=>{
 const [row]=normalizeContacts([{id:123,customer:'Công ty A',role:'Mua hàng',salesPerson:'Anh A',phone:'0901234567'}]);
 assert.equal(row.legacy_id,'123');assert.equal(row.position,'Mua hàng');assert.equal(row.legacy_sales_person,'Anh A');assert.equal(row.assigned_to,undefined);
 assert.throws(()=>normalizeContacts([{id:1,customer:'A'},{id:1,customer:'B'}]),/trùng/);
 assert.throws(()=>normalizeContacts({}),/mảng/);
});
test('HTML cũ giải mã trên máy, không thực thi script trong HTML',async()=>{
 const password='test-not-a-real-password',salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
 const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
 const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt']);
 const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode('[{"id":1,"customer":"A"}]')));
 const payload=Buffer.concat([salt,iv,encrypted]).toString('base64');
 const html=`<script>globalThis.BAD=true; const ENCRYPTED_PAYLOAD_B64 = '${payload}';</script>`;
 assert.equal((await parseLegacyContacts(html,password))[0].customer,'A');assert.equal(globalThis.BAD,undefined);
 await assert.rejects(()=>parseLegacyContacts(html,'wrong'),/Sai mật khẩu/);
});
test('Nhập lại cùng ghi chú tạo cùng khóa; file backup không được coi là âm thanh',async()=>{
 const [row]=normalizeLogs({'123':{status:'3. Hẹn gọi lại',callNote:'Ghi chú',updatedAt:'20/10/2026',audioBlobId:'rec1'}});
 assert.equal(row.has_audio,true);assert.equal(await legacyLogKey(row),await legacyLogKey({...row}));
 assert.notEqual(await legacyLogKey(row),await legacyLogKey({...row,note:'Khác'}));
 assert.throws(()=>normalizeLogs([]),/JSON/);
});
test('Báo cáo chốt hết ngày Việt Nam, CSV không mở thành công thức Excel',()=>{
 assert.deepEqual(reportBounds('2026-10-01','2026-10-21'),{start:'2026-09-30T17:00:00.000Z',end:'2026-10-21T17:00:00.000Z'});
 assert.throws(()=>reportBounds('2026-11-01','2026-10-21'),/không hợp lệ/);
 assert.equal(csvCell('=HYPERLINK("x")'),'"\'=HYPERLINK(""x"")"');
});

import os
import json
import base64
import subprocess
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

workspace_dir = r"c:\Users\user\Desktop\Khách hàng"
scratch_dir = r"C:\Users\user\.gemini\antigravity\brain\8c70b57c-ab35-4dd1-8af0-cc2c7c1b82e2\scratch"

def encrypt_with_password(password_str):
    with open(f"{scratch_dir}/perfected_1to1_records.json", "r", encoding="utf-8") as f:
        records = json.load(f)

    contacts_json = json.dumps(records, ensure_ascii=False)

    salt = os.urandom(16)
    iv = os.urandom(12)
    
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=100000,
    )
    key = kdf.derive(password_str.encode('utf-8'))
    
    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(iv, contacts_json.encode('utf-8'), None)
    
    payload = salt + iv + ciphertext
    b64_payload = base64.b64encode(payload).decode('utf-8')

    # Update index.html
    index_path = os.path.join(workspace_dir, "index.html")
    with open(index_path, "r", encoding="utf-8") as f:
        html_text = f.read()

    # Replace ENCRYPTED_PAYLOAD_B64
    import re
    html_text = re.sub(
        r'const ENCRYPTED_PAYLOAD_B64 = ".*?";',
        f'const ENCRYPTED_PAYLOAD_B64 = "{b64_payload}";',
        html_text
    )

    with open(index_path, "w", encoding="utf-8") as f:
        f.write(html_text)

    # Also update GOI_DIEN_KHACH_HANG_THEO_KHU_VUC.html
    main_html_path = os.path.join(workspace_dir, "GOI_DIEN_KHACH_HANG_THEO_KHU_VUC.html")
    with open(main_html_path, "w", encoding="utf-8") as f:
        f.write(html_text)

    print("\n✅ Đã mã hóa lại toàn bộ dữ liệu 592 liên hệ bằng mật khẩu mới thành công!")

    # Git commit and push
    print("⏳ Đang đẩy mã nguồn mới lên GitHub...")
    subprocess.run(["git", "add", "index.html", "GOI_DIEN_KHACH_HANG_THEO_KHU_VUC.html", "DANH_SACH_KHACH_HANG_GOI_DIEN_THEO_KHU_VUC_V3.xlsx"], cwd=workspace_dir, check=True)
    subprocess.run(["git", "commit", "-m", "Update perfected 1-to-1 contacts with AES-256 encryption"], cwd=workspace_dir, check=True)
    subprocess.run(["git", "push", "origin", "main"], cwd=workspace_dir, check=True)
    print("🚀 ĐÃ ĐẨY LÊN GITHUB THÀNH CÔNG! Chỉ có mật khẩu mới này mới giải mã được.")

if __name__ == "__main__":
    print("=" * 60)
    print("CÔNG CỤ ĐỔI MẬT KHẨU BẢO MẬT AES-256 CHO APP TELESALES")
    print("=" * 60)
    p1 = input("Nhập mật khẩu bí mật mới của bạn: ").strip()
    if not p1:
        print("❌ Mật khẩu không được để trống!")
        exit(1)
    p2 = input("Nhập lại mật khẩu để xác nhận: ").strip()
    if p1 != p2:
        print("❌ Hai lần nhập mật khẩu không khớp nhau!")
        exit(1)
        
    encrypt_with_password(p1)

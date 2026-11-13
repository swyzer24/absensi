# Spesifikasi Keamanan Firestore — Presensia Cloud

## 1. Invarian Data & Kontrol Akses (Zero-Trust ABAC)

1. **Default-Deny Global**: Seluruh path yang tidak didefinisikan secara eksplisit ditolak (`allow read, write: if false`).
2. **Isolasi PII (Split Collection)**: Data sensitif karyawan (NIK, NPWP, Nomor Rekening Bank) dienkripsi di sisi klien dengan **AES-256-GCM** dan disimpan terpisah di `employees/{employeeId}/private/pii`. Hanya pemilik (`ownerUid == request.auth.uid`) atau `isAdmin()` yang terverifikasi emailnya (`email_verified == true`) yang dapat membaca atau memperbarui dokumen PII.
3. **Integritas Identitas & Anti-Spoofing**: Seluruh operasi tulis mewajibkan `request.auth != null && request.auth.token.email_verified == true`. Field `userId` / `ownerUid` wajib sama dengan `request.auth.uid` saat pembuatan dan bersifat imutabel setelah dibuat.
4. **Anti-Update-Gap & Validasi Ketat**: Setiap operasi `create` dan `update` wajib melewati fungsi validasi `isValid[Entity](incoming())` yang memeriksa kelengkapan key (`hasAll` & `hasOnly`), tipe data, batas panjang string (`.size()`), serta batas numerik.
5. **Integritas Temporal**: `createdAt` saat `create` dan `updatedAt` saat `create`/`update` wajib bernilai `request.time`.
6. **Validasi Relasional Lintas Koleksi**: Catatan absensi (`attendance`) hanya dapat dibuat jika `branchId` dan `employeeId` benar-benar ada di Firestore (`exists(...)`).
7. **Query Enforcer pada `allow list`**: Tidak ada `allow list: if isSignedIn();` tanpa filter. Setiap `list` non-admin mewajibkan `resource.data.userId == request.auth.uid` atau `resource.data.uid == request.auth.uid`.

## 2. Skenario Uji Penetrasi ("Dirty Dozen" Payloads)

1. **Unverified Email Spoof**: User login dengan email admin tetapi `email_verified: false` mencoba membaca `payrollRuns` -> **PERMISSION_DENIED**.
2. **Shadow Field Injection**: Payload `attendance` menyertakan field liar `isBypassed: true` saat `create` -> Ditolak oleh `hasOnly(...)` -> **PERMISSION_DENIED**.
3. **ID Poisoning (1KB ID)**: Mencoba menulis `/attendance/` dengan ID sepanjang 512 karakter atau karakter ilegal `@#$` -> Ditolak oleh `isValidId()` -> **PERMISSION_DENIED**.
4. **Identity Spoofing pada Absensi**: User A mengirim `userId: "user_B"` saat `clockIn` -> Ditolak oleh `incoming().userId == request.auth.uid` -> **PERMISSION_DENIED**.
5. **Orphaned Attendance Record**: Mengirim `branchId: "cabang_palsu"` yang tidak ada di `/branches` -> Ditolak oleh `exists(...)` -> **PERMISSION_DENIED**.
6. **Client Timestamp Forgery**: Mengirim `createdAt` mundur ke bulan lalu untuk memanipulasi absensi -> Ditolak oleh `incoming().createdAt == request.time` -> **PERMISSION_DENIED**.
7. **PII Cross-User Read**: Karyawan biasa mencoba `get` ke `/employees/emp_lain/private/pii` -> **PERMISSION_DENIED**.
8. **Blanket List Scraping**: Karyawan biasa menjalankan `getDocs(collection(db, 'attendance'))` tanpa `where('userId', '==', uid)` -> **PERMISSION_DENIED**.
9. **Unauthorized Salary Tampering**: Karyawan biasa mencoba `update` dokumen `/employees/{id}` untuk menaikkan `baseSalary` -> **PERMISSION_DENIED**.
10. **Clock-Out Field Hijacking**: Saat `clockOut`, user mencoba mengubah `faceVerified: true` atau `lateMinutes: 0` sekaligus -> Ditolak oleh `affectedKeys().hasOnly([...])` -> **PERMISSION_DENIED**.
11. **Terminal State Payroll Tampering**: Karyawan mencoba mengubah `status` pada `payrollRuns` dari `draft` ke `dibayarkan` -> **PERMISSION_DENIED**.
12. **Unencrypted / Oversized Snapshot DoS**: Mengirim string `faceThumbnail` > 65KB atau `notes` > 240 karakter -> Ditolak oleh `.size()` guard -> **PERMISSION_DENIED**.

import React, { useState } from 'react';
import { Building2, KeyRound, Lock, Plus, ShieldCheck, Unlock, Users } from 'lucide-react';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { Branch, Employee, EmployeeDecryptedPII, EmployeeEncryptedPII, PTKPStatus } from '../types';
import {
  decryptEmployeePII,
  encryptEmployeePII,
  getActiveVaultPassphrase,
  getKeyFingerprint,
  setActiveVaultPassphrase,
} from '../utils/encryption';
import { formatRupiah } from '../utils/geoAndPayroll';

interface BranchesAndSecurityModuleProps {
  currentUserUid: string;
  isAdmin: boolean;
  branches: Branch[];
  employees: Employee[];
}

export const BranchesAndSecurityModule: React.FC<BranchesAndSecurityModuleProps> = ({
  currentUserUid,
  isAdmin,
  branches,
  employees,
}) => {
  const [branchForm, setBranchForm] = useState({
    name: '',
    code: '',
    city: '',
    address: '',
    latitude: '-6.200000',
    longitude: '106.816666',
    radiusMeters: '250',
    shiftStart: '08:30',
    shiftEnd: '17:30',
  });
  const [savingBranch, setSavingBranch] = useState(false);

  const [empForm, setEmpForm] = useState({
    email: '',
    fullName: '',
    employeeCode: '',
    department: 'Operasional',
    position: 'Staf Regional',
    branchId: branches[0]?.id || 'cabang_jkt_hq',
    ptkpStatus: 'TK/0' as PTKPStatus,
    baseSalary: '9000000',
    dailyAllowance: '85000',
    nik: '',
    npwp: '',
    bankName: 'BCA',
    bankAccount: '',
  });
  const [savingEmp, setSavingEmp] = useState(false);

  const [vaultPassphrase, setVaultPassphrase] = useState(() => getActiveVaultPassphrase());
  const [inspectedEmpId, setInspectedEmpId] = useState<string | null>(null);
  const [inspectedCipher, setInspectedCipher] = useState<EmployeeEncryptedPII | null>(null);
  const [inspectedPlain, setInspectedPlain] = useState<EmployeeDecryptedPII | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const handleCreateBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    setSavingBranch(true);
    setFeedback(null);
    const cleanCode = branchForm.code.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const id = `cabang_${cleanCode.toLowerCase()}_${Date.now().toString().slice(-4)}`;
    try {
      await setDoc(doc(db, 'branches', id), {
        id,
        name: branchForm.name.trim(),
        code: cleanCode,
        city: branchForm.city.trim(),
        address: branchForm.address.trim(),
        latitude: Number(branchForm.latitude),
        longitude: Number(branchForm.longitude),
        radiusMeters: Number(branchForm.radiusMeters),
        shiftStart: branchForm.shiftStart,
        shiftEnd: branchForm.shiftEnd,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setBranchForm({
        name: '',
        code: '',
        city: '',
        address: '',
        latitude: '-6.200000',
        longitude: '106.816666',
        radiusMeters: '250',
        shiftStart: '08:30',
        shiftEnd: '17:30',
      });
      setFeedback(`Cabang ${cleanCode} berhasil ditambahkan dan tersinkron ke seluruh perangkat.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `branches/${id}`);
    } finally {
      setSavingBranch(false);
    }
  };

  const handleCreateEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    const cleanEmail = empForm.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setFeedback('Email Google karyawan tidak valid.');
      return;
    }
    if (employees.some((emp) => emp.email?.toLowerCase() === cleanEmail)) {
      setFeedback(`Email ${cleanEmail} sudah terdaftar di direktori karyawan.`);
      return;
    }
    setSavingEmp(true);
    setFeedback(null);
    const cleanCode = empForm.employeeCode.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const id = `emp_${Date.now()}`;
    const pendingUid = `UNCLAIMED_${id}`;
    try {
      await setDoc(doc(db, 'employees', id), {
        id,
        uid: pendingUid,
        email: cleanEmail,
        employeeCode: cleanCode,
        fullName: empForm.fullName.trim(),
        department: empForm.department.trim(),
        position: empForm.position.trim(),
        branchId: empForm.branchId || branches[0]?.id || 'cabang_jkt_hq',
        ptkpStatus: empForm.ptkpStatus,
        baseSalary: Number(empForm.baseSalary),
        dailyAllowance: Number(empForm.dailyAllowance),
        status: 'aktif',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const encrypted = await encryptEmployeePII(
        {
          nik: empForm.nik || '3174000000000000',
          npwp: empForm.npwp || '00.000.000.0-000.000',
          bankName: empForm.bankName || 'BCA',
          bankAccount: empForm.bankAccount || '0000000000',
          emergencyContact: '-',
        },
        pendingUid,
        vaultPassphrase
      );

      await setDoc(doc(db, 'employees', id, 'private', 'pii'), {
        ...encrypted,
        updatedAt: serverTimestamp(),
      });

      setEmpForm((prev) => ({
        ...prev,
        email: '',
        fullName: '',
        employeeCode: '',
        nik: '',
        npwp: '',
        bankAccount: '',
      }));
      setFeedback(`Karyawan ${empForm.fullName.trim()} (${cleanEmail}) didaftarkan dengan PII terenkripsi AES-256-GCM.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `employees/${id}`);
    } finally {
      setSavingEmp(false);
    }
  };

  const handleInspectVault = async (employeeId: string) => {
    setInspectedEmpId(employeeId);
    setInspectedPlain(null);
    setInspectedCipher(null);
    try {
      const snap = await getDoc(doc(db, 'employees', employeeId, 'private', 'pii'));
      if (snap.exists()) {
        const cipher = snap.data() as EmployeeEncryptedPII;
        setInspectedCipher(cipher);
        try {
          const plain = await decryptEmployeePII(cipher, vaultPassphrase);
          setInspectedPlain(plain);
        } catch {
          setInspectedPlain(null);
        }
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, `employees/${employeeId}/private/pii`);
    }
  };

  const handleApplyVaultKey = async () => {
    setActiveVaultPassphrase(vaultPassphrase);
    const fp = await getKeyFingerprint(vaultPassphrase);
    setFeedback(`Kunci sesi AES-256-GCM diperbarui (Fingerprint: ${fp}).`);
  };

  return (
    <div className="space-y-6 pb-20 lg:pb-6">
      <div>
        <p className="text-xs font-medium text-slate-500">
          Infrastruktur Cloud Multi-Cabang & Enkripsi Privasi Data
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
          Cabang Cloud, Karyawan & Brankas AES-256
        </h1>
      </div>

      {feedback && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs font-medium text-emerald-900">
          {feedback}
        </div>
      )}

      {/* Multi-Branch Synchronization Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-7">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Jaringan Kantor Cabang Tersinkronisasi ({branches.length})
              </h2>
              <p className="text-xs text-slate-500">
                Setiap pembaruan koordinat & radius geofence langsung aktif di ponsel seluruh karyawan.
              </p>
            </div>
            <Building2 className="h-5 w-5 text-slate-400" />
          </div>

          <div className="divide-y divide-slate-100">
            {branches.map((br) => (
              <div key={br.id} className="py-3.5 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {br.code} — {br.name}
                  </p>
                  <p className="text-xs text-slate-500">{br.address}</p>
                </div>
                <div className="text-left sm:text-right font-mono text-xs text-slate-700 tabular-nums">
                  <div>
                    {br.latitude.toFixed(4)}, {br.longitude.toFixed(4)}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Radius {br.radiusMeters}m · Shift {br.shiftStart}–{br.shiftEnd}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {isAdmin && (
          <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-5">
            <h2 className="text-base font-semibold text-slate-900">Tambah Cabang Baru</h2>
            <p className="text-xs text-slate-500 mb-4">
              Daftarkan lokasi cabang baru untuk sinkronisasi cloud instan.
            </p>
            <form onSubmit={handleCreateBranch} className="space-y-3 text-xs">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block font-medium text-slate-700">Kode</label>
                  <input
                    required
                    placeholder="BALI-01"
                    value={branchForm.code}
                    onChange={(e) => setBranchForm((p) => ({ ...p, code: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5 font-mono uppercase"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block font-medium text-slate-700">Kota</label>
                  <input
                    required
                    placeholder="Denpasar"
                    value={branchForm.city}
                    onChange={(e) => setBranchForm((p) => ({ ...p, city: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5"
                  />
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700">Nama Cabang</label>
                <input
                  required
                  placeholder="Cabang Bali Renon"
                  value={branchForm.name}
                  onChange={(e) => setBranchForm((p) => ({ ...p, name: e.target.value }))}
                  className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700">Alamat Lengkap</label>
                <input
                  required
                  placeholder="Jl. Raya Puputan No. 45"
                  value={branchForm.address}
                  onChange={(e) => setBranchForm((p) => ({ ...p, address: e.target.value }))}
                  className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block font-medium text-slate-700">Latitude</label>
                  <input
                    required
                    type="number"
                    step="any"
                    value={branchForm.latitude}
                    onChange={(e) => setBranchForm((p) => ({ ...p, latitude: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Longitude</label>
                  <input
                    required
                    type="number"
                    step="any"
                    value={branchForm.longitude}
                    onChange={(e) => setBranchForm((p) => ({ ...p, longitude: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Radius (m)</label>
                  <input
                    required
                    type="number"
                    min={20}
                    max={5000}
                    value={branchForm.radiusMeters}
                    onChange={(e) => setBranchForm((p) => ({ ...p, radiusMeters: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2 font-mono"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={savingBranch}
                className="w-full min-h-[42px] inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 font-semibold text-white hover:bg-slate-800 cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
                {savingBranch ? 'Menyimpan...' : 'Simpan & Sinkronkan Cabang'}
              </button>
            </form>
          </section>
        )}
      </div>

      {/* AES-256-GCM Encryption Vault & Employee Directory */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-7 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Direktori Karyawan & Inspeksi Enkripsi PII
              </h2>
              <p className="text-xs text-slate-500">
                Data identitas (NIK, NPWP, Bank) diisolasi dalam subkoleksi terenkripsi AES-256-GCM.
              </p>
            </div>
            <Users className="h-5 w-5 text-slate-400" />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 pr-3 font-medium">Karyawan</th>
                  <th className="py-2 px-2 font-medium">PTKP</th>
                  <th className="py-2 px-2 text-right font-medium">Gaji Pokok</th>
                  <th className="py-2 pl-2 text-right font-medium">Brankas PII</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {employees.map((emp) => (
                  <tr key={emp.id} className="hover:bg-slate-50">
                    <td className="py-2.5 pr-3">
                      <div className="font-medium text-slate-900">{emp.fullName}</div>
                      <div className="text-[11px] text-slate-500">
                        {emp.employeeCode} · {emp.position}
                      </div>
                      {emp.email && (
                        <div className="text-[10px] text-slate-400">{emp.email}</div>
                      )}
                    </td>
                    <td className="py-2.5 px-2 font-mono text-slate-700">{emp.ptkpStatus}</td>
                    <td className="py-2.5 px-2 text-right font-mono text-slate-900 tabular-nums">
                      {formatRupiah(emp.baseSalary)}
                    </td>
                    <td className="py-2.5 pl-2 text-right">
                      <button
                        type="button"
                        onClick={() => handleInspectVault(emp.id)}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                      >
                        <Lock className="h-3 w-3 text-emerald-600" />
                        Periksa Cipher
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {inspectedEmpId && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs space-y-2">
              <div className="flex items-center justify-between font-semibold text-slate-900">
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  Audit Enkripsi End-to-End (AES-256-GCM)
                </span>
                <span className="font-mono text-[11px] text-slate-500">
                  {inspectedCipher?.keyFingerprint || '—'}
                </span>
              </div>
              {inspectedCipher ? (
                <>
                  <div>
                    <span className="block text-[11px] font-medium text-slate-500">
                      Data Tersimpan di Cloud Firestore (Ciphertext Base64):
                    </span>
                    <code className="mt-0.5 block break-all rounded bg-slate-900 p-2 font-mono text-[10px] text-emerald-400">
                      {inspectedCipher.ciphertext}
                    </code>
                  </div>
                  {inspectedPlain ? (
                    <div className="grid grid-cols-2 gap-2 pt-1 text-slate-800">
                      <div>
                        <span className="text-slate-500">NIK (Terdekripsi):</span>{' '}
                        <span className="font-mono">{inspectedPlain.nik}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">NPWP:</span>{' '}
                        <span className="font-mono">{inspectedPlain.npwp}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Rekening:</span>{' '}
                        <span className="font-mono">
                          {inspectedPlain.bankName} {inspectedPlain.bankAccount}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500">Darurat:</span>{' '}
                        <span>{inspectedPlain.emergencyContact}</span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-rose-700">
                      Kunci dekripsi tidak cocok dengan ciphertext dokumen ini.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-slate-500">Tidak ada dokumen PII terenkripsi untuk karyawan ini.</p>
              )}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-5 space-y-5">
          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">Kunci Enkripsi Workspace</h2>
              <KeyRound className="h-4 w-4 text-emerald-600" />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Derivasi kunci PBKDF2-SHA256 (100.000 iterasi) berjalan lokal di browser Anda.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                type="password"
                value={vaultPassphrase}
                onChange={(e) => setVaultPassphrase(e.target.value)}
                className="flex-1 min-h-[38px] rounded-lg border border-slate-200 px-3 font-mono text-xs"
              />
              <button
                type="button"
                onClick={handleApplyVaultKey}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 cursor-pointer"
              >
                <Unlock className="h-3.5 w-3.5" />
                Terapkan
              </button>
            </div>
          </div>

          {isAdmin && (
            <form onSubmit={handleCreateEmployee} className="space-y-3 border-t border-slate-100 pt-4 text-xs">
              <h3 className="text-sm font-semibold text-slate-900">Registrasi Karyawan Baru</h3>
              <div>
                <label className="block font-medium text-slate-700">Email Google Karyawan (Wajib Login)</label>
                <input
                  required
                  type="email"
                  placeholder="karyawan@perusahaan.co.id"
                  value={empForm.email}
                  onChange={(e) => setEmpForm((p) => ({ ...p, email: e.target.value }))}
                  className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block font-medium text-slate-700">Kode</label>
                  <input
                    required
                    placeholder="EMP-006"
                    value={empForm.employeeCode}
                    onChange={(e) => setEmpForm((p) => ({ ...p, employeeCode: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5 font-mono uppercase"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block font-medium text-slate-700">Nama Lengkap</label>
                  <input
                    required
                    placeholder="Siti Rahmawati"
                    value={empForm.fullName}
                    onChange={(e) => setEmpForm((p) => ({ ...p, fullName: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium text-slate-700">Cabang</label>
                  <select
                    value={empForm.branchId}
                    onChange={(e) => setEmpForm((p) => ({ ...p, branchId: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 bg-white px-2"
                  >
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.code} — {b.city}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Status PTKP</label>
                  <select
                    value={empForm.ptkpStatus}
                    onChange={(e) =>
                      setEmpForm((p) => ({ ...p, ptkpStatus: e.target.value as PTKPStatus }))
                    }
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 bg-white px-2"
                  >
                    {['TK/0', 'TK/1', 'K/0', 'K/1', 'K/2', 'K/3'].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium text-slate-700">Gaji Pokok (IDR)</label>
                  <input
                    required
                    type="number"
                    value={empForm.baseSalary}
                    onChange={(e) => setEmpForm((p) => ({ ...p, baseSalary: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">NIK (Terenkripsi)</label>
                  <input
                    required
                    placeholder="3174..."
                    value={empForm.nik}
                    onChange={(e) => setEmpForm((p) => ({ ...p, nik: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium text-slate-700">NPWP (Terenkripsi)</label>
                  <input
                    required
                    placeholder="09.254..."
                    value={empForm.npwp}
                    onChange={(e) => setEmpForm((p) => ({ ...p, npwp: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">No. Rekening</label>
                  <input
                    required
                    placeholder="542091..."
                    value={empForm.bankAccount}
                    onChange={(e) => setEmpForm((p) => ({ ...p, bankAccount: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={savingEmp}
                className="w-full min-h-[42px] rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700 cursor-pointer"
              >
                {savingEmp ? 'Mengenkripsi & Menyimpan...' : 'Simpan Karyawan & Enkripsi PII'}
              </button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
};

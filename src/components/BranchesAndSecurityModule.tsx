import React, { useState } from 'react';
import {
  Building2,
  KeyRound,
  Lock,
  MapPin,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Unlock,
  Users,
  X,
} from 'lucide-react';
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
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
import { AdminBranchMapPicker } from './AdminBranchMapPicker';

interface BranchesAndSecurityModuleProps {
  currentUserUid: string;
  isAdmin: boolean;
  isSuperAdmin?: boolean;
  branches: Branch[];
  employees: Employee[];
}

const RADIUS_PRESETS = [50, 100, 250, 500, 1000, 2000];

const DEFAULT_BRANCH_FORM = {
  name: '',
  code: '',
  city: '',
  address: '',
  latitude: '-6.200000',
  longitude: '106.816666',
  radiusMeters: '250',
  shiftStart: '08:30',
  shiftEnd: '17:30',
  active: true,
};

export const BranchesAndSecurityModule: React.FC<BranchesAndSecurityModuleProps> = ({
  isAdmin,
  isSuperAdmin = false,
  branches,
  employees,
}) => {
  const [editingBranchId, setEditingBranchId] = useState<string | null>(null);
  const [branchForm, setBranchForm] = useState(DEFAULT_BRANCH_FORM);
  const [savingBranch, setSavingBranch] = useState(false);
  const [confirmDeleteBranchId, setConfirmDeleteBranchId] = useState<string | null>(null);

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
  const [editingPiiMode, setEditingPiiMode] = useState(false);
  const [piiEditForm, setPiiEditForm] = useState<EmployeeDecryptedPII>({
    nik: '',
    npwp: '',
    bankName: 'BCA',
    bankAccount: '',
    emergencyContact: '-',
  });
  const [savingPiiEdit, setSavingPiiEdit] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const startNewBranchMode = () => {
    setEditingBranchId(null);
    setBranchForm(DEFAULT_BRANCH_FORM);
    setFeedback(null);
  };

  const startEditBranchMode = (br: Branch) => {
    setEditingBranchId(br.id);
    setBranchForm({
      name: br.name,
      code: br.code,
      city: br.city,
      address: br.address,
      latitude: br.latitude.toFixed(6),
      longitude: br.longitude.toFixed(6),
      radiusMeters: String(br.radiusMeters),
      shiftStart: br.shiftStart,
      shiftEnd: br.shiftEnd,
      active: br.active,
    });
    setFeedback(null);
  };

  const handleSaveBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    setFeedback(null);

    const cleanCode = branchForm.code.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const cleanName = branchForm.name.trim();
    const cleanCity = branchForm.city.trim();
    const cleanAddress = branchForm.address.trim();
    const lat = Number(branchForm.latitude);
    const lng = Number(branchForm.longitude);
    const radius = Math.round(Number(branchForm.radiusMeters));

    if (cleanCode.length < 2 || cleanCode.length > 24) {
      setFeedback({ type: 'err', text: 'Kode cabang harus 2–24 karakter huruf/angka/tanda hubung.' });
      return;
    }
    if (cleanName.length < 2 || cleanCity.length < 2 || cleanAddress.length < 5) {
      setFeedback({
        type: 'err',
        text: 'Nama cabang, kota, dan alamat lengkap (minimal 5 karakter) wajib diisi.',
      });
      return;
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      setFeedback({ type: 'err', text: 'Koordinat Latitude/Longitude tidak valid.' });
      return;
    }
    if (!Number.isFinite(radius) || radius < 20 || radius > 5000) {
      setFeedback({ type: 'err', text: 'Radius absen harus di antara 20 meter hingga 5000 meter.' });
      return;
    }

    setSavingBranch(true);
    try {
      if (editingBranchId) {
        await updateDoc(doc(db, 'branches', editingBranchId), {
          name: cleanName.slice(0, 100),
          code: cleanCode,
          city: cleanCity.slice(0, 64),
          address: cleanAddress.slice(0, 240),
          latitude: lat,
          longitude: lng,
          radiusMeters: radius,
          shiftStart: branchForm.shiftStart,
          shiftEnd: branchForm.shiftEnd,
          active: branchForm.active,
          updatedAt: serverTimestamp(),
        });
        setFeedback({
          type: 'ok',
          text: `Lokasi & radius absen (${radius}m) cabang ${cleanCode} berhasil diperbarui ke cloud.`,
        });
      } else {
        const id = `cabang_${cleanCode.toLowerCase()}_${Date.now().toString().slice(-4)}`;
        await setDoc(doc(db, 'branches', id), {
          id,
          name: cleanName.slice(0, 100),
          code: cleanCode,
          city: cleanCity.slice(0, 64),
          address: cleanAddress.slice(0, 240),
          latitude: lat,
          longitude: lng,
          radiusMeters: radius,
          shiftStart: branchForm.shiftStart,
          shiftEnd: branchForm.shiftEnd,
          active: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        setBranchForm(DEFAULT_BRANCH_FORM);
        setFeedback({
          type: 'ok',
          text: `Cabang baru ${cleanCode} (${cleanName}) dengan radius absen ${radius}m tersinkron ke seluruh perangkat.`,
        });
      }
    } catch (err) {
      handleFirestoreError(
        err,
        editingBranchId ? OperationType.UPDATE : OperationType.CREATE,
        editingBranchId ? `branches/${editingBranchId}` : 'branches'
      );
    } finally {
      setSavingBranch(false);
    }
  };

  const handleDeleteBranch = async (branchId: string) => {
    if (!isAdmin) return;
    try {
      await deleteDoc(doc(db, 'branches', branchId));
      if (editingBranchId === branchId) {
        startNewBranchMode();
      }
      setConfirmDeleteBranchId(null);
      setFeedback({ type: 'ok', text: 'Cabang berhasil dihapus dari jaringan cloud.' });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `branches/${branchId}`);
    }
  };

  const handleCreateEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    const cleanEmail = empForm.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setFeedback({ type: 'err', text: 'Email Google karyawan tidak valid.' });
      return;
    }
    if (employees.some((emp) => emp.email?.toLowerCase() === cleanEmail)) {
      setFeedback({
        type: 'err',
        text: `Email ${cleanEmail} sudah terdaftar di direktori karyawan.`,
      });
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
      setFeedback({
        type: 'ok',
        text: `Karyawan ${empForm.fullName.trim()} (${cleanEmail}) didaftarkan dengan PII terenkripsi AES-256-GCM.`,
      });
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
    setEditingPiiMode(false);
    try {
      const snap = await getDoc(doc(db, 'employees', employeeId, 'private', 'pii'));
      if (snap.exists()) {
        const cipher = snap.data() as EmployeeEncryptedPII;
        setInspectedCipher(cipher);
        try {
          const plain = await decryptEmployeePII(cipher, vaultPassphrase);
          setInspectedPlain(plain);
          setPiiEditForm(plain);
        } catch {
          setInspectedPlain(null);
        }
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, `employees/${employeeId}/private/pii`);
    }
  };

  const handleSavePiiEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin || !inspectedEmpId) return;
    const emp = employees.find((item) => item.id === inspectedEmpId);
    if (!emp) return;
    setSavingPiiEdit(true);
    setFeedback(null);
    try {
      const encrypted = await encryptEmployeePII(
        {
          nik: piiEditForm.nik.trim() || '3174000000000000',
          npwp: piiEditForm.npwp.trim() || '00.000.000.0-000.000',
          bankName: piiEditForm.bankName.trim() || 'BCA',
          bankAccount: piiEditForm.bankAccount.trim() || '0000000000',
          emergencyContact: piiEditForm.emergencyContact.trim() || '-',
        },
        emp.uid,
        vaultPassphrase
      );
      await setDoc(doc(db, 'employees', emp.id, 'private', 'pii'), {
        ...encrypted,
        updatedAt: serverTimestamp(),
      });
      setInspectedCipher(encrypted);
      setInspectedPlain({ ...piiEditForm });
      setEditingPiiMode(false);
      setFeedback({
        type: 'ok',
        text: `Brankas PII terenkripsi AES-256 milik ${emp.fullName} berhasil diperbarui.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `employees/${emp.id}/private/pii`);
    } finally {
      setSavingPiiEdit(false);
    }
  };

  const handleApplyVaultKey = async () => {
    setActiveVaultPassphrase(vaultPassphrase);
    const fp = await getKeyFingerprint(vaultPassphrase);
    setFeedback({
      type: 'ok',
      text: `Kunci sesi AES-256-GCM diperbarui (Fingerprint: ${fp}).`,
    });
  };

  const parsedLat = Number(branchForm.latitude);
  const parsedLng = Number(branchForm.longitude);
  const parsedRadius = Math.max(20, Math.min(5000, Math.round(Number(branchForm.radiusMeters) || 250)));

  return (
    <div className="space-y-6 pb-20 lg:pb-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium text-slate-500">
            Integrasi Google Maps Geofencing · Multi-Cabang & Privasi AES-256
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
            Peta Cabang, Radius Absen & Enkripsi
          </h1>
        </div>
        {isAdmin && editingBranchId && (
          <button
            type="button"
            onClick={startNewBranchMode}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700 cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            Mode Tambah Cabang Baru
          </button>
        )}
      </div>

      {feedback && (
        <div
          className={`rounded-xl border p-4 text-xs font-medium ${
            feedback.type === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-rose-200 bg-rose-50 text-rose-900'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Google Maps Geofencing + Add / Edit Branch Form */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-7 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Peta Lokasi & Radius Geofence Google Maps
              </h2>
              <p className="text-xs text-slate-500">
                Cari lokasi, klik peta, atau seret pin & lingkaran hijau untuk mengatur titik kantor
                serta batas jarak absen.
              </p>
            </div>
            <MapPin className="h-5 w-5 shrink-0 text-emerald-600" />
          </div>

          <AdminBranchMapPicker
            branches={branches}
            editingBranchId={editingBranchId}
            targetLat={parsedLat}
            targetLng={parsedLng}
            targetRadius={parsedRadius}
            targetLabel={
              branchForm.name
                ? `${branchForm.code || 'CABANG'} — ${branchForm.name}`
                : editingBranchId
                ? 'Cabang Diedit'
                : 'Titik Cabang Baru'
            }
            onSelectCoordinates={(lat, lng) =>
              setBranchForm((p) => ({
                ...p,
                latitude: lat.toFixed(6),
                longitude: lng.toFixed(6),
              }))
            }
            onRadiusChange={(radius) =>
              setBranchForm((p) => ({ ...p, radiusMeters: String(radius) }))
            }
            onSelectExistingBranch={startEditBranchMode}
            onPlaceSelected={(place) => {
              setBranchForm((p) => ({
                ...p,
                name: p.name || place.name,
                city: place.city || p.city,
                address: place.address || p.address,
                latitude: place.lat.toFixed(6),
                longitude: place.lng.toFixed(6),
              }));
            }}
          />
        </section>

        {isAdmin && (
          <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-5 space-y-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  {editingBranchId ? 'Edit Cabang & Radius Absen' : 'Tambah Cabang Baru'}
                </h2>
                <p className="text-xs text-slate-500">
                  {editingBranchId
                    ? 'Sesuaikan koordinat GPS, jam shift, atau radius geofence cabang ini.'
                    : 'Daftarkan lokasi kantor cabang baru & batas jarak absen ponsel karyawan.'}
                </p>
              </div>
              {editingBranchId && (
                <button
                  type="button"
                  onClick={startNewBranchMode}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  <X className="h-3 w-3" />
                  Batal Edit
                </button>
              )}
            </div>

            <form onSubmit={handleSaveBranch} className="space-y-3 text-xs">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block font-medium text-slate-700">Kode</label>
                  <input
                    required
                    disabled={Boolean(editingBranchId)}
                    placeholder="BALI-01"
                    value={branchForm.code}
                    onChange={(e) => setBranchForm((p) => ({ ...p, code: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5 font-mono uppercase disabled:bg-slate-50"
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

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium text-slate-700">Latitude</label>
                  <input
                    required
                    type="number"
                    step="any"
                    value={branchForm.latitude}
                    onChange={(e) => setBranchForm((p) => ({ ...p, latitude: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5 font-mono"
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
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
              </div>

              {/* Interactive Radius Absen Slider & Presets */}
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <label className="font-semibold text-slate-900">
                    Radius Geofence Absen (Meter)
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      required
                      type="number"
                      min={20}
                      max={5000}
                      value={branchForm.radiusMeters}
                      onChange={(e) =>
                        setBranchForm((p) => ({ ...p, radiusMeters: e.target.value }))
                      }
                      className="w-20 min-h-[32px] rounded-md border border-emerald-300 bg-white px-2 text-right font-mono font-semibold text-slate-900"
                    />
                    <span className="font-mono text-[11px] text-slate-600">m</span>
                  </div>
                </div>

                <input
                  type="range"
                  min={20}
                  max={3000}
                  step={10}
                  value={Math.min(3000, parsedRadius)}
                  onChange={(e) =>
                    setBranchForm((p) => ({ ...p, radiusMeters: e.target.value }))
                  }
                  className="w-full accent-emerald-600 cursor-pointer"
                />

                <div className="flex flex-wrap gap-1.5">
                  {RADIUS_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() =>
                        setBranchForm((p) => ({ ...p, radiusMeters: String(preset) }))
                      }
                      className={`rounded-md border px-2 py-1 font-mono text-[11px] font-medium transition-colors cursor-pointer ${
                        parsedRadius === preset
                          ? 'border-emerald-700 bg-emerald-600 text-white'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {preset >= 1000 ? `${preset / 1000}km` : `${preset}m`}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium text-slate-700">Jam Masuk Shift</label>
                  <input
                    required
                    type="time"
                    value={branchForm.shiftStart}
                    onChange={(e) => setBranchForm((p) => ({ ...p, shiftStart: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Jam Pulang Shift</label>
                  <input
                    required
                    type="time"
                    value={branchForm.shiftEnd}
                    onChange={(e) => setBranchForm((p) => ({ ...p, shiftEnd: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
              </div>

              {editingBranchId && (
                <label className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 cursor-pointer">
                  <span className="font-medium text-slate-800">Status Cabang Aktif untuk Absensi</span>
                  <input
                    type="checkbox"
                    checked={branchForm.active}
                    onChange={(e) => setBranchForm((p) => ({ ...p, active: e.target.checked }))}
                    className="h-4 w-4 accent-emerald-600"
                  />
                </label>
              )}

              <button
                type="submit"
                disabled={savingBranch}
                className="w-full min-h-[42px] inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 font-semibold text-white hover:bg-slate-800 cursor-pointer"
              >
                {editingBranchId ? <Pencil className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                {savingBranch
                  ? 'Menyimpan...'
                  : editingBranchId
                  ? 'Simpan Perubahan Lokasi & Radius'
                  : 'Simpan & Sinkronkan Cabang'}
              </button>
            </form>
          </section>
        )}
      </div>

      {/* Synchronized Branch Directory List with Direct Edit & Radius Controls */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Jaringan Kantor Cabang Tersinkronisasi ({branches.length})
            </h2>
            <p className="text-xs text-slate-500">
              Pilih cabang untuk mengubah titik koordinat Google Maps atau menyesuaikan radius
              absen secara instan.
            </p>
          </div>
          <Building2 className="h-5 w-5 text-slate-400" />
        </div>

        <div className="divide-y divide-slate-100">
          {branches.map((br) => {
            const isBeingEdited = editingBranchId === br.id;
            return (
              <div
                key={br.id}
                className={`py-3.5 px-2 -mx-2 rounded-lg flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${
                  isBeingEdited ? 'bg-emerald-50/70' : ''
                }`}
              >
                <div className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-slate-900">
                      {br.code} — {br.name}
                    </p>
                    <span
                      className={`text-[11px] font-semibold ${
                        br.active ? 'text-emerald-700' : 'text-slate-400'
                      }`}
                    >
                      {br.active ? 'Aktif' : 'Nonaktif'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {br.address} · {br.city}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3 justify-between sm:justify-end">
                  <div className="text-left sm:text-right font-mono text-xs text-slate-700 tabular-nums">
                    <div>
                      {br.latitude.toFixed(5)}, {br.longitude.toFixed(5)}
                    </div>
                    <div className="text-[11px] font-semibold text-emerald-700">
                      Radius {br.radiusMeters}m · Shift {br.shiftStart}–{br.shiftEnd}
                    </div>
                  </div>

                  {isAdmin && (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => startEditBranchMode(br)}
                        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 cursor-pointer"
                      >
                        <Pencil className="h-3 w-3 text-emerald-600" />
                        Edit Lokasi & Radius
                      </button>

                      {branches.length > 1 &&
                        (confirmDeleteBranchId === br.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => void handleDeleteBranch(br.id)}
                              className="min-h-[36px] rounded-lg bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-rose-700 cursor-pointer"
                            >
                              Hapus
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteBranchId(null)}
                              className="min-h-[36px] rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-600 cursor-pointer"
                            >
                              Batal
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteBranchId(br.id)}
                            className="inline-flex min-h-[36px] items-center justify-center rounded-lg border border-slate-200 px-2.5 text-slate-500 hover:bg-rose-50 hover:text-rose-700 cursor-pointer"
                            aria-label={`Hapus cabang ${br.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

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
              <div className="flex flex-wrap items-center justify-between gap-2 font-semibold text-slate-900">
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  Audit Enkripsi End-to-End (AES-256-GCM)
                </span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-slate-500">
                    {inspectedCipher?.keyFingerprint || '—'}
                  </span>
                  {isSuperAdmin && (
                    <button
                      type="button"
                      onClick={() => setEditingPiiMode((v) => !v)}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                    >
                      <Pencil className="h-3 w-3 text-emerald-600" />
                      {editingPiiMode ? 'Tutup Edit PII' : 'Edit & Enkripsi Ulang'}
                    </button>
                  )}
                </div>
              </div>

              {editingPiiMode && isSuperAdmin ? (
                <form onSubmit={handleSavePiiEdit} className="space-y-2.5 pt-1">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block font-medium text-slate-700">NIK</label>
                      <input
                        required
                        value={piiEditForm.nik}
                        onChange={(e) => setPiiEditForm((p) => ({ ...p, nik: e.target.value }))}
                        className="mt-1 w-full min-h-[36px] rounded-lg border border-slate-200 bg-white px-2.5 font-mono"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700">NPWP</label>
                      <input
                        required
                        value={piiEditForm.npwp}
                        onChange={(e) => setPiiEditForm((p) => ({ ...p, npwp: e.target.value }))}
                        className="mt-1 w-full min-h-[36px] rounded-lg border border-slate-200 bg-white px-2.5 font-mono"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700">Bank</label>
                      <input
                        required
                        value={piiEditForm.bankName}
                        onChange={(e) =>
                          setPiiEditForm((p) => ({ ...p, bankName: e.target.value }))
                        }
                        className="mt-1 w-full min-h-[36px] rounded-lg border border-slate-200 bg-white px-2.5"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700">No. Rekening</label>
                      <input
                        required
                        value={piiEditForm.bankAccount}
                        onChange={(e) =>
                          setPiiEditForm((p) => ({ ...p, bankAccount: e.target.value }))
                        }
                        className="mt-1 w-full min-h-[36px] rounded-lg border border-slate-200 bg-white px-2.5 font-mono"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700">Kontak Darurat</label>
                    <input
                      value={piiEditForm.emergencyContact}
                      onChange={(e) =>
                        setPiiEditForm((p) => ({ ...p, emergencyContact: e.target.value }))
                      }
                      className="mt-1 w-full min-h-[36px] rounded-lg border border-slate-200 bg-white px-2.5"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingPiiMode(false)}
                      className="min-h-[36px] rounded-lg border border-slate-200 bg-white px-3 text-[11px] font-medium text-slate-700 cursor-pointer"
                    >
                      Batal
                    </button>
                    <button
                      type="submit"
                      disabled={savingPiiEdit}
                      className="min-h-[36px] rounded-lg bg-emerald-600 px-3.5 text-[11px] font-semibold text-white hover:bg-emerald-700 cursor-pointer"
                    >
                      {savingPiiEdit ? 'Mengenkripsi...' : 'Simpan & Enkripsi Ulang PII'}
                    </button>
                  </div>
                </form>
              ) : inspectedCipher ? (
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

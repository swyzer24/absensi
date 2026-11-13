import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Clock,
  Eye,
  FileCheck2,
  Search,
  Settings2,
  Shield,
  ShieldAlert,
  Trash2,
  UserCog,
  UserPlus,
  Users,
  X,
  AlertTriangle,
} from 'lucide-react';
import { deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { BOOTSTRAPPED_ADMIN_EMAIL, db, handleFirestoreError, OperationType } from '../firebase';
import type {
  AdminInvite,
  AdminRegistry,
  AdminRole,
  AppSettings,
  Branch,
  Employee,
  EmployeeStatus,
  LeaveRequest,
  OvertimeRequest,
  PTKPStatus,
} from '../types';
import { encryptEmployeePII, getActiveVaultPassphrase } from '../utils/encryption';

interface AdminControlCenterProps {
  currentUserUid: string;
  currentUserName: string;
  isSuperAdmin: boolean;
  admins: AdminRegistry[];
  adminInvites: AdminInvite[];
  appSettings: AppSettings | null;
  branches: Branch[];
  employees: Employee[];
  leaveRequests: LeaveRequest[];
  overtimeRequests: OvertimeRequest[];
  mirroredEmployeeId: string | null;
  onStartMirror: (employeeId: string) => void;
  onStopMirror: () => void;
}

type ControlTab = 'registration' | 'mirroring' | 'approvals' | 'settings';

const LEAVE_TYPE_LABELS: Record<LeaveRequest['leaveType'], string> = {
  izin_sakit: 'Izin Sakit',
  izin_pribadi: 'Izin Pribadi',
  cuti_tahunan: 'Cuti Tahunan',
  dinas_luar: 'Dinas Luar',
};

const ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: 'Super Admin',
  hrd_admin: 'Admin HRD',
  management: 'Manajemen',
};

export const AdminControlCenter: React.FC<AdminControlCenterProps> = ({
  currentUserUid,
  currentUserName,
  isSuperAdmin,
  admins,
  adminInvites,
  appSettings,
  branches,
  employees,
  leaveRequests,
  overtimeRequests,
  mirroredEmployeeId,
  onStartMirror,
  onStopMirror,
}) => {
  const [activeTab, setActiveTab] = useState<ControlTab>('registration');
  const [regSubTab, setRegSubTab] = useState<'employees' | 'hrd'>('employees');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Mirroring search & filter
  const [searchQuery, setSearchQuery] = useState('');
  const [branchFilter, setBranchFilter] = useState('ALL');

  // Approvals state
  const [approvalKind, setApprovalKind] = useState<'leave' | 'overtime'>('leave');
  const [approvalStatusFilter, setApprovalStatusFilter] = useState<'ALL' | 'menunggu' | 'disetujui' | 'ditolak'>('ALL');
  const [reviewNotesMap, setReviewNotesMap] = useState<Record<string, string>>({});
  const [processingReqId, setProcessingReqId] = useState<string | null>(null);

  // Global app settings form state
  const [settingsForm, setSettingsForm] = useState({
    companyName: 'PT Presensia Nusantara Teknologi',
    requireFaceVerification: true,
    requireGpsGeofence: true,
    allowEmployeeSelfService: true,
    lateToleranceMinutes: 5,
    maxOvertimeHoursPerMonth: 40,
    maintenanceMode: false,
    announcementBanner: '',
  });
  const [savingSettings, setSavingSettings] = useState(false);

  // Employee pre-registration form state
  const [newEmpForm, setNewEmpForm] = useState({
    email: '',
    employeeCode: '',
    fullName: '',
    department: 'Operasional',
    position: 'Staf Operasional',
    branchId: branches[0]?.id || 'cabang_jkt_hq',
    ptkpStatus: 'TK/0' as PTKPStatus,
    baseSalary: '9000000',
    dailyAllowance: '85000',
    nik: '',
    npwp: '',
    bankName: 'BCA',
    bankAccount: '',
  });
  const [savingNewEmp, setSavingNewEmp] = useState(false);

  // Admin/HRD pre-registration invite form state (Super Admin only)
  const [newAdminForm, setNewAdminForm] = useState({
    email: '',
    displayName: '',
    role: 'hrd_admin' as AdminRole,
  });
  const [savingAdmin, setSavingAdmin] = useState(false);

  useEffect(() => {
    if (appSettings) {
      setSettingsForm({
        companyName: appSettings.companyName,
        requireFaceVerification: appSettings.requireFaceVerification,
        requireGpsGeofence: appSettings.requireGpsGeofence,
        allowEmployeeSelfService: appSettings.allowEmployeeSelfService,
        lateToleranceMinutes: appSettings.lateToleranceMinutes,
        maxOvertimeHoursPerMonth: appSettings.maxOvertimeHoursPerMonth,
        maintenanceMode: appSettings.maintenanceMode,
        announcementBanner: appSettings.announcementBanner,
      });
    }
  }, [appSettings]);

  const branchMap = useMemo(() => new Map(branches.map((b) => [b.id, b])), [branches]);

  const pendingLeaveCount = useMemo(
    () => leaveRequests.filter((r) => r.status === 'menunggu').length,
    [leaveRequests]
  );
  const pendingOvertimeCount = useMemo(
    () => overtimeRequests.filter((r) => r.status === 'menunggu').length,
    [overtimeRequests]
  );
  const totalPendingApprovals = pendingLeaveCount + pendingOvertimeCount;

  const filteredEmployees = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return employees.filter((emp) => {
      if (branchFilter !== 'ALL' && emp.branchId !== branchFilter) return false;
      if (!q) return true;
      return (
        emp.fullName.toLowerCase().includes(q) ||
        emp.employeeCode.toLowerCase().includes(q) ||
        emp.department.toLowerCase().includes(q) ||
        emp.position.toLowerCase().includes(q)
      );
    });
  }, [employees, branchFilter, searchQuery]);

  const filteredLeaves = useMemo(() => {
    return [...leaveRequests]
      .filter((r) => approvalStatusFilter === 'ALL' || r.status === approvalStatusFilter)
      .sort((a, b) => b.startDate.localeCompare(a.startDate));
  }, [leaveRequests, approvalStatusFilter]);

  const filteredOvertimes = useMemo(() => {
    return [...overtimeRequests]
      .filter((r) => approvalStatusFilter === 'ALL' || r.status === approvalStatusFilter)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [overtimeRequests, approvalStatusFilter]);

  const handleReviewLeave = async (req: LeaveRequest, status: 'disetujui' | 'ditolak') => {
    setProcessingReqId(req.id);
    setFeedback(null);
    const noteText = (reviewNotesMap[req.id] || '').trim().slice(0, 240);
    try {
      await updateDoc(doc(db, 'leaveRequests', req.id), {
        status,
        reviewedByName: currentUserName,
        reviewNotes:
          noteText ||
          (status === 'disetujui'
            ? 'Disetujui oleh admin HRD.'
            : 'Ditolak oleh admin HRD.'),
        updatedAt: serverTimestamp(),
      });
      setFeedback({
        type: 'ok',
        text: `Pengajuan ${LEAVE_TYPE_LABELS[req.leaveType]} milik ${req.employeeName} telah ${
          status === 'disetujui' ? 'disetujui' : 'ditolak'
        }.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `leaveRequests/${req.id}`);
    } finally {
      setProcessingReqId(null);
    }
  };

  const handleReviewOvertime = async (req: OvertimeRequest, status: 'disetujui' | 'ditolak') => {
    setProcessingReqId(req.id);
    setFeedback(null);
    const noteText = (reviewNotesMap[req.id] || '').trim().slice(0, 240);
    try {
      await updateDoc(doc(db, 'overtimeRequests', req.id), {
        status,
        reviewedByName: currentUserName,
        reviewNotes:
          noteText ||
          (status === 'disetujui'
            ? 'Lembur disetujui untuk sinkronisasi payroll.'
            : 'Pengajuan lembur ditolak.'),
        updatedAt: serverTimestamp(),
      });
      setFeedback({
        type: 'ok',
        text: `Pengajuan lembur ${req.employeeName} (${req.durationHours} jam) telah ${
          status === 'disetujui' ? 'disetujui' : 'ditolak'
        }.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `overtimeRequests/${req.id}`);
    } finally {
      setProcessingReqId(null);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    setFeedback(null);
    const payload = {
      id: 'global',
      companyName: settingsForm.companyName.trim() || 'PT Presensia Nusantara Teknologi',
      requireFaceVerification: settingsForm.requireFaceVerification,
      requireGpsGeofence: settingsForm.requireGpsGeofence,
      allowEmployeeSelfService: settingsForm.allowEmployeeSelfService,
      lateToleranceMinutes: Math.max(0, Math.min(120, Number(settingsForm.lateToleranceMinutes) || 0)),
      maxOvertimeHoursPerMonth: Math.max(
        1,
        Math.min(200, Number(settingsForm.maxOvertimeHoursPerMonth) || 40)
      ),
      maintenanceMode: isSuperAdmin
        ? settingsForm.maintenanceMode
        : appSettings?.maintenanceMode ?? false,
      announcementBanner: settingsForm.announcementBanner.trim().slice(0, 240),
      updatedByUid: currentUserUid,
      updatedAt: serverTimestamp(),
    };

    try {
      await setDoc(doc(db, 'appSettings', 'global'), payload);
      setFeedback({
        type: 'ok',
        text: 'Konfigurasi aplikasi global berhasil disimpan dan langsung aktif di seluruh portal karyawan.',
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'appSettings/global');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleRegisterEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = newEmpForm.email.trim().toLowerCase();
    if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(cleanEmail)) {
      setFeedback({
        type: 'err',
        text: 'Format email Google karyawan tidak valid.',
      });
      return;
    }
    if (employees.some((emp) => emp.email?.toLowerCase() === cleanEmail)) {
      setFeedback({
        type: 'err',
        text: `Email ${cleanEmail} sudah terdaftar sebagai karyawan.`,
      });
      return;
    }
    const cleanCode = newEmpForm.employeeCode
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '');
    if (cleanCode.length < 3) {
      setFeedback({
        type: 'err',
        text: 'Kode karyawan minimal 3 karakter huruf/angka (contoh: EMP-006).',
      });
      return;
    }

    setSavingNewEmp(true);
    setFeedback(null);
    const id = `emp_${Date.now()}`;
    const pendingUid = `UNCLAIMED_${id}`;
    const targetBranchId = newEmpForm.branchId || branches[0]?.id || 'cabang_jkt_hq';

    try {
      await setDoc(doc(db, 'employees', id), {
        id,
        uid: pendingUid,
        email: cleanEmail,
        employeeCode: cleanCode,
        fullName: newEmpForm.fullName.trim(),
        department: newEmpForm.department.trim(),
        position: newEmpForm.position.trim(),
        branchId: targetBranchId,
        ptkpStatus: newEmpForm.ptkpStatus,
        baseSalary: Math.max(0, Number(newEmpForm.baseSalary) || 0),
        dailyAllowance: Math.max(0, Number(newEmpForm.dailyAllowance) || 0),
        status: 'aktif',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const encrypted = await encryptEmployeePII(
        {
          nik: newEmpForm.nik.trim() || '3174000000000000',
          npwp: newEmpForm.npwp.trim() || '00.000.000.0-000.000',
          bankName: newEmpForm.bankName.trim() || 'BCA',
          bankAccount: newEmpForm.bankAccount.trim() || '0000000000',
          emergencyContact: '-',
        },
        pendingUid,
        getActiveVaultPassphrase()
      );
      await setDoc(doc(db, 'employees', id, 'private', 'pii'), {
        ...encrypted,
        updatedAt: serverTimestamp(),
      });

      setNewEmpForm((p) => ({
        ...p,
        email: '',
        employeeCode: '',
        fullName: '',
        nik: '',
        npwp: '',
        bankAccount: '',
      }));
      setFeedback({
        type: 'ok',
        text: `Karyawan ${newEmpForm.fullName.trim()} (${cleanEmail}) berhasil didaftarkan. Karyawan kini dapat masuk ke Portal Karyawan menggunakan email Google tersebut.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `employees/${id}`);
    } finally {
      setSavingNewEmp(false);
    }
  };

  const handleUpdateEmployeeStatus = async (emp: Employee, nextStatus: EmployeeStatus) => {
    setFeedback(null);
    try {
      await updateDoc(doc(db, 'employees', emp.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      setFeedback({
        type: 'ok',
        text: `Status akun karyawan ${emp.fullName} diubah menjadi ${nextStatus.toUpperCase()}.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `employees/${emp.id}`);
    }
  };

  const handleDeleteEmployee = async (emp: Employee) => {
    setFeedback(null);
    try {
      await deleteDoc(doc(db, 'employees', emp.id, 'private', 'pii')).catch(() => {});
      await deleteDoc(doc(db, 'employees', emp.id));
      if (mirroredEmployeeId === emp.id) {
        onStopMirror();
      }
      setFeedback({
        type: 'ok',
        text: `Pendaftaran karyawan ${emp.fullName} telah dihapus dari sistem.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `employees/${emp.id}`);
    }
  };

  const handleCreateAdminInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin) return;
    const cleanEmail = newAdminForm.email.trim().toLowerCase();
    if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(cleanEmail)) {
      setFeedback({
        type: 'err',
        text: 'Format email Google Admin HRD / Super Admin tidak valid.',
      });
      return;
    }
    if (cleanEmail === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase()) {
      setFeedback({
        type: 'err',
        text: 'Email Super Admin utama sudah aktif secara permanen.',
      });
      return;
    }

    setSavingAdmin(true);
    setFeedback(null);
    try {
      await setDoc(doc(db, 'adminInvites', cleanEmail), {
        id: cleanEmail,
        email: cleanEmail,
        displayName: newAdminForm.displayName.trim(),
        role: newAdminForm.role,
        status: 'pending',
        createdByUid: currentUserUid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setNewAdminForm({ email: '', displayName: '', role: 'hrd_admin' });
      setFeedback({
        type: 'ok',
        text: `Akun ${ROLE_LABELS[newAdminForm.role]} untuk ${cleanEmail} berhasil didaftarkan. Saat pengguna masuk dengan Google, akses Dasbor Admin HRD akan aktif otomatis.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `adminInvites/${cleanEmail}`);
    } finally {
      setSavingAdmin(false);
    }
  };

  const handleCancelAdminInvite = async (invite: AdminInvite) => {
    if (!isSuperAdmin) return;
    try {
      await deleteDoc(doc(db, 'adminInvites', invite.id));
      setFeedback({
        type: 'ok',
        text: `Pendaftaran tertunda untuk ${invite.email} telah dibatalkan.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `adminInvites/${invite.id}`);
    }
  };

  const handleUpdateAdminRole = async (admin: AdminRegistry, role: AdminRole) => {
    if (!isSuperAdmin) return;
    if (admin.email === BOOTSTRAPPED_ADMIN_EMAIL && role !== 'super_admin') {
      setFeedback({
        type: 'err',
        text: 'Akun Super Admin utama tidak dapat diturunkan perannya.',
      });
      return;
    }
    try {
      await updateDoc(doc(db, 'admins', admin.uid), { role });
      const cleanEmail = admin.email.trim().toLowerCase();
      if (adminInvites.some((inv) => inv.id === cleanEmail)) {
        await updateDoc(doc(db, 'adminInvites', cleanEmail), {
          role,
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      }
      setFeedback({
        type: 'ok',
        text: `Peran ${admin.displayName} diperbarui menjadi ${ROLE_LABELS[role]}.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `admins/${admin.uid}`);
    }
  };

  const handleDeleteAdmin = async (admin: AdminRegistry) => {
    if (!isSuperAdmin) return;
    if (admin.uid === currentUserUid || admin.email === BOOTSTRAPPED_ADMIN_EMAIL) {
      setFeedback({
        type: 'err',
        text: 'Anda tidak dapat mencabut akses Super Admin utama atau akun sendiri.',
      });
      return;
    }
    try {
      await deleteDoc(doc(db, 'admins', admin.uid));
      const cleanEmail = admin.email.trim().toLowerCase();
      await deleteDoc(doc(db, 'adminInvites', cleanEmail)).catch(() => {});
      setFeedback({
        type: 'ok',
        text: `Akses admin untuk ${admin.displayName} (${admin.email}) telah dicabut.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `admins/${admin.uid}`);
    }
  };

  const pendingInvites = useMemo(
    () => adminInvites.filter((inv) => inv.status === 'pending'),
    [adminInvites]
  );

  return (
    <div className="space-y-6 pb-20 lg:pb-6">
      {/* Control Header */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-medium text-emerald-700">
              {isSuperAdmin
                ? 'Otoritas Penuh Super Admin · Kontrol Aplikasi & Hak Akses'
                : 'Dasbor Admin HRD · Operasional, Persetujuan & Mirroring'}
            </p>
            <h1 className="mt-1 text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
              Pusat Kontrol Super Admin & Admin HRD
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              Kelola kebijakan absensi global, setujui izin dan lembur karyawan, atur peran admin,
              serta lakukan mirroring tampilan portal karyawan secara real-time.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-4 border-t border-slate-100 pt-4 lg:border-t-0 lg:pt-0">
            <div>
              <span className="block text-[11px] text-slate-500">Karyawan Terdaftar</span>
              <span className="font-mono text-lg font-bold text-slate-900 tabular-nums">
                {employees.length}
              </span>
            </div>
            <div>
              <span className="block text-[11px] text-slate-500">Antrean Persetujuan</span>
              <span className="font-mono text-lg font-bold text-amber-700 tabular-nums">
                {totalPendingApprovals}
              </span>
            </div>
            <div>
              <span className="block text-[11px] text-slate-500">Admin Terotorisasi</span>
              <span className="font-mono text-lg font-bold text-slate-900 tabular-nums">
                {admins.length || 1}
              </span>
            </div>
          </div>
        </div>

        {/* Sub-navigation Tabs */}
        <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
          <button
            type="button"
            onClick={() => setActiveTab('registration')}
            className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'registration'
                ? 'bg-slate-900 text-white'
                : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <UserPlus className="h-3.5 w-3.5" />
            Pendaftaran Karyawan & HRD
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('mirroring')}
            className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'mirroring'
                ? 'bg-slate-900 text-white'
                : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Eye className="h-3.5 w-3.5" />
            Mirroring Karyawan
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('approvals')}
            className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'approvals'
                ? 'bg-slate-900 text-white'
                : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <FileCheck2 className="h-3.5 w-3.5" />
            Persetujuan ({totalPendingApprovals})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'settings'
                ? 'bg-slate-900 text-white'
                : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Settings2 className="h-3.5 w-3.5" />
            Kontrol Aplikasi Global
          </button>
        </div>
      </section>

      {feedback && (
        <div
          role="alert"
          className={`flex items-start gap-3 rounded-xl border p-4 text-xs ${
            feedback.type === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-rose-200 bg-rose-50 text-rose-900'
          }`}
        >
          {feedback.type === 'ok' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* TAB 0: PENDAFTARAN KARYAWAN & HRD */}
      {activeTab === 'registration' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setRegSubTab('employees')}
              className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                regSubTab === 'employees'
                  ? 'bg-emerald-600 text-white'
                  : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Users className="h-3.5 w-3.5" />
              Daftarkan Karyawan ({employees.length})
            </button>
            <button
              type="button"
              onClick={() => setRegSubTab('hrd')}
              className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                regSubTab === 'hrd'
                  ? 'bg-emerald-600 text-white'
                  : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <UserCog className="h-3.5 w-3.5" />
              Daftarkan HRD & Admin ({admins.length + pendingInvites.length})
            </button>
          </div>

          {regSubTab === 'employees' ? (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-5 space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    Daftarkan Akun Karyawan Baru
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Hanya email Google yang sudah didaftarkan di sini yang dapat masuk ke Portal
                    Karyawan.
                  </p>
                </div>

                <form onSubmit={handleRegisterEmployee} className="space-y-3 text-xs">
                  <div>
                    <label className="block font-medium text-slate-700">
                      Email Google Karyawan (Wajib untuk Login)
                    </label>
                    <input
                      type="email"
                      required
                      value={newEmpForm.email}
                      onChange={(e) => setNewEmpForm((p) => ({ ...p, email: e.target.value }))}
                      placeholder="budi.santoso@gmail.com"
                      className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-200 px-3 py-2 text-slate-900"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2.5">
                    <div>
                      <label className="block font-medium text-slate-700">Kode EMP</label>
                      <input
                        type="text"
                        required
                        value={newEmpForm.employeeCode}
                        onChange={(e) =>
                          setNewEmpForm((p) => ({ ...p, employeeCode: e.target.value }))
                        }
                        placeholder="EMP-006"
                        className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-200 px-2.5 font-mono uppercase text-slate-900"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block font-medium text-slate-700">Nama Lengkap</label>
                      <input
                        type="text"
                        required
                        minLength={2}
                        value={newEmpForm.fullName}
                        onChange={(e) =>
                          setNewEmpForm((p) => ({ ...p, fullName: e.target.value }))
                        }
                        placeholder="Budi Santoso"
                        className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-200 px-3 text-slate-900"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block font-medium text-slate-700">Cabang</label>
                      <select
                        value={newEmpForm.branchId}
                        onChange={(e) =>
                          setNewEmpForm((p) => ({ ...p, branchId: e.target.value }))
                        }
                        className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-200 bg-white px-2.5 text-slate-900"
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
                        value={newEmpForm.ptkpStatus}
                        onChange={(e) =>
                          setNewEmpForm((p) => ({
                            ...p,
                            ptkpStatus: e.target.value as PTKPStatus,
                          }))
                        }
                        className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-200 bg-white px-2.5 text-slate-900"
                      >
                        {(['TK/0', 'TK/1', 'K/0', 'K/1', 'K/2', 'K/3'] as PTKPStatus[]).map(
                          (ptkp) => (
                            <option key={ptkp} value={ptkp}>
                              {ptkp}
                            </option>
                          )
                        )}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block font-medium text-slate-700">Divisi</label>
                      <input
                        type="text"
                        required
                        value={newEmpForm.department}
                        onChange={(e) =>
                          setNewEmpForm((p) => ({ ...p, department: e.target.value }))
                        }
                        className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-200 px-3 text-slate-900"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700">Jabatan</label>
                      <input
                        type="text"
                        required
                        value={newEmpForm.position}
                        onChange={(e) =>
                          setNewEmpForm((p) => ({ ...p, position: e.target.value }))
                        }
                        className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-200 px-3 text-slate-900"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block font-medium text-slate-700">Gaji Pokok (IDR)</label>
                      <input
                        type="number"
                        required
                        min={0}
                        value={newEmpForm.baseSalary}
                        onChange={(e) =>
                          setNewEmpForm((p) => ({ ...p, baseSalary: e.target.value }))
                        }
                        className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-200 px-3 font-mono text-slate-900"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700">
                        Tunjangan Harian (IDR)
                      </label>
                      <input
                        type="number"
                        required
                        min={0}
                        value={newEmpForm.dailyAllowance}
                        onChange={(e) =>
                          setNewEmpForm((p) => ({ ...p, dailyAllowance: e.target.value }))
                        }
                        className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-200 px-3 font-mono text-slate-900"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5 pt-1">
                    <div>
                      <label className="block font-medium text-slate-700">
                        NIK (Opsional, AES-256)
                      </label>
                      <input
                        type="text"
                        value={newEmpForm.nik}
                        onChange={(e) => setNewEmpForm((p) => ({ ...p, nik: e.target.value }))}
                        placeholder="3174..."
                        className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-3 font-mono text-slate-900"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700">
                        No. Rekening (Opsional)
                      </label>
                      <input
                        type="text"
                        value={newEmpForm.bankAccount}
                        onChange={(e) =>
                          setNewEmpForm((p) => ({ ...p, bankAccount: e.target.value }))
                        }
                        placeholder="542091..."
                        className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-3 font-mono text-slate-900"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={savingNewEmp}
                    className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 cursor-pointer"
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    {savingNewEmp ? 'Mendaftarkan Karyawan...' : 'Daftarkan Karyawan Sekarang'}
                  </button>
                </form>
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-7 space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    Daftar Karyawan Terdaftar ({employees.length})
                  </h2>
                  <p className="text-xs text-slate-500">
                    Karyawan yang berstatus <strong>Aktif</strong> dapat langsung masuk ke Portal
                    Karyawan menggunakan email Google terdaftar.
                  </p>
                </div>

                <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                  {employees.map((emp) => {
                    const br = branchMap.get(emp.branchId);
                    const isLinked = !emp.uid.startsWith('UNCLAIMED_');
                    return (
                      <div
                        key={emp.id}
                        className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-xs font-semibold text-slate-900 truncate">
                              {emp.fullName}
                            </p>
                            <span
                              className={`text-[11px] font-semibold ${
                                isLinked ? 'text-emerald-700' : 'text-amber-700'
                              }`}
                            >
                              · {isLinked ? 'Sudah Aktivasi' : 'Menunggu Login Pertama'}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-600 truncate">
                            {emp.email || 'Email belum disetel'}
                          </p>
                          <p className="font-mono text-[10px] text-slate-400">
                            {emp.employeeCode} · {emp.position} · {br?.code || emp.branchId}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          <select
                            value={emp.status}
                            onChange={(e) =>
                              handleUpdateEmployeeStatus(emp, e.target.value as EmployeeStatus)
                            }
                            className="min-h-[38px] rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-800"
                          >
                            <option value="aktif">Aktif</option>
                            <option value="cuti">Cuti</option>
                            <option value="nonaktif">Nonaktif</option>
                          </select>
                          <button
                            type="button"
                            onClick={() => onStartMirror(emp.id)}
                            className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                            title="Mirroring tampilan karyawan"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            Mirror
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteEmployee(emp)}
                            className="inline-flex min-h-[38px] items-center justify-center rounded-lg border border-rose-200 px-2.5 text-rose-600 hover:bg-rose-50 cursor-pointer"
                            title="Hapus pendaftaran karyawan"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-5 space-y-4">
                <div className="flex items-center gap-2">
                  <Shield className="h-4 w-4 text-emerald-600" />
                  <h2 className="text-base font-semibold text-slate-900">
                    Daftarkan Admin HRD / Super Admin
                  </h2>
                </div>
                <p className="text-xs text-slate-500">
                  Daftarkan email Google terlebih dahulu. Pengguna yang masuk dengan email tersebut
                  akan otomatis memperoleh Dasbor Admin HRD atau Super Admin.
                </p>

                {!isSuperAdmin ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                    Pendaftaran atau pencabutan akun Admin HRD dan Super Admin hanya dapat dilakukan
                    oleh akun <strong>Super Admin</strong>.
                  </div>
                ) : (
                  <form onSubmit={handleCreateAdminInvite} className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700">
                        Email Google Admin HRD / Super Admin
                      </label>
                      <input
                        type="email"
                        required
                        value={newAdminForm.email}
                        onChange={(e) => setNewAdminForm((p) => ({ ...p, email: e.target.value }))}
                        placeholder="hrd.baru@gmail.com"
                        className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-900"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700">
                        Nama Lengkap
                      </label>
                      <input
                        type="text"
                        required
                        minLength={2}
                        value={newAdminForm.displayName}
                        onChange={(e) =>
                          setNewAdminForm((p) => ({ ...p, displayName: e.target.value }))
                        }
                        placeholder="Contoh: Hendra Wijaya"
                        className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-900"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700">
                        Tingkat Peran
                      </label>
                      <select
                        value={newAdminForm.role}
                        onChange={(e) =>
                          setNewAdminForm((p) => ({ ...p, role: e.target.value as AdminRole }))
                        }
                        className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900"
                      >
                        <option value="hrd_admin">
                          Admin HRD (Operasional, Payroll & Mirroring)
                        </option>
                        <option value="management">Manajemen (Analitik & Laporan)</option>
                        <option value="super_admin">Super Admin (Kontrol Penuh Aplikasi)</option>
                      </select>
                    </div>
                    <button
                      type="submit"
                      disabled={savingAdmin}
                      className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      {savingAdmin ? 'Mendaftarkan Otoritas...' : 'Daftarkan Akun Admin / HRD'}
                    </button>
                  </form>
                )}
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-7 space-y-5">
                {pendingInvites.length > 0 && (
                  <div className="space-y-2.5">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                      Terdaftar — Menunggu Login Pertama ({pendingInvites.length})
                    </h3>
                    <div className="divide-y divide-amber-100 rounded-xl border border-amber-200 bg-amber-50/40">
                      {pendingInvites.map((inv) => (
                        <div
                          key={inv.id}
                          className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div>
                            <p className="text-xs font-semibold text-slate-900">
                              {inv.displayName} ·{' '}
                              <span className="text-amber-800">{ROLE_LABELS[inv.role]}</span>
                            </p>
                            <p className="text-[11px] text-slate-600">{inv.email}</p>
                          </div>
                          {isSuperAdmin && (
                            <button
                              type="button"
                              onClick={() => handleCancelAdminInvite(inv)}
                              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 text-[11px] font-medium text-rose-700 hover:bg-rose-50 cursor-pointer"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Batalkan
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900">
                        Admin HRD & Super Admin Aktif ({admins.length})
                      </h2>
                      <p className="text-xs text-slate-500">
                        Akun yang sudah aktif masuk ke Dasbor Super Admin / Admin HRD.
                      </p>
                    </div>
                    <Users className="h-5 w-5 text-slate-400" />
                  </div>

                  <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                    {admins.length === 0 ? (
                      <div className="p-6 text-center text-xs text-slate-500">
                        Memuat daftar admin... (Super Admin utama {BOOTSTRAPPED_ADMIN_EMAIL} selalu
                        aktif).
                      </div>
                    ) : (
                      admins.map((adm) => {
                        const isMainRoot = adm.email === BOOTSTRAPPED_ADMIN_EMAIL;
                        return (
                          <div
                            key={adm.uid}
                            className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div>
                              <p className="text-xs font-semibold text-slate-900">
                                {adm.displayName} {adm.uid === currentUserUid ? '(Anda)' : ''}
                              </p>
                              <p className="text-[11px] text-slate-500">{adm.email}</p>
                            </div>

                            <div className="flex items-center gap-2">
                              <select
                                disabled={!isSuperAdmin || isMainRoot}
                                value={adm.role}
                                onChange={(e) =>
                                  handleUpdateAdminRole(adm, e.target.value as AdminRole)
                                }
                                className="min-h-[38px] rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 disabled:bg-slate-50"
                              >
                                <option value="super_admin">Super Admin</option>
                                <option value="hrd_admin">Admin HRD</option>
                                <option value="management">Manajemen</option>
                              </select>
                              {isSuperAdmin && !isMainRoot && adm.uid !== currentUserUid && (
                                <button
                                  type="button"
                                  onClick={() => handleDeleteAdmin(adm)}
                                  className="inline-flex min-h-[38px] items-center justify-center rounded-lg border border-rose-200 px-2.5 text-rose-600 hover:bg-rose-50 cursor-pointer"
                                  title="Cabut akses admin"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </section>
            </div>
          )}
        </div>
      )}

      {/* TAB 1: EMPLOYEE MIRRORING */}
      {activeTab === 'mirroring' && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Mirroring Tampilan & Data Karyawan (Real-Time)
              </h2>
              <p className="text-xs text-slate-500">
                Pilih karyawan untuk melihat persis tampilan dasbor ikon, slip gaji, riwayat absen,
                pengajuan izin, dan lembur dari sudut pandang karyawan tersebut.
              </p>
            </div>
            {mirroredEmployeeId && (
              <button
                type="button"
                onClick={onStopMirror}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
                Hentikan Mirroring Aktif
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="relative sm:col-span-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Cari nama karyawan, kode EMP, jabatan, atau departemen..."
                className="w-full min-h-[44px] rounded-lg border border-slate-200 pl-9 pr-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:outline-none"
              />
            </div>
            <select
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              className="w-full min-h-[44px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-emerald-600 focus:outline-none"
            >
              <option value="ALL">Semua Cabang ({branches.length})</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredEmployees.map((emp) => {
              const br = branchMap.get(emp.branchId);
              const isActiveMirror = mirroredEmployeeId === emp.id;
              const empLeaves = leaveRequests.filter((l) => l.employeeId === emp.id).length;
              const empOt = overtimeRequests.filter((o) => o.employeeId === emp.id).length;

              return (
                <div
                  key={emp.id}
                  className={`flex flex-col justify-between rounded-xl border p-4 transition-colors ${
                    isActiveMirror
                      ? 'border-emerald-600 bg-emerald-50/40'
                      : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        {emp.avatarUrl ? (
                          <img
                            src={emp.avatarUrl}
                            alt={emp.fullName}
                            referrerPolicy="no-referrer"
                            className="h-11 w-11 rounded-full object-cover border border-slate-200"
                          />
                        ) : (
                          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-700">
                            {emp.fullName
                              .split(' ')
                              .slice(0, 2)
                              .map((s) => s[0])
                              .join('')}
                          </div>
                        )}
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{emp.fullName}</p>
                          <p className="text-[11px] text-slate-500">
                            {emp.employeeCode} · {emp.position}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-1 border-t border-slate-100 pt-2.5 text-xs text-slate-600">
                      <p>
                        <span className="text-slate-400">Cabang:</span>{' '}
                        <span className="font-medium text-slate-800">{br?.name || emp.branchId}</span>
                      </p>
                      <p>
                        <span className="text-slate-400">Divisi:</span> {emp.department} · PTKP{' '}
                        <span className="font-mono">{emp.ptkpStatus}</span>
                      </p>
                      <p className="font-mono text-[11px] text-slate-500 tabular-nums">
                        {empLeaves} Pengajuan Izin · {empOt} Pengajuan Lembur
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onStartMirror(emp.id)}
                    className={`mt-4 inline-flex min-h-[42px] w-full items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                      isActiveMirror
                        ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                        : 'bg-slate-900 text-white hover:bg-slate-800'
                    }`}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    {isActiveMirror ? 'Buka Mirroring Aktif' : 'Mirroring Tampilan Karyawan'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* TAB 2: LEAVE & OVERTIME APPROVALS */}
      {activeTab === 'approvals' && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setApprovalKind('leave')}
                className={`min-h-[40px] rounded-lg px-3.5 py-2 text-xs font-semibold cursor-pointer ${
                  approvalKind === 'leave'
                    ? 'bg-emerald-600 text-white'
                    : 'border border-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
              >
                Izin & Cuti ({pendingLeaveCount} Menunggu)
              </button>
              <button
                type="button"
                onClick={() => setApprovalKind('overtime')}
                className={`min-h-[40px] rounded-lg px-3.5 py-2 text-xs font-semibold cursor-pointer ${
                  approvalKind === 'overtime'
                    ? 'bg-emerald-600 text-white'
                    : 'border border-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
              >
                Pengajuan Lembur ({pendingOvertimeCount} Menunggu)
              </button>
            </div>

            <select
              value={approvalStatusFilter}
              onChange={(e) =>
                setApprovalStatusFilter(
                  e.target.value as 'ALL' | 'menunggu' | 'disetujui' | 'ditolak'
                )
              }
              className="min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900"
            >
              <option value="ALL">Semua Status</option>
              <option value="menunggu">Menunggu Persetujuan</option>
              <option value="disetujui">Disetujui</option>
              <option value="ditolak">Ditolak</option>
            </select>
          </div>

          {approvalKind === 'leave' ? (
            filteredLeaves.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">
                Tidak ada pengajuan izin atau cuti yang sesuai filter saat ini.
              </div>
            ) : (
              <div className="space-y-3">
                {filteredLeaves.map((req) => {
                  const br = branchMap.get(req.branchId);
                  const canAct = req.status === 'menunggu' || isSuperAdmin;
                  return (
                    <div
                      key={req.id}
                      className="rounded-xl border border-slate-200 p-4 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"
                    >
                      <div className="space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-semibold text-slate-900">{req.employeeName}</span>
                          <span className="text-slate-400">·</span>
                          <span className="font-medium text-slate-700">
                            {LEAVE_TYPE_LABELS[req.leaveType]}
                          </span>
                          <span className="text-slate-400">·</span>
                          <span className="text-slate-500">{br?.code || req.branchId}</span>
                          <span className="text-slate-400">·</span>
                          <span
                            className={`font-semibold ${
                              req.status === 'disetujui'
                                ? 'text-emerald-700'
                                : req.status === 'ditolak'
                                ? 'text-rose-700'
                                : 'text-amber-700'
                            }`}
                          >
                            {req.status === 'menunggu'
                              ? 'Menunggu Persetujuan'
                              : req.status === 'disetujui'
                              ? 'Disetujui'
                              : 'Ditolak'}
                          </span>
                        </div>
                        <p className="font-mono text-xs text-slate-600 tabular-nums">
                          Periode: {req.startDate} s/d {req.endDate} ({req.totalDays} hari)
                        </p>
                        <p className="text-xs text-slate-700">Alasan: {req.reason}</p>
                        {req.reviewedByName && (
                          <p className="text-[11px] text-slate-500">
                            Ditinjau oleh {req.reviewedByName}
                            {req.reviewNotes ? ` — "${req.reviewNotes}"` : ''}
                          </p>
                        )}
                      </div>

                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center lg:shrink-0">
                        {canAct && (
                          <>
                            <input
                              type="text"
                              value={reviewNotesMap[req.id] || ''}
                              onChange={(e) =>
                                setReviewNotesMap((prev) => ({
                                  ...prev,
                                  [req.id]: e.target.value,
                                }))
                              }
                              placeholder="Catatan persetujuan (opsional)"
                              className="min-h-[40px] rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-900 sm:w-52"
                            />
                            <button
                              type="button"
                              disabled={processingReqId === req.id}
                              onClick={() => handleReviewLeave(req, 'disetujui')}
                              className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700 cursor-pointer"
                            >
                              <Check className="h-3.5 w-3.5" />
                              Setujui
                            </button>
                            <button
                              type="button"
                              disabled={processingReqId === req.id}
                              onClick={() => handleReviewLeave(req, 'ditolak')}
                              className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100 cursor-pointer"
                            >
                              <X className="h-3.5 w-3.5" />
                              Tolak
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => onStartMirror(req.employeeId)}
                          className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          Mirror
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : filteredOvertimes.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">
              Tidak ada pengajuan lembur yang sesuai filter saat ini.
            </div>
          ) : (
            <div className="space-y-3">
              {filteredOvertimes.map((req) => {
                const br = branchMap.get(req.branchId);
                const canAct = req.status === 'menunggu' || isSuperAdmin;
                return (
                  <div
                    key={req.id}
                    className="rounded-xl border border-slate-200 p-4 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"
                  >
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-slate-900">{req.employeeName}</span>
                        <span className="text-slate-400">·</span>
                        <span className="font-mono font-medium text-slate-700 tabular-nums">
                          {req.durationHours} Jam Lembur
                        </span>
                        <span className="text-slate-400">·</span>
                        <span className="text-slate-500">{br?.code || req.branchId}</span>
                        <span className="text-slate-400">·</span>
                        <span
                          className={`font-semibold ${
                            req.status === 'disetujui'
                              ? 'text-emerald-700'
                              : req.status === 'ditolak'
                              ? 'text-rose-700'
                              : 'text-amber-700'
                          }`}
                        >
                          {req.status === 'menunggu'
                            ? 'Menunggu Persetujuan'
                            : req.status === 'disetujui'
                            ? 'Disetujui'
                            : 'Ditolak'}
                        </span>
                      </div>
                      <p className="font-mono text-xs text-slate-600 tabular-nums">
                        <Clock className="mr-1 inline h-3.5 w-3.5 text-slate-400" />
                        {req.date} · {req.startTime} – {req.endTime} WIB
                      </p>
                      <p className="text-xs text-slate-700">Pekerjaan: {req.reason}</p>
                      {req.reviewedByName && (
                        <p className="text-[11px] text-slate-500">
                          Ditinjau oleh {req.reviewedByName}
                          {req.reviewNotes ? ` — "${req.reviewNotes}"` : ''}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center lg:shrink-0">
                      {canAct && (
                        <>
                          <input
                            type="text"
                            value={reviewNotesMap[req.id] || ''}
                            onChange={(e) =>
                              setReviewNotesMap((prev) => ({
                                ...prev,
                                [req.id]: e.target.value,
                              }))
                            }
                            placeholder="Catatan persetujuan (opsional)"
                            className="min-h-[40px] rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-900 sm:w-52"
                          />
                          <button
                            type="button"
                            disabled={processingReqId === req.id}
                            onClick={() => handleReviewOvertime(req, 'disetujui')}
                            className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700 cursor-pointer"
                          >
                            <Check className="h-3.5 w-3.5" />
                            Setujui
                          </button>
                          <button
                            type="button"
                            disabled={processingReqId === req.id}
                            onClick={() => handleReviewOvertime(req, 'ditolak')}
                            className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100 cursor-pointer"
                          >
                            <X className="h-3.5 w-3.5" />
                            Tolak
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => onStartMirror(req.employeeId)}
                        className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        Mirror
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* TAB 3: GLOBAL APP SETTINGS */}
      {activeTab === 'settings' && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
          <div className="mb-5">
            <h2 className="text-base font-semibold text-slate-900">
              Kontrol Kebijakan & Pengaturan Aplikasi Global
            </h2>
            <p className="text-xs text-slate-500">
              Pengaturan ini langsung mengontrol perilaku terminal absensi, toleransi shift, dan
              pengumuman di semua perangkat karyawan.
            </p>
          </div>

          <form onSubmit={handleSaveSettings} className="space-y-5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Nama Perusahaan (Kop Slip Gaji)
                </label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={100}
                  value={settingsForm.companyName}
                  onChange={(e) =>
                    setSettingsForm((p) => ({ ...p, companyName: e.target.value }))
                  }
                  className="mt-1.5 w-full min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Toleransi Keterlambatan (Menit)
                </label>
                <input
                  type="number"
                  min={0}
                  max={120}
                  required
                  value={settingsForm.lateToleranceMinutes}
                  onChange={(e) =>
                    setSettingsForm((p) => ({
                      ...p,
                      lateToleranceMinutes: Number(e.target.value),
                    }))
                  }
                  className="mt-1.5 w-full min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900 tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Kuota Maksimal Lembur / Bulan (Jam)
                </label>
                <input
                  type="number"
                  min={1}
                  max={200}
                  required
                  value={settingsForm.maxOvertimeHoursPerMonth}
                  onChange={(e) =>
                    setSettingsForm((p) => ({
                      ...p,
                      maxOvertimeHoursPerMonth: Number(e.target.value),
                    }))
                  }
                  className="mt-1.5 w-full min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900 tabular-nums"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700">
                Papan Pengumuman Global (Tampil di Dasbor Karyawan)
              </label>
              <input
                type="text"
                maxLength={240}
                value={settingsForm.announcementBanner}
                onChange={(e) =>
                  setSettingsForm((p) => ({ ...p, announcementBanner: e.target.value }))
                }
                placeholder="Kosongkan jika tidak ada pengumuman aktif..."
                className="mt-1.5 w-full min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-900"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsForm.requireFaceVerification}
                  onChange={(e) =>
                    setSettingsForm((p) => ({ ...p, requireFaceVerification: e.target.checked }))
                  }
                  className="mt-0.5 h-4 w-4 rounded accent-emerald-600"
                />
                <div>
                  <span className="block text-xs font-semibold text-slate-900">
                    Wajib Validasi Foto Wajah Anti-Kecurangan
                  </span>
                  <span className="block text-[11px] text-slate-500">
                    Karyawan harus memverifikasi foto wajah kamera langsung sebelum absen masuk.
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsForm.requireGpsGeofence}
                  onChange={(e) =>
                    setSettingsForm((p) => ({ ...p, requireGpsGeofence: e.target.checked }))
                  }
                  className="mt-0.5 h-4 w-4 rounded accent-emerald-600"
                />
                <div>
                  <span className="block text-xs font-semibold text-slate-900">
                    Wajib Lokasi GPS Dalam Radius Cabang
                  </span>
                  <span className="block text-[11px] text-slate-500">
                    Menolak absen masuk/pulang apabila perangkat berada di luar radius geofence cabang.
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsForm.allowEmployeeSelfService}
                  onChange={(e) =>
                    setSettingsForm((p) => ({ ...p, allowEmployeeSelfService: e.target.checked }))
                  }
                  className="mt-0.5 h-4 w-4 rounded accent-emerald-600"
                />
                <div>
                  <span className="block text-xs font-semibold text-slate-900">
                    Aktifkan Pengajuan Mandiri (Izin, Cuti & Lembur)
                  </span>
                  <span className="block text-[11px] text-slate-500">
                    Mengizinkan karyawan mengirim pengajuan izin dan lembur langsung dari dasbor ponsel.
                  </span>
                </div>
              </label>

              <label
                className={`flex items-start gap-3 rounded-xl border p-4 ${
                  isSuperAdmin
                    ? 'border-amber-200 bg-amber-50/40 cursor-pointer'
                    : 'border-slate-200 bg-slate-50 opacity-70 cursor-not-allowed'
                }`}
              >
                <input
                  type="checkbox"
                  disabled={!isSuperAdmin}
                  checked={settingsForm.maintenanceMode}
                  onChange={(e) =>
                    setSettingsForm((p) => ({ ...p, maintenanceMode: e.target.checked }))
                  }
                  className="mt-0.5 h-4 w-4 rounded accent-amber-600"
                />
                <div>
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
                    <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />
                    Mode Pemeliharaan Sistem (Khusus Super Admin)
                  </span>
                  <span className="block text-[11px] text-slate-500">
                    Membatasi akses portal karyawan sementara saat audit payroll atau pemeliharaan server.
                  </span>
                </div>
              </label>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={savingSettings}
                className="min-h-[44px] rounded-lg bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-700 cursor-pointer"
              >
                {savingSettings ? 'Menyimpan Konfigurasi...' : 'Simpan & Terapkan Kebijakan Global'}
              </button>
            </div>
          </form>
        </section>
      )}

    </div>
  );
};

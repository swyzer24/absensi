import React, { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { AttendanceRecord, AttendanceStatus, Branch, Employee, PayrollRun } from '../types';
import {
  downloadCSV,
  formatRupiah,
  formatTimeShort,
  getCurrentPeriodString,
  getTodayDateString,
} from '../utils/geoAndPayroll';

interface HRDAnalyticsDashboardProps {
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  branches: Branch[];
  employees: Employee[];
  attendance: AttendanceRecord[];
  payrollRuns: PayrollRun[];
}

function extractHHMM(isoStr?: string): string {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function combineDateAndHHMMToIso(dateStr: string, hhmm: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const dt = new Date(y || 2026, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
  return dt.toISOString();
}

async function computeManualHash(seed: string): Promise<string> {
  try {
    const buf = await window.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(seed)
    );
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return `manual_${Date.now()}_0000000000000000`;
  }
}

export const HRDAnalyticsDashboard: React.FC<HRDAnalyticsDashboardProps> = ({
  isSuperAdmin = false,
  branches,
  employees,
  attendance,
  payrollRuns,
}) => {
  const [selectedPeriod, setSelectedPeriod] = useState(() => getCurrentPeriodString());
  const [selectedBranchId, setSelectedBranchId] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [previewRecord, setPreviewRecord] = useState<AttendanceRecord | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Super Admin Add / Edit Attendance Modal
  const [attModalOpen, setAttModalOpen] = useState(false);
  const [editingAtt, setEditingAtt] = useState<AttendanceRecord | null>(null);
  const [attForm, setAttForm] = useState({
    employeeId: '',
    branchId: '',
    date: getTodayDateString(),
    clockInHHMM: '08:30',
    clockOutHHMM: '17:30',
    status: 'tepat_waktu' as AttendanceStatus,
    lateMinutes: '0',
    overtimeMinutes: '0',
    faceVerified: true,
    faceConfidence: '98',
    notes: '',
  });
  const [savingAtt, setSavingAtt] = useState(false);
  const [confirmDeleteAttId, setConfirmDeleteAttId] = useState<string | null>(null);

  const periodRecords = useMemo(() => {
    return attendance
      .filter((r) => {
        if (!r.date.startsWith(selectedPeriod)) return false;
        if (selectedBranchId !== 'all' && r.branchId !== selectedBranchId) return false;
        if (statusFilter !== 'all' && r.status !== statusFilter) return false;
        if (
          searchQuery.trim() &&
          !r.employeeName.toLowerCase().includes(searchQuery.toLowerCase()) &&
          !r.branchName.toLowerCase().includes(searchQuery.toLowerCase())
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [attendance, selectedPeriod, selectedBranchId, statusFilter, searchQuery]);

  const kpis = useMemo(() => {
    const total = periodRecords.length;
    const onTime = periodRecords.filter((r) => r.status === 'tepat_waktu' || r.status === 'lembur').length;
    const lateCount = periodRecords.filter((r) => r.status === 'terlambat').length;
    const faceValid = periodRecords.filter((r) => r.faceVerified).length;
    const totalOvertimeHours =
      Math.round((periodRecords.reduce((acc, r) => acc + (r.overtimeMinutes || 0), 0) / 60) * 10) / 10;
    const totalPayroll = payrollRuns
      .filter(
        (p) =>
          p.period === selectedPeriod &&
          (selectedBranchId === 'all' || p.branchId === selectedBranchId)
      )
      .reduce((acc, p) => acc + p.netSalary, 0);

    return {
      total,
      punctualityRate: total > 0 ? Math.round((onTime / total) * 100) : 0,
      lateCount,
      faceComplianceRate: total > 0 ? Math.round((faceValid / total) * 100) : 0,
      totalOvertimeHours,
      totalPayroll,
    };
  }, [periodRecords, payrollRuns, selectedPeriod, selectedBranchId]);

  const dailyTrendData = useMemo(() => {
    const map = new Map<string, { tanggal: string; tepatWaktu: number; terlambat: number }>();
    const sorted = [...periodRecords].sort((a, b) => a.date.localeCompare(b.date));
    for (const r of sorted) {
      const label = r.date.slice(5);
      const cur = map.get(label) || { tanggal: label, tepatWaktu: 0, terlambat: 0 };
      if (r.status === 'terlambat') cur.terlambat += 1;
      else cur.tepatWaktu += 1;
      map.set(label, cur);
    }
    return Array.from(map.values());
  }, [periodRecords]);

  const branchPerformanceData = useMemo(() => {
    return branches.map((br) => {
      const recs = attendance.filter(
        (r) => r.date.startsWith(selectedPeriod) && r.branchId === br.id
      );
      const onTime = recs.filter((r) => r.status !== 'terlambat').length;
      const score = recs.length > 0 ? Math.round((onTime / recs.length) * 100) : 0;
      return {
        cabang: br.code,
        nama: br.name,
        ketepatan: score,
        hadir: recs.length,
      };
    });
  }, [branches, attendance, selectedPeriod]);

  // Monthly Automated Employee Summary Matrix
  const monthlyEmployeeSummary = useMemo(() => {
    const scopedEmployees = employees.filter(
      (e) => selectedBranchId === 'all' || e.branchId === selectedBranchId
    );
    return scopedEmployees.map((emp) => {
      const empRecs = attendance.filter(
        (r) => r.date.startsWith(selectedPeriod) && r.employeeId === emp.id
      );
      const onTimeDays = empRecs.filter((r) => r.status === 'tepat_waktu' || r.status === 'lembur').length;
      const lateDays = empRecs.filter((r) => r.status === 'terlambat').length;
      const lateMinutes = empRecs.reduce((acc, r) => acc + (r.lateMinutes || 0), 0);
      const overtimeHours =
        Math.round((empRecs.reduce((acc, r) => acc + (r.overtimeMinutes || 0), 0) / 60) * 10) / 10;
      const rate = empRecs.length > 0 ? Math.round((onTimeDays / empRecs.length) * 100) : 0;
      const branch = branches.find((b) => b.id === emp.branchId);

      return {
        employee: emp,
        branchName: branch?.code || emp.branchId,
        presentDays: empRecs.length,
        onTimeDays,
        lateDays,
        lateMinutes,
        overtimeHours,
        disciplineScore: rate,
      };
    });
  }, [employees, attendance, branches, selectedPeriod, selectedBranchId]);

  const openAddAttendanceModal = () => {
    const defaultEmp = employees[0];
    setFeedback(null);
    setEditingAtt(null);
    setAttForm({
      employeeId: defaultEmp?.id || '',
      branchId: defaultEmp?.branchId || branches[0]?.id || '',
      date: getTodayDateString(),
      clockInHHMM: '08:30',
      clockOutHHMM: '17:30',
      status: 'tepat_waktu',
      lateMinutes: '0',
      overtimeMinutes: '0',
      faceVerified: true,
      faceConfidence: '98',
      notes: 'Input manual oleh Super Admin',
    });
    setAttModalOpen(true);
  };

  const openEditAttendanceModal = (rec: AttendanceRecord) => {
    setFeedback(null);
    setEditingAtt(rec);
    setAttForm({
      employeeId: rec.employeeId,
      branchId: rec.branchId,
      date: rec.date,
      clockInHHMM: extractHHMM(rec.clockInTime) || '08:30',
      clockOutHHMM: extractHHMM(rec.clockOutTime),
      status: rec.status,
      lateMinutes: String(rec.lateMinutes ?? 0),
      overtimeMinutes: String(rec.overtimeMinutes ?? 0),
      faceVerified: rec.faceVerified,
      faceConfidence: String(rec.faceConfidence ?? 95),
      notes: rec.notes || '',
    });
    setAttModalOpen(true);
  };

  const handleSaveAttendanceModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin) return;
    const emp = employees.find((item) => item.id === attForm.employeeId);
    const branch = branches.find((b) => b.id === attForm.branchId);
    if (!editingAtt && !emp) {
      setFeedback({ type: 'err', text: 'Pilih karyawan terlebih dahulu.' });
      return;
    }
    if (!branch) {
      setFeedback({ type: 'err', text: 'Pilih cabang kantor yang valid.' });
      return;
    }
    const clockInIso = combineDateAndHHMMToIso(attForm.date, attForm.clockInHHMM || '08:30');
    const hasOut = Boolean(attForm.clockOutHHMM.trim());
    const clockOutIso = hasOut ? combineDateAndHHMMToIso(attForm.date, attForm.clockOutHHMM) : '';
    const lateMins = Math.max(0, Math.min(1440, Math.round(Number(attForm.lateMinutes) || 0)));
    const otMins = Math.max(0, Math.min(1440, Math.round(Number(attForm.overtimeMinutes) || 0)));
    const confidence = Math.max(0, Math.min(100, Math.round(Number(attForm.faceConfidence) || 0)));
    const cleanNotes = attForm.notes.trim().slice(0, 240);

    setSavingAtt(true);
    setFeedback(null);
    try {
      if (editingAtt) {
        await updateDoc(doc(db, 'attendance', editingAtt.id), {
          branchId: branch.id,
          branchName: branch.name,
          date: attForm.date,
          clockInTime: clockInIso,
          clockOutTime: clockOutIso,
          status: attForm.status,
          lateMinutes: lateMins,
          overtimeMinutes: otMins,
          faceVerified: attForm.faceVerified,
          faceConfidence: confidence,
          notes: cleanNotes,
          updatedAt: serverTimestamp(),
        });
        setFeedback({
          type: 'ok',
          text: `Catatan absensi ${editingAtt.employeeName} (${attForm.date}) berhasil diperbarui.`,
        });
      } else if (emp) {
        const attId = `att_${Date.now()}`;
        const digest = await computeManualHash(`${attId}_${emp.id}_${attForm.date}`);
        await setDoc(doc(db, 'attendance', attId), {
          id: attId,
          userId: emp.uid,
          employeeId: emp.id,
          employeeName: emp.fullName,
          branchId: branch.id,
          branchName: branch.name,
          date: attForm.date,
          clockInTime: clockInIso,
          ...(hasOut
            ? {
                clockOutTime: clockOutIso,
                clockOutLat: branch.latitude,
                clockOutLng: branch.longitude,
                clockOutDistanceMeters: 0,
              }
            : {}),
          clockInLat: branch.latitude,
          clockInLng: branch.longitude,
          clockInDistanceMeters: 0,
          faceVerified: attForm.faceVerified,
          faceConfidence: confidence,
          faceHash: digest,
          status: attForm.status,
          lateMinutes: lateMins,
          overtimeMinutes: otMins,
          notes: cleanNotes,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        setFeedback({
          type: 'ok',
          text: `Absensi manual untuk ${emp.fullName} (${attForm.date}) berhasil ditambahkan.`,
        });
      }
      setAttModalOpen(false);
    } catch (err) {
      handleFirestoreError(
        err,
        editingAtt ? OperationType.UPDATE : OperationType.CREATE,
        'attendance'
      );
    } finally {
      setSavingAtt(false);
    }
  };

  const handleDeleteAttendance = async (rec: AttendanceRecord) => {
    if (!isSuperAdmin) return;
    try {
      await deleteDoc(doc(db, 'attendance', rec.id));
      setConfirmDeleteAttId(null);
      setFeedback({
        type: 'ok',
        text: `Log absensi ${rec.employeeName} (${rec.date}) telah dihapus.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `attendance/${rec.id}`);
    }
  };

  const handleExportMonthlyCSV = () => {
    downloadCSV(
      `laporan-kehadiran-bulanan-${selectedPeriod}.csv`,
      [
        'Kode Karyawan',
        'Nama Lengkap',
        'Cabang',
        'Departemen',
        'Hari Hadir',
        'Tepat Waktu',
        'Terlambat (Hari)',
        'Total Menit Terlambat',
        'Total Lembur (Jam)',
        'Skor Kedisiplinan (%)',
      ],
      monthlyEmployeeSummary.map((row) => [
        row.employee.employeeCode,
        row.employee.fullName,
        row.branchName,
        row.employee.department,
        row.presentDays,
        row.onTimeDays,
        row.lateDays,
        row.lateMinutes,
        row.overtimeHours,
        row.disciplineScore,
      ])
    );
  };

  return (
    <div className="space-y-6 pb-20 lg:pb-6">
      {/* Header & Filter Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium text-slate-500">
            Analitik HRD & Manajemen · Sinkronisasi Multi-Cabang Real-time
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
            Dasbor Performa & Laporan Kehadiran
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="month"
            aria-label="Pilih periode bulan"
            value={selectedPeriod}
            onChange={(e) => setSelectedPeriod(e.target.value)}
            className="min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-900"
          />
          <select
            aria-label="Filter cabang"
            value={selectedBranchId}
            onChange={(e) => setSelectedBranchId(e.target.value)}
            className="min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-900"
          >
            <option value="all">Semua Cabang ({branches.length})</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.city}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleExportMonthlyCSV}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <Download className="h-3.5 w-3.5" />
            Unduh Laporan CSV
          </button>
        </div>
      </div>

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

      {/* 4-Column KPI Summary Strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs text-slate-500">Total Log Kehadiran ({selectedPeriod})</p>
          <p className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {kpis.total}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {employees.length} karyawan aktif terdaftar
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs text-slate-500">Tingkat Ketepatan Waktu</p>
          <p className="mt-2 font-mono text-2xl font-bold text-emerald-700 tabular-nums">
            {kpis.punctualityRate}%
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {kpis.lateCount} catatan keterlambatan
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs text-slate-500">Validasi Foto Wajah & Lembur</p>
          <p className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {kpis.faceComplianceRate}%
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Total lembur terhitung {kpis.totalOvertimeHours} jam
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs text-slate-500">Estimasi Payroll Tersinkron</p>
          <p className="mt-2 font-mono text-xl font-bold text-slate-900 tabular-nums sm:text-2xl">
            {kpis.totalPayroll > 0 ? formatRupiah(kpis.totalPayroll) : 'Belum Disinkron'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Sinkronisasi via modul Penggajian
          </p>
        </div>
      </div>

      {/* Analytics Charts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-7">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-slate-900">
              Tren Kedisiplinan Harian ({selectedPeriod})
            </h2>
            <p className="text-xs text-slate-500">
              Perbandingan kehadiran tepat waktu terhadap keterlambatan harian.
            </p>
          </div>
          <div className="h-64 w-full">
            {dailyTrendData.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-200 text-xs text-slate-500">
                Belum ada data grafik untuk periode {selectedPeriod}.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailyTrendData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="tanggal" tick={{ fontSize: 11, fill: '#64748b' }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: '8px',
                      border: '1px solid #e2e8f0',
                      fontSize: '12px',
                    }}
                  />
                  <Bar dataKey="tepatWaktu" name="Tepat Waktu" fill="#059669" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="terlambat" name="Terlambat" fill="#d97706" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-5">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-slate-900">
              Performa Ketepatan Waktu per Cabang
            </h2>
            <p className="text-xs text-slate-500">
              Persentase kehadiran tepat waktu lintas lokasi perusahaan.
            </p>
          </div>
          <div className="h-64 w-full">
            {branchPerformanceData.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-200 text-xs text-slate-500">
                Belum ada cabang terdaftar.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={branchPerformanceData}
                  layout="vertical"
                  margin={{ top: 8, right: 16, left: 10, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: '#64748b' }} />
                  <YAxis dataKey="cabang" type="category" tick={{ fontSize: 11, fill: '#0f172a' }} />
                  <Tooltip
                    formatter={(value) => [`${value}%`, 'Ketepatan Waktu']}
                    contentStyle={{
                      borderRadius: '8px',
                      border: '1px solid #e2e8f0',
                      fontSize: '12px',
                    }}
                  />
                  <Bar dataKey="ketepatan" fill="#0f172a" radius={[0, 4, 4, 0]} barSize={22} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>
      </div>

      {/* Monthly Automated Performance Summary Table */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Laporan Kehadiran Otomatis Per Bulan ({selectedPeriod})
            </h2>
            <p className="text-xs text-slate-500">
              Akumulasi otomatis jam hadir, keterlambatan, dan lembur untuk transparansi kinerja & penggajian.
            </p>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2.5 pr-4 font-medium">Karyawan</th>
                <th className="py-2.5 px-3 font-medium">Cabang</th>
                <th className="py-2.5 px-3 text-right font-medium">Hari Hadir</th>
                <th className="py-2.5 px-3 text-right font-medium">Tepat Waktu</th>
                <th className="py-2.5 px-3 text-right font-medium">Terlambat</th>
                <th className="py-2.5 px-3 text-right font-medium">Lembur</th>
                <th className="py-2.5 pl-3 text-right font-medium">Skor Disiplin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {monthlyEmployeeSummary.map((row) => (
                <tr key={row.employee.id} className="hover:bg-slate-50">
                  <td className="py-3 pr-4">
                    <div className="font-medium text-slate-900">{row.employee.fullName}</div>
                    <div className="text-[11px] text-slate-500">
                      {row.employee.employeeCode} · {row.employee.position}
                    </div>
                  </td>
                  <td className="py-3 px-3 text-slate-700">{row.branchName}</td>
                  <td className="py-3 px-3 text-right font-mono text-slate-900 tabular-nums">
                    {row.presentDays} hr
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-emerald-700 tabular-nums">
                    {row.onTimeDays} hr
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-amber-700 tabular-nums">
                    {row.lateDays}x ({row.lateMinutes}m)
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-slate-900 tabular-nums">
                    {row.overtimeHours} jam
                  </td>
                  <td className="py-3 pl-3 text-right font-mono font-semibold text-slate-900 tabular-nums">
                    {row.disciplineScore}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Detailed Real-time Attendance Audit Log */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Log Audit Real-time GPS & Biometrik Wajah
            </h2>
            <p className="text-xs text-slate-500">
              Menampilkan jarak koordinat GPS aktual serta bukti verifikasi wajah setiap karyawan.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isSuperAdmin && (
              <button
                type="button"
                onClick={openAddAttendanceModal}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
                Tambah Absensi Manual
              </button>
            )}
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Cari karyawan atau cabang..."
                className="min-h-[38px] rounded-lg border border-slate-200 pl-8 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
              {[
                { key: 'all', label: 'Semua' },
                { key: 'tepat_waktu', label: 'Tepat Waktu' },
                { key: 'terlambat', label: 'Terlambat' },
                { key: 'lembur', label: 'Lembur' },
              ].map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setStatusFilter(tab.key)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    statusFilter === tab.key
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2.5 pr-3 font-medium">Tanggal</th>
                <th className="py-2.5 px-3 font-medium">Karyawan</th>
                <th className="py-2.5 px-3 font-medium">Cabang</th>
                <th className="py-2.5 px-3 font-medium">Masuk / Pulang</th>
                <th className="py-2.5 px-3 text-right font-medium">Jarak GPS</th>
                <th className="py-2.5 px-3 text-right font-medium">Wajah</th>
                <th className="py-2.5 pl-3 text-right font-medium">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {periodRecords.map((rec) => (
                <tr key={rec.id} className="hover:bg-slate-50">
                  <td className="py-2.5 pr-3 font-mono text-slate-900 tabular-nums">{rec.date}</td>
                  <td className="py-2.5 px-3 font-medium text-slate-900">{rec.employeeName}</td>
                  <td className="py-2.5 px-3 text-slate-600">{rec.branchName}</td>
                  <td className="py-2.5 px-3 font-mono text-slate-900 tabular-nums">
                    {formatTimeShort(rec.clockInTime)} –{' '}
                    {rec.clockOutTime ? formatTimeShort(rec.clockOutTime) : 'Aktif'}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono text-slate-700 tabular-nums">
                    {rec.clockInDistanceMeters}m
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono text-emerald-700 tabular-nums">
                    {rec.faceVerified ? `${rec.faceConfidence}%` : 'Ditolak'}
                  </td>
                  <td className="py-2.5 pl-3 text-right">
                    <div className="inline-flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setPreviewRecord(rec)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 hover:text-emerald-700 cursor-pointer"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        Audit
                      </button>
                      {isSuperAdmin && (
                        <>
                          <button
                            type="button"
                            onClick={() => openEditAttendanceModal(rec)}
                            className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                          >
                            <Pencil className="h-3 w-3 text-emerald-600" />
                            Edit
                          </button>
                          {confirmDeleteAttId === rec.id ? (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => void handleDeleteAttendance(rec)}
                                className="rounded bg-rose-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-rose-700 cursor-pointer"
                              >
                                Hapus
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteAttId(null)}
                                className="rounded border border-slate-200 px-1.5 py-1 text-[11px] text-slate-600 cursor-pointer"
                              >
                                Batal
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteAttId(rec.id)}
                              className="inline-flex items-center justify-center rounded border border-rose-200 p-1 text-rose-600 hover:bg-rose-50 cursor-pointer"
                              title="Hapus log absensi"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Audit Detail Modal */}
      {previewRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                Audit Verifikasi Kehadiran
              </h3>
              <button
                type="button"
                onClick={() => setPreviewRecord(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer"
                aria-label="Tutup audit"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3 text-xs">
              {previewRecord.faceThumbnail && (
                <img
                  src={previewRecord.faceThumbnail}
                  alt={`Foto absen ${previewRecord.employeeName}`}
                  referrerPolicy="no-referrer"
                  className="h-44 w-full rounded-lg border border-slate-200 object-cover scale-x-[-1]"
                />
              )}
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-2">
                <div className="flex justify-between">
                  <span className="text-slate-500">Karyawan</span>
                  <span className="font-medium text-slate-900">{previewRecord.employeeName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Koordinat Masuk</span>
                  <span className="font-mono text-slate-900 tabular-nums">
                    {previewRecord.clockInLat.toFixed(5)}, {previewRecord.clockInLng.toFixed(5)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Jarak Geofence</span>
                  <span className="font-mono text-slate-900 tabular-nums">
                    {previewRecord.clockInDistanceMeters} meter
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Skor Validasi Wajah</span>
                  <span className="font-mono text-emerald-700 tabular-nums">
                    {previewRecord.faceConfidence}%
                  </span>
                </div>
                <div>
                  <span className="block text-slate-500">SHA-256 Digest Biometrik</span>
                  <span className="mt-0.5 block break-all font-mono text-[11px] text-slate-700">
                    {previewRecord.faceHash}
                  </span>
                </div>
                {previewRecord.notes && (
                  <div>
                    <span className="block text-slate-500">Catatan</span>
                    <span className="text-slate-900">{previewRecord.notes}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Modal Tambah / Edit Absensi (Super Admin) */}
      {attModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">
                {editingAtt
                  ? `Edit Absensi: ${editingAtt.employeeName}`
                  : 'Tambah Absensi Karyawan Manual'}
              </h3>
              <button
                type="button"
                onClick={() => setAttModalOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveAttendanceModal} className="space-y-3 text-xs">
              {!editingAtt && (
                <div>
                  <label className="block font-medium text-slate-700">Karyawan</label>
                  <select
                    required
                    value={attForm.employeeId}
                    onChange={(e) => {
                      const emp = employees.find((item) => item.id === e.target.value);
                      setAttForm((p) => ({
                        ...p,
                        employeeId: e.target.value,
                        branchId: emp?.branchId || p.branchId,
                      }));
                    }}
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 text-slate-900"
                  >
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.employeeCode} — {emp.fullName}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block font-medium text-slate-700">Cabang</label>
                  <select
                    required
                    value={attForm.branchId}
                    onChange={(e) => setAttForm((p) => ({ ...p, branchId: e.target.value }))}
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 text-slate-900"
                  >
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.code} — {b.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Tanggal</label>
                  <input
                    type="date"
                    required
                    value={attForm.date}
                    onChange={(e) => setAttForm((p) => ({ ...p, date: e.target.value }))}
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-3 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block font-medium text-slate-700">Jam Masuk</label>
                  <input
                    type="time"
                    required
                    value={attForm.clockInHHMM}
                    onChange={(e) => setAttForm((p) => ({ ...p, clockInHHMM: e.target.value }))}
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Jam Pulang</label>
                  <input
                    type="time"
                    value={attForm.clockOutHHMM}
                    onChange={(e) => setAttForm((p) => ({ ...p, clockOutHHMM: e.target.value }))}
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Status</label>
                  <select
                    value={attForm.status}
                    onChange={(e) =>
                      setAttForm((p) => ({ ...p, status: e.target.value as AttendanceStatus }))
                    }
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 bg-white px-2"
                  >
                    <option value="tepat_waktu">Tepat Waktu</option>
                    <option value="terlambat">Terlambat</option>
                    <option value="lembur">Lembur</option>
                    <option value="izin">Izin</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block font-medium text-slate-700">Telat (Menit)</label>
                  <input
                    type="number"
                    min={0}
                    max={1440}
                    required
                    value={attForm.lateMinutes}
                    onChange={(e) => setAttForm((p) => ({ ...p, lateMinutes: e.target.value }))}
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Lembur (Menit)</label>
                  <input
                    type="number"
                    min={0}
                    max={1440}
                    required
                    value={attForm.overtimeMinutes}
                    onChange={(e) =>
                      setAttForm((p) => ({ ...p, overtimeMinutes: e.target.value }))
                    }
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Skor Wajah (%)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    required
                    value={attForm.faceConfidence}
                    onChange={(e) =>
                      setAttForm((p) => ({ ...p, faceConfidence: e.target.value }))
                    }
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block font-medium text-slate-700">Catatan Audit</label>
                <input
                  type="text"
                  maxLength={240}
                  value={attForm.notes}
                  onChange={(e) => setAttForm((p) => ({ ...p, notes: e.target.value }))}
                  className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-3"
                />
              </div>

              <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={attForm.faceVerified}
                  onChange={(e) =>
                    setAttForm((p) => ({ ...p, faceVerified: e.target.checked }))
                  }
                  className="h-4 w-4 accent-emerald-600"
                />
                <span className="font-medium text-slate-800">Tandai Verifikasi Wajah Valid</span>
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setAttModalOpen(false)}
                  className="min-h-[40px] rounded-lg border border-slate-200 px-4 font-medium text-slate-700 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingAtt}
                  className="min-h-[40px] rounded-lg bg-emerald-600 px-4 font-semibold text-white hover:bg-emerald-700 cursor-pointer"
                >
                  {savingAtt ? 'Menyimpan...' : 'Simpan Absensi'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

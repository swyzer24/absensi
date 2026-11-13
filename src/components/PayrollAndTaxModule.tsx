import React, { useMemo, useState } from 'react';
import {
  Calculator,
  CheckCircle2,
  Download,
  FileCheck2,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  AlertTriangle,
  Code2,
  X,
} from 'lucide-react';
import { deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  AttendanceRecord,
  Branch,
  Employee,
  PayrollRun,
  PayrollStatus,
  TaxFiling,
  TaxFilingStatus,
} from '../types';
import {
  calculatePPh21TER,
  computeMonthlyPayrollForEmployee,
  downloadCSV,
  formatRupiah,
  getCurrentPeriodString,
} from '../utils/geoAndPayroll';

interface PayrollAndTaxModuleProps {
  currentUserUid: string;
  isAdmin: boolean;
  isSuperAdmin?: boolean;
  branches: Branch[];
  employees: Employee[];
  attendance: AttendanceRecord[];
  payrollRuns: PayrollRun[];
  taxFilings: TaxFiling[];
}

export const PayrollAndTaxModule: React.FC<PayrollAndTaxModuleProps> = ({
  currentUserUid,
  isAdmin,
  isSuperAdmin = false,
  branches,
  employees,
  attendance,
  payrollRuns,
  taxFilings,
}) => {
  const [selectedPeriod, setSelectedPeriod] = useState(() => getCurrentPeriodString());
  const [selectedBranchId, setSelectedBranchId] = useState<string>('all');
  const [syncingPayroll, setSyncingPayroll] = useState(false);

  // Tax API integration state
  const [taxProvider, setTaxProvider] = useState('DJP-eBupot-v2');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [syncingTax, setSyncingTax] = useState(false);
  const [lastBatchPayload, setLastBatchPayload] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Super Admin Add / Edit Payroll Run Modal
  const [payrollModalOpen, setPayrollModalOpen] = useState(false);
  const [editingPayroll, setEditingPayroll] = useState<PayrollRun | null>(null);
  const [payForm, setPayForm] = useState({
    employeeId: '',
    branchId: '',
    period: getCurrentPeriodString(),
    presentDays: '22',
    lateMinutesTotal: '0',
    overtimeHours: '0',
    baseSalary: '0',
    allowances: '0',
    overtimePay: '0',
    lateDeduction: '0',
    bpjsDeduction: '0',
    grossIncome: '0',
    pph21Rate: '0',
    pph21Amount: '0',
    netSalary: '0',
    status: 'draft' as PayrollStatus,
    taxReported: false,
  });
  const [savingPayModal, setSavingPayModal] = useState(false);
  const [confirmDeletePayId, setConfirmDeletePayId] = useState<string | null>(null);
  const [confirmDeleteTaxId, setConfirmDeleteTaxId] = useState<string | null>(null);

  const scopedPayrolls = useMemo(() => {
    return payrollRuns.filter(
      (p) =>
        p.period === selectedPeriod &&
        (selectedBranchId === 'all' || p.branchId === selectedBranchId)
    );
  }, [payrollRuns, selectedPeriod, selectedBranchId]);

  const totals = useMemo(() => {
    return scopedPayrolls.reduce(
      (acc, p) => {
        acc.gross += p.grossIncome;
        acc.pph21 += p.pph21Amount;
        acc.bpjs += p.bpjsDeduction;
        acc.net += p.netSalary;
        return acc;
      },
      { gross: 0, pph21: 0, bpjs: 0, net: 0 }
    );
  }, [scopedPayrolls]);

  const handleSyncPayrollFromAttendance = async () => {
    if (!isAdmin) return;
    setSyncingPayroll(true);
    setFeedback(null);
    try {
      const targetEmployees = employees.filter(
        (e) => selectedBranchId === 'all' || e.branchId === selectedBranchId
      );

      for (const emp of targetEmployees) {
        const empAtt = attendance.filter(
          (a) => a.date.startsWith(selectedPeriod) && a.employeeId === emp.id
        );
        const calc = computeMonthlyPayrollForEmployee(emp, empAtt);
        const payrollId = `pay_${selectedPeriod.replace('-', '')}_${emp.id}`;
        const existing = payrollRuns.find((p) => p.id === payrollId);

        if (existing && existing.status === 'dibayarkan') {
          continue;
        }

        await setDoc(doc(db, 'payrollRuns', payrollId), {
          id: payrollId,
          period: selectedPeriod,
          employeeId: emp.id,
          employeeName: emp.fullName,
          userId: emp.uid,
          branchId: emp.branchId,
          ...calc,
          status: existing?.status || 'draft',
          taxReported: existing?.taxReported || false,
          createdAt: existing?.createdAt || serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      setFeedback({
        type: 'ok',
        text: `Penggajian periode ${selectedPeriod} untuk ${targetEmployees.length} karyawan berhasil disinkronkan dari log absensi.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'payrollRuns');
    } finally {
      setSyncingPayroll(false);
    }
  };

  const handleAdvanceStatus = async (run: PayrollRun, nextStatus: 'disetujui' | 'dibayarkan') => {
    if (!isAdmin) return;
    try {
      await updateDoc(doc(db, 'payrollRuns', run.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `payrollRuns/${run.id}`);
    }
  };

  const prefillPayFormForEmployee = (emp: Employee, period: string) => {
    const empAtt = attendance.filter((a) => a.date.startsWith(period) && a.employeeId === emp.id);
    const calc = computeMonthlyPayrollForEmployee(emp, empAtt);
    setPayForm({
      employeeId: emp.id,
      branchId: emp.branchId,
      period,
      presentDays: String(calc.presentDays),
      lateMinutesTotal: String(calc.lateMinutesTotal),
      overtimeHours: String(calc.overtimeHours),
      baseSalary: String(calc.baseSalary),
      allowances: String(calc.allowances),
      overtimePay: String(calc.overtimePay),
      lateDeduction: String(calc.lateDeduction),
      bpjsDeduction: String(calc.bpjsDeduction),
      grossIncome: String(calc.grossIncome),
      pph21Rate: String(calc.pph21Rate),
      pph21Amount: String(calc.pph21Amount),
      netSalary: String(calc.netSalary),
      status: 'draft',
      taxReported: false,
    });
  };

  const openAddPayrollModal = () => {
    const defaultEmp = employees[0];
    setFeedback(null);
    setEditingPayroll(null);
    if (defaultEmp) {
      prefillPayFormForEmployee(defaultEmp, selectedPeriod);
    } else {
      setPayForm((p) => ({
        ...p,
        employeeId: '',
        branchId: branches[0]?.id || '',
        period: selectedPeriod,
      }));
    }
    setPayrollModalOpen(true);
  };

  const openEditPayrollModal = (run: PayrollRun) => {
    setFeedback(null);
    setEditingPayroll(run);
    setPayForm({
      employeeId: run.employeeId,
      branchId: run.branchId,
      period: run.period,
      presentDays: String(run.presentDays),
      lateMinutesTotal: String(run.lateMinutesTotal),
      overtimeHours: String(run.overtimeHours),
      baseSalary: String(run.baseSalary),
      allowances: String(run.allowances),
      overtimePay: String(run.overtimePay),
      lateDeduction: String(run.lateDeduction),
      bpjsDeduction: String(run.bpjsDeduction),
      grossIncome: String(run.grossIncome),
      pph21Rate: String(run.pph21Rate),
      pph21Amount: String(run.pph21Amount),
      netSalary: String(run.netSalary),
      status: run.status,
      taxReported: run.taxReported,
    });
    setPayrollModalOpen(true);
  };

  const handleRecalculatePayForm = () => {
    const emp = employees.find((e) => e.id === payForm.employeeId);
    const base = Math.max(0, Number(payForm.baseSalary) || 0);
    const allow = Math.max(0, Number(payForm.allowances) || 0);
    const otPay = Math.max(0, Number(payForm.overtimePay) || 0);
    const lateDed = Math.max(0, Number(payForm.lateDeduction) || 0);
    const bpjsDed = Math.max(0, Number(payForm.bpjsDeduction) || 0);
    const gross = Math.max(0, base + allow + otPay - lateDed);
    const { ratePercent, taxAmount } = calculatePPh21TER(gross, emp?.ptkpStatus || 'TK/0');
    const net = Math.max(0, gross - bpjsDed - taxAmount);
    setPayForm((p) => ({
      ...p,
      grossIncome: String(gross),
      pph21Rate: String(ratePercent),
      pph21Amount: String(taxAmount),
      netSalary: String(net),
    }));
  };

  const handleSavePayrollModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin) return;
    const emp = employees.find((item) => item.id === payForm.employeeId);
    if (!editingPayroll && !emp) {
      setFeedback({ type: 'err', text: 'Pilih karyawan terlebih dahulu.' });
      return;
    }

    const presentDays = Math.max(0, Math.min(31, Math.round(Number(payForm.presentDays) || 0)));
    const lateMinutesTotal = Math.max(
      0,
      Math.min(20000, Math.round(Number(payForm.lateMinutesTotal) || 0))
    );
    const overtimeHours = Math.max(0, Math.min(300, Number(payForm.overtimeHours) || 0));
    const baseSalary = Math.max(0, Math.round(Number(payForm.baseSalary) || 0));
    const allowances = Math.max(0, Math.round(Number(payForm.allowances) || 0));
    const overtimePay = Math.max(0, Math.round(Number(payForm.overtimePay) || 0));
    const lateDeduction = Math.max(0, Math.round(Number(payForm.lateDeduction) || 0));
    const bpjsDeduction = Math.max(0, Math.round(Number(payForm.bpjsDeduction) || 0));
    const grossIncome = Math.max(0, Math.round(Number(payForm.grossIncome) || 0));
    const pph21Rate = Math.max(0, Math.min(50, Number(payForm.pph21Rate) || 0));
    const pph21Amount = Math.max(0, Math.round(Number(payForm.pph21Amount) || 0));
    const netSalary = Math.max(0, Math.round(Number(payForm.netSalary) || 0));

    setSavingPayModal(true);
    setFeedback(null);
    try {
      if (editingPayroll) {
        await updateDoc(doc(db, 'payrollRuns', editingPayroll.id), {
          branchId: payForm.branchId || editingPayroll.branchId,
          presentDays,
          lateMinutesTotal,
          overtimeHours,
          baseSalary,
          allowances,
          overtimePay,
          lateDeduction,
          bpjsDeduction,
          grossIncome,
          pph21Rate,
          pph21Amount,
          netSalary,
          status: payForm.status,
          taxReported: payForm.taxReported,
          updatedAt: serverTimestamp(),
        });
        setFeedback({
          type: 'ok',
          text: `Slip gaji ${editingPayroll.employeeName} (${editingPayroll.period}) berhasil diperbarui.`,
        });
      } else if (emp) {
        const defaultId = `pay_${payForm.period.replace('-', '')}_${emp.id}`;
        const alreadyExists = payrollRuns.some((r) => r.id === defaultId);
        const payrollId = alreadyExists
          ? `${defaultId}_${Date.now().toString().slice(-4)}`
          : defaultId;
        await setDoc(doc(db, 'payrollRuns', payrollId), {
          id: payrollId,
          period: payForm.period,
          employeeId: emp.id,
          employeeName: emp.fullName,
          userId: emp.uid,
          branchId: payForm.branchId || emp.branchId,
          presentDays,
          lateMinutesTotal,
          overtimeHours,
          baseSalary,
          allowances,
          overtimePay,
          lateDeduction,
          bpjsDeduction,
          grossIncome,
          pph21Rate,
          pph21Amount,
          netSalary,
          status: payForm.status,
          taxReported: payForm.taxReported,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        setFeedback({
          type: 'ok',
          text: `Slip gaji manual untuk ${emp.fullName} periode ${payForm.period} berhasil dibuat.`,
        });
      }
      setPayrollModalOpen(false);
    } catch (err) {
      handleFirestoreError(
        err,
        editingPayroll ? OperationType.UPDATE : OperationType.CREATE,
        'payrollRuns'
      );
    } finally {
      setSavingPayModal(false);
    }
  };

  const handleDeletePayroll = async (run: PayrollRun) => {
    if (!isSuperAdmin) return;
    try {
      await deleteDoc(doc(db, 'payrollRuns', run.id));
      setConfirmDeletePayId(null);
      setFeedback({
        type: 'ok',
        text: `Slip gaji ${run.employeeName} (${run.period}) telah dihapus.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `payrollRuns/${run.id}`);
    }
  };

  const handleUpdateTaxFilingStatus = async (tf: TaxFiling, status: TaxFilingStatus) => {
    if (!isSuperAdmin) return;
    try {
      await updateDoc(doc(db, 'taxFilings', tf.id), { status });
      setFeedback({
        type: 'ok',
        text: `Status BPE ${tf.receiptNumber} diperbarui menjadi ${status}.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `taxFilings/${tf.id}`);
    }
  };

  const handleDeleteTaxFiling = async (tf: TaxFiling) => {
    if (!isSuperAdmin) return;
    try {
      await deleteDoc(doc(db, 'taxFilings', tf.id));
      setConfirmDeleteTaxId(null);
      setFeedback({
        type: 'ok',
        text: `Riwayat BPE pajak ${tf.receiptNumber} dihapus.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `taxFilings/${tf.id}`);
    }
  };

  const handleSyncTaxAPI = async () => {
    if (!isAdmin || scopedPayrolls.length === 0) {
      setFeedback({
        type: 'err',
        text: 'Sinkronkan data penggajian terlebih dahulu sebelum melaporkan PPh 21.',
      });
      return;
    }

    setSyncingTax(true);
    setFeedback(null);
    try {
      const empMap = new Map(employees.map((e) => [e.id, e]));
      const response = await fetch('/api/tax/sync-ebupot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period: selectedPeriod,
          branchId: selectedBranchId,
          provider: taxProvider,
          webhookUrl: webhookUrl.trim() || undefined,
          records: scopedPayrolls.map((p) => ({
            employeeId: p.employeeId,
            employeeName: p.employeeName,
            ptkpStatus: empMap.get(p.employeeId)?.ptkpStatus || 'TK/0',
            grossIncome: p.grossIncome,
            pph21Rate: p.pph21Rate,
            pph21Amount: p.pph21Amount,
          })),
        }),
      });

      const result = (await response.json()) as {
        success: boolean;
        receiptNumber: string;
        payloadSignature: string;
        provider: string;
        status: 'tervalidasi' | 'terkirim' | 'gagal';
        totalEmployees: number;
        totalGrossIncome: number;
        totalPph21: number;
        eBupotBatchPayload: unknown;
        webhookDelivery: string;
      };

      if (!result.success) {
        throw new Error('Konektor API Pajak mengembalikan kegagalan.');
      }

      const filingId = `tax_${selectedPeriod.replace('-', '')}_${Date.now()}`;
      await setDoc(doc(db, 'taxFilings', filingId), {
        id: filingId,
        period: selectedPeriod,
        branchId: selectedBranchId,
        provider: result.provider,
        totalEmployees: result.totalEmployees,
        totalGrossIncome: result.totalGrossIncome,
        totalPph21: result.totalPph21,
        receiptNumber: result.receiptNumber,
        payloadSignature: result.payloadSignature,
        status: result.status,
        syncedByUid: currentUserUid,
        createdAt: serverTimestamp(),
      });

      for (const run of scopedPayrolls) {
        await updateDoc(doc(db, 'payrollRuns', run.id), {
          taxReported: true,
          updatedAt: serverTimestamp(),
        });
      }

      setLastBatchPayload(JSON.stringify(result.eBupotBatchPayload, null, 2));
      setFeedback({
        type: 'ok',
        text: `Pelaporan SPT Masa PPh 21 berhasil dikirim ke ${result.provider}. Nomor BPE: ${result.receiptNumber} (${result.webhookDelivery}).`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Gagal menyinkronkan API pajak.',
      });
    } finally {
      setSyncingTax(false);
    }
  };

  const handleExportPayrollCSV = () => {
    downloadCSV(
      `rekap-payroll-pph21-${selectedPeriod}.csv`,
      [
        'Periode',
        'Karyawan',
        'Hadir (Hari)',
        'Terlambat (Menit)',
        'Lembur (Jam)',
        'Gaji Pokok',
        'Tunjangan',
        'Upah Lembur',
        'Potongan Telat',
        'BPJS Karyawan',
        'Bruto',
        'Tarif TER (%)',
        'PPh 21',
        'Gaji Bersih',
        'Status',
      ],
      scopedPayrolls.map((p) => [
        p.period,
        p.employeeName,
        p.presentDays,
        p.lateMinutesTotal,
        p.overtimeHours,
        p.baseSalary,
        p.allowances,
        p.overtimePay,
        p.lateDeduction,
        p.bpjsDeduction,
        p.grossIncome,
        p.pph21Rate,
        p.pph21Amount,
        p.netSalary,
        p.status,
      ])
    );
  };

  return (
    <div className="space-y-6 pb-20 lg:pb-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium text-slate-500">
            Penggajian Otomatis & Kepatuhan Pajak PPh 21 TER (PP 58/2023)
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
            Sinkronisasi Payroll & Pelaporan Pajak API
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="month"
            aria-label="Periode penggajian"
            value={selectedPeriod}
            onChange={(e) => setSelectedPeriod(e.target.value)}
            className="min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-900"
          />
          <select
            aria-label="Cabang penggajian"
            value={selectedBranchId}
            onChange={(e) => setSelectedBranchId(e.target.value)}
            className="min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-900"
          >
            <option value="all">Semua Cabang</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.city}
              </option>
            ))}
          </select>
          {isAdmin && (
            <button
              type="button"
              disabled={syncingPayroll}
              onClick={handleSyncPayrollFromAttendance}
              className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncingPayroll ? 'animate-spin' : ''}`} />
              {syncingPayroll ? 'Menghitung...' : 'Sinkronkan dari Absensi'}
            </button>
          )}
          {isSuperAdmin && (
            <button
              type="button"
              onClick={openAddPayrollModal}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              Tambah Slip Gaji
            </button>
          )}
          <button
            type="button"
            disabled={scopedPayrolls.length === 0}
            onClick={handleExportPayrollCSV}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
          >
            <Download className="h-3.5 w-3.5" />
            CSV Payroll
          </button>
        </div>
      </div>

      {feedback && (
        <div
          role="alert"
          className={`flex items-start gap-3 rounded-xl border p-4 text-sm ${
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

      {/* Summary Metrics */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs text-slate-500">Total Penghasilan Bruto</p>
          <p className="mt-2 font-mono text-xl font-bold text-slate-900 tabular-nums">
            {formatRupiah(totals.gross)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs text-slate-500">Total Potongan PPh 21 TER</p>
          <p className="mt-2 font-mono text-xl font-bold text-slate-900 tabular-nums">
            {formatRupiah(totals.pph21)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs text-slate-500">Total Iuran BPJS Karyawan</p>
          <p className="mt-2 font-mono text-xl font-bold text-slate-900 tabular-nums">
            {formatRupiah(totals.bpjs)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs text-slate-500">Total Gaji Bersih (Take-Home)</p>
          <p className="mt-2 font-mono text-xl font-bold text-emerald-700 tabular-nums">
            {formatRupiah(totals.net)}
          </p>
        </div>
      </div>

      {/* Payroll Ledger Table */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-slate-900">
            Rincian Penggajian Periode {selectedPeriod}
          </h2>
          <p className="text-xs text-slate-500">
            Tunjangan kehadiran, lembur, dan potongan keterlambatan dihitung otomatis dari log kehadiran tervalidasi.
          </p>
        </div>

        {scopedPayrolls.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 p-8 text-center space-y-3">
            <p className="text-sm text-slate-600">
              Belum ada rekapitulasi payroll untuk periode {selectedPeriod}.
            </p>
            {isAdmin && (
              <button
                type="button"
                onClick={handleSyncPayrollFromAttendance}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Hitung & Sinkronkan Sekarang
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2.5 pr-3 font-medium">Karyawan</th>
                  <th className="py-2.5 px-2 text-right font-medium">Hadir</th>
                  <th className="py-2.5 px-2 text-right font-medium">Gaji Pokok</th>
                  <th className="py-2.5 px-2 text-right font-medium">Tunj. & Lembur</th>
                  <th className="py-2.5 px-2 text-right font-medium">Pot. Telat</th>
                  <th className="py-2.5 px-2 text-right font-medium">PPh 21 TER</th>
                  <th className="py-2.5 px-2 text-right font-medium">Gaji Bersih</th>
                  <th className="py-2.5 pl-3 text-right font-medium">Status & Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {scopedPayrolls.map((run) => (
                  <tr key={run.id} className="hover:bg-slate-50">
                    <td className="py-3 pr-3">
                      <div className="font-medium text-slate-900">{run.employeeName}</div>
                      <div className="text-[11px] text-slate-500">
                        {run.taxReported ? 'SPT PPh 21 Terlapor' : 'Belum Lapor Pajak'}
                      </div>
                    </td>
                    <td className="py-3 px-2 text-right font-mono text-slate-900 tabular-nums">
                      {run.presentDays} hr
                    </td>
                    <td className="py-3 px-2 text-right font-mono text-slate-900 tabular-nums">
                      {formatRupiah(run.baseSalary)}
                    </td>
                    <td className="py-3 px-2 text-right font-mono text-emerald-700 tabular-nums">
                      +{formatRupiah(run.allowances + run.overtimePay)}
                    </td>
                    <td className="py-3 px-2 text-right font-mono text-amber-700 tabular-nums">
                      -{formatRupiah(run.lateDeduction)}
                    </td>
                    <td className="py-3 px-2 text-right font-mono text-slate-900 tabular-nums">
                      {formatRupiah(run.pph21Amount)} ({run.pph21Rate}%)
                    </td>
                    <td className="py-3 px-2 text-right font-mono font-semibold text-slate-900 tabular-nums">
                      {formatRupiah(run.netSalary)}
                    </td>
                    <td className="py-3 pl-3 text-right">
                      <div className="inline-flex items-center justify-end gap-2">
                        <span className="font-medium text-slate-700 capitalize">
                          {run.status}
                        </span>
                        {isAdmin && run.status === 'draft' && (
                          <button
                            type="button"
                            onClick={() => handleAdvanceStatus(run, 'disetujui')}
                            className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                          >
                            Setujui
                          </button>
                        )}
                        {isAdmin && run.status === 'disetujui' && (
                          <button
                            type="button"
                            onClick={() => handleAdvanceStatus(run, 'dibayarkan')}
                            className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-700 cursor-pointer"
                          >
                            Bayar
                          </button>
                        )}
                        {isSuperAdmin && (
                          <>
                            <button
                              type="button"
                              onClick={() => openEditPayrollModal(run)}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                              title="Edit rincian gaji, potongan, atau status slip"
                            >
                              <Pencil className="h-3 w-3 text-emerald-600" />
                              Edit
                            </button>
                            {confirmDeletePayId === run.id ? (
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => void handleDeletePayroll(run)}
                                  className="rounded-md bg-rose-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-rose-700 cursor-pointer"
                                >
                                  Hapus
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeletePayId(null)}
                                  className="rounded-md border border-slate-200 px-1.5 py-1 text-[11px] text-slate-600 cursor-pointer"
                                >
                                  Batal
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmDeletePayId(run.id)}
                                className="inline-flex items-center justify-center rounded-md border border-rose-200 p-1 text-rose-600 hover:bg-rose-50 cursor-pointer"
                                title="Hapus slip gaji"
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
        )}
      </section>

      {/* Third-Party Tax API Connector (e-Bupot PPh 21 / CoreTax) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Integrasi API Pelaporan Pajak Otomatis (e-Bupot 21)
              </h2>
              <p className="text-xs text-slate-500">
                Kirim SPT Masa PPh 21 bertanda tangan HMAC-SHA256 ke konektor DJP atau webhook sistem pajak eksternal.
              </p>
            </div>
            <FileCheck2 className="h-5 w-5 shrink-0 text-emerald-600" />
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Penyedia API Pajak Pihak Ketiga
              </label>
              <select
                value={taxProvider}
                onChange={(e) => setTaxProvider(e.target.value)}
                className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900"
              >
                <option value="DJP-eBupot-v2">DJP e-Bupot 21/26 Connector (TER PP 58/2023)</option>
                <option value="CoreTax-Gateway">CoreTax Enterprise API Gateway</option>
                <option value="Klikpajak-Mekari-Webhook">API Pihak Ketiga / Custom Webhook</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700">
                Endpoint Webhook Eksternal (Opsional)
              </label>
              <input
                type="url"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://api-pajak-perusahaan.example.com/v1/ebupot"
                className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900 placeholder:text-slate-400"
              />
            </div>

            {isAdmin && (
              <button
                type="button"
                disabled={syncingTax || scopedPayrolls.length === 0}
                onClick={handleSyncTaxAPI}
                className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-500 cursor-pointer"
              >
                <Send className="h-3.5 w-3.5" />
                {syncingTax
                  ? 'Mengirim Payload e-Bupot...'
                  : `Kirim & Laporkan PPh 21 (${formatRupiah(totals.pph21)})`}
              </button>
            )}
          </div>

          {lastBatchPayload && (
            <div className="rounded-lg border border-slate-200 bg-slate-900 p-3 text-slate-100">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-emerald-400">
                <Code2 className="h-3.5 w-3.5" />
                Payload JSON Terakhir yang Dikirim
              </div>
              <pre className="max-h-44 overflow-auto font-mono text-[11px] leading-relaxed">
                {lastBatchPayload}
              </pre>
            </div>
          )}
        </section>

        {/* Tax Filing Audit History */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-6">
          <h2 className="text-base font-semibold text-slate-900">
            Riwayat Bukti Penerimaan Elektronik (BPE) Pajak
          </h2>
          <p className="text-xs text-slate-500">
            Log transmisi SPT Masa PPh 21 yang tersimpan secara permanen di cloud.
          </p>

          {taxFilings.length === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">
              Belum ada pengiriman pelaporan pajak PPh 21 tercatat.
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {taxFilings.map((tf) => (
                <div
                  key={tf.id}
                  className="rounded-lg border border-slate-200 p-3.5 text-xs space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2 font-semibold text-slate-900">
                    <span className="font-mono">{tf.receiptNumber}</span>
                    {isSuperAdmin ? (
                      <div className="flex items-center gap-1.5">
                        <select
                          value={tf.status}
                          onChange={(e) =>
                            void handleUpdateTaxFilingStatus(tf, e.target.value as TaxFilingStatus)
                          }
                          className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-emerald-700"
                        >
                          <option value="tervalidasi">Tervalidasi</option>
                          <option value="terkirim">Terkirim</option>
                          <option value="gagal">Gagal</option>
                        </select>
                        {confirmDeleteTaxId === tf.id ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleDeleteTaxFiling(tf)}
                              className="rounded bg-rose-600 px-2 py-0.5 text-[10px] font-semibold text-white cursor-pointer"
                            >
                              Hapus
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteTaxId(null)}
                              className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 cursor-pointer"
                            >
                              Batal
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteTaxId(tf.id)}
                            className="rounded border border-rose-200 p-1 text-rose-600 hover:bg-rose-50 cursor-pointer"
                            title="Hapus riwayat BPE"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-emerald-700 capitalize">{tf.status}</span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-slate-600">
                    <span>Periode {tf.period}</span>
                    <span aria-hidden="true">·</span>
                    <span>{tf.provider}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">{tf.totalEmployees} karyawan</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono font-medium text-slate-900 tabular-nums">
                      PPh 21 {formatRupiah(tf.totalPph21)}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-slate-400 truncate">
                    HMAC-SHA256: {tf.payloadSignature}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Modal Tambah / Edit Slip Gaji (Super Admin) */}
      {payrollModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-xl space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold text-emerald-700">
                  Kontrol Penuh Super Admin · Penggajian & PPh 21
                </p>
                <h3 className="text-base font-bold text-slate-900">
                  {editingPayroll
                    ? `Edit Slip Gaji: ${editingPayroll.employeeName} (${editingPayroll.period})`
                    : 'Tambah Slip Gaji Manual'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setPayrollModalOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSavePayrollModal} className="space-y-3 text-xs">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {!editingPayroll && (
                  <div className="sm:col-span-2">
                    <label className="block font-medium text-slate-700">Karyawan</label>
                    <select
                      required
                      value={payForm.employeeId}
                      onChange={(e) => {
                        const emp = employees.find((item) => item.id === e.target.value);
                        if (emp) prefillPayFormForEmployee(emp, payForm.period);
                      }}
                      className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 text-slate-900"
                    >
                      {employees.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.employeeCode} — {e.fullName}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block font-medium text-slate-700">Periode</label>
                  <input
                    type="month"
                    required
                    disabled={Boolean(editingPayroll)}
                    value={payForm.period}
                    onChange={(e) => setPayForm((p) => ({ ...p, period: e.target.value }))}
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 font-mono disabled:bg-slate-50"
                  />
                </div>
                {editingPayroll && (
                  <div className="sm:col-span-2">
                    <label className="block font-medium text-slate-700">Cabang</label>
                    <select
                      value={payForm.branchId}
                      onChange={(e) => setPayForm((p) => ({ ...p, branchId: e.target.value }))}
                      className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 bg-white px-3"
                    >
                      {branches.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.code} — {b.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="block font-medium text-slate-700">Hari Hadir</label>
                  <input
                    type="number"
                    min={0}
                    max={31}
                    required
                    value={payForm.presentDays}
                    onChange={(e) => setPayForm((p) => ({ ...p, presentDays: e.target.value }))}
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Total Telat (Menit)</label>
                  <input
                    type="number"
                    min={0}
                    max={20000}
                    required
                    value={payForm.lateMinutesTotal}
                    onChange={(e) =>
                      setPayForm((p) => ({ ...p, lateMinutesTotal: e.target.value }))
                    }
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Jam Lembur</label>
                  <input
                    type="number"
                    step="0.5"
                    min={0}
                    max={300}
                    required
                    value={payForm.overtimeHours}
                    onChange={(e) => setPayForm((p) => ({ ...p, overtimeHours: e.target.value }))}
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                <div>
                  <label className="block font-medium text-slate-700">Gaji Pokok (IDR)</label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={payForm.baseSalary}
                    onChange={(e) => setPayForm((p) => ({ ...p, baseSalary: e.target.value }))}
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Tunjangan (IDR)</label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={payForm.allowances}
                    onChange={(e) => setPayForm((p) => ({ ...p, allowances: e.target.value }))}
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Upah Lembur (IDR)</label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={payForm.overtimePay}
                    onChange={(e) => setPayForm((p) => ({ ...p, overtimePay: e.target.value }))}
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Potongan Telat</label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={payForm.lateDeduction}
                    onChange={(e) => setPayForm((p) => ({ ...p, lateDeduction: e.target.value }))}
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Potongan BPJS</label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={payForm.bpjsDeduction}
                    onChange={(e) => setPayForm((p) => ({ ...p, bpjsDeduction: e.target.value }))}
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 font-mono"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={handleRecalculatePayForm}
                    className="inline-flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 font-semibold text-emerald-800 hover:bg-emerald-100 cursor-pointer"
                  >
                    <Calculator className="h-3.5 w-3.5" />
                    Hitung Ulang Total
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <div>
                  <label className="block font-medium text-slate-700">Penghasilan Bruto</label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={payForm.grossIncome}
                    onChange={(e) => setPayForm((p) => ({ ...p, grossIncome: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 bg-white px-2.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Tarif TER (%)</label>
                  <input
                    type="number"
                    step="0.25"
                    min={0}
                    max={50}
                    required
                    value={payForm.pph21Rate}
                    onChange={(e) => setPayForm((p) => ({ ...p, pph21Rate: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 bg-white px-2.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">PPh 21 (IDR)</label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={payForm.pph21Amount}
                    onChange={(e) => setPayForm((p) => ({ ...p, pph21Amount: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-slate-200 bg-white px-2.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-emerald-800">Gaji Bersih (THP)</label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={payForm.netSalary}
                    onChange={(e) => setPayForm((p) => ({ ...p, netSalary: e.target.value }))}
                    className="mt-1 w-full min-h-[38px] rounded-lg border border-emerald-300 bg-white px-2.5 font-mono font-bold text-emerald-800"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block font-medium text-slate-700">Status Pembayaran</label>
                  <select
                    value={payForm.status}
                    onChange={(e) =>
                      setPayForm((p) => ({ ...p, status: e.target.value as PayrollStatus }))
                    }
                    className="mt-1 w-full min-h-[40px] rounded-lg border border-slate-200 bg-white px-3"
                  >
                    <option value="draft">Draft</option>
                    <option value="disetujui">Disetujui</option>
                    <option value="dibayarkan">Dibayarkan</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 sm:mt-5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={payForm.taxReported}
                    onChange={(e) =>
                      setPayForm((p) => ({ ...p, taxReported: e.target.checked }))
                    }
                    className="h-4 w-4 accent-emerald-600"
                  />
                  <span className="font-medium text-slate-800">Tandai SPT PPh 21 Terlapor</span>
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setPayrollModalOpen(false)}
                  className="min-h-[40px] rounded-lg border border-slate-200 px-4 font-medium text-slate-700 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingPayModal}
                  className="min-h-[40px] rounded-lg bg-emerald-600 px-5 font-semibold text-white hover:bg-emerald-700 cursor-pointer"
                >
                  {savingPayModal ? 'Menyimpan...' : 'Simpan Slip Gaji'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

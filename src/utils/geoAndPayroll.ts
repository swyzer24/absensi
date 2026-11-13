import type { AttendanceRecord, Employee, PTKPStatus } from '../types';

export function calculateDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

export function formatRupiah(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(amount);
}

export function getTodayDateString(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getCurrentPeriodString(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function formatTimeShort(isoOrDate: string): string {
  if (!isoOrDate) return '-';
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return isoOrDate;
  return d.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function calculateLateMinutes(clockInIso: string, shiftStartHHMM: string): number {
  const d = new Date(clockInIso);
  if (Number.isNaN(d.getTime())) return 0;
  const [sh, sm] = shiftStartHHMM.split(':').map(Number);
  const shiftDate = new Date(d);
  shiftDate.setHours(sh, sm, 0, 0);
  const diffMs = d.getTime() - shiftDate.getTime();
  return diffMs > 60000 ? Math.floor(diffMs / 60000) : 0;
}

export function calculateOvertimeMinutes(clockOutIso: string, shiftEndHHMM: string): number {
  const d = new Date(clockOutIso);
  if (Number.isNaN(d.getTime())) return 0;
  const [eh, em] = shiftEndHHMM.split(':').map(Number);
  const shiftEndDate = new Date(d);
  shiftEndDate.setHours(eh, em, 0, 0);
  const diffMs = d.getTime() - shiftEndDate.getTime();
  return diffMs > 15 * 60000 ? Math.floor(diffMs / 60000) : 0;
}

// Tarif Efektif Rata-rata (TER) PPh 21 sesuai PP No. 58 Tahun 2023
export function calculatePPh21TER(grossIncome: number, ptkpStatus: PTKPStatus): {
  ratePercent: number;
  taxAmount: number;
} {
  // Kategori A: TK/0, TK/1, K/0
  // Kategori B: TK/2, K/1, K/2
  // Kategori C: K/3
  let ratePercent = 0;

  if (ptkpStatus === 'TK/0' || ptkpStatus === 'TK/1' || ptkpStatus === 'K/0') {
    if (grossIncome <= 5400000) ratePercent = 0;
    else if (grossIncome <= 5650000) ratePercent = 0.25;
    else if (grossIncome <= 6300000) ratePercent = 0.75;
    else if (grossIncome <= 7500000) ratePercent = 1.25;
    else if (grossIncome <= 9100000) ratePercent = 1.75;
    else if (grossIncome <= 10700000) ratePercent = 2.5;
    else if (grossIncome <= 13400000) ratePercent = 4.0;
    else if (grossIncome <= 16900000) ratePercent = 6.0;
    else if (grossIncome <= 22100000) ratePercent = 9.0;
    else if (grossIncome <= 30000000) ratePercent = 12.0;
    else ratePercent = 15.0;
  } else if (ptkpStatus === 'K/1' || ptkpStatus === 'K/2') {
    if (grossIncome <= 6200000) ratePercent = 0;
    else if (grossIncome <= 6850000) ratePercent = 0.5;
    else if (grossIncome <= 8000000) ratePercent = 1.0;
    else if (grossIncome <= 9550000) ratePercent = 1.5;
    else if (grossIncome <= 11600000) ratePercent = 2.25;
    else if (grossIncome <= 14600000) ratePercent = 3.5;
    else if (grossIncome <= 18850000) ratePercent = 5.5;
    else if (grossIncome <= 24500000) ratePercent = 8.0;
    else ratePercent = 11.0;
  } else {
    // K/3 (Kategori C)
    if (grossIncome <= 6600000) ratePercent = 0;
    else if (grossIncome <= 7450000) ratePercent = 0.5;
    else if (grossIncome <= 8800000) ratePercent = 1.0;
    else if (grossIncome <= 10950000) ratePercent = 1.75;
    else if (grossIncome <= 14150000) ratePercent = 3.0;
    else if (grossIncome <= 18500000) ratePercent = 5.0;
    else if (grossIncome <= 25200000) ratePercent = 7.5;
    else ratePercent = 10.0;
  }

  return {
    ratePercent,
    taxAmount: Math.round((grossIncome * ratePercent) / 100),
  };
}

export function computeMonthlyPayrollForEmployee(
  employee: Employee,
  periodRecords: AttendanceRecord[]
) {
  const presentDays = periodRecords.filter((r) => r.status !== 'izin').length;
  const lateMinutesTotal = periodRecords.reduce((acc, r) => acc + (r.lateMinutes || 0), 0);
  const overtimeMinutesTotal = periodRecords.reduce((acc, r) => acc + (r.overtimeMinutes || 0), 0);
  const overtimeHours = Math.round((overtimeMinutesTotal / 60) * 10) / 10;

  const baseSalary = employee.baseSalary;
  const allowances = presentDays * employee.dailyAllowance;
  const hourlyRate = Math.round(baseSalary / 173);
  const overtimePay = Math.round(overtimeHours * hourlyRate * 1.5);
  const lateDeduction = Math.round((lateMinutesTotal / 60) * (hourlyRate * 0.5));
  const bpjsDeduction = Math.round(baseSalary * 0.03); // 1% BPJS Kes + 2% JHT

  const grossIncome = Math.max(0, baseSalary + allowances + overtimePay - lateDeduction);
  const { ratePercent: pph21Rate, taxAmount: pph21Amount } = calculatePPh21TER(
    grossIncome,
    employee.ptkpStatus
  );
  const netSalary = Math.max(0, grossIncome - bpjsDeduction - pph21Amount);

  return {
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
  };
}

export function downloadCSV(filename: string, headers: string[], rows: Array<Array<string | number>>) {
  const escape = (v: string | number) => {
    const str = String(v ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const csvContent = [
    headers.map(escape).join(','),
    ...rows.map((row) => row.map(escape).join(',')),
  ].join('\n');

  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

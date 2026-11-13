import type { Timestamp } from 'firebase/firestore';

export type AdminRole = 'super_admin' | 'hrd_admin' | 'management';
export type PTKPStatus = 'TK/0' | 'TK/1' | 'K/0' | 'K/1' | 'K/2' | 'K/3';
export type EmployeeStatus = 'aktif' | 'cuti' | 'nonaktif';
export type AttendanceStatus = 'tepat_waktu' | 'terlambat' | 'lembur' | 'izin';
export type RequestStatus = 'menunggu' | 'disetujui' | 'ditolak';
export type LeaveType = 'izin_sakit' | 'izin_pribadi' | 'cuti_tahunan' | 'dinas_luar';
export type PayrollStatus = 'draft' | 'disetujui' | 'dibayarkan';
export type TaxFilingStatus = 'terkirim' | 'tervalidasi' | 'gagal';

export interface AdminRegistry {
  uid: string;
  email: string;
  displayName: string;
  role: AdminRole;
  createdAt?: Timestamp | Date | unknown;
}

export interface AdminInvite {
  id: string;
  email: string;
  displayName: string;
  role: AdminRole;
  status: 'pending' | 'claimed';
  claimedUid?: string;
  createdByUid: string;
  createdAt?: Timestamp | Date | unknown;
  updatedAt?: Timestamp | Date | unknown;
}

export interface AppSettings {
  id: string;
  companyName: string;
  requireFaceVerification: boolean;
  requireGpsGeofence: boolean;
  allowEmployeeSelfService: boolean;
  lateToleranceMinutes: number;
  maxOvertimeHoursPerMonth: number;
  maintenanceMode: boolean;
  announcementBanner: string;
  updatedByUid: string;
  updatedAt?: Timestamp | Date | unknown;
}

export interface Branch {
  id: string;
  name: string;
  code: string;
  city: string;
  address: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  shiftStart: string;
  shiftEnd: string;
  active: boolean;
  createdAt?: Timestamp | Date | unknown;
  updatedAt?: Timestamp | Date | unknown;
}

export interface Employee {
  id: string;
  uid: string;
  email?: string;
  employeeCode: string;
  fullName: string;
  department: string;
  position: string;
  branchId: string;
  ptkpStatus: PTKPStatus;
  baseSalary: number;
  dailyAllowance: number;
  avatarUrl?: string;
  status: EmployeeStatus;
  createdAt?: Timestamp | Date | unknown;
  updatedAt?: Timestamp | Date | unknown;
}

export interface EmployeeDecryptedPII {
  nik: string;
  npwp: string;
  bankName: string;
  bankAccount: string;
  emergencyContact: string;
}

export interface EmployeeEncryptedPII {
  ownerUid: string;
  algorithm: 'AES-256-GCM';
  ciphertext: string;
  iv: string;
  keyFingerprint: string;
  updatedAt?: Timestamp | Date | unknown;
}

export interface AttendanceRecord {
  id: string;
  userId: string;
  employeeId: string;
  employeeName: string;
  branchId: string;
  branchName: string;
  date: string;
  clockInTime: string;
  clockOutTime?: string;
  clockInLat: number;
  clockInLng: number;
  clockInDistanceMeters: number;
  clockOutLat?: number;
  clockOutLng?: number;
  clockOutDistanceMeters?: number;
  faceVerified: boolean;
  faceConfidence: number;
  faceHash: string;
  faceThumbnail?: string;
  status: AttendanceStatus;
  lateMinutes: number;
  overtimeMinutes: number;
  notes?: string;
  createdAt?: Timestamp | Date | unknown;
  updatedAt?: Timestamp | Date | unknown;
}

export interface LeaveRequest {
  id: string;
  userId: string;
  employeeId: string;
  employeeName: string;
  branchId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason: string;
  status: RequestStatus;
  reviewedByName?: string;
  reviewNotes?: string;
  createdAt?: Timestamp | Date | unknown;
  updatedAt?: Timestamp | Date | unknown;
}

export interface OvertimeRequest {
  id: string;
  userId: string;
  employeeId: string;
  employeeName: string;
  branchId: string;
  date: string;
  startTime: string;
  endTime: string;
  durationHours: number;
  reason: string;
  status: RequestStatus;
  reviewedByName?: string;
  reviewNotes?: string;
  createdAt?: Timestamp | Date | unknown;
  updatedAt?: Timestamp | Date | unknown;
}

export interface PayrollRun {
  id: string;
  period: string;
  employeeId: string;
  employeeName: string;
  userId: string;
  branchId: string;
  presentDays: number;
  lateMinutesTotal: number;
  overtimeHours: number;
  baseSalary: number;
  allowances: number;
  overtimePay: number;
  lateDeduction: number;
  bpjsDeduction: number;
  grossIncome: number;
  pph21Rate: number;
  pph21Amount: number;
  netSalary: number;
  status: PayrollStatus;
  taxReported: boolean;
  createdAt?: Timestamp | Date | unknown;
  updatedAt?: Timestamp | Date | unknown;
}

export interface TaxFiling {
  id: string;
  period: string;
  branchId: string;
  provider: string;
  totalEmployees: number;
  totalGrossIncome: number;
  totalPph21: number;
  receiptNumber: string;
  payloadSignature: string;
  status: TaxFilingStatus;
  syncedByUid: string;
  createdAt?: Timestamp | Date | unknown;
}

export interface ReminderSchedule {
  id: string;
  userId: string;
  branchId: string;
  shiftStart: string;
  shiftEnd: string;
  remindBeforeMinutes: number;
  browserNotifyEnabled: boolean;
  soundEnabled: boolean;
  updatedAt?: Timestamp | Date | unknown;
}

export type AdminSection = 'control' | 'analytics' | 'payroll' | 'branches';
export type EmployeeSection = 'terminal' | 'reminders';
export type AppSection = AdminSection | EmployeeSection;
export type EmployeePortalTab = 'beranda' | 'absen' | 'izin' | 'slip_gaji' | 'lembur' | 'riwayat' | 'privasi';

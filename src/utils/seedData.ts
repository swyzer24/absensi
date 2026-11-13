import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { BOOTSTRAPPED_ADMIN_EMAIL, db, handleFirestoreError, OperationType } from '../firebase';
import type { Branch, Employee, EmployeeDecryptedPII } from '../types';
import { computeSHA256, encryptEmployeePII, getActiveVaultPassphrase } from './encryption';
import { computeMonthlyPayrollForEmployee, getCurrentPeriodString, getTodayDateString } from './geoAndPayroll';

const DEFAULT_BRANCHES: Array<Omit<Branch, 'createdAt' | 'updatedAt'>> = [
  {
    id: 'cabang_jkt_hq',
    name: 'Kantor Pusat Jakarta Sudirman',
    code: 'JKT-HQ',
    city: 'Jakarta Selatan',
    address: 'Jl. Jend. Sudirman Kav. 52-53, SCBD, Jakarta Selatan',
    latitude: -6.225014,
    longitude: 106.808762,
    radiusMeters: 250,
    shiftStart: '08:30',
    shiftEnd: '17:30',
    active: true,
  },
  {
    id: 'cabang_sby_01',
    name: 'Cabang Surabaya Tunjungan',
    code: 'SBY-01',
    city: 'Surabaya',
    address: 'Jl. Basuki Rahmat No. 88, Genteng, Surabaya',
    latitude: -7.263694,
    longitude: 112.740821,
    radiusMeters: 250,
    shiftStart: '08:30',
    shiftEnd: '17:30',
    active: true,
  },
  {
    id: 'cabang_bdg_01',
    name: 'Cabang Bandung Dago',
    code: 'BDG-01',
    city: 'Bandung',
    address: 'Jl. Ir. H. Juanda No. 112, Coblong, Bandung',
    latitude: -6.892751,
    longitude: 107.613218,
    radiusMeters: 250,
    shiftStart: '08:30',
    shiftEnd: '17:30',
    active: true,
  },
  {
    id: 'cabang_mdn_01',
    name: 'Cabang Medan Merdeka',
    code: 'MDN-01',
    city: 'Medan',
    address: 'Jl. Balai Kota No. 14, Medan Barat, Medan',
    latitude: 3.591243,
    longitude: 98.677412,
    radiusMeters: 300,
    shiftStart: '08:30',
    shiftEnd: '17:30',
    active: true,
  },
];

export async function ensureWorkspaceSeeded(
  user: User,
  isAdmin: boolean,
  isSuperAdmin: boolean
): Promise<void> {
  if (!isAdmin) return;
  try {
    const branchSnap = await getDocs(query(collection(db, 'branches'), limit(1)));
    const passphrase = getActiveVaultPassphrase();

    if (branchSnap.empty) {
      for (const branch of DEFAULT_BRANCHES) {
        await setDoc(doc(db, 'branches', branch.id), {
          ...branch,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      const seedEmployees: Array<{
        emp: Omit<Employee, 'createdAt' | 'updatedAt'>;
        pii: EmployeeDecryptedPII;
      }> = [
        {
          emp: {
            id: 'emp_andi_pratama',
            uid: 'UNCLAIMED_emp_andi_pratama',
            email: 'andi.pratama@presensia.id',
            employeeCode: 'EMP-002',
            fullName: 'Andi Pratama Wijaya',
            department: 'Teknologi Informasi',
            position: 'Senior Cloud Engineer',
            branchId: 'cabang_jkt_hq',
            ptkpStatus: 'TK/0',
            baseSalary: 14500000,
            dailyAllowance: 100000,
            avatarUrl: '/src/assets/images/avatar_employee_primary_1794555760215.jpg',
            status: 'aktif',
          },
          pii: {
            nik: '3173051204930011',
            npwp: '71.402.118.9-031.000',
            bankName: 'Mandiri',
            bankAccount: '1240008912341',
            emergencyContact: '+62 813-4421-9001 (Ibu Lestari)',
          },
        },
        {
          emp: {
            id: 'emp_ratna_kumala',
            uid: 'UNCLAIMED_emp_ratna_kumala',
            email: 'ratna.kumala@presensia.id',
            employeeCode: 'EMP-003',
            fullName: 'Ratna Kumala Dewi',
            department: 'Operasional Cabang',
            position: 'Branch Operations Lead',
            branchId: 'cabang_sby_01',
            ptkpStatus: 'K/2',
            baseSalary: 13200000,
            dailyAllowance: 95000,
            avatarUrl: '/src/assets/images/avatar_branch_manager_1794555760821.jpg',
            status: 'aktif',
          },
          pii: {
            nik: '3578044809910002',
            npwp: '62.918.304.1-604.000',
            bankName: 'BNI',
            bankAccount: '0291847712',
            emergencyContact: '+62 811-3192-774 (Suami - Dimas)',
          },
        },
        {
          emp: {
            id: 'emp_bima_nugraha',
            uid: 'UNCLAIMED_emp_bima_nugraha',
            email: 'bima.nugraha@presensia.id',
            employeeCode: 'EMP-004',
            fullName: 'Bima Sakti Nugraha',
            department: 'Keuangan & Pajak',
            position: 'Payroll & Tax Specialist',
            branchId: 'cabang_bdg_01',
            ptkpStatus: 'K/0',
            baseSalary: 11800000,
            dailyAllowance: 85000,
            status: 'aktif',
          },
          pii: {
            nik: '3273021911940007',
            npwp: '84.119.520.4-423.000',
            bankName: 'BCA',
            bankAccount: '7750318842',
            emergencyContact: '+62 856-2291-0118 (Ibu Sinta)',
          },
        },
        {
          emp: {
            id: 'emp_farah_nadia',
            uid: 'UNCLAIMED_emp_farah_nadia',
            email: 'farah.nadia@presensia.id',
            employeeCode: 'EMP-005',
            fullName: 'Farah Nadia Putri',
            department: 'Penjualan Regional',
            position: 'Regional Account Executive',
            branchId: 'cabang_mdn_01',
            ptkpStatus: 'TK/0',
            baseSalary: 9800000,
            dailyAllowance: 80000,
            status: 'aktif',
          },
          pii: {
            nik: '1271036207960005',
            npwp: '91.504.221.8-121.000',
            bankName: 'BRI',
            bankAccount: '034101009912503',
            emergencyContact: '+62 812-6004-7122 (Ayah - Rahman)',
          },
        },
      ];

      for (const item of seedEmployees) {
        await setDoc(doc(db, 'employees', item.emp.id), {
          ...item.emp,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        const encrypted = await encryptEmployeePII(item.pii, item.emp.uid, passphrase);
        await setDoc(doc(db, 'employees', item.emp.id, 'private', 'pii'), {
          ...encrypted,
          updatedAt: serverTimestamp(),
        });
      }

      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth();
      const todayDay = now.getDate();

      const branchMap = new Map(DEFAULT_BRANCHES.map((b) => [b.id, b]));
      const sampleTargets = seedEmployees;

      let dayCount = 0;
      for (let d = Math.max(1, todayDay - 10); d < todayDay; d++) {
        const dt = new Date(currentYear, currentMonth, d);
        if (dt.getDay() === 0 || dt.getDay() === 6) continue;
        dayCount++;
        const dateStr = getTodayDateString(dt);

        for (let idx = 0; idx < sampleTargets.length; idx++) {
          const emp = sampleTargets[idx].emp;
          const br = branchMap.get(emp.branchId) || DEFAULT_BRANCHES[0];
          const isLate = (d + idx) % 5 === 0;
          const lateMinutes = isLate ? 14 + ((d * 3 + idx * 7) % 22) : 0;
          const isOvertime = (d + idx) % 4 === 1;
          const overtimeMinutes = isOvertime ? 65 + ((d * 5 + idx * 10) % 55) : 0;

          const inDate = new Date(currentYear, currentMonth, d, 8, isLate ? 30 + lateMinutes : 18 + idx * 3, 12);
          const outDate = new Date(currentYear, currentMonth, d, isOvertime ? 18 : 17, isOvertime ? 35 + (overtimeMinutes % 45) : 32 + idx * 4, 40);

          const attId = `att_${emp.id}_${dateStr.replace(/-/g, '')}`;
          const faceHash = await computeSHA256(`${emp.id}:${dateStr}:verified`);

          await setDoc(doc(db, 'attendance', attId), {
            id: attId,
            userId: emp.uid,
            employeeId: emp.id,
            employeeName: emp.fullName,
            branchId: br.id,
            branchName: br.name,
            date: dateStr,
            clockInTime: inDate.toISOString(),
            clockOutTime: outDate.toISOString(),
            clockInLat: br.latitude + idx * 0.0001,
            clockInLng: br.longitude + idx * 0.0001,
            clockInDistanceMeters: 18 + idx * 9,
            clockOutLat: br.latitude + idx * 0.0001,
            clockOutLng: br.longitude + idx * 0.0001,
            clockOutDistanceMeters: 21 + idx * 7,
            faceVerified: true,
            faceConfidence: 94 + (idx % 5),
            faceHash,
            status: isOvertime ? 'lembur' : isLate ? 'terlambat' : 'tepat_waktu',
            lateMinutes,
            overtimeMinutes,
            notes: isOvertime ? 'Penyelesaian laporan operasional cabang' : '',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
        if (dayCount >= 6) break;
      }

      await setDoc(doc(db, 'schedules', `sched_${user.uid}`), {
        id: `sched_${user.uid}`,
        userId: user.uid,
        branchId: 'cabang_jkt_hq',
        shiftStart: '08:30',
        shiftEnd: '17:30',
        remindBeforeMinutes: 15,
        browserNotifyEnabled: true,
        soundEnabled: true,
        updatedAt: serverTimestamp(),
      });
    }

    // Upgrade-safe seeding for Super Admin registry, Global AppSettings, Leave & Overtime Requests, and initial Payslips
    if (isSuperAdmin) {
      const adminDocRef = doc(db, 'admins', user.uid);
      const adminSnap = await getDoc(adminDocRef);
      if (!adminSnap.exists()) {
        await setDoc(adminDocRef, {
          uid: user.uid,
          email: user.email || BOOTSTRAPPED_ADMIN_EMAIL,
          displayName: user.displayName || 'Super Admin Presensia',
          role: 'super_admin',
          createdAt: serverTimestamp(),
        });
      }
    }

    if (isAdmin) {
      const settingsRef = doc(db, 'appSettings', 'global');
      const settingsSnap = await getDoc(settingsRef);
      if (!settingsSnap.exists()) {
        await setDoc(settingsRef, {
          id: 'global',
          companyName: 'PT Presensia Nusantara Teknologi',
          requireFaceVerification: true,
          requireGpsGeofence: true,
          allowEmployeeSelfService: true,
          lateToleranceMinutes: 5,
          maxOvertimeHoursPerMonth: 40,
          maintenanceMode: false,
          announcementBanner:
            'Gunakan portal karyawan untuk absensi GPS, pengajuan izin/cuti, lembur, dan unduh slip gaji digital.',
          updatedByUid: user.uid,
          updatedAt: serverTimestamp(),
        });
      }

      const leaveSnap = await getDocs(query(collection(db, 'leaveRequests'), limit(1)));
      if (leaveSnap.empty) {
        const today = getTodayDateString();
        await setDoc(doc(db, 'leaveRequests', 'leave_sample_andi'), {
          id: 'leave_sample_andi',
          userId: user.uid,
          employeeId: 'emp_andi_pratama',
          employeeName: 'Andi Pratama Wijaya',
          branchId: 'cabang_jkt_hq',
          leaveType: 'cuti_tahunan',
          startDate: today,
          endDate: today,
          totalDays: 1,
          reason: 'Keperluan keluarga mendesak di Jakarta Selatan',
          status: 'menunggu',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        await setDoc(doc(db, 'leaveRequests', 'leave_sample_ratna'), {
          id: 'leave_sample_ratna',
          userId: user.uid,
          employeeId: 'emp_ratna_kumala',
          employeeName: 'Ratna Kumala Dewi',
          branchId: 'cabang_sby_01',
          leaveType: 'dinas_luar',
          startDate: today,
          endDate: today,
          totalDays: 1,
          reason: 'Kunjungan audit operasional ke cabang mitra Surabaya Timur',
          status: 'disetujui',
          reviewedByName: user.displayName || 'HRD Director',
          reviewNotes: 'Disetujui sesuai agenda operasional Q4.',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      const otSnap = await getDocs(query(collection(db, 'overtimeRequests'), limit(1)));
      if (otSnap.empty) {
        const today = getTodayDateString();
        await setDoc(doc(db, 'overtimeRequests', 'ot_sample_bima'), {
          id: 'ot_sample_bima',
          userId: user.uid,
          employeeId: 'emp_bima_nugraha',
          employeeName: 'Bima Sakti Nugraha',
          branchId: 'cabang_bdg_01',
          date: today,
          startTime: '18:00',
          endTime: '20:30',
          durationHours: 2.5,
          reason: 'Rekonsiliasi SPT Masa PPh 21 akhir periode cabang Bandung',
          status: 'menunggu',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      // Ensure initial payslips exist for current period so Slip Gaji & Mirroring work immediately
      const paySnap = await getDocs(query(collection(db, 'payrollRuns'), limit(1)));
      if (paySnap.empty) {
        const period = getCurrentPeriodString();
        const empDocs = await getDocs(collection(db, 'employees'));
        const attDocs = await getDocs(collection(db, 'attendance'));
        const allAtt = attDocs.docs.map((d) => d.data() as import('../types').AttendanceRecord);
        for (const ed of empDocs.docs) {
          const emp = ed.data() as Employee;
          const empAtt = allAtt.filter((a) => a.date.startsWith(period) && a.employeeId === emp.id);
          const calc = computeMonthlyPayrollForEmployee(emp, empAtt);
          const payrollId = `pay_${period.replace('-', '')}_${emp.id}`;
          await setDoc(doc(db, 'payrollRuns', payrollId), {
            id: payrollId,
            period,
            employeeId: emp.id,
            employeeName: emp.fullName,
            userId: emp.uid,
            branchId: emp.branchId,
            ...calc,
            status: 'disetujui',
            taxReported: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      }
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'workspace_seed');
  }
}

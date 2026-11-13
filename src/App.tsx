import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  BarChart3,
  Bell,
  Building2,
  Calculator,
  Clock,
  Home,
  Lock,
  LogOut,
  Menu,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  UserCheck,
  X,
} from 'lucide-react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  auth,
  BOOTSTRAPPED_ADMIN_EMAIL,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
} from './firebase';
import type {
  AdminInvite,
  AdminRegistry,
  AdminSection,
  AppSection,
  AppSettings,
  AttendanceRecord,
  Branch,
  Employee,
  EmployeePortalTab,
  LeaveRequest,
  OvertimeRequest,
  PayrollRun,
  ReminderSchedule,
  TaxFiling,
} from './types';
import { ensureWorkspaceSeeded } from './utils/seedData';
import { EmployeeTerminal } from './components/EmployeeTerminal';
import { AdminControlCenter } from './components/AdminControlCenter';
import { HRDAnalyticsDashboard } from './components/HRDAnalyticsDashboard';
import { PayrollAndTaxModule } from './components/PayrollAndTaxModule';
import { BranchesAndSecurityModule } from './components/BranchesAndSecurityModule';
import { ReminderCenter } from './components/ReminderCenter';
import { PWAInstallButton } from './components/PWAInstallButton';
import { OfflineIndicator } from './components/OfflineIndicator';

function playReminderChime() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.14);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.45);
  } catch {
    // Audio playback blocked before user gesture
  }
}

function GoogleLogo({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        fill="#4285F4"
        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z"
      />
    </svg>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [hasEmployeeRecord, setHasEmployeeRecord] = useState(false);
  const [employeesLoaded, setEmployeesLoaded] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [activeSection, setActiveSection] = useState<AppSection>('control');
  const [employeePortalTab, setEmployeePortalTab] = useState<EmployeePortalTab>('beranda');
  const [mirroredEmployeeId, setMirroredEmployeeId] = useState<string | null>(null);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  const [adminsList, setAdminsList] = useState<AdminRegistry[]>([]);
  const [adminInvites, setAdminInvites] = useState<AdminInvite[]>([]);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [payrollRuns, setPayrollRuns] = useState<PayrollRun[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);
  const [overtimeRequests, setOvertimeRequests] = useState<OvertimeRequest[]>([]);
  const [taxFilings, setTaxFilings] = useState<TaxFiling[]>([]);
  const [schedule, setSchedule] = useState<ReminderSchedule | null>(null);

  const [activeToast, setActiveToast] = useState<{ title: string; body: string } | null>(null);
  const [lastTriggeredMinute, setLastTriggeredMinute] = useState<string>('');

  const triggerReminderNotification = useCallback(
    (title: string, body: string, withSound = true) => {
      setActiveToast({ title, body });
      if (withSound) {
        playReminderChime();
      }
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification(title, {
            body,
            icon: '/pwa-192x192.png',
          });
        } catch {
          // Ignore Notification errors on restricted browsers
        }
      }
    },
    []
  );

  const resolveUserAccess = useCallback(async (nextUser: User) => {
    const emailLower = (nextUser.email || '').trim().toLowerCase();
    let superAdminFlag =
      emailLower === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase() && nextUser.emailVerified;
    let adminFlag = superAdminFlag;
    let employeeFlag = false;

    try {
      const adminDoc = await getDoc(doc(db, 'admins', nextUser.uid));
      if (adminDoc.exists()) {
        adminFlag = true;
        const data = adminDoc.data() as Partial<AdminRegistry>;
        if (data.role === 'super_admin') {
          superAdminFlag = true;
        }
      } else if (emailLower && nextUser.emailVerified) {
        const inviteSnap = await getDoc(doc(db, 'adminInvites', emailLower));
        if (inviteSnap.exists()) {
          const inv = inviteSnap.data() as AdminInvite;
          await setDoc(doc(db, 'admins', nextUser.uid), {
            uid: nextUser.uid,
            email: emailLower,
            displayName: inv.displayName || nextUser.displayName || emailLower,
            role: inv.role,
            createdAt: serverTimestamp(),
          });
          if (inv.status === 'pending') {
            await updateDoc(doc(db, 'adminInvites', emailLower), {
              status: 'claimed',
              claimedUid: nextUser.uid,
              updatedAt: serverTimestamp(),
            });
          }
          adminFlag = true;
          superAdminFlag = inv.role === 'super_admin';
        }
      }
    } catch (err) {
      if (adminFlag) {
        // Keep bootstrapped super admin fallback
      } else {
        setAuthError(
          err instanceof Error ? err.message : 'Gagal memverifikasi otoritas admin.'
        );
      }
    }

    if (!adminFlag) {
      try {
        const uidEmpSnap = await getDocs(
          query(collection(db, 'employees'), where('uid', '==', nextUser.uid), limit(1))
        );
        if (!uidEmpSnap.empty) {
          employeeFlag = true;
        } else if (emailLower && nextUser.emailVerified) {
          const emailEmpSnap = await getDocs(
            query(collection(db, 'employees'), where('email', '==', emailLower), limit(1))
          );
          if (!emailEmpSnap.empty) {
            const empDoc = emailEmpSnap.docs[0];
            const empData = empDoc.data() as Employee;
            if (empData.status === 'nonaktif') {
              setAuthError(
                'Status kepegawaian untuk email ini saat ini Nonaktif. Hubungi Admin HRD atau Super Admin.'
              );
              employeeFlag = false;
            } else {
              if (empData.status === 'aktif' && empData.uid !== nextUser.uid) {
                await updateDoc(doc(db, 'employees', empDoc.id), {
                  uid: nextUser.uid,
                  avatarUrl: empData.avatarUrl || nextUser.photoURL || '',
                  updatedAt: serverTimestamp(),
                });
              }
              employeeFlag = true;
            }
          }
        }
      } catch (err) {
        setAuthError(
          err instanceof Error ? err.message : 'Gagal memeriksa pendaftaran karyawan.'
        );
      }
    }

    setIsAdmin(adminFlag);
    setIsSuperAdmin(superAdminFlag);
    setHasEmployeeRecord(employeeFlag);

    if (adminFlag) {
      setActiveSection((prev) =>
        prev === 'terminal' || prev === 'reminders' ? 'control' : prev
      );
      setSeeding(true);
      try {
        await ensureWorkspaceSeeded(nextUser, adminFlag, superAdminFlag);
      } catch (err) {
        setAuthError(
          err instanceof Error ? err.message : 'Gagal menyinkronkan data awal cloud.'
        );
      } finally {
        setSeeding(false);
      }
    } else if (employeeFlag) {
      setActiveSection('terminal');
    }
  }, []);

  // Auth listener & hierarchical role resolution
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setAuthError(null);
      if (!nextUser) {
        setIsAdmin(false);
        setIsSuperAdmin(false);
        setHasEmployeeRecord(false);
        setMirroredEmployeeId(null);
        setAuthReady(true);
        return;
      }

      await resolveUserAccess(nextUser);
      setAuthReady(true);
    });

    return () => unsub();
  }, [resolveUserAccess]);

  // Real-time Firestore cloud subscriptions
  useEffect(() => {
    if (!authReady || !user || (!isAdmin && !hasEmployeeRecord)) {
      setAdminsList([]);
      setAdminInvites([]);
      setAppSettings(null);
      setBranches([]);
      setEmployees([]);
      setEmployeesLoaded(false);
      setAttendance([]);
      setPayrollRuns([]);
      setLeaveRequests([]);
      setOvertimeRequests([]);
      setTaxFilings([]);
      setSchedule(null);
      return;
    }

    const unsubSettings = onSnapshot(
      doc(db, 'appSettings', 'global'),
      (snap) => {
        setAppSettings(snap.exists() ? (snap.data() as AppSettings) : null);
      },
      (err) => handleFirestoreError(err, OperationType.GET, 'appSettings/global')
    );

    const unsubBranches = onSnapshot(
      collection(db, 'branches'),
      (snap) => {
        setBranches(snap.docs.map((d) => d.data() as Branch));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'branches')
    );

    const empQuery = isAdmin
      ? collection(db, 'employees')
      : query(collection(db, 'employees'), where('uid', '==', user.uid));
    const unsubEmployees = onSnapshot(
      empQuery,
      (snap) => {
        setEmployees(snap.docs.map((d) => d.data() as Employee));
        setEmployeesLoaded(true);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'employees')
    );

    const attQuery = isAdmin
      ? collection(db, 'attendance')
      : query(collection(db, 'attendance'), where('userId', '==', user.uid));
    const unsubAttendance = onSnapshot(
      attQuery,
      (snap) => {
        setAttendance(snap.docs.map((d) => d.data() as AttendanceRecord));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'attendance')
    );

    const payQuery = isAdmin
      ? collection(db, 'payrollRuns')
      : query(collection(db, 'payrollRuns'), where('userId', '==', user.uid));
    const unsubPayroll = onSnapshot(
      payQuery,
      (snap) => {
        setPayrollRuns(snap.docs.map((d) => d.data() as PayrollRun));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'payrollRuns')
    );

    const leaveQuery = isAdmin
      ? collection(db, 'leaveRequests')
      : query(collection(db, 'leaveRequests'), where('userId', '==', user.uid));
    const unsubLeaves = onSnapshot(
      leaveQuery,
      (snap) => {
        setLeaveRequests(snap.docs.map((d) => d.data() as LeaveRequest));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'leaveRequests')
    );

    const otQuery = isAdmin
      ? collection(db, 'overtimeRequests')
      : query(collection(db, 'overtimeRequests'), where('userId', '==', user.uid));
    const unsubOvertimes = onSnapshot(
      otQuery,
      (snap) => {
        setOvertimeRequests(snap.docs.map((d) => d.data() as OvertimeRequest));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'overtimeRequests')
    );

    const schedQuery = query(collection(db, 'schedules'), where('userId', '==', user.uid));
    const unsubSchedule = onSnapshot(
      schedQuery,
      (snap) => {
        setSchedule(snap.empty ? null : (snap.docs[0].data() as ReminderSchedule));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'schedules')
    );

    let unsubTax = () => {};
    let unsubAdmins = () => {};
    let unsubInvites = () => {};
    if (isAdmin) {
      unsubTax = onSnapshot(
        collection(db, 'taxFilings'),
        (snap) => {
          setTaxFilings(snap.docs.map((d) => d.data() as TaxFiling));
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'taxFilings')
      );
      unsubAdmins = onSnapshot(
        collection(db, 'admins'),
        (snap) => {
          setAdminsList(snap.docs.map((d) => d.data() as AdminRegistry));
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'admins')
      );
      unsubInvites = onSnapshot(
        collection(db, 'adminInvites'),
        (snap) => {
          setAdminInvites(snap.docs.map((d) => d.data() as AdminInvite));
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'adminInvites')
      );
    }

    return () => {
      unsubSettings();
      unsubBranches();
      unsubEmployees();
      unsubAttendance();
      unsubPayroll();
      unsubLeaves();
      unsubOvertimes();
      unsubSchedule();
      unsubTax();
      unsubAdmins();
      unsubInvites();
    };
  }, [authReady, user, isAdmin, hasEmployeeRecord]);

  // Real-time Shift Reminder Watcher
  useEffect(() => {
    if (!user || !schedule) return;
    const interval = setInterval(() => {
      const now = new Date();
      const hhmmNow = `${String(now.getHours()).padStart(2, '0')}:${String(
        now.getMinutes()
      ).padStart(2, '0')}`;
      if (hhmmNow === lastTriggeredMinute) return;

      const checkTarget = (targetHHMM: string, label: string) => {
        const [th, tm] = targetHHMM.split(':').map(Number);
        const targetDate = new Date(now);
        targetDate.setHours(th, tm, 0, 0);
        const remindAt = new Date(targetDate.getTime() - schedule.remindBeforeMinutes * 60000);
        const remindHHMM = `${String(remindAt.getHours()).padStart(2, '0')}:${String(
          remindAt.getMinutes()
        ).padStart(2, '0')}`;

        if (hhmmNow === remindHHMM || hhmmNow === targetHHMM) {
          setLastTriggeredMinute(hhmmNow);
          triggerReminderNotification(
            `Pengingat ${label}`,
            hhmmNow === targetHHMM
              ? `Waktu ${label} (${targetHHMM} WIB) telah tiba. Segera lakukan verifikasi GPS & wajah.`
              : `${schedule.remindBeforeMinutes} menit lagi menuju jadwal ${label} (${targetHHMM} WIB).`,
            schedule.soundEnabled
          );
        }
      };

      checkTarget(schedule.shiftStart, 'Absen Masuk');
      checkTarget(schedule.shiftEnd, 'Absen Pulang');
    }, 15000);

    return () => clearInterval(interval);
  }, [user, schedule, lastTriggeredMinute, triggerReminderNotification]);

  const currentEmployee = useMemo(() => {
    if (!user) return null;
    return (
      employees.find((e) => e.id === user.uid) ||
      employees.find((e) => e.uid === user.uid) ||
      null
    );
  }, [employees, user]);

  const mirroredEmployee = useMemo(() => {
    if (!isAdmin || !mirroredEmployeeId) return null;
    return employees.find((e) => e.id === mirroredEmployeeId) || null;
  }, [isAdmin, mirroredEmployeeId, employees]);

  const effectiveEmployee = mirroredEmployee || currentEmployee;

  const effectiveAttendance = useMemo(() => {
    if (!user) return [];
    if (mirroredEmployee) {
      return attendance.filter((a) => a.employeeId === mirroredEmployee.id);
    }
    return attendance.filter(
      (a) => a.userId === user.uid && (!currentEmployee || a.employeeId === currentEmployee.id)
    );
  }, [attendance, user, mirroredEmployee, currentEmployee]);

  const effectivePayrolls = useMemo(() => {
    if (!user) return [];
    if (mirroredEmployee) {
      return payrollRuns.filter((p) => p.employeeId === mirroredEmployee.id);
    }
    return payrollRuns.filter(
      (p) => p.userId === user.uid && (!currentEmployee || p.employeeId === currentEmployee.id)
    );
  }, [payrollRuns, user, mirroredEmployee, currentEmployee]);

  const effectiveLeaveRequests = useMemo(() => {
    if (!user) return [];
    if (mirroredEmployee) {
      return leaveRequests.filter((l) => l.employeeId === mirroredEmployee.id);
    }
    return leaveRequests.filter(
      (l) => l.userId === user.uid && (!currentEmployee || l.employeeId === currentEmployee.id)
    );
  }, [leaveRequests, user, mirroredEmployee, currentEmployee]);

  const effectiveOvertimeRequests = useMemo(() => {
    if (!user) return [];
    if (mirroredEmployee) {
      return overtimeRequests.filter((o) => o.employeeId === mirroredEmployee.id);
    }
    return overtimeRequests.filter(
      (o) => o.userId === user.uid && (!currentEmployee || o.employeeId === currentEmployee.id)
    );
  }, [overtimeRequests, user, mirroredEmployee, currentEmployee]);

  const handleLogin = async () => {
    if (loggingIn) return;
    setAuthError(null);
    setLoggingIn(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: unknown) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: string }).code)
          : '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        setAuthError('Jendela pilih akun Google ditutup sebelum proses login selesai.');
      } else if (code === 'auth/popup-blocked') {
        setAuthError(
          'Popup Google diblokir oleh browser Anda. Mohon izinkan popup untuk situs ini lalu klik Masuk dengan Google lagi.'
        );
      } else if (code === 'auth/unauthorized-domain') {
        setAuthError(
          `Domain ${window.location.hostname} belum diizinkan pada Firebase Auth Authorized Domains.`
        );
      } else if (code === 'auth/network-request-failed') {
        setAuthError('Koneksi ke server Google gagal. Periksa jaringan internet Anda.');
      } else {
        setAuthError(
          err instanceof Error ? err.message : 'Gagal menghubungkan akun Google.'
        );
      }
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    setMirroredEmployeeId(null);
    await signOut(auth);
  };

  const handleStartMirror = (employeeId: string) => {
    setMirroredEmployeeId(employeeId);
    setEmployeePortalTab('beranda');
    setActiveSection('terminal');
  };

  const handleStopMirror = () => {
    setMirroredEmployeeId(null);
    setActiveSection('control');
  };

  const handleRecheckRegistration = async () => {
    if (!user) return;
    setCheckingAccess(true);
    setAuthError(null);
    try {
      await resolveUserAccess(user);
    } finally {
      setCheckingAccess(false);
    }
  };

  // Menu khusus Dasbor Super Admin & Admin HRD (terpisah total dari Dasbor Karyawan)
  const adminNavItems: Array<{
    id: AdminSection;
    label: string;
    mobileLabel: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    {
      id: 'control',
      label: 'Kontrol & Pendaftaran',
      mobileLabel: 'Kontrol',
      icon: SlidersHorizontal,
    },
    {
      id: 'analytics',
      label: 'Analitik HRD',
      mobileLabel: 'Analitik',
      icon: BarChart3,
    },
    {
      id: 'payroll',
      label: 'Payroll & Pajak',
      mobileLabel: 'Payroll',
      icon: Calculator,
    },
    {
      id: 'branches',
      label: 'Cabang & Enkripsi',
      mobileLabel: 'Cabang',
      icon: Building2,
    },
  ];

  const visibleNavItems = adminNavItems;

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <p className="font-display text-lg font-bold text-slate-900">Presensia Cloud</p>
          <p className="text-xs text-slate-500">Memuat sinkronisasi layanan cloud...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
        <OfflineIndicator />
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-6 py-4">
            <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
              Presensia Cloud
            </span>
            <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
              <a
                href="#gps-biometrik"
                className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
              >
                GPS & Wajah
              </a>
              <a
                href="#analitik-hrd"
                className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
              >
                Analitik HRD
              </a>
              <a
                href="#payroll-pajak"
                className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
              >
                Payroll & PPh 21
              </a>
              <a
                href="#keamanan-aes"
                className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
              >
                Enkripsi Cloud
              </a>
            </nav>
            <div className="shrink-0">
              <button
                type="button"
                disabled={loggingIn}
                onClick={handleLogin}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 shadow-2xs hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
              >
                <GoogleLogo className="h-4 w-4 shrink-0" />
                {loggingIn ? 'Menghubungkan...' : 'Masuk Google'}
              </button>
            </div>
          </div>
        </header>

        <main className="mx-auto flex-1 w-full max-w-6xl px-6 py-12 lg:py-16 space-y-16">
          <section className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:items-stretch">
            <div className="lg:col-span-7 flex flex-col justify-center space-y-6">
              <p className="text-xs font-medium text-emerald-700">
                Platform Absensi Multi-Cabang · Portal Layanan Mandiri Karyawan · Kontrol Super Admin & HRD
              </p>
              <h1 className="font-display text-3xl font-bold tracking-tight text-slate-900 sm:text-5xl [text-wrap:balance]">
                Absensi ponsel real-time yang langsung sinkron ke penggajian & pajak.
              </h1>
              <p className="max-w-xl text-base leading-relaxed text-slate-600">
                Portal terpadu bagi karyawan untuk absensi GPS dan wajah, pengajuan izin/cuti,
                lembur, dan slip gaji digital, serta pusat kontrol Super Admin & HRD lengkap
                dengan mirroring tampilan karyawan secara langsung.
              </p>

              {authError && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                  {authError}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="button"
                  disabled={loggingIn}
                  onClick={handleLogin}
                  className="inline-flex min-h-[48px] items-center gap-3 rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow-xs hover:bg-slate-50 transition-colors cursor-pointer disabled:opacity-60"
                >
                  <GoogleLogo className="h-5 w-5 shrink-0" />
                  <span>
                    {loggingIn ? 'Menghubungkan ke Akun Google...' : 'Masuk dengan Google'}
                  </span>
                </button>
                <PWAInstallButton />
              </div>
              <p className="text-xs text-slate-500">
                Terhubung langsung ke otentikasi resmi Google. Sistem otomatis memisahkan
                Dasbor Super Admin / HRD dan Portal Karyawan berdasarkan akun Google terdaftar.
              </p>
            </div>

            <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-6 flex flex-col justify-between space-y-6">
              <div className="flex items-center gap-4">
                <img
                  src="/src/assets/images/avatar_hrd_director_1794555758196.jpg"
                  alt="Direktur HRD Presensia Cloud"
                  referrerPolicy="no-referrer"
                  className="h-14 w-14 rounded-full object-cover border border-slate-200"
                />
                <div>
                  <p className="text-sm font-semibold text-slate-900">Dewi Kartika Sari</p>
                  <p className="text-xs text-slate-500">HRD Director · Jakarta Sudirman HQ</p>
                </div>
              </div>

              <div className="space-y-4 border-t border-slate-100 pt-5 text-xs">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  <div>
                    <p className="font-semibold text-slate-900">
                      Dasbor Terpisah: Super Admin & HRD
                    </p>
                    <p className="text-slate-600">
                      Dasbor khusus manajemen untuk pendaftaran akun HRD & karyawan, analitik
                      kehadiran, payroll PPh 21, dan mirroring layar karyawan.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  <div>
                    <p className="font-semibold text-slate-900">
                      Portal Terpisah: Karyawan (Pas di HP)
                    </p>
                    <p className="text-slate-600">
                      Akses khusus karyawan terdaftar untuk absen GPS & wajah, izin/cuti, slip
                      gaji digital, lembur, dan pengingat jadwal.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <UserCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  <div>
                    <p className="font-semibold text-slate-900">
                      Wajib Terdaftar Terlebih Dahulu
                    </p>
                    <p className="text-slate-600">
                      Akun karyawan dan HRD harus didaftarkan oleh Super Admin / HRD sebelum dapat
                      masuk menggunakan Google.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-6 border-t border-slate-200 pt-10 md:grid-cols-4">
            <div id="gps-biometrik" className="space-y-1.5">
              <p className="font-mono text-xs text-emerald-700">01. Portal Karyawan</p>
              <h2 className="text-sm font-semibold text-slate-900">Absen, Izin, Slip & Lembur</h2>
              <p className="text-xs leading-relaxed text-slate-600">
                Dasbor ikon karyawan dengan absen GPS/wajah, pengajuan izin/cuti, lembur, dan
                unduh slip gaji.
              </p>
            </div>
            <div id="analitik-hrd" className="space-y-1.5">
              <p className="font-mono text-xs text-emerald-700">02. Kontrol & Pendaftaran</p>
              <h2 className="text-sm font-semibold text-slate-900">Dasbor Super Admin & HRD</h2>
              <p className="text-xs leading-relaxed text-slate-600">
                Pendaftaran akun HRD & karyawan, kontrol kebijakan global, persetujuan, dan
                mirroring tampilan karyawan.
              </p>
            </div>
            <div id="payroll-pajak" className="space-y-1.5">
              <p className="font-mono text-xs text-emerald-700">03. Payroll & API Pajak</p>
              <h2 className="text-sm font-semibold text-slate-900">PPh 21 TER & e-Bupot</h2>
              <p className="text-xs leading-relaxed text-slate-600">
                Kalkulasi gaji bersih tersinkron absensi dan pengiriman SPT PPh 21 ke API pihak
                ketiga.
              </p>
            </div>
            <div id="keamanan-aes" className="space-y-1.5">
              <p className="font-mono text-xs text-emerald-700">04. Cloud & Pengingat</p>
              <h2 className="text-sm font-semibold text-slate-900">Sinkron Cabang & Enkripsi</h2>
              <p className="text-xs leading-relaxed text-slate-600">
                Notifikasi pengingat jadwal masuk/pulang real-time dan isolasi data pribadi
                terenkripsi AES-256.
              </p>
            </div>
          </section>
        </main>
      </div>
    );
  }

  // Smooth loading while registered employee profile snapshot resolves
  if (!isAdmin && hasEmployeeRecord && !employeesLoaded) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <p className="font-display text-lg font-bold text-slate-900">Presensia Cloud</p>
          <p className="text-xs text-slate-500">Memuat profil karyawan terdaftar...</p>
        </div>
      </div>
    );
  }

  // Gate 1: Unregistered Google Account (must be pre-registered as Employee or HRD/Admin)
  if (!isAdmin && !currentEmployee) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-5">
        <OfflineIndicator />
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 sm:p-7 space-y-5">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-amber-200 bg-amber-50 text-amber-700">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-semibold text-amber-800">Akses Belum Terdaftar</p>
              <h1 className="mt-0.5 text-lg font-bold text-slate-900">
                Akun Perlu Didaftarkan Terlebih Dahulu
              </h1>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs space-y-1.5">
            <p className="text-slate-500">Email Google yang masuk saat ini:</p>
            <p className="font-mono font-semibold text-slate-900 break-all">{user.email}</p>
            <p className="text-[11px] text-slate-600 pt-1 leading-relaxed">
              Sesuai kebijakan keamanan workspace, Super Admin atau Admin HRD harus mendaftarkan
              email ini sebagai <strong>Karyawan</strong> atau <strong>Admin HRD</strong> terlebih
              dahulu sebelum Anda dapat membuka dasbor.
            </p>
          </div>

          {authError && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
              {authError}
            </div>
          )}

          <div className="flex flex-col gap-2.5">
            <div className="flex flex-col gap-2.5 sm:flex-row">
              <button
                type="button"
                disabled={checkingAccess}
                onClick={handleRecheckRegistration}
                className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 cursor-pointer"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${checkingAccess ? 'animate-spin' : ''}`} />
                {checkingAccess ? 'Memeriksa...' : 'Periksa Ulang Status'}
              </button>
              <button
                type="button"
                disabled={loggingIn}
                onClick={handleLogin}
                className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
              >
                <GoogleLogo className="h-4 w-4 shrink-0" />
                {loggingIn ? 'Menghubungkan...' : 'Ganti Akun Google'}
              </button>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex min-h-[40px] w-full items-center justify-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 cursor-pointer"
            >
              <LogOut className="h-3.5 w-3.5" />
              Keluar Akun
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Gate 2: Deactivated employee account
  if (!isAdmin && currentEmployee?.status === 'nonaktif') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-5">
        <div className="w-full max-w-md rounded-2xl border border-rose-200 bg-white p-6 text-center space-y-4">
          <ShieldAlert className="mx-auto h-10 w-10 text-rose-600" />
          <h1 className="text-lg font-bold text-slate-900">Akun Karyawan Dinonaktifkan</h1>
          <p className="text-xs leading-relaxed text-slate-600">
            Status kepegawaian untuk <strong>{currentEmployee.fullName}</strong> ({user.email}) saat
            ini berstatus <strong>Nonaktif</strong>. Hubungi Admin HRD atau Super Admin untuk
            mengaktifkan kembali akses Anda.
          </p>
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer"
          >
            <LogOut className="h-3.5 w-3.5" />
            Keluar Akun
          </button>
        </div>
      </div>
    );
  }

  // Maintenance gate for non-admins when enabled by Super Admin
  if (appSettings?.maintenanceMode && !isAdmin) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md rounded-xl border border-amber-200 bg-white p-6 text-center space-y-4">
          <ShieldAlert className="mx-auto h-10 w-10 text-amber-600" />
          <h1 className="text-lg font-bold text-slate-900">
            Sistem Sedang Dalam Pemeliharaan
          </h1>
          <p className="text-xs leading-relaxed text-slate-600">
            Super Admin sedang mengaktifkan mode pemeliharaan sistem untuk sinkronisasi payroll
            atau audit keamanan. Silakan coba beberapa saat lagi.
          </p>
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer"
          >
            <LogOut className="h-3.5 w-3.5" />
            Keluar Akun
          </button>
        </div>
      </div>
    );
  }

  const roleLabel = isSuperAdmin
    ? 'Dasbor Super Admin'
    : isAdmin
    ? 'Dasbor Admin HRD'
    : 'Portal Karyawan';

  const showAdminSidebar = isAdmin && !mirroredEmployee;
  const pendingApprovalsCount =
    leaveRequests.filter((r) => r.status === 'menunggu').length +
    overtimeRequests.filter((o) => o.status === 'menunggu').length;
  const activeNavMeta = visibleNavItems.find((i) => i.id === activeSection) || visibleNavItems[0];

  const handleSelectSection = (id: AppSection) => {
    setActiveSection(id);
    setMobileDrawerOpen(false);
  };

  if (showAdminSidebar) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex">
        <OfflineIndicator />

        {/* Desktop Left Sidebar Dashboard (Super Admin & Admin HRD) */}
        <aside className="print:hidden hidden lg:flex lg:w-64 lg:flex-col lg:justify-between lg:sticky lg:top-0 lg:h-screen border-r border-slate-200 bg-white shrink-0">
          <div className="flex flex-col flex-1 overflow-y-auto">
            <div className="border-b border-slate-200 px-5 py-4">
              <a
                href="#top"
                onClick={(e) => {
                  e.preventDefault();
                  handleSelectSection('control');
                }}
                className="font-display text-lg font-bold tracking-tight text-slate-900 block"
              >
                Presensia Cloud
              </a>
              <p
                className={`mt-1 text-xs font-semibold ${
                  isSuperAdmin ? 'text-emerald-700' : 'text-slate-600'
                }`}
              >
                {roleLabel}
              </p>
              <p className="mt-0.5 font-mono text-[11px] text-slate-500 tabular-nums">
                {branches.length} Cabang Tersinkron
              </p>
            </div>

            <nav aria-label="Dasbor Samping Admin" className="flex-1 space-y-1 px-3 py-4">
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                const active = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectSection(item.id)}
                    className={`flex w-full min-h-[44px] items-center justify-between gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-semibold transition-colors cursor-pointer ${
                      active
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <span className="flex items-center gap-2.5 truncate">
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </span>
                    {item.id === 'control' && pendingApprovalsCount > 0 && (
                      <span
                        className={`font-mono text-[11px] tabular-nums ${
                          active ? 'text-emerald-300' : 'text-amber-700'
                        }`}
                      >
                        {pendingApprovalsCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="border-t border-slate-200 p-4 space-y-3">
            <div className="flex items-center gap-2.5 text-xs">
              {user.photoURL ? (
                <img
                  src={user.photoURL}
                  alt={user.displayName || 'Akun Google'}
                  referrerPolicy="no-referrer"
                  className="h-8 w-8 rounded-full border border-slate-200 object-cover shrink-0"
                />
              ) : (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-50">
                  <GoogleLogo className="h-4 w-4" />
                </div>
              )}
              <div className="min-w-0">
                <p className="font-semibold text-slate-900 truncate">
                  {user.displayName || user.email}
                </p>
                <p className="text-[11px] text-slate-500 truncate">{user.email}</p>
              </div>
            </div>
            <PWAInstallButton />
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={loggingIn}
                onClick={handleLogin}
                className="flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
                title="Pilih akun Google lain"
              >
                <GoogleLogo className="h-3.5 w-3.5 shrink-0" />
                Ganti
              </button>
              <button
                type="button"
                onClick={handleLogout}
                className="flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
              >
                <LogOut className="h-3.5 w-3.5" />
                Keluar
              </button>
            </div>
          </div>
        </aside>

        {/* Mobile/Tablet Slide-Over Side Drawer for Admin */}
        {mobileDrawerOpen && (
          <div className="print:hidden fixed inset-0 z-50 flex lg:hidden">
            <div
              className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs"
              onClick={() => setMobileDrawerOpen(false)}
            />
            <aside className="relative z-10 flex w-72 max-w-[82vw] flex-col justify-between bg-white border-r border-slate-200 h-full">
              <div className="flex flex-col flex-1 overflow-y-auto">
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3.5">
                  <div>
                    <p className="font-display text-base font-bold text-slate-900">
                      Presensia Cloud
                    </p>
                    <p className="text-[11px] font-semibold text-emerald-700">{roleLabel}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMobileDrawerOpen(false)}
                    className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 cursor-pointer"
                    aria-label="Tutup menu samping"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <nav className="flex-1 space-y-1 px-3 py-4">
                  {visibleNavItems.map((item) => {
                    const Icon = item.icon;
                    const active = activeSection === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleSelectSection(item.id)}
                        className={`flex w-full min-h-[44px] items-center justify-between gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-semibold transition-colors cursor-pointer ${
                          active
                            ? 'bg-slate-900 text-white'
                            : 'text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        <span className="flex items-center gap-2.5">
                          <Icon className="h-4 w-4 shrink-0" />
                          <span>{item.label}</span>
                        </span>
                        {item.id === 'control' && pendingApprovalsCount > 0 && (
                          <span className="font-mono text-[11px] tabular-nums">
                            {pendingApprovalsCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </nav>
              </div>

              <div className="border-t border-slate-200 p-4 space-y-2.5">
                <PWAInstallButton />
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex w-full min-h-[40px] items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Keluar
                </button>
              </div>
            </aside>
          </div>
        )}

        {/* Right Main Content Column */}
        <div className="flex-1 min-w-0 flex flex-col">
          <header className="print:hidden sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-md">
            <div className="flex h-13 lg:h-14 items-center justify-between gap-4 px-4 sm:px-6">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  type="button"
                  onClick={() => setMobileDrawerOpen(true)}
                  className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 lg:hidden cursor-pointer"
                  aria-label="Buka menu samping"
                >
                  <Menu className="h-4 w-4" />
                </button>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900 truncate">
                    {activeNavMeta.label}
                  </p>
                  <p className="text-[11px] text-slate-500 truncate lg:hidden">
                    {roleLabel} · {branches.length} Cabang
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0 text-xs text-slate-600">
                <span className="hidden sm:inline font-medium text-slate-900">
                  {user.displayName || user.email}
                </span>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="lg:hidden inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Keluar
                </button>
              </div>
            </div>
          </header>

          {activeToast && (
            <div className="print:hidden fixed right-4 top-16 z-50 w-full max-w-sm rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <Clock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  <div>
                    <p className="text-xs font-semibold text-slate-900">{activeToast.title}</p>
                    <p className="mt-0.5 text-xs text-slate-600">{activeToast.body}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveToast(null)}
                  className="rounded p-1 text-slate-400 hover:text-slate-600 cursor-pointer"
                  aria-label="Tutup notifikasi"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
            {seeding && (
              <div className="print:hidden mb-4 rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600">
                Menyiapkan sinkronisasi cloud multi-cabang dan enkripsi workspace...
              </div>
            )}

            {authError && (
              <div className="print:hidden mb-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800">
                {authError}
              </div>
            )}

            {activeSection === 'control' && (
              <AdminControlCenter
                currentUserUid={user.uid}
                currentUserName={user.displayName || user.email || 'Admin HRD'}
                isSuperAdmin={isSuperAdmin}
                admins={adminsList}
                adminInvites={adminInvites}
                appSettings={appSettings}
                branches={branches}
                employees={employees}
                leaveRequests={leaveRequests}
                overtimeRequests={overtimeRequests}
                mirroredEmployeeId={mirroredEmployeeId}
                onStartMirror={handleStartMirror}
                onStopMirror={() => setMirroredEmployeeId(null)}
              />
            )}

            {activeSection === 'analytics' && (
              <HRDAnalyticsDashboard
                branches={branches}
                employees={employees}
                attendance={attendance}
                payrollRuns={payrollRuns}
              />
            )}

            {activeSection === 'payroll' && (
              <PayrollAndTaxModule
                currentUserUid={user.uid}
                isAdmin={isAdmin}
                branches={branches}
                employees={employees}
                attendance={attendance}
                payrollRuns={payrollRuns}
                taxFilings={taxFilings}
              />
            )}

            {activeSection === 'branches' && (
              <BranchesAndSecurityModule
                currentUserUid={user.uid}
                isAdmin={isAdmin}
                branches={branches}
                employees={employees}
              />
            )}
          </main>

          {/* Mobile Bottom Nav for Admin */}
          <nav
            aria-label="Navigasi ponsel admin"
            className="print:hidden fixed bottom-0 left-0 right-0 z-40 h-14 border-t border-slate-200 bg-white/95 backdrop-blur-md lg:hidden"
          >
            <div
              className="grid h-full items-center"
              style={{ gridTemplateColumns: `repeat(${visibleNavItems.length}, minmax(0, 1fr))` }}
            >
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                const active = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectSection(item.id)}
                    className={`flex h-full min-h-[44px] flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                      active ? 'text-emerald-700' : 'text-slate-500 hover:text-slate-900'
                    }`}
                  >
                    <Icon className="h-4.5 w-4.5" />
                    <span className="truncate max-w-[60px]">{item.mobileLabel}</span>
                  </button>
                );
              })}
            </div>
          </nav>
        </div>
      </div>
    );
  }

  // KARYAWAN & MODE MIRRORING KARYAWAN:
  // Bilah navigasi di paling bawah (Beranda & Pengingat), dan Dasbor Logo Karyawan tepat di atas bilah navigasi.
  const employeeBottomNavItems: Array<{
    id: 'terminal' | 'reminders' | 'exit_mirror';
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    active: boolean;
    onClick: () => void;
  }> = [
    {
      id: 'terminal',
      label: 'Beranda',
      icon: Home,
      active: activeSection === 'terminal' && employeePortalTab === 'beranda',
      onClick: () => {
        setActiveSection('terminal');
        setEmployeePortalTab('beranda');
      },
    },
    {
      id: 'reminders',
      label: 'Pengingat',
      icon: Bell,
      active: activeSection === 'reminders',
      onClick: () => setActiveSection('reminders'),
    },
    ...(mirroredEmployee
      ? [
          {
            id: 'exit_mirror' as const,
            label: 'Kembali Admin',
            icon: ArrowLeft,
            active: false,
            onClick: handleStopMirror,
          },
        ]
      : []),
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <OfflineIndicator />

      {/* Compact Top Bar for Employee */}
      <header className="print:hidden sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-md">
        <div className="mx-auto flex h-13 lg:h-14 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3 min-w-0">
            <a
              href="#top"
              onClick={(e) => {
                e.preventDefault();
                setActiveSection('terminal');
                setEmployeePortalTab('beranda');
              }}
              className="font-display text-base sm:text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
            >
              Presensia Cloud
            </a>
            <span className="hidden sm:inline text-xs text-slate-400">·</span>
            <span className="hidden sm:inline text-xs text-slate-600 truncate">
              {mirroredEmployee
                ? `Mirroring: ${mirroredEmployee.fullName}`
                : user.displayName || user.email}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <PWAInstallButton />
            {mirroredEmployee ? (
              <button
                type="button"
                onClick={handleStopMirror}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Kembali ke Admin
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={loggingIn}
                  onClick={handleLogin}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  title="Ganti Akun Google"
                >
                  <GoogleLogo className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden sm:inline">Ganti Akun</span>
                </button>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 sm:px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Keluar
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Real-time Reminder Toast */}
      {activeToast && (
        <div className="print:hidden fixed right-4 top-16 z-50 w-full max-w-sm rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <div>
                <p className="text-xs font-semibold text-slate-900">{activeToast.title}</p>
                <p className="mt-0.5 text-xs text-slate-600">{activeToast.body}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setActiveToast(null)}
              className="rounded p-1 text-slate-400 hover:text-slate-600 cursor-pointer"
              aria-label="Tutup notifikasi"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Main Viewport */}
      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {seeding && (
          <div className="print:hidden mb-4 rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600">
            Menyiapkan sinkronisasi cloud multi-cabang dan enkripsi workspace...
          </div>
        )}

        {authError && (
          <div className="print:hidden mb-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800">
            {authError}
          </div>
        )}

        {activeSection === 'reminders' ? (
          <div className="pb-20">
            <ReminderCenter
              currentUserUid={user.uid}
              branches={branches}
              schedule={schedule}
              onTriggerTestNotification={(title, body) =>
                triggerReminderNotification(title, body, schedule?.soundEnabled ?? true)
              }
            />
          </div>
        ) : (
          <EmployeeTerminal
            currentUserUid={user.uid}
            currentEmployee={effectiveEmployee}
            branches={branches}
            myAttendance={effectiveAttendance}
            myPayrolls={effectivePayrolls}
            myLeaveRequests={effectiveLeaveRequests}
            myOvertimeRequests={effectiveOvertimeRequests}
            appSettings={appSettings}
            isMirroredView={Boolean(mirroredEmployee)}
            hasAdminSidebar={false}
            activeTab={employeePortalTab}
            onChangeTab={setEmployeePortalTab}
            onExitMirror={handleStopMirror}
          />
        )}
      </main>

      {/* Bilah Navigasi Karyawan di Paling Bawah (Dasbor Logo Karyawan ada tepat di atas bilah ini) */}
      <nav
        aria-label="Bilah navigasi karyawan"
        className="print:hidden fixed bottom-0 left-0 right-0 z-40 h-14 border-t border-slate-200 bg-white/95 backdrop-blur-md"
      >
        <div
          className="mx-auto grid h-full max-w-5xl items-center"
          style={{
            gridTemplateColumns: `repeat(${employeeBottomNavItems.length}, minmax(0, 1fr))`,
          }}
        >
          {employeeBottomNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={item.onClick}
                className={`flex h-full min-h-[44px] flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition-colors cursor-pointer ${
                  item.active
                    ? 'text-emerald-700'
                    : item.id === 'exit_mirror'
                    ? 'text-amber-800 hover:text-amber-950'
                    : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                <Icon className="h-4.5 w-4.5" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

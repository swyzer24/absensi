import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CalendarOff,
  Camera,
  CheckCircle2,
  Clock,
  Download,
  Eye,
  Lock,
  MapPin,
  Megaphone,
  Navigation,
  Printer,
  Receipt,
  RefreshCw,
  ShieldCheck,
  Timer,
  Trash2,
  Unlock,
  UserCheck,
} from 'lucide-react';
import {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  AppSettings,
  AttendanceRecord,
  Branch,
  Employee,
  EmployeeDecryptedPII,
  EmployeeEncryptedPII,
  EmployeePortalTab,
  LeaveRequest,
  LeaveType,
  OvertimeRequest,
  PayrollRun,
} from '../types';
import {
  computeSHA256,
  decryptEmployeePII,
  encryptEmployeePII,
  getActiveVaultPassphrase,
} from '../utils/encryption';
import {
  calculateDistanceMeters,
  calculateLateMinutes,
  calculateOvertimeMinutes,
  downloadCSV,
  formatRupiah,
  formatTimeShort,
  getCurrentPeriodString,
  getTodayDateString,
} from '../utils/geoAndPayroll';
import { EmployeeAttendanceMap } from './EmployeeAttendanceMap';

interface EmployeeTerminalProps {
  currentUserUid: string;
  currentEmployee: Employee | null;
  branches: Branch[];
  myAttendance: AttendanceRecord[];
  myPayrolls: PayrollRun[];
  myLeaveRequests: LeaveRequest[];
  myOvertimeRequests: OvertimeRequest[];
  appSettings: AppSettings | null;
  isMirroredView?: boolean;
  hasAdminSidebar?: boolean;
  activeTab?: EmployeePortalTab;
  onChangeTab?: (tab: EmployeePortalTab) => void;
  onExitMirror?: () => void;
}

const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  izin_sakit: 'Izin Sakit',
  izin_pribadi: 'Izin Pribadi',
  cuti_tahunan: 'Cuti Tahunan',
  dinas_luar: 'Dinas Luar',
};

function computeDaysInclusive(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return 1;
  const diff = Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  return Math.max(1, Math.min(90, diff));
}

function computeHoursDiff(startHHMM: string, endHHMM: string): number {
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);
  if ([sh, sm, eh, em].some(Number.isNaN)) return 1;
  let diffMins = eh * 60 + em - (sh * 60 + sm);
  if (diffMins <= 0) diffMins += 24 * 60;
  const hrs = Math.round((diffMins / 60) * 10) / 10;
  return Math.max(0.5, Math.min(16, hrs));
}

export const EmployeeTerminal: React.FC<EmployeeTerminalProps> = ({
  currentUserUid,
  currentEmployee,
  branches,
  myAttendance,
  myPayrolls,
  myLeaveRequests,
  myOvertimeRequests,
  appSettings,
  isMirroredView = false,
  hasAdminSidebar = false,
  activeTab: controlledTab,
  onChangeTab,
  onExitMirror,
}) => {
  const [internalTab, setInternalTab] = useState<EmployeePortalTab>('beranda');
  const activeTab = controlledTab ?? internalTab;
  const setActiveTab = (tab: EmployeePortalTab) => {
    if (onChangeTab) {
      onChangeTab(tab);
    } else {
      setInternalTab(tab);
    }
  };
  const [absenSubView, setAbsenSubView] = useState<'terminal' | 'riwayat'>('terminal');
  const [now, setNow] = useState(() => new Date());
  const [selectedBranchId, setSelectedBranchId] = useState<string>('');
  const [gpsState, setGpsState] = useState<{
    lat: number | null;
    lng: number | null;
    accuracy: number | null;
    loading: boolean;
    error: string | null;
    simulated: boolean;
  }>({
    lat: null,
    lng: null,
    accuracy: null,
    loading: false,
    error: null,
    simulated: false,
  });

  // Camera & face validation state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [verifyingFace, setVerifyingFace] = useState(false);
  const [faceResult, setFaceResult] = useState<{
    verified: boolean;
    confidence: number;
    reason: string;
    faceHash: string;
    engine?: string;
  } | null>(null);

  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Leave request form state
  const [leaveForm, setLeaveForm] = useState<{
    leaveType: LeaveType;
    startDate: string;
    endDate: string;
    reason: string;
  }>(() => {
    const today = getTodayDateString();
    return {
      leaveType: 'izin_pribadi',
      startDate: today,
      endDate: today,
      reason: '',
    };
  });
  const [submittingLeave, setSubmittingLeave] = useState(false);

  // Overtime request form state
  const [overtimeForm, setOvertimeForm] = useState(() => ({
    date: getTodayDateString(),
    startTime: '18:00',
    endTime: '20:00',
    reason: '',
  }));
  const [submittingOvertime, setSubmittingOvertime] = useState(false);

  // Payslip period selection
  const [selectedPayrollId, setSelectedPayrollId] = useState<string>('');

  // Encrypted PII vault state
  const [piiLoading, setPiiLoading] = useState(false);
  const [piiDecrypted, setPiiDecrypted] = useState<EmployeeDecryptedPII | null>(null);
  const [piiCipherMeta, setPiiCipherMeta] = useState<{
    ciphertextPreview: string;
    keyFingerprint: string;
  } | null>(null);
  const [piiUnlocked, setPiiUnlocked] = useState(false);
  const [piiSaving, setPiiSaving] = useState(false);

  // Reset vault & branch when switching mirrored employee
  useEffect(() => {
    setPiiUnlocked(false);
    setPiiDecrypted(null);
    setPiiCipherMeta(null);
    setFeedback(null);
    if (currentEmployee?.branchId) {
      setSelectedBranchId(currentEmployee.branchId);
    }
  }, [currentEmployee?.id, currentEmployee?.branchId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedBranchId && branches.length > 0) {
      const empBranch = currentEmployee?.branchId;
      const found = branches.find((b) => b.id === empBranch && b.active) || branches[0];
      setSelectedBranchId(found.id);
    }
  }, [branches, currentEmployee, selectedBranchId]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const requireGps = appSettings?.requireGpsGeofence ?? true;
  const requireFace = appSettings?.requireFaceVerification ?? true;
  const allowSelfService = appSettings?.allowEmployeeSelfService ?? true;
  const lateTolerance = appSettings?.lateToleranceMinutes ?? 5;
  const maxOvertimePerMonth = appSettings?.maxOvertimeHoursPerMonth ?? 40;
  const companyName = appSettings?.companyName || 'PT Presensia Nusantara Teknologi';

  const activeBranch = useMemo(
    () => branches.find((b) => b.id === selectedBranchId) || branches[0] || null,
    [branches, selectedBranchId]
  );

  const assignedBranch = useMemo(
    () => branches.find((b) => b.id === currentEmployee?.branchId) || activeBranch,
    [branches, currentEmployee?.branchId, activeBranch]
  );

  const todayStr = getTodayDateString(now);
  const todayRecord = useMemo(
    () =>
      myAttendance.find(
        (r) => r.date === todayStr && (!currentEmployee || r.employeeId === currentEmployee.id)
      ) || null,
    [myAttendance, todayStr, currentEmployee]
  );

  const distanceMeters = useMemo(() => {
    if (gpsState.lat === null || gpsState.lng === null || !activeBranch) return null;
    return calculateDistanceMeters(
      gpsState.lat,
      gpsState.lng,
      activeBranch.latitude,
      activeBranch.longitude
    );
  }, [gpsState.lat, gpsState.lng, activeBranch]);

  const withinGeofence =
    distanceMeters !== null && activeBranch ? distanceMeters <= activeBranch.radiusMeters : false;

  const acquireGps = () => {
    if (!navigator.geolocation) {
      setGpsState((prev) => ({
        ...prev,
        loading: false,
        error: 'Perangkat tidak mendukung GPS Geolocation.',
      }));
      return;
    }

    setGpsState((prev) => ({ ...prev, loading: true, error: null }));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsState({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
          loading: false,
          error: null,
          simulated: false,
        });
      },
      (err) => {
        setGpsState((prev) => ({
          ...prev,
          loading: false,
          error:
            err.code === 1
              ? 'Izin lokasi ditolak browser. Aktifkan izin lokasi atau gunakan koordinat uji cabang untuk simulasi.'
              : 'Sinyal GPS tidak dapat dijangkau. Coba lagi di ruang terbuka.',
        }));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  useEffect(() => {
    acquireGps();
  }, []);

  const useBranchTestCoordinates = () => {
    if (!activeBranch) return;
    setGpsState({
      lat: Number((activeBranch.latitude + 0.00012).toFixed(6)),
      lng: Number((activeBranch.longitude - 0.00009).toFixed(6)),
      accuracy: 12,
      loading: false,
      error: null,
      simulated: true,
    });
  };

  const startCamera = async () => {
    setCameraError(null);
    setCapturedImage(null);
    setFaceResult(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraActive(true);
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      });
    } catch {
      setCameraError(
        'Kamera tidak dapat diakses. Berikan izin kamera pada browser ponsel/desktop Anda.'
      );
      setCameraActive(false);
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  };

  const captureAndVerifyFace = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
    setCapturedImage(dataUrl);
    stopCamera();

    setVerifyingFace(true);
    try {
      const res = await fetch('/api/verify-face', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: dataUrl,
          employeeName: currentEmployee?.fullName || 'Karyawan',
        }),
      });
      const json = (await res.json()) as {
        verified: boolean;
        confidence: number;
        reason: string;
        faceHash: string;
        engine?: string;
      };
      setFaceResult(json);
    } catch {
      setFaceResult({
        verified: false,
        confidence: 0,
        reason: 'Gagal menghubungi layanan verifikasi wajah.',
        faceHash: '',
      });
    } finally {
      setVerifyingFace(false);
    }
  };

  const handleClockIn = async () => {
    if (isMirroredView) return;
    if (!currentEmployee || !activeBranch) {
      setFeedback({ type: 'err', text: 'Pastikan data karyawan dan cabang telah termuat.' });
      return;
    }
    if (requireGps && (gpsState.lat === null || gpsState.lng === null || !withinGeofence)) {
      setFeedback({
        type: 'err',
        text:
          gpsState.lat === null
            ? 'Koordinat GPS wajib aktif sebelum melakukan absen masuk.'
            : `Anda berada ${distanceMeters}m dari lokasi cabang (maksimal ${activeBranch.radiusMeters}m).`,
      });
      return;
    }
    if (requireFace && !faceResult?.verified) {
      setFeedback({
        type: 'err',
        text: 'Validasi foto wajah wajib berhasil sebelum melakukan absen masuk.',
      });
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    const attId = `att_${currentEmployee.id}_${todayStr.replace(/-/g, '')}`;
    const clockInIso = new Date().toISOString();
    const rawLate = calculateLateMinutes(clockInIso, activeBranch.shiftStart);
    const effectiveLate = rawLate <= lateTolerance ? 0 : rawLate;
    const fallbackHash = await computeSHA256(`policy_optional:${currentEmployee.id}:${clockInIso}`);

    try {
      await setDoc(doc(db, 'attendance', attId), {
        id: attId,
        userId: currentUserUid,
        employeeId: currentEmployee.id,
        employeeName: currentEmployee.fullName,
        branchId: activeBranch.id,
        branchName: activeBranch.name,
        date: todayStr,
        clockInTime: clockInIso,
        clockInLat: gpsState.lat ?? activeBranch.latitude,
        clockInLng: gpsState.lng ?? activeBranch.longitude,
        clockInDistanceMeters: distanceMeters ?? 0,
        faceVerified: Boolean(faceResult?.verified),
        faceConfidence: faceResult?.confidence ?? 0,
        faceHash: faceResult?.faceHash || fallbackHash,
        faceThumbnail: capturedImage && capturedImage.length < 60000 ? capturedImage : '',
        status: effectiveLate > 0 ? 'terlambat' : 'tepat_waktu',
        lateMinutes: effectiveLate,
        overtimeMinutes: 0,
        notes: notes.trim().slice(0, 240),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setFeedback({
        type: 'ok',
        text:
          effectiveLate > 0
            ? `Absen masuk tercatat pada ${formatTimeShort(clockInIso)} (terlambat ${effectiveLate} menit).`
            : `Absen masuk tepat waktu tercatat pada ${formatTimeShort(clockInIso)}.`,
      });
      setNotes('');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `attendance/${attId}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClockOut = async () => {
    if (isMirroredView) return;
    if (!todayRecord || !activeBranch) return;
    if (requireGps && (gpsState.lat === null || gpsState.lng === null || !withinGeofence)) {
      setFeedback({
        type: 'err',
        text: `Anda berada di luar radius geofence cabang (${distanceMeters ?? '-'}m).`,
      });
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    const clockOutIso = new Date().toISOString();
    const overtimeMinutes = calculateOvertimeMinutes(clockOutIso, activeBranch.shiftEnd);
    const nextStatus = overtimeMinutes > 0 ? 'lembur' : todayRecord.status;

    try {
      await updateDoc(doc(db, 'attendance', todayRecord.id), {
        clockOutTime: clockOutIso,
        clockOutLat: gpsState.lat ?? activeBranch.latitude,
        clockOutLng: gpsState.lng ?? activeBranch.longitude,
        clockOutDistanceMeters: distanceMeters ?? 0,
        overtimeMinutes,
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      setFeedback({
        type: 'ok',
        text:
          overtimeMinutes > 0
            ? `Absen pulang tercatat pada ${formatTimeShort(clockOutIso)} dengan lembur ${overtimeMinutes} menit.`
            : `Absen pulang berhasil dicatat pada ${formatTimeShort(clockOutIso)}.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `attendance/${todayRecord.id}`);
    } finally {
      setSubmitting(false);
    }
  };

  // Submit Leave Request
  const handleSubmitLeave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isMirroredView || !currentEmployee) return;
    if (!allowSelfService) {
      setFeedback({ type: 'err', text: 'Pengajuan mandiri sedang dinonaktifkan oleh Admin HRD.' });
      return;
    }
    if (leaveForm.endDate < leaveForm.startDate) {
      setFeedback({ type: 'err', text: 'Tanggal selesai tidak boleh lebih awal dari tanggal mulai.' });
      return;
    }

    const reqId = `lv_${currentEmployee.id}_${Date.now()}`;
    const totalDays = computeDaysInclusive(leaveForm.startDate, leaveForm.endDate);
    setSubmittingLeave(true);
    setFeedback(null);

    try {
      await setDoc(doc(db, 'leaveRequests', reqId), {
        id: reqId,
        userId: currentUserUid,
        employeeId: currentEmployee.id,
        employeeName: currentEmployee.fullName,
        branchId: currentEmployee.branchId,
        leaveType: leaveForm.leaveType,
        startDate: leaveForm.startDate,
        endDate: leaveForm.endDate,
        totalDays,
        reason: leaveForm.reason.trim().slice(0, 300),
        status: 'menunggu',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setLeaveForm((p) => ({ ...p, reason: '' }));
      setFeedback({
        type: 'ok',
        text: `Pengajuan ${LEAVE_TYPE_LABELS[leaveForm.leaveType]} (${totalDays} hari) berhasil dikirim ke HRD.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `leaveRequests/${reqId}`);
    } finally {
      setSubmittingLeave(false);
    }
  };

  const handleCancelLeave = async (reqId: string) => {
    if (isMirroredView) return;
    try {
      await deleteDoc(doc(db, 'leaveRequests', reqId));
      setFeedback({ type: 'ok', text: 'Pengajuan izin/cuti yang masih menunggu telah dibatalkan.' });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `leaveRequests/${reqId}`);
    }
  };

  // Submit Overtime Request
  const currentPeriod = getCurrentPeriodString(now);
  const usedOvertimeHoursThisMonth = useMemo(() => {
    return myOvertimeRequests
      .filter((o) => o.date.startsWith(currentPeriod) && o.status !== 'ditolak')
      .reduce((sum, o) => sum + o.durationHours, 0);
  }, [myOvertimeRequests, currentPeriod]);

  const handleSubmitOvertime = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isMirroredView || !currentEmployee) return;
    if (!allowSelfService) {
      setFeedback({ type: 'err', text: 'Pengajuan mandiri sedang dinonaktifkan oleh Admin HRD.' });
      return;
    }

    const durationHours = computeHoursDiff(overtimeForm.startTime, overtimeForm.endTime);
    if (usedOvertimeHoursThisMonth + durationHours > maxOvertimePerMonth) {
      setFeedback({
        type: 'err',
        text: `Total lembur bulan ini akan melebihi batas kebijakan (${maxOvertimePerMonth} jam).`,
      });
      return;
    }

    const otId = `ot_${currentEmployee.id}_${Date.now()}`;
    setSubmittingOvertime(true);
    setFeedback(null);

    try {
      await setDoc(doc(db, 'overtimeRequests', otId), {
        id: otId,
        userId: currentUserUid,
        employeeId: currentEmployee.id,
        employeeName: currentEmployee.fullName,
        branchId: currentEmployee.branchId,
        date: overtimeForm.date,
        startTime: overtimeForm.startTime,
        endTime: overtimeForm.endTime,
        durationHours,
        reason: overtimeForm.reason.trim().slice(0, 300),
        status: 'menunggu',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setOvertimeForm((p) => ({ ...p, reason: '' }));
      setFeedback({
        type: 'ok',
        text: `Pengajuan lembur ${durationHours} jam untuk tanggal ${overtimeForm.date} telah dikirim ke HRD.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `overtimeRequests/${otId}`);
    } finally {
      setSubmittingOvertime(false);
    }
  };

  const handleCancelOvertime = async (otId: string) => {
    if (isMirroredView) return;
    try {
      await deleteDoc(doc(db, 'overtimeRequests', otId));
      setFeedback({ type: 'ok', text: 'Pengajuan lembur yang masih menunggu telah dibatalkan.' });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `overtimeRequests/${otId}`);
    }
  };

  // Encrypted PII Vault
  const loadMyEncryptedPII = async () => {
    if (!currentEmployee) return;
    setPiiLoading(true);
    try {
      const piiRef = doc(db, 'employees', currentEmployee.id, 'private', 'pii');
      const snap = await getDoc(piiRef);
      if (snap.exists()) {
        const enc = snap.data() as EmployeeEncryptedPII;
        setPiiCipherMeta({
          ciphertextPreview: enc.ciphertext.slice(0, 32) + '...',
          keyFingerprint: enc.keyFingerprint,
        });
        const decrypted = await decryptEmployeePII(enc, getActiveVaultPassphrase());
        setPiiDecrypted(decrypted);
        setPiiUnlocked(true);
      } else {
        setPiiDecrypted({
          nik: '',
          npwp: '',
          bankName: 'BCA',
          bankAccount: '',
          emergencyContact: '',
        });
        setPiiUnlocked(true);
      }
    } catch {
      setFeedback({
        type: 'err',
        text: 'Gagal mendekripsi data pribadi. Periksa kunci enkripsi AES-256 pada menu Keamanan.',
      });
    } finally {
      setPiiLoading(false);
    }
  };

  const saveMyEncryptedPII = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isMirroredView || !currentEmployee || !piiDecrypted) return;
    setPiiSaving(true);
    try {
      const encrypted = await encryptEmployeePII(
        piiDecrypted,
        currentEmployee.uid || currentUserUid,
        getActiveVaultPassphrase()
      );
      await setDoc(doc(db, 'employees', currentEmployee.id, 'private', 'pii'), {
        ...encrypted,
        updatedAt: serverTimestamp(),
      });
      setPiiCipherMeta({
        ciphertextPreview: encrypted.ciphertext.slice(0, 32) + '...',
        keyFingerprint: encrypted.keyFingerprint,
      });
      setFeedback({
        type: 'ok',
        text: 'Data NIK, NPWP, dan Rekening berhasil dienkripsi dengan AES-256-GCM dan disinkronkan ke cloud.',
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `employees/${currentEmployee.id}/private/pii`);
    } finally {
      setPiiSaving(false);
    }
  };

  const myMonthlyAttendance = useMemo(
    () =>
      myAttendance
        .filter(
          (r) =>
            r.date.startsWith(currentPeriod) &&
            (!currentEmployee || r.employeeId === currentEmployee.id)
        )
        .sort((a, b) => b.date.localeCompare(a.date)),
    [myAttendance, currentPeriod, currentEmployee]
  );

  const sortedPayrolls = useMemo(
    () =>
      myPayrolls
        .filter((p) => !currentEmployee || p.employeeId === currentEmployee.id)
        .sort((a, b) => b.period.localeCompare(a.period)),
    [myPayrolls, currentEmployee]
  );

  const activePayslip = useMemo(() => {
    if (sortedPayrolls.length === 0) return null;
    return sortedPayrolls.find((p) => p.id === selectedPayrollId) || sortedPayrolls[0];
  }, [sortedPayrolls, selectedPayrollId]);

  const sortedLeaves = useMemo(
    () => [...myLeaveRequests].sort((a, b) => b.startDate.localeCompare(a.startDate)),
    [myLeaveRequests]
  );

  const sortedOvertimes = useMemo(
    () => [...myOvertimeRequests].sort((a, b) => b.date.localeCompare(a.date)),
    [myOvertimeRequests]
  );

  const pendingLeavesCount = myLeaveRequests.filter((l) => l.status === 'menunggu').length;
  const pendingOvertimeCount = myOvertimeRequests.filter((o) => o.status === 'menunggu').length;

  const dockIcons: Array<{
    id: EmployeePortalTab;
    shortLabel: string;
    title: string;
    badgeText: string;
    icon: React.ComponentType<{ className?: string }>;
    accentClass: string;
  }> = [
    {
      id: 'absen',
      shortLabel: 'Absen',
      title: 'Absen GPS, Wajah & Riwayat',
      badgeText: !todayRecord
        ? 'Belum Masuk'
        : todayRecord.clockOutTime
        ? 'Selesai'
        : formatTimeShort(todayRecord.clockInTime),
      icon: MapPin,
      accentClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    },
    {
      id: 'izin',
      shortLabel: 'Izin & Cuti',
      title: 'Pengajuan Izin & Cuti',
      badgeText:
        pendingLeavesCount > 0 ? `${pendingLeavesCount} Tunggu` : `${myLeaveRequests.length} Data`,
      icon: CalendarOff,
      accentClass: 'bg-amber-50 text-amber-700 border-amber-200',
    },
    {
      id: 'slip_gaji',
      shortLabel: 'Slip Gaji',
      title: 'Slip Gaji Digital',
      badgeText: activePayslip ? activePayslip.period : 'Belum Ada',
      icon: Receipt,
      accentClass: 'bg-sky-50 text-sky-700 border-sky-200',
    },
    {
      id: 'lembur',
      shortLabel: 'Lembur',
      title: 'Pengajuan Lembur',
      badgeText:
        pendingOvertimeCount > 0
          ? `${pendingOvertimeCount} Tunggu`
          : `${usedOvertimeHoursThisMonth}j/${maxOvertimePerMonth}j`,
      icon: Timer,
      accentClass: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    },
  ];

  const handlePrintPayslip = () => {
    window.print();
  };

  const handleDownloadPayslipCsv = () => {
    if (!activePayslip || !currentEmployee) return;
    downloadCSV(
      `slip-gaji-${activePayslip.period}-${currentEmployee.employeeCode}.csv`,
      ['Komponen', 'Nilai'],
      [
        ['Perusahaan', companyName],
        ['Periode', activePayslip.period],
        ['Kode Karyawan', currentEmployee.employeeCode],
        ['Nama Lengkap', currentEmployee.fullName],
        ['Jabatan', currentEmployee.position],
        ['Hari Hadir', activePayslip.presentDays],
        ['Gaji Pokok (IDR)', activePayslip.baseSalary],
        ['Tunjangan Kehadiran (IDR)', activePayslip.allowances],
        ['Upah Lembur (IDR)', activePayslip.overtimePay],
        ['Potongan Terlambat (IDR)', activePayslip.lateDeduction],
        ['Iuran BPJS 3% (IDR)', activePayslip.bpjsDeduction],
        [`PPh 21 TER ${activePayslip.pph21Rate}% (IDR)`, activePayslip.pph21Amount],
        ['Gaji Bersih / Take-Home Pay (IDR)', activePayslip.netSalary],
      ]
    );
  };

  return (
    <div
      className={`space-y-4 sm:space-y-6 ${
        hasAdminSidebar ? 'pb-36 lg:pb-28' : 'pb-36 sm:pb-36'
      }`}
    >
      {/* Mirroring Banner when Admin HRD / Super Admin previews an employee */}
      {isMirroredView && (
        <section className="print:hidden flex flex-col gap-2.5 rounded-xl border border-amber-300 bg-amber-50 p-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5">
            <Eye className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" />
            <div>
              <p className="text-xs font-bold text-amber-950">
                Mode Mirroring: {currentEmployee?.fullName || 'Karyawan'} (
                {currentEmployee?.employeeCode || '-'})
              </p>
              <p className="text-[11px] text-amber-800">
                Pratinjau tampilan ponsel karyawan. Aksi ubah/kirim data dinonaktifkan.
              </p>
            </div>
          </div>
          {onExitMirror && (
            <button
              type="button"
              onClick={onExitMirror}
              className="inline-flex min-h-[40px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-amber-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-amber-800 cursor-pointer"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Kembali ke Admin
            </button>
          )}
        </section>
      )}

      {/* Global Announcement Banner controlled by Super Admin / HRD */}
      {appSettings?.announcementBanner && (
        <div className="print:hidden flex items-start gap-2.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs text-slate-700">
          <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <p className="leading-snug">
            <span className="font-semibold text-slate-900">Info HRD: </span>
            <span>{appSettings.announcementBanner}</span>
          </p>
        </div>
      )}

      {/* Compact Mobile-First Employee Identity + Real-time Clock Header */}
      <section className="print:hidden rounded-xl border border-slate-200 bg-white p-3.5 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {currentEmployee?.avatarUrl ? (
              <img
                src={currentEmployee.avatarUrl}
                alt={currentEmployee.fullName}
                referrerPolicy="no-referrer"
                className="h-11 w-11 sm:h-13 sm:w-13 rounded-full object-cover border border-slate-200 shrink-0"
              />
            ) : (
              <div className="flex h-11 w-11 sm:h-13 sm:w-13 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-xs font-bold text-slate-700">
                {(currentEmployee?.fullName || 'KP')
                  .split(' ')
                  .slice(0, 2)
                  .map((s) => s[0])
                  .join('')}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-slate-500 truncate">
                {currentEmployee
                  ? `${currentEmployee.employeeCode} · ${currentEmployee.position}`
                  : 'Portal Karyawan'}
              </p>
              <h1 className="text-base sm:text-xl font-bold tracking-tight text-slate-900 truncate">
                {currentEmployee?.fullName || 'Karyawan Presensia'}
              </h1>
            </div>
          </div>

          <div className="text-right shrink-0">
            <span className="block font-mono text-lg sm:text-2xl font-bold tracking-tight text-slate-900 tabular-nums">
              {now.toLocaleTimeString('id-ID', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
              })}
            </span>
            <span className="block text-[11px] font-semibold text-emerald-700">
              {!todayRecord
                ? 'Belum Masuk'
                : todayRecord.clockOutTime
                ? `Selesai ${formatTimeShort(todayRecord.clockOutTime)}`
                : `Masuk ${formatTimeShort(todayRecord.clockInTime)}`}
            </span>
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5 text-[11px] text-slate-500">
          <span>
            {now.toLocaleDateString('id-ID', {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          </span>
          <span className="font-mono tabular-nums">
            Shift {activeBranch?.shiftStart || '08:30'}–{activeBranch?.shiftEnd || '17:30'} ·{' '}
            {assignedBranch?.code || 'HQ'}
          </span>
        </div>
      </section>

      {feedback && (
        <div
          role="alert"
          className={`print:hidden flex items-start gap-3 rounded-xl border p-4 text-xs ${
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

      {/* VIEW 0: BERANDA TERPADU (Ringkasan + Cabang + Pengajuan + Brankas AES-256) */}
      {(activeTab === 'beranda' || activeTab === 'privasi') && (
        <div className="space-y-4 sm:space-y-6">
          <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3.5">
            <button
              type="button"
              onClick={() => {
                setAbsenSubView('terminal');
                setActiveTab('absen');
              }}
              className="rounded-xl border border-slate-200 bg-white p-3.5 sm:p-4 text-left hover:border-emerald-500 transition-colors cursor-pointer"
            >
              <span className="block text-[11px] text-slate-500">Hadir Bulan Ini</span>
              <span className="mt-1 block font-mono text-xl sm:text-2xl font-bold text-slate-900 tabular-nums">
                {myMonthlyAttendance.length} Hari
              </span>
              <span className="mt-0.5 block text-[11px] text-emerald-700 font-medium">
                {!todayRecord ? 'Tap untuk Absen' : 'Lihat Absensi'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('izin')}
              className="rounded-xl border border-slate-200 bg-white p-3.5 sm:p-4 text-left hover:border-emerald-500 transition-colors cursor-pointer"
            >
              <span className="block text-[11px] text-slate-500">Izin & Cuti</span>
              <span className="mt-1 block font-mono text-xl sm:text-2xl font-bold text-slate-900 tabular-nums">
                {myLeaveRequests.length}
              </span>
              <span className="mt-0.5 block text-[11px] text-amber-700 font-medium">
                {pendingLeavesCount} Menunggu
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('lembur')}
              className="rounded-xl border border-slate-200 bg-white p-3.5 sm:p-4 text-left hover:border-emerald-500 transition-colors cursor-pointer"
            >
              <span className="block text-[11px] text-slate-500">Lembur {currentPeriod}</span>
              <span className="mt-1 block font-mono text-xl sm:text-2xl font-bold text-slate-900 tabular-nums">
                {usedOvertimeHoursThisMonth}/{maxOvertimePerMonth}j
              </span>
              <span className="mt-0.5 block text-[11px] text-slate-600 font-medium">
                {pendingOvertimeCount} Menunggu
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('slip_gaji')}
              className="rounded-xl border border-slate-200 bg-white p-3.5 sm:p-4 text-left hover:border-emerald-500 transition-colors cursor-pointer"
            >
              <span className="block text-[11px] text-slate-500">Gaji Bersih</span>
              <span className="mt-1 block font-mono text-base sm:text-xl font-bold text-emerald-700 tabular-nums truncate">
                {activePayslip ? formatRupiah(activePayslip.netSalary) : 'Belum Terbit'}
              </span>
              <span className="mt-0.5 block text-[11px] text-slate-600 font-medium">
                {activePayslip ? `Periode ${activePayslip.period}` : 'Buka Slip Gaji'}
              </span>
            </button>
          </section>

          {/* Cabang & Aksi Cepat Absen */}
          <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <Building2 className="mt-0.5 h-4.5 w-4.5 shrink-0 text-emerald-600" />
              <div>
                <p className="text-xs sm:text-sm font-semibold text-slate-900">
                  {assignedBranch?.name || 'Kantor Pusat'} ({assignedBranch?.code || 'HQ'})
                </p>
                <p className="text-[11px] sm:text-xs text-slate-500">
                  Radius Geofence {assignedBranch?.radiusMeters ?? 250}m · Toleransi Telat{' '}
                  {lateTolerance} menit
                </p>
                {assignedBranch && (
                  <p className="mt-0.5 font-mono text-[10px] text-slate-400 tabular-nums">
                    Google Maps: {assignedBranch.latitude.toFixed(5)},{' '}
                    {assignedBranch.longitude.toFixed(5)}
                  </p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setAbsenSubView('terminal');
                setActiveTab('absen');
              }}
              className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 cursor-pointer"
            >
              <MapPin className="h-3.5 w-3.5" />
              {!todayRecord
                ? 'Buka Peta & Absen Masuk'
                : !todayRecord.clockOutTime
                ? 'Buka Peta & Absen Pulang'
                : 'Lihat Peta & Absensi'}
            </button>
          </section>

          {/* Ringkasan Pengajuan & Slip Gaji Terakhir */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 lg:col-span-6 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs sm:text-sm font-semibold text-slate-900">
                  Pengajuan Izin & Lembur Terbaru
                </h3>
                <button
                  type="button"
                  onClick={() => setActiveTab('izin')}
                  className="text-xs font-semibold text-emerald-700 hover:underline cursor-pointer"
                >
                  Kelola
                </button>
              </div>
              {sortedLeaves.length === 0 && sortedOvertimes.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-200 p-4 text-xs text-slate-500">
                  Belum ada pengajuan izin atau lembur tercatat.
                </p>
              ) : (
                <div className="divide-y divide-slate-100 text-xs">
                  {sortedLeaves.slice(0, 2).map((l) => (
                    <div key={l.id} className="flex items-center justify-between py-2 gap-3">
                      <div>
                        <p className="font-semibold text-slate-900">
                          {LEAVE_TYPE_LABELS[l.leaveType]} ({l.totalDays} hr)
                        </p>
                        <p className="font-mono text-[11px] text-slate-500 tabular-nums">
                          {l.startDate} s/d {l.endDate}
                        </p>
                      </div>
                      <span
                        className={`font-semibold ${
                          l.status === 'disetujui'
                            ? 'text-emerald-700'
                            : l.status === 'ditolak'
                            ? 'text-rose-700'
                            : 'text-amber-700'
                        }`}
                      >
                        {l.status === 'menunggu'
                          ? 'Menunggu'
                          : l.status === 'disetujui'
                          ? 'Disetujui'
                          : 'Ditolak'}
                      </span>
                    </div>
                  ))}
                  {sortedOvertimes.slice(0, 2).map((o) => (
                    <div key={o.id} className="flex items-center justify-between py-2 gap-3">
                      <div>
                        <p className="font-semibold text-slate-900">
                          Lembur ({o.durationHours} Jam)
                        </p>
                        <p className="font-mono text-[11px] text-slate-500 tabular-nums">
                          {o.date} · {o.startTime}–{o.endTime}
                        </p>
                      </div>
                      <span
                        className={`font-semibold ${
                          o.status === 'disetujui'
                            ? 'text-emerald-700'
                            : o.status === 'ditolak'
                            ? 'text-rose-700'
                            : 'text-amber-700'
                        }`}
                      >
                        {o.status === 'menunggu'
                          ? 'Menunggu'
                          : o.status === 'disetujui'
                          ? 'Disetujui'
                          : 'Ditolak'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Brankas Data Pribadi AES-256-GCM digabung langsung ke Beranda agar ringkas di HP */}
            <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 lg:col-span-6 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xs sm:text-sm font-semibold text-slate-900">
                    Data Pribadi & Rekening (AES-256)
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    NIK, NPWP & nomor rekening terenkripsi di perangkat.
                  </p>
                </div>
                <ShieldCheck className="h-4.5 w-4.5 shrink-0 text-emerald-600" />
              </div>

              {!piiUnlocked ? (
                <button
                  type="button"
                  onClick={loadMyEncryptedPII}
                  disabled={piiLoading || !currentEmployee}
                  className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100 cursor-pointer"
                >
                  {piiLoading ? (
                    'Mendekripsi...'
                  ) : (
                    <>
                      <Unlock className="h-3.5 w-3.5 text-emerald-600" />
                      Buka Brankas NIK, NPWP & Rekening
                    </>
                  )}
                </button>
              ) : (
                <form onSubmit={saveMyEncryptedPII} className="space-y-2.5">
                  {piiCipherMeta && (
                    <div className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-[10px] font-mono text-slate-500 truncate">
                      Kunci: {piiCipherMeta.keyFingerprint} · {piiCipherMeta.ciphertextPreview}
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-700">NIK</label>
                      <input
                        type="text"
                        required
                        disabled={isMirroredView}
                        value={piiDecrypted?.nik || ''}
                        onChange={(e) =>
                          setPiiDecrypted((p) => (p ? { ...p, nik: e.target.value } : p))
                        }
                        className="mt-0.5 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 py-1 font-mono text-xs text-slate-900 disabled:bg-slate-50"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-700">NPWP</label>
                      <input
                        type="text"
                        required
                        disabled={isMirroredView}
                        value={piiDecrypted?.npwp || ''}
                        onChange={(e) =>
                          setPiiDecrypted((p) => (p ? { ...p, npwp: e.target.value } : p))
                        }
                        className="mt-0.5 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 py-1 font-mono text-xs text-slate-900 disabled:bg-slate-50"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-700">Bank</label>
                      <input
                        type="text"
                        required
                        disabled={isMirroredView}
                        value={piiDecrypted?.bankName || ''}
                        onChange={(e) =>
                          setPiiDecrypted((p) => (p ? { ...p, bankName: e.target.value } : p))
                        }
                        className="mt-0.5 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-900 disabled:bg-slate-50"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-[11px] font-medium text-slate-700">
                        No. Rekening
                      </label>
                      <input
                        type="text"
                        required
                        disabled={isMirroredView}
                        value={piiDecrypted?.bankAccount || ''}
                        onChange={(e) =>
                          setPiiDecrypted((p) => (p ? { ...p, bankAccount: e.target.value } : p))
                        }
                        className="mt-0.5 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 py-1 font-mono text-xs text-slate-900 disabled:bg-slate-50"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-700">
                      Kontak Darurat
                    </label>
                    <input
                      type="text"
                      disabled={isMirroredView}
                      value={piiDecrypted?.emergencyContact || ''}
                      onChange={(e) =>
                        setPiiDecrypted((p) =>
                          p ? { ...p, emergencyContact: e.target.value } : p
                        )
                      }
                      className="mt-0.5 w-full min-h-[40px] rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-900 disabled:bg-slate-50"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    {!isMirroredView && (
                      <button
                        type="submit"
                        disabled={piiSaving}
                        className="flex-1 min-h-[40px] rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 cursor-pointer"
                      >
                        {piiSaving ? 'Menyimpan...' : 'Enkripsi & Simpan'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setPiiUnlocked(false)}
                      className="inline-flex min-h-[40px] items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 cursor-pointer"
                    >
                      <Lock className="h-3.5 w-3.5" />
                      Kunci
                    </button>
                  </div>
                </form>
              )}
            </section>
          </div>
        </div>
      )}

      {/* VIEW 1: ABSENSI GPS, WAJAH & RIWAYAT KEHADIRAN TERPADU */}
      {(activeTab === 'absen' || activeTab === 'riwayat') && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-white p-1.5">
            <button
              type="button"
              onClick={() => {
                setAbsenSubView('terminal');
                setActiveTab('absen');
              }}
              className={`min-h-[40px] rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                absenSubView === 'terminal' && activeTab !== 'riwayat'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              Absen GPS & Wajah
            </button>
            <button
              type="button"
              onClick={() => {
                setAbsenSubView('riwayat');
                setActiveTab('absen');
              }}
              className={`min-h-[40px] rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                absenSubView === 'riwayat' || activeTab === 'riwayat'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              Riwayat Bulan Ini ({myMonthlyAttendance.length})
            </button>
          </div>

          {absenSubView === 'riwayat' || activeTab === 'riwayat' ? (
            <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-sm sm:text-base font-semibold text-slate-900">
                    Riwayat Kehadiran ({currentPeriod})
                  </h2>
                  <p className="text-xs text-slate-500">
                    Tersinkronisasi otomatis ke rekap payroll bulanan.
                  </p>
                </div>
              </div>

              {myMonthlyAttendance.length === 0 ? (
                <div className="mt-4 rounded-lg border border-dashed border-slate-200 p-6 text-center text-xs text-slate-500">
                  Belum ada catatan absensi pada bulan {currentPeriod}.
                </div>
              ) : (
                <>
                  {/* Tampilan kartu mobile yang pas untuk layar HP */}
                  <div className="mt-4 space-y-2.5 sm:hidden">
                    {myMonthlyAttendance.map((rec) => (
                      <div
                        key={rec.id}
                        className="rounded-xl border border-slate-200 p-3.5 space-y-1.5 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-semibold text-slate-900 tabular-nums">
                            {rec.date}
                          </span>
                          <span
                            className={`font-semibold ${
                              rec.status === 'terlambat'
                                ? 'text-amber-700'
                                : rec.status === 'lembur'
                                ? 'text-slate-900'
                                : 'text-emerald-700'
                            }`}
                          >
                            {rec.status === 'tepat_waktu'
                              ? 'Tepat Waktu'
                              : rec.status === 'terlambat'
                              ? `Terlambat ${rec.lateMinutes}m`
                              : rec.status === 'lembur'
                              ? `Lembur ${rec.overtimeMinutes}m`
                              : 'Izin'}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-600">{rec.branchName}</p>
                        <div className="flex items-center justify-between border-t border-slate-100 pt-1.5 font-mono text-[11px] text-slate-700 tabular-nums">
                          <span>
                            Masuk {formatTimeShort(rec.clockInTime)} · Pulang{' '}
                            {rec.clockOutTime ? formatTimeShort(rec.clockOutTime) : '—'}
                          </span>
                          <span className="text-slate-500">{rec.clockInDistanceMeters}m</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Tampilan tabel untuk tablet & desktop */}
                  <div className="mt-4 hidden sm:block overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500">
                          <th className="py-2.5 pr-3 font-medium">Tanggal</th>
                          <th className="py-2.5 px-3 font-medium">Cabang</th>
                          <th className="py-2.5 px-3 font-medium">Masuk</th>
                          <th className="py-2.5 px-3 font-medium">Pulang</th>
                          <th className="py-2.5 px-3 font-medium">Jarak GPS</th>
                          <th className="py-2.5 pl-3 text-right font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {myMonthlyAttendance.map((rec) => (
                          <tr key={rec.id} className="hover:bg-slate-50">
                            <td className="py-2.5 pr-3 font-mono text-slate-900 tabular-nums">
                              {rec.date}
                            </td>
                            <td className="py-2.5 px-3 text-slate-700">{rec.branchName}</td>
                            <td className="py-2.5 px-3 font-mono text-slate-900 tabular-nums">
                              {formatTimeShort(rec.clockInTime)}
                            </td>
                            <td className="py-2.5 px-3 font-mono text-slate-900 tabular-nums">
                              {rec.clockOutTime ? formatTimeShort(rec.clockOutTime) : '—'}
                            </td>
                            <td className="py-2.5 px-3 font-mono text-slate-600 tabular-nums">
                              {rec.clockInDistanceMeters}m
                            </td>
                            <td className="py-2.5 pl-3 text-right">
                              <span
                                className={`font-medium ${
                                  rec.status === 'terlambat'
                                    ? 'text-amber-700'
                                    : rec.status === 'lembur'
                                    ? 'text-slate-900'
                                    : 'text-emerald-700'
                                }`}
                              >
                                {rec.status === 'tepat_waktu'
                                  ? 'Tepat Waktu'
                                  : rec.status === 'terlambat'
                                  ? `Terlambat ${rec.lateMinutes}m`
                                  : rec.status === 'lembur'
                                  ? `Lembur ${rec.overtimeMinutes}m`
                                  : 'Izin'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-stretch">
          <section className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    1. Integrasi Lokasi GPS & Geofence Cabang
                  </h2>
                  <p className="text-xs text-slate-500">
                    {requireGps
                      ? 'Kebijakan aktif: GPS wajib berada dalam radius kantor cabang.'
                      : 'Kebijakan fleksibel: Koordinat GPS dicatat tanpa blokir radius.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={acquireGps}
                  disabled={gpsState.loading}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${gpsState.loading ? 'animate-spin' : ''}`} />
                  Perbarui GPS
                </button>
              </div>

              <div>
                <label htmlFor="branch-select" className="block text-xs font-medium text-slate-700">
                  Lokasi Kantor Cabang
                </label>
                <select
                  id="branch-select"
                  value={selectedBranchId}
                  onChange={(e) => setSelectedBranchId(e.target.value)}
                  className="mt-1.5 w-full min-h-[44px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-600 focus:outline-none"
                >
                  {branches.map((br) => (
                    <option key={br.id} value={br.id}>
                      {br.code} — {br.name} (Radius {br.radiusMeters}m)
                    </option>
                  ))}
                </select>
              </div>

              {/* Google Maps Live Geofence & Employee GPS View */}
              <EmployeeAttendanceMap
                branch={activeBranch}
                gpsLat={gpsState.lat}
                gpsLng={gpsState.lng}
                distanceMeters={distanceMeters}
                withinGeofence={withinGeofence}
              />

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500">Koordinat Perangkat</span>
                  <span className="font-mono text-slate-900 tabular-nums">
                    {gpsState.lat !== null && gpsState.lng !== null
                      ? `${gpsState.lat.toFixed(6)}, ${gpsState.lng.toFixed(6)}`
                      : gpsState.loading
                      ? 'Mengunci satelit GPS...'
                      : 'Belum tersedia'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500">Jarak ke Titik Kantor</span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {distanceMeters !== null
                      ? `${distanceMeters} meter (Batas ${activeBranch?.radiusMeters ?? 250}m)`
                      : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500">Status Radius Geofence</span>
                  <span
                    className={`font-medium ${
                      distanceMeters === null
                        ? 'text-slate-500'
                        : withinGeofence
                        ? 'text-emerald-700'
                        : 'text-rose-700'
                    }`}
                  >
                    {distanceMeters === null
                      ? 'Menunggu GPS'
                      : withinGeofence
                      ? 'Dalam Radius Kantor (Valid)'
                      : 'Di Luar Radius Kantor'}
                  </span>
                </div>
                {gpsState.accuracy !== null && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500">Akurasi Sinyal</span>
                    <span className="font-mono text-slate-700 tabular-nums">
                      ±{gpsState.accuracy}m{' '}
                      {gpsState.simulated ? '(Koordinat Uji Cabang)' : '(GPS Perangkat)'}
                    </span>
                  </div>
                )}
              </div>

              {gpsState.error && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-2">
                  <p>{gpsState.error}</p>
                  <button
                    type="button"
                    onClick={useBranchTestCoordinates}
                    className="inline-flex items-center gap-1.5 rounded-md bg-amber-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-800 cursor-pointer"
                  >
                    <Navigation className="h-3.5 w-3.5" />
                    Gunakan Koordinat Uji Cabang Ini
                  </button>
                </div>
              )}

              {!gpsState.error && distanceMeters !== null && !withinGeofence && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 flex items-center justify-between gap-2">
                  <span>Posisi Anda di luar cabang terpilih.</span>
                  <button
                    type="button"
                    onClick={useBranchTestCoordinates}
                    className="shrink-0 font-medium text-emerald-700 hover:underline cursor-pointer"
                  >
                    Simulasi Lokasi Cabang
                  </button>
                </div>
              )}
            </div>

            <div className="mt-5 pt-4 border-t border-slate-100">
              <label htmlFor="att-notes" className="block text-xs font-medium text-slate-700">
                Catatan Kehadiran (Opsional)
              </label>
              <input
                id="att-notes"
                type="text"
                maxLength={240}
                disabled={isMirroredView}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Contoh: Kunjungan klien atau piket shift pagi"
                className="mt-1.5 w-full min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:outline-none disabled:bg-slate-50"
              />
            </div>
          </section>

          <section className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    2. Validasi Foto Wajah Anti-Kecurangan
                  </h2>
                  <p className="text-xs text-slate-500">
                    {requireFace
                      ? 'Kebijakan aktif: Verifikasi kamera wajib sebelum absen masuk.'
                      : 'Kebijakan opsional: Foto wajah bersifat opsional sesuai pengaturan HRD.'}
                  </p>
                </div>
                {!cameraActive && !isMirroredView && (
                  <button
                    type="button"
                    onClick={startCamera}
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
                  >
                    <Camera className="h-3.5 w-3.5 text-emerald-600" />
                    {capturedImage ? 'Foto Ulang' : 'Buka Kamera'}
                  </button>
                )}
              </div>

              <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-slate-900 aspect-video flex items-center justify-center">
                {cameraActive ? (
                  <>
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      className="h-full w-full object-cover scale-x-[-1]"
                    />
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <div className="h-44 w-36 rounded-full border-2 border-dashed border-emerald-400/90" />
                    </div>
                  </>
                ) : capturedImage ? (
                  <img
                    src={capturedImage}
                    alt="Hasil tangkapan validasi wajah"
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover scale-x-[-1]"
                  />
                ) : (
                  <div className="px-6 text-center text-slate-300 space-y-2">
                    <UserCheck className="mx-auto h-9 w-9 text-slate-400" />
                    <p className="text-xs">
                      {isMirroredView
                        ? 'Kamera dinonaktifkan dalam Mode Mirroring Admin.'
                        : 'Ketuk "Buka Kamera" untuk memulai verifikasi wajah langsung sebelum absen.'}
                    </p>
                  </div>
                )}
                <canvas ref={canvasRef} className="hidden" />
              </div>

              {cameraError && (
                <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                  {cameraError}
                </p>
              )}

              {cameraActive && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={captureAndVerifyFace}
                    className="flex-1 min-h-[44px] rounded-lg bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-800 transition-colors cursor-pointer"
                  >
                    Ambil Foto & Verifikasi Wajah
                  </button>
                  <button
                    type="button"
                    onClick={stopCamera}
                    className="min-h-[44px] rounded-lg border border-slate-200 px-4 py-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                  >
                    Batal
                  </button>
                </div>
              )}

              {verifyingFace && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                  Memeriksa keaslian biometrik wajah dan sidik SHA-256...
                </div>
              )}

              {faceResult && (
                <div
                  className={`rounded-lg border p-3.5 text-xs space-y-1 ${
                    faceResult.verified
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                      : 'border-rose-200 bg-rose-50 text-rose-900'
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span>
                      {faceResult.verified ? 'Wajah Terverifikasi Valid' : 'Verifikasi Wajah Ditolak'}
                    </span>
                    <span className="font-mono tabular-nums">Skor {faceResult.confidence}%</span>
                  </div>
                  <p>{faceResult.reason}</p>
                  {faceResult.faceHash && (
                    <p className="font-mono text-[11px] opacity-80 truncate">
                      Digest SHA-256: {faceResult.faceHash}
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="mt-5 pt-4 border-t border-slate-100 flex flex-col sm:flex-row gap-3">
              {isMirroredView ? (
                <div className="flex-1 min-h-[48px] flex items-center justify-center rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-900">
                  Mode Mirroring — Tombol absensi dinonaktifkan agar data karyawan tidak berubah.
                </div>
              ) : !todayRecord ? (
                <button
                  type="button"
                  disabled={
                    submitting ||
                    (requireGps && !withinGeofence) ||
                    (requireFace && !faceResult?.verified)
                  }
                  onClick={handleClockIn}
                  className="flex-1 min-h-[48px] inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 py-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-500 transition-colors cursor-pointer"
                >
                  <MapPin className="h-4 w-4" />
                  {submitting ? 'Menyimpan Absensi...' : 'Catat Absen Masuk Sekarang'}
                </button>
              ) : !todayRecord.clockOutTime ? (
                <button
                  type="button"
                  disabled={submitting || (requireGps && !withinGeofence)}
                  onClick={handleClockOut}
                  className="flex-1 min-h-[48px] inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-500 transition-colors cursor-pointer"
                >
                  <Clock className="h-4 w-4" />
                  {submitting ? 'Memproses Pulang...' : 'Catat Absen Pulang Sekarang'}
                </button>
              ) : (
                <div className="flex-1 min-h-[48px] flex items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  Absensi Hari Ini Lengkap ({formatTimeShort(todayRecord.clockInTime)} –{' '}
                  {formatTimeShort(todayRecord.clockOutTime)})
                </div>
              )}
            </div>
          </section>
        </div>
          )}
        </div>
      )}

      {/* VIEW 2: PENGAJUAN IZIN & CUTI */}
      {activeTab === 'izin' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-5">
            <h2 className="text-base font-semibold text-slate-900">
              Formulir Pengajuan Izin & Cuti
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Pengajuan langsung diteruskan ke antrean persetujuan Admin HRD secara real-time.
            </p>

            {isMirroredView ? (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
                Pengajuan izin baru dinonaktifkan selama Mode Mirroring Admin.
              </div>
            ) : !allowSelfService ? (
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                Fitur pengajuan mandiri sedang ditutup sementara oleh Admin HRD.
              </div>
            ) : (
              <form onSubmit={handleSubmitLeave} className="mt-4 space-y-3.5">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Jenis Pengajuan</label>
                  <select
                    value={leaveForm.leaveType}
                    onChange={(e) =>
                      setLeaveForm((p) => ({ ...p, leaveType: e.target.value as LeaveType }))
                    }
                    className="mt-1 w-full min-h-[44px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900"
                  >
                    <option value="izin_pribadi">Izin Pribadi</option>
                    <option value="izin_sakit">Izin Sakit</option>
                    <option value="cuti_tahunan">Cuti Tahunan</option>
                    <option value="dinas_luar">Dinas Luar Kantor</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700">Tanggal Mulai</label>
                    <input
                      type="date"
                      required
                      value={leaveForm.startDate}
                      onChange={(e) =>
                        setLeaveForm((p) => ({
                          ...p,
                          startDate: e.target.value,
                          endDate: e.target.value > p.endDate ? e.target.value : p.endDate,
                        }))
                      }
                      className="mt-1 w-full min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Tanggal Selesai
                    </label>
                    <input
                      type="date"
                      required
                      min={leaveForm.startDate}
                      value={leaveForm.endDate}
                      onChange={(e) => setLeaveForm((p) => ({ ...p, endDate: e.target.value }))}
                      className="mt-1 w-full min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900"
                    />
                  </div>
                </div>

                <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 flex items-center justify-between">
                  <span>Durasi Pengajuan</span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {computeDaysInclusive(leaveForm.startDate, leaveForm.endDate)} Hari Kerja
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Alasan / Keterangan
                  </label>
                  <textarea
                    required
                    minLength={4}
                    maxLength={300}
                    rows={3}
                    value={leaveForm.reason}
                    onChange={(e) => setLeaveForm((p) => ({ ...p, reason: e.target.value }))}
                    placeholder="Jelaskan keperluan izin, cuti, atau lokasi dinas luar..."
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-900"
                  />
                </div>

                <button
                  type="submit"
                  disabled={submittingLeave}
                  className="w-full min-h-[44px] rounded-lg bg-emerald-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-emerald-700 cursor-pointer"
                >
                  {submittingLeave ? 'Mengirim Pengajuan...' : 'Kirim Pengajuan Izin / Cuti'}
                </button>
              </form>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-7 space-y-4">
            <h2 className="text-base font-semibold text-slate-900">
              Riwayat Pengajuan Izin & Cuti ({sortedLeaves.length})
            </h2>
            {sortedLeaves.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">
                Belum ada riwayat pengajuan izin atau cuti.
              </div>
            ) : (
              <div className="space-y-3">
                {sortedLeaves.map((req) => (
                  <div
                    key={req.id}
                    className="rounded-xl border border-slate-200 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-slate-900">
                          {LEAVE_TYPE_LABELS[req.leaveType]}
                        </span>
                        <span className="text-slate-400">·</span>
                        <span className="font-mono text-slate-600 tabular-nums">
                          {req.startDate} s/d {req.endDate} ({req.totalDays} hari)
                        </span>
                      </div>
                      <p className="text-xs text-slate-700">{req.reason}</p>
                      {req.reviewedByName && (
                        <p className="text-[11px] text-slate-500">
                          Catatan {req.reviewedByName}: {req.reviewNotes || '-'}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <span
                        className={`text-xs font-semibold ${
                          req.status === 'disetujui'
                            ? 'text-emerald-700'
                            : req.status === 'ditolak'
                            ? 'text-rose-700'
                            : 'text-amber-700'
                        }`}
                      >
                        {req.status === 'menunggu'
                          ? 'Menunggu HRD'
                          : req.status === 'disetujui'
                          ? 'Disetujui'
                          : 'Ditolak'}
                      </span>
                      {req.status === 'menunggu' && !isMirroredView && (
                        <button
                          type="button"
                          onClick={() => handleCancelLeave(req.id)}
                          className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-[11px] font-medium text-slate-600 hover:bg-rose-50 hover:text-rose-700 cursor-pointer"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Batalkan
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* VIEW 3: SLIP GAJI DIGITAL */}
      {activeTab === 'slip_gaji' && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-8 space-y-6">
          <div className="print:hidden flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-100 pb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Slip Gaji Digital Karyawan (Tersinkron Payroll & PPh 21 TER)
              </h2>
              <p className="text-xs text-slate-500">
                Perhitungan otomatis berdasarkan hari kehadiran, lembur, BPJS 3%, dan tarif PPh 21.
              </p>
            </div>
            {sortedPayrolls.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={activePayslip?.id || ''}
                  onChange={(e) => setSelectedPayrollId(e.target.value)}
                  className="min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-mono text-xs text-slate-900"
                >
                  {sortedPayrolls.map((p) => (
                    <option key={p.id} value={p.id}>
                      Periode {p.period} ({p.status.toUpperCase()})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleDownloadPayslipCsv}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  Unduh CSV
                </button>
                <button
                  type="button"
                  onClick={handlePrintPayslip}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer"
                >
                  <Printer className="h-3.5 w-3.5" />
                  Cetak Slip Gaji
                </button>
              </div>
            )}
          </div>

          {!activePayslip ? (
            <div className="rounded-lg border border-dashed border-slate-200 p-10 text-center text-xs text-slate-500">
              Belum ada slip gaji yang diterbitkan untuk karyawan ini. HRD dapat menjalankan
              kalkulasi payroll pada modul Payroll & Pajak.
            </div>
          ) : (
            <div className="mx-auto max-w-3xl rounded-xl border border-slate-200 p-6 space-y-6">
              <div className="flex flex-col gap-2 border-b border-slate-200 pb-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
                    SLIP GAJI RESMI KARYAWAN
                  </p>
                  <h3 className="mt-1 text-lg font-bold text-slate-900">{companyName}</h3>
                  <p className="text-xs text-slate-500">
                    {assignedBranch?.name || 'Kantor Pusat'} · {assignedBranch?.city || 'Indonesia'}
                  </p>
                </div>
                <div className="text-left sm:text-right text-xs">
                  <p className="font-mono font-semibold text-slate-900 tabular-nums">
                    Periode: {activePayslip.period}
                  </p>
                  <p className="mt-0.5 text-slate-600">
                    Status:{' '}
                    <span className="font-semibold text-emerald-700">
                      {activePayslip.status === 'dibayarkan'
                        ? 'Sudah Dibayarkan'
                        : activePayslip.status === 'disetujui'
                        ? 'Disetujui HRD'
                        : 'Draft'}
                    </span>
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-4 text-xs sm:grid-cols-4">
                <div>
                  <span className="block text-[11px] text-slate-500">Nama Karyawan</span>
                  <span className="font-semibold text-slate-900">
                    {currentEmployee?.fullName || activePayslip.employeeName}
                  </span>
                </div>
                <div>
                  <span className="block text-[11px] text-slate-500">NIK / Kode</span>
                  <span className="font-mono font-semibold text-slate-900">
                    {currentEmployee?.employeeCode || activePayslip.employeeId}
                  </span>
                </div>
                <div>
                  <span className="block text-[11px] text-slate-500">Jabatan & PTKP</span>
                  <span className="font-semibold text-slate-900">
                    {currentEmployee?.position || '-'} · {currentEmployee?.ptkpStatus || 'TK/0'}
                  </span>
                </div>
                <div>
                  <span className="block text-[11px] text-slate-500">Kehadiran / Lembur</span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {activePayslip.presentDays} hr / {activePayslip.overtimeHours} jam
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <div className="space-y-2.5 text-xs">
                  <h4 className="border-b border-slate-200 pb-1.5 font-semibold text-slate-900">
                    Rincian Penerimaan
                  </h4>
                  <div className="flex justify-between">
                    <span className="text-slate-600">Gaji Pokok Bulanan</span>
                    <span className="font-mono text-slate-900 tabular-nums">
                      {formatRupiah(activePayslip.baseSalary)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">
                      Tunjangan Kehadiran ({activePayslip.presentDays} hari)
                    </span>
                    <span className="font-mono text-slate-900 tabular-nums">
                      {formatRupiah(activePayslip.allowances)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">
                      Upah Lembur ({activePayslip.overtimeHours} jam)
                    </span>
                    <span className="font-mono text-slate-900 tabular-nums">
                      {formatRupiah(activePayslip.overtimePay)}
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-slate-200 pt-2 font-semibold">
                    <span className="text-slate-900">Penghasilan Bruto</span>
                    <span className="font-mono text-slate-900 tabular-nums">
                      {formatRupiah(activePayslip.grossIncome)}
                    </span>
                  </div>
                </div>

                <div className="space-y-2.5 text-xs">
                  <h4 className="border-b border-slate-200 pb-1.5 font-semibold text-slate-900">
                    Rincian Potongan & Pajak
                  </h4>
                  <div className="flex justify-between">
                    <span className="text-slate-600">
                      Potongan Terlambat ({activePayslip.lateMinutesTotal} menit)
                    </span>
                    <span className="font-mono text-rose-700 tabular-nums">
                      -{formatRupiah(activePayslip.lateDeduction)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">Iuran BPJS Kes & JHT (3%)</span>
                    <span className="font-mono text-rose-700 tabular-nums">
                      -{formatRupiah(activePayslip.bpjsDeduction)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">
                      PPh 21 TER ({activePayslip.pph21Rate}%)
                    </span>
                    <span className="font-mono text-rose-700 tabular-nums">
                      -{formatRupiah(activePayslip.pph21Amount)}
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-slate-200 pt-2 font-semibold">
                    <span className="text-slate-900">Total Potongan</span>
                    <span className="font-mono text-rose-700 tabular-nums">
                      -
                      {formatRupiah(
                        activePayslip.lateDeduction +
                          activePayslip.bpjsDeduction +
                          activePayslip.pph21Amount
                      )}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <span className="block text-xs font-semibold text-emerald-900">
                    TOTAL GAJI BERSIH DITERIMA (TAKE-HOME PAY)
                  </span>
                  <span className="text-[11px] text-emerald-800">
                    {activePayslip.taxReported
                      ? 'Telah dilaporkan ke e-Bupot PPh 21 DJP'
                      : 'Menunggu pelaporan periodik e-Bupot'}
                  </span>
                </div>
                <span className="font-mono text-2xl font-bold text-emerald-800 tabular-nums">
                  {formatRupiah(activePayslip.netSalary)}
                </span>
              </div>
            </div>
          )}
        </section>
      )}

      {/* VIEW 4: PENGAJUAN LEMBUR */}
      {activeTab === 'lembur' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-5">
            <h2 className="text-base font-semibold text-slate-900">Formulir Pengajuan Lembur</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Kuota terpakai bulan {currentPeriod}:{' '}
              <span className="font-mono font-semibold text-slate-900 tabular-nums">
                {usedOvertimeHoursThisMonth} / {maxOvertimePerMonth} Jam
              </span>
            </p>

            {isMirroredView ? (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
                Pengajuan lembur baru dinonaktifkan selama Mode Mirroring Admin.
              </div>
            ) : !allowSelfService ? (
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                Fitur pengajuan mandiri sedang ditutup sementara oleh Admin HRD.
              </div>
            ) : (
              <form onSubmit={handleSubmitOvertime} className="mt-4 space-y-3.5">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Tanggal Lembur</label>
                  <input
                    type="date"
                    required
                    value={overtimeForm.date}
                    onChange={(e) => setOvertimeForm((p) => ({ ...p, date: e.target.value }))}
                    className="mt-1 w-full min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700">Jam Mulai</label>
                    <input
                      type="time"
                      required
                      value={overtimeForm.startTime}
                      onChange={(e) =>
                        setOvertimeForm((p) => ({ ...p, startTime: e.target.value }))
                      }
                      className="mt-1 w-full min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">Jam Selesai</label>
                    <input
                      type="time"
                      required
                      value={overtimeForm.endTime}
                      onChange={(e) => setOvertimeForm((p) => ({ ...p, endTime: e.target.value }))}
                      className="mt-1 w-full min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900"
                    />
                  </div>
                </div>

                <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 flex items-center justify-between">
                  <span>Durasi Dihitung</span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {computeHoursDiff(overtimeForm.startTime, overtimeForm.endTime)} Jam
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Uraian Tugas Lembur
                  </label>
                  <textarea
                    required
                    minLength={4}
                    maxLength={300}
                    rows={3}
                    value={overtimeForm.reason}
                    onChange={(e) => setOvertimeForm((p) => ({ ...p, reason: e.target.value }))}
                    placeholder="Contoh: Penyelesaian closing laporan cabang atau pemeliharaan server..."
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-900"
                  />
                </div>

                <button
                  type="submit"
                  disabled={submittingOvertime}
                  className="w-full min-h-[44px] rounded-lg bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer"
                >
                  {submittingOvertime ? 'Mengirim Pengajuan...' : 'Ajukan Lembur ke HRD'}
                </button>
              </form>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-7 space-y-4">
            <h2 className="text-base font-semibold text-slate-900">
              Riwayat Pengajuan Lembur ({sortedOvertimes.length})
            </h2>
            {sortedOvertimes.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">
                Belum ada pengajuan lembur tercatat.
              </div>
            ) : (
              <div className="space-y-3">
                {sortedOvertimes.map((req) => (
                  <div
                    key={req.id}
                    className="rounded-xl border border-slate-200 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono font-semibold text-slate-900 tabular-nums">
                          {req.date}
                        </span>
                        <span className="text-slate-400">·</span>
                        <span className="font-mono text-slate-600 tabular-nums">
                          {req.startTime} – {req.endTime} WIB ({req.durationHours} jam)
                        </span>
                      </div>
                      <p className="text-xs text-slate-700">{req.reason}</p>
                      {req.reviewedByName && (
                        <p className="text-[11px] text-slate-500">
                          Catatan {req.reviewedByName}: {req.reviewNotes || '-'}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <span
                        className={`text-xs font-semibold ${
                          req.status === 'disetujui'
                            ? 'text-emerald-700'
                            : req.status === 'ditolak'
                            ? 'text-rose-700'
                            : 'text-amber-700'
                        }`}
                      >
                        {req.status === 'menunggu'
                          ? 'Menunggu HRD'
                          : req.status === 'disetujui'
                          ? 'Disetujui'
                          : 'Ditolak'}
                      </span>
                      {req.status === 'menunggu' && !isMirroredView && (
                        <button
                          type="button"
                          onClick={() => handleCancelOvertime(req.id)}
                          className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-[11px] font-medium text-slate-600 hover:bg-rose-50 hover:text-rose-700 cursor-pointer"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Batalkan
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* DASBOR LOGO KARYAWAN (1 BARIS PAS UNTUK HP, TEPAT DI ATAS BILAH NAVIGASI) */}
      <section
        aria-label="Dasbor Logo Layanan Karyawan"
        className={`print:hidden fixed left-0 right-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur-md shadow-[0_-4px_20px_-6px_rgba(15,23,42,0.08)] ${
          hasAdminSidebar ? 'bottom-14 lg:bottom-0 lg:left-64' : 'bottom-14'
        }`}
      >
        <div className="mx-auto max-w-5xl px-2.5 py-2 sm:px-6">
          <div className="grid grid-cols-4 gap-1.5 sm:gap-2.5">
            {dockIcons.map((item) => {
              const Icon = item.icon;
              const isSelected = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    if (item.id === 'absen') {
                      setAbsenSubView('terminal');
                    }
                    setActiveTab(item.id);
                  }}
                  title={item.title}
                  className={`flex min-h-[54px] flex-col items-center justify-center gap-0.5 rounded-xl border px-1 py-1.5 text-center transition-all cursor-pointer ${
                    isSelected
                      ? 'border-emerald-600 bg-emerald-50/80'
                      : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <div
                    className={`flex h-7 w-7 items-center justify-center rounded-lg border ${item.accentClass}`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <span
                    className={`text-[11px] font-semibold leading-tight truncate max-w-full ${
                      isSelected ? 'text-emerald-800' : 'text-slate-800'
                    }`}
                  >
                    {item.shortLabel}
                  </span>
                  <span className="hidden sm:block font-mono text-[10px] text-slate-500 truncate max-w-full tabular-nums">
                    {item.badgeText}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
};

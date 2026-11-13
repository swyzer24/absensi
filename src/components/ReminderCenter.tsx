import React, { useEffect, useState } from 'react';
import { Bell, BellRing, CheckCircle2, Clock, Volume2 } from 'lucide-react';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { Branch, ReminderSchedule } from '../types';

interface ReminderCenterProps {
  currentUserUid: string;
  branches: Branch[];
  schedule: ReminderSchedule | null;
  onTriggerTestNotification: (title: string, body: string) => void;
}

export const ReminderCenter: React.FC<ReminderCenterProps> = ({
  currentUserUid,
  branches,
  schedule,
  onTriggerTestNotification,
}) => {
  const [branchId, setBranchId] = useState(schedule?.branchId || branches[0]?.id || 'cabang_jkt_hq');
  const [shiftStart, setShiftStart] = useState(schedule?.shiftStart || '08:30');
  const [shiftEnd, setShiftEnd] = useState(schedule?.shiftEnd || '17:30');
  const [remindBeforeMinutes, setRemindBeforeMinutes] = useState(
    schedule?.remindBeforeMinutes ?? 15
  );
  const [browserNotifyEnabled, setBrowserNotifyEnabled] = useState(
    schedule?.browserNotifyEnabled ?? true
  );
  const [soundEnabled, setSoundEnabled] = useState(schedule?.soundEnabled ?? true);
  const [permissionState, setPermissionState] = useState<string>(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    if (schedule) {
      setBranchId(schedule.branchId);
      setShiftStart(schedule.shiftStart);
      setShiftEnd(schedule.shiftEnd);
      setRemindBeforeMinutes(schedule.remindBeforeMinutes);
      setBrowserNotifyEnabled(schedule.browserNotifyEnabled);
      setSoundEnabled(schedule.soundEnabled);
    }
  }, [schedule]);

  const requestNotificationPermission = async () => {
    if (typeof Notification === 'undefined') {
      setPermissionState('unsupported');
      return;
    }
    const perm = await Notification.requestPermission();
    setPermissionState(perm);
  };

  const handleSaveSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedMsg(null);
    const schedId = schedule?.id || `sched_${currentUserUid}`;
    try {
      await setDoc(doc(db, 'schedules', schedId), {
        id: schedId,
        userId: currentUserUid,
        branchId,
        shiftStart,
        shiftEnd,
        remindBeforeMinutes: Number(remindBeforeMinutes),
        browserNotifyEnabled,
        soundEnabled,
        updatedAt: serverTimestamp(),
      });
      setSavedMsg('Jadwal pengingat masuk & pulang kantor berhasil disimpan ke cloud.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `schedules/${schedId}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 pb-20 lg:pb-6">
      <div>
        <p className="text-xs font-medium text-slate-500">
          Otomatisasi Kedisiplinan · Notifikasi Real-time Perangkat
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
          Pengingat Jadwal Masuk & Pulang Kantor
        </h1>
      </div>

      {savedMsg && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs font-medium text-emerald-900">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <span>{savedMsg}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-7">
          <h2 className="text-base font-semibold text-slate-900">Konfigurasi Pengingat Shift</h2>
          <p className="text-xs text-slate-500 mb-4">
            Sistem memantau waktu server secara real-time dan mengirim pengingat sebelum jadwal dimulai maupun berakhir.
          </p>

          <form onSubmit={handleSaveSchedule} className="space-y-4 text-xs">
            <div>
              <label className="block font-medium text-slate-700">Cabang Acuan Shift</label>
              <select
                value={branchId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setBranchId(nextId);
                  const br = branches.find((b) => b.id === nextId);
                  if (br) {
                    setShiftStart(br.shiftStart);
                    setShiftEnd(br.shiftEnd);
                  }
                }}
                className="mt-1.5 w-full min-h-[42px] rounded-lg border border-slate-200 bg-white px-3 text-slate-900"
              >
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {b.name} ({b.shiftStart}–{b.shiftEnd})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="block font-medium text-slate-700">Jam Masuk</label>
                <input
                  type="time"
                  required
                  value={shiftStart}
                  onChange={(e) => setShiftStart(e.target.value)}
                  className="mt-1.5 w-full min-h-[42px] rounded-lg border border-slate-200 px-3 font-mono text-slate-900"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700">Jam Pulang</label>
                <input
                  type="time"
                  required
                  value={shiftEnd}
                  onChange={(e) => setShiftEnd(e.target.value)}
                  className="mt-1.5 w-full min-h-[42px] rounded-lg border border-slate-200 px-3 font-mono text-slate-900"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700">Ingatkan Sebelum (Menit)</label>
                <input
                  type="number"
                  min={1}
                  max={120}
                  required
                  value={remindBeforeMinutes}
                  onChange={(e) => setRemindBeforeMinutes(Number(e.target.value))}
                  className="mt-1.5 w-full min-h-[42px] rounded-lg border border-slate-200 px-3 font-mono text-slate-900"
                />
              </div>
            </div>

            <div className="space-y-2.5 pt-2">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={browserNotifyEnabled}
                  onChange={(e) => setBrowserNotifyEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-emerald-600"
                />
                <span className="text-slate-700 font-medium">
                  Aktifkan Notifikasi Push Browser / Ponsel Real-time
                </span>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={soundEnabled}
                  onChange={(e) => setSoundEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-emerald-600"
                />
                <span className="text-slate-700 font-medium">
                  Bunyikan Nada Peringatan Audio Saat Jadwal Tiba
                </span>
              </label>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="min-h-[44px] rounded-lg bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-700 cursor-pointer"
            >
              {saving ? 'Menyimpan...' : 'Simpan Pengaturan Pengingat'}
            </button>
          </form>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 lg:col-span-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">Status & Uji Notifikasi</h2>
            <Bell className="h-5 w-5 text-emerald-600" />
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Izin Notifikasi Browser</span>
              <span className="font-mono font-semibold text-slate-900 uppercase">
                {permissionState}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Jadwal Masuk Berikutnya</span>
              <span className="font-mono text-slate-900 tabular-nums">{shiftStart} WIB</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Jadwal Pulang Berikutnya</span>
              <span className="font-mono text-slate-900 tabular-nums">{shiftEnd} WIB</span>
            </div>
          </div>

          {permissionState !== 'granted' && permissionState !== 'unsupported' && (
            <button
              type="button"
              onClick={requestNotificationPermission}
              className="w-full min-h-[42px] inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              <BellRing className="h-4 w-4 text-emerald-600" />
              Izinkan Notifikasi Browser Sekarang
            </button>
          )}

          <div className="space-y-2 pt-2 border-t border-slate-100">
            <p className="text-xs font-medium text-slate-700">Simulasi Pengingat Instan</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() =>
                  onTriggerTestNotification(
                    'Pengingat Absen Masuk',
                    `Jadwal masuk pukul ${shiftStart} WIB dalam ${remindBeforeMinutes} menit. Pastikan Anda berada di radius cabang.`
                  )
                }
                className="min-h-[42px] inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 cursor-pointer"
              >
                <Clock className="h-3.5 w-3.5" />
                Uji Pengingat Masuk
              </button>
              <button
                type="button"
                onClick={() =>
                  onTriggerTestNotification(
                    'Pengingat Absen Pulang',
                    `Jam kerja berakhir pukul ${shiftEnd} WIB. Jangan lupa lakukan absen pulang dan verifikasi lokasi.`
                  )
                }
                className="min-h-[42px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                <Volume2 className="h-3.5 w-3.5 text-emerald-600" />
                Uji Pengingat Pulang
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

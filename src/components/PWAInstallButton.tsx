import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
      >
        <Download className="h-3.5 w-3.5 text-emerald-600" />
        Pasang Aplikasi
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Smartphone className="h-3.5 w-3.5 text-emerald-600" />
          Pasang di iOS
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-slate-900">Pasang di iPhone / iPad</h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  aria-label="Tutup panduan"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <ol className="mt-3 space-y-2 text-sm text-slate-600 list-decimal pl-4">
                <li>Ketuk ikon <strong>Bagikan (Share)</strong> pada bilah Safari.</li>
                <li>Gulir ke bawah lalu pilih <strong>Tambahkan ke Layar Utama (Add to Home Screen)</strong>.</li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full rounded-lg bg-slate-900 py-2.5 text-xs font-medium text-white hover:bg-slate-800 transition-colors"
              >
                Mengerti
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

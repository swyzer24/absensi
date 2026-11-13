import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/usePWAInstall';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-20 left-4 z-50 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 shadow-md lg:bottom-4"
    >
      <WifiOff className="h-3.5 w-3.5 text-amber-700" />
      <span>Mode Offline — Data tersimpan di cache lokal dan akan tersinkron otomatis.</span>
    </div>
  );
};

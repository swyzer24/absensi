import React, { useEffect } from 'react';
import {
  APILoadingStatus,
  APIProvider,
  useApiLoadingStatus,
} from '@vis.gl/react-google-maps';

export const GOOGLE_MAPS_API_KEY = (
  import.meta.env.VITE_GOOGLE_MAPS_API_KEY || ''
).trim();

export const DEMO_MAP_ID = 'DEMO_MAP_ID';
export const GMP_ATTRIBUTION_IDS = ['gmp_mcp_codeassist_v1_aistudio'];

function ApiStatusWatcher() {
  const status = useApiLoadingStatus();

  useEffect(() => {
    if (status === APILoadingStatus.AUTH_FAILURE) {
      window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
    }
  }, [status]);

  return null;
}

export const GoogleMapsProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  if (!GOOGLE_MAPS_API_KEY) {
    return <>{children}</>;
  }

  return (
    <APIProvider
      apiKey={GOOGLE_MAPS_API_KEY}
      language="id"
      region="ID"
      libraries={['places', 'marker']}
    >
      <ApiStatusWatcher />
      {children}
    </APIProvider>
  );
};

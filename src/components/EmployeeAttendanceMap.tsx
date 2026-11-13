import React, { useEffect, useState } from 'react';
import {
  APILoadingStatus,
  AdvancedMarker,
  Circle,
  Map as GoogleMap,
  InfoWindow,
  Pin,
  useAdvancedMarkerRef,
  useApiLoadingStatus,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import { LocateFixed, MapPin } from 'lucide-react';
import type { Branch } from '../types';
import {
  DEMO_MAP_ID,
  GMP_ATTRIBUTION_IDS,
  GOOGLE_MAPS_API_KEY,
} from './GoogleMapsWrapper';

interface EmployeeAttendanceMapProps {
  branch: Branch | null;
  gpsLat: number | null;
  gpsLng: number | null;
  distanceMeters: number | null;
  withinGeofence: boolean;
}

function EmployeeMapCameraSync({
  branchLat,
  branchLng,
  gpsLat,
  gpsLng,
  recenterSignal,
}: {
  branchLat: number;
  branchLng: number;
  gpsLat: number | null;
  gpsLng: number | null;
  recenterSignal: number;
}) {
  const map = useMap();
  const coreLib = useMapsLibrary('core');

  useEffect(() => {
    if (!map) return;
    if (gpsLat !== null && gpsLng !== null && coreLib) {
      const bounds = new coreLib.LatLngBounds();
      bounds.extend({ lat: branchLat, lng: branchLng });
      bounds.extend({ lat: gpsLat, lng: gpsLng });
      map.fitBounds(bounds, { top: 48, right: 48, bottom: 48, left: 48 });
      const listener = coreLib.event.addListenerOnce(map, 'idle', () => {
        const z = map.getZoom();
        if (z !== undefined && z > 17) {
          map.setZoom(17);
        }
      });
      return () => listener.remove();
    }
    map.panTo({ lat: branchLat, lng: branchLng });
    map.setZoom(16);
  }, [map, coreLib, branchLat, branchLng, gpsLat, gpsLng, recenterSignal]);

  return null;
}

export const EmployeeAttendanceMap: React.FC<EmployeeAttendanceMapProps> = ({
  branch,
  gpsLat,
  gpsLng,
  distanceMeters,
  withinGeofence,
}) => {
  const apiStatus = useApiLoadingStatus();
  const [branchMarkerRef, branchMarker] = useAdvancedMarkerRef();
  const [showBranchInfo, setShowBranchInfo] = useState(false);
  const [recenterSignal, setRecenterSignal] = useState(0);

  if (!branch) return null;

  if (
    !GOOGLE_MAPS_API_KEY ||
    apiStatus === APILoadingStatus.FAILED ||
    apiStatus === APILoadingStatus.AUTH_FAILURE
  ) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600 space-y-1">
        <p className="font-semibold text-slate-900 inline-flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5 text-emerald-600" />
          {branch.name} (Radius {branch.radiusMeters}m)
        </p>
        <p className="font-mono text-[11px] text-slate-500 tabular-nums">
          Titik Kantor: {branch.latitude.toFixed(6)}, {branch.longitude.toFixed(6)}
        </p>
      </div>
    );
  }

  const circleColor =
    distanceMeters === null || withinGeofence ? '#059669' : '#e11d48';
  const fillColor =
    distanceMeters === null || withinGeofence ? '#10b981' : '#f43f5e';

  return (
    <div className="relative h-[240px] sm:h-[280px] w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-100">
      <GoogleMap
        mapId={DEMO_MAP_ID}
        defaultCenter={{ lat: branch.latitude, lng: branch.longitude }}
        defaultZoom={16}
        gestureHandling="greedy"
        mapTypeControl={false}
        streetViewControl={false}
        fullscreenControl={false}
        internalUsageAttributionIds={GMP_ATTRIBUTION_IDS}
        className="h-full w-full"
      >
        <EmployeeMapCameraSync
          branchLat={branch.latitude}
          branchLng={branch.longitude}
          gpsLat={gpsLat}
          gpsLng={gpsLng}
          recenterSignal={recenterSignal}
        />

        {/* Branch Geofence Circle */}
        <Circle
          center={{ lat: branch.latitude, lng: branch.longitude }}
          radius={branch.radiusMeters}
          strokeColor={circleColor}
          strokeOpacity={0.9}
          strokeWeight={2}
          fillColor={fillColor}
          fillOpacity={0.18}
          clickable={false}
        />

        {/* Branch Office Marker */}
        <AdvancedMarker
          ref={branchMarkerRef}
          position={{ lat: branch.latitude, lng: branch.longitude }}
          title={`${branch.code} — ${branch.name}`}
          onClick={() => setShowBranchInfo((prev) => !prev)}
        >
          <Pin
            background="#0f172a"
            borderColor="#059669"
            glyphColor="#ffffff"
          />
        </AdvancedMarker>

        {showBranchInfo && branchMarker && (
          <InfoWindow
            anchor={branchMarker}
            onCloseClick={() => setShowBranchInfo(false)}
          >
            <div className="p-1 text-xs space-y-1 max-w-[210px]">
              <p className="font-bold text-slate-900">
                {branch.code} — {branch.name}
              </p>
              <p className="text-[11px] text-slate-600">{branch.address}</p>
              <p className="font-mono text-[11px] text-slate-700 tabular-nums">
                Radius Absen: {branch.radiusMeters}m
                {distanceMeters !== null ? ` · Jarak Anda: ${distanceMeters}m` : ''}
              </p>
            </div>
          </InfoWindow>
        )}

        {/* Employee Real-time GPS Position Marker */}
        {gpsLat !== null && gpsLng !== null && (
          <AdvancedMarker
            position={{ lat: gpsLat, lng: gpsLng }}
            title="Posisi GPS Anda Saat Ini"
          >
            <div className="flex flex-col items-center">
              <span className="rounded-md bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm mb-1 whitespace-nowrap">
                Posisi Anda
              </span>
              <span
                className={`h-4 w-4 rounded-full border-2 border-white shadow-md ${
                  withinGeofence ? 'bg-emerald-600' : 'bg-sky-600'
                }`}
              />
            </div>
          </AdvancedMarker>
        )}
      </GoogleMap>

      {/* Recenter Map Button */}
      <button
        type="button"
        onClick={() => setRecenterSignal((s) => s + 1)}
        className="absolute right-3 top-3 z-10 inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white/95 px-2.5 py-1.5 text-[11px] font-semibold text-slate-800 shadow-xs hover:bg-white cursor-pointer"
        title="Pusatkan peta ke kantor dan GPS Anda"
      >
        <LocateFixed className="h-3.5 w-3.5 text-emerald-600" />
        Pusatkan
      </button>

      {/* Bottom Radius Status Badge */}
      <div className="pointer-events-none absolute bottom-2.5 left-2.5 z-10 rounded-lg border border-slate-200 bg-white/95 px-2.5 py-1 text-[11px] font-medium text-slate-700 shadow-xs">
        Radius Kantor: <span className="font-mono font-semibold">{branch.radiusMeters}m</span>
        {distanceMeters !== null && (
          <span
            className={`ml-1.5 font-mono font-semibold ${
              withinGeofence ? 'text-emerald-700' : 'text-rose-700'
            }`}
          >
            · Anda {distanceMeters}m
          </span>
        )}
      </div>
    </div>
  );
};

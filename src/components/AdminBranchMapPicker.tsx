import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  APILoadingStatus,
  AdvancedMarker,
  type AdvancedMarkerRef,
  Circle,
  Map as GoogleMap,
  InfoWindow,
  Pin,
  useAdvancedMarkerRef,
  useApiLoadingStatus,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import { Crosshair, MapPin, Navigation, Search, X } from 'lucide-react';
import type { Branch } from '../types';
import {
  DEMO_MAP_ID,
  GMP_ATTRIBUTION_IDS,
  GOOGLE_MAPS_API_KEY,
} from './GoogleMapsWrapper';

interface AdminBranchMapPickerProps {
  branches: Branch[];
  editingBranchId: string | null;
  targetLat: number;
  targetLng: number;
  targetRadius: number;
  targetLabel: string;
  onSelectCoordinates: (lat: number, lng: number) => void;
  onRadiusChange?: (radius: number) => void;
  onSelectExistingBranch?: (branch: Branch) => void;
  onPlaceSelected?: (payload: {
    name: string;
    address: string;
    city: string;
    lat: number;
    lng: number;
  }) => void;
}

function isQuotaError(err: unknown): boolean {
  const text =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null
      ? JSON.stringify(err)
      : String(err);
  return (
    text.includes('RESOURCE_EXHAUSTED') ||
    text.includes('OVER_QUERY_LIMIT') ||
    text.includes('429') ||
    text.includes('Quota')
  );
}

function CameraController({
  targetLat,
  targetLng,
  focusTrigger,
}: {
  targetLat: number;
  targetLng: number;
  focusTrigger: number;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;
    if (Number.isFinite(targetLat) && Number.isFinite(targetLng)) {
      map.panTo({ lat: targetLat, lng: targetLng });
    }
  }, [map, targetLat, targetLng, focusTrigger]);

  return null;
}

function ExistingBranchMarker({
  branch,
  onSelectMarker,
}: {
  branch: Branch;
  onSelectMarker: (
    br: Branch,
    marker: NonNullable<AdvancedMarkerRef>
  ) => void;
}) {
  const [markerRef, marker] = useAdvancedMarkerRef();

  return (
    <AdvancedMarker
      ref={markerRef}
      position={{ lat: branch.latitude, lng: branch.longitude }}
      title={`${branch.code} — ${branch.name}`}
      onClick={() => {
        if (marker) {
          onSelectMarker(branch, marker);
        }
      }}
    >
      <Pin
        background={branch.active ? '#334155' : '#94a3b8'}
        borderColor="#ffffff"
        glyphColor="#ffffff"
      />
    </AdvancedMarker>
  );
}

export const AdminBranchMapPicker: React.FC<AdminBranchMapPickerProps> = ({
  branches,
  editingBranchId,
  targetLat,
  targetLng,
  targetRadius,
  targetLabel,
  onSelectCoordinates,
  onRadiusChange,
  onSelectExistingBranch,
  onPlaceSelected,
}) => {
  const apiStatus = useApiLoadingStatus();
  const placesLib = useMapsLibrary('places');

  const [searchInput, setSearchInput] = useState('');
  type PlacesLib = NonNullable<ReturnType<typeof useMapsLibrary<'places'>>>;
  type AutocompleteSuggestionType = Awaited<
    ReturnType<PlacesLib['AutocompleteSuggestion']['fetchAutocompleteSuggestions']>
  >['suggestions'][number];
  type SessionTokenType = InstanceType<PlacesLib['AutocompleteSessionToken']>;

  const [suggestions, setSuggestions] = useState<AutocompleteSuggestionType[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [focusTrigger, setFocusTrigger] = useState(0);
  const [locatingSelf, setLocatingSelf] = useState(false);

  const [selectedInfoBranch, setSelectedInfoBranch] = useState<Branch | null>(null);
  const [infoMarker, setInfoMarker] = useState<AdvancedMarkerRef>(null);
  const [targetMarkerRef, targetMarker] = useAdvancedMarkerRef();
  const [showTargetInfo, setShowTargetInfo] = useState(false);

  const sessionTokenRef = useRef<SessionTokenType | null>(null);

  const safeLat = Number.isFinite(targetLat) ? targetLat : -6.2;
  const safeLng = Number.isFinite(targetLng) ? targetLng : 106.816666;
  const safeRadius = Math.max(20, Math.min(5000, Math.round(targetRadius || 250)));

  useEffect(() => {
    if (!placesLib || !GOOGLE_MAPS_API_KEY) return;
    const trimmed = searchInput.trim();
    if (trimmed.length < 3) {
      setSuggestions([]);
      setSearchNote(null);
      return;
    }

    const timer = window.setTimeout(async () => {
      setSearching(true);
      setSearchNote(null);
      try {
        const { AutocompleteSessionToken, AutocompleteSuggestion } = placesLib;
        if (!sessionTokenRef.current) {
          sessionTokenRef.current = new AutocompleteSessionToken();
        }
        const res = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: trimmed,
          sessionToken: sessionTokenRef.current,
          includedRegionCodes: ['id'],
        });
        setSuggestions(res.suggestions || []);
        if (!res.suggestions || res.suggestions.length === 0) {
          setSearchNote('Lokasi tidak ditemukan. Anda juga dapat klik langsung pada peta.');
        }
      } catch (err) {
        if (isQuotaError(err)) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
        }
        setSuggestions([]);
        setSearchNote('Pencarian alamat tidak tersedia. Klik langsung pada peta untuk menentukan titik.');
      } finally {
        setSearching(false);
      }
    }, 350);

    return () => window.clearTimeout(timer);
  }, [placesLib, searchInput]);

  const handleSelectSuggestion = useCallback(
    async (suggestion: AutocompleteSuggestionType) => {
      if (!suggestion.placePrediction) return;
      try {
        const place = suggestion.placePrediction.toPlace();
        await place.fetchFields({
          fields: [
            'displayName',
            'formattedAddress',
            'location',
            'addressComponents',
          ],
        });

        const loc = place.location;
        if (loc) {
          const lat = Number(loc.lat().toFixed(6));
          const lng = Number(loc.lng().toFixed(6));
          const components: Array<{ types: string[]; longText: string | null }> =
            place.addressComponents || [];
          const cityComp =
            components.find((c) => c.types.includes('administrative_area_level_2')) ||
            components.find((c) => c.types.includes('locality')) ||
            components.find((c) => c.types.includes('administrative_area_level_1'));
          const cityName = (cityComp?.longText || 'Indonesia')
            .replace(/^Kota\s+|^Kabupaten\s+/i, '')
            .trim();

          onSelectCoordinates(lat, lng);
          onPlaceSelected?.({
            name: place.displayName || '',
            address: place.formattedAddress || suggestion.placePrediction.text.text,
            city: cityName || 'Indonesia',
            lat,
            lng,
          });
          setFocusTrigger((c) => c + 1);
        }
      } catch (err) {
        if (isQuotaError(err)) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
        }
      } finally {
        sessionTokenRef.current = null;
        setSuggestions([]);
        setSearchInput('');
      }
    },
    [onSelectCoordinates, onPlaceSelected]
  );

  const handleLocateAdminGps = () => {
    if (!navigator.geolocation) return;
    setLocatingSelf(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(6));
        const lng = Number(pos.coords.longitude.toFixed(6));
        onSelectCoordinates(lat, lng);
        setFocusTrigger((c) => c + 1);
        setLocatingSelf(false);
      },
      () => {
        setLocatingSelf(false);
        setSearchNote('Izin GPS browser ditolak. Klik titik pada peta untuk memilih lokasi cabang.');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  if (
    !GOOGLE_MAPS_API_KEY ||
    apiStatus === APILoadingStatus.FAILED ||
    apiStatus === APILoadingStatus.AUTH_FAILURE
  ) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-xs text-slate-600 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-slate-900 inline-flex items-center gap-1.5">
            <MapPin className="h-4 w-4 text-emerald-600" />
            Pratinjau Koordinat & Radius Cabang
          </span>
          <span className="font-mono text-slate-700 tabular-nums">
            {safeLat.toFixed(6)}, {safeLng.toFixed(6)} · Radius {safeRadius}m
          </span>
        </div>
        <p className="text-[11px] text-slate-500">
          Peta Google Maps sedang tidak tersedia (periksa koneksi atau kuota API key). Anda tetap
          dapat memasukkan Latitude, Longitude, dan Radius Absen secara manual pada formulir di
          samping.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Search Bar & GPS Trigger */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Cari gedung, jalan, atau lokasi kantor cabang di Google Maps..."
            className="w-full min-h-[40px] rounded-lg border border-slate-200 bg-white pl-9 pr-8 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:outline-none"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => {
                setSearchInput('');
                setSuggestions([]);
                setSearchNote(null);
              }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
              aria-label="Hapus pencarian"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}

          {suggestions.length > 0 && (
            <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg divide-y divide-slate-100">
              {suggestions.map((item, idx) => (
                <li key={item.placePrediction?.placeId || idx}>
                  <button
                    type="button"
                    onClick={() => void handleSelectSuggestion(item)}
                    className="flex w-full items-start gap-2 px-3 py-2.5 text-left text-xs hover:bg-slate-50 cursor-pointer"
                  >
                    <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                    <span className="text-slate-800 leading-snug">
                      {item.placePrediction?.text.text}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button
          type="button"
          onClick={handleLocateAdminGps}
          disabled={locatingSelf}
          className="inline-flex min-h-[40px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
        >
          <Crosshair className="h-3.5 w-3.5 text-emerald-600" />
          {locatingSelf ? 'Mengunci...' : 'Lokasi Saya (GPS)'}
        </button>
      </div>

      {searching && (
        <p className="text-[11px] text-slate-500">Mencari lokasi melalui Google Places...</p>
      )}
      {searchNote && <p className="text-[11px] text-amber-700">{searchNote}</p>}

      {/* Map Canvas with Explicit CSS Height (CF2) */}
      <div className="relative h-[360px] sm:h-[420px] w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-100">
        <GoogleMap
          mapId={DEMO_MAP_ID}
          defaultCenter={{ lat: safeLat, lng: safeLng }}
          defaultZoom={15}
          gestureHandling="greedy"
          mapTypeControl={true}
          streetViewControl={false}
          fullscreenControl={true}
          internalUsageAttributionIds={GMP_ATTRIBUTION_IDS}
          className="h-full w-full"
          onClick={(ev) => {
            const latLng = ev.detail.latLng;
            if (!latLng) return;
            onSelectCoordinates(
              Number(latLng.lat.toFixed(6)),
              Number(latLng.lng.toFixed(6))
            );
          }}
        >
          <CameraController
            targetLat={safeLat}
            targetLng={safeLng}
            focusTrigger={focusTrigger}
          />

          {/* Existing synchronized branches + their geofence circles */}
          {branches.map((br) => {
            if (editingBranchId === br.id) return null;
            return (
              <React.Fragment key={br.id}>
                <Circle
                  center={{ lat: br.latitude, lng: br.longitude }}
                  radius={br.radiusMeters}
                  strokeColor={br.active ? '#64748b' : '#94a3b8'}
                  strokeOpacity={0.7}
                  strokeWeight={1.5}
                  fillColor={br.active ? '#94a3b8' : '#cbd5e1'}
                  fillOpacity={0.14}
                  clickable={false}
                />
                <ExistingBranchMarker
                  branch={br}
                  onSelectMarker={(branchItem, markerEl) => {
                    setSelectedInfoBranch(branchItem);
                    setInfoMarker(markerEl);
                  }}
                />
              </React.Fragment>
            );
          })}

          {/* Active Editable / Draft Branch Circle */}
          <Circle
            center={{ lat: safeLat, lng: safeLng }}
            radius={safeRadius}
            strokeColor="#059669"
            strokeOpacity={0.95}
            strokeWeight={2}
            fillColor="#10b981"
            fillOpacity={0.2}
            editable={Boolean(onRadiusChange)}
            draggable={true}
            onRadiusChanged={(newRadius) => {
              if (!onRadiusChange || !Number.isFinite(newRadius)) return;
              const clamped = Math.max(20, Math.min(5000, Math.round(newRadius)));
              if (Math.abs(clamped - safeRadius) >= 2) {
                onRadiusChange(clamped);
              }
            }}
            onCenterChanged={(newCenter) => {
              if (!newCenter) return;
              const nextLat = Number(newCenter.lat().toFixed(6));
              const nextLng = Number(newCenter.lng().toFixed(6));
              if (
                Math.abs(nextLat - safeLat) > 0.00001 ||
                Math.abs(nextLng - safeLng) > 0.00001
              ) {
                onSelectCoordinates(nextLat, nextLng);
              }
            }}
          />

          {/* Active Editable / Draft Branch Pin */}
          <AdvancedMarker
            ref={targetMarkerRef}
            position={{ lat: safeLat, lng: safeLng }}
            draggable={true}
            title={targetLabel || 'Lokasi Cabang'}
            onClick={() => setShowTargetInfo((prev) => !prev)}
            onDragEnd={(ev) => {
              const latLng = ev.latLng;
              if (!latLng) return;
              onSelectCoordinates(
                Number(latLng.lat().toFixed(6)),
                Number(latLng.lng().toFixed(6))
              );
            }}
          >
            <Pin
              background="#059669"
              borderColor="#064e3b"
              glyphColor="#ffffff"
              scale={1.15}
            />
          </AdvancedMarker>

          {showTargetInfo && targetMarker && (
            <InfoWindow
              anchor={targetMarker}
              onCloseClick={() => setShowTargetInfo(false)}
            >
              <div className="p-1 text-xs space-y-1 max-w-[220px]">
                <p className="font-bold text-slate-900">
                  {targetLabel || (editingBranchId ? 'Cabang Diedit' : 'Titik Cabang Baru')}
                </p>
                <p className="font-mono text-[11px] text-slate-600 tabular-nums">
                  {safeLat.toFixed(6)}, {safeLng.toFixed(6)}
                </p>
                <p className="text-[11px] font-semibold text-emerald-700">
                  Radius Absen: {safeRadius} meter
                </p>
              </div>
            </InfoWindow>
          )}

          {selectedInfoBranch && infoMarker && (
            <InfoWindow
              anchor={infoMarker}
              onCloseClick={() => setSelectedInfoBranch(null)}
            >
              <div className="p-1 text-xs space-y-1.5 max-w-[220px]">
                <p className="font-bold text-slate-900">
                  {selectedInfoBranch.code} — {selectedInfoBranch.name}
                </p>
                <p className="text-[11px] text-slate-600">{selectedInfoBranch.address}</p>
                <p className="font-mono text-[11px] text-slate-700">
                  Radius {selectedInfoBranch.radiusMeters}m · {selectedInfoBranch.shiftStart}–
                  {selectedInfoBranch.shiftEnd}
                </p>
                {onSelectExistingBranch && (
                  <button
                    type="button"
                    onClick={() => {
                      onSelectExistingBranch(selectedInfoBranch);
                      setSelectedInfoBranch(null);
                    }}
                    className="inline-flex w-full items-center justify-center gap-1 rounded-md bg-slate-900 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-slate-800 cursor-pointer"
                  >
                    Edit Lokasi & Radius Ini
                  </button>
                )}
              </div>
            </InfoWindow>
          )}
        </GoogleMap>

        {/* Bottom-left Legend Pill Overlay */}
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-lg border border-slate-200 bg-white/95 px-3 py-1.5 text-[11px] text-slate-700 shadow-xs backdrop-blur-xs">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <Navigation className="h-3 w-3 text-emerald-600" />
            Klik peta / geser pin atau lingkaran hijau untuk atur koordinat & radius ({safeRadius}m)
          </span>
        </div>
      </div>
    </div>
  );
};

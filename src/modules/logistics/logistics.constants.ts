import { SettingsService } from '../settings/settings.service';

/** Runtime-configurable logistics thresholds (settings key 'logisticsThresholds'). */
export interface LogisticsThresholds {
  gpsStaleMinutes: number;
  gpsOfflineMinutes: number;
  stationaryAlertMinutes: number;
  etaRefreshMinutes: number;
  etaRefreshDistanceKm: number;
  delayToleranceMinutes: number;
  routeDeviationKm: number;
  routeDeviationMinPoints: number;
  geofenceMinPoints: number;
  averageSpeedKmh: number;
  roadFactor: number;
  documentExpiryWarningDays: number;
  maxPositionAgeHours: number;
  maxFutureSkewMinutes: number;
}

export const DEFAULT_LOGISTICS_THRESHOLDS: LogisticsThresholds = {
  gpsStaleMinutes: 10,
  gpsOfflineMinutes: 60,
  stationaryAlertMinutes: 210,
  etaRefreshMinutes: 5,
  etaRefreshDistanceKm: 2,
  delayToleranceMinutes: 30,
  routeDeviationKm: 2,
  routeDeviationMinPoints: 3,
  geofenceMinPoints: 2,
  averageSpeedKmh: 45,
  roadFactor: 1.3,
  documentExpiryWarningDays: 30,
  maxPositionAgeHours: 72,
  maxFutureSkewMinutes: 5
};

export async function logisticsThresholds(settings: SettingsService): Promise<LogisticsThresholds> {
  return { ...DEFAULT_LOGISTICS_THRESHOLDS, ...(await settings.get<Partial<LogisticsThresholds>>('logisticsThresholds', {})) };
}

/** Logistics list response envelope */
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function pageParams(q: { page?: unknown; pageSize?: unknown }) {
  const page = Math.max(parseInt(String(q.page ?? '1'), 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(String(q.pageSize ?? '50'), 10) || 50, 1), 200);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

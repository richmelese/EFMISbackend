import { SettingsService } from '../settings/settings.service';

/** Re-exported for existing imports — the implementation lives in common/utils/pagination. */
export { Paged, pageParams } from '../../common/utils/pagination';

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

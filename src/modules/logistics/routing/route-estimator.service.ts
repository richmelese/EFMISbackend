import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { haversineKm, LatLng, polylineLengthKm } from '../../../common/utils/geo';
import { round } from '../../../common/utils/helpers';
import { SettingsService } from '../../settings/settings.service';
import { logisticsThresholds } from '../logistics.constants';

export interface RouteEstimate {
  distanceKm: number;
  durationMin: number;
  geometry: LatLng[];
  source: 'ROUTING_PROVIDER' | 'STRAIGHT_LINE';
}

const PROVIDER_TIMEOUT_MS = 5000;

/**
 * Road distance / duration / geometry (Logistics doc §12: "Use a road-routing provider for road-based ETA where possible").
 *  - logistics.routingProviderUrl set → OSRM-compatible `/route/v1/driving/{lng},{lat};{lng},{lat}` (5 s timeout)
 *  - otherwise, or on any provider error → straight line × roadFactor at averageSpeedKmh (settings 'logisticsThresholds')
 */
@Injectable()
export class RouteEstimatorService {
  private readonly logger = new Logger('RouteEstimator');

  constructor(private readonly config: ConfigService, private readonly settings: SettingsService) {}

  async estimate(origin: LatLng, destination: LatLng, viaGeometry?: LatLng[]): Promise<RouteEstimate> {
    const url = (this.config.get<string>('logistics.routingProviderUrl') || '').replace(/\/+$/, '');
    if (url) {
      try {
        return await this.fromProvider(url, origin, destination, viaGeometry);
      } catch (err) {
        this.logger.warn(`Routing provider failed, falling back to straight line: ${(err as Error)?.message}`);
      }
    }
    return this.straightLine(origin, destination, viaGeometry);
  }

  async straightLine(origin: LatLng, destination: LatLng, viaGeometry?: LatLng[]): Promise<RouteEstimate> {
    const t = await logisticsThresholds(this.settings);
    const geometry: LatLng[] = viaGeometry && viaGeometry.length >= 2 ? viaGeometry : [origin, destination];
    // A supplied corridor is already road-like; a 2-point straight line is inflated by the road factor.
    const raw = viaGeometry && viaGeometry.length >= 2 ? polylineLengthKm(viaGeometry) : haversineKm(origin, destination) * (t.roadFactor || 1);
    const distanceKm = round(raw, 2);
    const durationMin = round((distanceKm / Math.max(t.averageSpeedKmh || 45, 1)) * 60, 1);
    return { distanceKm, durationMin, geometry, source: 'STRAIGHT_LINE' };
  }

  private async fromProvider(url: string, origin: LatLng, destination: LatLng, via?: LatLng[]): Promise<RouteEstimate> {
    // OSRM coordinate order is lng,lat. Intermediate vertices of a supplied corridor are not sent (URL length); only endpoints.
    void via;
    const coords = `${origin[1]},${origin[0]};${destination[1]},${destination[0]}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROVIDER_TIMEOUT_MS);
    try {
      const res = await fetch(`${url}/route/v1/driving/${coords}?overview=simplified&geometries=geojson`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: any = await res.json();
      const r = body?.routes?.[0];
      if (body?.code && body.code !== 'Ok') throw new Error(`provider code ${body.code}`);
      if (!r || typeof r.distance !== 'number' || typeof r.duration !== 'number') throw new Error('no route in response');
      const coordsOut: Array<[number, number]> = Array.isArray(r.geometry?.coordinates) ? r.geometry.coordinates : [];
      const geometry: LatLng[] = coordsOut
        .filter(c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))
        .map(c => [c[1], c[0]] as LatLng);
      return {
        distanceKm: round(r.distance / 1000, 2),
        durationMin: round(r.duration / 60, 1),
        geometry: geometry.length >= 2 ? geometry : [origin, destination],
        source: 'ROUTING_PROVIDER'
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

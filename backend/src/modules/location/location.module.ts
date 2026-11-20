import {
  Module, Injectable, Controller, Get, Query, Param, BadRequestException, Logger, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { Public } from '../../common';

// ─── Types ───────────────────────────────────────────────────────────────────
// Future-ready interfaces — swap provider without touching callers

export interface ReverseGeocodeResult {
  fullAddress: string;
  area: string;        // suburb / locality
  city: string;
  state: string;
  country: string;
  pincode: string;
  provider: string;    // 'nominatim' | 'google' | 'manual'
}

export interface IfscResult {
  ifsc: string;
  bank: string;
  branch: string;
  address: string;
  city: string;
  state: string;
}

export interface PincodeResult {
  pincode: string;
  area: string;
  city: string;
  state: string;
  country: string;
}

// ─── Service ─────────────────────────────────────────────────────────────────
@Injectable()
export class LocationService {
  private readonly logger = new Logger(LocationService.name);

  // India bounding box validation
  private isValidIndia(lat: number, lng: number): boolean {
    return lat >= 6.5 && lat <= 37.6 && lng >= 68.1 && lng <= 97.4;
  }

  /**
   * Reverse geocode using Nominatim (OpenStreetMap) — FREE, no API key.
   * Swap this method body with Google Geocoding API call in the future.
   * Rate limit: 1 req/sec. User-Agent header is required by Nominatim policy.
   */
  async reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
    if (!this.isValidIndia(lat, lng)) {
      throw new BadRequestException('Coordinates out of India bounds');
    }

    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1&accept-language=en`;
    this.logger.log(`Reverse geocoding: ${lat},${lng}`);

    const res = await fetch(url, {
      headers: { 'User-Agent': 'RemontIndia/1.0 (contact@remontindia.com)' },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) throw new BadRequestException('Geocoding service unavailable');

    const data: any = await res.json();
    const a = data.address || {};

    return {
      fullAddress: data.display_name || '',
      area:        a.suburb || a.neighbourhood || a.quarter || a.village || '',
      city:        a.city || a.town || a.municipality || a.county || a.state_district || a.district || a.village || '',
      state:       a.state || '',
      country:     a.country || 'India',
      pincode:     a.postcode || '',
      provider:    'nominatim',
    };
  }

  /**
   * Lookup PIN code details using postalpincode.in — FREE, India-only, no API key.
   * Swap with Google Places / Maps API in the future.
   */
  async lookupPincode(pincode: string): Promise<PincodeResult> {
    if (!/^\d{6}$/.test(pincode)) {
      throw new BadRequestException('PIN code must be exactly 6 digits');
    }

    const url = `https://api.postalpincode.in/pincode/${pincode}`;
    this.logger.log(`Pincode lookup: ${pincode}`);

    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) throw new BadRequestException('Pincode service unavailable');

    const [data]: any[] = await res.json();

    if (data?.Status !== 'Success' || !data.PostOffice?.length) {
      throw new BadRequestException('Pincode not found');
    }

    const po = data.PostOffice[0];
    return {
      pincode,
      area:    po.Name    || '',
      city:    po.District || po.Division || '',
      state:   po.State   || '',
      country: 'India',
    };
  }

  // Successful IFSC lookups rarely change — cache them so repeated form edits don't re-hit
  // the upstream service. Bounded so it can never grow without limit.
  private readonly ifscCache = new Map<string, IfscResult>();

  /**
   * IFSC → bank + branch, using Razorpay's public IFSC service (ifsc.razorpay.com) — FREE,
   * open data, no API key. Only the IFSC code is sent. Used by seller registration so the
   * bank name / branch are filled from an authoritative source instead of typed by hand.
   */
  async lookupIfsc(code: string): Promise<IfscResult> {
    const ifsc = String(code || '').trim().toUpperCase();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
      throw new BadRequestException('Enter a valid 11-character IFSC (e.g. HDFC0001234)');
    }
    const cached = this.ifscCache.get(ifsc);
    if (cached) return cached;

    let res: Response;
    try {
      res = await fetch(`https://ifsc.razorpay.com/${ifsc}`, { signal: AbortSignal.timeout(6000) });
    } catch {
      throw new ServiceUnavailableException('IFSC lookup is unavailable right now — enter bank details manually');
    }
    if (res.status === 404) throw new NotFoundException('IFSC code not found');
    if (!res.ok) throw new ServiceUnavailableException('IFSC lookup is unavailable right now — enter bank details manually');

    const d: any = await res.json();
    const result: IfscResult = {
      ifsc,
      bank:    String(d?.BANK || ''),
      branch:  String(d?.BRANCH || ''),
      address: String(d?.ADDRESS || ''),
      city:    String(d?.CITY || d?.DISTRICT || ''),
      state:   String(d?.STATE || ''),
    };
    if (this.ifscCache.size >= 2000) this.ifscCache.clear();
    this.ifscCache.set(ifsc, result);
    return result;
  }

  /**
   * Open navigation in Google Maps using standard URL — NO API key needed.
   * Returns the URL; frontend opens it in a new tab.
   */
  buildNavigationUrl(lat: number, lng: number, label?: string): string {
    if (!this.isValidIndia(lat, lng)) {
      throw new BadRequestException('Invalid coordinates');
    }
    let url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    if (label) url += `&travelmode=driving`;
    return url;
  }

  /** Validate that lat/lng are plausible (India bounds) */
  validateCoords(lat: number, lng: number): boolean {
    return this.isValidIndia(lat, lng);
  }
}

// ─── Controller ───────────────────────────────────────────────────────────────
@Controller('location')
export class LocationController {
  constructor(private loc: LocationService) {}

  /** Reverse geocode — browser sends GPS coords, we return address via Nominatim */
  @Public()
  @Get('reverse-geocode')
  async reverseGeocode(
    @Query('lat') latStr: string,
    @Query('lng') lngStr: string,
  ) {
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);
    if (isNaN(lat) || isNaN(lng)) throw new BadRequestException('lat and lng are required numbers');
    return this.loc.reverseGeocode(lat, lng);
  }

  /** Pincode lookup — returns city, state, area */
  @Public()
  @Get('pincode/:pin')
  async pincode(@Param('pin') pin: string) {
    return this.loc.lookupPincode(pin);
  }

  /** IFSC → bank name + branch (seller registration bank step). */
  @Public()
  @Get('ifsc/:code')
  ifsc(@Param('code') code: string) {
    return this.loc.lookupIfsc(code);
  }

  /** Navigation URL builder — no API key */
  @Public()
  @Get('navigate')
  navigate(@Query('lat') latStr: string, @Query('lng') lngStr: string, @Query('label') label?: string) {
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);
    if (isNaN(lat) || isNaN(lng)) throw new BadRequestException('lat and lng required');
    return { url: this.loc.buildNavigationUrl(lat, lng, label) };
  }
}

// ─── Module ──────────────────────────────────────────────────────────────────
@Module({
  controllers: [LocationController],
  providers:   [LocationService],
  exports:     [LocationService],
})
export class LocationModule {}

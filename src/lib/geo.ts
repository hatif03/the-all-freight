// Geocoding for the route map. Tries a built-in table of major ports/cities
// first (instant, always works for the demo presets), then falls back to the
// free OpenStreetMap Nominatim geocoder for anything else.

import type { GeoPoint } from "./types";

// [lat, lng] for common origins/destinations in global trade.
const PORTS: Record<string, [number, number]> = {
  shanghai: [31.23, 121.47],
  ningbo: [29.87, 121.54],
  shenzhen: [22.54, 114.06],
  guangzhou: [23.13, 113.26],
  "hong kong": [22.32, 114.17],
  qingdao: [36.07, 120.38],
  tianjin: [39.13, 117.2],
  busan: [35.18, 129.08],
  tokyo: [35.68, 139.69],
  yokohama: [35.44, 139.64],
  singapore: [1.35, 103.82],
  "port klang": [3.0, 101.4],
  "ho chi minh": [10.82, 106.63],
  dhaka: [23.81, 90.41],
  chittagong: [22.36, 91.78],
  mumbai: [19.08, 72.88],
  "nhava sheva": [18.95, 72.95],
  dubai: [25.2, 55.27],
  "jebel ali": [25.01, 55.06],
  rotterdam: [51.95, 4.14],
  antwerp: [51.26, 4.4],
  hamburg: [53.55, 9.99],
  felixstowe: [51.96, 1.35],
  "los angeles": [33.74, -118.27],
  "long beach": [33.75, -118.19],
  oakland: [37.8, -122.27],
  seattle: [47.6, -122.33],
  vancouver: [49.28, -123.12],
  "new york": [40.71, -74.0],
  savannah: [32.08, -81.09],
  houston: [29.76, -95.37],
  charleston: [32.78, -79.93],
};

function builtin(place: string): [number, number] | null {
  const p = place.toLowerCase();
  for (const [name, coords] of Object.entries(PORTS)) {
    if (p.includes(name)) return coords;
  }
  return null;
}

async function nominatim(place: string): Promise<[number, number] | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "TheAllFreight/1.0 (logistics risk demo)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ lat: string; lon: string }>;
    if (!data.length) return null;
    return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
  } catch {
    return null;
  }
}

export async function geocode(place: string): Promise<GeoPoint | null> {
  if (!place) return null;
  const coords = builtin(place) ?? (await nominatim(place));
  if (!coords) return null;
  return { name: place, lat: coords[0], lng: coords[1] };
}

/** Great-circle distance in km. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

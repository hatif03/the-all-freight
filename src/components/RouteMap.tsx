"use client";

import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import type { PortOption, RouteGeo } from "@/lib/types";

function congColor(score: number): string {
  if (score >= 70) return "#f43f5e";
  if (score >= 45) return "#f59e0b";
  return "#22c55e";
}

// Great-circle arc between two points, with longitude "unwrapped" so trans-
// Pacific routes draw as one continuous line instead of wrapping the map.
function greatCircle(a: [number, number], b: [number, number], n = 64): [number, number][] {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const [lat1, lon1] = [toRad(a[0]), toRad(a[1])];
  const [lat2, lon2] = [toRad(b[0]), toRad(b[1])];
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
      ),
    );
  const pts: [number, number][] = [];
  let prevLon = a[1];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = d === 0 ? 1 - f : Math.sin((1 - f) * d) / Math.sin(d);
    const B = d === 0 ? f : Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    const lat = toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)));
    let lon = toDeg(Math.atan2(y, x));
    while (lon - prevLon > 180) lon -= 360;
    while (lon - prevLon < -180) lon += 360;
    prevLon = lon;
    pts.push([lat, lon]);
  }
  return pts;
}

export function RouteMap({ geo, ports = [] }: { geo: RouteGeo; ports?: PortOption[] }) {
  const elRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      if (cancelled || !elRef.current || mapRef.current) return;

      const map = L.map(elRef.current, {
        zoomControl: false,
        scrollWheelZoom: false,
        attributionControl: true,
        worldCopyJump: true,
      });
      mapRef.current = map;

      L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        attribution: '© OpenStreetMap contributors © CARTO',
        subdomains: "abcd",
        maxZoom: 19,
      }).addTo(map);

      const o: [number, number] = [geo.origin.lat, geo.origin.lng];
      const arc = greatCircle(o, [geo.destination.lat, geo.destination.lng]);
      const dest = arc[arc.length - 1]; // unwrapped destination

      L.polyline(arc, { color: "#38bdf8", weight: 2.5, opacity: 0.9, dashArray: "6,7" }).addTo(map);

      const dot = (latlng: [number, number], color: string, label: string) =>
        L.circleMarker(latlng, {
          radius: 7,
          color,
          weight: 2,
          fillColor: color,
          fillOpacity: 1,
        })
          .addTo(map)
          .bindTooltip(label, { direction: "top", offset: [0, -6] });

      dot(o, "#2dd4bf", `Origin: ${geo.origin.name}`);
      dot(dest, "#f43f5e", `Destination: ${geo.destination.name}`);

      // Candidate ports, colored by congestion. Unwrap longitude to match dest.
      const bounds: [number, number][] = [o, dest];
      for (const p of ports) {
        if (p.lat == null || p.lng == null) continue;
        let lon = p.lng;
        while (lon - dest[1] > 180) lon -= 360;
        while (lon - dest[1] < -180) lon += 360;
        const latlng: [number, number] = [p.lat, lon];
        const color = congColor(p.congestionScore);
        if (p.recommended) {
          L.circleMarker(latlng, { radius: 11, color, weight: 2, fillColor: color, fillOpacity: 0.15 }).addTo(map);
        }
        L.circleMarker(latlng, { radius: 6, color, weight: 2, fillColor: color, fillOpacity: 0.95 })
          .addTo(map)
          .bindTooltip(`${p.name} · congestion ${p.congestionScore}/100${p.recommended ? " ✓ recommended" : ""}`, {
            direction: "top",
            offset: [0, -6],
          });
        bounds.push(latlng);
      }

      map.fitBounds(L.latLngBounds(bounds).pad(0.3), { animate: false });
    })();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [geo]);

  return <div ref={elRef} className="h-72 w-full rounded-xl overflow-hidden border border-border" />;
}

"use client";

import { useEffect, useRef } from "react";
// maplibre-gl v6 is ESM-only with no synthetic default export — use the namespace import.
import * as maplibregl from "maplibre-gl";

interface Vessel {
  mmsi: number;
  name: string;
  lat: number;
  lon: number;
  sog: number;
  cog: number;
  destination: string | null;
}

interface Anchorage {
  port_code: string;
  polygon: [number, number][]; // [lat, lon] pairs
}

// Vessel + anchorage overlay on a MapLibre basemap. Fetches `/vessels/positions`
// once on load and again whenever the disrupted vessel (from the active
// incident) changes, so the map flies to and highlights it.
export function VesselMap({
  apiBaseUrl,
  disruptedMmsi,
  port,
}: {
  apiBaseUrl: string;
  disruptedMmsi?: number | null;
  port?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<{ [mmsi: number]: maplibregl.Marker }>({});

  const updateLayers = async () => {
    const map = mapRef.current;
    if (!map) return;
    try {
      const res = await fetch(`${apiBaseUrl}/vessels/positions`);
      const data = await res.json();
      const vessels: Vessel[] = data.vessels ?? [];
      const anchorages: Anchorage[] = data.anchorages ?? [];

      vessels.forEach((v) => {
        const isDisrupted = disruptedMmsi === v.mmsi;
        markersRef.current[v.mmsi]?.remove();

        const el = document.createElement("div");
        el.className = isDisrupted
          ? "w-8 h-8 rounded-full flex items-center justify-center cursor-pointer ops-vessel-marker"
          : "w-5 h-5 rounded-full border border-accent-2/60 bg-panel/80 flex items-center justify-center cursor-pointer hover:bg-accent-2 transition-colors";
        el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${isDisrupted ? 16 : 10}" height="${isDisrupted ? 16 : 10}" viewBox="0 0 24 24" fill="none" stroke="${isDisrupted ? "#ffffff" : "#0284c7"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 21h20"/><path d="M19.3 14.8C21.1 13.5 22 11.7 22 10c0-3.9-3.1-7-7-7-2 0-3.8.8-5.2 2.2L3 12v6h6l6.8-6.8c1.4-1.4 3.2-2.2 5.2-2.2z"/></svg>`;

        const popup = new maplibregl.Popup({ offset: 15 }).setHTML(`
          <div style="font-size:12px; line-height:1.5;">
            <div style="font-weight:700; display:flex; align-items:center; gap:6px;">
              <span style="width:7px; height:7px; border-radius:50%; background:${isDisrupted ? "#e11d48" : "#16a34a"};"></span>
              ${v.name}
            </div>
            <div style="opacity:0.7; font-size:11px; margin-top:4px;">MMSI ${v.mmsi}</div>
            <div style="opacity:0.7; font-size:11px;">Destination: ${v.destination || "N/A"}</div>
            <div style="opacity:0.7; font-size:11px;">SOG ${v.sog} kn · COG ${v.cog}°</div>
            ${isDisrupted ? '<div style="color:#e11d48; font-weight:700; margin-top:5px; font-size:11px;">⚠ INCIDENT VESSEL</div>' : ""}
          </div>
        `);

        markersRef.current[v.mmsi] = new maplibregl.Marker(el)
          .setLngLat([v.lon, v.lat])
          .setPopup(popup)
          .addTo(map);

        if (isDisrupted) {
          map.flyTo({ center: [v.lon, v.lat], zoom: 12, speed: 1.2, curve: 1.4, essential: true });
        }
      });

      anchorages.forEach((a) => {
        const sourceId = `anchorage-src-${a.port_code}`;
        const coords: [number, number][] = [
          ...a.polygon.map((p) => [p[1], p[0]] as [number, number]),
          [a.polygon[0][1], a.polygon[0][0]],
        ];
        const geojson: GeoJSON.Feature<GeoJSON.Polygon> = {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [coords] },
          properties: {},
        };

        const existing = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
        if (existing) {
          existing.setData(geojson);
          return;
        }

        map.addSource(sourceId, { type: "geojson", data: geojson });
        map.addLayer({
          id: `anchorage-layer-${a.port_code}`,
          type: "fill",
          source: sourceId,
          paint: { "fill-color": "#d97706", "fill-opacity": 0.08, "fill-outline-color": "#d97706" },
        });
        map.addLayer({
          id: `anchorage-layer-${a.port_code}-border`,
          type: "line",
          source: sourceId,
          paint: { "line-color": "#d97706", "line-width": 1.5, "line-dasharray": [3, 2] },
        });
      });
    } catch (err) {
      console.error("Failed to load vessel map layers:", err);
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
      center: [-118.21, 33.74], // LA/Long Beach — the demo port complex
      zoom: 10,
      pitch: 45,
      bearing: 15,
    });
    mapRef.current = map;
    map.on("load", updateLayers);

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (mapRef.current?.loaded()) updateLayers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disruptedMmsi]);

  return (
    <div className="bg-panel border border-border rounded-2xl overflow-hidden relative">
      <div ref={containerRef} className="w-full h-[300px] md:h-[340px]" />

      <div className="absolute top-3.5 left-3.5 text-[10px] mono text-muted tracking-wider pointer-events-none">
        {port ? `${port.toUpperCase()} · ANCHORAGE` : "AWAITING DISRUPTION SIGNAL"}
      </div>

      <div className="absolute bottom-3 left-3.5 flex items-center gap-2 bg-panel backdrop-blur border border-ok/25 px-2.5 py-1.5 rounded-lg">
        <span className="w-1.5 h-1.5 rounded-full bg-ok" />
        <span className="text-[10px] mono text-ok">Vessel reporting · satellite stream</span>
      </div>
      <div className="absolute bottom-3 right-3.5 text-[9px] mono text-muted/70 pointer-events-none">
        MapLibre GL · CartoDB
      </div>
    </div>
  );
}

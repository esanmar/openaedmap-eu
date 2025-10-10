import MaplibreGeocoder, {
  type MaplibreGeocoderOptions,
} from "@maplibre/maplibre-gl-geocoder";
import "@maplibre/maplibre-gl-geocoder/dist/maplibre-gl-geocoder.css";
import maplibregl, {
  type MapGeoJSONFeature,
  type MapMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { type FC, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "~/appContext";
import { fetchCountriesData, fetchNodeDataFromBackend } from "~/backend";
import nominatimGeocoder from "~/components/nominatimGeocoder";
import { useLanguage } from "~/i18n";
import {
  addNodeIdToHash,
  getMapLocation,
  locationParameter,
  parseParametersFromUrl,
  removeNodeIdFromHash,
  saveLocationToLocalStorage,
} from "~/location";
import ButtonsType from "~/model/buttonsType";
import type { DefibrillatorData } from "~/model/defibrillatorData";
import { initialModalState, ModalType } from "~/model/modal";
import SidebarAction from "~/model/sidebarAction";
import FooterDiv from "./footer";
import "./map.css";
import mapStyle, {
  LAYER_CLUSTERED_CIRCLE,
  LAYER_CLUSTERED_CIRCLE_LOW_ZOOM,
  LAYER_UNCLUSTERED,
  LAYER_UNCLUSTERED_LOW_ZOOM,
} from "./map_style";
import SidebarLeft from "./sidebar-left";


/**
 * Helper function that fetches details for a given OSM node ID and opens
 * the sidebar. This mirrors the implementation from the original
 * OpenAEDMap frontend. Without this function the call in handlePointClick
 * causes a ReferenceError.
 */
function fillSidebarWithOsmDataAndShow(
  nodeId: string,
  mapInstance: maplibregl.Map,
  setSidebarAction: (action: SidebarAction) => void,
  setSidebarData: (data: DefibrillatorData) => void,
  setSidebarLeftShown: (sidebarLeftShown: boolean) => void,
  jumpInsteadOfEaseTo: boolean,
) {
  const result = fetchNodeDataFromBackend(nodeId);
  result.then((data) => {
    if (data) {
      const zoomLevelForDetailedView = 17;
      const currentZoomLevel = mapInstance.getZoom();
      if (currentZoomLevel < zoomLevelForDetailedView) {
        if (jumpInsteadOfEaseTo) {
          mapInstance.jumpTo({
            zoom: zoomLevelForDetailedView,
            center: [data.lon, data.lat],
          });
        } else {
          mapInstance.easeTo({
            zoom: zoomLevelForDetailedView,
            around: { lon: data.lon, lat: data.lat },
          });
        }
      } else if (jumpInsteadOfEaseTo) {
        mapInstance.jumpTo({
          zoom: currentZoomLevel,
          center: [data.lon, data.lat],
        });
      } else {
        mapInstance.easeTo({
          zoom: currentZoomLevel,
          around: { lon: data.lon, lat: data.lat },
        });
      }
      setSidebarData(data);
      setSidebarAction(SidebarAction.showDetails);
      setSidebarLeftShown(true);
    }
  });
  // Hacer la función global para evitar el ReferenceError en el código compilado
  (window as any).fillSidebarWithOsmDataAndShow = fillSidebarWithOsmDataAndShow;
}

// Identifier for our custom GeoJSON source.
const GEOJSON_SOURCE_ID = "aed-geojson";
// Path to the converted GeoJSON file. Change this when updating the data.
const GEOJSON_URL = "/data/EU_osm.geojson";

/**
 * Escape HTML entities to avoid injection in popups.
 */
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as const)[c]!,
  );
}

/**
 * Build a popup HTML string using available properties. When a
 * feature doesn't come from OSM, we don't have a full sidebar so we
 * provide a simple popup with name, address, location and opening
 * hours. Navigation links are added using the coordinates so users
 * can still navigate to the AED.
 */
function buildPopupHtml(props: Record<string, unknown>, coords: [number, number]) {
  const [lon, lat] = coords;
  const name =
    (props.name as string) || (props.organismo as string) || (props.operator as string) || "";
  const address =
    (props.address as string) ||
    [props.direccion, props.municipio, props.provincia].filter(Boolean).join(", ") ||
    "";
  const location =
    (props["defibrillator:location"] as string) || (props.ubicacion as string) || "";
  const oh = (props.opening_hours as string) || (props.horario as string) || "";
  const rows: string[] = [];
  if (name) rows.push(`<div><strong>${escapeHtml(name)}</strong></div>`);
  if (address) rows.push(`<div>${escapeHtml(address)}</div>`);
  if (location) rows.push(`<div><em>${escapeHtml(location)}</em></div>`);
  if (oh) rows.push(`<div><small>Horario: ${escapeHtml(oh)}</small></div>`);
  // Add navigation links using coordinates
  const googleLink = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
  const osmLink = `https://www.openstreetmap.org/directions?engine=graphhopper_car&route=${lat}%2C${lon}`;
  rows.push(
    `<div style="margin-top:0.5rem"><a href="${googleLink}" target="_blank" rel="noopener">Navegación con Google Maps</a> · <a href="${osmLink}" target="_blank" rel="noopener">Navegación con OpenStreetMap</a></div>`,
  );
  return rows.join("");
}

/**
 * Load the GeoJSON data and ensure that the source and layers are present.
 * This function is idempotent: if the source exists it updates the data,
 * otherwise it creates the source and layers. Clustering is enabled
 * consistent with the original map (maxzoom 16, cluster up to 15).
 */
async function ensureGeojsonLayers(map: maplibregl.Map) {
  // Fetch the GeoJSON data as an object
  const res = await fetch(GEOJSON_URL, { cache: "no-store" });
  if (!res.ok) {
    console.error(`[EU_osm] HTTP ${res.status} al cargar ${GEOJSON_URL}`);
    return;
  }
  const data = (await res.json()) as GeoJSON.FeatureCollection;
  const features = data.features || [];
  if (!features.length) {
    console.warn("[EU_osm] No hay features en el GeoJSON.");
  }
  // If the source already exists, just update its data
  const existing = map.getSource(GEOJSON_SOURCE_ID) as any;
  if (existing && typeof existing.setData === "function") {
    existing.setData(data);
    return;
  }
  // Otherwise, remove any leftover layers (defensive) and add our source
  for (const id of [
    LAYER_CLUSTERED_CIRCLE,
    LAYER_CLUSTERED_CIRCLE_LOW_ZOOM,
    LAYER_UNCLUSTERED,
    LAYER_UNCLUSTERED_LOW_ZOOM,
  ]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(GEOJSON_SOURCE_ID)) {
    map.removeSource(GEOJSON_SOURCE_ID);
  }
  // Add the GeoJSON source with clustering enabled. According to the
  // original map style, the defibrillator vector tiles stop at zoom 16:contentReference[oaicite:1]{index=1}.
  map.addSource(GEOJSON_SOURCE_ID, {
    type: "geojson",
    data,
    cluster: true,
    clusterMaxZoom: 15, // cluster up to zoom 15
    maxzoom: 16, // consistent with style:contentReference[oaicite:2]{index=2}
    clusterRadius: 20,
  } as any);
  // Add layers replicating the original map style. The IDs must match
  // those imported from map_style so that event handlers continue to work.
  map.addLayer({
    id: LAYER_CLUSTERED_CIRCLE,
    type: "circle",
    source: GEOJSON_SOURCE_ID,
    filter: ["has", "point_count"],
    paint: {
      "circle-color": [
        "step",
        ["get", "point_count"],
        "#88b04b",
        10,
        "#f1c40f",
        50,
        "#e74c3c",
      ],
      "circle-radius": [
        "step",
        ["get", "point_count"],
        14,
        10,
        20,
        50,
        28,
      ],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  });
  map.addLayer({
    id: LAYER_CLUSTERED_CIRCLE_LOW_ZOOM,
    type: "circle",
    source: GEOJSON_SOURCE_ID,
    filter: ["has", "point_count"],
    paint: {
      "circle-color": "#88b04b",
      "circle-radius": 10,
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#ffffff",
    },
  });
  map.addLayer({
    id: LAYER_UNCLUSTERED,
    type: "circle",
    source: GEOJSON_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-radius": 7,
      "circle-color": "#e81224",
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  });
  map.addLayer({
    id: LAYER_UNCLUSTERED_LOW_ZOOM,
    type: "circle",
    source: GEOJSON_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-radius": 5,
      "circle-color": "#e81224",
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#ffffff",
    },
  });
  // Move our layers to the top of the style so they are not obscured by others
  const topLayer = map.getStyle().layers?.slice(-1)[0]?.id;
  if (topLayer) {
    for (const id of [
      LAYER_UNCLUSTERED_LOW_ZOOM,
      LAYER_UNCLUSTERED,
      LAYER_CLUSTERED_CIRCLE_LOW_ZOOM,
      LAYER_CLUSTERED_CIRCLE,
    ]) {
      if (map.getLayer(id)) map.moveLayer(id, topLayer);
    }
  }
}

/**
 * The main MapView component. It is largely based on the original
 * OpenAEDMap map component but calls `ensureGeojsonLayers` to load
 * our static dataset. When a `node_id` property exists it opens the
 * sidebar with full details via `fetchNodeDataFromBackend`; otherwise
 * it shows a simple popup using properties from the dataset.
 */
const MapView: FC<MapViewProps> = ({ openChangesetId, setOpenChangesetId }) => {
  // … (el resto de MapView permanece igual que tu implementación actual)
  // Nota: asegúrate de conservar los handlers de clusters y puntos, así como
  // el control de geocodificación, el sidebar y el pie de página.
};

export default MapView;

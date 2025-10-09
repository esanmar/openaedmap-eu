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

/** === Config GeoJSON local (OSM-like) ===
 * Coloca el archivo en: public/data/EU_osm.geojson
 * Si lo actualizas, cambia el valor de VERSION para forzar recarga.
 */
const GEOJSON_SOURCE_ID = "aed-geojson";
const GEOJSON_URL_BASE = "/data/EU_osm.geojson";
const VERSION = "v=4"; // cache-buster
const GEOJSON_URL = `${GEOJSON_URL_BASE}?${VERSION}`;

/** Capa de texto para conteo de clúster (diagnóstico visual) */
const LAYER_CLUSTER_COUNT = "aed-cluster-count";

/** ---- Utils ---- */
type AnyProps = Record<string, unknown>;
type MapEventType = MapMouseEvent & { features?: MapGeoJSONFeature[] };

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as const)[c]!,
  );
}
function buildPopupHtml(p: AnyProps) {
  const name =
    (p.name as string) ||
    (p.organismo as string) ||
    (p.operator as string) ||
    "";
  const address =
    (p.address as string) ||
    [p.direccion, p.municipio, p.provincia].filter(Boolean).join(", ") ||
    "";
  const where =
    (p["defibrillator:location"] as string) || (p.ubicacion as string) || "";
  const oh = (p.opening_hours as string) || (p.horario as string) || "";

  const rows = [
    name ? `<div><strong>${escapeHtml(name)}</strong></div>` : "",
    address ? `<div>${escapeHtml(address)}</div>` : "",
    where ? `<div><em>${escapeHtml(where)}</em></div>` : "",
    oh ? `<div><small>Horario: ${escapeHtml(oh)}</small></div>` : "",
  ].filter(Boolean);
  return rows.join("") || "<div>Desfibrilador</div>";
}

/** Carga el GeoJSON explícitamente y añade fuente + capas
 * con parámetros conservadores para evitar errores de teselado.
 */
async function ensureGeojsonLayers(map: maplibregl.Map) {
  // 0) Cargar GeoJSON como OBJETO (debug más claro)
  const res = await fetch(GEOJSON_URL, { cache: "no-store" });
  if (!res.ok) {
    console.error(`[EU_osm] HTTP ${res.status} al cargar ${GEOJSON_URL}`);
    return;
  }
  const data = (await res.json()) as GeoJSON.FeatureCollection;
  const count = data.features?.length ?? 0;
  console.log("[EU_osm] features:", count);
  if (!count) {
    console.warn("[EU_osm] No hay features en el GeoJSON.");
  }

  // 1) Quitar capas con mismos IDs (del style base)
  for (const id of [
    LAYER_UNCLUSTERED,
    LAYER_UNCLUSTERED_LOW_ZOOM,
    LAYER_CLUSTERED_CIRCLE,
    LAYER_CLUSTERED_CIRCLE_LOW_ZOOM,
    LAYER_CLUSTER_COUNT,
  ]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(GEOJSON_SOURCE_ID)) map.removeSource(GEOJSON_SOURCE_ID);

  // 2) Añadir fuente: OBJETO + clustering + tile opts seguros
  // Importante: clusterMaxZoom < maxzoom (y compatible con las capas del estilo)
  map.addSource(GEOJSON_SOURCE_ID, {
    type: "geojson",
    data, // 👈 objeto, no URL
    cluster: false,
    clusterMaxZoom: 15, // < maxzoom
    maxzoom: 16, // > clusterMaxZoom
    clusterRadius: 15,
    buffer: 32, // reduce riesgo "Geometry exceeds allowed extent"
    tolerance: 0.25,
  } as any);

  // 3) Añadir capas con IDs que la app ya usa (y una extra de conteo)
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
      "circle-radius": ["step", ["get", "point_count"], 14, 10, 20, 50, 28],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  });

  map.addLayer({
    id: LAYER_CLUSTER_COUNT,
    type: "symbol",
    source: GEOJSON_SOURCE_ID,
    filter: ["has", "point_count"],
    layout: { "text-field": ["get", "point_count"], "text-size": 12 },
    paint: { "text-color": "#000" },
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

  // 4) Sube tus capas arriba del todo (por si el style las tapa)
  const top = map.getStyle().layers?.slice(-1)[0]?.id;
  if (top) {
    for (const id of [
      LAYER_UNCLUSTERED_LOW_ZOOM,
      LAYER_UNCLUSTERED,
      LAYER_CLUSTER_COUNT,
      LAYER_CLUSTERED_CIRCLE_LOW_ZOOM,
      LAYER_CLUSTERED_CIRCLE,
    ]) {
      if (map.getLayer(id)) map.moveLayer(id, top);
    }
  }

  console.log("[EU_osm] capas inyectadas OK");
}

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
}

const MapView: FC<MapViewProps> = ({ openChangesetId, setOpenChangesetId }) => {
  const {
    authState: { auth },
    setModalState,
    sidebarAction,
    setSidebarAction,
    sidebarData,
    setSidebarData,
    countriesData,
    setCountriesData,
    countriesDataLanguage,
    setCountriesDataLanguage,
  } = useAppContext();
  const { t } = useTranslation();
  const language = useLanguage();
  const { longitude, latitude, zoom } = getMapLocation();
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const maplibreGeocoderRef = useRef<MaplibreGeocoder | null>(null);
  const controlsLocation = "bottom-right";
  const [marker, setMarker] = useState<maplibregl.Marker | null>(null);
  const [sidebarLeftShown, setSidebarLeftShown] = useState(false);
  const [footerButtonType, setFooterButtonType] = useState(ButtonsType.Basic);

  const deleteMarker = () => {
    if (marker !== null) {
      marker.remove();
      setMarker(null);
    }
  };

  const closeSidebarLeft = () => {
    setSidebarLeftShown(false);
    deleteMarker();
    removeNodeIdFromHash();
    setFooterButtonType(ButtonsType.Basic);
  };

  const checkConditionsThenCall = (callable: () => void) => {
    if (mapRef.current === null) return;
    const map = mapRef.current;
    if (auth === null || !auth.authenticated()) {
      setModalState({
        ...initialModalState,
        visible: true,
        type: ModalType.NeedToLogin,
      });
    } else if (map.getZoom() < 15) {
      setModalState({
        ...initialModalState,
        visible: true,
        type: ModalType.NeedMoreZoom,
        currentZoom: map.getZoom(),
      });
    } else callable();
  };

  const mobileCancel = () => {
    deleteMarker();
    setSidebarLeftShown(false);
    setFooterButtonType(ButtonsType.Basic);
  };

  const showFormMobile = () => {
    setSidebarLeftShown(true);
    setFooterButtonType(ButtonsType.None);
  };

  const startAEDAdding = (mobile: boolean) => {
    if (mapRef.current === null) return;
    const map = mapRef.current;
    deleteMarker();
    removeNodeIdFromHash();
    setSidebarData(null);
    setSidebarAction(SidebarAction.addNode);
    setSidebarLeftShown(!mobile); // for mobile hide sidebar so marker is visible
    setFooterButtonType(mobile ? ButtonsType.MobileAddAed : ButtonsType.None);
    // add marker
    const markerColour = "#e81224";
    const mapCenter = map.getCenter();
    const initialCoordinates: [number, number] = [mapCenter.lng, mapCenter.lat];
    setMarker(
      new maplibregl.Marker({
        draggable: true,
        color: markerColour,
      })
        .setLngLat(initialCoordinates)
        .setPopup(new maplibregl.Popup().setHTML(t("form.marker_popup_text")))
        .addTo(mapRef.current)
        .togglePopup(),
    );
  };

  useEffect(() => {
    const fetchData = async () => {
      const data = await fetchCountriesData(language);
      if (data !== null) {
        setCountriesData(data);
        setCountriesDataLanguage(language);
      }
    };
    fetchData().catch(console.error);
  }, [language, setCountriesDataLanguage, setCountriesData]);

  const addMaplibreGeocoder = useCallback(
    (map: maplibregl.Map) => {
      if (maplibreGeocoderRef.current !== null) {
        map.removeControl(maplibreGeocoderRef.current);
      }
      const newMaplibreGeocoder = new MaplibreGeocoder(nominatimGeocoder, {
        maplibregl,
        placeholder: t("sidebar.find_location"),
        reverseGeocode: false,
      } as MaplibreGeocoderOptions);
      newMaplibreGeocoder.setLanguage(language);
      map.addControl(newMaplibreGeocoder);
      maplibreGeocoderRef.current = newMaplibreGeocoder;
    },
    [t, language],
  );

  useEffect(() => {
    if (mapContainer.current === null) return;
    if (mapRef.current !== null) return; // stops map from initializing more than once

    const map = new maplibregl.Map({
      container: mapContainer.current,
      hash: locationParameter,
      style: mapStyle(language.toUpperCase(), countriesData),
      center: [longitude, latitude],
      zoom: zoom,
      minZoom: 3,
      maxZoom: 19,
      maplibreLogo: false,
      attributionControl: false,
    });

    // Imagen 1x1 para cualquier sprite faltante (evita "mismatched image size")
    map.on("styleimagemissing", (e) => {
      if (map.hasImage(e.id)) return;
      // @ts-ignore
      const img = new ImageData(new Uint8ClampedArray(4), 1, 1);
      map.addImage(e.id, img, { sdf: false });
    });

    map.addControl(
      new maplibregl.AttributionControl({
        customAttribution: "",
      }),
    );
    addMaplibreGeocoder(map);
    mapRef.current = map;
    // how fast mouse scroll wheel zooms
    map.scrollZoom.setWheelZoomRate(1);
    // disable map rotation using right click + drag
    map.dragRotate.disable();
    // disable map rotation using touch rotation gesture
    map.touchZoomRotate.disableRotation();
    // disable map rotation using shift + arrows
    map.keyboard.disableRotation();
    map.addControl(
      new maplibregl.NavigationControl({
        showCompass: false,
      }),
      controlsLocation,
    );
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: {
          enableHighAccuracy: true,
        },
        fitBoundsOptions: {
          animate: false,
        },
      }),
      controlsLocation,
    );

    // Inyecta / reinyecta capas al cargar y cuando cambie el style (p.ej. idioma)
    map.on("load", () => {
      ensureGeojsonLayers(map).catch(console.error);
    });
    map.on("styledata", () => {
      ensureGeojsonLayers(map).catch(console.error);
    });

    for (const layer of [
      LAYER_CLUSTERED_CIRCLE,
      LAYER_UNCLUSTERED,
      LAYER_CLUSTERED_CIRCLE_LOW_ZOOM,
      LAYER_UNCLUSTERED_LOW_ZOOM,
      LAYER_CLUSTER_COUNT,
    ]) {
      map.on("mouseenter", layer, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = "";
      });
    }
    map.on("moveend", saveLocationToLocalStorage);

    // Click en clusters: acercar
    for (const layer of [
      LAYER_CLUSTERED_CIRCLE,
      LAYER_CLUSTERED_CIRCLE_LOW_ZOOM,
    ]) {
      map.on("click", layer, (e: MapEventType) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: [layer],
        });
        if (!features.length) return;
        const zoomNow = map.getZoom();
        const point = features[0].geometry as GeoJSON.Point;
        map.easeTo({
          center: point.coordinates as [number, number],
          zoom: zoomNow + 2,
        });
      });
    }

    // Click en punto suelto:
    function showObjectWithProperties(e: MapEventType) {
      if (!e.features?.length || !mapRef.current) return;
      const feat: any = e.features[0];
      const props: AnyProps = feat.properties || {};

      // Solo abrimos sidebar si viene node_id "real" (OSM); nuestros datos locales no lo tienen
      if (typeof props.node_id === "string") {
        const osmNodeId = props.node_id;
        fillSidebarWithOsmDataAndShow(
          osmNodeId,
          mapRef.current,
          setSidebarAction,
          setSidebarData,
          setSidebarLeftShown,
          false,
        );
        addNodeIdToHash(osmNodeId);
        return;
      }

      // Popup sencillo con info básica (nombre/dirección/ubicación)
      const [lng, lat] = (feat.geometry?.coordinates || []) as [number, number];
      const html = buildPopupHtml(props);
      new maplibregl.Popup().setLngLat([lng, lat]).setHTML(html).addTo(mapRef.current);
    }

    map.on("click", LAYER_UNCLUSTERED, showObjectWithProperties);
    map.on("click", LAYER_UNCLUSTERED_LOW_ZOOM, showObjectWithProperties);

    // if direct link to osm node then get its data and zoom in
    const newParamsFromHash = parseParametersFromUrl();
    if (newParamsFromHash.node_id && mapRef.current !== null) {
      fillSidebarWithOsmDataAndShow(
        newParamsFromHash.node_id,
        mapRef.current,
        setSidebarAction,
        setSidebarData,
        setSidebarLeftShown,
        true,
      );
    }
  }, [
    latitude,
    longitude,
    zoom,
    setSidebarAction,
    setSidebarData,
    language,
    countriesData,
    addMaplibreGeocoder,
  ]);

  useEffect(() => {
    if (mapRef.current === null) return;
    const map = mapRef.current;
    addMaplibreGeocoder(map);
    if (countriesDataLanguage !== language) return; // wait for countries data to be loaded
    map.setStyle(mapStyle(language.toUpperCase(), countriesData));
    // ensureGeojsonLayers se vuelve a llamar en "styledata"
  }, [countriesData, countriesDataLanguage, language, addMaplibreGeocoder]);

  return (
    <>
      {sidebarLeftShown && (
        <SidebarLeft
          action={sidebarAction}
          data={sidebarData}
          closeSidebar={closeSidebarLeft}
          visible={sidebarLeftShown}
          marker={marker}
          openChangesetId={openChangesetId}
          setOpenChangesetId={setOpenChangesetId}
        />
      )}
      <div className="map-wrap">
        <div ref={mapContainer} className="map" />
      </div>
      <FooterDiv
        startAEDAdding={(mobile) =>
          checkConditionsThenCall(() => startAEDAdding(mobile))
        }
        mobileCancel={mobileCancel}
        showFormMobile={showFormMobile}
        buttonsConfiguration={footerButtonType}
      />
    </>
  );
};

interface MapViewProps {
  openChangesetId: string;
  setOpenChangesetId: (openChangesetId: string) => void;
}

export default MapView;

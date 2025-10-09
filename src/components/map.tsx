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

/** === Config GeoJSON local === */
const GEOJSON_SOURCE_ID = "aed-geojson";
const GEOJSON_URL = "/data/EU.geojson"; // tu archivo: https://openaedmap-eu.vercel.app/data/EU.geojson

/** Guards para evitar 'Source already exists' y cachear datos */
const injectingRef = { current: false } as { current: boolean };
const geojsonDataRef = { current: null as GeoJSON.FeatureCollection | null };

type EUProps = {
  organismo?: string;
  direccion?: string;
  municipio?: string;
  provincia?: string;
  ubicacion?: string;
  horario?: string;
  [k: string]: unknown;
};

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as const)[c]!,
  );
}

function buildPopupHtml(p: EUProps) {
  const addr = [p.direccion, p.municipio, p.provincia].filter(Boolean).join(", ");
  const rows = [
    p.organismo ? `<div><strong>${escapeHtml(p.organismo)}</strong></div>` : "",
    addr ? `<div>${escapeHtml(addr)}</div>` : "",
    p.ubicacion ? `<div><em>${escapeHtml(p.ubicacion)}</em></div>` : "",
    p.horario ? `<div><small>Horario: ${escapeHtml(p.horario)}</small></div>` : "",
  ].filter(Boolean);
  return rows.join("") || "<div>Sin información</div>";
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

/** Carga + transformación mínima (no tocamos tu fichero) */
async function loadAndTransformEUGeojson(): Promise<GeoJSON.FeatureCollection> {
  if (geojsonDataRef.current) return geojsonDataRef.current;
  const res = await fetch(GEOJSON_URL, { cache: "no-store" });
  const raw = (await res.json()) as GeoJSON.FeatureCollection;
  const features = (raw.features || [])
    .filter((f) => f?.geometry?.type === "Point")
    .map((f) => {
      const props = (f.properties || {}) as EUProps;
      return {
        type: "Feature",
        geometry: f.geometry,
        properties: {
          ...props,
          name: props.organismo, // alias útil si más adelante se usa
        },
      } as GeoJSON.Feature;
    });
  geojsonDataRef.current = { type: "FeatureCollection", features };
  return geojsonDataRef.current;
}

/** Inyecta fuente/capas; idempotente y segura ante recargas de estilo */
async function ensureGeojsonLayers(map: maplibregl.Map) {
  if (injectingRef.current) return;
  injectingRef.current = true;
  try {
    const data = await loadAndTransformEUGeojson();

    // Fuente: crear si no existe; si existe, actualizar
    const src = map.getSource(GEOJSON_SOURCE_ID) as any;
    if (src && typeof src.setData === "function") {
      src.setData(data);
    } else if (!src) {
      map.addSource(GEOJSON_SOURCE_ID, {
        type: "geojson",
        data,
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 50,
      } as any);
    }

    // Capas: crear solo si faltan (respetando IDs de tu app)
    if (!map.getLayer(LAYER_CLUSTERED_CIRCLE)) {
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
            10, "#f1c40f",
            50, "#e74c3c",
          ],
          "circle-radius": [
            "step",
            ["get", "point_count"],
            14,
            10, 20,
            50, 28,
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });
    }

    if (!map.getLayer(LAYER_CLUSTERED_CIRCLE_LOW_ZOOM)) {
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
    }

    if (!map.getLayer(LAYER_UNCLUSTERED)) {
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
    }

    if (!map.getLayer(LAYER_UNCLUSTERED_LOW_ZOOM)) {
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
    }
  } finally {
    injectingRef.current = false;
  }
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
    setSidebarLeftShown(!mobile);
    setFooterButtonType(mobile ? ButtonsType.MobileAddAed : ButtonsType.None);
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
    if (mapRef.current !== null) return; // init una vez

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

    map.addControl(new maplibregl.AttributionControl({ customAttribution: "" }));
    addMaplibreGeocoder(map);
    mapRef.current = map;

    map.scrollZoom.setWheelZoomRate(1);
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), controlsLocation);
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        fitBoundsOptions: { animate: false },
      }),
      controlsLocation,
    );

    // Inyecta capa EU en load y cuando el estilo cambie
    map.on("load", () => { ensureGeojsonLayers(map).catch(console.error); });
    map.on("styledata", () => { ensureGeojsonLayers(map).catch(console.error); });

    for (const layer of [
      LAYER_CLUSTERED_CIRCLE,
      LAYER_UNCLUSTERED,
      LAYER_CLUSTERED_CIRCLE_LOW_ZOOM,
      LAYER_UNCLUSTERED_LOW_ZOOM,
    ]) {
      map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
    }

    map.on("moveend", saveLocationToLocalStorage);
    type MapEventType = MapMouseEvent & { features?: MapGeoJSONFeature[] };

    // Zoom a cluster al click
    for (const layer of [LAYER_CLUSTERED_CIRCLE, LAYER_CLUSTERED_CIRCLE_LOW_ZOOM]) {
      map.on("click", layer, (e: MapEventType) => {
        const features = map.queryRenderedFeatures(e.point, { layers: [layer] });
        if (!features.length) return;
        const zoomNow = map.getZoom();
        const point = features[0].geometry as GeoJSON.Point;
        map.easeTo({ center: point.coordinates as [number, number], zoom: zoomNow + 2 });
      });
    }

    // Click en punto: si hay node_id => sidebar OSM; si no => popup con tus campos
    function showObjectWithProperties(e: MapEventType) {
      if (!e.features?.length || !mapRef.current) return;
      const feature = e.features[0] as any;
      const props = feature.properties || {};

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

      const [lng, lat] = (feature.geometry?.coordinates || []) as [number, number];
      const html = buildPopupHtml(props as EUProps);
      new maplibregl.Popup().setLngLat([lng, lat]).setHTML(html).addTo(mapRef.current);
    }

    map.on("click", LAYER_UNCLUSTERED, showObjectWithProperties);
    map.on("click", LAYER_UNCLUSTERED_LOW_ZOOM, showObjectWithProperties);

    // Link directo a un node_id existente en OSM/back
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
    if (countriesDataLanguage !== language) return; // espera a countriesData
    map.setStyle(mapStyle(language.toUpperCase(), countriesData));
    // ensureGeojsonLayers se re-llama en "styledata"
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
        startAEDAdding={(mobile) => checkConditionsThenCall(() => startAEDAdding(mobile))}
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

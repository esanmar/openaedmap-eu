"use client"

import maplibregl, { type MapGeoJSONFeature } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import { useEffect, useRef, useState } from "react"
import "./map.css"
import type GeoJSON from "geojson"

// Tipos para los datos del desfibrilador
interface DefibrillatorProperties {
  access?: string
  "addr:city"?: string
  "addr:housenumber"?: string
  "addr:postcode"?: string
  "addr:street"?: string
  description?: string
  indoor?: string
  level?: string
  location?: string
  "defibrillator:location"?: string
  opening_hours?: string
  operator?: string
  phone?: string
  name?: string
  address?: string
  model?: string
  ref?: string
  organismo?: string
  municipio?: string
  provincia?: string
  ubicacion?: string
  horario?: string
  [key: string]: any
}

interface DefibrillatorFeature {
  type: "Feature"
  geometry: {
    type: "Point"
    coordinates: [number, number]
  }
  properties: DefibrillatorProperties
}

// Constantes para las capas según el proyecto original
const LAYER_CLUSTERED_CIRCLE = "clustered-circle"
const LAYER_CLUSTERED_CIRCLE_LOW_ZOOM = "clustered-circle-low-zoom"
const LAYER_UNCLUSTERED = "unclustered"
const LAYER_UNCLUSTERED_LOW_ZOOM = "unclustered-low-zoom"
const GEOJSON_SOURCE_ID = "aed-geojson"
const GEOJSON_URL = "/data/EU_osm.geojson"

export default function MapView() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return

    console.log("[v0] Inicializando mapa...")

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          "raster-tiles": {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          },
        },
        layers: [
          {
            id: "simple-tiles",
            type: "raster",
            source: "raster-tiles",
            minzoom: 0,
            maxzoom: 22,
          },
        ],
      },
      center: [10, 50], // Centro de Europa
      zoom: 4,
      minZoom: 3,
      maxZoom: 19,
    })

    mapRef.current = map
    console.log("[v0] Mapa creado")

    map.scrollZoom.setWheelZoomRate(1)
    map.dragRotate.disable()
    map.touchZoomRotate.disableRotation()
    map.keyboard.disableRotation()

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right")
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        fitBoundsOptions: { animate: false },
      }),
      "bottom-right",
    )

    map.on("load", () => {
      console.log("[v0] Mapa cargado, agregando capas de desfibriladores...")
      ensureGeojsonLayers(map)
        .then(() => {
          setIsLoading(false)
          console.log("[EU_osm] Mapa completamente listo")
        })
        .catch((error) => {
          console.error("[EU_osm] Error:", error)
          setIsLoading(false)
        })
    })

    for (const layer of [
      LAYER_CLUSTERED_CIRCLE,
      LAYER_UNCLUSTERED,
      LAYER_CLUSTERED_CIRCLE_LOW_ZOOM,
      LAYER_UNCLUSTERED_LOW_ZOOM,
    ]) {
      map.on("mouseenter", layer, () => {
        map.getCanvas().style.cursor = "pointer"
      })
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = ""
      })
    }

    type MapEventTypeFull = maplibregl.MapMouseEvent & { features?: MapGeoJSONFeature[] }
    for (const layer of [LAYER_CLUSTERED_CIRCLE, LAYER_CLUSTERED_CIRCLE_LOW_ZOOM]) {
      map.on("click", layer, (e: MapEventTypeFull) => {
        const features = map.queryRenderedFeatures(e.point, { layers: [layer] })
        if (!features.length) return
        const zoomNow = map.getZoom()
        const point = features[0].geometry as { type: string; coordinates: [number, number] }
        map.easeTo({ center: point.coordinates as [number, number], zoom: zoomNow + 2 })
      })
    }

    function handlePointClick(e: MapEventTypeFull) {
      if (!e.features?.length || !mapRef.current) return
      const feature = e.features[0] as any
      const props = feature.properties || {}
      const [lon, lat] = feature.geometry.coordinates as [number, number]
      const html = buildPopupHtml(props, [lon, lat])
      new maplibregl.Popup().setLngLat([lon, lat]).setHTML(html).addTo(mapRef.current)
    }
    map.on("click", LAYER_UNCLUSTERED, handlePointClick)
    map.on("click", LAYER_UNCLUSTERED_LOW_ZOOM, handlePointClick)

    return () => {
      map.remove()
    }
  }, [])

  return (
    <div className="relative h-screen w-full">
      <div ref={mapContainer} className="map-container" />
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#009140] bg-opacity-90">
          <div className="text-white text-xl">Cargando desfibriladores...</div>
        </div>
      )}
    </div>
  )
}

/**
 * Escape HTML entities to avoid injection in popups.
 */
function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as const)[c]!,
  )
}

/**
 * Build a popup HTML string using available properties.
 */
function buildPopupHtml(props: Record<string, unknown>, coords: [number, number]) {
  const [lon, lat] = coords
  const name = (props.name as string) || (props.organismo as string) || (props.operator as string) || ""
  const address =
    (props.address as string) || [props.direccion, props.municipio, props.provincia].filter(Boolean).join(", ") || ""
  const location = (props["defibrillator:location"] as string) || (props.ubicacion as string) || ""
  const oh = (props.opening_hours as string) || (props.horario as string) || ""
  const model = (props.model as string) || ""
  const ref = (props.ref as string) || ""
  const phone = (props.phone as string) || ""
  const description = (props.description as string) || ""
  const access = (props.access as string) || "yes"

  const accessLabels: Record<string, string> = {
    yes: "Acceso público",
    customers: "Solo clientes",
    private: "Privado",
    permissive: "Con permiso",
    no: "No disponible",
  }

  const accessColors: Record<string, string> = {
    yes: "#009140",
    customers: "#FFA500",
    private: "#FF6B6B",
    permissive: "#4ECDC4",
    no: "#FF0000",
  }

  const rows: string[] = []
  rows.push(
    `<div style="background-color: ${accessColors[access] || "#009140"}; color: white; padding: 10px; margin: -15px -15px 10px -15px; border-radius: 3px 3px 0 0;">
      <h3 style="margin: 0; font-size: 16px; font-weight: bold;">Desfibrilador (AED)</h3>
    </div>`,
  )
  rows.push(
    `<div style="padding: 5px 0;"><strong style="color: ${accessColors[access] || "#009140"};">🔓 ${accessLabels[access] || "Acceso público"}</strong></div>`,
  )

  if (name) rows.push(`<div style="margin: 5px 0;"><strong>🏢 Nombre:</strong> ${escapeHtml(name)}</div>`)
  if (address) rows.push(`<div style="margin: 5px 0;"><strong>🏠 Dirección:</strong> ${escapeHtml(address)}</div>`)
  if (location) rows.push(`<div style="margin: 5px 0;"><strong>📍 Ubicación:</strong> ${escapeHtml(location)}</div>`)
  if (oh) rows.push(`<div style="margin: 5px 0;"><strong>🕐 Horario:</strong> ${escapeHtml(oh)}</div>`)
  if (model) rows.push(`<div style="margin: 5px 0;"><strong>🔧 Modelo:</strong> ${escapeHtml(model)}</div>`)
  if (ref) rows.push(`<div style="margin: 5px 0;"><strong>🔢 Ref:</strong> ${escapeHtml(ref)}</div>`)
  if (phone) rows.push(`<div style="margin: 5px 0;"><strong>📞 Teléfono:</strong> ${escapeHtml(phone)}</div>`)
  if (description)
    rows.push(`<div style="margin: 5px 0;"><strong>ℹ️ Descripción:</strong> ${escapeHtml(description)}</div>`)

  // Add navigation links using coordinates
  const googleLink = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`
  const osmLink = `https://www.openstreetmap.org/directions?engine=graphhopper_car&route=${lat}%2C${lon}`
  rows.push(
    `<div style="margin-top: 15px; padding-top: 10px; border-top: 1px solid #e0e0e0;">
      <a href="${googleLink}" target="_blank" rel="noopener" 
         style="display: inline-block; background-color: #4285F4; color: white; padding: 8px 16px; 
                text-decoration: none; border-radius: 4px; font-weight: bold; text-align: center; width: 100%; margin-bottom: 8px;">
        🗺️ Navegar con Google Maps
      </a>
      <a href="${osmLink}" target="_blank" rel="noopener"
         style="display: inline-block; background-color: #7EBC6F; color: white; padding: 8px 16px; 
                text-decoration: none; border-radius: 4px; font-weight: bold; text-align: center; width: 100%;">
        🗺️ Navegar con OpenStreetMap
      </a>
    </div>`,
  )
  return `<div style="min-width: 250px; font-family: Arial, sans-serif;">${rows.join("")}</div>`
}

/**
 * Load the GeoJSON data and ensure that the source and layers are present.
 */
async function ensureGeojsonLayers(map: maplibregl.Map) {
  console.log("[v0] Iniciando carga de GeoJSON desde:", GEOJSON_URL)

  // Fetch the GeoJSON data as an object
  const res = await fetch(GEOJSON_URL, { cache: "no-store" })
  if (!res.ok) {
    console.error(`[EU_osm] HTTP ${res.status} al cargar ${GEOJSON_URL}`)
    return
  }
  const data = (await res.json()) as GeoJSON.FeatureCollection
  const features = data.features || []
  console.log(`[EU_osm] Cargadas ${features.length} features`)
  console.log("[v0] Primera feature:", features[0])

  // If the source already exists, just update its data
  const existing = map.getSource(GEOJSON_SOURCE_ID) as any
  if (existing && typeof existing.setData === "function") {
    console.log("[v0] Fuente existente encontrada, actualizando datos...")
    existing.setData(data)
    return
  }

  // Otherwise, remove any leftover layers (defensive) and add our source
  for (const id of [
    LAYER_CLUSTERED_CIRCLE,
    LAYER_CLUSTERED_CIRCLE_LOW_ZOOM,
    LAYER_UNCLUSTERED,
    LAYER_UNCLUSTERED_LOW_ZOOM,
  ]) {
    if (map.getLayer(id)) {
      console.log("[v0] Removiendo capa existente:", id)
      map.removeLayer(id)
    }
  }
  if (map.getSource(GEOJSON_SOURCE_ID)) {
    console.log("[v0] Removiendo fuente existente:", GEOJSON_SOURCE_ID)
    map.removeSource(GEOJSON_SOURCE_ID)
  }

  // Add the GeoJSON source with clustering enabled
  console.log("[v0] Agregando fuente GeoJSON con clustering...")
  map.addSource(GEOJSON_SOURCE_ID, {
    type: "geojson",
    data,
    cluster: true,
    clusterMaxZoom: 15,
    maxzoom: 16,
    clusterRadius: 20,
  } as any)

  // Capa para clusters en zoom alto
  console.log("[v0] Agregando capa:", LAYER_CLUSTERED_CIRCLE)
  map.addLayer({
    id: LAYER_CLUSTERED_CIRCLE,
    type: "circle",
    source: GEOJSON_SOURCE_ID,
    filter: ["has", "point_count"],
    minzoom: 10,
    paint: {
      "circle-color": [
        "step",
        ["get", "point_count"],
        "#88b04b", // verde para pocos puntos
        10,
        "#f1c40f", // amarillo para cantidad media
        50,
        "#e74c3c", // rojo para muchos puntos
      ],
      "circle-radius": ["step", ["get", "point_count"], 14, 10, 20, 50, 28],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  })

  // Capa para clusters en zoom bajo
  console.log("[v0] Agregando capa:", LAYER_CLUSTERED_CIRCLE_LOW_ZOOM)
  map.addLayer({
    id: LAYER_CLUSTERED_CIRCLE_LOW_ZOOM,
    type: "circle",
    source: GEOJSON_SOURCE_ID,
    filter: ["has", "point_count"],
    maxzoom: 10,
    paint: {
      "circle-color": "#88b04b",
      "circle-radius": 10,
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#ffffff",
    },
  })

  // Capa para puntos individuales en zoom alto
  console.log("[v0] Agregando capa:", LAYER_UNCLUSTERED)
  map.addLayer({
    id: LAYER_UNCLUSTERED,
    type: "circle",
    source: GEOJSON_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    minzoom: 10,
    paint: {
      "circle-radius": 7,
      "circle-color": "#e81224",
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  })

  // Capa para puntos individuales en zoom bajo
  console.log("[v0] Agregando capa:", LAYER_UNCLUSTERED_LOW_ZOOM)
  map.addLayer({
    id: LAYER_UNCLUSTERED_LOW_ZOOM,
    type: "circle",
    source: GEOJSON_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    maxzoom: 10,
    paint: {
      "circle-radius": 5,
      "circle-color": "#e81224",
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#ffffff",
    },
  })

  console.log("[v0] Todas las capas agregadas exitosamente")
  console.log("[v0] Zoom actual:", map.getZoom())
  console.log("[v0] Centro actual:", map.getCenter())
}

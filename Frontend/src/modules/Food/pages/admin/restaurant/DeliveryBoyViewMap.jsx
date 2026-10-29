import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { MapPin, ArrowLeft, Search, Bike, RefreshCw } from "lucide-react"
import { adminAPI } from "@food/api"
import { API_BASE_URL } from "@food/api/config"
import { getGoogleMapsApiKey } from "@food/utils/googleMapsApiKey"
import { Loader } from "@googlemaps/js-api-loader"
import { subscribeAllDeliveryLocations } from "@food/realtimeTracking"
import bikeLogo from "@food/assets/bikelogo.png"
import io from "socket.io-client"

const debugLog = (...args) => {}
const debugWarn = (...args) => {}
const debugError = (...args) => {}

/**
 * Robust coordinate parser: Handles objects ({lat, lng}, {latitude, longitude})
 * and arrays ([lng, lat] GeoJSON or [lat, lng]).
 * Correctly distinguishes India/global latitude vs longitude without swapping.
 */
const parseCoords = (input) => {
  if (!input) return null

  // Handle object with named keys
  if (typeof input === "object" && !Array.isArray(input)) {
    const lat = Number(input.lat ?? input.latitude)
    const lng = Number(input.lng ?? input.longitude ?? input.lon)
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180 &&
      (lat !== 0 || lng !== 0)
    ) {
      return { lat, lng }
    }
    // Handle nested coordinates array if present
    if (Array.isArray(input.coordinates)) {
      return parseCoords(input.coordinates)
    }
  }

  // Handle array: [a, b]
  if (Array.isArray(input) && input.length >= 2) {
    const c0 = Number(input[0])
    const c1 = Number(input[1])
    if (!Number.isFinite(c0) || !Number.isFinite(c1)) return null

    let lat = null
    let lng = null

    // Definite rule: latitude must be within [-90, 90]
    if (Math.abs(c0) > 90 && Math.abs(c1) <= 90) {
      lng = c0
      lat = c1
    } else if (Math.abs(c1) > 90 && Math.abs(c0) <= 90) {
      lat = c0
      lng = c1
    } else if (c0 >= 60 && c0 <= 100 && c1 >= 5 && c1 <= 40) {
      // Standard India coordinates: longitude ~68-98, latitude ~8-38
      lng = c0
      lat = c1
    } else if (c1 >= 60 && c1 <= 100 && c0 >= 5 && c0 <= 40) {
      lat = c0
      lng = c1
    } else {
      // GeoJSON standard: [lng, lat]
      lng = c0
      lat = c1
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
    if (lat === 0 && lng === 0) return null
    return { lat, lng }
  }

  return null
}

const getZonePoint = (coord = {}) => {
  return parseCoords(coord)
}

const isPointInsidePolygon = (point, polygon = []) => {
  if (!point || !Array.isArray(polygon) || polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = Number(polygon[i]?.lng)
    const yi = Number(polygon[i]?.lat)
    const xj = Number(polygon[j]?.lng)
    const yj = Number(polygon[j]?.lat)
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / ((yj - yi) || Number.EPSILON) + xi
    if (intersect) inside = !inside
  }
  return inside
}

const normalizeId = (val) => {
  if (!val) return ""
  if (typeof val === "string") return val.trim()
  if (typeof val === "object") {
    if (val._id) return normalizeId(val._id)
    if (val.id) return normalizeId(val.id)
  }
  return String(val).trim()
}

export default function DeliveryBoyViewMap() {
  const navigate = useNavigate()
  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const zonesPolygonsRef = useRef([])
  const infoWindowsRef = useRef([])
  const deliveryBoyMarkersRef = useRef([])
  const rotatedIconCacheRef = useRef(new Map())
  const socketRef = useRef(null)

  const [googleMapsApiKey, setGoogleMapsApiKey] = useState("")
  const [mapLoading, setMapLoading] = useState(true)
  const [zones, setZones] = useState([])
  const [deliveryBoys, setDeliveryBoys] = useState([])
  const [selectedZoneId, setSelectedZoneId] = useState("all")
  const [loading, setLoading] = useState(true)
  const [locationSearch, setLocationSearch] = useState("")
  const [isRefreshing, setIsRefreshing] = useState(false)

  const directoryPartnersRef = useRef(new Map())
  const realtimeLocationsRef = useRef(new Map())

  const autocompleteInputRef = useRef(null)
  const autocompleteRef = useRef(null)

  // Merge directory partners (from MongoDB) and real-time updates (from Firebase / Socket)
  const mergeAllDeliveryBoys = useCallback(() => {
    const mergedMap = new Map()

    // 1. Add directory partners from MongoDB
    directoryPartnersRef.current.forEach((partner, partnerId) => {
      mergedMap.set(partnerId, { ...partner })
    })

    // 2. Overlay real-time updates from Firebase / Socket
    realtimeLocationsRef.current.forEach((rt, partnerId) => {
      const existing = mergedMap.get(partnerId)
      if (existing) {
        mergedMap.set(partnerId, {
          ...existing,
          availability: {
            ...existing.availability,
            isOnline: rt.isOnline ?? existing.availability?.isOnline ?? true,
            status: rt.status || existing.availability?.status || "online",
            currentLocation: {
              type: "Point",
              coordinates: [rt.coords.lng, rt.coords.lat],
              heading: rt.heading ?? existing.availability?.currentLocation?.heading ?? 0,
              speed: rt.speed ?? existing.availability?.currentLocation?.speed ?? 0,
              lastUpdate: rt.timestamp || Date.now()
            },
            lastLocationUpdate: rt.timestamp || Date.now()
          }
        })
      } else if (rt.coords) {
        mergedMap.set(partnerId, {
          _id: partnerId,
          name: rt.name || "Delivery Partner",
          phone: rt.phone || "N/A",
          zoneId: rt.zoneId || null,
          availability: {
            isOnline: rt.isOnline ?? true,
            status: rt.status || "online",
            currentLocation: {
              type: "Point",
              coordinates: [rt.coords.lng, rt.coords.lat],
              heading: rt.heading || 0,
              speed: rt.speed || 0,
              lastUpdate: rt.timestamp || Date.now()
            },
            lastLocationUpdate: rt.timestamp || Date.now()
          }
        })
      }
    })

    // 3. Filter only partners who have valid coordinates and are active/online
    const list = Array.from(mergedMap.values()).filter((boy) => {
      const coords =
        parseCoords(boy?.availability?.currentLocation?.coordinates) ||
        parseCoords(boy?.availability?.currentLocation) ||
        parseCoords({ lat: boy?.lastLat ?? boy?.lat, lng: boy?.lastLng ?? boy?.lng }) ||
        parseCoords(boy?.lastLocation?.coordinates)
      return Boolean(coords)
    })

    setDeliveryBoys(list)
    setLoading(false)
  }, [])

  // Fetch approved delivery partners from Backend API (MongoDB)
  const fetchDeliveryPartnerDirectory = useCallback(async () => {
    try {
      const response = await adminAPI.getDeliveryPartners({
        limit: 1000,
        status: "approved",
        isActive: true,
        includeAvailability: true
      })

      if (response.data?.success && response.data.data?.deliveryPartners) {
        const nextMap = new Map()
        response.data.data.deliveryPartners.forEach((boy) => {
          const boyId = normalizeId(boy?._id || boy?.id || boy?.deliveryId || boy?.fullData?._id)
          if (!boyId) return

          const availability = boy?.availability || boy?.fullData?.availability || {}
          const currentLocation = availability?.currentLocation || {}
          const coords =
            parseCoords(currentLocation?.coordinates) ||
            parseCoords(currentLocation) ||
            parseCoords({ lat: boy?.lastLat, lng: boy?.lastLng }) ||
            parseCoords(boy?.lastLocation?.coordinates)

          const zoneId = normalizeId(
            boy?.zoneId?._id ||
            boy?.zoneId?.id ||
            boy?.zoneId ||
            boy?.fullData?.zoneId?._id ||
            boy?.fullData?.zoneId?.id ||
            boy?.fullData?.zoneId
          )

          const status = String(availability?.status || boy?.availabilityStatus || "").toLowerCase()
          const isOnline = availability?.isOnline === true || status === "online" || status === "busy"

          nextMap.set(boyId, {
            _id: boyId,
            name: boy?.name || boy?.fullName || boy?.fullData?.name || "Delivery Partner",
            phone: boy?.phone || boy?.fullData?.phone || "N/A",
            zoneId: zoneId || null,
            lastLat: boy?.lastLat,
            lastLng: boy?.lastLng,
            availabilityStatus: boy?.availabilityStatus || "offline",
            availability: {
              isOnline: isOnline,
              status: status || (isOnline ? "online" : "offline"),
              currentLocation: coords
                ? {
                    type: "Point",
                    coordinates: [coords.lng, coords.lat],
                    heading: Number(currentLocation?.heading || boy?.lastHeading || 0),
                    speed: Number(currentLocation?.speed || boy?.lastSpeed || 0),
                    lastUpdate: Number(currentLocation?.timestamp || availability?.lastLocationUpdate || boy?.lastLocationAt || Date.now())
                  }
                : null,
              lastLocationUpdate: Number(availability?.lastLocationUpdate || currentLocation?.timestamp || boy?.lastLocationAt || Date.now())
            }
          })
        })

        directoryPartnersRef.current = nextMap
        mergeAllDeliveryBoys()
      }
    } catch (error) {
      debugError("Error fetching delivery partner directory:", error)
    }
  }, [mergeAllDeliveryBoys])

  const fetchZones = async () => {
    try {
      setLoading(true)
      const response = await adminAPI.getZones({ limit: 1000 })
      if (response.data?.success && response.data.data?.zones) {
        setZones(response.data.data.zones)
      }
    } catch (error) {
      debugError("Error fetching zones:", error)
      setZones([])
    } finally {
      setLoading(false)
    }
  }

  // Socket.IO real-time connection for admin live updates
  useEffect(() => {
    try {
      const backendUrl = API_BASE_URL ? API_BASE_URL.replace(/\/api\/v1\/?$/, "").replace(/\/api\/?$/, "") : ""
      const token = localStorage.getItem("accessToken") || localStorage.getItem("adminToken") || ""
      if (backendUrl && token) {
        const socket = io(backendUrl, {
          auth: { token },
          transports: ["websocket", "polling"],
          reconnection: true,
          reconnectionAttempts: 10,
          reconnectionDelay: 1000
        })

        socket.on("rider-location-update", (data) => {
          if (!data) return
          const partnerId = normalizeId(data.deliveryPartnerId || data._id)
          if (!partnerId) return

          const coords = parseCoords({ lat: data.lat, lng: data.lng })
          if (!coords) return

          realtimeLocationsRef.current.set(partnerId, {
            coords,
            heading: Number(data.heading) || 0,
            speed: Number(data.speed) || 0,
            status: data.status || "online",
            isOnline: data.isOnline !== false,
            timestamp: Number(data.timestamp || data.lastUpdate) || Date.now(),
            name: data.name,
            phone: data.phone,
            zoneId: data.zoneId
          })

          mergeAllDeliveryBoys()
        })

        socketRef.current = socket
      }
    } catch (e) {
      debugWarn("Admin socket init error:", e)
    }

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect()
        socketRef.current = null
      }
    }
  }, [mergeAllDeliveryBoys])

  // Firebase Realtime DB subscription + periodic polling
  useEffect(() => {
    fetchZones()
    fetchDeliveryPartnerDirectory()
    loadGoogleMaps()

    // 1. Firebase Realtime DB Listener
    const unsubscribeRealtime = subscribeAllDeliveryLocations(
      (deliveryNode) => {
        if (!deliveryNode || typeof deliveryNode !== "object") return

        Object.entries(deliveryNode).forEach(([deliveryId, payload]) => {
          if (!payload) return
          const rawLocation = payload?.location || {}
          const coords =
            parseCoords({
              lat: payload?.lat ?? payload?.latitude ?? rawLocation?.lat ?? rawLocation?.latitude,
              lng: payload?.lng ?? payload?.longitude ?? rawLocation?.lng ?? rawLocation?.longitude
            }) || parseCoords(payload)

          if (!coords) return

          const status = String(payload?.status ?? rawLocation?.status ?? payload?.availabilityStatus ?? "").toLowerCase()
          const isOnlineFlag = payload?.isOnline ?? payload?.is_online ?? rawLocation?.isOnline ?? rawLocation?.is_online

          let rawTimestamp =
            payload?.timestamp ??
            rawLocation?.timestamp ??
            payload?.last_updated ??
            rawLocation?.last_updated ??
            0
          let timestamp = Number(rawTimestamp)
          if (!Number.isFinite(timestamp) || timestamp === 0) {
            timestamp = Date.parse(String(rawTimestamp || "")) || Date.now()
          }
          // Convert seconds to ms if necessary
          if (timestamp > 0 && timestamp < 1e11) {
            timestamp *= 1000
          }

          const isOnline = isOnlineFlag === true || status === "online" || status === "busy" || isOnlineFlag !== false

          realtimeLocationsRef.current.set(String(deliveryId), {
            coords,
            heading: Number(payload?.heading ?? rawLocation?.heading) || 0,
            speed: Number(payload?.speed ?? rawLocation?.speed) || 0,
            status: status || (isOnline ? "online" : "offline"),
            isOnline,
            timestamp,
            name: payload?.name,
            phone: payload?.phone,
            zoneId: payload?.zoneId
          })
        })

        mergeAllDeliveryBoys()
      },
      (error) => {
        debugError("Firebase delivery listener failed:", error)
      }
    )

    // 2. Periodic poll: Keeps MongoDB background GPS updates fresh on map
    const pollInterval = setInterval(() => {
      fetchDeliveryPartnerDirectory()
    }, 12000)

    return () => {
      if (typeof unsubscribeRealtime === "function") unsubscribeRealtime()
      clearInterval(pollInterval)
    }
  }, [fetchDeliveryPartnerDirectory, mergeAllDeliveryBoys])

  const filteredDeliveryBoys = useMemo(() => {
    if (selectedZoneId === "all") return deliveryBoys

    const selectedZone = zones.find(
      (zone) => String(zone?._id || zone?.id || "") === String(selectedZoneId)
    )
    const zonePolygon = Array.isArray(selectedZone?.coordinates)
      ? selectedZone.coordinates.map(getZonePoint).filter(Boolean)
      : []

    return deliveryBoys.filter((boy) => {
      const boyZoneId = normalizeId(boy?.zoneId)
      if (boyZoneId && boyZoneId === String(selectedZoneId)) return true

      // Fallback: if zoneId is missing/mismatched, still show rider when live point is inside selected zone polygon
      if (zonePolygon.length < 3) return false
      const riderPoint =
        parseCoords(boy?.availability?.currentLocation?.coordinates) ||
        parseCoords(boy?.availability?.currentLocation) ||
        parseCoords({ lat: boy?.lastLat ?? boy?.lat, lng: boy?.lastLng ?? boy?.lng })
      return isPointInsidePolygon(riderPoint, zonePolygon)
    })
  }, [deliveryBoys, selectedZoneId, zones])

  // Initialize Places Autocomplete when map is loaded
  useEffect(() => {
    if (!mapLoading && mapInstanceRef.current && autocompleteInputRef.current && window.google?.maps?.places && !autocompleteRef.current) {
      const autocomplete = new window.google.maps.places.Autocomplete(autocompleteInputRef.current, {
        componentRestrictions: { country: "in" }
      })

      autocomplete.addListener("place_changed", () => {
        const place = autocomplete.getPlace()
        if (place.geometry && place.geometry.location && mapInstanceRef.current) {
          const location = place.geometry.location
          mapInstanceRef.current.setCenter(location)
          mapInstanceRef.current.setZoom(13)
          setLocationSearch(place.formatted_address || place.name || "")
        }
      })

      autocompleteRef.current = autocomplete
    }
  }, [mapLoading])

  // Draw zones and delivery boy markers when map and data are ready
  useEffect(() => {
    if (!mapLoading && mapInstanceRef.current && window.google) {
      drawAllZonesOnMap(window.google, mapInstanceRef.current)
      drawDeliveryBoyMarkers(window.google, mapInstanceRef.current, filteredDeliveryBoys).catch((error) => {
        debugError("Error drawing delivery boy markers:", error)
      })
    }
  }, [zones, mapLoading, filteredDeliveryBoys, selectedZoneId])

  const loadGoogleMaps = async () => {
    try {
      const apiKey = await getGoogleMapsApiKey()
      setGoogleMapsApiKey(apiKey || "loaded")

      let retries = 0
      const maxRetries = 50

      while (!window.google && retries < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        retries++
      }

      if (window.google && window.google.maps) {
        initializeMap(window.google)
        return
      }

      if (apiKey) {
        const loader = new Loader({
          apiKey: apiKey,
          version: "weekly",
          libraries: ["places", "geometry"]
        })

        const google = await loader.load()
        initializeMap(google)
      } else {
        setMapLoading(false)
      }
    } catch (error) {
      debugError("Error loading Google Maps:", error)
      setMapLoading(false)
    }
  }

  const initializeMap = (google) => {
    if (!mapRef.current) return

    const initialLocation = { lat: 20.5937, lng: 78.9629 }

    const map = new google.maps.Map(mapRef.current, {
      center: initialLocation,
      zoom: 5,
      mapTypeControl: true,
      mapTypeControlOptions: {
        style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
        position: google.maps.ControlPosition.TOP_RIGHT,
        mapTypeIds: [google.maps.MapTypeId.ROADMAP, google.maps.MapTypeId.SATELLITE]
      },
      zoomControl: true,
      streetViewControl: false,
      fullscreenControl: true,
      scrollwheel: true,
      gestureHandling: "greedy",
      disableDoubleClickZoom: false
    })

    mapInstanceRef.current = map
    setMapLoading(false)
  }

  // Draw all zones on the map
  const drawAllZonesOnMap = (google, map) => {
    zonesPolygonsRef.current.forEach((polygon) => {
      if (polygon) polygon.setMap(null)
    })
    zonesPolygonsRef.current = []

    infoWindowsRef.current.forEach((infoWindow) => {
      if (infoWindow) infoWindow.close()
    })
    infoWindowsRef.current = []

    if (!zones || zones.length === 0) return

    const colors = [
      "#3b82f6", "#10b981", "#f59e0b", "#ef4444",
      "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16"
    ]

    const bounds = new google.maps.LatLngBounds()
    let pointsToFit = 0

    zones.forEach((zone, index) => {
      if (!zone.coordinates || zone.coordinates.length < 3) return

      const path = zone.coordinates
        .map((coord) => {
          const pt = parseCoords(coord)
          if (!pt) return null
          const latLng = new google.maps.LatLng(pt.lat, pt.lng)
          const zoneId = String(zone?._id || zone?.id)
          if (selectedZoneId === "all" || zoneId === String(selectedZoneId)) {
            bounds.extend(latLng)
            pointsToFit++
          }
          return latLng
        })
        .filter(Boolean)

      if (path.length < 3) return

      const color = colors[index % colors.length]

      const polygon = new google.maps.Polygon({
        paths: path,
        strokeColor: color,
        strokeOpacity: 0.8,
        strokeWeight: 2,
        fillColor: color,
        fillOpacity: 0.2,
        editable: false,
        draggable: false,
        clickable: true,
        zIndex: 1
      })

      polygon.setMap(map)
      zonesPolygonsRef.current.push(polygon)

      const infoWindow = new google.maps.InfoWindow({
        content: `
          <div style="padding: 12px; min-width: 200px; font-family: system-ui, sans-serif;">
            <h3 style="margin: 0 0 8px 0; font-size: 15px; font-weight: 600; color: #0f172a;">
              ${zone.name || zone.zoneName || "Zone"}
            </h3>
            <div style="font-size: 13px; color: #475569; line-height: 1.6;">
              <div style="margin-bottom: 4px;">
                <strong>Location:</strong> ${zone.serviceLocation || "N/A"}
              </div>
              <div style="margin-bottom: 4px;">
                <strong>Unit:</strong> ${zone.unit || "km"}
              </div>
              <div style="margin-bottom: 4px;">
                <strong>Points:</strong> ${zone.coordinates.length}
              </div>
              <div>
                <strong>Status:</strong> 
                <span style="color: ${zone.isActive ? "#10b981" : "#ef4444"}; font-weight: 600;">
                  ${zone.isActive ? "Active" : "Inactive"}
                </span>
              </div>
            </div>
          </div>
        `
      })

      polygon.addListener("click", () => {
        infoWindowsRef.current.forEach((iw) => {
          if (iw && iw !== infoWindow) iw.close()
        })
        infoWindow.setPosition(path[0])
        infoWindow.open(map)
        infoWindowsRef.current.push(infoWindow)
      })
    })

    if (pointsToFit > 0) {
      const padding = { top: 50, right: 50, bottom: 50, left: 50 }
      map.fitBounds(bounds, padding)

      if (selectedZoneId !== "all") {
        const listener = google.maps.event.addListener(map, "idle", () => {
          if (map.getZoom() > 16) map.setZoom(15)
          google.maps.event.removeListener(listener)
        })
      }
    }
  }

  // Generate or retrieve rotated bike icon canvas
  const getRotatedBikeIcon = (heading = 0) => {
    const roundedHeading = Math.round(heading / 5) * 5
    const cacheKey = `${roundedHeading}`

    if (rotatedIconCacheRef.current.has(cacheKey)) {
      return Promise.resolve(rotatedIconCacheRef.current.get(cacheKey))
    }

    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas")
          const size = 52
          canvas.width = size
          canvas.height = size
          const ctx = canvas.getContext("2d")

          ctx.clearRect(0, 0, size, size)
          ctx.save()
          ctx.translate(size / 2, size / 2)
          ctx.rotate((roundedHeading * Math.PI) / 180)
          ctx.drawImage(img, -size / 2, -size / 2, size, size)
          ctx.restore()

          const dataUrl = canvas.toDataURL()
          rotatedIconCacheRef.current.set(cacheKey, dataUrl)
          resolve(dataUrl)
        } catch (error) {
          resolve(bikeLogo)
        }
      }
      img.onerror = () => {
        resolve(bikeLogo)
      }
      img.src = bikeLogo
    })
  }

  // Draw delivery boy markers (bikes) on the map
  const drawDeliveryBoyMarkers = async (google, map, markerList = []) => {
    // Clear existing markers
    deliveryBoyMarkersRef.current.forEach((marker) => {
      if (marker) marker.setMap(null)
    })
    deliveryBoyMarkersRef.current = []

    if (!markerList || markerList.length === 0) return

    const processedIds = new Set()
    const markerBounds = new google.maps.LatLngBounds()

    for (const boy of markerList) {
      const fullData = boy.fullData || boy
      const boyId = normalizeId(boy._id || boy.id || boy.deliveryId || fullData?._id)
      if (!boyId || processedIds.has(boyId)) continue
      processedIds.add(boyId)

      const availability = boy.availability || fullData?.availability || {}
      const currentLocation = availability?.currentLocation || {}

      // Robust coordinate extraction
      const coords =
        parseCoords(currentLocation?.coordinates) ||
        parseCoords(currentLocation) ||
        parseCoords({ lat: boy?.lastLat ?? boy?.lat, lng: boy?.lastLng ?? boy?.lng }) ||
        parseCoords(boy?.lastLocation?.coordinates)

      if (!coords) continue
      const { lat, lng } = coords

      const heading = Number(currentLocation.heading || boy?.lastHeading || 0)
      const speed = Number(currentLocation.speed || boy?.lastSpeed || 0)
      const boyName = fullData.name || fullData.fullName || boy.name || "Delivery Boy"
      const boyPhone = fullData.phone || boy.phone || "N/A"
      const lastUpdate = availability?.lastLocationUpdate || currentLocation?.lastUpdate || boy?.lastLocationAt

      const isOnline = availability?.isOnline !== false
      const statusLabel = availability?.status === "busy" ? "On Trip" : isOnline ? "Online" : "Offline"
      const statusColor = availability?.status === "busy" ? "#f59e0b" : isOnline ? "#10b981" : "#64748b"

      const rotatedIconUrl = await getRotatedBikeIcon(heading)
      const bikeIcon = {
        url: rotatedIconUrl,
        scaledSize: new google.maps.Size(48, 48),
        anchor: new google.maps.Point(24, 24)
      }

      const marker = new google.maps.Marker({
        position: { lat, lng },
        map: map,
        icon: bikeIcon,
        title: boyName,
        zIndex: 1000
      })
      markerBounds.extend(new google.maps.LatLng(lat, lng))

      const formattedTime = lastUpdate
        ? new Date(lastUpdate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
        : "Just now"

      const infoWindow = new google.maps.InfoWindow({
        content: `
          <div style="padding: 12px; min-width: 220px; font-family: system-ui, sans-serif;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
              <h3 style="margin: 0; font-size: 15px; font-weight: 600; color: #0f172a;">
                ${boyName}
              </h3>
              <span style="font-size: 11px; padding: 2px 8px; border-radius: 9999px; background: ${statusColor}15; color: ${statusColor}; font-weight: 600;">
                ${statusLabel}
              </span>
            </div>
            <div style="font-size: 13px; color: #475569; line-height: 1.6;">
              <div style="margin-bottom: 4px;">
                <strong>Phone:</strong> <a href="tel:${boyPhone}" style="color: #3b82f6; text-decoration: none;">${boyPhone}</a>
              </div>
              ${speed > 0 ? `
                <div style="margin-bottom: 4px;">
                  <strong>Speed:</strong> ${speed.toFixed(1)} km/h
                </div>
              ` : ""}
              <div style="margin-top: 6px; font-size: 11px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 6px;">
                Last location: ${formattedTime}
              </div>
            </div>
          </div>
        `
      })

      marker.addListener("click", () => {
        infoWindowsRef.current.forEach((iw) => {
          if (iw && iw !== infoWindow) iw.close()
        })
        infoWindow.open(map, marker)
        infoWindowsRef.current.push(infoWindow)
      })

      deliveryBoyMarkersRef.current.push(marker)
    }

    // Auto center map on riders if no specific zone polygon was zoomed to
    if (deliveryBoyMarkersRef.current.length > 0 && selectedZoneId === "all" && zones.length === 0) {
      if (deliveryBoyMarkersRef.current.length === 1) {
        map.setCenter(markerBounds.getCenter())
        if (map.getZoom() < 14) map.setZoom(14)
      } else {
        map.fitBounds(markerBounds, { top: 60, right: 60, bottom: 60, left: 60 })
      }
    }
  }

  const handleManualRefresh = async () => {
    setIsRefreshing(true)
    await Promise.all([fetchZones(), fetchDeliveryPartnerDirectory()])
    setIsRefreshing(false)
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="p-4 lg:p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate("/admin/food")}
              className="p-2 hover:bg-slate-200 rounded-lg transition-colors"
              title="Back"
            >
              <ArrowLeft className="w-5 h-5 text-slate-600" />
            </button>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-orange-500 flex items-center justify-center text-white shadow-sm">
                <Bike className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-slate-900">Delivery Partner Live Map</h1>
                <p className="text-sm text-slate-600">Track online delivery partners and background GPS locations in real time</p>
              </div>
            </div>
          </div>

          <button
            onClick={handleManualRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors shadow-sm"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? "animate-spin text-orange-500" : ""}`} />
            Refresh
          </button>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-4 mb-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                ref={autocompleteInputRef}
                type="text"
                placeholder="Search location on map..."
                value={locationSearch}
                onChange={(e) => setLocationSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>
            <select
              value={selectedZoneId}
              onChange={(event) => setSelectedZoneId(event.target.value)}
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-orange-500"
            >
              <option value="all">All zones ({filteredDeliveryBoys.length} partners)</option>
              {zones
                .filter((zone) => zone?.isActive !== false)
                .map((zone) => (
                  <option key={String(zone?._id || zone?.id)} value={String(zone?._id || zone?.id)}>
                    {zone?.name || zone?.zoneName || zone?.serviceLocation || "Unnamed Zone"}
                  </option>
                ))}
            </select>
          </div>
        </div>

        {/* Map Container */}
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-4">
          <div className="relative" style={{ height: "calc(100vh - 250px)", minHeight: "600px" }}>
            <div ref={mapRef} className="w-full h-full rounded-lg" />

            {mapLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-100/90 rounded-lg z-10">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500 mx-auto mb-4"></div>
                  <p className="text-slate-600 font-medium">Loading Google Maps...</p>
                </div>
              </div>
            )}

            {!googleMapsApiKey && !mapLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-100/90 rounded-lg z-10">
                <div className="text-center p-6 bg-white rounded-xl shadow-lg border border-slate-200 max-w-sm">
                  <MapPin className="w-12 h-12 text-slate-400 mx-auto mb-4" />
                  <p className="text-sm font-semibold text-slate-900">Google Maps API Key Not Found</p>
                  <p className="text-xs text-slate-500 mt-1">Please configure your Google Maps API key in settings.</p>
                </div>
              </div>
            )}
          </div>

          {/* Legend */}
          {!mapLoading && (
            <div className="mt-4 p-4 bg-slate-50 rounded-lg border border-slate-200 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div className="text-xs text-slate-600 space-y-1">
                {zones.length > 0 && (
                  <p>
                    Configured delivery zones: <strong>{zones.length}</strong>
                  </p>
                )}
                <p>
                  Live delivery partners on map: <strong className="text-green-600">{filteredDeliveryBoys.length}</strong>
                </p>
              </div>

              {filteredDeliveryBoys.length === 0 ? (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
                  <span>No delivery partners with active coordinates found for this zone.</span>
                </div>
              ) : (
                <div className="text-xs text-green-700 bg-green-50 border border-green-200 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                  <span>Live tracking active • Real-time updates enabled</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

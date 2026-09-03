/* ==========================================================================
   NER-SMART — Smart Logistics, Accessibility & Emergency/Rescue Platform
   Complete rewritten script.js
   ========================================================================== */

/* ==========================================================================
   1. CONFIGURATION
   ========================================================================== */

const STORAGE_KEYS = {
    INCIDENTS: "nerSmartIncidents",
    SOS: "nerSmartSOS",
    RESOURCES: "nerSmartResources"
};

const OSRM_BASE_URL = "https://router.project-osrm.org/route/v1/driving/";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// Reuse an existing Supabase client if one is already initialized elsewhere
// in the page. Never create a second client, never invent credentials here.
const supabaseClient = window.supabaseClient || null;
const supabaseConfigured = !!supabaseClient;

const SOS_EMERGENCY_BASE_SCORE = {
    "Medical Emergency": 40,
    "People Trapped": 35,
    "Rescue Required": 35,
    "Flood": 30,
    "Water Required": 25,
    "Medicine Required": 25,
    "Food Required": 20,
    "Other": 10
};

const URGENT_KEYWORDS = [
    "dying", "unconscious", "bleeding", "drowning", "trapped",
    "urgent", "emergency", "critical", "collapsed", "fire", "not breathing"
];

/* ==========================================================================
   2. GLOBAL STATE
   ========================================================================== */

let map = null;

let selectedStart = null;      // { lat, lng }
let destinationMarker = null;  // Leaflet marker
let currentRouteLine = null;   // Leaflet polyline

let riskMarkers = [];
let facilityMarkers = [];

let incidentMarkers = [];
let incidentMarkerById = {};

let sosMarkers = [];
let sosMarkerById = {};

let resourceMarkers = [];

let vehicleMarkers = [];
let demoVehicles = [];

let lastRouteAnalyses = [];   // analysed OSRM alternatives (real API results only)
let selectedRouteAnalysisIndex = 0;
let lastRouteRequest = null;  // { start, end }
let demoRiskPoints = [];      // risk points created by showRiskPoints()

let alertsCache = [];
let currentAlertFilter = "all";
let alertFiltersBound = false;

let notificationDropdownOpen = false;
let notificationOutsideClickBound = false;
let unreadNotificationCount = 0;

/* ==========================================================================
   3. UTILITY FUNCTIONS
   ========================================================================== */

function escapeHTML(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function byId(id) {
    return document.getElementById(id);
}

function setText(id, value) {
    const el = byId(id);
    if (el) {
        el.textContent = value;
    }
}

function setHTML(id, html) {
    const el = byId(id);
    if (el) {
        el.innerHTML = html;
    }
}

function safeParseArray(raw) {
    try {
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error("Failed to parse stored data:", error);
        return [];
    }
}

function loadFromStorage(key) {
    return safeParseArray(localStorage.getItem(key));
}

function saveToStorage(key, records) {
    try {
        localStorage.setItem(key, JSON.stringify(records));
    } catch (error) {
        console.error("Failed to save to localStorage:", error);
    }
}

function generateId(prefix) {
    return prefix + "-" + Date.now() + "-" + Math.floor(Math.random() * 100000);
}

function nowISO() {
    return new Date().toISOString();
}

function formatTime(value) {
    if (!value) {
        return "Unknown";
    }
    const date = new Date(value);
    return isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function formatLatLng(lat, lng) {
    if (lat === null || lat === undefined || lng === null || lng === undefined) {
        return "Unknown";
    }
    return Number(lat).toFixed(5) + ", " + Number(lng).toFixed(5);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

async function safeSupabaseCall(fn, fallbackLabel) {
    if (!supabaseConfigured) {
        return { ok: false, reason: "not_configured" };
    }
    try {
        const result = await fn();
        if (result && result.error) {
            console.error(fallbackLabel + " Supabase error:", result.error);
            return { ok: false, reason: "error", error: result.error };
        }
        return { ok: true, data: result ? result.data : null };
    } catch (error) {
        console.error(fallbackLabel + " Supabase call failed:", error);
        return { ok: false, reason: "network", error: error };
    }
}

/* ==========================================================================
   4. MAP INITIALIZATION
   ========================================================================== */

function initMap() {
    const mapEl = byId("map");
    if (!mapEl) {
        console.warn("No #map element found — map features are disabled.");
        return null;
    }

    // Guard against Leaflet's "Map container is already initialized" error
    // if initApp() ever runs twice (e.g. hot reload, duplicate script include).
    if (mapEl._leaflet_id) {
        console.warn("Map already initialized — reusing existing instance.");
        return map;
    }

    const leafletMap = L.map("map").setView([27.5, 93.5], 6);

    // "osm-intl" = OpenStreetMap tiles with internationalised (Latin/English)
    // labels. The plain OSM tile server renders labels in each country's local
    // script (Chinese, Assamese, etc.), which is why labels looked Chinese when
    // zooming near the China border. No API key required.
    L.tileLayer("https://maps.wikimedia.org/osm-intl/{z}/{x}/{y}{r}.png", {
        attribution: "&copy; OpenStreetMap contributors | Wikimedia Maps",
        maxZoom: 19
    }).addTo(leafletMap);



    leafletMap.on("click", function (event) {
        selectedStart = { lat: event.latlng.lat, lng: event.latlng.lng };

        L.popup()
            .setLatLng(event.latlng)
            .setContent(
                "<b>Selected location</b><br>" +
                formatLatLng(event.latlng.lat, event.latlng.lng) +
                '<br><button onclick="checkAccessibility()">Check Accessibility</button>'
            )
            .openOn(leafletMap);
    });

    return leafletMap;
}

function checkAccessibility() {
    if (!selectedStart) {
        setText("route-status", "Please click a location on the map first.");
        return;
    }
    setText(
        "location-display",
        "📍 Selected: " + formatLatLng(selectedStart.lat, selectedStart.lng)
    );
    setText("route-status", "Location set. Choose a destination or find nearby facilities.");
}

function useSelectedMapLocation() {
    checkAccessibility();
}

function getCurrentLocation() {
    if (!navigator.geolocation) {
        setText("route-status", "Geolocation is not supported by this browser.");
        return;
    }
    navigator.geolocation.getCurrentPosition(
        function (position) {
            selectedStart = {
                lat: position.coords.latitude,
                lng: position.coords.longitude
            };
            if (map) {
                map.setView([selectedStart.lat, selectedStart.lng], 13);
            }
            setText(
                "location-display",
                "📍 Current location: " + formatLatLng(selectedStart.lat, selectedStart.lng)
            );
            setText("route-status", "Current location captured.");
        },
        function () {
            setText("route-status", "Unable to access your location. Please select a point on the map instead.");
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

/* ==========================================================================
   5. ACCESSIBILITY MODULE
   ========================================================================== */

const ACCESSIBILITY_PROFILES = {
    wheelchair: {
        label: "Wheelchair user",
        notes: "Prioritizing accessible roads, ramps, and lower-risk routes."
    },
    elderly: {
        label: "Elderly",
        notes: "Prioritizing safer roads, shorter routes, and nearby facilities."
    },
    visual: {
        label: "Visually impaired",
        notes: "Prioritizing safer crossings, simple route information, and accessible facilities."
    },
    hearing: {
        label: "Hearing impaired",
        notes: "Prioritizing clear visual information and accessible facilities."
    },
    general: {
        label: "General accessibility",
        notes: "Prioritizing overall accessibility and lower-risk routes."
    }
};

function getAccessibilityPreference() {
    const el = byId("accessibility-type");
    const value = el ? el.value : "general";
    return ACCESSIBILITY_PROFILES[value] ? value : "general";
}

function analyzeUserPreference() {
    const preferenceKey = getAccessibilityPreference();
    const profile = ACCESSIBILITY_PROFILES[preferenceKey];

    setHTML(
        "preference-result",
        "<b>" + escapeHTML(profile.label) + ":</b> " + escapeHTML(profile.notes)
    );

    generateSmartRecommendation();
}

function calculateAccessibilityScore(distanceKm, durationMin) {
    const preferenceKey = getAccessibilityPreference();

    let score = 90;

    if (distanceKm > 15) score -= 15;
    else if (distanceKm > 8) score -= 8;
    else if (distanceKm > 3) score -= 3;

    if (durationMin > 40) score -= 15;
    else if (durationMin > 20) score -= 8;
    else if (durationMin > 10) score -= 3;

    if (preferenceKey === "wheelchair") score -= 5;
    if (preferenceKey === "visual") score -= 3;

    score = clamp(Math.round(score), 0, 100);

    setText("score", score);
    generateAccessibilityInsights(score, distanceKm, durationMin, preferenceKey);

    return score;
}

function generateAccessibilityInsights(score, distanceKm, durationMin, preferenceKey) {
    const listEl = byId("insights-list");
    if (!listEl) {
        return;
    }

    const insights = [];

    if (score >= 70) {
        insights.push("This route is generally favorable for the selected accessibility profile.");
    } else if (score >= 40) {
        insights.push("This route has moderate accessibility concerns — plan for extra time.");
    } else {
        insights.push("This route may present significant accessibility challenges.");
    }

    insights.push("Distance: " + distanceKm.toFixed(1) + " km, estimated time: " + Math.round(durationMin) + " min.");
    insights.push(ACCESSIBILITY_PROFILES[preferenceKey].notes);

    listEl.innerHTML = insights.map(function (line) {
        return "<li>" + escapeHTML(line) + "</li>";
    }).join("");
}

function generateSmartRecommendation() {
    const preferenceKey = getAccessibilityPreference();
    const profile = ACCESSIBILITY_PROFILES[preferenceKey];

    setHTML(
        "ai-recommendation",
        "🤖 <b>Rule-based recommendation:</b> " + escapeHTML(profile.notes)
    );

    const secondaryEl = byId("ai-recommendation-secondary");
    if (secondaryEl) {
        secondaryEl.innerHTML =
            "This suggestion is generated from simple, transparent rules based on your selected " +
            "profile — it is not an AI model and does not use any external medical or government data.";
    }
}

/* ==========================================================================
   6. ROUTE MODULE
   ========================================================================== */

function clearCurrentRoute() {
    if (currentRouteLine && map) {
        map.removeLayer(currentRouteLine);
    }
    currentRouteLine = null;
}

function getRouteStyleForScore(score) {
    if (score >= 70) {
        return { color: "#16a34a", label: "Safe route" };
    }
    if (score >= 40) {
        return { color: "#f97316", label: "Medium-risk route" };
    }
    return { color: "#dc2626", label: "High-risk route" };
}

/* --------------------------------------------------------------------------
   6a. GEOMETRY HELPERS (Haversine + point-to-segment distance)
   -------------------------------------------------------------------------- */

function toRadians(deg) {
    return (deg * Math.PI) / 180;
}

// Great-circle distance between two {lat,lng} points, in kilometres.
function haversineKm(a, b) {
    if (!a || !b) return Infinity;
    const R = 6371;
    const dLat = toRadians(b.lat - a.lat);
    const dLng = toRadians(b.lng - a.lng);
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const h =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Shortest distance (km) from a point to the segment A-B, using a local
// equirectangular projection. Accurate enough at city / district scale.
function pointToSegmentKm(point, a, b) {
    const R = 6371;
    const latRef = toRadians((a.lat + b.lat) / 2);

    function project(p) {
        return {
            x: R * toRadians(p.lng) * Math.cos(latRef),
            y: R * toRadians(p.lat)
        };
    }

    const P = project(point);
    const A = project(a);
    const B = project(b);

    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
        return haversineKm(point, a);
    }

    let t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / lenSq;
    t = clamp(t, 0, 1);

    const cx = A.x + t * dx;
    const cy = A.y + t * dy;

    return Math.sqrt((P.x - cx) * (P.x - cx) + (P.y - cy) * (P.y - cy));
}

// Shortest distance (km) from a point to a polyline of {lat,lng} coordinates.
function distanceToRouteKm(point, coords) {
    if (!coords || coords.length === 0) return Infinity;
    if (coords.length === 1) return haversineKm(point, coords[0]);

    let best = Infinity;
    for (let i = 0; i < coords.length - 1; i++) {
        const d = pointToSegmentKm(point, coords[i], coords[i + 1]);
        if (d < best) best = d;
    }
    return best;
}

/* --------------------------------------------------------------------------
   6b. HAZARD COLLECTION AND ROUTE RISK SCORING
   -------------------------------------------------------------------------- */

// Distance from the route line within which a hazard is considered relevant.
const HAZARD_CORRIDOR_KM = 1.5;

const HAZARD_SEVERITY_WEIGHT = {
    CRITICAL: 30,
    HIGH: 20,
    MEDIUM: 10,
    LOW: 5
};

function normalizeSeverity(value) {
    const text = String(value || "").toUpperCase();
    if (text.indexOf("CRITICAL") !== -1) return "CRITICAL";
    if (text.indexOf("HIGH") !== -1) return "HIGH";
    if (text.indexOf("MEDIUM") !== -1 || text.indexOf("MODERATE") !== -1) return "MEDIUM";
    return "LOW";
}

// Builds the live hazard list from data the app already stores:
// reported incidents, HIGH/CRITICAL SOS requests and analysed risk points.
function collectRouteHazards() {
    const hazards = [];

    getSavedIncidents().forEach(function (incident) {
        if (incident.status === "RESOLVED") return;
        const lat = parseFloat(incident.latitude);
        const lng = parseFloat(incident.longitude);
        if (isNaN(lat) || isNaN(lng)) return;

        hazards.push({
            source: "Incident",
            type: incident.type || "Incident",
            severity: normalizeSeverity(incident.severity),
            lat: lat,
            lng: lng,
            label: (incident.type || "Incident") + " (" + (incident.id || "incident") + ")"
        });
    });

    getSavedSOS().forEach(function (record) {
        if (record.status === "RESOLVED") return;
        const severity = normalizeSeverity(record.priorityLevel);
        if (severity !== "HIGH" && severity !== "CRITICAL") return;

        const lat = parseFloat(record.latitude);
        const lng = parseFloat(record.longitude);
        if (isNaN(lat) || isNaN(lng)) return;

        hazards.push({
            source: "SOS",
            type: record.emergencyType || "SOS",
            severity: severity,
            lat: lat,
            lng: lng,
            label: "SOS: " + (record.emergencyType || "Emergency") + " (" + (record.id || "sos") + ")"
        });
    });

    demoRiskPoints.forEach(function (risk) {
        hazards.push({
            source: "Risk point",
            type: risk.label || "Risk point",
            severity: normalizeSeverity(risk.level),
            lat: risk.lat,
            lng: risk.lng,
            label: risk.label || "Risk point"
        });
    });

    return hazards;
}

// Transparent scoring: every hazard near the route contributes its severity
// weight, scaled down as it gets further from the route line.
function scoreRouteHazards(hazards) {
    let penalty = 0;

    hazards.forEach(function (hazard) {
        const weight = HAZARD_SEVERITY_WEIGHT[hazard.severity] || 5;
        const proximityFactor = clamp(1 - (hazard.distanceKm / HAZARD_CORRIDOR_KM), 0.2, 1);
        penalty += weight * proximityFactor;
    });

    const riskScore = clamp(Math.round(penalty), 0, 100);

    let riskLevel = "LOW";
    if (riskScore >= 70) riskLevel = "CRITICAL";
    else if (riskScore >= 40) riskLevel = "HIGH";
    else if (riskScore >= 15) riskLevel = "MEDIUM";

    return { riskScore: riskScore, riskLevel: riskLevel };
}

// Analyses one genuine OSRM route object. No statistics are invented:
// distance and duration come from OSRM, hazards from stored app data.
function buildRouteAnalysis(route, index) {
    const coords = (route.geometry && route.geometry.coordinates ? route.geometry.coordinates : [])
        .map(function (pair) {
            return { lat: pair[1], lng: pair[0] };
        });

    const analysis = {
        index: index,
        coords: coords,
        distanceKm: (route.distance || 0) / 1000,
        durationMin: (route.duration || 0) / 60
    };

    return analyseStoredRoute(analysis);
}

// Recomputes hazards / risk for an already-stored route geometry.
function analyseStoredRoute(analysis) {
    const nearby = [];

    collectRouteHazards().forEach(function (hazard) {
        const distanceKm = distanceToRouteKm({ lat: hazard.lat, lng: hazard.lng }, analysis.coords);
        if (distanceKm <= HAZARD_CORRIDOR_KM) {
            nearby.push(Object.assign({}, hazard, { distanceKm: distanceKm }));
        }
    });

    nearby.sort(function (a, b) { return a.distanceKm - b.distanceKm; });

    const scored = scoreRouteHazards(nearby);

    const types = [];
    nearby.forEach(function (hazard) {
        if (types.indexOf(hazard.type) === -1) types.push(hazard.type);
    });

    analysis.hazards = nearby;
    analysis.hazardTypes = types;
    analysis.riskScore = scored.riskScore;
    analysis.riskLevel = scored.riskLevel;
    analysis.riskLabel = "Risk " + scored.riskLevel + " (" + scored.riskScore + "/100)";
    analysis.hasSeriousHazard = nearby.some(function (hazard) {
        return hazard.severity === "HIGH" || hazard.severity === "CRITICAL";
    });
    analysis.safetyScore = clamp(100 - scored.riskScore, 0, 100);

    return analysis;
}

// Prefers the lowest-risk genuine alternative; ties break on travel time.
function pickSaferRouteIndex(analyses) {
    if (!analyses || !analyses.length) return 0;

    let bestIndex = 0;
    for (let i = 1; i < analyses.length; i++) {
        const current = analyses[i];
        const best = analyses[bestIndex];
        if (
            current.riskScore < best.riskScore ||
            (current.riskScore === best.riskScore && current.durationMin < best.durationMin)
        ) {
            bestIndex = i;
        }
    }
    return bestIndex;
}

function drawRouteAnalysis(analysis, fitView) {
    if (!map || !analysis || !analysis.coords.length) return;

    clearCurrentRoute();

    const style = getRouteStyleForScore(analysis.safetyScore);

    currentRouteLine = L.polyline(
        analysis.coords.map(function (p) { return [p.lat, p.lng]; }),
        { color: style.color, weight: 5, opacity: 0.85 }
    ).addTo(map);

    if (fitView !== false) {
        map.fitBounds(currentRouteLine.getBounds(), { padding: [30, 30] });
    }

    calculateAccessibilityScore(analysis.distanceKm, analysis.durationMin);
    setText("dashboard-risk", analysis.riskLevel);
    setText("risk", analysis.riskLevel + " (" + analysis.hazards.length + " hazard(s))");
}

/* --------------------------------------------------------------------------
   6c. ROUTE INTELLIGENCE RENDERING + LIVE UPDATES
   -------------------------------------------------------------------------- */

function routeSummaryHTML(analysis, title) {
    if (!analysis) return "";

    const typesText = analysis.hazardTypes.length
        ? analysis.hazardTypes.map(escapeHTML).join(", ")
        : "None detected";

    return (
        '<div class="route-summary">' +
        "<h4>" + escapeHTML(title) + "</h4>" +
        "<p><b>Distance:</b> " + analysis.distanceKm.toFixed(1) + " km</p>" +
        "<p><b>ETA:</b> " + Math.round(analysis.durationMin) + " min</p>" +
        "<p><b>Risk score:</b> " + analysis.riskScore + "/100</p>" +
        "<p><b>Risk level:</b> " + escapeHTML(analysis.riskLevel) + "</p>" +
        "<p><b>Hazards near route:</b> " + analysis.hazards.length + "</p>" +
        "<p><b>Hazard types:</b> " + typesText + "</p>" +
        "</div>"
    );
}

function renderRouteIntelligence() {
    const resultEl = byId("routeResult");
    const panelEl = byId("route-intel-panel");

    if (!lastRouteAnalyses.length) {
        const empty =
            "No route has been calculated yet. Open the Dashboard map, select a start point, " +
            "search a destination and click “Find Accessible Route”.";
        if (resultEl) resultEl.textContent = empty;
        if (panelEl) panelEl.innerHTML = "<p>" + empty + "</p>";
        return;
    }

    const fastest = lastRouteAnalyses.reduce(function (best, item) {
        return item.durationMin < best.durationMin ? item : best;
    }, lastRouteAnalyses[0]);

    const safest = lastRouteAnalyses[pickSaferRouteIndex(lastRouteAnalyses)];
    const selected = lastRouteAnalyses[selectedRouteAnalysisIndex] || safest;

    let html = "";

    if (selected.hasSeriousHazard) {
        html +=
            '<p class="route-warning">⚠️ Serious hazard detected near this route — ' +
            escapeHTML(selected.hazards[0].label) + " about " +
            selected.hazards[0].distanceKm.toFixed(1) + " km from the road.</p>";
    }

    html += routeSummaryHTML(fastest, "⚡ Fastest Route (OSRM)");
    html += routeSummaryHTML(selected, "🛡️ Safety Analysis (selected route)");
    html += routeSummaryHTML(selected, "♿ Accessible Route (in use)");

    if (lastRouteAnalyses.length > 1 && safest.index !== fastest.index) {
        html +=
            '<p class="route-note">A genuine OSRM alternative with a lower risk score is available ' +
            "and has been selected (risk " + safest.riskScore + "/100 vs " + fastest.riskScore + "/100).</p>";
    } else if (lastRouteAnalyses.length > 1) {
        html +=
            '<p class="route-note">OSRM returned ' + lastRouteAnalyses.length +
            " alternatives; the current route already has the lowest risk score.</p>";
    } else {
        html +=
            '<p class="route-note">OSRM returned only one route for this pair of points, so no ' +
            "alternative exists. The safety analysis above applies to that single route.</p>";
    }

    if (resultEl) resultEl.innerHTML = html;
    if (panelEl) panelEl.innerHTML = html;
}

// Re-runs hazard detection for already-calculated routes whenever incidents,
// SOS records or risk points change. Never re-requests OSRM.
function updateRouteRiskAnalysis() {
    if (!lastRouteAnalyses.length) {
        renderRouteIntelligence();
        return;
    }

    lastRouteAnalyses = lastRouteAnalyses.map(function (analysis) {
        return analyseStoredRoute(analysis);
    });

    selectedRouteAnalysisIndex = pickSaferRouteIndex(lastRouteAnalyses);

    const chosen = lastRouteAnalyses[selectedRouteAnalysisIndex];
    if (chosen) {
        setText("dashboard-risk", chosen.riskLevel);
        drawRouteAnalysis(chosen, false);
    }

    renderRouteIntelligence();
}



async function findAccessibleRoute() {
    if (!selectedStart) {
        setText("route-status", "Please select a starting location on the map first.");
        return;
    }
    if (!destinationMarker) {
        setText("route-status", "Please search for and select a destination first.");
        return;
    }

    setText("route-status", "Calculating route...");

    const destLatLng = destinationMarker.getLatLng();
    const url =
        OSRM_BASE_URL +
        selectedStart.lng + "," + selectedStart.lat + ";" +
        destLatLng.lng + "," + destLatLng.lat +
        "?overview=full&geometries=geojson&alternatives=true";

    let response;
    try {
        response = await fetch(url);
    } catch (error) {
        console.error("OSRM network error:", error);
        setText("route-status", "Network error while calculating the route. Please try again.");
        return;
    }

    if (!response.ok) {
        setText("route-status", "The routing service returned an error. Please try again shortly.");
        return;
    }

    let data;
    try {
        data = await response.json();
    } catch (error) {
        console.error("OSRM response parse error:", error);
        setText("route-status", "Received an invalid response from the routing service.");
        return;
    }

    if (!data || data.code !== "Ok" || !data.routes || !data.routes.length) {
        setText("route-status", "No route could be found between these two points.");
        return;
    }

    lastRouteRequest = {
        start: { lat: selectedStart.lat, lng: selectedStart.lng },
        end: { lat: destLatLng.lat, lng: destLatLng.lng }
    };

    // Keep every genuine OSRM alternative. Nothing is invented here: if OSRM
    // returns a single route, only that route is analysed and displayed.
    lastRouteAnalyses = data.routes.map(function (route, index) {
        return buildRouteAnalysis(route, index);
    });

    selectedRouteAnalysisIndex = pickSaferRouteIndex(lastRouteAnalyses);

    const chosen = lastRouteAnalyses[selectedRouteAnalysisIndex];

    setText("dashboard-distance", chosen.distanceKm.toFixed(1) + " km");
    setText("dashboard-time", Math.round(chosen.durationMin) + " min");

    drawRouteAnalysis(chosen);

    setText(
        "route-status",
        chosen.riskLabel + " — " + chosen.distanceKm.toFixed(1) + " km, " +
        Math.round(chosen.durationMin) + " min, " + chosen.hazards.length + " hazard(s) near the route."
    );

    renderRouteIntelligence();
}

async function searchDestination() {
    const inputEl = byId("destination-input") || byId("destination");
    const query = inputEl ? inputEl.value.trim() : "";

    if (!query) {
        setText("route-status", "Please enter a destination to search for.");
        return;
    }

    setText("route-status", "Searching for destination...");

    let response;
    try {
        response = await fetch(NOMINATIM_URL + "?format=json&limit=1&q=" + encodeURIComponent(query));
    } catch (error) {
        console.error("Nominatim network error:", error);
        setText("route-status", "Network error while searching for the destination.");
        return;
    }

    if (!response.ok) {
        setText("route-status", "The location search service returned an error.");
        return;
    }

    let results;
    try {
        results = await response.json();
    } catch (error) {
        setText("route-status", "Received an invalid response while searching for the destination.");
        return;
    }

    if (!results || !results.length) {
        setText("route-status", "No matching destination was found.");
        return;
    }

    const place = results[0];
    const lat = parseFloat(place.lat);
    const lng = parseFloat(place.lon);

    if (destinationMarker && map) {
        map.removeLayer(destinationMarker);
    }

    if (map) {
        destinationMarker = L.marker([lat, lng])
            .addTo(map)
            .bindPopup("<b>Destination</b><br>" + escapeHTML(place.display_name))
            .openPopup();

        map.setView([lat, lng], 13);
    }

    setText("route-status", "Destination set: " + place.display_name);
}

/* ==========================================================================
   7. NEARBY FACILITIES
   ========================================================================== */

function clearFacilityMarkers() {
    facilityMarkers.forEach(function (marker) {
        if (map) map.removeLayer(marker);
    });
    facilityMarkers = [];
}

async function findNearbyFacilities() {
    if (!selectedStart) {
        setText("route-status", "Please select a location on the map first.");
        return;
    }

    setText("route-status", "Searching for nearby facilities...");

    const radius = 5000;
    const query =
        "[out:json][timeout:25];(" +
        'node["amenity"="hospital"](around:' + radius + "," + selectedStart.lat + "," + selectedStart.lng + ");" +
        'node["highway"="bus_stop"](around:' + radius + "," + selectedStart.lat + "," + selectedStart.lng + ");" +
        'node["railway"="station"](around:' + radius + "," + selectedStart.lat + "," + selectedStart.lng + ");" +
        ");out body;";

    let response;
    try {
        response = await fetch(OVERPASS_URL, {
            method: "POST",
            body: query
        });
    } catch (error) {
        console.error("Overpass network error:", error);
        setText("route-status", "Network error while searching for nearby facilities.");
        return;
    }

    if (!response.ok) {
        setText("route-status", "The facility search service returned an error.");
        return;
    }

    let data;
    try {
        data = await response.json();
    } catch (error) {
        setText("route-status", "Received an invalid response while searching for facilities.");
        return;
    }

    clearFacilityMarkers();

    const elements = (data && data.elements) || [];
    if (!elements.length) {
        setText("route-status", "No nearby facilities were found within 5 km.");
        return;
    }

    elements.forEach(function (element) {
        if (!map) return;

        let icon = "📍";
        let type = "Facility";
        if (element.tags && element.tags.amenity === "hospital") {
            icon = "🏥"; type = "Hospital";
        } else if (element.tags && element.tags.highway === "bus_stop") {
            icon = "🚌"; type = "Bus Stop";
        } else if (element.tags && element.tags.railway === "station") {
            icon = "🚉"; type = "Railway Station";
        }

        const name = (element.tags && element.tags.name) || type;

        const marker = L.marker([element.lat, element.lon])
            .addTo(map)
            .bindPopup("<b>" + icon + " " + escapeHTML(name) + "</b><br>" + escapeHTML(type));

        facilityMarkers.push(marker);
    });

    setText("route-status", elements.length + " nearby facilities found.");
}

/* ==========================================================================
   8. RISK POINTS
   ========================================================================== */

function clearRiskMarkers() {
    riskMarkers.forEach(function (marker) {
        if (map) map.removeLayer(marker);
    });
    riskMarkers = [];
}

function showRiskPoints() {
    if (!selectedStart) {
        setText("route-status", "Please select a location on the map first.");
        return;
    }

    // Clear previous risk markers first so repeated clicks never stack duplicates.
    clearRiskMarkers();
    demoRiskPoints = [];

    if (!map) {
        return;
    }

    const demoRisks = [
        { offsetLat: 0.01, offsetLng: 0.015, label: "Road blockage", level: "High" },
        { offsetLat: -0.012, offsetLng: 0.008, label: "Limited wheelchair access", level: "Medium" },
        { offsetLat: 0.006, offsetLng: -0.014, label: "Poor road condition", level: "Low" }
    ];

    demoRisks.forEach(function (risk) {
        const lat = selectedStart.lat + risk.offsetLat;
        const lng = selectedStart.lng + risk.offsetLng;

        const marker = L.marker([lat, lng])
            .addTo(map)
            .bindPopup("<b>⚠️ " + escapeHTML(risk.label) + "</b><br>Risk level: " + escapeHTML(risk.level));

        riskMarkers.push(marker);
        demoRiskPoints.push({ lat: lat, lng: lng, label: risk.label, level: risk.level });
    });

    updateRouteRiskAnalysis();

    setText("route-status", "Demo risk points displayed around the selected location.");
}

/* ==========================================================================
   9. INCIDENT REPORTING
   ========================================================================== */

let incidentLocation = null;

function getSavedIncidents() {
    return loadFromStorage(STORAGE_KEYS.INCIDENTS);
}

function saveIncident(incident) {
    const incidents = getSavedIncidents();
    incidents.push(incident);
    saveToStorage(STORAGE_KEYS.INCIDENTS, incidents);
}

function setIncidentLocation(lat, lng) {
    incidentLocation = { lat: parseFloat(lat), lng: parseFloat(lng) };
    setText("incident-location-display", formatLatLng(incidentLocation.lat, incidentLocation.lng));
    setText("incident-location-error", "");
}

function useSelectedIncidentLocation() {
    if (!selectedStart) {
        setText("incident-location-error", "No map location selected. Click the map first.");
        return;
    }
    setIncidentLocation(selectedStart.lat, selectedStart.lng);
}

function getIncidentLocation() {
    if (!navigator.geolocation) {
        setText("incident-location-error", "Geolocation is not supported by this browser.");
        return;
    }
    navigator.geolocation.getCurrentPosition(
        function (position) {
            setIncidentLocation(position.coords.latitude, position.coords.longitude);
        },
        function () {
            setText("incident-location-error", "Unable to get your location. Use the selected map location instead.");
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

function getIncidentSeverityRank(severity) {
    const order = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    return order[severity] !== undefined ? order[severity] : 4;
}

function incidentSeverityClass(severity) {
    return "severity-" + String(severity || "").toLowerCase();
}

function displayIncidentOnMap(incident) {
    if (!map || incident.latitude == null || incident.longitude == null) {
        return;
    }

    const popupHtml =
        "<div><b>🚧 " + escapeHTML(incident.type) + "</b><br>" +
        "Severity: " + escapeHTML(incident.severity) + "<br>" +
        "People affected: " + escapeHTML(incident.peopleAffected) + "<br>" +
        "Status: " + escapeHTML(incident.status) + "<br>" +
        escapeHTML(incident.description || "") +
        "</div>";

    const marker = L.marker([incident.latitude, incident.longitude])
        .addTo(map)
        .bindPopup(popupHtml);

    incidentMarkers.push(marker);
    if (incident.id) {
        incidentMarkerById[incident.id] = marker;
    }
}

function renderIncidentList() {
    const listEl = byId("incident-list");
    if (!listEl) return;

    const incidents = getSavedIncidents();
    if (!incidents.length) {
        listEl.innerHTML = '<p class="incident-empty">No incidents reported yet.</p>';
        return;
    }

    listEl.innerHTML = incidents.slice().reverse().map(function (incident) {
        return (
            '<div class="incident-card ' + incidentSeverityClass(incident.severity) + '">' +
            "<strong>" + escapeHTML(incident.id) + "</strong>" +
            "<p><b>Type:</b> " + escapeHTML(incident.type) + "</p>" +
            "<p><b>Severity:</b> " + escapeHTML(incident.severity) + "</p>" +
            "<p><b>People affected:</b> " + escapeHTML(incident.peopleAffected) + "</p>" +
            "<p>" + escapeHTML(incident.description || "") + "</p>" +
            "<p><b>Location:</b> " + escapeHTML(formatLatLng(incident.latitude, incident.longitude)) + "</p>" +
            "<p><b>Reported:</b> " + escapeHTML(formatTime(incident.timestamp)) + "</p>" +
            "<p><b>Status:</b> " + escapeHTML(incident.status) + "</p>" +
            "</div>"
        );
    }).join("");
}

function loadIncidents() {
    incidentMarkers.forEach(function (marker) {
        if (map) map.removeLayer(marker);
    });
    incidentMarkers = [];

    const incidents = getSavedIncidents();
    incidents.forEach(displayIncidentOnMap);
    renderIncidentList();
    updateRouteRiskAnalysis();
    return incidents;
}

async function submitIncident() {
    const typeEl = byId("incident-type");
    const severityEl = byId("incident-severity");
    const peopleEl = byId("incident-people");
    const descriptionEl = byId("incident-description");
    const vulnerabilityEl = byId("incident-vulnerability");
    const datetimeEl = byId("incident-datetime");
    const incidentStatusEl = byId("incident-status");
    const statusEl = byId("incident-form-status");

    const type = typeEl ? typeEl.value.trim() : "";
    const severity = severityEl ? severityEl.value : "";
    const peopleAffected = peopleEl ? parseInt(peopleEl.value, 10) : NaN;
    const description = descriptionEl ? descriptionEl.value.trim() : "";
    const vulnerabilities = vulnerabilityEl ? vulnerabilityEl.value.trim() : "";
    const reportedAtRaw = datetimeEl ? datetimeEl.value : "";
    const incidentStatus = incidentStatusEl && incidentStatusEl.value ? incidentStatusEl.value : "OPEN";

    if (statusEl) statusEl.textContent = "";

    if (!type) {
        if (statusEl) statusEl.textContent = "Please select an incident type.";
        return;
    }
    if (!severity) {
        if (statusEl) statusEl.textContent = "Please select a severity level.";
        return;
    }
    if (isNaN(peopleAffected) || peopleAffected < 0) {
        if (statusEl) statusEl.textContent = "Please enter a valid number of people affected.";
        return;
    }
    if (!incidentLocation) {
        setText("incident-location-error", "Please set a location before submitting.");
        return;
    }

    let reportedAt = nowISO();
    if (reportedAtRaw) {
        const parsed = new Date(reportedAtRaw);
        if (isNaN(parsed.getTime())) {
            if (statusEl) statusEl.textContent = "Please enter a valid date and time.";
            return;
        }
        if (parsed.getTime() > Date.now() + 60000) {
            if (statusEl) statusEl.textContent = "Incident date/time cannot be in the future.";
            return;
        }
        reportedAt = parsed.toISOString();
    }
    if (description.length > 500) {
        if (statusEl) statusEl.textContent = "Description must be under 500 characters.";
        return;
    }

    const incident = {
        id: generateId("INC"),
        type: type,
        severity: severity,
        peopleAffected: peopleAffected,
        description: description,
        vulnerabilities: vulnerabilities,
        latitude: incidentLocation.lat,
        longitude: incidentLocation.lng,
        timestamp: reportedAt,
        status: incidentStatus,
        supabaseId: null,
        synced: false
    };

    saveIncident(incident);
    displayIncidentOnMap(incident);
    renderIncidentList();
    loadRescueDashboard();

    if (statusEl) {
        statusEl.textContent = "✅ Incident " + incident.id + " reported.";
    }

    const formEl = byId("incident-form");
    if (formEl) formEl.reset();
    incidentLocation = null;
    setText("incident-location-display", "Not set");
    setText("incident-location-error", "");

    syncIncidentToSupabase(incident);
}

function clearIncidentForm() {
    const formEl = byId("incident-form");
    if (formEl) formEl.reset();
    incidentLocation = null;
    setText("incident-location-display", "Not set");
    setText("incident-location-error", "");
    setText("incident-form-status", "Form cleared.");
}

function viewIncidents() {
    const nav = document.querySelector('.nav-item[data-target="view-incidents"]');
    if (nav) nav.click();
    const listEl = byId("incident-list");
    if (listEl && listEl.scrollIntoView) {
        listEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }
}

async function updateIncidentStatus(id, newStatus) {
    const incidents = getSavedIncidents();
    const incident = incidents.find(function (i) { return i.id === id; });
    if (!incident) return;

    incident.status = newStatus;
    saveToStorage(STORAGE_KEYS.INCIDENTS, incidents);

    loadIncidents();
    loadRescueDashboard();

    if (incident.supabaseId && supabaseConfigured) {
        await safeSupabaseCall(function () {
            return supabaseClient.from("incidents").update({ status: newStatus }).eq("id", incident.supabaseId);
        }, "Incident status update");
    }
}

function focusIncidentOnMap(id) {
    const marker = incidentMarkerById[id];
    if (!marker || !map) return;
    map.setView(marker.getLatLng(), 14);
    marker.openPopup();
}

async function syncIncidentToSupabase(incident) {
    if (!supabaseConfigured) return;

    const result = await safeSupabaseCall(function () {
        return supabaseClient.from("incidents").insert({
            client_id: incident.id,
            type: incident.type,
            severity: incident.severity,
            people_affected: incident.peopleAffected,
            description: incident.description,
            vulnerabilities: incident.vulnerabilities,
            latitude: incident.latitude,
            longitude: incident.longitude,
            status: incident.status
        }).select().single();
    }, "Incident insert");

    if (result.ok && result.data) {
        const incidents = getSavedIncidents();
        const match = incidents.find(function (i) { return i.id === incident.id; });
        if (match) {
            match.supabaseId = result.data.id;
            match.synced = true;
            saveToStorage(STORAGE_KEYS.INCIDENTS, incidents);
        }
    }
}

async function fetchIncidentsFromSupabase() {
    return safeSupabaseCall(function () {
        return supabaseClient.from("incidents").select("*").order("created_at", { ascending: true });
    }, "Incident fetch");
}

function mergeIncidentsFromSupabase(rows) {
    const local = getSavedIncidents();
    const localById = {};
    local.forEach(function (record) { localById[record.id] = record; });

    let changed = false;

    rows.forEach(function (row) {
        const existing = row.client_id ? localById[row.client_id] : null;
        if (existing) {
            if (!existing.supabaseId) {
                existing.supabaseId = row.id;
                existing.synced = true;
                changed = true;
            }
            return;
        }

        const mappedId = row.client_id || generateId("INC-REMOTE");
        if (localById[mappedId]) return;

        const mapped = {
            id: mappedId,
            type: row.type,
            severity: row.severity,
            peopleAffected: row.people_affected,
            description: row.description || "",
            vulnerabilities: row.vulnerabilities || "",
            latitude: row.latitude,
            longitude: row.longitude,
            timestamp: row.created_at,
            status: row.status,
            supabaseId: row.id,
            synced: true
        };
        local.push(mapped);
        localById[mappedId] = mapped;
        changed = true;
    });

    if (changed) {
        saveToStorage(STORAGE_KEYS.INCIDENTS, local);
    }
    return changed;
}

/* ==========================================================================
   10. SOS
   ========================================================================== */

let sosLocation = null;

function getSavedSOS() {
    return loadFromStorage(STORAGE_KEYS.SOS);
}

function saveSOS(record) {
    const records = getSavedSOS();
    records.push(record);
    saveToStorage(STORAGE_KEYS.SOS, records);
}

function setSOSLocation(lat, lng) {
    sosLocation = { lat: parseFloat(lat), lng: parseFloat(lng) };
    setText("sos-location-display", formatLatLng(sosLocation.lat, sosLocation.lng));
    setText("sos-location-error", "");
}

function useSelectedSOSLocation() {
    if (!selectedStart) {
        setText("sos-location-error", "No map location selected. Click the map first.");
        return;
    }
    setSOSLocation(selectedStart.lat, selectedStart.lng);
}

function getSOSLocation() {
    if (!navigator.geolocation) {
        setText("sos-location-error", "Geolocation is not supported by this browser.");
        return;
    }
    navigator.geolocation.getCurrentPosition(
        function (position) {
            setSOSLocation(position.coords.latitude, position.coords.longitude);
        },
        function () {
            setText("sos-location-error", "Unable to get your location. Use the selected map location instead.");
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

function getSelectedSOSVulnerabilities() {
    const checkboxes = document.querySelectorAll('input[name="sos-vulnerability"]:checked');
    return Array.prototype.slice.call(checkboxes).map(function (cb) { return cb.value; });
}

// --- Transparent, rule-based SOS priority scoring (0-100) --------------------
// This is an explainable rule engine used for decision support in the
// prototype. It is NOT a trained machine-learning model.

const SOS_VULNERABILITY_WEIGHT = {
    "Children": 8,
    "Elderly": 8,
    "Pregnant": 9,
    "Disabled": 9
};

const SOS_VULNERABILITY_LABEL = {
    "Children": "child present",
    "Elderly": "elderly person",
    "Pregnant": "pregnant person",
    "Disabled": "person with disability"
};

// Nearby disaster risk taken from the existing risk system (risk points shown
// on the map plus unresolved incidents), within this radius of the SOS.
const SOS_RISK_RADIUS_KM = 3;

function getNearbySOSRisk(lat, lng) {
    if (lat == null || lng == null || typeof haversineKm !== "function") {
        return { level: "NONE", points: 0, labels: [] };
    }

    let best = 0;
    const labels = [];

    function consider(pLat, pLng, level, label) {
        if (pLat == null || pLng == null) return;
        if (haversineKm({ lat: lat, lng: lng }, { lat: pLat, lng: pLng }) > SOS_RISK_RADIUS_KM) return;
        const weight = level === "CRITICAL" ? 4 : level === "HIGH" ? 3 : level === "MEDIUM" ? 2 : 1;
        if (weight > best) best = weight;
        if (labels.indexOf(label) === -1) labels.push(label);
    }

    (demoRiskPoints || []).forEach(function (risk) {
        consider(risk.lat, risk.lng, normalizeSeverity(risk.level), risk.label || "risk point");
    });

    getSavedIncidents().forEach(function (incident) {
        if (incident.status === "RESOLVED") return;
        consider(incident.latitude, incident.longitude,
            normalizeSeverity(incident.severity), incident.type || "incident");
    });

    const levels = { 0: "NONE", 1: "LOW", 2: "MEDIUM", 3: "HIGH", 4: "CRITICAL" };
    return { level: levels[best], points: best * 3, labels: labels.slice(0, 3) };
}

function calculateSOSPriority(emergencyType, peopleAffected, vulnerabilities, description, location) {
    const reasons = [];
    const breakdown = [];
    let score = 0;

    // 1. Emergency / disaster type (severity of the request itself)
    const typeScore = SOS_EMERGENCY_BASE_SCORE[emergencyType] || 10;
    score += typeScore;
    breakdown.push("Emergency type (" + (emergencyType || "Other") + "): +" + typeScore);
    if (typeScore >= 35) reasons.push("severe emergency type (" + emergencyType + ")");
    if (emergencyType === "Medical Emergency") reasons.push("medical emergency");

    // 2. Number of people affected
    const people = parseInt(peopleAffected, 10) || 0;
    let peopleScore = 0;
    if (people >= 20) peopleScore = 20;
    else if (people >= 10) peopleScore = 15;
    else if (people >= 5) peopleScore = 10;
    else if (people >= 2) peopleScore = 5;
    score += peopleScore;
    breakdown.push("People affected (" + people + "): +" + peopleScore);
    if (people >= 10) reasons.push(people + " people affected");

    // 3. Vulnerable people (elderly, disability, pregnant, child)
    const vulns = vulnerabilities || [];
    let vulnScore = 0;
    vulns.forEach(function (v) { vulnScore += SOS_VULNERABILITY_WEIGHT[v] || 5; });
    vulnScore = Math.min(vulnScore, 25);
    score += vulnScore;
    breakdown.push("Vulnerable people (" + (vulns.length || 0) + "): +" + vulnScore);
    if (vulns.length) {
        reasons.push(vulns.map(function (v) {
            return SOS_VULNERABILITY_LABEL[v] || v.toLowerCase();
        }).join(", "));
    }

    // 4. Urgency signals in the free-text description
    const lowerDescription = (description || "").toLowerCase();
    const matchedKeywords = URGENT_KEYWORDS.filter(function (keyword) {
        return lowerDescription.indexOf(keyword) !== -1;
    });
    const keywordScore = Math.min(matchedKeywords.length * 6, 12);
    score += keywordScore;
    breakdown.push("Urgency keywords (" + matchedKeywords.length + "): +" + keywordScore);
    if (matchedKeywords.length) reasons.push('report mentions "' + matchedKeywords[0] + '"');

    // 5. Nearby disaster risk from the existing risk / incident data
    const nearbyRisk = location ? getNearbySOSRisk(location.lat, location.lng)
        : { level: "NONE", points: 0, labels: [] };
    score += nearbyRisk.points;
    breakdown.push("Nearby disaster risk (" + nearbyRisk.level + "): +" + nearbyRisk.points);
    if (nearbyRisk.points > 0) {
        reasons.push("nearby " + nearbyRisk.level.toLowerCase() + " risk area" +
            (nearbyRisk.labels.length ? " (" + nearbyRisk.labels.join(", ") + ")" : ""));
    }

    score = clamp(Math.round(score), 0, 100);

    let priorityLevel;
    if (score >= 75) priorityLevel = "CRITICAL";
    else if (score >= 55) priorityLevel = "HIGH";
    else if (score >= 35) priorityLevel = "MEDIUM";
    else priorityLevel = "LOW";

    const priorityReason = reasons.length
        ? priorityLevel + ": " + reasons.slice(0, 3).join(" + ") + "."
        : priorityLevel + ": no escalating factors detected.";

    return {
        priorityScore: score,
        priorityLevel: priorityLevel,
        priorityReason: priorityReason,
        priorityFactors: breakdown,
        nearbyRiskLevel: nearbyRisk.level
    };
}

// Existing records saved before this upgrade have no stored explanation, so
// recompute one from the data already on the record.
function getSOSPriorityReason(record) {
    if (record.priorityReason) return record.priorityReason;
    const location = (record.latitude != null && record.longitude != null)
        ? { lat: record.latitude, lng: record.longitude } : null;
    return calculateSOSPriority(record.emergencyType, record.peopleAffected,
        record.vulnerabilities, record.description, location).priorityReason;
}

// Small explanation block shown only for CRITICAL / HIGH requests.
function sosPriorityExplanationHTML(record) {
    const level = record.priorityLevel;
    if (level !== "CRITICAL" && level !== "HIGH") return "";
    return '<p class="sos-priority-why">🧠 ' + escapeHTML(getSOSPriorityReason(record)) + "</p>";
}


function getSOSPriorityRank(level) {
    const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    return order[level] !== undefined ? order[level] : 4;
}

function getSOSPriorityColor(level) {
    if (level === "CRITICAL") return "#dc2626";
    if (level === "HIGH") return "#f97316";
    if (level === "MEDIUM") return "#eab308";
    return "#16a34a";
}

function displaySOSOnMap(record) {
    if (!map || record.latitude == null || record.longitude == null) {
        return;
    }

    const color = getSOSPriorityColor(record.priorityLevel);
    const icon = L.divIcon({
        className: "",
        html: '<span class="sos-marker-dot" style="background:' + color + '">SOS</span>',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        popupAnchor: [0, -14]
    });

    const popupHtml =
        "<div><b>🆘 " + escapeHTML(record.emergencyType) + "</b><br>" +
        "Priority: " + escapeHTML(record.priorityLevel) + " (score " + escapeHTML(record.priorityScore) + ")<br>" +
        "People affected: " + escapeHTML(record.peopleAffected) + "<br>" +
        "Status: " + escapeHTML(record.status) +
        "</div>";

    const marker = L.marker([record.latitude, record.longitude], { icon: icon })
        .addTo(map)
        .bindPopup(popupHtml);

    sosMarkers.push(marker);
    if (record.id) {
        sosMarkerById[record.id] = marker;
    }
}

function renderSOSList() {
    const listEl = byId("sos-list");
    if (!listEl) return;

    const active = getSavedSOS().filter(function (s) { return s.status !== "RESOLVED"; });
    if (!active.length) {
        listEl.innerHTML = '<p class="incident-empty">No active SOS requests.</p>';
        return;
    }

    const sorted = active.slice().sort(function (a, b) {
        const rankDiff = getSOSPriorityRank(a.priorityLevel) - getSOSPriorityRank(b.priorityLevel);
        if (rankDiff !== 0) return rankDiff;
        return new Date(b.timestamp) - new Date(a.timestamp);
    });

    listEl.innerHTML = sorted.map(function (record) {
        return (
            '<div class="incident-card severity-' + record.priorityLevel.toLowerCase() + '">' +
            "<strong>" + escapeHTML(record.id) + "</strong>" +
            "<p><b>Type:</b> " + escapeHTML(record.emergencyType) + "</p>" +
            "<p><b>Priority:</b> " + escapeHTML(record.priorityLevel) + " (score " + escapeHTML(record.priorityScore) + "/100)</p>" +
            sosPriorityExplanationHTML(record) +
            "<p><b>People affected:</b> " + escapeHTML(record.peopleAffected) + "</p>" +
            "<p><b>Status:</b> " + escapeHTML(record.status) + "</p>" +
            "</div>"
        );
    }).join("");
}

function loadSOS() {
    sosMarkers.forEach(function (marker) {
        if (map) map.removeLayer(marker);
    });
    sosMarkers = [];

    const records = getSavedSOS();
    records.forEach(displaySOSOnMap);
    renderSOSList();
    updateRouteRiskAnalysis();
    return records;
}

async function submitSOS() {
    const typeEl = byId("sos-type");
    const peopleEl = byId("sos-people");
    const descriptionEl = byId("sos-description");
    const statusEl = byId("sos-form-status");

    const emergencyType = typeEl ? typeEl.value : "";
    const peopleAffected = peopleEl ? parseInt(peopleEl.value, 10) : NaN;
    const description = descriptionEl ? descriptionEl.value.trim() : "";
    const vulnerabilities = getSelectedSOSVulnerabilities();

    if (statusEl) statusEl.textContent = "";

    if (!emergencyType) {
        if (statusEl) statusEl.textContent = "Please select an emergency type.";
        return;
    }
    if (isNaN(peopleAffected) || peopleAffected < 1) {
        if (statusEl) statusEl.textContent = "Please enter a valid number of people affected.";
        return;
    }
    if (!sosLocation) {
        setText("sos-location-error", "Please set a location before sending.");
        return;
    }

    const priority = calculateSOSPriority(emergencyType, peopleAffected, vulnerabilities, description, sosLocation);

    const record = {
        id: generateId("SOS"),
        emergencyType: emergencyType,
        peopleAffected: peopleAffected,
        vulnerabilities: vulnerabilities,
        description: description,
        latitude: sosLocation.lat,
        longitude: sosLocation.lng,
        priorityScore: priority.priorityScore,
        priorityLevel: priority.priorityLevel,
        priorityReason: priority.priorityReason,
        priorityFactors: priority.priorityFactors,
        nearbyRiskLevel: priority.nearbyRiskLevel,
        status: "OPEN",
        timestamp: nowISO(),
        supabaseId: null,
        synced: false
    };

    saveSOS(record);
    displaySOSOnMap(record);
    renderSOSList();
    loadRescueDashboard();

    if (statusEl) {
        statusEl.textContent =
            "✅ SOS " + record.id + " sent. " + record.priorityReason +
            " (rule-based score " + record.priorityScore + "/100). This is decision support only — " +
            "also contact local emergency services if you can.";
    }

    const formEl = byId("sos-form");
    if (formEl) formEl.reset();
    sosLocation = null;
    setText("sos-location-display", "Not set");

    syncSOSToSupabase(record);
}

async function updateSOSStatus(id, newStatus) {
    const records = getSavedSOS();
    const record = records.find(function (s) { return s.id === id; });
    if (!record) return;

    record.status = newStatus;
    saveToStorage(STORAGE_KEYS.SOS, records);

    loadSOS();
    loadRescueDashboard();

    if (record.supabaseId && supabaseConfigured) {
        await safeSupabaseCall(function () {
            return supabaseClient.from("sos").update({ status: newStatus }).eq("id", record.supabaseId);
        }, "SOS status update");
    }
}

function focusSOSOnMap(id) {
    const marker = sosMarkerById[id];
    if (!marker || !map) return;
    map.setView(marker.getLatLng(), 14);
    marker.openPopup();
}

async function syncSOSToSupabase(record) {
    if (!supabaseConfigured) return;

    const result = await safeSupabaseCall(function () {
        return supabaseClient.from("sos").insert({
            client_id: record.id,
            emergency_type: record.emergencyType,
            people_affected: record.peopleAffected,
            vulnerabilities: record.vulnerabilities,
            description: record.description,
            latitude: record.latitude,
            longitude: record.longitude,
            priority_score: record.priorityScore,
            priority_level: record.priorityLevel,
            status: record.status
        }).select().single();
    }, "SOS insert");

    if (result.ok && result.data) {
        const records = getSavedSOS();
        const match = records.find(function (s) { return s.id === record.id; });
        if (match) {
            match.supabaseId = result.data.id;
            match.synced = true;
            saveToStorage(STORAGE_KEYS.SOS, records);
        }
    }
}

async function fetchSOSFromSupabase() {
    return safeSupabaseCall(function () {
        return supabaseClient.from("sos").select("*").order("created_at", { ascending: true });
    }, "SOS fetch");
}

function mergeSOSFromSupabase(rows) {
    const local = getSavedSOS();
    const localById = {};
    local.forEach(function (record) { localById[record.id] = record; });

    let changed = false;

    rows.forEach(function (row) {
        const existing = row.client_id ? localById[row.client_id] : null;
        if (existing) {
            if (!existing.supabaseId) {
                existing.supabaseId = row.id;
                existing.synced = true;
                changed = true;
            }
            return;
        }

        const mappedId = row.client_id || generateId("SOS-REMOTE");
        if (localById[mappedId]) return;

        const mapped = {
            id: mappedId,
            emergencyType: row.emergency_type,
            peopleAffected: row.people_affected,
            vulnerabilities: Array.isArray(row.vulnerabilities) ? row.vulnerabilities : [],
            description: row.description || "",
            latitude: row.latitude,
            longitude: row.longitude,
            priorityScore: row.priority_score,
            priorityLevel: row.priority_level,
            status: row.status,
            timestamp: row.created_at,
            supabaseId: row.id,
            synced: true
        };
        local.push(mapped);
        localById[mappedId] = mapped;
        changed = true;
    });

    if (changed) {
        saveToStorage(STORAGE_KEYS.SOS, local);
    }
    return changed;
}

/* ==========================================================================
   11. RESOURCES
   ========================================================================== */

let resourceLocation = null;

function getSavedResources() {
    return loadFromStorage(STORAGE_KEYS.RESOURCES);
}

function calculateResourceStatus(quantity, capacity) {
    const qty = Number(quantity) || 0;
    const cap = Number(capacity) || 0;
    const percent = cap > 0 ? (qty / cap) * 100 : 0;

    if (percent >= 50) return { status: "AVAILABLE", label: "🟢 AVAILABLE", cssClass: "severity-low", percent: percent };
    if (percent >= 20) return { status: "LOW", label: "🟠 LOW", cssClass: "severity-high", percent: percent };
    return { status: "CRITICAL", label: "🔴 CRITICAL", cssClass: "severity-critical", percent: percent };
}

function setResourceLocation(lat, lng) {
    resourceLocation = { lat: parseFloat(lat), lng: parseFloat(lng) };
    setText("resource-location-display", formatLatLng(resourceLocation.lat, resourceLocation.lng));
    setText("resource-location-error", "");
}

function useSelectedResourceLocation() {
    if (!selectedStart) {
        setText("resource-location-error", "No map location selected. Click the map first.");
        return;
    }
    setResourceLocation(selectedStart.lat, selectedStart.lng);
}

function getResourceLocation() {
    if (!navigator.geolocation) {
        setText("resource-location-error", "Geolocation is not supported by this browser.");
        return;
    }
    navigator.geolocation.getCurrentPosition(
        function (position) {
            setResourceLocation(position.coords.latitude, position.coords.longitude);
        },
        function () {
            setText("resource-location-error", "Unable to get your location. Use the selected map location instead.");
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

async function saveResource() {
    const nameEl = byId("resource-name");
    const quantityEl = byId("resource-quantity");
    const capacityEl = byId("resource-capacity");
    const unitEl = byId("resource-unit");
    const locationEl = byId("resource-location");
    const statusEl = byId("resource-form-status");

    if (statusEl) statusEl.textContent = "";

    const resourceName = nameEl ? nameEl.value.trim() : "";
    const quantity = quantityEl ? parseInt(quantityEl.value, 10) : NaN;
    const capacity = capacityEl ? parseInt(capacityEl.value, 10) : NaN;
    const unit = unitEl ? unitEl.value.trim() : "";
    const location = locationEl ? locationEl.value.trim() : "";

    if (!resourceName) { if (statusEl) statusEl.textContent = "Please select a resource."; return; }
    if (isNaN(quantity) || quantity < 0) { if (statusEl) statusEl.textContent = "Please enter a valid quantity."; return; }
    if (isNaN(capacity) || capacity < 1) { if (statusEl) statusEl.textContent = "Please enter a valid capacity."; return; }
    if (!location) { if (statusEl) statusEl.textContent = "Please enter a relief centre name."; return; }
    if (!resourceLocation) { setText("resource-location-error", "Please set coordinates before saving."); return; }

    const resource = {
        id: generateId("RES"),
        resource: resourceName,
        quantity: quantity,
        capacity: capacity,
        unit: unit || "units",
        location: location,
        latitude: resourceLocation.lat,
        longitude: resourceLocation.lng,
        timestamp: nowISO(),
        supabaseId: null,
        synced: false
    };

    const resources = getSavedResources();
    resources.push(resource);
    saveToStorage(STORAGE_KEYS.RESOURCES, resources);

    if (statusEl) statusEl.textContent = "✅ " + resourceName + " saved for " + location + ".";

    const formEl = byId("resource-form");
    if (formEl) formEl.reset();
    resourceLocation = null;
    setText("resource-location-display", "Not set");

    loadResources();
    syncResourceToSupabase(resource);
}

async function deleteResource(id) {
    const resources = getSavedResources();
    const target = resources.find(function (r) { return r.id === id; });
    const remaining = resources.filter(function (r) { return r.id !== id; });
    saveToStorage(STORAGE_KEYS.RESOURCES, remaining);
    loadResources();

    if (target && target.supabaseId && supabaseConfigured) {
        await safeSupabaseCall(function () {
            return supabaseClient.from("resources").delete().eq("id", target.supabaseId);
        }, "Resource delete");
    }
}

function renderResourceList() {
    const listEl = byId("resource-list");
    if (!listEl) return;

    const resources = getSavedResources();
    if (!resources.length) {
        listEl.innerHTML = '<p class="incident-empty">No relief resources saved yet.</p>';
        return;
    }

    listEl.innerHTML = resources.slice().reverse().map(function (r) {
        const info = calculateResourceStatus(r.quantity, r.capacity);
        return (
            '<div class="incident-card ' + info.cssClass + '">' +
            "<strong>" + escapeHTML(r.location) + "</strong>" +
            "<p><b>Resource:</b> " + escapeHTML(r.resource) + "</p>" +
            "<p><b>Quantity/Capacity:</b> " + escapeHTML(r.quantity) + " / " + escapeHTML(r.capacity) + " " + escapeHTML(r.unit) + "</p>" +
            "<p><b>Status:</b> " + info.label + "</p>" +
            "<p><b>Last updated:</b> " + escapeHTML(formatTime(r.timestamp)) + "</p>" +
            '<div class="queue-actions"><button onclick="deleteResource(\'' + r.id + '\')">🗑️ Remove</button></div>' +
            "</div>"
        );
    }).join("");
}

function displayResourcesOnMap(resources) {
    resourceMarkers.forEach(function (marker) {
        if (map) map.removeLayer(marker);
    });
    resourceMarkers = [];

    if (!map) return;

    const groups = {};
    resources.forEach(function (r) {
        if (r.latitude == null || r.longitude == null) return;
        const key = Number(r.latitude).toFixed(4) + "," + Number(r.longitude).toFixed(4);
        if (!groups[key]) {
            groups[key] = { lat: r.latitude, lng: r.longitude, location: r.location, totals: {}, latest: r.timestamp };
        }
        groups[key].totals[r.resource] = (groups[key].totals[r.resource] || 0) + (Number(r.quantity) || 0);
        if (new Date(r.timestamp) > new Date(groups[key].latest)) {
            groups[key].latest = r.timestamp;
            groups[key].location = r.location;
        }
    });

    Object.keys(groups).forEach(function (key) {
        const group = groups[key];
        const icon = L.divIcon({
            className: "",
            html: '<span class="resource-marker-dot">📦</span>',
            iconSize: [26, 26],
            iconAnchor: [13, 13]
        });

        const popupHtml =
            "<div><b>📦 " + escapeHTML(group.location) + "</b><br>" +
            "🍚 Food: " + escapeHTML(group.totals["Food"] || 0) + "<br>" +
            "💧 Water: " + escapeHTML(group.totals["Water"] || 0) + "<br>" +
            "💊 Medicine: " + escapeHTML(group.totals["Medicine"] || 0) + "<br>" +
            "🧣 Blankets: " + escapeHTML(group.totals["Blankets"] || 0) + "<br>" +
            "Last updated: " + escapeHTML(formatTime(group.latest)) +
            "</div>";

        const marker = L.marker([group.lat, group.lng], { icon: icon }).addTo(map).bindPopup(popupHtml);
        resourceMarkers.push(marker);
    });
}

function loadResources() {
    const resources = getSavedResources();
    renderResourceList();
    displayResourcesOnMap(resources);
    loadRescueDashboard();
    return resources;
}

async function syncResourceToSupabase(resource) {
    if (!supabaseConfigured) return;

    const result = await safeSupabaseCall(function () {
        return supabaseClient.from("resources").insert({
            client_id: resource.id,
            resource_name: resource.resource,
            quantity: resource.quantity,
            capacity: resource.capacity,
            unit: resource.unit,
            location_name: resource.location,
            latitude: resource.latitude,
            longitude: resource.longitude
        }).select().single();
    }, "Resource insert");

    if (result.ok && result.data) {
        const resources = getSavedResources();
        const match = resources.find(function (r) { return r.id === resource.id; });
        if (match) {
            match.supabaseId = result.data.id;
            match.synced = true;
            saveToStorage(STORAGE_KEYS.RESOURCES, resources);
        }
    }
}

async function fetchResourcesFromSupabase() {
    return safeSupabaseCall(function () {
        return supabaseClient.from("resources").select("*").order("updated_at", { ascending: true });
    }, "Resource fetch");
}

function mergeResourcesFromSupabase(rows) {
    const local = getSavedResources();
    const localById = {};
    local.forEach(function (record) { localById[record.id] = record; });

    let changed = false;

    rows.forEach(function (row) {
        const existing = row.client_id ? localById[row.client_id] : null;
        if (existing) {
            if (!existing.supabaseId) {
                existing.supabaseId = row.id;
                existing.synced = true;
                changed = true;
            }
            return;
        }

        const mappedId = row.client_id || generateId("RES-REMOTE");
        if (localById[mappedId]) return;

        const mapped = {
            id: mappedId,
            resource: row.resource_name,
            quantity: row.quantity,
            capacity: row.capacity,
            unit: row.unit,
            location: row.location_name,
            latitude: row.latitude,
            longitude: row.longitude,
            timestamp: row.updated_at || row.created_at,
            supabaseId: row.id,
            synced: true
        };
        local.push(mapped);
        localById[mappedId] = mapped;
        changed = true;
    });

    if (changed) {
        saveToStorage(STORAGE_KEYS.RESOURCES, local);
    }
    return changed;
}

/* ==========================================================================
   12. RESCUE DASHBOARD
   ========================================================================== */

function calculateDashboardKPIs() {
    const sosRecords = getSavedSOS();
    const incidents = getSavedIncidents();
    const resources = getSavedResources();

    const criticalSOS = sosRecords.filter(function (s) { return s.priorityLevel === "CRITICAL" && s.status !== "RESOLVED"; }).length;
    const highSOS = sosRecords.filter(function (s) { return s.priorityLevel === "HIGH" && s.status !== "RESOLVED"; }).length;
    const openIncidents = incidents.filter(function (i) { return i.status === "OPEN"; }).length;

    function shortageCount(name) {
        return resources.filter(function (r) {
            if (r.resource !== name) return false;
            return calculateResourceStatus(r.quantity, r.capacity).status !== "AVAILABLE";
        }).length;
    }

    const kpis = {
        criticalSOS: criticalSOS,
        highSOS: highSOS,
        openIncidents: openIncidents,
        waterShortage: shortageCount("Water"),
        foodShortage: shortageCount("Food"),
        medicineShortage: shortageCount("Medicine")
    };

    setText("kpi-critical-sos", kpis.criticalSOS);
    setText("kpi-high-sos", kpis.highSOS);
    setText("kpi-open-incidents", kpis.openIncidents);
    setText("kpi-open-incidents-report", kpis.openIncidents);
    setText("kpi-water-shortage", kpis.waterShortage);
    setText("kpi-food-shortage", kpis.foodShortage);
    setText("kpi-medicine-shortage", kpis.medicineShortage);

    return kpis;
}

function renderSOSQueue() {
    const queueEl = byId("sos-queue");
    if (!queueEl) return;

    const active = getSavedSOS().filter(function (s) { return s.status !== "RESOLVED"; });
    if (!active.length) {
        queueEl.innerHTML = '<p class="incident-empty">No active SOS requests.</p>';
        return;
    }

    const sorted = active.slice().sort(function (a, b) {
        const rankDiff = getSOSPriorityRank(a.priorityLevel) - getSOSPriorityRank(b.priorityLevel);
        if (rankDiff !== 0) return rankDiff;
        return new Date(b.timestamp) - new Date(a.timestamp);
    });

    queueEl.innerHTML = sorted.map(function (s) {
        const status = s.status || "OPEN";
        function opt(v) { return '<option value="' + v + '"' + (status === v ? " selected" : "") + ">" + v + "</option>"; }
        return (
            '<div class="incident-card severity-' + s.priorityLevel.toLowerCase() + '">' +
            "<strong>" + escapeHTML(s.id) + "</strong>" +
            "<p><b>Type:</b> " + escapeHTML(s.emergencyType) + "</p>" +
            "<p><b>Priority:</b> " + escapeHTML(s.priorityLevel) + " (score " + escapeHTML(s.priorityScore) + "/100)</p>" +
            sosPriorityExplanationHTML(s) +
            "<p><b>People affected:</b> " + escapeHTML(s.peopleAffected) + "</p>" +
            "<p><b>Location:</b> " + escapeHTML(formatLatLng(s.latitude, s.longitude)) + "</p>" +
            "<p><b>Reported:</b> " + escapeHTML(formatTime(s.timestamp)) + "</p>" +
            '<div class="queue-actions">' +
            '<select onchange="updateSOSStatus(\'' + s.id + '\', this.value)">' + opt("OPEN") + opt("IN PROGRESS") + opt("RESOLVED") + "</select>" +
            '<button onclick="focusSOSOnMap(\'' + s.id + '\')">📍 View on Map</button>' +
            "</div></div>"
        );
    }).join("");
}

function renderIncidentQueue() {
    const queueEl = byId("incident-queue");
    if (!queueEl) return;

    const active = getSavedIncidents().filter(function (i) { return i.status !== "RESOLVED"; });
    if (!active.length) {
        queueEl.innerHTML = '<p class="incident-empty">No incidents reported.</p>';
        return;
    }

    const sorted = active.slice().sort(function (a, b) {
        const rankDiff = getIncidentSeverityRank(a.severity) - getIncidentSeverityRank(b.severity);
        if (rankDiff !== 0) return rankDiff;
        return new Date(b.timestamp) - new Date(a.timestamp);
    });

    queueEl.innerHTML = sorted.map(function (i) {
        const status = i.status || "OPEN";
        function opt(v) { return '<option value="' + v + '"' + (status === v ? " selected" : "") + ">" + v + "</option>"; }
        return (
            '<div class="incident-card ' + incidentSeverityClass(i.severity) + '">' +
            "<strong>" + escapeHTML(i.id) + "</strong>" +
            "<p><b>Type:</b> " + escapeHTML(i.type) + "</p>" +
            "<p><b>Severity:</b> " + escapeHTML(i.severity) + "</p>" +
            "<p><b>People affected:</b> " + escapeHTML(i.peopleAffected) + "</p>" +
            "<p><b>Location:</b> " + escapeHTML(formatLatLng(i.latitude, i.longitude)) + "</p>" +
            "<p><b>Reported:</b> " + escapeHTML(formatTime(i.timestamp)) + "</p>" +
            '<div class="queue-actions">' +
            '<select onchange="updateIncidentStatus(\'' + i.id + '\', this.value)">' + opt("OPEN") + opt("IN PROGRESS") + opt("RESOLVED") + "</select>" +
            '<button onclick="focusIncidentOnMap(\'' + i.id + '\')">📍 View on Map</button>' +
            "</div></div>"
        );
    }).join("");
}

function renderShortageAlerts() {
    const el = byId("resource-shortage-alerts");
    if (!el) return;

    const alerts = getSavedResources().map(function (r) {
        return { resource: r, info: calculateResourceStatus(r.quantity, r.capacity) };
    }).filter(function (a) { return a.info.status !== "AVAILABLE"; });

    if (!alerts.length) {
        el.innerHTML = "";
        return;
    }

    el.innerHTML = alerts.map(function (a) {
        const cssClass = a.info.status === "CRITICAL" ? "critical" : "low";
        const icon = a.info.status === "CRITICAL" ? "🔴" : "🟠";
        return (
            '<div class="shortage-alert ' + cssClass + '">' +
            "<strong>" + icon + " " + escapeHTML(a.info.status) + " " + escapeHTML(a.resource.resource.toUpperCase()) + " STOCK</strong>" +
            "<p>" + escapeHTML(a.resource.location) + "</p>" +
            "<p>" + escapeHTML(a.resource.quantity) + " / " + escapeHTML(a.resource.capacity) + " " + escapeHTML(a.resource.unit) + " remaining</p>" +
            "</div>"
        );
    }).join("");
}

function renderResourceRecommendations() {
    const el = byId("resource-recommendations");
    if (!el) return;

    const kpis = calculateDashboardKPIs();
    const resources = getSavedResources();

    function worstStatus(name) {
        let worst = null;
        resources.forEach(function (r) {
            if (r.resource !== name) return;
            const status = calculateResourceStatus(r.quantity, r.capacity).status;
            if (status === "CRITICAL") worst = "CRITICAL";
            else if (status === "LOW" && worst !== "CRITICAL") worst = "LOW";
        });
        return worst;
    }

    const water = worstStatus("Water");
    const food = worstStatus("Food");
    const medicine = worstStatus("Medicine");
    const lines = [];

    if (kpis.criticalSOS > 0 && (water || food || medicine)) {
        lines.push("🚨 URGENT RESOURCE DELIVERY REQUIRED — active critical SOS with a low/critical resource on record.");
    }
    if (water === "CRITICAL") lines.push("💧 Prioritize drinking water.");
    if (medicine === "CRITICAL") lines.push("💊 Prioritize medicine.");
    if (food === "CRITICAL") lines.push("🍚 Prioritize food.");
    if (!lines.length) lines.push("✅ No urgent resource actions identified from current data.");

    el.innerHTML =
        "<h3>🤖 Resource Recommendations</h3>" +
        '<p class="incident-hint">Rule-based decision support only — not AI, not a dispatch replacement.</p>' +
        '<ul style="margin:0;padding-left:20px;">' +
        lines.map(function (line) { return "<li>" + escapeHTML(line) + "</li>"; }).join("") +
        "</ul>";
}

function loadRescueDashboard() {
    calculateDashboardKPIs();
    renderSOSQueue();
    renderIncidentQueue();
    renderShortageAlerts();
    renderResourceRecommendations();
    rebuildAlertsFromData();
}

/* ==========================================================================
   13. VEHICLES
   ========================================================================== */

function getDemoVehicles() {
    return [
        { id: "VEH-01", type: "Ambulance", location: "Guwahati", destination: "Relief Centre A", status: "AVAILABLE", routeStatus: "Clear", lastUpdated: nowISO() },
        { id: "VEH-02", type: "Relief Truck", location: "Dibrugarh", destination: "Relief Centre B", status: "IN TRANSIT", routeStatus: "Clear", lastUpdated: nowISO() },
        { id: "VEH-03", type: "Boat", location: "Silchar", destination: "Flood Zone C", status: "DELAYED", routeStatus: "Road blocked", lastUpdated: nowISO() }
    ];
}

function renderVehicleMarkers(vehicles) {
    vehicleMarkers.forEach(function (marker) {
        if (map) map.removeLayer(marker);
    });
    vehicleMarkers = [];

    if (!map) return;

    vehicles.forEach(function (vehicle) {
        if (vehicle.latitude == null || vehicle.longitude == null) return;
        const marker = L.marker([vehicle.latitude, vehicle.longitude])
            .addTo(map)
            .bindPopup("<b>🚑 " + escapeHTML(vehicle.type) + "</b><br>Status: " + escapeHTML(vehicle.status));
        vehicleMarkers.push(marker);
    });
}

function renderVehiclesTable(vehicles) {
    const tbody = byId("vehicles-table-body");
    if (!tbody) return;

    if (!vehicles.length) {
        tbody.innerHTML = '<tr><td colspan="7">No vehicles available.</td></tr>';
        return;
    }

    tbody.innerHTML = vehicles.map(function (v) {
        return (
            "<tr>" +
            "<td>" + escapeHTML(v.id) + "</td>" +
            "<td>" + escapeHTML(v.type) + "</td>" +
            "<td>" + escapeHTML(v.location) + "</td>" +
            "<td>" + escapeHTML(v.destination) + "</td>" +
            "<td>" + escapeHTML(v.status) + "</td>" +
            "<td>" + escapeHTML(v.routeStatus) + "</td>" +
            "<td>" + escapeHTML(formatTime(v.lastUpdated)) + "</td>" +
            "</tr>"
        );
    }).join("");
}

async function loadVehicles() {
    let vehicles = null;

    if (supabaseConfigured) {
        const result = await safeSupabaseCall(function () {
            return supabaseClient.from("vehicles").select("*");
        }, "Vehicles fetch");

        if (result.ok && result.data && result.data.length) {
            vehicles = result.data.map(function (row) {
                return {
                    id: row.id,
                    type: row.type,
                    location: row.location,
                    destination: row.destination,
                    status: row.status,
                    routeStatus: row.route_status,
                    lastUpdated: row.updated_at,
                    latitude: row.latitude,
                    longitude: row.longitude
                };
            });
        }
    }

    if (!vehicles) {
        vehicles = getDemoVehicles();
    }

    demoVehicles = vehicles;
    renderVehiclesTable(vehicles);
    renderVehicleMarkers(vehicles);
    return vehicles;
}

/* ==========================================================================
   14. ALERTS
   ========================================================================== */

function rebuildAlertsFromData() {
    const alerts = [];

    getSavedSOS().filter(function (s) { return s.status !== "RESOLVED"; }).forEach(function (s) {
        alerts.push({
            id: "alert-sos-" + s.id,
            type: "SOS",
            severity: s.priorityLevel,
            title: s.emergencyType + " — " + s.peopleAffected + " affected",
            details: "SOS " + s.id + " · " + formatLatLng(s.latitude, s.longitude),
            time: s.timestamp
        });
    });

    getSavedIncidents().filter(function (i) { return i.status !== "RESOLVED"; }).forEach(function (i) {
        alerts.push({
            id: "alert-incident-" + i.id,
            type: "INCIDENT",
            severity: (i.severity || "").toUpperCase(),
            title: i.type,
            details: "Incident " + i.id + " · " + formatLatLng(i.latitude, i.longitude),
            time: i.timestamp
        });
    });

    getSavedResources().forEach(function (r) {
        const info = calculateResourceStatus(r.quantity, r.capacity);
        if (info.status === "AVAILABLE") return;
        alerts.push({
            id: "alert-resource-" + r.id,
            type: "RESOURCE",
            severity: info.status === "CRITICAL" ? "CRITICAL" : "MEDIUM",
            title: info.status + " " + r.resource,
            details: r.location + " · " + r.quantity + "/" + r.capacity + " " + r.unit,
            time: r.timestamp
        });
    });

    alerts.sort(function (a, b) { return new Date(b.time) - new Date(a.time); });
    alertsCache = alerts;

    renderAlerts();
    renderNotificationBell();
}

function renderAlerts() {
    const container = byId("alerts-container");
    if (!container) return;

    const filtered = currentAlertFilter === "all"
        ? alertsCache
        : alertsCache.filter(function (a) { return a.severity === currentAlertFilter; });

    if (!filtered.length) {
        container.innerHTML = '<p class="incident-empty">No alerts to show.</p>';
        return;
    }

    container.innerHTML = filtered.map(function (a) {
        return (
            '<div class="incident-card severity-' + a.severity.toLowerCase() + '">' +
            "<strong>[" + escapeHTML(a.type) + "] " + escapeHTML(a.title) + "</strong>" +
            "<p>" + escapeHTML(a.details) + "</p>" +
            "<p>" + escapeHTML(formatTime(a.time)) + "</p>" +
            "</div>"
        );
    }).join("");

    bindAlertFilters();
}

function bindAlertFilters() {
    if (alertFiltersBound) return;

    const buttons = document.querySelectorAll(".filter-btn");
    if (!buttons.length) return;

    buttons.forEach(function (button) {
        button.addEventListener("click", function () {
            currentAlertFilter = button.getAttribute("data-filter") || "all";
            buttons.forEach(function (b) { b.classList.remove("active"); });
            button.classList.add("active");
            renderAlerts();
        });
    });

    alertFiltersBound = true;
}

/* ==========================================================================
   15. NOTIFICATION BELL
   ========================================================================== */

function renderNotificationBell() {
    const listEl = byId("bell-alerts-list");
    const badgeEl = byId("unread-count-badge");

    unreadNotificationCount = alertsCache.length;

    if (badgeEl) {
        if (unreadNotificationCount > 0) {
            badgeEl.textContent = unreadNotificationCount;
            badgeEl.style.display = "inline-block";
        } else {
            badgeEl.style.display = "none";
        }
    }

    if (listEl) {
        if (!alertsCache.length) {
            listEl.innerHTML = '<p class="incident-empty">No notifications.</p>';
        } else {
            listEl.innerHTML = alertsCache.slice(0, 10).map(function (a) {
                return (
                    "<div>" +
                    "<strong>[" + escapeHTML(a.type) + "] " + escapeHTML(a.title) + "</strong>" +
                    "<p>" + escapeHTML(formatTime(a.time)) + "</p>" +
                    "</div>"
                );
            }).join("");
        }
    }
}

function toggleNotificationDropdown() {
    const dropdown = byId("bell-dropdown");
    if (!dropdown) return;

    notificationDropdownOpen = !notificationDropdownOpen;
    dropdown.style.display = notificationDropdownOpen ? "block" : "none";
}

function markNotificationsRead() {
    unreadNotificationCount = 0;
    const badgeEl = byId("unread-count-badge");
    if (badgeEl) {
        badgeEl.style.display = "none";
    }
}

function initNotificationBell() {
    const bellBtn = byId("admin-bell-btn");
    const markReadBtn = byId("mark-read-btn");
    const dropdown = byId("bell-dropdown");

    if (bellBtn) {
        bellBtn.addEventListener("click", function (event) {
            event.stopPropagation();
            toggleNotificationDropdown();
        });
    }

    if (markReadBtn) {
        markReadBtn.addEventListener("click", markNotificationsRead);
    }

    if (!notificationOutsideClickBound) {
        document.addEventListener("click", function (event) {
            if (!dropdown || dropdown.style.display !== "block") return;
            if (dropdown.contains(event.target)) return;
            if (bellBtn && bellBtn.contains(event.target)) return;
            dropdown.style.display = "none";
            notificationDropdownOpen = false;
        });
        notificationOutsideClickBound = true;
    }

    renderNotificationBell();
}

/* ==========================================================================
   16. NAVIGATION
   ========================================================================== */

function initNavigation() {
    const navItems = document.querySelectorAll(".nav-item");
    if (!navItems.length) return;

    navItems.forEach(function (item) {
        item.addEventListener("click", function () {
            const targetId = item.getAttribute("data-target");
            if (!targetId) return;

            navItems.forEach(function (nav) { nav.classList.remove("active"); });
            item.classList.add("active");

            document.querySelectorAll(".view-section").forEach(function (section) {
                section.classList.remove("active");
            });

            const targetSection = byId(targetId);
            if (targetSection) {
                targetSection.classList.add("active");
            }

            const titleEl = byId("page-title");
            if (titleEl) {
                titleEl.textContent = item.textContent.trim();
            }

            const subtitleEl = byId("page-subtitle");
            if (subtitleEl) {
                subtitleEl.textContent = item.getAttribute("data-subtitle") || "";
            }

            renderIncidentList();
            loadRescueDashboard();

            if (map && typeof map.invalidateSize === "function") {
                setTimeout(function () { map.invalidateSize(); }, 200);
            }
        });
    });
}

/* ==========================================================================
   17. SUPABASE SYNCHRONIZATION
   ========================================================================== */

async function syncAllFromSupabase() {
    if (!supabaseConfigured) {
        console.warn("Supabase not connected — running on localStorage only.");
        return;
    }

    const incidentResult = await fetchIncidentsFromSupabase();
    if (incidentResult.ok) {
        mergeIncidentsFromSupabase(incidentResult.data || []);
    }

    const sosResult = await fetchSOSFromSupabase();
    if (sosResult.ok) {
        mergeSOSFromSupabase(sosResult.data || []);
    }

    const resourceResult = await fetchResourcesFromSupabase();
    if (resourceResult.ok) {
        mergeResourcesFromSupabase(resourceResult.data || []);
    }

    loadIncidents();
    loadSOS();
    loadResources();
    loadRescueDashboard();
}

/* ==========================================================================
   18. APPLICATION INITIALIZATION
   ========================================================================== */

let appInitialized = false;

async function initApp() {
    if (appInitialized) {
        console.warn("initApp() called more than once — ignoring repeat call.");
        return;
    }
    appInitialized = true;

    map = initMap();

    loadIncidents();
    loadSOS();
    loadResources();
    loadRescueDashboard();

    initNavigation();
    initNotificationBell();

    try {
        await loadVehicles();
    } catch (error) {
        console.error("Vehicle loading failed:", error);
    }

    try {
        await syncAllFromSupabase();
    } catch (error) {
        console.error("Supabase synchronization failed — continuing with localStorage only:", error);
    }
}

document.addEventListener("DOMContentLoaded", initApp);

/* ==========================================================================
   19. GLOBAL EXPORTS
   ========================================================================== */

window.checkAccessibility = checkAccessibility;
window.useSelectedMapLocation = useSelectedMapLocation;
window.getCurrentLocation = getCurrentLocation;
window.analyzeUserPreference = analyzeUserPreference;
window.generateSmartRecommendation = generateSmartRecommendation;
window.findAccessibleRoute = findAccessibleRoute;
window.searchDestination = searchDestination;
window.findNearbyFacilities = findNearbyFacilities;
window.showRiskPoints = showRiskPoints;

window.useSelectedIncidentLocation = useSelectedIncidentLocation;
window.getIncidentLocation = getIncidentLocation;
window.submitIncident = submitIncident;
window.updateIncidentStatus = updateIncidentStatus;
window.clearIncidentForm = clearIncidentForm;
window.viewIncidents = viewIncidents;
window.focusIncidentOnMap = focusIncidentOnMap;

window.useSelectedSOSLocation = useSelectedSOSLocation;
window.getSOSLocation = getSOSLocation;
window.submitSOS = submitSOS;
window.updateSOSStatus = updateSOSStatus;
window.focusSOSOnMap = focusSOSOnMap;

window.useSelectedResourceLocation = useSelectedResourceLocation;
window.getResourceLocation = getResourceLocation;
window.saveResource = saveResource;
window.deleteResource = deleteResource;

window.loadRescueDashboard = loadRescueDashboard;
/* ==========================================================================
   20. ROUTE INTELLIGENCE DEMO ANALYSIS
   ========================================================================== */

// Re-analyses the routes that OSRM actually returned. No demo statistics.
window.analyzeRoute = function () {
    updateRouteRiskAnalysis();
};

window.updateRouteRiskAnalysis = updateRouteRiskAnalysis;
window.renderRouteIntelligence = renderRouteIntelligence;

"""Flood zone (FEMA) plus Pennsylvania-specific due-diligence notes."""

from ..http import SourceError, get_json

NFHL_URL = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query"

ZONE_MEANING = {
    "A": "High risk (1% annual chance) - flood insurance typically required with a mortgage",
    "AE": "High risk (1% annual chance) - flood insurance typically required with a mortgage",
    "AH": "High risk, shallow ponding - flood insurance typically required",
    "AO": "High risk, sheet flow - flood insurance typically required",
    "VE": "High risk coastal",
    "X": "Moderate to minimal risk",
    "D": "Undetermined risk",
}


def fetch_flood_zone(lat: float, lon: float) -> dict:
    data = get_json(
        NFHL_URL,
        params={
            "geometry": f"{lon},{lat}",
            "geometryType": "esriGeometryPoint",
            "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "FLD_ZONE,ZONE_SUBTY,SFHA_TF",
            "returnGeometry": "false",
            "f": "json",
        },
        ttl=30 * 86400,
    )
    if "error" in data:
        raise SourceError(f"FEMA NFHL error: {data['error']}")
    features = data.get("features", [])
    if not features:
        return {"zone": None, "meaning": "Not mapped by FEMA at the ZIP center", "sfha": False}
    attrs = features[0].get("attributes", {})
    zone = attrs.get("FLD_ZONE")
    return {
        "zone": zone,
        "subtype": attrs.get("ZONE_SUBTY"),
        "sfha": attrs.get("SFHA_TF") == "T",
        "meaning": ZONE_MEANING.get(zone, ""),
    }


def pa_buyer_notes(zip_code: str, county: str) -> list[dict]:
    """Static guidance that applies statewide; worth knowing before an offer."""
    philly = "philadelphia" in (county or "").lower()
    transfer = (
        "Philadelphia's combined realty transfer tax is over 4% (1% state plus the city's ~3.5%), "
        "customarily split 50/50 between buyer and seller."
        if philly
        else "PA realty transfer tax is 1% state + usually 1% local (some municipalities charge more), "
        "customarily split 50/50 between buyer and seller."
    )
    return [
        {"title": "Realty transfer tax", "text": transfer},
        {"title": "Radon", "text": "Pennsylvania has some of the highest radon levels in the US; "
         "PA DEP estimates about 40% of homes exceed the EPA action level. Get a radon test "
         "during inspection."},
        {"title": "Mine subsidence", "text": "Much of western and northeastern PA sits over "
         "old coal mines. Standard homeowners policies exclude subsidence; the state's Mine "
         "Subsidence Insurance (MSI) program is inexpensive - check whether the area is eligible."},
        {"title": "Sinkholes", "text": "Limestone (karst) areas such as the Lehigh Valley, "
         "Lancaster, Cumberland and Centre counties are prone to sinkholes - ask about "
         "history and check the PA geological survey maps."},
        {"title": "Property & school taxes", "text": "PA property tax is mostly school "
         "district tax and varies widely between neighboring districts. Check the county "
         "assessment and the school district millage for the exact parcel; the estimate on "
         "this page uses Census medians."},
        {"title": "Private wells & septic", "text": "Many PA homes outside cities use wells "
         "and on-lot septic; PA has no statewide private well standards, so order water "
         "and septic inspections."},
        {"title": "Flood maps", "text": "The flood zone shown is for the ZIP's center only. "
         "Look up the exact address on FEMA's map.",
         "link": f"https://msc.fema.gov/portal/search?AddressQuery={zip_code}"},
    ]

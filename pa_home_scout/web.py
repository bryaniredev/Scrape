"""Flask web UI: enter a PA ZIP, get the report as a single page."""

import json

from flask import Flask, jsonify, render_template, request

from . import config
from .http import SourceError
from .report import build_report


def sparkline(history: list, width: int = 560, height: int = 120) -> dict | None:
    """SVG polyline points for the Zillow value history."""
    values = [v for _, v in history]
    if len(values) < 2:
        return None
    lo, hi = min(values), max(values)
    span = (hi - lo) or 1
    step = width / (len(values) - 1)
    points = " ".join(
        f"{i * step:.1f},{height - (v - lo) / span * (height - 10) - 5:.1f}"
        for i, v in enumerate(values)
    )
    return {"points": points, "width": width, "height": height, "lo": lo, "hi": hi,
            "start": history[0][0], "end": history[-1][0]}


def _map_points(report: dict) -> list[dict]:
    s, pts = report["sections"], []
    if s["listings"]["ok"]:
        for h in s["listings"]["data"]["homes"][:200]:
            pts.append({"kind": "home", "lat": h["lat"], "lon": h["lon"],
                        "label": f"${h['price'] or 0:,.0f} - {h['address']} ({h['drive_minutes']} min)"})
    if s["schools"]["ok"]:
        for x in s["schools"]["data"]["schools"]:
            pts.append({"kind": "school", "lat": x["lat"], "lon": x["lon"],
                        "label": f"{x['name']} ({x['level']}) rating {x.get('rating') or 'n/a'}"})
    if s["restaurants"]["ok"]:
        for x in s["restaurants"]["data"]["restaurants"]:
            if x["lat"] is not None:
                pts.append({"kind": "food", "lat": x["lat"], "lon": x["lon"],
                            "label": f"{x['name']} {x['rating']}*"})
    if s["amenities"]["ok"]:
        for cat in ("Grocery stores", "Parks & playgrounds", "Hospitals & clinics",
                    "Train & subway stations", "Libraries"):
            for x in s["amenities"]["data"]["categories"][cat]["nearest"][:3]:
                pts.append({"kind": "amenity", "lat": x["lat"], "lon": x["lon"],
                            "label": f"{cat[:-1] if cat.endswith('s') else cat}: {x['name']}"})
    return pts


def _float_arg(name, default):
    try:
        return float(request.args.get(name, default))
    except (TypeError, ValueError):
        return default


def create_app() -> Flask:
    app = Flask(__name__)

    @app.template_filter("money")
    def money(v):
        return f"${v:,.0f}" if isinstance(v, (int, float)) else "n/a"

    @app.template_filter("num")
    def num(v, suffix=""):
        if not isinstance(v, (int, float)):
            return "n/a"
        return f"{v:,.0f}{suffix}" if float(v).is_integer() or abs(v) >= 100 else f"{v:,.1f}{suffix}"

    def _params():
        return (
            request.args.get("zip", "").strip(),
            int(_float_arg("drive", config.DEFAULT_MAX_DRIVE_MINUTES)),
            _float_arg("rate", config.DEFAULT_MORTGAGE_RATE),
            _float_arg("down", config.DEFAULT_DOWN_PAYMENT_PCT),
        )

    @app.get("/")
    def index():
        zip_code, drive, rate, down = _params()
        ctx = {"zip": zip_code, "drive": drive, "rate": rate, "down": down,
               "report": None, "error": None}
        if zip_code:
            try:
                report = build_report(zip_code, drive, rate, down)
                ctx["report"] = report
                hv = report["sections"]["home_values"]
                ctx["spark"] = sparkline(hv["data"]["history"]) if hv["ok"] else None
                ctx["map_json"] = json.dumps({
                    "center": [report["location"]["lat"], report["location"]["lon"]],
                    "points": _map_points(report),
                }).replace("<", "\\u003c")  # safe to embed in <script>
            except (ValueError, SourceError) as exc:
                ctx["error"] = str(exc)
        return render_template("index.html", **ctx)

    @app.get("/api/report")
    def api_report():
        zip_code, drive, rate, down = _params()
        try:
            return jsonify(build_report(zip_code, drive, rate, down))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except SourceError as exc:
            return jsonify({"error": str(exc)}), 502

    return app


if __name__ == "__main__":
    create_app().run(debug=True)

"""Runtime configuration, read from environment variables (or a .env file)."""

import os
from pathlib import Path


def _load_dotenv() -> None:
    """Minimal .env loader so users don't need python-dotenv."""
    for candidate in (Path.cwd() / ".env", Path(__file__).resolve().parent.parent / ".env"):
        if not candidate.is_file():
            continue
        for line in candidate.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
        break


_load_dotenv()

# Optional API keys. Every section degrades gracefully when its key is missing.
RENTCAST_API_KEY = os.getenv("RENTCAST_API_KEY", "")  # homes for sale
YELP_API_KEY = os.getenv("YELP_API_KEY", "")  # rated restaurants
GREATSCHOOLS_API_KEY = os.getenv("GREATSCHOOLS_API_KEY", "")  # GreatSchools ratings
DATA_GOV_API_KEY = os.getenv("DATA_GOV_API_KEY", "DEMO_KEY")  # FBI crime data
CENSUS_API_KEY = os.getenv("CENSUS_API_KEY", "")  # optional, raises Census rate limits

CACHE_DIR = Path(os.getenv("PA_HOME_SCOUT_CACHE", Path.home() / ".cache" / "pa_home_scout"))
USER_AGENT = os.getenv(
    "PA_HOME_SCOUT_USER_AGENT", "pa-home-scout/0.1 (personal home-buyer research tool)"
)
HTTP_TIMEOUT = float(os.getenv("PA_HOME_SCOUT_TIMEOUT", "30"))

# Search parameters
DEFAULT_MAX_DRIVE_MINUTES = 20
SCHOOL_RADIUS_MILES = 5
AMENITY_RADIUS_METERS = 3000
RESTAURANT_RADIUS_METERS = 8000

# Mortgage estimate assumptions (editable in the web UI)
DEFAULT_MORTGAGE_RATE = float(os.getenv("PA_HOME_SCOUT_MORTGAGE_RATE", "6.5"))
DEFAULT_DOWN_PAYMENT_PCT = 20.0
DEFAULT_LOAN_YEARS = 30

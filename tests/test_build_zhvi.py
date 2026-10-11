import importlib.util
from pathlib import Path

from pa_home_scout.sources import zillow

spec = importlib.util.spec_from_file_location(
    "build_zhvi", Path(__file__).resolve().parent.parent / "scripts" / "build_zhvi.py"
)
build_zhvi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_zhvi)


def test_compact_fills_gaps_and_trims_to_ten_years():
    series = [(f"{2010 + m // 12}-{m % 12 + 1:02d}-28", 1000 + m) for m in range(200)]
    del series[190]  # a missing month becomes None
    packed = build_zhvi.compact(series)
    assert len(packed["values"]) == build_zhvi.MONTHS
    assert packed["start"] == "2016-08" and packed["values"][-1] == 1199
    assert packed["values"].count(None) == 1


def test_build_from_csv(tmp_path):
    data = build_zhvi.build(zillow._load_pa_rows())
    assert list(data["zips"]) == ["19010"]  # NJ row dropped
    entry = data["zips"]["19010"]
    assert entry["values"][-1] == 819000 and entry["values"][-13] == 780000

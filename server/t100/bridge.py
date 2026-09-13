#!/usr/bin/env python3
"""Emit the T100 manifest, unit roster, and ladder scorer status as one JSON doc.

The Node world model wants exact ladder semantics without reimplementing the
scoring rules in JavaScript, so this thin bridge runs the canonical
`scripts/unit_test_status.py --json` from the models bringup-ladder tree and
hands back its output alongside the parsed manifest and roster.

It never mutates the source repo. When no ctest JUnit exists (the common case on
a fresh checkout), it scores against an empty suite written to a temp file: that
yields honest zeros the world model reports as `unknown`, not as failures.

Usage:
    python3 bridge.py --repo /path/to/models/bringup-ladder [--fidelity rtl]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import tomllib
except ImportError:  # Python 3.10: models environments commonly carry tomli.
    import tomli as tomllib


def load_yaml(path: Path):
    try:
        import yaml
    except ImportError:
        sys.exit(
            "PyYAML is required; run this with the models repo venv, e.g.\n"
            "  <models>/.venv/bin/python3 bridge.py --repo <models>"
        )
    with path.open() as f:
        return yaml.safe_load(f) or {}


def load_toml_directory(directory: Path, table: str) -> dict:
    """Index typed SSoT records by their declared name, skipping malformed files."""
    out = {}
    if not directory.exists():
        return out
    for path in sorted(directory.glob("*.toml")):
        try:
            with path.open("rb") as stream:
                doc = tomllib.load(stream)
            record = doc.get(table, {})
            name = record.get("name")
            if name:
                out[str(name)] = {"path": str(path.relative_to(directory.parent.parent)), **record}
        except (OSError, tomllib.TOMLDecodeError):
            continue
    return out


def run_scorer(repo: Path, fidelity: str | None) -> dict:
    scorer = repo / "scripts" / "unit_test_status.py"
    if not scorer.exists():
        return {"error": f"no scorer at {scorer}"}

    junit = repo / "build" / "unit-tests.xml"
    junit_present = junit.exists()
    tmp_junit = None
    if not junit_present:
        tmp_junit = tempfile.NamedTemporaryFile(
            "w", suffix=".xml", delete=False, encoding="utf8"
        )
        tmp_junit.write('<?xml version="1.0"?>\n<testsuite tests="0"></testsuite>\n')
        tmp_junit.close()
        junit = Path(tmp_junit.name)

    out = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    out.close()
    cmd = [
        sys.executable,
        str(scorer),
        "--junit",
        str(junit),
        "--json",
        out.name,
    ]
    if fidelity:
        cmd += ["--fidelity", fidelity]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    status: dict = {}
    try:
        status = json.loads(Path(out.name).read_text())
    except Exception as exc:  # noqa: BLE001 - surface, don't crash the server
        status = {"error": f"scorer produced no readable json: {exc}", "stderr": proc.stderr}
    finally:
        Path(out.name).unlink(missing_ok=True)
        if tmp_junit:
            Path(tmp_junit.name).unlink(missing_ok=True)
    status["_junit_present"] = junit_present
    status["_scorer_returncode"] = proc.returncode
    return status


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo", required=True, type=Path, help="models bringup-ladder root")
    ap.add_argument("--fidelity", default=None, help="score gates at this fidelity")
    args = ap.parse_args()

    repo = args.repo.resolve()
    manifest_path = repo / "t100.yaml"
    roster_path = repo / "units.yaml"

    ladder_path = repo / "milestones.yaml"
    doc = {
        "manifest": load_yaml(manifest_path) if manifest_path.exists() else None,
        "roster": load_yaml(roster_path) if roster_path.exists() else None,
        # Raw ladder is included so the world model can attribute a rung to the
        # units it demands (milestones[].units / requires.adds), which the scorer
        # JSON summarises but does not itemise per rung.
        "ladder": load_yaml(ladder_path) if ladder_path.exists() else None,
        "interfaces": load_toml_directory(repo / "ssot" / "interfaces", "interface"),
        "unit_specs": load_toml_directory(repo / "ssot" / "units", "unit"),
        "status": run_scorer(repo, args.fidelity),
        "repo": str(repo),
    }
    # YAML coerces bare `2026-01-27` into date objects; stringify anything json
    # cannot represent rather than crashing the whole bridge on one metadata field.
    sys.stdout.write(json.dumps(doc, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())

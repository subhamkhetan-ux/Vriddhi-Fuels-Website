"""Updates from inside the app: the newest bridge release on GitHub, checked against its
published SHA-256 and the package's own manifest before it is opened. The new version
then installs itself (cli --finish-update), keeping the pairing and queued work."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import urllib.request
import zipfile

from . import __version__
from .packaging import MANIFEST, verify_package

RELEASES = "https://api.github.com/repos/subhamkhetan-ux/Vriddhi-Fuels-Website/releases?per_page=30"
ASSET, SUMS = "VriddhiTallyBridge-Windows.zip", "SHA256SUMS.txt"
TAG = re.compile(r"^tally-bridge-v(\d+(?:\.\d+){1,3})$")


def version_key(version):
    return tuple(int(x) for x in str(version).split("."))


def fetch(url, limit, timeout=60):
    """GitHub over verified HTTPS. Release downloads redirect to GitHub's file host."""
    request = urllib.request.Request(url, headers={"User-Agent": "VriddhiTallyBridge/" + __version__,
                                                   "Accept": "application/vnd.github+json" if "api.github.com" in url else "*/*"})
    with urllib.request.urlopen(request, timeout=timeout) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError("The download is larger than a bridge package")
    return data


def newest(releases, current=__version__):
    """The highest tally-bridge-v* release above `current` with the package and its checksums."""
    best = None
    for r in releases if isinstance(releases, list) else []:
        found = TAG.match(str(r.get("tag_name") or ""))
        if r.get("draft") or not found:
            continue
        assets = {a.get("name"): a.get("browser_download_url") for a in r.get("assets") or []}
        if not (str(assets.get(ASSET) or "").startswith("https://") and str(assets.get(SUMS) or "").startswith("https://")):
            continue
        if best is None or version_key(found[1]) > version_key(best["version"]):
            best = {"version": found[1], "zip": assets[ASSET], "sums": assets[SUMS]}
    return best if best and version_key(best["version"]) > version_key(current) else None


def check(get=fetch):
    return newest(json.loads(get(RELEASES, 2_000_000)))


def expected_hash(sums, name=ASSET):
    for line in sums.splitlines():
        parts = line.strip().split()
        if len(parts) == 2 and parts[1].lstrip("*") == name and re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
            return parts[0].lower()
    raise RuntimeError("The release lists no checksum for the bridge package")


def extract(archive, dest):
    """Unpack only plain files inside `dest`; returns the folder holding the package manifest."""
    dest = Path(dest).resolve()
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            name = info.filename.replace("\\", "/")  # Windows PowerShell 5 writes backslashes
            parts = PurePosixPath(name).parts
            if not parts or name.startswith("/") or ":" in name or ".." in parts:
                raise RuntimeError("The bridge package holds an unsafe path")
            target = dest.joinpath(*parts)
            if name.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, target.open("wb") as out:
                shutil.copyfileobj(src, out)
    roots = [p.parent for p in dest.rglob(MANIFEST) if len(p.relative_to(dest).parts) <= 2]
    if len(roots) != 1:
        raise RuntimeError("The download is not a bridge package")
    return roots[0]


def download(release, folder, get=fetch):
    """Download, check and unpack `release` into `folder`; returns the verified package folder."""
    folder = Path(folder)
    for old in folder.parent.glob("*") if folder.parent.is_dir() else []:
        shutil.rmtree(old, ignore_errors=True)  # earlier downloads (one still open stays, harmlessly)
    folder.mkdir(parents=True, exist_ok=True)
    want = expected_hash(get(release["sums"], 100_000).decode("ascii", "replace"))
    data = get(release["zip"], 300_000_000, timeout=300)
    if hashlib.sha256(data).hexdigest() != want:
        raise RuntimeError("The download did not match its published checksum. Nothing was changed; try again.")
    archive = folder / ASSET
    archive.write_bytes(data)
    try:
        root = extract(archive, folder / "package")
    finally:
        archive.unlink(missing_ok=True)
    verify_package(root, release["version"])
    return root

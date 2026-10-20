"""Readable Windows distribution using the unmodified CPython runtime, not a bootloader."""
import hashlib
import importlib.util
import importlib.metadata
import json
from pathlib import Path
import shutil
import sys

from . import __version__

MANIFEST = "bridge-package.json"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_package(root):
    root = Path(root).resolve()
    try:
        manifest = json.loads((root / MANIFEST).read_text(encoding="utf-8"))
        if manifest["format"] != 1 or manifest["version"] != __version__:
            raise ValueError("Unsupported package")
        expected = manifest["files"]
        actual = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file() and p.relative_to(root).as_posix() != MANIFEST}
        if set(expected) != actual:
            raise ValueError("Package files differ")
        for name, checksum in expected.items():
            if not isinstance(name, str) or "\\" in name or ":" in name or name.startswith("/") or ".." in Path(name).parts:
                raise ValueError("Invalid package path")
            path = root / name
            if not path.resolve().is_relative_to(root) or path.is_symlink() or digest(path) != checksum:
                raise ValueError("Package checksum differs")
        for name in ("runtime/python.exe", "runtime/pythonw.exe", "bridge.pyw", "Setup.cmd"):
            if name not in expected:
                raise ValueError("Incomplete package")
    except (OSError, ValueError, KeyError, TypeError):
        raise RuntimeError("Package verification failed. Extract a fresh official ZIP; do not restore a quarantined executable or disable Defender.") from None
    return manifest


def package_root():
    root = Path(__file__).resolve().parent.parent
    if not (root / MANIFEST).is_file() or Path(sys.executable).resolve().parent != root / "runtime":
        raise RuntimeError("Open Setup.cmd from the extracted official Windows package.")
    return root


def build(root, runtime_prefix=None):
    if sys.platform != "win32":
        raise RuntimeError("Build the Windows runtime on the Windows CI runner")
    root = Path(root)
    if root.exists():
        raise RuntimeError("Build into a new empty directory")
    root.mkdir(parents=True)
    prefix = Path(runtime_prefix or sys.base_prefix)
    runtime = root / "runtime"
    runtime.mkdir()
    for path in prefix.iterdir():
        if path.is_file() and (path.suffix.lower() == ".dll" or path.name.lower() in ("python.exe", "pythonw.exe", "license.txt")):
            shutil.copy2(path, runtime / path.name)
    for name in ("DLLs", "Lib", "tcl"):
        shutil.copytree(prefix / name, runtime / name,
                        ignore=shutil.ignore_patterns("__pycache__", "test", "tests", "idlelib", "turtledemo", "ensurepip", "site-packages", "*.pdb"))
    # The only application dependency is pure Python and is pinned in requirements.txt.
    dependency = Path(importlib.util.find_spec("defusedxml").origin).parent
    shutil.copytree(dependency, runtime / "Lib" / "site-packages" / "defusedxml", ignore=shutil.ignore_patterns("__pycache__"))
    dist = importlib.metadata.distribution("defusedxml")
    license_file = next(p for p in dist.files if p.name == "LICENSE")
    (root / "LICENSES").mkdir()
    shutil.copy2(dist.locate_file(license_file), root / "LICENSES" / "defusedxml-LICENSE.txt")
    source = Path(__file__).resolve().parent
    shutil.copytree(source, root / "tally_bridge", ignore=shutil.ignore_patterns("__pycache__", "package"))
    (root / "bridge.pyw").write_text(
        '"""Vriddhi bridge launcher. Run with the bundled, signed Python runtime."""\n'
        'from pathlib import Path\nimport sys\nsys.path.insert(0,str(Path(__file__).resolve().parent))\n'
        'from tally_bridge.entry import run\nrun()\n', encoding="utf-8")
    (root / "Setup.cmd").write_text('@echo off\r\nstart "" "%~dp0runtime\\pythonw.exe" -I -B "%~dp0bridge.pyw"\r\n', encoding="ascii")
    shutil.copy2(source / "README.md", root / "SETUP.md")
    manifest = {"format": 1, "version": __version__, "python": sys.version,
                "files": {p.relative_to(root).as_posix(): digest(p) for p in sorted(root.rglob("*")) if p.is_file()}}
    (root / MANIFEST).write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    verify_package(root)
    return root


if __name__ == "__main__":
    build(sys.argv[1])

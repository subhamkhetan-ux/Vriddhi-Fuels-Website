"""Per-user Windows installation, DPAPI credentials, startup and single-instance locks."""
import base64
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from . import __version__

APP = "VriddhiTallyBridge"


def data_dir():
    if sys.platform != "win32":
        raise RuntimeError("The installer runs on Windows 10/11")
    return Path(os.environ["LOCALAPPDATA"]) / APP


class Blob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def crypt(data, decrypt=False):
    if sys.platform != "win32":
        raise RuntimeError("Device credentials require Windows DPAPI")
    buf = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)))
    target = Blob()
    method = ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    # CRYPTPROTECT_UI_FORBIDDEN, current Windows user (NOT machine-wide).
    if not method(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise RuntimeError("Windows could not unlock this user's bridge credential")
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        ctypes.windll.kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        ctypes.windll.kernel32.LocalFree.restype = ctypes.c_void_p
        ctypes.windll.kernel32.LocalFree(target.data)


def save_config(config, folder=None):
    folder = folder or data_dir()
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / "credential.tmp"
    tmp.write_bytes(crypt(json.dumps(config).encode()))
    os.replace(tmp, folder / "credential.dat")


def load_config(folder=None):
    return json.loads(crypt(((folder or data_dir()) / "credential.dat").read_bytes(), decrypt=True))


class SingleInstance:
    def __init__(self, name):
        if sys.platform != "win32":
            raise RuntimeError("Worker service requires Windows")
        kernel = ctypes.windll.kernel32
        kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        kernel.CreateMutexW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = kernel.CreateMutexW(None, False, "Local\\" + APP + name)
        if not self.handle or kernel.GetLastError() == 183:
            if self.handle:
                kernel.CloseHandle(self.handle)
            raise RuntimeError("The bridge is already running")

    def close(self):
        ctypes.windll.kernel32.CloseHandle(self.handle)


def detached(args):
    return subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW)


def install():
    if not getattr(sys, "frozen", False):
        raise RuntimeError("Install using the packaged VriddhiTallyBridge.exe")
    import winreg
    folder = Path(os.environ["LOCALAPPDATA"]) / "Programs" / APP / __version__
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / "VriddhiTallyBridge.exe"
    if Path(sys.executable).resolve() != dest.resolve():
        # A versioned install doesn't overwrite a running older executable.
        if not dest.exists():
            shutil.copy2(sys.executable, dest)
        elif dest.read_bytes() != Path(sys.executable).read_bytes():
            raise RuntimeError("This version is already installed with different contents; uninstall it before replacing")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
        winreg.SetValueEx(key, APP, 0, winreg.REG_SZ, f'"{dest}" --supervise')
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + APP) as key:
        for k, value in {"DisplayName": "Vriddhi Fuels — Tally Bridge", "DisplayVersion": __version__,
                         "Publisher": "Vriddhi Fuels", "InstallLocation": str(folder),
                         "UninstallString": f'"{dest}" --uninstall', "DisplayIcon": str(dest)}.items():
            winreg.SetValueEx(key, k, 0, winreg.REG_SZ, value)
    desktop = Path(os.environ["USERPROFILE"]) / "Desktop"
    # A .url shortcut avoids dependencies on COM or PowerShell for installation.
    if desktop.exists():
        (desktop / "Vriddhi Tally Bridge.url").write_text("[InternetShortcut]\nURL=" + dest.as_uri() + "\n", encoding="utf-8")
    return dest


def start(exe):
    (data_dir() / "stop").unlink(missing_ok=True)
    detached([str(exe), "--supervise"])


def stop():
    data_dir().mkdir(parents=True, exist_ok=True)
    (data_dir() / "stop").touch()


def stop_before_pairing():
    stop()
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            supervisor = SingleInstance("Supervisor")
            try:
                service = SingleInstance("Worker")
                service.close()
                return
            finally:
                supervisor.close()
        except RuntimeError:
            time.sleep(1)
    raise RuntimeError("The current sync is still finishing; try pairing again shortly")


class StopFlag:
    def is_set(self):
        return (data_dir() / "stop").exists()

    def wait(self, seconds):
        end = time.monotonic() + seconds
        while not self.is_set() and time.monotonic() < end:
            time.sleep(min(0.5, max(0, end - time.monotonic())))
        return self.is_set()


def supervise():
    guard = SingleInstance("Supervisor")
    flag = StopFlag()
    delay = 5
    try:
        while not flag.is_set():
            child = detached([sys.executable, "--worker"])
            child.wait()
            if flag.wait(delay):
                break
            delay = min(60, delay * 2)
    finally:
        guard.close()


def uninstall():
    import winreg
    stop()
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
        try:
            winreg.DeleteValue(key, APP)
        except FileNotFoundError:
            pass
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + APP)
    except FileNotFoundError:
        pass
    (Path(os.environ["USERPROFILE"]) / "Desktop" / "Vriddhi Tally Bridge.url").unlink(missing_ok=True)
    folder = Path(os.environ["LOCALAPPDATA"]) / "Programs" / APP
    # Wait for this uninstaller and the worker's network timeout. LiteralPath is quoted safely.
    literal = str(folder).replace("'", "''")
    script = f"Wait-Process -Id {os.getpid()} -ErrorAction SilentlyContinue; Start-Sleep -Seconds 45; Remove-Item -LiteralPath '{literal}' -Recurse -Force -ErrorAction SilentlyContinue"
    detached(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.b64encode(script.encode("utf-16le")).decode()])
    # Retain the journal and encrypted credential for safe reinstallation. Revoke in the web app.

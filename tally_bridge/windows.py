"""Visible per-user installation, DPAPI credentials, startup tasks and Tally recovery."""
import ctypes
import datetime as dt
from ctypes import wintypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
from xml.etree import ElementTree as ET

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


def user_sid():
    """Use the actual token SID, not an environment variable or account-name guess."""
    kernel, adv = ctypes.windll.kernel32, ctypes.windll.advapi32
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    adv.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    adv.GetTokenInformation.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    token, size = wintypes.HANDLE(), wintypes.DWORD()
    if not adv.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
        raise RuntimeError("Windows could not read this account's identity")
    try:
        adv.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
        buf = ctypes.create_string_buffer(size.value)
        if not adv.GetTokenInformation(token, 1, buf, size, ctypes.byref(size)):
            raise RuntimeError("Windows could not read this account's identity")
        sid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
        result = wintypes.LPWSTR()
        adv.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
        if not adv.ConvertSidToStringSidW(sid, ctypes.byref(result)):
            raise RuntimeError("Windows could not read this account's identity")
        try:
            return result.value
        finally:
            kernel.LocalFree(ctypes.cast(result, ctypes.c_void_p))
    finally:
        kernel.CloseHandle(token)


class AlreadyRunning(RuntimeError):
    pass


class SingleInstance:
    def __init__(self, name, legacy=False):
        if sys.platform != "win32":
            raise RuntimeError("Worker requires Windows")
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel.CreateMutexW.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        # One worker per user across interactive/RDP sessions sharing the same journal.
        key = "Local\\" + APP + name if legacy else "Global\\" + APP + user_sid() + name
        self.handle = self.kernel.CreateMutexW(None, False, key)
        if not self.handle:
            raise RuntimeError("Windows could not create the bridge lock")
        if ctypes.get_last_error() == 183:
            self.kernel.CloseHandle(self.handle)
            self.handle = None
            raise AlreadyRunning("The bridge is already running")

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def command(root, *args, console=False):
    root = Path(root)
    return [str(root / "runtime" / ("python.exe" if console else "pythonw.exe")), "-I", "-B", str(root / "bridge.pyw"), *args]


def detached(args):
    return subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)


def task_xml(root, sid):
    ns = "http://schemas.microsoft.com/windows/2004/02/mit/task"
    ET.register_namespace("", ns)
    task = ET.Element("{" + ns + "}Task", version="1.2")
    def item(parent, name, value=None):
        node = ET.SubElement(parent, name)
        if value is not None:
            node.text = value
        return node
    info = item(task, "RegistrationInfo")
    item(info, "Description", "Vriddhi Fuels background sync. Runs only while this Windows account is signed in.")
    triggers = item(task, "Triggers")
    trigger = item(triggers, "LogonTrigger")
    repeat = item(trigger, "Repetition")
    item(repeat, "Interval", "PT5M")
    item(repeat, "StopAtDurationEnd", "false")
    item(trigger, "Enabled", "true")
    item(trigger, "UserId", sid)
    timer = item(triggers, "TimeTrigger")
    repetition = item(timer, "Repetition")
    item(repetition, "Interval", "PT5M")
    item(repetition, "StopAtDurationEnd", "false")
    item(timer, "StartBoundary", (dt.datetime.now() + dt.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%S"))
    item(timer, "Enabled", "true")
    principal = item(item(task, "Principals"), "Principal")
    principal.set("id", "BridgeUser")
    item(principal, "UserId", sid)
    item(principal, "LogonType", "InteractiveToken")
    item(principal, "RunLevel", "LeastPrivilege")
    settings = item(task, "Settings")
    for name, value in (("MultipleInstancesPolicy", "IgnoreNew"), ("DisallowStartIfOnBatteries", "false"),
                        ("StopIfGoingOnBatteries", "false"), ("StartWhenAvailable", "true"),
                        ("RunOnlyIfNetworkAvailable", "false"), ("ExecutionTimeLimit", "PT0S"), ("Enabled", "true")):
        item(settings, name, value)
    restart = item(settings, "RestartOnFailure")
    item(restart, "Interval", "PT1M")
    item(restart, "Count", "999")
    actions = item(task, "Actions")
    actions.set("Context", "BridgeUser")
    action = item(actions, "Exec")
    args = command(root, "--supervise")
    item(action, "Command", args[0])
    item(action, "Arguments", subprocess.list2cmdline(args[1:]))
    item(action, "WorkingDirectory", str(root))
    return '<?xml version="1.0" encoding="UTF-16"?>\n' + ET.tostring(task, encoding="unicode")


def task_command(*args):
    executable = Path(os.environ["SystemRoot"]) / "System32" / "schtasks.exe"
    return subprocess.run([str(executable), *args], capture_output=True, timeout=25, creationflags=subprocess.CREATE_NO_WINDOW)


def install():
    from .packaging import package_root, verify_package, MANIFEST
    import winreg
    source = package_root()
    verify_package(source)
    parent = Path(os.environ["LOCALAPPDATA"]) / "Programs" / APP
    parent.mkdir(parents=True, exist_ok=True)
    dest = parent / __version__
    if dest.exists():
        verify_package(dest)
        if (dest / MANIFEST).read_bytes() != (source / MANIFEST).read_bytes():
            raise RuntimeError("A different build of this version is installed. Close it and extract a fresh official package.")
    else:
        staging = parent / ("installing-" + str(uuid.uuid4()))
        try:
            shutil.copytree(source, staging)
            verify_package(staging)
            staging.rename(dest)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    args = command(dest, "--supervise")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
        winreg.SetValueEx(key, APP, 0, winreg.REG_SZ, subprocess.list2cmdline(args))
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + APP) as key:
        for k, value in {"DisplayName": "Vriddhi Fuels — Tally Bridge", "DisplayVersion": __version__,
                         "Publisher": "Vriddhi Fuels", "InstallLocation": str(dest),
                         "UninstallString": subprocess.list2cmdline(command(dest, "--uninstall")),
                         "DisplayIcon": args[0]}.items():
            winreg.SetValueEx(key, k, 0, winreg.REG_SZ, value)
    desktop = Path(os.environ["USERPROFILE"]) / "Desktop"
    if desktop.exists():
        # Plain, readable launcher; no encoded PowerShell or registry script payloads.
        relative = "\\Programs\\" + APP + "\\" + __version__
        (desktop / "Vriddhi Tally Bridge.cmd").write_text(
            '@echo off\r\nstart "" "%LOCALAPPDATA%' + relative + '\\runtime\\pythonw.exe" -I -B "%LOCALAPPDATA%' + relative + '\\bridge.pyw"\r\n', encoding="ascii")
        (desktop / "Vriddhi Tally Bridge.url").unlink(missing_ok=True)
    data_dir().mkdir(parents=True, exist_ok=True)
    task_path = data_dir() / "startup-task.xml"
    task_path.write_text(task_xml(dest, user_sid()), encoding="utf-16")
    registered = False
    try:
        registered = task_command("/Create", "/TN", APP, "/XML", str(task_path), "/F").returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        pass
    (data_dir() / "startup.json").write_text(json.dumps({"scheduled_task": registered}), encoding="utf-8")
    return dest


def start(root=None):
    root = Path(root) if root else Path(os.environ["LOCALAPPDATA"]) / "Programs" / APP / __version__
    if not (root / "bridge.pyw").is_file():
        raise RuntimeError("Install or upgrade this version first.")
    (data_dir() / "stop").unlink(missing_ok=True)
    try:
        scheduled = json.loads((data_dir() / "startup.json").read_text()).get("scheduled_task")
        if scheduled and task_command("/Run", "/TN", APP).returncode == 0:
            return
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    detached(command(root, "--supervise"))


def stop():
    data_dir().mkdir(parents=True, exist_ok=True)
    (data_dir() / "stop").touch()


def stop_before_pairing():
    stop()
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        acquired = []
        try:
            for legacy in (False, True):
                for kind in ("Supervisor", "Worker"):
                    acquired.append(SingleInstance(kind, legacy=legacy))
            return
        except AlreadyRunning:
            time.sleep(1)
        finally:
            for guard in acquired:
                guard.close()
    raise RuntimeError("The current sync is still finishing; try again shortly. No worker was force-terminated.")


def worker_running():
    """Whether a bridge worker of any version holds its lock. Never stops anything."""
    for legacy in (False, True):
        try:
            SingleInstance("Worker", legacy=legacy).close()
        except AlreadyRunning:
            return True
    return False


def installed_version():
    """The version Windows starts at sign-in, from the Run entry install() writes."""
    import re
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
            value = winreg.QueryValueEx(key, APP)[0]
    except OSError:
        return None
    found = re.search(r"\\" + APP + r"\\([0-9][0-9.]*)\\", value)
    return found[1] if found else "an older version"


class StopFlag:
    def is_set(self):
        return (data_dir() / "stop").exists()

    def wait(self, seconds):
        end = time.monotonic() + seconds
        while not self.is_set() and time.monotonic() < end:
            time.sleep(min(0.5, max(0, end - time.monotonic())))
        return self.is_set()


def supervise():
    from .packaging import package_root
    guard = SingleInstance("Supervisor")
    flag = StopFlag()
    delay = 5
    try:
        while not flag.is_set():
            launched = time.monotonic()
            child = detached(command(package_root(), "--worker"))
            child.wait()
            if time.monotonic() - launched > 300:
                delay = 5
            if flag.wait(delay):
                break
            delay = min(60, delay * 2)
    finally:
        guard.close()


def tally_processes():
    """Only Tally processes in this interactive Windows session; never stop any process."""
    class ProcessEntry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD),
                    ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                    ("pcPriClassBase", wintypes.LONG), ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.Process32FirstW.argtypes = kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    session = wintypes.DWORD()
    if not kernel.ProcessIdToSessionId(os.getpid(), ctypes.byref(session)):
        raise RuntimeError("Windows could not inspect this interactive session")
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == wintypes.HANDLE(-1).value:
        raise RuntimeError("Windows could not inspect running Tally processes")
    result = []
    try:
        entry = ProcessEntry(); entry.dwSize = ctypes.sizeof(entry)
        valid = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while valid:
            if entry.szExeFile.lower() in ("tally.exe", "tallyprime.exe"):
                other = wintypes.DWORD()
                if kernel.ProcessIdToSessionId(entry.th32ProcessID, ctypes.byref(other)) and other.value == session.value:
                    handle = kernel.OpenProcess(0x1000, False, entry.th32ProcessID)
                    path = None
                    if handle:
                        try:
                            size = wintypes.DWORD(32768); buf = ctypes.create_unicode_buffer(size.value)
                            if kernel.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                                path = buf.value
                        finally:
                            kernel.CloseHandle(handle)
                    result.append({"pid": entry.th32ProcessID, "exe": path})
            valid = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    return result


def launch_tally(settings):
    info = subprocess.STARTUPINFO()
    info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    info.wShowWindow = 7  # SW_SHOWMINNOACTIVE: don't steal an employee's foreground window.
    return subprocess.Popen([settings["exe"], "/NOINILOAD", "/LOAD:" + settings["number"]],
                            cwd=str(Path(settings["exe"]).parent), startupinfo=info,
                            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)


def keep_awake(enabled):
    # Affect only this worker's lifetime, not global power settings or the display lock.
    if not ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | (1 if enabled else 0)):
        raise RuntimeError("Windows could not apply the requested keep-awake preference")


def uninstall():
    import winreg
    stop_before_pairing()
    try:
        task_command("/Delete", "/TN", APP, "/F")
    except (OSError, subprocess.TimeoutExpired):
        pass
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
        try:
            winreg.DeleteValue(key, APP)
        except FileNotFoundError:
            pass
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + APP)
    except FileNotFoundError:
        pass
    desktop = Path(os.environ["USERPROFILE"]) / "Desktop"
    for name in ("Vriddhi Tally Bridge.cmd", "Vriddhi Tally Bridge.url"):
        (desktop / name).unlink(missing_ok=True)
    # Leave program files for removal after the UI/runtime closes. Do not run delayed deletion scripts.
    # Recovery journal and encrypted credential are retained for a safe reinstall.
    return Path(os.environ["LOCALAPPDATA"]) / "Programs" / APP

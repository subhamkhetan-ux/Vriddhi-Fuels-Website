"""Read the VBA macros out of a macro-enabled workbook — no Excel needed.

``oletools`` pulls each module's source out of ``xl/vbaProject.bin`` (this works
even when the VBA project is password-locked for viewing). The rest is a small,
pure parser, unit-tested with source strings, that:

* lists every procedure with its scope, parameters and leading comment;
* picks out the **entry points** — public ``Sub``s with no required arguments,
  i.e. what Alt+F8 / a button can run — and the **event macros** Excel runs by
  itself (``Workbook_Open``, ``Worksheet_Change``, a control's ``_Click`` …);
* follows calls between procedures so each entry point's dialogs are counted
  through everything it calls: ``MsgBox`` / ``InputBox`` (with the InputBox
  prompts pulled out, since they become form fields when a macro is ported),
  plus file pickers, UserForms and other dialogs;
* blanks string literals on lines that look like passwords, so no password
  ever ends up in the report.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class Module:
    name: str
    kind: str            # "standard" | "document" | "class" | "form"
    code: str            # source without the Attribute header lines
    description: str = ""


@dataclass
class Proc:
    module: str
    module_kind: str
    name: str
    kind: str            # "Sub" | "Function" | "Property"
    scope: str           # "Public" | "Private"
    params: str
    required_params: int
    body: list = field(default_factory=list)   # logical lines (continuations joined)
    description: str = ""
    msgbox: int = 0
    inputbox: int = 0
    other_dialogs: list = field(default_factory=list)
    calls: list = field(default_factory=list)
    prompts: list = field(default_factory=list)
    total: tuple = ()    # (msgbox, inputbox, other_dialogs, prompts) incl. everything it calls

    @property
    def qualified(self) -> str:
        return f"{self.module}.{self.name}"

    @property
    def entry_point(self) -> bool:
        return (self.kind == "Sub" and self.scope == "Public" and self.required_params == 0
                and self.module_kind in ("standard", "document"))

    @property
    def event(self) -> str:
        """What makes Excel run this by itself, or "" for an ordinary procedure."""
        if self.kind != "Sub":
            return ""
        n = self.name
        if self.module_kind == "document" and re.match(r"(?i)(Workbook|Worksheet|Chart)_[A-Za-z]+$", n):
            return n.split("_", 1)[1]
        if self.module_kind in ("document", "form") and re.match(
                r"(?i)\w+_(Click|DblClick|Change|BeforeUpdate|AfterUpdate|Initialize|Terminate|"
                r"Activate|Deactivate|Enter|Exit|KeyPress|KeyDown|KeyUp|QueryClose)$", n):
            return n.rsplit("_", 1)[1]
        if self.module_kind == "standard" and re.match(r"(?i)Auto_(Open|Close)$", n):
            return n.split("_", 1)[1]
        return ""


# ---- extraction (oletools) -----------------------------------------------------

def extract_modules(path: str) -> list:
    """Every VBA module in the workbook at ``path`` (empty list if no macros)."""
    try:
        from oletools.olevba import VBA_Parser
    except ImportError as ex:  # pragma: no cover - environment-specific
        raise RuntimeError("oletools is not installed — run `pip3 install oletools`") from ex
    parser = VBA_Parser(path)
    try:
        if not parser.detect_vba_macros():
            return []
        mods, seen = [], set()
        for _fname, _stream, vba_filename, code in parser.extract_macros():
            m = module_from_source(vba_filename, code)
            if m.name not in seen:
                seen.add(m.name)
                mods.append(m)
        return mods
    finally:
        parser.close()


def module_from_source(filename: str, code) -> Module:
    if isinstance(code, bytes):
        code = code.decode("latin-1")
    code = code.replace("\r\n", "\n").replace("\r", "\n")
    name = re.sub(r"\.(bas|cls|frm)$", "", filename or "", flags=re.I)
    base, body = "", []
    for ln in code.split("\n"):
        m = re.match(r'\s*Attribute\s+VB_Name\s*=\s*"([^"]+)"', ln, re.I)
        if m:
            name = m.group(1)
            continue
        m = re.match(r'\s*Attribute\s+VB_Base\s*=\s*"([^"]+)"', ln, re.I)
        if m:
            base = m.group(1)
            continue
        if re.match(r"\s*Attribute\s+\w+", ln, re.I):
            continue
        body.append(ln)
    ext = (filename or "").lower().rsplit(".", 1)[-1]
    if ext == "bas":
        kind = "standard"
    elif ext == "frm":
        kind = "form"
    elif "00020819" in base or "00020820" in base:
        kind = "document"      # ThisWorkbook / a sheet's own code
    else:
        kind = "class"
    text = "\n".join(body).strip("\n")
    header = [ln for ln in text.split("\n") if not re.match(r"\s*Option\s", ln, re.I)]
    return Module(name, kind, text, _leading_comment(header))


# ---- parsing ------------------------------------------------------------------

_DECL = re.compile(r"^\s*(?:(Public|Private|Friend)\s+)?(?:Static\s+)?"
                   r"(Sub|Function|Property\s+(?:Get|Let|Set))\s+([A-Za-z_]\w*)", re.I)
_END = re.compile(r"^\s*End\s+(Sub|Function|Property)\b", re.I)
_OTHER_DIALOGS = [
    (re.compile(r"\bVBA\s*\.\s*MsgBox\b", re.I), "VBA.MsgBox"),
    (re.compile(r"\bVBA\s*\.\s*InputBox\b", re.I), "VBA.InputBox"),
    (re.compile(r"\bApplication\s*\.\s*InputBox\b", re.I), "Application.InputBox"),
    (re.compile(r"\bGetOpenFilename\b", re.I), "file picker (GetOpenFilename)"),
    (re.compile(r"\bGetSaveAsFilename\b", re.I), "save dialog (GetSaveAsFilename)"),
    (re.compile(r"\bFileDialog\b", re.I), "FileDialog"),
    (re.compile(r"\bApplication\s*\.\s*Dialogs\b", re.I), "Application.Dialogs"),
    (re.compile(r"\.\s*Show\b(?!\w)", re.I), "a UserForm (.Show)"),
]
_MSGBOX = re.compile(r"(?<![.\w])MsgBox\b", re.I)
_INPUTBOX = re.compile(r"(?<![.\w])InputBox\b", re.I)
_CONSTS = {"vbcrlf": "\n", "vblf": "\n", "vbcr": "\n", "vbnewline": "\n", "vbtab": "\t"}
_SECRET_LINE = re.compile(r"(?i)pass\s*word|passwd|pwd|\bpass\b|\b(un)?protect\b|secret|"
                          r"api_?key|\btoken\b")


def logical_lines(code: str) -> list:
    """Source lines with ``_`` line-continuations joined."""
    out, buf = [], ""
    for ln in code.split("\n"):
        s = ln.rstrip()
        if s.endswith(" _") or s == "_":
            buf += s[:-1] + " "
            continue
        out.append(buf + ln)
        buf = ""
    if buf:
        out.append(buf)
    return out


def _string_end(line: str, i: int) -> int:
    """Index just past the string literal that opens at ``line[i]`` ('"')."""
    j, n = i + 1, len(line)
    while j < n:
        if line[j] == '"':
            if j + 1 < n and line[j + 1] == '"':
                j += 2
                continue
            return j + 1
        j += 1
    return n


def code_only(line: str) -> str:
    """The line with string literals blanked (to ``""``) and any comment removed."""
    out, i, n = [], 0, len(line)
    while i < n:
        ch = line[i]
        if ch == '"':
            out.append('""')
            i = _string_end(line, i)
            continue
        if ch == "'":
            break
        if (line[i:i + 4].lower() == "rem " or line[i:].lower() == "rem") and (
                i == 0 or line[i - 1] in " :\t"):
            break
        out.append(ch)
        i += 1
    return "".join(out)


def redact_secrets(code: str) -> str:
    """Replace every non-empty string literal with "***" on lines that look like
    they hold a password (``PROT_PWD = "…"``, ``.Unprotect "…"`` …). Comments
    and empty strings are left as they are."""
    out = []
    for ln in code.split("\n"):
        if _SECRET_LINE.search(code_only(ln)):
            ln = _blank_literals(ln)
        out.append(ln)
    return "\n".join(out)


def _blank_literals(line: str) -> str:
    out, i, n = [], 0, len(line)
    while i < n:
        ch = line[i]
        if ch == '"':
            j = _string_end(line, i)
            out.append(line[i:j] if j - i <= 2 else '"***"')
            i = j
            continue
        if ch == "'":
            out.append(line[i:])    # the rest is a comment
            break
        out.append(ch)
        i += 1
    return "".join(out)


def _split_args(line: str, start: int) -> list:
    """Top-level comma-separated arguments of a call whose name ends at ``start``
    (handles both ``F(a, b)`` and statement form ``F a, b``)."""
    i, n = start, len(line)
    while i < n and line[i] == " ":
        i += 1
    paren = i < n and line[i] == "("
    if paren:
        i += 1
    args, cur, depth = [], "", 0
    while i < n:
        ch = line[i]
        if ch == '"':
            j = _string_end(line, i)
            cur += line[i:j]
            i = j
            continue
        if ch == "'" and not paren:
            break
        if ch == "(":
            depth += 1
        elif ch == ")":
            if depth == 0:
                break
            depth -= 1
        elif ch == "," and depth == 0:
            args.append(cur.strip())
            cur = ""
            i += 1
            continue
        elif ch == ":" and depth == 0 and not paren:
            break
        cur += ch
        i += 1
    if cur.strip():
        args.append(cur.strip())
    return args


def literal_text(expr: str) -> str:
    """Readable text of a VBA string expression: literals kept, vbCrLf -> newline,
    anything computed -> "…"."""
    parts = []
    for m in re.finditer(r'"((?:[^"]|"")*)"|([A-Za-z_][\w.$]*(?:\([^()]*\))?)', expr or ""):
        if m.group(1) is not None:
            parts.append(m.group(1).replace('""', '"'))
        else:
            tok = m.group(2)
            if tok.lower() in _CONSTS:
                parts.append(_CONSTS[tok.lower()])
            elif tok.lower() not in ("and", "or"):
                parts.append("…")
    return re.sub(r"(…)+", "…", "".join(parts)).strip()


def _required_params(params: str) -> int:
    if not params.strip():
        return 0
    return sum(1 for p in _split_args("(" + params + ")", 0)
               if p.strip() and not re.match(r"(?i)(optional|paramarray)\b", p.strip()))


def _params_of(line: str, name_end: int) -> str:
    i = line.find("(", name_end)
    if i < 0 or line[name_end:i].strip():
        return ""
    depth = 0
    for j in range(i, len(line)):
        if line[j] == "(":
            depth += 1
        elif line[j] == ")":
            depth -= 1
            if depth == 0:
                return line[i + 1:j]
    return line[i + 1:]


def _leading_comment(lines: list) -> str:
    """The comment block at the top of ``lines`` (separators like '=====' dropped)."""
    out = []
    for ln in lines:
        s = ln.strip()
        if not s:
            if out:
                break
            continue
        if not s.startswith("'"):
            break
        t = s.lstrip("'").strip()
        if t and not re.fullmatch(r"[-=*_~#]+", t):
            out.append(t)
    return " ".join(out)[:400]


def parse_procs(mod: Module) -> list:
    """Every procedure in a module, with its body and direct dialog usage."""
    lines = logical_lines(mod.code)
    private_module = any(re.match(r"\s*Option\s+Private\s+Module", ln, re.I) for ln in lines)
    procs, cur, pending = [], None, []
    for ln in lines:
        if cur is None:
            m = _DECL.match(code_only(ln))
            if m:
                scope = "Private" if private_module else (m.group(1) or "Public").capitalize()
                if scope == "Friend":
                    scope = "Public"
                params = " ".join(_params_of(ln, m.end(3)).split())   # no literal precedes the name
                cur = Proc(mod.name, mod.kind, m.group(3), m.group(2).split()[0].capitalize(),
                           scope, params, _required_params(params),
                           description=_leading_comment(pending))
                pending = []
                continue
            s = ln.strip()
            if s.startswith("'"):
                pending.append(ln)
            elif s:
                pending = []
            continue
        if _END.match(code_only(ln)):
            if not cur.description:
                cur.description = _leading_comment(cur.body)
            procs.append(cur)
            cur = None
            continue
        cur.body.append(ln)
    for p in procs:
        _scan_dialogs(p)
    return procs


def _scan_dialogs(p: Proc) -> None:
    for ln in p.body:
        code = code_only(ln)
        for rx, label in _OTHER_DIALOGS:
            if rx.search(code) and label not in p.other_dialogs:
                p.other_dialogs.append(label)
        p.msgbox += len(_MSGBOX.findall(code))
        for m in _INPUTBOX.finditer(code):
            p.inputbox += 1
            args = _split_args(ln, _locate_in_raw(ln, m.end()))
            p.prompts.append({
                "prompt": literal_text(args[0]) if args else "",
                "title": literal_text(args[1]) if len(args) > 1 else "",
                "default": args[2] if len(args) > 2 else "",
            })


def _locate_in_raw(raw: str, code_pos: int) -> int:
    """Map a position in ``code_only(raw)`` back to ``raw`` (literals are two
    quotes there, so offsets drift after the first one)."""
    ci = ri = 0
    while ri < len(raw) and ci < code_pos:
        if raw[ri] == '"':
            ri = _string_end(raw, ri)
            ci += 2
            continue
        ri += 1
        ci += 1
    return ri


def analyse(modules: list) -> list:
    """All procedures across modules, with calls resolved and dialog usage
    rolled up through everything each procedure calls."""
    procs = [p for m in modules for p in parse_procs(m)]
    by_name = {}
    for p in procs:
        by_name.setdefault(p.name.lower(), []).append(p)

    for p in procs:
        seen = []
        for ln in p.body:
            for tok in re.findall(r"[A-Za-z_]\w*", code_only(ln)):
                t = tok.lower()
                if t == p.name.lower() or t not in by_name:
                    continue
                same = [q for q in by_name[t] if q.module == p.module]
                target = (same or [q for q in by_name[t] if q.scope == "Public"] or [None])[0]
                if target is not None and target.qualified not in seen:
                    seen.append(target.qualified)
        p.calls = seen

    index = {p.qualified: p for p in procs}

    def rollup(p, stack):
        mb, ib = p.msgbox, p.inputbox
        other, prompts = list(p.other_dialogs), list(p.prompts)
        for q in p.calls:
            if q in stack or q not in index:
                continue
            a, b, c, d = rollup(index[q], stack | {q})
            mb, ib = mb + a, ib + b
            other += [x for x in c if x not in other]
            prompts += d
        return mb, ib, other, prompts

    for p in procs:
        p.total = rollup(p, {p.qualified})
    return procs


def button_target(macro_ref: str) -> str:
    """"[0]!PrintBillPDFs" / "'Book.xlsm'!Module1.X" -> "PrintBillPDFs" / "Module1.X"."""
    return (macro_ref or "").split("!")[-1].strip().strip("'")


def catalog(modules: list, buttons: list | None = None, sheet_of: dict | None = None) -> dict:
    """Everything the report says about the macros, JSON-ready.

    ``buttons`` are the workbook's macro buttons ({sheet, text, macro});
    ``sheet_of`` maps a document module's code name ("Sheet46") to its sheet."""
    buttons = buttons or []
    sheet_of = sheet_of or {}
    procs = analyse(modules)

    def base(p):
        mb, ib, other, prompts = p.total
        return {"name": p.qualified, "module": p.module, "proc": p.name,
                "module_kind": p.module_kind, "sheet": sheet_of.get(p.module, ""),
                "description": p.description, "msgbox": mb, "inputbox": ib,
                "other_dialogs": other, "prompts": prompts, "calls": p.calls}

    entry, events = [], []
    for p in procs:
        if p.event:
            events.append({**base(p), "event": p.event})
        elif p.entry_point:
            btns = [b for b in buttons if button_target(b.get("macro", "")) in (p.name, p.qualified)]
            entry.append({**base(p), "buttons": [{"sheet": b.get("sheet"), "text": b.get("text")}
                                                 for b in btns]})
    entry.sort(key=lambda d: (not d["buttons"], d["module"].lower(), d["proc"].lower()))
    events.sort(key=lambda d: (d["module"].lower(), d["proc"].lower()))
    helpers = [{"name": p.qualified, "kind": p.kind, "scope": p.scope, "params": p.params.strip(),
                "description": p.description, "calls": p.calls}
               for p in procs if not p.event and not p.entry_point]
    return {"entry_points": entry, "events": events, "helpers": helpers}

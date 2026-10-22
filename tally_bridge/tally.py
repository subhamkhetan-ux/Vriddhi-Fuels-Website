"""Tally XML protocol. All accounting amounts use Decimal, never float."""
import copy
import datetime as dt
import html
import re
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from html.parser import HTMLParser

from defusedxml import ElementTree as SafeET

from .transport import ConnectionProblem

SERIES = {
    "hsd": ("HSD CREDIT", "High Speed Diesel", "SALE (HSD)"),
    "ms": ("MS CREDIT", "Motor Spirit", "SALE (MS)"),
    "xg": ("XG CREDIT", "XtraGreen Diesel", "SALE (HSD)"),
}
# Only the app's own fuel vouchers are watched. Masters and history arrive through
# the web app's "Import from Tally" files, exactly as before the bridge.
KINDS = ("Voucher",)
FUEL_FILTER = "(" + " OR ".join('$VoucherTypeName = "%s"' % s[0] for s in SERIES.values()) + ")"
META = ("GUID", "MasterID", "AlterID", "VoucherNumber", "VoucherTypeName", "Date", "IsCancelled", "IsOptional")
REPORTS = {"daybook": "Day Book", "ledger": "Ledger Vouchers", "trial_balance": "Trial Balance",
           "balance_sheet": "Balance Sheet", "profit_loss": "Profit and Loss", "receivables": "Bills Receivable",
           "payables": "Bills Payable", "stock": "Stock Summary", "cash_bank": "Cash/Bank Summary"}


class TallyProblem(RuntimeError):
    pass


class CompanyNotOpen(TallyProblem):
    """Tally answers, but the paired company is not loaded (Select Company, or another company)."""


def decimal(value):
    s = str(value).strip().replace(",", "")
    m = re.match(r"^(-?\d+(?:\.\d+)?)", s)
    if not m:
        raise TallyProblem("Tally returned an invalid accounting amount")
    return Decimal(m[1])


def amount(value, places=2):
    return format(Decimal(str(value)).quantize(Decimal(10) ** -places, rounding=ROUND_HALF_UP), f".{places}f")


def parse(raw):
    if isinstance(raw, bytes):
        raw = raw.decode("utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig")
    if re.search(r"<!\s*(DOCTYPE|ENTITY)", raw, re.I):
        raise TallyProblem("Unsafe XML response")
    def clean_ref(m):
        n = int(m[1], 16) if m[1] else int(m[2])
        return m[0] if n in (9, 10, 13) or 32 <= n <= 0x10ffff and not 0xd800 <= n <= 0xdfff else ""
    raw = re.sub(r"&#(?:x([0-9a-f]+)|(\d+));", clean_ref, raw, flags=re.I)
    raw = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", raw)
    raw = re.sub(r"<\?xml[^>]*\?>", "", raw).strip()
    try:
        root = SafeET.fromstring('<ROOT xmlns:UDF="TallyUDF">' + raw + '</ROOT>')
    except Exception:
        raise TallyProblem("Incomplete or invalid Tally XML; no sync checkpoint was advanced") from None
    if root.find(".//LINEERROR") is not None or root.findtext(".//HEADER/STATUS") == "0":
        # Tally's own words ("Ledger 'X' does not exist!") are the useful part of a rejection.
        reason = " ".join(e.text.strip() for e in root.iter("LINEERROR") if e.text and e.text.strip())[:300]
        raise TallyProblem("Tally rejected the request" + (": " + reason if reason else "; check company access and report availability"))
    return root


def tag(parent, name, value, **attrs):
    node = ET.SubElement(parent, name, attrs)
    node.text = str(value)
    return node


def text(node, name, default=""):
    return (node.findtext(name) or default).strip()


def yes(value):
    return str(value).lower() in ("yes", "true", "1")


def ledger_gst(v, as_of=None):
    """Prime 3+ stores dated GST/mailing registrations in child lists."""
    day = (as_of or dt.date.today().isoformat()).replace("-", "")
    def applicable(path):
        entries = [e for e in v.findall(path) if text(e, "APPLICABLEFROM", "19000101").replace("-", "") <= day]
        return max(entries, key=lambda e: text(e, "APPLICABLEFROM", "19000101").replace("-", "")) if entries else v
    gst, mailing = applicable("LEDGSTREGDETAILS.LIST"), applicable("LEDMAILINGDETAILS.LIST")
    return dict(gstin=text(gst,"GSTIN",text(v,"PARTYGSTIN")), reg_type=text(gst,"GSTREGISTRATIONTYPE",text(v,"GSTREGISTRATIONTYPE")),
                state=text(mailing,"STATE",text(v,"LEDSTATENAME")), place_of_supply=text(gst,"PLACEOFSUPPLY",text(v,"PLACEOFSUPPLY")),
                pincode=text(mailing,"PINCODE",text(v,"PINCODE")), country=text(mailing,"COUNTRY",text(v,"COUNTRYNAME")))


def export_request(company, kind, methods="*", formula=None, since=None):
    if kind not in KINDS + ("Company", "Ledger", "StockItem", "VoucherType"):
        raise ValueError("Unknown Tally collection")
    e = ET.Element("ENVELOPE")
    h = ET.SubElement(e, "HEADER")
    for k, v in (("VERSION", 1), ("TALLYREQUEST", "Export"), ("TYPE", "Collection"), ("ID", "VFBridge")):
        tag(h, k, v)
    desc = ET.SubElement(ET.SubElement(e, "BODY"), "DESC")
    sv = ET.SubElement(desc, "STATICVARIABLES")
    tag(sv, "SVEXPORTFORMAT", "$$SysName:XML")
    if company:
        tag(sv, "SVCURRENTCOMPANY", company)
    # From `since` (else the whole book), independent of the period selected in the UI.
    tag(sv, "SVFROMDATE", since.strftime("%Y%m%d") if since else "19000101")
    tag(sv, "SVTODATE", "20991231")
    msg = ET.SubElement(ET.SubElement(desc, "TDL"), "TDLMESSAGE")
    col = ET.SubElement(msg, "COLLECTION", NAME="VFBridge", ISMODIFY="No")
    tag(col, "TYPE", kind)
    # One method per tag: the documented form, and an unknown method cannot hide the others.
    for method in ([methods] if isinstance(methods, str) else methods):
        tag(col, "NATIVEMETHOD", method)
    if formula:
        tag(col, "FILTERS", "VFBridgeFilter")
        tag(msg, "SYSTEM", formula, TYPE="Formulae", NAME="VFBridgeFilter")
    return ET.tostring(e, encoding="unicode")


def literal(value):
    """A TDL string literal. Tally formulae cannot escape a double quote."""
    value = str(value)
    if not value or '"' in value or re.search(r"[\x00-\x1f]", value) or len(value) > 250:
        raise TallyProblem("This name cannot be looked up safely in Tally: " + value[:60])
    return '"' + value + '"'


def describe(node):
    number = text(node, "VOUCHERNUMBER")
    kind = text(node, "VOUCHERTYPENAME", node.get("VCHTYPE", ""))
    if number:
        return (kind + " #" + number).strip()
    return node.get("NAME") or text(node, "NAME") or node.tag.title()


def identity(node):
    def number(name):
        raw = re.sub(r"[\s,]", "", text(node, name))
        return int(raw) if re.fullmatch(r"-?[0-9]+", raw) else 0
    guid, master, alter = text(node, "GUID"), number("MASTERID"), number("ALTERID")
    missing = [k for k, ok in (("GUID", guid), ("MasterID", master > 0), ("AlterID", alter > 0)) if not ok]
    if missing:
        raise TallyProblem("Tally did not supply " + ", ".join(missing) + " for " + describe(node)
                           + ". Sync is paused; open this voucher once in Tally Prime and save it.")
    return guid, master, alter


def business_equal(a, b):
    if not a or not b:
        return False
    for k in ("series", "number", "date"):
        if str(a.get(k, "")) != str(b.get(k, "")):
            return False
    # Tally stores its ledger's own spelling; names are case-insensitive there.
    if str(a.get("party", "")).casefold() != str(b.get("party", "")).casefold():
        return False
    # Some Tally releases leave UDFs out of collection exports; a blank read is not a different vehicle.
    if a.get("vehicle") and b.get("vehicle") and a["vehicle"] != b["vehicle"]:
        return False
    try:
        return all(Decimal(str(a[k])) == Decimal(str(b[k])) for k in ("qty", "rate", "item_amt", "party_amt", "roff"))
    except (KeyError, InvalidOperation):
        return False


def filled(node, name):
    """Real list entries; Tally exports empty placeholders such as <BILLALLOCATIONS.LIST>  </...>."""
    return [e for e in node.findall(name) if len(e) or (e.text or "").strip()]


def entries(v, *names):
    # Invoice exports use LEDGERENTRIES/ALLINVENTORYENTRIES, accounting views the ALL* lists.
    # Some releases emit both copies of the same entries, so read the first filled one.
    return next((found for name in names if (found := filled(v, name))), [])


def series_of(v):
    vt = text(v, "VOUCHERTYPENAME", v.get("VCHTYPE", ""))
    return next((k for k, s in SERIES.items() if s[0] == vt), None)


def fuel_voucher(v):
    """The fuel fields the app shows, read from any HSD/MS/XG CREDIT voucher in Tally."""
    sk = series_of(v)
    if sk is None or yes(text(v, "ISCANCELLED")) or yes(text(v, "ISOPTIONAL")) or yes(text(v, "ISDELETED")):
        return None
    inv = entries(v, "ALLINVENTORYENTRIES.LIST", "INVENTORYENTRIES.LIST")
    led = entries(v, "LEDGERENTRIES.LIST", "ALLLEDGERENTRIES.LIST")
    if len(inv) != 1 or text(inv[0], "STOCKITEMNAME") != SERIES[sk][1]:
        return None
    party = text(v, "PARTYLEDGERNAME")
    party_entries = [e for e in led if text(e, "LEDGERNAME") == party]
    if len(party_entries) != 1 or any(text(e, "LEDGERNAME") not in (party, "R/off") for e in led):
        return None
    try:
        qty = decimal(text(inv[0], "BILLEDQTY") or text(inv[0], "ACTUALQTY"))
        if qty <= 0:
            return None
        item = decimal(text(inv[0], "AMOUNT"))
        total = -decimal(text(party_entries[0], "AMOUNT"))
        rate = decimal(text(inv[0], "RATE"))
        roff = sum((decimal(text(e, "AMOUNT")) for e in led if text(e, "LEDGERNAME") == "R/off"), Decimal(0))
        if abs(total - item - roff) > Decimal("0.01"):
            return None
        date = dt.datetime.strptime(text(v, "DATE").replace("-", ""), "%Y%m%d").date().isoformat()
    except (ValueError, TallyProblem, InvalidOperation):
        return None
    vehicle = text(v, ".//{TallyUDF}EIVEHNO") or text(v, "BASICSHIPVEHICLENO")
    return dict(series=sk, number=text(v, "VOUCHERNUMBER"), date=date, party=party,
                vehicle=vehicle, qty=amount(qty, 3), rate=amount(rate),
                item_amt=amount(item), party_amt=amount(total), roff=amount(roff))


def alterable(v):
    """Altering replaces the ledger and inventory lists, so allow it only when nothing else lives there."""
    sk = series_of(v)
    if fuel_voucher(v) is None:
        return False
    if any(filled(e, t) for e in v.iter() for t in ("BILLALLOCATIONS.LIST", "COSTCENTREALLOCATIONS.LIST",
                                                    "BANKALLOCATIONS.LIST", "CATEGORYALLOCATIONS.LIST")):
        return False
    inv = entries(v, "ALLINVENTORYENTRIES.LIST", "INVENTORYENTRIES.LIST")[0]
    alloc, batches = filled(inv, "ACCOUNTINGALLOCATIONS.LIST"), filled(inv, "BATCHALLOCATIONS.LIST")
    return (len(alloc) == 1 and text(alloc[0], "LEDGERNAME") == SERIES[sk][2] and len(batches) == 1
            and text(batches[0], "GODOWNNAME") == "Main Location" and text(batches[0], "BATCHNAME") == "Primary Batch")


def compact(v):
    """A copy without Tally's hundreds of empty fields; every value and list entry is kept."""
    v = copy.deepcopy(v)
    def prune(node):
        for child in list(node):
            prune(child)
            if not len(child) and not (child.text or "").strip() and not child.attrib:
                node.remove(child)
    prune(v)
    return v


def object_data(kind, v):
    guid, master, alter = identity(v)
    if kind != "Voucher":
        raise ValueError("Only vouchers are synchronised")
    data = {"xml": ET.tostring(compact(v), encoding="unicode"), "number": text(v, "VOUCHERNUMBER"),
            "party": text(v, "PARTYLEDGERNAME"), "date": text(v, "DATE"),
            "voucher_type": text(v, "VOUCHERTYPENAME", v.get("VCHTYPE", "")),
            "cancelled": any(yes(text(v, k)) for k in ("ISCANCELLED", "ISOPTIONAL", "ISDELETED")),
            "app_voucher": fuel_voucher(v)}
    return dict(kind=kind, guid=guid, master_id=master, alter_id=alter, data=data)


def voucher_date(v):
    try:
        return dt.datetime.strptime(text(v, "DATE").replace("-", ""), "%Y%m%d").date()
    except ValueError:
        raise TallyProblem("Tally did not supply a date for " + describe(v)) from None


def voucher_xml(company, p, existing=None):
    """Accounting structure matches tally/index.html's verified fuel exporter."""
    vt, item, sales = SERIES[p["series"]]
    # A new invoice is created exactly like the verified web XML; Tally assigns its GUID.
    v = ET.Element("VOUCHER", VCHTYPE=vt, ACTION="Alter" if existing is not None else "Create",
                   OBJVIEW="Invoice Voucher View")
    g, party = p.get("gst") or {}, p["party"]
    state = g.get("state") or "Odisha"
    fields = {"DATE": p["date"].replace("-", ""), "EFFECTIVEDATE": p["date"].replace("-", ""),
              "GSTREGISTRATIONTYPE": g.get("reg_type") or "Unregistered/Consumer", "STATENAME": state,
              "COUNTRYOFRESIDENCE": g.get("country") or "India", "PLACEOFSUPPLY": g.get("place_of_supply") or state,
              "VOUCHERTYPENAME": vt, "VOUCHERNUMBER": p["number"], "PARTYNAME": party,
              "CMPGSTIN": "21AATFV8250A1Z8", "PARTYLEDGERNAME": party, "CMPGSTREGISTRATIONTYPE": "Regular",
              "PARTYMAILINGNAME": party, "CONSIGNEEMAILINGNAME": party, "CONSIGNEESTATENAME": state,
              "CMPGSTSTATE": "Odisha", "CONSIGNEECOUNTRYNAME": g.get("country") or "India",
              "BASICBASEPARTYNAME": party, "BASICBUYERNAME": party, "PERSISTEDVIEW": "Invoice Voucher View",
              "VCHENTRYMODE": "Item Invoice", "ISINVOICE": "Yes"}
    for k, val in fields.items():
        tag(v, k, val)
    tag(v, "GSTREGISTRATION", "Odisha Registration", TAXTYPE="GST", TAXREGISTRATION="21AATFV8250A1Z8")
    if g.get("gstin"):
        tag(v, "PARTYGSTIN", g["gstin"])
        tag(v, "CONSIGNEEGSTIN", g["gstin"])
    if g.get("pincode"):
        tag(v, "PARTYPINCODE", g["pincode"])
        tag(v, "CONSIGNEEPINCODE", g["pincode"])
    def ledger(name, value, party_entry=False):
        e = ET.SubElement(v, "LEDGERENTRIES.LIST")
        for k, val in (("LEDGERNAME", name), ("ISDEEMEDPOSITIVE", "Yes" if Decimal(str(value)) < 0 else "No"),
                       ("ISPARTYLEDGER", "Yes" if party_entry else "No"), ("AMOUNT", amount(value))):
            tag(e, k, val)
    ledger(party, -Decimal(str(p["party_amt"])), True)
    if Decimal(str(p["roff"])):
        ledger("R/off", p["roff"])
    inv = ET.SubElement(v, "ALLINVENTORYENTRIES.LIST")
    for k, val in (("STOCKITEMNAME", item), ("ISDEEMEDPOSITIVE", "No"), ("RATE", amount(p["rate"]) + "/LTR"),
                   ("AMOUNT", amount(p["item_amt"])), ("ACTUALQTY", amount(p["qty"], 3) + " LTR"), ("BILLEDQTY", amount(p["qty"], 3) + " LTR")):
        tag(inv, k, val)
    batch = ET.SubElement(inv, "BATCHALLOCATIONS.LIST")
    for k, val in (("GODOWNNAME", "Main Location"), ("BATCHNAME", "Primary Batch"), ("AMOUNT", amount(p["item_amt"])),
                   ("ACTUALQTY", amount(p["qty"], 3) + " LTR"), ("BILLEDQTY", amount(p["qty"], 3) + " LTR")):
        tag(batch, k, val)
    allocation = ET.SubElement(inv, "ACCOUNTINGALLOCATIONS.LIST")
    for k, val in (("LEDGERNAME", sales), ("ISDEEMEDPOSITIVE", "No"), ("AMOUNT", amount(p["item_amt"]))):
        tag(allocation, k, val)
    if p.get("vehicle"):
        udf = ET.SubElement(v, "{TallyUDF}EIVEHNO.LIST", DESC="`EiVehNo`", ISLIST="YES", TYPE="String", INDEX="120")
        tag(udf, "{TallyUDF}EIVEHNO", p["vehicle"], DESC="`EiVehNo`")
    if existing is not None:
        original = copy.deepcopy(existing)
        if not alterable(original):
            raise TallyProblem("This voucher has bill-wise, cost-centre or batch details the fuel editor cannot safely alter. Edit it in Tally Prime.")
        # Tally's own REMOTEID/VCHKEY/GUID identify the voucher being altered.
        original.set("ACTION", "Alter")
        replace = {e.tag for e in v} | {"ALLLEDGERENTRIES.LIST", "INVENTORYENTRIES.LIST",
                    "{TallyUDF}EIVEHNO.LIST", "PARTYGSTIN", "CONSIGNEEGSTIN", "PARTYPINCODE", "CONSIGNEEPINCODE"}
        for e in list(original):
            if e.tag in replace:
                original.remove(e)
        original.extend(list(v))
        v = original
    env = ET.Element("ENVELOPE")
    tag(ET.SubElement(env, "HEADER"), "TALLYREQUEST", "Import Data")
    imp = ET.SubElement(ET.SubElement(env, "BODY"), "IMPORTDATA")
    desc = ET.SubElement(imp, "REQUESTDESC")
    tag(desc, "REPORTNAME", "Vouchers")
    tag(ET.SubElement(desc, "STATICVARIABLES"), "SVCURRENTCOMPANY", company)
    ET.SubElement(ET.SubElement(imp, "REQUESTDATA"), "TALLYMESSAGE").append(v)
    return ET.tostring(env, encoding="unicode")


class ReportSanitizer(HTMLParser):
    # Keep readable tables only. No links, external images, styles, scripts or handlers.
    allowed = {"table", "thead", "tbody", "tfoot", "tr", "td", "th", "p", "br", "b", "strong", "i", "em",
               "h1", "h2", "h3", "h4", "div", "span", "pre", "hr"}
    blocked = {"script", "style", "iframe", "object", "svg", "math", "form", "head"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.depth = [], 0

    def handle_starttag(self, name, attrs):
        if name in self.blocked:
            self.depth += 1
        if self.depth or name not in self.allowed:
            return
        safe = ""
        for k, v in attrs:
            if k in ("colspan", "rowspan") and v and v.isdigit() and 1 <= int(v) <= 100:
                safe += f' {k}="{int(v)}"'
        self.out.append("<" + name + safe + ">")

    def handle_endtag(self, name):
        if name in self.blocked:
            self.depth = max(0, self.depth - 1)
            return
        if not self.depth and name in self.allowed:
            self.out.append("</" + name + ">")

    def handle_data(self, data):
        if not self.depth:
            self.out.append(html.escape(data))


def sanitize_report(raw):
    if isinstance(raw, bytes):
        raw = raw.decode("utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig")
    if re.search(r"<LINEERROR|<STATUS>0|<RESPONSE>", raw, re.I) or not re.search(r"<(html|table)\b", raw, re.I):
        raise TallyProblem("This Tally report did not return HTML. Check its availability in Tally Prime.")
    parser = ReportSanitizer()
    parser.feed(raw)
    result = "".join(parser.out)
    if not re.sub(r"<[^>]*>", "", result).strip():
        raise TallyProblem("Tally returned an empty report")
    if len(result) > 2_000_000:
        raise TallyProblem("Report too large; select a shorter date range")
    return result


class Tally:
    def __init__(self, transport, company, guid=None, clock=None):
        import time
        self.transport, self.company, self.guid = transport, company, guid
        self.clock = clock or time.monotonic
        self.cache = {}  # masters seen present and party GST, for half an hour

    def voucher_mark(self):
        """The company's voucher alteration counter ($AltVchId): one tiny request that
        tells whether any voucher changed, so idle polls never scan the voucher list.
        None when this Tally release does not report it."""
        try:
            root = parse(self.transport.post(export_request(None, "Company", ["Name", "AltVchId"])))
        except TallyProblem:
            return None
        for c in root.findall(".//COMPANY"):
            if text(c, "NAME", c.get("NAME", "")) == self.company:
                raw = re.sub(r"[\s,]", "", text(c, "ALTVCHID"))
                return int(raw) if raw.isdigit() else None
        return None

    def cached(self, key):
        hit = self.cache.get(key)
        return hit[1] if hit and self.clock() - hit[0] < 1800 else None

    def remember(self, key, value):
        self.cache[key] = (self.clock(), value)
        return value

    def companies(self):
        root = parse(self.transport.post(export_request(None, "Company", "Name,GUID,BooksFrom")))
        if root.find(".//COLLECTION") is None:
            raise TallyProblem("Tally XML server did not return a company collection")
        found = [{"name": text(c, "NAME", c.get("NAME", "")), "guid": text(c, "GUID")} for c in root.findall(".//COMPANY")]
        return [c for c in found if c["name"]]  # Tally can list a blank placeholder entry

    def startup_number(self):
        """Optional discovery; unsupported TDL is never needed for ordinary sync."""
        request = ET.fromstring(export_request(self.company, "Company", "Name,GUID"))
        col = request.find(".//COLLECTION")
        tag(col, "COMPUTE", "VFBRIDGECOMPANYNUMBER:@@SetCmpNumStr")
        root = parse(self.transport.post(ET.tostring(request, encoding="unicode")))
        for company in root.findall(".//COMPANY"):
            if text(company, "NAME", company.get("NAME", "")) == self.company and text(company, "GUID") == self.guid:
                value = text(company, "VFBRIDGECOMPANYNUMBER").strip().strip("()").strip()
                if re.fullmatch(r"[0-9]{1,9}", value) and int(value) > 0:
                    return value
        return None

    def verify(self):
        matches = [c for c in self.companies() if c["name"] == self.company]
        if len(matches) != 1 or not matches[0]["guid"]:
            raise CompanyNotOpen("Open the exact company configured in the web app's Settings")
        if self.guid and matches[0]["guid"] != self.guid:
            raise TallyProblem("Company GUID changed. Sync paused for restore or financial-year review.")
        return matches[0]

    def collection(self, kind, methods="*", formula=None, identities=True, since=None):
        root = parse(self.transport.post(export_request(self.company, kind, methods, formula, since)))
        col = root.find(".//COLLECTION")
        if col is None:
            raise TallyProblem("Tally did not return a complete collection")
        values = col.findall(kind.upper())
        if identities:
            ids = [identity(v)[0] for v in values]
            if len(ids) != len(set(ids)):
                raise TallyProblem("Tally returned duplicate identities; sync paused")
        return values

    def metadata(self, kind="Voucher", after=0, since=None):
        """Fuel vouchers dated on or after `since` (all when None), changed after AlterID `after`."""
        formula = FUEL_FILTER + (" AND $AlterID > " + str(int(after)) if after else "")
        found = self.collection(kind, META, formula, since=since)
        # Should a Tally release ignore the period, older vouchers are still left alone.
        return [v for v in found if since is None or voucher_date(v) >= since]

    def by_guid(self, guids):
        """Metadata of particular vouchers, whatever their date (a 'Use Tally version' refresh)."""
        if not guids:
            return []
        return self.collection("Voucher", META, " OR ".join("$GUID = " + literal(g) for g in guids))

    def daybook(self, start, end):
        """Tally's Day Book export: the same complete vouchers as a Day Book XML file.
        A collection export with NativeMethod * omits ledger and inventory lines."""
        env = ET.Element("ENVELOPE")
        tag(ET.SubElement(env, "HEADER"), "TALLYREQUEST", "Export Data")
        desc = ET.SubElement(ET.SubElement(ET.SubElement(env, "BODY"), "EXPORTDATA"), "REQUESTDESC")
        tag(desc, "REPORTNAME", "Day Book")
        sv = ET.SubElement(desc, "STATICVARIABLES")
        for k, val in (("SVCURRENTCOMPANY", self.company), ("SVFROMDATE", start.strftime("%Y%m%d")),
                       ("SVTODATE", end.strftime("%Y%m%d")), ("SVEXPORTFORMAT", "$$SysName:XML")):
            tag(sv, k, val)
        return list(parse(self.transport.post(ET.tostring(env, encoding="unicode"))).iter("VOUCHER"))

    def details(self, entries):
        """Complete vouchers for these metadata entries, one Day Book read per date."""
        wanted = {identity(e)[0] for e in entries}
        found = {}
        for day in sorted({voucher_date(e) for e in entries}, reverse=True):
            for v in self.daybook(day, day):
                if text(v, "GUID") in wanted:
                    found[text(v, "GUID")] = v
        return list(found.values())

    def missing(self, kind, names, fresh=False):
        """Which of these masters Tally lacks. Masters are read live, never mirrored.
        Tally names are case-insensitive, like its own voucher import."""
        names = [n for n in names if fresh or not self.cached((kind, n.casefold()))]
        if not names:
            return []
        try:
            formula = " OR ".join("$Name = " + literal(n) for n in names)
        except TallyProblem:
            formula = None  # a quote in a name: compare against the full list instead
        found = {(n.get("NAME") or text(n, "NAME")).casefold() for n in self.collection(kind, "Name", formula, False)}
        for n in names:
            if n.casefold() in found:
                self.remember((kind, n.casefold()), True)
        return [n for n in names if n.casefold() not in found]

    def missing_masters(self, p):
        vt, item, sales = SERIES[p["series"]]
        wanted = {"Ledger": [p["party"], sales] + (["R/off"] if Decimal(str(p["roff"])) else []),
                  "StockItem": [item], "VoucherType": [vt]}
        return [n for kind, names in wanted.items() for n in self.missing(kind, names)]

    def party_gst(self, party, as_of):
        """The party's GST registration on the invoice date, or None to keep the app's copy."""
        key = ("gst", party.casefold(), as_of)
        if (hit := self.cached(key)) is not None:
            return hit or None
        try:
            ledgers = self.collection("Ledger", "*", "$Name = " + literal(party), identities=False)
        except TallyProblem:
            return None
        return self.remember(key, ledger_gst(ledgers[0], as_of) if len(ledgers) == 1 else {}) or None

    def lookup(self, p):
        """The Tally invoice with this voucher's GUID, or the same type and number."""
        vt = SERIES[p["series"]][0]
        clauses = ["($VoucherTypeName = " + literal(vt) + " AND $VoucherNumber = " + literal(p["number"]) + ")"]
        if p.get("guid"):
            clauses.append("$GUID = " + literal(p["guid"]))
        # A new invoice is looked for from its own date; a linked one, whose date may have
        # been edited, across the book.
        since = None if p.get("guid") else dt.date.fromisoformat(p["date"])
        candidates = self.collection("Voucher", META, " OR ".join(clauses), since=since)
        if len(candidates) > 1:
            raise TallyProblem("Multiple invoices match " + vt + " #" + p["number"] + ". Review duplicates in Tally Prime.")
        if not candidates:
            return None
        records = self.details(candidates)
        if len(records) != 1:
            raise TallyProblem("Invoice changed during lookup; try again after the next sync")
        expected, actual = identity(candidates[0]), identity(records[0])
        if actual[:2] != expected[:2] or actual[2] < expected[2]:
            raise TallyProblem("Invoice identity or version changed during lookup; posting is blocked")
        return records[0]

    def import_voucher(self, p, existing=None):
        self.verify()
        root = parse(self.transport.post(voucher_xml(self.company, p, existing)))
        if int(root.findtext(".//ERRORS") or "0") or int(root.findtext(".//CANCELLED") or "0"):
            raise TallyProblem("Tally rejected the voucher; review its ledgers and voucher type")
        expected = "ALTERED" if existing is not None else "CREATED"
        if int(root.findtext(".//" + expected) or "0") != 1:
            raise TallyProblem("Tally did not confirm one voucher; reconciliation is required")

    def report(self, p):
        self.verify()
        if p["report"] == "ledger":
            # A renamed/deleted ledger must not silently fall back to Tally's selected ledger.
            if self.missing("Ledger", [p["ledger"]], fresh=True):
                raise TallyProblem("The requested ledger is no longer available in this Tally company. Check the ledger's current name in Tally Prime.")
        report = REPORTS[p["report"]]
        start, end = dt.date.fromisoformat(p["from"]), dt.date.fromisoformat(p["to"])
        if end < start:
            raise ValueError("Invalid dates")
        env = ET.Element("ENVELOPE")
        h = ET.SubElement(env, "HEADER")
        for k, val in (("VERSION", 1), ("TALLYREQUEST", "Export"), ("TYPE", "Data"), ("ID", report)):
            tag(h, k, val)
        sv = ET.SubElement(ET.SubElement(ET.SubElement(env, "BODY"), "DESC"), "STATICVARIABLES")
        for k, val in (("SVCURRENTCOMPANY", self.company), ("SVFROMDATE", start.strftime("%Y%m%d")),
                       ("SVTODATE", end.strftime("%Y%m%d")), ("SVEXPORTFORMAT", "$$SysName:HTML")):
            tag(sv, k, val)
        if p["report"] == "ledger":
            tag(sv, "LEDGERNAME", p["ledger"])
            tag(sv, "SVLEDGERNAME", p["ledger"])
        return sanitize_report(self.transport.post(ET.tostring(env, encoding="unicode")))

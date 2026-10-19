"""Tally XML protocol. All accounting amounts use Decimal, never float."""
import copy
import datetime as dt
import html
import re
import uuid
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
KINDS = ("Group", "Ledger", "StockGroup", "StockItem", "Unit", "Godown", "VoucherType", "CostCentre", "Currency", "Voucher")
REPORTS = {"daybook": "Day Book", "ledger": "Ledger Vouchers", "trial_balance": "Trial Balance",
           "balance_sheet": "Balance Sheet", "profit_loss": "Profit and Loss", "receivables": "Bills Receivable",
           "payables": "Bills Payable", "stock": "Stock Summary", "cash_bank": "Cash/Bank Summary"}


class TallyProblem(RuntimeError):
    pass


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
        raise TallyProblem("Tally rejected the request; check company access and report availability")
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


def export_request(company, kind, methods="*", formula=None):
    if kind not in KINDS + ("Company",):
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
    # Read the entire company's book, independent of the period selected in the UI.
    tag(sv, "SVFROMDATE", "19000101")
    tag(sv, "SVTODATE", "20991231")
    msg = ET.SubElement(ET.SubElement(desc, "TDL"), "TDLMESSAGE")
    col = ET.SubElement(msg, "COLLECTION", NAME="VFBridge", ISMODIFY="No")
    tag(col, "TYPE", kind)
    tag(col, "NATIVEMETHOD", methods)
    if formula:
        tag(col, "FILTERS", "VFBridgeFilter")
        tag(msg, "SYSTEM", formula, TYPE="Formulae", NAME="VFBridgeFilter")
    return ET.tostring(e, encoding="unicode")


def identity(node):
    guid = text(node, "GUID")
    master = int(text(node, "MASTERID", "0"))
    alter = int(text(node, "ALTERID", "0"))
    if not guid or master < 1 or alter < 1:
        raise TallyProblem("Tally did not supply GUID, MasterID and AlterID; sync is paused")
    return guid, master, alter


def business_equal(a, b):
    if not a or not b:
        return False
    for k in ("series", "number", "date", "party", "vehicle"):
        if str(a.get(k, "")) != str(b.get(k, "")):
            return False
    try:
        return all(Decimal(str(a[k])) == Decimal(str(b[k])) for k in ("qty", "rate", "item_amt", "party_amt", "roff"))
    except (KeyError, InvalidOperation):
        return False


def fuel_voucher(v):
    """Only map vouchers the web editor can represent WITHOUT dropping allocations."""
    vt = text(v, "VOUCHERTYPENAME", v.get("VCHTYPE", ""))
    sk = next((k for k, s in SERIES.items() if s[0] == vt), None)
    if sk is None or yes(text(v, "ISCANCELLED")) or yes(text(v, "ISOPTIONAL")):
        return None
    inv = v.findall("ALLINVENTORYENTRIES.LIST") + v.findall("INVENTORYENTRIES.LIST")
    led = v.findall("LEDGERENTRIES.LIST") + v.findall("ALLLEDGERENTRIES.LIST")
    if len(inv) != 1 or text(inv[0], "STOCKITEMNAME") != SERIES[sk][1]:
        return None
    # Bill-wise/cost-centre/bank allocations need an editor that understands them.
    if any(v.find(".//" + t) is not None for t in ("BILLALLOCATIONS.LIST", "COSTCENTREALLOCATIONS.LIST", "BANKALLOCATIONS.LIST")):
        return None
    party = text(v, "PARTYLEDGERNAME")
    party_entries = [e for e in led if text(e, "LEDGERNAME") == party]
    if len(party_entries) != 1 or any(text(e, "LEDGERNAME") not in (party, "R/off") for e in led):
        return None
    alloc = inv[0].findall("ACCOUNTINGALLOCATIONS.LIST")
    batches = inv[0].findall("BATCHALLOCATIONS.LIST")
    if len(alloc) != 1 or text(alloc[0], "LEDGERNAME") != SERIES[sk][2] or len(batches) != 1:
        return None
    if text(batches[0], "GODOWNNAME") != "Main Location" or text(batches[0], "BATCHNAME") != "Primary Batch":
        return None
    try:
        qty = decimal(text(inv[0], "BILLEDQTY"))
        if "LTR" not in text(inv[0], "BILLEDQTY").upper() or qty <= 0:
            return None
        item = decimal(text(inv[0], "AMOUNT"))
        total = -decimal(text(party_entries[0], "AMOUNT"))
        rate = decimal(text(inv[0], "RATE"))
        roff = sum((decimal(text(e, "AMOUNT")) for e in led if text(e, "LEDGERNAME") == "R/off"), Decimal(0))
        # The web app supports amount-driven sales, rounding quantity to 3 decimals.
        if abs(total - item - roff) > Decimal("0.01") or abs(qty * rate - item) > abs(rate) * Decimal("0.0005") + Decimal("0.011"):
            return None
        date = dt.datetime.strptime(text(v, "DATE").replace("-", ""), "%Y%m%d").date().isoformat()
    except (ValueError, TallyProblem, InvalidOperation):
        return None
    return dict(series=sk, number=text(v, "VOUCHERNUMBER"), date=date, party=party,
                vehicle=text(v, ".//{TallyUDF}EIVEHNO"), qty=amount(qty, 3), rate=amount(rate),
                item_amt=amount(item), party_amt=amount(total), roff=amount(roff))


def object_data(kind, v):
    guid, master, alter = identity(v)
    data = {"name": text(v, "NAME", v.get("NAME", text(v,"ORIGINALNAME"))), "parent": text(v, "PARENT"),
            "xml": ET.tostring(v, encoding="unicode")}
    if kind == "Voucher":
        data.update(number=text(v, "VOUCHERNUMBER"), party=text(v, "PARTYLEDGERNAME"),
                    date=text(v, "DATE"), voucher_type=text(v, "VOUCHERTYPENAME", v.get("VCHTYPE", "")),
                    remote_id=text(v, "REMOTEID", v.get("REMOTEID", "")),
                    cancelled=yes(text(v, "ISCANCELLED")), app_voucher=fuel_voucher(v))
    elif kind == "Ledger":
        data.update(ledger_gst(v), closing_balance=text(v, "CLOSINGBALANCE"))
    elif kind == "StockItem":
        data.update(closing_balance=text(v, "CLOSINGBALANCE"), closing_value=text(v, "CLOSINGVALUE"), unit=text(v, "BASEUNITS"))
    return dict(kind=kind, guid=guid, master_id=master, alter_id=alter, data=data)


def voucher_xml(company, p, existing=None):
    """Accounting structure matches tally/index.html's verified fuel exporter."""
    vt, item, sales = SERIES[p["series"]]
    guid = p.get("guid") or str(uuid.UUID(p["id"]))
    if not re.fullmatch(r"[a-zA-Z0-9-]{8,128}", guid):
        raise TallyProblem("Invalid voucher identity")
    v = ET.Element("VOUCHER", VCHTYPE=vt, ACTION="Alter" if existing is not None else "Create",
                   OBJVIEW="Invoice Voucher View", REMOTEID=p["id"])
    g, party = p.get("gst") or {}, p["party"]
    state = g.get("state") or "Odisha"
    fields = {"GUID": guid, "DATE": p["date"].replace("-", ""), "EFFECTIVEDATE": p["date"].replace("-", ""),
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
        if fuel_voucher(original) is None:
            raise TallyProblem("This voucher has allocations the fuel editor cannot safely alter. Edit in Tally Prime.")
        original.set("ACTION", "Alter")
        original.set("TAGNAME", "GUID")
        original.set("TAGVALUE", guid)
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
    raw = raw.decode("utf-8-sig") if isinstance(raw, bytes) else raw
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
    def __init__(self, transport, company, guid=None):
        self.transport, self.company, self.guid = transport, company, guid

    def companies(self):
        root = parse(self.transport.post(export_request(None, "Company", "Name,GUID,BooksFrom")))
        if root.find(".//COLLECTION") is None:
            raise TallyProblem("Tally XML server did not return a company collection")
        return [{"name": text(c, "NAME", c.get("NAME", "")), "guid": text(c, "GUID")}
                for c in root.findall(".//COMPANY")]

    def verify(self):
        matches = [c for c in self.companies() if c["name"] == self.company]
        if len(matches) != 1 or not matches[0]["guid"]:
            raise TallyProblem("Open the exact company configured in the web app's Settings")
        if self.guid and matches[0]["guid"] != self.guid:
            raise TallyProblem("Company GUID changed. Sync paused for restore or financial-year review.")
        return matches[0]

    def collection(self, kind, methods="*", formula=None):
        root = parse(self.transport.post(export_request(self.company, kind, methods, formula)))
        col = root.find(".//COLLECTION")
        if col is None:
            raise TallyProblem("Tally did not return a complete collection")
        values = col.findall(kind.upper())
        ids = [identity(v)[0] for v in values]
        if len(ids) != len(set(ids)):
            raise TallyProblem("Tally returned duplicate identities; sync paused")
        return values

    def metadata(self, kind, after=0):
        return self.collection(kind, "GUID,MasterID,AlterID,VoucherNumber,VoucherTypeName,RemoteID",
                               "$AlterID > " + str(int(after)) if after else None)

    def objects(self, kind, ids):
        return self.collection(kind, "*", " OR ".join("$MasterID = " + str(int(i)) for i in ids)) if ids else []

    def lookup(self, p):
        # A fresh identity read also catches invoices created manually with the same number.
        entries = self.metadata("Voucher")
        vt = SERIES[p["series"]][0]
        candidates = [v for v in entries if text(v, "GUID") == p.get("guid", p["id"])
                      or text(v, "REMOTEID", v.get("REMOTEID", "")) == p["id"]
                      or (text(v, "VOUCHERNUMBER") == p["number"] and text(v, "VOUCHERTYPENAME", v.get("VCHTYPE", "")) == vt)]
        if len(candidates) > 1:
            raise TallyProblem("Multiple invoices match this identity. Review duplicates in Tally Prime.")
        if not candidates:
            return None
        records = self.objects("Voucher", [identity(candidates[0])[1]])
        if len(records) != 1:
            raise TallyProblem("Invoice changed during lookup; try again after the next sync")
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
            tag(sv, "SVLEDGERNAME", p["ledger"])
        return sanitize_report(self.transport.post(ET.tostring(env, encoding="unicode")))

"""payments/consignment_note_template.pdf: the firm's blank consignment note,
with the serial and the Place of Origin erased — payments/consignment_pdf.js
writes both on every note (the FY's VF/CNyyyy/ prefix, the chosen terminal).
If the form is replaced, it must keep the labels and drop those two values,
or a printed note would carry a hidden second serial / terminal."""
import os

import pytest

pymupdf = pytest.importorskip("pymupdf")

TEMPLATE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "payments", "consignment_note_template.pdf")


def test_template_has_the_form_but_not_the_values_the_app_writes():
    doc = pymupdf.open(TEMPLATE)
    assert len(doc) == 1
    text = " ".join(doc[0].get_text().split())
    for label in ("CONSIGNMENT NOTE", "Consignment Note Sl. No.", "(Place of Origin) :",
                  "Name of the Consignee : VRIDDHI FUELS", "Quantity (KL)", "Value of Goods: Rs.",
                  "Signature of the Authorised Person with Rubber Seal"):
        assert label in text, label
    assert "VF/CN" not in text                          # the serial is written by the app
    assert "Jharsuguda Terminal" not in text            # so is the Place of Origin
    assert "Place of Destination : Jharsuguda (Vriddhi Fuels)." in text   # this one stays

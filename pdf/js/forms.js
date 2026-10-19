// Fill & flatten forms: list every AcroForm field, fill it in, save.

import { PDFLib, readBytes, baseName, out, loadPdf } from "./lib.js";
import { h, toast, withBusy, reportError } from "./ui.js";

export async function mount(el, { files, done, restart }) {
  const file = files[0];
  const bytes = await readBytes(file);
  const doc = await loadPdf(bytes);
  const form = doc.getForm();
  const fields = form.getFields();
  const panel = h("div", { class: "panel" });
  el.append(panel);
  if (!fields.length) {
    panel.append(h("h2", {}, "No form fields found"),
      h("p", { class: "help" }, "This PDF has no fillable fields. To type onto it anyway, use Edit PDF or Sign PDF."),
      h("div", { class: "toolbar" },
        h("a", { class: "btn", href: "#/tool/edit" }, "Open Edit PDF"),
        h("button", { class: "btn ghost", type: "button", onclick: restart }, "Choose another file")));
    return;
  }
  const getters = [];
  const rows = fields.map((f) => {
    const name = f.getName();
    let input;
    if (f instanceof PDFLib.PDFTextField) {
      const multi = f.isMultiline();
      input = h(multi ? "textarea" : "input", { type: multi ? null : "text", style: "width:100%" });
      input.value = f.getText() || "";
      getters.push(() => f.setText(input.value));
    } else if (f instanceof PDFLib.PDFCheckBox) {
      input = h("input", { type: "checkbox" });
      input.checked = f.isChecked();
      getters.push(() => (input.checked ? f.check() : f.uncheck()));
    } else if (f instanceof PDFLib.PDFDropdown || f instanceof PDFLib.PDFOptionList) {
      input = h("select", { style: "width:100%" }, h("option", { value: "" }, "—"), f.getOptions().map((o) => h("option", { value: o }, o)));
      input.value = f.getSelected()[0] || "";
      getters.push(() => input.value ? f.select(input.value) : f.clear());
    } else if (f instanceof PDFLib.PDFRadioGroup) {
      input = h("select", { style: "width:100%" }, h("option", { value: "" }, "—"), f.getOptions().map((o) => h("option", { value: o }, o)));
      input.value = f.getSelected() || "";
      getters.push(() => input.value ? f.select(input.value) : f.clear());
    } else {
      input = h("span", { class: "help" }, f.constructor.name.replace("PDF", "") + " (not editable here)");
    }
    if (f.isReadOnly?.()) input.disabled = true;
    return h("tr", {}, h("td", {}, name), h("td", {}, input));
  });
  const flatten = h("input", { type: "checkbox" });
  const save = h("button", { class: "btn big", type: "button" }, "Save PDF →");
  save.onclick = async () => {
    try {
      const res = await withBusy("Saving form…", async () => {
        for (const g of getters) {
          try { g(); } catch (e) { throw new Error("A value uses characters this form's font can't show: " + e.message); }
        }
        if (flatten.checked) form.flatten();
        return doc.save({ useObjectStreams: true });
      });
      done([out(baseName(file.name) + (flatten.checked ? "_filled_flat.pdf" : "_filled.pdf"), res)]);
    } catch (e) { reportError(e); }
  };
  panel.append(h("h2", { style: "margin-top:0" }, `${fields.length} form field${fields.length > 1 ? "s" : ""}`),
    h("table", { class: "formtable" }, rows),
    h("label", { class: "check", style: "margin-top:14px" }, flatten, h("span", {}, "Flatten after filling (fields become permanent page content)")),
    save);
}

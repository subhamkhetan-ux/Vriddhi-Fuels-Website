// Workflows: chain PDF→PDF tools and run the chain over many files.

import { TOOLS, toolById } from "./tools.js";
import { readBytes, baseName, out } from "./lib.js";
import { h, toast, withBusy, subCtx, defaults, renderForm, pickFiles, reportError, Cancelled } from "./ui.js";

const STEP_TOOLS = TOOLS.filter((t) => t.transform);
const store = {
  get() { try { return JSON.parse(localStorage.getItem("pdftk.workflows")) || {}; } catch { return {}; } },
  set(v) { try { localStorage.setItem("pdftk.workflows", JSON.stringify(v)); } catch {} },
};
const PRESETS = {
  "Scan cleanup": [["ocr", {}], ["compress", {}]],
  "Share safely": [["compress", {}], ["watermark", { text: "CONFIDENTIAL" }], ["protect", {}]],
  "Archive": [["repair", {}], ["ocr", {}], ["pdf-to-pdfa", {}]],
};

export async function mount(el, { files, done }) {
  let steps = [];
  const addStep = (id, vals = {}) => {
    const t = toolById(id);
    // file-type options (images) can't be saved, so they start empty
    steps.push({ id, values: { ...defaults(t.options), ...vals } });
  };
  addStep("compress");

  const fileList = h("div", {});
  const stepsBox = h("div", {});
  const side = h("div", { class: "panel side" });
  el.append(h("div", { class: "layout" }, h("div", { class: "panel" }, h("h2", { style: "margin-top:0" }, "Steps"), stepsBox), side));

  function drawSteps() {
    stepsBox.innerHTML = "";
    steps.forEach((s, i) => {
      const t = toolById(s.id);
      const sel = h("select", {}, STEP_TOOLS.map((x) => h("option", { value: x.id }, x.name)));
      sel.value = s.id;
      sel.onchange = () => { s.id = sel.value; s.values = defaults(toolById(s.id).options); drawSteps(); };
      stepsBox.append(h("div", { class: "step" },
        h("div", { class: "step-h" }, h("b", {}, `${i + 1}.`), sel,
          h("button", { class: "btn ghost small", type: "button", title: "Move up", disabled: i === 0 || null, onclick: () => { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; drawSteps(); } }, "↑"),
          h("button", { class: "btn ghost small", type: "button", title: "Remove", onclick: () => { steps.splice(i, 1); drawSteps(); } }, "×")),
        t.options?.length ? renderForm(t.options, s.values) : h("p", { class: "help" }, "No options.")));
    });
    const add = h("select", {}, h("option", { value: "" }, "+ Add a step…"), STEP_TOOLS.map((x) => h("option", { value: x.id }, x.name)));
    add.onchange = () => { if (add.value) { addStep(add.value); drawSteps(); } };
    stepsBox.append(add);
    if (steps.some((s, i) => s.id === "protect" && i < steps.length - 1)) stepsBox.append(h("p", { class: "err" }, "“Protect PDF” should be the last step — later steps can't open an encrypted file."));
  }

  function drawSide() {
    side.innerHTML = "";
    side.append(h("h2", {}, "Files"));
    fileList.innerHTML = "";
    files.forEach((f, i) => fileList.append(h("div", { class: "step-h" }, h("span", { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px" }, f.name),
      h("button", { class: "btn ghost small", type: "button", onclick: () => { files.splice(i, 1); drawSide(); } }, "×"))));
    side.append(fileList, h("button", { class: "btn ghost small", type: "button", onclick: async () => { files.push(...(await pickFiles({ accept: ".pdf,application/pdf", multiple: true }))); drawSide(); } }, "+ Add files"));

    side.append(h("h2", { style: "margin-top:18px" }, "Saved workflows"));
    const saved = store.get();
    const all = { ...Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v])), ...saved };
    side.append(h("div", { class: "toolbar" }, Object.keys(all).map((name) =>
      h("button", { class: "btn ghost small", type: "button", onclick: () => { steps = []; all[name].forEach(([id, v]) => addStep(id, v)); drawSteps(); } }, name))));
    side.append(h("button", { class: "btn ghost small", type: "button", onclick: () => {
      const name = prompt("Name this workflow:");
      if (!name) return;
      const s = store.get();
      s[name] = steps.map((st) => [st.id, Object.fromEntries(Object.entries(st.values).filter(([, v]) => !(v instanceof File)))]);
      store.set(s);
      toast("Workflow saved on this device.");
      drawSide();
    } }, "💾 Save current workflow"));

    const run = h("button", { class: "btn big", type: "button", style: "width:100%;margin-top:16px" }, `Run on ${files.length} file${files.length === 1 ? "" : "s"} →`);
    run.disabled = !files.length || !steps.length;
    run.onclick = execute;
    side.append(run);
  }

  async function execute() {
    let notes = [];
    try {
      const outputs = await withBusy("Running workflow…", async (ctx) => {
        notes = ctx.notes;
        const res = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          try {
            let bytes = await readBytes(f);
            for (let k = 0; k < steps.length; k++) {
              const t = toolById(steps[k].id);
              const c = subCtx(ctx, i * steps.length + k, files.length * steps.length, `${f.name} · ${t.name}`);
              c.progress(0, "");
              bytes = await t.transform(bytes, { ...steps[k].values, __name: f.name }, c);
            }
            res.push(out(baseName(f.name) + "_processed.pdf", bytes));
          } catch (e) {
            if (e instanceof Cancelled || files.length === 1) throw e;
            ctx.note(`${f.name}: ${e.message}`);
          }
        }
        if (!res.length) throw new Error(ctx.notes.join("\n") || "Nothing was produced.");
        return res;
      });
      done(outputs, { notes });
    } catch (e) { reportError(e); }
  }

  drawSteps();
  drawSide();
}

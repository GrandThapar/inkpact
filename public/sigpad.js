// Shared signature pad: Draw / Type / Upload. Used by the signer page and the admin "My signatures".
// root must contain: .tabs (buttons with data-t), canvas, .hint, .clear button, input[type=file]
export function sigPad({ root, nameInput, onError = () => {} }) {
  const pad = root.querySelector("canvas"), ctx = pad.getContext("2d");
  const hintEl = root.querySelector(".hint"), fileIn = root.querySelector("input[type=file]");
  const tabs = [...root.querySelectorAll(".tabs button")];
  let mode = "draw", drawn = false, drawing = false, last;
  const hints = { draw: "Draw your signature here", upload: "Tap here to upload a photo of your signature" };
  const pos = (e) => { const r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height }; };

  function clear() {
    ctx.clearRect(0, 0, pad.width, pad.height); drawn = false;
    hintEl.textContent = hints[mode] || ""; hintEl.style.display = hints[mode] ? "" : "none";
    fileIn.value = "";
    if (mode === "type") typeSig();
  }
  async function typeSig() {
    await document.fonts.load('600 80px "SignFont"');
    ctx.clearRect(0, 0, pad.width, pad.height);
    const name = (nameInput?.value || "").trim();
    if (!name) { drawn = false; return; }
    let size = 86; ctx.font = `600 ${size}px "SignFont"`;
    while (ctx.measureText(name).width > pad.width - 40 && size > 30) { size -= 4; ctx.font = `600 ${size}px "SignFont"`; }
    ctx.fillStyle = "#0b2a5b"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(name, pad.width / 2, pad.height / 2 + 6);
    drawn = true;
  }

  pad.addEventListener("click", () => { if (mode === "upload" && !drawn) fileIn.click(); });
  // Upload: crop to the ink, remove the paper background, fit into the pad.
  fileIn.onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const img = new Image();
    img.src = URL.createObjectURL(f);
    try { await img.decode(); } catch { return onError("Could not read that image"); }
    const s = Math.min(1, 1400 / Math.max(img.width, img.height));
    const w = Math.round(img.width * s), h = Math.round(img.height * s);
    const oc = document.createElement("canvas"); oc.width = w; oc.height = h;
    const o = oc.getContext("2d"); o.fillStyle = "#fff"; o.fillRect(0, 0, w, h); o.drawImage(img, 0, 0, w, h);
    const d = o.getImageData(0, 0, w, h), px = d.data;
    let sum = 0; for (let i = 0; i < px.length; i += 4) sum += (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11);
    const thr = Math.min(190, sum / (px.length / 4) - 45);
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, lum = px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11;
      if (lum < thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; px[i + 3] = 255; }
      else px[i + 3] = 0;
    }
    if (x1 <= x0 || y1 <= y0) return onError("Couldn't find a signature in that image – try a clearer photo on white paper");
    o.putImageData(d, 0, 0);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1, m = 16;
    const k = Math.min((pad.width - 2 * m) / cw, (pad.height - 2 * m) / ch);
    ctx.clearRect(0, 0, pad.width, pad.height);
    ctx.drawImage(oc, x0, y0, cw, ch, (pad.width - cw * k) / 2, (pad.height - ch * k) / 2, cw * k, ch * k);
    hintEl.style.display = "none"; onError(""); drawn = true;
  };
  pad.addEventListener("pointerdown", (e) => { if (mode !== "draw") return; drawing = true; last = pos(e); pad.setPointerCapture(e.pointerId); hintEl.style.display = "none"; });
  pad.addEventListener("pointermove", (e) => {
    if (!drawing) return; const p = pos(e);
    ctx.strokeStyle = "#0b2a5b"; ctx.lineWidth = 3.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; drawn = true;
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => pad.addEventListener(ev, () => (drawing = false)));
  root.querySelector(".clear").onclick = (e) => { e.preventDefault(); clear(); };
  nameInput?.addEventListener("input", () => mode === "type" && typeSig());
  tabs.forEach((b) => b.onclick = (e) => {
    e.preventDefault();
    tabs.forEach((x) => x.classList.toggle("on", x === b));
    mode = b.dataset.t; clear();
  });

  return {
    has: () => drawn,
    mode: () => mode,
    dataURL: () => pad.toDataURL("image/png"),
    reset: () => { tabs[0].click(); },
    missingMsg: () => ({ draw: "Please draw your signature", type: "Please type your name", upload: "Please upload your signature" }[mode]),
  };
}

// Markup helper so both pages use the same structure
export const PAD_HTML = `
  <div class="tabs"><button class="on" data-t="draw">Draw</button><button data-t="type">Type</button><button data-t="upload">Upload</button></div>
  <input type="file" accept="image/*" class="hidden">
  <div class="pad">
    <canvas width="600" height="250"></canvas>
    <div class="hint">Draw your signature here</div>
    <button class="btn sm ghost clear">Clear</button>
  </div>`;

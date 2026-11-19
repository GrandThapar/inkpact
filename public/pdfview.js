// Renders every page of a PDF into a container. Returns array of page wrapper elements.
import * as pdfjs from "/vendor/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";

export async function renderPdf(data, container) {
  container.innerHTML = "";
  const doc = await pdfjs.getDocument({ data }).promise;
  const out = [];
  const maxW = Math.min(container.clientWidth - 28, 820);
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = (maxW / base.width) * Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale });
    const wrap = document.createElement("div");
    wrap.className = "pg";
    wrap.style.width = maxW + "px";
    wrap.style.aspectRatio = `${base.width} / ${base.height}`;
    const c = document.createElement("canvas");
    c.width = vp.width; c.height = vp.height;
    wrap.appendChild(c);
    container.appendChild(wrap);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    wrap.dataset.ratio = base.height / base.width;
    out.push(wrap);
  }
  return out;
}

// Signature box size as fraction of page width (matches server: min(170pt, 32% width) on A4 ≈ 0.29)
export const BOX_W = 0.29, BOX_H_RATIO = 0.42;

export function placeMarker(wrap, fx, fy, text = "Sign here", cls = "") {
  let m = wrap.querySelector(".marker");
  if (!m) { m = document.createElement("div"); wrap.appendChild(m); }
  m.className = "marker " + cls;
  m.textContent = text;
  const ratio = Number(wrap.dataset.ratio) || 1.414;
  m.style.left = fx * 100 + "%";
  m.style.top = fy * 100 + "%";
  m.style.width = BOX_W * 100 + "%";
  m.style.height = (BOX_W * BOX_H_RATIO / ratio) * 100 + "%";
  return m;
}

// Core logic for Inkpact. Storage is injected so it runs on Netlify (Blobs) or locally.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import nodemailer from "nodemailer";
import crypto from "node:crypto";

const env = (k, d = "") => process.env[k] ?? d;

// ---------- helpers ----------
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const err = (msg, status = 400) => json({ error: msg }, status);
const newId = () => crypto.randomBytes(18).toString("base64url");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const nowIso = () => new Date().toISOString();
const ist = (iso) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
      }) + " IST"
    : "-";
// Standard PDF fonts only cover Latin-1; replace anything else so stamping never crashes.
const safe = (s) =>
  String(s ?? "")
    .replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/₹/g, "Rs.").replace(/…/g, "...")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function siteUrl(req) {
  return (env("SITE_URL") || env("URL") || new URL(req.url).origin).replace(/\/$/, "");
}

function isAdmin(req) {
  const pass = env("ADMIN_PASSWORD");
  const got = req.headers.get("x-admin-key") || "";
  if (!pass) return false;
  const a = Buffer.from(pass), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- email ----------
let transporter;
function mailer() {
  if (transporter) return transporter;
  if (env("SMTP_USER") && env("SMTP_PASS")) {
    const port = Number(env("SMTP_PORT", "465"));
    transporter = nodemailer.createTransport({
      host: env("SMTP_HOST", "smtp.gmail.com"),
      port,
      secure: port === 465,
      auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") },
    });
  } else {
    // Dev mode: no SMTP configured, just log the email.
    transporter = nodemailer.createTransport({ jsonTransport: true });
  }
  return transporter;
}

async function sendMail({ to, cc, subject, html, attachments }) {
  const fromName = env("FROM_NAME", "Inkpact");
  const fromAddr = env("SMTP_USER", "no-reply@example.com");
  const info = await mailer().sendMail({
    from: `"${fromName.replace(/"/g, "")}" <${fromAddr}>`,
    to, cc, subject, html, attachments,
  });
  if (!env("SMTP_USER")) console.log("[dev email]", subject, "->", to, cc ? `(cc ${cc})` : "");
  return info;
}

function emailShell(inner) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1f2937;line-height:1.55">
  ${inner}
  <p style="color:#9ca3af;font-size:12px;margin-top:28px">Sent via Inkpact</p></div>`;
}

const adminEmails = () => env("ADMIN_EMAIL").split(",").map((s) => s.trim()).filter(Boolean);

async function emailCandidateInvite(req, offer) {
  const link = `${siteUrl(req)}/sign.html?id=${offer.id}`;
  await sendMail({
    to: offer.candidateEmail,
    subject: `${offer.company} has sent you “${offer.role}” to sign`,
    html: emailShell(`
      <p>Dear ${esc(offer.candidateName)},</p>
      <p>${esc(offer.company)} has sent you <b>${esc(offer.role)}</b> for your signature.</p>
      ${offer.message ? `<p>${esc(offer.message).replace(/\n/g, "<br>")}</p>` : ""}
      <p>Please review the document and sign it online:</p>
      <p><a href="${link}" style="display:inline-block;background:#1D4E89;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Review &amp; Sign</a></p>
      <p style="font-size:13px;color:#6b7280">Or open this link: ${link}</p>
      <p>Regards,<br>${esc(env("FROM_NAME", offer.company))}</p>`),
  });
}

// ---------- PDF stamping ----------
// Draws a signature image + name + timestamp at a spot given as fractions of the page (top-left of box).
function stampOnPage(pages, { page: pIdx, x: fx, y: fy }, png, fonts, line1, line2) {
  const pIndex = Math.min(Math.max(pIdx ?? pages.length - 1, 0), pages.length - 1);
  const page = pages[pIndex];
  const { width, height } = page.getSize();
  const boxW = Math.min(170, width * 0.32);
  const boxH = boxW * (png.height / png.width);
  let x = fx * width, yTop = height - fy * height;
  x = Math.min(Math.max(x, 10), width - boxW - 10);
  yTop = Math.min(Math.max(yTop, boxH + 30), height - 10);
  page.drawImage(png, { x, y: yTop - boxH, width: boxW, height: boxH });
  page.drawLine({ start: { x, y: yTop - boxH - 2 }, end: { x: x + boxW, y: yTop - boxH - 2 }, thickness: 0.6, color: rgb(0.4, 0.4, 0.4) });
  page.drawText(safe(line1), { x, y: yTop - boxH - 13, size: 8.5, font: fonts.bold, color: rgb(0.1, 0.1, 0.1) });
  page.drawText(safe(line2), { x, y: yTop - boxH - 23, size: 7, font: fonts.font, color: rgb(0.35, 0.35, 0.35) });
}
const senderLabel = (s) => (s.designation ? `${s.name}, ${s.designation}` : s.name);

// Stamp the sender's own signature onto a PDF (before sending, or as a countersignature).
async function stampSender(bytes, offer, sigPng, when, certNote) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const fonts = { font: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
  const png = await pdf.embedPng(sigPng);
  const pages = pdf.getPages();
  const s = offer.senderSig;
  stampOnPage(pages, s, png, fonts, senderLabel(s), `Signed digitally: ${ist(when)}`);
  if (certNote) {
    // Countersign: add a block on the certificate page (last page)
    const cert = pages[pages.length - 1];
    let y = 220;
    cert.drawLine({ start: { x: 40, y: y + 16 }, end: { x: 555, y: y + 16 }, thickness: 0.3, color: rgb(0.85, 0.85, 0.85) });
    cert.drawText("Countersigned by", { x: 40, y, size: 9, font: fonts.bold, color: rgb(0.3, 0.3, 0.3) });
    cert.drawText(safe(senderLabel(s)), { x: 210, y, size: 9, font: fonts.font, color: rgb(0.1, 0.1, 0.1) });
    cert.drawText(safe(ist(when)), { x: 210, y: y - 12, size: 9, font: fonts.font, color: rgb(0.1, 0.1, 0.1) });
    const w = 140, h = w * (png.height / png.width);
    cert.drawImage(png, { x: 210, y: y - 20 - h, width: w, height: h });
  }
  return await pdf.save();
}

async function buildSignedPdf(offer, originalBytes, sig) {
  const pdf = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const png = await pdf.embedPng(sig.imageBytes);
  const pages = pdf.getPages();

  // Signer's signature on the chosen spot (default: bottom-right of last page)
  stampOnPage(pages, { page: offer.sigPage, x: offer.sigX ?? 0.6, y: offer.sigY ?? 0.8 }, png, { font, bold },
    sig.typedName, `Signed digitally: ${ist(sig.signedAt)}`);

  // Footer reference on every page
  for (const p of pages) {
    const { width: w } = p.getSize();
    const t = safe(`Digitally signed via Inkpact - Ref ${offer.id.slice(0, 10)}`);
    p.drawText(t, { x: w - font.widthOfTextAtSize(t, 6.5) - 18, y: 10, size: 6.5, font, color: rgb(0.55, 0.55, 0.55) });
  }

  // Signature certificate page
  const cert = pdf.addPage([595.28, 841.89]);
  const ink = rgb(0.11, 0.3, 0.54);
  let y = 790;
  cert.drawRectangle({ x: 0, y: 812, width: 595.28, height: 30, color: ink });
  cert.drawText("SIGNATURE CERTIFICATE", { x: 40, y: 822, size: 12, font: bold, color: rgb(1, 1, 1) });
  y = 775;
  cert.drawText(safe(offer.company), { x: 40, y, size: 16, font: bold, color: rgb(0.1, 0.1, 0.1) });
  y -= 18;
  cert.drawText(safe(offer.role), { x: 40, y, size: 11, font, color: rgb(0.35, 0.35, 0.35) });
  y -= 30;
  const rows = [
    ["Reference ID", offer.id],
    ["File", offer.fileName || "Document.pdf"],
    ["Original document SHA-256", offer.sha256],
    ["Signer name", offer.candidateName],
    ["Signer email", offer.candidateEmail],
    ["Sent", ist(offer.createdAt)],
    ["First viewed", ist(offer.viewedAt)],
    ["Signed", ist(sig.signedAt)],
    ["Name typed at signing", sig.typedName],
    ["Signer IP address", sig.ip || "-"],
    ["Signer device", (sig.userAgent || "-").slice(0, 90)],
  ];
  if (offer.senderSig?.mode === "before")
    rows.splice(5, 0, ["Sender signed (before sending)", `${senderLabel(offer.senderSig)} - ${ist(offer.senderSig.signedAt)}`]);
  for (const [k, v] of rows) {
    cert.drawText(safe(k), { x: 40, y, size: 9, font: bold, color: rgb(0.3, 0.3, 0.3) });
    const val = safe(v);
    // wrap at word boundaries to fit the value column; break very long tokens (hashes, ids)
    const chunks = [];
    for (const word of val.split(" ")) {
      const parts = word.match(/.{1,64}/g) || [""];
      for (const w of parts) {
        const lastC = chunks[chunks.length - 1];
        if (lastC !== undefined && font.widthOfTextAtSize(lastC + " " + w, 9) <= 340) chunks[chunks.length - 1] = lastC + " " + w;
        else chunks.push(w);
      }
    }
    if (!chunks.length) chunks.push("-");
    chunks.forEach((c, i) => cert.drawText(c, { x: 210, y: y - i * 12, size: 9, font, color: rgb(0.1, 0.1, 0.1) }));
    const lineY = y - 12 * (chunks.length - 1) - 7;
    cert.drawLine({ start: { x: 40, y: lineY }, end: { x: 555, y: lineY }, thickness: 0.3, color: rgb(0.85, 0.85, 0.85) });
    y = lineY - 15;
  }
  y -= 14;
  cert.drawText("Signature", { x: 40, y, size: 9, font: bold, color: rgb(0.3, 0.3, 0.3) });
  const sW = 200, sH = sW * (png.height / png.width);
  cert.drawRectangle({ x: 205, y: y - sH + 8, width: sW + 10, height: sH + 10, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.6 });
  cert.drawImage(png, { x: 210, y: y - sH + 13, width: sW, height: sH });
  y -= sH + 40;
  const note = [
    "The signer opened a unique link sent to the email address above, reviewed the document,",
    "confirmed they had read and accepted it, typed their full name and applied the signature shown.",
    "This certificate forms part of the signed document.",
  ];
  note.forEach((l, i) => cert.drawText(l, { x: 40, y: y - i * 13, size: 8.5, font, color: rgb(0.4, 0.4, 0.4) }));

  pdf.setTitle(`Signed - ${offer.role} - ${offer.candidateName}`);
  return await pdf.save();
}

async function emailFinalCopies(offer, bytes) {
  const fileName = `Signed - ${offer.role} - ${offer.candidateName}.pdf`;
  const attachments = [{ filename: fileName, content: Buffer.from(bytes), contentType: "application/pdf" }];
  await sendMail({
    to: offer.candidateEmail,
    subject: `Signed copy: ${offer.role} – ${offer.company}`,
    html: emailShell(`<p>Dear ${esc(offer.candidateName)},</p>
      <p>Thank you for signing <b>${esc(offer.role)}</b>. The fully signed copy is attached for your records.</p>
      <p>Regards,<br>${esc(env("FROM_NAME", offer.company))}</p>`),
    attachments,
  });
  const admins = adminEmails();
  if (admins.length)
    await sendMail({
      to: admins.join(","),
      subject: `✅ Signed: ${offer.candidateName} – ${offer.role} (${offer.company})`,
      html: emailShell(`<p><b>${esc(offer.candidateName)}</b> (${esc(offer.candidateEmail)}) has signed <b>${esc(offer.role)}</b> (${esc(offer.company)}) on ${ist(offer.signedAt)}.</p>
        ${offer.countersignedAt ? `<p>Countersigned by ${esc(senderLabel(offer.senderSig))} on ${ist(offer.countersignedAt)}.</p>` : ""}
        <p>The signed PDF with signature certificate is attached.</p>`),
      attachments,
    });
}

// ---------- routes ----------
export async function handle(req, ctx) {
  const { store, ip } = ctx;
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const m = req.method;

  const getOffer = (id) => store.get(`offer/${id}`, { type: "json" });
  const putOffer = (o) => store.setJSON(`offer/${o.id}`, o);

  try {
    // ---- admin ----
    if (parts[0] === "login" && m === "POST") return isAdmin(req) ? json({ ok: true }) : err("Wrong password", 401);

    // ---- my saved signatures ----
    if (parts[0] === "mysigs") {
      if (!isAdmin(req)) return err("Not authorised", 401);
      if (parts.length === 1 && m === "GET") {
        const { blobs } = await store.list({ prefix: "mysig/" });
        const sigs = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
        sigs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return json(sigs);
      }
      if (parts.length === 1 && m === "POST") {
        const body = await req.json();
        const name = String(body.name || "").trim(), designation = String(body.designation || "").trim();
        if (name.length < 2) return err("Please enter the signatory's name");
        if (!/^data:image\/png;base64,.+/.test(body.image || "")) return err("Please add the signature");
        if (body.image.length > 2_000_000) return err("Signature image too large");
        const sig = { id: newId(), name, designation, image: body.image, createdAt: nowIso() };
        await store.setJSON(`mysig/${sig.id}`, sig);
        return json(sig);
      }
      if (parts.length === 2 && m === "DELETE") { await store.delete(`mysig/${parts[1]}`); return json({ ok: true }); }
    }

    // ---- Word -> PDF conversion (CloudConvert) ----
    if (parts[0] === "convert") {
      if (!isAdmin(req)) return err("Not authorised", 401);
      const key = env("CLOUDCONVERT_API_KEY");
      if (!key) return err("Word upload is not switched on yet (CloudConvert key missing). Please upload a PDF for now.", 400);
      const cc = (path, opts = {}) =>
        fetch(`https://api.cloudconvert.com/v2${path}`, { ...opts, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(opts.headers || {}) } });
      if (parts.length === 1 && m === "POST") {
        const fd = await req.formData();
        const file = fd.get("file");
        if (!file || typeof file === "string") return err("No file received");
        const buf = Buffer.from(await file.arrayBuffer());
        if (buf.length > 5 * 1024 * 1024) return err("Word file is larger than 5 MB");
        const r = await cc("/jobs", {
          method: "POST",
          body: JSON.stringify({
            tasks: {
              "import-1": { operation: "import/base64", file: buf.toString("base64"), filename: file.name || "document.docx" },
              "convert-1": { operation: "convert", input: "import-1", output_format: "pdf" },
              "export-1": { operation: "export/url", input: "convert-1" },
            },
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return err("Conversion service error: " + (j.message || r.status), 502);
        return json({ jobId: j.data.id });
      }
      if (parts.length === 2 && m === "GET") {
        const r = await cc(`/jobs/${encodeURIComponent(parts[1])}`);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return err("Conversion service error: " + (j.message || r.status), 502);
        const job = j.data;
        if (job.status === "error") {
          const t = (job.tasks || []).find((t) => t.status === "error");
          return err("Could not convert this Word file" + (t?.message ? `: ${t.message}` : ""), 422);
        }
        if (job.status !== "finished") return json({ status: "processing" }, 202);
        const exp = (job.tasks || []).find((t) => t.operation === "export/url");
        const fileUrl = exp?.result?.files?.[0]?.url;
        if (!fileUrl) return err("Converted file not found", 502);
        const pdf = await fetch(fileUrl);
        return new Response(await pdf.arrayBuffer(), { headers: { "content-type": "application/pdf" } });
      }
    }

    if (parts[0] === "offers") {
      if (!isAdmin(req)) return err("Not authorised", 401);

      if (parts.length === 1 && m === "GET") {
        const { blobs } = await store.list({ prefix: "offer/" });
        const offers = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
        offers.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return json(offers);
      }

      if (parts.length === 1 && m === "POST") {
        const fd = await req.formData();
        const file = fd.get("pdf");
        const f = (k) => String(fd.get(k) || "").trim();
        if (!file || typeof file === "string") return err("Please attach the PDF");
        if (!f("candidateName") || !f("candidateEmail") || !f("company") || !f("role")) return err("Fill in all required fields");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f("candidateEmail"))) return err("Signer email looks wrong");
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length > 8 * 1024 * 1024) return err("PDF is larger than 8 MB");
        let pageCount;
        try { pageCount = (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount(); }
        catch { return err("That file is not a readable PDF"); }
        const num = (k, d) => (fd.get(k) !== null && fd.get(k) !== "" ? Number(fd.get(k)) : d);
        const offer = {
          id: newId(),
          candidateName: f("candidateName"),
          candidateEmail: f("candidateEmail").toLowerCase(),
          company: f("company"),
          role: f("role"),
          message: f("message"),
          fileName: file.name || "Document.pdf",
          sha256: sha256(bytes),
          pageCount,
          sigPage: num("sigPage", pageCount - 1),
          sigX: num("sigX", 0.6),
          sigY: num("sigY", 0.8),
          status: "sent",
          createdAt: nowIso(),
          history: [{ at: nowIso(), event: "Sent" }],
        };

        // Sender's own signature: before sending, or countersign after the signer signs
        const senderMode = f("senderMode");
        let sendBytes = bytes;
        if (senderMode === "before" || senderMode === "after") {
          const ms = await store.get(`mysig/${f("senderSigId")}`, { type: "json" });
          if (!ms) return err("Please choose your signature");
          const png = Buffer.from(ms.image.split(",")[1], "base64");
          offer.senderSig = {
            mode: senderMode, name: ms.name, designation: ms.designation,
            page: num("sPage", pageCount - 1), x: num("sX", 0.08), y: num("sY", 0.8),
          };
          await store.set(`ssig/${offer.id}`, png);
          if (senderMode === "before") {
            offer.senderSig.signedAt = nowIso();
            sendBytes = await stampSender(bytes, offer, png, offer.senderSig.signedAt, false);
            offer.history.push({ at: offer.senderSig.signedAt, event: `Signed by ${ms.name} before sending` });
          }
        }
        await store.set(`orig/${offer.id}`, bytes);
        await store.set(`pdf/${offer.id}`, sendBytes);
        await putOffer(offer);
        await emailCandidateInvite(req, offer);
        return json(offer);
      }

      const offer = await getOffer(parts[1]);
      if (!offer) return err("Document not found", 404);

      if (parts[2] === "resend" && m === "POST") {
        if (offer.status === "signed") return err("Already signed");
        await emailCandidateInvite(req, offer);
        offer.history.push({ at: nowIso(), event: "Reminder sent" });
        await putOffer(offer);
        return json(offer);
      }
      if (parts[2] === "countersign" && m === "POST") {
        if (offer.status !== "signed" || !offer.awaitingCountersign) return err("Nothing to countersign");
        const png = new Uint8Array(await store.get(`ssig/${offer.id}`, { type: "arrayBuffer" }));
        const signedBytes = new Uint8Array(await store.get(`signed/${offer.id}`, { type: "arrayBuffer" }));
        const at = nowIso();
        const final = await stampSender(signedBytes, offer, png, at, true);
        await store.set(`signed/${offer.id}`, final);
        offer.awaitingCountersign = false;
        offer.senderSig.signedAt = at;
        offer.countersignedAt = at;
        offer.signedSha256 = sha256(final);
        offer.history.push({ at, event: `Countersigned by ${offer.senderSig.name}` });
        await putOffer(offer);
        await emailFinalCopies(offer, final);
        return json(offer);
      }
      if (parts[2] === "cancel" && m === "POST") {
        if (offer.status === "signed") return err("Already signed – cannot cancel");
        offer.status = "cancelled";
        offer.history.push({ at: nowIso(), event: "Cancelled" });
        await putOffer(offer);
        return json(offer);
      }
      if (parts[2] === "pdf" && m === "GET") {
        const key = offer.status === "signed" ? `signed/${offer.id}` : `pdf/${offer.id}`;
        const data = await store.get(key, { type: "arrayBuffer" });
        return new Response(data, { headers: { "content-type": "application/pdf" } });
      }
      if (parts.length === 2 && m === "DELETE") {
        await Promise.all(["offer", "pdf", "signed", "orig", "ssig"].map((k) => store.delete(`${k}/${offer.id}`)));
        return json({ ok: true });
      }
    }

    // ---- candidate ----
    if (parts[0] === "sign" && parts[1]) {
      const offer = await getOffer(parts[1]);
      if (!offer) return err("This link is not valid", 404);

      if (parts.length === 2 && m === "GET") {
        if (!offer.viewedAt && offer.status === "sent") {
          offer.viewedAt = nowIso();
          offer.status = "viewed";
          offer.history.push({ at: offer.viewedAt, event: "Viewed by signer" });
          await putOffer(offer);
        }
        const { candidateName, company, role, status, signedAt, pageCount, sigPage, sigX, sigY, awaitingCountersign } = offer;
        return json({ candidateName, company, role, status, signedAt: ist(signedAt), pageCount, sigPage, sigX, sigY, awaitingCountersign: !!awaitingCountersign });
      }

      if (parts[2] === "pdf" && m === "GET") {
        const key = offer.status === "signed" ? `signed/${offer.id}` : `pdf/${offer.id}`;
        const data = await store.get(key, { type: "arrayBuffer" });
        return new Response(data, {
          headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${safe(offer.role)} - ${safe(offer.candidateName)}.pdf"` },
        });
      }

      if (parts.length === 2 && m === "POST") {
        if (offer.status === "signed") return err("This document is already signed");
        if (offer.status === "cancelled") return err("This document has been withdrawn");
        if (offer.status === "declined") return err("This document was declined");
        const body = await req.json();
        const typedName = String(body.typedName || "").trim();
        if (!body.agree) return err("Please tick the box to confirm");
        if (typedName.length < 2) return err("Please type your full name");
        const mt = /^data:image\/png;base64,(.+)$/.exec(body.signature || "");
        if (!mt) return err("Please add your signature");
        const imageBytes = Buffer.from(mt[1], "base64");
        if (imageBytes.length > 1_500_000) return err("Signature image too large");

        const sig = { typedName, imageBytes, signedAt: nowIso(), ip, userAgent: req.headers.get("user-agent") || "" };
        const original = new Uint8Array(await store.get(`pdf/${offer.id}`, { type: "arrayBuffer" }));
        const signed = await buildSignedPdf(offer, original, sig);
        await store.set(`signed/${offer.id}`, signed);

        offer.status = "signed";
        offer.signedAt = sig.signedAt;
        offer.signedName = typedName;
        offer.signerIp = ip;
        offer.signedSha256 = sha256(signed);
        offer.history.push({ at: sig.signedAt, event: "Signed by signer" });
        if (offer.senderSig?.mode === "after") offer.awaitingCountersign = true;
        await putOffer(offer);

        if (offer.awaitingCountersign) {
          await sendMail({
            to: offer.candidateEmail,
            subject: `Signed: ${offer.role} – ${offer.company}`,
            html: emailShell(`<p>Dear ${esc(offer.candidateName)},</p>
              <p>Thank you for signing <b>${esc(offer.role)}</b>. You will receive the final copy by email once ${esc(offer.company)} countersigns it.</p>
              <p>Regards,<br>${esc(env("FROM_NAME", offer.company))}</p>`),
          });
          const admins = adminEmails();
          if (admins.length)
            await sendMail({
              to: admins.join(","),
              subject: `✍️ Your turn: ${offer.candidateName} signed ${offer.role} – please countersign`,
              html: emailShell(`<p><b>${esc(offer.candidateName)}</b> has signed <b>${esc(offer.role)}</b> (${esc(offer.company)}) on ${ist(offer.signedAt)}.</p>
                <p>Please countersign to complete it:</p>
                <p><a href="${siteUrl(req)}/" style="display:inline-block;background:#15803d;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Open Inkpact &amp; Countersign</a></p>`),
            });
        } else {
          await emailFinalCopies(offer, signed);
        }
        return json({ ok: true, signedAt: ist(offer.signedAt), awaitingCountersign: !!offer.awaitingCountersign });
      }

      if (parts[2] === "decline" && m === "POST") {
        if (["signed", "cancelled", "declined"].includes(offer.status)) return err("This document can no longer be declined");
        const body = await req.json().catch(() => ({}));
        offer.status = "declined";
        offer.declinedAt = nowIso();
        offer.declineReason = String(body.reason || "").slice(0, 1000);
        offer.history.push({ at: offer.declinedAt, event: "Declined by candidate" });
        await putOffer(offer);
        const admins = adminEmails();
        if (admins.length)
          await sendMail({
            to: admins.join(","),
            subject: `❌ Declined: ${offer.candidateName} – ${offer.role} (${offer.company})`,
            html: emailShell(`<p><b>${esc(offer.candidateName)}</b> declined to sign <b>${esc(offer.role)}</b>.</p>
              <p>Reason: ${esc(offer.declineReason || "Not given")}</p>`),
          });
        return json({ ok: true });
      }
    }
    return err("Not found", 404);
  } catch (e) {
    console.error(e);
    return err("Something went wrong: " + e.message, 500);
  }
}

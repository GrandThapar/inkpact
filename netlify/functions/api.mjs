import { getStore } from "@netlify/blobs";
import { handle } from "../../lib/app.mjs";

export default async (req, context) => {
  const store = getStore({ name: "inkpact", consistency: "strong" });
  return handle(req, { store, ip: context.ip });
};

export const config = { path: ["/api", "/api/*"] };

import { type NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/proxy";

// Next 16 proxy convention (formerly `middleware`). Defaults to the Node.js
// runtime, which the Supabase server client needs. Its only job is to keep the
// auth session fresh; route-level authorization lives in the (panel) layout.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Run on every path except Next internals, metadata files and static assets
    // (none of which carry a session to refresh), so the auth cookie stays fresh
    // on real navigations without paying getClaims() on asset fetches.
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf)$).*)",
  ],
};

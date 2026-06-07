import { redirect } from "next/navigation";

import { getSessionRole } from "@/lib/services/authz";

/**
 * Gate for a signed-in user's own account surface (step14). Unlike `(panel)`
 * (staff only), this admits ANY authenticated session — citizens AND staff may
 * view their own reports. An anonymous visitor (no `userId`) is redirected to
 * sign in BEFORE the route renders, so `/mis-reportes` never leaks behind the
 * gate (citizen-my-reports.scenarios.md SCEN-003).
 */
export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await getSessionRole();

  if (!userId) {
    redirect("/ingresar");
  }

  return children;
}

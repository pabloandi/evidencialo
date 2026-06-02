import { redirect } from "next/navigation";

import { canAccessPanel, getSessionRole } from "@/lib/services/authz";

/**
 * Gate for the management panel. Resolves the session role and redirects any
 * non-staff visitor (citizens and anonymous users) away before the panel
 * renders (AC1). The role comes from the JWT `user_role` claim, with a live
 * `profiles` fallback — see `authz.getSessionRole`.
 */
export default async function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { role } = await getSessionRole();

  if (!canAccessPanel(role)) {
    redirect("/");
  }

  return children;
}

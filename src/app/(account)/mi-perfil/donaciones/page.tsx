import type { Metadata } from "next";
import Link from "next/link";

import { getSessionRole } from "@/lib/services/authz";
import {
  getOwnDonationChannels,
  isPublishedSolver,
} from "@/lib/services/solverService";
import DonationChannelsEditor from "@/components/solver/DonationChannelsEditor";

/**
 * Solver self-management of donation channels (subsystem D, chunk D3; SCEN-011,
 * the UI half of SCEN-012) — `/mi-perfil/donaciones`.
 *
 * OWNER-SCOPED by construction: there is NO handle in the URL. The page resolves
 * the editable profile from `auth.uid()` (via `getSessionRole`), so a user can
 * only ever edit THEIR OWN channels — no cross-solver edit path exists. The
 * `(account)/layout.tsx` gate already redirects an anonymous visitor to
 * `/ingresar` BEFORE this renders (inherited; not re-implemented here).
 *
 * A non-solver authenticated user has no `solver_profiles` row → they see a
 * friendly "this section is for solvers" empty state, never an editor.
 */

export const metadata: Metadata = {
  title: "Canales de donación — evidencialo",
};

export default async function DonacionesPage() {
  // The `(account)` layout guarantees a session, so `userId` is non-null here.
  const { userId } = await getSessionRole();
  const uid = userId ?? "";

  const solver = await isPublishedSolver(uid);

  if (!solver) {
    return (
      <main className="donation-editor-page">
        <header className="donation-editor-page__header">
          <Link href="/" className="donation-editor-page__back">
            ← Volver al mapa
          </Link>
          <h1 className="donation-editor-page__title">Canales de donación</h1>
        </header>
        <p className="donation-editor-page__empty">
          Esta sección es para solucionadores.
        </p>
      </main>
    );
  }

  const channels = await getOwnDonationChannels(uid);

  return (
    <main className="donation-editor-page">
      <header className="donation-editor-page__header">
        <Link href="/" className="donation-editor-page__back">
          ← Volver al mapa
        </Link>
        <h1 className="donation-editor-page__title">Canales de donación</h1>
        <p className="donation-editor-page__subtitle">
          Publica tus canales para que la gente pueda apoyarte directamente.
          evidencialo nunca recibe el dinero.
        </p>
      </header>

      <DonationChannelsEditor initialChannels={channels} />
    </main>
  );
}

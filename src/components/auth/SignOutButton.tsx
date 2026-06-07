import { signOut } from "@/lib/services/authActions";

/**
 * Sign-out control (SCEN-005). A minimal form that posts to the `signOut`
 * server action — no client JS needed, works as a progressive-enhancement
 * submit. Rendered in the panel header.
 */
export default function SignOutButton() {
  return (
    <form action={signOut}>
      <button type="submit" className="auth-signout">
        Salir
      </button>
    </form>
  );
}

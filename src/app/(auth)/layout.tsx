import Link from "next/link";

/**
 * Auth shell (sign-in / sign-up). A centered, mobile-first card layout on the
 * civic paper background, with the "evidencialo" wordmark linking home. The
 * pages inside render the actual `.auth-card` form.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="auth-shell">
      <div className="auth-shell__inner">
        <Link href="/" className="auth-shell__brand">
          evidencialo
        </Link>
        {children}
      </div>
    </main>
  );
}

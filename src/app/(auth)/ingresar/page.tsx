"use client";

import Link from "next/link";
import { useActionState } from "react";

import { login, type AuthState } from "./actions";

/**
 * Sign-in page (SCEN-002/003/004). Client component driven by React 19
 * `useActionState`: the form posts to the `login` server action, which returns
 * an error state on validation/credential failure (rendered inline,
 * `role="alert"`) or redirects by role on success. The submit button is
 * disabled while the action is pending.
 */

const INITIAL: AuthState = {};

export default function IngresarPage() {
  const [state, formAction, isPending] = useActionState(login, INITIAL);

  return (
    <form className="auth-card" action={formAction}>
      <h1 className="auth-card__title">Ingresar</h1>
      <p className="auth-card__subtitle">
        Accede a tu cuenta para gestionar reportes.
      </p>

      <div className="auth-field">
        <label htmlFor="email">Correo</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
        />
      </div>

      <div className="auth-field">
        <label htmlFor="password">Contraseña</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      {state.error ? (
        <p className="auth-error" role="alert">
          {state.error.message}
        </p>
      ) : null}

      <button type="submit" className="auth-submit" disabled={isPending}>
        {isPending ? "Ingresando…" : "Ingresar"}
      </button>

      <p className="auth-alt">
        ¿No tienes cuenta? <Link href="/registro">Regístrate</Link>
      </p>
    </form>
  );
}

"use client";

import Link from "next/link";
import { useActionState } from "react";

import { signup, type SignupState } from "./actions";

/**
 * Sign-up page (SCEN-001/004). Mirrors the sign-in page: the form posts to the
 * `signup` server action, which either redirects (auto-signed-in), returns a
 * "check your inbox" notice (confirmation required), or returns an inline error.
 */

const INITIAL: SignupState = {};

export default function RegistroPage() {
  const [state, formAction, isPending] = useActionState(signup, INITIAL);

  return (
    <form className="auth-card" action={formAction}>
      <h1 className="auth-card__title">Crear cuenta</h1>
      <p className="auth-card__subtitle">
        Regístrate para reportar y seguir problemas en tu ciudad.
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
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>

      {state.error ? (
        <p className="auth-error" role="alert">
          {state.error.message}
        </p>
      ) : null}

      {state.notice ? (
        <p className="auth-notice" role="status">
          {state.notice}
        </p>
      ) : null}

      <button type="submit" className="auth-submit" disabled={isPending}>
        {isPending ? "Creando…" : "Crear cuenta"}
      </button>

      <p className="auth-alt">
        ¿Ya tienes cuenta? <Link href="/ingresar">Ingresar</Link>
      </p>
    </form>
  );
}

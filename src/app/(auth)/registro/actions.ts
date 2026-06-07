"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createServerSupabase } from "@/lib/supabase/server";
import { validateAuthInput } from "@/lib/validation/authSchema";

/**
 * Sign-up server action (SCEN-001). Validates the input shape (SCEN-004), then
 * calls `signUp` on the request-bound server client. The `handle_new_user`
 * trigger creates the `profiles` row (role `citizen`) automatically.
 *
 * The next step depends on the project's email-confirmation setting:
 * - `data.session` present → the user is signed in → revalidate + redirect("/").
 * - `data.user && !data.session` → confirmation required → return a notice so
 *   the page tells them to check their inbox (never a raw error on valid input).
 *
 * `redirect()` throws to unwind, so it runs only after the success branch is
 * confirmed — never inside a swallowing try/catch.
 */

export type SignupState = {
  error?: { code: string; message: string; field?: string };
  notice?: string;
};

export async function signup(
  _prevState: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const validation = validateAuthInput({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!validation.ok) {
    return { error: validation.error };
  }

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.signUp({
    email: validation.value.email,
    password: validation.value.password,
  });

  if (error) {
    return {
      error: {
        code: "signup_failed",
        message: "No pudimos crear la cuenta. Inténtalo de nuevo.",
      },
    };
  }

  // Email confirmation required: a user exists but there is no session yet.
  // NOTE (anti-enumeration): GoTrue returns this same shape for an ALREADY
  // registered email (an obfuscated user, no session, no error) and sends NO
  // mail — so the copy must NOT promise "we sent you an email" (a dead end for
  // someone who already has an account). It stays generic and points to sign-in,
  // without revealing whether the address was already taken.
  if (data.user && !data.session) {
    return {
      notice:
        "Si el correo no estaba registrado, te enviamos un enlace para confirmar tu cuenta. ¿Ya tienes cuenta? Inicia sesión.",
    };
  }

  // Auto-signed-in (confirmation disabled): the session cookies are set on this
  // response. New accounts are citizens → land on the public map.
  revalidatePath("/", "layout");
  redirect("/");
}

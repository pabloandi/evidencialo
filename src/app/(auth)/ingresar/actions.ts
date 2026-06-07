"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getSessionRole, isStaff } from "@/lib/services/authz";
import { createServerSupabase } from "@/lib/supabase/server";
import { validateAuthInput } from "@/lib/validation/authSchema";

/**
 * Sign-in server action (SCEN-002/003/004). Reads the credentials from the
 * form, validates the SHAPE before touching Supabase (SCEN-004), then calls
 * `signInWithPassword` on the request-bound server client — which sets the
 * session cookies via the cookie adapter on this response.
 *
 * On error we return an in-place error state (SCEN-003 — no session, no
 * redirect). On success we resolve the role from the now-set session and
 * redirect by role (staff → /panel, otherwise → /). `redirect()` throws to
 * unwind, so it is called OUTSIDE the supabase call's result handling — never
 * swallowed.
 */

export type AuthState = {
  error?: { code: string; message: string; field?: string };
};

export async function login(
  _prevState: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const validation = validateAuthInput({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!validation.ok) {
    return { error: validation.error };
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithPassword({
    email: validation.value.email,
    password: validation.value.password,
  });

  if (error) {
    // Do NOT leak whether the email exists: one generic message for any
    // credential failure (wrong password, unknown email, unconfirmed account).
    return {
      error: {
        code: "invalid_credentials",
        message: "Correo o contraseña incorrectos.",
      },
    };
  }

  // The session cookies are set on this response, so getClaims sees the new
  // session and resolves the role for an immediate role-aware redirect.
  const { role } = await getSessionRole();

  revalidatePath("/", "layout");
  redirect(isStaff(role) ? "/panel" : "/");
}

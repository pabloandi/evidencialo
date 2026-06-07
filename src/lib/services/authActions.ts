"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Sign-out server action (SCEN-005). Called from a `<form action={signOut}>`
 * (no args). `signOut()` clears the session cookies via the cookie adapter on
 * this response; revalidating the root layout drops any cached session-aware UI,
 * and the redirect sends the now-anonymous user back to the public map — where
 * the panel gate re-applies if they try to return.
 *
 * `redirect()` throws to unwind, so it runs after the supabase call returns,
 * never inside a swallowing try/catch.
 */
export async function signOut(): Promise<void> {
  const supabase = await createServerSupabase();
  // Clear local cookies regardless, but surface a revoke failure rather than
  // swallowing it silently (auth-flow observability) — the redirect still runs:
  // a stuck session is worse left invisible.
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error("[signOut] session revoke failed", { error: String(error) });
  }

  revalidatePath("/", "layout");
  redirect("/");
}

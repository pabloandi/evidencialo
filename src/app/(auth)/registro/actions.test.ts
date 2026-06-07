import { beforeEach, describe, expect, it, vi } from "vitest";

// Observable contract for the signup server action (SCEN-001/004).
// The Supabase server client is mocked (signUp returns session, user-only, or
// error) and next/navigation + next/cache are mocked. `redirect()` throws a
// sentinel we catch to assert the auto-signed-in path.

const signUpMock = vi.fn();
const revalidatePathMock = vi.fn();

class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}

const redirectMock = vi.fn((path: string) => {
  throw new RedirectError(path);
});

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: vi.fn(async () => ({
    auth: { signUp: (...a: unknown[]) => signUpMock(...a) },
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: (...a: unknown[]) => revalidatePathMock(...a),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirectMock(path),
}));

import { createServerSupabase } from "@/lib/supabase/server";
import { signup } from "./actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("signup action", () => {
  it("redirects to / when sign-up returns a session (auto-signed-in) (SCEN-001)", async () => {
    signUpMock.mockResolvedValue({
      data: { user: { id: "u1" }, session: { access_token: "t" } },
      error: null,
    });

    await expect(
      signup({}, form({ email: "new@example.com", password: "contrasena1" })),
    ).rejects.toMatchObject({ path: "/" });

    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
    expect(redirectMock).toHaveBeenCalledWith("/");
  });

  it("returns a notice when confirmation is required (user, no session) (SCEN-001)", async () => {
    signUpMock.mockResolvedValue({
      data: { user: { id: "u1" }, session: null },
      error: null,
    });

    const state = await signup(
      {},
      form({ email: "new@example.com", password: "contrasena1" }),
    );

    // Anti-enumeration copy: an already-registered email hits this same branch
    // with NO mail sent, so the notice must NOT promise a sent email; it stays
    // generic and points to sign-in.
    expect(state.notice).toBe(
      "Si el correo no estaba registrado, te enviamos un enlace para confirmar tu cuenta. ¿Ya tienes cuenta? Inicia sesión.",
    );
    expect(state.error).toBeUndefined();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("returns an error state when sign-up fails", async () => {
    signUpMock.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "User already registered" },
    });

    const state = await signup(
      {},
      form({ email: "dupe@example.com", password: "contrasena1" }),
    );

    expect(state.error?.code).toBe("signup_failed");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("returns a validation error and never calls Supabase on bad input (SCEN-004)", async () => {
    const state = await signup({}, form({ email: "bad", password: "x" }));

    expect(state.error?.code).toBe("email_invalid");
    expect(createServerSupabase).not.toHaveBeenCalled();
    expect(signUpMock).not.toHaveBeenCalled();
  });
});

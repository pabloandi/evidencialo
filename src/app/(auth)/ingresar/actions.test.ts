import { beforeEach, describe, expect, it, vi } from "vitest";

// Observable contract for the login server action (SCEN-002/003/004).
// The Supabase server client is mocked (signInWithPassword success/error),
// getSessionRole is mocked for the role branch, and next/navigation `redirect`
// + next/cache `revalidatePath` are mocked. `redirect()` throws to unwind, so
// the mock throws a sentinel we catch to assert the target path.

const signInWithPasswordMock = vi.fn();
const getSessionRoleMock = vi.fn();
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
    auth: { signInWithPassword: (...a: unknown[]) => signInWithPasswordMock(...a) },
  })),
}));

vi.mock("@/lib/services/authz", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/services/authz")>(
      "@/lib/services/authz",
    );
  return {
    ...actual,
    getSessionRole: (...a: unknown[]) => getSessionRoleMock(...a),
  };
});

vi.mock("next/cache", () => ({
  revalidatePath: (...a: unknown[]) => revalidatePathMock(...a),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirectMock(path),
}));

import { createServerSupabase } from "@/lib/supabase/server";
import { login } from "./actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("login action", () => {
  it("returns a validation error and never calls Supabase on bad input (SCEN-004)", async () => {
    const state = await login({}, form({ email: "bad", password: "x" }));

    expect(state.error?.code).toBe("email_invalid");
    expect(createServerSupabase).not.toHaveBeenCalled();
    expect(signInWithPasswordMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("returns an error state and does not redirect on wrong credentials (SCEN-003)", async () => {
    signInWithPasswordMock.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });

    const state = await login(
      {},
      form({ email: "user@example.com", password: "contrasena1" }),
    );

    expect(state.error?.code).toBe("invalid_credentials");
    expect(getSessionRoleMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("redirects a staff sign-in to /panel (SCEN-002)", async () => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    getSessionRoleMock.mockResolvedValue({ userId: "u1", role: "staff" });

    await expect(
      login({}, form({ email: "staff@example.com", password: "contrasena1" })),
    ).rejects.toMatchObject({ path: "/panel" });

    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
    expect(redirectMock).toHaveBeenCalledWith("/panel");
  });

  it("redirects a citizen sign-in to / (SCEN-002)", async () => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    getSessionRoleMock.mockResolvedValue({ userId: "u2", role: "citizen" });

    await expect(
      login({}, form({ email: "citizen@example.com", password: "contrasena1" })),
    ).rejects.toMatchObject({ path: "/" });

    expect(redirectMock).toHaveBeenCalledWith("/");
  });
});

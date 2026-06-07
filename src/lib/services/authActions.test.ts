import { beforeEach, describe, expect, it, vi } from "vitest";

// Observable contract for the signOut server action (SCEN-005). The Supabase
// server client is mocked; next/navigation + next/cache are mocked. signOut
// must clear the session and redirect to "/". `redirect()` throws a sentinel.

const signOutMock = vi.fn();
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
    auth: { signOut: (...a: unknown[]) => signOutMock(...a) },
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: (...a: unknown[]) => revalidatePathMock(...a),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirectMock(path),
}));

import { signOut } from "./authActions";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("signOut action", () => {
  it("clears the session and redirects to / (SCEN-005)", async () => {
    signOutMock.mockResolvedValue({ error: null });

    await expect(signOut()).rejects.toMatchObject({ path: "/" });

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
    expect(redirectMock).toHaveBeenCalledWith("/");
  });
});

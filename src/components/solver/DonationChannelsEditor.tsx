"use client";

/**
 * Owner self-management editor for donation channels (subsystem D, chunk D3;
 * SCEN-011, the UI half of SCEN-012). One editable row per `DONATION_TYPES`
 * entry. Mounted on `/mi-perfil/donaciones`, which already resolved the editable
 * profile from `auth.uid()` — so every write here is scoped to the caller by the
 * routes' owner gate + the DEFINER RPC's `auth.uid()`; this component never
 * sends a solver id.
 *
 * Per row:
 *   - a value `<input>` (cell / account number / paypal user),
 *   - a `<select>` for the account kind (bancolombia ONLY),
 *   - a QR `<input type="file" accept="image/*">` for the three Colombian rails
 *     (NOT paypal — its QR is auto-generated),
 *   - a Save button, and (when the channel already exists) a Delete button.
 *
 * SAVE flow: for a rail, if a NEW file is chosen, FIRST `POST /api/solver/
 * donation-qr` (multipart `file` + `type`) → `{ qrPath }`; THEN `POST
 * /api/solver/donation-channels` with `{ type, value, accountKind?, qrPath? }`.
 * DELETE: `DELETE /api/solver/donation-channels` `{ type }`. On any success →
 * `router.refresh()` so the server re-reads the channels (qrUrl, existence).
 *
 * Feedback mirrors `DisputeForm`: per-row pending/error/success with
 * `role="status"` / `role="alert"` and gerund button text ("Guardando…").
 */

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { DonationChannel } from "@/lib/services/solverService";
import {
  ACCOUNT_KINDS,
  DONATION_TYPES,
  type AccountKind,
  type DonationType,
} from "@/lib/validation/donationSchema";

type Props = {
  initialChannels: DonationChannel[];
};

const TYPE_LABELS: Record<DonationType, string> = {
  nequi: "Nequi",
  daviplata: "Daviplata",
  bancolombia: "Bancolombia",
  paypal: "PayPal",
};

const VALUE_PLACEHOLDERS: Record<DonationType, string> = {
  nequi: "Número celular (ej. 3001234567)",
  daviplata: "Número celular (ej. 3001234567)",
  bancolombia: "Número de cuenta",
  paypal: "Usuario de paypal.me",
};

const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  ahorros: "Ahorros",
  corriente: "Corriente",
};

type RowState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "deleting" }
  | { kind: "error"; message: string }
  | { kind: "saved" }
  | { kind: "deleted" };

function ChannelRow({
  type,
  existing,
  onChanged,
}: {
  type: DonationType;
  existing: DonationChannel | undefined;
  onChanged: () => void;
}) {
  const valueId = useId();
  const kindId = useId();
  const fileId = useId();

  const isPaypal = type === "paypal";
  const isBancolombia = type === "bancolombia";

  const [value, setValue] = useState(existing?.value ?? "");
  const [accountKind, setAccountKind] = useState<AccountKind | "">(
    existing?.accountKind ?? "",
  );
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [state, setState] = useState<RowState>({ kind: "idle" });

  const previewRef = useRef<string | null>(null);
  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);
  // Revoke the object URL on unmount (no leak) — mirrors ResolutionUpload.
  useEffect(() => {
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, []);

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0] ?? null;
    if (preview) URL.revokeObjectURL(preview);
    setFile(picked);
    setPreview(picked ? URL.createObjectURL(picked) : null);
    setState({ kind: "idle" });
  }

  async function readError(res: Response): Promise<string> {
    try {
      const body = await res.json();
      if (body?.error?.message) return body.error.message as string;
    } catch {
      // non-JSON error body
    }
    return "No se pudo guardar el canal. Inténtalo de nuevo.";
  }

  async function onSave() {
    if (state.kind === "saving" || state.kind === "deleting") return;
    setState({ kind: "saving" });

    try {
      // 1) For a rail with a NEWLY chosen file, upload the QR first.
      let qrPath: string | null = null;
      if (!isPaypal && file) {
        const form = new FormData();
        form.append("file", file);
        form.append("type", type);
        const qrRes = await fetch("/api/solver/donation-qr", {
          method: "POST",
          body: form,
        });
        if (!qrRes.ok) {
          setState({ kind: "error", message: await readError(qrRes) });
          return;
        }
        const qrBody = (await qrRes.json()) as { qrPath?: string };
        qrPath = qrBody.qrPath ?? null;
      }

      // 2) Save the channel.
      const payload: {
        type: DonationType;
        value: string;
        accountKind?: AccountKind;
        qrPath?: string;
      } = { type, value: value.trim() };
      if (isBancolombia && accountKind) payload.accountKind = accountKind;
      if (qrPath) payload.qrPath = qrPath;

      const res = await fetch("/api/solver/donation-channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setState({ kind: "error", message: await readError(res) });
        return;
      }

      setState({ kind: "saved" });
      // Reset the pending file (the server now holds it).
      if (preview) URL.revokeObjectURL(preview);
      setFile(null);
      setPreview(null);
      onChanged();
    } catch {
      setState({
        kind: "error",
        message: "No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.",
      });
    }
  }

  async function onDelete() {
    if (state.kind === "saving" || state.kind === "deleting") return;
    setState({ kind: "deleting" });

    try {
      const res = await fetch("/api/solver/donation-channels", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type }),
      });
      if (!res.ok) {
        setState({ kind: "error", message: await readError(res) });
        return;
      }
      setState({ kind: "deleted" });
      setValue("");
      setAccountKind("");
      onChanged();
    } catch {
      setState({
        kind: "error",
        message: "No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.",
      });
    }
  }

  const busy = state.kind === "saving" || state.kind === "deleting";
  const valueEmpty = value.trim().length === 0;

  return (
    <li className="donation-editor__row">
      <span className="donation-editor__type">{TYPE_LABELS[type]}</span>

      <div className="donation-editor__fields">
        <label className="donation-editor__field" htmlFor={valueId}>
          <span className="donation-editor__label">Valor</span>
          <input
            id={valueId}
            className="donation-editor__input"
            type="text"
            inputMode={isPaypal ? "text" : "numeric"}
            value={value}
            placeholder={VALUE_PLACEHOLDERS[type]}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>

        {isBancolombia && (
          <label className="donation-editor__field" htmlFor={kindId}>
            <span className="donation-editor__label">Tipo de cuenta</span>
            <select
              id={kindId}
              className="donation-editor__select"
              value={accountKind}
              disabled={busy}
              onChange={(e) => setAccountKind(e.target.value as AccountKind | "")}
            >
              <option value="">Selecciona…</option>
              {ACCOUNT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {ACCOUNT_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        )}

        {!isPaypal && (
          <label className="donation-editor__field" htmlFor={fileId}>
            <span className="donation-editor__label">Código QR (imagen)</span>
            <input
              id={fileId}
              className="donation-editor__file"
              type="file"
              accept="image/*"
              disabled={busy}
              onChange={onFileChange}
            />
          </label>
        )}

        {preview && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            className="donation-editor__preview"
            src={preview}
            alt={`Vista previa del código QR de ${TYPE_LABELS[type]}`}
          />
        )}
        {!preview && existing?.qrUrl && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            className="donation-editor__preview"
            src={existing.qrUrl}
            alt={`Código QR actual de ${TYPE_LABELS[type]}`}
          />
        )}
      </div>

      {state.kind === "error" && (
        <p className="donation-editor__error" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === "saved" && (
        <p className="donation-editor__status" role="status">
          Guardado ✓
        </p>
      )}
      {state.kind === "deleted" && (
        <p className="donation-editor__status" role="status">
          Eliminado ✓
        </p>
      )}

      <div className="donation-editor__actions">
        <button
          type="button"
          className="capture-btn capture-btn--primary donation-editor__save"
          onClick={onSave}
          disabled={busy || valueEmpty}
        >
          {state.kind === "saving" ? "Guardando…" : "Guardar"}
        </button>
        {existing && (
          <button
            type="button"
            className="capture-btn capture-btn--secondary donation-editor__delete"
            onClick={onDelete}
            disabled={busy}
          >
            {state.kind === "deleting" ? "Eliminando…" : "Eliminar"}
          </button>
        )}
      </div>
    </li>
  );
}

export default function DonationChannelsEditor({ initialChannels }: Props) {
  const router = useRouter();
  const byType = new Map<DonationType, DonationChannel>(
    initialChannels.map((c) => [c.type, c]),
  );

  return (
    <ul className="donation-editor">
      {DONATION_TYPES.map((type) => (
        <ChannelRow
          key={type}
          type={type}
          existing={byType.get(type)}
          onChanged={() => router.refresh()}
        />
      ))}
    </ul>
  );
}

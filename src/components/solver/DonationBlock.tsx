/**
 * Public "Apóyalo" donation block (subsystem D, chunk D3; SCEN-009, the UI half
 * of SCEN-007/008). Renders under the C `ReputationBlock` on the public solver
 * profile so the donor judges with the track record in view.
 *
 * An ASYNC server component (no client JS of its own beyond the small
 * `<CopyButton>` islands) — it `await`s `paypalQrSvg` for the PayPal rail. One
 * card per channel:
 *   - nequi/daviplata → label + the cell value + a copy button.
 *   - bancolombia     → label + account kind (Ahorros/Corriente) + number + copy.
 *   - paypal          → label + an "Abrir PayPal" link (the normalized
 *                       `https://paypal.me/<user>` URL) styled as a primary pill.
 *   - QR: paypal renders the SERVER-GENERATED inline SVG (safe: it is produced by
 *     `paypalQrSvg` from a validated, normalized paypal.me URL — never user HTML);
 *     a rail WITH `qrUrl` renders an `<img>` of the uploaded PNG; a rail with no
 *     `qrUrl` shows no QR (just the copy value).
 *
 * EMPTY STATE: a solver with zero channels → the block renders NOTHING (`null`),
 * no "no recibe donaciones" noise (SCEN-009).
 */

import { Fragment } from "react";

import CopyButton from "@/components/solver/CopyButton";
import { paypalQrSvg } from "@/lib/donation/paypalQr";
import type { DonationChannel } from "@/lib/services/solverService";

type Props = {
  channels: DonationChannel[];
};

/** Human label per rail. */
const TYPE_LABELS: Record<DonationChannel["type"], string> = {
  nequi: "Nequi",
  daviplata: "Daviplata",
  bancolombia: "Bancolombia",
  paypal: "PayPal",
};

const ACCOUNT_KIND_LABELS: Record<"ahorros" | "corriente", string> = {
  ahorros: "Ahorros",
  corriente: "Corriente",
};

/** Render one channel card. Async because PayPal awaits its generated SVG. */
async function renderCard(channel: DonationChannel) {
  const label = TYPE_LABELS[channel.type];

  if (channel.type === "paypal") {
    // The SVG is server-generated from the validated, normalized paypal.me URL
    // (`paypalQrSvg` re-checks the shape) — it is never user-supplied HTML, so
    // `dangerouslySetInnerHTML` is safe here.
    const qrSvg = await paypalQrSvg(channel.value);
    return (
      <li className="donation-channel donation-channel--paypal">
        <div className="donation-channel__body">
          <span className="donation-channel__label">{label}</span>
          <a
            className="capture-btn capture-btn--primary donation-channel__open"
            href={channel.value}
            target="_blank"
            rel="noopener noreferrer"
          >
            Abrir PayPal
          </a>
        </div>
        <div
          className="donation-channel__qr donation-channel__qr--svg"
          aria-label="Código QR para donar por PayPal"
          role="img"
          dangerouslySetInnerHTML={{ __html: qrSvg }}
        />
      </li>
    );
  }

  // Colombian rails: cell (nequi/daviplata) or account (bancolombia) + copy.
  const kindLabel =
    channel.type === "bancolombia" && channel.accountKind
      ? ACCOUNT_KIND_LABELS[channel.accountKind]
      : null;

  return (
    <li className="donation-channel">
      <div className="donation-channel__body">
        <span className="donation-channel__label">{label}</span>
        {kindLabel && (
          <span className="donation-channel__kind">{kindLabel}</span>
        )}
        <span className="donation-channel__value">{channel.value}</span>
        <CopyButton value={channel.value} />
      </div>
      {channel.qrUrl && (
        <div className="donation-channel__qr">
          {/* Public-bucket QR URL → a plain <img> (next/image cannot optimize a
              CDN URL it doesn't recognize, and the QR must stay pixel-exact). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="donation-channel__qr-img"
            src={channel.qrUrl}
            alt={`Código QR para donar por ${label}`}
            loading="lazy"
          />
        </div>
      )}
    </li>
  );
}

export default async function DonationBlock({ channels }: Props) {
  // SCEN-009 empty state: zero channels → render nothing at all.
  if (channels.length === 0) return null;

  const cards = (
    await Promise.all(
      channels.map(async (channel) => {
        try {
          return { key: channel.type, node: await renderCard(channel) };
        } catch {
          // A single bad channel (e.g. a malformed stored value that the read
          // layer didn't drop) must NEVER take down the public profile — drop
          // just that card. `Promise.all` would otherwise reject the whole page.
          return null;
        }
      }),
    )
  ).filter(
    (
      card,
    ): card is {
      key: DonationChannel["type"];
      node: Awaited<ReturnType<typeof renderCard>>;
    } => card !== null,
  );

  // Every channel was unrenderable → render nothing (no empty shell).
  if (cards.length === 0) return null;

  return (
    <section className="donation-block" aria-label="Canales de donación">
      <h2 className="donation-block__title">Apóyalo</h2>
      <ul className="donation-block__list">
        {cards.map((card) => (
          <Fragment key={card.key}>{card.node}</Fragment>
        ))}
      </ul>
    </section>
  );
}

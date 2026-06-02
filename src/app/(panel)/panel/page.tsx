// Placeholder for the management panel — the real filters + status-change UI
// arrive in step13. The `(panel)` layout already restricts this route to
// staff/admin; this page only exists so `/panel` is routable for the gate.
export default function PanelPage() {
  return (
    <main>
      <h1>Panel de gestión</h1>
      <p>Acceso restringido a personal autorizado.</p>
    </main>
  );
}

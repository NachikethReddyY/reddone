const invoices = [
  { client: "Northline Studio", invoice: "INV-1048", value: "$12,400", age: "18 days", risk: "High", note: "Promise passed yesterday" },
  { client: "Fieldwork Co.", invoice: "INV-1051", value: "$6,800", age: "9 days", risk: "Watch", note: "Opened reminder twice" },
  { client: "Morrow Labs", invoice: "INV-1057", value: "$3,200", age: "3 days", risk: "Low", note: "Due Friday" },
];

export function GeneratedApplication() {
  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="#main" aria-label="LatePay Copilot home">
          <span className="brand-mark" aria-hidden="true">LP</span>
          <span>LatePay Copilot</span>
        </a>
        <div className="period" aria-label="Current reporting period">May 2026 · SGD</div>
      </header>

      <section id="main" className="hero" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">Receivables command</p>
          <h1 id="page-title">Know who needs a nudge before cash gets tight.</h1>
          <p className="lede">Three invoices need attention. Nothing sends until you approve it.</p>
        </div>
        <button className="primary" type="button">Review priority queue</button>
      </section>

      <section className="metrics" aria-label="Receivables summary">
        <article><span>Open value</span><strong>$38,600</strong><small>Across 8 invoices</small></article>
        <article><span>At risk</span><strong>$19,200</strong><small>2 promises need follow-up</small></article>
        <article><span>Expected 14d</span><strong>$24,900</strong><small>Based on recorded commitments</small></article>
      </section>

      <section className="queue" aria-labelledby="queue-title">
        <div className="section-heading">
          <div><p className="eyebrow">Priority queue</p><h2 id="queue-title">Follow-up candidates</h2></div>
          <button className="quiet" type="button">Export ledger</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Client</th><th>Invoice</th><th>Value</th><th>Age</th><th>Risk</th><th>Why now</th><th><span className="sr-only">Action</span></th></tr></thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.invoice}>
                  <td><strong>{invoice.client}</strong></td><td>{invoice.invoice}</td><td>{invoice.value}</td><td>{invoice.age}</td>
                  <td><span className={`risk risk-${invoice.risk.toLowerCase()}`}>{invoice.risk}</span></td><td>{invoice.note}</td>
                  <td><button className="row-action" type="button">Review<span className="sr-only"> {invoice.invoice}</span></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

import Link from "next/link";
import type { Metadata } from "next";
import { OPS_AGENTS, OPS_PHASES } from "@/lib/ops";

export const metadata: Metadata = {
  title: "How it works — The All Freight",
  description:
    "What this product does, the problem it solves, and how the planning half and the live ops half fit together.",
};

/**
 * Deliberately a server component with no client JavaScript: it's the page a
 * first-time visitor and a reviewer read before anything else, so it should
 * render instantly and work with the backend down.
 */
export default function HowItWorksPage() {
  return (
    <main className="flex-1 mx-auto w-full max-w-3xl px-5 py-10">
      <h1 className="serif text-4xl">How it works</h1>
      <p className="text-sm text-muted mt-2">
        One product with two halves: research a shipment before it moves, then watch it — and act — once it does.
      </p>

      <Section title="The problem">
        <p>
          When a container sits longer than its free time, the carrier charges demurrage and detention by the day,
          per container. The rates are published, the rules about how they can be billed are federal law, and yet
          the moment a vessel is actually delayed the response is a scramble: someone digs out the tariff PDF,
          someone else guesses at the reroute cost, someone emails the carrier, and the clock runs the whole time.
        </p>
        <p>
          The information needed to decide well is public. It&apos;s just scattered across carrier tariff documents,
          port advisories, regulatory filings and freight indices — and nobody has time to gather it while the
          meter is running.
        </p>
      </Section>

      <Section title="What this does">
        <p>
          <strong>Plan.</strong> Describe a shipment and a pipeline of agents researches it against the live web:
          freight rates, tariffs and duty, port congestion, weather, geopolitical and supplier risk. You get a risk
          score, a cost and delay forecast, a recommended entry port, and a dated action plan — every figure
          carrying the source it came from.
        </p>
        <p>
          <strong>Track.</strong> Keep a shipment and it stops being a one-off report. The pages that determine what
          a disruption would cost on that lane — the port&apos;s advisories, the carrier&apos;s demurrage tariff, the
          FMC billing rule — are put under scheduled monitoring, and changes land on the shipment.
        </p>
        <p>
          <strong>Act.</strong> If a vessel is actually disrupted at a monitored port, a room opens. Seven agents
          across three frameworks negotiate recovery options costed against the real published tariff, vote to a
          quorum, and an adversarial agent argues against the front-runner. Then a human approves or rejects, and
          the whole exchange becomes an audit dossier.
        </p>
      </Section>

      <Section title="How the two halves join">
        <p>
          The join is the tracked shipment. Planning produces one; monitoring watches its lane; an incident at its
          entry port attaches to it. That&apos;s why the watchlist is the home page — it&apos;s the list of things
          the rest of the product is about.
        </p>
        <p>
          The attribution is deliberately conservative. A shipment is linked to an incident only when its resolved
          entry port is the same monitored port, and the link stores the sentence explaining why. It&apos;s labelled
          a port-level match, because that&apos;s all it is: it does not claim your cargo is aboard the affected
          vessel, and the data available couldn&apos;t support that claim.
        </p>
      </Section>

      <Section title="Where the data comes from">
        <p>
          Live web access — search, structured extraction from a page, deep research and scheduled page monitoring —
          runs through <span className="text-accent-2 font-medium">Anakin</span>. Extraction is how a number becomes
          citable rather than estimated: pointed at a carrier&apos;s published tariff PDF it returns the actual
          per-day rates and free-time days, which is what the agents then negotiate over.
        </p>
        <p>
          The rule the whole product is built on:{" "}
          <strong>nothing is invented to fill a gap.</strong> If a source can&apos;t be reached, the figure is
          absent and labelled, not estimated into place. Anything inferred says so. That&apos;s why the ops room is
          empty most of the time, and why a lane outside the monitored ports is shown as unmonitored rather than
          quietly attached to a nearby one.
        </p>
      </Section>

      <Section title="The seven agents">
        <p className="mb-3">
          Three different frameworks on purpose, and the dissenting agent runs on a different model from the ones it
          argues with — so the objection isn&apos;t one model agreeing with itself.
        </p>
        <ul className="space-y-2 not-prose">
          {OPS_AGENTS.map((a) => (
            <li key={a.role} className="flex items-start gap-2.5">
              <span className="text-[10px] mono uppercase tracking-wide px-1.5 py-0.5 rounded border border-border bg-panel-2 text-muted shrink-0 mt-0.5">
                {a.framework}
              </span>
              <span className="min-w-0">
                <span className="text-[13px] font-medium">{a.label}</span>
                <span className="text-[13px] text-muted"> — {a.does}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="What happens during an incident">
        <ol className="space-y-2.5 not-prose">
          {OPS_PHASES.filter((p) => p.key !== "rejected").map((p, i) => (
            <li key={p.key} className="flex gap-3">
              <span className="size-5 shrink-0 rounded-full border-[1.5px] border-border bg-panel-2 text-muted grid place-items-center text-[11px] font-bold mono">
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="text-[13px] font-medium">{p.name}</span>
                <span className="block text-[13px] text-muted leading-snug">{p.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Why is the ops room empty?">
        <p>
          Because it&apos;s real. It reflects an actual AIS feed watching three port complexes — Los Angeles / Long
          Beach, New York / New Jersey and Singapore — and it lights up when a vessel is genuinely dwelling where it
          shouldn&apos;t. It isn&apos;t a scripted demo that plays on load. The vessel map is live either way, so
          you can see the feed working even when nothing is wrong.
        </p>
      </Section>

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <Link
          href="/plan"
          className="inline-flex items-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-xl bg-accent text-white hover:brightness-110 transition"
        >
          Plan a shipment
        </Link>
        <Link
          href="/?tour=1"
          className="inline-flex items-center gap-2 text-sm px-4 py-2.5 rounded-xl border border-border bg-panel-2 hover:border-accent/40 transition"
        >
          Take the walkthrough
        </Link>
        <Link
          href="/ops"
          className="inline-flex items-center gap-2 text-sm px-4 py-2.5 rounded-xl border border-border bg-panel-2 hover:border-accent/40 transition"
        >
          See the ops room
        </Link>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-9">
      <h2 className="text-[11px] mono uppercase tracking-wider text-muted mb-3">{title}</h2>
      <div className="space-y-3 text-[14px] leading-relaxed text-foreground/85 [&_strong]:text-foreground [&_strong]:font-semibold">
        {children}
      </div>
    </section>
  );
}

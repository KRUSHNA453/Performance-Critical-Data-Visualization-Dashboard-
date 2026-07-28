import DashboardClient from "./DashboardClient";
import { buildInitialDataset } from "@/lib/serialization";

/**
 * The dataset's timestamps are anchored to the moment of the request, so this
 * page cannot be prerendered at build time — a statically generated backfill
 * would arrive with timestamps hours or days old, leaving a gap between the
 * history and the first live tick. Rendering per request is the correct
 * tradeoff here, and it is a deliberate one rather than an accident.
 */
export const dynamic = "force-dynamic";

/** Total samples across all series in the server-generated backfill. */
const INITIAL_POINTS = 10_000;

/**
 * Server Component.
 *
 * Runs only on the server: generating the backfill and packing it for
 * transport. It ships no JavaScript to the browser — the generator, the PRNG
 * and the profile tables stay server-side and never enter the client bundle.
 */
export default function DashboardPage() {
  const initialDataset = buildInitialDataset({ count: INITIAL_POINTS });

  return <DashboardClient initialDataset={initialDataset} />;
}

import Link from "next/link";

export default function Home() {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: "64px 24px",
      }}
    >
      <h1 style={{ fontSize: 28, margin: "0 0 8px" }}>Performance Dashboard</h1>
      <p style={{ color: "var(--text-muted)", margin: "0 0 24px" }}>
        Real-time data visualization built on raw Canvas 2D — no chart
        libraries.
      </p>
      <Link href="/dashboard">Open dashboard →</Link>
    </main>
  );
}

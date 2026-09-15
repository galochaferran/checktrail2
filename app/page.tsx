import Link from "next/link";

export default function Page() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        margin: 0,
        padding:
          "max(1.5rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1.5rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left))",
        fontFamily: "Outfit, system-ui, sans-serif",
        color: "#e8f4ff",
        background:
          "radial-gradient(ellipse 70% 50% at 15% 10%, rgba(200,245,66,0.14), transparent 55%), radial-gradient(ellipse 60% 45% at 90% 20%, rgba(47,95,173,0.18), transparent 50%), #071018",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <p
          style={{
            margin: "0 0 0.75rem",
            fontFamily: "Bebas Neue, sans-serif",
            fontSize: "clamp(2.75rem, 14vw, 5rem)",
            letterSpacing: "0.06em",
            color: "#c8f542",
            lineHeight: 0.9,
          }}
        >
          Checktrail
        </p>
        <h1
          style={{
            fontFamily: "Bebas Neue, sans-serif",
            fontSize: "clamp(1.85rem, 8vw, 3.2rem)",
            letterSpacing: "0.03em",
            margin: "0 0 0.5rem",
            fontWeight: 400,
          }}
        >
          Pick a category
        </h1>
        <p
          style={{
            color: "#8aa3b5",
            margin: "0 0 1.75rem",
            maxWidth: "36ch",
            lineHeight: 1.45,
            fontSize: "0.98rem",
          }}
        >
          Hosts choose the game first, then create a room. Friends who get your
          invite link join that room directly.
        </p>

        <div style={{ display: "grid", gap: "0.85rem" }}>
          <Link
            href="/game.html?host=1"
            style={{
              textDecoration: "none",
              color: "inherit",
              display: "block",
              padding: "1.25rem 1.2rem",
              minHeight: 88,
              borderRadius: 16,
              border: "1px solid rgba(200,245,66,0.35)",
              background: "rgba(18,36,51,0.85)",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            <span
              style={{
                display: "inline-block",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "#c8f542",
                marginBottom: 6,
              }}
            >
              Category 1
            </span>
            <span style={{ display: "block", fontSize: "clamp(1.15rem, 5vw, 1.375rem)", fontWeight: 700 }}>
              Anon Wheel
            </span>
            <span style={{ display: "block", color: "#8aa3b5", marginTop: 4, fontSize: 14 }}>
              Secret questions, spinning wheel, rapid-fire finale
            </span>
          </Link>

          <Link
            href="/category2.html?host=1"
            style={{
              textDecoration: "none",
              color: "inherit",
              display: "block",
              padding: "1.25rem 1.2rem",
              minHeight: 88,
              borderRadius: 16,
              border: "1px solid rgba(47,95,173,0.55)",
              background: "rgba(18,21,28,0.9)",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            <span
              style={{
                display: "inline-block",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "#9bb8ef",
                marginBottom: 6,
              }}
            >
              Category 2
            </span>
            <span style={{ display: "block", fontSize: "clamp(1.15rem, 5vw, 1.375rem)", fontWeight: 700 }}>
              Mirror Vote
            </span>
            <span style={{ display: "block", color: "#8b93a7", marginTop: 4, fontSize: 14 }}>
              Shuffled “most likely” votes, charts, and your trait portrait
            </span>
          </Link>
        </div>
      </div>
      <link
        href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Outfit:wght@400;600;700&display=swap"
        rel="stylesheet"
      />
    </main>
  );
}

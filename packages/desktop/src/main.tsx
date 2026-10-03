import { createRoot } from "react-dom/client";
import { useState, type ReactNode } from "react";
import { RouterProvider } from "react-router/dom";
import { DesktopSession } from "./session.ts";
import { connectNative, restartNative } from "./transport.ts";
import { createDesktopRouter } from "./routes.tsx";
import { Theme } from "@radix-ui/themes";
import { Button } from "./ui.tsx";
import "./appearance.ts";
import "@radix-ui/themes/styles.css";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Desktop document is missing its root");
const root = createRoot(container);
const themed = (content: ReactNode) => (
  <Theme accentColor="blue" grayColor="slate" radius="small" scaling="95%">
    {content}
  </Theme>
);
function StartupError({ message }: { message: string }) {
  const [error, setError] = useState(message);
  const [busy, setBusy] = useState(false);
  return (
    <div className="startup">
      <h1>Harness could not start</h1>
      <p role="alert">{error}</p>
      <Button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void restartNative().catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : String(cause));
            setBusy(false);
          });
        }}
      >
        Retry
      </Button>
    </div>
  );
}
root.render(themed(<div className="startup">Starting Harness…</div>));
let session: DesktopSession | undefined;
let failure: string | undefined;
try {
  const connection = await connectNative((message) => {
    failure = message;
    session?.disconnect(message);
  });
  session = new DesktopSession(connection);
  await session.start();
  root.render(themed(<RouterProvider router={createDesktopRouter(session)} />));
} catch (error) {
  root.render(
    themed(
      <StartupError
        message={failure ?? (error instanceof Error ? error.message : String(error))}
      />,
    ),
  );
}
